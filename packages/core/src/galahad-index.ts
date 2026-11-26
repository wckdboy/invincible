/*
 * The Galahad Index, and the seeded generator trials pose their problems with.
 * No dependencies (no zod): the PWA imports this directly (@galahad/core/galahad-index),
 * so the CLI, the PWA and every node compute the same number from the same scores.
 */
import { costOf, type Prices, spendTotal, type UsageLine } from "./spend.ts";

/** mulberry32: small, fast, and the same everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The Galahad Index for a set of trials: the mean score with a 90 % percentile
 * bootstrap interval (seeded, so the same scores always give the same interval).
 * A change "wins" only if its interval clears the incumbent's.
 */
export function galahadIndex(scores: readonly number[], resamples = 2000): { mean: number; low: number; high: number; n: number } {
  const n = scores.length;
  if (!n) return { mean: 0, low: 0, high: 0, n: 0 };
  const mean = scores.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { mean, low: mean, high: mean, n };
  const rng = seededRandom(0x9e3779b9);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += scores[Math.floor(rng() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return { mean, low: means[Math.floor(0.05 * (resamples - 1))]!, high: means[Math.ceil(0.95 * (resamples - 1))]!, n };
}

/** An interval, as the Index gives it. */
export interface Interval {
  mean: number;
  low: number;
  high: number;
  n: number;
}

/**
 * A ratio of sums over trials (Σ score ÷ Σ cost) with a 90 % percentile bootstrap interval: the trials are
 * resampled whole, each with its score and its cost together, by the same seeded generator as the Index.
 * A trial whose cost isn't known (null) is left out; `n` says how many were counted. No cost at all: null.
 */
export function ratioIndex(pairs: readonly { score: number; cost: number | null }[], resamples = 2000): Interval | null {
  const known = pairs.filter((p): p is { score: number; cost: number } => p.cost !== null && Number.isFinite(p.cost) && p.cost >= 0);
  const n = known.length;
  const total = known.reduce((s, p) => s + p.cost, 0);
  if (!n || total <= 0) return null;
  const mean = known.reduce((s, p) => s + p.score, 0) / total;
  if (n === 1) return { mean, low: mean, high: mean, n };
  const rng = seededRandom(0x9e3779b9);
  const ratios: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let score = 0;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const p = known[Math.floor(rng() * n)]!;
      score += p.score;
      cost += p.cost;
    }
    // A resample that cost nothing (every trial drawn was free) says nothing about the ratio.
    if (cost > 0) ratios.push(score / cost);
  }
  if (!ratios.length) return { mean, low: mean, high: mean, n };
  ratios.sort((a, b) => a - b);
  return { mean, low: ratios[Math.floor(0.05 * (ratios.length - 1))]!, high: ratios[Math.ceil(0.95 * (ratios.length - 1))]!, n };
}

/** What the Index needs of a trial to weigh its quality against what it cost. */
export interface CostedTrial {
  status: string;
  score: number;
  seconds: number;
  /** Its tokens in and out together, when every one of its model calls was counted (null: unknown, or partly). */
  tokens: number | null;
  /** What those calls cost at the owner's prices, when every one is counted and priced (null otherwise). */
  usd: number | null;
}

/**
 * The Galahad Index beside what it cost: raw quality, and quality per million tokens, per hour of trial time
 * and per dollar, each with its interval. A "point" is one trial solved outright (a score of 1). The cost
 * figures are null where nothing is known (no call reported its tokens, no price stated): never an estimate.
 */
export function costIndex(trials: readonly CostedTrial[]): {
  quality: Interval;
  /** Points per million tokens. */
  perMTok: Interval | null;
  /** Points per hour of trial time (the trials' own durations, summed; not the wall time of a parallel run). */
  perHour: Interval | null;
  /** Points per US dollar. */
  perUsd: Interval | null;
  /** Totals over the trials whose cost is known, for the columns beside the Index. */
  tokens: number | null;
  usd: number | null;
  seconds: number;
} {
  const scored = trials.filter((t) => t.status === "scored");
  const sum = (xs: (number | null)[]): number | null => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
  return {
    quality: galahadIndex(scored.map((t) => t.score)),
    perMTok: ratioIndex(scored.map((t) => ({ score: t.score, cost: t.tokens === null ? null : t.tokens / 1e6 }))),
    perHour: ratioIndex(scored.map((t) => ({ score: t.score, cost: t.seconds / 3600 }))),
    perUsd: ratioIndex(scored.map((t) => ({ score: t.score, cost: t.usd }))),
    tokens: sum(scored.map((t) => t.tokens)),
    usd: sum(scored.map((t) => t.usd)),
    seconds: scored.reduce((s, t) => s + t.seconds, 0),
  };
}

