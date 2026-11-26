import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { QAMP_ARM_PREFIX, QAMP_PORTS, QAMP_TOOLS, QampDid, type QampGrantMade, type QampGrantView, type QampTool, qampArm, type Scope } from "@galahad/core";
import type { LedgerEntryInput } from "@galahad/sandbox";
import { ARM_FORBIDDEN_SCOPES, type ArmTokens } from "./arms.ts";
import type { Home } from "./home.ts";
import { type GalahadTool, TOOLS, toolScopes } from "./tools.ts";

/*
 * Grants to agents on your other machines, over Q-AMP (PLAN #58, its first phase; docs/SECURITY.md, "Q-AMP grants").
 *
 * An agent on a machine that runs no node (Claude Code on the MacBook, say) calls a few of Galahad's tools on this
 * node, over one QUIC connection. A grant is one act of yours, and it makes three things:
 *
 *   1. an arm, `qamp.<id>`, holding the scopes its tools' routes need and nothing more. A scope no arm may hold is
 *      refused, never trimmed. Its token is a 0600 file in this node's home, and the bridge's MCP server holds it:
 *      the agent never does. The node's door checks it on every call, as for any arm (loopback only).
 *   2. a delegation chain from this node's bridge key to the agent's key, for `/tool/galahad`, ending when the grant
 *      does. It is useless without the agent's private key. The bridge key is made once, here, and is never the
 *      node's own key, which stays in the daemon.
 *   3. a bridge, `qamp serve --mcp-stdio`, on this node's tailnet address (never 0.0.0.0) and a port of its own. It
 *      lets the agent's key alone connect, and serves the granted tools alone, from `galahad mcp --tools`, which offers
 *      them alone too.
 *
 * When the grant ends (its time is up, or you revoke it) its arm is deleted first, so the agent's very next call is
 * refused at the door, and then its bridge is stopped (SIGTERM: it drains). Each step is a line in the ledger. While
 * the daemon runs it keeps each grant's bridge running and starts it again if it stops; when the daemon stops it stops
 * them, and when it starts it starts those of grants still in force. Grants are node-local, as arm tokens are.
 */

/** Why a grant is refused, as the API says it: a status and a sentence. */
export class QampGrantError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Who asks: as the server's principal is (server.ts). */
export interface GrantPrincipal {
  kind: "admin" | "client" | "node" | "arm";
  scopes: readonly string[];
  label?: string;
}

/**
 * Who may grant, list and revoke: you alone, at a terminal or on a paired device of yours that holds fleet:admin.
 * Never an agent (Galahad's own principal and the knights' are arms), and never another node, which holds every scope
 * and still isn't you: as for your rules and standing orders.
 */
export const mayGrant = (p: GrantPrincipal): boolean => (p.kind === "admin" || p.kind === "client") && p.scopes.includes("fleet:admin");

/**
 * The scopes a grant's arm holds: every route its tools call, each route's one scope. A scope no arm may ever hold is
 * refused, not trimmed; so is a tool only Galahad himself may use. (`table`: the tools, for tests.)
 */
export function grantScopes(tools: readonly string[], table: readonly GalahadTool[] = TOOLS): Scope[] {
  const scopes = new Set<Scope>();
  for (const name of tools) {
    const tool = table.find((t) => t.name === name);
    if (!tool) throw new QampGrantError(400, `there's no tool named ${name}`);
    if (tool.own) throw new QampGrantError(400, `${name} is Galahad's own: no agent is ever given it`);
    for (const scope of toolScopes(tool)) scopes.add(scope as Scope);
  }
  const forbidden = [...scopes].filter((s) => ARM_FORBIDDEN_SCOPES.includes(s));
  if (forbidden.length) throw new QampGrantError(400, `refused: ${tools.join(", ")} would need ${forbidden.join(", ")}, which no agent may ever hold`);
  return [...scopes].sort();
}

