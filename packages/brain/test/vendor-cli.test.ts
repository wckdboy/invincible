import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecResult, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { AGENTS, CLAUDE, CODEX, OWN_SIGN_IN, agentModelName, chooseAgentModels, type AgentDriver } from "../src/agents.ts";
import { ENGRAM_BIN, engramArgv } from "../src/engram.ts";
import { GatewayTokens, handleGateway } from "../src/gateway.ts";
import { type QuestEvent, type QuestRole, runQuest } from "../src/quest.ts";
import { CLAUDE_BRIDGE, CODEX_BRIDGE } from "../src/vendor-cli.ts";

/*
 * The vendors' own CLIs as harnesses: Claude Code and Codex, each run headless by a bridge inside the
 * knight's VM. Nothing here runs a real CLI: each test puts a stand-in executable of the same name on
 * PATH. The two fixtures are the streams the real CLIs printed on 13 November 2026 (claude 2.1.311,
 * codex 0.167.2) for one short prompt, with every id, path and account value replaced; the other
 * streams (a spent allowance, a failed tool, a very long line) are written here on those shapes and
 * the vendors' documented fields, and were not recorded.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PYTHON = Bun.which("python3")!;
const SESSION = "00000000-0000-4000-8000-000000000001";
const FIXTURE = {
  claude: readFileSync(new URL("./fixtures/claude-code-2.1.311.jsonl", import.meta.url), "utf8"),
  codex: readFileSync(new URL("./fixtures/codex-0.167.2.jsonl", import.meta.url), "utf8"),
};
/** Every variable Galahad's gateway lease puts in a knight's environment. */
const GATEWAY_VARS = ["GALAHAD_GATEWAY", "GALAHAD_TOKEN", "GALAHAD_REPO_URL", "GALAHAD_SEARCH", "GALAHAD_WORLD", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
/** What a sign-in looks like, so a test can say it never got anywhere (fake, like every key here). */
const FAKE_SIGN_IN = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
/** The other vendor's is a signed three-part token with no prefix of its own (fake: its parts say so). */
const FAKE_SIGNED_TOKEN = "eyJGQUtFIjoibm90LWEtdG9rZW4ifQ.eyJGQUtFIjoibm90LWEtdG9rZW4ifQ.RkFLRS1ub3QtYS1zaWduYXR1cmU";

const COMMON = String.raw`import json, os, signal, sys, time
from pathlib import Path
here = Path(__file__).resolve().parent
def record(item):
    with (here / "trace.jsonl").open("a") as f:
        f.write(json.dumps(item) + "\n")
def out(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)
def terminated(*_):
    (here / "terminated").write_text("yes")
    sys.exit(143)
signal.signal(signal.SIGTERM, terminated)
args = sys.argv[1:]
record({"called": args})
signed = (here / "signed-in").exists()
fixture = [json.loads(line) for line in (here / "fixture.jsonl").read_text().splitlines()]
SESSION = "${SESSION}"
`;

// Claude Code 2.1.311's flags and stream-json shapes.
const CLAUDE_STAND_IN = `#!${PYTHON}
${COMMON}${String.raw`
if args == ["--version"]:
    print("2.1.311 (Claude Code)")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    record({"asked": "status", "env": dict(os.environ)})
    if signed:
        # As the real command prints it: who is signed in, to what. None of this may leave the VM.
        print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "knight@example.invalid", "orgId": "org-FAKE-0000", "orgName": "Fake Org Ltd", "subscriptionType": "max"}, indent=2))
        sys.exit(0)
    print(json.dumps({"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty"}, indent=2))
    sys.exit(1)
prompt = sys.stdin.read()
record({"argv": args, "env": dict(os.environ), "prompt": prompt})
init, call, limit, returned, said, done = fixture
resumed = args[args.index("--resume") + 1] if "--resume" in args else None
if resumed is not None and resumed != SESSION:
    print("No conversation found with session ID: " + resumed, file=sys.stderr)
    sys.exit(1)
def assistant(content, **more):
    return dict(call, message=dict(call["message"], content=content), **more)
def tool_result(ident, content, is_error=False):
    return dict(returned, message={"role": "user", "content": [{"tool_use_id": ident, "type": "tool_result", "content": content, "is_error": is_error}]})
def rejected(**more):
    return dict(limit, rate_limit_info=dict(limit["rate_limit_info"], status="rejected", **more))
def failed(text):
    return dict(done, is_error=True, subtype="error_during_execution", result=text, api_error_status=429)
if prompt == "long":
    out(init)
    out(assistant([{"type": "tool_use", "id": "toolu_FAKE000009", "name": "Read", "input": {"file_path": "/work/big.txt"}}]))
    out(tool_result("toolu_FAKE000009", "é" * 300000))
    out(assistant([{"type": "text", "text": "y" * 100000}]))
    out(dict(done, result="y" * 100000))
elif prompt == "half a character":
    # A tool that cuts its output by UTF-16 units can leave half of a pair, which JSON carries as an escape.
    out(init)
    print(json.dumps(assistant([{"type": "text", "text": "cut here " + chr(0xD83D)}])), flush=True)
    print("{not json", flush=True)
    print(json.dumps(["not", "an", "event"]), flush=True)
    print(json.dumps(dict(returned, message={"role": "user", "content": "a plain message"})), flush=True)
    print(json.dumps(dict(done, result="cut here " + chr(0xD83D))), flush=True)
elif prompt == "spent before any reply":
    out(init)
    out(rejected())
    time.sleep(30)
elif prompt == "spent midway":
    out(init); out(call); out(returned)
    out(rejected(errorCode="credits_required"))
    out(failed("You've hit your session limit · resets 3:45pm"))
    sys.exit(1)
elif prompt == "limit said only in the result":
    out(init)
    out(assistant([{"type": "text", "text": "You've hit your weekly limit · resets Mon 12:00am"}], error="rate_limit"))
    out(failed("You've hit your weekly limit · resets Mon 12:00am"))
    sys.exit(1)
elif prompt == "out of turns":
    out(init); out(call); out(returned)
    out(dict(done, is_error=False, subtype="error_max_turns", result=None))
elif prompt == "a tool fails":
    out(init)
    out(assistant([{"type": "tool_use", "id": "toolu_FAKE000008", "name": "Bash", "input": {"command": "cat /work/.secrets"}}]))
    out(tool_result("toolu_FAKE000008", [{"type": "text", "text": "token=${FAKE_SIGN_IN}"}, {"type": "text", "text": "${FAKE_SIGNED_TOKEN}"}, {"type": "text", "text": "exit 1"}], True))
    out(assistant([{"type": "text", "text": "It printed ${FAKE_SIGNED_TOKEN} and stopped."}]))
    out(dict(done, result="It printed ${FAKE_SIGNED_TOKEN} and stopped."))