/**
 * A trial as the cost-normalised Index weighs it: its tokens only when every model call reported them, its
 * money only when every one is also priced. A trial recorded before calls were counted has neither.
 */
export function costed(trial: { status: string; score: number; seconds: number; spent?: { lines: readonly UsageLine[] } }, prices: Prices): CostedTrial {
  const lines = trial.spent?.lines;
  const total = lines ? spendTotal(lines) : null;
  const cost = lines ? costOf(lines, prices) : null;
  return {
    status: trial.status,
    score: trial.score,
    seconds: trial.seconds,
    tokens: total && total.calls > 0 && total.complete ? total.tokens : null,
    usd: cost && total && total.calls > 0 && cost.complete ? cost.usd : null,
  };
}

/** The rule every comparison here goes by: one "wins" only if its interval clears the other's. */
export function compareIntervals(base: Pick<Interval, "low" | "high" | "n">, other: Pick<Interval, "low" | "high" | "n">): "helps" | "hurts" | "none" | "unmeasured" {
  if (base.n < 2 || other.n < 2) return "unmeasured";
  if (other.low > base.high) return "helps";
  if (other.high < base.low) return "hurts";
  return "none";
}

/** The Index of the trials run at one effort level. */
export interface EffortIndex {
  /** Attempts per trial (1: one engineer in one sandbox). */
  effort: number;
  mean: number;
  low: number;
  high: number;
  /** Scored trials (crashed ones say nothing about ability), and the runs they came from. */
  n: number;
  runs: number;
}

const percent = (x: number): string => `${(100 * x).toFixed(0)}%`;

/**
 * The Index per effort level, and whether more effort measurably helped: a level "wins" only
 * if its interval clears effort 1's (the same rule as any change). `efforts` says which runs
 * ran at more than effort 1 (a run it doesn't name ran at 1). When more effort didn't
 * measurably help, the verdict says so.
 */
export function effortReport(
  trials: readonly { run: string; status: string; score: number }[],
  efforts: Readonly<Record<string, number>>,
): { levels: EffortIndex[]; helps: boolean | null; verdict: string } {
  const byLevel = new Map<number, { scores: number[]; runs: Set<string> }>();
  for (const t of trials) {
    if (t.status !== "scored") continue;
    const effort = efforts[t.run] ?? 1;
    const level = byLevel.get(effort) ?? { scores: [], runs: new Set<string>() };
    level.scores.push(t.score);
    level.runs.add(t.run);
    byLevel.set(effort, level);
  }
  const levels = [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([effort, level]) => ({ effort, ...galahadIndex(level.scores), runs: level.runs.size }));
  const base = levels.find((l) => l.effort === 1);
  const top = [...levels].reverse().find((l) => l.effort > 1);
  if (!base || !top || base.n < 2 || top.n < 2) {
    return { levels, helps: null, verdict: "Not measured at more than one effort level yet: galahad trial run --effort 3 (and one at --effort 1) to see whether more compute helps." };
  }
  const said = (l: EffortIndex) => `${percent(l.mean)} (${percent(l.low)}–${percent(l.high)}, ${l.n} trials)`;
  if (top.low > base.high) return { levels, helps: true, verdict: `More effort measurably helps: effort ${top.effort} scores ${said(top)} against ${said(base)} at effort 1, and the intervals don't overlap.` };
  if (top.high < base.low) return { levels, helps: false, verdict: `More effort measurably hurt: effort ${top.effort} scores ${said(top)} against ${said(base)} at effort 1.` };
  return { levels, helps: false, verdict: `No measurable difference: effort ${top.effort} scores ${said(top)} against ${said(base)} at effort 1, and the intervals overlap. More compute hasn't been shown to help on this suite.` };
}
