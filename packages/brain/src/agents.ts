import { planOf } from "./providers.ts";
import { type ExecResult, randomId, redact } from "@galahad/core";
import { agentCleanupCommand, agentProcessCommand, AGENT_PROCESS_PY } from "./agent-process.ts";
import { ENGRAM_ENV, engramArgv } from "./engram.ts";
import { acpDriver } from "./acp.ts";
import { HERMES } from "./hermes.ts";
import { CLAUDE, CODEX } from "./vendor-cli.ts";
export { ACP_BRIDGE, ACP_PROBE, acpDriver } from "./acp.ts";
export { HERMES } from "./hermes.ts";
export { CLAUDE, CODEX } from "./vendor-cli.ts";
export { agentCleanupCommand } from "./agent-process.ts";

/*
 * Coding agents in the sandbox: for long work on real codebases, a full harness
 * (OpenCode) does the engineer's part instead of the quest's one-command-at-a-time
 * loop. It runs headless in the background inside the sandbox, so it isn't bound by
 * one command's time limit; its model calls go through Galahad's gateway on a token
 * scoped to that sandbox (it never sees a key); Galahad follows its event stream, so
 * every command and edit is visible as it happens; and the independent reviewer
 * still judges the result. Pure orchestration over `exec`, like the quest itself.
 * (A vendor's own tool that its owner signed in there calls its vendor itself
 * instead, and the gateway is kept out of its way: vendor-cli.ts.)
 */

/** The model the agent uses, through the gateway. */
export interface AgentModel {
  /** The gateway provider, e.g. "orcarouter". */
  provider: string;
  model: string;
  /**
   * Not a gateway model at all: the tool's own sign-in in this sandbox (vendor-cli.ts). The tool calls its
   * vendor itself, on the model its account gives it, and is not pointed at the gateway.
   */
  own?: boolean;
}

/** A run on the tool's own sign-in. */
export const OWN_SIGN_IN: AgentModel = { provider: "", model: "", own: true };

/** What a run is on, as a person reads it. */
export const agentModelName = (model: AgentModel): string => (model.own ? "its own sign-in" : `${model.provider}/${model.model}`);

export type AgentEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; input: string; output: string; ok: boolean }
  | { type: "tokens"; input: number; output: number }
  | { type: "error"; message: string }
  /** The tool asking a provider again by itself after a refusal: which try this is, why, and how long it waits first. */
  | { type: "retry"; attempt: number; error: string; waitMs: number };

export interface AgentDriver {
  name: string;
  /** What a person calls it. */
  title: string;
  /** The API a gateway model must speak for it: a provider's kind. */
  kind: "openai" | "anthropic";
  /** A command that exits 0 in a sandbox where it is installed and can start. */
  check: string;
  /**
   * A vendor's own tool, which its owner signs in himself, in the sandbox, through the vendor's own flow
   * (vendor-cli.ts). `check` then also prints whether it has a sign-in, and `read` reads that: signed in or
   * not, and the tool's word for how. The sign-in itself is never Galahad's to see. `login`: the tool's own
   * command to sign in; `roster`: what kind of model it runs on through the gateway instead.
   */
  signIn?: { read(stdout: string): { signedIn: boolean; method?: string }; login: string; roster: string };
  /**
   * It runs as you set it up in the sandbox (an ACP agent you named: acp.ts), its own sign-in or configuration, with the
   * role's model offered through the gateway for it to use: with none to offer, it runs on its setup alone.
   */
  ownSetup?: boolean;
  /**
   * Files written before the first run (absolute path → content): every model it may fall back to. `engram`:
   * the project of the VM's notes store (engram.ts) when the run is given it; the tool then starts the store's
   * server for itself, in its own way. Without one, a driver writes exactly what it did before there was a store.
   */
  files(models: readonly AgentModel[], engram?: string): Record<string, string>;
  /** The command for one run on one model, reading its message from AGENT_DIR/prompt.md (a session id continues one). */
  command(model: AgentModel, session: string | null): string;
  /** One line of the event stream, or null if it's nothing to report. */
  read(line: string): AgentEvent[];
}

export const AGENT_DIR = "/work/.agent";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const brief = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * OpenCode (v2, headless): `opencode run --standalone --auto --format json`, stdin closed
 * (with stdin open it waits for more input and never starts). Its state and config live
 * under the sandbox's HOME (/work). Every tool is allowed: the sandbox is the boundary,
 * and its network decides what's reachable.
 */
/** OpenCode's name for a gateway provider: g-<provider>. */
const ocProvider = (model: AgentModel) => `g-${model.provider.replace(/[^A-Za-z0-9-]/g, "-")}`;

