import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ClientCall, ExecResult, NamedRule } from "@invincible/core";
import { MAX_CALLS, type RunEvent, type RunRole, runLoop } from "../src/run.ts";

/*
 * The engineer with tools of its own (RunOptions.tools): several calls a turn, each one of its commands, run in its
 * workspace (here bash, in a folder of its own), said as a shell command to your rules and the reviewer.
 */

const FAKE_KEY = `sk-ant-api03-${"FAKE".repeat(8)}`;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Reply = string | { text?: string; calls: Omit<ClientCall, "id">[] } | { error: string };
let ids = 0;

function harness(engineer: Reply[], options: { gates?: string[]; maxSteps?: number; rules?: NamedRule[]; reviewer?: string[]; computer?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "invincible-run-tools-"));
  dirs.push(dir);
  // The VM's desktop command, stood in for: each verb it is given kept, in order, and answered as deskd answers it.
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "desktop"), DESKTOP);
  chmodSync(join(dir, "bin", "desktop"), 0o755);
  const script = [...engineer];
  const reviews = [...(options.reviewer ?? ["PASS\nLooks right."])];
  const asked: { role: RunRole; messages: ChatMessage[]; tools: string[] }[] = [];
  const events: RunEvent[] = [];
  const run = runLoop(
    { goal: "make it so", environment: "a test sandbox", plan: "", tools: true, ...(options.gates ? { gates: options.gates } : {}), ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}), ...(options.computer ? { computer: true } : {}) },
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
        const proc = Bun.spawn(["bash", "-c", command], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { exitCode, stdout, stderr, durationMs: 1, truncated: false } satisfies ExecResult;
      },
      emit: (event) => events.push(event),
      ...(options.rules ? { rules: () => options.rules! } : {}),
    },
  );
  const desk = () => (existsSync(join(dir, "desk.log")) ? readFileSync(join(dir, "desk.log"), "utf8").trim().split("\n") : []);
  return { dir, run, asked, events, desk };
}

