import { describe, expect, test } from "bun:test";
import { galahadNow, needsYou } from "./now.ts";

const quest = (goal: string) => ({ goal });
const turn = (title: string | null = null) => ({ title });

describe("what Galahad is doing now, in a line", () => {
  test("idle, and nothing is said of your Inbox until it has been asked", () => {
    expect(galahadNow({ turns: [], quests: [], needs: null })).toEqual({ text: "Idle", expression: "idle", tone: "neutral" });
    expect(galahadNow({ turns: [], quests: [], needs: 0 })).toEqual({ text: "Idle · nothing needs you", expression: "idle", tone: "neutral" });
  });

  test("something needs you: he asks for you, and says how much", () => {
    expect(galahadNow({ turns: [], quests: [], needs: 1 })).toEqual({ text: "1 thing needs you", expression: "asking", tone: "warn" });
    expect(galahadNow({ turns: [], quests: [], needs: 3 }).text).toBe("3 things need you");
    expect([needsYou(1), needsYou(2)]).toEqual(["1 thing needs you", "2 things need you"]);
  });

  test("writing an answer in the chat on screen: the step he's at, whatever else is in hand", () => {
    expect(galahadNow({ step: "Thinking with anthropic/claude-opus-5-5", turns: [turn("Release"), turn("Another")], quests: [quest("a")], needs: 0 })).toEqual({ text: "Thinking with anthropic/claude-opus-5-5", expression: "thinking", tone: "accent" });
    // The node hasn't said what he's at yet.
    expect(galahadNow({ step: null, turns: [], quests: [], needs: null })).toEqual({ text: "Starting", expression: "thinking", tone: "accent" });
  });

  test("working elsewhere: one thing is named, several are counted", () => {
    expect(galahadNow({ turns: [turn("Release plan")], quests: [], needs: 0 })).toEqual({ text: "Working in “Release plan”", expression: "working", tone: "accent" });
    expect(galahadNow({ turns: [turn()], quests: [], needs: 0 }).text).toBe("Working in a temporary chat");
    expect(galahadNow({ turns: [], quests: [quest("Make sync resume after a dropped connection\nand prove it")], needs: 0 }).text).toBe("Working on: Make sync resume after a dropped connection");
    expect(galahadNow({ turns: [turn("Release plan")], quests: [quest("a"), quest("b")], needs: 0 })).toEqual({ text: "Working on 3 things", expression: "working", tone: "accent" });
  });

  test("what needs you is said after the work (a narrow screen cuts the line's end; the Inbox's badge still counts it), and marks the line", () => {
    expect(galahadNow({ turns: [], quests: [quest("Ship it")], needs: 2 })).toEqual({ text: "Working on: Ship it · 2 things need you", expression: "working", tone: "warn" });
    expect(galahadNow({ step: "Answering", turns: [], quests: [], needs: 1 })).toEqual({ text: "Answering · 1 thing needs you", expression: "thinking", tone: "warn" });
  });

  test("an answer he finished that you haven't read: named, or counted, when nothing else is going on", () => {
    expect(galahadNow({ turns: [], quests: [], needs: 0, unread: [{ title: "Release plan" }] })).toEqual({ text: "New answer in “Release plan”", expression: "idle", tone: "ok" });
    expect(galahadNow({ turns: [], quests: [], needs: null, unread: [{ title: "A" }, { title: "B" }] }).text).toBe("2 new answers");
    expect(galahadNow({ turns: [], quests: [], needs: 0, unread: [] })).toEqual({ text: "Idle · nothing needs you", expression: "idle", tone: "neutral" });
    // What needs you, and work in hand, come first.
    expect(galahadNow({ turns: [], quests: [], needs: 1, unread: [{ title: "A" }] })).toEqual({ text: "1 thing needs you", expression: "asking", tone: "warn" });
    expect(galahadNow({ turns: [turn("Release plan")], quests: [], needs: 0, unread: [{ title: "A" }] }).tone).toBe("accent");
  });
});
