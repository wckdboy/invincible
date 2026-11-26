import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChatStreamEvent, type RouteName, routes, TrialRecord, trialProblem, type TrialRunsView, TrialRunSettings, type TrialView } from "@galahad/core";
import { ENGINEERING_SUITE, pose, REVIEWER_CASES } from "@galahad/brain";
import { runTrials } from "../src/trial-cli.ts";
import { trialCommand, UsageError } from "../src/trial-commands.ts";
import { suiteNamed } from "../src/trial-suites.ts";

/*
 * Each model in each role, the reviewer measured directly, and variants of the harness,
 * against a fake node with stand-in models: a reviewer that passes everything and one
 * that reads the evidence; an engineer who only gets it right when the planner had the
 * archive's context. What's checked is that the same seeded tasks are put to each side,
 * that what set each run apart is on record, and that the report says what was measured
 * and no more.
 */

const cantilever = ENGINEERING_SUITE.find((p) => p.id === "cantilever-beam")!;

/** What a careful reviewer notices in the evidence of each case that should be sent back. */
const TELLS = [/\+\+\+ b\/test\//, /\b2 NaN\b/, /echo "total,/, /about 3× faster/, /total\.mjs/];

function fakeNode() {
  const recorded: TrialView[] = [];
  const runs: TrialRunsView = {};
  const chats: any[] = [];
  const turns = new Map<string, number>();
  let created = 0;
  /** Whether the plan of the quest under way had the archive's context (trials here run one at a time). */
  let archived = false;
  const node = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      switch (name) {
        case "prices":
          return { prices: { "a/credulous": { input: 1, output: 1 }, "b/careful": { input: 10, output: 10 } } } as T;
        case "trials":
          return { trials: [...recorded].reverse(), runs } as T;
        case "startTrialRun": {
          const { run, suite: _suite, ...settings } = routes.startTrialRun.input.parse(input);
          runs[run] = TrialRunSettings.parse(settings);
          return { run } as T;
        }
        case "effort":
          return { quest: input.quest, attempts: input.effort, asked: input.effort, host: "ultra", reasons: [], budget: { perDay: 12, usedToday: 0 } } as T;
        case "createSandbox":
          return { sandbox: { id: String(++created).padStart(10, "0"), node: "n_ultra", image: "galahad/lab:1", network: input.network, isolation: "container", cpus: 4, memoryGb: 8, providers: [] } } as T;
        case "execSandbox": {
          const command: string = input.cmd[2];
          if (command.includes("cat /work/out/answer.json")) {
            const seed = node.seed;
            const exact = Object.fromEntries(pose(cantilever, seed).expected.map((e) => [e.key, archived ? e.value : e.value * 2]));
            return { exitCode: 0, stdout: JSON.stringify(exact), stderr: "", durationMs: 1, truncated: false } as T;
          }
          return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, truncated: false } as T;
        }
        case "saveArtifact":
          return { artifact: null } as T;
        case "destroySandbox":
          return {} as T;
        case "recordTrial": {
          const { spent, ...record } = routes.recordTrial.input.parse(input);
          expect(trialProblem(record)).toBeNull();
          const view = { ...TrialRecord.parse(record), id: `tr_${String(recorded.length).padStart(22, "0")}`, recordedAt: recorded.length, nodeName: "ultra", ...(spent ? { spent: { lines: spent } } : {}) };
          recorded.push(view);
          return { trial: view } as T;
        }
        default:
          throw new Error(`unexpected call ${name}`);
      }
    },
    /** The seed of the problem the quest under way was posed with (read from the goal its planner got). */
    seed: 0,
    async *stream(_name: RouteName, input: any): AsyncGenerator<ChatStreamEvent> {
      chats.push(input);
      const role: string = input.role;
      const ref: string = input.model ?? `roster/${role}`;
      const first: string = input.messages[0].content;
      yield { type: "model", ref };
      let text: string;
      if (role === "planner") {
        archived = input.archive === true;
        for (const seed of [11, 12, 13, 14]) if (first.includes(pose(cantilever, seed).goal)) node.seed = seed;
        text = "1. Solve it.\n2. Write answer.json.";
      } else if (role === "engineer") {
        const turn = (turns.get(first) ?? 0) + 1;
        turns.set(first, turn);
        text = turn % 2 === 1 ? "Solving.\n```sh\npython3 /work/out/solve.py\n```" : "DONE\nWrote /work/out/answer.json.";
      } else if (ref === "a/credulous") text = "PASS\nThey say it works.";
      else text = TELLS.some((tell) => tell.test(first)) ? "REVISE\nThe evidence doesn't show what the summary claims." : "PASS\nThe evidence shows it.";
      yield { type: "text", text };
      yield { type: "usage", ref, usage: { input: ref === "b/careful" ? 3000 : 2000, output: 20 } };
    },
  };
  return { node, recorded, runs, chats };
}

