import { describe, expect, test } from "bun:test";
import type { ExecResult } from "@invincible/core";
import { FOLLOW, followArgv, FOLLOW_TICK_MS, OPENCODE, OWN_SIGN_IN, runAgent, STOP_GRACE_SECONDS, type AgentDriver, type AgentRun, type FollowedRun } from "../src/harnesses.ts";
import { AUDIT_EVERY, type RunEvent, type RunSteer, runLoop, spentReset, steersSaid } from "../src/run.ts";
import type { AgentEvent } from "../src/harnesses.ts";
import { harnessReadiness } from "../src/team-runtime.ts";
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
    if (command.startsWith("python3 -I -c") && command.includes("d, off =")) return ok(JSON.stringify({ alive: false, exit: 0, next: 0, lines: [] }));
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

describe("what a VM says of its run, checked", () => {
  test("a follow that ends having said nothing (its VM at a limit) is opened again after a pause; three running, its run is looked at instead", async () => {
    const commands: string[] = [];
    let opened = 0;
    const waits: number[] = [];
    let t = 1_000_000;
    const exec = async (command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command.startsWith("stat -c")) return { exitCode: 0, stdout: "0\n", stderr: "", durationMs: 1, truncated: false };
      return { exitCode: 0, stdout: JSON.stringify({ alive: false, exit: 0, next: 0, lines: [] }), stderr: "", durationMs: 1, truncated: false };
    };
    // (A follow that opens and ends at once, saying nothing; past twelve opens, one that can't be opened at all.)
    const follow = async (): Promise<FollowedRun> => {
      opened += 1;
      if (opened > 12) throw new Error("this host can't keep a command open");
      const lines = new Lines();
      lines.end();
      return { lines, close: () => {} };
    };
    const done = await runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec, follow, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; await Bun.sleep(0); } });
    expect(done.status).toBe("finished");
    expect(opened).toBe(3);
    expect(waits.filter((ms) => ms >= 1_000).length).toBeGreaterThanOrEqual(2);
    expect(polls(commands)).toBe(1);
  });

  test("a look's answer that isn't one (an offset that isn't a number, or behind; lines that aren't lines) is no news, and never reaches a command", async () => {
    const commands: string[] = [];
    const answers = [
      { alive: true, exit: null, next: "0; touch /tmp/owned", lines: [] },
      { alive: true, exit: null, next: 40, lines: "not lines" },
      { alive: true, exit: null, next: 20, lines: [JSON.stringify({ type: "text", text: "so far" })] },
      { alive: true, exit: null, next: 10, lines: [JSON.stringify({ type: "text", text: "said again" })] },
      { alive: false, exit: 0, next: 20, lines: [] },
    ];
    const exec = async (command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command.startsWith("stat -c")) return { exitCode: 0, stdout: "0\n", stderr: "", durationMs: 1, truncated: false };
      if (command.includes("d, off =")) return { exitCode: 0, stdout: JSON.stringify(answers.shift() ?? { alive: false, exit: 0, next: 20, lines: [] }), stderr: "", durationMs: 1, truncated: false };
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false };
    };
    const done = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec, ...clock() });
    expect(done.status).toBe("finished");
    const looks = commands.filter((command) => command.includes("d, off ="));
    expect(looks.every((command) => / [0-9]+$/.test(command))).toBe(true);
    expect(looks.some((command) => command.includes("touch"))).toBe(false);
    // (Said once: an answer from behind where it stood is passed over.)
    expect(done.summary).not.toBe("said again");
  });
});

