import { describe, expect, test } from "bun:test";
import type { RouteName, TeamTask, TeamTrailEntry } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import { endType, Tracker } from "../../src/inv/events.ts";
import { EXIT } from "../../src/inv/exit.ts";
import { follow, needsYou } from "../../src/inv/follow.ts";
import { action, GATE, gated, reviewed, snapshot, T0, task, trail, worked } from "./fixtures.ts";

/*
 * --stream's events (docs/CLI.md, "Events"): what each line of the runner's trail makes, what an agent's approvals make,
 * and how a follower ends: with the task, or leaving first (its timeout, --no-ask, Ctrl-C).
 */

describe("the events a task's trail makes", () => {
  test("each step started and completed, each gate before and after the work, the review, the cost: in order, each a line of JSON", () => {
    const tracker = new Tracker("task-a1b2c3d4e5f6", [GATE], T0);
    const events = tracker.trail(trail([...worked([1]), { type: "budget", spentUsd: 1.62, budgetUsd: 2, out: false }, ...gated([0]), ...reviewed("pass")]));
    const said = events.map((event) => [event.type, event.kind ?? event.phase ?? event.verdict ?? null]);
    expect(said).toEqual([
      ["gate.result", "before"],
      ["step.completed", "plan"],
      ["step.started", "read"],
      ["step.completed", "read"],
      ["step.started", "run"],
      ["step.completed", "run"],
      ["step.completed", "submitted"],
      ["cost.update", null],
      ["step.completed", "note"],
      ["gate.result", "after"],
      ["review.verdict", "pass"],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ v: 1, task: "task-a1b2c3d4e5f6" });
      expect(typeof event.at).toBe("number");
      expect(JSON.stringify(event)).not.toContain("\n");
    }
    expect(events[0]).toMatchObject({ phase: "before", index: 1, of: 1, cmd: GATE, exit: 1, ms: null });
    expect(events[3]).toMatchObject({ n: 4, kind: "read", text: "packages/link/src/sync.ts", exit: 0 });
    expect(events[5]).toMatchObject({ kind: "run", text: GATE, exit: 1 });
    expect(events[7]).toMatchObject({ usd: 1.62, budgetUsd: 2, complete: false });
    expect(events[9]).toMatchObject({ phase: "after", index: 1, of: 1, cmd: GATE, exit: 0, ms: 1000 });
    expect(events[10]).toMatchObject({ verdict: "pass", sameModel: false, notes: 2 });
  });

  test("lines come in pieces as the trail grows, and each is told once", () => {
    const entries = trail([...worked([1]), ...gated([0])]);
    const whole = new Tracker("t", [GATE], T0).trail(entries);
    const pieces = new Tracker("t", [GATE], T0);
    const told = [pieces.trail(entries.slice(0, 4)), pieces.trail(entries.slice(4, 7)), pieces.trail(entries.slice(7))].flat();
    expect(told).toEqual(whole);
  });

  test("its agent's approvals: each asked for once, then decided; another agent's, or one from before the task, isn't its", () => {
    const tracker = new Tracker("task-a1b2c3d4e5f6", [GATE], T0);
    const mine = action();
    const old = action({ id: `a_${"o".repeat(22)}`, requestedAt: "001700000000000.000000" });
    const theirs = action({ id: `a_${"t".repeat(22)}`, by: "arm:team.0123456789.lin" });
    expect(tracker.asks([mine, old, theirs], "ada", T0).map((event) => [event.type, event.id])).toEqual([["approval.requested", mine.id]]);
    expect(tracker.asks([mine], "ada", T0)).toEqual([]);
    expect(tracker.asks([{ ...mine, state: "approved" }], "ada", T0)).toMatchObject([{ type: "approval.decided", id: mine.id, state: "approved" }]);
  });

  test("how it stands is told when it changes, and the end has its own type for each verdict", () => {
    const tracker = new Tracker("t", [], T0);
    expect(tracker.stands("queued", "Queued", T0)).toHaveLength(1);
    expect(tracker.stands("queued", "Queued", T0)).toEqual([]);
    expect(tracker.stands("running", "Working", T0)[0]).toMatchObject({ type: "task.state", state: "running", word: "Working" });
    expect(["verified", "unproven", "failed", "rejected", "stopped", "error"].map((state) => endType(state as never))).toEqual(["task.verified", "task.unproven", "task.failed", "task.failed", "task.stopped", "task.failed"]);
    expect(tracker.left(T0, "timeout", EXIT.stillRunning)).toMatchObject({ type: "left", reason: "timeout", exit: 21 });
  });
});

