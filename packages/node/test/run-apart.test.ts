import { expect, test } from "bun:test";
import { runLoop, type RunRole } from "@invincible/agents";

const sh = (command: string) => `Next step.\n\`\`\`sh\n${command}\n\`\`\``;

test("a run's reviewer call carries `apart`: the model the engineer's latest answer came from", async () => {
  const calls: { role: RunRole; turn?: { apart?: readonly string[] } }[] = [];
  const texts: Record<RunRole, string[]> = {
    planner: ["1. Make the change.\nDone when: it is done."],
    engineer: [sh("echo hi"), "DONE\nBuilt."],
    reviewer: ["PASS\nThe evidence supports it."],
  };
  const outcome = await runLoop(
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
  // The reviewer is asked apart from every model the engineer's answers came from (test/engineer).
  expect(reviewer[0]!.turn).toEqual({ apart: ["test/engineer"] });
});