let printed: string[] = [];
const realLog = console.log;
beforeEach(() => {
  printed = [];
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
});
afterEach(() => {
  console.log = realLog;
});
const out = () => printed.join("\n");
const command = (node: ReturnType<typeof fakeNode>["node"], sub: string, rest: string[], flags: Record<string, unknown> = {}) => trialCommand({ command: "trial", sub, rest, flags: { parallel: "1", ...flags }, node: () => node });

describe("the reviewer, measured directly", () => {
  test("each case is put to the reviewer as a quest's evidence, and scored by whether its verdict is the careful one", async () => {
    const { node, chats, recorded } = fakeNode();
    const cases = suiteNamed("reviewer").choose([]);
    expect(cases.map((c) => [c.id, c.domain])).toEqual(REVIEWER_CASES.map((c) => [c.id, c.truth === "pass" ? "should-pass" : "should-fail"]));
    const { trials } = await runTrials(node, { suite: "reviewer", problems: cases, repeat: 1, parallel: 1, network: "gateway", seed: 3, pins: { reviewer: "a/credulous" } });
    // One model call a case, to the reviewer role, held to the model, without tools; no sandbox anywhere.
    expect(chats).toHaveLength(8);
    expect(chats.every((c) => c.role === "reviewer" && c.model === "a/credulous" && c.tools === false && c.messages[0].content.startsWith("You are reviewing another engineer's work"))).toBe(true);
    // A review is coding work, as it is in a quest: a model on a coding plan may be the reviewer measured.
    expect(chats.every((c) => c.coding === true)).toBe(true);
    // A reviewer that passes everything is right about what is right and wrong about what is wrong.
    expect(trials.map((t) => [t.problem, t.domain, t.score])).toEqual(REVIEWER_CASES.map((c) => [c.id, c.truth === "pass" ? "should-pass" : "should-fail", c.truth === "pass" ? 1 : 0]));
    expect(recorded[3]).toMatchObject({ suite: "reviewer", problem: "weakened-test", models: ["a/credulous"], answers: [{ key: "verdict_right", units: "pass", expected: 1, got: 0, ok: false }] });
    expect(recorded[3]!.note).toMatch(/^said PASS; a careful reviewer says REVISE: the diff changes the test/);
    expect(recorded[0]!.spent!.lines).toEqual([{ role: "reviewer", model: "a/credulous", calls: 1, unknown: 0, input: 2000, output: 20, cached: 0, reasoning: 0 }]);
    expect(suiteNamed("reviewer").choose(["should-fail"]).map((c) => c.id)).toEqual(["weakened-test", "ignored-edge", "unsupported-claim", "gamed-gate", "wrong-result"]);
  });

  test("a sweep: the same cases to each candidate, then which passes what it should fail", async () => {
    const { node, runs, recorded } = fakeNode();
    expect(await command(node, "sweep", ["reviewer", "a/credulous", "b/careful"], { suite: "reviewer", seed: "5" })).toBe(0);
    // Two runs, each holding the reviewer to its candidate, on the same seed, made to be compared.
    const made = Object.entries(runs);
    expect(made.map(([, s]) => s.pins)).toEqual([{ reviewer: "a/credulous" }, { reviewer: "b/careful" }]);
    expect(new Set(made.map(([, s]) => s.seed))).toEqual(new Set([5]));
    expect(new Set(made.map(([, s]) => s.group)).size).toBe(1);
    expect(recorded.filter((t) => t.models[0] === "a/credulous").map((t) => t.seed)).toEqual(recorded.filter((t) => t.models[0] === "b/careful").map((t) => t.seed));
    // The role's table: the careful one is measurably best; the credulous one is cheaper a point.
    expect(out()).toMatch(/As reviewer/);
    expect(out()).toMatch(/b\/careful\s+100%/);
    expect(out()).toMatch(/a\/credulous\s+38%/);
    expect(out()).toContain("Best reviewer: b/careful, 100% (100%–100%, 8 trials). Its interval clears every other candidate's: that is measured.");
    expect(out()).toMatch(/Best for its cost as reviewer: a\/credulous, .* points a dollar/);
    // And the listing for the suite says the reviewer's two error rates.
    printed = [];
    expect(await trialCommand({ command: "trials", sub: undefined, rest: [], flags: { suite: "reviewer" }, node: () => node })).toBe(0);
    expect(out()).toContain("a/credulous: right 38% (13%–63%, 8 trials) · passed what it should fail 5 of 5 (100%, 100%–100%) · failed what it should pass 0 of 3 (0%, 0%–0%) · 2,020 tokens a case");
    expect(out()).toMatch(/b\/careful: right 100% .* passed what it should fail 0 of 5/);
  });

  test("a sweep gives each candidate an equal share of its budget: the first can't spend the next one's", async () => {
    const { node, runs, recorded } = fakeNode();
    // Eight cases at 2,020 tokens are 16,160: more than either share of 6,000.
    await command(node, "sweep", ["reviewer", "a/credulous", "b/careful"], { suite: "reviewer", seed: "5", budget: "12k" });
    expect(out()).toContain("within an equal share of your budget (6,000 tokens)");
    expect(Object.values(runs).map((s) => s.budget)).toEqual([{ tokens: 6000 }, { tokens: 6000 }]);
    // Each kept to its own: both were measured, and both stopped at their share.
    expect(new Set(recorded.map((t) => t.models[0]))).toEqual(new Set(["a/credulous", "b/careful"]));
    expect(out().match(/Stopped at the budget/g)).toHaveLength(2);
  });

  test("what a sweep is asked is checked before anything runs", async () => {
    const { node, recorded } = fakeNode();
    await expect(command(node, "sweep", ["swift", "a/b"], { suite: "reviewer" })).rejects.toThrow(UsageError);
    await expect(command(node, "sweep", ["reviewer"], { suite: "reviewer" })).rejects.toThrow(/usage: galahad trial sweep/);
    await expect(command(node, "sweep", ["reviewer", "nomodel"], { suite: "reviewer" })).rejects.toThrow(/a candidate is <provider>\/<model>/);
    await expect(command(node, "sweep", ["reviewer", "a/b"], { suite: "reviewer", pin: ["reviewer=c/d"] })).rejects.toThrow(/disagree/);
    await expect(command(node, "run", [], { suite: "warp" })).rejects.toThrow(/no trial suite "warp"/);
    await expect(command(node, "run", [], { suite: "reviewer", level: "2" })).rejects.toThrow(/has no --level/);
    await expect(command(node, "run", [], { suite: "agentic", level: "9" })).rejects.toThrow(/--level must be a whole number from 1 to 4/);
    await expect(command(node, "run", [], { suite: "agentic", net: "online" })).rejects.toThrow(/--net must be isolated or gateway/);
    await expect(command(node, "run", [], { variant: "effort-3", effort: "1" })).rejects.toThrow(/disagree/);
    expect(recorded).toEqual([]);
  });
});

