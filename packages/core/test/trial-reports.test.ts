import { describe, expect, test } from "bun:test";
import { compareTrials, doneLine, doneReport, measure, modelReport, pairedDifference, type ReportRun, type ReportTrial, reviewerLine, reviewerReport, type UsageLine, variantReport, VARIANTS } from "../src/index.ts";

/*
 * The reports the recorded trials give: which model is best in a role and how sure
 * that is, whether a variant of the harness measurably helps and what it cost, and
 * the reviewer's two error rates. One rule decides every comparison: an interval has
 * to clear the other's. When it doesn't, the report says so.
 */

const spent = (tokens: number, model = "p/m"): { lines: UsageLine[] } => ({ lines: [{ role: "engineer", model, calls: 4, unknown: 0, input: tokens - 1000, output: 1000, cached: 0, reasoning: 0 }] });
let n = 0;
const trial = (run: string, score: number, over: Partial<ReportTrial> = {}): ReportTrial => ({ run, suite: "agentic", problem: `p${n % 7}`, domain: "debugging", seed: 1000 + n++, status: "scored", score, seconds: 300, models: ["p/m"], spent: spent(200_000), ...over });
/** `count` trials of a run, `solved` of them solved, on the same problems and seeds every time it's called with the same `count`. */
const run = (id: string, count: number, solved: number, over: Partial<ReportTrial> = {}): ReportTrial[] =>
  Array.from({ length: count }, (_, i) => trial(id, i < solved ? 1 : 0, { problem: `p${i % 7}`, seed: 500 + i, ...over }));

describe("what a set of trials cost and bought", () => {
  test("the Index, tokens and money a trial, and what a point cost", () => {
    const m = measure(run("r-a", 10, 4), { "p/m": { input: 5, output: 5 } });
    expect(m.quality).toMatchObject({ mean: 0.4, n: 10 });
    expect(m.tokensPerTrial).toBe(200_000);
    expect(m.usdPerTrial).toBeCloseTo(1, 12);
    // Ten trials' tokens bought four points.
    expect(m.tokensPerPoint).toBe(500_000);
    expect(m.usdPerPoint).toBeCloseTo(2.5, 12);
    expect(m.perMTok!.mean).toBeCloseTo(2, 12);
    expect(m.crashed).toBe(0);
  });

  test("what isn't known is left unknown: no price, no money; an unreported call, no tokens; nothing solved, no price of a point", () => {
    const unpriced = measure(run("r-a", 4, 2), {});
    expect(unpriced.usdPerTrial).toBeNull();
    expect(unpriced.tokensPerTrial).toBe(200_000);
    const silent = measure(run("r-a", 4, 2, { spent: { lines: [{ ...spent(1).lines[0]!, unknown: 1 }] } }), {});
    expect(silent.tokensPerTrial).toBeNull();
    expect(silent.perMTok).toBeNull();
    expect(measure(run("r-a", 4, 0), {}).tokensPerPoint).toBeNull();
    expect(measure([...run("r-a", 3, 3), trial("r-a", 0, { status: "crashed" })], {})).toMatchObject({ crashed: 1, quality: { n: 3 } });
  });
});

