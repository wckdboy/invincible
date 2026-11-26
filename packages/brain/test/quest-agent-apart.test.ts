import { expect, test } from "bun:test";
import type { ExecResult } from "@galahad/core";
import { OPENCODE, runQuest, type QuestRole } from "../src/index.ts";

/*
 * A coding agent's review is asked apart from the agent's own model too: `worked` is set in agentWork from the model the
 * agent ran on (provider/model), so the reviewer call carries `apart` even though the shell-engineer loop never ran.
 */

const SESSION = "ses_e3b7b5785ffeWOUAvU1UHA94R4";
const line = (type: string, part: object) => JSON.stringify({ type, timestamp: 1794298395235, sessionID: SESSION, part: { sessionID: SESSION, ...part } });
const LINES = {
  start: line("step_start", { type: "step-start" }),
  text: line("text", { type: "text", text: "`python3 test_calc.py` now passes." }),
};

/** A sandbox that plays a background agent: the first poll returns a finished run's lines. */
function sandbox(batches: string[][], exit: number | null = 0) {
  let polls = 0;
  let offset = 0;
  const exec = async (command: string): Promise<ExecResult> => {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
    if (command.startsWith("python3 -c") && command.includes("d, off =")) {
      const batch = batches[polls] ?? [];
      polls += 1;
      const alive = polls < batches.length;
      offset += batch.join("\n").length + (batch.length ? 1 : 0);
      return ok(JSON.stringify({ alive, exit: alive ? null : exit, next: offset, lines: batch }));
    }
    if (command.startsWith("stat -c")) return ok("0\n");
    return ok();
  };
  return { exec };
}

const model = { provider: "orcarouter", model: "anthropic/claude-opus-5.5" };
const noSleep = async () => {};

test("a coding agent's reviewer call carries `apart`: the agent's own model", async () => {
  const reviewerCalls: { role: QuestRole; turn?: { apart?: string } }[] = [];
  const box = sandbox([[LINES.start, LINES.text]]);
  const outcome = await runQuest(
    { goal: "continue", environment: "a sandbox", plan: "Continue the task", agent: { driver: OPENCODE, models: [model], minutes: 1, workdir: "/work" } },
    {
      exec: box.exec,
      sleep: noSleep,
      ask: async (role, _messages, turn) => {
        if (role === "reviewer") reviewerCalls.push({ role, turn });
        return { text: "PASS", model: "test/reviewer" };
      },
    },
  );
  expect(outcome.status).toBe("done");
  expect(reviewerCalls).toHaveLength(1);
  // The agent ran on orcarouter/anthropic/claude-opus-5.5: the reviewer is asked apart from exactly that.
  expect(reviewerCalls[0]!.turn).toEqual({ apart: "orcarouter/anthropic/claude-opus-5.5" });
});
