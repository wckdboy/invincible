/*
 * While you were away (the node's away.ts, PLAN #37): its lines as a fresh chat shows them under its welcome. The line
 * that counts what needs your answer is left out where the chat's head says that count already, live (its line in the
 * "warn" tone, lib/now.ts primaryNow): the count is said once (the lead's note, 27 November 2026; Android's Away.kt).
 */

const WAITING = /^\d+ (thing needs|things need) your answer\.$/;

/** The node's lines, less its count of what needs your answer where `countShown` (the chat's head says it already). */
export function awayShown<T extends { text: string }>(lines: readonly T[], countShown: boolean): T[] {
  return countShown ? lines.filter((line) => !WAITING.test(line.text)) : [...lines];
}
