import type { AgentDriver, AgentEvent, AgentModel } from "./agents.ts";
import { ENGRAM_ENV, engramArgv } from "./engram.ts";
import { readBridge } from "./hermes.ts";

/*
 * The vendors' own coding tools as harnesses: Claude Code and Codex. A subscription (a Claude
 * plan, a ChatGPT plan) may be used only by its vendor's own tool, unmodified, signed in by its
 * owner through the vendor's own flow. So that is all this does: it runs the tool the owner
 * installed and signed in inside the knight's VM, headless, and reads what it prints.
 *
 *   - Galahad never holds a sign-in. Nothing here opens, copies, moves or sends where a tool keeps
 *     one. Whether the tool has one is asked of the tool (its own status command), and of the
 *     answer only "signed in or not" and one word from a fixed list leaves the VM.
 *   - Galahad never installs, updates or signs in the tool, and never says it is another tool:
 *     the flags below are the vendor's documented ones, and no client identity is set anywhere.
 *   - Signed in, the tool talks to its vendor itself: every variable that points at Galahad's
 *     gateway is taken out of its environment, so the gateway is never given that traffic.
 *   - Not signed in, it runs on a keyed roster model through the gateway, by the vendor's own
 *     documented way to another endpoint, on the VM's scoped token (never a key).
 *
 * Like Hermes' bridge this is Python's standard library, running INSIDE the assigned sandbox. It
 * prints the same bounded, normalised events, so one long line of the tool's never splits JSON.
 */

