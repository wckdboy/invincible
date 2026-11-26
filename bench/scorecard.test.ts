import { describe, expect, test } from "bun:test";
import { REFERENCE_SINGLE } from "../packages/core/src/compute.ts";
import { collector, Pace, rng, sig, subSeed, summarise } from "./lib.ts";
import { compare, formatScorecard, nextBaseline, renderSuite, Scorecard, type ScoreMetric, SPEED_FAIL_FACTOR, SPEED_NOISE_FLOOR } from "./scorecard.ts";

/*
 * How a run is read against its baseline: the rules that decide what "better",
 * "worse" and "broke" mean (docs/BENCHMARKS.md), held here so they can't drift.
 */

const quality = (id: string, value: number, better: "higher" | "lower" = "lower", spread?: number): ScoreMetric => ({ id, value, unit: "", kind: "quality", better, ...(spread !== undefined ? { spread } : {}) });
const speed = (id: string, value: number, spread = 0, better: "higher" | "lower" = "lower"): ScoreMetric => ({ id, value, unit: better === "lower" ? "ms" : "/s", kind: "speed", better, spread, n: 9 });
const card = (metrics: ScoreMetric[], over: Partial<Scorecard> = {}): Scorecard => ({ suite: "demo", commit: "abc1234", at: 1, seed: 7, machine: { name: "test", calibration: REFERENCE_SINGLE, cores: 8 }, metrics, ...over });
const verdicts = (run: Scorecard, baseline: Scorecard | null, options = { full: false, qualityOnly: false }) => Object.fromEntries(compare(run, baseline, options).rows.map((r) => [r.metric.id, r.verdict]));
const DEFAULT = { full: false, qualityOnly: false };

describe("quality: exact, and a change for the worse fails", () => {
  test("the same value is the same; lower-is-better going up, or higher-is-better going down, is a regression that fails the run", () => {
    const baseline = card([quality("degenerate", 0), quality("converged", 1, "higher"), quality("ratio", 1.0312)]);
    expect(compare(card([quality("degenerate", 0), quality("converged", 1, "higher"), quality("ratio", 1.0312)]), baseline, DEFAULT).failed).toBe(false);
    const worse = compare(card([quality("degenerate", 3), quality("converged", 0, "higher"), quality("ratio", 1.0312)]), baseline, DEFAULT);
    expect(Object.fromEntries(worse.rows.map((r) => [r.metric.id, r.verdict]))).toEqual({ degenerate: "regressed", converged: "regressed", ratio: "same" });
    expect(worse.failed).toBe(true);
  });

  test("an improvement is said, and doesn't fail", () => {
    const result = compare(card([quality("ratio", 1.01)]), card([quality("ratio", 1.03)]), DEFAULT);
    expect(result.rows[0]!.verdict).toBe("better");
    expect(result.rows[0]!.change).toBeCloseTo(1.01 / 1.03 - 1, 12);
    expect(result.failed).toBe(false);
  });

  test("the smallest change counts, unless the metric states a resolution: then only a change beyond it does", () => {
    expect(verdicts(card([quality("ratio", 1.0300001)]), card([quality("ratio", 1.03)]))).toEqual({ ratio: "regressed" });
    expect(verdicts(card([quality("arcmin", 0.4004, "lower", 0.001)]), card([quality("arcmin", 0.4, "lower", 0.001)]))).toEqual({ arcmin: "same" });
    expect(verdicts(card([quality("arcmin", 0.402, "lower", 0.001)]), card([quality("arcmin", 0.4, "lower", 0.001)]))).toEqual({ arcmin: "regressed" });
    // The last bit of a double isn't a change.
    expect(verdicts(card([quality("ratio", 0.1 + 0.2)]), card([quality("ratio", 0.3)]))).toEqual({ ratio: "same" });
  });

  test("a metric the baseline had and the run doesn't report is gone, and fails: a benchmark can't pass by measuring less", () => {
    const result = compare(card([quality("a", 1)]), card([quality("a", 1), quality("b", 0)]), DEFAULT);
    expect(result.rows.map((r) => [r.metric.id, r.verdict])).toEqual([["a", "same"], ["b", "gone"]]);
    expect(result.failed).toBe(true);
  });

  test("a full-only metric isn't expected of a default run, and is of a full one", () => {
    const baseline = card([quality("a", 1), quality("full.n32.converged", 1, "higher")]);
    expect(compare(card([quality("a", 1)]), baseline, DEFAULT).failed).toBe(false);
    expect(compare(card([quality("a", 1)]), baseline, { full: true, qualityOnly: false }).failed).toBe(true);
  });

  test("a metric that's new, or that changed what it measures (its unit, its direction, its kind), is new: not judged against the old one", () => {
    const baseline = card([quality("a", 1), quality("b", 5)]);
    expect(verdicts(card([quality("a", 1), { ...quality("b", 9), better: "higher" }, quality("c", 2)]), baseline)).toEqual({ a: "same", b: "new", c: "new" });
  });

  test("no baseline, or one from another seed: nothing is judged, and it says why", () => {
    const none = compare(card([quality("a", 9)]), null, DEFAULT);
    expect(none.rows[0]!.verdict).toBe("unjudged");
    expect(none.note).toMatch(/no baseline/);
    expect(none.failed).toBe(false);
    const other = compare(card([quality("a", 9)]), card([quality("a", 1)], { seed: 8 }), DEFAULT);
    expect(other.rows[0]!.verdict).toBe("unjudged");
    expect(other.note).toMatch(/seed 8/);
  });
});

