import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH, b64u, FABRIC, LINK_METHOD, LINK_PATHS, type LinkCall, newNodeIdentity, type NodeIdentity, randomId, signRequest, utf8 } from "@invincible/core";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "@invincible/link";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "@invincible/ledger";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import type { Invocation } from "../src/fabric/socket.ts";
import { Home, type TransportKey, transportKeyOf } from "../src/home.ts";
import { admin, type Admin, fakeCaps, until } from "./fabric-pair.ts";
import { freePort } from "./ports.ts";

/*
 * The transport key is transport-only (the fabric's security review, M1 and L6). The sidecar's handshake proves which
 * key is calling; the node's door takes it for a node only by a profile whose key signed for that node, and takes each
 * link call and hand-off only with that node's device signature over it, checked exactly as an HTTPS request's is: the
 * node's own, active, fresh, for the tool's path, never sent before. So a transport key alone, read from a file or a
 * backup, carries nothing; and no node can claim another's key, or a key a revoked node ever held.
 *
 * No Q-AMP binary is needed: what the sidecar would deliver after its handshake is handed to beta's door directly.
 */

setDefaultTimeout(60_000);

let root: string;
let a: Daemon;
let b: Daemon;
let homeA: Home;
let callB: Admin;
let alphaKey: TransportKey;

/** Publishes `who`'s profile naming this transport key (as its sidecar would once up), on `store`. */
function claim(store: LedgerStore, who: NodeIdentity, key: TransportKey, pop = key.pop): void {
  const current = store.device(who.id)?.profile;
  store.emit(who, "node.profile", { ...(current?.endpoint ? { endpoint: current.endpoint } : {}), caps: { ...(current?.caps ?? {}), qamp: { did: key.did, address: `qamp://${key.did}@127.0.0.1:7410`, pop } } });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "q5l-"));
  homeA = new Home(join(root, "a"));
  const homeB = new Home(join(root, "b"));
  const portA = freePort();
  const portB = freePort();
  const { identity, keystore } = await homeA.createIdentity("file");
  const store = new LedgerStore(homeA.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "pair", nodeName: "alpha" });
  store.close();
  homeA.writeConfig({ v: 1, name: "alpha", fleet, port: portA, keystore, advertise: "127.0.0.1" });
  a = await startDaemon(homeA, { capabilities: fakeCaps("alpha"), syncIntervalMs: 200, proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false });
  const callA = admin(homeA, portA);
  const invite = await callA<{ invite: string }>("createInvite", { kind: "node" });
  const joining = await homeB.createIdentity("file");
  const join_ = await requestPairing(invite.invite, { device: joining.identity.id, name: "beta", kind: "node", box: b64u(joining.identity.boxPublic), endpoint: `http://127.0.0.1:${portB}` });
  const { pairings } = await callA("pairings");
  await callA("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });
  const approved = await waitForApproval(join_, { intervalMs: 50 });
  const storeB = new LedgerStore(homeB.ledgerPath);
  storeB.expectFleet(approved.fleet);
  storeB.ingest((await signedPost<SyncPage>(joining.identity, a.endpoint, "/link/sync", { have: {} })).events);
  storeB.close();
  homeB.writeConfig({ v: 1, name: "beta", fleet: approved.fleet, port: portB, keystore: joining.keystore, advertise: "127.0.0.1" });
  b = await startDaemon(homeB, { capabilities: fakeCaps("beta"), syncIntervalMs: 200, proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false });
  callB = admin(homeB, portB);
  await callB("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  // alpha's transport key, from its own keystore, named in its profile as its sidecar names it once up.
  alphaKey = await homeA.transportKey("file", a.identity.id);
  claim(a.store, a.identity, alphaKey);
  await until(() => b.fabric.nodeOfKey(alphaKey.did)?.id === a.identity.id, 15_000, "alpha's key known to beta as alpha's");
});

