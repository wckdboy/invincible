import { describe, expect, test } from "bun:test";
import { type ChatStreamEvent, type RouteName, routes, spendTotal, TrialRecord, TrialRunId, type TrialRunsView, type TrialView, type Usage, VARIANTS } from "@galahad/core";
import { ENGINEERING_SUITE, pose, type TrialProblem } from "@galahad/brain";
import { DEFAULT_TOKENS_PER_ATTEMPT, describeCost, describeDone, describeFallback, describeTrial, estimateLabel, estimateRun, freshRunId, runTrials, type TrialUnit } from "../src/trial-cli.ts";
import { parseBudget, parsePins, parseTokens } from "../src/trial-commands.ts";

/*
 * What a run costs, against a fake node whose stand-in models report their usage (or
 * don't): every model call is counted by role and model and recorded with its trial; a
 * run keeps to its budget and says what it finished; it says first what past runs of the
 * same problems cost; a pinned role asks exactly its model; a variant's switches reach
 * the quest.
 */

const cantilever = ENGINEERING_SUITE.find((p) => p.id === "cantilever-beam")!;
const rlc = ENGINEERING_SUITE.find((p) => p.id === "rlc-step")!;
const exactAnswers = (problem: TrialProblem, seed: number) => JSON.stringify(Object.fromEntries(pose(problem, seed).expected.map((e) => [e.key, e.value])));

interface FakeOptions {
  /** What each role's call reports (null: the provider says nothing). */
  usage?: (role: string, model: string) => Usage | null;
  past?: { trials: TrialView[]; runs?: TrialRunsView };
  /** A role's first model that can't answer (the next one does): the role, the model and why. */
  refused?: { role: string; model: string; error: string };
  /** What a call reports by its role and its problem (the first message's words), in place of `usage`. */
  usageOf?: (role: string, first: string) => Usage | null;
}

function fakeNode(options: FakeOptions = {}) {
  const calls: { name: RouteName; input: any }[] = [];
  const chats: any[] = [];
  const recorded: TrialView[] = [];
  const runs: any[] = [];
  const turns = new Map<string, number>();
  let created = 0;
  const node = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      calls.push({ name, input });
      switch (name) {
        case "trials":
          return (options.past ?? { trials: [], runs: {} }) as T;
        case "startTrialRun":
          runs.push(routes.startTrialRun.input.parse(input));
          return { run: input.run } as T;
        case "effort":
          return { quest: input.quest, attempts: input.effort, asked: input.effort, host: "ultra", reasons: [], budget: { perDay: 12, usedToday: 0 } } as T;
        case "createSandbox":
          created += 1;
          return { sandbox: { id: String(created).padStart(10, "0"), node: "n_ultra", image: "galahad/lab:1", network: input.network, isolation: "container", cpus: 4, memoryGb: 8, providers: [], quest: input.quest } } as T;
        case "fleet":
          throw new Error("not needed");
        case "execSandbox": {
          const command: string = input.cmd[2];
          await Bun.sleep(1);
          if (command.includes("cat /work/out/answer.json")) return { exitCode: 0, stdout: exactAnswers(cantilever, 11), stderr: "", durationMs: 1, truncated: false } as T;
          return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, truncated: false } as T;
        }
        case "saveArtifact":
          return { artifact: null } as T;
        case "destroySandbox":
          return {} as T;
        case "recordTrial": {
          const { spent, ...record } = routes.recordTrial.input.parse(input);
          const view = { ...TrialRecord.parse(record), id: `tr_${String(recorded.length).padStart(22, "0")}`, recordedAt: recorded.length, nodeName: "ultra", ...(spent ? { spent: { lines: spent } } : {}) };
          recorded.push(view);
          return { trial: view } as T;
        }
        case "rules":
          // (A node that holds no rules of yours: no command is held to a tripwire.)
          return { rules: [] } as T;
        default:
          throw new Error(`unexpected call ${name}`);
      }
    },
    async *stream(_name: RouteName, input: any): AsyncGenerator<ChatStreamEvent> {
      chats.push(input);
      const role: string = input.role;
      const ref: string = input.model ?? `fake/${role}`;
      if (options.refused?.role === role && !input.model) yield { type: "fallback", from: options.refused.model, error: options.refused.error };
      yield { type: "model", ref };
      const first: string = input.messages[0].content;
      let text: string;
      if (role === "planner") text = "1. Solve it.\n2. Write answer.json.";
      else if (role === "engineer") {
        const turn = (turns.get(first) ?? 0) + 1;
        turns.set(first, turn);
        text = turn % 2 === 1 ? "Solving.\n```sh\npython3 /work/out/solve.py\n```" : "DONE\nWrote /work/out/answer.json.";
      } else text = "PASS\nThe answer file is there.";
      yield { type: "text", text };
      const usage = options.usageOf ? options.usageOf(role, input.messages[0].content) : options.usage ? options.usage(role, ref) : { input: 1000, output: 100 };
      yield { type: "usage", ref, usage };
      yield { type: "done", ref };
    },
  };
  return { node, calls, chats, recorded, runs };
}

