import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCE_SINGLE } from "../packages/core/src/compute.ts";
import { Scorecard, ScoreMetric } from "../packages/core/src/scorecard.ts";

/*
 * The scorecard's shape (packages/core/src/scorecard.ts, re-exported here), where
 * it's kept, and how a run is read against its baseline:
 *
 *   bench/out/<suite>.json        the last run (git-ignored)
 *   bench/baseline/<suite>.json   the recorded baseline (reviewed like code;
 *                                 written only by `bun run bench --update-baseline`)
 *
 * Reading a run against a baseline (compare, below) is pure, and tested.
 */

export { Scorecard, ScoreMetric };

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(HERE, "out");
export const BASELINE_DIR = join(HERE, "baseline");

/**
 * Speed is compared after scaling by each machine's calibration, which is good to about one part in ten
 * (REFERENCE_SINGLE's own note), and a run on a machine doing other work moves by more than that from one
 * minute to the next (measured: docs/BENCHMARKS.md, "Noise"). A difference inside this band is no change.
 */
export const SPEED_NOISE_FLOOR = 0.25;
/** And the band is never narrower than the two runs' own spreads, added, times this. */
export const SPEED_SPREAD_FACTOR = 1.5;
/** A speed metric fails a run only when it's more than this many times slower than its baseline, scaled. */
export const SPEED_FAIL_FACTOR = 2;

/** A suite's last run, or null when there is none. Throws when the file isn't a scorecard. */
export function readScorecard(dir: string, suite: string): Scorecard | null {
  const path = join(dir, `${suite}.json`);
  if (!existsSync(path)) return null;
  const parsed = Scorecard.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a scorecard: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  if (parsed.data.suite !== suite) throw new Error(`${path} says it is suite "${parsed.data.suite}"`);
  return parsed.data;
}