describe("each model, in each role", () => {
  const runs: Record<string, ReportRun> = {
    "r-opus": { effort: 1, pins: { engineer: "router/opus" } },
    "r-deep": { effort: 1, pins: { engineer: "deepseek/v4" } },
    "r-rev": { effort: 1, pins: { reviewer: "google/gemini" } },
    "r-three": { effort: 3, pins: { engineer: "router/opus" } },
  };
  const prices = { "router/opus": { input: 15, output: 75 }, "deepseek/v4": { input: 0.5, output: 2 } };

  test("the score with its interval, tokens, time and cost for each candidate; the best, and the best for its cost, with how sure that is", () => {
    const trials = [
      ...run("r-opus", 14, 13, { spent: spent(400_000, "router/opus") }),
      ...run("r-deep", 14, 4, { spent: spent(300_000, "deepseek/v4") }),
      ...run("r-plain", 14, 9),
      // Another effort isn't the same measurement: it's left out of the table.
      ...run("r-three", 14, 14, { spent: spent(900_000, "router/opus") }),
    ];
    const [engineer, ...rest] = modelReport(trials, runs, prices, "agentic");
    expect(rest).toEqual([]);
    expect(engineer!.role).toBe("engineer");
    expect(engineer!.rows.map((r) => [r.model, r.quality.n, r.runs])).toEqual([
      ["router/opus", 14, ["r-opus"]],
      [null, 14, ["r-plain"]],
      ["deepseek/v4", 14, ["r-deep"]],
    ]);
    expect(engineer!.rows[0]).toMatchObject({ tokensPerTrial: 400_000, secondsPerTrial: 300 });
    expect(engineer!.rows[0]!.usdPerTrial).toBeCloseTo((399_000 * 15 + 1000 * 75) / 1e6, 9);
    // Opus clears DeepSeek, not the roster as it is: said as it is.
    expect(engineer!.best).toMatch(/^Highest so far as engineer: router\/opus, 93% \(\d+%–100%, 14 trials\), but not measurably better than the roster as it is/);
    expect(engineer!.best).not.toContain("deepseek/v4");
    // For its cost: DeepSeek solves fewer and costs a thirtieth, and that is measured too.
    expect(engineer!.bestForCost).toMatch(/^Best for its cost as engineer: deepseek\/v4, .* points a dollar .*; its interval clears the others'\.$/);
  });

  test("measurably best says so; too little to compare says that; a role nobody pinned has no table", () => {
    const clear = modelReport([...run("r-opus", 14, 14), ...run("r-deep", 14, 2)], runs, {}, "agentic")[0]!;
    expect(clear.best).toMatch(/^Best engineer: router\/opus, 100% .* Its interval clears every other candidate's: that is measured\.$/);
    // No prices and no second candidate priced: cost goes by tokens, and says what that leaves out.
    expect(clear.bestForCost).toMatch(/by tokens, which says nothing of what a token costs/);
    const thin = modelReport(run("r-opus", 1, 1), runs, {}, "agentic")[0]!;
    expect(thin.best).toMatch(/^Not enough to compare engineers yet/);
    expect(modelReport(run("r-plain", 14, 9), runs, {}, "agentic")).toEqual([]);
    // Another suite's trials are another suite's.
    expect(modelReport(run("r-opus", 14, 14, { suite: "engineering" }), runs, {}, "agentic")).toEqual([]);
    // A run that pinned the reviewer isn't the roster as it stood for the engineer's table.
    const mixed = modelReport([...run("r-opus", 4, 4), ...run("r-rev", 4, 1)], runs, {}, "agentic");
    expect(mixed.find((r) => r.role === "engineer")!.rows.map((r) => r.model)).toEqual(["router/opus"]);
    expect(mixed.find((r) => r.role === "reviewer")!.rows.map((r) => r.model)).toEqual(["google/gemini"]);
  });
});

describe("does a change to the harness help?", () => {
  test("measurably helps: the interval clears the baseline's, and each point gained has its price", () => {
    const c = compareTrials({ name: "baseline", trials: run("r-a", 14, 3) }, { name: "effort-3", trials: run("r-b", 14, 13, { spent: spent(600_000) }) }, { "p/m": { input: 1, output: 1 } });
    expect(c.verdict).toBe("helps");
    expect(c.lines[2]).toBe("effort-3 measurably helps: its interval clears baseline's.");
    // The same 14 tasks under both: ten of them went from missed to solved.
    expect(c.paired).toMatchObject({ pairs: 14 });
    expect(c.paired!.mean).toBeCloseTo(10 / 14, 12);
    expect(c.paired!.low).toBeGreaterThan(0);
    expect(c.lines[3]).toMatch(/^On the 14 tasks both ran \(same problem, same seed\): \+71 points for effort-3 \(\+\d+ to \+\d+\), an interval above zero\.$/);
    // 400k more tokens a trial for 10/14 of a point a trial: 560k tokens a point gained.
    expect(c.tokensPerPointGained).toBeCloseTo(400_000 / (10 / 14), 6);
    expect(c.usdPerPointGained).toBeCloseTo(0.4 / (10 / 14), 9);
    expect(c.lines[4]).toBe("Each point effort-3 gained cost 560k more tokens ($0.56).");
    expect(c.lines[0]).toBe("baseline: 21% (7%–43%, 14 trials) · 200k tokens a trial · $0.20 a trial · 933k tokens a point ($0.93)");
  });

  test("no measurable difference is said in as many words, with what the extra cost bought", () => {
    const c = compareTrials({ name: "baseline", trials: run("r-a", 14, 7) }, { name: "skills", trials: run("r-b", 14, 7, { spent: spent(260_000) }) }, {});
    expect(c.verdict).toBe("none");
    expect(c.lines).toContain("No measurable difference between baseline and skills: the intervals overlap. skills hasn't been shown to help on this suite.");
    expect(c.lines.at(-1)).toBe("skills spent 60.0k more tokens a trial and gained no score for it.");
    expect(c.tokensPerPointGained).toBeNull();
  });

  test("measurably hurts; not measured; nothing in common", () => {
    expect(compareTrials({ name: "baseline", trials: run("r-a", 14, 13) }, { name: "bare", trials: run("r-b", 14, 2) }, {}).lines).toContain("bare measurably hurts: its interval lies below baseline's.");
    const thin = compareTrials({ name: "baseline", trials: run("r-a", 1, 1) }, { name: "bare", trials: run("r-b", 14, 2) }, {});
    expect(thin.verdict).toBe("unmeasured");
    expect(thin.lines[2]).toBe("Not measured yet: each side needs at least two scored trials (baseline has 1, bare has 14).");
    // Other seeds: nothing to pair, and it says the comparison is between the sets as wholes.
    const apart = compareTrials({ name: "a", trials: run("r-a", 6, 3) }, { name: "b", trials: run("r-b", 6, 3).map((t) => ({ ...t, seed: t.seed + 9000 })) }, {});
    expect(apart.paired).toBeNull();
    expect(apart.lines).toContain("No task was run under both with the same seed: the comparison is between the two sets as wholes.");
    // Scoring more for less is said as that.
    expect(compareTrials({ name: "a", trials: run("r-a", 14, 3, { spent: spent(500_000) }) }, { name: "b", trials: run("r-b", 14, 13) }, {}).lines.at(-1)).toBe("b scored more and spent fewer tokens a trial.");
  });

  test("the paired difference: the mean with an interval that's the same every time", () => {
    const d = pairedDifference([{ a: 0, b: 1 }, { a: 1, b: 1 }, { a: 0.5, b: 0 }, { a: 0, b: 1 }]);
    expect(d).toMatchObject({ mean: 0.375, pairs: 4 });
    expect(pairedDifference([{ a: 0, b: 1 }, { a: 1, b: 1 }, { a: 0.5, b: 0 }, { a: 0, b: 1 }])).toEqual(d);
    expect(pairedDifference([])).toBeNull();
    expect(pairedDifference([{ a: 0.25, b: 1 }])).toMatchObject({ mean: 0.75, low: 0.75, high: 0.75 });
  });

  test("every variant against the baseline run beside it (the same group), or failing that every baseline run", () => {
    const runs: Record<string, ReportRun> = {
      "r-base1": { effort: 1, variant: { name: "baseline", options: VARIANTS.baseline! }, group: "g-1" },
      "r-nogates": { effort: 1, variant: { name: "no-gates", options: VARIANTS["no-gates"]! }, group: "g-1" },
      "r-base2": { effort: 1, variant: { name: "baseline", options: VARIANTS.baseline! }, group: "g-2" },
      "r-e3": { effort: 3, variant: { name: "effort-3", options: VARIANTS["effort-3"]! }, group: "g-2" },
      "r-lonely": { effort: 1, variant: { name: "skills", options: VARIANTS.skills! } },
    };
    const trials = [...run("r-base1", 14, 12), ...run("r-nogates", 14, 3), ...run("r-base2", 14, 2), ...run("r-e3", 14, 13), ...run("r-lonely", 14, 7), ...run("r-unrecorded", 14, 14)];
    const report = variantReport(trials, runs, {}, "agentic");
    expect(report.map((c) => [c.b.name, c.verdict, c.a.runs])).toEqual([
      ["effort-3", "helps", ["r-base2"]],
      ["no-gates", "hurts", ["r-base1"]],
      ["skills", "none", ["r-base1", "r-base2"]],
    ]);
  });
});

describe("the reviewer, measured directly", () => {
  const kase = (model: string, domain: "should-pass" | "should-fail", right: boolean): ReportTrial => trial("r-rev", right ? 1 : 0, { suite: "reviewer", domain, models: [model], spent: spent(3000, model) });

  test("how often it passes what it should fail, and fails what it should pass, by the model that reviewed", () => {
    const trials = [
      // A credulous reviewer: passes everything.
      ...Array.from({ length: 10 }, () => kase("a/credulous", "should-fail", false)),
      ...Array.from({ length: 6 }, () => kase("a/credulous", "should-pass", true)),
      // A careful one: one slip each way.
      ...Array.from({ length: 10 }, (_, i) => kase("b/careful", "should-fail", i !== 0)),
      ...Array.from({ length: 6 }, (_, i) => kase("b/careful", "should-pass", i !== 0)),
      trial("r-eng", 1),
    ];
    const rows = reviewerReport(trials);
    // The one that lets less wrong work through comes first.
    expect(rows.map((r) => r.model)).toEqual(["b/careful", "a/credulous"]);
    expect(rows[0]).toMatchObject({ passedWrong: { count: 1, of: 10 }, failedRight: { count: 1, of: 6 }, tokensPerCase: 3000 });
    expect(rows[0]!.right.mean).toBeCloseTo(14 / 16, 12);
    expect(rows[1]).toMatchObject({ passedWrong: { count: 10, of: 10 }, failedRight: { count: 0, of: 6 } });
    expect(rows[1]!.passedWrong.rate).toMatchObject({ mean: 1, low: 1, high: 1 });
    expect(reviewerLine(rows[1]!)).toBe("a/credulous: right 38% (19%–56%, 16 trials) · passed what it should fail 10 of 10 (100%, 100%–100%) · failed what it should pass 0 of 6 (0%, 0%–0%) · 3,000 tokens a case");
    expect(reviewerReport([trial("r-eng", 1)])).toEqual([]);
  });
});

describe("what a quest's \"done\" was worth", () => {
  const ended = (status: string, score: number, over: Partial<ReportTrial> = {}): ReportTrial => trial("r-a", score, { quest: { status }, ...over });

  test("of the quests that ended done, how many the grading found short; of the trials solved outright, how many he didn't call done", () => {
    const trials = [
      ...Array.from({ length: 6 }, () => ended("done", 1)),
      // Done, and the hidden tests say otherwise: wholly wrong twice, in part once.
      ended("done", 0),
      ended("done", 0),
      ended("done", 0.5),
      // Right, and he didn't stand behind it.
      ended("unverified", 1),
      // Not done and not right: neither error.
      ended("gave-up", 0),
      // A crashed run says nothing, and a reviewer's case has no quest to end.
      ended("done", 0, { status: "crashed" }),
      trial("r-rev", 1, { suite: "reviewer" }),
    ];
    const report = doneReport(trials)!;
    expect(report.falseDone).toMatchObject({ count: 3, of: 9 });
    expect(report.falseDone.rate!.mean).toBeCloseTo(1 / 3, 12);
    expect(report.falseDone.rate!.low).toBeLessThan(1 / 3);
    expect(report.falseDone.rate!.high).toBeGreaterThan(1 / 3);
    expect(report.unclaimed).toMatchObject({ count: 1, of: 7 });
    expect(doneLine(report)).toBe(`called done 9 times, 3 of them false (33%, ${Math.round(100 * report.falseDone.rate!.low)}%–${Math.round(100 * report.falseDone.rate!.high)}%) · solved outright 7 times, 1 of them left unverified or stopped`);
  });

  test("a refusal that was right is not work he failed to stand behind: giving up where the grading says that was the answer", () => {
    // An honesty task: the right ending is to say it can't be done. One stopped at its last command with the work right.
    const report = doneReport([ended("gave-up", 1), ended("stopped", 1), ended("unverified", 1), ended("done", 1), ended("gave-up", 0)])!;
    expect(report.unclaimed).toMatchObject({ count: 2, of: 4 });
    expect(report.falseDone).toMatchObject({ count: 0, of: 1 });
  });

  test("nothing is said where nothing is known: no quest on record, none that ended done, nothing solved", () => {
    expect(doneReport([trial("r-rev", 1, { suite: "reviewer" })])).toBeNull();
    const never = doneReport([ended("gave-up", 0), ended("stopped", 0)])!;
    expect(never).toMatchObject({ falseDone: { count: 0, of: 0, rate: null }, unclaimed: { count: 0, of: 0, rate: null } });
    expect(doneLine(never)).toBe("never called done · nothing solved outright");
    expect(doneLine(doneReport([ended("done", 1)])!)).toBe("called done once, and it was · solved outright once, and stood behind");
  });
});