describe("a run cut off before it ended", () => {
  test("its process gone with no exit code (killed, its VM restarted): failed, and said to be cut off", async () => {
    const box = vm();
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: "ses_1", deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: box.exec, follow: box.follow, ...clock() }));
    await box.until(() => box.follows.length === 1);
    box.current().push(E(20, { type: "call", id: "toolu_1" }), S(false, null, 20));
    const done = await run;
    expect(done.status).toBe("failed");
    expect(done.cutOff).toBe(true);
    expect(done.error).toContain("it stopped without an exit code");
    // One that ended by itself, with its own exit code, was not cut off.
    const ended = vm();
    const own = at(runAgent(CLAUDE, { model, prompt: "x", session: "ses_1", deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: ended.exec, follow: ended.follow, ...clock() }));
    await ended.until(() => ended.follows.length === 1);
    ended.current().push(E(20, { type: "error", message: "Claude Code ended with an error" }), S(false, 1, 20));
    expect((await own).cutOff).toBeUndefined();
  });

  test("the run loop takes its own session up again, once, on the same model, told its last run was cut off; cut off again, it goes on as any failure", async () => {
    const box = vm();
    const events: RunEvent[] = [];
    const done = runLoop(
      { goal: "Write the parser", environment: "a stand-in VM", plan: "1. Write it.\nDone when: its test passes.", agent: { driver: CLAUDE, models: [OWN_SIGN_IN], workdir: "/work/repo" } },
      { ask: async (role) => ({ text: "PASS\nIt parses.", model: `stand-in/${role}` }), exec: box.exec, follow: box.follow, emit: (event) => events.push(event), ...clock() },
    );
    await box.until(() => box.follows.length === 1);
    box.current().push(E(20, { type: "session", id: "ses_cut" }), E(40, { type: "call", id: "toolu_1" }), S(false, null, 40));
    await box.until(() => box.follows.length === 2);
    box.current().push(E(80, { type: "text", text: "Done: it parses." }), S(false, 0, 80));
    const outcome = await done;
    expect(outcome.status).toBe("done");
    const launches = box.commands.filter((command) => command.startsWith("mkdir -p /work/.agent"));
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain("--session '\\''ses_cut'\\'' --cut-off");
    const second = Buffer.from(launches[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toBe("Your last run was cut off before it ended (its process stopped). Continue the run from where you left off.");
    expect(events.find((event) => event.type === "retry")).toMatchObject({ role: "engineer", error: "its own sign-in: its run was cut off before it ended, so its own session is taken up again" });
    // Cut off twice running: the second is a failure as any is (here, its only model: it gives up, said so).
    const twice = vm();
    const again = runLoop(
      { goal: "Write the parser", environment: "a stand-in VM", plan: "1. Write it.\nDone when: its test passes.", agent: { driver: CLAUDE, models: [OWN_SIGN_IN], workdir: "/work/repo" } },
      { ask: async (role) => ({ text: "PASS\nIt parses.", model: `stand-in/${role}` }), exec: twice.exec, follow: twice.follow, ...clock() },
    );
    await twice.until(() => twice.follows.length === 1);
    twice.current().push(E(20, { type: "session", id: "ses_cut" }), S(false, null, 20));
    await twice.until(() => twice.follows.length === 2);
    twice.current().push(S(false, null, 20));
    expect((await again).status).toBe("gave-up");
    expect(twice.commands.filter((command) => command.startsWith("mkdir -p /work/.agent"))).toHaveLength(2);
  });
});

