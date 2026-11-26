import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { Fabric } from "../src/fabric/service.ts";
import type { Sidecar } from "../src/fabric/sidecar.ts";
import { type Call, SidecarError } from "../src/fabric/socket.ts";
import { transportKeyOf } from "../src/home.ts";

/*
 * The fabric's calling side, with a stand-in sidecar: which path a peer is on after each kind of failure, and when Q-AMP
 * is tried again. (The real sidecars are in fabric.e2e.test.ts.)
 */

/** The stand-in peer's transport key: a test seed's (03…03), made here, with its proof that it is the peer's. */
const PEER_KEY = transportKeyOf(new Uint8Array(32).fill(3), "n_peer");
const PEER_DID = PEER_KEY.did;
const peer: Device = {
  id: "n_peer",
  name: "beta",
  kind: "node",
  role: "full",
  box: null,
  scopes: [],
  enrolledBy: "n_a",
  enrolledHlc: "0",
  revokedHlc: null,
  profile: { endpoint: "http://127.0.0.1:1", caps: { qamp: { did: PEER_DID, address: `qamp://${PEER_DID}@127.0.0.1:7410`, pop: PEER_KEY.pop } } },
};

/** A fabric whose sidecar answers every call with what `answer` says. */
function fabricWith(answer: () => Promise<unknown>, now: { t: number }) {
  const calls: string[] = [];
  const client = {
    open: true,
    call(_peer: string, tool: string): Call {
      calls.push(tool);
      const result = answer();
      result.catch(() => {});
      return { id: calls.length, chunks: { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }) }, result, send() {}, end() {}, cancel() {} };
    },
  };
  const sidecar = { client, did: "did:key:z6Mkself", address: null, state: "up", why: null } as unknown as Sidecar;
  const store = { onApplied: () => () => {}, devices: () => [peer], activeDevice: () => peer } as unknown as LedgerStore;
  const fabric = new Fabric({ store, identity: newNodeIdentity(), sidecar, log: () => {}, presence: async () => ({}) as never, now: () => now.t });
  return { fabric, calls };
}

describe("when Q-AMP is tried again", () => {
  test("a peer whose door doesn't know this node's key yet (UNAUTHORIZED) is asked again in 2 s, however often it refused", async () => {
    const now = { t: 1_000_000 };
    const { fabric } = fabricWith(() => Promise.reject(new SidecarError("remote", "remote error UNAUTHORIZED: not one of its fleet's keys", 3)), now);
    for (let i = 0; i < 4; i++) {
      expect(await fabric.call(peer, "invincible/link/sync", {})).toEqual({ unavailable: expect.stringContaining("UNAUTHORIZED") });
      expect(fabric.pathOf(peer.id)?.path).toBe("https");
      expect(fabric.unusable(peer)).toMatch(/tried again in 2 s/);
      now.t += 2_001;
      expect(fabric.unusable(peer)).toBeNull();
    }
  });

  test("a peer that can't be reached waits longer each time: 5 s, 10 s, 20 s, to a minute", async () => {
    const now = { t: 1_000_000 };
    const { fabric } = fabricWith(() => Promise.reject(new SidecarError("unavailable", "connection lost")), now);
    for (const seconds of [5, 10, 20, 40, 60, 60]) {
      await fabric.call(peer, "invincible/link/sync", {});
      expect(fabric.unusable(peer)).toMatch(new RegExp(`tried again in ${seconds} s`));
      now.t += seconds * 1000 + 1;
    }
  });

  test("a node from before the fabric (UNKNOWN_TOOL) is asked again in a minute; one that answers over Q-AMP clears the wait", async () => {
    const now = { t: 1_000_000 };
    let answer: () => Promise<unknown> = () => Promise.reject(new SidecarError("remote", "UNKNOWN_TOOL", 1));
    const { fabric } = fabricWith(() => answer(), now);
    await fabric.call(peer, "invincible/link/sync", {});
    expect(fabric.unusable(peer)).toMatch(/tried again in 60 s/);
    now.t += 60_001;
    answer = () => Promise.resolve({ events: [], more: false });
    expect(await fabric.call(peer, "invincible/link/sync", {})).toEqual({ value: { events: [], more: false } });
    expect(fabric.pathOf(peer.id)).toMatchObject({ path: "qamp", why: null });
    expect(fabric.unusable(peer)).toBeNull();
  });

  test("an error the peer answered with over Q-AMP is its answer, not a reason to leave Q-AMP", async () => {
    const now = { t: 1_000_000 };
    const { fabric } = fabricWith(() => Promise.reject(new SidecarError("remote", "the tool failed", 8)), now);
    await expect(fabric.call(peer, "invincible/link/forward", {})).rejects.toThrow("the tool failed");
    expect(fabric.pathOf(peer.id)).toMatchObject({ path: "qamp" });
    expect(fabric.unusable(peer)).toBeNull();
  });
});

