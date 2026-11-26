import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { b64u, didKeyOfEd25519, fromB64u, signingPublicKey } from "@invincible/core";
import { SidecarClient, within } from "./socket.ts";

/*
 * The node's sidecar (docs/ARCHITECTURE.md §3): Q-AMP's own binary, `qamp sidecar`, beside the daemon, spoken to over a
 * socket in the node's home. The daemon holds the vault, so no QUIC stack is loaded into it; the sidecar holds no secret
 * but the node's transport key, an Ed25519 key of its own (never the node's device key, which signs its ledger).
 *
 * The node makes that key once, starts the sidecar, watches it, and starts it again when it stops (at once after one
 * that ran a while, longer each time after one that keeps stopping). While it is down, or the binary isn't installed,
 * every link goes over HTTPS with signed requests, as before it, and the node says so.
 */

/** The transport key's file, as `qamp keygen` writes one: `qamp-sk1.` and base64url of its 32-byte seed. */
const KEY_PREFIX = "qamp-sk1.";
/** A Unix socket's path is short (104 bytes on macOS, 108 on Linux, with its NUL). */
const SOCKET_PATH_MAX = 103;
const MAX_BACKOFF_MS = 60_000;

/** The sidecar process as the supervisor sees it (tests: a stand-in). */
export interface SidecarProcess {
  /** Its first line on stdout: its address (qamp://…) when it listens, else its DID; null if it ended first. */
  ready: Promise<string | null>;
  exited: Promise<number | string | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  pid?: number;
}

export type SpawnSidecar = (binary: string, args: string[], env: Record<string, string>, line: (text: string) => void) => SidecarProcess;

/** How the sidecar's process is started: Bun.spawn, its stdout's first line its address, stderr's lines to `line`. */
export const spawnSidecar: SpawnSidecar = (binary, args, env, line) => {
  const proc = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const lines = async (stream: ReadableStream<Uint8Array>, each: (text: string) => void) => {
    const decoder = new TextDecoder();
    let held = "";
    for await (const chunk of stream) {
      held += decoder.decode(chunk, { stream: true });
      for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
        each(held.slice(0, at));
        held = held.slice(at + 1);
      }
      if (held.length > 4096) held = held.slice(-4096);
    }
    if (held) each(held);
  };
  let first: (address: string | null) => void = () => {};
  const ready = new Promise<string | null>((resolve) => (first = resolve));
  // Its address is its first line; whatever follows is read and dropped, so the pipe never fills.
  void lines(proc.stdout, (text) => first(text.trim())).finally(() => first(null));
  void lines(proc.stderr, line).catch(() => {});
  return { ready, exited: proc.exited.then(() => proc.signalCode ?? proc.exitCode), kill: (signal) => proc.kill(signal), pid: proc.pid };
};

/**
 * Whether a `qamp` binary has a sidecar at all (Q-AMP 0.1.0, the first release, has none), and its version: asked of
 * the binary itself, `qamp sidecar --help` and `qamp --version`.
 */