/** Shared by both bridges: bounded events, the two environments, the gateway lease, the run itself. */
const SHARED = String.raw`import argparse, json, os, re, shutil, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlsplit

# Every variable a gateway lease puts in a sandbox's environment (GALAHAD_WORLD: only in sandboxes made before 14 November 2026).
GATEWAY_VARS = ("GALAHAD_GATEWAY", "GALAHAD_TOKEN", "GALAHAD_REPO_URL", "GALAHAD_SEARCH", "GALAHAD_WORLD",
                "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
# These tools print a whole tool result on one line. A line past this is dropped whole, never cut.
LINE_LIMIT = 8000000

def clip(text, limit):
    # Long output keeps its head and its tail, where the answer and the error usually are.
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    return text[:head] + "\n…\n" + text[len(text) - (limit - head - 3):]

def emit(kind, **fields):
    event = dict(type=kind, **fields)
    wire = lambda: json.dumps(event, ensure_ascii=False).encode("utf-8", "replace")
    # runAgent polls bounded JSONL lines. Clip prose without ever splitting JSON.
    while len(wire()) > 16000:
        strings = [k for k, v in event.items() if k != "type" and isinstance(v, str) and len(v) > 100]
        if not strings:
            break
        key = max(strings, key=lambda k: len(event[k]))
        event[key] = clip(event[key], len(event[key]) // 2)
    sys.stdout.buffer.write(wire() + b"\n")
    sys.stdout.buffer.flush()

def text_of(content, depth=0):
    if isinstance(content, str):
        return content
    if depth > 8:
        return ""
    if isinstance(content, dict):
        if content.get("type") == "text":
            return str(content.get("text", ""))
        return text_of(content.get("content", ""), depth + 1)
    if isinstance(content, list):
        return "\n".join(part for part in (text_of(c, depth + 1) for c in content) if part)
    return ""

def as_text(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def count(usage, *names):
    values = [usage.get(name) for name in names] if isinstance(usage, dict) else []
    return sum(v for v in values if type(v) is int and v > 0)

# When a spent allowance resets (seconds or ms since the epoch), as both tools' are said.
def resets(at):
    if type(at) not in (int, float) or at <= 0:
        return ""
    try:
        return "; it resets " + time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(at / 1000 if at > 100000000000 else at))
    except (OverflowError, OSError, ValueError):
        return ""

def own_path(env):
    # (Where a vendor's installer puts its tool for one user, whatever the shell's profile says.)
    env["PATH"] = os.path.join(os.path.expanduser("~"), ".local", "bin") + os.pathsep + env.get("PATH", "")
    return env

def own_environment():
    # The tool as its owner set it up in this VM, less everything that points at Galahad's gateway:
    # signed in for itself, it talks to its vendor itself.
    return own_path({k: v for k, v in os.environ.items() if k not in GATEWAY_VARS})

def gateway_lease(path):
    values = {k: os.environ.get(k, "") for k in ("GALAHAD_GATEWAY", "GALAHAD_TOKEN")}
    if path.exists():
        if path.stat().st_size > 16384:
            raise RuntimeError("Galahad gateway environment file is too large")
        try:
            fresh = json.loads(path.read_text())
        except (ValueError, OSError):
            raise RuntimeError("Galahad gateway environment file is invalid") from None
        if not isinstance(fresh, dict) or any(not isinstance(fresh.get(k), str) or not fresh[k] for k in values):
            raise RuntimeError("Galahad gateway environment file is incomplete")
        values.update({k: fresh[k] for k in values})
    if not all(values.values()):
        raise RuntimeError(NAME + " needs this workspace's Galahad gateway endpoint and token")
    url = urlsplit(values["GALAHAD_GATEWAY"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RuntimeError("Galahad gateway endpoint is invalid")
    return values["GALAHAD_GATEWAY"].rstrip("/"), values["GALAHAD_TOKEN"]

def ask(env, *args):
    try:
        return subprocess.run([TOOL, *args], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=12)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None

def status():
    # Installed, and signed in or not. Asked of the tool as itself: a gateway token is never its sign-in.
    env = own_environment()
    version = ask(env, "--version") if shutil.which(TOOL, path=env["PATH"]) else None
    installed = version is not None and version.returncode == 0
    method = sign_in(env) if installed else None
    told = {"type": "status", "installed": installed, "signedIn": method is not None}
    if method:
        told["method"] = method
    print(json.dumps(told), flush=True)
    return 0 if installed else 1

def lines(stream):
    while True:
        raw = stream.readline(LINE_LIMIT + 1)
        if not raw:
            return
        if len(raw) > LINE_LIMIT:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(LINE_LIMIT + 1)
            continue
        yield raw

def run(args):
    env = own_environment() if args.own else own_path(dict(os.environ))
    if shutil.which(TOOL, path=env["PATH"]) is None:
        raise RuntimeError(NAME + " is not installed in this VM; its owner installs it there (Galahad never does)")
    if args.own:
        if sign_in(env) is None:
            raise RuntimeError(NAME + " is not signed in in this VM; sign it in there (" + LOGIN + ")")
        extra = []
    else:
        base, token = gateway_lease(Path(args.gateway_env))
        extra = through_gateway(env, base + "/" + args.provider, token, args.model)
    reader = Reader()
    with open(args.prompt, "rb") as message:
        child = subprocess.Popen(arguments(args, extra), env=env, stdin=message, stdout=subprocess.PIPE, stderr=sys.stderr)
    ended = False
    try:
        for raw in lines(child.stdout):
            try:
                event = json.loads(raw)
                if isinstance(event, dict):
                    reader.event(event)
            except (ValueError, TypeError, AttributeError, KeyError, RecursionError):
                # What the tool prints is data. A line that isn't what it should be is passed over.
                continue
            if reader.stop:
                break
        ended = not reader.stop
    finally:
        # Stopped here (a spent allowance, a fault of our own): the tool is not left running.
        if not ended and child.poll() is None:
            child.terminate()
        try:
            code = child.wait(timeout=None if ended else 5)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
    failure = reader.verdict()
    if failure:
        raise RuntimeError(failure)
    if not reader.finished:
        raise RuntimeError(NAME + (" exited with %d and no result" % code if code else " ended without a result"))
    if code:
        raise RuntimeError(NAME + " exited with %d" % code)
`;

