import type { AgentDriver } from "./harnesses.ts";
import { ACP_CLIENT, ACP_ENTRY, notesServer, readSignedIn, withNotes } from "./acp.ts";

/*
 * Google's Antigravity CLI (agy) on its owner's Google sign-in (a Google AI Pro or Ultra plan), driven as T3 Code drives
 * it (pingdotgg/t3code: provider/antigravityAuthSupport.ts, buildAntigravityAcpSpawnInput and antigravityEnvironment;
 * Drivers/AntigravityDriver.ts; AntigravityAuth.ts): `agy acp`, the Agent Client Protocol on stdio, in a profile of its
 * own (--gemini-dir, its data beneath it in antigravity-acp), told it is a remote session so its sign-in is the one in
 * that profile and never the OS keyring's, its updates off, and signed in with `agy acp --login` (seat-sign-in.ts). The
 * owner chose this on 27 November 2026, accepting the risk Google's Antigravity terms (clause 6) put on their account.
 *
 * Its bridge is the primary's ACP client (acp.ts), Python's standard library alone, run INSIDE the VM: it says its name
 * truthfully (invincible), authenticates with the profile's sign-in (oauth-personal) before anything else, as T3 Code
 * does, and runs nothing on an agy older than 1.5.1, the first that serves every ACP client. What agy asks permission
 * for is given once, as for every ACP agent: the VM is the boundary. agy keeps its sign-in in its OS keyring, and with
 * none (a VM has none) in a file of its own in the profile. Nothing of Invincible's reads it: on a seat, each start copies
 * the seat's sealed sign-in into that file, whole and never opened for what it says (sealed_in), and in an agent's own VM
 * the file is kept as the rest of the profile goes.
 */
