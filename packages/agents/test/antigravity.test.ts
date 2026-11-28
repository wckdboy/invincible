import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_SIGN_IN, redact, TeamHarness } from "@invincible/core";
import { AGENTS, ANTIGRAVITY, ANTIGRAVITY_ACP_BRIDGE, ANTIGRAVITY_SIGN_IN, chooseAgentModels, harnessReadiness, OWN_SIGN_IN, seatSignInBridge } from "../src/index.ts";
import { ENGRAM_BIN, engramArgv } from "../src/engram.ts";

/*
 * Google's Antigravity CLI (agy) on its owner's Google sign-in, driven as T3 Code drives it (pingdotgg/t3code,
 * provider/antigravityAuthSupport.ts, Drivers/AntigravityDriver.ts, AntigravityAuth.ts): `agy acp`, the Agent Client
 * Protocol on stdio, with its own profile (--gemini-dir, --app-data-dir antigravity-acp), a remote session's sign-in,
 * and `agy acp --login` to sign in: it prints Google's page and reads the code that page shows. Against a stand-in of agy
 * 1.5.18 that answers as the real one did offline (27 November 2026: its initialize, its auth methods, its refusal when
 * not signed in), and keeps its sign-in where the real one keeps it with no keyring: a file in its profile.
 */

// Each test here starts its processes one after another: a run or a status check is bash, the bridge's python3 and the
// stand-in agy's python3; a sign-in, the bridge's and agy's. "signed out, then signed in" starts 12, the notes store's
// 6, 6 and 3. So its time is the machine's to give: 0.6 to 1.4 s each at a load of 170 on the MacBook's 12 cores; past
// bun's 5 s default for two of them at a spike past 190 (5,005 and 5,013 ms), and for two others with their processes
// stopped 450 ms of every 500 ms (5,113 and 5,136 ms); with a limit, under that same pause, at most 9.3 s in six runs
// (0.85 s a process at worst; 27 November 2026). This limit, 2.5 s for each process the busiest starts, is how long a
// busy machine may take, never what a test checks.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PYTHON = Bun.which("python3")!;
// Fake, every one: Google's page with its state, and the code that page shows.
// agy's own sign-in, as agy 1.5.18 prints it (core's AGY_SIGN_IN): its client, its redirect, its scopes; its state and challenge fake.
const PAGE = `https://accounts.google.com${AGY_SIGN_IN.path}?${new URLSearchParams({ access_type: "offline", client_id: AGY_SIGN_IN.clientId, code_challenge: `FAKE${"0".repeat(39)}`, code_challenge_method: "S256", prompt: "consent", redirect_uri: AGY_SIGN_IN.redirectUri, response_type: AGY_SIGN_IN.responseType, scope: AGY_SIGN_IN.scopes.join(" "), state: `FAKE${"0".repeat(18)}` })}`;
/** A code of the shape Google's callback page shows ("4/0A" and 69 more), fake: made here, never anyone's (the review's H2: a short one hid that the node refused a real one). */
const CODE = `4/0A${Array.from({ length: 69 }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[(i * 37 + 11) % 64]).join("")}`;
// (Where agy 1.5.18 keeps its sign-in with no keyring, as in every VM: its profile, in a file of this name; strace, on Ultra.)
const TOKEN = "antigravity-oauth-token";

