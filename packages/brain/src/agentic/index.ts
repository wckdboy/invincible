import { type AgenticTask, LEVELS, problemId, USUAL_LEVEL } from "./kit.ts";
import { honestContradiction, honestFalseClaim } from "./honesty.ts";
import { intervalSpec } from "./interval-spec.ts";
import { lostUpdate } from "./lost-update.ts";
import { slowRollup } from "./slow-rollup.ts";
import { tangledTotal } from "./tangled-total.ts";
import { twoManifests } from "./two-manifests.ts";
import { untangle } from "./untangle.ts";

export * from "./kit.ts";
export * from "./transfer.ts";

/*
 * The agentic suite: real work in a small repository, graded by hidden tests. One task
 * of each kind; every task has a level from 1 to 4 that turns its difficulty (each
 * task's `dial` says what the level changes), and a seed that draws everything else.
 */
export const AGENTIC_SUITE: readonly AgenticTask[] = [tangledTotal, slowRollup, untangle, intervalSpec, twoManifests, lostUpdate, honestContradiction, honestFalseClaim];

/**
 * The level each task is posed at unless a run says otherwise. They start in the middle of the dial; the
 * first calibration run (docs/TRIALS.md) moves each to where the roster scores between a third and two thirds.
 */
export const USUAL_LEVELS: Readonly<Record<string, number>> = Object.fromEntries(AGENTIC_SUITE.map((task) => [task.id, USUAL_LEVEL]));

/** A task and a level from a problem's name: `tangled-total-l3`, or `tangled-total` (its usual level, or the one given). */
export function agenticProblem(name: string, level?: number): { task: AgenticTask; level: number } | null {
  const m = /^(.*)-l([1-9])$/.exec(name);
  const task = AGENTIC_SUITE.find((t) => t.id === (m ? m[1] : name));
  if (!task) return null;
  const at = m ? Number(m[2]) : (level ?? USUAL_LEVELS[task.id] ?? USUAL_LEVEL);
  return at >= 1 && at <= LEVELS ? { task, level: at } : null;
}

/** Every task at one level (default: each at its usual one), as a run lists them. */
export const agenticProblems = (level?: number): { id: string; task: AgenticTask; level: number }[] =>
  AGENTIC_SUITE.map((task) => {
    const at = level ?? USUAL_LEVELS[task.id] ?? USUAL_LEVEL;
    return { id: problemId(task, at), task, level: at };
  });
