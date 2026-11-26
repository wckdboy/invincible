import type { AgentDriver } from "./agents.ts";
import { ACP_CLIENT, ACP_ENTRY, notesServer, readBridge, withNotes } from "./acp.ts";
export { readBridge } from "./acp.ts";

/*
 * Hermes' supported ACP protocol works on v0.21.1, whose CLI predates stream-json. Its bridge is Galahad's ACP client
 * (acp.ts), Python's standard library alone, run INSIDE the assigned sandbox: no host tools, owner config, provider
 * keys or arm tokens. Its profile and ACP session database survive subsequent runs in that workspace.
 */
const BRIDGE = String.raw`
class Bridge(Client):
    agent = "Hermes"
    missing = "Hermes or a required workspace file is missing; install Hermes with ACP support in this workspace"

    def run(self):
        args = self.args
        home = Path(args.home).resolve()
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Deliberate allowlist: no owner credentials, SSH agent, proxy, PYTHONPATH or
        # ambient plugin settings. This dedicated profile belongs to this VM alone.
        env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TMPDIR", "TERM") if k in os.environ}
        env.update({"HOME": str(home.parent), "HERMES_HOME": str(home), "PYTHONUNBUFFERED": "1"})
        if not args.check:
            env.update(gateway_environment(Path(args.gateway_env), self.agent))
            base = env["GALAHAD_GATEWAY"].rstrip("/") + "/" + args.provider
            config = {"model": {"provider": "custom:galahad", "default": args.model},
                      "providers": {"galahad": {"base_url": base, "key_env": "OPENAI_API_KEY",
                                    "transport": "chat_completions", "default_model": args.model,
                                    "discover_models": False, "models": [args.model]}},
                      "terminal": {"backend": "local", "cwd": os.getcwd()},
                      "memory": {"provider": "builtin"}}
            # JSON is a YAML subset. No secret is written to this configuration.
            target = home / "config.yaml"
            target.write_text(json.dumps(config))
            target.chmod(0o600)
        checked = subprocess.run(["hermes", "acp", "--check"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if checked.returncode:
            raise RuntimeError("Hermes ACP is unavailable; install Hermes with ACP support in this workspace")
        initialized = self.start(["hermes", "acp"], env)
        if not initialized.get("agentCapabilities", {}).get("loadSession"):
            raise RuntimeError("Hermes ACP must support durable session loading")
        if args.check:
            emit("text", text="Hermes ACP is ready (protocol 1, durable session loading)")
            return
        params = {"cwd": os.getcwd(), "mcpServers": []}
        if self.session:
            state = self.request("session/load", dict(params, sessionId=self.session))
            if not isinstance(state, dict):
                raise RuntimeError("The saved Hermes session could not be loaded; it was not replaced")
        else:
            state = self.request("session/new", params)
            self.session = state.get("sessionId") if isinstance(state, dict) else None
            if not isinstance(self.session, str) or not self.session:
                raise RuntimeError("Hermes did not create a session")
        emit("session", id=self.session)
        # Explicit named custom selection resets a restored endpoint too; merely
        # changing config or a model name would keep the previous provider's URL.
        self.request("session/set_model", {"sessionId": self.session, "modelId": "custom:galahad:" + args.model})
        modes = (state.get("modes") or {}).get("availableModes", [])
        if any(m.get("id") == "accept_edits" for m in modes):
            self.request("session/set_mode", {"sessionId": self.session, "modeId": "accept_edits"})
        self.prompt()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--session")
    parser.add_argument("--home", default="/work/.hermes")
    parser.add_argument("--prompt", default="/work/.agent/prompt.md")
    parser.add_argument("--gateway-env", default="/work/.galahad-gateway.json")
    # A knight is audited, never capped (your ruling, 17 and 19 November 2026): no tool budget and no time limit of the
    # bridge's own unless one is asked for. The run's deadline, its audits and you stop it.
    parser.add_argument("--max-tools", type=int, default=0)
    parser.add_argument("--max-seconds", type=int, default=0)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.max_tools < 0 or args.max_seconds < 0 or (not args.check and (not args.provider or not args.model)):
        parser.error("a provider and a model are required, and no budget is negative")
    return serve(Bridge(args))
`;

export const HERMES_ACP_BRIDGE = `${ACP_CLIENT}${BRIDGE}${ACP_ENTRY}`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const HERMES: AgentDriver = {
  name: "hermes",
  title: "Hermes",
  kind: "openai",
  check: "hermes acp --check",
  files: (_models, engram) => ({ "/work/.agent/hermes-acp.py": engram ? `${ACP_CLIENT}${BRIDGE}${withNotes([notesServer(engram)])}${ACP_ENTRY}` : HERMES_ACP_BRIDGE }),
  command: (model, session) => `python3 /work/.agent/hermes-acp.py --provider ${quote(model.provider)} --model ${quote(model.model)}${session ? ` --session ${quote(session)}` : ""}`,
  read: readBridge,
};
