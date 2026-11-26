// Run as a process of its own (fabric-runner.test.ts): an error inside a hand-off's run here fails that hand-off,
// never the process, as it would otherwise end the node (Bun ends a process on an unhandled rejection).
import { Database } from "bun:sqlite";
import { FABRIC, newNodeIdentity, randomId, type TeamTask } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { Handoffs } from "../src/fabric/handoff.ts";
import type { Fabric } from "../src/fabric/service.ts";
import type { Invocation } from "../src/fabric/socket.ts";

const alpha = { id: "n_alpha", name: "alpha", kind: "node", role: "full" } as unknown as Device;
const fabric = { sidecar: { client: null, did: null } } as unknown as Fabric;
const store = { activeDevice: () => alpha, device: () => alpha, handoffGrant: () => null } as unknown as LedgerStore;
const h = new Handoffs({ db: new Database(":memory:"), store, identity: newNodeIdentity(), fabric, log: () => {} });
const task = { id: "task-aaaaaaaaaaaa", status: "running", verified: false, output: "", error: null } as unknown as TeamTask;
h.attachTeam({
  give: async () => ({ task, agent: { id: "ada", name: "Ada" } }),
  task: () => task,
  // As TeamService.trail does for a task it no longer has, or any query on a closed database.
  trail: () => {
    throw new Error("No such team task.");
  },
  stop() {},
  runningIn: () => null,
  handed: () => ({ atOnce: 0, given: 0 }),
  handedOpen: () => [],
});
const inv = {
  task: 1,
  tool: FABRIC.hand,
  args: { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: "g", title: "t", gates: [], tools: [] },
  caller: "did:key:z6Mk",
  authorization: { kind: "public" },
  chain: [],
  meta: null,
  deadlineMs: null,
  input: false,
  signal: new AbortController().signal,
  inputs: { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) },
  emit() {},
  progress() {},
  complete() {},
  fail: (code: number, message: string) => console.log(`the hand-off failed: ${code}: ${message}`),
} as unknown as Invocation;
h.invoked(inv, alpha);
setTimeout(() => console.log("still running after 300 ms"), 300);
