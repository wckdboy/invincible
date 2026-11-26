import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, type LedgerEntry, type LoopView, type QuestView, REFERENCE_SINGLE, routes, type RouteName } from "@galahad/core";
import type { QuestEvent } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { runNodeQuest } from "../src/quest-cli.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * Gates on a quest, end to end over real HTTP on a real node (stand-ins only for Docker
 * and for the models): a gate that fails once sends the work back, and the reviewer is
 * asked only after it passes; a gate that never passes means the quest is never done;
 * every gate is a ledgered command in the quest's own sandbox; with effort, each attempt
 * runs the gates in its own sandbox; a loop's quest carries its gates.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "gates-test",
  cores: 32,
  cpu: "test",
  memoryGb: 128,
  hasBattery: false,
  gpu: [],
  docker: true,
  vm: { kvm: false, tools: [] },
  tools: ["git", "docker"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true },
};

const root = mkdtempSync(join(tmpdir(), "galahad-gates-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1200, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads }, memoryGbps: 9.5 };
};

/** The stand-in models. The engineer writes, says DONE, and when sent back fixes it and says DONE again. */
/** Every model call: whose turn it reads as (from what it is asked), what it was last told, and the model asked. */
const asked: { role: string; prompt: string; model?: string }[] = [];
let atReview: QuestView[] = [];
let plan ="1. Write the file.\n2. Check it.\nDone when: the file is there and says hi.";
const fence = "```";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const first = turns[0]?.content ?? "";
    const last = turns.at(-1)?.content ?? "";
    let role = "planner";
    let text = plan;
    if (first.startsWith("You are choosing between")) {
      role = "pick";
      text = "PICK A\nA's evidence is complete.";
    } else if (first.startsWith("You are reviewing")) {
      role = "reviewer";
      text = "PASS\nThe gates passed and the file is there.";
      // What the node shows of the quest while its review is under way.
      for (let i = 0; i < 200 && !(atReview = (await call<{ quests: QuestView[] }>("quests")).quests.filter((q) => q.state === "reviewing")).length; i++) await Bun.sleep(5);
    } else if (first.startsWith("Quest:")) {
      role = "engineer";
      const said = turns.filter((m) => m.role === "assistant").length;
      if (said === 0) text = `Writing it.\n${fence}sh\ntouch /work/out/hi.txt\n${fence}`;
      else if (/gates? did not pass/.test(last)) text = `The gate is right: the file is empty.\n${fence}sh\necho hi > /work/out/hi.txt\n${fence}`;
      else text = "DONE\nThe file is there.";
    }
    asked.push({ role, prompt: last, model: body.model });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

async function call<T = any>(name: RouteName, input?: unknown, token = home.adminToken()): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; status?: number };
  if (!response.ok) throw new Error(`${name} → ${response.status} ${body.error ?? ""}`);
  if (typeof body.error === "string" && typeof body.status === "number") throw new Error(`${name} → ${body.status} ${body.error}`);
  return body as T;
}

const client = () => new LocalClient(`http://127.0.0.1:${port}`, home.adminToken());
const GATE = "test -s /work/out/hi.txt";
/** What ran in a sandbox, as the shell saw it. */
const ran = (container?: string) => docker.execs.filter((e) => !container || e.container === container).map((e) => e.cmd.at(-1)!);

/** The stand-in sandbox: a file that's been written to is non-empty, per container; the gate checks exactly that. */
function scriptSandbox(opts: { neverPasses?: boolean } = {}): void {
  const written = new Set<string>();
  docker.onExec = (container, cmd) => {
    const command = cmd.at(-1)!;
    if (command.startsWith("echo hi >")) written.add(container);
    if (command === GATE) return !opts.neverPasses && written.has(container) ? { code: 0, stdout: "" } : { code: 1, stdout: "", stderr: "hi.txt is empty\n" };
    return { code: 0, stdout: "" };
  };
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure, slotWaitMs: 4_000 });
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const role of ["planner", "reviewer", "engineer"]) await call("setRoster", { role, models: ["stand-in/m"] });
});

