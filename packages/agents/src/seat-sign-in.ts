/*
 * A seat's sign-in, made by the vendor's own tool in the seat's VM (I15 step 4; core's seats.ts), on the owner's word and
 * page: Invincible never signs in for anyone, and never holds what a sign-in makes. Like the run bridges this is Python's
 * standard library, run there as `python3 -I -c <bridge>`, its standard input and output the node's, a JSON line each.
 *
 * It reads: first its start ({"email": …} for Claude Code, which starts on that account; {} otherwise), then at most
 * once {"code": …} (Claude Code: what its page showed you) or {"cancel": true}. An end of input cancels it too.
 * It prints:
 *   {"type":"card","url":…[,"code":…]}       what the tool asks of you: its page, and the code to enter there (Codex)
 *   {"type":"asks"}                           Claude Code waits for the code its page showed you
 *   {"type":"done","ok":true|false,"why":…}   how it ended: the tool said it was signed in, or why not
 *
 * Nothing it prints is a sign-in: a page's address, Codex's one-time code to type there, and what ended it. Claude Code's
 * code goes to the tool's own terminal and nowhere else (D7). The sign-in itself the tool keeps in the seat's home,
 * where nothing of Invincible's reads it; whether it holds is asked afterwards of the tool's own status command.
 */

const COMMON = String.raw`import json, os, re, select, signal, sys, time
WAIT = 600
def emit(kind, **fields):
    sys.stdout.write(json.dumps(dict(type=kind, **fields)) + "\n")
    sys.stdout.flush()
class Lines:
    # Whole lines from a file descriptor, read as they come (select tells when there is more), never a partial one.
    def __init__(self, fd):
        self.fd, self.held, self.ended = fd, b"", False
    def read(self):
        try:
            chunk = os.read(self.fd, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            self.ended = True
        self.held += chunk
        out = []
        while b"\n" in self.held:
            line, self.held = self.held.split(b"\n", 1)
            if len(line) <= 65536:
                out.append(line.decode("utf-8", "replace"))
        if len(self.held) > 65536:
            self.held = b""
        return out
def said(line):
    try:
        value = json.loads(line)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
`;

/** Claude Code: `claude auth login --claudeai [--email <its email>]` under a terminal of its own (it needs one). */
export const CLAUDE_SIGN_IN = String.raw`${COMMON}import fcntl, pty, struct, termios
# Its terminal's own escapes (colours, cursor moves, titles): taken out before anything is read from what it shows.
ESCAPES = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]")
URL = re.compile(r"https://[^\s\x1b\"'<>]+")
def main():
    start = said(sys.stdin.readline())
    email = start.get("email") if isinstance(start.get("email"), str) and re.fullmatch(r"[^\s@]{1,64}@[^\s@]{1,190}", start.get("email", "")) else None
    argv = ["claude", "auth", "login", "--claudeai"] + (["--email", email] if email else [])
    pid, fd = pty.fork()
    if pid == 0:
        # (Wide, so its address is one line whatever its length.)
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))
        except OSError:
            pass
        os.environ["COLUMNS"] = "4000"
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)
    seen, carded, asked, answered, ok, why = "", False, False, False, False, ""
    stdin = Lines(sys.stdin.fileno())
    until = time.monotonic() + WAIT
    try:
        while True:
            if time.monotonic() > until:
                why = "expired"
                break
            ready, _, _ = select.select([fd] + ([] if stdin.ended else [sys.stdin.fileno()]), [], [], 1.0)
            if fd in ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    why = why or "it ended without saying it was signed in"
                    break
                seen = (seen + ESCAPES.sub("", chunk.decode("utf-8", "replace")).replace("\r", ""))[-65536:]
                if not carded:
                    found = URL.search(seen)
                    # (Whole once something follows it.)
                    if found and found.end() < len(seen):
                        emit("card", url=found.group(0))
                        carded = True
                if carded and not asked and "Paste code here" in seen:
                    emit("asks")
                    asked = True
                if "Login successful" in seen:
                    ok = True
                    break
            if sys.stdin.fileno() in ready:
                for line in stdin.read():
                    told = said(line)
                    if told.get("cancel"):
                        why = "cancelled"
                    code = told.get("code")
                    # Once, as it was given: to its terminal alone. It says it took it, or why not, so the node marks it
                    # answered only once its tool has it (the review of 28 November 2026, L1).
                    if isinstance(code, str):
                        if answered:
                            emit("refused", why="answered")
                        elif not re.fullmatch(r"[!-~]{1,512}", code):
                            emit("refused", why="shape")
                        else:
                            os.write(fd, (code + "\r").encode())
                            answered = True
                            emit("took")
                if why == "cancelled" or stdin.ended:
                    why = why or "cancelled"
                    break
    finally:
        # Signed in, it ends of itself (a moment for it to save what it made); otherwise it is ended.
        if ok:
            end = time.monotonic() + 15
            while time.monotonic() < end and os.waitpid(pid, os.WNOHANG) == (0, 0):
                ready, _, _ = select.select([fd], [], [], 0.5)
                if fd in ready:
                    try:
                        os.read(fd, 65536)
                    except OSError:
                        break
        try:
            if os.waitpid(pid, os.WNOHANG) == (0, 0):
                os.kill(pid, signal.SIGTERM)
                time.sleep(1)
                if os.waitpid(pid, os.WNOHANG) == (0, 0):
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    emit("done", ok=ok, **({} if ok else {"why": why[:200]}))
main()
`;

