/*
 * What the recorded evals say, as reports: which model is best in which role (and
 * best for its cost), whether a variant of the harness helps, and how well the
 * reviewer tells right work from wrong. No dependencies (no zod): the PWA imports this
 * directly (@invincible/core/eval-reports), so the CLI, the PWA and every node say the
 * same thing from the same records.
 *
 * One rule decides every comparison here, the Evals' own: a change "wins" only if its
 * 90 % interval clears the other's. When it doesn't, the report says so in as many
 * words, and says how many evals it rests on.
 */
import { compareIntervals, costed, costIndex, evalIndex, type Interval, seededRandom } from "./eval-index.ts";
import { type Prices, spendTotal, tokensLabel, type UsageLine, moneyLabel } from "./spend.ts";

/** An eval as the reports read it (a EvalView has all of this). */
export interface ReportEval {
  run: string;
  suite: string;
  problem: string;
  domain: string;
  seed: number;
  status: string;
  score: number;
  seconds: number;
  models: readonly string[];
  spent?: { lines: readonly UsageLine[] };
  /** How the eval's run ended (done, unverified, gave-up, stopped); a reviewer's case has none. */
  outcome?: { status: string };
}

/** A run's settings as the reports read them (a EvalRunSettings has all of this). */
export interface ReportRun {
  effort: number;
  pins?: { planner?: string; engineer?: string; reviewer?: string };
  variant?: { name: string; options: Readonly<Record<string, unknown>> };
  group?: string;
  seed?: number;
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
const said = (i: Interval): string => `${pct(i.mean)} (${pct(i.low)}–${pct(i.high)}, ${i.n} eval${i.n === 1 ? "" : "s"})`;
const scored = <T extends { status: string }>(evals: readonly T[]): T[] => evals.filter((t) => t.status === "scored");

/** What a set of evals cost and bought: the Index, its cost-normalised forms, and the means an eval. */
export interface Measured {
  quality: Interval;
  perMTok: Interval | null;
  perHour: Interval | null;
  perUsd: Interval | null;
  /** Mean tokens an eval, over the evals whose every call was counted (null: none was). */
  tokensPerEval: number | null;
  usdPerEval: number | null;
  secondsPerEval: number;
  /** Tokens for one point of score (an eval solved outright), over the evals that were counted. */
  tokensPerPoint: number | null;
  usdPerPoint: number | null;
  crashed: number;
}

export function measure(evals: readonly ReportEval[], prices: Prices): Measured {
  const ok = scored(evals);
  const c = ok.map((t) => costed(t, prices));
  const index = costIndex(c);
  const counted = c.filter((t) => t.tokens !== null);
  const priced = c.filter((t) => t.usd !== null);
  const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
  const points = (ts: typeof c): number => sum(ts.map((t) => t.score));
  return {
    quality: index.quality,
    perMTok: index.perMTok,
    perHour: index.perHour,
    perUsd: index.perUsd,
    tokensPerEval: counted.length ? sum(counted.map((t) => t.tokens!)) / counted.length : null,
    usdPerEval: priced.length ? sum(priced.map((t) => t.usd!)) / priced.length : null,
    secondsPerEval: ok.length ? sum(ok.map((t) => t.seconds)) / ok.length : 0,
    tokensPerPoint: counted.length && points(counted) > 0 ? sum(counted.map((t) => t.tokens!)) / points(counted) : null,
    usdPerPoint: priced.length && points(priced) > 0 ? sum(priced.map((t) => t.usd!)) / points(priced) : null,
    crashed: evals.length - ok.length,
  };
}

/* ---------- each model, in each role ---------- */

export interface ModelRow extends Measured {
  /** The model the role was held to; null: the roster as it stood (no pin for this role). */
  model: string | null;
  runs: string[];
}

export interface RoleReport {
  role: string;
  rows: ModelRow[];
  /** Which is best, and how sure that is, in a sentence. */
  best: string;
  /** Which is best for what it costs, in a sentence (or why that can't be said yet). */
  bestForCost: string;
}

const ROLES = ["planner", "engineer", "reviewer"] as const;
const label = (row: Pick<ModelRow, "model">): string => row.model ?? "the roster as it is";

/**
 * For one suite: each role's candidates (the models a run held that role to, and the roster as it stood),
 * measured on that suite's evals. Only runs at effort 1 under the baseline harness count, so what differs
 * between rows is the model. A role nobody pinned has no table.
 */
export function modelReport(evals: readonly ReportEval[], runs: Readonly<Record<string, ReportRun>>, prices: Prices, suite: string): RoleReport[] {
  const of = evals.filter((t) => t.suite === suite);
  const plain = (run: string): boolean => {
    const s = runs[run];
    return !s || (s.effort === 1 && (!s.variant || s.variant.name === "baseline"));
  };
  const out: RoleReport[] = [];
  for (const role of ROLES) {
    const pinnedRuns = Object.entries(runs).filter(([run, s]) => s.pins?.[role] && plain(run));
    if (!pinnedRuns.length) continue;
    const groups = new Map<string | null, ReportEval[]>();
    for (const t of of) {
      if (!plain(t.run)) continue;
      const pins = runs[t.run]?.pins;
      // A run that pinned another role isn't the roster as it stood: it's a row of that other role's table.
      if (!pins?.[role] && pins && Object.keys(pins).length) continue;
      const model = pins?.[role] ?? null;
      groups.set(model, [...(groups.get(model) ?? []), t]);
    }
    const rows = [...groups.entries()]
      .map(([model, ts]): ModelRow => ({ model, runs: [...new Set(ts.map((t) => t.run))], ...measure(ts, prices) }))
      .filter((r) => r.quality.n > 0)
      .sort((a, b) => b.quality.mean - a.quality.mean || (a.model ?? "").localeCompare(b.model ?? ""));
    if (!rows.some((r) => r.model !== null)) continue;
    out.push({ role, rows, best: bestOf(role, rows), bestForCost: bestForCostOf(role, rows) });
  }
  return out;
}

function bestOf(role: string, rows: readonly ModelRow[]): string {
  const measured = rows.filter((r) => r.quality.n >= 2);
  if (measured.length < 2) return `Not enough to compare ${role}s yet: at least two candidates with two evals each (invincible eval sweep ${role} <provider/model> <provider/model> …).`;
  const top = measured[0]!;
  const unclear = measured.slice(1).filter((r) => compareIntervals(r.quality, top.quality) !== "helps");
  if (!unclear.length) return `Best ${role}: ${label(top)}, ${said(top.quality)}. Its interval clears every other candidate's: that is measured.`;
  return `Highest so far as ${role}: ${label(top)}, ${said(top.quality)}, but not measurably better than ${unclear.map((r) => `${label(r)} ${said(r.quality)}`).join(", ")}: the intervals overlap. More evals would tell.`;
}

function bestForCostOf(role: string, rows: readonly ModelRow[]): string {
  const money = rows.filter((r) => r.perUsd && r.perUsd.n >= 2);
  const tokens = rows.filter((r) => r.perMTok && r.perMTok.n >= 2);
  const by = money.length >= 2 ? { rows: money, of: (r: ModelRow) => r.perUsd!, unit: "points a dollar" } : tokens.length >= 2 ? { rows: tokens, of: (r: ModelRow) => r.perMTok!, unit: "points a million tokens" } : null;
  if (!by) return `What each ${role} costs isn't known for two candidates yet (their calls counted, and for money: a price stated with invincible price set).`;
  const ranked = [...by.rows].sort((a, b) => by.of(b).mean - by.of(a).mean);
  const top = ranked[0]!;
  const fig = (r: ModelRow): string => `${fix(by.of(r).mean)} ${by.unit} (${fix(by.of(r).low)}–${fix(by.of(r).high)})`;
  const unclear = ranked.slice(1).filter((r) => compareIntervals(by.of(r), by.of(top)) !== "helps");
  const note = money.length >= 2 ? "" : " (no prices for two candidates: by tokens, which says nothing of what a token costs)";
  if (!unclear.length) return `Best for its cost as ${role}: ${label(top)}, ${fig(top)}; its interval clears the others'${note}.`;
  return `Most for its cost so far as ${role}: ${label(top)}, ${fig(top)}, not measurably ahead of ${unclear.map((r) => `${label(r)} ${fig(r)}`).join(", ")}${note}.`;
}

const fix = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(2));

