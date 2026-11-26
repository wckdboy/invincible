import { describe, expect, test } from "bun:test";
import type { ChatMessage, ExecResult } from "@galahad/core";
import { attemptInstructions, chooseAttempt, evidenceCollector, parsePick, pickPrompt, rotated, runEffort, type EffortAttempt, type EffortEvent } from "../src/effort.ts";
import { type QuestOutcome, type QuestRole, runQuest } from "../src/quest.ts";

/*
 * Effort: several independent attempts at one quest, each reviewed as any quest is,
 * then the independent reviewer takes the best on the evidence alone. The honesty
 * rules of quests don't change: the outcome is the taken attempt's own.
 */

const outcome = (status: QuestOutcome["status"], summary = "did it"): QuestOutcome => ({ status, summary, steps: 3, revisions: 0, plan: "1. Do it." });
const attempt = (index: number, status: QuestOutcome["status"], evidence = `evidence of ${index}`): EffortAttempt<string> => ({ index, outcome: outcome(status, `summary ${index}`), evidence, handle: `sandbox-${index}` });

describe("reading the reviewer's pick", () => {
  test("PICK and a letter on the first line; anything else isn't a pick", () => {
    expect(parsePick("PICK B\nIts tests ran; A's didn't.", ["A", "B"])).toEqual({ label: "B", notes: "Its tests ran; A's didn't." });
    expect(parsePick("**PICK: a**\nbecause", ["A", "B"])).toEqual({ label: "A", notes: "because" });
    expect(parsePick("PICK C\nnope", ["A", "B"])).toBeNull();
    expect(parsePick("I think B is a little better.", ["A", "B"])).toBeNull();
    expect(parsePick("", ["A", "B"])).toBeNull();
  });
});

