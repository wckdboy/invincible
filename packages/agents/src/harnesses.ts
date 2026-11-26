import { planOf } from "@invincible/models";
import { type ExecResult, randomId, redact } from "@invincible/core";
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
 * (OpenCode) does the engineer's part instead of the run's one-command-at-a-time
 * loop. It runs headless in the background inside the sandbox, so it isn't bound by
 * one command's time limit; its model calls go through Invincible's gateway on a token
 * scoped to that sandbox (it never sees a key); the primary follows its event stream, so
 * every command and edit is visible as it happens; and the independent reviewer
 * still judges the result. Pure orchestration over `exec`, like the run itself.
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
  /** A tool call that ended (`id`: the call's, where its stream names it, ending its `call`). */
  | { type: "tool"; tool: string; input: string; output: string; ok: boolean; id?: string }
  /** A tool call that began, by its id, where its stream says so: a steer waits for it to end (runAgent). */
  | { type: "call"; id: string }
  | { type: "tokens"; input: number; output: number }
  | { type: "error"; message: string }
  /** The tool asking a provider again by itself after a refusal: which try this is, why, and how long it waits first. */
  | { type: "retry"; attempt: number; error: string; waitMs: number }
  /**
   * Words the node told a run as it went (runAgent: a live steer), by its id: queued by the tool, taken into its work, or
   * late (it had stopped taking any: they are said in its next run).
   */
  | { type: "steer"; id: string; state: "queued" | "taken" | "late" }
  /** One of its plan's windows, as its tool said it: allowed, warning or rejected; how much is used (%); when it resets (ms). */
  | { type: "window"; name: string; status: "allowed" | "warning" | "rejected"; usedPercent?: number; resetsAt?: number };

/**
 * What a driver's tool can do as it runs, declared and never faked (T3 Code: "Declare only what the provider actually
 * supports"). `steer`: your words reach it as it works (`live`), end its run between its tool calls to be said in its own
 * session (`restart`), or wait for its run to end (`none`). `streams`: it says what it does as it does it. `resumes`: a run
 * of it continues its session. `readsWindows`: it says its plan's windows as it runs (used, and when they reset).
 */
export interface DriverCapabilities {
  steer: "live" | "restart" | "none";
  streams: boolean;
  resumes: boolean;
  readsWindows: boolean;
}

