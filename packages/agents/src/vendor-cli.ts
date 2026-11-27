import { SeatFingerprint, SeatPlan, SIGN_IN_METHODS, tokenShaped } from "@invincible/core";
import type { AgentDriver, AgentEvent, AgentModel } from "./harnesses.ts";
import { ENGRAM_ENV, engramArgv } from "./engram.ts";
import { readBridge } from "./hermes.ts";

/*
 * The vendors' own coding tools as harnesses: Claude Code and Codex. A subscription (a Claude
 * plan, a ChatGPT plan) may be used only by its vendor's own tool, unmodified, signed in by its
 * owner through the vendor's own flow. So that is all this does: it runs the tool (pinned and
 * checked in the VM's image, sandbox/harnesses, or one the owner installed in the VM), signed in
 * by its owner, headless, and reads what it prints.
 *
 *   - Invincible never holds a sign-in. Nothing here opens, copies, moves or sends where a tool keeps
 *     one. Whether the tool has one is asked of the tool (its own status command), and of the
 *     answer only "signed in or not" and one word from a fixed list leaves the VM; for a seat (core's
 *     seats.ts), three things more: its tier, its account as a salted hash made in the VM, and when
 *     its sign-in ends.
 *   - Invincible never updates or signs in the tool, and never says it is another tool: the flags
 *     below are the vendor's documented ones, and no client identity is set anywhere but its own
 *     name to Codex's app server. A seat's sign-in is the owner's, on the vendor's own page.
 *   - Signed in, the tool talks to its vendor itself: every variable that points at Invincible's
 *     gateway is taken out of its environment, so the gateway is never given that traffic.
 *   - Not signed in, it runs on a keyed roster model through the gateway, by the vendor's own
 *     documented way to another endpoint, on the VM's scoped token (never a key).
 *
 * Like Hermes' bridge this is Python's standard library, running INSIDE the assigned sandbox. It
 * prints the same bounded, normalised events, so one long line of the tool's never splits JSON.
 */