describe("what a trial spent", () => {
  test("every model call is counted by role and model, and recorded beside the trial: counts only", async () => {
    const { node, recorded } = fakeNode({ usage: (role) => (role === "engineer" ? { input: 4000, output: 300, cached: 3000, reasoning: 120 } : { input: 900, output: 80 }) });
    const { trials, spent } = await runTrials(node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11 });
    expect(trials[0]!.score).toBe(1);
    // One plan, two engineer turns (a command, then DONE), one review.
    expect(trials[0]!.spent!.lines).toEqual([
      { role: "engineer", model: "fake/engineer", calls: 2, unknown: 0, input: 8000, output: 600, cached: 6000, reasoning: 240 },
      { role: "planner", model: "fake/planner", calls: 1, unknown: 0, input: 900, output: 80, cached: 0, reasoning: 0 },
      { role: "reviewer", model: "fake/reviewer", calls: 1, unknown: 0, input: 900, output: 80, cached: 0, reasoning: 0 },
    ]);
    expect(spendTotal(spent).tokens).toBe(8600 + 980 + 980);
    // Nothing of a prompt or an answer is in what's recorded.
    expect(JSON.stringify(recorded[0]!.spent)).not.toMatch(/Solving|DONE|PASS|cantilever/i);
    expect(describeTrial(trials[0]!, true, { "fake/*": { input: 1, output: 2 } })).toMatch(/spent: 9,800 tokens in \(6,000 cached\), 760 out \(240 reasoning\) · 4 calls · \$0\.01/);
  });

  test("a provider that reports nothing: the calls are counted, their tokens unknown, and no figure is made up", async () => {
    const { node } = fakeNode({ usage: (role) => (role === "engineer" ? null : { input: 500, output: 50 }) });
    const { trials } = await runTrials(node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11 });
    const engineer = trials[0]!.spent!.lines.find((l) => l.role === "engineer")!;
    expect(engineer).toMatchObject({ calls: 2, unknown: 2, input: 0, output: 0 });
    expect(spendTotal(trials[0]!.spent!.lines).complete).toBe(false);
    // The Index's cost columns leave such a trial out rather than count it short.
    expect(describeCost(trials, {})).toMatch(/tokens unknown/);
  });
});

describe("what his \"done\" was worth", () => {
  test("a quest that ended done on work the grading found short is counted as a false done, beside the run's Index", async () => {
    // The stand-in leaves the cantilever's answers whatever was asked: both quests end done, and one of them is right.
    const { node } = fakeNode();
    const { trials } = await runTrials(node, { suite: "engineering", problems: [cantilever, rlc], repeat: 1, parallel: 1, network: "gateway", seed: 11 });
    expect(trials.map((t) => [t.problem, t.quest?.status, t.score === 1])).toEqual([["cantilever-beam", "done", true], ["rlc-step", "done", false]]);
    expect(describeDone(trials)).toMatch(/done.* called done 2 times, 1 of them false \(50%, \d+%–\d+%\) · solved outright once, and stood behind$/);
    // A reviewer's case has no quest to end: nothing is said.
    expect(describeDone(trials.map(({ quest: _quest, ...t }) => t))).toBe("");
  });
});