else:
    for event in fixture:
        out(event)
`}`;

// Codex 0.167.2's flags and --json shapes.
const CODEX_STAND_IN = `#!${PYTHON}
${COMMON}${String.raw`
if args == ["--version"]:
    print("codex-cli 0.167.2")
    sys.exit(0)
if args[:2] == ["login", "status"]:
    record({"asked": "status", "env": dict(os.environ)})
    # As the real command prints it: on stderr.
    if (here / "api-key").exists():
        print("Logged in using an API key - sk-fake***0000", file=sys.stderr)
        sys.exit(0)
    if signed:
        print("Logged in using ChatGPT", file=sys.stderr)
        sys.exit(0)
    print("Not logged in", file=sys.stderr)
    sys.exit(1)
if args[0] != "exec":
    sys.exit(2)
prompt = sys.stdin.read()
record({"argv": args, "env": dict(os.environ), "prompt": prompt})
started, turn, hello, running, ran, said, completed = fixture
if args[1] == "resume" and SESSION not in args:
    print("Error: no rollout found for that session", file=sys.stderr)
    sys.exit(1)
LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 3:45 PM."
if prompt == "long":
    out(started); out(turn)
    out(dict(ran, item=dict(ran["item"], aggregated_output="é" * 300000)))
    out(dict(said, item=dict(said["item"], text="y" * 100000)))
    out(completed)
elif prompt == "spent":
    out(started); out(turn)
    out({"type": "error", "message": LIMIT})
    out({"type": "turn.failed", "error": {"message": LIMIT}})
    sys.exit(1)
elif prompt == "spent until another day":
    # As 0.169.0 said it (21 Nov 2026, against a stand-in for its plan's endpoint).
    again = "You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 23rd, 2026 8:11 PM."
    out(started); out(turn)
    out({"type": "error", "message": again})
    out({"type": "turn.failed", "error": {"message": again}})
    sys.exit(1)
elif prompt == "spent midway":
    out(started); out(turn); out(hello); out(ran)
    out({"type": "turn.failed", "error": {"message": LIMIT}})
    sys.exit(1)
elif prompt == "an error and nothing after it":
    out(started); out(turn)
    out({"type": "error", "message": "unexpected status 404 Not Found: no such route /responses"})
elif prompt == "reconnects":
    out(started); out(turn)
    out({"type": "error", "message": "Reconnecting... 1/5"})
    # As 0.169.0 says one with its reason (21 Nov 2026, against a stand-in).
    out({"type": "error", "message": "Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)"})
    out(hello); out(running); out(ran); out(said); out(completed)
elif prompt == "edits and a failing command":
    out(started); out(turn)
    out({"type": "item.completed", "item": {"id": "item_1", "type": "file_change", "changes": [{"path": "/work/repo/calc.py", "kind": "update"}, {"path": "/work/repo/test_calc.py", "kind": "add"}], "status": "completed"}})
    out(dict(ran, item=dict(ran["item"], command="/bin/bash -lc 'cat /work/.secrets'", aggregated_output="token=${FAKE_SIGN_IN}\n${FAKE_SIGNED_TOKEN}\n", exit_code=1, status="failed")))
    out(dict(said, item=dict(said["item"], text="It printed ${FAKE_SIGNED_TOKEN} and stopped.")))
    out(completed)
else:
    for event in fixture:
        out(event)
`}`;

const TOOLS = {
  claude: { driver: CLAUDE, bridge: CLAUDE_BRIDGE, script: "/work/.agent/claude-code.py", standIn: CLAUDE_STAND_IN, name: "Claude Code" },
  codex: { driver: CODEX, bridge: CODEX_BRIDGE, script: "/work/.agent/codex.py", standIn: CODEX_STAND_IN, name: "Codex" },
};

/**
 * A knight's VM in miniature: the bridge, the stand-in CLI on PATH (or none), its sign-in state, and a gateway
 * lease. `engram`: the bridge as its driver writes it for a task that has the VM's notes store, under that project.
 */
