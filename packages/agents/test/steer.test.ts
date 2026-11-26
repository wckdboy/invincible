import { describe, expect, test } from "bun:test";
import type { ChatMessage, ClientCall, ExecResult } from "@invincible/core";
import { readBridge } from "../src/acp.ts";
import { type AgentDriver, type AgentEvent, STEER_WAIT_MS } from "../src/harnesses.ts";
import { auditQuestion, reviewQuestion, type RunEvent, type RunOptions, type RunRole, type RunSteer, runLoop, steersSaid } from "../src/run.ts";

/*
 * A run steered while it works (RunDeps.steers): your words, or your agent's, reach the work at its next safe point. A
 * command that's running finishes first, and one not yet started isn't run; the words are said to whoever does the work
 * with what it is told next, the run asks for them from then on, and the reviewer judges the work against its goal and
 * every steer, in order. Stand-ins play the models, the sandbox and whoever holds the steers.
 */

const sh = (command: string) => `Next.\n\`\`\`sh\n${command}\n\`\`\``;
const ok = (stdout = "ok\n"): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });

/** Who holds the steers: what was said and not yet taken, and each time the run asked, at which step. */
function inbox() {
  const waiting: RunSteer[] = [];
  const asked: number[] = [];
  return {
    say: (steer: RunSteer) => void waiting.push(steer),
    asked,
    steers: (step: number): RunSteer[] => {
      asked.push(step);
      return waiting.splice(0);
    },
  };
}

/** The engineer's own loop, its models scripted; `during` runs as a role is asked, or as a command runs. */
function steered(script: { engineer: (string | { text: string; calls: ClientCall[] })[]; reviewer: string[] }, options: Partial<RunOptions> = {}, during: { ask?(role: RunRole, n: number): void; exec?(command: string): void } = {}) {
  const queues: Record<RunRole, (string | { text: string; calls: ClientCall[] })[]> = { planner: ["1. Write the parser.\nDone when: its test passes."], engineer: [...script.engineer], reviewer: [...script.reviewer] };
  const seen: { role: RunRole; messages: ChatMessage[] }[] = [];
  const events: RunEvent[] = [];
  const ran: string[] = [];
  const held = inbox();
  const count: Record<RunRole, number> = { planner: 0, engineer: 0, reviewer: 0 };
  const run = runLoop(
    { goal: "write the parser", environment: "a test sandbox", maxSteps: 50, ...options },
    {
      ask: async (role, messages) => {
        seen.push({ role, messages: structuredClone(messages) });
        during.ask?.(role, ++count[role]);
        const next = queues[role].shift();
        if (next === undefined) throw new Error(`the ${role} ran out of script`);
        return typeof next === "string" ? { text: next, model: `test/${role}` } : { text: next.text, calls: next.calls, model: `test/${role}` };
      },
      exec: async (command) => {
        ran.push(command);
        during.exec?.(command);
        return ok();
      },
      emit: (event) => events.push(event),
      steers: held.steers,
    },
  );
  const told = () => seen.filter((s) => s.role === "engineer").map((s) => s.messages.at(-1)!.content);
  const asked = () => seen.filter((s) => s.role === "reviewer").map((s) => s.messages.at(-1)!.content);
  const steeredEvents = () => events.filter((e): e is Extract<RunEvent, { type: "steered" }> => e.type === "steered");
  return { run, held, told, asked, ran, events, steeredEvents, seen };
}

