import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { newNodeIdentity } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { Handoffs } from "../src/fabric/handoff.ts";
import type { Fabric } from "../src/fabric/service.ts";
import type { Call } from "../src/fabric/socket.ts";

/*
 * The hand-off's own state, with a stand-in fabric: what it does when the node it lives in stops. (The whole of it, with
 * real sidecars, is fabric-handoff.e2e.test.ts.)
 */

const beta = { id: "n_beta", name: "beta", kind: "node", role: "full", profile: { endpoint: "http://127.0.0.1:1", caps: {} } } as unknown as Device;

/** A call that never ends: the runner never answers. */
function silentCall(): Call {
  const result = new Promise<unknown>(() => {});
  return { id: 1, chunks: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, result, send() {}, end() {}, cancel() {} };
}

function handoffs(db: Database, stopWaitMs: number) {
  const fabric = {
    unusable: () => null,
    peerEndpoint: () => ({ did: "did:key:z6Mkbeta", address: "qamp://did:key:z6Mkbeta@127.0.0.1:1" }),
    // (The link call as its node signs it: what it carries is the stand-in call's to ignore.)
    seal: async (path: string, body: unknown) => ({ path, body: JSON.stringify(body), auth: {} }),
    sidecar: { client: { call: () => silentCall() }, did: "did:key:z6Mkalpha" },
  } as unknown as Fabric;
  const store = { activeDevice: () => beta, device: () => beta } as unknown as LedgerStore;
  return new Handoffs({ db, store, identity: newNodeIdentity(), fabric, log: () => {}, stopWaitMs });
}

describe("a hand-off when its node stops", () => {
  test("a stop asked just before the node stops never touches the node's closed database afterwards", async () => {
    const db = new Database(":memory:");
    const h = handoffs(db, 20);
    const view = await h.hand({ node: "beta", goal: "Never answered" }, beta);
    h.stop(view.id);
    // The node stops: the hand-offs first, then its database.
    h.close();
    db.close();
    const errors: unknown[] = [];
    const caught = (error: unknown) => errors.push(error);
    process.on("uncaughtException", caught);
    try {
      await Bun.sleep(80);
    } finally {
      process.off("uncaughtException", caught);
    }
    expect(errors).toEqual([]);
  });
});