/** A bridge as the grants see it: started, reports its address once it listens, ends, and is told to stop. */
export interface QampProcess {
  /** Its first line on stdout, the address it serves (qamp://<did>@<host>:<port>), once it listens; null if it ended first. */
  ready: Promise<string | null>;
  /** How it ended: its exit code, or the signal that ended it. */
  exited: Promise<number | string | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Its process id, kept with its grant: a node that died without stopping it stops it when it starts again. */
  pid?: number;
}

/** How a bridge a dead node left running is found and stopped (tests: a stand-in). */
export interface QampStrays {
  /** A process's whole command line, or null if there's none by that id. */
  command(pid: number): string | null;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

const processes: QampStrays = {
  command(pid) {
    const ps = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    return ps.exitCode === 0 ? ps.stdout.toString().trim() || null : null;
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // Gone already.
    }
  },
};

/** How the grants run Q-AMP's command (tests: a stand-in). */
export interface QampRunner {
  /** One command to its end (keygen, id, delegate): its exit code and what it printed. */
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** A bridge, started with this environment; each line it writes to stderr goes to `line`. */
  serve(args: string[], env: Record<string, string>, line: (text: string) => void): QampProcess;
}

const NOT_INSTALLED = "Q-AMP isn't installed on this node: its pinned binary goes to <home>/bin/qamp (scripts/qamp-pin.sh, deploy.sh --qamp <file>)";