export const OPENCODE: AgentDriver = {
  name: "opencode",
  title: "OpenCode",
  kind: "openai",
  check: "opencode --version",
  files: (models, engram) => {
    // One provider per gateway provider, all on the sandbox's one token: each model the
    // roster offers is a fallback the next run can continue the session on.
    const providers: Record<string, unknown> = {};
    for (const m of models) {
      const id = ocProvider(m);
      const entry = (providers[id] ??= {
        name: `Galahad gateway (${m.provider})`,
        env: ["OPENAI_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `{env:GALAHAD_GATEWAY}/${m.provider}`, apiKey: "{env:OPENAI_API_KEY}" },
        models: {},
      }) as { models: Record<string, { name: string }> };
      entry.models[m.model] = { name: m.model };
    }
    return {
      "/work/.config/opencode/opencode.json": JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          update: "disable",
          model: `${ocProvider(models[0]!)}/${models[0]!.model}`,
          providers,
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          // The notes store, as OpenCode's own `mcp add` writes a local server: OpenCode starts it, for the run.
          ...(engram ? { mcp: { servers: { engram: { type: "local", command: engramArgv(engram), environment: ENGRAM_ENV } } } } : {}),
        },
        null,
        2,
      ),
    };
  },
  command: (model, session) =>
    `opencode run --standalone --auto --format json --title galahad --model ${quote(`${ocProvider(model)}/${model.model}`)}${session ? ` --session ${quote(session)}` : ""} "$(cat ${AGENT_DIR}/prompt.md)"`,
  read(line) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== "object") return [];
    const out: AgentEvent[] = [];
    if (typeof event.sessionID === "string") out.push({ type: "session", id: event.sessionID });
    const part = event.part ?? {};
    if (event.type === "text" && typeof part.text === "string" && part.text.trim()) out.push({ type: "text", text: part.text });
    if (event.type === "tool_use" && part.state && part.state.status !== "running" && part.state.status !== "pending") {
      const input = part.state.input ?? {};
      out.push({
        type: "tool",
        tool: String(part.tool ?? "tool"),
        input: brief(typeof input.command === "string" ? input.command : input, 2000),
        output: brief(part.state.output ?? part.state.error ?? "", 4000),
        ok: part.state.status === "completed" && (part.state.metadata?.metadata?.exit ?? 0) === 0,
      });
    }
    if (event.type === "step_finish" && part.tokens) out.push({ type: "tokens", input: Number(part.tokens.input) || 0, output: Number(part.tokens.output) || 0 });
    // What a failure or a retry says: its message, which 2.3.0 puts inside its error.
    const said = typeof event.message === "string" ? event.message : typeof event.error?.message === "string" ? event.error.message : (event.error ?? event);
    // Failures come as their own event types: "error", "provider.content-filter", …
    if (/error|filter|fail|denied|refus/i.test(String(event.type))) out.push({ type: "error", message: brief(said, 1000) });
    // Its own retry of a refusal, with when it asks again: on the trail, so a run that waits isn't taken for one that hangs.
    if (event.type === "retry") out.push({ type: "retry", attempt: Number(event.attempt) || 1, error: brief(said, 300), waitMs: Math.max(0, (Number(event.nextRetryAt) || 0) - (Number(event.timestamp) || 0)) });
    return out;
  },
};

export const AGENTS: Record<string, AgentDriver> = { opencode: OPENCODE, hermes: HERMES, claude: CLAUDE, codex: CODEX };

/** A knight's harness driver: one of AGENTS, or (harness `acp`) one for the ACP agent its command starts. */
export function driverFor(harness: string, acp?: string | null): AgentDriver | undefined {
  if (harness === "acp") return acp ? acpDriver(acp) : undefined;
  return AGENTS[harness];
}

