import { describe, expect, test } from "bun:test";
import { beginFor, PROBE_AFTER, type RoutedTaskRead, TASK_KINDS, type TaskKind, taskKindOf, TeamTaskRouting } from "../src/index.ts";

/*
 * Smart routing's memory, by kind of task (routing.ts): an agent's tasks of a kind begin on the tier that last verified
 * one of them, the engineer's until one has been; and after PROBE_AFTER in a row begun on the planner's by it, one tries
 * the engineer's again, so a kind the cheaper models can do now goes back to them. The same tasks give the same tier.
 */

let n = 0;
const id = () => `task-${String(++n).padStart(12, "0")}`;
/** One of an agent's finished tasks of a kind: where its work began, why, and whether it moved up or was verified. */
const finished = (kind: TaskKind, began: "engineer" | "planner", opts: { moved?: boolean; verified?: boolean; because?: "plan" | "memory" | "probe" } = {}): RoutedTaskRead => ({
  id: id(),
  status: opts.verified === false ? "failed" : "done",
  verified: opts.verified !== false,
  record: { routing: { began, kind, ...(opts.because ? { because: opts.because } : {}), ...(opts.moved ? { moved: "gate" } : {}) } },
});

describe("a task's kind", () => {
  test("a fix of a pull request's checks, else desktop work, else code in a repository, else a task", () => {
    expect(taskKindOf({ fix: true, desktop: true, repository: true })).toBe("fix");
    expect(taskKindOf({ fix: false, desktop: true, repository: true })).toBe("desktop");
    expect(taskKindOf({ fix: false, desktop: false, repository: true })).toBe("code");
    expect(taskKindOf({ fix: false, desktop: false, repository: false })).toBe("task");
  });

  test("the record says it as the contract does: the kinds, and a beginning that was a try of the cheaper models", () => {
    expect([...TeamTaskRouting.shape.kind.unwrap().options]).toEqual([...TASK_KINDS]);
    expect(TeamTaskRouting.safeParse({ began: "engineer", because: "probe", kind: "code" }).success).toBe(true);
    expect(TeamTaskRouting.safeParse({ began: "engineer", kind: "chores" }).success).toBe(false);
    // A record from before kinds were kept still reads.
    expect(TeamTaskRouting.safeParse({ began: "planner", because: "memory" }).success).toBe(true);
  });
});

describe("where a task of a kind begins", () => {
  test("on the engineer's models until one of its kind has been verified", () => {
    expect(beginFor([], "code")).toEqual({ tier: "engineer", because: null, why: "none of its code tasks has been verified yet: the engineer's models first", from: null });
    // A failure isn't one verified, wherever it ran.
    expect(beginFor([finished("code", "planner", { verified: false })], "code").tier).toBe("engineer");
  });

  test("on the tier that last verified one: the engineer's, or the planner's when it began there or moved up to it", () => {
    const cheap = finished("code", "engineer");
    expect(beginFor([cheap], "code")).toEqual({ tier: "engineer", because: null, why: "its last code task was verified on the engineer's models", from: cheap.id });
    const moved = finished("code", "engineer", { moved: true });
    expect(beginFor([moved, cheap], "code")).toEqual({ tier: "planner", because: "memory", why: "its last code task was verified on the planner's models", from: moved.id });
    expect(beginFor([finished("fix", "planner", { because: "plan" })], "fix").tier).toBe("planner");
    // The last verified is what counts: one that failed after it says nothing.
    expect(beginFor([finished("code", "engineer", { moved: true, verified: false }), cheap], "code").tier).toBe("engineer");
  });

  test("by its own kind alone: another kind's tasks, and records from before kinds were kept, say nothing of it", () => {
    const old: RoutedTaskRead = { id: id(), status: "done", verified: true, record: { routing: { began: "planner", because: "memory" } } };
    const fix = finished("fix", "engineer");
    expect(beginFor([finished("code", "engineer", { moved: true }), old, fix], "fix")).toEqual({ tier: "engineer", because: null, why: "its last fix was verified on the engineer's models", from: fix.id });
    expect(beginFor([old], "code").tier).toBe("engineer");
  });

  test(`after ${PROBE_AFTER} in a row begun on the planner's by it, the next tries the engineer's again; where that is verified, it stays`, () => {
    const remembered = () => finished("desktop", "planner", { because: "memory" });
    const run = [remembered(), remembered(), finished("desktop", "engineer", { moved: true })];
    expect(beginFor(run, "desktop")).toEqual({ tier: "engineer", because: "probe", why: "its last 2 desktop tasks began on the planner's models: this one tries the engineer's again", from: run[0]!.id });
    // The try moved up: back to the planner's. It was verified on the engineer's: the engineer's it is.
    expect(beginFor([finished("desktop", "engineer", { because: "probe", moved: true }), ...run], "desktop").tier).toBe("planner");
    expect(beginFor([finished("desktop", "engineer", { because: "probe" }), ...run], "desktop").tier).toBe("engineer");
    // One begun so is no try yet; nor two begun on the planner's by their plan.
    expect(beginFor(run.slice(1), "desktop").tier).toBe("planner");
    expect(beginFor([finished("desktop", "planner", { because: "plan" }), finished("desktop", "planner", { because: "plan" })], "desktop").tier).toBe("planner");
  });

  test("the task itself is never its own history", () => {
    const self = finished("code", "engineer", { moved: true });
    expect(beginFor([self], "code", self.id).tier).toBe("engineer");
  });
});