describe("speed: scaled by the machine, judged beyond noise, failed only far out", () => {
  test("a machine half as fast that took twice as long did the same: no change", () => {
    const baseline = card([speed("rebuild", 100), speed("rate", 5000, 0, "higher")]);
    const slowMachine = card([speed("rebuild", 200), speed("rate", 2500, 0, "higher")], { machine: { name: "slow", calibration: REFERENCE_SINGLE / 2, cores: 4 } });
    const result = compare(slowMachine, baseline, DEFAULT);
    expect(result.rows.map((r) => r.verdict)).toEqual(["same", "same"]);
    for (const row of result.rows) expect(row.change).toBeCloseTo(0, 12);
  });

  test("a difference inside the noise band isn't called a change, either way", () => {
    const baseline = card([speed("op", 100)]);
    expect(verdicts(card([speed("op", 100 * (1 + SPEED_NOISE_FLOOR) - 0.01)]), baseline)).toEqual({ op: "same" });
    expect(verdicts(card([speed("op", 100 / (1 + SPEED_NOISE_FLOOR) + 0.01)]), baseline)).toEqual({ op: "same" });
  });

  test("beyond it, slower is reported and doesn't fail; faster is said", () => {
    const baseline = card([speed("op", 100), speed("rate", 1000, 0, "higher")]);
    const slower = compare(card([speed("op", 150), speed("rate", 600, 0, "higher")]), baseline, DEFAULT);
    expect(slower.rows.map((r) => r.verdict)).toEqual(["slower", "slower"]);
    expect(slower.rows[0]!.change).toBeCloseTo(0.5, 12);
    expect(slower.rows[1]!.change).toBeCloseTo(-0.4, 12);
    expect(slower.failed).toBe(false);
    expect(verdicts(card([speed("op", 60), speed("rate", 1600, 0, "higher")]), baseline)).toEqual({ op: "better", rate: "better" });
  });

  test("samples that scatter widen the band: a noisy measurement has to move further to count", () => {
    const baseline = card([speed("op", 100, 20)]);
    // 1.5 × (20/100 + 30/150) = 0.6: +50 % is inside it.
    expect(verdicts(card([speed("op", 150, 30)]), baseline)).toEqual({ op: "same" });
    expect(verdicts(card([speed("op", 150, 1)]), card([speed("op", 100, 1)]))).toEqual({ op: "slower" });
  });

  test(`past ${SPEED_FAIL_FACTOR}× slower it fails the run; under --ci (quality only) it's reported and doesn't`, () => {
    const baseline = card([speed("op", 100), speed("rate", 1000, 0, "higher")]);
    const run = card([speed("op", 100 * SPEED_FAIL_FACTOR + 5), speed("rate", 1000 / SPEED_FAIL_FACTOR - 5, 0, "higher")]);
    const result = compare(run, baseline, DEFAULT);
    expect(result.rows.map((r) => r.verdict)).toEqual(["regressed", "regressed"]);
    expect(result.failed).toBe(true);
    const gate = compare(run, baseline, { full: false, qualityOnly: true });
    expect(gate.rows.map((r) => r.verdict)).toEqual(["slower", "slower"]);
    expect(gate.failed).toBe(false);
    // A speed metric that's gone doesn't fail CI's quality gate; a quality one does.
    expect(compare(card([]), baseline, { full: false, qualityOnly: true }).failed).toBe(false);
    expect(compare(card([]), card([quality("a", 1)]), { full: false, qualityOnly: true }).failed).toBe(true);
  });
});

