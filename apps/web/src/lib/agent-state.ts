import type { Now } from "./now.ts";

/*
 * What an agent is doing, in a word and a colour: the chip beside its name (ui/avatar.ts' stateChip, ui/controls.ts's
 * badge) and its row's state (its seat keeps it as data-state; since 26 November 2026 no ring round its face says it).
 * Pure (no DOM). Which one an agent is in, its row says (lib/roster.ts); the primary's, its line (lib/now.ts). The colour is
 * never the only telling: every state it colours is said in words too.
 *
 * One colour to each thing going on, the same on every device (the Apple app's Brand.swift): blue at work, amber when
 * it waits on you, red for a failure, green for what has ended and is new to you (verified work among it) until you
 * look, grey while queued or paused, nothing at rest. Chosen so no two can be mistaken with full colour vision (each
 * pair at least 15 apart in OKLab, light and dark); under red-green colour blindness the words tell them apart.
 */

export type AgentState = "working" | "needs" | "failed" | "paused" | "queued" | "verified" | "unread" | "resting";

export interface StateLook {
  /** The chip's words. None for an agent at rest: its line says what it is for. */
  words: string | null;
  /** The chip's tone: the state's colour. */
  tone: "work" | "needs" | "failed" | "ok" | "neutral";
}

export const STATES: Record<AgentState, StateLook> = {
  working: { words: "Working", tone: "work" },
  needs: { words: "Needs you", tone: "needs" },
  failed: { words: "Failed", tone: "failed" },
  paused: { words: "Paused", tone: "neutral" },
  queued: { words: "Queued", tone: "neutral" },
  // (Verified work is new to you until you look, as the iPhone says it: never "Verified" over a verdict that may say it
  // wasn't proven. Its line says the verdict.)
  verified: { words: "New", tone: "ok" },
  unread: { words: "New", tone: "ok" },
  resting: { words: null, tone: "neutral" },
};

/** The primary's state, from what its line says: what waits on you first, as an agent's row has it (what only you can
 * answer is what the row is marked for); then work in hand or an answer being written; then an answer of its you
 * haven't read; at rest otherwise. */
export const primaryState = (now: Pick<Now, "expression" | "tone">): AgentState =>
  now.tone === "warn" ? "needs" : now.tone === "accent" || now.expression === "thinking" || now.expression === "working" ? "working" : now.tone === "ok" ? "unread" : "resting";

/** How an agent is named with its state, for a screen reader and a tooltip: "Ada, working". */
export const withState = (name: string, state: AgentState): string => (STATES[state].words ? `${name}, ${STATES[state].words!.toLowerCase()}` : name);

/**
 * A line as it reads beside its state's chip: the chip's words aren't said twice. A line that begins with them ("Failed:
 * “X”", "Paused · 2 waiting") loses them there, and one that is only them ("Paused") leaves the chip to say it (empty).
 * Where no chip is shown (the sidebar's rows), the line keeps them: the colour is never the only telling.
 */
export function besideChip(line: string, state: AgentState | undefined): string {
  const words = STATES[state ?? "resting"].words;
  if (!words) return line;
  if (line === words) return "";
  for (const joint of [": ", " · "]) if (line.startsWith(`${words}${joint}`)) return line.slice(words.length + joint.length);
  return line;
}
