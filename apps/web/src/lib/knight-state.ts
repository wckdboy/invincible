import type { Now } from "./now.ts";

/*
 * What a knight is doing, in a word and a colour: the chip beside its name (ui/avatar.ts' stateChip, ui/controls.ts's
 * badge) and its row's state (its seat keeps it as data-state; since 26 November 2026 no ring round its face says it).
 * Pure (no DOM). Which one a knight is in, its row says (lib/roster.ts); Galahad's, his line (lib/now.ts). The colour is
 * never the only telling: every state it colours is said in words too.
 *
 * One colour to each thing going on, the same on every device (the Apple app's Brand.swift): blue at work, amber when
 * it waits on you, red for a failure, green for what has ended and is new to you (verified work among it) until you
 * look, grey while queued or paused, nothing at rest. Chosen so no two can be mistaken with full colour vision (each
 * pair at least 15 apart in OKLab, light and dark); under red-green colour blindness the words tell them apart.
 */

export type KnightState = "working" | "needs" | "failed" | "paused" | "queued" | "verified" | "unread" | "resting";

export interface StateLook {
  /** The chip's words. None for a knight at rest: its line says what it is for. */
  words: string | null;
  /** The chip's tone: the state's colour. */
  tone: "work" | "needs" | "failed" | "ok" | "neutral";
}

export const STATES: Record<KnightState, StateLook> = {
  working: { words: "Working", tone: "work" },
  needs: { words: "Needs you", tone: "needs" },
  failed: { words: "Failed", tone: "failed" },
  paused: { words: "Paused", tone: "neutral" },
  queued: { words: "Queued", tone: "neutral" },
  verified: { words: "Verified", tone: "ok" },
  unread: { words: "New", tone: "ok" },
  resting: { words: null, tone: "neutral" },
};

/** Galahad's state, from what his line says: what waits on you first, as a knight's row has it (what only you can
 * answer is what the row is marked for); then work in hand or an answer being written; then an answer of his you
 * haven't read; at rest otherwise. */
export const galahadState = (now: Pick<Now, "expression" | "tone">): KnightState =>
  now.tone === "warn" ? "needs" : now.tone === "accent" || now.expression === "thinking" || now.expression === "working" ? "working" : now.tone === "ok" ? "unread" : "resting";

/** How a knight is named with its state, for a screen reader and a tooltip: "Ada, working". */
export const withState = (name: string, state: KnightState): string => (STATES[state].words ? `${name}, ${STATES[state].words!.toLowerCase()}` : name);

/**
 * A line as it reads beside its state's chip: the chip's words aren't said twice. A line that begins with them ("Failed:
 * “X”", "Paused · 2 waiting") loses them there, and one that is only them ("Paused") leaves the chip to say it (empty).
 * Where no chip is shown (the sidebar's rows), the line keeps them: the colour is never the only telling.
 */
export function besideChip(line: string, state: KnightState | undefined): string {
  const words = STATES[state ?? "resting"].words;
  if (!words) return line;
  if (line === words) return "";
  for (const joint of [": ", " · "]) if (line.startsWith(`${words}${joint}`)) return line.slice(words.length + joint.length);
  return line;
}