function vm(tool: keyof typeof TOOLS, options: { installed?: boolean; signedIn?: boolean; apiKey?: boolean; engram?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `galahad-${tool}-`));
  dirs.push(dir);
  const bin = join(dir, "bin"), home = join(dir, "home"), work = join(dir, "work");
  for (const made of [bin, home, work]) mkdirSync(made);
  writeFileSync(join(dir, "bridge.py"), options.engram ? TOOLS[tool].driver.files([], options.engram)[TOOLS[tool].script]! : TOOLS[tool].bridge);
  if (options.installed !== false) {
    writeFileSync(join(bin, tool), TOOLS[tool].standIn);
    chmodSync(join(bin, tool), 0o700);
    writeFileSync(join(bin, "fixture.jsonl"), FIXTURE[tool]);
  }
  if (options.signedIn !== false) writeFileSync(join(bin, "signed-in"), "");
  if (options.apiKey) writeFileSync(join(bin, "api-key"), "");
  const lease = join(dir, "gateway.json");
  const fresh = { GALAHAD_GATEWAY: "http://192.0.2.1:7777/gw", GALAHAD_TOKEN: "gw_fake-fresh-lease", OPENAI_API_KEY: "gw_fake-fresh-lease", OPENAI_BASE_URL: "http://192.0.2.1:7777/gw/openai", ANTHROPIC_AUTH_TOKEN: "gw_fake-fresh-lease", ANTHROPIC_BASE_URL: "http://192.0.2.1:7777/gw/anthropic" };
  writeFileSync(lease, JSON.stringify(fresh), { mode: 0o600 });
  // What the VM's shell has: the owner's own settings, and every gateway variable (stale ones, as a container's are).
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8", OWNER_SET: "kept", ANTHROPIC_API_KEY: "fake-owner-key-in-this-vm", ...Object.fromEntries(GATEWAY_VARS.map((name) => [name, `http://192.0.2.2/stale-${name}`])) };
  const run = async (args: string[], prompt = "work") => {
    writeFileSync(join(dir, "prompt.md"), prompt);
    const proc = Bun.spawn([PYTHON, join(dir, "bridge.py"), "--prompt", join(dir, "prompt.md"), "--gateway-env", lease, ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const lines = stdout.split("\n").filter(Boolean);
    return { exit, stdout, stderr, lines, events: lines.flatMap((line) => TOOLS[tool].driver.read(line)) };
  };
  const trace = (): any[] => (existsSync(join(bin, "trace.jsonl")) ? readFileSync(join(bin, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  /** The runs the CLI was started for (not the questions about its sign-in). */
  const runs = () => trace().filter((item) => item.argv);
  return { dir, bin, env, fresh, run, trace, runs };
}

const OWN = ["--own"];
const CLAUDE_FLAGS = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
const CODEX_FLAGS = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];

describe("the vendors' own CLIs are harnesses", () => {
  test("the registry offers both, and each says which API its gateway models must speak", () => {
    expect(AGENTS.claude).toBe(CLAUDE);
    expect(AGENTS.codex).toBe(CODEX);
    expect([CLAUDE.kind, CODEX.kind, AGENTS.opencode!.kind, AGENTS.hermes!.kind]).toEqual(["anthropic", "openai", "openai", "openai"]);
    expect([CLAUDE.title, CODEX.title]).toEqual(["Claude Code", "Codex"]);
    expect(CLAUDE.files([])["/work/.agent/claude-code.py"]).toBe(CLAUDE_BRIDGE);
    expect(CODEX.files([])["/work/.agent/codex.py"]).toBe(CODEX_BRIDGE);
  });

  test("every command is valid shell whatever a name holds, and a run on its own sign-in names no provider or model", () => {
    for (const driver of [CLAUDE, CODEX]) {
      const hostile = driver.command({ provider: "p'; $(danger)", model: "a/b' model" }, "session'; x");
      expect(Bun.spawnSync(["bash", "-n", "-c", hostile]).exitCode).toBe(0);
      expect(Bun.spawnSync(["bash", "-n", "-c", driver.check]).exitCode).toBe(0);
      const own = driver.command(OWN_SIGN_IN, SESSION);
      expect(own).toContain(` --own --session '${SESSION}'`);
      expect(own).not.toMatch(/--provider|--model/);
      expect(driver.command({ provider: "anthropic", model: "claude-opus-5-5" }, null)).toContain("--provider 'anthropic' --model 'claude-opus-5-5'");
      expect(driver.read("not json")).toEqual([]);
      expect(driver.read('{"type":"tokens","input":-1,"output":1}')).toEqual([]);
    }
    expect(agentModelName(OWN_SIGN_IN)).toBe("its own sign-in");
    expect(agentModelName({ provider: "anthropic", model: "claude-opus-5-5" })).toBe("anthropic/claude-opus-5-5");
  });

  test("the roster's models for a harness are the ones that speak its API: the kind is the driver's to say", () => {
    const providers = [
      { id: "anthropic", kind: "anthropic", hasKey: true },
      { id: "orcarouter", kind: "openai", hasKey: true },
      { id: "claude-elsewhere", kind: "anthropic", hasKey: false },
    ];
    const engineer = ["anthropic/claude-opus-5-5", "orcarouter/gpt-6.1-sol", "claude-elsewhere/claude-opus-5-5", "anthropic/*", "anthropic/claude-sonnet-5-5"];
    expect(chooseAgentModels(engineer, providers, 3, CLAUDE.kind)).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }, { provider: "anthropic", model: "claude-sonnet-5-5" }]);
    expect(chooseAgentModels(engineer, providers, 3, CODEX.kind)).toEqual([{ provider: "orcarouter", model: "gpt-6.1-sol" }]);
    // Asked nothing, it chooses as it always did.
    expect(chooseAgentModels(engineer, providers)).toEqual([{ provider: "orcarouter", model: "gpt-6.1-sol" }]);
  });
});

