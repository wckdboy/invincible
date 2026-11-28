import { describe, expect, test } from "bun:test";
import { SEAT_KINDS, SeatId, taskPlanFacts, taskRecordFacts, taskRoutingFacts, TeamTaskPlan, TeamTaskRecord, windowName } from "../src/index.ts";

/* What an agent's task came to, in words: the same at a terminal and in the app, from the record the runner kept. */

const spent = [
  { role: "engineer", model: "plan/m", calls: 9, unknown: 0, input: 90_000, output: 4000, cached: 70_000, reasoning: 1500 },
  { role: "reviewer", model: "plan/r", calls: 1, unknown: 0, input: 6000, output: 500, cached: 0, reasoning: 0 },
];
const prices = { "plan/m": { input: 1, output: 4, cached: 0.2 }, "plan/r": { input: 0.5, output: 2 } };

describe("a task's record, in words", () => {
  test("its time, its commands and how often it was sent back, its tokens, and money where every model that answered has a price", () => {
    const record = TeamTaskRecord.parse({ startedAt: 0, endedAt: 724_000, ended: "done", commands: 8, revisions: 1, spent });
    expect(taskRecordFacts(record, prices)).toEqual(["12m04s", "8 commands, sent back once", "101k tokens", "$0.05"]);
    // A price missing for one model: its money isn't guessed.
    expect(taskRecordFacts(record, { "plan/m": prices["plan/m"] }).at(-1)).toBe("no price");
  });

  test("an ending that isn't done comes first; a provider that reported nothing is said as that; no model call, no money", () => {
    expect(taskRecordFacts({ startedAt: 1000, endedAt: 60_000, ended: "unverified", commands: 1, revisions: 2, spent: [{ ...spent[1]!, unknown: 1, input: 0, output: 0 }] }, prices)).toEqual(["ended unverified", "59s", "1 command, sent back 2 times", "tokens unknown"]);
    // One call of ten unreported: what was counted is a lower bound, and says so.
    const partly = [{ ...spent[0]!, unknown: 1 }];
    expect(taskRecordFacts({ startedAt: 0, endedAt: 1000, ended: "done", commands: 1, revisions: 0, spent: partly }, prices).slice(-2)).toEqual(["94.0k+ tokens", "at least $0.05"]);
    // Under a second, nothing of its time: never "0s" (the honesty the iPhone and the web keep, I9 and I11).
    expect(taskRecordFacts({ startedAt: 0, endedAt: 0, ended: "stopped", commands: 0, revisions: 0, spent: [] }, prices)).toEqual(["ended stopped", "0 commands", "no model calls"]);
    expect(taskRecordFacts({ startedAt: 0, endedAt: 999, ended: "stopped", commands: 0, revisions: 0, spent: [] }, prices)[1]).toBe("0 commands");
    expect(taskRecordFacts({ startedAt: 0, endedAt: 1000, ended: "stopped", commands: 0, revisions: 0, spent: [] }, prices)[1]).toBe("1s");
  });

  test("the plan its coding tool ran on, after the rest: whose, the share of each window it took, and what it would have cost, covered by the plan", () => {
    const plan = { seat: `st_${"s".repeat(22)}`, kind: "claude-subscription" as const, windows: [{ window: "five_hour", share: 7 }, { window: "seven_day", share: 1 }], usd: 0.00144, sessionUsd: 0.00144 };
    const record = { startedAt: 0, endedAt: 724_000, ended: "done", commands: 8, revisions: 1, spent, plan };
    expect(taskRecordFacts(record, prices).slice(-2)).toEqual(["on your Claude plan, 7% of its five hours and 1% of its week", "≈$0.0014 at API prices, covered by the plan"]);
    // A window it took nothing of is left out; no window said, the plan alone; no cost said, none guessed.
    expect(taskPlanFacts({ ...plan, windows: [{ window: "five_hour", share: 0 }], usd: null })).toEqual(["on your Claude plan"]);
    // Its VM's own sign-in, not a seat of yours: said as that.
    expect(taskPlanFacts({ ...plan, seat: null, kind: "chatgpt-codex", windows: [], usd: 2.8 })).toEqual(["on its own ChatGPT sign-in", "≈$2.80 at API prices, covered by the plan"]);
    // A Gemini plan, Antigravity's: on your seat, or on its VM's own Google sign-in.
    expect(taskPlanFacts({ ...plan, kind: "google-antigravity", windows: [], usd: null })).toEqual(["on your Gemini plan"]);
    expect(taskPlanFacts({ ...plan, seat: null, kind: "google-antigravity", windows: [], usd: null })).toEqual(["on its own Google sign-in"]);
    // A record without a plan says nothing of one.
    expect(taskRecordFacts({ startedAt: 0, endedAt: 724_000, ended: "done", commands: 8, revisions: 1, spent }, prices)).toHaveLength(4);
  });

  test("a plan's window, named as its length", () => {
    expect(["five_hour", "seven_day", "seven_day_opus", "minutes_60", "minutes_1440", "minutes_90", "plan", "overage_window"].map(windowName)).toEqual(["five hours", "week", "week (Opus)", "1 hour", "1 day", "90 minutes", "plan", "overage window"]);
  });

  test("an ending is said in words, never as the record's token", () => {
    expect(taskRecordFacts({ startedAt: 0, endedAt: 5000, ended: "gave-up", commands: 2, revisions: 0, spent: [] }, prices)[0]).toBe("gave up");
  });

  test("a record may say the plan its coding tool ran on: a seat (or its VM's own sign-in), each window's share, what it would have cost", () => {
    const base = { startedAt: 0, endedAt: 1, ended: "done", commands: 0, revisions: 0, spent: [] };
    const plan = { seat: `st_${"s".repeat(22)}`, kind: "claude-subscription", windows: [{ window: "five_hour", share: 7 }], usd: 0.00144, sessionUsd: 0.00144 };
    expect(TeamTaskRecord.safeParse({ ...base, plan }).success).toBe(true);
    expect(TeamTaskRecord.safeParse({ ...base, plan: { ...plan, seat: null, usd: null, sessionUsd: undefined } }).success).toBe(true);
    for (const bad of [{ ...plan, seat: "st_x" }, { ...plan, kind: "gemini" }, { ...plan, windows: [{ window: "five_hour", share: 101 }] }, { ...plan, windows: [{ window: "Five Hours", share: 1 }] }, { ...plan, usd: -1 }, { ...plan, account: "fp_x" }]) {
      expect(TeamTaskRecord.safeParse({ ...base, plan: bad }).success).toBe(false);
    }
    // Its seat's id and its kinds are seats.ts's, said again where team.ts can't import them: held equal here.
    expect([...TeamTaskPlan.shape.kind.options]).toEqual([...SEAT_KINDS]);
    for (const id of [`st_${"a".repeat(22)}`, "st_short", `st_${"a".repeat(23)}`, `ST_${"a".repeat(22)}`]) expect(TeamTaskPlan.shape.seat.safeParse(id).success).toBe(SeatId.safeParse(id).success);
  });

  test("a record is counts and times and nothing else: a field too many is refused", () => {
    expect(TeamTaskRecord.safeParse({ startedAt: 0, endedAt: 1, ended: "done", commands: 0, revisions: 0, spent: [], prompt: "words" }).success).toBe(false);
    expect(TeamTaskRecord.safeParse({ startedAt: 0, endedAt: 1, ended: "finished", commands: 0, revisions: 0, spent: [] }).success).toBe(false);
  });

  test("whose models did its work: kept with its record, said where the planner's did some of it, and nothing else taken", () => {
    const base = { startedAt: 0, endedAt: 1000, ended: "done", commands: 3, revisions: 2, spent };
    const moved = TeamTaskRecord.parse({ ...base, routing: { began: "engineer", moved: "review" } });
    expect(taskRecordFacts(moved, prices).at(-1)).toBe("moved up to the planner's models: the reviewer sent it back twice");
    const remembered = TeamTaskRecord.parse({ ...base, routing: { began: "planner", because: "memory" } });
    expect(taskRecordFacts(remembered, prices).at(-1)).toBe("began on the planner's models: its agent's last tasks needed them");
    expect(taskRoutingFacts({ began: "planner", because: "plan" })).toEqual(["began on the planner's models: its plan asked for them"]);
    expect(taskRoutingFacts({ began: "engineer", moved: "rereads" })).toEqual(["moved up to the planner's models: it read the same files again and again"]);
    // The engineer's alone: no fact of it.
    expect(taskRoutingFacts({ began: "engineer" })).toEqual([]);
    // With its kind (routing.ts), the memory names it; and a try of the engineer's after the planner's is said.
    expect(taskRoutingFacts({ began: "planner", because: "memory", kind: "fix" })).toEqual(["began on the planner's models: its agent's last fix was verified there"]);
    expect(taskRoutingFacts({ began: "engineer", because: "probe", kind: "desktop" })).toEqual(["began on the engineer's models: a try of them after its desktop tasks began on the planner's"]);
    expect(taskRoutingFacts({ began: "engineer", because: "probe", kind: "code", moved: "gate" })).toEqual(["began on the engineer's models: a try of them after its code tasks began on the planner's", "moved up to the planner's models: the same gate failed twice"]);
    // Gone round on both tiers (run.ts round): said after its moving up, as it came.
    expect(taskRoutingFacts({ began: "engineer", moved: "rereads", round: true, kind: "code" })).toEqual(["moved up to the planner's models: it read the same files again and again", "went round on the planner's models too: you were told"]);
    for (const routing of [{ began: "reviewer" }, { began: "engineer", moved: "boredom" }, { began: "planner", because: "a hunch" }, { began: "engineer", why: "x" }]) {
      expect([routing, TeamTaskRecord.safeParse({ ...base, routing }).success]).toEqual([routing, false]);
    }
  });
});