describe("a model that couldn't answer is never passed over in silence", () => {
  test("a run says once, as it happens, that a role's first model couldn't answer, why, and which one answers instead", async () => {
    const { node } = fakeNode({ refused: { role: "engineer", model: "plan/first", error: "plan → 400 MissingSessionID" } });
    const said: any[] = [];
    const { trials } = await runTrials(node, { suite: "engineering", problems: [cantilever, rlc], repeat: 1, parallel: 1, network: "gateway", seed: 11, progress: (event) => void said.push(event) });
    // The work was done by the model that answered: the record says which.
    expect(trials.map((t) => t.models.includes("fake/engineer"))).toEqual([true, true]);
    // Four engineer turns over two trials: one notice.
    expect(said.filter((e) => e.type === "fallback")).toEqual([{ type: "fallback", role: "engineer", model: "plan/first", error: "plan → 400 MissingSessionID", answered: "fake/engineer" }]);
  });

  test("said as it is: that answer was the other model's, and the next is asked of the role's models in order again", () => {
    // (Not "what this run measures": a turn the first model answers again is that model's, measured and paid as such.)
    expect(describeFallback({ role: "engineer", model: "plan/first", error: "plan → 400 MissingSessionID\nmore of it", answered: "fake/engineer" })).toBe(
      "! plan/first couldn't answer as engineer: plan → 400 MissingSessionID. fake/engineer answered in its place, and that answer is measured and paid as its own; the next is asked of the role's models in order again (said once a run).",
    );
  });
});

