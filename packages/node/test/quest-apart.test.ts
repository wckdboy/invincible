import { expect, test } from "bun:test";
import { runQuest, type QuestRole } from "@galahad/brain";

const sh = (command: string) => `Next step.\n\`\`\`sh\n${command}\n\`\`\``;

test("a quest's reviewer call carries `apart`: the model the engineer's latest answer came from", async () => {
  const calls: { role: QuestRole; turn?: { apart?: string } }[] = [];
  const texts: Record<QuestRole, string[]> = {
    planner: ["1. Make the change.\nDone when: it is done."],
    engineer: [sh("echo hi"), "DONE\nBuilt."],
    reviewer: ["PASS\nThe evidence supports it."],
  };
  const outcome = await runQuest(
    { goal: "make it so", environment: "a test sandbox", maxSteps: 30 },
    {
      ask: async (role, _messages, turn) => {
        calls.push({ role, turn });
        const text = texts[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, truncated: false }),
    },
  );
  expect(outcome.status).toBe("done");
  const reviewer = calls.filter((c) => c.role === "reviewer");
  expect(reviewer).toHaveLength(1);
  // The reviewer is asked apart from the model the engineer's latest answer came from (test/engineer).
  expect(reviewer[0]!.turn).toEqual({ apart: "test/engineer" });
});