/** After a tool's own part: the arguments, and the one error a failed run ends on. */
const MAIN = String.raw`
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--own", action="store_true")
    parser.add_argument("--provider", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--session")
    parser.add_argument("--prompt", default="/work/.agent/prompt.md")
    parser.add_argument("--gateway-env", default="/work/.galahad-gateway.json")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    try:
        if args.status:
            return status()
        # A session, a provider and a model are passed to the tool as arguments: none may read as a flag.
        if args.session is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", args.session):
            raise RuntimeError("The saved " + NAME + " session is not one of its own")
        if not args.own and not (re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", args.provider) and re.fullmatch(r"[A-Za-z0-9][!-~]{0,199}", args.model)):
            raise RuntimeError(NAME + " runs on its own sign-in, or on a provider and model through the gateway")
        run(args)
        return 0
    except Exception as error:
        # Only our own controlled RuntimeErrors are shown. stderr is separately redacted by the outer runner.
        emit("error", message=str(error) if type(error) is RuntimeError else NAME + " bridge failed (" + type(error).__name__ + ")")
        return 1

if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * Claude Code, headless: `claude -p --output-format stream-json --verbose`, the message on stdin,
 * every tool allowed (the VM is the boundary), `--resume <session id>` to continue. Shapes as
 * v2.1.311 printed them (test/fixtures): `system/init` names the session; an `assistant` message
 * holds `text` and `tool_use` blocks; a `user` message holds each `tool_result`; `result` ends it.
 */
const CLAUDE_PART = String.raw`
TOOL, NAME, LOGIN = "claude", "Claude Code", "claude auth login"
# How the tool says it is signed in. One of these words is all that is passed on: its status
# command also prints whose account it is, and none of that is Galahad's to know.
METHODS = ("claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party")

def sign_in(env):
    state = ask(env, "auth", "status")
    if state is None or state.returncode != 0:
        return None
    try:
        told = json.loads(state.stdout)
    except ValueError:
        return None
    if not isinstance(told, dict) or told.get("loggedIn") is False or told.get("authMethod") == "none":
        return None
    return told["authMethod"] if told.get("authMethod") in METHODS else "signed in"

def through_gateway(env, base, token, model):
    # The tool's own documented way to a gateway: its endpoint, and a bearer for it.
    env.update({"ANTHROPIC_BASE_URL": base, "ANTHROPIC_AUTH_TOKEN": token})
    # (As under galahad run: a key of the owner's own is not sent beside the gateway's token.)
    env.pop("ANTHROPIC_API_KEY", None)
    return ["--model", model]

def arguments(args, extra):
    argv = [TOOL, "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"] + extra
    return argv + (["--resume", args.session] if args.session else [])

def blocks(event):
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []

def call_input(value):
    if isinstance(value, dict) and isinstance(value.get("command"), str):
        return value["command"]
    return as_text(value)

class Reader:
    def __init__(self):
        self.session, self.told, self.calls, self.said = None, False, {}, ""
        self.cause, self.failed, self.finished, self.stop = "", "", False, False

    def answered(self):
        # A session is worth continuing once the model has answered in it. One that never got a
        # reply is not: the next model starts the work afresh.
        if self.session and not self.told:
            self.told = True
            emit("session", id=self.session)

    def event(self, e):
        kind = e.get("type")
        if kind == "system" and e.get("subtype") == "init" and isinstance(e.get("session_id"), str):
            self.session = e["session_id"]
        elif kind == "assistant":
            if isinstance(e.get("error"), str):
                # The tool's own notice that a request failed, by category. Its result says the rest.
                self.cause = e["error"] if re.fullmatch(r"[a-z_]{1,40}", e["error"]) else "unknown"
                return
            self.answered()
            for block in blocks(e):
                if block.get("type") == "text" and isinstance(block.get("text"), str) and block["text"].strip():
                    self.said = block["text"]
                    emit("text", text=clip(self.said, 24000))
                elif block.get("type") == "tool_use" and isinstance(block.get("id"), str) and len(self.calls) < 512:
                    self.calls[block["id"]] = (str(block.get("name") or "tool"), block.get("input"))
        elif kind == "user":
            for block in blocks(e):
                ident = block.get("tool_use_id")
                call = self.calls.pop(ident, None) if block.get("type") == "tool_result" and isinstance(ident, str) else None
                if call:
                    emit("tool", tool=call[0][:200], input=clip(call_input(call[1]), 2000),
                         output=clip(text_of(block.get("content")), 4000), ok=block.get("is_error") is not True)
        elif kind == "rate_limit_event":
            info = e.get("rate_limit_info")
            # Only status says a request was refused: a run within its allowance carries
            # "overageStatus": "rejected" beside "status": "allowed".
            if isinstance(info, dict) and info.get("status") == "rejected":
                credits = " (it needs usage credits to go on)" if info.get("errorCode") == "credits_required" else ""
                self.failed = NAME + "'s allowance is spent" + credits + resets(info.get("resetsAt"))
                # It may wait for its window to reset. The next model takes over instead.
                self.stop = True
        elif kind == "result":
            self.finished = True
            emit("tokens", input=count(e.get("usage"), "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"),
                 output=count(e.get("usage"), "output_tokens"))
            text = e.get("result") if isinstance(e.get("result"), str) else ""
            subtype = e["subtype"] if isinstance(e.get("subtype"), str) and re.fullmatch(r"[a-z_]{1,40}", e["subtype"]) else ""
            # (A result of an error's kind is one, whatever its flag says.)
            if e.get("is_error") is True or subtype.startswith("error"):
                errors = e.get("errors") if isinstance(e.get("errors"), list) else []
                detail = text.strip() or "; ".join(x for x in errors if isinstance(x, str))
                cause = self.cause or subtype
                self.failed = self.failed or NAME + " ended with an error" + (" (" + cause + ")" if cause else "") + (": " + clip(detail, 600) if detail else "")
            elif text.strip() and text != self.said:
                emit("text", text=clip(text, 24000))

    def verdict(self):
        return self.failed
