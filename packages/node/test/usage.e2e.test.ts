import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, costOf, type Price, REFERENCE_SINGLE, routes, type RouteName, spendTotal, type TrialView, type UsageMeter, type UsageView } from "@galahad/core";
import { ENGINEERING_SUITE, pose, type QuestEvent } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { runNodeQuest } from "../src/quest-cli.ts";
import { runTrials } from "../src/trial-cli.ts";
import { UsageStore } from "../src/usage.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * What model calls cost, end to end over real HTTP on a real node (stand-ins only for
 * Docker and for the models, which report their usage as a provider does): a quest's
 * calls are counted by role and model and come back with it; the node keeps its own
 * count by day and who asked; your prices turn tokens into money and are yours alone
 * to state; a trial's spend is recorded beside it in the log. Counts only, anywhere.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "usage-test",
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

const root = mkdtempSync(join(tmpdir(), "galahad-usage-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1200, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads }, memoryGbps: 9.5 };
};

const SECRET_WORDS = "the-prompt-and-the-answer-never-leave";
const fence = "```";
/** The stand-in provider: `counted` reports its usage in the stream's last chunk (when asked to), `silent` never does. */
const requests: { model: string; askedUsage: boolean }[] = [];
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { model: string; stream_options?: { include_usage?: boolean }; messages: { role: string; content: string }[] };
    requests.push({ model: body.model, askedUsage: !!body.stream_options?.include_usage });
    const turns = body.messages.filter((m) => m.role !== "system");
    const first = turns[0]?.content ?? "";
    let text = `1. Do it (${SECRET_WORDS}).\nDone when: it is done.`;
    if (first.startsWith("You are reviewing")) text = "PASS\nIt is there.";
    else if (first.startsWith("Quest:")) text = turns.filter((m) => m.role === "assistant").length === 0 ? `Doing it.\n${fence}sh\ntouch /work/out/done\n${fence}` : "DONE\nIt is done.";
    const frames = [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
    // What a provider counts: here, a token a character, a tenth of the prompt read from its cache.
    const prompt = body.messages.reduce((n, m) => n + m.content.length, 0);
    const usage = body.model === "silent" || !body.stream_options?.include_usage ? [] : [{ choices: [], usage: { prompt_tokens: prompt, completion_tokens: text.length, prompt_tokens_details: { cached_tokens: Math.floor(prompt / 10) } } }];
    return new Response([...frames, ...usage].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
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
  return body as T;
}

const client = (token = home.adminToken()) => new LocalClient(`http://127.0.0.1:${port}`, token);
const hire = async (model: string) => {
  for (const role of ["planner", "reviewer", "engineer"]) await call("setRoster", { role, models: [`stand-in/${model}`] });
};

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure, slotWaitMs: 4_000 });
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  await hire("counted");
});

