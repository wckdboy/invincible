import { describe, expect, test } from "bun:test";
import { ACTIVITY_GATES_MAX, ACTIVITY_LINGER_MS, type ActivityState, readActivityState } from "../src/live-activity.ts";
import { LiveActivityInput } from "../src/notify-input.ts";
import { routes } from "../src/api.ts";

/*
 * A task's proof on the iPhone's Lock Screen (I10): what the node may say to Apple of it is read strictly, fixed words
 * and counts only, and what the app hands the node for it is checked at the door.
 */
const running: ActivityState = { phase: "running", gates: ["passed", "running", "waiting"], review: null, verdict: null, gate: null, at: 1_795_700_000_000 };

describe("what a Live Activity may say, read strictly", () => {
  test("a state as the node makes it reads back as itself", () => {
    expect(readActivityState(running)).toEqual(running);
    const ended: ActivityState = { phase: "ended", gates: ["passed", "failed"], review: "passed", verdict: "failed", gate: 2, at: 1 };
    expect(readActivityState(ended)).toEqual(ended);
    const reviewing: ActivityState = { phase: "review", gates: ["passed"], review: "reading", verdict: null, gate: null, at: 1 };
    expect(readActivityState(reviewing)).toEqual(reviewing);
  });

  test("words of any other kind never pass: a title, a goal, an agent's words, a word outside the fixed ones", () => {
    expect(readActivityState({ ...running, title: "Fix the importer" })).toBeNull();
    expect(readActivityState({ ...running, said: "Verified." })).toBeNull();
    expect(readActivityState({ ...running, phase: "Working on it" })).toBeNull();
    expect(readActivityState({ ...running, gates: ["passed", "bun test"] })).toBeNull();
    expect(readActivityState({ ...running, review: "LGTM" })).toBeNull();
    expect(readActivityState({ ...running, verdict: "Verified" })).toBeNull();
  });

  test("counts are counts: a gate number within its gates, at most sixteen gates, a time", () => {
    expect(readActivityState({ ...running, gates: Array(ACTIVITY_GATES_MAX + 1).fill("waiting") })).toBeNull();
    expect(readActivityState({ phase: "ended", gates: ["failed"], review: null, verdict: "failed", gate: 2, at: 1 })).toBeNull();
    expect(readActivityState({ phase: "ended", gates: ["failed"], review: null, verdict: "failed", gate: 0, at: 1 })).toBeNull();
    expect(readActivityState({ phase: "ended", gates: ["failed"], review: null, verdict: "failed", gate: 1.5, at: 1 })).toBeNull();
    expect(readActivityState({ ...running, gate: 1 })).toBeNull();
    expect(readActivityState({ ...running, at: -1 })).toBeNull();
    expect(readActivityState({ ...running, at: "now" })).toBeNull();
    expect(readActivityState(null)).toBeNull();
    expect(readActivityState("running")).toBeNull();
  });

  test("an ended one has its verdict; one still in hand has none", () => {
    expect(readActivityState({ ...running, verdict: "proven" })).toBeNull();
    expect(readActivityState({ phase: "ended", gates: [], review: null, verdict: null, gate: null, at: 1 })).toBeNull();
  });

  test("an ended task's activity stays a quarter of an hour", () => {
    expect(ACTIVITY_LINGER_MS).toBe(15 * 60_000);
  });
});

describe("the app's activity, at the node's door", () => {
  const token = "ab".repeat(80);

  test("its task, its push token in hex, and which of Apple's services; or no token, to forget it", () => {
    expect(LiveActivityInput.parse({ task: "task-abcdefghijkl", token, environment: "development" })).toEqual({ task: "task-abcdefghijkl", token, environment: "development" });
    expect(LiveActivityInput.parse({ task: "task-abcdefghijkl", token: null, environment: "production" }).token).toBeNull();
  });

  test("anything else is refused", () => {
    expect(LiveActivityInput.safeParse({ task: "task-abcdefghijkl", token: "AB".repeat(80), environment: "development" }).success).toBe(false);
    expect(LiveActivityInput.safeParse({ task: "task-abcdefghijkl", token: "abc", environment: "development" }).success).toBe(false);
    expect(LiveActivityInput.safeParse({ task: "task-abcdefghijkl", token: `${token}a`, environment: "development" }).success).toBe(false);
    expect(LiveActivityInput.safeParse({ task: "not-a-task", token, environment: "development" }).success).toBe(false);
    expect(LiveActivityInput.safeParse({ task: "task-abcdefghijkl", token, environment: "sandbox" }).success).toBe(false);
    expect(LiveActivityInput.safeParse({ task: "task-abcdefghijkl", token, environment: "development", title: "Fix it" }).success).toBe(false);
  });

  test("one route, one scope: a paired device's own", () => {
    expect(routes.notifyActivity).toEqual({ method: "POST", path: "/api/notify/activity", scope: "mind:read", input: LiveActivityInput });
  });
});