`;

/**
 * Codex, headless: `codex exec --json`, the message on stdin (`-`), no approvals and no sandbox of
 * its own (the VM is the boundary), `codex exec resume <id>` to continue. Shapes as v0.167.2 printed
 * them (test/fixtures): `thread.started` names the session; `item.completed` carries a message, a
 * command with its output and exit code, or a change; `turn.completed` ends a turn with its usage.
 * A failure is `turn.failed` or `error`; there is no event of its own for a spent allowance.
 */
const CODEX_PART = String.raw`
TOOL, NAME, LOGIN = "codex", "Codex", "codex login --device-auth"

def sign_in(env):
    state = ask(env, "login", "status")
    if state is None or state.returncode != 0:
        return None
    said = state.stdout + state.stderr
    # With an API key this command prints part of the key. One of these words is all that is passed on.
    return "chatgpt" if "ChatGPT" in said else "api-key" if "API key" in said else "signed in"

def through_gateway(env, base, token, model):
    # The tool's own documented way to another endpoint: a model_providers entry on the Responses
    # API (the only one it speaks), its bearer read from the environment and never written down.
    env["GALAHAD_TOKEN"] = token
    entry = {"name": "Galahad gateway", "base_url": base, "env_key": "GALAHAD_TOKEN", "wire_api": "responses"}
    extra = ["-m", model, "-c", "model_provider=" + json.dumps("galahad")]
    for key, value in entry.items():
        extra += ["-c", "model_providers.galahad." + key + "=" + json.dumps(value)]
    return extra

# Its plan's allowance spent, in its own words: "You've hit your usage limit. … try again at 3:45 PM." (0.169.0 writes
# You’ve, and the day too when it isn't today: "at Nov 23rd, 2026 8:11 PM", by this VM's clock). Said as Claude Code's
# is, without the offers around it, and when it resets in UTC where it gave a time.
LIMIT = re.compile("You['’]ve hit your usage limit")
RECONNECT = re.compile(r"Reconnecting\.\.\. (\d{1,3})/\d{1,3}(?: \((.*)\))?$", re.S)
AGAIN = re.compile(r"try again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)")

def spent(message):
    if not LIMIT.search(message):
        return ""
    at, when = AGAIN.search(message), ""
    if at:
        try:
            day = " ".join(at.group(1, 2, 3)) if at.group(1) else time.strftime("%b %d %Y")
            when = resets(time.mktime(time.strptime("%s %s:%s %s" % (day, at.group(4), at.group(5), at.group(6)), "%b %d %Y %I:%M %p")))
        except (OverflowError, ValueError):
            when = ""
    return NAME + "'s allowance is spent" + when