/** One metric a line, so a baseline's diff reads like a table. */
export function formatScorecard(card: Scorecard): string {
  const head = { suite: card.suite, commit: card.commit, at: card.at, seed: card.seed, machine: card.machine };
  const lines = card.metrics.map((m) => `    ${JSON.stringify(m)}`);
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "metrics": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

export function writeScorecard(dir: string, card: Scorecard): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${card.suite}.json`);
  writeFileSync(path, formatScorecard(Scorecard.parse(card)));
  return path;
}

/** Only a `--full` run measures these. */
export const isFullOnly = (id: string): boolean => id.startsWith("full.");

/**
 * The baseline a run leaves: its own metrics, and, when it wasn't a full run, the full-only ones the old
 * baseline held (a default run can't speak for them).
 */
export function nextBaseline(run: Scorecard, old: Scorecard | null, full: boolean): Scorecard {
  if (full || !old) return run;
  const kept = old.metrics.filter((m) => isFullOnly(m.id) && !run.metrics.some((r) => r.id === m.id));
  return { ...run, metrics: [...run.metrics, ...kept] };
}

export type Verdict =
  /** Within noise (speed), or the same value (quality). */
  | "same"
  /** Quality improved; speed faster beyond noise. */
  | "better"
  /** Speed slower beyond noise, inside the wide threshold: reported, doesn't fail. */
  | "slower"
  /** A quality metric got worse, or a speed metric is past the wide threshold: fails the run. */
  | "regressed"
  /** Not in the baseline. */
  | "new"
  /** In the baseline, and this run didn't report it: fails the run. */
  | "gone"
  /** Nothing to read it against (no baseline, or another seed). */
  | "unjudged";

export interface Row {
  metric: ScoreMetric;
  baseline: ScoreMetric | null;
  /**
   * The value's change against the baseline as a fraction of the baseline (+0.2: a fifth more), for speed after
   * scaling both by their machines' calibrations. Null when there's nothing to compare, or the baseline is zero.
   */
  change: number | null;
  /** How big a change would have to be to count (speed: the noise band; quality: its resolution, as a fraction). */
  noise: number | null;
  verdict: Verdict;
}

export interface Comparison {
  suite: string;
  rows: Row[];
  /** Why quality wasn't judged, when it wasn't. */
  note: string | null;
  failed: boolean;
}

/** How much slower one thread of this machine is than the reference's (1: the reference; 2: half its speed). */
const slowness = (card: Scorecard): number => REFERENCE_SINGLE / card.machine.calibration;

/** A speed value as the reference machine would have measured it: times shrink on a slow machine's card, rates grow. */
export function scaled(metric: ScoreMetric, card: Scorecard): number {
  return metric.better === "lower" ? metric.value / slowness(card) : metric.value * slowness(card);
}

/** The value's change as a fraction of what it was. */
const changeOf = (now: number, was: number): number | null => (was === 0 ? (now === 0 ? 0 : null) : now / was - 1);

export interface CompareOptions {
  /** `--full`: full-only metrics are expected. */
  full: boolean;
  /** CI's gate: speed is reported and never fails. */
  qualityOnly: boolean;
}

/**
 * A run against its baseline. Quality: any change for the worse (beyond the metric's own resolution, when it
 * states one) is a regression, and a metric the baseline had that the run doesn't report is gone; both fail.
 * Speed: scaled by each machine's calibration, a difference inside the noise band is no change; beyond it, it
 * is said with its size, and fails only past SPEED_FAIL_FACTOR.
 */
export function compare(run: Scorecard, baseline: Scorecard | null, options: CompareOptions): Comparison {
  const rows: Row[] = [];
  let note: string | null = null;
  if (!baseline) note = "no baseline recorded: nothing is judged (bun run bench --update-baseline records one)";
  else if (baseline.seed !== run.seed) note = `the baseline was recorded with seed ${baseline.seed}: other inputs, so nothing is judged`;
  const judge = baseline !== null && baseline.seed === run.seed;
  const before = new Map((baseline?.metrics ?? []).map((m) => [m.id, m]));
  for (const metric of run.metrics) {
    const was = judge ? (before.get(metric.id) ?? null) : null;
    if (!judge) {
      rows.push({ metric, baseline: null, change: null, noise: null, verdict: "unjudged" });
      continue;
    }
    if (!was || was.kind !== metric.kind || was.better !== metric.better || was.unit !== metric.unit) {
      rows.push({ metric, baseline: null, change: null, noise: null, verdict: "new" });
      continue;
    }
    if (metric.kind === "quality") {
      const resolution = Math.max(metric.spread ?? 0, was.spread ?? 0, 1e-9 * Math.max(Math.abs(metric.value), Math.abs(was.value)));
      const delta = metric.better === "lower" ? metric.value - was.value : was.value - metric.value;
      const verdict: Verdict = Math.abs(delta) <= resolution ? "same" : delta > 0 ? "regressed" : "better";
      rows.push({ metric, baseline: was, change: changeOf(metric.value, was.value), noise: was.value === 0 ? null : resolution / Math.abs(was.value), verdict });
      continue;
    }
    const now = scaled(metric, run);
    const then = scaled(was, baseline!);
    const change = changeOf(now, then);
    // How many times worse: a time that grew, or a rate that shrank, by the same factor.
    const worse = now > 0 && then > 0 ? (metric.better === "lower" ? now / then : then / now) : null;
    const spreads = (metric.value ? (metric.spread ?? 0) / metric.value : 0) + (was.value ? (was.spread ?? 0) / was.value : 0);
    const noise = Math.max(SPEED_NOISE_FLOOR, SPEED_SPREAD_FACTOR * spreads);
    let verdict: Verdict = "same";
    if (worse === null) verdict = now === then ? "same" : "new";
    else if (worse > 1 + noise) verdict = worse > SPEED_FAIL_FACTOR && !options.qualityOnly ? "regressed" : "slower";
    else if (worse < 1 / (1 + noise)) verdict = "better";
    rows.push({ metric, baseline: was, change, noise, verdict });
  }
  if (judge) {
    const reported = new Set(run.metrics.map((m) => m.id));
    for (const was of baseline!.metrics) {
      if (reported.has(was.id) || (isFullOnly(was.id) && !options.full)) continue;
      rows.push({ metric: was, baseline: was, change: null, noise: null, verdict: "gone" });
    }
  }
  const failed = rows.some((r) => r.verdict === "regressed" || (r.verdict === "gone" && (r.metric.kind === "quality" || !options.qualityOnly)));
  return { suite: run.suite, rows, note, failed };
}

/* ---------- the report ---------- */

function number(value: number): string {
  const abs = Math.abs(value);
  if (Number.isInteger(value) && abs < 1e7) return value.toLocaleString("en-US");
  if (abs >= 1000) return Math.round(value).toLocaleString("en-US");
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(3);
  return value.toPrecision(2);
}

const amount = (m: ScoreMetric): string => `${number(m.value)}${m.unit ? ` ${m.unit}` : ""}`;

function percent(change: number): string {
  const p = change * 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p) >= 10 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1)} %`;
}

