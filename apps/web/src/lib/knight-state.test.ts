import { describe, expect, test } from "bun:test";
import { besideChip, galahadState, type KnightState, STATES, withState } from "./knight-state.ts";
import { galahadNow } from "./now.ts";

describe("a knight's state in a word and a colour", () => {
  test("every state the ring colours is said in words too; one at rest says nothing more than its line", () => {
    for (const [state, look] of Object.entries(STATES) as [KnightState, (typeof STATES)[KnightState]][]) {
      expect([state, look.words === null]).toEqual([state, state === "resting"]);
      if (state !== "resting") expect([state, look.words!.length > 0]).toEqual([state, true]);
    }
    // Blue while it works, amber when it waits on you, red for a failure, green for a pass or for what is new to you,
    // grey otherwise.
    expect(Object.fromEntries(Object.entries(STATES).map(([state, look]) => [state, look.tone]))).toEqual({ working: "work", needs: "needs", failed: "failed", paused: "neutral", queued: "neutral", verified: "ok", unread: "ok", resting: "neutral" });
  });

  test("Galahad's, from his line: what waits on you first, then work in hand or an answer he is writing, then rest", () => {
    expect(galahadState(galahadNow({ turns: [], quests: [], needs: 0 }))).toBe("resting");
    expect(galahadState(galahadNow({ turns: [], quests: [], needs: null }))).toBe("resting");
    expect(galahadState(galahadNow({ step: "Thinking with stand-in/planner", turns: [], quests: [], needs: 0 }))).toBe("working");
    expect(galahadState(galahadNow({ turns: [{ title: "Release plan" }], quests: [], needs: 0 }))).toBe("working");
    expect(galahadState(galahadNow({ turns: [], quests: [{ goal: "Make sync resume" }], needs: 2 }))).toBe("needs");
    expect(galahadState(galahadNow({ turns: [], quests: [], needs: 1 }))).toBe("needs");
    // An answer of his you haven't read: green, until what waits on you or work in hand comes first.
    expect(galahadState(galahadNow({ turns: [], quests: [], needs: 0, unread: [{ title: "Release plan" }] }))).toBe("unread");
    expect(galahadState(galahadNow({ turns: [], quests: [], needs: 1, unread: [{ title: "Release plan" }] }))).toBe("needs");
    expect(galahadState(galahadNow({ turns: [{ title: "Another" }], quests: [], needs: 0, unread: [{ title: "Release plan" }] }))).toBe("working");
  });

  test("beside its chip a line doesn't say the chip's word again; where no chip is shown it keeps it", () => {
    expect(besideChip("Failed: “Migrations run on a fresh database” · gave-up", "failed")).toBe("“Migrations run on a fresh database” · gave-up");
    expect(besideChip("Paused · 2 waiting", "paused")).toBe("2 waiting");
    expect(besideChip("Paused", "paused")).toBe("");
    expect(besideChip("Queued: “Ship it”", "queued")).toBe("“Ship it”");
    expect(besideChip("Verified: “Ship it” · 3 files kept", "verified")).toBe("“Ship it” · 3 files kept");
    // What doesn't begin with the chip's words stays as it is: another state's line, or words that only start alike.
    expect(besideChip("Interrupted: “Ship it” · review it before resuming", "needs")).toBe("Interrupted: “Ship it” · review it before resuming");
    expect(besideChip("Working on “Ship it”", "working")).toBe("Working on “Ship it”");
    expect(besideChip("Pausedness", "paused")).toBe("Pausedness");
    expect(besideChip("Verified: “Ship it”", "resting")).toBe("Verified: “Ship it”");
    expect(besideChip("Paused", undefined)).toBe("Paused");
  });

  test("a knight is named with its state for a screen reader, and alone at rest", () => {
    expect(withState("Ada", "working")).toBe("Ada, working");
    expect(withState("Ada", "needs")).toBe("Ada, needs you");
    expect(withState("Ada", "resting")).toBe("Ada");
  });
});
