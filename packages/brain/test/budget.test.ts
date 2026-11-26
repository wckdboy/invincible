import { describe, expect, test } from "bun:test";
import type { ChatMessage, ExecResult } from "@galahad/core";
import type { AgentDriver, AgentEvent } from "../src/agents.ts";
import { type QuestEvent, type QuestOptions, type QuestRole, runQuest } from "../src/quest.ts";

const sh = (command: string) => `Next.\n\`\`\`sh\n${command}\n\`\`\``;

/** A quest whose every model call costs `per` dollars (as its caller prices them), with a script for each role. */
function priced(engineer: string[], options: Partial<QuestOptions>, per = 0.1, complete = true, reviewer = ["PASS\nIt is."]) {
  const queues: Record<QuestRole, string[]> = { planner: ["1. Do it.\nDone when: it is done."], engineer: [...engineer], reviewer: [...reviewer] };
  let usd = 0;
  const seen: { role: QuestRole; messages: ChatMessage[] }[] = [];
  const events: QuestEvent[] = [];
  const run = runQuest(
    { goal: "make it so", environment: "a test sandbox", ...options },
    {
      ask: async (role, messages) => {
        seen.push({ role, messages });
        usd += per;
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, truncated: false }),
      emit: (event) => events.push(event),
      spentUsd: () => ({ usd, complete }),
    },
  );
  const told = () => seen.filter((s) => s.role === "engineer").map((s) => s.messages.at(-1)!.content);
  return { run, events, told, asked: () => seen.map((s) => s.role) };
}

describe("a budget in dollars", () => {
  test("each step says what is spent; past four fifths he is told to wrap up; spent, the work stops and what is there is judged", async () => {
    const q = priced(Array.from({ length: 10 }, (_, i) => sh(`echo ${i}`)), { budgetUsd: 0.6, submitAtLimit: true });
    const outcome = await q.run;
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toContain("Its budget ($0.60) was spent before he said he was done");
    const told = q.told();
    expect(told[1]).toContain("(Spent $0.20 of $0.60.)");
    expect(told.some((m) => m.includes("of $0.60: wrap up."))).toBe(true);
    expect(q.events.filter((e) => e.type === "budget")).toEqual([
      { type: "budget", spentUsd: expect.closeTo(0.5, 5), budgetUsd: 0.6, out: false },
      { type: "budget", spentUsd: expect.closeTo(0.6, 5), budgetUsd: 0.6, out: true },
    ]);
  });

  test("without submitAtLimit a quest whose budget is spent stops, and says it was the budget", async () => {
    const q = priced(Array.from({ length: 10 }, (_, i) => sh(`echo ${i}`)), { budgetUsd: 0.3 });
    const outcome = await q.run;
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toBe("Stopped: its budget ($0.30) was spent before he finished.");
  });

  test("work the reviewer sent back, its budget spent by that review, isn't judged again: the reviewer's word stands", async () => {
    // (Planner, a command, DONE: $0.30; the review that sends it back spends the rest. A second look at the same work
    // could pass what was just sent back.)
    const q = priced([sh("echo 1"), "DONE\nDone."], { budgetUsd: 0.35, submitAtLimit: true }, 0.1, true, ["REVISE\nThe test still fails.", "PASS\nIt is."]);
    const outcome = await q.run;
    expect(q.asked().filter((role) => role === "reviewer")).toHaveLength(1);
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toBe("Stopped: its budget ($0.35) was spent before he finished.");
    expect(outcome.review).toBe("The test still fails.");
  });

  test("with no budget nothing is said of money", async () => {
    const q = priced([sh("echo 1"), "DONE\nDone."], {});
    expect((await q.run).status).toBe("done");
    expect(q.told().some((m) => m.includes("Spent $"))).toBe(false);
    expect(q.events.some((e) => e.type === "budget")).toBe(false);
  });

  test("when some calls have no price, what is spent is said to be at least that", async () => {
    const q = priced([sh("echo 1"), "DONE\nDone."], { budgetUsd: 5 }, 0.1, false);
    await q.run;
    expect(q.told()[1]).toContain("(Spent at least $0.20 of $5.00: some calls have no price.)");
  });
});

