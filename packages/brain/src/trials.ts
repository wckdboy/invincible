import { answerOk, seededRandom, type TrialAnswer, trialScore } from "@galahad/core";

/*
 * Trials: problems with exact answers, posed with fresh random parameters (a
 * remembered textbook answer doesn't help), solved by Galahad as a normal quest in
 * the Lab, and graded by this program, never by a model. The grader and the exact
 * solutions live here, outside the sandbox: the engineer only ever sees the problem.
 */

export type TrialDomain = "structures" | "civil" | "mechanical" | "electrical" | "aerospace" | "fluids" | "thermal" | "physics" | "geometry";

export interface Expected {
  key: string;
  /** What the number is, as the engineer reads it. */
  what: string;
  units: string;
  value: number;
  /** Relative tolerance (of |value|). */
  rel?: number;
  /** Absolute tolerance, in the answer's units. The larger of the two applies. */
  abs?: number;
}

export interface TrialProblem<P = any> {
  id: string;
  title: string;
  domain: TrialDomain;
  /** What a fair attempt needs, when it's more than a quest's usual budget. */
  budget?: { maxSteps?: number; commandTimeoutSec?: number };
  /** The parameters, drawn from the seeded generator (the same seed is the same problem). */
  params(rng: () => number): P;
  /** The problem as the engineer reads it (the answer keys are added after it). */
  statement(p: P): string;
  /** The exact answers. */
  solve(p: P): Expected[];
}

/** A value on the grid min, min + step, … max, printed exactly as it's used. */
export function pick(rng: () => number, min: number, max: number, step: number): number {
  const n = Math.round((max - min) / step);
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number((min + Math.floor(rng() * (n + 1)) * step).toFixed(decimals));
}

/** Draw until the parameters make a well-posed problem. */
export function until<P>(rng: () => number, draw: (rng: () => number) => P, ok: (p: P) => boolean): P {
  for (let i = 0; i < 10_000; i++) {
    const p = draw(rng);
    if (ok(p)) return p;
  }
  throw new Error("no well-posed parameters found");
}

export const tolerance = (e: Expected): number => Math.max((e.rel ?? (e.abs === undefined ? 1e-3 : 0)) * Math.abs(e.value), e.abs ?? 0);

export interface PosedTrial {
  problem: TrialProblem;
  seed: number;
  params: unknown;
  expected: Expected[];
  /** The goal handed to the quest: the statement and how to answer. */
  goal: string;
}

export function pose(problem: TrialProblem, seed: number): PosedTrial {
  const params = problem.params(seededRandom(seed));
  const expected = problem.solve(params);
  const keys = expected.map((e) => `  "${e.key}": ${e.what}, in ${e.units}`).join("\n");
  const example = `{${expected.map((e) => `"${e.key}": …`).join(", ")}}`;
  const goal = [
    problem.statement(params).trim(),
    "",
    "Write your final answers to /work/out/answer.json: one JSON object with exactly these keys, each a plain number in the units given.",
    keys,
    `For example: ${example}`,
    "Leave the scripts or working that produced them in /work/out too.",
  ].join("\n");
  return { problem, seed, params, expected, goal };
}

/** For the engineer, after the usual instructions. Nothing in it hints at a method or an answer. */
export const TRIAL_INSTRUCTIONS = [
  "This is a trial: a problem with an exact answer, graded by a program against the keys and units asked for, to a tight tolerance.",
  "Compute rather than estimate: carry full precision and round only at the end (give at least 6 significant figures).",
  "Where the problem leaves something open, make the standard assumption and note it in /work/out.",
  "Check each result independently before you finish: a second method, a limiting case, a convergence study or a units check.",
  "Write /work/out/answer.json exactly as asked; a missing key or a number in the wrong units scores nothing.",
].join(" ");

/** What the reviewer sees besides the engineer's summary. */
export const TRIAL_EVIDENCE = ["cat /work/out/answer.json"];

/** The answer file, read leniently (it comes from a sandbox): a JSON object, or one under "answers". */
export function readAnswers(text: string | null): Record<string, unknown> | null {
  if (!text?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const inner = (parsed as Record<string, unknown>).answers;
    return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : (parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

export interface Graded {
  answers: TrialAnswer[];
  score: number;
  note?: string;
}

/** Grade an answer file against the exact answers. Only plain numbers count. */
export function grade(expected: Expected[], answerText: string | null): Graded {
  const given = readAnswers(answerText);
  const answers = expected.map((e): TrialAnswer => {
    const raw = given?.[e.key];
    const got = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const tol = tolerance(e);
    return { key: e.key, units: e.units.slice(0, 20), expected: e.value, got, tolerance: tol, ok: answerOk(got, e.value, tol) };
  });
  const note = !answerText?.trim()
    ? "no /work/out/answer.json"
    : !given
      ? "answer.json isn't a JSON object"
      : answers.some((a) => a.got === null)
        ? `missing or not a number: ${answers.filter((a) => a.got === null).map((a) => a.key).join(", ")}`
        : undefined;
  return { answers, score: trialScore(answers), ...(note ? { note } : {}) };
}
