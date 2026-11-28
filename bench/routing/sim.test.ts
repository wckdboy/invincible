import { describe, expect, test } from "bun:test";
import { runPolicy, type SimTask, simTasks } from "./sim.ts";

/*
 * The routing suite's stand-in world (sim.ts): its tasks are the seed's, and what each way of routing does with a task
 * follows from the task's kind and level and the stand-ins' capabilities, through the real team runtime.
 */

const task = (kind: SimTask["kind"], level: number, n: number): SimTask => ({ id: `task-${String(n).padStart(12, "0")}`, kind, level });
/** One of each kind at each level. */
const EVERY: SimTask[] = (["gate", "review", "stall"] as const).flatMap((kind, k) => [1, 2, 3, 4].map((level) => task(kind, level, k * 4 + level)));
const done = (r: Awaited<ReturnType<typeof runPolicy>>) => r.tasks.filter((t) => t.verified).map((t) => `${t.task.kind}${t.task.level}`);

describe("the routing suite's stand-ins", () => {
  test("a seed's tasks are the same every time, as many of each kind, each at a level from 1 to 4", () => {
    const tasks = simTasks(7, 12);
    expect(simTasks(7, 12)).toEqual(tasks);
    expect(simTasks(8, 12)).not.toEqual(tasks);
    expect(["gate", "review", "stall"].map((kind) => tasks.filter((t) => t.kind === kind).length)).toEqual([4, 4, 4]);
    expect(tasks.every((t) => t.level >= 1 && t.level <= 4 && /^task-[a-z0-9_-]{12}$/.test(t.id))).toBe(true);
  });

  test("routed, the ladder takes what the worker can't do to the lead: a gate, a review or the audits saying no twice; a 4 needs you", async () => {
    const r = await runPolicy("routed", EVERY);
    expect(done(r)).toEqual(["gate1", "gate2", "gate3", "review1", "review2", "review3", "stall1", "stall2", "stall3"]);
    const why = (kind: string, level: number) => r.tasks.find((t) => t.task.kind === kind && t.task.level === level)!.escalations;
    expect(why("gate", 3)).toEqual(["Escalated · the same gate failed twice in a row: the planner's models take the work"]);
    expect(why("review", 3)).toEqual(["Escalated · the reviewer sent it back twice in a row: the planner's models take the work"]);
    expect(why("stall", 3)).toEqual(["Escalated · two audits in a row steered it: the planner's models take the work"]);
    // What the worker can do never moves, and costs the lead nothing but the plan.
    expect(why("gate", 1)).toEqual([]);
    expect(r.tasks.find((t) => t.task.kind === "gate" && t.task.level === 1)!.calls).toEqual({ worker: 3, lead: 1, judge: 1 });
    expect(r.interventions).toBe(3);
  });

  test("pinned to the worker, its work stays there: nothing moves, and what is too hard for it needs you", async () => {
    const r = await runPolicy("pinned", EVERY);
    expect(done(r)).toEqual(["gate1", "gate2", "review1", "review2", "stall1", "stall2"]);
    expect(r.tasks.every((t) => t.escalations.length === 0 && t.movedOffPins === 0)).toBe(true);
  });

  test("all on the lead, it does what the lead can do, at the lead's price, and nothing says it moved", async () => {
    const r = await runPolicy("strong", EVERY);
    expect(done(r)).toEqual(["gate1", "gate2", "gate3", "review1", "review2", "review3", "stall1", "stall2", "stall3"]);
    expect(r.tasks.every((t) => t.escalations.length === 0 && t.calls.worker === 0)).toBe(true);
    // The lead's work costs more than the worker's, task for task, where both do it.
    const routed = await runPolicy("routed", EVERY);
    expect(r.tasks[0]!.usd).toBeGreaterThan(routed.tasks[0]!.usd);
  });

  test("the same tasks give the same outcomes, costs and times when run again", async () => {
    const once = await runPolicy("routed", EVERY);
    const again = await runPolicy("routed", EVERY);
    expect(again.tasks.map((t) => [t.verified, t.usd, t.minutes, t.calls])).toEqual(once.tasks.map((t) => [t.verified, t.usd, t.minutes, t.calls]));
  });
});
