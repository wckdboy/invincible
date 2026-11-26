import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecResult, newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { AGENTS, OWN_SIGN_IN, agentModelName, chooseAgentModels, type AgentDriver, type AgentEvent } from "../src/harnesses.ts";
import { CLAUDE, CODEX } from "../src/vendor-cli.ts";
import { ENGRAM_BIN, engramArgv } from "../src/engram.ts";
import { GatewayTokens, handleGateway } from "@invincible/models";
import { type RunEvent, type RunRole, runLoop } from "../src/run.ts";
import { CLAUDE_BRIDGE, CODEX_BRIDGE } from "../src/vendor-cli.ts";

/*
 * The vendors' own CLIs as harnesses: Claude Code and Codex, each run headless and live by a bridge inside the agent's
 * VM. Nothing here runs a real CLI: each test puts a stand-in executable of the same name on PATH, which replays the real
 * one. The fixtures are what Claude Code 2.1.326 and Codex 0.172.0 printed, and what their bridges sent them, as those
 * bridges drove them against a loopback model on 26 November 2026 (a tap on their PATH in a VM with no network; every
 * id, host and socket replaced, and Claude Code's own lists of its commands, skills, agents and plugins cut short). A
 * variant is one of those with one thing changed (a spent allowance, a failed tool, a very long line), written here on
 * those shapes. A plan's spent window (rate_limit_event, said only on a claude.ai sign-in) is the one 2.1.311 printed on
 * 13 November 2026 (fixtures/claude-code-2.1.311.jsonl), with its status set to rejected.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PYTHON = Bun.which("python3")!;
/**
 * What this host's python3 puts into any process's environment by itself, measured: macOS's CoreFoundation adds
 * `__CF_USER_TEXT_ENCODING` and `LC_CTYPE`, and Apple's /usr/bin/python3 (a developer tools shim) adds `SDKROOT`,
 * `CPATH`, `LIBRARY_PATH` and `MANPATH` (found 26 November 2026 on the Mac mini, whose only python3 it is). A driver is
 * held to adding nothing beyond these: on Linux, as a VM is, the set is empty.
 */
const HOST_ADDED: ReadonlySet<string> = (() => {
  const given = { PATH: "/usr/bin:/bin" };
  const seen = Bun.spawnSync([PYTHON, "-c", "import json, os; print(json.dumps(sorted(os.environ)))"], { env: given, stdout: "pipe" });
  return new Set((JSON.parse(seen.stdout.toString()) as string[]).filter((name) => !(name in given)));
})();
/** Each tool's session as the fixtures recorded it: the one its `hello` began, and its `resumed` continued. */
const SESSION = { claude: "00000000-0000-4000-8000-00000000000f", codex: "00000000-0000-4000-8000-000000000058" } as const;
const FIXTURE = {
  claude: readFileSync(new URL("./fixtures/claude-code-2.1.326.jsonl", import.meta.url), "utf8"),
  codex: readFileSync(new URL("./fixtures/codex-0.172.0.jsonl", import.meta.url), "utf8"),
};
/** A plan's window as Claude Code said it on a real claude.ai sign-in (2.1.311): allowed, beside "overageStatus":"rejected". */
const LIMIT = readFileSync(new URL("./fixtures/claude-code-2.1.311.jsonl", import.meta.url), "utf8").split("\n").find((line) => line.includes('"rate_limit_event"'))!;
/** Every variable the primary's gateway lease puts in an agent's environment. */
const GATEWAY_VARS = ["INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN", "INVINCIBLE_REPO_URL", "INVINCIBLE_SEARCH", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
/** What a sign-in looks like, so a test can say it never got anywhere (fake, like every key here). */
const FAKE_SIGN_IN = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
/** The other vendor's is a signed three-part token with no prefix of its own (fake: its parts say so). */
const FAKE_SIGNED_TOKEN = "eyJGQUtFIjoibm90LWEtdG9rZW4ifQ.eyJGQUtFIjoibm90LWEtdG9rZW4ifQ.RkFLRS1ub3QtYS1zaWduYXR1cmU";

const COMMON = String.raw`import copy, json, os, queue, signal, sys, threading, time
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
fixture = [json.loads(line) for line in (here / "fixture.jsonl").read_text().splitlines() if line]
chosen = (here / "scenario").read_text().strip() if (here / "scenario").exists() else "plain"
`;

/**
 * The real tool, replayed: a scenario as it was lived, in answer to this bridge. Each line its bridge sent then is waited
 * for (by its kind), and what the tool printed after it is said again, with whatever this bridge said differently (an id,
 * a uuid, its words) in place of what was said then. A signal, or the end of its input, is waited for as it came.
 */
const REPLAY = String.raw`
inbox = queue.Queue()
def leave(code):
    # (Out at once, as the tool ends: its reader of stdin may still be blocked, and a shutdown would wait for it.)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
def reading():
    for raw in sys.stdin.buffer:
        inbox.put(("in", raw))
    inbox.put(("eof", None))
def signalled(sig, frame):
    record({"signal": sig})
    inbox.put(("signal", sig))
def scenario(name):
    return copy.deepcopy([f for f in fixture if f["scenario"] == name])
def outs(frames, test):
    return [f for f in frames if f["dir"] == "out" and isinstance(f["line"], dict) and test(f["line"])]

class Replay:
    def __init__(self, frames, held=()):
        self.frames, self.held, self.swap, self.ids = frames, list(held), {}, {}

    def learn(self, then, now):
        if isinstance(then, dict) and isinstance(now, dict):
            for key, value in then.items():
                if key not in now:
                    continue
                if key == "id" and type(value) is int and type(now[key]) is int:
                    self.ids[value] = now[key]
                else:
                    self.learn(value, now[key])
        elif isinstance(then, list) and isinstance(now, list):
            for a, b in zip(then, now):
                self.learn(a, b)
        elif isinstance(then, str) and isinstance(now, str) and then != now:
            self.swap[then] = now

    def said(self, value):
        if isinstance(value, dict):
            told = {k: self.said(v) for k, v in value.items()}
            if type(value.get("id")) is int and "method" not in value:
                told["id"] = self.ids.get(value["id"], value["id"])
            return told
        if isinstance(value, list):
            return [self.said(v) for v in value]
        return self.swap.get(value, value) if isinstance(value, str) else value

    def same(self, then, now):
        if isinstance(then, dict) and isinstance(now, dict):
            if "method" in then or "method" in now:
                return then.get("method") == now.get("method")
            return then.get("type") == now.get("type")
        return then == now

    def fail(self, why):
        sys.stderr.write("replay: " + why + "\n")
        leave(3)

    def next(self):
        if self.held:
            return "in", self.held.pop(0)
        try:
            return inbox.get(timeout=30)
        except queue.Empty:
            self.fail("its bridge sent nothing more")

    def wait(self, want, then=None):
        kind, value = self.next()
        if kind == "signal":
            if want == "signal" and value == then:
                return None
            leave(128 + value)
        if kind == "eof":
            if want == "eof":
                record({"eof": True})
                return None
            self.fail("its input ended where the tool was sent " + json.dumps(then)[:200])
        try:
            now = json.loads(value)
        except ValueError:
            now = value.decode("utf-8", "replace").rstrip("\n")
        if want != "in" or not self.same(then, now):
            self.fail("its bridge sent " + json.dumps(now)[:200] + " where the tool " + ("was sent " + json.dumps(then)[:200] if want == "in" else "waited for " + want))
        self.learn(then, now)
        return now

    def play(self, told):
        for frame in self.frames:
            kind, line = frame["dir"], frame["line"]
            if kind == "out":
                print(line if isinstance(line, str) else json.dumps(self.said(line)), flush=True)
            elif kind == "in":
                told(self.wait("in", line))
            elif kind == "signal":
                self.wait("signal", line)
            elif kind == "eof":
                self.wait("eof")
            elif kind == "pause":
                time.sleep(line / 1000)
            elif kind == "exit":
                leave(line)

def live():
    threading.Thread(target=reading, daemon=True).start()
    signal.signal(signal.SIGINT, signalled)

def lingering(frames):
    # Its end, a second and a half after its input closed: words told it then are late.
    at = next(i for i, f in enumerate(frames) if f["dir"] == "eof")
    return frames[:at + 1] + [dict(frames[at], dir="pause", line=1500)] + frames[at + 1:]
`;

// Claude Code 2.1.326: its flags, and its frames as the bridge's stream-json input drew them.
const CLAUDE_STAND_IN = `#!${PYTHON}
${COMMON}${REPLAY}${String.raw`
if args == ["--version"]:
    print("2.1.326 (Claude Code)")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    record({"asked": "status", "env": dict(os.environ)})
    if signed:
        # As the real command prints it: who is signed in, to what. None of this may leave the VM.
        print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "agent@example.invalid", "orgId": "org-FAKE-0000", "orgName": "Fake Org Ltd", "subscriptionType": "max", "loginExpiresAt": "2026-12-24T10:00:00.000Z"}, indent=2))
        sys.exit(0)
    print(json.dumps({"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty"}, indent=2))
    sys.exit(1)