describe("who a transport key is", () => {
  const seedOf = (n: number) => new Uint8Array(32).fill(n);
  const did = (n: number) => transportKeyOf(seedOf(n), "n_any").did;
  /** A node whose profile names key `n`, with that key's proof made for `claimedFor` (its own id, unless it lies). */
  const node = (id: string, n: number, opts: { revoked?: boolean; claimedFor?: string } = {}): Device => {
    const key = transportKeyOf(seedOf(n), opts.claimedFor ?? id);
    return { ...peer, id, name: id, revokedHlc: opts.revoked ? "1" : null, profile: { endpoint: "http://127.0.0.1:1", caps: { qamp: { did: key.did, address: `qamp://${key.did}@127.0.0.1:7410`, pop: key.pop } } } };
  };
  const fabricOf = (devices: Device[], earlier: Record<string, unknown[]> = {}) => {
    const sidecar = { client: null, did: "did:key:z6Mkself", address: null, state: "off", why: null } as unknown as Sidecar;
    const store = {
      onApplied: () => () => {},
      devices: (withRevoked = false) => devices.filter((d) => withRevoked || !d.revokedHlc),
      activeDevice: (id: string) => devices.find((d) => d.id === id && !d.revokedHlc) ?? null,
      // Every profile it ever signed: the ones given here, then its latest.
      profilesOf: (id: string) => [...(earlier[id] ?? []), devices.find((d) => d.id === id)?.profile?.caps],
    } as unknown as LedgerStore;
    return new Fabric({ store, identity: newNodeIdentity(), sidecar, log: () => {}, presence: async () => ({}) as never });
  };

  test("the active node whose signed profile names it, with that key's own proof for it", () => {
    expect(fabricOf([node("n_b", 4), node("n_c", 5)]).nodeOfKey(did(5))?.id).toBe("n_c");
  });

  test("a claim on a key it doesn't hold is no claim (L6): the key stays its own node's", () => {
    // n_liar copies n_b's key and its proof: the proof names n_b.
    const f = fabricOf([node("n_b", 4), node("n_liar", 4, { claimedFor: "n_b" })]);
    expect(f.nodeOfKey(did(4))?.id).toBe("n_b");
  });

  test("a key two nodes both hold is neither's", () => {
    const f = fabricOf([node("n_b", 4), node("n_twin", 4), node("n_c", 5)]);
    expect(f.nodeOfKey(did(4))).toBeNull();
    expect(f.nodeOfKey(did(5))?.id).toBe("n_c");
  });

  test("a key no node names, or a revoked node's, is nobody; a key a revoked node ever held is nobody's, whoever names it after", () => {
    expect(fabricOf([node("n_b", 4), node("n_gone", 6, { revoked: true })]).nodeOfKey(did(7))).toBeNull();
    expect(fabricOf([node("n_b", 4), node("n_gone", 6, { revoked: true })]).nodeOfKey(did(6))).toBeNull();
    // n_gone held key 8 once (an earlier profile), then moved to 6, and was revoked; n_b names 8 now, with a proof for itself.
    const f = fabricOf([node("n_b", 8), node("n_gone", 6, { revoked: true })], { n_gone: [node("n_gone", 8).profile!.caps] });
    expect(f.nodeOfKey(did(8))).toBeNull();
  });
});

describe("plain HTTP to a peer that speaks Q-AMP (L7)", () => {
  const withEndpoint = (endpoint: string, qamp = true): Device => ({ ...peer, profile: { endpoint, caps: qamp ? peer.profile!.caps : {} } });
  const fabricOf = (state: "up" | "down" | "off") => {
    const sidecar = { client: null, did: "did:key:z6Mkself", address: null, state, why: null } as unknown as Sidecar;
    const store = { onApplied: () => () => {}, devices: () => [], activeDevice: () => null } as unknown as LedgerStore;
    return new Fabric({ store, identity: newNodeIdentity(), sidecar, log: () => {}, presence: async () => ({}) as never });
  };

  test("off the tailnet, while this node runs its sidecar (up or down), it is refused, and says why", () => {
    for (const state of ["up", "down"] as const) expect(fabricOf(state).httpRefused(withEndpoint("http://192.0.2.10:7400"))).toBe("beta speaks Q-AMP, and its HTTP endpoint (192.0.2.10) is off the tailnet: its requests and answers would travel in clear, so it waits for Q-AMP (invincible fabric off on this node goes back to HTTP knowingly)");
  });

  test("on the tailnet or this machine, to a peer without Q-AMP, or with this node's fabric off: HTTP, as before", () => {
    // (A tailnet address, made from RFC 6598's numbers: no real host.)
    expect(fabricOf("up").httpRefused(withEndpoint(`http://${[100, 70, 1, 2].join(".")}:7400`))).toBeNull();
    expect(fabricOf("up").httpRefused(withEndpoint("http://[fd7a:115c:a1e0::5]:7400"))).toBeNull();
    expect(fabricOf("up").httpRefused(withEndpoint("http://127.0.0.1:7400"))).toBeNull();
    expect(fabricOf("up").httpRefused(withEndpoint("http://192.0.2.10:7400", false))).toBeNull();
    expect(fabricOf("off").httpRefused(withEndpoint("http://192.0.2.10:7400"))).toBeNull();
  });
});