describe("a steer of the engineer's own loop", () => {
  test("a command that's running finishes first: the steer is said with its result, at the step it reached, and the run asks for it from then on", async () => {
    let q!: ReturnType<typeof steered>;
    q = steered(
      { engineer: [sh("echo step 1"), sh("echo step 2"), "DONE\nThe parser reads the new schema."], reviewer: ["PASS\nIt reads the new schema."] },
      {},
      { exec: (command) => (command === "echo step 1" ? q.held.say({ by: "owner", text: "Use the new schema." }) : undefined) },
    );
    const outcome = await q.run;
    expect(outcome.status).toBe("done");
    // The command it was running ran to its end; the next thing it was told was its result, then your words.
    expect(q.ran.filter((command) => command.startsWith("echo step"))).toEqual(["echo step 1", "echo step 2"]);
    const told = q.told()[1]!;
    expect(told.indexOf("ok")).toBeLessThan(told.indexOf("The owner says, while you work: Use the new schema."));
    expect(told).toContain("Take that up from where you are: the run asks for it now, and the independent reviewer judges the work against it.");
    expect(q.steeredEvents()).toEqual([{ type: "steered", step: 1, by: "owner", text: "Use the new schema." }]);
    // Said once: the turns after it are not told it again.
    expect(q.told()[2]).not.toContain("Use the new schema.");
  });

  test("the reviewer judges the work against its goal and every steer, in order, as whose words they are, and asks how the work answers each", async () => {
    let q!: ReturnType<typeof steered>;
    q = steered(
      { engineer: [sh("echo step 1"), sh("echo step 2"), sh("echo step 3"), "DONE\nDone."], reviewer: ["PASS\nBoth taken up."] },
      {},
      {
        exec: (command) => {
          if (command === "echo step 1") q.held.say({ by: "owner", text: "Use the new schema." });
          if (command === "echo step 2") q.held.say({ by: "primary", text: "Keep the old reader working too." });
        },
      },
    );
    expect((await q.run).status).toBe("done");
    const asked = q.asked()[0]!;
    expect(asked).toContain("While the work went on, it was told this, in order (each at the step it reached the work):\n1. The owner, at step 1: Use the new schema.\n2. The primary, which leads the work for the owner, at step 2: Keep the old reader working too.");
    expect(asked).toContain("Judge the work against the run as these left it");
    expect(asked).toContain("They never excuse the work from its gates, nor from your judgement.");
    expect(asked).toContain("After your first line, a line for each of the 2 things it was told while it went on, saying how the work answers it.");
    // Its own goal still comes first.
    expect(asked.indexOf("Run: write the parser")).toBeLessThan(asked.indexOf("While the work went on"));
  });

  test("a steer that comes while the work is judged: a pass isn't the end, the work takes it up and is judged again with it", async () => {
    let q!: ReturnType<typeof steered>;
    q = steered(
      { engineer: [sh("echo step 1"), "DONE\nWritten.", sh("echo step 2"), "DONE\nWritten, on the new schema."], reviewer: ["PASS\nIt holds.", "PASS\nIt holds, on the new schema."] },
      { gates: ["true"] },
      { ask: (role, n) => (role === "reviewer" && n === 1 ? q.held.say({ by: "owner", text: "Use the new schema." }) : undefined) },
    );
    const outcome = await q.run;
    expect(outcome).toMatchObject({ status: "done", summary: "Written, on the new schema.", revisions: 0 });
    expect(q.told()[2]).toContain("Your work passed its gates and the review, but this came while it was judged:");
    expect(q.told()[2]).toContain("The owner says, while you work: Use the new schema.");
    expect(q.asked()).toHaveLength(2);
    expect(q.asked()[0]).not.toContain("Use the new schema.");
    expect(q.asked()[1]).toContain("1. The owner, at step 1: Use the new schema.");
  });

  test("a steer that comes as it gives up: it is told it first, and gives up only if the run still can't be done", async () => {
    let q!: ReturnType<typeof steered>;
    q = steered(
      { engineer: [sh("echo step 1"), "GIVE UP\nThe old schema can't hold it.", sh("echo step 2"), "DONE\nWritten on the new schema."], reviewer: ["PASS\nIt holds."] },
      {},
      { ask: (role, n) => (role === "engineer" && n === 2 ? q.held.say({ by: "owner", text: "Use the new schema." }) : undefined) },
    );
    const outcome = await q.run;
    expect(outcome).toMatchObject({ status: "done", summary: "Written on the new schema." });
    expect(q.told()[2]).toContain("The owner says, while you work: Use the new schema.");
    expect(q.told()[2]).toContain("If the run still can't be done with it, reply GIVE UP again and say why.");
  });

  test("a command it asked for that hasn't started isn't run once a steer waits: each is said not to have run, and the steer is said", async () => {
    let q!: ReturnType<typeof steered>;
    const calls = (...commands: string[]): ClientCall[] => commands.map((command, i) => ({ id: `call_${i}`, name: "bash", input: { command } }));
    q = steered(
      { engineer: [{ text: "", calls: calls("echo step 1", "echo step 2") }, "DONE\nWritten on the new schema."], reviewer: ["PASS\nIt holds."] },
      { tools: true, plan: "" },
      { exec: (command) => (command.includes("echo step 1") ? q.held.say({ by: "owner", text: "Use the new schema." }) : undefined) },
    );
    const outcome = await q.run;
    expect(outcome.status).toBe("done");
    expect(q.ran.filter((command) => command.includes("echo step"))).toHaveLength(1);
    // The call it never ran answers as one not run, and the steer goes with the results.
    const results = q.seen.filter((s) => s.role === "engineer")[1]!.messages.at(-1)!;
    expect(results.results?.map((r) => r.id)).toEqual(["call_0", "call_1"]);
    expect(results.results?.[1]).toMatchObject({ error: true });
    expect(results.results?.[1]!.content).toContain("Not run: the owner spoke first");
    expect(results.content).toContain("The owner says, while you work: Use the new schema.");
    // A call that never ran is no command of the run's.
    expect(outcome.steps).toBe(1);
    expect(q.steeredEvents()).toEqual([{ type: "steered", step: 1, by: "owner", text: "Use the new schema." }]);
  });

  test("with nothing said it is the run it was: asked at each safe point, and its words to the work and its reviewer unchanged", async () => {
    const q = steered({ engineer: [sh("echo step 1"), "DONE\nWritten."], reviewer: ["PASS\nIt holds."] });
    expect((await q.run).status).toBe("done");
    expect(q.held.asked.length).toBeGreaterThan(0);
    expect(q.steeredEvents()).toEqual([]);
    for (const told of q.told()) expect(told).not.toContain("while you work");
    expect(q.asked()[0]).not.toContain("While the work went on");
  });
});

