import type { InvestigationView, TrialAnswer, TrialView } from "@galahad/core";
import { galahadIndex } from "@galahad/core/galahad-index";

/*
 * Trials and findings, as people read them. Pure functions (no DOM), unit-tested.
 * The Index is computed by the same function the CLI uses (core's galahad-index).
 */

export interface RunSummary {
  run: string;
  startedAt: number;
  suite: string;
  version: string;
  models: string[];
  nodeName: string;
  /** In the order they finished. */
  trials: TrialView[];
  index: { mean: number; low: number; high: number; n: number };
  solved: number;
  crashed: number;
}

/** Runs, newest first; a run's Index counts its scored trials only (a crash says nothing about ability). */
export function groupRuns(trials: readonly TrialView[]): RunSummary[] {
  const runs = new Map<string, TrialView[]>();
  for (const t of trials) runs.set(t.run, [...(runs.get(t.run) ?? []), t]);
  return [...runs]
    .map(([run, ts]) => {
      const ordered = [...ts].sort((a, b) => a.recordedAt - b.recordedAt);
      const scored = ordered.filter((t) => t.status === "scored");
      return {
        run,
        startedAt: ordered[0]!.recordedAt - ordered[0]!.seconds * 1000,
        suite: ordered[0]!.suite,
        version: ordered[0]!.version,
        models: [...new Set(ordered.flatMap((t) => t.models))],
        nodeName: ordered[0]!.nodeName,
        trials: ordered,
        index: galahadIndex(scored.map((t) => t.score)),
        solved: scored.filter((t) => t.score === 1).length,
        crashed: ordered.length - scored.length,
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

const DOMAINS = ["structures", "civil", "mechanical", "electrical", "aerospace", "fluids", "thermal", "physics", "geometry"];

export interface ProblemSummary {
  problem: string;
  title: string;
  domain: string;
  tries: number;
  solved: number;
  mean: number;
  /** The most recent scored try. */
  latest: TrialView;
}

/** Each problem over every run (scored tries only), in the suite's domain order. */
export function byProblem(trials: readonly TrialView[]): ProblemSummary[] {
  const groups = new Map<string, TrialView[]>();
  for (const t of trials) if (t.status === "scored") groups.set(t.problem, [...(groups.get(t.problem) ?? []), t]);
  const rank = (d: string) => (DOMAINS.includes(d) ? DOMAINS.indexOf(d) : DOMAINS.length);
  return [...groups]
    .map(([problem, ts]) => {
      const latest = ts.reduce((a, b) => (b.recordedAt > a.recordedAt ? b : a));
      return { problem, title: latest.title, domain: latest.domain, tries: ts.length, solved: ts.filter((t) => t.score === 1).length, mean: ts.reduce((s, t) => s + t.score, 0) / ts.length, latest };
    })
    .sort((a, b) => rank(a.domain) - rank(b.domain) || a.problem.localeCompare(b.problem));
}

export const percent = (x: number): string => `${Math.round(100 * x)}%`;

/** A number as the grader saw it, without float noise: 6 significant figures. */
export const numberLabel = (x: number | null): string => (x === null ? "—" : String(Number(x.toPrecision(6))));

/** How far an answer was from the exact one, in words. */
export function offBy(a: TrialAnswer): string {
  if (a.got === null) return "no number given";
  if (a.expected === 0) return `off by ${numberLabel(Math.abs(a.got))}`;
  const rel = Math.abs(a.got - a.expected) / Math.abs(a.expected);
  if (a.ok && rel < 1e-6) return "exact";
  if (a.ok && rel < 1e-5) return "within 0.001%";
  const label = rel >= 0.1 ? `${Math.round(rel * 100)}%` : rel >= 0.001 ? `${(rel * 100).toFixed(2)}%` : `${(rel * 100).toPrecision(2)}%`;
  return `${a.ok ? "within" : "off by"} ${label}`;
}

export type Mark = "solved" | "partial" | "missed" | "crashed";

export function markOf(t: TrialView): Mark {
  if (t.status === "crashed") return "crashed";
  return t.score === 1 ? "solved" : t.score > 0 ? "partial" : "missed";
}

export const durationLabel = (seconds: number): string =>
  seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;

/* ---------- findings ---------- */

export interface PredictionLine {
  id: string;
  statement: string;
  expected: string;
  refutedIf: string;
  verdict: "consistent" | "refuted" | "undetermined" | null;
  value: string | null;
}

/** Each registered prediction beside what was found for it. */
export function predictionLines(i: InvestigationView): PredictionLine[] {
  return (i.registration?.predictions ?? []).map((p) => {
    const got = i.predictions.find((x) => x.id === p.id);
    const value =
      got && typeof got.value === "number"
        ? `${numberLabel(got.value)}${got.units ? ` ${got.units}` : ""}${typeof got.uncertainty === "number" ? ` ± ${numberLabel(got.uncertainty)}` : ""}`
        : null;
    return { id: p.id, statement: p.statement, expected: p.expected, refutedIf: p.refutedIf, verdict: got?.verdict ?? null, value };
  });
}

/** What a finding says in one word: its conclusion, or how it ended without one. */
export function findingState(i: InvestigationView): { label: string; tone: "ok" | "danger" | "warn" | "info" | "neutral" } {
  if (i.conclusion === "supported") return { label: "Supported", tone: "ok" };
  if (i.conclusion === "refuted") return { label: "Refuted", tone: "danger" };
  if (i.conclusion === "inconclusive") return { label: "Inconclusive", tone: "warn" };
  if (i.status === "running") return { label: "Running", tone: "info" };
  return { label: i.status === "gave-up" ? "Gave up" : i.status === "stopped" ? "Stopped" : "Unverified", tone: "neutral" };
}