describe("a node revoked here (I3)", () => {
  test("its forwarded work under way is cut off: the route's own signal aborts, so the work stops, not only its answer", async () => {
    const alpha = newNodeIdentity();
    const key = transportKeyOf(new Uint8Array(32).fill(4), alpha.id);
    const device: Device = { ...peer, id: alpha.id, name: "alpha", profile: { endpoint: "http://127.0.0.1:1", caps: { qamp: { did: key.did, address: `qamp://${key.did}@127.0.0.1:7410`, pop: key.pop } } } };
    let revoked = false;
    const listeners: ((events: { kind: string; body: unknown }[], rebuilt: boolean) => void)[] = [];
    const store = {
      onApplied: (listener: (typeof listeners)[number]) => (listeners.push(listener), () => {}),
      devices: (withRevoked = false) => (withRevoked || !revoked ? [device] : []),
      activeDevice: (id: string) => (id === alpha.id && !revoked ? device : null),
      profilesOf: () => [],
    } as unknown as LedgerStore;
    const sidecar = { client: null, did: "did:key:z6Mkself", address: null, state: "up", why: null } as unknown as Sidecar;
    let routeSignal: AbortSignal | null = null;
    const fabric = new Fabric({
      store,
      identity: newNodeIdentity(),
      sidecar,
      log: () => {},
      presence: async () => ({}) as never,
      // A long command in a sandbox: it waits on its signal, as the server's route does.
      route: (_path, _body, _principal, signal) => ((routeSignal = signal), new Promise(() => {})),
    });
    const sealer = new Fabric({ store, identity: alpha, sidecar, log: () => {}, presence: async () => ({}) as never });
    let failed: { code: number; message: string } | null = null;
    const inv = { task: 1, tool: "invincible/link/forward", args: await sealer.seal("/api/sandboxes/exec", { id: "0a1b2c3d4e", cmd: ["sleep", "4500"] }), caller: key.did, authorization: { kind: "public" }, chain: [], meta: null, deadlineMs: null, input: false, signal: new AbortController().signal, inputs: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }, emit() {}, progress() {}, complete() {}, fail: (code: number, message: string) => void (failed = { code, message }) };
    fabric.door(inv as never);
    for (let i = 0; i < 50 && !routeSignal; i++) await Bun.sleep(10);
    expect(routeSignal).not.toBeNull();
    revoked = true;
    for (const listener of listeners) listener([{ kind: "device.revoked", body: { device: alpha.id } }], false);
    expect(failed as { code: number; message: string } | null).toEqual({ code: 3, message: "this node was revoked" });
    expect((routeSignal as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe("each of the fabric's tools declares one scope, and its caller must hold it (I5)", () => {
  test("a limited node holding only what it was given: its sync over Q-AMP needs mind:read, its push mind:write", async () => {
    const node = newNodeIdentity();
    const key = transportKeyOf(new Uint8Array(32).fill(5), node.id);
    const limited: Device = { ...peer, id: node.id, name: "sensor", role: "limited", scopes: ["mind:read"], profile: { endpoint: "http://127.0.0.1:1", caps: { qamp: { did: key.did, address: `qamp://${key.did}@127.0.0.1:7410`, pop: key.pop } } } };
    const store = { onApplied: () => () => {}, devices: () => [limited], activeDevice: (id: string) => (id === node.id ? limited : null), profilesOf: () => [], eventsSince: () => ({ events: [], more: false }) } as unknown as LedgerStore;
    const sidecar = { client: null, did: "did:key:z6Mkself", address: null, state: "up", why: null } as unknown as Sidecar;
    const fabric = new Fabric({ store, identity: newNodeIdentity(), sidecar, log: () => {}, presence: async () => ({}) as never });
    const sealer = new Fabric({ store, identity: node, sidecar, log: () => {}, presence: async () => ({}) as never });
    const knock = (tool: string, args: unknown) =>
      new Promise<string>((resolve) => fabric.door({ task: 1, tool, args, caller: key.did, authorization: { kind: "public" }, chain: [], meta: null, deadlineMs: null, input: false, signal: new AbortController().signal, inputs: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }, emit() {}, progress() {}, complete: () => resolve("taken"), fail: (code: number, message: string) => resolve(`${code}: ${message}`) } as never));
    expect(await knock("invincible/link/sync", await sealer.seal("/link/sync", { have: {} }))).toBe("taken");
    expect(await knock("invincible/link/push", await sealer.seal("/link/push", { events: [] }))).toBe("3: refused: invincible/link/push needs mind:write, which sensor doesn't hold");
    expect(await knock("invincible/task/hand", await sealer.seal("/fabric/hand", {}))).toBe("3: refused: invincible/task/hand needs fleet:admin, which sensor doesn't hold");
  });
});
