import { z } from "zod";

/*
 * Quests, as the contract sees them: the gates a quest must pass, and where a quest
 * in hand stands (its plan, the step he's on, each gate's last result).
 *
 * A gate is a shell command you name ("done means this passes"): it runs in the quest's
 * own sandbox after the engineer says DONE, and every gate must exit 0 before the
 * independent reviewer is even asked. The planner may propose gates of its own; those
 * are marked as its proposal, and yours are never dropped or rewritten.
 */

/** The most gates you may give one quest. */
export const MAX_QUEST_GATES = 8;
/** The most gates a planner may propose on top of yours. */
export const MAX_PROPOSED_GATES = 3;

/** One gate: a shell command, run with `bash -c` in the quest's sandbox. */
export const QuestGate = z
  .string()
  .trim()
  .min(1, "a gate is a shell command")
  .max(1000)
  .refine((command) => !command.includes("\0"), "no NUL bytes in a gate");

export const QuestGates = z.array(QuestGate).max(MAX_QUEST_GATES);

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
 * Where a quest in hand stands. Whoever runs a quest (a terminal's `galahad do`, a loop on a node)
 * tells its node as it goes: the plan, the step he's on, each gate's last result. Node-local and in
 * memory: it's a view of work under way, not a record (the ledger and the quest's memory are those).
 */

/** In hand: planning, working, its gates running, under review. Ended: as the quest's outcome says, or failed (it couldn't run). */
export const QUEST_STATES = ["planning", "working", "gating", "reviewing", "done", "unverified", "gave-up", "stopped", "failed"] as const;
export type QuestState = (typeof QUEST_STATES)[number];

/** Whether a quest in that state is still in hand. */
export const questInHand = (state: QuestState): boolean => state === "planning" || state === "working" || state === "gating" || state === "reviewing";

const QuestRef = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** One report of where a quest stands: the whole of it each time, so a report lost or repeated changes nothing. */
export const QuestProgressInput = z.strictObject({
  quest: QuestRef,
  /** With effort: which attempt this is, and the quest they all belong to. */
  attempt: z.strictObject({ of: QuestRef, index: z.number().int().min(1).max(8), attempts: z.number().int().min(1).max(8) }).optional(),
  goal: z.string().max(400),
  state: z.enum(QUEST_STATES),
  plan: z.string().max(6000).optional(),
  /** The command he's on (or the last he ran), and how many he may run. */
  step: z.number().int().min(0).max(10_000),
  maxSteps: z.number().int().min(1).max(10_000),
  /** What he's doing now, in a line. */
  doing: z.string().max(300).optional(),
  revisions: z.number().int().min(0).max(100),
  gates: z
    .array(z.strictObject({ command: z.string().min(1).max(1000), by: z.enum(["owner", "planner"]), exitCode: z.number().int().min(-1).max(255).nullable(), excerpt: z.string().max(1500).optional() }))
    .max(MAX_QUEST_GATES + MAX_PROPOSED_GATES),
  /** How it ended, in a few lines. */
  summary: z.string().max(800).optional(),
});
export type QuestProgressInput = z.infer<typeof QuestProgressInput>;

/** A quest as the node shows it. */
export interface QuestView extends QuestProgressInput {
  /** Who runs it: "you" (a terminal), or the loop or agent that reported it. */
  by: string;
  startedAt: number;
  updatedAt: number;
  /** In hand, but its runner hasn't been heard from for a while (it may have been closed). */
  silent: boolean;
}