describe("a run's budget", () => {
  test("the budget is spent: no more trials start, what finished is recorded, and the run says so", async () => {
    // Each trial costs 4 calls of 1,100 tokens: 4,400. A budget of 6,000 is spent during the second.
    const { node, recorded, runs } = fakeNode();
    const events: string[] = [];
    const result = await runTrials(node, {
      suite: "engineering",
      problems: [cantilever],
      repeat: 5,
      parallel: 1,
      network: "gateway",
      seed: 11,
      budget: { tokens: 6000 },
      progress: (e) => void events.push(e.type === "spent" ? `spent:${e.finished}/${e.stopped}/${e.notStarted}` : e.type),
    });
    expect(result.trials).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    // The second was stopped mid-way (not recorded: a stop says nothing about ability); three never started.
    expect(result.budgetEnded).toMatchObject({ stopped: 1, notStarted: 3 });
    expect(result.budgetEnded!.why).toMatch(/budget of 6,000 tokens is spent/);
    expect(events.at(-1)).toBe("spent:1/1/3");
    // It never ran far past it: the stop lands after the call that crossed it.
    expect(spendTotal(result.spent).tokens).toBeLessThanOrEqual(6000 + 1100);
    // The budget is on record with the run.
    expect(runs[0]).toMatchObject({ budget: { tokens: 6000 }, seed: 11, effort: 1 });
  });

  test("with no budget named, the run takes an allowance for every attempt it would make, and says it's the default", async () => {
    const { node, runs } = fakeNode();
    const seen: any[] = [];
    await runTrials(node, { suite: "engineering", problems: [cantilever, rlc], repeat: 2, parallel: 2, network: "gateway", seed: 11, progress: (e) => void (e.type === "budget" && seen.push(e)) });
    expect(seen[0]).toMatchObject({ byDefault: true, budget: { tokens: 4 * DEFAULT_TOKENS_PER_ATTEMPT } });
    // Nothing asked for beyond a plain run: no run record, as ever.
    expect(runs).toEqual([]);
  });

  test("a money budget is counted at your prices, and can't be kept blind: an unpriced model ends the run", async () => {
    const priced = fakeNode();
    const a = await runTrials(priced.node, { suite: "engineering", problems: [cantilever], repeat: 4, parallel: 1, network: "gateway", seed: 11, budget: { usd: 0.01 }, prices: { "fake/*": { input: 1, output: 10 } } });
    // A call costs $0.002: the fifth crosses a cent, in the second trial.
    expect(a.trials).toHaveLength(1);
    expect(a.budgetEnded!.why).toMatch(/budget of \$0\.01 is spent/);
    const blind = fakeNode();
    const b = await runTrials(blind.node, { suite: "engineering", problems: [cantilever], repeat: 2, parallel: 1, network: "gateway", seed: 11, budget: { usd: 5 }, prices: { "fake/planner": { input: 1, output: 1 } } });
    expect(b.trials).toHaveLength(0);
    expect(b.budgetEnded!.why).toMatch(/needs a price for every model that answers, and there's none for fake\/engineer/);
  });

  test("two runs begun in the same millisecond are two runs (seen on Ultra: a sweep's second run took the first's id)", () => {
    const now = Date.now;
    Date.now = () => 1_794_000_000_000;
    try {
      const ids = Array.from({ length: 50 }, () => freshRunId());
      expect(new Set(ids).size).toBe(50);
      for (const id of ids) expect(TrialRunId.safeParse(id).success).toBe(true);
    } finally {
      Date.now = now;
    }
  });

  test("how a budget is spelled", () => {
    expect([parseTokens("2M"), parseTokens("750k"), parseTokens("1500000"), parseTokens("1.5m")]).toEqual([2_000_000, 750_000, 1_500_000, 1_500_000]);
    expect(() => parseTokens("lots")).toThrow(/isn't a number of tokens/);
    expect(parseBudget({ budget: "2M", "budget-usd": "$5" })).toEqual({ tokens: 2_000_000, usd: 5 });
    expect(parseBudget({})).toBeUndefined();
    expect(() => parseBudget({ "budget-usd": "free" })).toThrow(/US dollars/);
  });
});

describe("what a run will cost, going by the past", () => {
  const past = (problem: string, run: string, tokens: number | null): TrialView => ({
    id: `tr_${run}${problem}`,
    run,
    suite: "engineering",
    problem,
    title: problem,
    domain: "x",
    seed: 1,
    status: "scored",
    score: 1,
    answers: [],
    models: [],
    version: "v",
    seconds: 60,
    recordedAt: 0,
    nodeName: "ultra",
    ...(tokens === null ? {} : { spent: { lines: [{ role: "engineer", model: "p/m", calls: 3, unknown: 0, input: tokens - 100, output: 100, cached: 0, reasoning: 0 }] } }),
  });

  test("the mean of each problem's past trials at the same effort; a problem never counted goes by the others, and says so", () => {
    const trials = [past("cantilever-beam", "r-a", 300_000), past("cantilever-beam", "r-b", 500_000), past("rlc-step", "r-a", null)];
    const estimate = estimateRun(trials, [cantilever, rlc], 2, 1, {}, { "p/m": { input: 1, output: 1 } });
    expect(estimate).toMatchObject({ tokens: 1_600_000, known: 2, of: 4 });
    expect(estimate.usd).toBeCloseTo(1.6, 9);
    expect(estimateLabel(estimate)).toBe("going by past runs it will cost about 1.60M tokens ($1.60), known for 2 of its 4 trials and assumed alike for the rest");
  });

  test("past trials at another effort count as that many attempts' worth", () => {
    const estimate = estimateRun([past("cantilever-beam", "r-three", 900_000)], [cantilever], 1, 1, { "r-three": 3 });
    expect(estimate.tokens).toBe(300_000);
    expect(estimateRun([past("cantilever-beam", "r-one", 300_000)], [cantilever], 1, 3, {}).tokens).toBe(900_000);
  });

  test("a trial your budget can't be expected to see through isn't started: what starts finishes, and is recorded", async () => {
    // Each trial costs 4,400 tokens, as the past says. Five slots, and 10,000 tokens: two fit, the third wouldn't.
    const known = { trials: [past("cantilever-beam", "r-a", 4400)] };
    const { node, recorded } = fakeNode({ past: known });
    const result = await runTrials(node, { suite: "engineering", problems: [cantilever], repeat: 5, parallel: 5, network: "gateway", seed: 11, budget: { tokens: 10_000 } });
    expect(result.trials).toHaveLength(2);
    expect(recorded).toHaveLength(2);
    // None paid for and lost: nothing was stopped mid-way.
    expect(result.budgetEnded).toEqual({ stopped: 0, notStarted: 3, why: "1,200 tokens of the budget are left, and a trial takes about 4,400 going by past runs" });
    expect(spendTotal(result.spent).tokens).toBe(8800);
    // No budget of yours: the default allowance is a guard, not a forecast, and every trial runs.
    const plain = fakeNode({ past: known });
    expect((await runTrials(plain.node, { suite: "engineering", problems: [cantilever], repeat: 5, parallel: 5, network: "gateway", seed: 11 })).trials).toHaveLength(5);
  });

  test("trials never priced under a budget close to their cost run one at a time: a stop cuts one short, and those before it count", async () => {
    // The cantilever is known (4,400 tokens a trial); the RLC step was never tried, and costs five times that.
    const dear = (role: string, first: string): Usage => (first.includes("A series RLC circuit") ? { input: 4900, output: 100 } : { input: 1000, output: 100 });
    const known = { trials: [past("cantilever-beam", "r-a", 4400)] };
    const plans: string[] = [];
    const { node, recorded } = fakeNode({ past: known, usageOf: dear });
    const result = await runTrials(node, {
      suite: "engineering",
      problems: [cantilever, rlc],
      repeat: 1,
      parallel: 2,
      network: "gateway",
      seed: 11,
      budget: { tokens: 12_000 },
      progress: (e) => void (e.type === "plan" && plans.push(`${e.parallel} · ${e.why}`)),
    });
    expect(plans).toEqual(["1 · some have never been tried, and the budget is close to what they're expected to cost: a stop at it cuts one short, not all"]);
    // The cantilever finished and counts; the RLC step was stopped by the budget. Two at once, both would have been.
    expect(recorded.map((t) => t.problem)).toEqual(["cantilever-beam"]);
    expect(result.budgetEnded).toMatchObject({ stopped: 1, notStarted: 0 });

    // Every one known: the budget's own admission decides, as many at once as asked.
    const plain = fakeNode({ past: known });
    const asked: number[] = [];
    await runTrials(plain.node, { suite: "engineering", problems: [cantilever], repeat: 2, parallel: 2, network: "gateway", seed: 11, budget: { tokens: 9_000 }, progress: (e) => void (e.type === "plan" && asked.push(e.parallel)) });
    expect(asked).toEqual([2]);
  });

  test("nothing known: it says so rather than guess", async () => {
    const none = estimateRun([past("rlc-step", "r-a", null)], [cantilever, rlc], 1, 1, {});
    expect(none).toEqual({ tokens: null, usd: null, known: 0, of: 2 });
    expect(estimateLabel(none)).toMatch(/unknown: none of these problems has been tried with its calls counted/);
    // And a run says it before its first trial.
    const { node } = fakeNode({ past: { trials: [past("cantilever-beam", "r-a", 400_000)] } });
    const said: any[] = [];
    await runTrials(node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11, progress: (e) => void (e.type === "budget" && said.push(e.estimate)) });
    expect(said).toEqual([{ tokens: 400_000, usd: null, known: 1, of: 1 }]);
  });
});

describe("a role held to one model, and a variant of the harness", () => {
  test("--pin engineer=…: the engineer asks exactly that model, the others ask the roster, and the run records it", async () => {
    const { node, chats, runs, recorded } = fakeNode();
    await runTrials(node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11, pins: { engineer: "deepseek/deepseek-v4-pro" } });
    expect(chats.filter((c) => c.role === "engineer").every((c) => c.model === "deepseek/deepseek-v4-pro")).toBe(true);
    expect(chats.filter((c) => c.role !== "engineer").every((c) => c.model === undefined)).toBe(true);
    expect(runs[0]).toMatchObject({ pins: { engineer: "deepseek/deepseek-v4-pro" }, effort: 1 });
    expect(recorded[0]!.spent!.lines.find((l) => l.role === "engineer")!.model).toBe("deepseek/deepseek-v4-pro");
    expect(parsePins(["engineer=deepseek/deepseek-v4-pro", "reviewer=a/b"])).toEqual({ engineer: "deepseek/deepseek-v4-pro", reviewer: "a/b" });
    expect(parsePins([])).toBeUndefined();
    expect(() => parsePins(["swift=a/b"])).toThrow(/the role one of planner, engineer, reviewer/);
    expect(() => parsePins(["engineer=nomodel"])).toThrow(/<role>=<provider>\/<model>/);
    expect(() => parsePins(["engineer=a/b", "engineer=c/d"])).toThrow(/twice/);
  });

  test("a variant's switches reach the quest, and the run records the variant by name", async () => {
    const bare = fakeNode();
    await runTrials(bare.node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11, variant: { name: "bare", options: VARIANTS.bare! } });
    expect(bare.recorded[0]).toMatchObject({ status: "scored", score: 1 });
    // No archive context with the plan, no skills offered.
    expect(bare.chats.filter((c) => c.role === "planner")).toHaveLength(1);
    expect(bare.chats.find((c) => c.role === "planner")).not.toHaveProperty("archive");
    expect(bare.chats.every((c) => c.quest === undefined)).toBe(true);
    expect(bare.runs[0]).toMatchObject({ variant: { name: "bare", options: VARIANTS.bare }, effort: 1 });

    const skilled = fakeNode();
    await runTrials(skilled.node, { suite: "engineering", problems: [cantilever], repeat: 1, parallel: 1, network: "gateway", seed: 11, variant: { name: "skills", options: VARIANTS.skills! } });
    expect(skilled.chats.find((c) => c.role === "planner")).toMatchObject({ archive: true, quest: { goal: expect.any(String) } });
    expect(skilled.chats.find((c) => c.role === "reviewer")!.quest).toBeUndefined();
    // Offered, and still a trial: nothing is remembered or learned from it.
    expect(skilled.calls.some((c) => c.name === ("remember" as RouteName) || c.name === ("learnSkill" as RouteName))).toBe(false);
  });
});