def arguments(args, extra):
    argv = [TOOL, "exec"] + (["resume"] if args.session else [])
    argv += ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"] + extra
    return argv + ([args.session] if args.session else []) + ["-"]

class Reader:
    def __init__(self):
        self.session, self.told = None, False
        self.trouble, self.failed, self.finished, self.stop = "", "", False, False

    def answered(self):
        # A session is worth continuing once something was done in it. One that never got a
        # reply is not: the next model starts the work afresh.
        if self.session and not self.told:
            self.told = True
            emit("session", id=self.session)

    def event(self, e):
        kind = e.get("type")
        if kind == "thread.started" and isinstance(e.get("thread_id"), str):
            self.session = e["thread_id"]
        elif kind == "item.completed" and isinstance(e.get("item"), dict):
            item = e["item"]
            what = item.get("type")
            self.answered()
            if what == "agent_message" and isinstance(item.get("text"), str) and item["text"].strip():
                emit("text", text=clip(item["text"], 24000))
            elif what == "command_execution":
                emit("tool", tool="shell", input=clip(as_text(item.get("command", "")), 2000),
                     output=clip(as_text(item.get("aggregated_output", "")), 4000), ok=item.get("exit_code") == 0)
            elif what == "file_change":
                changes = [c for c in item["changes"] if isinstance(c, dict)] if isinstance(item.get("changes"), list) else []
                emit("tool", tool="edit", input=clip("\n".join(str(c.get("kind", "change")) + " " + str(c.get("path", "")) for c in changes), 2000),
                     output="", ok=item.get("status") == "completed")
            elif what == "mcp_tool_call":
                emit("tool", tool=(str(item.get("server", "mcp")) + "." + str(item.get("tool", "tool")))[:200],
                     input=clip(as_text(item.get("arguments", "")), 2000),
                     output=clip(text_of(item.get("result")) or as_text(item.get("error") or ""), 4000), ok=item.get("status") == "completed")
            elif what == "web_search":
                emit("tool", tool="web_search", input=clip(as_text(item.get("query", "")), 2000), output="", ok=True)
        elif kind == "turn.completed":
            self.finished, self.trouble = True, ""
            emit("tokens", input=count(e.get("usage"), "input_tokens"), output=count(e.get("usage"), "output_tokens"))
        elif kind == "turn.failed":
            error = e.get("error")
            message = error.get("message") if isinstance(error, dict) and isinstance(error.get("message"), str) else ""
            self.failed = spent(message or self.trouble) or NAME + " stopped: " + clip(message or self.trouble or "its turn failed", 600)
        elif kind == "error" and isinstance(e.get("message"), str):
            # Not always the end (a reconnection is told this way too): it is, if no turn completes after it.
            self.trouble = e["message"]
            # A reconnection is a retry on the trail, its reason where it gives one: a run that waits isn't one that hangs.
            again = RECONNECT.match(e["message"])
            if again:
                emit("retry", attempt=int(again.group(1)), error=clip(again.group(2) or "reconnecting", 300), waitMs=0)

    def verdict(self):
        return self.failed or (spent(self.trouble) or NAME + " stopped: " + clip(self.trouble, 600) if self.trouble else "")
`;

export const CLAUDE_BRIDGE = `${SHARED}${CLAUDE_PART}${MAIN}`;
export const CODEX_BRIDGE = `${SHARED}${CODEX_PART}${MAIN}`;

/**
 * With the VM's notes store (engram.ts): the tool is given these arguments of its own too (the vendor's
 * documented ones), and starts the store's server itself, as it starts any MCP server. Nothing is written
 * where a tool keeps its own configuration, and nothing of the store is put in its environment.
 */
const withNotes = (argv: readonly string[]) => String.raw`
NOTES = json.loads(${JSON.stringify(JSON.stringify(argv))})
plain_arguments = arguments

def arguments(args, extra):
    return plain_arguments(args, extra + NOTES)