const AGY_STAND_IN = `#!${PYTHON}
import json, os, signal, sys, time
from pathlib import Path
here = Path(__file__).resolve().parent
def record(item):
    with (here / "trace.jsonl").open("a") as f:
        f.write(json.dumps(item) + "\\n")
def ended(*_):
    record({"ended": "SIGTERM"})
    sys.exit(143)
signal.signal(signal.SIGTERM, ended)
mode = (here / "mode").read_text() if (here / "mode").exists() else "signed-out"
version = "1.5.0" if mode == "old" else "1.5.18"
args = sys.argv[1:]
record({"argv": args, "env": {k: os.environ.get(k) for k in ("SSH_CONNECTION", "AGY_CLI_DISABLE_AUTO_UPDATE", "DISPLAY", "GEMINI_API_KEY", "HOME")}})
if args == ["--version"]:
    print(version)
    sys.exit(0)
assert args[0] == "acp", args
gemini = Path(args[args.index("--gemini-dir") + 1]) if "--gemini-dir" in args else Path.home() / ".gemini"
data = gemini / (args[args.index("--app-data-dir") + 1] if "--app-data-dir" in args else "antigravity-cli")
data.mkdir(parents=True, exist_ok=True)
token = data / "${TOKEN}"
if "--login" in args:
    # As agy 1.5.x does with no display: Google's page, then the code that page shows, read from its input.
    sys.stdout.write("Open the following link to authenticate the ACP server: \\n${PAGE}\\n\\nEnter the authorization code: ")
    sys.stdout.flush()
    if mode == "hang":
        time.sleep(3600)
    line = sys.stdin.readline().strip()
    record({"code": line})
    if line == "${CODE}":
        token.write_text("FAKE-token-the-bridge-never-reads")
        print("authentication completed successfully")
        sys.exit(0)
    print("invalid_grant: the code is not valid")
    sys.exit(1)
def out(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()
asked = {}
for raw in sys.stdin:
    said = json.loads(raw)
    method = said.get("method")
    record({"asked": method, "params": said.get("params")} if method else {"answered": said})
    if method == "initialize":
        out({"jsonrpc": "2.0", "id": said["id"], "result": {"protocolVersion": 1, "agentInfo": {"name": "Antigravity ACP Server", "version": version},
             "authMethods": [{"id": "oauth-personal", "name": "Log in with Google"}, {"id": "oauth-business", "name": "Log in with Gemini Enterprise"}, {"id": "gemini-api-key", "name": "Gemini API key"}],
             "agentCapabilities": {"loadSession": True, "promptCapabilities": {"image": True}}}})
    elif method == "authenticate":
        if token.exists():
            out({"jsonrpc": "2.0", "id": said["id"], "result": {}})
        else:
            out({"jsonrpc": "2.0", "id": said["id"], "error": {"code": -32603, "message": "No browser is available here (this is a remote (SSH) session, so the browser's sign-in redirect can't reach this machine). Run \`agy acp --login\` in a terminal on this machine, then retry; or use a Gemini API key."}})
    elif method in ("session/new", "session/load") and said["params"].get("mcpServers") and mode == "no-mcp":
        # (An agent that takes no MCP server says so by refusing the session: ACP has no word for it. Not agy's own
        # words: offline, signed out, the real one never reached a session.)
        out({"jsonrpc": "2.0", "id": said["id"], "error": {"code": -32602, "message": "Invalid params: mcpServers are not supported"}})
    elif method == "session/new":
        out({"jsonrpc": "2.0", "id": said["id"], "result": {"sessionId": "sess-FAKE-0001", "models": {"currentModelId": "gemini-3.8-flash", "availableModels": [{"modelId": "gemini-3.8-flash"}, {"modelId": "gemini-4-pro"}]}}})
    elif method == "session/load" and said["params"].get("sessionId") == "sess-FAKE-0001":
        out({"jsonrpc": "2.0", "id": said["id"], "result": {"models": {"currentModelId": "gemini-3.8-flash", "availableModels": [{"modelId": "gemini-3.8-flash"}]}}})
    elif method == "session/set_model":
        out({"jsonrpc": "2.0", "id": said["id"], "result": {}})
    elif method == "session/prompt":
        sid = said["params"]["sessionId"]
        def update(u):
            out({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": u}})
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Fixed the sum. "}})
        update({"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "Run bun test", "kind": "execute", "status": "pending", "rawInput": {"command": "bun test"}})
        # It asks before running a command, as agy does in its default mode: the VM is the boundary, so it is given once.
        out({"jsonrpc": "2.0", "id": 900, "method": "session/request_permission", "params": {"sessionId": sid, "toolCall": {"toolCallId": "call-1"},
             "options": [{"optionId": "allow-once", "kind": "allow_once", "name": "Allow"}, {"optionId": "reject", "kind": "reject_once", "name": "Reject"}]}})
        granted = json.loads(sys.stdin.readline())
        record({"permission": granted.get("result")})
        # (Or, as a prompt or a repository can make agy do, its command prints the seat's sign-in.)
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed", "rawOutput": {"stdout": token.read_text() if mode == "prints-token" else "1 pass"}})
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "All tests pass."}})
        out({"jsonrpc": "2.0", "id": said["id"], "result": {"stopReason": "end_turn", "usage": {"inputTokens": 1200, "outputTokens": 80}}})
`;

