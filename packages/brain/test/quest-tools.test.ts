import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ClientCall, ExecResult, NamedRule } from "@galahad/core";
import { MAX_CALLS, type QuestEvent, type QuestRole, runQuest } from "../src/quest.ts";

/*
 * The engineer with tools of its own (QuestOptions.tools): several calls a turn, each one of its commands, run in its
 * workspace (here bash, in a folder of its own), said as a shell command to your rules and the reviewer.
 */

const FAKE_KEY = `sk-ant-api03-${"FAKE".repeat(8)}`;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Reply = string | { text?: string; calls: Omit<ClientCall, "id">[] } | { error: string };
let ids = 0;

function harness(engineer: Reply[], options: { gates?: string[]; maxSteps?: number; rules?: NamedRule[]; reviewer?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "galahad-quest-tools-"));
  dirs.push(dir);
  const script = [...engineer];
  const reviews = [...(options.reviewer ?? ["PASS\nLooks right."])];
  const asked: { role: QuestRole; messages: ChatMessage[]; tools: string[] }[] = [];
  const events: QuestEvent[] = [];
  const run = runQuest(
    { goal: "make it so", environment: "a test sandbox", plan: "", tools: true, ...(options.gates ? { gates: options.gates } : {}), ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}) },
    {
      ask: async (role, messages, turn) => {
        asked.push({ role, messages: structuredClone(messages), tools: (turn?.tools ?? []).map((t) => t.name) });
        if (role === "reviewer") return { text: reviews.shift() ?? "PASS", model: "test/reviewer" };
        const next = script.shift();
        if (next === undefined) throw new Error("the engineer ran out of script");
        if (typeof next === "string") return { text: next, model: "test/engineer" };
        if ("error" in next) throw new Error(next.error);
        return { text: next.text ?? "", model: "test/engineer", calls: next.calls.map((c) => ({ ...c, id: `call_${++ids}` })), carry: '{"v":1}' };
      },
      exec: async (command) => {
        const proc = Bun.spawn(["bash", "-c", command], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { exitCode, stdout, stderr, durationMs: 1, truncated: false } satisfies ExecResult;
      },
      emit: (event) => events.push(event),
      ...(options.rules ? { rules: () => options.rules! } : {}),
    },
  );
  return { dir, run, asked, events };
}

const bash = (command: string) => ({ name: "bash", input: { command } });
const engineerAsks = (h: ReturnType<typeof harness>) => h.asked.filter((a) => a.role === "engineer");