describe("baselines and files", () => {
  test("a default run's baseline keeps the full-only numbers the old one held; a full run's replaces them", () => {
    const old = card([quality("a", 1), quality("full.b", 2), quality("dropped", 3)]);
    const run = card([quality("a", 5)], { commit: "new" });
    expect(nextBaseline(run, old, false).metrics.map((m) => [m.id, m.value])).toEqual([["a", 5], ["full.b", 2]]);
    expect(nextBaseline(run, old, true).metrics.map((m) => m.id)).toEqual(["a"]);
    expect(nextBaseline(run, null, false)).toEqual(run);
  });

  test("a scorecard is written one metric a line and reads back the same", () => {
    const original = card([quality("a.b", 1, "higher", 0.5), { ...speed("c", 12.5, 0.4), note: 'says "this"' }]);
    const text = formatScorecard(original);
    expect(text.split("\n").filter((line) => line.startsWith("    {")).length).toBe(2);
    expect(Scorecard.parse(JSON.parse(text))).toEqual(original);
  });

  test("the contract: unknown fields are dropped, and a broken card is refused", () => {
    const loose = { ...card([quality("a", 1)]), extra: true, metrics: [{ ...quality("a", 1), later: "field" }] };
    expect(Scorecard.parse(loose)).toEqual(card([quality("a", 1)]));
    expect(Scorecard.safeParse(card([quality("a", 1), quality("a", 2)])).success).toBe(false); // one id twice
    expect(Scorecard.safeParse(card([{ ...quality("a", 1), value: Number.NaN }])).success).toBe(false);
    expect(Scorecard.safeParse(card([{ ...quality("a", 1), kind: "vibes" as never }])).success).toBe(false);
    expect(Scorecard.safeParse(card([quality("A bad id", 1)])).success).toBe(false);
    expect(Scorecard.safeParse({ ...card([]), machine: { name: "x", calibration: 0, cores: 1 } }).success).toBe(false);
  });

  test("the report shows the headline numbers and whatever moved, and counts the rest", () => {
    const baseline = card([quality("head", 1), quality("quiet", 2), quality("moved", 3), speed("op", 100)]);
    const run = card([quality("head", 1), quality("quiet", 2), quality("moved", 4), speed("op", 100)]);
    const text = renderSuite(run, compare(run, baseline, DEFAULT), { all: false, headline: ["head"], about: "a demo", tookMs: 1234 });
    expect(text).toContain("demo: a demo");
    expect(text).toContain("1 regressed");
    expect(text).toMatch(/head\s+quality\s+1\s+1\s+0\.0 %\s+same/);
    expect(text).toMatch(/moved\s+quality\s+4\s+3\s+\+33 %\s+REGRESSED/);
    expect(text).not.toContain("quiet");
    expect(text).toContain("(2 more unchanged; --all shows every metric)");
    expect(renderSuite(run, compare(run, baseline, DEFAULT), { all: true, headline: ["head"], about: "", tookMs: null })).toContain("quiet");
    // A suite measured elsewhere names no headline: it's shown whole, and with nothing to judge it against it says so.
    const elsewhere = renderSuite(run, compare(run, null, DEFAULT), { all: false, headline: [], about: "in a browser", tookMs: null, origin: "measured earlier, not run now" });
    expect(elsewhere).toContain("demo (measured earlier, not run now): in a browser");
    expect(elsewhere).toContain("quiet");
    expect(elsewhere).toContain("no baseline recorded");
  });
});