afterAll(async () => {
  await b?.stop();
  await a?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** A call through beta's door, as its sidecar delivers it: from this transport key, with these arguments. */
function knock(tool: string, args: unknown, caller = alphaKey.did) {
  let failed: { code: number; message: string } | null = null;
  let completed: unknown = null;
  const said: unknown[] = [];
  const abort = new AbortController();
  const inv: Invocation = {
    task: 1,
    tool,
    args,
    caller,
    authorization: { kind: "public" },
    chain: [],
    meta: null,
    deadlineMs: null,
    input: tool === FABRIC.hand,
    signal: abort.signal,
    inputs: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    emit: (chunk) => void said.push((chunk as { value: unknown }).value),
    progress() {},
    complete: (result) => void (completed = result),
    fail: (code, message) => void (failed = { code, message }),
  };
  b.fabric.door(inv);
  return { failed: () => failed, completed: () => completed, said, end: () => abort.abort() };
}

/** A link call signed by `signer` as its node's seal would be, with a clock of its own. */
async function signed(signer: NodeIdentity, path: string, body: unknown, now = Date.now()): Promise<LinkCall> {
  const text = JSON.stringify(body);
  const headers = await signRequest(signer.id, (m) => signer.sign(m), LINK_METHOD, path, utf8(text), now);
  return { path, body: text, auth: { device: headers[AUTH.device]!, ts: headers[AUTH.ts]!, nonce: headers[AUTH.nonce]!, sig: headers[AUTH.sig]! } };
}

const answered = async (k: ReturnType<typeof knock>) => {
  await until(() => k.failed() !== null || k.completed() !== null, 15_000, "an answer");
  return k;
};

describe("a link call is its node's own word, not its transport key's", () => {
  test("signed by alpha's device key, alpha's sync is answered", async () => {
    const k = await answered(knock(FABRIC.sync, await a.fabric.seal(LINK_PATHS.sync, { have: {} })));
    expect(k.failed()).toBeNull();
    expect(k.completed()).toMatchObject({ more: expect.any(Boolean) });
  });

  test("the transport key alone carries nothing: a call alpha's device key didn't sign is refused before anything is read", async () => {
    for (const args of [{ have: {} }, { path: LINK_PATHS.sync, body: '{"have":{}}' }]) {
      const k = await answered(knock(FABRIC.sync, args));
      expect(k.failed()).toEqual({ code: 3, message: "refused: a link call is signed by its node's device key, as its HTTPS request would be" });
    }
  });

  test("another device's signature, another tool's path, an old one, or one sent twice: each refused, with why", async () => {
    const stranger = newNodeIdentity();
    const cases: [unknown, string, string][] = [
      [await signed(stranger, LINK_PATHS.sync, { have: {} }), FABRIC.sync, "refused: it is signed by another device than the node whose transport key called"],
      [await signed(b.identity, LINK_PATHS.sync, { have: {} }), FABRIC.sync, "refused: it is signed by another device than the node whose transport key called"],
      [await a.fabric.seal(LINK_PATHS.push, { have: {} }), FABRIC.sync, `refused: that call isn't signed for ${FABRIC.sync}`],
      [await signed(a.identity, LINK_PATHS.sync, { have: {} }, Date.now() - 5 * 60_000), FABRIC.sync, "refused: its signature doesn't verify, or it is outside its time window"],
    ];
    for (const [args, tool, why] of cases) expect((await answered(knock(tool, args))).failed()).toEqual({ code: 3, message: why });
    // A body changed after it was signed doesn't verify.
    const sealed = await a.fabric.seal(LINK_PATHS.sync, { have: {} });
    expect((await answered(knock(FABRIC.sync, { ...sealed, body: '{"have":{"x":"1"}}' }))).failed()?.message).toBe("refused: its signature doesn't verify, or it is outside its time window");
    // Sent twice: the second time is refused.
    const once = await a.fabric.seal(LINK_PATHS.sync, { have: {} });
    expect((await answered(knock(FABRIC.sync, once))).failed()).toBeNull();
    expect((await answered(knock(FABRIC.sync, once))).failed()).toEqual({ code: 3, message: "refused: it was sent before: its nonce is spent" });
  });

  test("a hand-off is held to the same: unsigned, refused before anything is given; signed by alpha, it reaches the runner's door", async () => {
    const args = { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: "Write hello.txt", title: "hello", gates: [], tools: [], agent: "ada" };
    const bare = await answered(knock(FABRIC.hand, args));
    expect(bare.failed()?.message).toBe("refused: a link call is signed by its node's device key, as its HTTPS request would be");
    const k = knock(FABRIC.hand, await a.fabric.seal(LINK_PATHS.hand, args));
    await until(() => k.failed() !== null || k.said.length > 0, 15_000, "the runner's answer");
    expect(k.failed()).toBeNull();
    // No grant: it waits for your approval there, as alpha's.
    expect(k.said[0]).toMatchObject({ kind: "proposed", why: "you haven't granted that node hand-offs here" });
    await callB("controlTeam", { task: (k.said[0] as { task: string }).task, action: "stop" });
    k.end();
  });
});

describe("whose transport key it is", () => {
  let gamma: NodeIdentity;

  test("a node that names alpha's key without that key's signature for it takes nothing: alpha's key stays alpha's (L6)", async () => {
    gamma = newNodeIdentity();
    enrollDevice(a.store, a.identity, { device: gamma.id, name: "gamma", kind: "node", box: b64u(gamma.boxPublic) });
    // alpha's own proof, copied: it names alpha, not gamma.
    claim(a.store, gamma, alphaKey);
    await until(() => b.store.device(gamma.id)?.profile?.caps?.qamp !== undefined, 15_000, "gamma's claim on beta");
    expect(b.fabric.nodeOfKey(alphaKey.did)?.id).toBe(a.identity.id);
    expect((await answered(knock(FABRIC.sync, await a.fabric.seal(LINK_PATHS.sync, { have: {} })))).failed()).toBeNull();
  });

  test("a key a revoked node ever held is refused, whoever names it after", async () => {
    const held = transportKeyOf(randomBytes(32), gamma.id);
    claim(a.store, gamma, held);
    await until(() => b.fabric.nodeOfKey(held.did)?.id === gamma.id, 15_000, "gamma's own key on beta");
    revokeDevice(a.store, a.identity, gamma.id, "test: its key was read from a backup");
    // alpha names it now, with a proof made for alpha: still nobody's.
    const passed = transportKeyOf(fromSeedOf(held), a.identity.id);
    claim(a.store, a.identity, passed);
    await until(() => (b.store.device(a.identity.id)?.profile?.caps?.qamp as { did?: string } | undefined)?.did === passed.did, 15_000, "alpha's new claim on beta");
    expect(b.fabric.nodeOfKey(passed.did)).toBeNull();
    const k = await answered(knock(FABRIC.sync, await a.fabric.seal(LINK_PATHS.sync, { have: {} }), passed.did));
    expect(k.failed()?.message).toBe("this node takes link calls from the active nodes of its fleet alone, by the key each one's signed profile names");
    // alpha's own key again: alpha's calls are taken.
    claim(a.store, a.identity, alphaKey);
    await until(() => b.fabric.nodeOfKey(alphaKey.did)?.id === a.identity.id, 15_000, "alpha's own key again");
  });
});

describe("a rotation", () => {
  test("gives the node a new transport key, read from its keystore from then on", async () => {
    const before = await homeA.transportKey("file", a.identity.id);
    const view = await admin(homeA, a.port)<{ did: string }>("rotateTransportKey", {});
    expect(view.did).not.toBe(before.did);
    expect((await homeA.transportKey("file", a.identity.id)).did).toBe(view.did);
  });
});

/** The seed a test key was made from (its text is Q-AMP's form of it). */
function fromSeedOf(key: TransportKey): Uint8Array {
  return Uint8Array.from(Buffer.from(key.text.trim().slice("qamp-sk1.".length), "base64url"));
}
