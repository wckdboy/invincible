import { describe, expect, test } from "bun:test";
import { type TeamTask, type TeamTaskRouting, TeamTaskRouting as Routing } from "@invincible/core";
import { BEGIN_BY_MEMORY, beginOf, ESCALATION_WHYS } from "../src/index.ts";

/*
 * Smart routing's memory, by kind of task (team-runtime beginOf): an agent's next task begins on the planner's models when
 * its last two that began on the engineer's both had to move up to them, and on the engineer's again once two in a row
 * began on the planner's that way, so work the cheaper models can do goes back to them.
 */

let n = 0;
/** One of an agent's tasks, its routing as its record kept it (none: running, or a record from before). */
const task = (routing?: TeamTaskRouting): Pick<TeamTask, "id" | "record"> => ({
  id: `task-${String(++n).padStart(12, "0")}`,
  ...(routing ? { record: { startedAt: 0, endedAt: 1, ended: "done" as const, commands: 3, revisions: 1, spent: [], routing } } : {}),
});
const moved = (why: TeamTaskRouting["moved"] = "gate"): TeamTaskRouting => ({ began: "engineer", moved: why });
const cheap: TeamTaskRouting = { began: "engineer" };
const remembered: TeamTaskRouting = { began: "planner", because: "memory" };

describe("where an agent's next task begins", () => {
  test("on the planner's models when its last two that began on the engineer's both moved up: said why", () => {
    expect(beginOf([task(moved("review")), task(moved("rereads"))], "task-new000000000")).toEqual({ why: BEGIN_BY_MEMORY });
    // Older history doesn't count: only the last two that began cheap.
    expect(beginOf([task(moved()), task(moved()), task(cheap)], "x")).toEqual({ why: BEGIN_BY_MEMORY });
  });

  test("on the engineer's when either of those two was done there, when there were fewer than two, or none was kept", () => {
    expect(beginOf([task(moved()), task(cheap)], "x")).toBeNull();
    expect(beginOf([task(cheap), task(moved())], "x")).toBeNull();
    expect(beginOf([task(moved())], "x")).toBeNull();
    expect(beginOf([], "x")).toBeNull();
    // Running work, or records from before routing was kept, say nothing.
    expect(beginOf([task(), task(), task(moved())], "x")).toBeNull();
  });

  test("after two in a row begun on the planner's by it, on the engineer's again: the cheaper models are tried again", () => {
    expect(beginOf([task(remembered), task(remembered), task(moved()), task(moved())], "x")).toBeNull();
    // One begun so is no reason to try again yet; one begun by its plan is no memory's.
    expect(beginOf([task(remembered), task(moved()), task(moved())], "x")).toEqual({ why: BEGIN_BY_MEMORY });
    expect(beginOf([task({ began: "planner", because: "plan" }), task(remembered), task(moved()), task(moved())], "x")).toEqual({ why: BEGIN_BY_MEMORY });
    // The try went up again: back to the planner's; it was done on the engineer's: it stays there.
    expect(beginOf([task(moved()), task(remembered), task(remembered), task(moved())], "x")).toEqual({ why: BEGIN_BY_MEMORY });
    expect(beginOf([task(cheap), task(remembered), task(remembered), task(moved())], "x")).toBeNull();
  });

  test("the task itself is never its own history", () => {
    const self = task(moved());
    expect(beginOf([self, task(moved())], self.id)).toBeNull();
  });

  test("why work moves up is said the same in the run and in the record core keeps", () => {
    expect([...Routing.shape.moved.unwrap().options]).toEqual([...ESCALATION_WHYS]);
  });
});