/**
 * A coding agent at work (a stub whose events are Galahad's own), each look at it costing `perPoll` dollars of its own
 * calls through the gateway, as the caller counts them; it ends of itself after `polls` looks. The planner and the
 * reviewer cost `perAsk` a call.
 */
function agentAtWork(options: Partial<QuestOptions>, { perPoll, polls = 6, perAsk = 0, reviewer = ["PASS\nIt holds."], minutes = 60 }: { perPoll: number; polls?: number; perAsk?: number; reviewer?: string[]; minutes?: number }) {
  const driver: AgentDriver = { name: "stub", title: "Stub", kind: "openai", check: "true", files: () => ({}), command: () => "stub-agent", read: (line) => JSON.parse(line) as AgentEvent[] };
  const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
  const queues: Record<QuestRole, string[]> = { planner: ["1. Do it.\nDone when: it is done."], engineer: [], reviewer: [...reviewer] };
  let usd = 0;
  let looked = 0;
  const events: QuestEvent[] = [];
  const prompts: string[] = [];
  let stopped = 0;
  const run = runQuest(
    { goal: "make it so", environment: "a test sandbox", agent: { driver, models: [{ provider: "p", model: "m" }], minutes, workdir: "/work" }, ...options },
    {
      ask: async (role) => {
        usd += perAsk;
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command) => {
        const prompt = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/work\/\.agent\/prompt\.md/.exec(command)?.[1];
        if (prompt) {
          prompts.push(Buffer.from(prompt, "base64").toString("utf8"));
          return ok();
        }
        if (command.startsWith("stat -c")) return ok("0\n");
        if (command.startsWith("python3 -c") && command.includes("d, off =")) {
          // (A look takes a moment, as it does: a deadline can pass between two.)
          await Bun.sleep(2);
          looked += 1;
          usd += perPoll;
          const lines = [JSON.stringify([{ type: "session", id: "ses_1" }, { type: "tool", tool: "bash", input: `step ${looked}`, output: "ok", ok: true }, { type: "text", text: `did ${looked}` }])];
          return ok(JSON.stringify({ alive: looked < polls, exit: looked < polls ? null : 0, next: looked * 10, lines }));
        }
        return ok();
      },
      stopAgent: async () => void (stopped += 1),
      emit: (event) => events.push(event),
      spentUsd: () => ({ usd, complete: true }),
      sleep: async () => {},
    },
  );
  return { run, events, prompts, budget: () => events.filter((e) => e.type === "budget"), stopped: () => stopped, looked: () => looked };
}

describe("a coding agent, held to its budget", () => {
  test("its own calls count as it works: past four fifths it is said, and spent, the agent is stopped and what it left is judged", async () => {
    const q = agentAtWork({ budgetUsd: 0.5, submitAtLimit: true }, { perPoll: 0.2 });
    const outcome = await q.run;
    expect(q.looked()).toBe(3);
    expect(q.stopped()).toBe(1);
    expect(q.budget()).toEqual([
      { type: "budget", spentUsd: expect.closeTo(0.4, 5), budgetUsd: 0.5, out: false },
      { type: "budget", spentUsd: expect.closeTo(0.6, 5), budgetUsd: 0.5, out: true },
    ]);
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toBe("Its budget ($0.50) was spent before he said he was done. The work as it stood was put to the reviewer, who accepted it.");
  });

  test("without submitAtLimit it stops, saying it was the budget", async () => {
    const q = agentAtWork({ budgetUsd: 0.5 }, { perPoll: 0.2 });
    const outcome = await q.run;
    expect(q.stopped()).toBe(1);
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toBe("Stopped: its budget ($0.50) was spent before he finished.");
  });

  test("work sent back isn't taken up again once the budget is spent: it ends with the reviewer's word", async () => {
    const q = agentAtWork({ budgetUsd: 0.5 }, { perPoll: 0.1, polls: 2, perAsk: 0.2, reviewer: ["REVISE\nThe test still fails."] });
    const outcome = await q.run;
    expect(q.prompts).toHaveLength(1);
    expect(q.stopped()).toBe(0);
    expect(outcome.status).toBe("unverified");
    expect(outcome.review).toBe("The test still fails.");
    expect(q.budget().at(-1)).toEqual({ type: "budget", spentUsd: expect.closeTo(0.6, 5), budgetUsd: 0.5, out: true });
  });

  test("with no budget nothing is said of money and the agent works to its end", async () => {
    const q = agentAtWork({}, { perPoll: 5, polls: 4 });
    expect((await q.run).status).toBe("done");
    expect(q.looked()).toBe(4);
    expect(q.stopped()).toBe(0);
    expect(q.budget()).toEqual([]);
  });
});

