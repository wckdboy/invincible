import { redact, TeamAcpCommand } from "@galahad/core";
import type { AgentDriver, AgentEvent } from "./agents.ts";
import { ENGRAM_ENV, engramArgv } from "./engram.ts";

/*
 * The Agent Client Protocol (ACP, protocol 1), Galahad's side of it: a client that runs INSIDE the knight's VM, on the
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
    values = {k: os.environ.get(k, "") for k in ("OPENAI_API_KEY", "GALAHAD_GATEWAY")}
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
        raise RuntimeError(agent + " needs this workspace's Galahad gateway endpoint and token")
    url = urlsplit(values["GALAHAD_GATEWAY"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RuntimeError("Galahad gateway endpoint is invalid")
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
                self.send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Galahad exposes no client resources"}})
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
            item.update({k: v for k, v in update.items() if v is not None})
            if item.get("status") in ("completed", "failed"):
                self.completed.add(ident)
                emit("tool", tool=str(item.get("title") or item.get("kind") or "tool")[:200],
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
                                   "clientInfo": {"name": "galahad", "version": "1"}}, timeout)
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
 * Any agent you name: the command that starts it in its ACP mode, run in the knight's VM as you set it up there (its
 * own sign-in or its own configuration, in the VM's HOME). The model of the knight's role is offered to it two ways:
 * the gateway's address and token in the variables most agents read (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL), and by name
 * where it lists the models it can run on (session/set_model). A session it can load again is kept for the next run.
 * No tool budget and no time limit of the bridge's own: a knight is audited, not capped, and the run's deadline and
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
            base = values["GALAHAD_GATEWAY"].rstrip("/") + "/" + args.provider
            env.update({"OPENAI_BASE_URL": base, "OPENAI_API_BASE": base, "OPENAI_API_KEY": values["OPENAI_API_KEY"], "OPENAI_MODEL": args.model,
                        "GALAHAD_GATEWAY": values["GALAHAD_GATEWAY"], "GALAHAD_PROVIDER": args.provider, "GALAHAD_MODEL": args.model})
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
    parser.add_argument("--gateway-env", default="/work/.galahad-gateway.json")
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

/** The store's server as ACP names a stdio one. */
export const notesServer = (project: string) => {
  const [command, ...args] = engramArgv(project);
  return { name: "engram", command, args, env: Object.entries(ENGRAM_ENV).map(([name, value]) => ({ name, value })) };
};

/** One line a bridge in the sandbox printed: its normalised event, checked and redacted (the sandbox's words are data). */
export function readBridge(line: string): AgentEvent[] {
  let e: any;
  try { e = JSON.parse(line); } catch { return []; }
  if (!e || typeof e !== "object") return [];
  if (e.type === "session" && typeof e.id === "string" && e.id.length <= 256) return [{ type: "session", id: e.id }];
  if (e.type === "text" && typeof e.text === "string") return [{ type: "text", text: redact(e.text) }];
  if (e.type === "error" && typeof e.message === "string") return [{ type: "error", message: redact(e.message) }];
  if (e.type === "tool" && [e.tool, e.input, e.output].every((v) => typeof v === "string") && typeof e.ok === "boolean") {
    return [{ type: "tool", tool: redact(e.tool), input: redact(e.input), output: redact(e.output), ok: e.ok }];
  }
  if (e.type === "tokens" && [e.input, e.output].every((v) => Number.isSafeInteger(v) && v >= 0)) return [{ type: "tokens", input: e.input, output: e.output }];
  if (e.type === "retry" && Number.isSafeInteger(e.attempt) && e.attempt > 0 && typeof e.error === "string") return [{ type: "retry", attempt: e.attempt, error: redact(e.error), waitMs: Number.isSafeInteger(e.waitMs) && e.waitMs >= 0 ? e.waitMs : 0 }];
  return [];
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
    p.stdin.write((json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "galahad", "version": "1"}}}) + "\n").encode())
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
    ownSetup: true,
    check: `python3 -c ${quote(ACP_PROBE)} ${quote(command)}`,
    files: (_models, engram) => ({ [ACP_BRIDGE_PATH]: engram ? `${ACP_CLIENT}${GENERIC}${withNotes([notesServer(engram)])}${ACP_ENTRY}` : ACP_BRIDGE }),
    command: (model, session) =>
      `python3 ${ACP_BRIDGE_PATH} --command ${quote(command)} --name ${quote(title)}${model.own ? "" : ` --provider ${quote(model.provider)} --model ${quote(model.model)}`}${session ? ` --session ${quote(session)}` : ""}`,
    read: readBridge,
  };
}
