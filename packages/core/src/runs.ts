import { z } from "zod";

/*
 * Runs, as the contract sees them: the gates a run must pass, and where a run
 * in hand stands (its plan, the step it's on, each gate's last result).
 *
 * A gate is a shell command you name ("done means this passes"): it runs in the run's
 * own sandbox after the engineer says DONE, and every gate must exit 0 before the
 * independent reviewer is even asked. The planner may propose gates of its own; those
 * are marked as its proposal, and yours are never dropped or rewritten.
 */

/** The most gates you may give one run. */
export const MAX_RUN_GATES = 8;
/** The most gates a planner may propose on top of yours. */
export const MAX_PROPOSED_GATES = 3;

/** One gate: a shell command, run with `bash -c` in the run's sandbox. */
export const RunGate = z
  .string()
  .trim()
  .min(1, "a gate is a shell command")
  .max(1000)
  .refine((command) => !command.includes("\0"), "no NUL bytes in a gate");

export const RunGates = z.array(RunGate).max(MAX_RUN_GATES);

/** Who set a gate: you, or the planner (its own proposal, from its "Done when:" line). */
export type GateBy = "owner" | "planner";

/** A gate's last run, as every surface shows it. `exitCode` null: not run yet. */
export interface GateView {
  command: string;
  by: GateBy;
  exitCode: number | null;
  /** An excerpt of what it printed (redacted), when it has run. */
  excerpt?: string;
}

/*
 * Where a run in hand stands. Whoever runs a run (a terminal's `invincible do`, a loop on a node)
 * tells its node as it goes: the plan, the step it's on, each gate's last result. Node-local and in
 * memory: it's a view of work under way, not a record (the ledger and the run's memory are those).
 */

/** In hand: planning, working, its gates running, under review. Ended: as the run's outcome says, or failed (it couldn't run). */
export const RUN_STATES = ["planning", "working", "gating", "reviewing", "done", "unverified", "gave-up", "stopped", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Whether a run in that state is still in hand. */
export const runInHand = (state: RunState): boolean => state === "planning" || state === "working" || state === "gating" || state === "reviewing";

const RunRef = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** One report of where a run stands: the whole of it each time, so a report lost or repeated changes nothing. */
export const RunProgressInput = z.strictObject({
  run: RunRef,
  /** With effort: which attempt this is, and the run they all belong to. */
  attempt: z.strictObject({ of: RunRef, index: z.number().int().min(1).max(8), attempts: z.number().int().min(1).max(8) }).optional(),
  goal: z.string().max(400),
  state: z.enum(RUN_STATES),
  plan: z.string().max(6000).optional(),
  /** The command it's on (or the last it ran), and how many it may run. */
  step: z.number().int().min(0).max(10_000),
  maxSteps: z.number().int().min(1).max(10_000),
  /** What it's doing now, in a line. */
  doing: z.string().max(300).optional(),
  revisions: z.number().int().min(0).max(100),
  gates: z
    .array(z.strictObject({ command: z.string().min(1).max(1000), by: z.enum(["owner", "planner"]), exitCode: z.number().int().min(-1).max(255).nullable(), excerpt: z.string().max(1500).optional() }))
    .max(MAX_RUN_GATES + MAX_PROPOSED_GATES),
  /** How it ended, in a few lines. */
  summary: z.string().max(800).optional(),
});
export type RunProgressInput = z.infer<typeof RunProgressInput>;

/** A run as the node shows it. */
export interface RunView extends RunProgressInput {
  /** Who runs it: "you" (a terminal), or the loop or agent that reported it. */
  by: string;
  startedAt: number;
  updatedAt: number;
  /** In hand, but its runner hasn't been heard from for a while (it may have been closed). */
  silent: boolean;
}