describe("a coding tool's own calls", () => {
  test("heard as its sandbox closes, they are the trial's and the run's like any, and count against the budget", async () => {
    // What the node counted of the sandbox's calls through the gateway: the tool's, never seen call by call.
    const tool = { role: "engineer", model: "p/tool", calls: 3, unknown: 0, input: 9000, output: 400, cached: 6000, reasoning: 0 };
    const unit: TrialUnit = {
      id: "a-case",
      title: "A case",
      domain: "should-pass",
      attempt: async (_node, job) => {
        job.spent?.({ role: "reviewer", model: "p/judge", usage: { input: 700, output: 9 } });
        job.sandboxSpent?.([tool]);
        return { run: job.run, suite: job.suite, problem: "a-case", title: "A case", domain: "should-pass", seed: job.seed, status: "scored", score: 1, answers: [{ key: "verdict", units: "pass", expected: 1, got: 1, tolerance: 0, ok: true }], models: ["p/judge"], version: job.version, seconds: 1 };
      },
    };
    const { node } = fakeNode();
    const two = await runTrials(node, { suite: "reviewer", problems: [unit], repeat: 2, parallel: 1, network: "gateway", seed: 3 });
    expect(two.trials[0]!.spent!.lines).toEqual([tool, { role: "reviewer", model: "p/judge", calls: 1, unknown: 0, input: 700, output: 9, cached: 0, reasoning: 0 }]);
    expect(two.spent.find((l) => l.model === "p/tool")).toEqual({ ...tool, calls: 6, input: 18_000, output: 800, cached: 12_000 });
    // The first trial's tool crosses the budget: no other starts.
    const capped = await runTrials(fakeNode().node, { suite: "reviewer", problems: [unit], repeat: 3, parallel: 1, network: "gateway", seed: 3, budget: { tokens: 10_000 } });
    expect(capped.trials).toHaveLength(1);
    expect(capped.budgetEnded).toMatchObject({ notStarted: 2, stopped: 0 });
    expect(capped.budgetEnded!.why).toMatch(/budget of 10\.0k tokens is spent \(10\.1k counted\)/);
  });
});

describe("a unit of another suite", () => {
  test("its record is recorded with what it spent, like any trial; a crash in it is the unit's to report", async () => {
    const unit: TrialUnit = {
      id: "a-case",
      title: "A case",
      domain: "should-pass",
      attempt: async (_node, job) => {
        job.spent?.({ role: "reviewer", model: "p/judge", usage: { input: 700, output: 9 } });
        return { run: job.run, suite: job.suite, problem: "a-case", title: "A case", domain: "should-pass", seed: job.seed, status: "scored", score: 1, answers: [{ key: "verdict", units: "pass", expected: 1, got: 1, tolerance: 0, ok: true }], models: ["p/judge"], version: job.version, seconds: 1 };
      },
    };
    const { node } = fakeNode();
    const { trials } = await runTrials(node, { suite: "reviewer", problems: [unit], repeat: 2, parallel: 2, network: "gateway", seed: 3 });
    expect(trials.map((t) => [t.problem, t.seed, t.spent!.lines[0]!.input])).toEqual([
      ["a-case", 3, 700],
      ["a-case", 4, 700],
    ]);
    expect(describeTrial(trials[0]!, true)).toContain("ok     verdict");
  });
});