describe("the same trail, the same tier", () => {
  /** A kind's tasks run in turn: each begins as beginFor says, and the next sees how it ended (latest first). */
  const replay = (outcomes: readonly { moved: boolean; verified: boolean }[]) => {
    const tasks: RoutedTaskRead[] = [];
    return outcomes.map((o) => {
      const begin = beginFor(tasks, "code");
      tasks.unshift({ id: id(), status: o.verified ? "done" : "failed", verified: o.verified, record: { routing: { began: begin.tier, kind: "code", ...(begin.because ? { because: begin.because } : {}), ...(o.moved && begin.tier === "engineer" ? { moved: "rereads" } : {}) } } });
      return `${begin.tier}${begin.because ? `:${begin.because}` : ""}`;
    });
  };
  const trail = [
    { moved: false, verified: true },
    { moved: true, verified: true },
    { moved: false, verified: true },
    { moved: false, verified: true },
    { moved: true, verified: true },
    { moved: false, verified: false },
    { moved: false, verified: true },
  ];

  test("replayed, a kind's trail begins each task on the same tier, every time", () => {
    const once = replay(trail);
    expect(replay(trail)).toEqual(once);
    expect(once).toEqual(["engineer", "engineer", "planner:memory", "planner:memory", "engineer:probe", "planner:memory", "planner:memory"]);
  });

  test("cy's case: one kind at any level, one hard task among easy ones: the planner's for the next two, then a try of the engineer's, kept where it is verified", () => {
    // cy's levels in the routing suite (bench/routing/sim.ts memoryTasks, the default seed): its worker does 1 and 2, the
    // lead does 3, and nothing does a 4. Begun on the engineer's, a 3 moves up and is verified, a 4 moves up and fails.
    const levels = [2, 2, 1, 4, 2, 1, 3, 1, 1, 1, 2, 1];
    const run = () => {
      const tasks: RoutedTaskRead[] = [];
      return levels.map((level) => {
        const begin = beginFor(tasks, "code");
        const moved = begin.tier === "engineer" && level > 2;
        const verified = level <= 3;
        tasks.unshift({ id: id(), status: verified ? "done" : "failed", verified, record: { routing: { began: begin.tier, kind: "code", ...(begin.because ? { because: begin.because } : {}), ...(moved ? { moved: "gate" } : {}) } } });
        return `${level} ${begin.tier}${begin.because ? `:${begin.because}` : ""}`;
      });
    };
    const once = run();
    expect(run()).toEqual(once);
    // (The 4 failed: the last verified is still the engineer's. After the 3, two easy ones on the planner's: the price of
    // beginning where the last was verified; the try brings the kind back down.)
    expect(once).toEqual(["2 engineer", "2 engineer", "1 engineer", "4 engineer", "2 engineer", "1 engineer", "3 engineer", "1 planner:memory", "1 planner:memory", "1 engineer:probe", "2 engineer", "1 engineer"]);
  });

  test("other kinds' tasks among them change nothing of it, and neither does asking again", () => {
    const own = [finished("code", "engineer", { moved: true }), finished("code", "engineer")];
    const mixed = [finished("fix", "engineer"), own[0]!, finished("desktop", "planner", { because: "memory" }), own[1]!, finished("task", "engineer", { moved: true })];
    expect(beginFor(mixed, "code")).toEqual(beginFor(own, "code"));
    expect(beginFor(mixed, "code")).toEqual(beginFor(mixed, "code"));
  });
});