describe("a coding agent out of time", () => {
  test("with work done, what it left is judged as it stands (submitAtLimit), and what passes is done", async () => {
    const q = agentAtWork({ submitAtLimit: true }, { perPoll: 0, minutes: 0 });
    const outcome = await q.run;
    expect(q.stopped()).toBe(1);
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toBe("His time (0 minutes) was up before he said he was done. The work as it stood was put to the reviewer, who accepted it.");
  });

  test("what they don't pass ends as before: it ran out of time, and what was there was judged", async () => {
    const q = agentAtWork({ submitAtLimit: true }, { perPoll: 0, minutes: 0, reviewer: ["REVISE\nNot finished."] });
    const outcome = await q.run;
    expect(outcome.status).toBe("gave-up");
    expect(outcome.summary).toEndWith("stub ran out of time (0 minutes): it ran out of time What was there was put to the reviewer, who did not accept it.");
    expect(outcome.review).toBe("Not finished.");
  });

  test("without submitAtLimit it gives up, as it did", async () => {
    const q = agentAtWork({}, { perPoll: 0, minutes: 0 });
    const outcome = await q.run;
    expect(outcome.status).toBe("gave-up");
    expect(outcome.summary).toEndWith("stub ran out of time (0 minutes): it ran out of time");
  });
});

/**
 * A coding agent on two models whose first run works (a command, then a summary) and ends in a failure, and whose
 * run on the next model can't start, as Percival's could not once its model access was gone (22 November 2026: its
 * finished work was given up unjudged). `worked: false`: the first run fails before it does anything. `firstExit: 0`: it
 * ends well instead, for the reviewer to judge. `then: "hangs"`: a later run starts and does nothing, until its time
 * (`minutes`) or its budget (`budgetUsd`, spent once it starts) ends it.
 */
function agentThatFails({ worked = true, firstExit = 1, then = "cant-start", minutes = 60, budgetUsd, reviewer = ["PASS\nThe report is there."] }: { worked?: boolean; firstExit?: number; then?: "cant-start" | "hangs"; minutes?: number; budgetUsd?: number; reviewer?: string[] } = {}) {
  const driver: AgentDriver = { name: "stub", title: "Stub", kind: "openai", check: "true", files: () => ({}), command: () => "stub-agent", read: (line) => JSON.parse(line) as AgentEvent[] };
  const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
  const queues: Record<QuestRole, string[]> = { planner: ["1. Write the report.\nDone when: it is written."], engineer: [], reviewer: [...reviewer] };
  let launches = 0;
  const asked: QuestRole[] = [];
  const run = runQuest(
    { goal: "profile the suite", environment: "a test sandbox", submitAtLimit: true, ...(budgetUsd !== undefined ? { budgetUsd } : {}), agent: { driver, models: [{ provider: "p", model: "first" }, { provider: "p", model: "next" }], minutes, workdir: "/work" } },
    {
      ask: async (role) => {
        asked.push(role);
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command) => {
        if (command.includes("base64 -d > /work/.agent/prompt.md")) {
          launches += 1;
          if (launches === 1 || then === "hangs") return ok();
          return { exitCode: 1, stdout: "", stderr: "Traceback (most recent call last):\n  File \"<string>\", line 1\nFileNotFoundError: [Errno 2] No such file or directory: '/work/.galahad-gateway.json'", durationMs: 1, truncated: false };
        }
        if (command.startsWith("stat -c")) return ok("0\n");
        if (command.startsWith("python3 -c") && command.includes("d, off =")) {
          if (launches > 1) return ok(JSON.stringify({ alive: true, exit: null, next: 10, lines: [] }));
          const lines = worked ? [JSON.stringify([{ type: "session", id: "ses_1" }, { type: "tool", tool: "bash", input: "bun test > report.txt", output: "ok", ok: true }, { type: "text", text: "Wrote report.txt." }])] : [];
          return ok(JSON.stringify({ alive: false, exit: firstExit, next: 10, lines }));
        }
        return ok();
      },
      emit: () => {},
      spentUsd: () => ({ usd: launches > 1 ? 1 : 0, complete: true }),
      sleep: async () => {},
    },
  );
  return { run, asked, launches: () => launches };
}

