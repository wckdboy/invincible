import { afterEach, expect, test } from "bun:test";
import { newNodeIdentity, type Teammate, type TeamRoom, type TeamTask } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { teamRuntime, type TeamRuntimeDeps } from "../src/team-runtime.ts";
import type { TeamRunContext } from "../src/team.ts";

const stores: MindStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const member: Teammate = { id: "ada", name: "Ada", instructions: "Keep changes small.", role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 0, repository: null, workspaceNode: "host", workspace: { node: "host", id: "0123456789" }, memory: "private working note", createdAt: 1, updatedAt: 1 };
const room: TeamRoom = { id: "forge", name: "Forge", members: ["ada"], direct: false, turnBudget: 4, paused: false, createdAt: 1, updatedAt: 1 };
const task: TeamTask = { id: "task-abcdefghijkl", room: room.id, assignee: member.id, title: "Build", goal: "Build and verify the change.", dependsOn: [], gates: ["bun test required-check"], status: "running", verified: false, progress: "", output: "", error: null, chainId: "chain-test", createdAt: 1, updatedAt: 1 };
const result = () => ({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1, truncated: false }) as const;
const say = (text: string) => ({ content: text });

function fixture(script: object[], overrides: Partial<TeamRuntimeDeps> = {}) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:"); stores.push(store);
  foundFleet(store, identity, { fleetName: "hivemind", nodeName: "keep" });
  const vault = new Vault(store, identity);
  store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  for (const role of ["planner", "engineer", "reviewer"]) store.emit(identity, "roster.set", { role, models: ["local/fake"] });
  const bodies: any[] = [];
  let held = 0;
  const brain = { store, vault, fetch: (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const delta = script.shift() ?? say("GIVE UP\nUnexpected model call.");
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch };
  const deps: TeamRuntimeDeps = {
    brain: () => brain,
    enter: async () => { held++; return () => { held--; }; },
    exec: async (_m, _command) => result(),
    prepare: async () => {},
    tools: () => ({ specs: [], describe: () => ({ title: "unused", input: "" }), run: async () => { throw new Error("unexpected external tool"); } }),
    models: () => [], memories: () => "Shared knowledge.", teammate: () => member,
    dependencies: () => [], stopWorker: async () => {}, ...overrides,
  };
  const context: TeamRunContext = { signal: new AbortController().signal, chainId: task.chainId, send: () => { throw new Error("unexpected send"); }, remember: () => { throw new Error("unexpected local note"); }, delegate: () => { throw new Error("unexpected task"); }, recruit: () => { throw new Error("unexpected knight"); }, emit: () => {} };
  const setRoster = (role: string, models: string[]) => void store.emit(identity, "roster.set", { role, models });
  return { runtime: teamRuntime(deps), context, bodies, held: () => held, setRoster };
}

test("a knight's task whose engineer answered on the reviewer's first model is reviewed by the reviewer's next model", async () => {
  const f = fixture([say("1. Make the change."), say("```sh\necho built\n```"), say("DONE\nBuilt."), say("PASS\nFine.")]);
  f.setRoster("engineer", ["local/er"]);
  f.setRoster("reviewer", ["local/er", "local/rv"]);
  const outcome = await f.runtime.executeTask(member, task, f.context);
  expect(outcome.verified).toBe(true);
  // planner (fake), the engineer's two turns (er), then the reviewer's next model (rv): the reviewer's first model is
  // the same model as the engineer's, so it was asked last.
  expect(f.bodies.map((body) => body.model)).toEqual(["fake", "er", "er", "rv"]);
  expect(f.held()).toBe(0);
});

test("a review answered by the same model that did the work says so once on the trail", async () => {
  const told: string[] = [];
  const f = fixture([say("1. Make the change."), say("```sh\necho one\n```"), say("DONE\nBuilt."), say("REVISE\nMore evidence."), say("```sh\necho two\n```"), say("DONE\nMore."), say("PASS\nFine.")]);
  // Only one model plays the reviewer, and it is the engineer's too: both reviews are answered by the same model.
  f.setRoster("engineer", ["local/er"]);
  f.setRoster("reviewer", ["local/er"]);
  const context: TeamRunContext = { ...f.context, emit: (line) => void told.push(line) };
  const outcome = await f.runtime.executeTask(member, task, context);
  expect(outcome.verified).toBe(true);
  const same = told.filter((line) => line.startsWith("Review · by the same model that did the work"));
  expect(same).toEqual(["Review · by the same model that did the work (local/er): no other reviewer model could answer"]);
  // Said beside the reviews, never in their place: each verdict and its notes are on the trail as ever, the note once
  // just before the first.
  const reviews = told.filter((line) => /^Review · (pass|revise)\n/.test(line));
  expect(reviews).toEqual(["Review · revise\nMore evidence.", "Review · pass\nFine."]);
  expect(told.indexOf(reviews[0]!)).toBe(told.indexOf(same[0]!) + 1);
});