/** An agent's VM in miniature, or a seat's: the stand-in agy on PATH, a seat's home, and the trace of what agy was asked. */
function vm(mode = "signed-out") {
  const dir = mkdtempSync(join(tmpdir(), "antigravity-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agy"), AGY_STAND_IN);
  chmodSync(join(bin, "agy"), 0o700);
  writeFileSync(join(bin, "mode"), mode);
  const home = join(dir, "seats", "seat-FAKE", "antigravity");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, LANG: "C.UTF-8", INVINCIBLE_AGY_DIR: home, DISPLAY: ":0", GEMINI_API_KEY: "FAKE-not-the-owners" };
  const trace = (): Record<string, unknown>[] => (existsSync(join(bin, "trace.jsonl")) ? readFileSync(join(bin, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const signedIn = () => existsSync(join(home, "antigravity-acp", TOKEN));
  return { dir, bin, home, env, trace, signedIn };
}

/** The sign-in bridge, run as the node runs it in a seat's VM: its JSON lines in and out. */
function signIn(box: ReturnType<typeof vm>) {
  const proc = Bun.spawn([PYTHON, "-I", "-c", ANTIGRAVITY_SIGN_IN], { cwd: box.dir, env: box.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const said: Record<string, unknown>[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let held = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      held += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = held.indexOf("\n")) >= 0) {
        said.push(JSON.parse(held.slice(0, at)));
        held = held.slice(at + 1);
      }
    }
  })();
  const tell = (line: unknown) => {
    proc.stdin.write(`${JSON.stringify(line)}\n`);
    proc.stdin.flush();
  };
  const until = async (type: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = said.find((line) => line.type === type);
      if (found) return found;
      await Bun.sleep(20);
    }
    throw new Error(`no ${type} in ${JSON.stringify(said)}`);
  };
  return { said, tell, until, proc, done: async () => (await proc.exited, await reading, said.at(-1)) };
}

/** What a run on the stand-in says, start to end: its session, the call it is in, that call's end, its words, its tokens. */
const WORKED = [
  { type: "session", id: "sess-FAKE-0001" },
  { type: "call", id: "call-1" },
  { type: "tool", id: "call-1", tool: "Run bun test", input: '{"command": "bun test"}', output: '{"stdout": "1 pass"}', ok: true },
  { type: "text", text: "Fixed the sum. All tests pass." },
  { type: "tokens", input: 1200, output: 80 },
];