export interface AgentRunDeps {
  exec(command: string, timeoutSec: number): Promise<ExecResult>;
  /** Trusted, workspace-bound cleanup that remains available after the request aborts. */
  stopAgent?(): Promise<void>;
  /** Persist a newly observed harness session before following more events. */
  session?(id: string): Promise<void>;
  /** Each event as it arrives. */
  event?(event: AgentEvent): void;
  signal?: AbortSignal;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

export interface AgentRun {
  /** `spent`: its budget was spent, and it was stopped as at its deadline. `audited`: its audit ended this run (`input.audit`). */
  status: "finished" | "failed" | "timeout" | "stopped" | "spent" | "audited";
  /** The agent's last words: its own account of what it did. */
  summary: string;
  /** Tool calls it made. */
  steps: number;
  session: string | null;
  tokens: { input: number; output: number };
  /** Why it failed (its exit, its last error, its stderr). */
  error?: string;
}

/**
 * How long a run may go unread, every look at it failing, before it is ended: Galahad has lost sight of it. On 22
 * November 2026 a knight deleted its lease, every command in its VM failed from then on, and a look that failed was
 * taken as no news, so its task waited on a run that had ended, with an audit paid for every quarter of an hour.
 */
export const UNREAD_LIMIT_MS = 5 * 60_000;

/** Prints {alive, exit, next, lines} for the events written since byte `offset`. */
const POLL = `${AGENT_PROCESS_PY}
d, off = ${JSON.stringify(AGENT_DIR)}, int(sys.argv[1])
alive = False
try:
    item = marker()
    alive = bool(item and matches(item, identity(item["pid"])))
except Exception:
    pass
exit_code = None
try:
    exit_code = int(open(d + "/exit").read())
except Exception:
    pass
lines, nxt = [], off
try:
    with open(d + "/events.jsonl", "rb") as f:
        f.seek(off)
        data = f.read(2000000)
    end = data.rfind(b"\\n")
    if end >= 0:
        lines = [raw[:20000].decode("utf-8", "replace") for raw in data[:end].split(b"\\n")]
        nxt = off + end + 1
except FileNotFoundError:
    pass
print(json.dumps({"alive": alive, "exit": exit_code, "next": nxt, "lines": lines}))`;

/**
 * One run of a coding agent: write its message, start it in the background (its own
 * process group, so it outlives the command that started it and can be stopped as a
 * whole), follow its events until it ends, the deadline passes, its budget is spent
 * (`spent`, asked at each look) or you stop it.
 */
export async function runAgent(
  driver: AgentDriver,
  input: { model: AgentModel; prompt: string; session: string | null; deadline: number; workdir: string; pollMs?: number; spent?: () => boolean | Promise<boolean>; audit?: () => Promise<boolean> },
  deps: AgentRunDeps,
): Promise<AgentRun> {
  const now = deps.now ?? Date.now;
  const run: AgentRun = { status: "finished", summary: "", steps: 0, session: input.session, tokens: { input: 0, output: 0 } };
  const runId = randomId(12);
  let launched = false;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= deps.stopAgent
    ? deps.stopAgent()
    : deps.exec(agentCleanupCommand(runId), 30).then((result) => {
      if (result.exitCode !== 0) throw new Error("Could not safely stop the worker process");
    });
  try {
    if (deps.signal?.aborted) return { ...run, status: "stopped" };
    // Read the previous end before spawning: a fast agent can write its entire run
    // before the launch command returns. The per-workspace caller serializes runs.
    const offsetCmd = `stat -c %s ${AGENT_DIR}/events.jsonl 2>/dev/null || echo 0`;
    let offset = Number((await deps.exec(offsetCmd, 30)).stdout.trim()) || 0;
    const prompt = Buffer.from(input.prompt, "utf8").toString("base64");
    // A transport can abort after starting the process but before returning its
    // response. From this point cleanup must run even if the launch promise rejects.
    launched = true;
    const started = await deps.exec(
      [
        `mkdir -p ${AGENT_DIR} && rm -f ${AGENT_DIR}/exit ${AGENT_DIR}/pid`,
        `printf %s ${quote(prompt)} | base64 -d > ${AGENT_DIR}/prompt.md`,
        `cd ${quote(input.workdir)}`,
        // Backgrounded inside braces: `… & && …` isn't shell.
        `{ setsid bash -c ${quote(`${agentProcessCommand("record", runId)} && ${driver.command(input.model, input.session)} < /dev/null >> ${AGENT_DIR}/events.jsonl 2>> ${AGENT_DIR}/stderr.log; echo $? > ${AGENT_DIR}/exit`)} > /dev/null 2>&1 & echo $! > ${AGENT_DIR}/pid; }`,
        agentProcessCommand("wait_record", runId),
      ].join(" && "),
      60,
    );
    if (started.exitCode !== 0) {
      await stop();
      // (Its first line is what a trail and the next model are told: a Python traceback's is its last, the exception.)
      const said = (started.stderr || started.stdout).trim();
      const first = /^Traceback \(most recent call last\):/.test(said) ? (said.split("\n").filter(Boolean).at(-1) ?? said) : said;
      return { ...run, status: "failed", error: redact(`couldn't start ${driver.name}: ${first === said ? said : `${first}\n${said}`}`).slice(0, 2000) };
    }

    let lastError = "";
    /** Since when its looks have failed in a row (null: the last one was read), and what the latest said. */
    let unreadSince: number | null = null;
    let unreadWhy = "";
    for (;;) {
      let poll: { alive: boolean; exit: number | null; next: number; lines: string[] };
      let looked: ExecResult | null = null;
      try {
        looked = await deps.exec(`python3 -c ${quote(POLL)} ${offset}`, 60);
        poll = JSON.parse(looked.stdout.trim().split("\n").at(-1) ?? "");
        unreadSince = null;
      } catch (error) {
        // A look that couldn't be read is no news, for a while; a run unread for long is one Galahad can't see.
        unreadSince ??= now();
        unreadWhy = redact((looked ? looked.stderr || looked.stdout || `exit ${looked.exitCode}` : String((error as Error)?.message ?? error)).trim().split("\n").filter(Boolean).at(-1) ?? "").slice(0, 300);
        if (now() - unreadSince > UNREAD_LIMIT_MS) {
          await stop();
          return { ...run, status: "failed", error: `Galahad couldn't read how its run was going for ${Math.round(UNREAD_LIMIT_MS / 60_000)} minutes, so it was stopped: ${unreadWhy || "no reason given"}` };
        }
        poll = { alive: true, exit: null, next: offset, lines: [] };
      }
      offset = poll.next;
      for (const line of poll.lines) {
        for (const event of driver.read(line)) {
          if (event.type === "session") {
            const changed = run.session !== event.id;
            run.session = event.id;
            if (changed) await deps.session?.(event.id);
            continue;
          }
          if (event.type === "text") run.summary = event.text;
          if (event.type === "tool") run.steps += 1;
          if (event.type === "tokens") {
            run.tokens.input += event.input;
            run.tokens.output += event.output;
          }
          if (event.type === "error") lastError = event.message;
          deps.event?.(event);
        }
      }
      if (deps.signal?.aborted) {
        await stop();
        return { ...run, status: "stopped" };
      }
      if (!poll.alive) {
        const cleared = await deps.exec(agentProcessCommand("finish", runId), 30);
        if (cleared.exitCode !== 0) throw new Error("Could not clear the completed worker's process marker");
        if (poll.exit !== 0 || (!run.summary && lastError)) {
          const stderr = (await deps.exec(`tail -c 2000 ${AGENT_DIR}/stderr.log 2>/dev/null`, 30).catch(() => null))?.stdout ?? "";
          return { ...run, status: "failed", error: redact([lastError, poll.exit === null ? "it stopped without an exit code" : `it exited with ${poll.exit}`, stderr.trim()].filter(Boolean).join("\n")).slice(0, 3000) };
        }
        return run;
      }
      if (await input.spent?.()) {
        await stop();
        return { ...run, status: "spent", error: "its budget was spent" };
      }
      // An audit, when one is due, may end this run (QuestOptions.audit): the caller says what comes of it.
      if (await input.audit?.()) {
        await stop();
        return { ...run, status: "audited", error: "its audit ended this run" };
      }
      if (now() > input.deadline) {
        await stop();
        return { ...run, status: "timeout", error: "it ran out of time" };
      }
      await deps.sleep(input.pollMs ?? 10_000);
    }
  } catch (error) {
    // Any exception after launch may leave a background worker behind. Await its
    // trusted cleanup before the caller can release this workspace's writer lock.
    if (launched) await stop();
    if (deps.signal?.aborted) return { ...run, status: "stopped" };
    throw error;
  } finally {
    if (launched && deps.signal?.aborted) await stop();
  }
}

/**
 * The agent's models, in the roster's order: the engineer's models on providers the gateway
 * can reach with a key, speaking the API the agent does (its driver's `kind`; the
 * OpenAI-compatible one unless it says otherwise). The first does the work; the others are
 * fallbacks, as for every role.
 */
export function chooseAgentModels(engineer: readonly string[], providers: readonly { id: string; kind: string; hasKey: boolean }[], max = 3, kind: AgentDriver["kind"] = "openai"): AgentModel[] {
  const out: AgentModel[] = [];
  for (const ref of engineer) {
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    const provider = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    if (!model || model === "*") continue;
    const known = providers.find((p) => p.id === provider);
    // (A plan for interactive use only never does a knight's or a quest's unattended work.)
    if (planOf(provider)?.allows.tools === "interactive") continue;
    if (known?.hasKey && known.kind === kind && out.length < max) out.push({ provider, model });
  }
  return out;
}
