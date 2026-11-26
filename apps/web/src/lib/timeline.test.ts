import { describe, expect, test } from "bun:test";
import type { TeamMessage, TeamRoom, TeamTask } from "@galahad/core/team";
import { againGoal, giveAgain, timeline, timelineTasks } from "./timeline.ts";

const message = (id: string, createdAt: number, speaker = "owner"): TeamMessage => ({ id, room: "dm-ada", speaker, speakerName: speaker, text: id, createdAt, chainId: "c" });
const task = (id: string, createdAt: number, more: Partial<TeamTask> = {}): TeamTask => ({ id, room: "dm-ada", assignee: "ada", title: id, goal: "Do it", dependsOn: [], gates: [], status: "done", verified: true, progress: "", output: "", error: null, chainId: "c", createdAt, updatedAt: createdAt + 500, ...more });
const room = (id: string, members: string[], direct: boolean): TeamRoom => ({ id, name: id, members, direct, turnBudget: 8, paused: false, createdAt: 1, updatedAt: 1 });

describe("a knight's timeline", () => {
  test("messages and tasks are one list in the order they happened, each task where it was given", () => {
    // (The node lists a room's messages oldest first and its tasks newest first.)
    const items = timeline([message("m1", 10), message("m2", 30, "ada"), message("m3", 60)], [task("task-late", 50), task("task-early", 20)]);
    expect(items.map((item) => item.key)).toEqual(["m1", "task:task-early", "m2", "task:task-late", "m3"]);
    expect(items.map((item) => item.kind)).toEqual(["message", "task", "message", "task", "message"]);
    expect(items.map((item) => item.at)).toEqual([10, 20, 30, 50, 60]);
  });

  test("a task stays where it was given however long it runs, and whatever is said meanwhile", () => {
    const items = timeline([message("m1", 10), message("m2", 900)], [task("task-long", 20, { status: "running", updatedAt: 5000 })]);
    expect(items.map((item) => item.key)).toEqual(["m1", "task:task-long", "m2"]);
  });

  test("at the same moment, the words come before the work they asked for", () => {
    expect(timeline([message("m1", 20)], [task("task-a", 20)]).map((item) => item.key)).toEqual(["m1", "task:task-a"]);
    // And two tasks given at once keep the order they were given in (the node lists the later one first).
    expect(timeline([], [task("task-b", 20), task("task-a", 20)]).map((item) => item.key)).toEqual(["task:task-a", "task:task-b"]);
  });

  test("nothing said and nothing given is an empty timeline", () => {
    expect(timeline([], [])).toEqual([]);
  });

  test("where the words begin later than the work (only the latest are kept), ended tasks from before them are left out; work in hand never is", () => {
    const tasks = [task("task-new", 150), task("task-old", 50), task("task-held", 40, { status: "running" }), task("task-waiting", 30, { status: "queued" })];
    const items = timeline([message("m1", 100), message("m2", 200)], tasks, { since: 100 });
    expect(items.map((item) => item.key)).toEqual(["task:task-waiting", "task:task-held", "m1", "task:task-new", "m2"]);
    // Without a beginning, every task is there.
    expect(timeline([message("m1", 100)], tasks).length).toBe(5);
  });

  test("a knight's own timeline holds every task given to it, wherever it was given; a room's holds the room's", () => {
    const all = [task("task-own", 1), task("task-forge", 2, { room: "forge" }), task("task-lins", 3, { room: "forge", assignee: "lin" })];
    expect(timelineTasks(room("dm-ada", ["ada"], true), all).map((t) => t.id)).toEqual(["task-own", "task-forge"]);
    expect(timelineTasks(room("forge", ["ada", "lin"], false), all).map((t) => t.id)).toEqual(["task-forge", "task-lins"]);
    // A conversation two knights had with each other is a room like any other: only what was given in it.
    expect(timelineTasks(room("pair", ["ada", "lin"], true), all)).toEqual([]);
  });
});

describe("giving the same task again", () => {
  test("is the same goal, gates and knight in the same room, as a new task, with what came of it last time", () => {
    const failed = task("task-failed", 5, { status: "failed", verified: false, error: "gave-up", title: " Fix the importer ", goal: "Fix it", gates: ["bun test"], dependsOn: ["task-first"], output: "old", progress: "old" });
    expect(giveAgain(failed)).toEqual({ room: "dm-ada", assignee: "ada", title: "Fix the importer", goal: "Fix it\n\nLast time (task-failed), it ended without verified work: It gave up.\nWhat it said of its work: old", gates: ["bun test"], dependsOn: ["task-first"], again: failed.id });
  });

  test("the next try starts from the last: why, what the knight said, what the review said; only the latest try's, and nothing for work stopped or verified", () => {
    const output = "I made kilo work.\n\nReview: REVISE\nMega still parses as milli.\nWorkspace: /work/tasks/x";
    const unverified = task("task-second", 6, { status: "done", verified: false, goal: "Parse units.\n\nLast time (task-first), it ended without verified work: It gave up.", output });
    expect(againGoal(unverified)).toBe("Parse units.\n\nLast time (task-second), it ended without verified work: The work was not independently verified.\nWhat it said of its work: I made kilo work.\nWhat the independent review said: REVISE\nMega still parses as milli.");
    // A verdict alone says nothing more; a long word is cut; the goal stays within a task's limit.
    expect(againGoal({ ...unverified, output: `${"y".repeat(900)}\n\nReview: FAIL\nWorkspace: /w`, goal: "g".repeat(7990) })).toHaveLength(8000);
    expect(againGoal({ ...unverified, output: "\n\nReview: FAIL" })).toBe("Parse units.\n\nLast time (task-second), it ended without verified work: The work was not independently verified.");
    for (const status of ["stopped", "interrupted", "queued"] as const) expect(againGoal({ ...unverified, status })).toBe("Parse units.");
    expect(againGoal({ ...unverified, verified: true })).toBe("Parse units.");
  });
});