/** A node that answers what follow() asks from a script of how the task stands at each look. */
function scripted(looks: { task: Partial<TeamTask>; entries?: TeamTrailEntry[]; actions?: ReturnType<typeof action>[] }[]) {
  let look = 0;
  const asked: { name: RouteName; input: unknown }[] = [];
  const now = () => looks[Math.min(look, looks.length - 1)]!;
  const client: NodeClient = {
    label: "a scripted node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      // (A look reads the snapshot, then the trail: the trail is the last thing a look asks for.)
      if (name === "teamTrail") {
        const after = (input as { after: number }).after;
        const page = { entries: (now().entries ?? []).filter((entry) => entry.n > after), more: false };
        look += 1;
        return page as T;
      }
      if (name === "team") return snapshot([task(now().task)]) as T;
      if (name === "actions") return { actions: now().actions ?? [] } as T;
      return {} as T;
    },
    async *events(): AsyncGenerator<string> {
      // No live stream: the follower looks again by its timer.
    },
  };
  return { client, asked };
}

describe("following a task", () => {
  const lines = trail([...worked([1]), ...gated([0]), ...reviewed("pass")]);

  test("to its end: every update, the new lines in each, and the last one ended", async () => {
    const { client } = scripted([{ task: { status: "queued" } }, { task: { status: "running" }, entries: lines.slice(0, 5) }, { task: { status: "done", verified: true }, entries: lines }]);
    const fresh: number[] = [];
    const end = await follow(client, "task-a1b2c3d4e5f6", { pollMs: 1, onUpdate: (update) => void fresh.push(update.fresh.length) });
    expect(end.left).toBeUndefined();
    expect(end.last.task.status).toBe("done");
    expect(end.last.entries).toHaveLength(lines.length);
    expect(fresh).toEqual([0, 5, lines.length - 5]);
  });

  test("--no-ask: a task that comes to need you is stopped, its agent's waiting approvals declined, and it leaves as needing you", async () => {
    const { client, asked } = scripted([{ task: { status: "running" }, entries: lines.slice(0, 3) }, { task: { status: "running" }, entries: lines.slice(0, 3), actions: [action()] }]);
    const end = await follow(client, "task-a1b2c3d4e5f6", { pollMs: 1, noAsk: true, onUpdate: () => {} });
    expect(end.left).toBe("needs-you");
    expect(asked.filter((call) => call.name === "controlTeam" || call.name === "decideAction")).toEqual([
      { name: "controlTeam", input: { task: "task-a1b2c3d4e5f6", action: "stop" } },
      { name: "decideAction", input: { id: action().id, approve: false, note: "Declined by inv --no-ask: nobody waits for a person." } },
    ]);
    expect(needsYou(task({ status: "proposed" }), [])).toBe(true);
    expect(needsYou(task({ status: "running" }), [action({ by: "arm:team.0123456789.lin" })])).toBe(false);
  });

  test("its --timeout: it leaves when the time runs out, and never stops the task", async () => {
    let clock = T0;
    const { client, asked } = scripted([{ task: { status: "running" }, entries: lines.slice(0, 3) }]);
    const end = await follow(client, "task-a1b2c3d4e5f6", { pollMs: 1, deadline: T0 + 3, now: () => (clock += 1), onUpdate: () => {} });
    expect(end.left).toBe("timeout");
    expect(asked.some((call) => call.name === "controlTeam")).toBe(false);
  });

  test("Ctrl-C: it leaves, and never stops the task", async () => {
    const stop = new AbortController();
    const { client, asked } = scripted([{ task: { status: "running" }, entries: lines.slice(0, 3) }]);
    const end = await follow(client, "task-a1b2c3d4e5f6", { pollMs: 1, signal: stop.signal, onUpdate: () => stop.abort() });
    expect(end.left).toBe("interrupted");
    expect(asked.some((call) => call.name === "controlTeam")).toBe(false);
  });
});
