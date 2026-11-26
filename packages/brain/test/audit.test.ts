import { describe, expect, test } from "bun:test";
import type { ChatMessage, ExecResult } from "@galahad/core";
import type { AgentDriver, AgentEvent } from "../src/agents.ts";
import { AUDIT_EVERY, auditQuestion, type QuestEvent, type QuestOptions, type QuestRole, readAudit, runQuest } from "../src/quest.ts";

/*
 * Work audited while it runs, in place of any limit (QuestOptions.audit): every AUDIT_EVERY, the reviewer's models, who
 * don't do the work, say whether it is still on its task. A steer is said to whoever does the work, and an audit never
 * ends it (your word, 19 November 2026: "dont artificially limit my knights. Just have an inline auditor, that makes sure
 * they stay on task"). Stand-ins play the models and the sandbox.
 */

const sh = (command: string) => `Next.\n\`\`\`sh\n${command}\n\`\`\``;
const ok = (stdout = "ok\n"): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
const commands = (n: number, from = 1) => Array.from({ length: n }, (_, i) => sh(`echo step ${from + i}`));

/** The engineer's own loop, with a script for each role; `minutesPerCommand` moves the quest's clock at each command. */
function engineer(script: { engineer: string[]; reviewer: string[] }, options: Partial<QuestOptions>, minutesPerCommand = 0) {
  const queues: Record<QuestRole, string[]> = { planner: ["1. Write the parser.\nDone when: its test passes."], engineer: [...script.engineer], reviewer: [...script.reviewer] };
  const seen: { role: QuestRole; messages: ChatMessage[] }[] = [];
  const events: QuestEvent[] = [];
  let now = 1_000_000;
  const run = runQuest(
    { goal: "write the parser", environment: "a test sandbox", maxSteps: 200, ...options },
    {
      ask: async (role, messages) => {
        seen.push({ role, messages });
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command) => {
        if (command.startsWith("echo step")) now += minutesPerCommand * 60_000;
        return ok(command.startsWith("git status") ? " M parser.ts\n" : "ok\n");
      },
      emit: (event) => events.push(event),
      now: () => now,
    },
  );
  const audits = () => events.filter((e): e is Extract<QuestEvent, { type: "audit" }> => e.type === "audit");
  const asked = () => seen.filter((s) => s.role === "reviewer").map((s) => s.messages.at(-1)!.content);
  const told = () => seen.filter((s) => s.role === "engineer").map((s) => s.messages.at(-1)!.content);
  /** How hard each call was asked to think: its last message's level. */
  const efforts = (role: QuestRole) => seen.filter((s) => s.role === role).map((s) => s.messages.at(-1)!.effort);
  return { run, audits, asked, told, efforts };
}

describe("an audit's answer", () => {
  test("its word on the first line, however it is dressed, and what follows it", () => {
    expect(readAudit("ON\nIt is writing the parser.")).toEqual({ verdict: "on", note: "It is writing the parser." });
    expect(readAudit("**STEER** — stop reinstalling packages\nWrite the test first.")).toEqual({ verdict: "steer", note: "stop reinstalling packages\nWrite the test first." });
    expect(readAudit("Stop: the network is off.")).toEqual({ verdict: "stop", note: "the network is off." });
    expect(readAudit("ONLY partly.")).toBeNull();
    // A sentence that begins with one of the words is not its word.
    expect(readAudit("On second thought, it seems fine.")).toBeNull();
    expect(readAudit("Stop and think: is it closer?")).toBeNull();
    expect(readAudit("steer\nWrite the test.")).toEqual({ verdict: "steer", note: "Write the test." });
    expect(readAudit("It seems fine to me.")).toBeNull();
  });

  test("the question: the task, the plan, the gates, what was run since, what the evidence prints, and the last audit's word", () => {
    const asked = auditQuestion({ goal: "write the parser", plan: "1. Write it.", gates: ["bun test parser"], steps: [{ command: "bun add left-pad", exitCode: 1, excerpt: "network down" }], evidence: "$ git status --short\n M parser.ts", last: { verdict: "steer", note: "Write the test first." } });
    for (const part of ["Its task: write the parser", "1. Write it.", "1. bun test parser", "$ bun add left-pad", "exit 1", "network down", "M parser.ts", "At the last audit: STEER: Write the test first.", "since the last audit"]) expect(asked).toContain(part);
    expect(auditQuestion({ goal: "g", plan: "p", gates: [], steps: [] })).toContain("What it has run since it began");
  });
});