SESSION = "${SESSION.claude}"
LIMIT = json.loads(${JSON.stringify(LIMIT)})

def assistant_text(l):
    return l.get("type") == "assistant" and any(b.get("type") == "text" for b in l["message"]["content"])
def tool_use(l):
    return l.get("type") == "assistant" and any(b.get("type") == "tool_use" for b in l["message"]["content"])
def tool_result(l):
    return l.get("type") == "user" and not l.get("isReplay") and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in l["message"]["content"])
def result(l):
    return l.get("type") == "result"
def rejected(at, **more):
    return dict(at, dir="out", line=dict(LIMIT, rate_limit_info=dict(LIMIT["rate_limit_info"], status="rejected", **more)))

def stopped(base):
    # What it printed once SIGINT came (the recorded stop's end: its turn ended and cancelled), as of the run it ends.
    stop = scenario("stop")
    mine, theirs = base[1]["line"]["uuid"], stop[1]["line"]["uuid"]
    at = next(i for i, f in enumerate(stop) if f["dir"] == "signal")
    tail = [f for f in stop[at:] if not (f["dir"] == "out" and isinstance(f["line"], dict) and f["line"].get("type") == "user")]
    return json.loads(json.dumps(tail).replace(theirs, mine))

def variant(name):
    if name == "long":
        frames = scenario("plain")
        for f in outs(frames, tool_result):
            f["line"]["message"]["content"][0]["content"] = "é" * 300000
        for f in outs(frames, assistant_text):
            f["line"]["message"]["content"][0]["text"] = "y" * 100000
        for f in outs(frames, result):
            f["line"]["result"] = "y" * 100000
        return frames
    if name == "half a character":
        # A tool that cuts its output by UTF-16 units can leave half of a pair, which JSON carries as an escape; then a
        # line that isn't JSON, an event that isn't one, and a message that is plain words.
        frames, done = [], scenario("hello")
        for f in done:
            if f["dir"] == "out" and isinstance(f["line"], dict) and assistant_text(f["line"]):
                f["line"]["message"]["content"][0]["text"] = "cut here " + chr(0xD83D)
                frames += [f, dict(f, line="{not json"), dict(f, line=json.dumps(["not", "an", "event"])), dict(f, line={"type": "user", "message": {"role": "user", "content": "a plain message"}})]
                continue
            if f["dir"] == "out" and isinstance(f["line"], dict) and result(f["line"]):
                f["line"]["result"] = "cut here " + chr(0xD83D)
            frames.append(f)
        return frames
    if name == "a tool fails":
        frames = scenario("plain")
        for f in outs(frames, tool_use):
            f["line"]["message"]["content"][0]["input"]["command"] = "cat /work/.secrets"
        for f in outs(frames, tool_result):
            block = f["line"]["message"]["content"][0]
            block["content"] = [{"type": "text", "text": "token=${FAKE_SIGN_IN}"}, {"type": "text", "text": "${FAKE_SIGNED_TOKEN}"}, {"type": "text", "text": "exit 1"}]
            block["is_error"] = True
        for f in outs(frames, assistant_text):
            f["line"]["message"]["content"][0]["text"] = "It printed ${FAKE_SIGNED_TOKEN} and stopped."
        for f in outs(frames, result):
            f["line"]["result"] = "It printed ${FAKE_SIGNED_TOKEN} and stopped."
        return frames
    if name == "spent before any reply":
        # Its plan's window spent at once: it would wait for the reset, but its bridge stops it (SIGINT).
        frames = scenario("hello")
        at = next(i for i, f in enumerate(frames) if f["dir"] == "out" and f["line"].get("isReplay"))
        tail = stopped(frames)
        for f in outs(tail, result):
            f["line"]["usage"] = {}  # (Its one request was refused: nothing was spent.)
        return frames[:at + 1] + [rejected(frames[at])] + tail
    if name == "spent midway":
        frames = scenario("plain")
        at = next(i for i, f in enumerate(frames) if f["dir"] == "out" and isinstance(f["line"], dict) and tool_result(f["line"]))
        return frames[:at + 1] + [rejected(frames[at], errorCode="credits_required")] + stopped(frames)
    if name == "limit said only in the result":
        frames = scenario("spent")
        for f in outs(frames, lambda l: l.get("type") == "assistant"):
            f["line"]["message"]["content"][0]["text"] = "You've hit your weekly limit · resets Mon 12:00am"
        for f in outs(frames, result):
            f["line"]["result"] = "You've hit your weekly limit · resets Mon 12:00am"
        return frames
    if name == "out of turns":
        frames = scenario("plain")
        for f in outs(frames, result):
            f["line"].update(subtype="error_max_turns", is_error=False, result=None)
        return frames
    if name == "lingering":
        return lingering(scenario("hello"))
    return scenario(name)

resumed = args[args.index("--resume") + 1] if "--resume" in args else None
name = chosen if resumed is None or chosen != "plain" else ("resumed" if resumed == SESSION else "unknown-session")
told = []
def heard(line):
    text = line["message"]["content"][0]["text"] if isinstance(line, dict) and line.get("type") == "user" else None
    if not told:
        record({"argv": args, "env": dict(os.environ), "prompt": text})
    else:
        record({"said": text if text is not None else line})
    told.append(line)
live()
Replay(variant(name)).play(heard)
`}`;

// Codex 0.172.0: its app server, as its bridge's JSON-RPC drew it (and as a seat's status asks it for its account).
const CODEX_STAND_IN = `#!${PYTHON}
${COMMON}${REPLAY}${String.raw`
if args == ["--version"]:
    print("codex-cli 0.172.0")
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
if args[:1] != ["app-server"]:
    sys.exit(2)
SESSION = "${SESSION.codex}"
SPENT_LATER = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 23rd, 2026 8:11 PM."

def items(frames, kind, method="item/completed"):
    return outs(frames, lambda l: l.get("method") == method and l["params"]["item"]["type"] == kind)
def ids(frames):
    turn = next(f["line"]["params"]["turn"] for f in frames if f["dir"] == "out" and isinstance(f["line"], dict) and f["line"].get("method") == "turn/started")
    thread = next(f["line"]["params"]["threadId"] for f in frames if f["dir"] == "out" and isinstance(f["line"], dict) and f["line"].get("method") == "turn/started")
    return thread, turn["id"]
def note(at, method, params):
    return dict(at, dir="out", line={"method": method, "params": params})

def refusal(base, words=None):
    # The recorded refusal (its error and its failed turn), as of the run it ends: what comes after base's last call.
    spent = scenario("spent")
    (mine_thread, mine_turn), (thread, turn) = ids(base), ids(spent)
    at = next(i for i, f in enumerate(spent) if f["dir"] == "out" and isinstance(f["line"], dict) and f["line"].get("method") == "account/rateLimits/updated")
    tail = json.loads(json.dumps(spent[at:]).replace(thread, mine_thread).replace(turn, mine_turn))
    if words:
        for f in outs(tail, lambda l: l.get("method") in ("error", "turn/completed")):
            (f["line"]["params"].get("error") or f["line"]["params"]["turn"]["error"])["message"] = words
    return tail