afterAll(async () => {
  await daemon?.stop();
  models.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("gates on a quest, on a real node", () => {
  test("a gate that fails once: the work goes back, is revised, the gate passes, and only then is the reviewer asked", async () => {
    asked.length = 0;
    docker.execs.length = 0;
    scriptSandbox();
    const events: QuestEvent[] = [];
    const { outcome, quest } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE] }, { emit: (event) => void events.push(event) });
    expect(outcome).toMatchObject({ status: "done", revisions: 1 });
    expect(outcome.gates).toMatchObject([{ command: GATE, by: "owner", exitCode: 0 }]);
    // In order: the engineer's command, the gate (fails), the fix, the gate (passes); the one review comes last.
    expect(ran().filter((c) => c === GATE || c.includes("hi.txt"))).toEqual(["touch /work/out/hi.txt", GATE, "echo hi > /work/out/hi.txt", GATE]);
    expect(asked.map((a) => a.role)).toEqual(["planner", "engineer", "engineer", "engineer", "engineer", "reviewer"]);
    // The engineer got the gate's command, exit code and output back; the reviewer sees both runs.
    const sentBack = asked[3]!.prompt;
    expect(sentBack).toContain(`$ ${GATE}`);
    expect(sentBack).toContain("exit 1");
    expect(sentBack).toContain("hi.txt is empty");
    const review = asked.at(-1)!.prompt;
    expect(review).toMatch(/run 1[^\n]*exit 1/);
    expect(review).toContain("all did on run 2");
    expect(events.filter((e) => e.type === "gated").map((e) => (e.type === "gated" ? e.passed : null))).toEqual([false, true]);
    // Each gate run is in the ledger under the quest, like every other command.
    const { entries } = await call<{ entries: LedgerEntry[] }>("ledger");
    const gateRuns = entries.filter((e) => e.resource === "sandbox.exec" && e.quest === quest && e.detail?.includes(GATE));
    expect(gateRuns.map((e) => e.detail).sort()).toEqual([`bash -c ${GATE} → exit 0`, `bash -c ${GATE} → exit 1`]);
    // And it's remembered with its gates.
    const { memories } = await call<{ memories: { text: string }[] }>("recall", { q: "Gates" });
    expect(memories[0]!.text).toContain(`Gates: 1 of 1 passed ($ ${GATE})`);
    expect(docker.running()).toBe(0);
  });

  test("a gate that never passes: the quest is never done, and the reviewer's model call is never spent", async () => {
    asked.length = 0;
    docker.execs.length = 0;
    scriptSandbox({ neverPasses: true });
    const { outcome } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE] });
    expect(outcome.status).toBe("unverified");
    expect(outcome.status).not.toBe("done");
    expect(outcome.review).toContain(`$ ${GATE}`);
    expect(outcome.gates).toMatchObject([{ command: GATE, exitCode: 1 }]);
    expect(asked.filter((a) => a.role === "reviewer")).toHaveLength(0);
    // The gate ran on each of the three submissions (the first, and two revisions): no more.
    expect(ran().filter((c) => c === GATE)).toHaveLength(3);
    const { memories } = await call<{ memories: { text: string }[] }>("recall", { q: "unverified" });
    expect(memories[0]!.text).toContain("Quest (unverified)");
    expect(memories[0]!.text).toContain(`Gates: 0 of 1 passed; failed: $ ${GATE} (exit 1)`);
  });

  test("the planner's own gates run only when asked for, after yours, marked as its proposal", async () => {
    asked.length = 0;
    docker.execs.length = 0;
    scriptSandbox();
    plan = "1. Write the file.\nDone when: the file is there and says hi.\nGate: grep -q hi /work/out/hi.txt";
    try {
      const events: QuestEvent[] = [];
      const { outcome } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE], proposeGates: true }, { emit: (event) => void events.push(event) });
      expect(outcome.status).toBe("done");
      expect(outcome.gates!.map((g) => [g.command, g.by])).toEqual([
        [GATE, "owner"],
        ["grep -q hi /work/out/hi.txt", "planner"],
      ]);
      expect(events.find((e) => e.type === "gates")).toMatchObject({ gates: [{ by: "owner" }, { by: "planner" }] });
      // Without it, the plan's Gate: line is only text.
      docker.execs.length = 0;
      const plain = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated" });
      expect(plain.outcome.gates).toBeUndefined();
      expect(ran().some((c) => c.startsWith("grep -q hi"))).toBe(false);
    } finally {
      plan = "1. Write the file.\n2. Check it.\nDone when: the file is there and says hi.";
    }
  });

  test("with effort, each attempt runs the gates in its own sandbox", async () => {
    asked.length = 0;
    docker.execs.length = 0;
    scriptSandbox();
    const { outcome, effort } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE], effort: 2 });
    expect(effort!.attempts).toEqual([
      { index: 1, status: "done" },
      { index: 2, status: "done" },
    ]);
    expect(outcome.status).toBe("done");
    const containers = [...new Set(docker.execs.filter((e) => e.cmd.at(-1) === GATE).map((e) => e.container))];
    expect(containers).toHaveLength(2);
    // In each: failed once (the empty file), then passed.
    for (const container of containers) expect(ran(container).filter((c) => c === GATE)).toHaveLength(2);
    // The pick compares attempts that each show their gates' last run.
    expect(asked.find((a) => a.role === "pick")!.prompt).toContain(`$ ${GATE}`);
  }, 20_000);

  test("a gate that looks like a key is refused before anything runs", async () => {
    docker.execs.length = 0;
    const before = docker.peak();
    await expect(runNodeQuest(client(), { goal: "write hi", network: "isolated", gates: [`curl -H 'x-api-key: sk-ant-api03-${"FAKE".repeat(8)}' http://example.test`] })).rejects.toThrow(/looks like a/i);
    await expect(runNodeQuest(client(), { goal: "write hi", network: "isolated", gates: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })).rejects.toThrow();
    expect(docker.execs).toHaveLength(0);
    expect(docker.peak()).toBe(before);
  });
});