describe("what an audit is told of the whole run, not only since the last look", () => {
  test("how many commands in how many minutes, and the files its commands named most: reading the same ones again and again shows", () => {
    const reads = (path: string, n: number) => Array.from({ length: n }, (_, i) => ({ command: `sed -n '${i * 40 + 1},${i * 40 + 40}p' ${path}`, exitCode: 0, excerpt: "…" }));
    const steps = [...reads("packages/node/src/ci-watch.ts", 7), ...reads("packages/node/src/ci-back.ts", 5), { command: "grep -n look packages/node/src/ci-watch.ts packages/node/src/ci-back.ts", exitCode: 0, excerpt: "…" }, ...reads("docs/PLAN.md", 2)];
    const asked = auditQuestion({ goal: "g", plan: "p", gates: [], steps: steps.slice(-3), whole: { steps, minutes: 46 } });
    expect(asked).toContain("Since it began: 15 commands in 46 minutes.");
    // A file named in one command is counted once in it; a file named only twice isn't worth a line.
    expect(asked).toContain("The files its commands named most: packages/node/src/ci-watch.ts (in 8 of them), packages/node/src/ci-back.ts (in 6).");
    expect(asked).not.toContain("docs/PLAN.md (in");
    // Going round in circles is said in words it can't miss.
    expect(asked).toContain("reading the same files again and again while nothing changes is going round in circles");
  });

  test("nothing named more than a few times: no list of files, only the count", () => {
    const steps = [{ command: "cat a/b.ts", exitCode: 0, excerpt: "" }, { command: "bun test a/b.test.ts", exitCode: 1, excerpt: "" }];
    const asked = auditQuestion({ goal: "g", plan: "p", gates: [], steps, whole: { steps, minutes: 0.4 } });
    expect(asked).toContain("Since it began: 2 commands in under a minute.");
    expect(asked).not.toContain("named most");
  });
});