def variant(name):
    if name == "long":
        frames = scenario("plain")
        for f in items(frames, "commandExecution"):
            f["line"]["params"]["item"]["aggregatedOutput"] = "é" * 300000
        for f in items(frames, "agentMessage"):
            f["line"]["params"]["item"]["text"] = "y" * 100000
        return frames
    if name == "edits and a failing command":
        frames = scenario("plain")
        thread, turn = ids(frames)
        at = frames.index(items(frames, "commandExecution", "item/started")[0])
        change = {"type": "fileChange", "id": "item_1", "changes": [{"path": "/work/repo/calc.py", "kind": {"type": "update", "move_path": None}, "diff": "-a\n+b\n"}, {"path": "/work/repo/test_calc.py", "kind": {"type": "add"}, "diff": "+ok\n"}], "status": "inProgress"}
        frames[at:at] = [note(frames[at], "item/started", {"item": change, "threadId": thread, "turnId": turn}), note(frames[at], "item/completed", {"item": dict(change, status="completed"), "threadId": thread, "turnId": turn})]
        for f in items(frames, "commandExecution", "item/started") + items(frames, "commandExecution"):
            f["line"]["params"]["item"]["command"] = "/bin/sh -lc 'cat /work/.secrets'"
        for f in items(frames, "commandExecution"):
            f["line"]["params"]["item"].update(aggregatedOutput="token=${FAKE_SIGN_IN}\n${FAKE_SIGNED_TOKEN}\n", exitCode=1, status="failed")
        for f in items(frames, "agentMessage"):
            f["line"]["params"]["item"]["text"] = "It printed ${FAKE_SIGNED_TOKEN} and stopped."
        return frames
    if name == "spent until another day":
        # Another day's reset, in 0.169.0's words (21 November 2026, against a stand-in for its plan's endpoint).
        frames = scenario("spent")
        at = next(i for i, f in enumerate(frames) if f["dir"] == "out" and isinstance(f["line"], dict) and f["line"].get("method") == "account/rateLimits/updated")
        return frames[:at] + refusal(frames, SPENT_LATER)
    if name == "spent midway":
        frames = scenario("plain")
        at = frames.index(items(frames, "commandExecution")[0])
        return frames[:at + 1] + refusal(frames)
    if name == "an error and nothing after it":
        frames = scenario("hello")
        thread, turn = ids(frames)
        error = {"message": "unexpected status 404 Not Found: no such route /responses", "codexErrorInfo": "other", "additionalDetails": None, "misalignment": None}
        said = lambda l: l.get("method", "").startswith("item/agentMessage") or ((l.get("params") or {}).get("item") or {}).get("type") == "agentMessage" or l.get("method") == "thread/tokenUsage/updated"
        kept = [f for f in frames if not (f["dir"] == "out" and isinstance(f["line"], dict) and said(f["line"]))]
        at = kept.index(outs(kept, lambda l: l.get("method") == "turn/completed")[0])
        kept[at:at] = [note(kept[at], "error", {"error": error, "willRetry": False, "threadId": thread, "turnId": turn})]
        kept[at + 1]["line"]["params"]["turn"].update(status="failed", error=error, items=[])
        return kept
    if name == "reconnects":
        # As 0.169.0 said them (21 Nov 2026, against a stand-in), now as its app server says them: errors it will retry.
        frames = scenario("hello")
        thread, turn = ids(frames)
        at = frames.index(items(frames, "agentMessage", "item/started")[0])
        frames[at:at] = [note(frames[at], "error", {"error": {"message": said, "codexErrorInfo": None, "additionalDetails": None, "misalignment": None}, "willRetry": True, "threadId": thread, "turnId": turn}) for said in ("Reconnecting... 1/5", "Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)")]
        return frames
    if name == "lingering":
        return lingering(scenario("hello"))
    return scenario(name)

# Its app server: asked for the account it holds (a seat's status), or given a thread to work in (a run), told apart by
# what follows its handshake. Its handshake is answered as 0.172.0 answered its bridge's.
live()
hello = next(f["line"] for f in scenario("plain") if f["dir"] == "out" and isinstance(f["line"], dict) and f["line"].get("id") == 1 and "result" in f["line"])
held = []
while True:
    kind, raw = inbox.get(timeout=30)
    if kind != "in":
        leave(0)
    said = json.loads(raw)
    held.append(said)
    if said.get("method") == "initialize":
        out(dict(hello, id=said["id"]))
    elif said.get("method") != "initialized":
        break
if said.get("method") == "account/read":
    record({"asked": "app-server", "argv": args})
    for item in held:
        record({"asked": item.get("method")})
    held_account = {"type": "chatgpt", "email": "agent@example.invalid", "planType": "plus", "workspaceName": "Fake Workspace"}
    out({"id": said["id"], "result": {"account": held_account if signed else None, "userId": "user-FAKE0000" if signed else None, "requiresOpenaiAuth": not signed}})
    for raw in iter(lambda: inbox.get()[1], None):
        pass
    leave(0)
if said.get("method") == "thread/resume":
    name = "resumed" if (said.get("params") or {}).get("threadId") == SESSION and chosen == "plain" else ("unknown-session" if chosen == "plain" else chosen)
else:
    name = chosen
frames = variant(name)
# (Its handshake was answered already: the replay goes on from the next line its bridge sends.)
start = next(i for i, f in enumerate(frames) if f["dir"] == "in" and isinstance(f["line"], dict) and f["line"].get("method") == "initialized")
first = []
def heard(line):
    method = line.get("method") if isinstance(line, dict) else None
    record({"told": method})
    if method == "turn/start" and not first:
        first.append(line)
        record({"argv": args, "env": dict(os.environ), "prompt": line["params"]["input"][0]["text"]})
    elif method in ("turn/steer", "turn/start"):
        record({"said": line["params"]["input"][0]["text"]})
Replay(frames[start:], [json.dumps(item).encode() for item in held[1:]]).play(heard)
`}`;

const TOOLS = {
  claude: { driver: CLAUDE, bridge: CLAUDE_BRIDGE, script: "/work/.agent/claude-code.py", standIn: CLAUDE_STAND_IN, name: "Claude Code" },
  codex: { driver: CODEX, bridge: CODEX_BRIDGE, script: "/work/.agent/codex.py", standIn: CODEX_STAND_IN, name: "Codex" },
};

/**
 * An agent's VM in miniature: the bridge, the stand-in CLI on PATH (or none), its sign-in state, and a gateway lease.
 * `engram`: the bridge as its driver writes it for a task that has the VM's notes store, under that project. A run is
 * given its message and, while it runs, its input: `start` hands it to the test (your words and its stop as they come);
 * `run` gives it none (its input ends at once, as /dev/null's does).
 */