describe("a gate that fails twice in a row", () => {
  test("moves the rest of the work to the planner's models, by default; with the engineer held to one model, the work stays his", async () => {
    asked.length = 0;
    docker.execs.length = 0;
    scriptSandbox({ neverPasses: true });
    // The planner's models are told apart from the engineer's by name.
    await call("setRoster", { role: "planner", models: ["stand-in/strong"] });
    try {
      const events: QuestEvent[] = [];
      const { outcome } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE] }, { emit: (event) => void events.push(event) });
      expect(outcome.status).toBe("unverified");
      expect(events.filter((e) => e.type === "escalated")).toEqual([{ type: "escalated", to: "planner", gate: GATE }]);
      // The work's turns: the engineer's model for the first two submissions, the planner's for the third.
      const work = asked.filter((a) => a.role === "engineer").map((a) => a.model);
      expect(work.slice(0, 2)).toEqual(["m", "m"]);
      expect(work.at(-1)).toBe("strong");
      expect(new Set(work).size).toBe(2);

      asked.length = 0;
      events.length = 0;
      const held = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE], pins: { engineer: "stand-in/m" } }, { emit: (event) => void events.push(event) });
      expect(held.outcome.status).toBe("unverified");
      expect(events.some((e) => e.type === "escalated")).toBe(false);
      expect(asked.filter((a) => a.role === "engineer").every((a) => a.model === "m")).toBe(true);
    } finally {
      await call("setRoster", { role: "planner", models: ["stand-in/m"] });
    }
  });
});