describe("the engineer's own loop, audited", () => {
  test(`every ${AUDIT_EVERY.steps} commands it is looked at: on its task and closer, the work goes on`, async () => {
    const q = engineer({ engineer: [...commands(25), "DONE\nThe parser is written and tested."], reviewer: ["ON\nIt is writing the parser.", "PASS\nIt holds."] }, { audit: true, gates: ["true"], evidence: ["git status --short"] });
    const outcome = await q.run;
    expect(outcome.status).toBe("done");
    expect(q.audits()).toEqual([{ type: "audit", step: AUDIT_EVERY.steps, verdict: "on", note: "It is writing the parser.", model: "test/reviewer" }]);
    const asked = q.asked()[0]!;
    for (const part of ["Its task: write the parser", "Done when: its test passes.", "1. true", "$ echo step 1", `$ echo step ${AUDIT_EVERY.steps}`, "M parser.ts", `Since it began: ${AUDIT_EVERY.steps} commands in under a minute.`]) expect(asked).toContain(part);
    expect(asked).not.toContain(`echo step ${AUDIT_EVERY.steps + 1}`);
  });

  test("a steer is said to him with what he is told next, and a steer after a steer is said too: no audit ends the work", async () => {
    const q = engineer({ engineer: [...commands(2 * AUDIT_EVERY.steps + 5), "DONE\nThe parser is written and tested."], reviewer: ["STEER\nStop reinstalling; write the test.", "STEER\nStill reinstalling.", "PASS\nIt holds."] }, { audit: true, submitAtLimit: true });
    const outcome = await q.run;
    expect(q.audits().map((a) => [a.step, a.verdict])).toEqual([[AUDIT_EVERY.steps, "steer"], [2 * AUDIT_EVERY.steps, "steer"]]);
    expect(q.told()[AUDIT_EVERY.steps]).toContain("An independent audit of the work so far says: Stop reinstalling; write the test.");
    expect(q.told()[2 * AUDIT_EVERY.steps]).toContain("An independent audit of the work so far says: Still reinstalling.");
    // The second audit is told what the first said, and sees only what was run since.
    expect(q.asked()[1]).toContain("At the last audit: STEER: Stop reinstalling; write the test.");
    expect(q.asked()[1]).not.toContain("$ echo step 20\n");
    // He worked on to the end he chose, and his work was judged as anyone's.
    expect(outcome).toMatchObject({ status: "done", steps: 2 * AUDIT_EVERY.steps + 5, summary: "The parser is written and tested." });
  });

  test("an audit, which only asks whether the work is on its task, thinks little; the turn its steer is said in thinks hardest", async () => {
    const q = engineer({ engineer: [...commands(AUDIT_EVERY.steps + 2), "DONE\nWritten."], reviewer: ["STEER\nWrite the test first.", "PASS\nIt holds."] }, { audit: true });
    expect((await q.run).status).toBe("done");
    // The audit at low, then the review as carefully as ever.
    expect(q.efforts("reviewer")).toEqual(["low", "high"]);
    expect(q.efforts("engineer")[AUDIT_EVERY.steps]).toBe("xhigh");
    expect(q.efforts("engineer")[AUDIT_EVERY.steps - 1]).toBe("medium");
  });

  test("an audit that answers STOP, as audits once could, is heard as a steer: its words are said to him and the work goes on", async () => {
    const q = engineer({ engineer: [...commands(AUDIT_EVERY.steps + 3), "DONE\nWritten."], reviewer: ["STOP\nThe package it needs can't be installed offline.", "PASS\nIt holds."] }, { audit: true });
    const outcome = await q.run;
    expect(q.audits()).toMatchObject([{ step: AUDIT_EVERY.steps, verdict: "steer", note: "The package it needs can't be installed offline." }]);
    expect(q.told()[AUDIT_EVERY.steps]).toContain("An independent audit of the work so far says: The package it needs can't be installed offline.");
    expect(outcome.status).toBe("done");
  });

  test("it asks only whether the work is on its task, and what would bring it back: never whether to end it", () => {
    const asked = auditQuestion({ goal: "g", plan: "p", gates: [], steps: [] });
    expect(asked).toContain("the work goes on whatever you answer");
    expect(asked).toContain("ON if it is working on its task");
    expect(asked).toContain("STEER if it has drifted from its task");
    expect(asked).not.toContain("STOP");
  });

  test("an answer that can't be read, or none at all, never stops the work: it is said, and the next audit asks again", async () => {
    const q = engineer({ engineer: [...commands(45), "DONE\nWritten."], reviewer: ["Hard to say, really.", "ON\nIt is closer.", "PASS\nIt holds."] }, { audit: true });
    const outcome = await q.run;
    expect(q.audits().map((a) => a.verdict)).toEqual(["unread", "on"]);
    expect(q.audits()[0]!.note).toBe("Its answer couldn't be read; it began: Hard to say, really.");
    expect(outcome.status).toBe("done");
  });

  test(`by time too: ${AUDIT_EVERY.minutes} minutes of slow commands is an audit, however few they were`, async () => {
    const q = engineer({ engineer: [...commands(3), "DONE\nWritten."], reviewer: ["ON\nSlow, but on its task.", "PASS\nIt holds."] }, { audit: true }, 8);
    expect((await q.run).status).toBe("done");
    expect(q.audits().map((a) => a.step)).toEqual([2]);
  });

  test("an audit is asked on the reviewer's models in their order; only the review that decides is asked apart from the work's model", async () => {
    // On 22 November 2026 audits asked apart went to the dearest model there was: 42 % of a knight's task's money.
    const turns: { role: QuestRole; apart?: string }[] = [];
    const queues: Record<QuestRole, string[]> = { planner: ["1. Write the parser.\nDone when: its test passes."], engineer: [...commands(AUDIT_EVERY.steps + 2), "DONE\nWritten."], reviewer: ["ON\nOn its task.", "PASS\nIt holds."] };
    const outcome = await runQuest({ goal: "write the parser", environment: "a test sandbox", maxSteps: 200, audit: true }, {
      ask: async (role, _messages, turn) => {
        turns.push({ role, ...(turn?.apart ? { apart: turn.apart } : {}) });
        return { text: queues[role].shift()!, model: `test/${role}` };
      },
      exec: async () => ok(),
    });
    expect(outcome.status).toBe("done");
    expect(turns.filter((t) => t.role === "reviewer")).toEqual([{ role: "reviewer" }, { role: "reviewer", apart: "test/engineer" }]);
  });

  test("off unless asked for: a quest is what it was, its reviewer asked only to review", async () => {
    const q = engineer({ engineer: [...commands(45), "DONE\nWritten."], reviewer: ["PASS\nIt holds."] }, {}, 8);
    expect((await q.run).status).toBe("done");
    expect(q.audits()).toEqual([]);
    expect(q.asked()).toHaveLength(1);
  });
});

/**
 * A coding agent at work: each look at it shows one more tool call (its session in the first), and moves the quest's
 * clock six minutes; it ends of itself at its `polls`th look. The reviewer's answers are the audits' and the review's.
 */