afterAll(async () => {
  await daemon?.stop();
  models.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("what a quest's model calls came to", () => {
  test("counted by role and model as the provider reported them, and handed back with the quest", async () => {
    requests.length = 0;
    const { outcome, usage } = await runNodeQuest(client(), { goal: "make the file", network: "isolated", remember: false });
    expect(outcome.status).toBe("done");
    // One plan, two engineer turns (a command, then DONE), one review: each asked the provider for its usage.
    expect(requests.every((r) => r.askedUsage)).toBe(true);
    expect(usage.map((l) => [l.role, l.model, l.calls, l.unknown])).toEqual([
      ["planner", "stand-in/counted", 1, 0],
      ["engineer", "stand-in/counted", 2, 0],
      ["reviewer", "stand-in/counted", 1, 0],
    ]);
    for (const line of usage) {
      expect(line.input).toBeGreaterThan(100);
      expect(line.output).toBeGreaterThan(5);
      // A tenth of each prompt came from the provider's cache, as it said.
      expect(line.cached).toBeGreaterThan(0);
      expect(line.cached).toBeLessThan(line.input);
    }
    expect(JSON.stringify(usage)).not.toContain(SECRET_WORDS);
  });

  test("a provider that says nothing: the calls are counted and their tokens are unknown, never estimated", async () => {
    await hire("silent");
    try {
      const { usage } = await runNodeQuest(client(), { goal: "make the file", network: "isolated", remember: false });
      expect(usage.map((l) => [l.role, l.calls, l.unknown, l.input, l.output])).toEqual([
        ["planner", 1, 1, 0, 0],
        ["engineer", 2, 2, 0, 0],
        ["reviewer", 1, 1, 0, 0],
      ]);
      expect(spendTotal(usage)).toMatchObject({ calls: 4, unknown: 4, tokens: 0, complete: false });
    } finally {
      await hire("counted");
    }
  });
});

describe("the node's own count, and your prices", () => {
  test("by day, who asked, role and model: counts only, in the node's own database, never the mind's log", async () => {
    const view = await call<UsageView>("usage", { days: 7 });
    expect(view.node).toBe("ultra");
    const today = new Date().toISOString().slice(0, 10);
    const mine = view.rows.filter((r) => r.who === "you" && r.model === "stand-in/counted");
    expect(mine.map((r) => r.role).sort()).toEqual(["engineer", "planner", "reviewer"]);
    expect(mine.every((r) => r.day === today && r.unknown === 0 && r.input > 0)).toBe(true);
    expect(view.rows.find((r) => r.model === "stand-in/silent" && r.role === "engineer")).toMatchObject({ calls: 2, unknown: 2, input: 0, output: 0 });
    // The table holds numbers and names of models: nothing a model read or wrote.
    const local = new Database(home.localPath, { readonly: true });
    try {
      const dump = JSON.stringify(local.query("SELECT * FROM usage_daily").all());
      expect(dump).toContain("stand-in/counted");
      expect(dump).not.toContain(SECRET_WORDS);
      expect(dump).not.toContain("make the file");
    } finally {
      local.close();
    }
    // And none of it is in the log: per-call counts are this node's telemetry, not something replicas decide on.
    const store = new MindStore(home.mindPath);
    try {
      expect(store.eventsSince({}, 100_000).events.some((e) => e.kind.startsWith("usage"))).toBe(false);
    } finally {
      store.close();
    }
  });

  test("an agent's calls are counted as the agent's", async () => {
    const { token } = await call<{ token: string }>("mintArm", { label: "scribe" });
    const response = await fetch(`http://127.0.0.1:${port}${routes.chat.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Plan something small." }], tools: false }),
    });
    expect(await response.text()).toContain('"type":"usage"');
    const view = await call<UsageView>("usage", {});
    expect(view.rows.find((r) => r.who === "arm:scribe")).toMatchObject({ role: "planner", model: "stand-in/counted", calls: 1, unknown: 0 });
  });

  test("a coding tool's calls through the gateway are counted too, as its token's, under the role tool", async () => {
    // (A knight's VM calls with a token labelled for the VM: sandbox:<its id>.)
    const { token } = await call<{ token: string }>("mintToken", { label: "sandbox:0123456789", providers: ["stand-in"] });
    const response = await fetch(`http://127.0.0.1:${port}/gw/stand-in/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "counted", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Quest: make the file" }] }),
    });
    expect(await response.text()).toContain('"usage"');
    const view = await call<UsageView>("usage", {});
    expect(view.rows.find((r) => r.who === "sandbox:0123456789")).toMatchObject({ role: "tool", model: "stand-in/counted", calls: 1, unknown: 0 });
  });

  test("tokens always; money only where you've stated a price, yours alone to state", async () => {
    const before = await call<UsageView>("usage", {});
    expect(before.prices).toEqual({});
    const counted = before.rows.filter((r) => r.model === "stand-in/counted");
    expect(costOf(counted, before.prices)).toMatchObject({ usd: 0, unpriced: ["stand-in/counted"], complete: false });

    // The coding plans are said beside your prices: their calls are paid for already (moneyPrices).
    expect((await call<{ plans: string[] }>("prices")).plans).toEqual(expect.arrayContaining(["opencode-go", "zai-coding", "mimo-token"]));
    const { prices } = await call<{ prices: Record<string, Price> }>("setPrice", { model: "stand-in/counted", input: 2, output: 8, cached: 0.2 });
    expect(prices).toEqual({ "stand-in/counted": { input: 2, output: 8, cached: 0.2 } });
    await call("setPrice", { model: "stand-in/*", input: 1, output: 1 });
    const after = await call<UsageView>("usage", {});
    const cost = costOf(counted, after.prices);
    const t = spendTotal(counted);
    expect(cost.usd).toBeCloseTo(((t.input - t.cached) * 2 + t.cached * 0.2 + t.output * 8) / 1e6, 12);
    expect(cost.unpriced).toEqual([]);

    // An agent can't state a price: it never holds brain:write.
    const { token } = await call<{ token: string }>("mintArm", { label: "pricer" });
    await expect(call("setPrice", { model: "stand-in/counted", input: 0, output: 0 }, token)).rejects.toThrow(/403/);
    await expect(call("setPrice", { model: "no-provider", input: 1, output: 1 })).rejects.toThrow(/400/);
    await expect(call("setPrice", { model: "x/y", input: -1, output: 1 })).rejects.toThrow(/400/);
    expect((await call<{ prices: Record<string, Price> }>("removePrice", { model: "stand-in/*" })).prices).toEqual({ "stand-in/counted": { input: 2, output: 8, cached: 0.2 } });
    await expect(call("removePrice", { model: "stand-in/*" })).rejects.toThrow(/404/);
  });

  test("the meter: this month's calls at your prices against your budget, which is yours alone to set", async () => {
    const meter = await call<UsageMeter>("usageMeter");
    expect(meter).toMatchObject({ per: "month", budgetUsd: null, leftUsd: null });
    expect(meter.calls).toBeGreaterThan(0);
    const set = await call<UsageMeter>("setUsageBudget", { usd: 25, per: "day" });
    expect(set).toMatchObject({ per: "day", budgetUsd: 25 });
    expect(set.leftUsd).toBeCloseTo(25 - set.spentUsd, 9);
    const { token } = await call<{ token: string }>("mintArm", { label: "spender" });
    await expect(call("setUsageBudget", { usd: 1000, per: "month" }, token)).rejects.toThrow(/403/);
    await expect(call("setUsageBudget", { usd: -1 })).rejects.toThrow(/400/);
    expect((await call<UsageMeter>("setUsageBudget", { usd: null })).budgetUsd).toBeNull();
  });
});

/*
 * `galahad do --budget-usd`: the run's calls are priced as they go, at your prices, and the work stops once they have
 * cost the budget (quest.ts says when and how; here, through a real node, with a price that makes the plan spend it).
 */
describe("a quest with a budget", () => {
  test("stops once its calls have cost it, says so, and says what they came to", async () => {
    const { prices: before } = await call<{ prices: Record<string, Price> }>("prices");
    await call("setPrice", { model: "stand-in/counted", input: 1000, output: 1000 });
    try {
      const events: QuestEvent[] = [];
      const { outcome, usage } = await runNodeQuest(client(), { goal: "make the file", network: "isolated", remember: false, budgetUsd: 0.05 }, { emit: (event) => void events.push(event) });
      expect(outcome.status).toBe("stopped");
      expect(outcome.summary).toBe("Stopped: its budget ($0.05) was spent before he finished.");
      // The plan alone spent it: no command ran.
      expect(usage.map((l) => [l.role, l.calls])).toEqual([["planner", 1]]);
      expect(events.filter((e) => e.type === "budget")).toEqual([{ type: "budget", spentUsd: expect.any(Number), budgetUsd: 0.05, out: true }]);
    } finally {
      await call("setPrice", { model: "stand-in/counted", ...before["stand-in/counted"]! });
    }
  });

  test("its sandbox's own calls through the gateway count in it (a coding agent's), and in what it says it spent", async () => {
    const { prices: before } = await call<{ prices: Record<string, Price> }>("prices");
    await call("setPrice", { model: "stand-in/counted", input: 1, output: 1 });
    try {
      // His command runs a program in the sandbox (a coding agent) that asks a model through the gateway on the sandbox's
      // own token, with a long prompt: a tenth of a dollar, where the planner's and the engineer's calls cost a cent.
      let sandboxId = "";
      docker.onExec = async (_container, cmd) => {
        if (cmd.join(" ").includes("touch /work/out/done")) {
          const { token } = await call<{ token: string }>("mintToken", { label: `sandbox:${sandboxId}`, providers: ["stand-in"] });
          const response = await fetch(`http://127.0.0.1:${port}/gw/stand-in/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "counted", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: `Quest: ${"x".repeat(100_000)}` }] }),
          });
          await response.text();
        }
        return { code: 0, stdout: "" };
      };
      const events: QuestEvent[] = [];
      const { outcome, usage } = await runNodeQuest(client(), { goal: "make the file", network: "isolated", remember: false, budgetUsd: 0.05 }, {
        started: ({ sandbox }) => void (sandboxId = sandbox.id),
        emit: (event) => void events.push(event),
      });
      // Told at once, after that command: the work stops before he is asked again.
      expect(events.filter((e) => e.type === "budget").map((e) => (e as { out: boolean }).out)).toEqual([false, true]);
      expect(outcome.status).toBe("stopped");
      expect(outcome.summary).toBe("Stopped: its budget ($0.05) was spent before he finished.");
      expect(usage.find((l) => l.role === "tool")).toMatchObject({ model: "stand-in/counted", calls: 1 });
      expect(usage.find((l) => l.role === "tool")!.input).toBeGreaterThan(100_000);
    } finally {
      docker.onExec = undefined;
      await call("setPrice", { model: "stand-in/counted", ...before["stand-in/counted"]! });
    }
  });

  test("without a budget too, what each sandbox spent through the gateway is said once, as it closes (a trial counts it so)", async () => {
    let sandboxId = "";
    docker.onExec = async (_container, cmd) => {
      if (cmd.join(" ").includes("touch /work/out/done")) {
        const { token } = await call<{ token: string }>("mintToken", { label: `sandbox:${sandboxId}`, providers: ["stand-in"] });
        const response = await fetch(`http://127.0.0.1:${port}/gw/stand-in/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "counted", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Quest: one call" }] }),
        });
        await response.text();
      }
      return { code: 0, stdout: "" };
    };
    try {
      const heard: { role: string; model: string; calls: number }[][] = [];
      const { usage } = await runNodeQuest(client(), { goal: "make the file", network: "isolated", remember: false }, {
        started: ({ sandbox }) => void (sandboxId = sandbox.id),
        sandboxSpent: (lines) => void heard.push(lines),
      });
      expect(heard.map((lines) => lines.map((l) => [l.role, l.model, l.calls]))).toEqual([[["tool", "stand-in/counted", 1]]]);
      // And what the quest says it spent holds the same, beside its own calls.
      expect(usage.find((l) => l.role === "tool")).toMatchObject({ model: "stand-in/counted", calls: 1 });
    } finally {
      docker.onExec = undefined;
    }
  });

  test("what a sandbox spent: all of it, or since a moment (a knight's VM outlives its tasks); an agent may ask only of its own", async () => {
    const { sandbox } = await call<{ sandbox: { id: string } }>("createSandbox", { network: "isolated" });
    try {
      expect(await call("sandboxSpend", { id: sandbox.id })).toEqual({ lines: [] });
      const { token } = await call<{ token: string }>("mintToken", { label: `sandbox:${sandbox.id}`, providers: ["stand-in"] });
      const asked = await fetch(`http://127.0.0.1:${port}/gw/stand-in/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "counted", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Quest: one call" }] }),
      });
      await asked.text();
      expect((await call<{ lines: { role: string; calls: number }[] }>("sandboxSpend", { id: sandbox.id })).lines.map((l) => [l.role, l.calls])).toEqual([["tool", 1]]);
      expect(await call("sandboxSpend", { id: sandbox.id, since: Date.now() + 60_000 })).toEqual({ lines: [] });
      const { token: nosy } = await call<{ token: string }>("mintArm", { label: "nosy" });
      await expect(call("sandboxSpend", { id: sandbox.id }, nosy)).rejects.toThrow(/403 that sandbox belongs to another quest/);
    } finally {
      await call("destroySandbox", { id: sandbox.id });
    }
  });

  test("with room to spare it runs as ever, told what it has spent as it goes", async () => {
    const asked: string[] = [];
    const { outcome } = await runNodeQuest(client(), { goal: "make the file", network: "isolated", remember: false, budgetUsd: 50 }, {
      spent: () => void asked.push("call"),
    });
    expect(outcome.status).toBe("done");
    expect(asked.length).toBeGreaterThan(2);
  });
});

describe("what a trial spent, in the log", () => {
  const cantilever = ENGINEERING_SUITE.find((p) => p.id === "cantilever-beam")!;

  test("recorded beside the trial, a kind of its own, and shown with it", async () => {
    const exact = JSON.stringify(Object.fromEntries(pose(cantilever, 11).expected.map((e) => [e.key, e.value])));
    docker.onExec = (_container, cmd) => (cmd.at(-1)!.includes("cat /work/out/answer.json") ? { code: 0, stdout: exact } : { code: 0, stdout: "" });
    try {
      const { trials, spent } = await runTrials(client(), { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11 });
      expect(trials[0]).toMatchObject({ status: "scored", score: 1 });
      expect(trials[0]!.spent!.lines.map((l) => [l.role, l.calls]).sort()).toEqual([
        ["engineer", 2],
        ["planner", 1],
        ["reviewer", 1],
      ]);
      expect(spendTotal(trials[0]!.spent!.lines).tokens).toBe(spendTotal(spent).tokens);
      const listed = (await call<{ trials: TrialView[] }>("trials")).trials.find((t) => t.id === trials[0]!.id)!;
      expect(listed.spent).toEqual(trials[0]!.spent!);
      const store = new MindStore(home.mindPath);
      try {
        const events = store.eventsSince({}, 100_000).events;
        const scored = events.find((e) => e.kind === "trial.scored" && (e.body as { id: string }).id === listed.id)!;
        const spentEvent = events.find((e) => e.kind === "trial.spent" && (e.body as { trial: string }).trial === listed.id)!;
        // The trial's own record is as it always was (a node that predates the count still takes it).
        expect(scored.body).not.toHaveProperty("spent");
        expect(JSON.stringify(spentEvent.body)).not.toContain(SECRET_WORDS);
        expect(store.rejection(spentEvent.id)).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      docker.onExec = undefined;
    }
  });
});

describe("the count itself", () => {
  test("a row a day, who, role and model; old days are dropped as new ones are written", () => {
    const db = new Database(":memory:");
    let now = Date.UTC(2026, 0, 1, 12);
    const usage = new UsageStore(db, () => now);
    usage.note("you", "engineer", "p/m", { input: 100, output: 10, cached: 500, reasoning: 99 });
    usage.note("you", "engineer", "p/m", null);
    now += 86_400_000;
    usage.note("galahad", "swift", "local/small", { input: 7, output: 3 });
    expect(usage.rows(2)).toEqual({
      since: "2026-01-01",
      rows: [
        { day: "2026-01-02", who: "galahad", role: "swift", model: "local/small", calls: 1, unknown: 0, input: 7, output: 3, cached: 0, reasoning: 0 },
        // Cached never exceeds the input it's part of, nor reasoning the output.
        { day: "2026-01-01", who: "you", role: "engineer", model: "p/m", calls: 2, unknown: 1, input: 100, output: 10, cached: 100, reasoning: 10 },
      ],
    });
    expect(usage.rows(1).rows).toHaveLength(1);
    now += 500 * 86_400_000;
    usage.note("you", "planner", "p/m", { input: 1, output: 1 });
    expect(usage.rows(366).rows).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) AS n FROM usage_daily").get() as { n: number }).n).toBe(1);
  });
});