describe("seeing where a quest is", () => {
  test("the node shows its plan, the step he's on and each gate's last result while it runs, and how it ended", async () => {
    asked.length = 0;
    atReview = [];
    scriptSandbox();
    const { quest } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", gates: [GATE] });
    // While the reviewer read the evidence: under review, the gate passed on its second run, one revision.
    expect(atReview).toHaveLength(1);
    expect(atReview[0]).toMatchObject({
      quest,
      by: "you",
      goal: "write hi to a file",
      state: "reviewing",
      step: 2,
      maxSteps: 30,
      revisions: 1,
      silent: false,
      gates: [{ command: GATE, by: "owner", exitCode: 0 }],
    });
    expect(atReview[0]!.plan).toContain("Done when: the file is there and says hi.");
    // Afterwards: done, with its summary; an agent may read it, as it may the ledger.
    const { token } = await call<{ token: string }>("mintArm", { label: "reader" });
    const { quests } = await call<{ quests: QuestView[] }>("quests", undefined, token);
    const ended = quests.find((q) => q.quest === quest)!;
    expect(ended).toMatchObject({ state: "done", step: 2, summary: "The file is there." });
    expect(ended.doing).toBeUndefined();
  });

  test("a quest that can't run at all is shown as failed, with why; a gate that never passes, as unverified with the failure", async () => {
    scriptSandbox({ neverPasses: true });
    const { quest } = await runNodeQuest(client(), { goal: "write hi, but the gate never passes", network: "isolated", gates: [GATE] });
    const shown = (await call<{ quests: QuestView[] }>("quests")).quests.find((q) => q.quest === quest)!;
    expect(shown).toMatchObject({ state: "unverified", revisions: 2, gates: [{ command: GATE, exitCode: 1 }] });
    expect(shown.gates[0]!.excerpt).toContain("hi.txt is empty");
    // No sandbox host by that name: nothing runs.
    await expect(runNodeQuest(client(), { goal: "nowhere to run", network: "isolated", on: "no-such-node" })).rejects.toThrow();
    const failed = (await call<{ quests: QuestView[] }>("quests")).quests.find((q) => q.goal === "nowhere to run")!;
    expect(failed).toMatchObject({ state: "failed", step: 0 });
    expect(failed.summary).toMatch(/no-such-node/);
  });

  test("with effort each attempt stands on its own; a loop's and an agent's quests are theirs, never yours", async () => {
    scriptSandbox();
    const { quest } = await runNodeQuest(client(), { goal: "write hi twice over", network: "isolated", gates: [GATE], effort: 2 });
    const attempts = (await call<{ quests: QuestView[] }>("quests")).quests.filter((q) => q.attempt?.of === quest);
    expect(attempts.map((q) => [q.quest, q.attempt!.index, q.attempt!.attempts, q.state]).sort()).toEqual([
      [`${quest}.1`, 1, 2, "done"],
      [`${quest}.2`, 2, 2, "done"],
    ]);
    // An agent reporting under one of your quests' names changes nothing of yours.
    const { token } = await call<{ token: string }>("mintArm", { label: "forger" });
    await call("questProgress", { quest: `${quest}.1`, goal: "forged", state: "failed", step: 0, maxSteps: 1, revisions: 0, gates: [] }, token);
    const after = (await call<{ quests: QuestView[] }>("quests")).quests.filter((q) => q.quest === `${quest}.1`);
    expect(after.map((q) => [q.by, q.state]).sort()).toEqual([
      ["forger", "failed"],
      ["you", "done"],
    ]);
    // Reporting needs the sandbox scope; an agent without it can't.
    const { token: reader } = await call<{ token: string }>("mintArm", { label: "no-sandbox", scopes: ["mind:read"] });
    await expect(call("questProgress", { quest: "q-x", goal: "g", state: "working", step: 0, maxSteps: 1, revisions: 0, gates: [] }, reader)).rejects.toThrow(/403/);
  }, 20_000);
});

describe("a loop's quest carries its gates", () => {
  test("set through the API, checked there, and run by the loop", async () => {
    asked.length = 0;
    docker.execs.length = 0;
    scriptSandbox();
    await expect(call("setLoop", { name: "bad", schedule: "every 30m", task: { kind: "quest", goal: "g", network: "isolated", gates: [""] } })).rejects.toThrow(/400/);
    await expect(call("setLoop", { name: "bad", schedule: "every 30m", task: { kind: "quest", goal: "g", network: "isolated", gates: [`echo sk-ant-api03-${"FAKE".repeat(8)}`] } })).rejects.toThrow(/422/);
    const { loop } = await call<{ loop: LoopView }>("setLoop", { name: "hi", schedule: "every 30m", task: { kind: "quest", goal: "write hi to a file", network: "isolated", gates: [GATE] } });
    expect(loop.task).toMatchObject({ kind: "quest", gates: [GATE] });
    await call("runLoop", { name: "hi" });
    await daemon.loops.settled("hi");
    const run = daemon.store.loopRuns("hi", 1)[0]!.body;
    expect(run.status).toBe("ok");
    expect(ran().filter((c) => c === GATE)).toHaveLength(2);
    // A loop is him on his own: the planner proposes nothing there; your gates are the gates.
    expect(asked.find((a) => a.role === "planner")!.prompt).not.toContain("Gate:");
    await call("removeLoop", { name: "hi" });
  }, 20_000);
});
