import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { newNodeIdentity, type Presence } from "@invincible/core";
import { type Device, foundFleet, LedgerStore } from "@invincible/ledger";
import { Fabric } from "../src/fabric/service.ts";
import type { Sidecar } from "../src/fabric/sidecar.ts";
import { type Call, SidecarError, type SidecarErrorKind } from "../src/fabric/socket.ts";
import { transportKeyOf } from "../src/home.ts";

/*
 * A forwarded route is never sent twice (the fabric re-review, I-c). A forward that failed over Q-AMP went again over
 * HTTP whatever the failure, so one that had reached the peer (its connection lost mid-call, the peer gone silent, its
 * deadline passed) could run there twice: execSandbox, destroySandbox, a write. Now only a call that surely never left,
 * or that the peer's door refused before running anything, goes over HTTP; any other failure says it may have run, and
 * isn't sent again. (The sidecar's `unavailable` is both "couldn't reach it" and "lost it mid-call": its words tell them
 * apart, and what it doesn't say plainly counts as reached.) The link's sync is safe to send again, and still is.
 * Test keys only; addresses from 192.0.2.0/24.
 */

function fabricFailing(error: SidecarError) {
  const self = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, self, { fleetName: "f", nodeName: "self" });
  const peerKey = transportKeyOf(randomBytes(32), "n_" + "B".repeat(43));
  const peer = { id: "n_" + "B".repeat(43), name: "rack", kind: "node", role: "full", profile: { endpoint: "http://192.0.2.12:7400", caps: { qamp: { did: peerKey.did, address: `qamp://${peerKey.did}@192.0.2.12:7410`, pop: peerKey.pop } } } } as unknown as Device;
  const call = () => {
    const c = { id: 1, chunks: { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) }, result: Promise.reject(error), send() {}, end() {}, cancel() {} } as unknown as Call;
    (c.result as Promise<unknown>).catch(() => {});
    return c;
  };
  const fabric = new Fabric({ store, identity: self, sidecar: { state: "up", client: { open: true, call }, did: "did:key:z6Mkself", address: null, pop: null, why: null } as unknown as Sidecar, log: () => {}, presence: async () => ({}) as Presence });
  return { fabric, peer, close: () => (fabric.close(), store.close()) };
}

const failure = (kind: SidecarErrorKind, message: string, code: number | null = null) => new SidecarError(kind, message, code, kind === "unavailable");

describe("a forward that failed over Q-AMP", () => {
  const never: [string, SidecarError][] = [
    ["this node's sidecar couldn't take it", failure("unsent", "the sidecar's socket closed")],
    ["the sidecar refused it", failure("invalid", "invalid argument: bad address")],
    ["no connection could be made", failure("unavailable", "connect: connection refused")],
    ["the connection timed out", failure("unavailable", "connect timed out")],
    ["the peer was going away", failure("unavailable", "peer is going away")],
    ["the peer's door refused it", failure("remote", "remote error UNAUTHORIZED: not this node's key", 3)],
    ["the peer was busy", failure("remote", "remote error OVERLOADED: busy", 6)],
  ];
  for (const [why, error] of never)
    test(`never reached the peer (${why}): it may go over HTTP`, async () => {
      const f = fabricFailing(error);
      expect(await f.fabric.forward(f.peer, "/api/sandbox/exec", { id: "s1" }, 5_000)).toBeNull();
      f.close();
    });

  const reached: [string, SidecarError][] = [
    ["its connection was lost mid-call", failure("unavailable", "connection: connection lost")],
    ["the peer went silent", failure("unavailable", "peer unresponsive")],
    ["this node's sidecar went away during it", failure("unavailable", "the sidecar went away during the call: closed")],
    ["its deadline passed", failure("deadline", "deadline exceeded")],
    ["something else", failure("internal", "wire: bad frame")],
  ];
  for (const [why, error] of reached)
    test(`may have reached it (${why}): it isn't sent again, and says so`, async () => {
      const f = fabricFailing(error);
      await expect(f.fabric.forward(f.peer, "/api/sandbox/exec", { id: "s1" }, 5_000)).rejects.toThrow("it may have run there, so it isn't sent again");
      f.close();
    });

  test("the link's sync is safe to send again: it still goes over HTTP after a call lost mid-way", async () => {
    const f = fabricFailing(failure("unavailable", "connection: connection lost"));
    expect(await f.fabric.sync(f.peer, { have: {} })).toBeNull();
    f.close();
  });
});