const BRIDGE = String.raw`
import shutil, stat

FIRST_FOR_EVERY_CLIENT = (1, 5, 1)

def version_of(text):
    parts = str(text or "").split("-")[0].split(".")
    try:
        return tuple(int(p) for p in parts[:3]) if len(parts) >= 3 else None
    except ValueError:
        return None

# agy's sign-in: the one file agy 1.5.18 keeps it in with no keyring, as in every VM (its profile's antigravity-acp
# folder; strace on Ultra). This is the one line of the run's code that names it, and nothing here opens it for what it
# says: on a seat, each start copies the seat's sealed sign-in in under this name, whole (sealed_in); in an agent's own
# VM, where you sign agy in yourself, it is kept as the rest of the profile goes.
TOKEN = "antigravity-oauth-token"

# What agy keeps of its own from one start to the next: on a seat, nothing, its sign-in included (a run's command can put
# another Google account's there, and each start's is the seat's sealed one); in an agent's own VM, its sign-in alone.
# The rest of its profile is configuration (hooks, MCP servers, plugins, skills, rules, agents, settings), its built-in
# skills and its state, which agy makes anew as it starts; a run may have left any of it there, to run commands or steer
# it. So are its sessions: it loads a session's brain/<session>/ as a customization root (the re-check of 28 November
# 2026, R1), and a session's conversations/<session>.db keeps the MCP servers that session was made with, which agy starts
# again at its next prompt once it is loaded (its round 4, agy 1.5.18 on Ultra). So each start is from the node's own,
# which is none of it, each run's session is a new one, and no link stays anywhere in it (the review of 28 November 2026,
# M2).
KEPT = {TOKEN: "file"}

def gone(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink()
        return
    for inner in list(path.iterdir()):
        gone(inner)
    path.rmdir()

def unlinked(folder):
    for inner in list(folder.iterdir()):
        if inner.is_symlink():
            inner.unlink()
        elif inner.is_dir():
            unlinked(inner)

def reset(gemini, kept):
    for path in list(gemini.iterdir()):
        if path.name != "antigravity-acp" or path.is_symlink() or not path.is_dir():
            gone(path)
            continue
        for inner in list(path.iterdir()):
            keep = kept.get(inner.name)
            if inner.is_symlink() or keep is None or (keep == "dir") != inner.is_dir():
                gone(inner)
            elif keep == "dir":
                unlinked(inner)

# The seat's sign-in, as its last sign-in that took sealed it (seat-sign-in.ts), copied whole into agy's emptied profile at
# each start, where agy reads it and keeps its refreshed token: its bytes are never parsed, printed, logged, hashed or
# sent. Only a sign-in writes the sealed one (a run's VM and a status check's mount it read-only), so what a run does to
# this copy ends with it, and the next start's is the sealed one again. None sealed, or anything there but a file (never
# followed, nor waited on): none is copied, and agy says it isn't signed in.
def sealed_in(sealed, data):
    try:
        source = os.open(os.path.join(sealed, "sign-in"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return
    if not stat.S_ISREG(os.fstat(source).st_mode):
        os.close(source)
        return
    with os.fdopen(source, "rb") as blob:
        data.mkdir(exist_ok=True, mode=0o700)
        with os.fdopen(os.open(str(data / TOKEN), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as copy:
            shutil.copyfileobj(blob, copy)

class Bridge(Client):
    agent = "Antigravity"
    permit = True
    missing = "Antigravity's CLI (agy) isn't in this VM: it comes with the tools' image, at its pin"

    def run(self):
        args = self.args
        gemini = Path(args.gemini_dir or os.environ.get("INVINCIBLE_AGY_DIR") or os.path.join(os.path.expanduser("~"), ".antigravity"))
        # (A seat's VM names the seat's sealed sign-in beside its home: packages/sandbox, seatEnv. An agent's own VM, none.)
        sealed = os.environ.get("INVINCIBLE_AGY_SEALED", "")
        # A profile left as a link, or as anything but a folder (a run's command can replace it in the seat's volume), is
        # taken away, never followed, as a sign-in takes one away: else the reset would empty what it points at (the next
        # run's /work) and leave the link (the re-check of 28 November 2026, R2).
        if gemini.is_symlink() or (gemini.exists() and not gemini.is_dir()):
            gemini.unlink()
        gemini.mkdir(parents=True, exist_ok=True, mode=0o700)
        reset(gemini, {} if sealed else KEPT)
        if sealed:
            sealed_in(sealed, gemini / "antigravity-acp")
        temp = gemini / "tmp"
        temp.mkdir(exist_ok=True, mode=0o700)
        # Deliberate allowlist, as T3 Code's antigravityEnvironment: no key of yours (GEMINI_API_KEY, GOOGLE_API_KEY), no
        # display (a browser it would open), no proxy; its updates off; a remote session, so the profile's sign-in is used.
        env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TERM", "HOME", "USER") if k in os.environ}
        env.update({"AGY_CLI_DISABLE_AUTO_UPDATE": "true", "SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 0", "TMPDIR": str(temp)})
        argv = ["agy", "acp", "--gemini-dir", str(gemini), "--app-data-dir", "antigravity-acp", "--disable-telemetry"]
        initialized = self.start(argv, env, 120)
        info = initialized.get("agentInfo") or {}
        version = version_of(info.get("version"))
        if version is None or version < FIRST_FOR_EVERY_CLIENT:
            raise RuntimeError("Antigravity " + str(info.get("version") or "of an unknown version")[:40] + " is older than 1.5.1, the first that serves every ACP client")
        if not any(isinstance(m, dict) and m.get("id") == "oauth-personal" for m in initialized.get("authMethods") or []):
            raise RuntimeError("This Antigravity offers no Google sign-in (oauth-personal)")
        try:
            self.request("authenticate", {"methodId": "oauth-personal"}, 120)
        except RuntimeError:
            if args.check:
                print(json.dumps({"type": "status", "signedIn": False}), flush=True)
                return
            raise RuntimeError("Antigravity isn't signed in on this seat: sign the seat in again (its card), then retry")
        if args.check:
            print(json.dumps({"type": "status", "signedIn": True, "version": str(info.get("version"))[:40]}), flush=True)
            return
        # Each run's session is a new one, and none is loaded or said to go on with: nothing of an earlier run's session
        # reaches this one (a kept session brings its MCP servers back: the re-check's round 4). Work taken up again
        # starts agy afresh, from the task's own instructions and what Invincible kept of its steps.
        params = {"cwd": os.getcwd(), "mcpServers": []}
        state = self.request("session/new", params, 120)
        self.session = state.get("sessionId") if isinstance(state, dict) else None
        if not isinstance(self.session, str) or not self.session:
            raise RuntimeError("Antigravity did not create a session")
        # A model named for the work, where its account lists it; else the one its account runs by default.
        listed = (state.get("models") or {}) if isinstance(state, dict) else {}
        offered = [m.get("modelId") for m in listed.get("availableModels") or [] if isinstance(m, dict)]
        if args.model and args.model in offered and listed.get("currentModelId") != args.model:
            self.request("session/set_model", {"sessionId": self.session, "modelId": args.model})
        self.prompt()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gemini-dir", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--session")
    parser.add_argument("--prompt", default="/work/.agent/prompt.md")
    parser.add_argument("--max-tools", type=int, default=0)
    parser.add_argument("--max-seconds", type=int, default=0)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.max_tools < 0 or args.max_seconds < 0:
        parser.error("no budget is negative")
    return serve(Bridge(args))
`;