describe("Claude Code, on its own sign-in", () => {
  test("a run: the session, a tool call paired with its result, its last words and what it spent", async () => {
    const box = vm("claude");
    const run = await box.run(OWN, "Fix it ‘now’");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(run.events).toEqual([
      { type: "session", id: SESSION },
      { type: "tool", tool: "Bash", input: "echo galahad-probe", output: "galahad-probe", ok: true },
      { type: "text", text: "done" },
      { type: "tokens", input: 4 + 14500 + 34948, output: 82 },
    ]);
    // (As recorded: the allowance was fine, with "overageStatus":"rejected" beside it. Only `status` says a run is refused.)
    expect(FIXTURE.claude).toContain('"overageStatus":"rejected"');
    const [started] = box.runs();
    // The vendor's own flags and nothing else; the message on stdin.
    expect(started.argv).toEqual(CLAUDE_FLAGS);
    expect(started.prompt).toBe("Fix it ‘now’");
  });

  test("it is never pointed at Galahad's gateway: every gateway variable is gone from its environment, and the rest is the VM's own", async () => {
    const box = vm("claude");
    await box.run(OWN);
    const [started] = box.runs();
    for (const name of GATEWAY_VARS) expect([name, started.env[name]]).toEqual([name, undefined]);
    expect(JSON.stringify(started.env)).not.toContain("gw_fake");
    expect(JSON.stringify(started.env)).not.toContain("192.0.2.");
    // What the owner set up in the VM is the tool's to read: nothing of it is taken away, and nothing is added.
    expect(started.env).toMatchObject({ OWNER_SET: "kept", HOME: box.env.HOME, ANTHROPIC_API_KEY: "fake-owner-key-in-this-vm" });
    const added = Object.keys(started.env).filter((name) => !(name in box.env));
    expect(added.filter((name) => !["__CF_USER_TEXT_ENCODING", "LC_CTYPE"].includes(name))).toEqual([]);
  });

  test("a resumed run continues the session it is given, and one the tool doesn't know is not replaced with a new one", async () => {
    const box = vm("claude");
    const resumed = await box.run([...OWN, "--session", SESSION], "continue");
    expect(resumed.exit).toBe(0);
    expect(resumed.events[0]).toEqual({ type: "session", id: SESSION });
    expect(box.runs()[0].argv).toEqual([...CLAUDE_FLAGS, "--resume", SESSION]);
    const unknown = await box.run([...OWN, "--session", "00000000-0000-4000-8000-00000000dead"], "continue");
    expect(unknown.exit).toBe(1);
    expect(unknown.events.filter((event) => event.type === "session")).toEqual([]);
    expect(unknown.events.at(-1)).toEqual({ type: "error", message: "Claude Code exited with 1 and no result" });
    // A session id is the tool's own word, and is never read as a flag.
    for (const flag of ["--session=--dangerously-skip-permissions", "--session=-c"]) expect((await box.run([...OWN, flag], "continue")).exit).toBe(1);
    expect(box.runs()).toHaveLength(2);
  });

  test("a failed tool call is shown as failed, with what it printed, and a secret in it is redacted", async () => {
    const run = await vm("claude").run(OWN, "a tool fails");
    expect(run.exit).toBe(0);
    const tool = run.events.find((event) => event.type === "tool")!;
    expect(tool).toMatchObject({ type: "tool", tool: "Bash", input: "cat /work/.secrets", ok: false });
    // (A sign-in a model made the tool print, in either vendor's form, goes no further than the VM.)
    expect(JSON.stringify(run.events)).not.toContain(FAKE_SIGN_IN);
    expect(JSON.stringify(run.events)).not.toContain(FAKE_SIGNED_TOKEN);
    expect(JSON.stringify(tool)).toContain("[redacted");
    expect(JSON.stringify(tool)).toContain("exit 1");
    expect(run.events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "It printed [redacted token] and stopped." }]);
  });

  test("a very long line is clipped whole: every line the bridge prints is JSON, and short enough that the poll never cuts one", async () => {
    const run = await vm("claude").run(OWN, "long");
    expect(run.exit).toBe(0);
    expect(run.lines.length).toBeGreaterThanOrEqual(4);
    for (const line of run.lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16_000);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const tool = run.events.find((event) => event.type === "tool")!;
    expect(tool).toMatchObject({ type: "tool", tool: "Read", input: JSON.stringify({ file_path: "/work/big.txt" }), ok: true });
    expect(tool.type === "tool" && tool.output.startsWith("ééé") && tool.output.endsWith("ééé")).toBe(true);
    const text = run.events.filter((event) => event.type === "text");
    // Its last words once, not again as the result.
    expect(text).toHaveLength(1);
    expect(text[0]!.type === "text" && text[0]!.text.startsWith("yyy")).toBe(true);
  });

  test("what the tool prints is data: half a character, a line that isn't JSON and an event that isn't one are passed over, and the run goes on", async () => {
    const run = await vm("claude").run(OWN, "half a character");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(run.events.map((event) => event.type)).toEqual(["session", "text", "tokens"]);
    expect(run.events[1]).toEqual({ type: "text", text: "cut here ?" });
  });

  test("a spent allowance ends the run as failed, with when it resets; a run that never got a reply leaves no session to continue", async () => {
    const box = vm("claude");
    const started = Date.now();
    const run = await box.run(OWN, "spent before any reply");
    // (The stand-in then waits, as a tool waiting for its window would: the bridge stops it.)
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(run.exit).toBe(1);
    expect(run.events).toEqual([{ type: "error", message: "Claude Code's allowance is spent; it resets 2026-01-01 04:00 UTC" }]);
    expect(existsSync(join(box.bin, "terminated"))).toBe(true);
  }, 20_000);

  test("spent in the middle of the work, the session stays to be continued on the next model", async () => {
    const run = await vm("claude").run(OWN, "spent midway");
    expect(run.exit).toBe(1);
    expect(run.events[0]).toEqual({ type: "session", id: SESSION });
    expect(run.events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(run.events.at(-1)).toEqual({ type: "error", message: "Claude Code's allowance is spent (it needs usage credits to go on); it resets 2026-01-01 04:00 UTC" });
  });

  test("a result that is an error ends the run as failed, in the tool's own words (a limit it names only there, with its reset)", async () => {
    const run = await vm("claude").run(OWN, "limit said only in the result");
    expect(run.exit).toBe(1);
    const last = run.events.at(-1)!;
    expect(last.type).toBe("error");
    expect(last.type === "error" && last.message).toBe("Claude Code ended with an error (rate_limit): You've hit your weekly limit · resets Mon 12:00am");
    // The tool's own notice of the failure is not its answer, and not a reply worth continuing.
    expect(run.events.filter((event) => event.type === "text" || event.type === "session")).toEqual([]);
    // A result of an error's kind is one, whatever its flag says and whatever the tool exits with.
    const turns = await vm("claude").run(OWN, "out of turns");
    expect(turns.exit).toBe(1);
    expect(turns.events.at(-1)).toEqual({ type: "error", message: "Claude Code ended with an error (error_max_turns)" });
  });

  test("not signed in: an own run says so and how to mend it, and the tool is never started", async () => {
    const box = vm("claude", { signedIn: false });
    const run = await box.run(OWN);
    expect(run.exit).toBe(1);
    expect(run.events).toEqual([{ type: "error", message: "Claude Code is not signed in in this VM; sign it in there (claude auth login)" }]);
    expect(box.runs()).toEqual([]);
  });

  test("missing: a run says the owner installs it, and nothing is fetched", async () => {
    const box = vm("claude", { installed: false });
    const run = await box.run(OWN);
    expect(run.exit).toBe(1);
    expect(run.events).toEqual([{ type: "error", message: "Claude Code is not installed in this VM; its owner installs it there (Galahad never does)" }]);
    expect(readdirSync(box.bin)).toEqual(["signed-in"]);
  });
});

describe("Claude Code, through the gateway", () => {
  test("a keyed roster model: the tool's own documented variables point it at that provider, on this VM's fresh lease", async () => {
    const box = vm("claude", { signedIn: false });
    const run = await box.run(["--provider", "anthropic", "--model", "claude-opus-5-5", "--session", SESSION]);
    expect(run.exit).toBe(0);
    const [started] = box.runs();
    expect(started.argv).toEqual([...CLAUDE_FLAGS, "--model", "claude-opus-5-5", "--resume", SESSION]);
    expect(started.env.ANTHROPIC_BASE_URL).toBe("http://192.0.2.1:7777/gw/anthropic");
    expect(started.env.ANTHROPIC_AUTH_TOKEN).toBe("gw_fake-fresh-lease");
    // A key of the owner's own in the VM is not sent to the gateway beside its token.
    expect(started.env.ANTHROPIC_API_KEY).toBeUndefined();
    // It is asked nothing about a sign-in: this run is not on one.
    expect(box.trace().filter((item) => item.asked)).toEqual([]);
  });

  test("a lease that isn't whole stops the run before the tool starts; so does a provider or model that would read as a flag", async () => {
    const box = vm("claude");
    writeFileSync(join(box.dir, "gateway.json"), '{"GALAHAD_TOKEN":"gw_fake-incomplete"}');
    const incomplete = await box.run(["--provider", "anthropic", "--model", "claude-opus-5-5"]);
    expect(incomplete.exit).toBe(1);
    expect(incomplete.stdout).toContain("gateway environment file is incomplete");
    writeFileSync(join(box.dir, "gateway.json"), JSON.stringify(box.fresh));
    expect((await box.run(["--provider", "anthropic", "--model=--dangerously-skip-permissions"])).exit).toBe(1);
    expect((await box.run(["--provider", "../x", "--model", "m"])).exit).toBe(1);
    expect(box.runs()).toEqual([]);
  });
});

