import { describe, expect, test } from "bun:test";
import { readActivityState } from "@invincible/core";
import type { TeamTask, TeamTrailEntry } from "@invincible/core/team";
import { activityLine, activityOf, activityOthers, activityShort } from "./live-activity.ts";

const T0 = 1_795_700_000_000;
const trail = (...texts: string[]): TeamTrailEntry[] => texts.map((text, i) => ({ n: i + 1, at: T0 + i * 10_000, text }));
const GATES = ["bun test packages/link", "bun run typecheck"];
type Task = Pick<TeamTask, "status" | "verified" | "record" | "error" | "gates">;
const task = (status: TeamTask["status"], over: Partial<Task> = {}): Task => ({ status, verified: false, record: undefined, error: null, gates: GATES, ...over });
const before = "Gates before the work · 1. exit 1 · bun test packages/link\n2. exit 0 · bun run typecheck";

describe("a task on its Live Activity: what the node tells Apple, and the app tells itself", () => {
  test("in hand: where it is, each gate as it stands, and nothing of its words", () => {
    const working = activityOf(task("running"), trail("Plan · go", before, "Running · bun test"), T0);
    expect(working).toEqual({ phase: "running", gates: ["waiting", "waiting"], review: "waits", verdict: null, gate: null, others: 0, at: T0 });
    expect(activityLine(working)).toBe("Working");
    expect(activityShort(working)).toBe("0/2");
    const gating = activityOf(task("running"), trail(before, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link\n14 pass"), T0);
    expect(gating).toMatchObject({ phase: "running", gates: ["passed", "running"], review: "waits" });
    expect(activityLine(gating)).toBe("Gate 2 of 2");
    expect(activityShort(gating)).toBe("1/2");
  });

  test("its gates passed: the reviewer is reading it", () => {
    const reading = activityOf(task("running"), trail(before, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck"), T0);
    expect(reading).toMatchObject({ phase: "review", gates: ["passed", "passed"], review: "reading", verdict: null });
    expect(activityLine(reading)).toBe("The reviewer is reading it");
    expect(activityShort(reading)).toBe("Review");
  });

  test("ended: the verdict its proof allows, and the gate that failed", () => {
    const proven = activityOf(task("done", { verified: true }), trail(before, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck", "Review · pass\nMatches the brief."), T0);
    expect(proven).toEqual({ phase: "ended", gates: ["passed", "passed"], review: "passed", verdict: "proven", gate: null, others: 0, at: T0 });
    expect(activityLine(proven)).toBe("Proven");
    expect(activityShort(proven)).toBe("Proven");
    const failed = activityOf(task("failed", { error: "unverified" }), trail(before, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 1 · bun run typecheck"), T0);
    expect(failed).toMatchObject({ phase: "ended", gates: ["passed", "failed"], verdict: "failed", gate: 2 });
    expect(activityLine(failed)).toBe("Failed · gate 2");
    expect(activityShort(failed)).toBe("Failed");
    const reviewed = activityOf(task("done", { verified: true }), trail("Gates before the work · 1. exit 0 · bun test packages/link\n2. exit 0 · bun run typecheck", "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck", "Review · pass\nok"), T0);
    expect(reviewed).toMatchObject({ verdict: "reviewed" });
    expect(activityLine(reviewed)).toBe("Reviewed, not proven");
    const gaveUp = activityOf(task("failed", { error: "gave-up" }), trail("Plan · go"), T0);
    expect(gaveUp).toMatchObject({ phase: "ended", verdict: "gave-up", gate: null, gates: ["waiting", "waiting"] });
    expect(activityLine(gaveUp)).toBe("Gave up");
    expect(activityLine(activityOf(task("stopped"), trail("Plan · go"), T0))).toBe("Stopped");
  });

  test("queued and cut short say so", () => {
    expect(activityLine(activityOf(task("queued"), [], T0))).toBe("Queued");
    expect(activityOf(task("interrupted"), trail("Plan · go"), T0)).toMatchObject({ phase: "interrupted", verdict: null });
    expect(activityLine(activityOf(task("interrupted"), trail("Plan · go"), T0))).toBe("Interrupted: it needs you");
  });

  test("whatever it says reads back strictly, as the node checks it before Apple sees it", () => {
    for (const state of [
      activityOf(task("running"), trail(before), T0),
      activityOf(task("failed", { error: "unverified" }), trail(before, "Submitted for review · done", "Gate 1/2 · exit 1 · bun test packages/link"), T0),
      activityOf(task("done", { verified: true }), [], T0),
      activityOf(task("queued", { gates: Array.from({ length: 20 }, (_, i) => `test ${i}`) }), [], T0),
    ]) expect(readActivityState(state)).toEqual(state);
  });
});

describe("the team on its one Live Activity: how many others are at work besides the task it shows", () => {
  test("a count, said as the roster says the work (at work, or queued); none, nothing said", () => {
    const working = activityOf(task("running"), trail("Plan · go"), T0, 2);
    expect(working.others).toBe(2);
    expect(activityOthers(working)).toBe("2 more at work");
    expect(activityOthers({ ...working, others: 1 })).toBe("1 more at work");
    expect(activityOthers({ ...working, others: 0 })).toBe("");
    // (At most what the node may say of it.)
    expect(activityOf(task("running"), [], T0, 5_000).others).toBe(999);
    expect(readActivityState(working)).toEqual(working);
  });
});
