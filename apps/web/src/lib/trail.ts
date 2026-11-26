import type { TeamTrailEntry, TeamWorkStatus } from "@galahad/core/team";

/*
 * A task's trail, read as the node gives it (POST /api/team/trail { task, after }): a page
 * of lines after the last one held, and whether there is more. Pure (no DOM, no timers): the
 * card that shows a trail asks only for what is new, and this says what to keep of each
 * answer and when to ask again.
 */

export interface TrailPage {
  task: { id: string; status: TeamWorkStatus };
  entries: TeamTrailEntry[];
  more: boolean;
}

export interface Trail {
  /** The number of the last line held: the next page is asked for after it (0: from the first the node keeps). */
  after: number;
  entries: TeamTrailEntry[];
}

/** As many lines as the node itself keeps of one task. */
const KEEP = 600;

export const emptyTrail = (): Trail => ({ after: 0, entries: [] });

/** A page taken in: only the lines after the last one held, so a page that comes twice (or late) adds nothing. */
export function takeTrail(trail: Trail, page: Pick<TrailPage, "entries">, keep = KEEP): Trail {
  const fresh = page.entries.filter((entry) => entry.n > trail.after);
  if (!fresh.length) return trail;
  return { after: fresh.at(-1)!.n, entries: [...trail.entries, ...fresh].slice(-keep) };
}

/**
 * When to ask for the next page: at once while the node has more, after a pause while the task is at
 * work, never once it has ended. `took`: the page held something new (a node that says "more" and sends
 * nothing is not asked again in a tight loop).
 */
export function trailNext(page: Pick<TrailPage, "task" | "more">, took: boolean): "now" | "wait" | "done" {
  if (page.more && took) return "now";
  return page.task.status === "running" || page.task.status === "queued" ? "wait" : "done";
}

/** The latest lines for a card, oldest first: each one's first line of text, and how many more lines it holds. */
export function trailTail(trail: Trail, lines: number): { n: number; text: string; more: number }[] {
  return trail.entries.slice(-lines).map((entry) => {
    const [first = "", ...rest] = entry.text.trim().split("\n");
    return { n: entry.n, text: first.trim(), more: rest.length };
  });
}
