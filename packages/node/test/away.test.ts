import { describe, expect, test } from "bun:test";
import type { LoopRunView, NoticeView, TeamTask } from "@galahad/core";
import { AWAY_TASKS, awayLines } from "../src/away.ts";

/*
 * While you were away (PLAN #37): what happened since you last looked, from what the node holds, in its colours.
 */

const SINCE = 1_000_000;
const task = (over: Partial<TeamTask>): TeamTask =>
  ({ id: "task-x", room: "r", assignee: "gareth", title: "Merge conflicts back to the knight", goal: "g", dependsOn: [], gates: [], status: "done", verified: true, output: "", error: null, createdAt: SINCE - 10, updatedAt: SINCE + 10, ...over }) as TeamTask;
const notice = (over: Partial<NoticeView>): NoticeView => ({ key: "k", severity: "warn", title: "Merge conflicts: a decision for you", body: "", source: "outcome:out-1", node: null, at: SINCE + 5, dismissed: false, ...over });
const run = (over: Partial<LoopRunView>): LoopRunView => ({ loop: "bilag", run: "r1", slot: null, status: "failed", started: SINCE + 1, finished: SINCE + 2, summary: "Gmail refused the token\nmore", node: "n", ...over });
const names = (id: string) => ({ gareth: "Gareth", ada: "Ada" })[id] ?? id;

describe("while you were away", () => {
  test("nothing happened since you looked: nothing is said", () => {
    expect(awayLines({ since: SINCE, tasks: [task({ updatedAt: SINCE - 1 })], name: names, notices: [notice({ at: SINCE - 1 })], runs: [run({ finished: SINCE - 1 })], waiting: 0 })).toEqual([]);
  });

  test("tasks that ended, verified or not; his outcome's question; a loop that failed; what waits on you, each in its colour", () => {
    const lines = awayLines({
      since: SINCE,
      tasks: [task({ id: "a", status: "failed", verified: false, error: "stopped", updatedAt: SINCE + 30 }), task({ id: "b", assignee: "ada", title: "Slugs", updatedAt: SINCE + 20 }), task({ id: "c", status: "running", updatedAt: SINCE + 40 })],
      name: names,
      notices: [notice({}), notice({ key: "other", source: "heartbeat", title: "Disk is filling" })],
      runs: [run({}), run({ run: "r2", finished: SINCE + 3 }), run({ loop: "heartbeat", status: "ok" })],
      waiting: 2,
    });
    expect(lines).toEqual([
      { text: "Gareth's “Merge conflicts back to the knight” ended without passing (stopped).", tone: "danger" },
      { text: "Ada finished “Slugs”, verified.", tone: "ok" },
      { text: "Merge conflicts: a decision for you", tone: "warn" },
      { text: "The loop bilag failed 2 times: Gmail refused the token", tone: "danger" },
      { text: "2 things need your answer.", tone: "warn" },
    ]);
  });

  test(`more than ${AWAY_TASKS} tasks ended: they're counted, and the newest ${AWAY_TASKS} named`, () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}`, updatedAt: SINCE + i + 1, ...(i === 0 ? { status: "failed" as const, verified: false } : {}) }));
    const lines = awayLines({ since: SINCE, tasks, name: names, notices: [], runs: [], waiting: 0 });
    expect(lines[0]).toEqual({ text: "5 knights' tasks ended: 4 verified, 1 didn't pass.", tone: "danger" });
    expect(lines.slice(1).map((l) => l.text)).toEqual(["Gareth finished “Task 4”, verified.", "Gareth finished “Task 3”, verified.", "Gareth finished “Task 2”, verified."]);
  });
});