`;

/** What a tool is given for the store under a project: its arguments, and any file of Galahad's own they name. */
type Notes = (project: string) => { argv: string[]; files?: Record<string, string> };

/** Claude Code: `--mcp-config <file>`, a file Galahad writes beside its bridge, holding the one stdio server. */
const CLAUDE_NOTES_FILE = "/work/.agent/engram-mcp.json";
const claudeNotes: Notes = (project) => {
  const [command, ...args] = engramArgv(project);
  return { argv: ["--mcp-config", CLAUDE_NOTES_FILE], files: { [CLAUDE_NOTES_FILE]: JSON.stringify({ mcpServers: { engram: { type: "stdio", command, args, env: ENGRAM_ENV } } }, null, 2) } };
};

/** Codex: `-c mcp_servers.engram.*`, as its gateway provider is given it. (Each value is TOML: a string, an array of strings, an inline table.) */
const codexNotes: Notes = (project) => {
  const [command, ...args] = engramArgv(project);
  const env = Object.entries(ENGRAM_ENV).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(",");
  return { argv: ["-c", `mcp_servers.engram.command=${JSON.stringify(command)}`, "-c", `mcp_servers.engram.args=${JSON.stringify(args)}`, "-c", `mcp_servers.engram.env={${env}}`] };
};

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The words a tool has for how it is signed in. Nothing else a VM says of a sign-in is passed on. */
const SIGN_IN_WORDS = ["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party", "chatgpt", "api-key", "signed in"];

/** What a bridge's `--status` printed. A VM's output is data: one flag and one known word are read from it. */
function readStatus(stdout: string): { signedIn: boolean; method?: string } {
  for (const line of stdout.trim().split("\n").reverse()) {
    let told: any;
    try { told = JSON.parse(line); } catch { continue; }
    if (!told || typeof told !== "object" || told.type !== "status") continue;
    if (told.signedIn !== true) break;
    return { signedIn: true, ...(SIGN_IN_WORDS.includes(told.method) ? { method: told.method as string } : {}) };
  }
  return { signedIn: false };
}

/**
 * A sign-in lives in this VM, and a model can make the tool print it. What is passed on is redacted as every
 * driver's events are, and then of one thing more: the signed three-part tokens one vendor's sign-in is made
 * of, which have no prefix for the usual redaction to know them by.
 */
const SIGNED_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const scrub = (text: string) => text.replace(SIGNED_TOKEN, "[redacted token]");
function read(line: string): AgentEvent[] {
  return readBridge(line).map((event): AgentEvent => {
    if (event.type === "text") return { ...event, text: scrub(event.text) };
    if (event.type === "error") return { ...event, message: scrub(event.message) };
    if (event.type === "tool") return { ...event, tool: scrub(event.tool), input: scrub(event.input), output: scrub(event.output) };
    return event;
  });
}

const driver = (name: string, title: string, kind: AgentDriver["kind"], script: string, part: string, notes: Notes, signIn: Omit<NonNullable<AgentDriver["signIn"]>, "read">): AgentDriver => ({
  name,
  title,
  kind,
  // (Passed whole: readiness is asked before any run has written the bridge into the sandbox.)
  check: `python3 -c ${quote(`${SHARED}${part}${MAIN}`)} --status`,
  signIn: { ...signIn, read: readStatus },
  files: (_models, engram) => {
    if (!engram) return { [script]: `${SHARED}${part}${MAIN}` };
    const given = notes(engram);
    return { [script]: `${SHARED}${part}${withNotes(given.argv)}${MAIN}`, ...given.files };
  },
  command: (model: AgentModel, session) => `python3 ${script} ${model.own ? "--own" : `--provider ${quote(model.provider)} --model ${quote(model.model)}`}${session ? ` --session ${quote(session)}` : ""}`,
  read,
});

export const CLAUDE = driver("claude", "Claude Code", "anthropic", "/work/.agent/claude-code.py", CLAUDE_PART, claudeNotes, { login: "claude auth login", roster: "an Anthropic-API model" });
/** (Codex speaks only the Responses API: a roster model on an endpoint without it fails, and the next takes over.) */
export const CODEX = driver("codex", "Codex", "openai", "/work/.agent/codex.py", CODEX_PART, codexNotes, { login: "codex login --device-auth", roster: "an OpenAI-compatible model that speaks the Responses API" });