/** The `qamp` binary at `binary()`, checked each time it's used (installing it needs no restart). */
export function qampRunner(binary: () => string | null): QampRunner {
  const bin = (): string => {
    const path = binary();
    if (!path || !existsSync(path)) throw new QampGrantError(424, NOT_INSTALLED);
    return path;
  };
  return {
    async run(args) {
      const proc = Bun.spawn([bin(), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    },
    serve(args, env, line) {
      const proc = Bun.spawn([bin(), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
      const lines = async (stream: ReadableStream<Uint8Array>, each: (text: string) => void) => {
        const decoder = new TextDecoder();
        let held = "";
        for await (const chunk of stream) {
          held += decoder.decode(chunk, { stream: true });
          for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
            each(held.slice(0, at));
            held = held.slice(at + 1);
          }
          // A line with no end yet is kept whole only up to a point.
          if (held.length > 4096) held = held.slice(-4096);
        }
        if (held) each(held);
      };
      let first: (address: string | null) => void = () => {};
      const ready = new Promise<string | null>((resolve) => (first = resolve));
      // Its address is its first line; whatever follows is read and dropped, so the pipe never fills.
      void lines(proc.stdout, (text) => first(text.trim())).finally(() => first(null));
      void lines(proc.stderr, line).catch(() => {});
      return {
        ready,
        exited: proc.exited.then(() => proc.signalCode ?? proc.exitCode),
        kill: (signal) => proc.kill(signal),
        pid: proc.pid,
      };
    },
  };
}

/** Whether a UDP port can be bound on that address now. */
async function udpFree(address: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.udpSocket({ hostname: address, port });
    socket.close();
    return true;
  } catch {
    return false;
  }
}

/** An address and a port as a socket address, and as a URL's: an IPv6 address in brackets. */
const hostPort = (address: string, port: number): string => `${address.includes(":") ? `[${address}]` : address}:${port}`;

/**
 * Never every interface: a bridge listens on this node's tailnet address alone. Read as a URL reads it, so every way of
 * writing "any" (0.0.0.0, 0, ::, ::0, 0:0::0, an IPv4-mapped 0.0.0.0) is one form; what isn't an address at all counts too.
 */
export function unspecified(address: string): boolean {
  const bare = address.replace(/^\[(.*)\]$/, "$1");
  if (!bare) return true;
  try {
    const host = new URL(`http://${bare.includes(":") ? `[${bare}]` : bare}/`).hostname;
    return host === "0.0.0.0" || host === "[::]" || host === "[::ffff:0:0]";
  } catch {
    return true;
  }
}

interface Row {
  id: string;
  agent: string;
  tools: string;
  scopes: string;
  port: number;
  bridge: string;
  created_at: number;
  ends_at: number;
  /** Its bridge's process id when it last started (a dead node's left-over bridge is found by it). */
  pid: number | null;
}

/** A bridge in this process: what it is, and its supervision. */
interface Live {
  proc: QampProcess | null;
  state: "starting" | "up" | "down";
  why: string | null;
  /** Told to stop on purpose: its end is no failure, and it isn't started again. */
  stopping: boolean;
  /** Its stderr's last lines, to say why it stopped. */
  tail: string[];
  retry: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  upSince: number | null;
}

export interface QampGrantsOptions {
  db: Database;
  arms: ArmTokens;
  home: Home;
  /** The address bridges listen on and agents dial: this node's tailnet address (what it advertises). */
  address: () => string;
  /** This node's loopback port: where each bridge's `galahad mcp` reaches it. */
  port: number;
  runner: QampRunner;
  /** The MCP server a bridge serves: `galahad mcp --arm <label> --tools a,b --home <home>`, as a command. */
  mcpCommand: (label: string, tools: readonly string[]) => string[];
  ledger: (entry: LedgerEntryInput) => void;
  log: (message: string) => void;
  now?: () => number;
  /** Bridges' UDP ports (tests: others, on loopback). */
  ports?: { first: number; last: number };
  /** Whether a UDP port is free on the address (tests: a stand-in). */
  portFree?: (address: string, port: number) => Promise<boolean>;
  /** How long a bridge may take to listen (its MCP server's start included), and to drain when told to stop. */
  startMs?: number;
  stopGraceMs?: number;
  /** How a bridge left running by a node that died is found and stopped (tests: a stand-in). */
  strays?: QampStrays;
}

/** The longest a bridge that keeps stopping waits before it is started again. */
const MAX_BACKOFF_MS = 60_000;

export class QampGrants {
  private readonly now: () => number;
  private readonly ports: { first: number; last: number };
  private readonly portFree: (address: string, port: number) => Promise<boolean>;
  private readonly live = new Map<string, Live>();
  /** One change at a time: a grant, an end, the start of the daemon's bridges (rows, ports and arms agree throughout). */
  private queue: Promise<unknown> = Promise.resolve();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private bridgeDid: string | null = null;

  constructor(private readonly opts: QampGrantsOptions) {
    this.now = opts.now ?? Date.now;
    this.ports = opts.ports ?? QAMP_PORTS;
    this.portFree = opts.portFree ?? udpFree;
    opts.db.exec(`CREATE TABLE IF NOT EXISTS qamp_grants (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, tools TEXT NOT NULL, scopes TEXT NOT NULL, port INTEGER NOT NULL UNIQUE,
      bridge TEXT NOT NULL, created_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, pid INTEGER)`);
  }

  private get keyPath(): string {
    return join(this.opts.home.dir, "qamp", "bridge.qamp-key");
  }

  private rows(): Row[] {
    return this.opts.db.query<Row, []>("SELECT * FROM qamp_grants ORDER BY created_at, id").all();
  }

  private row(id: string): Row | null {
    return this.opts.db.query<Row, [string]>("SELECT * FROM qamp_grants WHERE id = ?").get(id);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Whether an arm is a grant's (its label is reserved for grants). */
  static isGrantArm(label: string): boolean {
    return label.startsWith(QAMP_ARM_PREFIX);
  }

  /** The grant an arm belongs to, by the arm's label. */
  grantOfArm(label: string): string | null {
    if (!QampGrants.isGrantArm(label)) return null;
    const id = label.slice(QAMP_ARM_PREFIX.length);
    return this.row(id) ? id : null;
  }

  list(): QampGrantView[] {
    return this.rows().map((row) => this.view(row));
  }

  private view(row: Row): QampGrantView {
    const live = this.live.get(row.id);
    return {
      id: row.id,
      label: qampArm(row.id),
      agent: row.agent,
      tools: JSON.parse(row.tools) as QampTool[],
      scopes: JSON.parse(row.scopes) as Scope[],
      createdAt: row.created_at,
      endsAt: row.ends_at,
      url: `qamp://${row.bridge}@${hostPort(this.opts.address(), row.port)}`,
      bridge: live ? { state: live.state, why: live.why } : { state: "down", why: "not started" },
    };
  }

  private line(entry: Omit<LedgerEntryInput, "resource" | "verdict">): void {
    this.opts.ledger({ resource: "qamp", verdict: "allow", ...entry });
  }

  /** This node's bridge key: made once (`qamp keygen`, 0600), its DID read back each start. Never the node's own key. */
  private async bridgeKey(): Promise<string> {
    if (this.bridgeDid) return this.bridgeDid;
    const path = this.keyPath;
    let did: string;
    if (existsSync(path)) {
      const id = await this.opts.runner.run(["id", "--key", path]);
      if (id.code !== 0) throw new QampGrantError(500, `the bridge key at ${path} can't be read: ${id.stderr.trim().slice(0, 300)}`);
      did = id.stdout.trim();
    } else {
      mkdirSync(join(this.opts.home.dir, "qamp"), { recursive: true, mode: 0o700 });
      const made = await this.opts.runner.run(["keygen", "--out", path]);
      if (made.code !== 0) throw new QampGrantError(500, `the bridge key wasn't made: ${made.stderr.trim().slice(0, 300)}`);
      did = made.stdout.trim();
      chmodSync(path, 0o600);
      this.line({ class: "create", target: "bridge key", reason: "the key this node's bridges serve under and its grants' chains start from: its own, never the node's", detail: did });
    }
    if (!QampDid.safeParse(did).success) throw new QampGrantError(500, `qamp named the bridge key with something that isn't a did:key: ${did.slice(0, 80)}`);
    this.bridgeDid = did;
    return did;
  }

  /** A port of the range nobody holds: no grant of this node's, nothing else on the address. */
  private async freePort(address: string): Promise<number> {
    const taken = new Set(this.rows().map((r) => r.port));
    for (let port = this.ports.first; port <= this.ports.last; port++) {
      if (!taken.has(port) && (await this.portFree(address, port))) return port;
    }
    throw new QampGrantError(409, `every Q-AMP port of this node is in use (${this.ports.first}–${this.ports.last}, one a grant): revoke a grant first (galahad qamp grants)`);
  }

  /**
   * Grant `agent` these tools for `ttlSeconds`: its arm, its chain, its bridge, in that order, each a line in the
   * ledger. Anything that fails undoes what came before it. Returns the grant and its chain (said this once).
   */
  grant(input: { agent: string; tools: QampTool[]; ttlSeconds: number }, by: GrantPrincipal): Promise<QampGrantMade> {
    return this.serial(async () => {
      if (this.closing) throw new QampGrantError(503, "this node is stopping");
      if (!mayGrant(by)) throw new QampGrantError(403, "only you grant an agent on another machine Galahad's tools");
      const unknown = input.tools.filter((t) => !(QAMP_TOOLS as readonly string[]).includes(t));
      if (unknown.length) throw new QampGrantError(400, `${unknown.join(", ")} can't be granted`);
      const scopes = grantScopes(input.tools);
      // Nothing you couldn't do from where you asked: as for an invite.
      const lacking = scopes.filter((s) => !by.scopes.includes(s));
      if (lacking.length) throw new QampGrantError(403, `this device doesn't hold ${lacking.join(", ")}, which those tools need`);
      const address = this.opts.address();
      if (unspecified(address)) throw new QampGrantError(424, "this node has no address to give a bridge but every interface's, and a bridge never listens on those: set its tailnet address (GALAHAD_ADVERTISE)");
      const bridge = await this.bridgeKey();
      const port = await this.freePort(address);
      let id = randomBytes(5).toString("hex");
      while (this.row(id) || this.opts.arms.get(qampArm(id))) id = randomBytes(5).toString("hex");
      const label = qampArm(id);
      const createdAt = this.now();
      const endsAt = createdAt + input.ttlSeconds * 1000;
      const until = new Date(endsAt).toISOString();

      const { token } = this.opts.arms.mint(label, scopes);
      try {
        this.opts.home.writeArmToken(label, token);
        this.line({ class: "create", target: label, reason: "you granted an agent on another machine these tools, for a while", detail: `agent ${input.agent} · tools ${input.tools.join(", ")} · scopes ${scopes.join(", ")} · until ${until}` });
        const chain = await this.opts.runner.run(["delegate", "--key", this.keyPath, "--to", input.agent, "--cmd", "/tool/galahad", "--ttl", String(input.ttlSeconds)]);
        const proof = chain.stdout.trim();
        if (chain.code !== 0 || !/^qdt1\.[A-Za-z0-9_-]+$/.test(proof)) throw new QampGrantError(500, `its chain wasn't issued: ${chain.stderr.trim().slice(0, 300) || "qamp printed no qdt1. chain"}`);
        this.line({ class: "create", target: label, reason: "its delegation chain: from this node's bridge key to the agent's key, for /tool/galahad, useless without the agent's private key", detail: `to ${input.agent} · ends ${until}` });
        this.opts.db
          .query("INSERT INTO qamp_grants (id, agent, tools, scopes, port, bridge, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, input.agent, JSON.stringify(input.tools), JSON.stringify(scopes), port, bridge, createdAt, endsAt);
        try {
          await this.launch(id);
        } catch (error) {
          this.opts.db.query("DELETE FROM qamp_grants WHERE id = ?").run(id);
          this.live.delete(id);
          throw error;
        }
        this.line({ class: "create", target: label, reason: "its bridge: the agent's key alone may connect, and the granted tools alone are served", detail: `listening on ${hostPort(address, port)}` });
        return { grant: this.view(this.row(id)!), proof };
      } catch (error) {
        // Undone: the arm and its token, so nothing of a grant that never came to be is left to use.
        this.opts.arms.revoke(label);
        rmSync(this.opts.home.armTokenPath(label), { force: true });
        this.line({ class: "delete", target: label, reason: "the grant wasn't made, so its arm was deleted", detail: (error as Error).message.slice(0, 500) });
        throw error;
      }
    });
  }

  /** Start a grant's bridge, and resolve once it listens; fail (and leave it stopped) if it doesn't. */
  private async launch(id: string): Promise<void> {
    const row = this.row(id);
    if (!row) return;
    const live: Live = this.live.get(id) ?? { proc: null, state: "starting", why: null, stopping: false, tail: [], retry: null, backoffMs: 1000, upSince: null };
    this.live.set(id, live);
    live.state = "starting";
    live.why = null;
    live.stopping = false;
    live.tail = [];
    const tools = JSON.parse(row.tools) as string[];
    const label = qampArm(id);
    const args = [
      "serve",
      "--key", this.keyPath,
      "--listen", hostPort(this.opts.address(), row.port),
      "--allow", row.agent,
      "--mcp-stdio",
      "--only", tools.join(","),
      "--prefix", "galahad",
      "--", ...this.opts.mcpCommand(label, tools),
    ];
    // What its MCP server needs to reach this node, and nothing else of the daemon's environment.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? this.opts.home.dir, GALAHAD_HOME: this.opts.home.dir, GALAHAD_PORT: String(this.opts.port) };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    let proc: QampProcess;
    try {
      proc = this.opts.runner.serve(args, env, (text) => {
        const said = text.trim();
        if (!said) return;
        live.tail = [...live.tail.slice(-4), said.slice(0, 300)];
        this.opts.log(`qamp ${label}: ${said.slice(0, 300)}`);
      });
    } catch (error) {
      live.state = "down";
      live.why = (error as Error).message;
      throw error;
    }
    live.proc = proc;
    void proc.exited.then((how) => this.ended(id, proc, how));
    const address = await Promise.race([proc.ready, Bun.sleep(this.opts.startMs ?? 45_000).then(() => "timeout" as const)]);
    if (address === "timeout" || address === null || !address.startsWith("qamp://")) {
      const why = address === "timeout" ? "it didn't start listening in time" : `it stopped before it listened${live.tail.length ? `: ${live.tail.join(" · ")}` : ""}`;
      // Forgotten before it's killed: its end is this failure, already said, never one to start it again for.
      live.proc = null;
      proc.kill("SIGKILL");
      live.state = "down";
      live.why = why;
      throw new QampGrantError(502, `the grant's bridge didn't start: ${why}`);
    }
    live.state = "up";
    live.upSince = this.now();
    if (proc.pid) this.opts.db.query("UPDATE qamp_grants SET pid = ? WHERE id = ?").run(proc.pid, id);
  }

  /**
   * A bridge of this grant's that a node which died (no stop of its own: killed, crashed) left running: it holds the
   * grant's port, and no later revoke could stop it. Stopped as the node starts again. Only if its command line still
   * names this grant's arm: a pid since taken by any other process is left alone.
   */
  private async stopStray(row: Row): Promise<void> {
    const strays = this.opts.strays ?? processes;
    const ours = (): boolean => {
      const command = row.pid ? strays.command(row.pid) : null;
      return !!command && /\bserve\b/.test(command) && command.includes(`--arm ${qampArm(row.id)} `);
    };
    if (!row.pid || !ours()) return;
    strays.kill(row.pid, "SIGTERM");
    for (let i = 0; i < 50 && ours(); i++) await Bun.sleep(100);
    if (ours()) strays.kill(row.pid, "SIGKILL");
    this.opts.log(`qamp: stopped ${qampArm(row.id)}'s bridge, left running by a node that didn't stop it (pid ${row.pid})`);
  }

  /** A bridge ended: on purpose (nothing more to do), or not, when it is started again until its grant ends. */
  private ended(id: string, proc: QampProcess, how: number | string | null): void {
    const live = this.live.get(id);
    if (!live || live.proc !== proc) return;
    live.proc = null;
    live.state = "down";
    if (live.stopping || this.closing) return;
    this.retryLater(id, `its bridge stopped (${how ?? "unknown"})${live.tail.length ? `: ${live.tail.join(" · ")}` : ""}`);
  }

  /** Start a grant's bridge again later: at once after one that ran a while, longer each time after one that keeps stopping. */
  private retryLater(id: string, why: string): void {
    const live = this.live.get(id);
    if (!live || this.closing) return;
    live.state = "down";
    live.why = why;
    if (live.upSince !== null && this.now() - live.upSince > MAX_BACKOFF_MS) live.backoffMs = 1000;
    live.upSince = null;
    const wait = live.backoffMs;
    live.backoffMs = Math.min(wait * 2, MAX_BACKOFF_MS);
    this.opts.log(`qamp ${qampArm(id)}: ${why}; started again in ${Math.round(wait / 1000)} s`);
    if (live.retry) clearTimeout(live.retry);
    live.retry = setTimeout(() => {
      live.retry = null;
      void this.serial(async () => {
        const row = this.row(id);
        if (!row || this.closing || live.proc || this.live.get(id) !== live || row.ends_at <= this.now()) return;
        await this.launch(id).catch((error: Error) => this.retryLater(id, error.message));
      });
    }, wait);
    live.retry.unref?.();
  }

  /** Tell a bridge to stop (SIGTERM: it drains its calls), and wait for it; one that won't is killed. */
  private async stopBridge(live: Live): Promise<number | string | null | "killed"> {
    if (live.retry) clearTimeout(live.retry);
    live.retry = null;
    const proc = live.proc;
    if (!proc) return null;
    live.stopping = true;
    proc.kill("SIGTERM");
    const how = await Promise.race([proc.exited, Bun.sleep(this.opts.stopGraceMs ?? 15_000).then(() => "killed" as const)]);
    if (how === "killed") {
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, Bun.sleep(2_000)]);
    }
    return how;
  }

  /** End a grant: its arm deleted (the agent's very next call is refused at the door), then its bridge stopped. */
  private async end(id: string, why: "expired" | "revoked"): Promise<boolean> {
    const row = this.row(id);
    if (!row) return false;
    const label = qampArm(id);
    this.opts.db.query("DELETE FROM qamp_grants WHERE id = ?").run(id);
    this.opts.arms.revoke(label);
    rmSync(this.opts.home.armTokenPath(label), { force: true });
    const said = why === "expired" ? "its time was up" : "you revoked it";
    this.line({ class: "delete", target: label, reason: `the grant ended (${said}): its arm is deleted, so the agent's next call is refused`, detail: `agent ${row.agent}` });
    const live = this.live.get(id);
    this.live.delete(id);
    if (live) {
      const how = await this.stopBridge(live);
      if (how !== null) this.line({ class: "delete", target: label, reason: `the grant ended (${said}): its bridge stopped`, detail: how === "killed" ? "it didn't stop when told to, so it was killed" : `it drained and stopped (${how})` });
    }
    return true;
  }

  revoke(id: string): Promise<boolean> {
    return this.serial(() => this.end(id, "revoked"));
  }

  revokeAll(): Promise<number> {
    return this.serial(async () => {
      let ended = 0;
      for (const row of this.rows()) if (await this.end(row.id, "revoked")) ended++;
      return ended;
    });
  }

  /** End the grants whose time is up. */
  sweep(): Promise<number> {
    return this.serial(async () => {
      let ended = 0;
      for (const row of this.rows()) if (row.ends_at <= this.now() && (await this.end(row.id, "expired"))) ended++;
      return ended;
    });
  }

  /**
   * As the daemon starts: grants whose time ran out while it was down end now; the others' bridges start again (one
   * that won't is started again later). An arm left by a grant that never came to be is deleted.
   */
  resume(sweepMs = 5_000): Promise<void> {
    if (sweepMs > 0 && !this.sweeper) {
      this.sweeper = setInterval(() => void this.sweep().catch((error: Error) => this.opts.log(`qamp: ${error.message}`)), sweepMs);
      this.sweeper.unref?.();
    }
    return this.serial(async () => {
      const held = new Set(this.rows().map((r) => qampArm(r.id)));
      for (const arm of this.opts.arms.list()) {
        if (QampGrants.isGrantArm(arm.label) && !held.has(arm.label)) {
          this.opts.arms.revoke(arm.label);
          rmSync(this.opts.home.armTokenPath(arm.label), { force: true });
          this.opts.log(`qamp: deleted ${arm.label}, an arm of a grant that was never made`);
        }
      }
      for (const row of this.rows()) {
        await this.stopStray(row);
        if (row.ends_at <= this.now()) {
          await this.end(row.id, "expired");
          continue;
        }
        try {
          await this.launch(row.id);
          this.opts.log(`qamp: ${qampArm(row.id)}'s bridge is up again on ${hostPort(this.opts.address(), row.port)}`);
        } catch (error) {
          this.retryLater(row.id, (error as Error).message);
        }
      }
    });
  }

  /** As the daemon stops: every bridge is stopped (each drains); the grants stay, to start again with the daemon. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await this.queue.catch(() => {});
    await Promise.all([...this.live.values()].map((live) => this.stopBridge(live)));
  }
}
