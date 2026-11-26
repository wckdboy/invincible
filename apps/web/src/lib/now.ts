import type { AvatarExpression } from "@invincible/core/avatar";

/*
 * What the primary is doing now, in one line, for the chat's header: idle, working on
 * something, or needing you. Pure (no DOM), from what the app already asks the node:
 * the answer on screen, the turns it is running, the runs in hand, the Inbox's count.
 * Its face follows the same word, never a mood.
 */

export interface NowInput {
  /** The answer this page is watching it write: the step it's at (null: only just started). Absent: none. */
  step?: string | null;
  /** The chat turns the node is running. */
  turns: { title: string | null }[];
  /** The runs in hand. */
  runs: { goal: string }[];
  /** What waits for you in the Inbox (null: not asked yet, so nothing is said of it). */
  needs: number | null;
  /** Its chats with an answer you haven't read yet, the newest first (`GET /api/turns`; absent: none known). */
  unread?: { title: string | null }[];
}

export interface Now {
  text: string;
  expression: AvatarExpression;
  /** `ok`: an answer of its waits for you to read it, and nothing else is going on. */
  tone: "neutral" | "accent" | "warn" | "ok";
}

/** How much waits for you, as it's said everywhere. */
export const needsYou = (n: number): string => `${n} ${n === 1 ? "thing needs" : "things need"} you`;

/** Its line's parts: what it is doing (null: nothing), how much needs you (null: nothing, or not asked yet), and an answer
 * of its you haven't read. */
function lineParts(input: NowInput): { here: boolean; doing: string | null; needs: string | null; fresh: string | null } {
  const here = input.step !== undefined;
  const inHand = input.turns.length + input.runs.length;
  const needs = input.needs ? needsYou(input.needs) : null;
  let doing: string | null = null;
  if (here) doing = input.step || "Starting";
  else if (inHand > 1) doing = `Working on ${inHand} things`;
  else if (input.turns[0]) doing = input.turns[0].title ? `Working in “${input.turns[0].title}”` : "Working in a temporary chat";
  else if (input.runs[0]) doing = `Working on: ${input.runs[0].goal.trim().split("\n")[0]}`;
  // An answer it finished while you were away, as an email you haven't opened.
  const unread = input.unread ?? [];
  const fresh = unread.length > 1 ? `${unread.length} new answers` : unread[0] ? (unread[0].title ? `New answer in “${unread[0].title}”` : "A new answer") : null;
  return { here, doing, needs, fresh };
}

export function primaryNow(input: NowInput): Now {
  const { here, doing, needs, fresh } = lineParts(input);
  // The work comes first: a narrow screen cuts the line's end, and the Inbox's badge still counts what needs you.
  const text = doing ? [doing, needs].filter(Boolean).join(" · ") : (needs ?? fresh ?? (input.needs === 0 ? "Idle · nothing needs you" : "Idle"));
  return { text, expression: here ? "thinking" : doing ? "working" : needs ? "asking" : "idle", tone: needs ? "warn" : doing ? "accent" : fresh ? "ok" : "neutral" };
}

/**
 * Its line as the PWA shows it (26 November 2026): when something needs you, that first, then what it is doing. The line
 * is amber then, and a phone cuts its end: "Working on: Make syn…" in amber said one thing in words and another in
 * colour, its "· 2 things need you" cut off (there is no Inbox badge beside it on a phone since its tab bar went). The
 * same parts, the same tone and the same face as primaryNow, whose order (the work first) the iPhone and Android apps
 * are held to by the parity vectors until they take this one.
 */
export function needsFirst(input: NowInput): Now {
  const now = primaryNow(input);
  const { doing, needs } = lineParts(input);
  return doing && needs ? { ...now, text: `${needs} · ${doing}` } : now;
}