describe("the engineer with tools", () => {
  test("several calls a turn, each one of its commands and said as one; DONE past the gates is done", async () => {
    const h = harness(
      [
        { text: "Writing it.", calls: [{ name: "write", input: { path: "a.txt", content: "hello\n" } }, { name: "read", input: { path: "a.txt" } }] },
        { calls: [{ name: "edit", input: { path: "a.txt", old_string: "hello", new_string: "world" } }, bash("cat a.txt")] },
        "DONE\nWrote a.txt and changed it.",
      ],
      { gates: ["grep -q world a.txt"] },
    );
    const outcome = await h.run;
    expect([outcome.status, outcome.steps]).toEqual(["done", 4]);
    expect(readFileSync(join(h.dir, "a.txt"), "utf8")).toBe("world\n");
    expect(h.events.filter((e) => e.type === "command").map((e) => (e as { command: string }).command)).toEqual([
      "cat > 'a.txt' <<'EOF'\nhello\nEOF",
      "sed -n '1,2000p' 'a.txt'",
      "edit 'a.txt' <<'EOF'\n-hello\n+world\nEOF",
      "cat a.txt",
    ]);
    const asks = engineerAsks(h);
    expect(asks[0]!.tools).toEqual(["bash", "read", "edit", "write"]);
    expect(asks[0]!.messages[0]!.content).toContain("Work with your tools: bash runs a command; read, edit and write work on files.");
    // The answer goes back with its calls and its carry, and every call has its result, matched by id.
    const [, said, results] = asks[1]!.messages;
    expect(said).toMatchObject({ role: "assistant", content: "Writing it.", carry: '{"v":1}' });
    expect(said!.calls!.map((c) => c.name)).toEqual(["write", "read"]);
    expect(results!.results!.map((r) => r.id)).toEqual(said!.calls!.map((c) => c.id));
    expect(results!.results!.map((r) => r.content)).toEqual(["Wrote a.txt: 1 line, 6 bytes.", "a.txt: lines 1–1 of 1\n     1\thello"]);
    // The reviewer reads what was done, said as commands.
    const review = h.asked.find((a) => a.role === "reviewer")!.messages[0]!.content;
    expect(review).toContain("$ edit 'a.txt' <<'EOF'");
    expect(review).toContain("Edited a.txt: 1 change, at line 1.");
  });

  test("a reply without calls says DONE or GIVE UP: three in a row that don't stop the work", async () => {
    const h = harness(["I will look at it.", "```sh\nls\n```", "Thinking."]);
    const outcome = await h.run;
    expect(outcome.status).toBe("stopped");
    expect(outcome.malformed).toBe(3);
    const told = engineerAsks(h)[2]!.messages.at(-1)!.content;
    expect(told).toStartWith("A command written in your reply isn't run: call the bash tool with it.");
  });

  test("a call that can't be run gets its result, runs nothing and isn't counted as a command", async () => {
    const h = harness([{ calls: [{ name: "browse", input: { url: "x" } }, bash("true")] }, "GIVE UP\nNo browser here."]);
    const outcome = await h.run;
    expect([outcome.status, outcome.steps, outcome.malformed]).toEqual(["gave-up", 2, 1]);
    const results = engineerAsks(h)[1]!.messages.at(-1)!.results!;
    expect(results[0]).toEqual({ id: results[0]!.id, content: 'There is no tool "browse": there is bash, read, edit, write.', error: true });
    expect(results[1]!.content).toStartWith("exit 0 · ");
  });

  test("your tripwires see each call as its command: a refused edit isn't run; a halt stops the turn before any call runs", async () => {
    const rules: NamedRule[] = [
      { name: "no-env", on: "command", does: "refuse", words: ["*.env"] },
      { name: "no-drop", on: "command", does: "halt", words: [], contains: "DROP TABLE" },
    ];
    const refused = harness([{ calls: [{ name: "write", input: { path: ".env", content: "A=1\n" } }] }, "GIVE UP\nRefused."], { rules });
    await refused.run;
    expect(refused.events.some((e) => e.type === "tripped" && e.rule === "no-env")).toBe(true);
    expect(engineerAsks(refused)[1]!.messages.at(-1)!.results![0]!.content).toStartWith('Not run: your liege\'s tripwire "no-env" refuses this command');

    const halted = harness([{ calls: [bash("touch first"), { name: "write", input: { path: "m.sql", content: "DROP TABLE users;" } }] }], { rules });
    const outcome = await halted.run;
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toContain("no-drop");
    // (Nothing of that turn ran, the call before the halted one included.)
    expect(() => readFileSync(join(halted.dir, "first"))).toThrow();
  });

  test("calls past MAX_CALLS aren't run or kept, and the engineer is told; past the commands left, none runs", async () => {
    const many = Array.from({ length: MAX_CALLS + 2 }, (_, i) => bash(`echo ${i}`));
    const h = harness([{ calls: many }, "DONE\nEchoed."]);
    const outcome = await h.run;
    expect(outcome.steps).toBe(MAX_CALLS);
    const [said, told] = engineerAsks(h)[1]!.messages.slice(-2);
    expect(said!.calls).toHaveLength(MAX_CALLS);
    expect(told!.results!.map((r) => r.id)).toEqual(said!.calls!.map((c) => c.id));
    expect(told!.content).toContain(`(Your other 2 calls were not run: at most ${MAX_CALLS} a turn.)`);

    const short = harness([{ calls: [bash("echo 1"), bash("echo 2"), bash("echo 3")] }], { maxSteps: 2 });
    expect((await short.run).steps).toBe(2);
    expect(short.events.filter((e) => e.type === "command")).toHaveLength(2);
  });

  test("only a failure repeated makes the next turn a hard one", async () => {
    const h = harness([{ calls: [bash("false")] }, { calls: [bash("false")] }, "GIVE UP\nIt keeps failing."]);
    await h.run;
    const asks = engineerAsks(h);
    expect(asks[1]!.messages.at(-1)!.effort).toBe("medium");
    expect(asks[2]!.messages.at(-1)!.effort).toBe("xhigh");
    expect(asks[2]!.messages.at(-1)!.results![0]!.content).toContain("The same command failed the same way 2 times in a row");
  });

  test("a result is never longer than the chat route takes, however much a command printed", async () => {
    const h = harness([{ calls: [bash("cat one.txt; cat two.txt >&2")] }, "GIVE UP\nToo much."]);
    writeFileSync(join(h.dir, "one.txt"), "a".repeat(150_000));
    writeFileSync(join(h.dir, "two.txt"), "b".repeat(150_000));
    await h.run;
    const result = engineerAsks(h)[1]!.messages.at(-1)!.results![0]!.content;
    expect(result.length).toBeLessThan(200_000);
    expect(result).toStartWith("exit 0 · ");
  });

  test("a tool call cut off by the model's output limit isn't asked again: he is told to write in parts", async () => {
    const cut = { error: "the engineer could not answer: test/m ran out of room in the middle of a tool call" };
    const h = harness([{ calls: [bash("true")] }, cut, "DONE\nWrote it in parts."], { gates: ["true"] });
    const outcome = await h.run;
    expect([outcome.status, outcome.malformed]).toEqual(["done", 1]);
    const told = engineerAsks(h).at(-1)!.messages.at(-1)!;
    expect(told.content).toEndWith("Write a long file in parts: write its beginning, then add the rest with bash (cat >> file <<'EOF'), and change files with edit rather than writing them whole again.");
    // Three in a row stop the work, as three replies with nothing to run do.
    const stuck = harness([cut, cut, cut]);
    const stopped = await stuck.run;
    expect([stopped.status, stopped.malformed]).toEqual(["stopped", 3]);
  });

  test("what a tool came to and what it was called with are redacted before any model sees them", async () => {
    const h = harness([{ calls: [bash(`echo ${FAKE_KEY}`)] }, "GIVE UP\nDone looking."]);
    await h.run;
    const sent = JSON.stringify(engineerAsks(h)[1]!.messages);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).toContain("[redacted");
  });

  test("a quest says where its time went: the plan, the work's model calls and its commands, the gates, the review", async () => {
    let now = 0;
    const replies: Record<QuestRole, (string | { text: string; calls: ClientCall[] })[]> = {
      planner: ["1. Do it.\nDone when: it is done."],
      engineer: [{ text: "", calls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] }, "DONE\nDid it."],
      reviewer: ["PASS\nFine."],
    };
    const outcome = await runQuest(
      { goal: "make it so", environment: "a test sandbox", tools: true, gates: ["true"] },
      {
        now: () => now,
        ask: async (role) => {
          now += role === "planner" ? 1_000 : role === "reviewer" ? 3_000 : 2_000;
          const next = replies[role].shift()!;
          return typeof next === "string" ? { text: next, model: `test/${role}` } : { ...next, model: `test/${role}` };
        },
        exec: async (command) => {
          now += command === "true" ? 50 : 100;
          return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, truncated: false };
        },
      },
    );
    expect(outcome.status).toBe("done");
    expect(outcome.timing).toEqual({ plan: 1_000, model: 4_000, commands: 100, gates: 50, review: 3_000 });
  });

  test("a read that a later edit made stale is said to be, once the conversation is cut short", async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const h = harness([
      { calls: [{ name: "write", input: { path: "big.txt", content: lines } }] },
      { calls: [{ name: "read", input: { path: "big.txt" } }] },
      { calls: [{ name: "edit", input: { path: "big.txt", old_string: "line 5 ", new_string: "line five " } }] },
      { calls: [{ name: "read", input: { path: "big.txt", limit: 1999 } }] },
      "GIVE UP\nRead enough.",
    ]);
    await h.run;
    const last = engineerAsks(h).at(-1)!.messages;
    const firstRead = last[4]!.results![0]!.content;
    expect(firstRead).toStartWith("big.txt: lines 1–");
    expect(firstRead).toContain("\n(stale: `big.txt` was changed later, by `edit 'big.txt' <<'EOF'`; read it again for what it holds now)");
    expect(firstRead.length).toBeLessThan(400);
    // The newest read stays whole.
    expect(last.at(-1)!.results![0]!.content.length).toBeGreaterThan(90_000);
    writeFileSync(join(h.dir, "done"), "");
  });
});