function agentAtWork(reviewer: string[], options: Partial<QuestOptions> = {}, polls = 10, minutes: number | null = 600) {
  const driver: AgentDriver = { name: "stub", title: "Stub", kind: "openai", check: "true", files: () => ({}), command: () => "stub-agent", read: (line) => JSON.parse(line) as AgentEvent[] };
  const queues: Record<QuestRole, string[]> = { planner: ["1. Write the parser.\nDone when: its test passes."], engineer: [], reviewer: [...reviewer] };
  const events: QuestEvent[] = [];
  const prompts: string[] = [];
  let looked = 0;
  let stopped = 0;
  let now = 1_000_000;
  /** Every command asked of the sandbox, as it was asked. */
  const ran: string[] = [];
  const run = runQuest(
    { goal: "write the parser", environment: "a test sandbox", audit: true, agent: { driver, models: [{ provider: "p", model: "m" }], ...(minutes !== null ? { minutes } : {}), workdir: "/work" }, ...options },
    {
      ask: async (role) => {
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command) => {
        ran.push(command);
        const prompt = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/work\/\.agent\/prompt\.md/.exec(command)?.[1];
        if (prompt) {
          prompts.push(Buffer.from(prompt, "base64").toString("utf8"));
          return ok("");
        }
        if (command.startsWith("stat -c")) return ok("0\n");
        if (command.startsWith("python3 -c") && command.includes("d, off =")) {
          looked += 1;
          now += 6 * 60_000;
          const lines = [JSON.stringify([...(looked === 1 ? [{ type: "session", id: "ses_1" }] : []), { type: "tool", tool: "bash", input: `step ${looked}`, output: "ok", ok: true }])];
          return ok(JSON.stringify({ alive: looked < polls, exit: looked < polls ? null : 0, next: looked * 10, lines }));
        }
        return ok("");
      },
      stopAgent: async () => void (stopped += 1),
      emit: (event) => events.push(event),
      sleep: async () => {},
      now: () => now,
    },
  );
  const audits = () => events.filter((e): e is Extract<QuestEvent, { type: "audit" }> => e.type === "audit");
  return { run, audits, prompts, ran, stopped: () => stopped };
}

describe("a coding agent's run, audited", () => {
  test("a steer ends its run and its own session is told; on, it works on to the end and its work is reviewed", async () => {
    const q = agentAtWork(["STEER\nWrite the parser's test first.", "ON\nIt is writing the test.", "ON\nThe parser takes shape.", "PASS\nIt holds."]);
    const outcome = await q.run;
    expect(q.audits().map((a) => a.verdict)).toEqual(["steer", "on", "on"]);
    expect(q.stopped()).toBe(1);
    expect(q.prompts).toHaveLength(2);
    expect(q.prompts[1]).toContain("An independent audit of the work so far says: Write the parser's test first.");
    expect(outcome.status).toBe("done");
  });

  test("an answer of STOP is a steer: its run is ended, its own session told, and it works on to the end", async () => {
    const q = agentAtWork(["STOP\nIt keeps rewriting the same file.", "ON\nIt is writing the test.", "ON\nThe parser takes shape.", "PASS\nIt holds."], { submitAtLimit: true });
    const outcome = await q.run;
    expect(q.audits().map((a) => a.verdict)).toEqual(["steer", "on", "on"]);
    expect(q.stopped()).toBe(1);
    expect(q.prompts[1]).toContain("An independent audit of the work so far says: It keeps rewriting the same file.");
    expect(outcome.status).toBe("done");
  });
});

describe("work with no count and no clock, audited instead", () => {
  test("the engineer is told his commands have no fixed number, and that an audit looks at his work", async () => {
    const q = engineer({ engineer: [...commands(2 * AUDIT_EVERY.steps + 5), "DONE\nWritten."], reviewer: ["ON\nOn its task.", "ON\nCloser.", "PASS\nIt holds."] }, { audit: true, maxSteps: Infinity });
    expect(await q.run).toMatchObject({ status: "done", steps: 2 * AUDIT_EVERY.steps + 5 });
    expect(q.told()[0]).toContain(`Your commands have no fixed number. An independent audit looks at your work every ${AUDIT_EVERY.steps} commands or ${AUDIT_EVERY.minutes} minutes to keep it on its task: when it says what to do next, do that.`);
  });

  test("an audit of a coding agent's run reads no evidence while it works (its commands could take the repository's lock from under it): its review still does", async () => {
    const q = agentAtWork(["ON\nOn its task.", "ON\nCloser.", "ON\nNearly there.", "PASS\nIt holds."], { evidence: ["git add -A -N . && git diff --stat"] });
    expect((await q.run).status).toBe("done");
    expect(q.audits()).toHaveLength(3);
    expect(q.ran.filter((command) => command.startsWith("git add -A -N"))).toHaveLength(1);
  });

  test("a coding agent given no minutes has no deadline: told so, it works an hour and more, audited, until it ends of itself", async () => {
    const q = agentAtWork(["ON\nOn its task.", "ON\nCloser.", "ON\nNearly there.", "PASS\nIt holds."], {}, 10, null);
    expect((await q.run).status).toBe("done");
    expect(q.audits().map((a) => a.verdict)).toEqual(["on", "on", "on"]);
    expect(q.stopped()).toBe(0);
    expect(q.prompts[0]).toContain(`Your time has no fixed limit. An independent audit looks at your work every ${AUDIT_EVERY.steps} tool calls or ${AUDIT_EVERY.minutes} minutes`);
  });
});