/* ---------- does a change to the harness help? ---------- */

export interface Comparison {
  a: Measured & { name: string; runs: string[] };
  b: Measured & { name: string; runs: string[] };
  /** By the Evals' rule, on raw quality: b against a. */
  verdict: "helps" | "hurts" | "none" | "unmeasured";
  /** The same tasks (problem and seed) under both: the mean of b's score minus a's, with its interval. Null: no task was run under both. */
  paired: (Interval & { pairs: number }) | null;
  /** What b spent beyond a for each point of score it gained, in tokens and in money (null: it gained none, or the cost isn't known). */
  tokensPerPointGained: number | null;
  usdPerPointGained: number | null;
  /** The whole of it in words. */
  lines: string[];
}

/** The mean of paired differences with a 90 % percentile bootstrap interval (seeded, like every interval here). */
export function pairedDifference(pairs: readonly { a: number; b: number }[], resamples = 2000): (Interval & { pairs: number }) | null {
  const n = pairs.length;
  if (!n) return null;
  const diffs = pairs.map((p) => p.b - p.a);
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { mean, low: mean, high: mean, n, pairs: n };
  const rng = seededRandom(0x9e3779b9);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rng() * n)]!;
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  return { mean, low: means[Math.floor(0.05 * (resamples - 1))]!, high: means[Math.ceil(0.95 * (resamples - 1))]!, n, pairs: n };
}