/** Shared by both bridges: bounded events, the two environments, the gateway lease, the run itself. */
const SHARED = String.raw`import argparse, base64, hashlib, hmac, json, os, re, selectors, shutil, signal, subprocess, sys, time, uuid
from pathlib import Path
from urllib.parse import urlsplit

# Every variable a gateway lease puts in a sandbox's environment.
GATEWAY_VARS = ("INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN", "INVINCIBLE_REPO_URL", "INVINCIBLE_SEARCH",
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

WINDOW = re.compile(r"[a-z0-9][a-z0-9_]{0,31}")

def window(name, status, used=None, at=None):
    # One of its plan's windows as the tool said it: its name, allowed, warning or rejected, how much of it is used (%)
    # and when it resets (seconds or ms since the epoch). Nothing else of what the tool says of its account is passed on.
    if not isinstance(name, str) or not WINDOW.fullmatch(name) or status not in ("allowed", "warning", "rejected"):
        return
    said = {"name": name, "status": status}
    if type(used) in (int, float) and 0 <= used <= 100:
        said["usedPercent"] = int(round(used))
    when = moment(at)
    if when:
        said["resetsAt"] = when
    emit("window", **said)

def own_path(env):
    # (Where a vendor's installer puts its tool for one user, whatever the shell's profile says.)
    env["PATH"] = os.path.join(os.path.expanduser("~"), ".local", "bin") + os.pathsep + env.get("PATH", "")
    return env

def own_environment():
    # The tool as its owner set it up in this VM, less everything that points at Invincible's gateway:
    # signed in for itself, it talks to its vendor itself.
    return own_path({k: v for k, v in os.environ.items() if k not in GATEWAY_VARS})

def gateway_lease(path):
    values = {k: os.environ.get(k, "") for k in ("INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN")}
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
        raise RuntimeError(NAME + " needs this workspace's Invincible gateway endpoint and token")
    url = urlsplit(values["INVINCIBLE_GATEWAY"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RuntimeError("Invincible gateway endpoint is invalid")
    return values["INVINCIBLE_GATEWAY"].rstrip("/"), values["INVINCIBLE_TOKEN"]

def ask(env, *args):
    try:
        return subprocess.run([TOOL, *args], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=12)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None

def moment(value):
    # When, as a tool says it (an ISO date, or seconds or ms since the epoch): ms since the epoch, else None.
    try:
        if type(value) in (int, float) and value > 0:
            return int(value if value > 100000000000 else value * 1000)
        if isinstance(value, str) and value:
            from datetime import datetime, timezone
            when = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return int((when if when.tzinfo else when.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    except (OverflowError, OSError, ValueError):
        return None
    return None

def fingerprint(salt, ident):
    # Which account, as a salted hash made here: the account's own id never leaves this VM.
    return base64.urlsafe_b64encode(hmac.new(salt, ident.encode("utf-8"), hashlib.sha256).digest()[:16]).decode().rstrip("=")

def status(args):
    # Installed, and signed in or not. Asked of the tool as itself: a gateway token is never its sign-in. For a seat
    # (--salt), three things more: the plan's tier, the account as a salted hash, and when the sign-in ends. Nothing
    # else the tool says of its account (whose it is, its email, its organization) is passed on.
    env = own_environment()
    version = ask(env, "--version") if shutil.which(TOOL, path=env["PATH"]) else None
    installed = version is not None and version.returncode == 0
    held = account(env, bool(args.salt)) if installed else None
    told = {"type": "status", "installed": installed, "signedIn": held is not None}
    if held:
        told["method"] = held["method"]
        if args.salt:
            salt = base64.urlsafe_b64decode(args.salt + "=" * (-len(args.salt) % 4))
            if held.get("plan"):
                told["plan"] = held["plan"]
            if held.get("id"):
                told["fingerprint"] = fingerprint(salt, held["id"])
            if held.get("renewBy"):
                told["renewBy"] = held["renewBy"]
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

class Lines:
    # Whole lines out of chunks as they come, for a loop that waits on two streams at once. A line longer than its
    # limit is dropped whole, never cut.
    def __init__(self, limit):
        self.limit, self.parts, self.size, self.dropping = limit, [], 0, False

    def feed(self, chunk):
        out = []
        while chunk:
            at = chunk.find(b"\n")
            if at < 0:
                self.size += len(chunk)
                if self.size > self.limit:
                    self.parts, self.size, self.dropping = [], 0, True
                elif not self.dropping:
                    self.parts.append(chunk)
                return out
            piece, chunk = chunk[:at], chunk[at + 1:]
            if not self.dropping and self.size + len(piece) <= self.limit:
                out.append(b"".join(self.parts) + piece)
            self.parts, self.size, self.dropping = [], 0, False
        return out

# What the node tells a run as it goes, a line at a time on the bridge's own input (a FIFO its launch opens; /dev/null
# where a run has none): {"say": <your words>, "id": <the node's for them>} or {"stop": true}. Your words are a message
# to the tool, as yours would be at its own prompt; each is said back by its id (queued, taken, or late: never told).
SAID_LIMIT = 65536
SAID_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

def run(args):
    env = own_environment() if args.own else own_path(dict(os.environ))
    if shutil.which(TOOL, path=env["PATH"]) is None:
        raise RuntimeError(NAME + " is not installed in this VM; its owner installs it there (Invincible never does)")
    if args.own:
        if sign_in(env) is None:
            raise RuntimeError(NAME + " is not signed in in this VM; sign it in there (" + LOGIN + ")")
        extra = []
    else:
        base, token = gateway_lease(Path(args.gateway_env))
        extra = through_gateway(env, base + "/" + args.provider, token, args.model)
    with open(args.prompt, "rb") as message:
        prompt = message.read().decode("utf-8", "replace")
    if args.cut_off and args.session:
        taken_up(env)
    child = subprocess.Popen(arguments(args, extra), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
    reader = Reader(child, args)
    ours, yours = Lines(LINE_LIMIT), Lines(SAID_LIMIT)
    watch = selectors.DefaultSelector()
    watch.register(child.stdout, selectors.EVENT_READ, "tool")
    try:
        watch.register(sys.stdin, selectors.EVENT_READ, "you")
    except (ValueError, OSError):
        pass  # (No input of its own: nothing is said to it as it runs.)
    ended = False
    try:
        reader.begin(prompt)
        while not ended:
            for key, _ in watch.select(timeout=1.0):
                if key.data == "tool":
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        ended = True
                        break
                    for raw in ours.feed(chunk):
                        try:
                            event = json.loads(raw)
                            if isinstance(event, dict):
                                reader.event(event)
                        except (ValueError, TypeError, AttributeError, KeyError, RecursionError):
                            # What the tool prints is data. A line that isn't what it should be is passed over.
                            continue
                else:
                    chunk = os.read(sys.stdin.fileno(), 65536)
                    if not chunk:
                        watch.unregister(sys.stdin)
                        continue
                    for raw in yours.feed(chunk):
                        try:
                            said = json.loads(raw)
                        except ValueError:
                            continue
                        if not isinstance(said, dict):
                            continue
                        if said.get("stop") is True:
                            reader.halt()
                        elif isinstance(said.get("say"), str) and said["say"].strip() and isinstance(said.get("id"), str) and SAID_ID.fullmatch(said["id"]):
                            reader.say(said["id"], said["say"])
            if reader.stop and not reader.stopping:
                # (A spent allowance: it is not waited out here. The next model takes over instead.)
                reader.halt()
            if not reader.closed and reader.done():
                reader.close()
    finally:
        # Stopped here (a spent allowance, a fault of our own): the tool is not left running.
        if not ended and child.poll() is None:
            child.terminate()
        try:
            code = child.wait(timeout=None if ended else 5)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
        # Whatever you said that it never took is said back as late: the node tells it in its next run.
        reader.untold()
    failure = reader.verdict()
    if failure:
        raise RuntimeError(failure)
    if reader.stopping and not reader.stop:
        return
    if not reader.finished:
        raise RuntimeError(NAME + (" exited with %d and no result" % code if code else " ended without a result"))
    if code:
        raise RuntimeError(NAME + " exited with %d" % code)

class Told:
    # What a run was told as it went, by the node's id for each: said back once it is queued, once it is taken, and as
    # late if it never was. Shared by both tools' readers.
    def __init__(self):
        self.state = {}

    def sent(self, ident):
        self.state[ident] = "sent"

    def mark(self, ident, state):
        if ident in self.state and self.state[ident] not in ("taken", "late") and self.state[ident] != state:
            self.state[ident] = state
            emit("steer", id=ident, state=state)

    def late(self, ident):
        self.state.setdefault(ident, "sent")
        self.mark(ident, "late")

    def untold(self):
        for ident, state in list(self.state.items()):
            if state not in ("taken", "late"):
                self.mark(ident, "late")
`;

