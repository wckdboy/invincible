import type { LookView, UnderwayTask } from "@galahad/core";

/*
 * What is under way in a chat, in words (views/underway.ts draws it above the message box): each task he gave a knight
 * there that hasn't ended, and each look he set himself there that waits. Pure, so it is unit-tested.
 */

const clock = (at: number, tz?: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(tz ? { timeZone: tz } : {}) }).format(at);
const day = (at: number, tz?: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", ...(tz ? { timeZone: tz } : {}) }).format(at);

/** A time as the row says it: "23:07" today, "Wed 25 Nov, 09:00" on another day (here, or in `tz`). */
export function whenWords(at: number, now: number, tz?: string): string {
  return day(at, tz) === day(now, tz) ? clock(at, tz) : `${day(at, tz)}, ${clock(at, tz)}`;
}

/** A task's line: its knight, how it stands, and what it is. */
export function taskWords(task: Pick<UnderwayTask, "name" | "status" | "title" | "progress">): { who: string; state: string; what: string } {
  const state = task.status === "queued" ? "waiting its turn" : task.progress.trim() ? task.progress.trim().split("\n")[0]!.slice(0, 80) : "at work";
  return { who: task.name, state, what: task.title };
}

/** A look's line: when he looks again, and what at. */
export function lookWords(look: Pick<LookView, "at" | "note">, now: number, tz?: string): string {
  return `Looking again at ${whenWords(look.at, now, tz)}: ${look.note}`;
}

/** A look of his come back, as the thread shows its message: when he said he would, and what at. */
export function lookedWords(look: { set: number; note: string }, now: number, tz?: string): string {
  return `He looked again, as he said at ${whenWords(look.set, now, tz)} he would: ${look.note}`;
}

/**
 * How soon to ask again: soon while a task is under way or he is answering (he may give work); just after a look of his
 * comes due, then soon until the node takes it (within its tick, and the look is gone from the row then); else seldom.
 */
export function nextLookMs(shown: { tasks: number; looks: readonly number[] }, answering: boolean, now: number): number {
  if (shown.tasks > 0 || answering) return 5_000;
  const soonest = Math.min(...shown.looks);
  return soonest <= now ? 5_000 : Math.min(30_000, soonest - now + 1_000);
}
