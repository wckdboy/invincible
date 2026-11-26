import type { UsageWindow } from "@galahad/core";

/*
 * A provider whose allowance is spent now, in the usage meter's words: the same line the
 * terminal's `galahad usage` says, worked out here (the web app reads only @galahad/core,
 * so it keeps its own HH:MM-UTC clock and its own hours-and-minutes span). Pure (no DOM).
 */

/** HH:MM in UTC, as the node keeps a window's time. */
const clockUtc = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** A span in hours and minutes ("34h 56m"). */
const spanWords = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

/** One window, in the words the meter says it: `opencode-go: its allowance is spent until 23:25 UTC (34h 56m from now), as its provider said`. */
export function spentWindowLine(window: UsageWindow, now = Date.now()): string {
  return `${window.provider}: its allowance is spent until ${clockUtc(window.until)} UTC (${spanWords(window.until - now)} from now), as its provider said`;
}

/** Every window the meter was told of, a line each (none: an empty list). */
export function spentWindowLines(windows: readonly UsageWindow[] | undefined, now = Date.now()): string[] {
  return (windows ?? []).map((window) => spentWindowLine(window, now));
}
