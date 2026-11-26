import type { AvatarExpression } from "@galahad/core/avatar";

/*
 * What Galahad is doing now, in one line, for the chat's header: idle, working on
 * something, or needing you. Pure (no DOM), from what the app already asks the node:
 * the answer on screen, the turns it is running, the quests in hand, the Inbox's count.
 * His face follows the same word, never a mood.
 */

export interface NowInput {
  /** The answer this page is watching him write: the step he's at (null: only just started). Absent: none. */
  step?: string | null;
  /** The chat turns the node is running. */
  turns: { title: string | null }[];
  /** The quests in hand. */
  quests: { goal: string }[];
  /** What waits for you in the Inbox (null: not asked yet, so nothing is said of it). */
  needs: number | null;
  /** His chats with an answer you haven't read yet, the newest first (`GET /api/turns`; absent: none known). */
  unread?: { title: string | null }[];
}

export interface Now {
  text: string;
  expression: AvatarExpression;
  /** `ok`: an answer of his waits for you to read it, and nothing else is going on. */
  tone: "neutral" | "accent" | "warn" | "ok";
}

/** How much waits for you, as it's said everywhere. */
export const needsYou = (n: number): string => `${n} ${n === 1 ? "thing needs" : "things need"} you`;

export function galahadNow(input: NowInput): Now {
  const here = input.step !== undefined;
  const inHand = input.turns.length + input.quests.length;
  const needs = input.needs ? needsYou(input.needs) : null;
  let doing: string | null = null;
  if (here) doing = input.step || "Starting";
  else if (inHand > 1) doing = `Working on ${inHand} things`;
  else if (input.turns[0]) doing = input.turns[0].title ? `Working in “${input.turns[0].title}”` : "Working in a temporary chat";
  else if (input.quests[0]) doing = `Working on: ${input.quests[0].goal.trim().split("\n")[0]}`;
  // An answer he finished while you were away, as an email you haven't opened.
  const unread = input.unread ?? [];
  const fresh = unread.length > 1 ? `${unread.length} new answers` : unread[0] ? (unread[0].title ? `New answer in “${unread[0].title}”` : "A new answer") : null;
  // The work comes first: a narrow screen cuts the line's end, and the Inbox's badge still counts what needs you.
  const text = doing ? [doing, needs].filter(Boolean).join(" · ") : (needs ?? fresh ?? (input.needs === 0 ? "Idle · nothing needs you" : "Idle"));
  return { text, expression: here ? "thinking" : doing ? "working" : needs ? "asking" : "idle", tone: needs ? "warn" : doing ? "accent" : fresh ? "ok" : "neutral" };
}