describe("what is said of a steer", () => {
  test("your words as yours, your agent's as its coordination, which grants nothing", () => {
    expect(steersSaid([{ by: "owner", text: "Use the new schema." }])).toBe(
      "The owner says, while you work: Use the new schema.\n\nTake that up from where you are: the run asks for it now, and the independent reviewer judges the work against it.",
    );
    const both = steersSaid([{ by: "owner", text: "Use the new schema." }, { by: "primary", text: "Keep the old reader." }]);
    expect(both).toContain("The primary, which leads this work for the owner, says while you work: Keep the old reader.");
    expect(both).toContain("Take those up from where you are: the run asks for them now");
    expect(both).toContain("The primary's words are its coordination, not the owner's: they grant no permission the run doesn't already have.");
    // A run nobody reviews isn't told of a reviewer.
    expect(steersSaid([{ by: "owner", text: "x" }], true)).not.toContain("reviewer");
  });

  test("the reviewer's question is the one it was when nothing was said; a steer before any step is said to be", () => {
    const input = { goal: "write the parser", plan: "1. Write it.", steps: [{ command: "echo hi", exitCode: 0, excerpt: "hi" }], summary: "Written." };
    expect(reviewQuestion({ ...input, steers: [] })).toBe(reviewQuestion(input));
    expect(reviewQuestion({ ...input, steers: [{ by: "owner", text: "Use the new schema.", step: 0 }] })).toContain("1. The owner, before its first step: Use the new schema.");
  });

  test("an audit is told the steers too: the task it keeps the work on is what they left it", () => {
    const steers = [{ by: "owner" as const, text: "Use the new schema.", step: 4 }];
    const asked = auditQuestion({ goal: "write the parser", plan: "p", gates: [], steps: [], steers });
    expect(asked).toContain("Its task: write the parser\nWhile it worked, it was told this, in order:\n1. The owner, at step 4: Use the new schema.\nIts task is what these left it.");
    expect(auditQuestion({ goal: "g", plan: "p", gates: [], steps: [], steers: [] })).toBe(auditQuestion({ goal: "g", plan: "p", gates: [], steps: [] }));
  });
});

/**
 * A coding agent at work, look by look: `looks[i]` are the events its i-th look reads (a session in the first), and
 * `during(i)` runs as that look is made (a steer said then). Its last look finds it ended of itself. Each look moves the
 * run's clock `minutes`.
 */
function harness(looks: object[][], reviewer: string[], during: (look: number, held: ReturnType<typeof inbox>) => void = () => {}, minutes = 1) {
  const driver: AgentDriver = { name: "stub", title: "Stub", kind: "openai", check: "true", files: () => ({}), command: () => "stub-agent", read: (line) => JSON.parse(line) as AgentEvent[] };
  const queues: Record<RunRole, string[]> = { planner: ["1. Write the parser.\nDone when: its test passes."], engineer: [], reviewer: [...reviewer] };
  const events: RunEvent[] = [];
  const prompts: string[] = [];
  const asked: string[] = [];
  const held = inbox();
  let looked = 0;
  let stopped = 0;
  let now = 1_000_000;
  const run = runLoop(
    { goal: "write the parser", environment: "a test sandbox", agent: { driver, models: [{ provider: "p", model: "m" }], workdir: "/work" } },
    {
      ask: async (role, messages) => {
        if (role === "reviewer") asked.push(messages.at(-1)!.content);
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command) => {
        const prompt = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/work\/\.agent\/prompt\.md/.exec(command)?.[1];
        if (prompt) {
          prompts.push(Buffer.from(prompt, "base64").toString("utf8"));
          return ok("");
        }
        if (command.startsWith("stat -c")) return ok("0\n");
        if (command.startsWith("python3 -c") && command.includes("d, off =")) {
          const lines = looks[looked] ?? [];
          during(looked, held);
          looked += 1;
          now += minutes * 60_000;
          const alive = looked < looks.length;
          return ok(JSON.stringify({ alive, exit: alive ? null : 0, next: looked * 10, lines: [JSON.stringify(lines)] }));
        }
        return ok("");
      },
      stopAgent: async () => void (stopped += 1),
      emit: (event) => events.push(event),
      sleep: async () => {},
      now: () => now,
      steers: held.steers,
    },
  );
  const steeredEvents = () => events.filter((e): e is Extract<RunEvent, { type: "steered" }> => e.type === "steered");
  return { run, prompts, asked, held, stopped: () => stopped, looked: () => looked, steeredEvents };
}