describe("choosing among attempts", () => {
  const never = async (): Promise<{ text: string; model: string }> => {
    throw new Error("the reviewer must not be asked");
  };

  test("one passed: it's taken, and nobody is asked", async () => {
    const pick = await chooseAttempt("the goal", [attempt(1, "unverified"), attempt(2, "done"), attempt(3, "gave-up")], never);
    expect(pick).toMatchObject({ index: 2, by: "only" });
  });

  test("none passed: the outcome is honest, the best status, never 'done'", async () => {
    const pick = await chooseAttempt("the goal", [attempt(1, "gave-up"), attempt(2, "unverified"), attempt(3, "stopped")], never);
    expect(pick).toMatchObject({ index: 2, by: "status" });
    expect(pick.reason).toMatch(/none passed/i);
  });

  test("several passed: the reviewer picks on the evidence alone, blind to who made each", async () => {
    let asked: ChatMessage[] = [];
    const pick = await chooseAttempt("compute the tip deflection", [attempt(1, "done", "$ python3 solve.py\nexit 0\n3.14"), attempt(2, "gave-up"), attempt(3, "done", "$ python3 fem.py\nexit 0\n3.1416, converged")], async (messages) => {
      asked = messages;
      return { text: "PICK B\nIt shows a convergence study; A is one unverified number.", model: "deepseek/deepseek-reasoner" };
    });
    expect(pick).toMatchObject({ index: 3, by: "reviewer", model: "deepseek/deepseek-reasoner" });
    expect(pick.reason).toContain("convergence study");
    const prompt = asked[0]!.content;
    expect(prompt).toContain("compute the tip deflection");
    expect(prompt).toContain("=== Attempt A ===");
    expect(prompt).toContain("3.1416, converged");
    // Only the ones that passed are compared, and nothing says which attempt or model each is.
    expect(prompt).not.toContain("Attempt C");
    expect(prompt).not.toMatch(/attempt 3|sandbox-/i);
  });

  test("an unclear pick, or a reviewer that can't be asked, takes the first that passed and says so", async () => {
    const unclear = await chooseAttempt("g", [attempt(1, "done"), attempt(2, "done")], async () => ({ text: "Both are fine.", model: "m" }));
    expect(unclear).toMatchObject({ index: 1, by: "first-passed" });
    expect(unclear.reason).toMatch(/wasn't clear/);
    const down = await chooseAttempt("g", [attempt(2, "done"), attempt(3, "done")], async () => {
      throw new Error("provider down");
    });
    expect(down).toMatchObject({ index: 2, by: "first-passed" });
    expect(down.reason).toMatch(/couldn't be asked/);
  });

  test("the prompt cuts each attempt's evidence to size", () => {
    const prompt = pickPrompt("g", [
      { label: "A", evidence: "x".repeat(50_000) },
      { label: "B", evidence: "short" },
    ]);
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("characters cut");
  });
});

describe("running attempts in parallel", () => {
  test("every attempt runs at once; the reviewer's pick is the outcome", async () => {
    let running = 0;
    let peak = 0;
    const events: EffortEvent[] = [];
    const result = await runEffort<string>(
      { goal: "the goal", attempts: 3 },
      {
        attempt: async (index) => {
          running += 1;
          peak = Math.max(peak, running);
          await Bun.sleep(20);
          running -= 1;
          return { outcome: outcome("done", `summary ${index}`), evidence: `evidence ${index}`, handle: `sandbox-${index}` };
        },
        ask: async () => ({ text: "PICK C\nThe strongest evidence.", model: "reviewer/model" }),
        emit: (event) => events.push(event),
      },
    );
    expect(peak).toBe(3);
    expect(result.taken).toMatchObject({ index: 3, handle: "sandbox-3" });
    expect(result.outcome).toMatchObject({ status: "done", summary: "summary 3" });
    expect(result.pick).toMatchObject({ by: "reviewer", index: 3 });
    expect(result.attempts.map((a) => a.index)).toEqual([1, 2, 3]);
    expect(events.filter((e) => e.type === "attempt-started")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "picked", index: 3 });
  });

  test("an attempt that crashes is one attempt lost, not the quest; all crashing is an error", async () => {
    const one = await runEffort<string>(
      { goal: "g", attempts: 2 },
      {
        attempt: async (index) => {
          if (index === 1) throw new Error("no sandbox host");
          return { outcome: outcome("unverified"), evidence: "e", handle: "s2" };
        },
        ask: async () => ({ text: "", model: "" }),
      },
    );
    expect(one.taken?.index).toBe(2);
    expect(one.outcome.status).toBe("unverified");
    expect(one.failed).toEqual([{ index: 1, error: "no sandbox host" }]);
    await expect(
      runEffort<string>({ goal: "g", attempts: 2 }, { attempt: async () => Promise.reject(new Error("docker is not available")), ask: async () => ({ text: "", model: "" }) }),
    ).rejects.toThrow(/docker is not available/);
  });

  test("stopped by you: no pick is made, and the outcome is stopped", async () => {
    const controller = new AbortController();
    const result = await runEffort<string>(
      { goal: "g", attempts: 2 },
      {
        attempt: async (index, _of, signal) => {
          if (index === 1) controller.abort();
          await Bun.sleep(5);
          return { outcome: outcome(signal.aborted ? "stopped" : "done"), evidence: "e", handle: `s${index}` };
        },
        ask: async () => {
          throw new Error("must not be asked after a stop");
        },
        signal: controller.signal,
      },
    );
    expect(result.outcome.status).toBe("stopped");
  });

  test("one attempt is just the quest: no pick, no extra call", async () => {
    const result = await runEffort<string>(
      { goal: "g", attempts: 1 },
      {
        attempt: async () => ({ outcome: outcome("done"), evidence: "e", handle: "s" }),
        ask: async () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(result.pick).toMatchObject({ index: 1, by: "only" });
  });
});

describe("what makes attempts differ", () => {
  test("the first attempt is the plain quest; the others are told they aren't alone", () => {
    expect(attemptInstructions(1, 3)).toBe("");
    expect(attemptInstructions(2, 3)).toMatch(/independently/);
    expect(attemptInstructions(1, 1)).toBe("");
  });

  test("each attempt starts the role's models at a different one, keeping the rest as fallbacks", () => {
    expect(rotated(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(rotated(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotated(["a", "b", "c"], 5)).toEqual(["c", "a", "b"]);
    expect(rotated([], 2)).toEqual([]);
    expect(rotated(["only"], 2)).toEqual(["only"]);
  });
});

describe("an attempt's evidence, collected as it works", () => {
  test("what it ran, the exit codes and excerpts; then what the evidence commands print", async () => {
    const collect = evidenceCollector();
    const turns: Partial<Record<QuestRole, number>> = {};
    const outputs: Partial<ExecResult>[] = [{ stdout: "wrote a.txt\n" }, { exitCode: 1, stderr: "assertion failed\n" }];
    const result = await runQuest(
      { goal: "make it so", environment: "a test sandbox" },
      {
        ask: async (role: QuestRole) => {
          const script: Record<QuestRole, string[]> = { planner: ["1. Do it."], engineer: ["One.\n```sh\necho hi > a.txt\n```", "Two.\n```sh\nbun test\n```", "DONE\nIt works."], reviewer: ["PASS"] };
          turns[role] = (turns[role] ?? 0) + 1;
          return { text: script[role][turns[role]! - 1]!, model: `test/${role}` };
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false, ...outputs.shift() }),
        emit: collect.emit,
      },
    );
    const text = collect.text(result, "$ cat /work/out/answer.json\n{\"x\": 1}");
    expect(text).toContain("$ echo hi > a.txt");
    expect(text).toContain("exit 1");
    expect(text).toContain("assertion failed");
    expect(text).toContain('{"x": 1}');
    expect(text).toContain("It works.");
    // Never which model did it.
    expect(text).not.toContain("test/engineer");
  });
});