/** After a tool's own part: the arguments, and the one error a failed run ends on. */
const MAIN = String.raw`
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--own", action="store_true")
    parser.add_argument("--provider", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--session")
    # Its last run in that session was cut off before it ended (its process stopped without an exit code).
    parser.add_argument("--cut-off", action="store_true")
    parser.add_argument("--prompt", default="/work/.agent/prompt.md")
    parser.add_argument("--gateway-env", default="/work/.invincible-gateway.json")
    parser.add_argument("--status", action="store_true")
    # For a seat's status: the salt its account's fingerprint is made with (url-safe base64).
    parser.add_argument("--salt", default="")
    args = parser.parse_args()
    try:
        if args.status:
            if args.salt and not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", args.salt):
                raise RuntimeError("A seat's salt is url-safe base64")
            return status(args)
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
 * Claude Code, headless and live: `claude -p --input-format stream-json --output-format stream-json --verbose
 * --replay-user-messages`, every tool allowed (the VM is the boundary), `--resume <session id>` to continue. Its message
 * is the first user message on its input, and each of yours as it runs is one more: one sent during a tool call reaches
 * it once those calls finish, in the same turn, and one after its turn starts a new one. Its input closes once every
 * message it was given has ended, and it ends then. A stop is SIGINT, which ends its turn and the tool. Shapes as 2.1.326
 * printed them against a loopback model on 26 November 2026 (test/fixtures/claude-code-2.1.326): `system/init` names the
 * session and its `capabilities`; `command_lifecycle` follows each message given it by its uuid (queued, started,
 * completed or cancelled), and `--replay-user-messages` says each back as it is taken; an `assistant` message holds
 * `text` and `tool_use` blocks; a `user` message holds each `tool_result`; `result` ends a turn.
 */
const CLAUDE_PART = String.raw`
TOOL, NAME, LOGIN = "claude", "Claude Code", "claude auth login"
# How the tool says it is signed in. One of these words is all that is passed on: its status
# command also prints whose account it is, and none of that is Invincible's to know.
METHODS = ("claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party")

def account(env, seat):
    # Its status command prints JSON: signed in or not and how, and for a claude.ai sign-in its plan, its organization
    # and when the sign-in ends (loginExpiresAt, as 2.1.325 says it). The organization is the account's id here.
    state = ask(env, "auth", "status")
    if state is None or state.returncode != 0:
        return None
    try:
        told = json.loads(state.stdout)
    except ValueError:
        return None
    if not isinstance(told, dict) or told.get("loggedIn") is False or told.get("authMethod") == "none":
        return None
    held = {"method": told["authMethod"] if told.get("authMethod") in METHODS else "signed in"}
    if isinstance(told.get("subscriptionType"), str):
        held["plan"] = told["subscriptionType"].lower()
    if isinstance(told.get("orgId"), str) and told["orgId"]:
        held["id"] = "claude.ai:" + told["orgId"]
    when = moment(told.get("loginExpiresAt"))
    if when:
        held["renewBy"] = when
    return held

def sign_in(env):
    held = account(env, False)
    return held["method"] if held else None

def taken_up(env):
    # Its last run was cut off mid-turn: the turn it was in is taken up again by itself on --resume, by Claude Code's own
    # setting, and the message that follows is answered in it (2.1.326, recorded 26 November 2026).
    env["CLAUDE_CODE_RESUME_INTERRUPTED_TURN"] = "1"

def through_gateway(env, base, token, model):
    # The tool's own documented way to a gateway: its endpoint, and a bearer for it.
    env.update({"ANTHROPIC_BASE_URL": base, "ANTHROPIC_AUTH_TOKEN": token})
    # (As under invincible run: a key of the owner's own is not sent beside the gateway's token.)
    env.pop("ANTHROPIC_API_KEY", None)
    return ["--model", model]