/**
 * Two sets of evals of the same suite, `b` against `a` (the baseline): the Index of each with its interval
 * and the verdict by the rule; the same tasks compared pair by pair; and what each cost.
 */
export function compareEvals(a: { name: string; evals: readonly ReportEval[] }, b: { name: string; evals: readonly ReportEval[] }, prices: Prices): Comparison {
  const ma = { name: a.name, runs: [...new Set(a.evals.map((t) => t.run))], ...measure(a.evals, prices) };
  const mb = { name: b.name, runs: [...new Set(b.evals.map((t) => t.run))], ...measure(b.evals, prices) };
  const verdict = compareIntervals(ma.quality, mb.quality);
  // The same task is the same problem posed with the same seed; several evals of it under one side are averaged.
  const key = (t: ReportEval): string => `${t.problem}#${t.seed}`;
  const mean = (ts: ReportEval[]): number => ts.reduce((s, t) => s + t.score, 0) / ts.length;
  const by = (ts: readonly ReportEval[]): Map<string, ReportEval[]> => {
    const m = new Map<string, ReportEval[]>();
    for (const t of scored(ts)) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return m;
  };
  const inA = by(a.evals);
  const inB = by(b.evals);
  const both = [...inA.keys()].filter((k) => inB.has(k)).sort();
  const paired = pairedDifference(both.map((k) => ({ a: mean(inA.get(k)!), b: mean(inB.get(k)!) })));
  const gained = mb.quality.mean - ma.quality.mean;
  const tokensPerPointGained = gained > 0 && ma.tokensPerEval !== null && mb.tokensPerEval !== null ? (mb.tokensPerEval - ma.tokensPerEval) / gained : null;
  const usdPerPointGained = gained > 0 && ma.usdPerEval !== null && mb.usdPerEval !== null ? (mb.usdPerEval - ma.usdPerEval) / gained : null;

  const cost = (m: Measured): string =>
    [
      m.tokensPerEval !== null ? `${tokensLabel(m.tokensPerEval)} tokens an eval` : "tokens unknown",
      m.usdPerEval !== null ? `${moneyLabel(m.usdPerEval)} an eval` : "",
      m.tokensPerPoint !== null ? `${tokensLabel(m.tokensPerPoint)} tokens a point${m.usdPerPoint !== null ? ` (${moneyLabel(m.usdPerPoint)})` : ""}` : m.quality.n ? "no point scored to price" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const lines = [`${a.name}: ${said(ma.quality)} · ${cost(ma)}`, `${b.name}: ${said(mb.quality)} · ${cost(mb)}`];
  if (verdict === "unmeasured") lines.push(`Not measured yet: each side needs at least two scored evals (${a.name} has ${ma.quality.n}, ${b.name} has ${mb.quality.n}).`);
  else if (verdict === "helps") lines.push(`${b.name} measurably helps: its interval clears ${a.name}'s.`);
  else if (verdict === "hurts") lines.push(`${b.name} measurably hurts: its interval lies below ${a.name}'s.`);
  else lines.push(`No measurable difference between ${a.name} and ${b.name}: the intervals overlap. ${b.name} hasn't been shown to help on this suite.`);
  if (paired && paired.pairs >= 2) {
    const sign = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(100 * x).toFixed(0)}`;
    const clear = paired.low > 0 ? "above zero" : paired.high < 0 ? "below zero" : "across zero";
    lines.push(`On the ${paired.pairs} tasks both ran (same problem, same seed): ${sign(paired.mean)} points for ${b.name} (${sign(paired.low)} to ${sign(paired.high)}), an interval ${clear}.`);
  } else lines.push("No task was run under both with the same seed: the comparison is between the two sets as wholes.");
  if (tokensPerPointGained !== null) {
    lines.push(
      tokensPerPointGained > 0
        ? `Each point ${b.name} gained cost ${tokensLabel(tokensPerPointGained)} more tokens${usdPerPointGained !== null ? ` (${moneyLabel(Math.max(0, usdPerPointGained))})` : ""}.`
        : `${b.name} scored more and spent fewer tokens an eval.`,
    );
  } else if (ma.tokensPerEval !== null && mb.tokensPerEval !== null && mb.tokensPerEval > ma.tokensPerEval) {
    lines.push(`${b.name} spent ${tokensLabel(mb.tokensPerEval - ma.tokensPerEval)} more tokens an eval and gained no score for it.`);
  }
  return { a: ma, b: mb, verdict, paired, tokensPerPointGained, usdPerPointGained, lines };
}

/**
 * Every variant a suite was run under against the baseline of its own group (the runs made together, on the
 * same seeds); a variant run without a baseline beside it is compared with every baseline run of the suite.
 */
export function variantReport(evals: readonly ReportEval[], runs: Readonly<Record<string, ReportRun>>, prices: Prices, suite: string): Comparison[] {
  const of = evals.filter((t) => t.suite === suite && runs[t.run]?.variant);
  const nameOf = (t: ReportEval): string => runs[t.run]!.variant!.name;
  const groupOf = (t: ReportEval): string => runs[t.run]!.group ?? "";
  const out: Comparison[] = [];
  const names = [...new Set(of.map(nameOf))].filter((n) => n !== "baseline").sort();
  for (const name of names) {
    const mine = of.filter((t) => nameOf(t) === name);
    const groups = new Set(mine.map(groupOf).filter(Boolean));
    const beside = of.filter((t) => nameOf(t) === "baseline" && groups.has(groupOf(t)));
    const base = beside.length ? beside : of.filter((t) => nameOf(t) === "baseline");
    if (!base.length) continue;
    out.push(compareEvals({ name: "baseline", evals: base }, { name, evals: mine }, prices));
  }
  return out;
}

/* ---------- the reviewer, measured directly ---------- */

export interface ReviewerRow {
  /** The model that reviewed (as it answered). */
  model: string;
  /** How often it was right, over every case. */
  right: Interval;
  /** Of the work it should have sent back: how much it passed. The error that lets wrong work through. */
  passedWrong: { count: number; of: number; rate: Interval | null };
  /** Of the work it should have passed: how much it sent back. The error that wastes revisions. */
  failedRight: { count: number; of: number; rate: Interval | null };
  tokensPerCase: number | null;
}

/**
 * The reviewer suite's evals by the model that reviewed: how often it passed what it should fail, and
 * failed what it should pass. A case's truth is its eval's domain (should-pass, should-fail); an eval's
 * score is 1 when the verdict was the right one.
 */
export function reviewerReport(evals: readonly ReportEval[]): ReviewerRow[] {
  const of = scored(evals).filter((t) => t.suite === "reviewer");
  const models = [...new Set(of.map((t) => t.models[0] ?? "unknown"))].sort();
  return models
    .map((model): ReviewerRow => {
      const mine = of.filter((t) => (t.models[0] ?? "unknown") === model);
      const wrong = mine.filter((t) => t.domain === "should-fail");
      const good = mine.filter((t) => t.domain === "should-pass");
      const counted = mine.filter((t) => t.spent?.lines.length && spendTotal(t.spent.lines).complete);
      const rate = (ts: ReportEval[]): Interval | null => (ts.length ? evalIndex(ts.map((t) => 1 - t.score)) : null);
      return {
        model,
        right: evalIndex(mine.map((t) => t.score)),
        passedWrong: { count: wrong.filter((t) => t.score < 1).length, of: wrong.length, rate: rate(wrong) },
        failedRight: { count: good.filter((t) => t.score < 1).length, of: good.length, rate: rate(good) },
        tokensPerCase: counted.length ? counted.reduce((s, t) => s + spendTotal(t.spent!.lines).tokens, 0) / counted.length : null,
      };
    })
    .sort((a, b) => (a.passedWrong.rate?.mean ?? 1) - (b.passedWrong.rate?.mean ?? 1) || b.right.mean - a.right.mean);
}

/** A reviewer row in a line. */
export function reviewerLine(row: ReviewerRow): string {
  const part = (p: ReviewerRow["passedWrong"], what: string): string => (p.of ? `${what} ${p.count} of ${p.of}${p.rate && p.of > 1 ? ` (${pct(p.rate.mean)}, ${pct(p.rate.low)}–${pct(p.rate.high)})` : ""}` : `${what}: no such case yet`);
  return `${row.model}: right ${said(row.right)} · ${part(row.passedWrong, "passed what it should fail")} · ${part(row.failedRight, "failed what it should pass")}${row.tokensPerCase !== null ? ` · ${tokensLabel(row.tokensPerCase)} tokens a case` : ""}`;
}

/* ---------- what "done" was worth ---------- */

export interface DoneReport {
  /** Of the runs that ended done: how many the grading found short. The error everything else is there to catch. */
  falseDone: { count: number; of: number; rate: Interval | null };
  /**
   * Of the evals solved outright: how many ended unverified or stopped. Right work it didn't stand behind, which
   * someone then has to check. (Giving up where the grading says that was the answer is a right refusal, not this.)
   */
  unclaimed: { count: number; of: number; rate: Interval | null };
}

/**
 * What a run's "done" was worth, over the scored evals that record how their run ended: a run ends
 * done on its own evidence (its gates, its reviewer), and the eval's grading, which it never sees, says
 * whether it was. Null when no eval here has a run on record (a reviewer's case has none).
 */
export function doneReport(evals: readonly ReportEval[]): DoneReport | null {
  const of = scored(evals).filter((t) => t.outcome);
  if (!of.length) return null;
  const part = (among: ReportEval[], miss: (t: ReportEval) => boolean): DoneReport["falseDone"] => ({
    count: among.filter(miss).length,
    of: among.length,
    rate: among.length ? evalIndex(among.map((t) => (miss(t) ? 1 : 0))) : null,
  });
  return {
    falseDone: part(of.filter((t) => t.outcome!.status === "done"), (t) => t.score < 1),
    unclaimed: part(of.filter((t) => t.score === 1), (t) => t.outcome!.status === "unverified" || t.outcome!.status === "stopped"),
  };
}

/** What "done" was worth, in a line. */
export function doneLine(report: DoneReport): string {
  const { falseDone: f, unclaimed: u } = report;
  const called = !f.of
    ? "never called done"
    : f.of === 1
      ? `called done once, and it ${f.count ? "wasn't" : "was"}`
      : `called done ${f.of} times, ${f.count || "none"} of them false (${pct(f.rate!.mean)}, ${pct(f.rate!.low)}–${pct(f.rate!.high)})`;
  const solved = !u.of
    ? "nothing solved outright"
    : u.of === 1
      ? `solved outright once, and ${u.count ? "left unverified or stopped" : "stood behind"}`
      : `solved outright ${u.of} times, ${u.count || "none"} of them left unverified or stopped`;
  return `${called} · ${solved}`;
}
