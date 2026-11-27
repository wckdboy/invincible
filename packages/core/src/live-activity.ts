/*
 * A task's proof on the iPhone's Lock Screen and in its Dynamic Island (I10, 26 November 2026; the X2 study's seventh
 * item: no rival's shows proof). The iPhone app keeps one Live Activity for the team: the task it gave or opened last,
 * and how many of the team's other tasks are at work (27 November 2026: one for each task opened stacked up). It hands
 * its node the activity's own push token (notify-input.ts' LiveActivityInput, the notifyActivity route), and the node
 * keeps one for each device: another task's replaces the one before.
 * While the app is in front it updates the activity itself; otherwise the node says how the task stands, through Apple's
 * push service, `liveactivity` pushes to that token, until the task ends.
 *
 * What it says follows notify.ts's rules, and is stricter: fixed words and counts only, no task's goal, no agent's words,
 * and no title at all (the app gave its activity the title on the device, and it never goes to Apple): where the task is,
 * each gate's state, the reviewer, the verdict, which gate failed, and how many others are at work. No zod here: the PWA
 * and the apps' vectors read it.
 */

export const ACTIVITY_PHASES = ["queued", "running", "review", "interrupted", "ended"] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];
/** Each gate as its latest round left it (the web lib's GateState). */
export const ACTIVITY_GATE_STATES = ["waiting", "running", "passed", "failed"] as const;
export type ActivityGate = (typeof ACTIVITY_GATE_STATES)[number];
/** The reviewer: the gates come first, it's reading it, it passed it, it sent it back. */
export const ACTIVITY_REVIEWS = ["waits", "reading", "passed", "sent-back"] as const;
export type ActivityReview = (typeof ACTIVITY_REVIEWS)[number];
/** The verdict, as the proof allows (the web lib's verdictOf). */
export const ACTIVITY_VERDICTS = ["proven", "reviewed", "failed", "rejected", "gave-up", "stopped", "unverified"] as const;
export type ActivityVerdict = (typeof ACTIVITY_VERDICTS)[number];

/** A task's gates, at most (core's team.ts takes sixteen). */
export const ACTIVITY_GATES_MAX = 16;
/** How long an ended task's activity stays on the Lock Screen (T3 Code's quarter of an hour, the X2 study). */
export const ACTIVITY_LINGER_MS = 15 * 60_000;
/** A Live Activity Apple ends by itself after eight hours; a registration older than this is forgotten. */
export const ACTIVITY_KEEP_MS = 12 * 60 * 60_000;
/** The most of the team's other tasks it counts (more are said as this many). */
export const ACTIVITY_OTHERS_MAX = 999;

/** How a task stands on its Live Activity: its `content-state`, as the node says it to Apple and the app to itself. */
export interface ActivityState {
  phase: ActivityPhase;
  /** Each gate, in order. */
  gates: ActivityGate[];
  /** The reviewer, once the work has gates to pass or a review (null: none yet, or none to come). */
  review: ActivityReview | null;
  /** Once it has ended, its verdict; never before. */
  verdict: ActivityVerdict | null;
  /** The gate that failed (counted from 1), where a gate is why it failed. */
  gate: number | null;
  /** How many of the team's other tasks are at work, or queued, besides this one: a count, never which. */
  others: number;
  /** When this was said, in milliseconds since 1970. */
  at: number;
}

const one = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/**
 * A state as it may go to Apple, read strictly: exactly these keys, each a fixed word or a count, a gate number within
 * the gates, a verdict only once it has ended. Anything else is no state at all (the node then says nothing).
 */
export function readActivityState(raw: unknown): ActivityState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const keys = Object.keys(s).sort().join(",");
  if (keys !== "at,gate,gates,others,phase,review,verdict") return null;
  if (!one(ACTIVITY_PHASES, s.phase)) return null;
  if (!Array.isArray(s.gates) || s.gates.length > ACTIVITY_GATES_MAX || !s.gates.every((gate) => one(ACTIVITY_GATE_STATES, gate))) return null;
  if (s.review !== null && !one(ACTIVITY_REVIEWS, s.review)) return null;
  if (s.verdict !== null && !one(ACTIVITY_VERDICTS, s.verdict)) return null;
  if ((s.phase === "ended") !== (s.verdict !== null)) return null;
  if (s.gate !== null && (typeof s.gate !== "number" || !Number.isInteger(s.gate) || s.gate < 1 || s.gate > s.gates.length || s.verdict !== "failed")) return null;
  if (typeof s.others !== "number" || !Number.isInteger(s.others) || s.others < 0 || s.others > ACTIVITY_OTHERS_MAX) return null;
  if (typeof s.at !== "number" || !Number.isFinite(s.at) || s.at < 0) return null;
  return { phase: s.phase, gates: [...(s.gates as ActivityGate[])], review: s.review as ActivityReview | null, verdict: s.verdict as ActivityVerdict | null, gate: s.gate as number | null, others: s.others, at: s.at };
}
