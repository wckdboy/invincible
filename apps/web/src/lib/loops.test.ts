import { describe, expect, test } from "bun:test";
import { describeTask } from "./loops.ts";

// A loop's task in words, as its card on Loops and a loop it drafted in Needs you say it (the iPhone says the same,
// held to it by the vectors' `loops`).
describe("a loop's task in words", () => {
  test("a heartbeat: what it checks, and whether it fixes what's safe itself", () => {
    expect(describeTask({ kind: "heartbeat" })).toBe("Heartbeat: checks the fleet and the machine it runs on. Then fixes what's safe itself.");
    expect(describeTask({ kind: "heartbeat", checklist: "Disk under 90 %", selfAction: false })).toBe("Heartbeat: checks the fleet, then reads your checklist. Only reports: self-action is off.");
  });

  test("a run: its network, its goal and what proves it", () => {
    expect(describeTask({ kind: "run", network: "isolated", goal: "Tidy the logs" })).toBe("Run, isolated: Tidy the logs");
    expect(describeTask({ kind: "run", network: "online", goal: "Check the release", gates: ["bun test"] })).toBe("Run, online: Check the release Done means this passes: bun test");
    expect(describeTask({ kind: "run", network: "gateway", goal: "x".repeat(200), gates: ["a", "b"] })).toBe(`Run, gateway: ${"x".repeat(159)}… Done means these 2 pass: a · b`);
  });

  test("a call: its tool and its arguments, by name, so every app says them in one order", () => {
    expect(describeTask({ kind: "call", connector: "gmail", tool: "send", args: { to: "ada@example.test", subject: "Hi", count: 2, urgent: false } })).toBe("Calls gmail.send count=2 subject=Hi to=ada@example.test urgent=false");
    expect(describeTask({ kind: "call", connector: "github", tool: "comment" })).toBe("Calls github.comment");
  });

  test("a tell: its words, or what woke it; a task this node can't read", () => {
    expect(describeTask({ kind: "tell", text: "Stand up" })).toBe("Tells you: Stand up: a notice in Needs you, and your loop's name on your phone.");
    expect(describeTask({ kind: "tell" })).toBe("Tells you, with what woke it: a notice in Needs you, and your loop's name on your phone.");
    expect(describeTask(null)).toBe("A task this node can't read.");
  });
});