/** Codex: its own app server, on stdio, signing in by ChatGPT's device code (account/login/start, chatgptDeviceCode). */
export const CODEX_SIGN_IN = String.raw`${COMMON}import subprocess
def main():
    sys.stdin.readline()
    child = subprocess.Popen(["codex", "app-server", "-c", 'cli_auth_credentials_store="file"'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    def send(message):
        try:
            child.stdin.write((json.dumps(message) + "\n").encode())
            child.stdin.flush()
        except OSError:
            pass
    send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "invincible", "title": "Invincible", "version": "1"}, "capabilities": None}})
    send({"method": "initialized"})
    send({"id": 2, "method": "account/login/start", "params": {"type": "chatgptDeviceCode"}})
    out, stdin = Lines(child.stdout.fileno()), Lines(sys.stdin.fileno())
    login, ok, why, ended = None, False, "", False
    until = time.monotonic() + WAIT
    try:
        while not ended:
            if time.monotonic() > until:
                why, ended = "expired", True
                break
            ready, _, _ = select.select([child.stdout.fileno()] + ([] if stdin.ended else [sys.stdin.fileno()]), [], [], 1.0)
            if child.stdout.fileno() in ready:
                for line in out.read():
                    message = said(line)
                    if message.get("id") == 2:
                        result = message.get("result") if isinstance(message.get("result"), dict) else {}
                        url, code = result.get("verificationUrl"), result.get("userCode")
                        if result.get("type") == "chatgptDeviceCode" and isinstance(url, str) and isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9-]{4,32}", code):
                            login = result.get("loginId") if isinstance(result.get("loginId"), str) else None
                            emit("card", url=url, code=code)
                        else:
                            error = message.get("error") if isinstance(message.get("error"), dict) else {}
                            why, ended = str(error.get("message") or "it could not start a sign-in"), True
                    elif message.get("method") == "account/login/completed":
                        params = message.get("params") if isinstance(message.get("params"), dict) else {}
                        if params.get("loginId") in (None, login):
                            ok, ended = params.get("success") is True, True
                            why = "" if ok else str(params.get("error") or "it was not signed in")
                if out.ended and not ended:
                    why, ended = "it ended without saying it was signed in", True
            if sys.stdin.fileno() in ready and not ended:
                for line in stdin.read():
                    if said(line).get("cancel"):
                        why, ended = "cancelled", True
                if stdin.ended and not ended:
                    why, ended = "cancelled", True
                if why == "cancelled" and login:
                    send({"id": 3, "method": "account/login/cancel", "params": {"loginId": login}})
                    # Its server takes the cancel before it is ended (it stops asking OpenAI), for three seconds at most.
                    told = time.monotonic() + 3
                    while time.monotonic() < told and not out.ended:
                        ready, _, _ = select.select([child.stdout.fileno()], [], [], 0.2)
                        if child.stdout.fileno() in ready and any(said(line).get("id") == 3 for line in out.read()):
                            break
    finally:
        child.kill()
        child.wait()
    emit("done", ok=ok, **({} if ok else {"why": why[:200]}))
main()
`;

/**
 * Antigravity (Google's agy): its own ACP sign-in, `agy acp --login`, in the seat's profile, as T3 Code signs it in
 * (pingdotgg/t3code, Drivers/AntigravityDriver.ts codeLogin; antigravityAuthSupport.ts): a remote session with no display,
 * so it prints Google's page, and reads from its input the code that page shows (Google's own callback page,
 * antigravity.google/oauth-callback, shows it). The code goes to agy alone, once; what it makes, agy keeps in the profile.
 */
