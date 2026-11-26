import { describe, expect, test } from "bun:test";
import { didKeyOfEd25519, newNodeIdentity, signingPublicKey } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { Fabric } from "../src/fabric/service.ts";
import type { Sidecar } from "../src/fabric/sidecar.ts";
import { type Call, SidecarError } from "../src/fabric/socket.ts";

/*
 * The fabric's calling side, with a stand-in sidecar: which path a peer is on after each kind of failure, and when Q-AMP
 * is tried again. (The real sidecars are in fabric.e2e.test.ts.)
 */

/** The stand-in peer's transport key: a test seed's (03…03), made here. */
const PEER_DID = didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(3)));
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
  profile: { endpoint: "http://127.0.0.1:1", caps: { qamp: { did: PEER_DID, address: `qamp://${PEER_DID}@127.0.0.1:7410` } } },
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
