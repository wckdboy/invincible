import { describe, expect, test } from "bun:test";
import { primaryNow, needsFirst, needsYou } from "./now.ts";

const run = (goal: string) => ({ goal });
const turn = (title: string | null = null) => ({ title });

describe("what your agent is doing now, in a line", () => {
  test("idle, and nothing is said of your Inbox until it has been asked", () => {
    expect(primaryNow({ turns: [], runs: [], needs: null })).toEqual({ text: "Idle", expression: "idle", tone: "neutral" });
    expect(primaryNow({ turns: [], runs: [], needs: 0 })).toEqual({ text: "Idle · nothing needs you", expression: "idle", tone: "neutral" });
  });

  test("something needs you: it asks for you, and says how much", () => {
    expect(primaryNow({ turns: [], runs: [], needs: 1 })).toEqual({ text: "1 thing needs you", expression: "asking", tone: "warn" });
    expect(primaryNow({ turns: [], runs: [], needs: 3 }).text).toBe("3 things need you");
    expect([needsYou(1), needsYou(2)]).toEqual(["1 thing needs you", "2 things need you"]);
  });

  test("writing an answer in the chat on screen: the step it's at, whatever else is in hand", () => {
    expect(primaryNow({ step: "Thinking with anthropic/claude-opus-5-5", turns: [turn("Release"), turn("Another")], runs: [run("a")], needs: 0 })).toEqual({ text: "Thinking with anthropic/claude-opus-5-5", expression: "thinking", tone: "accent" });
    // The node hasn't said what it's at yet.
    expect(primaryNow({ step: null, turns: [], runs: [], needs: null })).toEqual({ text: "Starting", expression: "thinking", tone: "accent" });
  });

  test("working elsewhere: one thing is named, several are counted", () => {
    expect(primaryNow({ turns: [turn("Release plan")], runs: [], needs: 0 })).toEqual({ text: "Working in “Release plan”", expression: "working", tone: "accent" });
    expect(primaryNow({ turns: [turn()], runs: [], needs: 0 }).text).toBe("Working in a temporary chat");
    expect(primaryNow({ turns: [], runs: [run("Make sync resume after a dropped connection\nand prove it")], needs: 0 }).text).toBe("Working on: Make sync resume after a dropped connection");
    expect(primaryNow({ turns: [turn("Release plan")], runs: [run("a"), run("b")], needs: 0 })).toEqual({ text: "Working on 3 things", expression: "working", tone: "accent" });
  });

  test("as the PWA shows it, what needs you comes first when there is any: the line is amber, and its first words agree", () => {
    expect(needsFirst({ turns: [], runs: [run("Make sync resume after a dropped connection")], needs: 2 })).toEqual({ text: "2 things need you · Working on: Make sync resume after a dropped connection", expression: "working", tone: "warn" });
    expect(needsFirst({ step: "Answering", turns: [], runs: [], needs: 1 })).toEqual({ text: "1 thing needs you · Answering", expression: "thinking", tone: "warn" });
    // Otherwise as primaryNow says it, word for word.
    for (const input of [{ turns: [], runs: [], needs: 3 }, { turns: [turn("Release plan")], runs: [], needs: 0 }, { turns: [], runs: [], needs: null }, { turns: [], runs: [], needs: 0, unread: [{ title: "Release plan" }] }]) expect(needsFirst(input)).toEqual(primaryNow(input));
  });

  test("what needs you is said after the work (a narrow screen cuts the line's end; the Inbox's badge still counts it), and marks the line", () => {
    expect(primaryNow({ turns: [], runs: [run("Ship it")], needs: 2 })).toEqual({ text: "Working on: Ship it · 2 things need you", expression: "working", tone: "warn" });
    expect(primaryNow({ step: "Answering", turns: [], runs: [], needs: 1 })).toEqual({ text: "Answering · 1 thing needs you", expression: "thinking", tone: "warn" });
  });

  test("an answer it finished that you haven't read: named, or counted, when nothing else is going on", () => {
    expect(primaryNow({ turns: [], runs: [], needs: 0, unread: [{ title: "Release plan" }] })).toEqual({ text: "New answer in “Release plan”", expression: "idle", tone: "ok" });
    expect(primaryNow({ turns: [], runs: [], needs: null, unread: [{ title: "A" }, { title: "B" }] }).text).toBe("2 new answers");
    expect(primaryNow({ turns: [], runs: [], needs: 0, unread: [] })).toEqual({ text: "Idle · nothing needs you", expression: "idle", tone: "neutral" });
    // What needs you, and work in hand, come first.
    expect(primaryNow({ turns: [], runs: [], needs: 1, unread: [{ title: "A" }] })).toEqual({ text: "1 thing needs you", expression: "asking", tone: "warn" });
    expect(primaryNow({ turns: [turn("Release plan")], runs: [], needs: 0, unread: [{ title: "A" }] }).tone).toBe("accent");
  });
});
