import type { AgentDriver } from "./harnesses.ts";
import { ACP_CLIENT, ACP_ENTRY, notesServer, readBridge, withNotes } from "./acp.ts";

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
 * none (a VM has none) in a file of its own in the profile: nothing of Invincible's names, reads, copies or moves it.
 */
const BRIDGE = String.raw`
FIRST_FOR_EVERY_CLIENT = (1, 5, 1)

def version_of(text):
    parts = str(text or "").split("-")[0].split(".")
    try:
        return tuple(int(p) for p in parts[:3]) if len(parts) >= 3 else None
    except ValueError:
        return None

class Bridge(Client):
    agent = "Antigravity"
    permit = True
    missing = "Antigravity's CLI (agy) isn't in this VM: it comes with the tools' image, at its pin"

    def run(self):
        args = self.args
        gemini = Path(args.gemini_dir or os.environ.get("INVINCIBLE_AGY_DIR") or os.path.join(os.path.expanduser("~"), ".antigravity"))
        gemini.mkdir(parents=True, exist_ok=True, mode=0o700)
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
        resumable = bool((initialized.get("agentCapabilities") or {}).get("loadSession"))
        params = {"cwd": os.getcwd(), "mcpServers": []}
        if self.session and resumable:
            state = self.request("session/load", dict(params, sessionId=self.session), 120)
            if not isinstance(state, dict):
                raise RuntimeError("The saved Antigravity session could not be loaded; it was not replaced")
        else:
            state = self.request("session/new", params, 120)
            self.session = state.get("sessionId") if isinstance(state, dict) else None
            if not isinstance(self.session, str) or not self.session:
                raise RuntimeError("Antigravity did not create a session")
        if resumable:
            emit("session", id=self.session)
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
  // (Its session loads again, so a steer ends its run between calls and is said there.)
  capabilities: { steer: "restart", streams: true, resumes: true, readsWindows: false },
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
  // With the VM's notes store (engram.ts), its session is opened with the store's one stdio server, as every ACP agent's
  // is (acp.ts's withNotes): agy starts it for itself, and none of agy's own files is written. If agy refuses a session
  // with it, the session is opened again without it, and the run says it has no notes store.
  files: (_models, engram, home) => ({ "/work/.agent/antigravity-acp.py": engram ? `${ACP_CLIENT}${BRIDGE}${withNotes([notesServer(engram, home)])}${ACP_ENTRY}` : ANTIGRAVITY_ACP_BRIDGE }),
  command: (model, session) =>
    `python3 -I /work/.agent/antigravity-acp.py --prompt /work/.agent/prompt.md${model.own || !model.model ? "" : ` --model ${quote(model.model)}`}${session ? ` --session ${quote(session)}` : ""}`,
  read: readBridge,
};
