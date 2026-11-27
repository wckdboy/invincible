import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FABRIC, type HandArgs, newNodeIdentity } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { Handoffs, MAC_TAKES_NO_TASK } from "../src/fabric/handoff.ts";
import type { Fabric } from "../src/fabric/service.ts";
import { type Call, type Invocation, SidecarError } from "../src/fabric/socket.ts";

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

/** A call the node it went to ended in its own words (a refusal there), as the sidecar says one: its chunks none, its result that error. */
function refusedCall(message: string, code: number, name: string): Call {
  // (Its end comes a moment after its chunks, as a call's does: by then it is waited for.)
  const result = new Promise<unknown>((_, reject) => setTimeout(() => reject(new SidecarError("remote", `remote error ${name}: ${message}`, code)), 10));
  return { id: 1, chunks: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }, result, send() {}, end() {}, cancel() {} };
}

function handoffs(db: Database, stopWaitMs: number, over: { mac?: boolean; call?: () => Call } = {}) {
  const fabric = {
    unusable: () => null,
    peerEndpoint: () => ({ did: "did:key:z6Mkbeta", address: "qamp://did:key:z6Mkbeta@127.0.0.1:1" }),
    // (The link call as its node signs it: what it carries is the stand-in call's to ignore.)
    seal: async (path: string, body: unknown) => ({ path, body: JSON.stringify(body), auth: {} }),
    sidecar: { client: { call: over.call ?? (() => silentCall()) }, did: "did:key:z6Mkalpha" },
  } as unknown as Fabric;
  const store = { activeDevice: () => beta, device: () => beta } as unknown as LedgerStore;
  return new Handoffs({ db, store, identity: newNodeIdentity(), fabric, log: () => {}, stopWaitMs, ...(over.mac ? { mac: true } : {}) });
}

/** A task handed to this node, as the fabric gives one to its runner: from beta, a full node of this fleet. */
function handedHere(args: unknown) {
  const failed: { code: number; message: string }[] = [];
  const inv = {
    task: 1,
    tool: FABRIC.hand,
    args,
    caller: "did:key:z6Mkbeta",
    authorization: { kind: "root" },
    chain: [],
    meta: null,
    deadlineMs: 60_000,
    input: true,
    signal: new AbortController().signal,
    inputs: (async function* () {})(),
    emit() {},
    progress() {},
    complete() {},
    fail: (code: number, message: string) => void failed.push({ code, message }),
  } as unknown as Invocation;
  return { inv, failed };
}

async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("it never came");
    await Bun.sleep(5);
  }
}

const TASK: HandArgs = { handoff: "h_0123456789abcdefghijkl", nonce: "n0123456789abcdefghijkl", goal: "Write the file", title: "Write the file", gates: [], tools: [] };

describe("another node's task, handed to a Mac (the owner's decision, 27 November 2026)", () => {
  test("a Mac takes none: refused at once, in words that say why, before anything of it is read", async () => {
    const mac = handoffs(new Database(":memory:"), 20, { mac: true });
    const handed = handedHere(TASK);
    mac.invoked(handed.inv, beta);
    await until(() => handed.failed.length > 0);
    expect(handed.failed).toEqual([{ code: 3, message: MAC_TAKES_NO_TASK }]);
    expect(MAC_TAKES_NO_TASK).toContain("such a task runs in a VM of its own, with a clone of its own of the repository, which only a Linux node with Docker makes");
    // Not even a task it couldn't read: a Mac says why it takes none, whatever it was sent.
    const garbled = handedHere({ not: "a task" });
    mac.invoked(garbled.inv, beta);
    await until(() => garbled.failed.length > 0);
    expect(garbled.failed).toEqual([{ code: 3, message: MAC_TAKES_NO_TASK }]);
    // A node that isn't a Mac reads it on (here it has no agents, so none to give it to).
    const linux = handoffs(new Database(":memory:"), 20);
    const other = handedHere(TASK);
    linux.invoked(other.inv, beta);
    await until(() => other.failed.length > 0);
    expect(other.failed).toEqual([{ code: 1, message: "this node has no agents to give it to" }]);
  });

  test("a refusal there reaches you in that node's own words: never as a link that failed", async () => {
    const h = handoffs(new Database(":memory:"), 20, { call: () => refusedCall(MAC_TAKES_NO_TASK, 3, "UNAUTHORIZED") });
    const view = await h.hand({ node: "beta", goal: "Write the file" }, beta);
    await until(() => h.get(view.id).phase === "ended");
    expect(h.get(view.id)).toMatchObject({ status: "interrupted", error: `beta said: ${MAC_TAKES_NO_TASK}` });
    h.close();
  });
});

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
