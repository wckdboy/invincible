import { redact, TeamAcpCommand, VM_WORK } from "@invincible/core";
import type { AgentDriver, AgentEvent } from "./harnesses.ts";
import { engramArgv, engramEnv } from "./engram.ts";

/*
 * The Agent Client Protocol (ACP, protocol 1), the primary's side of it: a client that runs INSIDE the agent's VM, on the
 * standard library alone, starts an agent that speaks ACP on stdio, opens or loads its session, gives it the task's
 * message and follows what it does. No host tool, owner configuration, provider key or arm token is in it. Hermes is
 * one such agent (hermes.ts); acpDriver is any other you name (Gemini CLI, Goose, OpenCode's own ACP server, an
 * adapter for another tool, one of yours).
 */
export const ACP_CLIENT = String.raw`import argparse, json, os, selectors, shlex, signal, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlsplit

def emit(kind, **fields):
    event = dict(type=kind, **fields)
    # runAgent polls bounded JSONL lines. Clip prose without ever splitting JSON.
    while len(json.dumps(event, ensure_ascii=False).encode()) > 16000:
        strings = [k for k, v in event.items() if k != "type" and isinstance(v, str) and len(v) > 100]
        if not strings:
            break
        key = max(strings, key=lambda k: len(event[k]))
        event[key] = event[key][:len(event[key]) // 2] + "…"
    print(json.dumps(event, ensure_ascii=False), flush=True)

def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if content.get("type") == "text":
            return str(content.get("text", ""))
        return content_text(content.get("content", ""))
    if isinstance(content, list):
        return "\n".join(content_text(c) for c in content)
    return ""

def value_text(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

def gateway_environment(path, agent):
    values = {k: os.environ.get(k, "") for k in ("OPENAI_API_KEY", "INVINCIBLE_GATEWAY")}
    if path.exists():
        if path.stat().st_size > 16384:
            raise RuntimeError("Invincible gateway environment file is too large")
        try:
            fresh = json.loads(path.read_text())
        except (ValueError, OSError):
            raise RuntimeError("Invincible gateway environment file is invalid") from None
        if not isinstance(fresh, dict) or any(not isinstance(fresh.get(k), str) or not fresh[k] for k in values):
            raise RuntimeError("Invincible gateway environment file is incomplete")
        values.update({k: fresh[k] for k in values})
    if not all(values.values()):
        raise RuntimeError(agent + " needs this workspace's Invincible gateway endpoint and token")
    url = urlsplit(values["INVINCIBLE_GATEWAY"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RuntimeError("Invincible gateway endpoint is invalid")
    return values

class Client:
    # The agent's name in what a run says; whether a permission it asks for is given (once, where it can be); what a
    # run says when it isn't there.
    agent = "The agent"
    permit = False
    missing = "The agent or a required workspace file is missing"

    def __init__(self, args):
        self.args, self.session, self.child = args, args.session, None
        self.sequence, self.buffer = 0, b""
        self.active, self.cancelled, self.stopping = False, False, None
        self.tools, self.completed, self.text = {}, set(), ""
        self.selector = selectors.DefaultSelector()

    def send(self, message):
        self.child.stdin.write((json.dumps(message) + "\n").encode())
        self.child.stdin.flush()

    def cancel(self, *_):
        if self.stopping is None:
            self.cancelled, self.stopping = True, time.monotonic()
            if self.child and self.child.poll() is None and self.session:
                try:
                    self.send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": self.session}})
                except (OSError, ValueError):
                    pass

    def permission(self, params):
        # The VM is the boundary: what the agent asks to do there is given, once where it offers that. Never by a
        # model's judgement. Without permit (Hermes, in its workspace-edit mode) it fails closed.
        if self.permit:
            options = [o for o in params.get("options") or [] if isinstance(o, dict) and isinstance(o.get("optionId"), str)]
            for kind in ("allow_once", "allow_always"):
                for option in options:
                    if option.get("kind") == kind:
                        return {"outcome": {"outcome": "selected", "optionId": option["optionId"]}}
        return {"outcome": {"outcome": "cancelled"}}

    def message(self, message):
        method, params = message.get("method"), message.get("params") or {}
        if "id" in message and method:
            # We never advertise host filesystem/terminal access.
            if method == "session/request_permission":
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": self.permission(params)})
            else:
                self.send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Invincible exposes no client resources"}})
            return
        # session/load replays history before its response: never count replayed work.
        if method != "session/update" or not self.active or params.get("sessionId") != self.session:
            return
        update = params.get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            self.text = (self.text + content_text(update.get("content")))[-24000:]
        elif kind in ("tool_call", "tool_call_update"):
            ident = update.get("toolCallId")
            if not isinstance(ident, str) or ident in self.completed:
                return
            item = self.tools.setdefault(ident, {})
            if kind == "tool_call":
                item["input"] = value_text(update["rawInput"]) if "rawInput" in update else content_text(update.get("content"))
                # Said as it begins: a steer waits for a call the agent is in.
                emit("call", id=ident[:256])
            item.update({k: v for k, v in update.items() if v is not None})
            if item.get("status") in ("completed", "failed"):
                self.completed.add(ident)
                emit("tool", id=ident[:256], tool=str(item.get("title") or item.get("kind") or "tool")[:200],
                     input=item.get("input", "")[:2000],
                     output=(value_text(item["rawOutput"]) if "rawOutput" in item else content_text(update.get("content")))[:4000],
                     ok=item["status"] == "completed")
                self.tools.pop(ident, None)
                if self.args.max_tools and len(self.completed) >= self.args.max_tools:
                    emit("error", message=self.agent + " reached this run's tool budget")
                    self.cancel()

    def request(self, method, params, timeout=45):
        self.sequence += 1
        ident = self.sequence
        self.send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
        # (No timeout: as long as it takes. The run's own deadline, and you, stop it.)
        until = time.monotonic() + timeout if timeout else None
        while True:
            if self.stopping is not None and time.monotonic() - self.stopping > 3:
                raise RuntimeError(self.agent + " run was cancelled")
            if until is not None and time.monotonic() > until:
                self.cancel()
                raise RuntimeError(self.agent + " ACP timed out during " + method)
            if not self.selector.select(0.2):
                if self.child.poll() is not None:
                    raise RuntimeError(self.agent + " ACP exited during " + method)
                continue
            chunk = os.read(self.child.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(self.agent + " ACP closed its protocol stream during " + method)
            self.buffer += chunk
            if len(self.buffer) > 2000000:
                raise RuntimeError(self.agent + " ACP exceeded the protocol message limit")
            while b"\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\n", 1)
                try:
                    message = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise RuntimeError(self.agent + " ACP returned invalid JSON") from None
                if not isinstance(message, dict):
                    raise RuntimeError(self.agent + " ACP returned an invalid message")
                if message.get("id") == ident and "method" not in message:
                    if "error" in message:
                        # Provider errors can contain request headers. Never echo raw RPC errors.
                        raise RuntimeError(self.agent + " ACP rejected " + method)
                    return message.get("result")
                self.message(message)

    def start(self, argv, env, timeout=45):
        self.child = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
        self.selector.register(self.child.stdout, selectors.EVENT_READ)
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, self.cancel)
        initialized = self.request("initialize", {"protocolVersion": 1, "clientCapabilities": {},
                                   "clientInfo": {"name": "invincible", "version": "1"}}, timeout)
        if not isinstance(initialized, dict) or initialized.get("protocolVersion") != 1:
            raise RuntimeError(self.agent + " ACP protocol version 1 is required")
        return initialized

    def prompt(self):
        self.active = True
        prompt = Path(self.args.prompt).read_text()
        result = self.request("session/prompt", {"sessionId": self.session, "prompt": [{"type": "text", "text": prompt}]}, self.args.max_seconds)
        if self.text.strip():
            emit("text", text=self.text)
        usage = result.get("usage") or {} if isinstance(result, dict) else {}
        emit("tokens", input=max(0, int(usage.get("inputTokens", 0))), output=max(0, int(usage.get("outputTokens", 0))))
        if self.cancelled or not isinstance(result, dict) or result.get("stopReason") != "end_turn":
            raise RuntimeError(self.agent + " did not complete its turn")
        if not self.text.strip():
            raise RuntimeError(self.agent + " ended without a result")

    def close(self):
        self.selector.close()
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()

def serve(bridge):
    try:
        bridge.run()
        return 0
    except FileNotFoundError:
        emit("error", message=bridge.missing)
        return 1
    except Exception as error:
        # Only our own controlled RuntimeErrors are shown; OS/provider errors may
        # carry credentials. stderr is separately redacted by the outer runner.
        emit("error", message=str(error) if type(error) is RuntimeError else bridge.agent + " ACP bridge failed (" + type(error).__name__ + ")")
        return 1
    finally:
        bridge.close()
`;