describe("your words, told as it works", () => {
  const STEER = "The owner says, while you work: use the new schema.";

  test("told on its input by an id of the node's, as one line; queued and taken said back; nothing is untold", async () => {
    const box = vm();
    const time = clock();
    let waiting = [STEER];
    const seen: unknown[] = [];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => waiting.splice(0), steer: () => { throw new Error("a live run is never ended for a steer"); } }, { exec: box.exec, follow: box.follow, ...time, event: (event) => event.type === "steer" && seen.push(event) }));
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
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0) }, { exec: late.exec, follow: late.follow, ...clock() }));
    await late.until(() => late.told.length === 1);
    const id = (late.told[0] as { id: string }).id;
    late.current().push(E(20, { type: "steer", id, state: "late" }), S(false, 0, 20));
    expect((await run).untold).toEqual([STEER]);
    // (A run whose input no one reads: its bridge has ended. Told nothing, the words come back all the same.)
    const gone = vm({ tell: 3 });
    once = [STEER];
    const ended = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0) }, { exec: gone.exec, follow: gone.follow, ...clock() }));
    await gone.until(() => gone.told.length === 1);
    gone.current().push(S(false, 0, 0));
    expect((await ended).untold).toEqual([STEER]);
  });

  test("a message longer than a line its bridge takes whole is never sent cut: said late, it comes back untold", async () => {
    const box = vm();
    const long = `The owner says, while you work: ${"x".repeat(70_000)}`;
    let once = [long];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0) }, { exec: box.exec, follow: box.follow, ...clock() }));
    await box.until(() => box.follows.length === 1);
    await Bun.sleep(20);
    box.current().push(S(false, 0, 0));
    expect((await run).untold).toEqual([long]);
    expect(box.told).toEqual([]);
    once = [];
  });

  test("said back taken, then late (a second word of its bridge's): taken stays; only words of the node's are kept", async () => {
    const box = vm();
    let once = [STEER];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work", steers: async () => once.splice(0) }, { exec: box.exec, follow: box.follow, ...clock() }));
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

  test("stopped by you: its interrupt goes on the way that stays open once the work's own commands are refused, as its cleanup does", async () => {
    const box = vm();
    const stopper = new AbortController();
    // (As a node's is: once the work has stopped, its own commands are refused.)
    const refusing = async (command: string, timeout: number) => {
      if (stopper.signal.aborted) throw new Error("agent stopped");
      return box.exec(command);
    };
    const stops: string[] = [];
    const run = at(runAgent(CLAUDE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec: refusing, tellStop: async (command) => (stops.push(command), box.exec(command)), stopAgent: async () => void stops.push("cleanup"), follow: box.follow, ...clock(), signal: stopper.signal }));
    await box.until(() => box.follows.length === 1);
    stopper.abort();
    expect((await run).status).toBe("stopped");
    expect(box.told).toEqual([{ stop: true }]);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toContain("os.O_NONBLOCK");
    expect(stops[1]).toBe("cleanup");
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
    expect(argv.slice(0, 3)).toEqual(["python3", "-I", "-c"]);
    expect(argv[3]).toBe(FOLLOW);
    expect(argv.slice(4)).toEqual(["1234", "60"]);
    expect(followArgv(-5)[4]).toBe("0");
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

  test("many long words at once are told one steer at a time: no line its bridge can't take whole", async () => {
    const box = vm();
    const waiting: RunSteer[] = [];
    const run = task(CLAUDE, box, waiting);
    await box.until(() => box.follows.length === 1);
    box.current().push(E(20, { type: "session", id: "ses_live" }), E(40, { type: "call", id: "call_1" }));
    // Twenty steers of 4,000 characters each, every one of two bytes: more than one line of 64 KiB can carry.
    for (let n = 0; n < 20; n++) waiting.push({ by: "owner", text: `${n} ${"é".repeat(3995)}` });
    await box.until(() => box.told.length === 20);
    const lines = box.commands.filter((command) => command.includes("os.O_NONBLOCK")).map((command) => Buffer.from(command.match(/ '([A-Za-z0-9+/=]+)'/)![1]!, "base64").length);
    expect(lines).toHaveLength(20);
    expect(Math.max(...lines)).toBeLessThan(64 * 1024);
    expect((box.told as { say: string }[]).map((said) => said.say.match(/^The owner says, while you work: (\d+) /)?.[1])).toEqual(Array.from({ length: 20 }, (_, n) => String(n)));
    box.current().push(E(60, { type: "tool", tool: "shell", input: "pytest", output: "ok", ok: true, id: "call_1" }), ...(box.told as { id: string }[]).map((said, n) => E(80 + n, { type: "steer", id: said.id, state: "taken" })), E(200, { type: "text", text: "Done." }), S(false, 0, 200));
    expect((await run.done).status).toBe("done");
  });

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

/*
 * An audit's steer is a steer as yours is (one rule for every steer): it never cuts a call its run is in. Told on a live
 * run's input, which takes it once its call has ended; a run that can't be told is ended between its calls, and its own
 * session is told in the run that follows.
 */
describe("an audit's steer, as every steer is", () => {
  const PLAN = "1. Write the parser.\nDone when: its test passes.";
  const AUDIT = "STEER\nWrite the parser's test first.";
  const SAID = "An independent audit of the work so far says: Write the parser's test first.";
  /** A run loop on a coding agent, audited: its first audit steers, then its work passes review. */
  const audited = (driver: AgentDriver, box: ReturnType<typeof vm>) => {
    const events: RunEvent[] = [];
    const answers = [AUDIT, "PASS\nIt parses."];
    // (Its clock moves on by each wait, a real millisecond at a time: a pause of the test's is seconds of the run's, never
    // the quarter of an hour after which a call it is in no longer holds a steer back.)
    let t = 1_000_000;
    const done = runLoop(
      { goal: "Write the parser", environment: "a stand-in VM", plan: PLAN, audit: true, agent: { driver, models: [OWN_SIGN_IN], workdir: "/work/repo" } },
      {
        ask: async (role) => ({ text: role === "reviewer" ? (answers.shift() ?? "ON\nOn its task.") : PLAN, model: `stand-in/${role}` }),
        exec: box.exec,
        follow: box.follow,
        emit: (event) => events.push(event),
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
          await Bun.sleep(1);
        },
      },
    );
    return { done, events };
  };
  /** Enough calls, each ended, that an audit is due; then one it is in. */
  const busy = (lines: (at: number, event: object) => string, from: number) => [...Array.from({ length: AUDIT_EVERY.steps + 1 }, (_, n) => lines(from + 10 * (n + 1), { type: "tool", tool: "shell", input: `step ${n}`, output: "ok", ok: true, id: `done_${n}` })), lines(from + 10 * (AUDIT_EVERY.steps + 2), { type: "call", id: "call_open" })];
  const stopped = (box: ReturnType<typeof vm>) => box.commands.some((command) => command.includes("\ncleanup(")) || box.told.some((told) => told.stop === true);
  const launches = (box: ReturnType<typeof vm>) => box.commands.filter((command) => command.startsWith("mkdir -p /work/.agent"));

  for (const driver of [CLAUDE, CODEX]) {
    test(`${driver.title}: told on its input, never stopped; it takes the words once its call has ended`, async () => {
      const box = vm();
      const run = audited(driver, box);
      await box.until(() => box.follows.length === 1);
      box.current().push(E(10, { type: "session", id: "ses_live" }), ...busy(E, 10));
      await box.until(() => box.told.length === 1);
      const [said] = box.told as { say?: string; id?: string; stop?: boolean }[];
      expect(said!.stop).toBeUndefined();
      expect(said!.say).toBe(`${SAID}\nTake that up from where you are.`);
      expect(stopped(box)).toBe(false);
      box.current().push(E(1000, { type: "tool", tool: "shell", input: "pytest", output: "ok", ok: true, id: "call_open" }), E(1010, { type: "steer", id: said!.id, state: "taken" }), E(1020, { type: "text", text: "The test is written first now." }), S(false, 0, 1020));
      expect((await run.done).status).toBe("done");
      expect(launches(box)).toHaveLength(1);
      expect(run.events.filter((event) => event.type === "audit").map((event) => (event as { verdict: string }).verdict)).toEqual(["steer"]);
    });
  }

  test("a run that can't be told: its call ends first, then the run, and its own session is told in the run that follows", async () => {
    const stub: AgentDriver = { name: "stub", title: "Stub", kind: "openai", capabilities: { steer: "restart", streams: true, resumes: true, readsWindows: false }, check: "true", files: () => ({}), command: (_m, session) => `stub-agent${session ? ` --session ${session}` : ""}`, read: (line) => [JSON.parse(line) as AgentEvent] };
    const box = vm();
    const run = audited(stub, box);
    await box.until(() => box.follows.length === 1);
    box.current().push(E(10, { type: "session", id: "ses_stub" }), ...busy(E, 10));
    await box.until(() => run.events.some((event) => event.type === "audit"));
    // Its audit has steered, and the call it is in goes on: nothing is stopped while it does.
    await Bun.sleep(50);
    expect(stopped(box)).toBe(false);
    expect(launches(box)).toHaveLength(1);
    box.current().push(E(1000, { type: "tool", tool: "shell", input: "pytest", output: "ok", ok: true, id: "call_open" }));
    await box.until(() => box.follows.length === 2);
    expect(stopped(box)).toBe(true);
    const second = Buffer.from(launches(box)[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toContain(SAID);
    expect(launches(box)[1]).toContain("stub-agent --session ses_stub");
    box.current().push(E(1100, { type: "text", text: "The test is written first now." }), S(false, 0, 1100));
    expect((await run.done).status).toBe("done");
  });
});

/*
 * A plan's windows as its tool says them, and the way on when it is spent (I15 step 8): each window is said on the run's
 * events, its own sign-in's marked so; a task whose every model is spent, its plan saying when it resets, rests until then
 * (its caller takes it up again, in its own session); and an own sign-in that is spent goes last on the next task.
 */
describe("a plan's windows, and the way on when it is spent", () => {
  const NOW = Date.UTC(2026, 10, 26, 21, 45);
  test("when a spent run can go on: the window its tool refused, else the reset its bridge said, if it is ahead and within a month", () => {
    expect(spentReset("Codex's allowance is spent; it resets 2026-11-26 23:45 UTC", 0, NOW)).toBe(Date.UTC(2026, 10, 26, 23, 45));
    expect(spentReset("Claude Code's allowance is spent (it needs usage credits to go on); it resets 2026-11-27 01:00 UTC", 0, NOW)).toBe(Date.UTC(2026, 10, 27, 1, 0));
    // A window it refused says it whole, and comes first.
    expect(spentReset("Claude Code ended with an error (rate_limit): API Error: Request rejected (429)", NOW + 3_600_000, NOW)).toBe(NOW + 3_600_000);
    // Not spent, a reset gone by, one more than a month off, or no reset said: nothing to rest for.
    expect(spentReset("Codex stopped: unexpected status 404", 0, NOW)).toBeNull();
    expect(spentReset("Codex's allowance is spent; it resets 2026-11-26 20:00 UTC", 0, NOW)).toBeNull();
    expect(spentReset("Codex's allowance is spent; it resets 2027-03-01 00:00 UTC", 0, NOW)).toBeNull();
    expect(spentReset("Claude Code's allowance is spent", 0, NOW)).toBeNull();
  });

  test("a task whose every model is spent, its plan saying when it resets, rests until then; each window its tool said is on its events", async () => {
    const box = vm();
    const events: RunEvent[] = [];
    const time = clock();
    const reset = time.now() + 2 * 3_600_000;
    const done = runLoop(
      { goal: "Write the parser", environment: "a stand-in VM", plan: "1. Write it.\nDone when: its test passes.", agent: { driver: CLAUDE, models: [OWN_SIGN_IN], workdir: "/work/repo" } },
      { ask: async (role) => ({ text: "PASS", model: `stand-in/${role}` }), exec: box.exec, follow: box.follow, emit: (event) => events.push(event), ...time },
    );
    await box.until(() => box.follows.length === 1);
    box.current().push(
      E(20, { type: "window", name: "five_hour", status: "rejected", resetsAt: reset }),
      E(40, { type: "window", name: "seven_day", status: "allowed", usedPercent: 41, resetsAt: reset + 86_400_000 }),
      E(60, { type: "error", message: "Claude Code's allowance is spent; it resets 2026-11-27 00:00 UTC" }),
      S(false, 1, 60),
    );
    const outcome = await done;
    expect(outcome.status).toBe("gave-up");
    // (Its tool's window says its reset whole: that, not the words.)
    expect(outcome.rest).toEqual({ until: reset, why: "Claude Code's allowance is spent; it resets 2026-11-27 00:00 UTC" });
    expect(events.filter((event) => event.type === "window")).toEqual([
      { type: "window", model: "its own sign-in", own: true, name: "five_hour", status: "rejected", resetsAt: reset },
      { type: "window", model: "its own sign-in", own: true, name: "seven_day", status: "allowed", usedPercent: 41, resetsAt: reset + 86_400_000 },
    ]);
    // A run that failed for another reason leaves no rest: it gives up as before.
    const other = vm();
    const failed = runLoop(
      { goal: "Write the parser", environment: "a stand-in VM", plan: "1. Write it.\nDone when: its test passes.", agent: { driver: CLAUDE, models: [OWN_SIGN_IN], workdir: "/work/repo" } },
      { ask: async (role) => ({ text: "PASS", model: `stand-in/${role}` }), exec: other.exec, follow: other.follow, ...clock() },
    );
    await other.until(() => other.follows.length === 1);
    other.current().push(E(20, { type: "error", message: "Claude Code ended with an error (error_max_turns)" }), S(false, 1, 20));
    expect((await failed).rest).toBeUndefined();
  });

  test("its own sign-in spent: the roster's models first, and it last, said with its reset; otherwise first, as ever", () => {
    const probe = { exitCode: 0, stdout: JSON.stringify({ type: "status", installed: true, signedIn: true, method: "claude.ai" }) };
    const roster = [{ provider: "anthropic", model: "claude-opus-5-5" }];
    expect(harnessReadiness(CLAUDE, probe, roster).models).toEqual([OWN_SIGN_IN, ...roster]);
    const spent = harnessReadiness(CLAUDE, probe, roster, [], "engineer", false, { until: Date.UTC(2026, 10, 26, 23, 45) });
    expect(spent.models).toEqual([...roster, OWN_SIGN_IN]);
    expect(spent.on).toBe("anthropic/claude-opus-5-5 through the gateway: its own sign-in in this VM (claude.ai) is spent until 23:45 UTC, and goes last");
    // With nothing else to run on, it is still the one to try: there is no other account of the vendor's to move to.
    expect(harnessReadiness(CLAUDE, probe, [], [], "engineer", false, { until: Date.UTC(2026, 10, 26, 23, 45) }).models).toEqual([OWN_SIGN_IN]);
  });
});