export const ANTIGRAVITY_SIGN_IN = String.raw`${COMMON}import shutil, subprocess
ESCAPES = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
PAGE = re.compile(r"https://accounts\.google\.com/[^\s\x1b\"'<>]+")
CODE = re.compile(r"[\w./~-]{1,2048}")
def main():
    sys.stdin.readline()
    gemini = os.environ.get("INVINCIBLE_AGY_DIR", "")
    if not gemini:
        emit("done", ok=False, why="this VM names no Antigravity profile")
        return
    # As T3 Code's antigravityEnvironment: no key of yours, no display or browser, its updates off, a remote session.
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TERM", "HOME", "USER") if k in os.environ}
    env.update({"AGY_CLI_DISABLE_AUTO_UPDATE": "true", "SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 0"})
    # A fresh sign-in starts from an empty profile: whatever a run left in the last one goes with it (the review of 28
    # November 2026, M2). Each run's start resets it again, keeping its sign-in alone (antigravity.ts). It is made in a
    # profile of its own beside the seat's, which stays as it was, signed in, until agy says the new one took; then the
    # new one takes its place (the re-check of 28 November 2026, R10). Anything at either name, a link a run left among
    # it, is taken away, never followed.
    def clear(path):
        if os.path.islink(path) or (os.path.lexists(path) and not os.path.isdir(path)):
            os.unlink(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)
    fresh, before = gemini + ".signing-in", gemini + ".before"
    for path in (fresh, before):
        clear(path)
    os.makedirs(fresh, mode=0o700)
    argv = ["agy", "acp", "--gemini-dir", fresh, "--app-data-dir", "antigravity-acp", "--disable-telemetry", "--login"]
    try:
        child = subprocess.Popen(argv, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except OSError:
        emit("done", ok=False, why="agy isn't in this VM")
        return
    out, stdin = Lines(child.stdout.fileno()), Lines(sys.stdin.fileno())
    seen, carded, asked, answered, why = "", False, False, False, ""
    until = time.monotonic() + WAIT
    try:
        while True:
            if time.monotonic() > until:
                why = "expired"
                break
            ready, _, _ = select.select([child.stdout.fileno()] + ([] if stdin.ended else [sys.stdin.fileno()]), [], [], 1.0)
            if child.stdout.fileno() in ready:
                try:
                    chunk = os.read(child.stdout.fileno(), 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                seen = (seen + ESCAPES.sub("", chunk.decode("utf-8", "replace")).replace("\r", ""))[-65536:]
                if not carded:
                    found = PAGE.search(seen)
                    # (Whole once something follows it.)
                    if found and found.end() < len(seen):
                        emit("card", url=found.group(0))
                        carded = True
                if carded and not asked and "authorization code" in seen.lower():
                    emit("asks")
                    asked = True
            if sys.stdin.fileno() in ready:
                for line in stdin.read():
                    told = said(line)
                    if told.get("cancel"):
                        why = "cancelled"
                    code = told.get("code")
                    # Once, as it was given: to agy alone. It says it took it, or why not, so the node marks it answered
                    # only once agy has it (the review of 28 November 2026, L1).
                    if isinstance(code, str):
                        if answered:
                            emit("refused", why="answered")
                        elif not carded or not CODE.fullmatch(code):
                            emit("refused", why="shape" if carded else "early")
                        else:
                            try:
                                child.stdin.write((code + "\n").encode())
                                child.stdin.flush()
                                answered = True
                                emit("took")
                            except OSError:
                                emit("refused", why="ended")
                if why == "cancelled" or stdin.ended:
                    why = why or "cancelled"
                    break
    finally:
        if child.poll() is None and why:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        code = child.wait()
    ok = not why and code == 0
    if ok:
        if os.path.lexists(gemini):
            os.rename(gemini, before)
        os.rename(fresh, gemini)
        clear(before)
    else:
        clear(fresh)
    emit("done", ok=ok, **({} if ok else {"why": (why or "it ended without saying it was signed in")[:200]}))
main()
`;

/** The sign-in bridge of a seat's tool, by the seat's kind (none: it isn't signed in by a tool of its own in a VM). */
export function seatSignInBridge(kind: string): string | null {
  return kind === "claude-subscription" ? CLAUDE_SIGN_IN : kind === "chatgpt-codex" ? CODEX_SIGN_IN : kind === "google-antigravity" ? ANTIGRAVITY_SIGN_IN : null;
}