describe("does a change to the harness help? An A/B", () => {
  test("the same seeded tasks under both variants; the report says it measurably hurts, pair by pair, with what each cost", async () => {
    const { node, runs, recorded, chats } = fakeNode();
    expect(await command(node, "ab", ["baseline", "no-archive", "cantilever-beam"], { repeat: "4", seed: "11" })).toBe(0);
    const made = Object.values(runs);
    expect(made.map((s) => s.variant!.name)).toEqual(["baseline", "no-archive"]);
    expect(made.map((s) => s.variant!.options.archive)).toEqual([true, false]);
    expect(new Set(made.map((s) => s.group)).size).toBe(1);
    expect(made.every((s) => s.seed === 11 && s.effort === 1)).toBe(true);
    // The switch reached the quest: the plan had the archive's context under one and not the other.
    const plans = chats.filter((c) => c.role === "planner");
    expect(plans.slice(0, 4).every((c) => c.archive === true)).toBe(true);
    expect(plans.slice(4).every((c) => c.archive === undefined)).toBe(true);
    // The same four tasks under each.
    expect(recorded.slice(0, 4).map((t) => t.seed)).toEqual([11, 12, 13, 14]);
    expect(recorded.slice(4).map((t) => t.seed)).toEqual([11, 12, 13, 14]);
    expect(recorded.map((t) => t.score)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(out()).toContain("no-archive against baseline");
    expect(out()).toContain("baseline: 100% (100%–100%, 4 trials)");
    expect(out()).toContain("no-archive measurably hurts: its interval lies below baseline's.");
    expect(out()).toContain("On the 4 tasks both ran (same problem, same seed): −100 points for no-archive (−100 to −100), an interval below zero.");
    // And the suite's listing keeps the comparison, from the records alone.
    printed = [];
    await trialCommand({ command: "trials", sub: undefined, rest: [], flags: {}, node: () => node });
    expect(out()).toContain("Variants of the harness");
    expect(out()).toContain("no-archive measurably hurts");
    // Two runs by id, the second against the first.
    printed = [];
    const [a, b] = Object.keys(runs);
    expect(await command(node, "compare", [a!, b!])).toBe(0);
    expect(out()).toContain("no-archive against baseline");
    await expect(command(node, "compare", [a!, "r-none"])).rejects.toThrow(/usage: galahad trial compare/);
  });

  test("each side of an A/B keeps to half the budget: the first can't leave the second too little to be measured", async () => {
    const { node, runs } = fakeNode();
    expect(await command(node, "ab", ["baseline", "no-archive", "cantilever-beam"], { repeat: "2", seed: "11", budget: "1M" })).toBe(0);
    expect(out()).toContain("each within half your budget (500k tokens)");
    expect(Object.values(runs).map((s) => [s.variant!.name, s.budget])).toEqual([
      ["baseline", { tokens: 500_000 }],
      ["no-archive", { tokens: 500_000 }],
    ]);
  });

  test("a variant whose coding tool can't do the work here is refused before anything runs", async () => {
    const { node, recorded } = fakeNode();
    await expect(command(node, "run", [], { suite: "agentic", variant: "opencode" })).rejects.toThrow(/opencode calls its models from the sandbox, through the gateway: give it --net gateway/);
    await expect(command(node, "ab", ["baseline", "opencode"], { suite: "agentic" })).rejects.toThrow(/--net gateway/);
    await expect(command(node, "run", [], { suite: "agentic", net: "gateway", variant: "mine:agent=cursor" })).rejects.toThrow(/no coding tool "cursor" \(there is: opencode, hermes, claude, codex\)/);
    await expect(command(node, "run", [], { variant: "opencode", net: "gateway" })).rejects.toThrow(/the engineering suite's problems are the Lab's/);
    expect(recorded).toEqual([]);
    // And with what it needs, it is listed among the variants as what it is.
    expect(await command(node, "variants", [])).toBe(0);
    expect(out()).toMatch(/opencode\s+gates off, no archive context, no revisions, opencode does the work, no plan, no reviewer/);
  });

  test("an A/B takes two different variants, named or spelled out; the named ones are listed", async () => {
    const { node } = fakeNode();
    await expect(command(node, "ab", ["baseline"])).rejects.toThrow(/usage: galahad trial ab/);
    await expect(command(node, "ab", ["baseline", "baseline"])).rejects.toThrow(/two different variants/);
    await expect(command(node, "ab", ["baseline", "warp"])).rejects.toThrow(/no variant "warp"/);
    await expect(command(node, "ab", ["baseline", "no-gates"], { effort: "2" })).rejects.toThrow(/not --variant or --effort/);
    expect(await command(node, "variants", [])).toBe(0);
    expect(out()).toMatch(/no-gates\s+gates off/);
    expect(out()).toMatch(/effort-3\s+effort 3/);
    expect(out()).toMatch(/bare\s+gates off, no archive context, no revisions/);
  });
});