function vm(tool: keyof typeof TOOLS, options: { installed?: boolean; signedIn?: boolean; apiKey?: boolean; engram?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `primary-${tool}-`));
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
  const fresh = { INVINCIBLE_GATEWAY: "http://192.0.2.1:7400/gw", INVINCIBLE_TOKEN: "gw_fake-fresh-lease", OPENAI_API_KEY: "gw_fake-fresh-lease", OPENAI_BASE_URL: "http://192.0.2.1:7400/gw/openai", ANTHROPIC_AUTH_TOKEN: "gw_fake-fresh-lease", ANTHROPIC_BASE_URL: "http://192.0.2.1:7400/gw/anthropic" };
  writeFileSync(lease, JSON.stringify(fresh), { mode: 0o600 });
  // What the VM's shell has: the owner's own settings, and every gateway variable (stale ones, as a container's are).
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8", OWNER_SET: "kept", ANTHROPIC_API_KEY: "fake-owner-key-in-this-vm", ...Object.fromEntries(GATEWAY_VARS.map((name) => [name, `http://192.0.2.2/stale-${name}`])) };
  const ended = async (proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">, out: Promise<string>) => {
    const [exit, stdout, stderr] = await Promise.all([proc.exited, out, new Response(proc.stderr).text()]);
    const lines = stdout.split("\n").filter(Boolean);
    return { exit, stdout, stderr, lines, events: lines.flatMap((line) => TOOLS[tool].driver.read(line)) };
  };
  /** A run, its input the test's: what it says as it says it (`seen`), and your words (`say`) or its stop (`stop`) when you like. */
  const start = (args: string[], prompt = "work", scenario?: string) => {
    writeFileSync(join(dir, "prompt.md"), prompt);
    if (scenario) writeFileSync(join(bin, "scenario"), scenario);
    else rmSync(join(bin, "scenario"), { force: true });
    const proc = Bun.spawn([PYTHON, join(dir, "bridge.py"), "--prompt", join(dir, "prompt.md"), "--gateway-env", lease, ...args], { cwd: work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const seen: AgentEvent[] = [];
    let text = "";
    const out = (async () => {
      const decoder = new TextDecoder();
      let held = "";
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        const part = decoder.decode(chunk, { stream: true });
        text += part;
        held += part;
        let at: number;
        while ((at = held.indexOf("\n")) >= 0) {
          seen.push(...TOOLS[tool].driver.read(held.slice(0, at)));
          held = held.slice(at + 1);
        }
      }
      return text;
    })();
    const write = (line: object) => {
      proc.stdin.write(`${JSON.stringify(line)}\n`);
      proc.stdin.flush();
    };
    return {
      seen,
      /** Until it has said what `find` looks for. */
      until: async (find: (event: AgentEvent) => boolean, ms = 10_000) => {
        const end = Date.now() + ms;
        while (!seen.some(find)) {
          if (Date.now() > end) throw new Error(`it never said what was waited for; it said ${JSON.stringify(seen)}`);
          await Bun.sleep(5);
        }
      },
      say: (id: string, words: string) => write({ say: words, id }),
      stop: () => write({ stop: true }),
      done: () => ended(proc, out),
    };
  };
  const run = async (args: string[], prompt = "work", scenario?: string) => {
    writeFileSync(join(dir, "prompt.md"), prompt);
    if (scenario) writeFileSync(join(bin, "scenario"), scenario);
    else rmSync(join(bin, "scenario"), { force: true });
    const proc = Bun.spawn([PYTHON, join(dir, "bridge.py"), "--prompt", join(dir, "prompt.md"), "--gateway-env", lease, ...args], { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return ended(proc, new Response(proc.stdout).text());
  };
  /** What the stand-in was asked and told: its whole lines (one may be being written as a test looks). */
  const trace = (): any[] => {
    if (!existsSync(join(bin, "trace.jsonl"))) return [];
    const text = readFileSync(join(bin, "trace.jsonl"), "utf8");
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  /** The runs the CLI was started for (not the questions about its sign-in). */
  const runs = () => trace().filter((item) => item.argv && !item.asked);
  return { dir, bin, env, fresh, run, start, trace, runs };
}

const OWN = ["--own"];
const CLAUDE_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--permission-mode", "bypassPermissions"];
const CODEX_RUN = ["app-server", "-c", 'cli_auth_credentials_store="file"'];
/** Your words as a run is told them (run.ts steersSaid), and what the loopback model answered when it was. */
const STEER = "The owner says, while you work: STEER-PROBE also say the word banana.\n\nTake that up from where you are: the run asks for it now, and the independent reviewer judges the work against it.";

describe("the vendors' own CLIs are harnesses", () => {
  test("the registry offers both, and each says which API its gateway models must speak", () => {
    expect(AGENTS.claude).toBe(CLAUDE);
    expect(AGENTS.codex).toBe(CODEX);
    expect([CLAUDE.kind, CODEX.kind, AGENTS.opencode!.kind, AGENTS.hermes!.kind]).toEqual(["anthropic", "openai", "openai", "openai"]);
    expect([CLAUDE.title, CODEX.title]).toEqual(["Claude Code", "Codex"]);
    expect(CLAUDE.files([])["/work/.agent/claude-code.py"]).toBe(CLAUDE_BRIDGE);
    expect(CODEX.files([])["/work/.agent/codex.py"]).toBe(CODEX_BRIDGE);
  });

  test("what each can do as it runs is declared, and only what it does: the vendors' tools are told your words as they work; the others are steered between their calls", () => {
    expect(CLAUDE.capabilities).toEqual({ steer: "live", streams: true, resumes: true, readsWindows: true });
    expect(CODEX.capabilities).toEqual({ steer: "live", streams: true, resumes: true, readsWindows: true });
    expect(AGENTS.opencode!.capabilities.steer).toBe("restart");
    expect(AGENTS.hermes!.capabilities.steer).toBe("restart");
  });

  test("every command is valid shell whatever a name holds, and a run on its own sign-in names no provider or model", () => {
    for (const driver of [CLAUDE, CODEX]) {
      const hostile = driver.command({ provider: "p'; $(danger)", model: "a/b' model" }, "session'; x");
      expect(Bun.spawnSync(["bash", "-n", "-c", hostile]).exitCode).toBe(0);
      expect(Bun.spawnSync(["bash", "-n", "-c", driver.check]).exitCode).toBe(0);
      const own = driver.command(OWN_SIGN_IN, SESSION.claude);
      expect(own).toContain(` --own --session '${SESSION.claude}'`);
      expect(own).not.toMatch(/--provider|--model/);
      expect(driver.command({ provider: "anthropic", model: "claude-opus-5-5" }, null)).toContain("--provider 'anthropic' --model 'claude-opus-5-5'");
      expect(driver.read("not json")).toEqual([]);
      expect(driver.read('{"type":"tokens","input":-1,"output":1}')).toEqual([]);
      // Your words said back: only by an id of the node's own shape, and only how far they got.
      expect(driver.read('{"type":"steer","id":"abc_DEF-123","state":"taken"}')).toEqual([{ type: "steer", id: "abc_DEF-123", state: "taken" }]);
      expect(driver.read('{"type":"steer","id":"abc; rm -rf /","state":"taken"}')).toEqual([]);
      expect(driver.read('{"type":"steer","id":"abc","state":"done"}')).toEqual([]);
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
      { type: "session", id: "00000000-0000-4000-8000-000000000003" },
      // (A call is said as it begins, and its end names it: a steer of a tool that can't be told at once waits for it.)
      { type: "call", id: "toolu_fake0223" },
      { type: "tool", tool: "Bash", input: "sleep 4 && echo slept", output: "slept", ok: true, id: "toolu_fake0223" },
      { type: "text", text: "PROBE-DONE: the command said slept." },
      { type: "tokens", input: 240, output: 24 },
    ]);
    const [started] = box.runs();
    // The vendor's own flags and nothing else; its message the first on its input.
    expect(started.argv).toEqual(CLAUDE_FLAGS);
    expect(started.prompt).toBe("Fix it ‘now’");
    // Its input closed once its turn and every message it was given had ended: so the tool ended.
    expect(box.trace().some((item) => item.eof)).toBe(true);
  });

  test("it is never pointed at your agent's gateway: every gateway variable is gone from its environment, and the rest is the VM's own", async () => {
    const box = vm("claude");
    await box.run(OWN);
    const [started] = box.runs();
    for (const name of GATEWAY_VARS) expect([name, started.env[name]]).toEqual([name, undefined]);
    expect(JSON.stringify(started.env)).not.toContain("gw_fake");
    expect(JSON.stringify(started.env)).not.toContain("192.0.2.");
    // What the owner set up in the VM is the tool's to read: nothing of it is taken away, and nothing is added.
    expect(started.env).toMatchObject({ OWNER_SET: "kept", HOME: box.env.HOME, ANTHROPIC_API_KEY: "fake-owner-key-in-this-vm" });
    const added = Object.keys(started.env).filter((name) => !(name in box.env));
    expect(added.filter((name) => !HOST_ADDED.has(name))).toEqual([]);
  });

  test("a resumed run continues the session it is given, and one the tool doesn't know is not replaced with a new one", async () => {
    const box = vm("claude");
    const resumed = await box.run([...OWN, "--session", SESSION.claude], "continue");
    expect(resumed.exit).toBe(0);
    expect(resumed.events[0]).toEqual({ type: "session", id: SESSION.claude });
    expect(box.runs()[0].argv).toEqual([...CLAUDE_FLAGS, "--resume", SESSION.claude]);
    const unknown = await box.run([...OWN, "--session", "00000000-0000-4000-8000-00000000dead"], "continue");
    expect(unknown.exit).toBe(1);
    expect(unknown.events.filter((event) => event.type === "session")).toEqual([]);
    // (In its own words, as 2.1.326 ends: a result of an error's kind, its reason in its errors.)
    expect(unknown.events.at(-1)).toEqual({ type: "error", message: "Claude Code ended with an error (error_during_execution): No conversation found with session ID: 00000000-0000-4000-8000-00000000dead" });
    // A session id is the tool's own word, and is never read as a flag.
    for (const flag of ["--session=--dangerously-skip-permissions", "--session=-c"]) expect((await box.run([...OWN, flag], "continue")).exit).toBe(1);
    expect(box.runs()).toHaveLength(2);
  });

  test("a failed tool call is shown as failed, with what it printed, and a secret in it is redacted", async () => {
    const run = await vm("claude").run(OWN, "work", "a tool fails");
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
    const run = await vm("claude").run(OWN, "work", "long");
    expect(run.exit).toBe(0);
    expect(run.lines.length).toBeGreaterThanOrEqual(4);
    for (const line of run.lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16_000);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const tool = run.events.find((event) => event.type === "tool")!;
    expect(tool).toMatchObject({ type: "tool", tool: "Bash", input: "sleep 4 && echo slept", ok: true });
    expect(tool.type === "tool" && tool.output.startsWith("ééé") && tool.output.endsWith("ééé")).toBe(true);
    const text = run.events.filter((event) => event.type === "text");
    // Its last words once, not again as the result.
    expect(text).toHaveLength(1);
    expect(text[0]!.type === "text" && text[0]!.text.startsWith("yyy")).toBe(true);
  });

  test("what the tool prints is data: half a character, a line that isn't JSON and an event that isn't one are passed over, and the run goes on", async () => {
    const run = await vm("claude").run(OWN, "work", "half a character");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(run.events.map((event) => event.type)).toEqual(["session", "text", "tokens"]);
    expect(run.events[1]).toEqual({ type: "text", text: "cut here ?" });
  });

  test("a spent allowance ends the run as failed, with when it resets; a run that never got a reply leaves no session to continue", async () => {
    const box = vm("claude");
    const started = Date.now();
    const run = await box.run(OWN, "work", "spent before any reply");
    // (A tool waiting for its window would wait: the bridge stops it by its own interrupt.)
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(run.exit).toBe(1);
    expect(run.events).toEqual([{ type: "error", message: "Claude Code's allowance is spent; it resets 2026-01-01 04:00 UTC" }]);
    expect(box.trace().filter((item) => item.signal)).toEqual([{ signal: 2 }]);
    // (As recorded on a real plan, the allowance fine, beside "overageStatus":"rejected": only `status` says a run is refused.)
    expect(LIMIT).toContain('"overageStatus":"rejected"');
  }, 20_000);

  test("spent in the middle of the work, the session stays to be continued on the next model", async () => {
    const run = await vm("claude").run(OWN, "work", "spent midway");
    expect(run.exit).toBe(1);
    expect(run.events[0]).toEqual({ type: "session", id: "00000000-0000-4000-8000-000000000003" });
    expect(run.events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(run.events.at(-1)).toEqual({ type: "error", message: "Claude Code's allowance is spent (it needs usage credits to go on); it resets 2026-01-01 04:00 UTC" });
  });

  test("a result that is an error ends the run as failed, in the tool's own words (a limit it names only there, with its reset)", async () => {
    // As 2.1.326 said a refusal through a gateway (a 429): a notice of its own, then a result that is an error.
    const spent = await vm("claude").run(OWN, "work", "spent");
    expect(spent.exit).toBe(1);
    expect(spent.events.at(-1)).toEqual({ type: "error", message: "Claude Code ended with an error (rate_limit): API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." });
    const run = await vm("claude").run(OWN, "work", "limit said only in the result");
    expect(run.exit).toBe(1);
    const last = run.events.at(-1)!;
    expect(last.type === "error" && last.message).toBe("Claude Code ended with an error (rate_limit): You've hit your weekly limit · resets Mon 12:00am");
    // The tool's own notice of the failure is not its answer, and not a reply worth continuing.
    expect(run.events.filter((event) => event.type === "text" || event.type === "session")).toEqual([]);
    // A result of an error's kind is one, whatever its flag says and whatever the tool exits with.
    const turns = await vm("claude").run(OWN, "work", "out of turns");
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
    expect(run.events).toEqual([{ type: "error", message: "Claude Code is not installed in this VM; its owner installs it there (Invincible never does)" }]);
    expect(readdirSync(box.bin)).toEqual(["signed-in"]);
  });
});

describe("Claude Code, told as it works", () => {
  test("your words during its tool call: queued at once, taken once the call ends, in the same turn, and answered", async () => {
    const box = vm("claude");
    const run = box.start(OWN, "work", "steer-mid-tool");
    await run.until((event) => event.type === "call");
    run.say("steer_0001", STEER);
    const done = await run.done();
    expect({ exit: done.exit, stderr: done.stderr }).toEqual({ exit: 0, stderr: "" });
    const told = done.events.filter((event) => event.type === "steer");
    expect(told).toEqual([{ type: "steer", id: "steer_0001", state: "queued" }, { type: "steer", id: "steer_0001", state: "taken" }]);
    // Taken after its call ended, and answered after that: one turn, one launch, nothing ended for it.
    const at = (find: (event: AgentEvent) => boolean) => done.events.findIndex(find);
    expect(at((e) => e.type === "steer" && e.state === "taken")).toBeGreaterThan(at((e) => e.type === "tool"));
    expect(done.events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "STEER-ACK: also say the word banana." }]);
    // The tool was told your words as you gave them, once, as one more message of its own conversation.
    expect(box.trace().filter((item) => "said" in item)).toEqual([{ said: STEER }]);
  });

  test("your words while it answers: queued at once; it takes them once its answer ends, in a turn of their own", async () => {
    const run = vm("claude").start(OWN, "work", "steer-mid-answer");
    await run.until((event) => event.type === "tool");
    run.say("steer_0002", STEER);
    const done = await run.done();
    expect(done.exit).toBe(0);
    expect(done.events.filter((event) => event.type === "steer").map((event) => event.type === "steer" && event.state)).toEqual(["queued", "taken"]);
    expect(done.events.filter((event) => event.type === "text").map((event) => event.type === "text" && event.text)).toEqual(["PROBE-DONE: the command said slept.", "STEER-ACK: also say the word banana."]);
    // Two turns, so two results: what it spent is both.
    expect(done.events.filter((event) => event.type === "tokens")).toEqual([{ type: "tokens", input: 240, output: 24 }, { type: "tokens", input: 120, output: 12 }]);
  });

  test("your stop during its tool call: its own interrupt (SIGINT) ends its turn and the tool, and the run is no failure", async () => {
    const box = vm("claude");
    const run = box.start(OWN, "work", "stop");
    await run.until((event) => event.type === "call");
    run.stop();
    const done = await run.done();
    expect({ exit: done.exit, stderr: done.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(box.trace().filter((item) => item.signal)).toEqual([{ signal: 2 }]);
    expect(done.events.filter((event) => event.type === "error")).toEqual([]);
  });

  test("words that come once its input has closed are said back late, never lost: its next run says them", async () => {
    const box = vm("claude");
    const run = box.start(OWN, "work", "lingering");
    const end = Date.now() + 10_000;
    while (!box.trace().some((item) => item.eof) && Date.now() < end) await Bun.sleep(5);
    run.say("steer_0003", STEER);
    const done = await run.done();
    expect(done.exit).toBe(0);
    expect(done.events.filter((event) => event.type === "steer")).toEqual([{ type: "steer", id: "steer_0003", state: "late" }]);
    // (The tool was never told them: its input had closed.)
    expect(box.trace().filter((item) => "said" in item)).toEqual([]);
  });

  test("what the node tells it is data: a line that isn't one of its own, or words without an id of its shape, are passed over", async () => {
    const box = vm("claude");
    const run = box.start(OWN, "work", "steer-mid-tool");
    await run.until((event) => event.type === "call");
    run.say("not an id; $(x)", "ignored");
    run.say("", "ignored too");
    run.say("steer_0004", STEER);
    const done = await run.done();
    expect(done.exit).toBe(0);
    expect(done.events.filter((event) => event.type === "steer").map((event) => event.type === "steer" && event.id)).toEqual(["steer_0004", "steer_0004"]);
    expect(box.trace().filter((item) => "said" in item)).toEqual([{ said: STEER }]);
  });
});

describe("Claude Code, through the gateway", () => {
  test("a keyed roster model: the tool's own documented variables point it at that provider, on this VM's fresh lease", async () => {
    const box = vm("claude", { signedIn: false });
    const run = await box.run(["--provider", "anthropic", "--model", "claude-opus-5-5", "--session", SESSION.claude]);
    expect(run.exit).toBe(0);
    const [started] = box.runs();
    expect(started.argv).toEqual([...CLAUDE_FLAGS, "--model", "claude-opus-5-5", "--resume", SESSION.claude]);
    expect(started.env.ANTHROPIC_BASE_URL).toBe("http://192.0.2.1:7400/gw/anthropic");
    expect(started.env.ANTHROPIC_AUTH_TOKEN).toBe("gw_fake-fresh-lease");
    // A key of the owner's own in the VM is not sent to the gateway beside its token.
    expect(started.env.ANTHROPIC_API_KEY).toBeUndefined();
    // It is asked nothing about a sign-in: this run is not on one.
    expect(box.trace().filter((item) => item.asked)).toEqual([]);
  });

  test("a lease that isn't whole stops the run before the tool starts; so does a provider or model that would read as a flag", async () => {
    const box = vm("claude");
    writeFileSync(join(box.dir, "gateway.json"), '{"INVINCIBLE_TOKEN":"gw_fake-incomplete"}');
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
      { type: "call", id: "call_fake0227" },
      // (A session worth continuing once something was done in it.)
      { type: "session", id: "00000000-0000-4000-8000-000000000055" },
      { type: "tool", tool: "shell", input: "/bin/sh -lc 'sleep 4 && echo slept'", output: "slept\n", ok: true, id: "call_fake0227" },
      // Each of its model calls, as its thread's totals grew.
      { type: "tokens", input: 120, output: 12 },
      { type: "text", text: "PROBE-DONE: the command said slept." },
      { type: "tokens", input: 120, output: 12 },
    ]);
    const [started] = box.runs();
    expect(started.argv).toEqual(CODEX_RUN);
    expect(started.prompt).toBe("Fix it ‘now’");
    // Asked only to work: its client named, a thread never asking approval with no sandbox of its own (the VM is the boundary).
    expect(box.trace().filter((item) => "told" in item).map((item) => item.told)).toEqual(["initialized", "thread/start", "turn/start"]);
    for (const name of GATEWAY_VARS) expect([name, started.env[name]]).toEqual([name, undefined]);
    expect(JSON.stringify(started.env)).not.toContain("gw_fake");
    expect(started.env).toMatchObject({ OWNER_SET: "kept", HOME: box.env.HOME });
    const added = Object.keys(started.env).filter((name) => !(name in box.env));
    expect(added.filter((name) => !HOST_ADDED.has(name))).toEqual([]);
  });

  test("a resumed run is its own thread/resume, what it spent is only this run's, and an unknown session is not replaced with a new one", async () => {
    const box = vm("codex");
    const resumed = await box.run([...OWN, "--session", SESSION.codex], "continue");
    expect(resumed.exit).toBe(0);
    expect(box.trace().filter((item) => "told" in item).map((item) => item.told)).toEqual(["initialized", "thread/resume", "turn/start"]);
    expect(resumed.events.filter((event) => event.type === "session")).toEqual([{ type: "session", id: SESSION.codex }]);
    // (Resumed, its thread says its totals so far before this run's turn: they are not this run's.)
    expect(resumed.events.filter((event) => event.type === "tokens")).toEqual([{ type: "tokens", input: 120, output: 12 }]);
    const unknown = await box.run([...OWN, "--session", "019a0000-0000-7000-8000-00000000dead"], "continue");
    expect(unknown.exit).toBe(1);
    expect(unknown.events).toEqual([{ type: "error", message: "The saved Codex session is not one it knows; it was not replaced (no rollout found for thread id 019a0000-0000-7000-8000-00000000dead)" }]);
  });

  test("edits are shown as what changed, a failing command as failed, and a secret in its output is redacted", async () => {
    const run = await vm("codex").run(OWN, "work", "edits and a failing command");
    expect(run.exit).toBe(0);
    const tools = run.events.filter((event) => event.type === "tool");
    expect(tools[0]).toEqual({ type: "tool", tool: "edit", input: "update /work/repo/calc.py\nadd /work/repo/test_calc.py", output: "", ok: true, id: "item_1" });
    expect(tools[1]).toMatchObject({ tool: "shell", input: "/bin/sh -lc 'cat /work/.secrets'", ok: false });
    expect(JSON.stringify(run.events)).not.toContain(FAKE_SIGN_IN);
    expect(JSON.stringify(run.events)).not.toContain(FAKE_SIGNED_TOKEN);
    expect(JSON.stringify(tools[1])).toContain("[redacted");
    expect(run.events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "It printed [redacted token] and stopped." }]);
  });

  test("a very long line is clipped whole", async () => {
    const run = await vm("codex").run(OWN, "work", "long");
    expect(run.exit).toBe(0);
    for (const line of run.lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16_000);
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const tool = run.events.find((event) => event.type === "tool")!;
    expect(tool.type === "tool" && tool.output.startsWith("ééé") && tool.output.length < 5000).toBe(true);
    expect(run.events.some((event) => event.type === "text" && event.text.startsWith("yyy"))).toBe(true);
  });

  test("a spent allowance (its error, usageLimitExceeded, and its failed turn) ends the run as failed, said as Claude Code's is, with when it resets in UTC", async () => {
    // Its words give a time by the VM's clock: here an hour ahead of UTC (a POSIX zone, which needs no zone database).
    const box = vm("codex");
    box.env.TZ = "CET-1";
    const atStart = await box.run(OWN, "work", "spent");
    expect(atStart.exit).toBe(1);
    // Nothing was answered: there is no session to continue.
    expect(atStart.events.map((event) => event.type)).toEqual(["error"]);
    const said = atStart.events[0]!;
    // ("try again at 11:45 PM", as 0.172.0 said it, is 22:45 UTC an hour ahead of it.)
    expect(said.type === "error" && said.message).toMatch(/^Codex's allowance is spent; it resets \d{4}-\d{2}-\d{2} 22:45 UTC$/);
    // Another day's reset, in 0.169.0's words (its apostrophe curly), and without the offers around it.
    const later = await box.run(OWN, "work", "spent until another day");
    expect(later.events).toEqual([{ type: "error", message: "Codex's allowance is spent; it resets 2026-11-23 19:11 UTC" }]);
    const midway = await vm("codex").run(OWN, "work", "spent midway");
    expect(midway.exit).toBe(1);
    expect(midway.events.find((event) => event.type === "session")).toEqual({ type: "session", id: "00000000-0000-4000-8000-000000000055" });
    expect(midway.events.at(-1)!.type).toBe("error");
  });

  test("an error it won't retry, its turn failed, is a failure even if the tool exits 0; one it retries and recovers from is not", async () => {
    const dead = await vm("codex").run(OWN, "work", "an error and nothing after it");
    expect(dead.exit).toBe(1);
    expect(dead.events.at(-1)).toEqual({ type: "error", message: "Codex stopped: unexpected status 404 Not Found: no such route /responses" });
    const recovered = await vm("codex").run(OWN, "work", "reconnects");
    expect(recovered.exit).toBe(0);
    expect(recovered.events.at(-1)).toEqual({ type: "tokens", input: 120, output: 12 });
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
    expect(missing.events).toEqual([{ type: "error", message: "Codex is not installed in this VM; its owner installs it there (Invincible never does)" }]);
  });
});

