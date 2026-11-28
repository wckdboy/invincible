import { describe, expect, test } from "bun:test";
import { beginsByKind, type RoutedTaskRead, type RoutingRead, routingReport, type RoutingReportTask } from "@invincible/core/routing";
import { beginLines, teamRoutingLines } from "./routing.ts";

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

describe("the team's routing, on the agents' page at a desk's width: a quiet line each kind", () => {
  const finished = (n: number, routing: RoutingRead | undefined, verified = true): RoutingReportTask => ({
    id: `task-${String(n).padStart(12, "0")}`,
    status: verified ? "done" : "failed",
    verified,
    record: { startedAt: 0, endedAt: 60_000, spent: [], ...(routing ? { routing } : {}) },
  });

  test("of each kind: how many were verified, began on the planner's, moved up, went round on both tiers; nothing that is none", () => {
    const tasks = [
      finished(1, { began: "engineer", kind: "code" }),
      finished(2, { began: "engineer", moved: "gate", kind: "code" }),
      finished(3, { began: "engineer", moved: "rereads", round: true, kind: "code" }, false),
      finished(4, { began: "planner", because: "memory", kind: "code" }),
      finished(5, { began: "engineer", kind: "fix" }),
      finished(6, undefined),
    ];
    expect(teamRoutingLines(tasks)).toEqual(["Fixes: 1 of 1 verified", "Code tasks: 3 of 4 verified · 1 began on the planner's · 2 moved up · 1 went round on both tiers"]);
    // The same as core's report says, which the node's CLI says too.
    expect(routingReport(tasks, {}).kinds.map((k) => k.kind)).toEqual(["fix", "code"]);
  });

  test("how many needed you (tasks you stepped in on, however often), only where any did", () => {
    const tasks = [
      { ...finished(1, { began: "engineer", kind: "code" }), interventions: { steer: 1 } },
      { ...finished(2, { began: "engineer", moved: "rereads", kind: "code" }, false), interventions: { message: 2, stop: 1 } },
      finished(3, { began: "engineer", kind: "code" }),
      finished(4, { began: "engineer", kind: "fix" }),
    ];
    expect(teamRoutingLines(tasks)).toEqual(["Fixes: 1 of 1 verified", "Code tasks: 2 of 3 verified · 1 moved up · 2 needed you"]);
  });

  test("none routed, nothing to say: the page leaves it out", () => {
    expect(teamRoutingLines([])).toEqual([]);
    expect(teamRoutingLines([finished(1, undefined), { id: "task-running0001", status: "running", verified: false }])).toEqual([]);
  });
});