describe("a coding agent whose run fails on every model", () => {
  test("with work done, what it left is judged as it stands (submitAtLimit), and what passes is done", async () => {
    const q = agentThatFails();
    const outcome = await q.run;
    expect(q.launches()).toBe(2);
    expect(q.asked.filter((role) => role === "reviewer")).toHaveLength(1);
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toBe("Its run failed on every model before he said he was done. The work as it stood was put to the reviewer, who accepted it.");
  });

  test("what they don't pass gives up as before, saying why it failed and that what was there was judged", async () => {
    const q = agentThatFails({ reviewer: ["REVISE\nThe report is half written."] });
    const outcome = await q.run;
    expect(outcome.status).toBe("gave-up");
    expect(outcome.summary).toContain("stub failed: couldn't start stub: FileNotFoundError: [Errno 2] No such file or directory: '/work/.galahad-gateway.json'");
    expect(outcome.summary).toEndWith("What was there was put to the reviewer, who did not accept it.");
    expect(outcome.review).toBe("The report is half written.");
  });

  test("with nothing done there is nothing to judge: it gives up, the reviewer unasked", async () => {
    const q = agentThatFails({ worked: false });
    const outcome = await q.run;
    expect(outcome.status).toBe("gave-up");
    expect(q.asked).not.toContain("reviewer");
  });

  test("work sent back whose next run fails having done nothing new isn't judged again: the reviewer's word stands", async () => {
    // (A second look at the same work could pass what was just sent back.)
    const q = agentThatFails({ firstExit: 0, reviewer: ["REVISE\nThe report misses the slowest files.", "PASS\nIt is there now."] });
    const outcome = await q.run;
    expect(q.launches()).toBe(3);
    expect(q.asked.filter((role) => role === "reviewer")).toHaveLength(1);
    expect(outcome.status).toBe("gave-up");
    expect(outcome.review).toBe("The report misses the slowest files.");
  });

  test("nor is work sent back whose next run did nothing new before its time or its budget ran out", async () => {
    const late = agentThatFails({ firstExit: 0, then: "hangs", minutes: 0, reviewer: ["REVISE\nThe report misses the slowest files.", "PASS\nIt is there now."] });
    const timedOut = await late.run;
    expect(late.asked.filter((role) => role === "reviewer")).toHaveLength(1);
    expect(timedOut.status).toBe("gave-up");
    expect(timedOut.review).toBe("The report misses the slowest files.");

    const dear = agentThatFails({ firstExit: 0, then: "hangs", budgetUsd: 0.5, reviewer: ["REVISE\nThe report misses the slowest files.", "PASS\nIt is there now."] });
    const spent = await dear.run;
    expect(dear.asked.filter((role) => role === "reviewer")).toHaveLength(1);
    expect(spent.status).toBe("stopped");
    expect(spent.review).toBe("The report misses the slowest files.");
  });
});