/** What a row's verdict says, in words. */
export function verdictWords(row: Row): string {
  const m = row.metric;
  switch (row.verdict) {
    case "same":
      return m.kind === "speed" ? "same (within noise)" : "same";
    case "better":
      return m.kind === "speed" ? "FASTER" : "BETTER";
    case "slower":
      return "slower";
    case "regressed":
      return m.kind === "speed" ? `REGRESSED (over ${SPEED_FAIL_FACTOR}× slower)` : "REGRESSED";
    case "new":
      return "new";
    case "gone":
      return "GONE (the run didn't report it)";
    case "unjudged":
      return "";
  }
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => `  ${r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  ")}`.trimEnd());
}

export interface RenderOptions {
  /** Every metric, not just the headline ones and those that changed. */
  all: boolean;
  headline: readonly string[];
  about: string;
  tookMs: number | null;
  /** Shown after the suite's name: "from bench/out, not run now", say. */
  origin?: string;
}

/** One suite's part of the report: its headline numbers and every metric whose verdict isn't "same". */
export function renderSuite(run: Scorecard, comparison: Comparison, options: RenderOptions): string {
  const lines: string[] = [];
  const count = (kind: "quality" | "speed", ...verdicts: Verdict[]) => comparison.rows.filter((r) => r.metric.kind === kind && verdicts.includes(r.verdict)).length;
  const judged = comparison.note === null;
  const tally = judged
    ? `quality: ${count("quality", "same")} same, ${count("quality", "better")} better, ${count("quality", "regressed")} regressed · speed: ${count("speed", "same")} same, ${count("speed", "better")} faster, ${count("speed", "slower", "regressed")} slower` +
      (count("quality", "new") + count("speed", "new") ? ` · ${count("quality", "new") + count("speed", "new")} new` : "") +
      (count("quality", "gone") + count("speed", "gone") ? ` · ${count("quality", "gone") + count("speed", "gone")} gone` : "")
    : `${run.metrics.length} metrics`;
  lines.push(`${run.suite}${options.origin ? ` (${options.origin})` : ""}: ${options.about}`);
  lines.push(`  ${tally}${options.tookMs !== null ? ` · ${(options.tookMs / 1000).toFixed(1)} s` : ""} · calibration ${run.machine.calibration.toLocaleString("en-US")} (${(run.machine.calibration / REFERENCE_SINGLE).toFixed(2)}× the reference)`);
  if (comparison.note) lines.push(`  ${comparison.note}`);
  const headline = new Set(options.headline);
  // (A suite that names no headline, one measured elsewhere, is shown whole.)
  const shown = comparison.rows.filter((r) => options.all || !options.headline.length || headline.has(r.metric.id) || !["same", "unjudged"].includes(r.verdict));
  // Headline first, in the suite's own order; then the rest as measured.
  const order = new Map(options.headline.map((id, i) => [id, i]));
  shown.sort((a, b) => (order.get(a.metric.id) ?? 1e9) - (order.get(b.metric.id) ?? 1e9));
  if (shown.length) {
    const body = shown.map((r) => [
      r.metric.id,
      r.metric.kind,
      r.verdict === "gone" ? "–" : amount(r.metric),
      r.metric.kind === "speed" && r.metric.spread !== undefined && r.verdict !== "gone" ? `±${number(r.metric.spread / 2)}` : "",
      r.baseline ? amount(r.baseline) : "",
      r.change !== null && r.verdict !== "gone" && r.baseline ? percent(r.change) : "",
      verdictWords(r),
    ]);
    lines.push(...table([["metric", "kind", "value", "", "baseline", "change", "verdict"], ...body]));
  }
  const hidden = comparison.rows.length - shown.length;
  if (hidden > 0) lines.push(`  (${hidden} more${judged ? " unchanged" : ""}; --all shows every metric)`);
  return lines.join("\n");
}
