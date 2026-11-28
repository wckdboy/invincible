import { describe, expect, test } from "bun:test";
import { beginsByKind, type RoutedTaskRead } from "@invincible/core/routing";
import { beginLines } from "./routing.ts";

/* Where an agent's next task of each kind begins, in its details: core's routing.ts, as the node and the CLI say it. */

const done = (id: string, routing: NonNullable<RoutedTaskRead["record"]>["routing"]): RoutedTaskRead => ({ id, status: "done", verified: true, record: { routing } });

describe("where an agent's work begins, in its details", () => {
  test("one line each kind it has done, in the node's order of kinds: the tier, and why", () => {
    // The latest first, as the node lists them.
    const tasks = [done("task-code00000001", { began: "engineer", moved: "gate", kind: "code" }), done("task-fix000000001", { began: "engineer", kind: "fix" })];
    expect(beginLines(tasks)).toEqual([
      { text: "Fixes begin on the engineer's models", why: "its last fix was verified on the engineer's models" },
      { text: "Code tasks begin on the planner's models", why: "its last code task was verified on the planner's models" },
    ]);
    // The same as the node begins them and the CLI says them: one rule, core's.
    expect(beginLines(tasks).map((line) => line.why)).toEqual(beginsByKind(tasks).map(({ begin }) => begin.why));
  });

  test("none kept yet, nothing to say: the details leave the lines out", () => {
    expect(beginLines([])).toEqual([]);
    expect(beginLines([{ id: "task-running0001", status: "running", verified: false }])).toEqual([]);
  });
});