export const ANTIGRAVITY_ACP_BRIDGE = `${ACP_CLIENT}${BRIDGE}${ACP_ENTRY}`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const STATUS = `python3 -I -c ${quote(ANTIGRAVITY_ACP_BRIDGE)} --check`;

/** What its status check said (the bridge's --check): signed in to its Google account or not. */
function readStatus(stdout: string): { signedIn: boolean; method?: "signed in" } {
  for (const line of stdout.split("\n")) {
    try {
      const said = JSON.parse(line) as { type?: unknown; signedIn?: unknown };
      if (said?.type === "status") return said.signedIn === true ? { signedIn: true, method: "signed in" } : { signedIn: false };
    } catch {
      /* not its line */
    }
  }
  return { signedIn: false };
}

export const ANTIGRAVITY: AgentDriver = {
  name: "antigravity",
  title: "Antigravity",
  // Gemini's API: no model of the gateway's speaks it, so it runs on its Google sign-in alone, never on a roster model.
  kind: "gemini",
  // (No session of its goes on from one run to the next, so a steer ends its run between its calls, and the next run, a
  // new session, is told the task's briefing with it, as a revision or a run cut off is: run.ts. Your agent steers it as
  // it works, not once its run ends: the third re-check's I3, the owner's "direct/steer".)
  capabilities: { steer: "anew", streams: true, resumes: false, readsWindows: false },
  // Whether it starts here and is signed in, asked of agy itself: its initialize, and its authenticate with the sign-in
  // its profile holds, never a model call or the token. (Passed whole: it is asked before any run has written the bridge.)
  check: STATUS,
  signIn: {
    read: readStatus,
    // (In the profile its bridge runs agy in, outside a seat: a seat signs in with its card, seat-sign-in.ts.)
    login: "agy acp --gemini-dir ~/.antigravity --app-data-dir antigravity-acp --login",
    // (No account's fingerprint: agy says none without its token read, so the seat keeps none.)
    seatCheck: () => STATUS,
  },
  family: ["gemini"],
  // Nothing is written for it: each start runs its bridge whole, as its status check does (STATUS), so no file in /work,
  // which a run, or a process a run left in its agent's own VM, could rewrite before the next start, is ever what runs
  // there (the fourth re-check of 28 November 2026, L1 and I6).
  files: (_models, engram, home) => {
    // (A notes project that isn't one is refused here, as every driver refuses it, before anything is made of it.)
    if (engram !== undefined) notesServer(engram, home);
    return {};
  },
  // With the VM's notes store (engram.ts), its session is opened with the store's one stdio server, as every ACP agent's
  // is (acp.ts's withNotes): agy starts it for itself, and none of agy's own files is written. If agy refuses a session
  // with it, the session is opened again without it, and the run says it has no notes store. (No session is named to it:
  // each run's is new.)
  command: (model, _session, _cutOff, notes) =>
    `python3 -I -c ${quote(notes ? `${ACP_CLIENT}${BRIDGE}${withNotes([notesServer(notes.engram, notes.home)])}${ACP_ENTRY}` : ANTIGRAVITY_ACP_BRIDGE)} --prompt /work/.agent/prompt.md${model.own || !model.model ? "" : ` --model ${quote(model.model)}`}`,
  // Its Google sign-in is in this VM, and a model can make agy print it: its events are scrubbed of it as Claude Code's
  // and Codex's are (the review of 28 November 2026, M1), and core's redaction knows Google's own tokens. And no session
  // is read from them: its bridge says none, since each run's is new, so a line that names one is a run's own, and would
  // have the next run told the reviewer's words without its briefing (the third re-check's I1).
  read: (line) => readSignedIn(line).filter((event) => event.type !== "session"),
};