export interface AgentDriver {
  name: string;
  /** What a person calls it. */
  title: string;
  /** The API a gateway model must speak for it: a provider's kind. */
  kind: "openai" | "anthropic";
  /** What it can do as it runs. A `live` one reads its run's input channel (runAgent: AGENT_DIR/input). */
  capabilities: DriverCapabilities;
  /** A command that exits 0 in a sandbox where it is installed and can start. */
  check: string;
  /**
   * A vendor's own tool, which its owner signs in itself, in the sandbox, through the vendor's own flow
   * (vendor-cli.ts). `check` then also prints whether it has a sign-in, and `read` reads that: signed in or
   * not, and the tool's word for how. The sign-in itself is never the primary's to see. `login`: the tool's own
   * command to sign in; `roster`: what kind of model it runs on through the gateway instead.
   */
  signIn?: {
    /** What its `--status` said: signed in or not and how, and for a seat (seatCheck) its tier, its account's fingerprint and when it ends. */
    read(stdout: string): { signedIn: boolean; method?: string; plan?: string; fingerprint?: string; renewBy?: number };
    login: string;
    roster: string;
    /** Its status for a seat: the check with the salt its account's fingerprint is made with (core's seats.ts). */
    seatCheck(salt: string): string;
  };
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
  /**
   * The command for one run on one model, reading its message from AGENT_DIR/prompt.md (a session id continues one).
   * `cutOff`: its last run in that session was cut off before it ended (its process stopped without an exit code).
   */
  command(model: AgentModel, session: string | null, cutOff?: boolean): string;
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
  // (Its run reads no input once started, so a steer ends it between calls and is said with --session.)
  capabilities: { steer: "restart", streams: true, resumes: true, readsWindows: false },
  check: "opencode --version",
  files: (models, engram) => {
    // One provider per gateway provider, all on the sandbox's one token: each model the
    // roster offers is a fallback the next run can continue the session on.
    const providers: Record<string, unknown> = {};
    for (const m of models) {
      const id = ocProvider(m);
      const entry = (providers[id] ??= {
        name: `Invincible gateway (${m.provider})`,
        env: ["OPENAI_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `{env:INVINCIBLE_GATEWAY}/${m.provider}`, apiKey: "{env:OPENAI_API_KEY}" },
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
    `opencode run --standalone --auto --format json --title invincible --model ${quote(`${ocProvider(model)}/${model.model}`)}${session ? ` --session ${quote(session)}` : ""} "$(cat ${AGENT_DIR}/prompt.md)"`,
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

/** An agent's harness driver: one of AGENTS, or (harness `acp`) one for the ACP agent its command starts. */
export function driverFor(harness: string, acp?: string | null): AgentDriver | undefined {
  if (harness === "acp") return acp ? acpDriver(acp) : undefined;
  return AGENTS[harness];
}

export interface AgentRunDeps {
  exec(command: string, timeoutSec: number): Promise<ExecResult>;
  /**
   * The run followed as it goes, where its host can keep a command open (FOLLOW, from byte `offset` of its events): its
   * events reach the node as they are written. Each follow ends by itself after FOLLOW_SECONDS and is opened again where
   * it stopped. Without one, or when none can be opened, the run is looked at every `pollMs`, as before.
   */
  follow?(offset: number): Promise<FollowedRun>;
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
  /**
   * `spent`: its budget was spent, and it was stopped as at its deadline. `audited`: its audit ended this run
   * (`input.audit`). `steered`: a steer of yours, or your agent's, ended it between its tool calls (`input.steer`).
   */
  status: "finished" | "failed" | "timeout" | "stopped" | "spent" | "audited" | "steered";
  /** The agent's last words: its own account of what it did. */
  summary: string;
  /** Tool calls it made. */
  steps: number;
  session: string | null;
  tokens: { input: number; output: number };
  /** Why it failed (its exit, its last error, its stderr). */
  error?: string;
  /** Words told to it as it ran that it never took (late, or that couldn't be told): its next run says them. */
  untold?: string[];
  /** It ended without an exit code: its process was stopped from outside (killed, its VM restarted), cut off mid-run. */
  cutOff?: boolean;
}

/** A run being followed: FOLLOW's lines as they come, and an end to them. */
export interface FollowedRun {
  lines: AsyncIterable<string>;
  close(): void;
}

/** How long one follow of a run lasts before it is opened again where it stopped: one command in its VM, ledgered once. */
export const FOLLOW_SECONDS = 600;
/** How often a followed run is looked at for what's cheap to ask (stopped? steered? out of time?). Its events don't wait. */
export const FOLLOW_TICK_MS = 250;
/** How long a live run that is stopped has to end its turn by its own interrupt before it is ended anyway. */
export const STOP_GRACE_SECONDS = 3;

/**
 * How long a run may go unread, every look at it failing, before it is ended: the primary has lost sight of it. On 22
 * November 2026 an agent deleted its lease, every command in its VM failed from then on, and a look that failed was
 * taken as no news, so its task waited on a run that had ended, with an audit paid for every quarter of an hour.
 */
export const UNREAD_LIMIT_MS = 5 * 60_000;

/**
 * How long a steer waits for a tool call a coding agent is in (its `call` with no end yet) before its run is ended all
 * the same: a call whose end its stream never names must not hold your words back for ever. A tool's own command in its
 * VM is killed at TEAM_COMMAND_SECONDS (15 minutes), so a call that runs longer has lost its way.
 */
export const STEER_WAIT_MS = 15 * 60_000;

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
 * Follows a run from byte argv[1] of its events for argv[2] seconds: each line as it is written (`E<end> <line>`, `end`
 * the byte its line ends at, so a follow opened again never says one twice), and how it stands (`S{alive, exit, next}`)
 * after each batch and at least every second. It ends with the run (having said what it wrote as it ended), or at its
 * time. A line is cut at 20,000 bytes, as POLL's are: a bridge's never are, and a tool's own that is cut isn't JSON.
 */
export const FOLLOW = `${AGENT_PROCESS_PY}
off, until = int(sys.argv[1]), time.monotonic() + float(sys.argv[2])
out = sys.stdout

def state():
    alive, code = False, None
    try:
        item = marker()
        alive = bool(item and matches(item, identity(item["pid"])))
    except Exception:
        pass
    try:
        code = int((D / "exit").read_text())
    except Exception:
        pass
    return alive, code

def read():
    global off
    try:
        with open(D / "events.jsonl", "rb") as f:
            f.seek(off)
            data = f.read(2000000)
    except FileNotFoundError:
        return 0
    end = data.rfind(b"\\n")
    if end < 0:
        return 0
    at = off
    for raw in data[:end].split(b"\\n"):
        at += len(raw) + 1
        out.write("E%d %s\\n" % (at, raw[:20000].decode("utf-8", "replace")))
    off += end + 1
    return end + 1

said = -1.0
while True:
    got = read()
    now = time.monotonic()
    if got or now - said >= 1.0:
        alive, code = state()
        if not alive:
            read()
        out.write("S" + json.dumps({"alive": alive, "exit": code, "next": off}) + "\\n")
        out.flush()
        said = now
        if not alive:
            break
    if now >= until:
        break
    if not got:
        time.sleep(0.02)`;

/** The command that follows a run from byte `offset` (FOLLOW), for a host's stream. */
export const followArgv = (offset: number, seconds = FOLLOW_SECONDS): string[] => ["python3", "-c", FOLLOW, String(Math.max(0, Math.trunc(offset))), String(seconds)];

/**
 * Tells a live run one line on its input channel (base64, argv[1]); exits 3 when no run is reading it. With a run and
 * seconds (argv[2], argv[3]), it then waits up to that long for that run to end (a stop: its own interrupt first).
 */
const TELL = `import base64
${AGENT_PROCESS_PY}
line = base64.b64decode(sys.argv[1]) + b"\\n"
try:
    fd = os.open(str(D / "input"), os.O_WRONLY | os.O_NONBLOCK)
except OSError:
    sys.exit(3)
try:
    until = time.monotonic() + 5
    while line:
        try:
            line = line[os.write(fd, line):]
        except BlockingIOError:
            if time.monotonic() > until:
                sys.exit(4)
            time.sleep(0.01)
finally:
    os.close(fd)
if len(sys.argv) > 3:
    run, until = sys.argv[2], time.monotonic() + float(sys.argv[3])
    while time.monotonic() < until:
        item = marker()
        if not item or item["run"] != run or not matches(item, identity(item["pid"])) or (D / "exit").exists():
            break
        time.sleep(0.05)`;

const tellCommand = (line: object, wait?: { run: string; seconds: number }): string =>
  `python3 -c ${quote(TELL)} ${quote(Buffer.from(JSON.stringify(line), "utf8").toString("base64"))}${wait ? ` ${quote(wait.run)} ${wait.seconds}` : ""}`;

/**
 * One run of a coding agent: write its message, start it in the background (its own process group, so it outlives the
 * command that started it and can be stopped as a whole), follow its events until it ends, the deadline passes, its
 * budget is spent (`spent`, asked at each look), a steer ends it (`steer`, asked at a look between its tool calls) or you
 * stop it. Followed (deps.follow), its events reach the node as they are written, and a `live` driver is told your words
 * as it works: `steers`, asked every FOLLOW_TICK_MS, gives what to tell it now (the caller has said them on its trail),
 * and what it never takes comes back as `untold`. Looked at instead (no follow), it is as it always was.
 */
export async function runAgent(
  driver: AgentDriver,
  input: { model: AgentModel; prompt: string; session: string | null; deadline: number; workdir: string; pollMs?: number; spent?: () => boolean | Promise<boolean>; audit?: () => Promise<boolean>; steer?: () => boolean | Promise<boolean>; steers?: () => Promise<string | null>; cutOff?: boolean },
  deps: AgentRunDeps,
): Promise<AgentRun> {
  const now = deps.now ?? Date.now;
  const run: AgentRun = { status: "finished", summary: "", steps: 0, session: input.session, tokens: { input: 0, output: 0 } };
  /** The tool calls it began and hasn't ended, as its stream says (`call`, ended by the `tool` with its id), and since when. */
  const open = new Map<string, number>();
  const runId = randomId(12);
  /** It reads an input channel of its own (AGENT_DIR/input) as it works: your words, and its stop. */
  const live = driver.capabilities.steer === "live";
  /** Your words told it as it ran, by the id each went with, and how far each got. */
  const told = new Map<string, { words: string; state: "sent" | "queued" | "taken" | "late" }>();
  let launched = false;
  /** It has been followed, so its channel can be told: a live one's stop is its own interrupt first. */
  let followed = false;
  let stopping: Promise<void> | undefined;
  const cleanup = () => deps.stopAgent
    ? deps.stopAgent()
    : deps.exec(agentCleanupCommand(runId), 30).then((result) => {
      if (result.exitCode !== 0) throw new Error("Could not safely stop the worker process");
    });
  const stop = () => stopping ??= (live && followed ? deps.exec(tellCommand({ stop: true }, { run: runId, seconds: STOP_GRACE_SECONDS }), STOP_GRACE_SECONDS + 15).then(() => undefined, () => undefined) : Promise.resolve()).then(cleanup);
  /** A run as it ends, with whatever of yours it never took. */
  const ended = (result: AgentRun): AgentRun => {
    const left = [...told.values()].filter((t) => t.state !== "taken").map((t) => t.words);
    return left.length ? { ...result, untold: left } : result;
  };
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
        // (A live one's input is a FIFO, opened read and write so that it never reads an end while its writers come and go.)
        `mkdir -p ${AGENT_DIR} && rm -f ${AGENT_DIR}/exit ${AGENT_DIR}/pid${live ? ` ${AGENT_DIR}/input && mkfifo -m 600 ${AGENT_DIR}/input` : ""}`,
        `printf %s ${quote(prompt)} | base64 -d > ${AGENT_DIR}/prompt.md`,
        `cd ${quote(input.workdir)}`,
        // Backgrounded inside braces: `… & && …` isn't shell.
        `{ setsid bash -c ${quote(`${agentProcessCommand("record", runId)} && ${driver.command(input.model, input.session, input.cutOff)} ${live ? `<> ${AGENT_DIR}/input` : "< /dev/null"} >> ${AGENT_DIR}/events.jsonl 2>> ${AGENT_DIR}/stderr.log; echo $? > ${AGENT_DIR}/exit`)} > /dev/null 2>&1 & echo $! > ${AGENT_DIR}/pid; }`,
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
    /** One line of its events: each event it says, kept, paired and passed on. */
    const take = async (line: string): Promise<void> => {
      for (const event of driver.read(line)) {
        if (event.type === "session") {
          const changed = run.session !== event.id;
          run.session = event.id;
          if (changed) await deps.session?.(event.id);
          continue;
        }
        // (Bounded: a stream that names more calls than any run makes is a stream that can't be believed about them.)
        if (event.type === "call") {
          if (open.size < 512 && !open.has(event.id)) open.set(event.id, now());
          continue;
        }
        if (event.type === "steer") {
          // (Only words told it, and only forward: taken and late are where they stay.)
          const said = told.get(event.id);
          if (!said || said.state === "taken" || said.state === "late") continue;
          said.state = event.state;
        }
        if (event.type === "tool" && event.id !== undefined) open.delete(event.id);
        if (event.type === "text") run.summary = event.text;
        if (event.type === "tool") run.steps += 1;
        if (event.type === "tokens") {
          run.tokens.input += event.input;
          run.tokens.output += event.output;
        }
        if (event.type === "error") lastError = event.message;
        deps.event?.(event);
      }
    };
    /** Its end, as the last look said it: its marker cleared, and failed if it failed. */
    const finished = async (exit: number | null): Promise<AgentRun> => {
      const cleared = await deps.exec(agentProcessCommand("finish", runId), 30);
      if (cleared.exitCode !== 0) throw new Error("Could not clear the completed worker's process marker");
      if (exit !== 0 || (!run.summary && lastError)) {
        const stderr = (await deps.exec(`tail -c 2000 ${AGENT_DIR}/stderr.log 2>/dev/null`, 30).catch(() => null))?.stdout ?? "";
        return ended({ ...run, status: "failed", error: redact([lastError, exit === null ? "it stopped without an exit code" : `it exited with ${exit}`, stderr.trim()].filter(Boolean).join("\n")).slice(0, 3000), ...(exit === null ? { cutOff: true } : {}) });
      }
      return ended(run);
    };
    /** Your words, told it now on its channel: late if no run of it was there to read them. */
    const tell = async (words: string): Promise<void> => {
      const id = randomId(12);
      told.set(id, { words, state: "sent" });
      const sent = await deps.exec(tellCommand({ say: words, id }), 15).catch(() => null);
      if (!sent || sent.exitCode !== 0) told.get(id)!.state = "late";
    };
    /** A steer ends a run that can't be told it as it works, between its tool calls (one it is in finishes first, for up to STEER_WAIT_MS). */
    const between = () => [...open.values()].every((since) => now() - since >= STEER_WAIT_MS);

    /**
     * Followed: its events as they are written; what's cheap to ask every FOLLOW_TICK_MS; its budget and its audit every
     * pollMs, as when it was looked at. Null: it can't be followed (never could, or no longer), and is looked at instead.
     */
    const follow = async (): Promise<AgentRun | null> => {
      let stream: FollowedRun | null = null;
      let lines: AsyncIterator<string> | null = null;
      let next: Promise<IteratorResult<string>> | null = null;
      let state = { alive: true, exit: null as number | null };
      /** Follows that couldn't be opened again in a row. */
      let lost = 0;
      let ticked = Number.NEGATIVE_INFINITY;
      let looked = now();
      const end = () => {
        try {
          stream?.close();
        } catch {
          // (Already ended.)
        }
        stream = lines = next = null;
      };
      try {
        for (;;) {
          if (!stream) {
            try {
              stream = await deps.follow!(offset);
              lines = stream.lines[Symbol.asyncIterator]();
              next = lines.next();
              followed = true;
              lost = 0;
            } catch {
              // Never followed, or lost three times running: looked at instead, from where it stands.
              if (!followed || ++lost >= 3) return null;
              await deps.sleep(1_000);
            }
          }
          if (next) {
            const got = await Promise.race([next, deps.sleep(FOLLOW_TICK_MS).then(() => null)]);
            if (got?.done) {
              // Its follow ended: at its time (opened again where it stopped), or with the run.
              end();
              if (!state.alive) return await finished(state.exit);
            } else if (got) {
              next = lines!.next();
              const line = got.value;
              if (line.startsWith("E")) {
                const space = line.indexOf(" ");
                const at = space > 1 ? Number(line.slice(1, space)) : NaN;
                // (Each line once: a follow opened again says nothing before where the last one stopped.)
                if (Number.isSafeInteger(at) && at > offset) {
                  offset = at;
                  await take(line.slice(space + 1));
                }
              } else if (line.startsWith("S")) {
                let said: { alive?: unknown; exit?: unknown; next?: unknown } = {};
                try {
                  said = JSON.parse(line.slice(1));
                } catch {
                  // (Not its own: passed over.)
                }
                state = { alive: said.alive !== false, exit: Number.isSafeInteger(said.exit) ? (said.exit as number) : null };
                if (Number.isSafeInteger(said.next) && (said.next as number) > offset) offset = said.next as number;
                if (!state.alive) {
                  end();
                  return await finished(state.exit);
                }
              }
            }
          }
          if (now() - ticked < FOLLOW_TICK_MS) continue;
          ticked = now();
          if (deps.signal?.aborted) {
            await stop();
            return { ...run, status: "stopped" };
          }
          // Your words: told it as it works, where it can be; otherwise they end this run between its tool calls.
          if (live && input.steers) {
            const words = await input.steers();
            if (words) await tell(words);
          } else if (between() && (await input.steer?.())) {
            await stop();
            return { ...run, status: "steered", error: "it was steered" };
          }
          if (now() > input.deadline) {
            await stop();
            return ended({ ...run, status: "timeout", error: "it ran out of time" });
          }
          if (now() - looked < (input.pollMs ?? 10_000)) continue;
          looked = now();
          if (await input.spent?.()) {
            await stop();
            return ended({ ...run, status: "spent", error: "its budget was spent" });
          }
          // An audit, when one is due, may end this run (RunOptions.audit): the caller says what comes of it.
          if (await input.audit?.()) {
            await stop();
            return ended({ ...run, status: "audited", error: "its audit ended this run" });
          }
        }
      } finally {
        end();
      }
    };
    if (deps.follow) {
      const result = await follow();
      if (result) return result;
    }

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
        // A look that couldn't be read is no news, for a while; a run unread for long is one the primary can't see.
        unreadSince ??= now();
        unreadWhy = redact((looked ? looked.stderr || looked.stdout || `exit ${looked.exitCode}` : String((error as Error)?.message ?? error)).trim().split("\n").filter(Boolean).at(-1) ?? "").slice(0, 300);
        if (now() - unreadSince > UNREAD_LIMIT_MS) {
          await stop();
          return ended({ ...run, status: "failed", error: `Invincible couldn't read how its run was going for ${Math.round(UNREAD_LIMIT_MS / 60_000)} minutes, so it was stopped: ${unreadWhy || "no reason given"}` });
        }
        poll = { alive: true, exit: null, next: offset, lines: [] };
      }
      offset = poll.next;
      for (const line of poll.lines) await take(line);
      if (deps.signal?.aborted) {
        await stop();
        return { ...run, status: "stopped" };
      }
      if (!poll.alive) return await finished(poll.exit);
      if (await input.spent?.()) {
        await stop();
        return ended({ ...run, status: "spent", error: "its budget was spent" });
      }
      // A steer ends this run only between its tool calls, so its own session can be told: the caller says what comes of it.
      if (between() && (await input.steer?.())) {
        await stop();
        return ended({ ...run, status: "steered", error: "it was steered" });
      }
      // An audit, when one is due, may end this run (RunOptions.audit): the caller says what comes of it.
      if (await input.audit?.()) {
        await stop();
        return ended({ ...run, status: "audited", error: "its audit ended this run" });
      }
      if (now() > input.deadline) {
        await stop();
        return ended({ ...run, status: "timeout", error: "it ran out of time" });
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
    // (A plan for interactive use only never does an agent's or a run's unattended work.)
    if (planOf(provider)?.allows.tools === "interactive") continue;
    if (known?.hasKey && known.kind === kind && out.length < max) out.push({ provider, model });
  }
  return out;
}
