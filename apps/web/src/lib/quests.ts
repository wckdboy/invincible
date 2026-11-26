/*
 * Quests as the app shows them: the gates you give one ("done means this command
 * passes"), and a gate's last result in words. Pure functions (no DOM), unit-tested.
 * The limits are the contract's (packages/core/src/quests.ts), restated here so the
 * app doesn't carry the schema library for them; a test holds the two together.
 */

export const MAX_GATES = 8;
export const MAX_GATE_LENGTH = 1000;

/** The gates typed into a field, one shell command a line: blank lines dropped, or why it won't do. */
export function gatesFromText(text: string): { gates: string[] } | { problem: string } {
  const gates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (gates.length > MAX_GATES) return { problem: `A quest takes at most ${MAX_GATES} gates (this is ${gates.length}).` };
  const long = gates.findIndex((g) => g.length > MAX_GATE_LENGTH);
  if (long >= 0) return { problem: `Gate ${long + 1} is longer than ${MAX_GATE_LENGTH} characters. Put a long check in a script and run that.` };
  return { gates };
}

/** Whose gate it is, as the app says it. */
export const gateOwner = (by: "owner" | "planner"): string => (by === "owner" ? "yours" : "proposed by the planner");

/** A gate's last result in a word or two, and its tone. */
export function gateResult(exitCode: number | null): { text: string; tone: "ok" | "danger" | "neutral" } {
  if (exitCode === null) return { text: "not run yet", tone: "neutral" };
  return exitCode === 0 ? { text: "passed", tone: "ok" } : { text: `failed (exit ${exitCode})`, tone: "danger" };
}

/* ---------- a quest in hand, as the node shows it ---------- */

export type QuestStateName = "planning" | "working" | "gating" | "reviewing" | "done" | "unverified" | "gave-up" | "stopped" | "failed";

/** Still in hand: planning, working, its gates running, under review. */
export const questInHand = (state: QuestStateName): boolean => state === "planning" || state === "working" || state === "gating" || state === "reviewing";

/** A quest's state as a badge: what it's doing, or how it ended (honestly: only "done" is green). */
export function questBadge(state: QuestStateName, silent = false): { text: string; tone: "accent" | "ok" | "warn" | "danger" | "neutral"; live: boolean } {
  if (silent && questInHand(state)) return { text: "No word from its runner", tone: "warn", live: false };
  switch (state) {
    case "planning":
      return { text: "Planning", tone: "accent", live: true };
    case "working":
      return { text: "Working", tone: "accent", live: true };
    case "gating":
      return { text: "Running its gates", tone: "accent", live: true };
    case "reviewing":
      return { text: "Under review", tone: "accent", live: true };
    case "done":
      return { text: "Done, reviewed", tone: "ok", live: false };
    case "unverified":
      return { text: "Not accepted", tone: "warn", live: false };
    case "gave-up":
      return { text: "Gave up", tone: "warn", live: false };
    case "stopped":
      return { text: "Stopped", tone: "neutral", live: false };
    case "failed":
      return { text: "Couldn't run", tone: "danger", live: false };
  }
}

/** Where he is in it, in a line: "command 3 of 30 · sent back once". */
export function questWhere(q: { step: number; maxSteps: number; revisions: number; attempt?: { index: number; attempts: number } | undefined }): string {
  const back = q.revisions === 0 ? "" : q.revisions === 1 ? "sent back once" : `sent back ${q.revisions} times`;
  return [q.attempt ? `attempt ${q.attempt.index} of ${q.attempt.attempts}` : "", `command ${q.step} of ${q.maxSteps}`, back].filter(Boolean).join(" · ");
}
