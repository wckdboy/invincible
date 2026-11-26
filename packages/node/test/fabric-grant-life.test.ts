import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { didKeyOfEd25519, newNodeIdentity, signingPublicKey } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { Handoffs } from "../src/fabric/handoff.ts";
import type { Fabric } from "../src/fabric/service.ts";
import type { Call, CallOptions, Chunk } from "../src/fabric/socket.ts";

/*
 * A run's grant follows its task, not its call (the fabric's security review, L1; its proofs of concept, made the tests
 * here). Against a runner that misbehaves: one that says its task is done and keeps the call open, one that says
 * "accepted" again and again, and a hand-off whose follower failed. A stand-in sidecar client counts what the giver
 * mints, renews, revokes and cancels; the runner's chunks are pushed by hand.
 */

const beta = { id: "n_beta", name: "beta", kind: "node", role: "full", profile: { endpoint: "http://127.0.0.1:1", caps: {} } } as unknown as Device;
/** Run keys from obviously fake seeds (i+1 repeated). */
const RUN = (i: number) => didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(i + 1)));

/** A call whose chunks the test pushes and whose result it settles. */
function controlledCall() {
  const queue: Chunk[] = [];
  const waiting: ((r: IteratorResult<Chunk>) => void)[] = [];
  let ended = false;
  let settle!: (v: unknown) => void;
  let fail!: (e: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => ((settle = resolve), (fail = reject)));
  result.catch(() => {});
  const sent: unknown[] = [];
  let cancelled = 0;
  let options: CallOptions | undefined;
  const end = () => {
    ended = true;
    for (const w of waiting.splice(0)) w({ value: undefined, done: true });
  };
  const call: Call = {
    id: 1,
    chunks: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const item = queue.shift();
          if (item) return Promise.resolve({ value: item, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiting.push(resolve));
        },
      }),
    },
    result,
    send: (chunk) => sent.push(chunk),
    end() {},
    cancel: () => {
      cancelled++;
      end();
      fail(Object.assign(new Error("cancelled"), { kind: "cancelled" }));
    },
  };
  return {
    call,
    sent,
    cancelled: () => cancelled,
    options: () => options,
    take: (opts: CallOptions) => ((options = opts), call),
    push(value: unknown) {
      const w = waiting.shift();
      if (w) w({ value: { value }, done: false });
      else queue.push({ value });
    },
    finish(value: unknown) {
      end();
      settle(value);
    },
  };
}

function setup(extra: { handCallMs?: number } = {}) {
  const ctl = controlledCall();
  const minted: string[] = [];
  const renewed: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const client = {
    call: (_address: string, _tool: string, _args: unknown, opts: CallOptions) => ctl.take(opts),
    mint: async () => {
      const grant = `g${++n}`;
      minted.push(grant);
      return { grant, tokens: [{ cmd: "/tool/invincible/agent", tokenId: `${grant}-t0`, exp: 0, chain: `qdt1.${grant}` }] };
    },
    renew: async (grant: string) => {
      renewed.push(grant);
      return { grant, tokens: [{ cmd: "/tool/invincible/agent", tokenId: `${grant}-r${renewed.length}`, exp: 0, chain: `qdt1.${grant}r` }] };
    },
    revoke: async (what: { grant: string }) => {
      revoked.push(what.grant);
      return [];
    },
  };
  const fabric = {
    unusable: () => null,
    peerEndpoint: () => ({ did: "did:key:z6Mkbeta", address: "qamp://did:key:z6Mkbeta@127.0.0.1:1" }),
    seal: async (path: string, body: unknown) => ({ path, body: JSON.stringify(body), auth: {} }),
    // The giver's own transport key: a fake seed's (07 repeated).
    sidecar: { client, did: didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(7))) },
  } as unknown as Fabric;
  const store = { activeDevice: () => beta, device: () => beta } as unknown as LedgerStore;
  // Grants that last 1 s, renewed every 500 ms.
  const h = new Handoffs({ db: new Database(":memory:"), store, identity: newNodeIdentity(), fabric, log: () => {}, grantTtlSecs: 1, ...extra });
  return { h, ctl, client, minted, renewed, revoked };
}

const accepted = (i: number) => ({ kind: "accepted", task: "task-aaaaaaaaaaaa", agent: { id: "ada", name: "Ada" }, run: RUN(i) });

describe("a run's grant follows its task, not its call", () => {
  test("the runner says its task is done but keeps the call open: its grant is renewed no more, and revoked at once", async () => {
    const { h, ctl, renewed, revoked } = setup();
    const view = await h.hand({ node: "beta", goal: "Look at the fleet", tools: ["fleet"] }, beta);
    ctl.push(accepted(0));
    await Bun.sleep(700);
    expect(renewed.length).toBeGreaterThanOrEqual(1);
    ctl.push({ kind: "state", status: "done" });
    await Bun.sleep(100);
    expect(h.get(view.id).status).toBe("done");
    expect(revoked).toEqual(["g1"]);
    const at = renewed.length;
    await Bun.sleep(1_500);
    expect(renewed.length - at).toBe(0);
    ctl.finish({ task: { status: "done" }, proof: null });
    await Bun.sleep(50);
    h.close();
  });

  test("`accepted` said again and again: one grant, minted once; the others are ignored, and no timer of theirs is left", async () => {
    const { h, ctl, minted, renewed, revoked } = setup();
    const view = await h.hand({ node: "beta", goal: "Look at the fleet", tools: ["fleet"] }, beta);
    for (let i = 0; i < 5; i++) ctl.push(accepted(i));
    await Bun.sleep(100);
    expect(minted).toEqual(["g1"]);
    ctl.finish({ task: { status: "done" }, proof: null });
    await Bun.sleep(100);
    expect(h.get(view.id).phase).toBe("ended");
    expect(revoked).toEqual(["g1"]);
    const at = renewed.length;
    await Bun.sleep(1_200);
    expect(renewed.length).toBe(at);
    h.close();
  });

  test("a hand-off whose follower failed cancels its call, so the work there stops, and says why", async () => {
    const { h, ctl, client } = setup();
    // The sidecar refuses the mint (busy, restarted, any error).
    client.mint = async () => {
      throw new Error("the sidecar didn't answer mint in 15000 ms");
    };
    const view = await h.hand({ node: "beta", goal: "Look at the fleet", tools: ["fleet"] }, beta);
    ctl.push(accepted(0));
    await Bun.sleep(100);
    const after = h.get(view.id);
    expect(after.phase).toBe("ended");
    expect(after.status).toBe("interrupted");
    expect(after.error).toContain("the sidecar didn't answer mint");
    expect(ctl.cancelled()).toBe(1);
    h.close();
  });

  test("the hand call has a deadline, and the grant is renewed no longer than it", async () => {
    const { h, ctl, renewed } = setup({ handCallMs: 1_200 });
    await h.hand({ node: "beta", goal: "Look at the fleet", tools: ["fleet"] }, beta);
    expect(ctl.options()?.deadlineMs).toBe(1_200);
    ctl.push(accepted(0));
    await Bun.sleep(2_000);
    const at = renewed.length;
    await Bun.sleep(1_000);
    expect(renewed.length).toBe(at);
    h.close();
  });
});
