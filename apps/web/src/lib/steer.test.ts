import { describe, expect, test } from "bun:test";
import type { TeamSteer } from "@invincible/core/team";
import { judgedLine, neverReached, STEER_WORDS, steerAction, steerHint, steersWaiting } from "./steer.ts";

/*
 * Steering an agent's running task, in words (pure: no DOM). What the task's composer does while it runs (steer it, or
 * queue for after it), the line under it, what is on its way to the work, what never reached it, and what its proof
 * was judged against. The views draw these; the native apps port them, held to the vectors.
 */

const steer = (by: TeamSteer["by"], text: string, taken?: number): TeamSteer => ({ by, text, at: 1, ...(taken !== undefined ? { taken: { at: 2, step: taken } } : {}) });

describe("the task's composer", () => {
  test("while it runs, Enter does what this device chose and the modifier the other; otherwise it sends, as a message", () => {
    expect(steerAction({ running: true, enter: "steer", modifier: false })).toBe("steer");
    expect(steerAction({ running: true, enter: "steer", modifier: true })).toBe("queue");
    expect(steerAction({ running: true, enter: "queue", modifier: false })).toBe("queue");
    expect(steerAction({ running: true, enter: "queue", modifier: true })).toBe("steer");
    expect(steerAction({ running: false, enter: "steer", modifier: true })).toBe("send");
  });

  test("its two actions, in the brief's words, and what each does", () => {
    expect(STEER_WORDS).toEqual({
      steer: "Steer this task",
      queue: "Queue for after it",
      steerTitle: "It takes your words at its next safe point: a command it's running finishes first",
      queueTitle: "A message, kept until this task is done: its agent answers then",
    });
  });

  test("the line under it says what the keys do now, and when its agent answers a message; a phone's buttons say it themselves", () => {
    expect(steerHint({ status: "running", name: "Ada", enter: "steer", coarse: false, mac: true })).toBe("Enter steers Ada · ⌘+Enter queues for after it");
    expect(steerHint({ status: "running", name: "Ada", enter: "queue", coarse: false, mac: false })).toBe("Enter queues for after it · Ctrl+Enter steers Ada");
    expect(steerHint({ status: "running", name: "Ada", enter: "steer", coarse: true, mac: true })).toBe("");
    // Queued, its message waits behind this task (the node runs an agent's work in order): it is said so.
    expect(steerHint({ status: "queued", name: "Ada", enter: "steer", coarse: false, mac: true })).toBe("Ada answers after this task");
    expect(steerHint({ status: "done", name: "Ada", enter: "steer", coarse: false, mac: true })).toBe("");
  });
});

describe("what was said to it", () => {
  test("on its way: what its run hasn't taken yet, in order, as whose words; nothing once it has ended", () => {
    const task = { status: "running" as const, steers: [steer("owner", "Use the new schema.", 3), steer("primary", "Keep the old reader."), steer("owner", "And name it v2.")] };
    expect(steersWaiting(task, "Ada")).toEqual({ title: "On its way to Ada, at its next safe point", lines: ["Your agent: Keep the old reader.", "You: And name it v2."] });
    expect(steersWaiting({ status: "running", steers: [steer("owner", "x", 1)] }, "Ada")).toBeNull();
    expect(steersWaiting({ status: "running" }, "Ada")).toBeNull();
    expect(steersWaiting({ ...task, status: "done" }, "Ada")).toBeNull();
  });

  test("never reached it: what an ended task never took, said as such", () => {
    expect(neverReached({ status: "stopped", steers: [steer("owner", "Use the new schema.", 3), steer("owner", "And name it v2.")] })).toEqual({ title: "It ended before this reached it", lines: ["You: And name it v2."] });
    expect(neverReached({ status: "running", steers: [steer("owner", "x")] })).toBeNull();
    expect(neverReached({ status: "done", steers: [steer("owner", "x", 1)] })).toBeNull();
  });

  test("its proof: what its review judged the work against, as whose words", () => {
    expect(judgedLine(1, [steer("owner", "x", 1)])).toBe("Judged against its brief and your steer");
    expect(judgedLine(2, [steer("owner", "x", 1), steer("owner", "y", 2)])).toBe("Judged against its brief and your 2 steers, in order");
    expect(judgedLine(1, [steer("primary", "x", 1)])).toBe("Judged against its brief and your agent's steer");
    expect(judgedLine(2, [steer("owner", "x", 1), steer("primary", "y", 2)])).toBe("Judged against its brief and 2 steers, yours and your agent's, in order");
    // Judged with fewer than were taken: a steer came after its last review.
    expect(judgedLine(1, [steer("owner", "x", 1), steer("owner", "y", 9)])).toBe("Judged against its brief and the first of its 2 steers");
    expect(judgedLine(0, [])).toBeNull();
    expect(judgedLine(null, [steer("owner", "x", 1)])).toBeNull();
  });
});
