import { describe, expect, test } from "bun:test";
import { findSecrets, QuestProgressInput } from "@galahad/core";
import { questStanding, standingAfter } from "../src/quest-progress.ts";
import { type QuestEvent, runQuest } from "../src/quest.ts";

const sh = (command: string, thought = "Next step.") => `${thought}\n\`\`\`sh\n${command}\n\`\`\``;

/** A real quest (scripted models, a scripted sandbox), and where it stood after each event. */
async function follow(script: { engineer: string[]; reviewer?: string[]; gates?: string[]; exec?: (command: string, nth: number) => { exitCode?: number; stdout?: string } }) {
  const replies = { planner: ["1. Write it.\n2. Check it.\nDone when: a.txt says hi."], engineer: [...script.engineer], reviewer: [...(script.reviewer ?? ["PASS"])] };
  const runs = new Map<string, number>();
  let standing = questStanding(30);
  const seen: { event: QuestEvent["type"]; state: string; step: number; doing: string }[] = [];
  const outcome = await runQuest(
    { goal: "say hi", environment: "a test sandbox", ...(script.gates ? { gates: script.gates } : {}) },
    {
      ask: async (role) => ({ text: replies[role].shift()!, model: `test/${role}` }),
      exec: async (command) => {
        const nth = (runs.get(command) ?? 0) + 1;
        runs.set(command, nth);
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, truncated: false, ...script.exec?.(command, nth) };
      },
      emit: (event) => {
        standing = standingAfter(standing, event);
        seen.push({ event: event.type, state: standing.state, step: standing.step, doing: standing.doing });
      },
    },
  );
  return { outcome, standing, seen };
}

describe("where a quest stands, from its events", () => {
  test("planning, then the step he's on, then under review, then how it ended", async () => {
    const { standing, seen, outcome } = await follow({ engineer: [sh("echo hi > a.txt", "Writing it."), sh("cat a.txt"), "DONE\nWrote a.txt; it says hi."] });
    expect(questStanding(30)).toMatchObject({ state: "planning", step: 0, maxSteps: 30, doing: "Planning" });
    expect(seen.map((s) => [s.event, s.state, s.step])).toEqual([
      ["plan", "working", 0],
      ["thought", "working", 1],
      ["command", "working", 1],
      ["observation", "working", 1],
      ["thought", "working", 2],
      ["command", "working", 2],
      ["observation", "working", 2],
      ["submitted", "reviewing", 2],
      ["review", "reviewing", 2],
      ["finished", "done", 2],
    ]);
    expect(seen[2]!.doing).toBe("$ echo hi > a.txt");
    expect(standing).toMatchObject({ state: "done", plan: outcome.plan, step: 2, revisions: 0, gates: [], summary: "Wrote a.txt; it says hi.", doing: "" });
  });

  test("gates: listed before they run, each with its last result; a failed run sends the work back", async () => {
    const { standing, seen } = await follow({
      engineer: ["DONE\nall good", sh("echo hi > a.txt"), "DONE\nnow it says hi"],
      gates: ["grep -q hi a.txt"],
      exec: (command, nth) => (command === "grep -q hi a.txt" && nth === 1 ? { exitCode: 1, stdout: "no match\n" } : {}),
    });
    const states = seen.map((s) => [s.event, s.state]);
    expect(states.slice(0, 6)).toEqual([
      ["plan", "working"],
      ["gates", "working"],
      ["submitted", "gating"],
      ["gate", "gating"],
      ["gated", "working"],
      ["thought", "working"],
    ]);
    expect(seen[4]!.doing).toBe("Sent back: 1 of 1 gate(s) failed");
    expect(states.slice(-5)).toEqual([
      ["submitted", "gating"],
      ["gate", "gating"],
      ["gated", "reviewing"],
      ["review", "reviewing"],
      ["finished", "done"],
    ]);
    expect(standing.revisions).toBe(1);
    expect(standing.gates).toEqual([{ command: "grep -q hi a.txt", by: "owner", exitCode: 0, excerpt: "ok" }]);
  });

  test("a quest whose gates never pass ends unverified, with the gate's failure on show", async () => {
    const { standing } = await follow({ engineer: ["DONE\na", "DONE\nb", "DONE\nc"], gates: ["false"], exec: (command) => (command === "false" ? { exitCode: 1, stdout: "" } : {}) });
    expect(standing).toMatchObject({ state: "unverified", revisions: 2, gates: [{ command: "false", by: "owner", exitCode: 1 }] });
  });

  test("every standing fits the contract, and nothing secret-shaped is in one", async () => {
    const FAKE_KEY = `sk-ant-api03-${"FAKE".repeat(8)}`;
    let standing = questStanding(30);
    const events: QuestEvent[] = [
      { type: "plan", text: `1. Use ${FAKE_KEY}\nDone when: done.`, model: "m" },
      { type: "gates", gates: [{ command: "bun test", by: "owner" }] },
      { type: "thought", step: 1, text: `I will use ${FAKE_KEY}`, model: "m" },
      { type: "command", step: 1, command: `curl -H 'x-api-key: ${FAKE_KEY}' http://x\necho more` },
      { type: "retry", role: "engineer", attempt: 1, error: "down", waitMs: 15_000 },
      { type: "finished", outcome: { status: "gave-up", summary: `It needs ${FAKE_KEY}.`, steps: 1, revisions: 0, plan: "p" } },
    ];
    for (const event of events) {
      standing = standingAfter(standing, event);
      expect(findSecrets(JSON.stringify(standing))).toEqual([]);
      expect(QuestProgressInput.safeParse({ quest: "q-1", goal: "g", state: standing.state, plan: standing.plan, step: standing.step, maxSteps: standing.maxSteps, doing: standing.doing, revisions: standing.revisions, gates: standing.gates, summary: standing.summary }).success).toBe(true);
    }
    expect(standing.state).toBe("gave-up");
  });

  test("a model passed over is what he is doing until the next thing happens: which one, and who answers instead", () => {
    const standing = standingAfter(questStanding(30), { type: "skipped", role: "engineer", model: "plan/first", error: "400 MissingSessionID", answered: "router/second" });
    expect(standing.doing).toBe("plan/first couldn't answer as engineer: router/second answers instead");
  });

  test("a quest that escalated says so where every device shows it: the work moved, and to whose models", () => {
    const standing = standingAfter({ ...questStanding(30), state: "working" }, { type: "escalated", to: "planner", gate: "bun test" });
    expect(standing).toMatchObject({ state: "working", doing: "The same gate failed twice in a row: the planner's models take the work" });
  });

  test("a command your tripwire stopped is what he is doing until the next thing happens: which rule, and what it did", () => {
    const working = { ...questStanding(30), state: "working" as const };
    const trip = { type: "tripped" as const, step: 4, command: "rm -f bun.lock\necho more", rule: "no-locks", why: "the word `bun.lock` matches `*.lock`" };
    expect(standingAfter(working, { ...trip, does: "refuse" })).toMatchObject({ state: "working", step: 4, doing: "Your tripwire no-locks refused: $ rm -f bun.lock" });
    expect(standingAfter(working, { ...trip, does: "halt" }).doing).toBe("Your tripwire no-locks halted it: $ rm -f bun.lock");
  });
});
