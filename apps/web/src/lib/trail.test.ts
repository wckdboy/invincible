import { describe, expect, test } from "bun:test";
import type { TeamTrailEntry } from "@invincible/core/team";
import { emptyTrail, takeTrail, trailNext, type TrailPage } from "./trail.ts";

const line = (n: number, text = `line ${n}`): TeamTrailEntry => ({ n, at: 1000 + n, text });
const page = (entries: TeamTrailEntry[], status: TrailPage["task"]["status"] = "running", more = false): TrailPage => ({ task: { id: "task-abcdefghijkl", status }, entries, more });

describe("reading a task's trail a page at a time", () => {
  test("it starts from the first line the node keeps, and each page says where the next begins", () => {
    let trail = emptyTrail();
    expect(trail.after).toBe(0);
    trail = takeTrail(trail, page([line(1), line(2), line(3)]));
    expect([trail.after, trail.entries.map((e) => e.n)]).toEqual([3, [1, 2, 3]]);
    trail = takeTrail(trail, page([line(4)]));
    expect([trail.after, trail.entries.map((e) => e.n)]).toEqual([4, [1, 2, 3, 4]]);
  });

  test("only what is new is taken: a page that comes twice, or late, adds nothing", () => {
    const first = takeTrail(emptyTrail(), page([line(1), line(2)]));
    expect(takeTrail(first, page([line(1), line(2)]))).toBe(first);
    expect(takeTrail(first, page([]))).toBe(first);
    // An answer to an older question that overlaps what is held: only its new lines.
    const next = takeTrail(first, page([line(2), line(3)]));
    expect([next.after, next.entries.map((e) => e.n)]).toEqual([3, [1, 2, 3]]);
  });

  test("the node's numbers are kept as they are: its oldest lines may be gone, and the first kept is not 1", () => {
    const trail = takeTrail(emptyTrail(), page([line(601), line(602)]));
    expect([trail.after, trail.entries.map((e) => e.n)]).toEqual([602, [601, 602]]);
  });

  test("no more is held than the node itself keeps: the oldest go", () => {
    let trail = emptyTrail();
    for (let n = 1; n <= 12; n += 4) trail = takeTrail(trail, page([line(n), line(n + 1), line(n + 2), line(n + 3)]), 10);
    expect([trail.after, trail.entries.length, trail.entries[0]!.n]).toEqual([12, 10, 3]);
  });

  test("the next page is asked for at once while the node has more, after a pause while the task is at work, and never once it has ended", () => {
    expect(trailNext(page([line(1)], "running", true), true)).toBe("now");
    expect(trailNext(page([line(1)], "running"), true)).toBe("wait");
    expect(trailNext(page([], "running"), false)).toBe("wait");
    expect(trailNext(page([], "queued"), false)).toBe("wait");
    for (const status of ["done", "failed", "stopped", "interrupted"] as const) expect([status, trailNext(page([line(9)], status), true)]).toEqual([status, "done"]);
    // An ended task's further pages are still read to the end.
    expect(trailNext(page([line(1)], "done", true), true)).toBe("now");
    // A node that says there is more and sends nothing new is not asked again in a tight loop.
    expect(trailNext(page([], "running", true), false)).toBe("wait");
    expect(trailNext(page([], "done", true), false)).toBe("done");
  });
});