describe("Codex, on its own sign-in", () => {
  test("a run: the session, a command paired with its output, its last words and what it spent", async () => {
    const box = vm("codex");
    const run = await box.run(OWN, "Fix it ‘now’");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(run.events).toEqual([
      { type: "session", id: SESSION },
      { type: "text", text: "I’ll run the command once." },
      { type: "tool", tool: "shell", input: "/bin/bash -lc 'echo galahad-probe'", output: "galahad-probe\n", ok: true },
      { type: "text", text: "done" },
      { type: "tokens", input: 45951, output: 49 },
    ]);
    const [started] = box.runs();
    expect(started.argv).toEqual(["exec", ...CODEX_FLAGS, "-"]);
    expect(started.prompt).toBe("Fix it ‘now’");
    for (const name of GATEWAY_VARS) expect([name, started.env[name]]).toEqual([name, undefined]);
    expect(JSON.stringify(started.env)).not.toContain("gw_fake");
    expect(started.env).toMatchObject({ OWNER_SET: "kept", HOME: box.env.HOME });
    const added = Object.keys(started.env).filter((name) => !(name in box.env));
    expect(added.filter((name) => !["__CF_USER_TEXT_ENCODING", "LC_CTYPE"].includes(name))).toEqual([]);
  });

  test("a resumed run is `codex exec resume <id>`, and an unknown session is not replaced with a new one", async () => {
    const box = vm("codex");
    const resumed = await box.run([...OWN, "--session", SESSION], "continue");
    expect(resumed.exit).toBe(0);
    expect(box.runs()[0].argv).toEqual(["exec", "resume", ...CODEX_FLAGS, SESSION, "-"]);
    const unknown = await box.run([...OWN, "--session", "00000000-0000-4000-8000-00000000dead"], "continue");
    expect(unknown.exit).toBe(1);
    expect(unknown.events).toEqual([{ type: "error", message: "Codex exited with 1 and no result" }]);
  });

  test("edits are shown as what changed, a failing command as failed, and a secret in its output is redacted", async () => {
    const run = await vm("codex").run(OWN, "edits and a failing command");
    expect(run.exit).toBe(0);
    const tools = run.events.filter((event) => event.type === "tool");
    expect(tools[0]).toEqual({ type: "tool", tool: "edit", input: "update /work/repo/calc.py\nadd /work/repo/test_calc.py", output: "", ok: true });
    expect(tools[1]).toMatchObject({ tool: "shell", input: "/bin/bash -lc 'cat /work/.secrets'", ok: false });
    expect(JSON.stringify(run.events)).not.toContain(FAKE_SIGN_IN);
    expect(JSON.stringify(run.events)).not.toContain(FAKE_SIGNED_TOKEN);
    expect(JSON.stringify(tools[1])).toContain("[redacted");
    expect(run.events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "It printed [redacted token] and stopped." }]);
  });

  test("a very long line is clipped whole", async () => {
    const run = await vm("codex").run(OWN, "long");
    expect(run.exit).toBe(0);
    for (const line of run.lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16_000);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const tool = run.events.find((event) => event.type === "tool")!;
    expect(tool.type === "tool" && tool.output.startsWith("ééé") && tool.output.length < 5000).toBe(true);
    expect(run.events.some((event) => event.type === "text" && event.text.startsWith("yyy"))).toBe(true);
  });

  test("a spent allowance (turn.failed, error) ends the run as failed, said as Claude Code's is, with when it resets in UTC", async () => {
    // Its words give a time by the VM's clock: here an hour ahead of UTC (a POSIX zone, which needs no zone database).
    const box = vm("codex");
    box.env.TZ = "CET-1";
    const atStart = await box.run(OWN, "spent");
    expect(atStart.exit).toBe(1);
    // Nothing was answered: there is no session to continue.
    expect(atStart.events.map((event) => event.type)).toEqual(["error"]);
    const said = atStart.events[0]!;
    expect(said.type === "error" && said.message).toMatch(/^Codex's allowance is spent; it resets \d{4}-\d{2}-\d{2} 14:45 UTC$/);
    // Another day's reset, in 0.169.0's words (its apostrophe curly), and without the offers around it.
    const later = await box.run(OWN, "spent until another day");
    expect(later.events).toEqual([{ type: "error", message: "Codex's allowance is spent; it resets 2026-11-23 19:11 UTC" }]);
    const midway = await vm("codex").run(OWN, "spent midway");
    expect(midway.exit).toBe(1);
    expect(midway.events[0]).toEqual({ type: "session", id: SESSION });
    expect(midway.events.at(-1)!.type).toBe("error");
  });

  test("an error with nothing after it is a failure even if the tool exits 0; one the tool recovers from is not", async () => {
    const dead = await vm("codex").run(OWN, "an error and nothing after it");
    expect(dead.exit).toBe(1);
    expect(dead.events.at(-1)).toEqual({ type: "error", message: "Codex stopped: unexpected status 404 Not Found: no such route /responses" });
    const recovered = await vm("codex").run(OWN, "reconnects");
    expect(recovered.exit).toBe(0);
    expect(recovered.events.at(-1)).toEqual({ type: "tokens", input: 45951, output: 49 });
    // Each reconnection is a retry on the trail (its reason where it gives one), so a run that waits isn't taken for one that hangs.
    expect(recovered.events.filter((event) => event.type === "retry")).toEqual([
      { type: "retry", attempt: 1, error: "reconnecting", waitMs: 0 },
      { type: "retry", attempt: 2, error: "exceeded retry limit, last status: 429 Too Many Requests", waitMs: 0 },
    ]);
  });

  test("not signed in, or missing: said plainly, and the tool is never started or fetched", async () => {
    const out = vm("codex", { signedIn: false });
    const unsigned = await out.run(OWN);
    expect(unsigned.exit).toBe(1);
    expect(unsigned.events).toEqual([{ type: "error", message: "Codex is not signed in in this VM; sign it in there (codex login --device-auth)" }]);
    expect(out.runs()).toEqual([]);
    const missing = await vm("codex", { installed: false }).run(OWN);
    expect(missing.exit).toBe(1);
    expect(missing.events).toEqual([{ type: "error", message: "Codex is not installed in this VM; its owner installs it there (Galahad never does)" }]);
  });
});

