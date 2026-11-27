import { describe, expect, test } from "bun:test";
import { LOOK_LIMITS, type TeamTask } from "@invincible/core";
import { ChatStore } from "../src/chats.ts";
import { writeFirst } from "../src/write-first.ts";

/*
 * It writes first when a task it gave from a chat of yours ends (your word, 27 November 2026: "be proactive";
 * docs/ARCHITECTURE.md: it proposes the next step when a task ends). The chat it gave it in gets a look of its, due at
 * once: a turn of its there, as the device whose turn gave the task and in its time zone, that says what came of it and
 * proposes the next step, which it starts itself where that is its to do. Once for each way the task ends.
 */

const NOW = Date.UTC(2026, 10, 27, 12);
const task = (over: Partial<TeamTask> = {}): TeamTask => ({
  id: "task_units",
  room: "room_ada",
  assignee: "ada",
  title: "Parse SI units",
  goal: "Parse them.",
  dependsOn: [],
  gates: [],
  status: "done",
  verified: true,
  progress: "",
  output: "Units parse, kilo to giga.",
  error: null,
  chainId: "chain_1",
  createdAt: NOW - 3_600_000,
  updatedAt: NOW,
  givenBy: "primary",
  ...over,
});
const PHONE = { kind: "client" as const, device: "d_phone" };

function world(tasks: Record<string, TeamTask>) {
  let now = NOW;
  const chats = new ChatStore(":memory:", () => now);
  const id = chats.create({ title: "The importer", project: null, role: "planner" }).id;
  const run = () => writeFirst({ chats, task: (key) => tasks[key] ?? null, now: () => now });
  return { chats, id, run, tasks, later: (ms: number) => void (now += ms) };
}

describe("it writes first when a task it gave ends", () => {
  test("its chat gets a look of its due at once, as the device that gave the task and in its time zone, saying how it ended", () => {
    const w = world({ task_units: task() });
    w.chats.handoff(w.id, "task_units", { by: PHONE, zone: "Europe/Copenhagen" });
    w.later(3_600_000);
    expect(w.run()).toBe(1);
    const [look] = w.chats.looksWaiting(w.id);
    // Set when it gave it (as every look reads as one it said it would take), due now.
    expect(look).toMatchObject({ conversation: w.id, at: NOW + 3_600_000, set: NOW, zone: "Europe/Copenhagen", by: PHONE });
    expect(look!.note).toBe("When the task you gave @ada, “Parse SI units” (task_units), ended: it is done and proven. Say what came of it and propose the next step; start it yourself where that is yours to do, within your money.");
  });

  test("once for each way it ends: not again while it stays so; again when it ends another way after you or it took it up again", () => {
    const w = world({ task_units: task({ status: "interrupted", verified: false }) });
    w.chats.handoff(w.id, "task_units", { by: PHONE, zone: "UTC" });
    expect(w.run()).toBe(1);
    expect(w.chats.looksWaiting(w.id)[0]!.note).toContain("(task_units), ended: it was interrupted.");
    expect(w.run()).toBe(0);
    w.tasks.task_units = task({ status: "running", verified: false });
    expect(w.run()).toBe(0);
    w.tasks.task_units = task({ status: "failed", verified: false, error: "Its gates failed: bun test" });
    expect(w.run()).toBe(1);
    expect(w.chats.looksWaiting(w.id).map((l) => l.note)).toContainEqual(expect.stringContaining("When the task you gave @ada, “Parse SI units” (task_units), ended: it failed: Its gates failed: bun test. Say what came of it"));
    expect(w.run()).toBe(0);
  });

  test("each way it ends is said as it is: done and proven, done but not proven, failed and why, stopped", () => {
    const said = (over: Partial<TeamTask>) => {
      const w = world({ task_units: task(over) });
      w.chats.handoff(w.id, "task_units", { by: PHONE, zone: "UTC" });
      w.run();
      return w.chats.looksWaiting(w.id)[0]!.note.split(". Say what came")[0];
    };
    expect(said({ status: "done", verified: true })).toBe("When the task you gave @ada, “Parse SI units” (task_units), ended: it is done and proven");
    expect(said({ status: "done", verified: false })).toBe("When the task you gave @ada, “Parse SI units” (task_units), ended: it is done but not proven");
    expect(said({ status: "failed", verified: false, error: "it ran out of steps" })).toBe("When the task you gave @ada, “Parse SI units” (task_units), ended: it failed: it ran out of steps");
    expect(said({ status: "stopped", verified: false })).toBe("When the task you gave @ada, “Parse SI units” (task_units), ended: it was stopped");
  });

  test("nothing while it is queued or running, nor for a task given before the giving turn's device was kept, a task gone, or a chat gone", () => {
    const w = world({ task_units: task({ status: "queued", verified: false }), task_old: task({ id: "task_old" }) });
    w.chats.handoff(w.id, "task_units", { by: PHONE, zone: "UTC" });
    expect(w.run()).toBe(0);
    w.tasks.task_units = task({ status: "running", verified: false });
    expect(w.run()).toBe(0);
    // Given before the device was kept with it: whose turn it would be isn't known, so it isn't taken.
    w.chats.handoff(w.id, "task_old");
    // A task that is gone, and a chat you deleted.
    w.chats.handoff(w.id, "task_gone", { by: PHONE, zone: "UTC" });
    expect(w.run()).toBe(0);
    const other = w.chats.create({ title: "Gone soon", project: null, role: "planner" }).id;
    w.tasks.task_there = task({ id: "task_there" });
    w.chats.handoff(other, "task_there", { by: PHONE, zone: "UTC" });
    w.chats.delete(other);
    expect(w.run()).toBe(0);
    expect(w.chats.looksWaiting()).toEqual([]);
  });

  test("within the limits a look of its has: a chat with as many as may wait gets it at a later run, once one is taken", () => {
    const w = world({ task_units: task() });
    for (let i = 0; i < LOOK_LIMITS.perChat; i++) w.chats.lookAdd({ conversation: w.id, at: NOW + 3_600_000, note: `look ${i}`, zone: "UTC", by: PHONE, held: null });
    w.chats.handoff(w.id, "task_units", { by: PHONE, zone: "UTC" });
    expect(w.run()).toBe(0);
    w.chats.lookEnd(w.chats.looksWaiting(w.id)[0]!.id, "cancelled", "made room");
    expect(w.run()).toBe(1);
  });
});
