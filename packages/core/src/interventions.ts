/*
 * The mandate's north star (docs/MANDATE.md; PLAN #28): human interventions per completed task. Each time you step in on
 * a knight's task is counted on it by how; these say what that comes to. Nothing here depends on anything, so the PWA
 * takes it alone (@galahad/core/interventions).
 */

/**
 * How you step in on a knight's task: an approve card its work raised and you answered, a message of yours in its room
 * while it worked, its desktop taken over, the task paused or stopped, resumed, given again, or rewritten (given
 * again with a different goal or gates). The audit's steers are
 * not yours, and giving it the first time is the ask itself.
 */
export const INTERVENTIONS = ["approval", "message", "takeover", "stop", "resume", "again", "rewritten"] as const;
export type InterventionKind = (typeof INTERVENTIONS)[number];

/** Interventions per completed task, over the tasks that ended since a moment. */
export interface NorthStar {
  since: number;
  /** Ended done and verified. */
  completed: number;
  /** Ended any way: done, failed or stopped. */
  ended: number;
  /** Each time you stepped in on any of them. */
  interventions: number;
  /** interventions ÷ completed; null with none completed. */
  perCompleted: number | null;
  byKind: Partial<Record<InterventionKind, number>>;
}

interface Counted {
  status: string;
  verified: boolean;
  updatedAt: number;
  interventions?: Partial<Record<InterventionKind, number>>;
}

/** The north star over tasks: those that ended since `since`, every intervention on them, per one done and verified. */
export function northStar(tasks: readonly Counted[], since: number): NorthStar {
  const ended = tasks.filter((t) => t.updatedAt >= since && (t.status === "done" || t.status === "failed" || t.status === "stopped"));
  const byKind: Partial<Record<InterventionKind, number>> = {};
  for (const task of ended) for (const kind of INTERVENTIONS) if (task.interventions?.[kind]) byKind[kind] = (byKind[kind] ?? 0) + task.interventions[kind]!;
  const interventions = Object.values(byKind).reduce((sum, n) => sum + n, 0);
  const completed = ended.filter((t) => t.status === "done" && t.verified).length;
  return { since, completed, ended: ended.length, interventions, perCompleted: completed ? interventions / completed : null, byKind };
}

const NUMBER = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const WORDS: Record<InterventionKind, (n: number) => string> = {
  approval: (n) => (n === 1 ? "an approval" : `${count(n)} approvals`),
  message: (n) => (n === 1 ? "a message" : `${count(n)} messages`),
  takeover: () => "its desktop taken over",
  stop: (n) => (n === 1 ? "a stop" : `${count(n)} stops`),
  resume: (n) => (n === 1 ? "a resume" : `${count(n)} resumes`),
  again: (n) => (n === 1 ? "given again" : `given again ${count(n)} times`),
  rewritten: (n) => (n === 1 ? "rewritten" : `rewritten ${count(n)} times`),
};
const count = (n: number) => NUMBER[n] ?? String(n);

/** "an approval and two messages": how you stepped in on a task, in words (empty: never). */
export function interventionWords(counts: Partial<Record<InterventionKind, number>> | undefined): string {
  const parts = INTERVENTIONS.filter((kind) => (counts?.[kind] ?? 0) > 0).map((kind) => WORDS[kind](counts![kind]!));
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