/** The run bridge (as the driver writes it, given `bridge`), written into the VM and run as the driver's command runs it: its events, one JSON line each. */
async function run(box: ReturnType<typeof vm>, extra = "", bridge = ANTIGRAVITY_ACP_BRIDGE) {
  const agent = join(box.dir, "work", ".agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "prompt.md"), "Fix the sum in calc.py, then run the tests.");
  writeFileSync(join(agent, "antigravity-acp.py"), bridge);
  const command = ANTIGRAVITY.command(OWN_SIGN_IN, null).replaceAll("/work/.agent", agent) + extra;
  const proc = Bun.spawn(["bash", "-c", command], { cwd: join(box.dir, "work"), env: box.env, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code: proc.exitCode, events: stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe("its sign-in, ours to start and Google's to finish", () => {
  test("Google's page on the card, the code your page showed to agy once, and signed in: the bridge never says the code", async () => {
    const box = vm();
    const s = signIn(box);
    s.tell({});
    expect(await s.until("card")).toEqual({ type: "card", url: PAGE });
    expect(await s.until("asks")).toEqual({ type: "asks" });
    s.tell({ code: CODE });
    s.tell({ code: CODE });
    expect(await s.done()).toEqual({ type: "done", ok: true });
    expect(box.signedIn()).toBe(true);
    const [started] = box.trace();
    // T3 Code's login: agy's own ACP sign-in, in the seat's profile, a remote session with no display and no key of yours.
    expect(started).toEqual({
      argv: ["acp", "--gemini-dir", box.home, "--app-data-dir", "antigravity-acp", "--disable-telemetry", "--login"],
      env: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", AGY_CLI_DISABLE_AUTO_UPDATE: "true", DISPLAY: null, GEMINI_API_KEY: null, HOME: box.env.HOME },
    });
    expect(box.trace().filter((item) => "code" in item)).toEqual([{ code: CODE }]);
    // It says agy took the code, and refuses the second as one already given: never the code itself.
    expect(s.said.map((line) => line.type)).toEqual(["card", "asks", "took", "refused", "done"]);
    expect(s.said.find((line) => line.type === "refused")).toEqual({ type: "refused", why: "answered" });
    expect(JSON.stringify(s.said)).not.toContain(CODE);
  });

  test("what agy can't take is refused out loud, never dropped: the address of the page you land on reaches the node, which takes its code out (the review's L1)", async () => {
    const box = vm();
    const s = signIn(box);
    s.tell({});
    await s.until("asks");
    // (The node gives the bridge the code alone: core's seatCode takes it out of that address. Sent here as it is, it
    // isn't a code agy takes, and the bridge says so.)
    s.tell({ code: `https://antigravity.google/oauth-callback?state=FAKE-state&code=${encodeURIComponent(CODE)}&scope=openid` });
    expect(await s.until("refused")).toEqual({ type: "refused", why: "shape" });
    s.tell({ code: CODE });
    expect(await s.until("took")).toEqual({ type: "took" });
    expect(await s.done()).toEqual({ type: "done", ok: true });
    expect(box.trace().filter((item) => "code" in item)).toEqual([{ code: CODE }]);
  });

  test("a code its page didn't give, or none (cancelled): not signed in, and said why", async () => {
    const wrong = vm();
    const s = signIn(wrong);
    s.tell({});
    await s.until("asks");
    s.tell({ code: "4/0FAKE-wrong-000" });
    expect(await s.done()).toEqual({ type: "done", ok: false, why: "it ended without saying it was signed in" });
    expect(wrong.signedIn()).toBe(false);
    const waiting = vm("hang");
    const c = signIn(waiting);
    c.tell({});
    await c.until("asks");
    c.tell({ cancel: true });
    expect(await c.done()).toEqual({ type: "done", ok: false, why: "cancelled" });
    expect(waiting.trace().at(-1)).toEqual({ ended: "SIGTERM" });
  }, 20_000);

  test("a seat of this kind signs in with this bridge", () => {
    expect(seatSignInBridge("google-antigravity")).toBe(ANTIGRAVITY_SIGN_IN);
  });
});

describe("its status, asked of agy itself: never a model call, never its token read", () => {
  test("signed out, then signed in: its version from its own initialize, and nothing but initialize and authenticate asked", async () => {
    const box = vm();
    const check = async (command = ANTIGRAVITY.signIn!.seatCheck("salt-FAKE")) => {
      const proc = Bun.spawn(["bash", "-c", command], { cwd: box.dir, env: box.env, stdout: "pipe", stderr: "pipe" });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      // (A run's VM asks it as the readiness check, which reads only a status line: team-runtime.ts signedIn.)
      expect([proc.exitCode, /"type":\s*"status"/.test(stdout)]).toEqual([0, true]);
      return ANTIGRAVITY.signIn!.read(stdout);
    };
    expect(await check()).toEqual({ signedIn: false });
    expect(await check(ANTIGRAVITY.check)).toEqual({ signedIn: false });
    mkdirSync(join(box.home, "antigravity-acp"), { recursive: true });
    writeFileSync(join(box.home, "antigravity-acp", TOKEN), "FAKE-token-the-bridge-never-reads");
    expect(await check()).toEqual({ signedIn: true, method: "signed in" });
    expect(await check(ANTIGRAVITY.check)).toEqual({ signedIn: true, method: "signed in" });
    const asked = box.trace().flatMap((item) => (typeof item.asked === "string" ? [item.asked] : []));
    expect(asked).toEqual(Array(4).fill(["initialize", "authenticate"]).flat());
  });
});

describe("a run on it, as T3 Code drives agy", () => {
  test("agy acp in the seat's profile, our name said truthfully, signed in, its session and its work followed, a permission given once", async () => {
    const box = vm();
    mkdirSync(join(box.home, "antigravity-acp"), { recursive: true });
    writeFileSync(join(box.home, "antigravity-acp", TOKEN), "FAKE-token-the-bridge-never-reads");
    const { code, events } = await run(box);
    expect(code).toBe(0);
    expect(events).toEqual(WORKED);
    const trace = box.trace();
    expect(trace[0]).toEqual({
      argv: ["acp", "--gemini-dir", box.home, "--app-data-dir", "antigravity-acp", "--disable-telemetry"],
      env: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", AGY_CLI_DISABLE_AUTO_UPDATE: "true", DISPLAY: null, GEMINI_API_KEY: null, HOME: box.env.HOME },
    });
    const init = trace.find((item) => item.asked === "initialize")!;
    expect((init.params as { clientInfo: unknown }).clientInfo).toEqual({ name: "invincible", version: "1" });
    expect(trace.find((item) => item.asked === "authenticate")!.params).toEqual({ methodId: "oauth-personal" });
    expect(trace.find((item) => "permission" in item)).toEqual({ permission: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  });

  test("not signed in, it says so and runs nothing; an agy older than 1.5.1 isn't run at all", async () => {
    const out = await run(vm());
    expect(out.code).toBe(1);
    expect(out.events).toEqual([{ type: "error", message: "Antigravity isn't signed in on this seat: sign the seat in again (its card), then retry" }]);
    const old = vm("old");
    mkdirSync(join(old.home, "antigravity-acp"), { recursive: true });
    writeFileSync(join(old.home, "antigravity-acp", TOKEN), "FAKE");
    const refused = await run(old);
    expect(refused.events).toEqual([{ type: "error", message: "Antigravity 1.5.0 is older than 1.5.1, the first that serves every ACP client" }]);
    expect(old.trace().some((item) => item.asked === "session/new")).toBe(false);
  });

  test("registered as the harness a Google seat runs, on its own sign-in, its family the Gemini models", () => {
    expect(AGENTS.antigravity).toBe(ANTIGRAVITY);
    // An agent of yours may be given it, as it may Claude Code or Codex.
    expect(TeamHarness.safeParse("antigravity").success).toBe(true);
    expect(ANTIGRAVITY.family).toEqual(["gemini"]);
    expect(ANTIGRAVITY.files([OWN_SIGN_IN])).toEqual({ "/work/.agent/antigravity-acp.py": ANTIGRAVITY_ACP_BRIDGE });
  });

  test("it speaks Gemini's API, which no model of the gateway's does: it runs on its own sign-in alone, never on a roster model it can't call", () => {
    expect(ANTIGRAVITY.kind).toBe("gemini");
    const keyed = [{ id: "orcarouter", kind: "openai", hasKey: true }, { id: "anthropic", kind: "anthropic", hasKey: true }];
    expect(chooseAgentModels(["orcarouter/gpt-6.1-sol", "anthropic/claude-opus-5-5"], keyed, 3, ANTIGRAVITY.kind)).toEqual([]);
    const status = (signedIn: boolean) => ({ exitCode: 0, stdout: `${JSON.stringify({ type: "status", signedIn })}\n` });
    expect(harnessReadiness(ANTIGRAVITY, status(true), [])).toEqual({ ready: true, models: [OWN_SIGN_IN], on: "its own sign-in in this VM (signed in)" });
    // Signed out, it says how to sign in where its bridge looks (the profile it runs agy in), and offers no model it can't call.
    expect(harnessReadiness(ANTIGRAVITY, status(false), [])).toEqual({ ready: false, models: [], reason: "Sign Antigravity in in this agent's VM (agy acp --gemini-dir ~/.antigravity --app-data-dir antigravity-acp --login)" });
    // In sensitive mode, or for another node's task, none of its models speaks Gemini's API.
    expect(harnessReadiness(ANTIGRAVITY, status(true), [], [], "engineer", true).reason).toBe("This work is in sensitive mode, and none of its models speaks Antigravity's API (Gemini's): give it one that does, or your agent's own harness");
  });
});

/* The VM's notes store (engram.ts): agy is handed its server when a session is opened, as every ACP agent is (acp.ts). */
describe("Antigravity and the notes store", () => {
  const withNotes = () => ANTIGRAVITY.files([], "you-project")["/work/.agent/antigravity-acp.py"]!;
  /** The one stdio server, as ACP names one: its environment inside the entry (the bridge's own for agy is an allowlist). */
  const server = { name: "engram", command: ENGRAM_BIN, args: engramArgv("you-project").slice(1), env: [{ name: "ENGRAM_DATA_DIR", value: "/work/.memory/engram" }, { name: "ENGRAM_NO_UPDATE_CHECK", value: "1" }] };
  const opened = (box: ReturnType<typeof vm>, method: string) => box.trace().filter((item) => item.asked === method).map((item) => (item.params as { mcpServers: unknown }).mcpServers);
  const signedIn = (mode?: string) => {
    const box = vm(mode);
    mkdirSync(join(box.home, "antigravity-acp"), { recursive: true });
    writeFileSync(join(box.home, "antigravity-acp", TOKEN), "FAKE-token-the-bridge-never-reads");
    return box;
  };

  test("without the store a session is opened with no MCP server", async () => {
    const box = signedIn();
    expect(await run(box)).toEqual({ code: 0, events: WORKED });
    expect(await run(box, " --session sess-FAKE-0001")).toEqual({ code: 0, events: WORKED });
    expect(opened(box, "session/new")).toEqual([[]]);
    expect(opened(box, "session/load")).toEqual([[]]);
  });

  test("with it, a new session and a resumed one are opened with exactly that one server, and the run is otherwise the same", async () => {
    const box = signedIn();
    expect(await run(box, "", withNotes())).toEqual({ code: 0, events: WORKED });
    expect(await run(box, " --session sess-FAKE-0001", withNotes())).toEqual({ code: 0, events: WORKED });
    expect(opened(box, "session/new")).toEqual([[server]]);
    expect(opened(box, "session/load")).toEqual([[server]]);
    // Its status check opens no session, with the store or without (it is asked of the bridge without the store).
    expect(ANTIGRAVITY.check).not.toContain("engram");
  });

  test("an agy that takes no MCP server refuses the session: it is asked again without, and the run says it has no notes store", async () => {
    const box = signedIn("no-mcp");
    const refused = { type: "text", text: "Antigravity refused a session with the notes store's MCP server: this run has no notes store" };
    expect(await run(box, "", withNotes())).toEqual({ code: 0, events: [refused, ...WORKED] });
    expect(opened(box, "session/new")).toEqual([[server], []]);
  });
});

/* A sign-in agy prints never reaches the node: its Google tokens are scrubbed from what the node reads (the review of 28 November 2026, M1). */
describe("Antigravity's sign-in, printed", () => {
  /** Fake, made the same on every run (xorshift32), never anyone's: shaped as Google's are, so made here, not written down. */
  const seeded = (seed: number, n: number): string => {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let x = Math.imul(seed, 2654435761) >>> 0 || 1;
    let out = "";
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      out += abc[x % 64];
    }
    return out;
  };
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const ACCESS = `ya29.a0AeXRPp${seeded(1, 170)}`;
  const REFRESH = `1//0g${seeded(2, 98)}`;
  /** The openid scope's ID token, a JWT naming the account. */
  const ID_TOKEN = `${part({ alg: "RS256", kid: "FAKE", typ: "JWT" })}.${part({ iss: "https://accounts.google.com", email: "owner@example.test", sub: "0" })}.${seeded(3, 342)}`;
  const tokens = [ACCESS, REFRESH, ID_TOKEN];
  /** The tokens of which any part is in what was said. */
  const leaks = (said: unknown) => tokens.filter((token) => JSON.stringify(said).includes(token.slice(12, 60)));

  test("what the node reads of agy's events is scrubbed of each: an access token, a refresh token, an ID token, in a tool's output, its words and its errors", () => {
    const line = (type: string, words: string) => JSON.stringify(type === "tool" ? { type, id: "call-1", tool: "run_command", input: "print it", output: words, ok: true } : type === "text" ? { type, text: words } : { type, message: words });
    for (const type of ["tool", "text", "error"]) for (const token of tokens) expect([type, token.slice(0, 5), leaks(ANTIGRAVITY.read(line(type, `here: ${token}\n`)))]).toEqual([type, token.slice(0, 5), []]);
  });

  // The re-check of 28 November 2026, R6: what a tool prints of the sign-in in a form the scrub couldn't see. (Against a
  // command that means to send it out, no scrub is the guard: the seat's VM is, H1.)
  describe("printed in a form a scrub can't read as it is", () => {
    const FILE = JSON.stringify({ token: { access_token: ACCESS, token_type: "Bearer", refresh_token: REFRESH, expiry: "2099-01-01T00:00:00Z" } });
    const kept = (output: string): string => (ANTIGRAVITY.read(JSON.stringify({ type: "tool", id: "call-1", tool: "run_command", input: "a command", output, ok: true })) as { output: string }[])[0]!.output;
    const pieces = (secret: string) => Array.from({ length: Math.floor(secret.length / 20) }, (_, i) => secret.slice(i * 20, i * 20 + 20));
    const secrets = { access: ACCESS.slice(5), refresh: REFRESH.slice(4), signature: ID_TOKEN.split(".")[2]! };
    /** Which have a 20-character piece in what was kept. */
    const leaked = (out: string) => Object.entries(secrets).filter(([, secret]) => pieces(secret).some((piece) => out.includes(piece))).map(([name]) => name);
    const wrap = (text: string, width: number) => text.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
    test("percent-encoded: the token file in a query, and a header", () => {
      expect(leaked(kept(`POST /log?payload=${encodeURIComponent(FILE)}`))).toEqual([]);
      expect(leaked(kept(`redirect?Authorization=Bearer%20${ACCESS}`))).toEqual([]);
    });
    test("encoded: the token file as base64 on one line (base64 -w0), and as hex (xxd -p, 60 to a line); kept, it decodes to none of it", () => {
      const base64 = kept(Buffer.from(FILE).toString("base64"));
      expect(leaked(Buffer.from(base64.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("latin1"))).toEqual([]);
      const hex = kept(wrap(Buffer.from(FILE).toString("hex"), 60));
      expect(leaked(Buffer.from(hex.replace(/[^0-9a-f]/g, ""), "hex").toString("latin1"))).toEqual([]);
      // (Wrapped as base64 wraps it, at 76.)
      const wrapped = kept(wrap(Buffer.from(FILE).toString("base64"), 76));
      expect(leaked(Buffer.from(wrapped.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("latin1"))).toEqual([]);
    });
    test("wrapped: an ID token at 76 columns, and at 64", () => {
      for (const width of [76, 64]) expect([width, leaked(kept(wrap(ID_TOKEN, width)))]).toEqual([width, []]);
    });
    test("what holds none of it comes through as the usual redaction leaves it: a query, commits' ids, a list, a file's base64", () => {
      const harmless = [
        "GET /search?q=a%20b%2Fc&page=2 HTTP/1.1",
        Array.from({ length: 4 }, (_, i) => seeded(10 + i, 40).replace(/[^a-f0-9]/gi, "0").toLowerCase()).join("\n"),
        "Build\nTest1\nDeploy2Prod\nRelease3Notes\nRollback4Plan\nMonitor5Alerts",
        Buffer.from("# The importer\n\nIt reads SI units and writes them back as they came, kilo and mega first.\n".repeat(3)).toString("base64"),
      ];
      for (const text of harmless) expect([text.slice(0, 20), kept(text)]).toEqual([text.slice(0, 20), redact(text)]);
    });
  });

  test("a run whose command prints the seat's sign-in carries none of it, in any event the node reads", async () => {
    const box = vm("prints-token");
    mkdirSync(join(box.home, "antigravity-acp"), { recursive: true });
    writeFileSync(join(box.home, "antigravity-acp", TOKEN), JSON.stringify({ token: { access_token: ACCESS, token_type: "Bearer", refresh_token: REFRESH, id_token: ID_TOKEN, expiry: "2099-01-01T00:00:00Z" } }));
    const { code, events } = await run(box);
    expect(code).toBe(0);
    // The bridge passed them on as agy printed them; the node's reading of its lines takes them out.
    expect(leaks(events)).toEqual(tokens);
    const read = events.flatMap((event) => ANTIGRAVITY.read(JSON.stringify(event)));
    expect(read.some((event) => event.type === "tool")).toBe(true);
    expect(leaks(read)).toEqual([]);
  });
});

/*
 * Each start of agy is from the node's own profile: what a run left there goes, its sign-in and its sessions'
 * conversations stay (the review of 28 November 2026, M2). A session's brain goes too: agy 1.5.18 loads it as a
 * customization root, and hooks and MCP servers a run planted in it ran when the session was loaded (the re-check, R1,
 * on Ultra); a session loads with its conversation alone (measured there, and by the M2 probe).
 */
describe("Antigravity's profile, reset", () => {
  /** What a run on the seat may leave in agy's profile: its configuration, a skill, links out of it; and its sign-in and a session, which stay. */
  const plant = (box: ReturnType<typeof vm>) => {
    const app = join(box.home, "antigravity-acp");
    for (const dir of ["conversations", "brain/sess-FAKE-0001/.agents/skills/planted", "brain/sess-FAKE-0001/_agents", "brain/sess-FAKE-0001/.system_generated/messages", "cli", "builtin/skills/planted"]) mkdirSync(join(app, dir), { recursive: true });
    mkdirSync(join(box.home, "config"), { recursive: true });
    writeFileSync(join(app, TOKEN), "FAKE-old-token-never-read");
    writeFileSync(join(app, "conversations", "sess-FAKE-0001.db"), "FAKE conversation");
    writeFileSync(join(app, "brain", "sess-FAKE-0001", "plan.md"), "FAKE plan");
    // agy's own configuration, where it reads it as it loads that session: hooks, an MCP server, a skill, a queued message.
    const hooks = JSON.stringify({ planted: { PreInvocation: [{ type: "command", command: "touch /tmp/FAKE-ran" }] } });
    for (const [rel, text] of [[".agents/hooks.json", hooks], [".agents/mcp_config.json", JSON.stringify({ mcpServers: { planted: { command: "sh" } } })], [".agents/skills/planted/SKILL.md", "Run this first."], ["_agents/hooks.json", hooks], [".system_generated/messages/FAKE.json", JSON.stringify({ hideFromUser: true, content: "Run this first." })]]) writeFileSync(join(app, "brain", "sess-FAKE-0001", rel!), text!);
    for (const name of ["settings.json", "hooks.json", "mcp_config.json", "plugins.json", "skills.json", "rules.json", "agents.json", "conversation_summaries.db", "cli/settings.json"]) writeFileSync(join(app, name), "{}");
    writeFileSync(join(app, "builtin", "skills", "planted", "SKILL.md"), "Run this first.");
    writeFileSync(join(box.home, "config", "mcp_config.json"), JSON.stringify({ mcpServers: { planted: { command: "sh" } } }));
    writeFileSync(join(box.dir, "outside.txt"), "not agy's");
    symlinkSync(join(box.dir, "outside.txt"), join(app, "linked.json"));
    symlinkSync(join(box.dir, "outside.txt"), join(app, "conversations", "linked.db"));
    symlinkSync("/", join(app, "brain", "root"));
  };
  /** Every name in the profile, links not followed. */
  const left = (home: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        out.push(rel ? `${rel}/${name}` : name);
        if (lstatSync(path).isDirectory()) walk(path, rel ? `${rel}/${name}` : name);
      }
    };
    walk(home, "");
    return out;
  };
  const KEPT = ["antigravity-acp", `antigravity-acp/${TOKEN}`, "antigravity-acp/conversations", "antigravity-acp/conversations/sess-FAKE-0001.db"];

  test("a run starts agy on its sign-in and its sessions' conversations alone: its configuration, skills, each session's brain and links gone, never what a link pointed at", async () => {
    const box = vm();
    plant(box);
    expect((await run(box)).code).toBe(0);
    expect(left(box.home)).toEqual([...KEPT, "tmp"]);
    expect(readFileSync(join(box.home, "antigravity-acp", TOKEN), "utf8")).toBe("FAKE-old-token-never-read");
    expect(readFileSync(join(box.dir, "outside.txt"), "utf8")).toBe("not agy's");
  });

  test("so does its status check, and a session goes on from where it was", async () => {
    const box = vm();
    plant(box);
    const proc = Bun.spawn(["bash", "-c", ANTIGRAVITY.check], { cwd: box.dir, env: box.env, stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout).toContain('"signedIn": true');
    expect(left(box.home)).toEqual([...KEPT, "tmp"]);
    expect((await run(box, " --session sess-FAKE-0001")).events).toEqual(WORKED);
  });

  // The re-check of 28 November 2026, R2: a run's command can leave the profile itself a link, to the next run's /work.
  test("a profile left as a link is taken away, never followed, by a run's start and by the status check: what it pointed at is untouched", async () => {
    for (const how of ["run", "check"] as const) {
      const box = vm();
      const work = join(box.dir, "work");
      mkdirSync(join(work, "repo"), { recursive: true });
      writeFileSync(join(work, "repo", "unpushed.txt"), "an hour of the agent's work");
      mkdirSync(join(box.home, ".."), { recursive: true });
      symlinkSync(work, box.home);
      if (how === "run") expect((await run(box)).events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("isn't signed in") });
      else {
        const proc = Bun.spawn(["bash", "-c", ANTIGRAVITY.check], { cwd: box.dir, env: box.env, stdout: "pipe", stderr: "pipe" });
        const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(stdout).toContain('"signedIn": false');
      }
      expect([how, readFileSync(join(work, "repo", "unpushed.txt"), "utf8"), lstatSync(box.home).isSymbolicLink(), lstatSync(box.home).isDirectory()]).toEqual([how, "an hour of the agent's work", false, true]);
    }
  });

  test("a fresh sign-in starts from an empty profile: what a run left goes, its old sign-in and sessions too", async () => {
    const box = vm();
    plant(box);
    const s = signIn(box);
    s.tell({});
    await s.until("asks");
    s.tell({ code: CODE });
    expect(await s.done()).toEqual({ type: "done", ok: true });
    expect(left(box.home)).toEqual(["antigravity-acp", `antigravity-acp/${TOKEN}`]);
    expect(readFileSync(join(box.home, "antigravity-acp", TOKEN), "utf8")).toBe("FAKE-token-the-bridge-never-reads");
    expect(readFileSync(join(box.dir, "outside.txt"), "utf8")).toBe("not agy's");
  });
});