describe("Codex, through the gateway", () => {
  test("a keyed roster model: a model_providers entry on the Responses API, the bearer read from this VM's fresh lease", async () => {
    const box = vm("codex", { signedIn: false });
    const run = await box.run(["--provider", "orcarouter", "--model", "gpt-6.1-sol"]);
    expect(run.exit).toBe(0);
    const [started] = box.runs();
    expect(started.argv).toEqual([
      "exec", ...CODEX_FLAGS, "-m", "gpt-6.1-sol",
      "-c", 'model_provider="galahad"',
      "-c", 'model_providers.galahad.name="Galahad gateway"',
      "-c", 'model_providers.galahad.base_url="http://192.0.2.1:7777/gw/orcarouter"',
      "-c", 'model_providers.galahad.env_key="GALAHAD_TOKEN"',
      "-c", 'model_providers.galahad.wire_api="responses"',
      "-",
    ]);
    // The token is in the environment the entry names, never in an argument.
    expect(started.env.GALAHAD_TOKEN).toBe("gw_fake-fresh-lease");
    expect(JSON.stringify(started.argv)).not.toContain("gw_fake");
    expect(box.trace().filter((item) => item.asked)).toEqual([]);
  });
});

describe("what a tool says of its sign-in", () => {
  const status = async (tool: keyof typeof TOOLS, options: Parameters<typeof vm>[1] = {}) => {
    const box = vm(tool, options);
    const run = await box.run(["--status"]);
    return { box, run, told: TOOLS[tool].driver.signIn!.read(run.stdout) };
  };

  test("signed in or not, and the tool's word for how: nothing else of what its status command prints leaves the VM", async () => {
    const claude = await status("claude");
    expect(claude.run.exit).toBe(0);
    expect(JSON.parse(claude.run.stdout)).toEqual({ type: "status", installed: true, signedIn: true, method: "claude.ai" });
    expect(claude.told).toEqual({ signedIn: true, method: "claude.ai" });
    for (const told of ["knight@example.invalid", "org-FAKE-0000", "Fake Org", "max"]) expect(claude.run.stdout + claude.run.stderr).not.toContain(told);
    const codex = await status("codex");
    expect(JSON.parse(codex.run.stdout)).toEqual({ type: "status", installed: true, signedIn: true, method: "chatgpt" });
    expect(codex.told).toEqual({ signedIn: true, method: "chatgpt" });
    // (With an API key, Codex prints part of the key. Only the fixed word is passed on.)
    const keyed = await status("codex", { apiKey: true });
    expect(JSON.parse(keyed.run.stdout)).toEqual({ type: "status", installed: true, signedIn: true, method: "api-key" });
    expect(keyed.run.stdout + keyed.run.stderr).not.toContain("sk-fake");
  });

  test("the tool is asked as itself, not as the gateway's client: a gateway token is never taken for its sign-in", async () => {
    for (const tool of ["claude", "codex"] as const) {
      const { box } = await status(tool);
      const asked = box.trace().filter((item) => item.asked);
      expect(asked).toHaveLength(1);
      for (const name of GATEWAY_VARS) expect([tool, name, asked[0].env[name]]).toEqual([tool, name, undefined]);
    }
  });

  test("not signed in, and missing", async () => {
    for (const tool of ["claude", "codex"] as const) {
      const unsigned = await status(tool, { signedIn: false });
      expect([tool, unsigned.run.exit, JSON.parse(unsigned.run.stdout)]).toEqual([tool, 0, { type: "status", installed: true, signedIn: false }]);
      expect(unsigned.told).toEqual({ signedIn: false });
      const missing = await status(tool, { installed: false });
      expect([tool, missing.run.exit, JSON.parse(missing.run.stdout)]).toEqual([tool, 1, { type: "status", installed: false, signedIn: false }]);
      expect(missing.told).toEqual({ signedIn: false });
    }
  });

  test("what a VM prints is data: a status that isn't the bridge's own, or a method it never names, is no sign-in", () => {
    for (const driver of [CLAUDE, CODEX]) {
      const read = driver.signIn!.read;
      expect(read("")).toEqual({ signedIn: false });
      expect(read("command completed")).toEqual({ signedIn: false });
      expect(read('{"type":"status","installed":true,"signedIn":"yes"}')).toEqual({ signedIn: false });
      expect(read('{"type":"status","installed":true,"signedIn":true,"method":"knight@example.invalid"}')).toEqual({ signedIn: true });
      expect(read('{"type":"status","installed":true,"signedIn":true,"method":"x; rm -rf /"}')).toEqual({ signedIn: true });
      expect(read('noise\n{"type":"status","installed":true,"signedIn":true,"method":"api_key"}\n')).toEqual({ signedIn: true, method: "api_key" });
    }
  });
});

/*
 * The VM's notes store (engram.ts): each tool is given it by arguments of its own, the vendor's documented
 * ones, and starts the store's server itself. Nothing is written where a tool keeps its own configuration.
 */
