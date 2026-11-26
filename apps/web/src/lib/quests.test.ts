import { describe, expect, test } from "bun:test";
import { MAX_QUEST_GATES, QuestGates } from "@galahad/core";
import { gateOwner, gateResult, gatesFromText, MAX_GATE_LENGTH, MAX_GATES } from "./quests.ts";

describe("gates typed into the app", () => {
  test("one command a line, blank lines dropped, each as typed (trimmed)", () => {
    expect(gatesFromText("bun test\n\n  test -s /work/out/report.md  \n")).toEqual({ gates: ["bun test", "test -s /work/out/report.md"] });
    expect(gatesFromText("")).toEqual({ gates: [] });
  });

  test("the app's limits are the contract's", () => {
    expect(MAX_GATES).toBe(MAX_QUEST_GATES);
    expect(QuestGates.safeParse(["x".repeat(MAX_GATE_LENGTH)]).success).toBe(true);
    expect(QuestGates.safeParse(["x".repeat(MAX_GATE_LENGTH + 1)]).success).toBe(false);
    const many = Array.from({ length: MAX_GATES + 1 }, (_, i) => `check ${i}`).join("\n");
    expect(gatesFromText(many)).toEqual({ problem: "A quest takes at most 8 gates (this is 9)." });
    expect(gatesFromText(`ok\n${"x".repeat(MAX_GATE_LENGTH + 1)}`)).toMatchObject({ problem: expect.stringContaining("Gate 2 is longer") });
    // What the field accepts, the contract accepts.
    const typed = gatesFromText("bun test\ngrep -q hi a.txt");
    expect("gates" in typed && QuestGates.parse(typed.gates)).toEqual(["bun test", "grep -q hi a.txt"]);
  });

  test("a gate's result and whose it is, in words", () => {
    expect(gateResult(null)).toEqual({ text: "not run yet", tone: "neutral" });
    expect(gateResult(0)).toEqual({ text: "passed", tone: "ok" });
    expect(gateResult(2)).toEqual({ text: "failed (exit 2)", tone: "danger" });
    expect(gateOwner("owner")).toBe("yours");
    expect(gateOwner("planner")).toBe("proposed by the planner");
  });
});

describe("a quest in hand, as the app shows it", () => {
  test("its state as a badge: only a reviewed quest is green, and a silent runner is said", async () => {
    const { questBadge, questInHand, questWhere } = await import("./quests.ts");
    const { QUEST_STATES, questInHand: contractInHand } = await import("@galahad/core");
    // The app's states are the contract's, each with words.
    for (const state of QUEST_STATES) {
      expect(questBadge(state).text.length).toBeGreaterThan(0);
      expect(questInHand(state)).toBe(contractInHand(state));
    }
    expect(questBadge("working")).toEqual({ text: "Working", tone: "accent", live: true });
    expect(questBadge("gating")).toEqual({ text: "Running its gates", tone: "accent", live: true });
    expect(questBadge("done")).toEqual({ text: "Done, reviewed", tone: "ok", live: false });
    expect(questBadge("unverified").tone).toBe("warn");
    expect(questBadge("failed").tone).toBe("danger");
    expect(questBadge("working", true)).toEqual({ text: "No word from its runner", tone: "warn", live: false });
    expect(questBadge("done", true).text).toBe("Done, reviewed");
    expect(questWhere({ step: 3, maxSteps: 30, revisions: 0 })).toBe("command 3 of 30");
    expect(questWhere({ step: 3, maxSteps: 30, revisions: 1, attempt: { index: 2, attempts: 3 } })).toBe("attempt 2 of 3 · command 3 of 30 · sent back once");
    expect(questWhere({ step: 9, maxSteps: 30, revisions: 2 })).toBe("command 9 of 30 · sent back 2 times");
  });
});