export function probeSidecar(binary: string): { sidecar: boolean; version: string | null } {
  const version = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
  const help = Bun.spawnSync([binary, "sidecar", "--help"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
  const said = version.exitCode === 0 ? version.stdout.toString().trim().replace(/^qamp\s+/, "").slice(0, 40) : null;
  return { sidecar: help.exitCode === 0, version: said };
}

export interface SidecarOptions {
  /** The node's home: the key goes to <home>/qamp/node.qamp-key, the socket to <home>/run/qamp.sock. */
  home: string;
  /**
   * The `qamp` binary, looked for at each start: a path that isn't there yet is looked for again (installing it needs no
   * restart); null, the node runs no sidecar at all (tests, or a node told so), and nothing is tried again.
   */
  binary: () => string | null;
  /** host:port to listen on (this node's tailnet address, never every interface); null: it only dials out. */
  listen: () => string | null;
  /** The name its MANIFEST gives (the node's). */
  name: string;
  log: (message: string) => void;
  /** The longest a grant it mints may live, in seconds (the sidecar refuses longer). */
  maxTtlSecs?: number;
  /** The socket's path (tests: a short one; INVINCIBLE_QAMP_SOCKET). */
  socket?: string;
  spawn?: SpawnSidecar;
  /** How long it may take to say its address and open its socket. */
  startMs?: number;
  stopGraceMs?: number;
  /** How a binary is asked whether it has a sidecar (tests: a stand-in): asked again only when the binary changes. */
  probe?: (binary: string) => { sidecar: boolean; version: string | null };
  /** Each time the node holds a connection to a sidecar that is up: serve its tools there. */
  up?(client: SidecarClient): Promise<void> | void;
  /** Each time it went down (or never came up), and why. */
  down?(why: string): void;
  now?: () => number;
}

export type SidecarState = "off" | "starting" | "up" | "down";

/**
 * Where the sidecar listens: the node's advertised address alone, never every interface. An address that is every
 * interface's (0.0.0.0, ::, and every other way of writing them) gives null: it only dials out (its peers' calls still
 * reach it over the connections it opens).
 */
export function sidecarListen(advertise: string, port: number, unspecified: (address: string) => boolean): string | null {
  if (unspecified(advertise)) return null;
  const bare = advertise.replace(/^\[(.*)\]$/, "$1");
  return `${bare.includes(":") ? `[${bare}]` : bare}:${port}`;
}

/** The node's transport key: made once, 0600, in its home. Returns its DID; its secret is never kept in memory. */
export function transportKey(home: string): { path: string; did: string; made: boolean } {
  const dir = join(home, "qamp");
  const path = join(dir, "node.qamp-key");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let made = false;
  if (!existsSync(path)) {
    const seed = randomBytes(32);
    // Made exclusively, so two starts can never write two keys; 0600 from its first byte.
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${KEY_PREFIX}${b64u(seed)}\n`);
    } finally {
      closeSync(fd);
    }
    seed.fill(0);
    made = true;
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} isn't a file`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
  const text = readFileSync(path, "utf8").trim();
  if (!text.startsWith(KEY_PREFIX)) throw new Error(`${path} isn't a Q-AMP key (qamp-sk1.…): a P-256 one, or another file`);
  const seed = fromB64u(text.slice(KEY_PREFIX.length));
  if (seed.length !== 32) throw new Error(`${path} isn't an Ed25519 key's seed`);
  const did = didKeyOfEd25519(signingPublicKey(seed));
  seed.fill(0);
  return { path, did, made };
}

export class Sidecar {
  private readonly now: () => number;
  private proc: SidecarProcess | null = null;
  private stopping = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private upSince: number | null = null;
  private tail: string[] = [];
  private starting: Promise<void> | null = null;
  /** What the binary said of itself, as it was when it was asked (its path, size and time). */
  private probed: { key: string; sidecar: boolean; version: string | null } | null = null;
  state: SidecarState = "off";
  why: string | null = "not started";
  client: SidecarClient | null = null;
  /** Its transport key's DID (known from its key, sidecar up or not), and its address once it said one. */
  did: string | null = null;
  address: string | null = null;
  version: string | null = null;

  constructor(private readonly opts: SidecarOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Its process's id while it runs (the doctor says it; tests stop it to see the node start it again). */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get socketPath(): string {
    return this.opts.socket ?? join(this.opts.home, "run", "qamp.sock");
  }

  /** Starts it (never throws: what went wrong is its state and why, and it is tried again later). */
  start(): Promise<void> {
    this.stopping = false;
    if (!this.starting) this.starting = this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const binary = this.opts.binary();
    if (binary === null) {
      this.state = "off";
      this.why = "this node runs no sidecar";
      return;
    }
    if (!existsSync(binary)) return this.off("Q-AMP isn't installed on this node: its pinned binary goes to <home>/bin/qamp (scripts/qamp-pin.sh; deploy.sh --qamp <file>)");
    // A binary from before the sidecar (0.1.0) runs grants' bridges and no sidecar: asked once, again when it changes.
    const stat = statSync(binary);
    const made = `${binary}:${stat.size}:${stat.mtimeMs}`;
    if (this.probed?.key !== made) this.probed = { key: made, ...(this.opts.probe ?? probeSidecar)(binary) };
    if (!this.probed.sidecar) return this.off(`the qamp here (${this.probed.version ?? binary}) has no sidecar: Q-AMP's release with one goes to <home>/bin/qamp (scripts/qamp-pin.sh; deploy.sh --qamp <file>)`);
    if (this.socketPath.length > SOCKET_PATH_MAX) return this.off(`the sidecar's socket path is too long for a Unix socket (${this.socketPath.length} bytes): set INVINCIBLE_QAMP_SOCKET to a shorter one`);
    let key: { path: string; did: string };
    try {
      key = transportKey(this.opts.home);
      this.did = key.did;
    } catch (error) {
      return this.off(`its transport key can't be read: ${(error as Error).message}`);
    }
    const socketDir = join(this.socketPath, "..");
    try {
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      chmodSync(socketDir, 0o700);
    } catch (error) {
      return this.failed(`its socket's directory can't be made private: ${(error as Error).message}`);
    }
    await this.stopStray();
    this.state = "starting";
    this.why = null;
    this.tail = [];
    const listen = this.opts.listen();
    const args = ["sidecar", "--key", key.path, "--socket", this.socketPath, "--name", this.opts.name, "--max-ttl", String(this.opts.maxTtlSecs ?? 86_400), "--allow-cmd", "/tool/invincible"];
    if (listen) args.push("--listen", listen);
    // What it needs, and nothing else of the daemon's environment (the vault's key among them).
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? this.opts.home };
    if (process.env.RUST_LOG) env.RUST_LOG = process.env.RUST_LOG;
    let proc: SidecarProcess;
    try {
      proc = (this.opts.spawn ?? spawnSidecar)(binary, args, env, (text) => {
        const said = text.trim();
        if (!said) return;
        this.tail = [...this.tail.slice(-4), said.slice(0, 300)];
      });
    } catch (error) {
      return this.failed(`it didn't start: ${(error as Error).message}`);
    }
    this.proc = proc;
    if (proc.pid) writeFileSync(join(socketDir, "qamp.pid"), `${proc.pid}\n`, { mode: 0o600 });
    void proc.exited.then((how) => this.exited(proc, how));
    const said = await within(proc.ready, this.opts.startMs ?? 20_000, () => "timeout" as const);
    if (said === "timeout" || said === null || !(said.startsWith("qamp://") || said.startsWith("did:key:"))) {
      this.proc = null;
      proc.kill("SIGKILL");
      return this.failed(said === "timeout" ? "it didn't say its address in time" : `it stopped before it listened${this.tail.length ? `: ${this.tail.join(" · ")}` : ""}`);
    }
    let client: SidecarClient;
    try {
      client = await SidecarClient.connect(this.socketPath, { timeoutMs: 5_000 });
    } catch (error) {
      this.proc = null;
      proc.kill("SIGTERM");
      return this.failed(`its socket didn't answer: ${(error as Error).message}`);
    }
    if (client.hello.did !== key.did) {
      client.close();
      this.proc = null;
      proc.kill("SIGTERM");
      return this.failed(`it speaks as ${client.hello.did}, not this node's transport key ${key.did}`);
    }
    this.client = client;
    this.address = client.hello.address;
    this.version = client.hello.version;
    client.onClose((why) => {
      if (this.client !== client) return;
      this.client = null;
      if (this.stopping) return;
      // A socket that closed under a sidecar still running: it is ended and started again.
      if (this.proc === proc) proc.kill("SIGTERM");
      this.failed(`its socket closed (${why.message})`);
    });
    try {
      await this.opts.up?.(client);
    } catch (error) {
      this.opts.log(`qamp: the sidecar is up, but its tools weren't served: ${(error as Error).message}`);
    }
    this.state = "up";
    this.why = null;
    this.upSince = this.now();
    this.opts.log(`qamp: sidecar up as ${key.did.slice(0, 20)}… ${this.address ? `on ${this.address.split("@")[1]}` : "(dials out only)"} · qamp ${this.version}`);
  }

  /** A sidecar a node that died left running holds the socket (and the port): it is stopped, by the pid it was started as. */
  private async stopStray(): Promise<void> {
    const pidFile = join(this.socketPath, "..", "qamp.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    rmSync(pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 1) return;
    const ours = (): boolean => {
      const ps = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
      const command = ps.exitCode === 0 ? ps.stdout.toString() : "";
      return /\bsidecar\b/.test(command) && command.includes(this.socketPath);
    };
    if (!ours()) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 120 && ours(); i++) await Bun.sleep(100);
    if (ours()) process.kill(pid, "SIGKILL");
    this.opts.log(`qamp: stopped a sidecar a node before this one left running (pid ${pid})`);
  }

  private off(why: string): void {
    this.state = "off";
    this.why = why;
    this.opts.down?.(why);
    this.later();
  }

  private failed(why: string): void {
    this.state = "down";
    this.why = why;
    this.opts.log(`qamp: ${why}`);
    this.opts.down?.(why);
    this.later();
  }

  private exited(proc: SidecarProcess, how: number | string | null): void {
    if (this.proc !== proc) return;
    this.proc = null;
    // One that ends while it is starting is that start's failure, said once, by the start itself.
    if (this.stopping || this.state === "starting") return;
    const client = this.client;
    this.client = null;
    client?.close();
    this.failed(`it stopped (${how ?? "unknown"})${this.tail.length ? `: ${this.tail.join(" · ")}` : ""}`);
  }

  /** Started again later: at once after one that ran a while, longer each time after one that keeps stopping. */
  private later(): void {
    if (this.stopping) return;
    if (this.upSince !== null && this.now() - this.upSince > MAX_BACKOFF_MS) this.backoffMs = 1_000;
    this.upSince = null;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(wait * 2, MAX_BACKOFF_MS);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, wait);
    this.retry.unref?.();
  }

  /** Stops it: SIGTERM (it drains its calls, up to 10 s), then SIGKILL if it won't. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    await this.starting?.catch(() => {});
    const client = this.client;
    this.client = null;
    const proc = this.proc;
    this.proc = null;
    this.state = "off";
    this.why = "stopped";
    if (proc) {
      proc.kill("SIGTERM");
      const how = await within(proc.exited, this.opts.stopGraceMs ?? 15_000, () => "killed" as const);
      if (how === "killed") {
        proc.kill("SIGKILL");
        await within(proc.exited, 2_000, () => null);
      }
      rmSync(join(this.socketPath, "..", "qamp.pid"), { force: true });
    }
    client?.close();
  }
}