describe("the vendors' tools and the notes store", () => {
  const MCP_FILE = "/work/.agent/engram-mcp.json";
  const CLAUDE_NOTES = ["--mcp-config", MCP_FILE];
  const CODEX_NOTES = [
    "-c", 'mcp_servers.engram.command="/opt/engram/bin/engram"',
    "-c", 'mcp_servers.engram.args=["mcp","--tools=mem_search,mem_get_observation,mem_save,mem_update","--project","you-project"]',
    "-c", 'mcp_servers.engram.env={ENGRAM_DATA_DIR="/work/.memory/engram",ENGRAM_NO_UPDATE_CHECK="1"}',
  ];

  test("Claude Code is pointed at a file of Galahad's own with --mcp-config: one stdio server, on every run, new or resumed, on its sign-in or through the gateway", async () => {
    const files = CLAUDE.files([], "you-project");
    expect(Object.keys(files)).toEqual(["/work/.agent/claude-code.py", MCP_FILE]);
    expect(JSON.parse(files[MCP_FILE]!)).toEqual({ mcpServers: { engram: { type: "stdio", command: ENGRAM_BIN, args: engramArgv("you-project").slice(1), env: { ENGRAM_DATA_DIR: "/work/.memory/engram", ENGRAM_NO_UPDATE_CHECK: "1" } } } });
    const box = vm("claude", { engram: "you-project" });
    const run = await box.run(OWN, "Fix it ‘now’");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    // What it reports is what it reports without the store.
    expect(run.events).toEqual((await vm("claude").run(OWN, "Fix it ‘now’")).events);
    await box.run([...OWN, "--session", SESSION], "continue");
    await box.run(["--provider", "anthropic", "--model", "claude-opus-5-5", "--session", SESSION]);
    expect(box.runs().map((started) => started.argv)).toEqual([
      [...CLAUDE_FLAGS, ...CLAUDE_NOTES],
      // (The flag takes every word up to the next flag: it is never the last thing before a session's id.)
      [...CLAUDE_FLAGS, ...CLAUDE_NOTES, "--resume", SESSION],
      [...CLAUDE_FLAGS, "--model", "claude-opus-5-5", ...CLAUDE_NOTES, "--resume", SESSION],
    ]);
    // Nothing of the store is put in the tool's own environment: the file says it all.
    for (const started of box.runs()) expect(Object.keys(started.env).filter((name) => name.startsWith("ENGRAM"))).toEqual([]);
    // On its sign-in it is still never pointed at the gateway.
    for (const name of GATEWAY_VARS) expect([name, box.runs()[0].env[name]]).toEqual([name, undefined]);
  });

  test("Codex is given three -c overrides of its own kind (a command, its arguments, its environment), on exec and on exec resume, beside the gateway's when it runs through it", async () => {
    expect(Object.keys(CODEX.files([], "you-project"))).toEqual(["/work/.agent/codex.py"]);
    const box = vm("codex", { engram: "you-project" });
    const run = await box.run(OWN, "Fix it ‘now’");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(run.events).toEqual((await vm("codex").run(OWN, "Fix it ‘now’")).events);
    await box.run([...OWN, "--session", SESSION], "continue");
    await box.run(["--provider", "orcarouter", "--model", "gpt-6.1-sol"]);
    const [fresh, resumed, gateway] = box.runs().map((started) => started.argv);
    expect(fresh).toEqual(["exec", ...CODEX_FLAGS, ...CODEX_NOTES, "-"]);
    expect(resumed).toEqual(["exec", "resume", ...CODEX_FLAGS, ...CODEX_NOTES, SESSION, "-"]);
    expect(gateway.slice(0, 2 + CODEX_FLAGS.length)).toEqual(["exec", ...CODEX_FLAGS, "-m"]);
    expect(gateway.filter((word: string) => word.startsWith("model_providers.galahad."))).toHaveLength(4);
    expect(gateway.slice(-7)).toEqual([...CODEX_NOTES, "-"]);
    // The token is still only in the environment, and nothing of the store is.
    expect(JSON.stringify(gateway)).not.toContain("gw_fake");
    for (const started of box.runs()) expect(Object.keys(started.env).filter((name) => name.startsWith("ENGRAM"))).toEqual([]);
  });

  test("with the store each tool is still only asked its version, whether it is signed in, and to do the work; its status question is the plain bridge's", async () => {
    for (const tool of ["claude", "codex"] as const) {
      const box = vm(tool, { engram: "you-project" });
      const status = await box.run(["--status"]);
      expect(JSON.parse(status.stdout)).toMatchObject({ type: "status", installed: true, signedIn: true });
      await box.run(OWN);
      const calls: string[][] = box.trace().filter((item) => item.called).map((item) => item.called);
      expect(calls.filter((call) => call.some((word) => /^(login|logout|update|upgrade|install|setup-token|mcp|plugin)$/.test(word)) && call.join(" ") !== "login status")).toEqual([]);
      const { driver, bridge, script } = TOOLS[tool];
      expect(driver.check).toBe(`python3 -c '${bridge.replace(/'/g, `'\\''`)}' --status`);
      const written = driver.files([], "you-project")[script]!;
      expect(written).not.toBe(bridge);
      expect(written).not.toMatch(/user.agent|urllib\.request|http\.client|\bsocket\b|\bcurl\b|\bwget\b/i);
      // The bridge as it was, with one part more: nothing of the plain one is changed.
      const main = bridge.indexOf("\ndef main():");
      expect(written.startsWith(bridge.slice(0, main))).toBe(true);
      expect(written.endsWith(bridge.slice(main))).toBe(true);
    }
  });
});

/** A sandbox that plays the background process for each launch in turn (as in agents.test.ts). */
function sandbox(script: { lines: object[]; exit: number }[]) {
  const launches: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });
    if (command.startsWith("mkdir -p /work/.agent")) {
      launches.push(command);
      return ok();
    }
    if (command.startsWith("python3 -c") && command.includes("d, off =")) {
      const played = script[launches.length - 1]!;
      return ok(JSON.stringify({ alive: false, exit: played.exit, next: launches.length * 100, lines: played.lines.map((line) => JSON.stringify(line)) }));
    }
    return ok(command.startsWith("stat") ? "0" : "");
  };
  const prompt = (launch: string) => Buffer.from(launch.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!, "base64").toString("utf8");
  return { exec, launches, prompt };
}

describe("a sign-in and the roster together", () => {
  const replies = (): Record<QuestRole, string[]> => ({ planner: ["1. Fix calc.py.\nDone when: the test passes."], engineer: [], reviewer: ["PASS"] });
  const models = [OWN_SIGN_IN, { provider: "anthropic", model: "claude-opus-5-5" }];
  const quest = async (driver: AgentDriver, box: ReturnType<typeof sandbox>, events: QuestEvent[]) => {
    const said = replies();
    return runQuest(
      { goal: "make the test pass", environment: "a sandbox", agent: { driver, models, minutes: 30, workdir: "/work/repo" } },
      { ask: async (role) => ({ text: said[role].shift()!, model: `test/${role}` }), exec: box.exec, emit: (event) => events.push(event), sleep: async () => {} },
    );
  };

  test("the sign-in goes first; its allowance spent before it answered, the roster's model starts the work afresh through the gateway", async () => {
    const box = sandbox([
      { lines: [{ type: "error", message: "Claude Code's allowance is spent; it resets 2026-01-01 04:00 UTC" }], exit: 1 },
      { lines: [{ type: "session", id: SESSION }, { type: "text", text: "The test passes now." }], exit: 0 },
    ]);
    const events: QuestEvent[] = [];
    expect((await quest(CLAUDE, box, events)).status).toBe("done");
    expect(box.launches).toHaveLength(2);
    expect(box.launches[0]).toContain("claude-code.py --own");
    expect(box.launches[0]).not.toContain("--provider");
    expect(box.launches[1]).toContain("claude-code.py --provider");
    expect(box.launches[1]).toContain("anthropic");
    expect(box.launches[1]).toContain("claude-opus-5-5");
    expect(box.launches[1]).not.toContain("--own");
    expect(box.launches[1]).not.toContain("--session");
    // No session came of the first run, so the second is given the whole quest, not "continue".
    expect(box.prompt(box.launches[1]!)).toBe(box.prompt(box.launches[0]!));
    expect(events.find((event) => event.type === "retry")).toMatchObject({ role: "engineer", attempt: 1, error: "its own sign-in: Claude Code's allowance is spent; it resets 2026-01-01 04:00 UTC\nit exited with 1" });
    for (const command of box.launches) expect(Bun.spawnSync(["bash", "-n", "-c", command]).stderr.toString()).toBe("");
  });

  test("spent midway, the roster's model continues the same session and is told why", async () => {
    const box = sandbox([
      { lines: [{ type: "session", id: SESSION }, { type: "tool", tool: "shell", input: "python3 test_calc.py", output: "AssertionError", ok: false }, { type: "error", message: "Codex stopped: You've hit your usage limit. Try again at 3:45 PM." }], exit: 1 },
      { lines: [{ type: "text", text: "The test passes now." }], exit: 0 },
    ]);
    const events: QuestEvent[] = [];
    expect((await quest(CODEX, box, events)).status).toBe("done");
    expect(box.launches[0]).toContain("codex.py --own");
    expect(box.launches[1]).toContain("codex.py --provider");
    expect(box.launches[1]).toContain(`--session`);
    expect(box.launches[1]).toContain(SESSION);
    const second = box.prompt(box.launches[1]!);
    expect(second).toContain("You've hit your usage limit");
    expect(second).toContain("you're now on anthropic/claude-opus-5-5");
    expect(events.some((event) => event.type === "thought" && event.model === "codex · anthropic/claude-opus-5-5")).toBe(true);
  });
});

describe("a subscription's sign-in never reaches Galahad", () => {
  test("no shipped source names where either tool keeps its sign-in: nothing reads, copies or moves one", () => {
    const kept = [".credentials.json", "CLAUDE_CODE_OAUTH", "auth.json", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
    const root = new URL("../../../", import.meta.url).pathname;
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "test" || name === "dist" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|py|sh)$/.test(name) && !name.endsWith(".test.ts")) sources.push(path);
      }
    };
    for (const dir of ["packages", "apps/web/src", "sandbox", "integrations"]) walk(join(root, dir));
    expect(sources.length).toBeGreaterThan(100);
    const found = sources.flatMap((path) => { const text = readFileSync(path, "utf8"); return kept.filter((name) => text.includes(name)).map((name) => `${path.slice(root.length)}: ${name}`); });
    expect(found).toEqual([]);
    // Nor do the bridges speak to anyone themselves, or say who the tool is: they start it and read it.
    for (const bridge of [CLAUDE_BRIDGE, CODEX_BRIDGE]) expect(bridge).not.toMatch(/user.agent|urllib\.request|http\.client|\bsocket\b|\bcurl\b|\bwget\b/i);
  });

  test("the tool is only ever asked its version, whether it is signed in, and to do the work: never to install, update, sign in or sign out", async () => {
    const asked: Record<keyof typeof TOOLS, (call: string[]) => boolean> = {
      claude: (call) => call.join(" ") === "--version" || call.join(" ") === "auth status" || call.slice(0, CLAUDE_FLAGS.length).join(" ") === CLAUDE_FLAGS.join(" "),
      codex: (call) => call.join(" ") === "--version" || call.join(" ") === "login status" || call[0] === "exec",
    };
    for (const tool of ["claude", "codex"] as const) {
      const box = vm(tool);
      await box.run(["--status"]);
      await box.run(OWN);
      await box.run([...OWN, "--session", SESSION]);
      await box.run(["--provider", "p", "--model", "m"]);
      await box.run(OWN, tool === "claude" ? "spent midway" : "spent");
      const calls: string[][] = box.trace().filter((item) => item.called).map((item) => item.called);
      expect(calls.length).toBeGreaterThanOrEqual(8);
      expect(calls.filter((call) => !asked[tool](call))).toEqual([]);
      // (Codex's own word for "is it signed in" is `login status`: that, and never `login` alone.)
      expect(calls.filter((call) => call.join(" ") !== "login status" && call.some((word) => /^(login|logout|update|upgrade|install|setup-token)$/.test(word)))).toEqual([]);
    }
  });

  test("the gateway takes its own tokens and nothing else: a request carrying a sign-in is refused before anything is sent or kept", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    try {
      foundFleet(store, identity, { fleetName: "sign-ins", nodeName: "keep" });
      const vault = new Vault(store, identity);
      vault.set("anthropic", "sk-ant-api03-FAKE-key-for-tests-0000", { provider: "anthropic", origin: "https://api.anthropic.com" });
      store.emit(identity, "provider.set", { id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", secret: "anthropic" });
      const tokens = new GatewayTokens(new Database(":memory:"));
      let sent = 0;
      const fetcher = (async () => { sent += 1; return new Response("{}"); }) as unknown as typeof fetch;
      const call = (headers: Record<string, string>) => handleGateway(new Request("http://127.0.0.1/gw/anthropic/v1/messages", { method: "POST", headers, body: "{}" }), { store, vault, tokens, fetch: fetcher });
      for (const headers of [{ authorization: `Bearer ${FAKE_SIGN_IN}` }, { "x-api-key": FAKE_SIGN_IN }, { authorization: `Bearer ${FAKE_SIGNED_TOKEN}` }] as Record<string, string>[]) {
        const response = await call(headers);
        expect(response.status).toBe(401);
        const body = await response.text();
        expect(body).not.toContain(FAKE_SIGN_IN);
        expect(body).not.toContain(FAKE_SIGNED_TOKEN);
      }
      expect(sent).toBe(0);
      expect(tokens.list()).toEqual([]);
      // (The same request on a token of the gateway's own is sent on: the refusal above is the sign-in's, not the route's.)
      const { token } = tokens.mint({ label: "sandbox:w1", providers: ["anthropic"], ttlMinutes: 10, maxRequests: 5 });
      expect((await call({ authorization: `Bearer ${token}` })).status).toBe(200);
      expect(sent).toBe(1);
    } finally { store.close(); }
  });
});