describe("the machine's pace through a suite", () => {
  /** A pace whose windows are given: what the machine "did" at each moment. */
  class Scripted extends Pace {
    constructor(private readonly script: { at: number; score: number }[]) {
      super();
      const windows = (this as unknown as { windows: { at: number; score: number }[] }).windows;
      windows.length = 0;
      windows.push(...script);
    }
    /** No new windows: the script is all the machine did (the base class takes three before the script is set). */
    override window(): number {
      return this.script?.at(-1)?.score ?? 1;
    }
  }

  test("a timing taken while the machine was at half its pace is brought to the suite's pace: half as long", () => {
    // The suite's median pace is 60,000; over 1,000 to 2,000 ms the machine did 30,000.
    const pace = new Scripted([
      { at: 0, score: 60_000 }, { at: 500, score: 60_000 }, { at: 900, score: 60_000 },
      { at: 1_100, score: 30_000 }, { at: 1_500, score: 30_000 }, { at: 1_900, score: 30_000 },
      { at: 2_100, score: 60_000 }, { at: 2_500, score: 60_000 }, { at: 3_000, score: 60_000 }, { at: 3_500, score: 60_000 }, { at: 4_000, score: 60_000 },
    ]);
    const { ctx, metrics, finish } = collector(1, false, () => {}, pace);
    ctx.speed("in-the-burst", [200, 200, 200], "ms", "lower", [1_050, 1_950]);
    ctx.speed("in-the-quiet", [100, 100, 100], "ms", "lower", [2_600, 3_900]);
    ctx.speed("rate-in-the-burst", [50, 50], "/s", "higher", [1_050, 1_950]);
    ctx.quality("exact", 3, "", "lower");
    expect(finish()).toBe(60_000);
    const by = Object.fromEntries(metrics.map((m) => [m.id, m]));
    // The nearest window either side counts too: 60k, 30k, 30k, 30k, 60k has the median 30k.
    expect(by["in-the-burst"]!.value).toBe(100);
    expect(by["in-the-quiet"]!.value).toBe(100);
    expect(by["rate-in-the-burst"]!.value).toBe(100);
    // Three samples that agree say nothing of how unsteady that stretch was; its windows do.
    expect(by["in-the-burst"]!.spread).toBeGreaterThan(0);
    expect(by["in-the-quiet"]!.spread).toBe(0);
    expect(by.exact!.spread).toBeUndefined();
  });

  test("timing a function: its samples as measured are returned, the metric is their median at the suite's pace, in milliseconds an item", () => {
    const pace = new Pace();
    const { ctx, metrics, finish } = collector(1, false, () => {}, pace);
    let calls = 0;
    const samples = ctx.time("spin", () => {
      calls++;
      let x = 0;
      for (let i = 0; i < 200_000; i++) x += Math.sqrt(i);
      return x;
    }, { n: 5, warm: 1, batch: 2, per: 4 });
    expect(calls).toBe(1 + 5 * 2);
    expect(samples).toHaveLength(5);
    const calibration = finish()!;
    // A real machine: tens of thousands of blocks a second, whatever else it is doing.
    expect(calibration).toBeGreaterThan(1_000);
    expect(calibration).toBe(pace.calibration());
    const [metric] = metrics;
    expect(metric).toMatchObject({ id: "spin", unit: "ms", kind: "speed", better: "lower", n: 5 });
    // Brought to the suite's pace: within the machine's own unsteadiness of what was measured.
    const measured = [...samples].sort((a, b) => a - b)[2]!;
    expect(metric!.value).toBeGreaterThan(measured / 4);
    expect(metric!.value).toBeLessThan(measured * 4);
  });
});

describe("the suites' tools", () => {
  test("the random source is the seed's: the same stream every time, another for another seed or label", () => {
    const a = rng(42);
    const b = rng(42);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(rng(43)()).not.toBe(first[0]!);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(subSeed(42, "nav")).toBe(subSeed(42, "nav"));
    expect(subSeed(42, "nav")).not.toBe(subSeed(42, "eco"));
    // Held: every recorded baseline was drawn from this stream (integer arithmetic only: the same on every machine).
    expect(rng(20_261_112)()).toBe(0.9313658876344562);
  });

  test("a timing is its samples' median with their interquartile range; nothing is dropped", () => {
    expect(summarise([5, 1, 3, 2, 4])).toEqual({ median: 3, iqr: 2, min: 1, n: 5 });
    expect(summarise([10, 10, 10, 1000]).median).toBe(10);
    expect(sig(123.456, 4)).toBe(123.5);
    expect(sig(0.00123456, 3)).toBe(0.00123);
    expect(sig(0, 3)).toBe(0);
  });

  test("a suite can't record one metric twice, or a number that isn't one", () => {
    const { ctx, metrics, finish } = collector(1, false, () => {});
    ctx.quality("a", 1, "", "higher");
    ctx.speed("b", [3, 1, 2], "ms", "lower", [0, 1]);
    expect(finish()).toBeNull(); // nobody is pacing this one: as measured
    expect(metrics).toEqual([
      { id: "a", value: 1, unit: "", kind: "quality", better: "higher" },
      { id: "b", value: 2, unit: "ms", kind: "speed", better: "lower", spread: 1, n: 3 },
    ]);
    expect(() => ctx.quality("a", 2, "", "higher")).toThrow(/twice/);
    expect(() => ctx.quality("c", Number.NaN, "", "higher")).toThrow(/finite/);
    expect(() => ctx.speed("d", [], "ms", "lower", [0, 1])).toThrow(/no samples/);
  });
});