/** The stand-in desktop: a typed FAIL has nothing to take it, as deskd says when nothing that takes text has the focus. */
const DESKTOP = `#!/bin/bash
printf '%s\\n' "$*" >> desk.log
case "$1" in
  screenshot|zoom) echo "data:image/png;base64,iVBORw0KGgo=" ;;
  tree) printf 'Chromium "Form"\\n  ref=1 push button "Send" 640,450 80x30\\n' ;;
  type) if [ "$2" = FAIL ]; then echo "desktop: nothing that takes text has the focus (click there first)" >&2; exit 1; fi; echo "typed \${#2} characters into the page · the screen changed (4 ms)" ;;
  *) echo "$1 at $2,$3 · the screen changed (5 ms)" ;;
esac
`;

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
    expect(engineerAsks(refused)[1]!.messages.at(-1)!.results![0]!.content).toStartWith('Not run: the owner\'s tripwire "no-env" refuses this command');

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

  test("a tool call cut off by the model's output limit isn't asked again: it is told to write in parts", async () => {
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

  test("a run says where its time went: the plan, the work's model calls and its commands, the gates, the review", async () => {
    let now = 0;
    const replies: Record<RunRole, (string | { text: string; calls: ClientCall[] })[]> = {
      planner: ["1. Do it.\nDone when: it is done."],
      engineer: [{ text: "", calls: [{ id: "c1", name: "bash", input: { command: "echo hi" } }] }, "DONE\nDid it."],
      reviewer: ["PASS\nFine."],
    };
    const outcome = await runLoop(
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

describe("the engineer with Claude's computer toolset (C1 step 7)", () => {
  const SCREEN = { mediaType: "image/png" as const, data: "iVBORw0KGgo=", alt: "The screen after this turn's actions: 1280 by 800, the pointer drawn in." };
  const TREE = 'What can be acted on now, in the window with the focus (desktop tree):\nChromium "Form"\n  ref=1 push button "Send" 640,450 80x30';
  const commands = (h: ReturnType<typeof harness>) => h.events.filter((e) => e.type === "command").map((e) => (e as { command: string }).command);

  test("offered beside its tools, each action is one of its commands, said as the VM's desktop command; the turn ends with what can be acted on, then the screen", async () => {
    const h = harness(
      [
        { calls: [{ name: "left_click", input: { coordinate: [640, 450] } }, { name: "type", input: { text: "Ada" } }, { name: "key", input: { text: "Return" } }] },
        "DONE\nSent the form.",
      ],
      { computer: true },
    );
    const outcome = await h.run;
    // (Unverified: desktop work with no gate to prove it, as below, C1 step 8.)
    expect([outcome.status, outcome.steps]).toEqual(["unverified", 3]);
    const asks = engineerAsks(h);
    expect(asks[0]!.tools).toEqual(["bash", "read", "edit", "write", "computer"]);
    expect(commands(h)).toEqual(["desktop left_click 640 450", "desktop type Ada", "desktop key Return"]);
    // One look at the end of the turn, not one an action.
    expect(h.desk()).toEqual(["left_click 640 450", "type Ada", "key Return", "tree", "screenshot --base64"]);
    const results = asks[1]!.messages.at(-1)!.results!;
    expect(results.map((r) => r.images)).toEqual([undefined, undefined, [SCREEN]]);
    expect(results.map((r) => r.content)).toEqual(["left_click at 640,450 · the screen changed (5 ms)", "typed 3 characters into the page · the screen changed (4 ms)", `key at Return, · the screen changed (5 ms)\n\n${TREE}`]);
  });

  test("a turn that ends with a screenshot ends with no second; its picture is its result, and its bytes reach no trail and no event", async () => {
    const h = harness([{ calls: [{ name: "left_click", input: { coordinate: [10, 20] } }, { name: "screenshot", input: {} }] }, "DONE\nLooked."], { computer: true });
    await h.run;
    expect(h.desk()).toEqual(["left_click 10 20", "screenshot --base64", "tree"]);
    const [, shot] = engineerAsks(h)[1]!.messages.at(-1)!.results!;
    expect(shot).toMatchObject({ content: `The screen as it is now: 1280 by 800, the pointer drawn in.\n\n${TREE}`, images: [{ ...SCREEN, alt: "The screen as it is now: 1280 by 800, the pointer drawn in." }] });
    expect(JSON.stringify(h.events)).not.toContain("iVBORw0KGgo");
  });

  test("an action that fails stops the turn's others, each told it wasn't executed, as the toolset asks; its other tools still run", async () => {
    const h = harness(
      [
        { calls: [{ name: "type", input: { text: "FAIL" } }, { name: "left_click", input: { coordinate: [1, 2] } }, bash("echo still"), { name: "left_click", input: { coordinate: [5000, 2] } }] },
        { calls: [{ name: "left_click", input: { coordinate: [5000, 2] } }, { name: "key", input: { text: "Return" } }] },
        "DONE\nTried.",
      ],
      { computer: true },
    );
    const outcome = await h.run;
    // (What was never started is no command of the run's.)
    expect(outcome.steps).toBe(3);
    expect(commands(h)).toEqual(["desktop type FAIL", "echo still"]);
    const [first, second] = engineerAsks(h).slice(1).map((a) => a.messages.at(-1)!.results!);
    expect(first!.map((r) => [r.error ?? false, r.content.split("\n")[0]])).toEqual([
      [true, "desktop: nothing that takes text has the focus (click there first)"],
      [true, "Not executed: an earlier computer action in this turn failed."],
      [false, "exit 0 · 1 ms"],
      [true, "Not executed: an earlier computer action in this turn failed."],
    ]);
    expect(first!.at(-1)).toMatchObject({ images: [SCREEN] });
    // A call that isn't one it can run stops the rest too, and acts on nothing: the turn ends without a look.
    expect(second!.map((r) => r.content)).toEqual(["left_click's coordinate is [x, y] on the screen: x from 0 to 1279, y from 0 to 799.", "Not executed: an earlier computer action in this turn failed."]);
    expect(h.desk()).toEqual(["type FAIL", "tree", "screenshot --base64"]);
  });

  test("without a desktop the toolset is neither offered nor run: its call is a tool there isn't", async () => {
    const h = harness([{ calls: [{ name: "left_click", input: { coordinate: [1, 2] } }] }, "DONE\nNo screen."]);
    await h.run;
    expect(engineerAsks(h)[0]!.tools).toEqual(["bash", "read", "edit", "write"]);
    expect(engineerAsks(h)[1]!.messages.at(-1)!.results).toEqual([{ id: expect.any(String), content: 'There is no tool "left_click": there is bash, read, edit, write.', error: true }]);
    expect(h.desk()).toEqual([]);
  });
});

describe("desktop work is proven by a gate (C1 step 8)", () => {
  const click = { name: "left_click", input: { coordinate: [640, 450] } };

  test("with no gate it is never verified, whatever the reviewer says: the screen is evidence, never the proof", async () => {
    const h = harness([{ calls: [click] }, "DONE\nSent the form."], { computer: true });
    const outcome = await h.run;
    expect(outcome.status).toBe("unverified");
    expect(outcome.review).toContain("Its desktop work has no gate to prove it");
    // The same done through the shell's own desktop command.
    const shell = harness([{ calls: [bash("desktop click 640 450 && desktop key Return")] }, "DONE\nSent the form."]);
    expect((await shell.run).status).toBe("unverified");
  });

  test("a gate that passes proves it; only looking at the screen is no desktop work", async () => {
    const gated = harness([{ calls: [click] }, "DONE\nSent the form."], { computer: true, gates: ["true"] });
    expect((await gated.run).status).toBe("done");
    const looked = harness([{ calls: [{ name: "screenshot", input: {} }, bash("desktop tree")] }, "DONE\nRead what it says."], { computer: true });
    expect((await looked.run).status).toBe("done");
  });
});
