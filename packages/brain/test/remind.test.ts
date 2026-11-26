import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@galahad/core";
import { type QuestOptions, type QuestRole, REMIND_EVERY, runQuest } from "../src/quest.ts";

/*
 * Constraints said again (`remind`, a trial variant until it is measured): twenty turns in, the briefing that said what
 * the quest is and when it is done is far behind, and that is where a model forgets it. Every ten commands the goal,
 * the plan's "Done when:" and the gates are said again at the end, where they are read; the beginning, which a provider
 * caches, is never rewritten.
 */

const fence = "```";
const sh = (...commands: string[]) => `Next.\n${commands.map((c) => `${fence}sh\n${c}\n${fence}`).join("\n")}`;

function scripted(engineer: string[], options: Partial<QuestOptions>) {
  const queues: Record<QuestRole, string[]> = { planner: ["1. Make it.\n2. Test it.\nDone when: bun test passes with the new case."], engineer: [...engineer], reviewer: ["PASS\nIt holds."] };
  const seen: ChatMessage[][] = [];
  const run = runQuest(
    { goal: "Add a case for empty input to the parser", environment: "a test sandbox", gates: ["bun test parser.test.ts"], ...options },
    {
      ask: async (role, messages) => {
        if (role === "engineer") seen.push(messages);
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, truncated: false }),
      sleep: async () => {},
    },
  );
  /** What he was told after each of his turns, in order. */
  const told = () => seen.slice(1).map((messages) => messages.at(-1)!.content);
  return { run, told };
}

const REMINDER = "(Still your quest: Add a case for empty input to the parser\nDone when: bun test passes with the new case.\nGate: $ bun test parser.test.ts)";

describe("constraints said again", () => {
  test("every ten commands, the goal, the plan's Done when and the gates, at the end of what he is told", async () => {
    const q = scripted([...Array.from({ length: 21 }, (_, i) => sh(`echo ${i + 1}`)), "DONE\nDone."], { remind: true, maxSteps: 30 });
    expect((await q.run).status).toBe("done");
    const told = q.told();
    const reminded = told.flatMap((text, i) => (text.includes("(Still your quest:") ? [i + 1] : []));
    expect(reminded).toEqual([REMIND_EVERY, REMIND_EVERY * 2]);
    expect(told[REMIND_EVERY - 1]).toEndWith(`\n\n${REMINDER}`);
  });

  test("a parallel batch that passes a tenth command says it once", async () => {
    const q = scripted([sh("echo 1", "echo 2", "echo 3"), sh("echo 4", "echo 5", "echo 6"), sh("echo 7", "echo 8", "echo 9"), sh("echo 10", "echo 11", "echo 12"), sh("echo 13"), "DONE\nDone."], { remind: true, parallelCommands: 3 });
    await q.run;
    expect(q.told().map((text) => text.includes("(Still your quest:"))).toEqual([false, false, false, true, false]);
  });

  test("off (as every quest is unless a trial's variant says so): never said", async () => {
    const q = scripted([...Array.from({ length: 12 }, (_, i) => sh(`echo ${i + 1}`)), "DONE\nDone."], {});
    await q.run;
    expect(q.told().some((text) => text.includes("Still your quest"))).toBe(false);
  });
});