/** The script's last lines: run main() when it is the program. */
export const ACP_ENTRY = String.raw`
if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * Any agent you name: the command that starts it in its ACP mode, run in the agent's VM as you set it up there (its
 * own sign-in or its own configuration, in the VM's HOME). The model of the agent's role is offered to it two ways:
 * the gateway's address and token in the variables most agents read (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL), and by name
 * where it lists the models it can run on (session/set_model). A session it can load again is kept for the next run.
 * No tool budget and no time limit of the bridge's own: an agent is audited, not capped, and the run's deadline and
 * you stop it.
 */
const GENERIC = String.raw`
class Bridge(Client):
    permit = True

    def run(self):
        args = self.args
        argv = shlex.split(args.command)
        if not argv:
            raise RuntimeError("No ACP agent command was given")
        self.agent = args.name or os.path.basename(argv[0])
        self.missing = self.agent + " isn't installed in this VM (" + argv[0] + " was not found)"
        # Deliberate allowlist: no owner credentials, SSH agent, proxy or ambient plugin settings. Its own setup is
        # what is in the VM's HOME.
        env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TMPDIR", "TERM", "HOME", "USER",
               "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME") if k in os.environ}
        if args.provider and not args.check:
            values = gateway_environment(Path(args.gateway_env), self.agent)
            base = values["INVINCIBLE_GATEWAY"].rstrip("/") + "/" + args.provider
            env.update({"OPENAI_BASE_URL": base, "OPENAI_API_BASE": base, "OPENAI_API_KEY": values["OPENAI_API_KEY"], "OPENAI_MODEL": args.model,
                        "INVINCIBLE_GATEWAY": values["INVINCIBLE_GATEWAY"], "INVINCIBLE_PROVIDER": args.provider, "INVINCIBLE_MODEL": args.model})
        initialized = self.start(argv, env, 120)
        resumable = bool((initialized.get("agentCapabilities") or {}).get("loadSession"))
        if args.check:
            emit("text", text=self.agent + " speaks ACP (protocol 1" + (", with sessions it can load again" if resumable else "") + ")")
            return
        params = {"cwd": os.getcwd(), "mcpServers": []}
        if self.session and resumable:
            state = self.request("session/load", dict(params, sessionId=self.session), 120)
            if not isinstance(state, dict):
                raise RuntimeError("The saved " + self.agent + " session could not be loaded; it was not replaced")
        else:
            state = self.request("session/new", params, 120)
            self.session = state.get("sessionId") if isinstance(state, dict) else None
            if not isinstance(self.session, str) or not self.session:
                raise RuntimeError(self.agent + " did not create a session")
        # Only a session it can load again is kept, for the next run to take up.
        if resumable:
            emit("session", id=self.session)
        # The model the work is on, where it lists the ones it can run on; else its own setup chooses.
        listed = (state.get("models") or {}) if isinstance(state, dict) else {}
        offered = [m.get("modelId") for m in listed.get("availableModels") or [] if isinstance(m, dict)]
        wanted = next((m for m in (args.model, args.provider + "/" + args.model) if args.model and m in offered), None)
        if wanted and listed.get("currentModelId") != wanted:
            self.request("session/set_model", {"sessionId": self.session, "modelId": wanted})
        self.prompt()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", required=True)
    parser.add_argument("--name", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--session")
    parser.add_argument("--prompt", default="/work/.agent/prompt.md")
    parser.add_argument("--gateway-env", default=os.path.join(os.path.expanduser("~"), ".invincible-gateway.json"))
    parser.add_argument("--max-tools", type=int, default=0)
    parser.add_argument("--max-seconds", type=int, default=0)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.max_tools < 0 or args.max_seconds < 0 or bool(args.provider) != bool(args.model):
        parser.error("a provider goes with a model, and no budget is negative")
    return serve(Bridge(args))
`;

/** The bridge for any ACP agent, as written into the VM. */
export const ACP_BRIDGE = `${ACP_CLIENT}${GENERIC}${ACP_ENTRY}`;
const ACP_BRIDGE_PATH = "/work/.agent/acp-bridge.py";

/**
 * With the VM's notes store (engram.ts): a session is opened with its one stdio server, which the agent then starts
 * for itself (its environment is inside the entry: the agent's own is the allowlist above). ACP has no word for "no
 * stdio servers": every agent is to take them, its mcpCapabilities speak only of http and sse, and Hermes 0.21.1
 * reports none. So an agent that takes none says it by refusing the session; it is then asked again without, and the
 * run says it has no notes store.
 */
export const withNotes = (servers: readonly object[]) => String.raw`
NOTES = json.loads(${JSON.stringify(JSON.stringify(servers))})
plain_request = Bridge.request

def request(self, method, params, timeout=45):
    if method in ("session/new", "session/load"):
        try:
            return plain_request(self, method, dict(params, mcpServers=NOTES), timeout)
        except RuntimeError as error:
            if str(error) != self.agent + " ACP rejected " + method:
                raise
            emit("text", text=self.agent + " refused a session with the notes store's MCP server: this run has no notes store")
    return plain_request(self, method, params, timeout)

Bridge.request = request
`;

/** The store's server as ACP names a stdio one, its notes in the VM's HOME (`home`). */
export const notesServer = (project: string, home: string = VM_WORK) => {
  const [command, ...args] = engramArgv(project);
  return { name: "engram", command, args, env: Object.entries(engramEnv(home)).map(([name, value]) => ({ name, value })) };
};

/** A tool call's id as a bridge passes it on (the agent's own: a string of its, kept short); never shown, only paired. */
const callId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
/** A model's name as a tool says it ran on it (vendor-cli.ts named()): one plain word, nothing else of its account. */
const MODEL_SAID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** One line a bridge in the sandbox printed: its normalised event, checked and redacted (the sandbox's words are data). */
export function readBridge(line: string): AgentEvent[] {
  let e: any;
  try { e = JSON.parse(line); } catch { return []; }
  if (!e || typeof e !== "object") return [];
  if (e.type === "session" && typeof e.id === "string" && e.id.length <= 256) return [{ type: "session", id: e.id }];
  if (e.type === "text" && typeof e.text === "string") return [{ type: "text", text: redact(e.text) }];
  if (e.type === "error" && typeof e.message === "string") return [{ type: "error", message: redact(e.message) }];
  if (e.type === "tool" && [e.tool, e.input, e.output].every((v) => typeof v === "string") && typeof e.ok === "boolean") {
    return [{ type: "tool", tool: redact(e.tool), input: redact(e.input), output: redact(e.output), ok: e.ok, ...(callId(e.id) ? { id: e.id as string } : {}) }];
  }
  // A call that began: only its id, which pairs it with its end (runAgent: a steer waits for it).
  if (e.type === "call" && callId(e.id)) return [{ type: "call", id: e.id }];
  // What it spent, with the model it ran on when it names one; and what its session has cost so far at API prices, as
  // its tool counts it (Claude Code's total_cost_usd), when that is a sum of money.
  if (e.type === "tokens" && [e.input, e.output].every((v) => Number.isSafeInteger(v) && v >= 0)) return [{ type: "tokens", input: e.input, output: e.output, ...(typeof e.model === "string" && MODEL_SAID.test(e.model) ? { model: e.model as string } : {}) }];
  if (e.type === "cost" && typeof e.usd === "number" && Number.isFinite(e.usd) && e.usd >= 0 && e.usd < 1_000_000) return [{ type: "cost", usd: e.usd }];
  if (e.type === "retry" && Number.isSafeInteger(e.attempt) && e.attempt > 0 && typeof e.error === "string") return [{ type: "retry", attempt: e.attempt, error: redact(e.error), waitMs: Number.isSafeInteger(e.waitMs) && e.waitMs >= 0 ? e.waitMs : 0 }];
  // One of its plan's windows, as its tool said it (vendor-cli.ts window): its name, its status, used %, its reset.
  if (e.type === "window" && typeof e.name === "string" && /^[a-z0-9][a-z0-9_]{0,31}$/.test(e.name) && (e.status === "allowed" || e.status === "warning" || e.status === "rejected")) {
    return [{ type: "window", name: e.name, status: e.status, ...(Number.isSafeInteger(e.usedPercent) && e.usedPercent >= 0 && e.usedPercent <= 100 ? { usedPercent: e.usedPercent } : {}), ...(Number.isSafeInteger(e.resetsAt) && e.resetsAt > 0 ? { resetsAt: e.resetsAt } : {}) }];
  }
  // Words the node told it, by its own id for them: how far they got.
  if (e.type === "steer" && typeof e.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(e.id) && (e.state === "queued" || e.state === "taken" || e.state === "late")) return [{ type: "steer", id: e.id, state: e.state }];
  return [];
}

/**
 * A vendor's tool keeps its sign-in in its own VM, and a model can make the tool print it. What such a driver passes on
 * (Claude Code's, Codex's, Antigravity's) is redacted as every driver's events are, and then of one thing more: the
 * signed three-part tokens a sign-in is made of (an ID token among them), which have no prefix for the usual redaction
 * to know them by.
 */
const SIGNED_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const scrubSigned = (text: string) => text.replace(SIGNED_TOKEN, "[redacted token]");

/*
 * And a sign-in printed in a form neither can read as it is (the re-check of 28 November 2026, R6): percent-encoded (a
 * token file in a query, Bearer%20ya29...), base64 or hex of it (base64 -w0, xxd -p), or wrapped across lines (an ID
 * token at 76 columns). Before the rest, each is looked at as it was before it was encoded or wrapped: percent-encoded
 * words are read decoded when that shows a secret; a run that decodes to one goes whole; and so does a block of lines
 * wrapped to one width whose lines, joined, show one or decode to one. What shows none comes through as it was. This is
 * for what a tool prints by the way: against a command that means to take the sign-in, no scrub is the guard (H1).
 */
const ENCODED_RUN = /[A-Za-z0-9+/=_-]{40,}/g;
const ENCODED_LINE = /^[A-Za-z0-9+/=_.-]+$/;
const HIDDEN = "[redacted encoded token]";
const shows = (text: string): boolean => redact(text) !== text || scrubSigned(text) !== text;
const decodedAs = (run: string): string[] => [
  ...(/^(?:[0-9a-fA-F]{2})+$/.test(run) ? [Buffer.from(run, "hex").toString("latin1")] : []),
  ...(/^[A-Za-z0-9+/]+={0,2}$/.test(run) ? [Buffer.from(run, "base64").toString("latin1")] : []),
  ...(/^[A-Za-z0-9_-]+={0,2}$/.test(run) ? [Buffer.from(run, "base64url").toString("latin1")] : []),
];
const percentDecoded = (text: string): string =>
  text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
  });
function unhidden(text: string): string {
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    const plain = percentDecoded(text);
    if (shows(plain)) text = plain;
  }
  // Wrapped: lines of encoded characters, each but the last the same width (at least 40), the last no wider. One pass:
  // each line is judged at most twice (the second re-check of 28 November 2026, N1: a search that started again at each
  // line of a block it didn't take held the node's event loop for seconds a line). A narrower last line that shows
  // nothing with its block may be the first of the next: a token wrapped right after a wider encoded line (a hash alone
  // on its line, a long path) begins there (the third re-check's N1b). Taken with its block first, it stays a token's
  // own last line when a line of its width follows.
  const lines = text.split("\n");
  const bare = lines.map((line) => line.replace(/\r$/, ""));
  const encoded = bare.map((line) => ENCODED_LINE.test(line));
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const width = bare[i]!.length;
    let end = i + 1;
    let narrower = false;
    if (encoded[i] && width >= 40) {
      while (end < lines.length && encoded[end] && bare[end]!.length === width) end++;
      if (end < lines.length && encoded[end] && bare[end]!.length < width) {
        end++;
        narrower = true;
      }
    }
    if (end - i > 1) {
      const joined = bare.slice(i, end).join("");
      if (shows(joined) || decodedAs(joined).some(shows)) {
        out.push(HIDDEN);
        i = end;
        continue;
      }
      if (narrower) end -= 1;
      out.push(...lines.slice(i, end));
    } else out.push(lines[i]!);
    i = end;
  }
  return out.join("\n").replace(ENCODED_RUN, (run) => (decodedAs(run).some(shows) ? HIDDEN : run));
}
/** A bridge's line with what it says looked at as it was before it was encoded or wrapped (unhidden). */
function unhiddenLine(line: string): string {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return line;
  }
  if (!e || typeof e !== "object") return line;
  let changed = false;
  for (const key of ["text", "message", "error", "tool", "input", "output"]) {
    const said = e[key];
    if (typeof said !== "string") continue;
    const plain = unhidden(said);
    if (plain !== said) {
      e[key] = plain;
      changed = true;
    }
  }
  return changed ? JSON.stringify(e) : line;
}
export function readSignedIn(line: string): AgentEvent[] {
  return readBridge(unhiddenLine(line)).map((event): AgentEvent => {
    if (event.type === "text") return { ...event, text: scrubSigned(event.text) };
    if (event.type === "error") return { ...event, message: scrubSigned(event.message) };
    if (event.type === "tool") return { ...event, tool: scrubSigned(event.tool), input: scrubSigned(event.input), output: scrubSigned(event.output) };
    return event;
  });
}

/**
 * Whether the command you named starts an ACP agent in this VM: it is started, asked `initialize`, and ended. It exits
 * 0 when the answer is ACP protocol 1, and otherwise says why on stderr (not installed, no ACP answer, another protocol).
 */
export const ACP_PROBE = String.raw`import json, os, select, shlex, subprocess, sys, time
argv = shlex.split(sys.argv[1])
try:
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
except (FileNotFoundError, PermissionError):
    sys.exit(argv[0] + " isn't installed in this VM")
try:
    p.stdin.write((json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "invincible", "version": "1"}}}) + "\n").encode())
    p.stdin.flush()
    end, buf = time.monotonic() + 20, b""
    while time.monotonic() < end:
        if not select.select([p.stdout], [], [], 0.5)[0]:
            if p.poll() is not None:
                break
            continue
        chunk = os.read(p.stdout.fileno(), 65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if isinstance(m, dict) and m.get("id") == 1 and "method" not in m:
                r = m.get("result")
                if isinstance(r, dict) and r.get("protocolVersion") == 1:
                    print(argv[0] + " speaks ACP (protocol 1)")
                    sys.exit(0)
                sys.exit(argv[0] + " answered, but not in ACP protocol 1")
    sys.exit(argv[0] + " gave no ACP answer in 20 seconds: is this the command that starts it in its ACP mode?")
except (BrokenPipeError, OSError):
    sys.exit(argv[0] + " ended before it answered: is this the command that starts it in its ACP mode?")
finally:
    if p.poll() is None:
        p.kill()
`;

/** What a person calls the agents whose ACP commands are known (read from each one's own help, 19 November 2026). */
const KNOWN: Record<string, string> = { gemini: "Gemini CLI", goose: "Goose", opencode: "OpenCode", hermes: "Hermes", qwen: "Qwen Code", kimi: "Kimi CLI" };

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The driver for an ACP agent you named (harness `acp`). It runs on its own setup in the VM, with the role's first
 * model offered through the gateway (`ownSetup`); its API is the OpenAI-compatible one most agents can be pointed at.
 */
export function acpDriver(command: string): AgentDriver {
  if (!TeamAcpCommand.safeParse(command).success || command !== command.trim()) throw new Error("an ACP agent's command is plain words: no quotes, no shell");
  const bin = command.split(" ")[0]!.split("/").at(-1)!;
  const title = KNOWN[bin] ?? bin;
  return {
    name: "acp",
    title,
    kind: "openai",
    // (Its run takes no words once started. One that can load its session again keeps it, and is steered between its
    // calls as OpenCode is; whether it can is its own to say as it runs, so it isn't declared.)
    capabilities: { steer: "restart", streams: true, resumes: false, readsWindows: false },
    ownSetup: true,
    check: `python3 -I -c ${quote(ACP_PROBE)} ${quote(command)}`,
    files: (_models, engram, home) => ({ [ACP_BRIDGE_PATH]: engram ? `${ACP_CLIENT}${GENERIC}${withNotes([notesServer(engram, home)])}${ACP_ENTRY}` : ACP_BRIDGE }),
    command: (model, session) =>
      `python3 -I ${ACP_BRIDGE_PATH} --command ${quote(command)} --name ${quote(title)}${model.own ? "" : ` --provider ${quote(model.provider)} --model ${quote(model.model)}`}${session ? ` --session ${quote(session)}` : ""}`,
    read: readBridge,
  };
}