def arguments(args, extra):
    argv = [TOOL, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
            "--permission-mode", "bypassPermissions"] + extra
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
    def __init__(self, child, args):
        self.child = child
        self.session, self.told, self.calls, self.said = None, False, {}, ""
        # failed: a spent allowance, which ends the run; faulted: the latest turn's own error, which a later turn that
        # ends well (one a message of yours began) leaves behind.
        self.cause, self.failed, self.faulted, self.finished, self.stop = "", "", "", False, False
        # What it was given, by the uuid each went with (the node's id for yours, "" for the run's own message); those
        # not yet ended; whether it says each one's lifecycle (msg_lifecycle_v1, in system/init's capabilities).
        self.given, self.open, self.lifecycle, self.heard = {}, set(), False, Told()
        self.closed, self.stopping, self.turned = False, False, False

    def write(self, message):
        if self.closed:
            return False
        try:
            self.child.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8", "replace"))
            self.child.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def message(self, text, ident):
        mark = str(uuid.uuid4())
        self.given[mark] = ident
        self.open.add(mark)
        if self.write({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": None, "uuid": mark}):
            return True
        self.open.discard(mark)
        return False

    def begin(self, prompt):
        if not self.message(prompt, ""):
            raise RuntimeError(NAME + " could not be given its message")

    def say(self, ident, text):
        # (With no priority of its own: "now" would end the turn under way and start another, so it is never sent.)
        self.heard.sent(ident)
        if self.stopping or self.closed or not self.message(text, ident):
            self.heard.late(ident)

    def halt(self):
        # A stop: SIGINT ends its turn, and the tool with it.
        self.stopping = True
        if self.child.poll() is None:
            self.child.send_signal(signal.SIGINT)

    def done(self):
        # Its input closes once a turn has ended and so has every message it was given.
        return self.turned and not self.open and not self.stopping

    def close(self):
        self.closed = True
        try:
            self.child.stdin.close()
        except OSError:
            pass

    def untold(self):
        self.heard.untold()

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
            self.lifecycle = isinstance(e.get("capabilities"), list) and "msg_lifecycle_v1" in e["capabilities"]
        elif kind == "command_lifecycle" and e.get("command_uuid") in self.given:
            mark, state = e["command_uuid"], e.get("state")
            ident = self.given[mark]
            if ident and state == "queued":
                self.heard.mark(ident, "queued")
            elif ident and state == "started":
                self.heard.mark(ident, "taken")
            if state in ("completed", "cancelled"):
                self.open.discard(mark)
                if ident and state == "cancelled":
                    self.heard.late(ident)
        elif kind == "user" and e.get("isReplay") is True:
            # A message of yours said back as it enters the conversation: taken. (Without lifecycles it's all there is.)
            ident = self.given.get(e.get("uuid"))
            if ident:
                self.heard.mark(ident, "taken")
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
                    # Said as it begins: a steer waits for a call it is in.
                    emit("call", id=block["id"][:256])
        elif kind == "user":
            for block in blocks(e):
                ident = block.get("tool_use_id")
                call = self.calls.pop(ident, None) if block.get("type") == "tool_result" and isinstance(ident, str) else None
                if call:
                    emit("tool", id=ident[:256], tool=call[0][:200], input=clip(call_input(call[1]), 2000),
                         output=clip(text_of(block.get("content")), 4000), ok=block.get("is_error") is not True)
        elif kind == "rate_limit_event":
            info = e.get("rate_limit_info")
            # Its plan's windows as it says them (on a claude.ai sign-in): the one this event is of, and each it lists.
            if isinstance(info, dict):
                status = {"allowed": "allowed", "allowed_warning": "warning", "rejected": "rejected"}.get(info.get("status"))
                used = info.get("utilization")
                window(info.get("rateLimitType") or "plan", status, used * 100 if type(used) in (int, float) else None, info.get("resetsAt"))
                listed = info.get("unifiedWindows")
                for name, held in (listed.items() if isinstance(listed, dict) else []):
                    if isinstance(held, dict) and name != info.get("rateLimitType"):
                        status = {"allowed": "allowed", "allowed_warning": "warning", "rejected": "rejected"}.get(held.get("status"))
                        used = held.get("utilization")
                        window(name, status, used * 100 if type(used) in (int, float) else None, held.get("resetsAt"))
            # Only status says a request was refused: a run within its allowance carries
            # "overageStatus": "rejected" beside "status": "allowed".
            if isinstance(info, dict) and info.get("status") == "rejected":
                credits = " (it needs usage credits to go on)" if info.get("errorCode") == "credits_required" else ""
                self.failed = NAME + "'s allowance is spent" + credits + resets(info.get("resetsAt"))
                # It may wait for its window to reset. The next model takes over instead.
                self.stop = True
        elif kind == "result":
            # A turn's end (and its usage): the run ends once every message it was given has.
            self.finished = self.turned = True
            if not self.lifecycle:
                self.open.clear()
            spent_in = count(e.get("usage"), "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
            spent_out = count(e.get("usage"), "output_tokens")
            if spent_in or spent_out:
                emit("tokens", input=spent_in, output=spent_out)
            text = e.get("result") if isinstance(e.get("result"), str) else ""
            subtype = e["subtype"] if isinstance(e.get("subtype"), str) and re.fullmatch(r"[a-z_]{1,40}", e["subtype"]) else ""
            # (A result of an error's kind is one, whatever its flag says. A turn its stop ended is no fault.)
            if e.get("is_error") is True or subtype.startswith("error"):
                errors = e.get("errors") if isinstance(e.get("errors"), list) else []
                detail = text.strip() or "; ".join(x for x in errors if isinstance(x, str))
                cause = self.cause or subtype
                if not self.stopping:
                    self.faulted = NAME + " ended with an error" + (" (" + cause + ")" if cause else "") + (": " + clip(detail, 600) if detail else "")
            else:
                self.faulted, self.cause = "", ""
                if text.strip() and text != self.said:
                    emit("text", text=clip(text, 24000))

    def verdict(self):
        return self.failed or self.faulted
`;

/**
 * Codex, headless and live: its app server on stdio (`codex app-server`, JSON-RPC lines), its client named Invincible.
 * A thread (`thread/start`, or `thread/resume` to continue one) never asks for approval and has no sandbox of its own
 * (the VM is the boundary); its message is a turn (`turn/start`), and each of yours as it runs is `turn/steer` of the
 * turn under way (`expectedTurnId`), or a turn of its own once that one has ended. A stop is `turn/interrupt`. Its input
 * closes once no turn is under way: closed during one, the app server ends at once. Shapes as 0.172.0 printed them
 * against a loopback model on 26 November 2026 (test/fixtures/codex-0.172.0): `item/started` and `item/completed` carry
 * a message, a command with its output and exit code, or a change; `turn/completed` ends a turn (completed, interrupted
 * or failed, with its error); `error` says a failure, or a retry (`willRetry`); `thread/tokenUsage/updated` its usage.
 */
const CODEX_PART = String.raw`
TOOL, NAME, LOGIN = "codex", "Codex", "codex login --device-auth"

# Where it keeps its sign-in in a VM, as OpenAI's CI page asks: a file in its home (a VM has no keyring).
STORE = ["-c", 'cli_auth_credentials_store="file"']

def app_server(env, requests):
    # Its own app server, on stdio, for the account it holds (account/read): asked and closed. Its answers by id.
    try:
        child = subprocess.Popen([TOOL, "app-server", *STORE], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
    except OSError:
        return {}
    answers = {}
    try:
        lines = [{"id": 0, "method": "initialize", "params": {"clientInfo": {"name": "invincible", "title": "Invincible", "version": "1"}, "capabilities": None}}, {"method": "initialized"}]
        lines += [dict(item, id=i + 1) for i, item in enumerate(requests)]
        child.stdin.write("".join(json.dumps(line) + "\n" for line in lines))
        child.stdin.flush()
        until = time.monotonic() + 12
        while time.monotonic() < until and len(answers) < len(requests):
            raw = child.stdout.readline(LINE_LIMIT + 1)
            if not raw:
                break
            try:
                said = json.loads(raw)
            except ValueError:
                continue
            if isinstance(said, dict) and type(said.get("id")) is int and said["id"] > 0 and isinstance(said.get("result"), dict):
                answers[said["id"]] = said["result"]
    except (OSError, ValueError):
        pass
    finally:
        child.kill()
        child.wait()
    return answers

def account(env, seat):
    state = ask(env, "login", "status")
    if state is None or state.returncode != 0:
        return None
    said = state.stdout + state.stderr
    # With an API key this command prints part of the key. One of these words is all that is passed on.
    held = {"method": "chatgpt" if "ChatGPT" in said else "api-key" if "API key" in said else "signed in"}
    if seat and held["method"] == "chatgpt":
        read = app_server(env, [{"method": "account/read", "params": {}}]).get(1, {})
        plan = (read.get("account") or {}).get("planType") if isinstance(read.get("account"), dict) else None
        if isinstance(plan, str):
            held["plan"] = plan.lower()
        if isinstance(read.get("userId"), str) and read["userId"]:
            held["id"] = "chatgpt:" + read["userId"]
    return held

def sign_in(env):
    held = account(env, False)
    return held["method"] if held else None

def taken_up(env):
    # (Its thread resumed as any is, thread/resume: the message that follows tells it to go on.)
    return None

def through_gateway(env, base, token, model):
    # The tool's own documented way to another endpoint: a model_providers entry on the Responses
    # API (the only one it speaks), its bearer read from the environment and never written down.
    env["INVINCIBLE_TOKEN"] = token
    entry = {"name": "Invincible gateway", "base_url": base, "env_key": "INVINCIBLE_TOKEN", "wire_api": "responses"}
    # (Its app server takes the model as a setting, as -c model="…" sets it: it has no -m.)
    extra = ["-c", "model=" + json.dumps(model), "-c", "model_provider=" + json.dumps("invincible")]
    for key, value in entry.items():
        extra += ["-c", "model_providers.invincible." + key + "=" + json.dumps(value)]
    return extra

# Its plan's allowance spent, in its own words: "You've hit your usage limit. … try again at 3:45 PM." (0.169.0 writes
# You’ve, and the day too when it isn't today: "at Nov 23rd, 2026 8:11 PM", by this VM's clock). Said as Claude Code's
# is, without the offers around it, and when it resets in UTC where it gave a time.
LIMIT = re.compile("You['’]ve hit your usage limit")
# The items that are calls of its: the start of each is said, as its end is.
CALLS = ("commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall")
# Its windows by their length in minutes, as Claude Code names its own.
WINDOWS = {300: "five_hour", 10080: "seven_day"}
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
    # (Its own approvals and sandbox are set per thread: never asked, and no sandbox of its own. The VM is the boundary.)
    return [TOOL, "app-server", *STORE] + extra

def as_input(words):
    return [{"type": "text", "text": words, "text_elements": []}]

def change(c):
    kind = c.get("kind")
    return str(kind.get("type", "change") if isinstance(kind, dict) else kind or "change") + " " + str(c.get("path", ""))

class Reader:
    def __init__(self, child, args):
        self.child, self.resuming, self.prompt = child, args.session, ""
        self.session, self.told = None, False
        self.trouble, self.failed, self.finished, self.stop = "", "", False, False
        self.closed, self.stopping, self.heard = False, False, Told()
        # Its requests by id, and what each was for; its thread, the turn under way and those that have ended; your words
        # said before its first turn began, to be told once it has; the token counts its thread had before this run.
        self.asked, self.count = {}, 0
        self.thread, self.turn, self.ended, self.started, self.mine = None, None, set(), False, set()
        self.early, self.totals = [], None

    def write(self, message):
        if self.closed:
            return False
        try:
            self.child.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8", "replace"))
            self.child.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def request(self, method, params, why):
        self.count += 1
        self.asked[self.count] = why
        return self.write({"id": self.count, "method": method, "params": params})

    def begin(self, prompt):
        # Its client is named as itself, Invincible, and nothing else (Codex names what it serves after its client).
        self.prompt = prompt
        if not self.request("initialize", {"clientInfo": {"name": "invincible", "title": "Invincible", "version": "1"}, "capabilities": None}, ("initialize",)):
            raise RuntimeError(NAME + " could not be given its message")

    def say(self, ident, words):
        self.heard.sent(ident)
        if self.stopping or self.closed:
            self.heard.late(ident)
        elif not self.started:
            self.early.append((ident, words))
        else:
            self.tell(ident, words)

    def tell(self, ident, words):
        # A steer of the turn under way (expectedTurnId: never another's), or a turn of its own in the same thread.
        if self.turn:
            sent = self.request("turn/steer", {"threadId": self.thread, "input": as_input(words), "expectedTurnId": self.turn, "clientUserMessageId": ident}, ("steer", ident, words))
        else:
            sent = self.request("turn/start", {"threadId": self.thread, "input": as_input(words), "clientUserMessageId": ident}, ("start", ident))
        if not sent:
            self.heard.late(ident)

    def halt(self):
        # A stop: its turn is interrupted (turn/interrupt), and its input closes once that turn has ended.
        self.stopping = True
        if not (self.turn and self.request("turn/interrupt", {"threadId": self.thread, "turnId": self.turn}, ("interrupt",))):
            self.close()

    def done(self):
        # Its input closes only once no turn is under way and nothing asked of it is unanswered: closed mid-turn, its
        # app server ends at once (0.172.0), the turn with it.
        if self.turn or any(why[0] != "interrupt" for why in self.asked.values()):
            return False
        return self.started or self.stopping or bool(self.failed)

    def close(self):
        self.closed = True
        try:
            self.child.stdin.close()
        except OSError:
            pass

    def untold(self):
        self.heard.untold()

    def answered(self):
        # A session is worth continuing once something was done in it. One that never got a
        # reply is not: the next model starts the work afresh.
        if self.session and not self.told:
            self.told = True
            emit("session", id=self.session)

    def event(self, e):
        method = e.get("method")
        if "id" in e and isinstance(method, str):
            return self.asks(e["id"], method)
        if method is None and type(e.get("id")) is int:
            return self.answer(e)
        params = e.get("params") if isinstance(e.get("params"), dict) else {}
        if method == "turn/started" and isinstance(params.get("turn"), dict) and isinstance(params["turn"].get("id"), str):
            self.mine.add(params["turn"]["id"])
            if params["turn"]["id"] not in self.ended:
                self.turn = params["turn"]["id"]
        elif method == "item/started" and isinstance(params.get("item"), dict):
            item = params["item"]
            if item.get("type") == "userMessage" and isinstance(item.get("clientId"), str):
                self.heard.mark(item["clientId"], "taken")
            elif item.get("type") in CALLS and isinstance(item.get("id"), str):
                # Its model has acted (as Claude Code's first answer says its session): a run cut off in its first call
                # is taken up again there. The call said as it begins: a steer of a tool told only between calls waits for it.
                self.answered()
                emit("call", id=item["id"][:256])
        elif method == "item/completed" and isinstance(params.get("item"), dict):
            self.item(params["item"])
        elif method == "turn/completed" and isinstance(params.get("turn"), dict):
            turn = params["turn"]
            if isinstance(turn.get("id"), str):
                self.ended.add(turn["id"])
                if self.turn == turn["id"]:
                    self.turn = None
            status = turn.get("status")
            if status == "completed":
                self.finished, self.trouble = True, ""
            elif status == "failed":
                error = turn.get("error") if isinstance(turn.get("error"), dict) else {}
                message = error.get("message") if isinstance(error.get("message"), str) else ""
                self.failed = spent(message or self.trouble) or NAME + " stopped: " + clip(message or self.trouble or "its turn failed", 600)
            elif status == "interrupted" and not self.stopping:
                self.failed = NAME + "'s turn was interrupted"
        elif method == "error" and isinstance(params.get("error"), dict) and isinstance(params["error"].get("message"), str):
            message = params["error"]["message"]
            if params.get("willRetry") is True:
                # A reconnection is a retry on the trail, its reason where it gives one: a run that waits isn't one that hangs.
                again = RECONNECT.match(message)
                emit("retry", attempt=int(again.group(1)) if again else 1, error=clip((again.group(2) if again else message) or "reconnecting", 300), waitMs=0)
            else:
                # Not always the end: it is, if its turn fails after it or no turn completes.
                self.trouble = message
        elif method == "thread/tokenUsage/updated" and isinstance(params.get("tokenUsage"), dict):
            self.tokens(params["tokenUsage"], params.get("turnId"))
        elif method == "account/rateLimits/updated" and isinstance(params.get("rateLimits"), dict):
            # Its plan's two windows as it says them after each response (named by their length: five hours, a week).
            for held in (params["rateLimits"].get("primary"), params["rateLimits"].get("secondary")):
                if isinstance(held, dict) and type(held.get("usedPercent")) in (int, float):
                    minutes = held.get("windowDurationMins") if type(held.get("windowDurationMins")) is int else 0
                    name = WINDOWS.get(minutes) or ("minutes_%d" % minutes if 0 < minutes < 10 ** 7 else None)
                    window(name, "rejected" if held["usedPercent"] >= 100 else "allowed", held["usedPercent"], held.get("resetsAt"))

    def tokens(self, usage, turn):
        # Its thread's running totals: what this run spent is what they grew by in its own turns. (Resumed, a thread says
        # its totals before any turn of this run's, as 0.172.0 does with its answer: that is where this run starts from.)
        total = usage.get("total") if isinstance(usage.get("total"), dict) else {}
        last = usage.get("last") if isinstance(usage.get("last"), dict) else {}
        now = [total.get("inputTokens"), total.get("outputTokens")]
        if not all(type(v) is int and v >= 0 for v in now):
            return
        if turn not in self.mine:
            self.totals = now
            return
        if self.totals is None:
            first = [last.get("inputTokens"), last.get("outputTokens")]
            self.totals = [n - f if type(f) is int and 0 <= f <= n else n for n, f in zip(now, first)]
        grew = [max(0, n - t) for n, t in zip(now, self.totals)]
        self.totals = now
        if any(grew):
            emit("tokens", input=grew[0], output=grew[1])

    def item(self, item):
        what = item.get("type")
        if what not in ("agentMessage", "commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"):
            return
        # Its end names it, where it has an id.
        ident = {"id": item["id"][:256]} if isinstance(item.get("id"), str) else {}
        self.answered()
        if what == "agentMessage" and isinstance(item.get("text"), str) and item["text"].strip():
            emit("text", text=clip(item["text"], 24000))
        elif what == "commandExecution":
            emit("tool", tool="shell", input=clip(as_text(item.get("command", "")), 2000),
                 output=clip(as_text(item.get("aggregatedOutput") or ""), 4000), ok=item.get("exitCode") == 0 and item.get("status") == "completed", **ident)
        elif what == "fileChange":
            changes = [c for c in item["changes"] if isinstance(c, dict)] if isinstance(item.get("changes"), list) else []
            emit("tool", tool="edit", input=clip("\n".join(change(c) for c in changes), 2000), output="", ok=item.get("status") == "completed", **ident)
        elif what == "mcpToolCall":
            result = item.get("result") if isinstance(item.get("result"), dict) else {}
            error = item.get("error") if isinstance(item.get("error"), dict) else {}
            emit("tool", tool=(str(item.get("server", "mcp")) + "." + str(item.get("tool", "tool")))[:200],
                 input=clip(as_text(item.get("arguments", "")), 2000),
                 output=clip(text_of(result.get("content")) or as_text(error.get("message") or ""), 4000), ok=item.get("status") == "completed", **ident)
        elif what == "webSearch":
            emit("tool", tool="web_search", input=clip(as_text(item.get("query", "")), 2000), output="", ok=True, **ident)
        elif what == "dynamicToolCall":
            said = item.get("contentItems") if isinstance(item.get("contentItems"), list) else []
            emit("tool", tool=str(item.get("tool", "tool"))[:200], input=clip(as_text(item.get("arguments", "")), 2000),
                 output=clip("\n".join(str(c.get("text", "")) for c in said if isinstance(c, dict)), 4000), ok=item.get("success") is True, **ident)

    def answer(self, e):
        why = self.asked.pop(e["id"], None)
        if why is None:
            return
        result = e.get("result") if isinstance(e.get("result"), dict) else None
        error = e.get("error") if isinstance(e.get("error"), dict) else {}
        said = error.get("message") if isinstance(error.get("message"), str) else ""
        if why[0] == "initialize":
            if result is None:
                self.failed = NAME + "'s app server didn't start" + (": " + clip(said, 300) if said else "")
                return
            self.write({"method": "initialized"})
            given = {"approvalPolicy": "never", "sandbox": "danger-full-access"}
            if self.resuming:
                self.request("thread/resume", dict(given, threadId=self.resuming, excludeTurns=True), ("thread",))
            else:
                self.request("thread/start", dict(given, cwd=os.getcwd()), ("thread",))
        elif why[0] == "thread":
            thread = result.get("thread") if result else None
            if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
                self.failed = ("The saved " + NAME + " session is not one it knows; it was not replaced" if self.resuming else NAME + " didn't start a thread") + (" (" + clip(said, 300) + ")" if said else "")
                return
            self.thread = self.session = thread["id"]
            self.request("turn/start", {"threadId": self.thread, "input": as_input(self.prompt)}, ("turn",))
        elif why[0] == "turn":
            turn = result.get("turn") if result else None
            if not isinstance(turn, dict) or not isinstance(turn.get("id"), str):
                self.failed = NAME + " didn't start its turn" + (": " + clip(said, 300) if said else "")
                return
            self.started = True
            self.mine.add(turn["id"])
            if turn["id"] not in self.ended:
                self.turn = turn["id"]
            for ident, words in self.early:
                self.tell(ident, words)
            self.early = []
        elif why[0] == "steer":
            ident, words = why[1], why[2]
            if result is not None:
                self.heard.mark(ident, "queued")
            elif "no active turn" in said and not (self.stopping or self.closed):
                # Its turn ended as you spoke: a turn of its own, in the same thread.
                if not self.request("turn/start", {"threadId": self.thread, "input": as_input(words), "clientUserMessageId": ident}, ("start", ident)):
                    self.heard.late(ident)
            else:
                self.heard.late(ident)
        elif why[0] == "start":
            turn = result.get("turn") if result else None
            if isinstance(turn, dict) and isinstance(turn.get("id"), str):
                self.mine.add(turn["id"])
                if turn["id"] not in self.ended:
                    self.turn = turn["id"]
                self.heard.mark(why[1], "queued")
            else:
                self.heard.late(why[1])

    def asks(self, ident, method):
        # What it asks of its client. Approvals only where its policy asks for them (never): the VM is the boundary, as
        # for codex exec --dangerously-bypass-approvals-and-sandbox. A question for you has no one to answer it while it
        # runs: it goes on without one. Anything else is refused.
        replies = {
            "item/commandExecution/requestApproval": {"decision": "accept"},
            "item/fileChange/requestApproval": {"decision": "accept"},
            "execCommandApproval": {"decision": "approved"},
            "applyPatchApproval": {"decision": "approved"},
            "item/tool/requestUserInput": {"answers": {}},
            "mcpServer/elicitation/request": {"action": "decline", "content": None, "_meta": None},
        }
        if method in replies:
            self.write({"id": ident, "result": replies[method]})
        else:
            self.write({"id": ident, "error": {"code": -32601, "message": "not answered by Invincible: " + method[:80]}})

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

/** What a tool is given for the store under a project: its arguments, and any file of the primary's own they name. */
type Notes = (project: string) => { argv: string[]; files?: Record<string, string> };

/** Claude Code: `--mcp-config <file>`, a file the primary writes beside its bridge, holding the one stdio server. */
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

/** The words a tool has for how it is signed in (core's SIGN_IN_METHODS). Nothing else a VM says of a sign-in is passed on. */
const SIGN_IN_WORDS: readonly string[] = SIGN_IN_METHODS;

/**
 * What a bridge's `--status` printed. A VM's output is data: one flag and one known word are read from it, and for a seat
 * three things more, each only in its own shape (a tier's one word, a fingerprint, a time): anything else is dropped.
 */
function readStatus(stdout: string): { signedIn: boolean; method?: string; plan?: string; fingerprint?: string; renewBy?: number } {
  for (const line of stdout.trim().split("\n").reverse()) {
    let told: any;
    try { told = JSON.parse(line); } catch { continue; }
    if (!told || typeof told !== "object" || told.type !== "status") continue;
    if (told.signedIn !== true) break;
    return {
      signedIn: true,
      ...(SIGN_IN_WORDS.includes(told.method) ? { method: told.method as string } : {}),
      ...(SeatPlan.safeParse(told.plan).success && !tokenShaped(told.plan) ? { plan: told.plan as string } : {}),
      ...(SeatFingerprint.safeParse(told.fingerprint).success ? { fingerprint: told.fingerprint as string } : {}),
      ...(Number.isSafeInteger(told.renewBy) && told.renewBy > 0 ? { renewBy: told.renewBy as number } : {}),
    };
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

const driver = (name: string, title: string, kind: AgentDriver["kind"], script: string, part: string, notes: Notes, signIn: Omit<NonNullable<AgentDriver["signIn"]>, "read" | "seatCheck">, family: readonly string[]): AgentDriver => ({
  name,
  title,
  kind,
  family,
  // Each is told your words as it works on its own input (its bridge's), resumes its own session, and says its windows:
  // Claude Code's rate_limit_event on a claude.ai sign-in, Codex's account/rateLimits/updated.
  capabilities: { steer: "live", streams: true, resumes: true, readsWindows: true },
  // (Passed whole: readiness is asked before any run has written the bridge into the sandbox.)
  check: `python3 -I -c ${quote(`${SHARED}${part}${MAIN}`)} --status`,
  signIn: { ...signIn, read: readStatus, seatCheck: (salt) => `python3 -I -c ${quote(`${SHARED}${part}${MAIN}`)} --status --salt ${quote(salt)}` },
  files: (_models, engram) => {
    if (!engram) return { [script]: `${SHARED}${part}${MAIN}` };
    const given = notes(engram);
    return { [script]: `${SHARED}${part}${withNotes(given.argv)}${MAIN}`, ...given.files };
  },
  command: (model: AgentModel, session, cutOff) => `python3 -I ${script} ${model.own ? "--own" : `--provider ${quote(model.provider)} --model ${quote(model.model)}`}${session ? ` --session ${quote(session)}${cutOff ? " --cut-off" : ""}` : ""}`,
  read,
});

// (What its own sign-in runs on is Anthropic's: a review of it is kept apart from every claude-* model.)
export const CLAUDE = driver("claude", "Claude Code", "anthropic", "/work/.agent/claude-code.py", CLAUDE_PART, claudeNotes, { login: "claude auth login", roster: "an Anthropic-API model" }, ["claude"]);
/** (Codex speaks only the Responses API: a roster model on an endpoint without it fails, and the next takes over.) */
// (What its own sign-in runs on is OpenAI's: GPT and its reasoning models, Codex's own.)
export const CODEX = driver("codex", "Codex", "openai", "/work/.agent/codex.py", CODEX_PART, codexNotes, { login: "codex login --device-auth", roster: "an OpenAI-compatible model that speaks the Responses API" }, ["gpt", "codex", "chatgpt", "o1", "o3", "o4"]);
