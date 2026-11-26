import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@invincible/core";
import { FOLLOW, followArgv, FOLLOW_TICK_MS, OPENCODE, OWN_SIGN_IN, runAgent, STOP_GRACE_SECONDS, type AgentDriver, type AgentRun, type FollowedRun } from "../src/harnesses.ts";
import { type RunEvent, type RunSteer, runLoop, steersSaid } from "../src/run.ts";
import { CLAUDE, CODEX } from "../src/vendor-cli.ts";

/*
 * A coding agent's run followed as it goes (I15 step 5; harnesses.ts runAgent): its events reach the node as they are
 * written, by one long-lived command in its VM (FOLLOW) opened again where it stopped, and a tool that can be told as it
 * works (a `live` driver) is told your words on its own input (TELL), and stopped by its own interrupt first. Here the VM
 * is a stand-in: each test says what its follow prints, and reads what the run asked of it.
 */

/** Lines a test gives a follow as it likes, and its end. */
class Lines implements AsyncIterable<string> {
  private held: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  push(...lines: string[]) {
    this.held.push(...lines);
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.held.length) yield this.held.shift()!;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/** A line of the run's events, ending at byte `at`, as FOLLOW says it; and how the run stands. */
const E = (at: number, event: object) => `E${at} ${JSON.stringify(event)}`;
const S = (alive: boolean, exit: number | null, next: number) => `S${JSON.stringify({ alive, exit, next })}`;

/** A VM whose run is followed. `tell`: what telling its input comes to (0 told; 3 no run was reading it). */
function vm(options: { tell?: number; follow?: "never" | ((opened: number) => boolean) } = {}) {
  const commands: string[] = [];
  const told: Record<string, unknown>[] = [];
  const follows: { offset: number; lines: Lines }[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    const ok = (stdout = "", exitCode = 0) => ({ exitCode, stdout, stderr: "", durationMs: 1, truncated: false });
    if (command.startsWith("stat -c")) return ok("0\n");
    if (command.includes("os.O_NONBLOCK")) {
      const payload = command.match(/ '([A-Za-z0-9+/=]+)'/)![1]!;
      told.push(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
      return ok("", options.tell ?? 0);
    }
    if (command.startsWith("python3 -c") && command.includes("d, off =")) return ok(JSON.stringify({ alive: false, exit: 0, next: 0, lines: [] }));
    return ok();
  };
  const follow = async (offset: number): Promise<FollowedRun> => {
    if (options.follow === "never" || (typeof options.follow === "function" && !options.follow(follows.length))) throw new Error("this host can't keep a command open");
    const lines = new Lines();
    follows.push({ offset, lines });
    return { lines, close: () => lines.end() };
  };
  /** Until the run has asked or been followed as `ready` says. */
  const until = async (ready: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!ready()) {
      if (Date.now() > end) throw new Error("the run never got there");
      await Bun.sleep(1);
    }
  };
  const current = () => follows.at(-1)!.lines;
  return { exec, follow, commands, told, follows, until, current };
}

/** The run's clock, moved on by each wait it makes: its looks come at once. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; await Bun.sleep(0); } };
}

const model = { provider: "anthropic", model: "claude-opus-5-5" };
const at = (run: Promise<AgentRun>) => run;
const polls = (commands: string[]) => commands.filter((command) => command.includes("d, off =")).length;

describe("a run, followed", () => {
  test("each event as it is written, and its end as its follow says it: one launch, one follow, no looks", async () => {
    const box = vm();
    const time = clock();
    const events: string[] = [];
    const run = at(runAgent(CLAUDE, { model, prompt: "Fix it", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work/repo" }, { exec: box.exec, follow: box.follow, ...time, event: (event) => events.push(event.type) }));
    await box.until(() => box.follows.length === 1);
    box.current().push(E(40, { type: "session", id: "ses_1" }), E(80, { type: "call", id: "toolu_1" }), E(160, { type: "tool", tool: "Bash", input: "ls", output: "a.py", ok: true, id: "toolu_1" }), E(200, { type: "text", text: "Done." }), E(240, { type: "tokens", input: 10, output: 2 }), S(false, 0, 240));
    const done = await run;
    expect(done).toEqual({ status: "finished", summary: "Done.", steps: 1, session: "ses_1", tokens: { input: 10, output: 2 } });
    expect(events).toEqual(["tool", "text", "tokens"]);
    expect(box.follows.map((f) => f.offset)).toEqual([0]);
    expect(polls(box.commands)).toBe(0);
    // A live driver's input is a FIFO of its own, opened read and write: its writers come and go, and it never reads an end.
    const launch = box.commands.find((command) => command.startsWith("mkdir -p /work/.agent"))!;
    expect(launch).toContain("mkfifo -m 600 /work/.agent/input");
    expect(launch).toContain("<> /work/.agent/input");
    expect(launch).not.toContain("< /dev/null");
  });

  test("a follow opened again where the last one stopped says no line twice, and goes on from there", async () => {
    const box = vm();
    const time = clock();
    const texts: string[] = [];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...time, event: (event) => event.type === "text" && texts.push(event.text) }));
    await box.until(() => box.follows.length === 1);
    box.current().push(E(30, { type: "text", text: "one" }), S(true, null, 30));
    // Its time up, the follow ends: opened again from byte 30, where a slow host may say the last line again.
    box.current().end();
    await box.until(() => box.follows.length === 2);
    box.current().push(E(30, { type: "text", text: "one" }), E(60, { type: "text", text: "two" }), S(false, 0, 60));
    const done = await run;
    expect(done.status).toBe("finished");
    expect(texts).toEqual(["one", "two"]);
    expect(box.follows.map((f) => f.offset)).toEqual([0, 30]);
  });

  test("what its follow says is data: a line that isn't one of its own, or one whose end isn't a number, is passed over", async () => {
    const box = vm();
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...clock() }));
    await box.until(() => box.follows.length === 1);
    box.current().push("noise", `Exx ${JSON.stringify({ type: "text", text: "forged" })}`, "S{not json", E(20, { type: "text", text: "real" }), S(false, 0, 20));
    expect((await run).summary).toBe("real");
  });

  test("no follow to be had (its host keeps no command open): looked at every pollMs, as before", async () => {
    const box = vm({ follow: "never" });
    const done = await runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...clock() });
    expect(done.status).toBe("finished");
    expect(polls(box.commands)).toBe(1);
  });

  test("a follow lost three times running: looked at instead, from where it stood", async () => {
    const box = vm({ follow: (opened) => opened === 0 });
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...clock() }));
    await box.until(() => box.follows.length === 1);
    box.current().push(E(50, { type: "text", text: "so far" }), S(true, null, 50));
    box.current().end();
    const done = await run;
    expect(done.summary).toBe("so far");
    const look = box.commands.find((command) => command.includes("d, off ="))!;
    expect(look.endsWith(" 50")).toBe(true);
  });
});

describe("your words, told as it works", () => {
  const STEER = "The owner says, while you work: use the new schema.";

  test("told on its input by an id of the node's, as one line; queued and taken said back; nothing is untold", async () => {
    const box = vm();
    const time = clock();
    let waiting = [STEER];
    const seen: unknown[] = [];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => waiting.splice(0)[0] ?? null, steer: () => { throw new Error("a live run is never ended for a steer"); } }, { exec: box.exec, follow: box.follow, ...time, event: (event) => event.type === "steer" && seen.push(event) }));
    await box.until(() => box.told.length === 1);
    const [said] = box.told as { say: string; id: string }[];
    expect(said!.say).toBe(STEER);
    expect(said!.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    box.current().push(E(20, { type: "steer", id: said!.id, state: "queued" }), E(40, { type: "steer", id: said!.id, state: "taken" }), E(60, { type: "text", text: "Using it." }), S(false, 0, 60));
    const done = await run;
    expect(done.status).toBe("finished");
    expect(done.untold).toBeUndefined();
    expect(seen).toEqual([{ type: "steer", id: said!.id, state: "queued" }, { type: "steer", id: said!.id, state: "taken" }]);
    waiting = [];
  });

  test("words it never took come back untold, for its next run to say: said back late, or with no run reading its input", async () => {
    const late = vm();
    let once = [STEER];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0)[0] ?? null }, { exec: late.exec, follow: late.follow, ...clock() }));
    await late.until(() => late.told.length === 1);
    const id = (late.told[0] as { id: string }).id;
    late.current().push(E(20, { type: "steer", id, state: "late" }), S(false, 0, 20));
    expect((await run).untold).toEqual([STEER]);
    // (A run whose input no one reads: its bridge has ended. Told nothing, the words come back all the same.)
    const gone = vm({ tell: 3 });
    once = [STEER];
    const ended = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0)[0] ?? null }, { exec: gone.exec, follow: gone.follow, ...clock() }));
    await gone.until(() => gone.told.length === 1);
    gone.current().push(S(false, 0, 0));
    expect((await ended).untold).toEqual([STEER]);
  });

  test("said back taken, then late (a second word of its bridge's): taken stays; only words of the node's are kept", async () => {
    const box = vm();
    let once = [STEER];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0)[0] ?? null }, { exec: box.exec, follow: box.follow, ...clock() }));
    await box.until(() => box.told.length === 1);
    const id = (box.told[0] as { id: string }).id;
    box.current().push(E(20, { type: "steer", id, state: "taken" }), E(40, { type: "steer", id, state: "late" }), E(60, { type: "steer", id: "not_ours", state: "late" }), S(false, 0, 60));
    expect((await run).untold).toBeUndefined();
    once = [];
  });

  test("a run that can't be told as it works is steered between its calls, as before: now at once, as its run is followed", async () => {
    const box = vm();
    const time = clock();
    let asked = 0;
    const run = at(runAgent(OPENCODE, { model, prompt: "x", session: "ses_1", deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steer: () => (asked += 1) >= 2, steers: async () => { throw new Error("never told: it can't be"); } }, { exec: box.exec, follow: box.follow, ...time }));
    await box.until(() => box.follows.length === 1);
    const done = await run;
    expect(done.status).toBe("steered");
    expect(box.told).toEqual([]);
    // Its input stays /dev/null: OpenCode reads none once started, and waits if it is left open.
    expect(box.commands.find((command) => command.startsWith("mkdir -p /work/.agent"))).toContain("< /dev/null");
  });
});

describe("its stop, when it is followed", () => {
  test("its own interrupt first, given STOP_GRACE_SECONDS to end its turn, then the cleanup all the same", async () => {
    const box = vm();
    const stopper = new AbortController();
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...clock(), signal: stopper.signal }));
    await box.until(() => box.follows.length === 1);
    stopper.abort();
    expect((await run).status).toBe("stopped");
    expect(box.told).toEqual([{ stop: true }]);
    const asked = box.commands.findIndex((command) => command.includes("os.O_NONBLOCK"));
    const cleaned = box.commands.findIndex((command) => command.includes("\ncleanup("));
    expect(asked).toBeGreaterThan(0);
    expect(cleaned).toBeGreaterThan(asked);
    // (It waits for that run to end, and no longer than its grace.)
    expect(box.commands[asked]).toMatch(new RegExp(` '[A-Za-z0-9_-]{16}' ${STOP_GRACE_SECONDS}$`));
  });

  test("a run that can't be told is stopped as before: the cleanup alone", async () => {
    const box = vm();
    const stopper = new AbortController();
    const run = at(runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...clock(), signal: stopper.signal }));
    await box.until(() => box.follows.length === 1);
    stopper.abort();
    expect((await run).status).toBe("stopped");
    expect(box.told).toEqual([]);
    expect(box.commands.some((command) => command.includes("\ncleanup("))).toBe(true);
  });
});

describe("the follow itself", () => {
  test("its command: the run's events from where it stood, for as long as it is given, and nothing a model chose", () => {
    const argv = followArgv(1234.9, 60);
    expect(argv.slice(0, 2)).toEqual(["python3", "-c"]);
    expect(argv[2]).toBe(FOLLOW);
    expect(argv.slice(3)).toEqual(["1234", "60"]);
    expect(followArgv(-5)[3]).toBe("0");
    expect(FOLLOW_TICK_MS).toBeLessThanOrEqual(250);
  });

  test("run on a folder standing for /work/.agent, it says each whole line once with where it ends, from where it is asked to start", async () => {
    const { appendFileSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(`${(await import("node:os")).tmpdir()}/follow-`);
    try {
      // The script's own, its folder pointed at the temp one: nothing else of it changes. (No process marker here, so no
      // run is alive: it says what is there and ends. Its following of a live one is measured in a VM: I15 step 5.)
      const script = FOLLOW.replace('D = Path("/work/.agent")', `D = Path(${JSON.stringify(root)})`);
      expect(script).not.toBe(FOLLOW);
      const follow = async (offset: number) => (await new Response(Bun.spawn(["python3", "-c", script, String(offset), "5"], { stdout: "pipe" }).stdout).text()).trim().split("\n");
      writeFileSync(`${root}/events.jsonl`, '{"type":"text","text":"one"}\n{"type":"te');
      // A line half written is not said until it is whole.
      expect(await follow(0)).toEqual(['E29 {"type":"text","text":"one"}', 'S{"alive": false, "exit": null, "next": 29}']);
      appendFileSync(`${root}/events.jsonl`, 'xt","text":"two"}\n');
      writeFileSync(`${root}/exit`, "0");
      expect(await follow(29)).toEqual(['E58 {"type":"text","text":"two"}', 'S{"alive": false, "exit": 0, "next": 58}']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/*
 * Steering a coding agent's task as it runs (I13 with I15 step 6): your words, or your agent's, reach its run through
 * its channel where its tool can be told as it works (Claude Code, Codex), and at the next safe point otherwise (as
 * OpenCode is: its run ended between its calls, and its session told). Either way the trail says them where they were
 * taken, and the reviewer judges the work against its goal and every steer, in order.
 */
describe("steering a coding agent's task", () => {
  const PLAN = "1. Write the parser.\nDone when: its test passes.";
  /** A task's run loop on a coding agent, its VM the stand-in's, its steers yours as you give them. */
  const task = (driver: AgentDriver, box: ReturnType<typeof vm>, waiting: RunSteer[]) => {
    const events: RunEvent[] = [];
    const reviewed: string[] = [];
    const done = runLoop(
      { goal: "Write the parser", environment: "a stand-in VM", plan: PLAN, agent: { driver, models: [OWN_SIGN_IN], workdir: "/work/repo" } },
      {
        ask: async (role, messages) => {
          if (role === "reviewer") reviewed.push(messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
          return { text: "PASS\nIt parses.", model: `stand-in/${role}` };
        },
        exec: box.exec,
        follow: box.follow,
        emit: (event) => events.push(event),
        ...clock(),
        steers: () => waiting.splice(0),
      },
    );
    return { done, events, reviewed };
  };
  const STEERED = { by: "owner" as const, text: "Keep the old reader." };

  for (const driver of [CLAUDE, CODEX]) {
    test(`${driver.title}: told at once on its input, said on the trail where it was taken, and judged against`, async () => {
      const box = vm();
      const waiting: RunSteer[] = [];
      const run = task(driver, box, waiting);
      await box.until(() => box.follows.length === 1);
      box.current().push(E(20, { type: "session", id: "ses_live" }), E(40, { type: "call", id: "call_1" }));
      waiting.push(STEERED);
      await box.until(() => box.told.length === 1);
      const [said] = box.told as { say: string; id: string }[];
      // In the run's own words for a steer, as its next message would carry it.
      expect(said!.say).toBe(steersSaid([STEERED]));
      box.current().push(E(60, { type: "steer", id: said!.id, state: "queued" }), E(80, { type: "tool", tool: "shell", input: "pytest", output: "ok", ok: true, id: "call_1" }), E(100, { type: "steer", id: said!.id, state: "taken" }), E(120, { type: "text", text: "Kept the old reader." }), S(false, 0, 120));
      const outcome = await run.done;
      expect(outcome.status).toBe("done");
      // One launch: the run went on with your words in it.
      expect(box.commands.filter((command) => command.startsWith("mkdir -p /work/.agent")).length).toBe(1);
      expect(run.events.filter((event) => event.type === "steered")).toEqual([{ type: "steered", step: 0, by: "owner", text: "Keep the old reader." }]);
      expect(run.reviewed.some((asked) => asked.includes("Keep the old reader."))).toBe(true);
    });
  }

  test("OpenCode: its run ended between its calls, and its own session told your words in the run that follows", async () => {
    const box = vm();
    const waiting: RunSteer[] = [];
    const run = task(OPENCODE, box, waiting);
    await box.until(() => box.follows.length === 1);
    box.current().push(`E40 ${JSON.stringify({ sessionID: "ses_oc", type: "step_start", part: {} })}`);
    waiting.push(STEERED);
    // Ended for it, then a run of its session that carries it.
    await box.until(() => box.follows.length === 2);
    box.current().push(`E90 ${JSON.stringify({ sessionID: "ses_oc", type: "text", part: { text: "Kept the old reader." } })}`, S(false, 0, 90));
    const outcome = await run.done;
    expect(outcome.status).toBe("done");
    const launches = box.commands.filter((command) => command.startsWith("mkdir -p /work/.agent"));
    expect(launches).toHaveLength(2);
    // (Inside the launch's own quoted script: its quotes escaped.)
    expect(launches[1]).toContain("--session '\\''ses_oc'\\''");
    const second = Buffer.from(launches[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toContain("The owner says, while you work: Keep the old reader.");
    expect(box.told).toEqual([]);
    expect(run.events.filter((event) => event.type === "steered")).toHaveLength(1);
  });

  test("words a live run never took (it had stopped taking any) are said in its next run, in its own session", async () => {
    const box = vm();
    const waiting: RunSteer[] = [];
    const run = task(CLAUDE, box, waiting);
    await box.until(() => box.follows.length === 1);
    box.current().push(E(20, { type: "session", id: "ses_live" }), E(40, { type: "text", text: "Done, I think." }));
    waiting.push(STEERED);
    await box.until(() => box.told.length === 1);
    const id = (box.told[0] as { id: string }).id;
    box.current().push(E(60, { type: "steer", id, state: "late" }), S(false, 0, 60));
    await box.until(() => box.follows.length === 2);
    box.current().push(E(90, { type: "text", text: "Kept the old reader." }), S(false, 0, 90));
    const outcome = await run.done;
    expect(outcome.status).toBe("done");
    const launches = box.commands.filter((command) => command.startsWith("mkdir -p /work/.agent"));
    expect(launches).toHaveLength(2);
    // (Inside the launch's own quoted script: its quotes escaped.)
    expect(launches[1]).toContain("--session '\\''ses_live'\\''");
    const second = Buffer.from(launches[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toBe(`${steersSaid([STEERED])} Then end with a short summary and the evidence.`);
    // Said once on the trail, where it was taken: not again for its second telling.
    expect(run.events.filter((event) => event.type === "steered")).toHaveLength(1);
  });
});