describe("Codex, told as it works", () => {
  test("your words during its command: turn/steer of the turn under way, queued at once, taken once the command ends, and answered in that turn", async () => {
    const box = vm("codex");
    const run = box.start(OWN, "work", "steer-mid-tool");
    await run.until((event) => event.type === "call");
    run.say("steer_0005", STEER);
    const done = await run.done();
    expect({ exit: done.exit, stderr: done.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(done.events.filter((event) => event.type === "steer")).toEqual([{ type: "steer", id: "steer_0005", state: "queued" }, { type: "steer", id: "steer_0005", state: "taken" }]);
    const at = (find: (event: AgentEvent) => boolean) => done.events.findIndex(find);
    expect(at((e) => e.type === "steer" && e.state === "taken")).toBeGreaterThan(at((e) => e.type === "tool"));
    expect(done.events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "STEER-ACK: also say the word banana." }]);
    expect(box.trace().filter((item) => "told" in item).map((item) => item.told)).toEqual(["initialized", "thread/start", "turn/start", "turn/steer"]);
    expect(box.trace().filter((item) => "said" in item)).toEqual([{ said: STEER }]);
  });

  test("your words while it answers: it takes them at once (0.172.0 lets the answer go), and answers them", async () => {
    const run = vm("codex").start(OWN, "work", "steer-mid-answer");
    await run.until((event) => event.type === "tool");
    run.say("steer_0006", STEER);
    const done = await run.done();
    expect(done.exit).toBe(0);
    expect(done.events.filter((event) => event.type === "steer").map((event) => event.type === "steer" && event.state)).toEqual(["queued", "taken"]);
    expect(done.events.filter((event) => event.type === "text").at(-1)).toEqual({ type: "text", text: "STEER-ACK: also say the word banana." });
  });

  test("your stop during its command: turn/interrupt, its turn ends interrupted, its input closes, and the run is no failure", async () => {
    const box = vm("codex");
    const run = box.start(OWN, "work", "stop");
    await run.until((event) => event.type === "call");
    run.stop();
    const done = await run.done();
    expect({ exit: done.exit, stderr: done.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(box.trace().filter((item) => "told" in item).map((item) => item.told)).toEqual(["initialized", "thread/start", "turn/start", "turn/interrupt"]);
    expect(done.events.filter((event) => event.type === "error")).toEqual([]);
  });

  test("words that come once its input has closed are said back late, never lost: its next run says them", async () => {
    const box = vm("codex");
    const run = box.start(OWN, "work", "lingering");
    const end = Date.now() + 10_000;
    while (!box.trace().some((item) => item.eof) && Date.now() < end) await Bun.sleep(5);
    run.say("steer_0007", STEER);
    const done = await run.done();
    expect(done.exit).toBe(0);
    expect(done.events.filter((event) => event.type === "steer")).toEqual([{ type: "steer", id: "steer_0007", state: "late" }]);
    expect(box.trace().filter((item) => "said" in item)).toEqual([]);
  });
});

describe("Codex, through the gateway", () => {
  test("a keyed roster model: a model_providers entry on the Responses API, the bearer read from this VM's fresh lease", async () => {
    const box = vm("codex", { signedIn: false });
    const run = await box.run(["--provider", "orcarouter", "--model", "gpt-6.1-sol"]);
    expect(run.exit).toBe(0);
    const [started] = box.runs();
    expect(started.argv).toEqual([
      ...CODEX_RUN,
      "-c", 'model="gpt-6.1-sol"',
      "-c", 'model_provider="invincible"',
      "-c", 'model_providers.invincible.name="Invincible gateway"',
      "-c", 'model_providers.invincible.base_url="http://192.0.2.1:7400/gw/orcarouter"',
      "-c", 'model_providers.invincible.env_key="INVINCIBLE_TOKEN"',
      "-c", 'model_providers.invincible.wire_api="responses"',
    ]);
    // The token is in the environment the entry names, never in an argument.
    expect(started.env.INVINCIBLE_TOKEN).toBe("gw_fake-fresh-lease");
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
    for (const told of ["agent@example.invalid", "org-FAKE-0000", "Fake Org", "max"]) expect(claude.run.stdout + claude.run.stderr).not.toContain(told);
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
      expect(read('{"type":"status","installed":true,"signedIn":true,"method":"agent@example.invalid"}')).toEqual({ signedIn: true });
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

  test("Claude Code is pointed at a file of your agent's own with --mcp-config: one stdio server, on every run, new or resumed, on its sign-in or through the gateway", async () => {
    const files = CLAUDE.files([], "you-project");
    expect(Object.keys(files)).toEqual(["/work/.agent/claude-code.py", MCP_FILE]);
    expect(JSON.parse(files[MCP_FILE]!)).toEqual({ mcpServers: { engram: { type: "stdio", command: ENGRAM_BIN, args: engramArgv("you-project").slice(1), env: { ENGRAM_DATA_DIR: "/work/.memory/engram", ENGRAM_NO_UPDATE_CHECK: "1" } } } });
    const box = vm("claude", { engram: "you-project" });
    const run = await box.run(OWN, "Fix it ‘now’");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    // What it reports is what it reports without the store.
    expect(run.events).toEqual((await vm("claude").run(OWN, "Fix it ‘now’")).events);
    await box.run([...OWN, "--session", SESSION.claude], "continue");
    await box.run(["--provider", "anthropic", "--model", "claude-opus-5-5", "--session", SESSION.claude]);
    expect(box.runs().map((started) => started.argv)).toEqual([
      [...CLAUDE_FLAGS, ...CLAUDE_NOTES],
      // (The flag takes every word up to the next flag: it is never the last thing before a session's id.)
      [...CLAUDE_FLAGS, ...CLAUDE_NOTES, "--resume", SESSION.claude],
      [...CLAUDE_FLAGS, "--model", "claude-opus-5-5", ...CLAUDE_NOTES, "--resume", SESSION.claude],
    ]);
    // Nothing of the store is put in the tool's own environment: the file says it all.
    for (const started of box.runs()) expect(Object.keys(started.env).filter((name) => name.startsWith("ENGRAM"))).toEqual([]);
    // On its sign-in it is still never pointed at the gateway.
    for (const name of GATEWAY_VARS) expect([name, box.runs()[0].env[name]]).toEqual([name, undefined]);
  });

  test("Codex is given three -c overrides of its own kind (a command, its arguments, its environment), on every run of its app server, new or resumed, beside the gateway's when it runs through it", async () => {
    expect(Object.keys(CODEX.files([], "you-project"))).toEqual(["/work/.agent/codex.py"]);
    const box = vm("codex", { engram: "you-project" });
    const run = await box.run(OWN, "Fix it ‘now’");
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(run.events).toEqual((await vm("codex").run(OWN, "Fix it ‘now’")).events);
    await box.run([...OWN, "--session", SESSION.codex], "continue");
    await box.run(["--provider", "orcarouter", "--model", "gpt-6.1-sol"]);
    const [fresh, resumed, gateway] = box.runs().map((started) => started.argv);
    expect(fresh).toEqual([...CODEX_RUN, ...CODEX_NOTES]);
    // (Resumed by its own thread/resume, as it is told on its input: its arguments are a fresh run's.)
    expect(resumed).toEqual([...CODEX_RUN, ...CODEX_NOTES]);
    expect(gateway.slice(0, CODEX_RUN.length + 2)).toEqual([...CODEX_RUN, "-c", 'model="gpt-6.1-sol"']);
    expect(gateway.filter((word: string) => word.startsWith("model_providers.invincible."))).toHaveLength(4);
    expect(gateway.slice(-6)).toEqual(CODEX_NOTES);
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
  const replies = (): Record<RunRole, string[]> => ({ planner: ["1. Fix calc.py.\nDone when: the test passes."], engineer: [], reviewer: ["PASS"] });
  const models = [OWN_SIGN_IN, { provider: "anthropic", model: "claude-opus-5-5" }];
  const run = async (driver: AgentDriver, box: ReturnType<typeof sandbox>, events: RunEvent[]) => {
    const said = replies();
    return runLoop(
      { goal: "make the test pass", environment: "a sandbox", agent: { driver, models, minutes: 30, workdir: "/work/repo" } },
      { ask: async (role) => ({ text: said[role].shift()!, model: `test/${role}` }), exec: box.exec, emit: (event) => events.push(event), sleep: async () => {} },
    );
  };

  test("the sign-in goes first; its allowance spent before it answered, the roster's model starts the work afresh through the gateway", async () => {
    const box = sandbox([
      { lines: [{ type: "error", message: "Claude Code's allowance is spent; it resets 2026-01-01 04:00 UTC" }], exit: 1 },
      { lines: [{ type: "session", id: SESSION.claude }, { type: "text", text: "The test passes now." }], exit: 0 },
    ]);
    const events: RunEvent[] = [];
    expect((await run(CLAUDE, box, events)).status).toBe("done");
    expect(box.launches).toHaveLength(2);
    expect(box.launches[0]).toContain("claude-code.py --own");
    expect(box.launches[0]).not.toContain("--provider");
    expect(box.launches[1]).toContain("claude-code.py --provider");
    expect(box.launches[1]).toContain("anthropic");
    expect(box.launches[1]).toContain("claude-opus-5-5");
    expect(box.launches[1]).not.toContain("--own");
    expect(box.launches[1]).not.toContain("--session");
    // No session came of the first run, so the second is given the whole run, not "continue".
    expect(box.prompt(box.launches[1]!)).toBe(box.prompt(box.launches[0]!));
    expect(events.find((event) => event.type === "retry")).toMatchObject({ role: "engineer", attempt: 1, error: "its own sign-in: Claude Code's allowance is spent; it resets 2026-01-01 04:00 UTC\nit exited with 1" });
    for (const command of box.launches) expect(Bun.spawnSync(["bash", "-n", "-c", command]).stderr.toString()).toBe("");
  });

  test("spent midway, the roster's model continues the same session and is told why", async () => {
    const box = sandbox([
      { lines: [{ type: "session", id: SESSION.codex }, { type: "tool", tool: "shell", input: "python3 test_calc.py", output: "AssertionError", ok: false }, { type: "error", message: "Codex stopped: You've hit your usage limit. Try again at 3:45 PM." }], exit: 1 },
      { lines: [{ type: "text", text: "The test passes now." }], exit: 0 },
    ]);
    const events: RunEvent[] = [];
    expect((await run(CODEX, box, events)).status).toBe("done");
    expect(box.launches[0]).toContain("codex.py --own");
    expect(box.launches[1]).toContain("codex.py --provider");
    expect(box.launches[1]).toContain(`--session`);
    expect(box.launches[1]).toContain(SESSION.codex);
    const second = box.prompt(box.launches[1]!);
    expect(second).toContain("You've hit your usage limit");
    expect(second).toContain("you're now on anthropic/claude-opus-5-5");
    expect(events.some((event) => event.type === "thought" && event.model === "codex · anthropic/claude-opus-5-5")).toBe(true);
  });
});

/*
 * A seat's status (I15; core's seats.ts): asked with the salt its account's fingerprint is made with, the bridge says
 * three things more than whether the tool is signed in and how: the plan's tier, the account as a salted hash made in the
 * VM, and when the sign-in ends. Nothing else the tool says of its account leaves the VM, and what the VM says is data.
 */
describe("a seat's status", () => {
  // (Fake: a salt for tests alone.)
  const SALT = "RkFLRS1zZWF0LXNhbHQtMDAwMA";
  /**
   * HMAC-SHA-256 as RFC 2104 makes it, from plain SHA-256, to check the VM's own: Bun's keyed hasher fails with an
   * OpenSSL error another test's elliptic-curve check can leave queued in the process (POINT_IS_NOT_ON_CURVE), so a run
   * of the whole suite failed where this file alone passed.
   */
  const fingerprintOf = (salt: string, id: string) => {
    const sha = (data: Uint8Array) => new Uint8Array(new Bun.CryptoHasher("sha256").update(data).digest());
    const key = new Uint8Array(64);
    key.set(Buffer.from(salt, "base64url"));
    const pad = (byte: number) => key.map((k) => k ^ byte);
    const inner = sha(Buffer.concat([pad(0x36), Buffer.from(id, "utf8")]));
    return Buffer.from(sha(Buffer.concat([pad(0x5c), inner]))).subarray(0, 16).toString("base64url");
  };
  const told = (run: { lines: string[] }) => JSON.parse(run.lines.at(-1)!);

  test("Claude Code: its tier, its organization as a salted hash, when its sign-in ends; never whose it is", async () => {
    const box = vm("claude");
    const run = await box.run(["--status", "--salt", SALT]);
    expect(run.exit).toBe(0);
    const expected = { type: "status", installed: true, signedIn: true, method: "claude.ai", plan: "max", fingerprint: fingerprintOf(SALT, "claude.ai:org-FAKE-0000"), renewBy: Date.parse("2026-12-24T10:00:00.000Z") };
    expect(told(run)).toEqual(expected);
    for (const kept of ["agent@example.invalid", "org-FAKE-0000", "Fake Org"]) expect(run.stdout).not.toContain(kept);
    const { type: _type, installed: _installed, ...read } = expected;
    expect(CLAUDE.signIn!.read(run.stdout)).toEqual(read);
    // The same account is the same fingerprint with the same salt, and another with another.
    expect(told(await box.run(["--status", "--salt", SALT])).fingerprint).toBe(expected.fingerprint);
    expect(told(await box.run(["--status", "--salt", "QW5vdGhlci1zZWF0LXNhbHQtMQ"])).fingerprint).not.toBe(expected.fingerprint);
  });

  test("Codex: its tier and its user from its own app server, where it is only asked for the account it holds", async () => {
    const box = vm("codex");
    const run = await box.run(["--status", "--salt", SALT]);
    expect(told(run)).toEqual({ type: "status", installed: true, signedIn: true, method: "chatgpt", plan: "plus", fingerprint: fingerprintOf(SALT, "chatgpt:user-FAKE0000") });
    for (const kept of ["agent@example.invalid", "user-FAKE0000", "Fake Workspace"]) expect(run.stdout).not.toContain(kept);
    const server = box.trace().filter((item) => item.asked === "app-server");
    expect(server.map((item) => item.argv)).toEqual([["app-server", "-c", 'cli_auth_credentials_store="file"']]);
    expect(box.trace().filter((item) => typeof item.asked === "string" && item.asked.includes("/") || item.asked === "initialize" || item.asked === "initialized").map((item) => item.asked)).toEqual(["initialize", "initialized", "account/read"]);
  });

  test("asked without a salt (an agent's readiness), it says only whether and how, and Codex's app server isn't started", async () => {
    for (const tool of ["claude", "codex"] as const) {
      const box = vm(tool);
      const run = await box.run(["--status"]);
      expect(Object.keys(told(run)).sort()).toEqual(["installed", "method", "signedIn", "type"]);
      expect(box.trace().some((item) => item.asked === "app-server")).toBe(false);
    }
    // Not signed in: nothing more, whatever the salt.
    const out = await vm("claude", { signedIn: false }).run(["--status", "--salt", SALT]);
    expect(told(out)).toEqual({ type: "status", installed: true, signedIn: false });
  });

  test("what a VM says is data: a tier that isn't one plain word, a fingerprint of another shape, a time that isn't one, anything else, are dropped", () => {
    for (const driver of [CLAUDE, CODEX]) {
      const line = (more: Record<string, unknown>) => JSON.stringify({ type: "status", signedIn: true, method: "claude.ai", ...more });
      expect(driver.signIn!.read(line({ plan: "max plan", fingerprint: "short", renewBy: "soon", email: "agent@example.invalid", orgId: "org-FAKE" }))).toEqual({ signedIn: true, method: "claude.ai" });
      expect(driver.signIn!.read(line({ plan: "sk-ant-oat01-fake-not-a-token-0000" }))).toEqual({ signedIn: true, method: "claude.ai" });
      expect(driver.signIn!.read(line({ renewBy: 1.5 }))).toEqual({ signedIn: true, method: "claude.ai" });
      expect(driver.signIn!.read(line({ plan: "pro", fingerprint: "A".repeat(22), renewBy: 1_800_000_000_000 }))).toEqual({ signedIn: true, method: "claude.ai", plan: "pro", fingerprint: "A".repeat(22), renewBy: 1_800_000_000_000 });
    }
  });

  test("a salt that isn't one is refused before the tool is asked anything", async () => {
    const box = vm("claude");
    const run = await box.run(["--status", "--salt", "not a salt; $(id)"]);
    expect(run.exit).toBe(1);
    expect(box.trace()).toEqual([]);
    expect(Bun.spawnSync(["bash", "-n", "-c", CLAUDE.signIn!.seatCheck("x'; $(danger)")]).exitCode).toBe(0);
  });
});

describe("a subscription's sign-in never reaches your agent", () => {
  test("no shipped source names where either tool keeps its sign-in, but to tell a seat's tool its own home: nothing reads, copies or moves one", () => {
    // Each tool's sign-in, and the variables that carry one: named nowhere.
    const kept = [".credentials.json", "CLAUDE_CODE_OAUTH", "auth.json", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY"];
    // Where each tool keeps its home: named in one place only, to tell a seat's tool the seat's own home (I15 step 3),
    // as a path under it and nothing else, so no source finds or reads what a tool keeps there.
    const homes = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"];
    const POINTED = "packages/sandbox/src/spec.ts";
    const pointsAtSeatHome = (text: string, name: string) => {
      const lines = text.split("\n").filter((line) => line.includes(name));
      return lines.length === 1 && new RegExp(`^  if \\(kind === "[a-z-]+"\\) return \\{ ${name}: \`\\$\\{home\\}/[a-z]+\` \\};$`).test(lines[0]!);
    };
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
    const found = sources.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const rel = path.slice(root.length);
      const named = [...kept, ...homes].filter((name) => text.includes(name) && !(rel === POINTED && homes.includes(name) && pointsAtSeatHome(text, name)));
      return named.map((name) => `${rel}: ${name}`);
    });
    expect(found).toEqual([]);
    // And the one place does say each, so this test holds what it says it holds.
    const pointed = readFileSync(join(root, POINTED), "utf8");
    for (const name of homes) expect([name, pointsAtSeatHome(pointed, name)]).toEqual([name, true]);
    // Nor do the bridges speak to anyone themselves, or say who the tool is: they start it and read it.
    for (const bridge of [CLAUDE_BRIDGE, CODEX_BRIDGE]) expect(bridge).not.toMatch(/user.agent|urllib\.request|http\.client|\bsocket\b|\bcurl\b|\bwget\b/i);
  });

  test("the tool is only ever asked its version, whether it is signed in, and to do the work: never to install, update, sign in or sign out", async () => {
    const asked: Record<keyof typeof TOOLS, (call: string[]) => boolean> = {
      claude: (call) => call.join(" ") === "--version" || call.join(" ") === "auth status" || call.slice(0, CLAUDE_FLAGS.length).join(" ") === CLAUDE_FLAGS.join(" "),
      codex: (call) => call.join(" ") === "--version" || call.join(" ") === "login status" || call.slice(0, CODEX_RUN.length).join(" ") === CODEX_RUN.join(" "),
    };
    for (const tool of ["claude", "codex"] as const) {
      const box = vm(tool);
      await box.run(["--status"]);
      await box.run(OWN);
      await box.run([...OWN, "--session", SESSION[tool]]);
      await box.run(["--provider", "p", "--model", "m"]);
      await box.run(OWN, "work", tool === "claude" ? "spent midway" : "spent");
      const told = box.start(OWN, "work", "stop");
      await told.until((event) => event.type === "call");
      told.stop();
      await told.done();
      const calls: string[][] = box.trace().filter((item) => item.called).map((item) => item.called);
      expect(calls.length).toBeGreaterThanOrEqual(9);
      expect(calls.filter((call) => !asked[tool](call))).toEqual([]);
      // (Codex's own word for "is it signed in" is `login status`: that, and never `login` alone.)
      expect(calls.filter((call) => call.join(" ") !== "login status" && call.some((word) => /^(login|logout|update|upgrade|install|setup-token)$/.test(word)))).toEqual([]);
    }
    // Nor is its app server asked anything but to work: a thread, its turns, your words and its stop. Never its account
    // or a sign-in (a seat's status asks account/read alone, and never in a run), its settings, or its plugins.
    const codex = vm("codex");
    await codex.run(OWN);
    await codex.run([...OWN, "--session", SESSION.codex]);
    const steered = codex.start(OWN, "work", "steer-mid-tool");
    await steered.until((event) => event.type === "call");
    steered.say("steer_0008", STEER);
    await steered.done();
    const methods = new Set(codex.trace().filter((item) => "told" in item).map((item) => item.told as string));
    expect([...methods].sort()).toEqual(["initialized", "thread/resume", "thread/start", "turn/start", "turn/steer"]);
  });

  test("the gateway takes its own tokens and nothing else: a request carrying a sign-in is refused before anything is sent or kept", async () => {
    const identity = newNodeIdentity();
    const store = new LedgerStore(":memory:");
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