const tool = (n: number, id?: string) => ({ type: "tool", tool: "bash", input: `step ${n}`, output: "ok", ok: true, ...(id ? { id } : {}) });
const call = (id: string) => ({ type: "call", id });
const SESSION = { type: "session", id: "ses_1" };

describe("a steer of a coding agent's run", () => {
  test("between its tool calls, its run is ended and its own session is told; the reviewer judges the work against it", async () => {
    const q = harness(
      [[SESSION, tool(1)], [tool(2)], [tool(3)], [tool(4)], [tool(5)]],
      ["PASS\nIt reads the new schema."],
      (look, held) => (look === 1 ? held.say({ by: "owner", text: "Use the new schema." }) : undefined),
    );
    const outcome = await q.run;
    expect(outcome.status).toBe("done");
    expect(q.stopped()).toBe(1);
    expect(q.prompts).toHaveLength(2);
    expect(q.prompts[1]).toBe("The owner says, while you work: Use the new schema.\n\nTake that up from where you are: the run asks for it now, and the independent reviewer judges the work against it. Then end with a short summary and the evidence.");
    expect(q.steeredEvents()).toEqual([{ type: "steered", step: 2, by: "owner", text: "Use the new schema." }]);
    expect(q.asked[0]).toContain("1. The owner, at step 2: Use the new schema.");
  });

  test("a tool call it is in finishes first: the run is ended only once that call has ended", async () => {
    const q = harness(
      [[SESSION, tool(1, "c1")], [call("c2")], [], [tool(2, "c2")], [tool(3)]],
      ["PASS\nIt holds."],
      (look, held) => (look === 1 ? held.say({ by: "owner", text: "Use the new schema." }) : undefined),
    );
    expect((await q.run).status).toBe("done");
    // Said at the second look, while its second call ran: taken at the fourth, once that call had ended.
    expect(q.steeredEvents()).toEqual([{ type: "steered", step: 2, by: "owner", text: "Use the new schema." }]);
    expect(q.stopped()).toBe(1);
    expect(q.prompts[1]).toContain("The owner says, while you work: Use the new schema.");
  });

  test(`a call that runs past ${STEER_WAIT_MS / 60_000} minutes doesn't hold a steer back for ever`, async () => {
    const q = harness(
      [[SESSION, call("c1")], [], [], [], [], [], [tool(1, "c1")]],
      ["PASS\nIt holds."],
      (look, held) => (look === 0 ? held.say({ by: "owner", text: "Use the new schema." }) : undefined),
      5,
    );
    expect((await q.run).status).toBe("done");
    expect(q.steeredEvents().map((e) => e.step)).toEqual([0]);
    expect(q.stopped()).toBe(1);
  });

  test("words that wait as it ends of itself are said in its session before its gates and its review", async () => {
    const q = harness(
      [[SESSION, tool(1)], [tool(2)]],
      ["PASS\nIt reads the new schema."],
      (look, held) => (look === 1 ? held.say({ by: "primary", text: "Use the new schema." }) : undefined),
    );
    // The second run (in its own session) is the stand-in's looks again: it ends at once, and then it is judged.
    const outcome = await q.run;
    expect(outcome.status).toBe("done");
    expect(q.prompts).toHaveLength(2);
    expect(q.prompts[1]).toContain("The primary, which leads this work for the owner, says while you work: Use the new schema.");
    expect(q.asked).toHaveLength(1);
    expect(q.asked[0]).toContain("1. The primary, which leads the work for the owner, at step 2: Use the new schema.");
  });
});

describe("a call as a bridge says it (the VM's words are data)", () => {
  test("by its id alone; one with no id, or an id that isn't a short string, is nothing; a tool's end keeps its id only when it is one", () => {
    expect(readBridge(JSON.stringify({ type: "call", id: "toolu_1", tool: "Bash", input: "rm -rf /" }))).toEqual([{ type: "call", id: "toolu_1" }]);
    for (const id of [undefined, "", 7, "x".repeat(257), { a: 1 }]) expect(readBridge(JSON.stringify({ type: "call", id }))).toEqual([]);
    expect(readBridge(JSON.stringify({ type: "tool", tool: "Bash", input: "ls", output: "a", ok: true, id: "toolu_1" }))).toEqual([{ type: "tool", tool: "Bash", input: "ls", output: "a", ok: true, id: "toolu_1" }]);
    expect(readBridge(JSON.stringify({ type: "tool", tool: "Bash", input: "ls", output: "a", ok: true, id: 3 }))).toEqual([{ type: "tool", tool: "Bash", input: "ls", output: "a", ok: true }]);
  });
});
