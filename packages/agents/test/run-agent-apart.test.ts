import { expect, test } from "bun:test";
import type { ExecResult } from "@invincible/core";
import { OPENCODE, runLoop, type RunRole } from "../src/index.ts";

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
    if (command.startsWith("python3 -I -c") && command.includes("d, off =")) {
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
  const reviewerCalls: { role: RunRole; turn?: { apart?: readonly string[] } }[] = [];
  const box = sandbox([[LINES.start, LINES.text]]);
  const outcome = await runLoop(
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
  expect(reviewerCalls[0]!.turn).toEqual({ apart: ["orcarouter/anthropic/claude-opus-5.5"] });
});

test("a review is asked apart from every model that did the work: a run that fell back is kept apart from both", async () => {
  const reviewerCalls: { apart?: readonly string[] }[] = [];
  let runs = 0;
  const exec = async (command: string): Promise<ExecResult> => {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
    if (command.startsWith("stat -c")) return ok("0\n");
    if (command.startsWith("python3 -I -c") && command.includes("d, off =")) {
      runs += 1;
      // (The first model's run fails at once, with nothing said; the second's ends with its summary.)
      return runs === 1 ? ok(JSON.stringify({ alive: false, exit: 1, next: 10, lines: [] })) : ok(JSON.stringify({ alive: false, exit: 0, next: 20, lines: [LINES.start, LINES.text] }));
    }
    return ok();
  };
  const outcome = await runLoop(
    { goal: "continue", environment: "a sandbox", plan: "Continue the task", agent: { driver: OPENCODE, models: [model, { provider: "deepseek", model: "deepseek-v4-pro" }], minutes: 1, workdir: "/work" } },
    { exec, sleep: noSleep, ask: async (role, _messages, turn) => (role === "reviewer" && reviewerCalls.push({ ...(turn?.apart ? { apart: turn.apart } : {}) }), { text: "PASS", model: "test/reviewer" }) },
  );
  expect(outcome.status).toBe("done");
  expect(reviewerCalls).toEqual([{ apart: ["orcarouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"] }]);
});

test("a tool on its own sign-in: its review is asked apart from every model of its vendor's (Claude Code's: family:claude)", async () => {
  const { CLAUDE } = await import("../src/vendor-cli.ts");
  const { OWN_SIGN_IN } = await import("../src/harnesses.ts");
  const reviewerCalls: { apart?: readonly string[] }[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
    if (command.startsWith("stat -c")) return ok("0\n");
    if (command.startsWith("python3 -I -c") && command.includes("d, off =")) return ok(JSON.stringify({ alive: false, exit: 0, next: 20, lines: [JSON.stringify({ type: "text", text: "Done." })] }));
    return ok();
  };
  const outcome = await runLoop(
    { goal: "continue", environment: "a sandbox", plan: "Continue the task", agent: { driver: CLAUDE, models: [OWN_SIGN_IN], minutes: 1, workdir: "/work" } },
    { exec, sleep: noSleep, ask: async (role, _messages, turn) => (role === "reviewer" && reviewerCalls.push({ ...(turn?.apart ? { apart: turn.apart } : {}) }), { text: "PASS", model: "test/reviewer" }) },
  );
  expect(outcome.status).toBe("done");
  expect(reviewerCalls).toEqual([{ apart: ["family:claude"] }]);
});
