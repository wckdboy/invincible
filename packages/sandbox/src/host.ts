import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ActionClass, COMPUTER_START, type Decision, decide, type ExecResult, isReservedGatewayScope, LEASE_FILE, MAC_VM_OVERHEAD, NOTES_DIR, randomBytes, redact, type SandboxNetwork, type SandboxView, type SeatKind, TeamWorkspaceRun, VM_OVERHEAD, type VmOverhead, WORKSPACE_OWN } from "@invincible/core";
import { layoutPath, MOVE_PY, WORK_TREE } from "./layout.ts";
import {
  CONTAINER_MAJOR,
  containerBuildArgs,
  containerBuilderStopArgs,
  containerCannot,
  containerCollectArgs,
  containerDeleteArgs,
  containerExecArgs,
  containerImageInspectArgs,
  containerInspectArgs,
  containerKeeperArgs,
  containerListArgs,
  containerNetworkCreateArgs,
  containerNetworkInspectArgs,
  containerRunArgs,
  containerStartArgs,
  containerStopArgs,
  containerSystemStartArgs,
  containerTerminalArgs,
  containerVersionArgs,
  containerVolumeDeleteArgs,
  parseContainers,
  CONTAINER_IMAGES,
  CONTAINER_UNMADE,
  DEFAULT_NETWORK,
  helperRestartArgs,
  KEEPERS,
  parseContainerVersion,
  type SandboxAsk,
  type Unmade,
} from "./container.ts";
import { ContainerVolumes } from "./container-volumes.ts";
import { DesktopSession, SessionEnded, type SpawnSession, spawnSession } from "./desktop-session.ts";
import { DesktopStream, type SpawnFrames, spawnFrames, StreamEnded } from "./desktop-stream.ts";
import { macFirewall, type MacFirewallState } from "./mac-firewall.ts";
import {
  chooseIsolation,
  containerName,
  DEFAULT_IMAGE,
  collectArgs,
  execArgs,
  gatewayEnv,
  DESKTOP_IMAGE,
  buildCommand,
  HARDWARE_IMAGE,
  HARNESS_IMAGE,
  LAB_IMAGE,
  LABEL,
  madeFrom,
  NETWORKS,
  networkCreateArgs,
  OWN_IMAGES,
  remadeImage,
  runArgs,
  type SandboxSpec,
  SEARCH_SCOPE,
  seatVolumeName,
  TERMINAL_HANG_UP,
  terminalArgs,
  volumeName,
} from "./spec.ts";
import { COLLECT_MISSING, COLLECT_REFUSED, collectSkipped } from "./walk.ts";
import { type ExtractLimits, type ExtractResult, extractTar } from "./tar.ts";
import { budgetProblem, DEFAULT_DISK_GB, type Workspaces, type WorkspaceStats } from "./workspaces.ts";

export interface LedgerEntryInput {
  class: ActionClass;
  resource: string;
  target: string;
  verdict: "allow" | "ask" | "deny" | "approved";
  reason?: string;
  run?: string;
  detail?: string;
}

export interface TokenMinter {
  /** `models`: a lease good for these alone, whatever its providers serve (work in sensitive mode, or another node's task). */
  mint(scope: { label: string; providers?: string[]; models?: string[]; ttlMinutes: number; maxRequests: number }): {
    token: string;
    info: { hash: string };
  };
  revoke(hash: string): boolean;
  /** The same token, valid longer and with more requests (a lease kept while its work runs): never a lapsed or revoked one. */
  extend?(hash: string, scope: { ttlMinutes: number; maxRequests: number }): boolean;
}

/** Node-local record of which gateway token belongs to which sandbox (never a container label). */
export interface SandboxTokenStore {
  put(id: string, tokenHash: string): void;
  take(id: string): string | null;
  /** Which token a sandbox has, leaving it there. */
  peek?(id: string): string | null;
}

export function memoryTokenStore(): SandboxTokenStore {
  const map = new Map<string, string>();
  return {
    put: (id, hash) => void map.set(id, hash),
    take: (id) => {
      const hash = map.get(id) ?? null;
      map.delete(id);
      return hash;
    },
    peek: (id) => map.get(id) ?? null,
  };
}

/**
 * A move of an agent's store to layout 2 under way, as the node keeps it (in its own database, which no VM reaches): the
 * move's word, which every name it makes in the store carries (layout.ts MOVE_PY), and what the store listed before it
 * began, which you're told once it is done. Kept from before the first rename until the move is done or put back, so a
 * node that stops in the middle takes it up again from there.
 */
export interface LayoutMove {
  nonce: string;
  entries: LayoutEntry[];
}
export interface LayoutMoves {
  /** The move of this agent's store under way, or null. */
  started(id: string): LayoutMove | null;
  start(id: string, move: LayoutMove): void;
  end(id: string): void;
}

export function memoryLayoutMoves(): LayoutMoves {
  const map = new Map<string, LayoutMove>();
  return {
    started: (id) => map.get(id) ?? null,
    start: (id, move) => void map.set(id, move),
    end: (id) => void map.delete(id),
  };
}

/**
 * A top-level entry of an agent's store, as a move to layout 2 would take it (layout.ts MOVE_PY's list), or its notes
 * (`notes`: named by their place in its HOME): by name and size.
 */
export interface LayoutEntry {
  name: string;
  to: "work" | "home" | "notes" | "drop";
  kind: "dir" | "file" | "link" | "other";
  bytes: number;
}

export interface SandboxHostOptions {
  /**
   * Layout 2 (layout.ts): an agent's VM is made in it, and one in layout 1 is moved to it at its next prepare while nothing
   * runs in it. A Linux host with Docker alone (a Mac's stay in layout 1); a store that is a Docker volume, only on Docker
   * Engine 26 or later, whose volumes' subpaths its trees are mounted as. Absent: every VM stays as it is made. A function:
   * the node's own switch as it is now (`invincible sandbox layout`), asked at each VM made or prepared.
   */
  layout2?: boolean | (() => boolean);
  /** An agent's VM moved to layout 2: its run, and what of its store went where, by name and size (its owner's notice). */
  moved?: (run: string, entries: readonly LayoutEntry[]) => void;
  node: string;
  tokens: TokenMinter;
  ledger: (entry: LedgerEntryInput) => void;
  maxCpus: number;
  maxMemoryGb: number;
  /** The largest workspace one sandbox may have (default 200 GB). */
  maxDiskGb?: number;
  /**
   * Size-limited workspaces; null or absent: /work is an unlimited Docker volume (the heartbeat says so). On a Mac
   * they are container's own volumes (ContainerVolumes), each of a fixed size, unless others are given.
   */
  workspaces?: Workspaces | null;
  /** The sandbox directory (its Dockerfile, and lab/ for the Lab), so a missing image is rebuilt instead of failing. */
  imageContext?: string;
  /** Whether this host runs KVM microVMs (Kata installed, /dev/kvm present). */
  microVMs?: boolean;
  /** The resolv.conf online microVMs get (see vmResolvConf). */
  resolvConf?: string;
  tokenStore?: SandboxTokenStore;
  /** The moves to layout 2 under way here (LayoutMove): in the node's own database. Absent: in this process's memory. */
  layoutMoves?: LayoutMoves;
  /**
   * The command line that runs sandboxes here: Docker's (the default), or Apple's `container` on a Mac, where every
   * sandbox is a lightweight VM of its own (container.ts: each of Docker's flags there, and what a Mac can't make).
   */
  engine?: "docker" | "container";
  /** The disk a Mac's workspaces come out of, for their budget (default: the one the home is on). */
  disk?: () => { totalBytes: number; freeBytes: number };
  /** The engine's binary (default: docker, or container). */
  docker?: string;
  /** How the engine is run (tests pass a stand-in that answers its commands; nothing is spawned then). */
  runner?: DockerRunner;
  /** How a terminal's process is started (tests pass one that starts a local shell instead of `docker exec`). */
  spawnTerminal?: SpawnTerminal;
  /** How a sandbox's long-lived process is started (tests pass a stand-in; nothing is spawned then). */
  spawnStream?: SpawnStream;
  now?: () => number;
  /** How long to wait before starting a sandbox once more (tests pass one that doesn't). */
  pause?: (ms: number) => Promise<void>;
  /** How launchctl is run on a Mac, to restart a network's helper (tests pass a stand-in; nothing is spawned then). */
  launchctl?: DockerRunner;
  /** On a Mac: whether its sandbox firewall is on (mac-firewall.ts; tests pass their own). No sandbox is made while it isn't. */
  firewall?: () => Promise<MacFirewallState>;
  /** How a VM's held desktop session is started (desktop-session.ts; tests pass a stand-in): an engine exec kept open. */
  spawnSession?: SpawnSession;
  /** How a VM's desktop stream is started while you watch it (desktop-stream.ts; tests pass a stand-in): an engine exec, its stdout as bytes. */
  spawnFrames?: SpawnFrames;
}

/**
 * Kata's rootless runtime gives each microVM a user of its own and hands a UID out again as soon as it is free: a VM
 * started while a finished one's teardown is still removing that UID's runtime directory loses its files, and Docker
 * says this (ultra, 16 November 2026, under parallel evals). The runtime's race, not the sandbox's fault.
 */
const lostItsFiles = (stderr: string): boolean => /failed to create shim task/.test(stderr) && /no such file or directory/.test(stderr);

/** One docker command: its arguments in, its exit code and output out. */
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; truncated?: boolean }>;

/** A process on a terminal: what it prints comes to the `onData` it was started with; keys and sizes go in. */
export interface TerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Its exit code once it has ended. */
  exited: Promise<number>;
}

export type SpawnTerminal = (argv: string[], size: { cols: number; rows: number }, onData: (bytes: Uint8Array) => void) => TerminalProcess;

/**
 * A process in a sandbox that runs while it's wanted (a seat's sign-in): what it prints, a line at a time, and what it's
 * told on its standard input. A line longer than STREAM_LINE_LIMIT is dropped whole, never cut.
 */
export interface SandboxStream {
  lines: AsyncIterable<string>;
  write(text: string): void;
  /** Its standard input closed: it reads the end. */
  close(): void;
  kill(): void;
  exited: Promise<number>;
}
export type SpawnStream = (argv: string[]) => SandboxStream;
export const STREAM_LINE_LIMIT = 64 * 1024;

/** A process on this host whose stdin stays open (`docker exec --interactive`), its stdout read as lines. */
export const spawnStream: SpawnStream = (argv) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  async function* lines(): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let held = "";
    let dropping = false;
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      held += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = held.indexOf("\n")) >= 0) {
        const line = held.slice(0, at);
        held = held.slice(at + 1);
        if (!dropping && line.length <= STREAM_LINE_LIMIT) yield line;
        dropping = false;
      }
      // (A line still growing past the limit is dropped whole, up to its end.)
      if (held.length > STREAM_LINE_LIMIT) {
        held = "";
        dropping = true;
      }
    }
    if (held && !dropping && held.length <= STREAM_LINE_LIMIT) yield held;
  }
  return {
    lines: lines(),
    write: (text) => {
      try {
        proc.stdin.write(text);
        proc.stdin.flush();
      } catch {
        // (It has ended: what it's told goes nowhere.)
      }
    },
    close: () => {
      try {
        proc.stdin.end();
      } catch {
        // (Ended already.)
      }
    },
    kill: () => proc.kill(),
    exited: proc.exited,
  };
};

/**
 * A process under a pseudo-terminal on this host (Bun's own): it sees a real terminal, and a resize reaches it.
 * Killing it hangs up its terminal (an interactive shell ignores SIGTERM), and two seconds on, kills it outright.
 */
export const spawnTerminal: SpawnTerminal = (argv, size, onData) => {
  const proc = Bun.spawn(argv, { terminal: { cols: size.cols, rows: size.rows, data: (_terminal, bytes) => onData(bytes) } });
  const terminal = proc.terminal!;
  const exited = proc.exited.finally(() => terminal.close());
  return {
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    kill: () => {
      proc.kill("SIGHUP");
      const outright = setTimeout(() => proc.kill("SIGKILL"), 2000);
      void exited.finally(() => clearTimeout(outright));
    },
    exited,
  };
};

/** Parsed (defaults applied) create request. */
export interface CreateInput {
  network: "isolated" | "gateway" | "online";
  image?: string;
  cpus: number;
  memoryGb: number;
  ttlMinutes: number;
  providers?: string[];
  persistent: boolean;
  run?: string;
  /** The workspace's size limit (default 20 GB). */
  diskGb?: number;
  /** container or vm; default: vm for online sandboxes where this host has microVMs. */
  isolation?: "container" | "vm";
  /** The Lab image (mathematics, physics, engineering) instead of the workshop. */
  lab?: boolean;
  /** The desktop image (a display, a window manager and a browser) instead of the workshop. */
  desktop?: boolean;
  /** The hardware image (the desktop with KiCad and FreeCAD): a desktop comes with it. */
  hardware?: boolean;
  /** Web search through the gateway (the node's own SearXNG): `websearch` in the images. */
  search?: boolean;
}

/**
 * How a sandbox is made, beyond what it is: `signal`, its asker went away while it waited for room (a governed host's);
 * `seat` and `shares`, a seat's VM (createSeatVm's alone: never a route's).
 */
export interface CreateOptions {
  signal?: AbortSignal;
  seat?: SeatVmInput["seat"];
  shares?: NonNullable<SandboxSpec["shares"]>;
  /** A VM made for another node's task (createTaskVm's alone): the task it is for. */
  task?: string;
}

/** A VM for a seat (createSeatVm): which seat, how many VMs its home may be in at once, and an agent's VM whose /work it shares. */
export interface SeatVmInput {
  seat: { id: string; kind: SeatKind; runs: number };
  /** For a run on the seat: the agent's own VM, on this host, whose /work this one uses. None: a VM of its own (a sign-in). */
  shares?: string;
  network: "online" | "gateway";
  cpus: number;
  memoryGb: number;
  ttlMinutes: number;
  run: string;
}

/** A VM for another node's task (createTaskVm): the task, the agent's VM whose workspace it shares, and its lease. */
export interface TaskVmInput {
  task: string;
  /** The agent's own VM on this host, in layout 2: its workspace (its work/ tree alone) is this VM's /work. */
  shares: string;
  run: string;
  /** Its lease: the providers its models are on, and those models alone (the task's paid ones: never a key, never a repository). */
  providers: readonly string[];
  models: readonly string[];
  ttlMinutes: number;
}

/** One thing done on an agent's desktop from outside its VM (`look`: nothing, only the picture). */
export type DesktopAction =
  | { do: "look" }
  | { do: "click"; x: number; y: number; button?: "left" | "right" | "middle" | "double" }
  | { do: "move"; x: number; y: number }
  | { do: "scroll"; direction: "up" | "down"; times?: number }
  | { do: "type"; text: string }
  | { do: "key"; keys: string[] }
  | { do: "open"; address: string };

/** Your take-over of an agent's desktop (deskd's hold, C1 step 9), as the node says it. */
export interface DesktopHold {
  /** When you took it, in milliseconds since the epoch. */
  since: number;
  /** It ends after this many seconds with no input from you, */
  idleSec: number;
  /** or this many in all, or when you give it back. */
  mostSec: number;
  /** How long it has left at most, as it is now: your next input starts its idle time again. */
  endsInSec: number;
}

/** The screen as it is now: a JPEG, and the display's size in the pixels a click is given in. */
export interface DesktopView {
  shot: { mediaType: "image/jpeg"; data: string };
  width: number;
  height: number;
  /** Whether you have its desktop (null: you don't), where its image has take-over; absent where it is older. */
  held?: DesktopHold | null;
}

/** A thing done with no picture asked back (what you watch shows it), or a look that asks only whether you have it. */
export interface DesktopDone {
  done: true;
  held?: DesktopHold | null;
}

/** What the owner is told of a VM made without a desktop. */
const NO_DESKTOP = "this agent's VM has no desktop: have it made again with one (invincible agents provision <id> --remake --desktop)";
/** What asks only whether a desktop is up, or how to use it, or stops it: none of it needs the room a desktop takes (deskd's ASKING, and stop). */
const DESKTOP_ASKING = new Set(["help", "--help", "-h", "status", "stop"]);
/** How soon a VM that couldn't grow for its desktop is tried again, at the soonest. */
const DESKTOP_ROOM_AGAIN_MS = 60_000;

/** The uid your own session with an agent's desktop runs as, never the agent's (deskd.py's OWNER_UID). */
export const DESKTOP_OWNER_UID = 1001;

/** A hold as deskd says it to your session (seconds; null: you don't have it). */
function holdOf(answer: Record<string, unknown>): DesktopHold | null {
  const h = answer.hold as Record<string, unknown> | null | undefined;
  if (!h || typeof h !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return { since: Math.round(n(h.since) * 1000), idleSec: n(h.idle), mostSec: n(h.most), endsInSec: n(h.ends_in) };
}

/** A hold's window, as the ledger says it. */
const holdSaid = (h: DesktopHold | null): string =>
  h ? `yours until you give it back, or ${Math.round(h.idleSec)} s pass with no input from you (${Math.round(h.mostSec / 60)} min at most)` : "it ended at once";

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The gateway scopes a sandbox's token carries: the model providers asked for, and web search
 * by its own flag. An internal scope (search, git:…) asked for by name is
 * refused, however the request got here.
 */
export function sandboxScopes(input: { network: CreateInput["network"]; providers?: string[]; search?: boolean }): string[] {
  const reserved = (input.providers ?? []).filter(isReservedGatewayScope);
  if (reserved.length) throw new SandboxError(`${reserved.join(", ")}: not a model provider (search is the request's own flag; repositories come from the node)`);
  if (input.network === "isolated") return [];
  return [...(input.providers ?? []), ...(input.search ? [SEARCH_SCOPE] : [])];
}

/** Where a sandbox reads a repository through the git gateway, beside the model gateway (`…/gw`). */
const repositoryUrl = (gateway: string, git: { connector: string; owner: string; repo: string }): string =>
  `${gateway.replace(/\/gw$/, "")}/git/${git.connector}/${git.owner}/${git.repo}.git`;

/**
 * A commit fetched into a sandbox, run there as `python3 -I -c CHECKOUT_SCRIPT <path> <commit>`: the lease is read and
 * removed before anything else, and its token goes to git only as a header of that one fetch (never into the
 * repository's configuration). The commit and up to 50 commits of its history, checked out detached, with no remote.
 */
export const CHECKOUT_SCRIPT = `import json,os,subprocess,sys
root, commit, lease = sys.argv[1], sys.argv[2], os.path.join(os.path.expanduser('~'), '${LEASE_FILE}')
d = json.load(open(lease))
os.remove(lease)
def git(*a):
    try:
        r = subprocess.run(['git','-C',root,*a],capture_output=True,text=True,timeout=540)
    except subprocess.TimeoutExpired:
        sys.exit('git took too long')
    if r.returncode: sys.exit((r.stderr or r.stdout).strip()[-400:] or 'git failed')
    return r.stdout.strip()
os.makedirs(root,exist_ok=True)
git('init','-q')
git('-c','http.extraHeader=Authorization: Bearer '+d['INVINCIBLE_TOKEN'],'fetch','--quiet','--no-tags','--depth','50',d['INVINCIBLE_REPO_URL'],commit)
git('-c','advice.detachedHead=false','checkout','--quiet','--detach','FETCH_HEAD')
head = git('rev-parse','HEAD')
if head != commit: sys.exit('the checkout is at '+head+', not '+commit)
print(head)`;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** How long the lease of model access an agent's VM is given at each preparation lasts (and 500 requests at most). */
export const TEAM_LEASE_MINUTES = 30;

const MAX_OUTPUT = 1024 * 1024;
/** The most of a store's list (MOVE_PY's `list`) the node reads: a line for each of its top-level entries, some hundred thousand of them. */
const LAYOUT_LIST_MAX = 16 * 1024 * 1024;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (size >= max) {
      truncated = true; // keep draining so the process never blocks on a full pipe
      continue;
    }
    const room = max - size;
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (piece.length < chunk.length) truncated = true;
    text += decoder.decode(piece, { stream: true });
    size += piece.length;
  }
  return { text: text + decoder.decode(), truncated };
}

/**
 * A sandbox host: this node runs agents' work in hardened containers.
 * Creating is free (logged); destroying goes through approvals, which lets a
 * run clean up its own ephemeral sandboxes and asks for everything else.
 */
export class SandboxHost {
  private readonly opts: SandboxHostOptions;
  private readonly bin: string;
  /** Sandboxes here are Apple's `container`'s, on a Mac: every one a VM of its own, its /work a volume. */
  private readonly apple: boolean;
  private readonly now: () => number;
  private readonly tokenStore: SandboxTokenStore;
  private readonly moves: LayoutMoves;
  /** Workspaces made for a sandbox that hasn't started yet (so a cleanup never takes them). */
  private readonly creating = new Set<string>();
  /** A seat whose VM is being made: the next ask for that seat waits for it, so two never pass the count at once. */
  private readonly seating = new Map<string, Promise<unknown>>();
  private readonly building = new Map<string, Promise<{ ok: boolean; output: string }>>();
  /** On a Mac: the networks being held up, once at a time (what it does to their helpers must never overlap). */
  private keeping: Promise<void> | null = null;
  /** On a Mac: why a network's keeper couldn't be started the last time it was tried, or null. */
  private unkept: string | null = null;
  /**
   * Each desktop VM's held session (deskd's), with the VM as it was when it began: while the session is open the VM is
   * running, so an action through it isn't preceded by a listing. Ended with the VM; a VM whose image has no deskd
   * (exit 127) is asked again only once it is made again.
   */
  private readonly sessions = new Map<string, { session: DesktopSession; view: SandboxView; owner?: DesktopSession | null }>();
  /** Each desktop VM's stream while you watch it (desktop-stream.ts): one encoder in it however many devices watch; ended with the VM. */
  private readonly streams = new Map<string, DesktopStream>();
  /** When a VM was last grown for its desktop, or tried and couldn't be (ms): desktopRoom tries again a minute on at the soonest. */
  private readonly desktopRoomTried = new Map<string, number>();
  /** What runs in each sandbox now, by its id: commands and terminals (a store isn't moved under them). */
  private readonly busy = new Map<string, number>();
  /**
   * Agents whose store a move to layout 2 may be about to take, or is taking (R5-1): marked before the move's first await,
   * as `sharing` is before a share's, so that neither begins while the other is under way.
   */
  private readonly moving = new Set<string>();
  /** VMs being made to share an agent's store, by its id, counted from before their first await (R5-1). */
  private readonly sharing = new Map<string, number>();
  private engineMajor: Promise<number | null> | null = null;
  /**
   * What each agent's VM was last leased (prepareTeam), by its id: the scopes of its lease, the providers its models are
   * on, its models, whether it may use keys of yours, and its repository. A seat's VM that shares it is leased the same
   * (leaseSeatVm). Never a token: each VM's is its own, minted for it.
   */
  private readonly leased = new Map<string, { scopes: readonly string[]; covered: readonly string[]; models?: readonly string[]; keys: boolean; git?: { connector: string; owner: string; repo: string } }>();

  constructor(opts: SandboxHostOptions) {
    this.apple = opts.engine === "container";
    this.opts = this.apple && !opts.workspaces ? { ...opts, workspaces: new ContainerVolumes((args, timeoutMs) => this.docker(args, timeoutMs), opts.disk) } : opts;
    this.bin = opts.docker ?? (this.apple ? "container" : "docker");
    this.now = opts.now ?? Date.now;
    this.tokenStore = opts.tokenStore ?? memoryTokenStore();
    this.moves = opts.layoutMoves ?? memoryLayoutMoves();
  }

  /** What a sandbox asked for runs as: on a Mac always its own VM (more than a container, never less); with Docker, chooseIsolation's. */
  isolationFor(network: SandboxNetwork, asked: "container" | "vm" | undefined): "container" | "vm" {
    return this.apple ? "vm" : chooseIsolation(network, asked, !!this.opts.microVMs);
  }

  /** The kinds of sandbox made here: a Mac's are all VMs. */
  get kinds(): readonly ("container" | "vm")[] {
    return this.apple ? ["vm"] : this.opts.microVMs ? ["container", "vm"] : ["container"];
  }

  /** The most a sandbox is cut off here: no network at all, or on a Mac, which has no such network, the gateway's alone. */
  get strictest(): SandboxNetwork {
    return this.apple ? "gateway" : "isolated";
  }

  /** Whether a VM here grows while it runs (Kata's take more as they run; a Mac's stop and start again: resizeTeam). */
  get growsLive(): boolean {
    return !this.apple;
  }

  /** Whether a sandbox's CPUs are whole here (a Mac's VM is given whole ones: a part of one is a whole one). */
  get wholeCpus(): boolean {
    return this.apple;
  }

  /** What a VM here takes on top of what it is given: Kata's on Linux, Apple's container's (measured on the Mac mini) on a Mac. */
  get vmOverhead(): VmOverhead {
    return this.apple ? MAC_VM_OVERHEAD : VM_OVERHEAD;
  }

  /** Why this host won't make the sandbox asked for (a Mac: no network at all, an image not built for it), or null. */
  refusal(ask: SandboxAsk): string | null {
    return this.apple ? containerCannot(ask) : null;
  }

  /** A command's arguments in a sandbox, for this host's engine. */
  private commandArgs(id: string, cmd: string[], timeoutSec: number): string[] {
    return this.apple ? containerExecArgs(id, cmd, timeoutSec) : execArgs(id, cmd, timeoutSec);
  }

  /** Removing a sandbox's container (or VM), whatever it is doing. */
  private removeArgs(name: string): string[] {
    return this.apple ? containerDeleteArgs(name) : ["rm", "--force", name];
  }

  private async docker(args: string[], timeoutMs = 60_000, max = MAX_OUTPUT): Promise<Run> {
    // (A stand-in's answer is whole unless it says it was cut, as a read past its cap is.)
    if (this.opts.runner) return { truncated: false, ...(await this.opts.runner(args, timeoutMs)) };
    const proc = Bun.spawn([this.bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([readCapped(proc.stdout, max), readCapped(proc.stderr, max), proc.exited]);
    clearTimeout(timer);
    return { code, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
  }

  async available(): Promise<boolean> {
    if (!this.opts.runner && !Bun.which(this.bin)) return false;
    if (this.apple) {
      // Its service answers when the API server's row is there; a major release this driver doesn't speak is no host.
      const version = parseContainerVersion((await this.docker(containerVersionArgs(), 8000)).stdout);
      return !!version?.running && version.major === CONTAINER_MAJOR;
    }
    return (await this.docker(["info", "--format", "{{.ServerVersion}}"], 8000)).code === 0;
  }

  async status() {
    if (!(await this.available())) return { docker: false, image: false, networks: { gateway: false, online: false } };
    if (this.apple) {
      // (`docker`: its engine answers.)
      const [image, gw, net] = await Promise.all([this.docker(containerImageInspectArgs(DEFAULT_IMAGE)), this.docker(containerNetworkInspectArgs("gateway")), this.docker(containerNetworkInspectArgs("online"))]);
      return { docker: true, image: image.code === 0, networks: { gateway: gw.code === 0, online: net.code === 0 } };
    }
    const [image, gw, net] = await Promise.all([
      this.docker(["image", "inspect", DEFAULT_IMAGE, "--format", "{{.Id}}"]),
      this.docker(["network", "inspect", NETWORKS.gateway.name, "--format", "{{.Id}}"]),
      this.docker(["network", "inspect", NETWORKS.online.name, "--format", "{{.Id}}"]),
    ]);
    return { docker: true, image: image.code === 0, networks: { gateway: gw.code === 0, online: net.code === 0 } };
  }

  /**
   * Idempotent: creates the sandbox networks if missing, and on a Mac holds them up (keepNetworks). (The ledger's
   * resource names are the kinds of thing the primary reads them as, whichever engine.)
   */
  async ensureNetworks(): Promise<void> {
    if (this.apple) {
      this.keeping ??= this.keepNetworks().finally(() => (this.keeping = null));
      return this.keeping;
    }
    for (const kind of ["gateway", "online"] as const) {
      const exists = (await this.docker(["network", "inspect", NETWORKS[kind].name, "--format", "{{.Id}}"])).code === 0;
      if (exists) continue;
      const result = await this.docker(networkCreateArgs(kind));
      if (result.code !== 0) throw new SandboxError(`could not create network ${NETWORKS[kind].name}: ${result.stderr.trim()}`, 500);
      this.opts.ledger({ class: "create", resource: "docker.network", target: NETWORKS[kind].name, verdict: "allow" });
    }
  }

  /**
   * On a Mac: both sandbox networks made if missing, and each held up by its keeper (KEEPERS, the gateway's first),
   * started again if it stopped, made if it isn't there. A keeper that comes up on a network nothing else runs on
   * comes up once that network's helper is restarted, and after one has, container's default network's is too while
   * nothing runs on it: so no network's bridge is ever one a live one holds, nor gets one of theirs later
   * (apple/container#2051). Never made from an image this Mac hasn't got: container would pull whatever that name
   * leads to. A keeper that won't start is said once a sandbox is asked for (readyForVm), not here: at the node's
   * start that would leave it hosting nothing until it next starts.
   */
  private async keepNetworks(): Promise<void> {
    for (const kind of ["gateway", "online"] as const) {
      if ((await this.docker(containerNetworkInspectArgs(kind))).code === 0) continue;
      const result = await this.docker(containerNetworkCreateArgs(kind));
      if (result.code !== 0) throw new SandboxError(`could not create network ${NETWORKS[kind].name}: ${result.stderr.trim()}`, 500);
      this.opts.ledger({ class: "create", resource: "docker.network", target: NETWORKS[kind].name, verdict: "allow", detail: kind === "gateway" ? "host-only (container network create --internal)" : "with a way out (vmnet's NAT): online sandboxes' egress" });
    }
    this.unkept = null;
    if (!(await this.hasImage())) {
      this.unkept = `${DEFAULT_IMAGE} isn't built on this Mac, and the VMs that hold its networks up are made from it: invincible sandbox build`;
      return;
    }
    // What runs, and on which network (null when container couldn't say: never read as "nothing", so no helper is restarted).
    const running = async () => {
      const listed = await this.docker(containerListArgs());
      return (listed.code === 0 ? parseContainers(listed.stdout) : null)?.filter((c) => c.status === "running") ?? null;
    };
    const idle = (now: Awaited<ReturnType<typeof running>>, network: string) => !!now && !now.some((c) => c.networks.includes(network));
    const now = await running();
    let started = false;
    for (const kind of ["gateway", "online"] as const) {
      const name = KEEPERS[kind];
      if (now?.some((c) => c.id === name)) continue;
      if (idle(now, NETWORKS[kind].name)) await this.restartHelper(NETWORKS[kind].name);
      const looked = await this.docker(containerInspectArgs([name]));
      const there = looked.code === 0 && (parseContainers(looked.stdout)?.length ?? 0) > 0;
      const ran = await this.docker(there ? containerStartArgs(name) : containerKeeperArgs(DEFAULT_IMAGE, kind), 120_000);
      if (ran.code !== 0) {
        this.unkept = `the VM that holds the ${NETWORKS[kind].name} network up on this Mac (${name}) won't ${there ? "start" : "make"}: ${redact(ran.stderr.trim() || `exit ${ran.code}`).split("\n")[0]!.slice(0, 300)}`;
        return;
      }
      started = true;
      if (!there) this.opts.ledger({ class: "create", resource: "docker.container", target: name, verdict: "allow", detail: `holds the ${NETWORKS[kind].name} network up on this Mac (1 cpu, 256 MB, nothing running in it)` });
    }
    if (started && idle(await running(), DEFAULT_NETWORK)) await this.restartHelper(DEFAULT_NETWORK);
  }

  /** A network's helper on a Mac, restarted (helperRestartArgs), in the login session's domain or else the user's. */
  private async restartHelper(network: string): Promise<void> {
    const uid = process.getuid?.() ?? 0;
    for (const domain of [`gui/${uid}`, `user/${uid}`]) {
      const args = helperRestartArgs(domain, network);
      const ran = this.opts.launchctl ? await this.opts.launchctl(args, 15_000) : await this.spawn(["/bin/launchctl", ...args], 15_000);
      if (ran.code === 0) return;
    }
    // (Not there to restart, as for a network made a moment ago: then it has no bridge fixed yet either.)
  }

  private async spawn(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([readCapped(proc.stdout, MAX_OUTPUT), readCapped(proc.stderr, MAX_OUTPUT), proc.exited]);
    clearTimeout(timer);
    return { code, stdout: out.text, stderr: err.text };
  }

  /**
   * What every VM start goes through: the networks, and on a Mac its keepers up and its firewall on (mac-firewall.ts),
   * or nothing is made. A bridge a keeper has just brought up has its filter within the helper's next run, so a firewall
   * that says it will be on soon is waited for (two of its runs at most).
   */
  private async readyForVm(): Promise<void> {
    await this.ensureNetworks();
    if (!this.apple) return;
    if (this.unkept) throw new SandboxError(this.unkept, 500);
    const pause = this.opts.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let state = (await this.firewallState())!;
    for (let waited = 0; !state.on && state.soon && waited < 20; waited++) {
      await pause(1_000);
      state = (await this.firewallState())!;
    }
    if (!state.on) throw new SandboxError(`no sandbox is made on this Mac while its firewall isn't on: ${state.why}`, 424);
  }

  /** A Mac's sandbox firewall, as it is now (mac-firewall.ts); null on Linux, whose is invincible-firewall's unit. */
  async firewallState(): Promise<MacFirewallState | null> {
    return this.apple ? (this.opts.firewall ?? (() => macFirewall()))() : null;
  }

  async build(contextDir: string, why?: string, image = DEFAULT_IMAGE): Promise<{ ok: boolean; output: string }> {
    // One build per image at a time: two runs that both find it missing wait for the same build.
    let pending = this.building.get(image);
    if (!pending) {
      pending = (async () => {
        // (A base of its own is in no registry: pulled, it would be looked for on Docker Hub, and the build fail.)
        const pull = !OWN_IMAGES[image]?.base;
        const result = await this.docker(this.apple ? containerBuildArgs(image, contextDir, pull) : ["build", ...(pull ? ["--pull"] : []), "-t", image, contextDir], 60 * 60_000);
        // On a Mac its builder is a VM of its own, left running by the build: stopped once no other build needs it.
        if (this.apple && [...this.building.keys()].every((other) => other === image)) await this.docker(containerBuilderStopArgs(), 60_000);
        this.opts.ledger({
          class: "create",
          resource: "docker.image",
          target: image,
          verdict: "allow",
          ...(result.code === 0 ? (why ? { detail: why } : {}) : { detail: "build failed" }),
        });
        if (result.code === 0) await this.keepImage(image);
        return { ok: result.code === 0, output: (result.code === 0 ? result.stdout : result.stderr).slice(-4000) };
      })().finally(() => this.building.delete(image));
      this.building.set(image, pending);
    }
    return pending;
  }

  private async hasImage(image = DEFAULT_IMAGE): Promise<boolean> {
    return (await this.docker(this.apple ? containerImageInspectArgs(image) : ["image", "inspect", image, "--format", "{{.Id}}"])).code === 0;
  }

  /** Keep every one of the primary's images that's built here. */
  async keepImages(): Promise<void> {
    for (const image of Object.keys(OWN_IMAGES)) await this.keepImage(image);
  }

  /**
   * Keep the sandbox image in use with a stopped container, so image pruning
   * (Coolify's nightly cleanup prunes every unused image) leaves it alone.
   * Idempotent; points the keeper at the image's current build.
   */
  async keepImage(tag = DEFAULT_IMAGE): Promise<boolean> {
    const keeper = OWN_IMAGES[tag]?.keeper;
    // (On a Mac nothing prunes images by itself: no keeper is needed, and container has no network to park one on.)
    if (!keeper || this.apple) return false;
    const image = (await this.docker(["image", "inspect", tag, "--format", "{{.Id}}"])).stdout.trim();
    if (!image) return false;
    const kept = (await this.docker(["container", "inspect", keeper, "--format", "{{.Image}}"])).stdout.trim();
    if (kept === image) return true;
    if (kept) await this.docker(["rm", "--force", keeper]);
    const made = await this.docker(["create", "--name", keeper, "--label", `${LABEL}.keeper=1`, "--network", "none", tag, "true"]);
    return made.code === 0;
  }

  /** Whether sandboxes here get size-limited workspaces. */
  async diskLimited(): Promise<boolean> {
    return !!this.opts.workspaces && (await this.opts.workspaces.available());
  }

  async create(input: CreateInput, seated: CreateOptions = {}): Promise<SandboxView> {
    // (A VM that shares an agent's store is counted from here, before anything is awaited, and none is begun while its move
    // may be about to be: R5-1.)
    if (seated.shares && this.moving.has(seated.shares.sandbox)) throw new SandboxError("that agent's store is being moved to layout 2: nothing shares it until its move is done or put back", 409);
    return seated.shares ? this.sharingWhile(seated.shares.sandbox, () => this.made(input, seated)) : this.made(input, seated);
  }

  /** `fn`, with a VM being made to share `id`'s store counted while it runs: no move of that store begins meanwhile. */
  private async sharingWhile<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.sharing.set(id, (this.sharing.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (this.sharing.get(id) ?? 1) - 1;
      if (left > 0) this.sharing.set(id, left);
      else this.sharing.delete(id);
    }
  }

  private async made(input: CreateInput, seated: CreateOptions): Promise<SandboxView> {
    const providers = sandboxScopes(input);
    // Never weaker than asked: what a Mac can't give (no network at all, an image not built for it) isn't made here.
    const cannot = this.refusal(input);
    if (cannot) throw new SandboxError(cannot, 424);
    if (!(await this.available())) throw new SandboxError(this.apple ? "Apple's container isn't answering on this Mac: its service has to be running (container system start), at a 1.x release" : "docker is not available on this node", 424);
    if (input.cpus > this.opts.maxCpus) throw new SandboxError(`at most ${this.opts.maxCpus} CPUs on this node`);
    if (input.memoryGb > this.opts.maxMemoryGb) throw new SandboxError(`at most ${this.opts.maxMemoryGb} GB memory per sandbox on this node`);
    const isolation = this.isolationFor(input.network, input.isolation);
    if (isolation === "vm" && !this.opts.microVMs) {
      throw new SandboxError("this host can't run microVMs: it needs KVM and Kata Containers, which a deploy with sudo installs", 424);
    }
    const image = input.lab ? LAB_IMAGE : input.hardware ? HARDWARE_IMAGE : input.desktop ? DESKTOP_IMAGE : (input.image ?? DEFAULT_IMAGE);
    const own = OWN_IMAGES[image];
    if (own && !(await this.hasImage(image))) {
      // Gone (pruned) or never built: building it is the primary's to do (create), rather than failing the run.
      if (!this.opts.imageContext) throw new SandboxError(`${image} is not built on this node yet: run \`${buildCommand(image)}\``, 424);
      // Made from others of its own (the desktop from the workshop's, the hardware's from the desktop's): each of those
      // that is gone too, first, the deepest first.
      const missing = [image];
      for (const base of madeFrom(image).slice(0, -1).reverse()) {
        if (await this.hasImage(base)) break;
        missing.unshift(base);
      }
      for (const tag of missing) {
        const built = await this.build(join(this.opts.imageContext, OWN_IMAGES[tag]!.context), "rebuilt: the image was missing when a sandbox was needed", tag);
        if (!built.ok) throw new SandboxError(`${tag} was missing and rebuilding it failed: ${built.output.slice(-300)}`, 424);
      }
    }
    const diskGb = input.diskGb ?? DEFAULT_DISK_GB;
    const maxDiskGb = this.opts.maxDiskGb ?? 200;
    if (diskGb > maxDiskGb) throw new SandboxError(`at most ${maxDiskGb} GB of workspace per sandbox on this node`);
    const limited = await this.diskLimited();
    if (limited) {
      const problem = budgetProblem(await this.opts.workspaces!.stats(), diskGb);
      if (problem) throw new SandboxError(problem, 507);
    }
    if (input.network !== "isolated") await this.readyForVm();

    const id = hex(randomBytes(5));
    const run = input.run ?? `adhoc-${id}`;
    let env: Record<string, string> = {};
    let tokenHash: string | undefined;
    if (providers.length) {
      const minted = this.opts.tokens.mint({
        label: `sandbox:${id}`,
        providers,
        ttlMinutes: input.persistent ? 7 * 24 * 60 : input.ttlMinutes,
        maxRequests: 100_000,
      });
      env = gatewayEnv(minted.token, providers);
      tokenHash = minted.info.hash;
    }
    const spec: SandboxSpec = {
      id,
      run,
      node: this.opts.node,
      image,
      network: input.network,
      cpus: input.cpus,
      memoryGb: input.memoryGb,
      pidsLimit: 1024,
      ttlMinutes: input.ttlMinutes,
      ephemeral: !input.persistent,
      providers,
      createdAt: this.now(),
      env,
      isolation,
      ...(this.opts.resolvConf ? { resolvConf: this.opts.resolvConf } : {}),
      ...(tokenHash ? { tokenHash } : {}),
      ...(seated.seat ? { seat: { id: seated.seat.id, kind: seated.seat.kind } } : {}),
      ...(seated.shares ? { shares: seated.shares } : {}),
      ...(seated.task ? { task: seated.task } : {}),
      // One that shares an agent's workspace has a HOME of its own, empty and in memory: never the agent's (a Linux host's alone).
      ...(seated.shares && !this.apple ? { ownHome: { path: await this.imagePath(image) } } : {}),
    };

    this.creating.add(id);
    try {
      if (seated.shares) {
        // Its /work is an agent's own, which it never makes, sizes or removes.
      } else if (limited) {
        try {
          spec.workspace = await this.opts.workspaces!.create(id, diskGb, { retain: input.persistent && run.startsWith("arm.team.") });
          spec.diskGb = diskGb;
          if (input.persistent && run.startsWith("arm.team.")) {
            if (!this.opts.workspaces!.retain) throw new Error("the workspace helper needs persistent agent support");
            await this.opts.workspaces!.retain!(id);
          }
        } catch (error) {
          if (tokenHash) this.opts.tokens.revoke(tokenHash);
          if (spec.workspace) await this.opts.workspaces!.remove(id).catch(() => {});
          throw new SandboxError(`could not create the workspace: ${(error as Error).message}`, 500);
        }
      } else {
        const volume = await this.docker(["volume", "create", "--label", `${LABEL}=1`, "--label", `${LABEL}.id=${id}`, volumeName(id)]);
        if (volume.code !== 0) throw new SandboxError(`could not create workspace: ${volume.stderr.trim()}`, 500);
      }
      // An agent's own persistent VM, made new: in layout 2, its store's three trees made first (layout.ts), and checked
      // as they are about to be mounted.
      if (input.persistent && run.startsWith("arm.team.") && !seated.shares && (await this.layout2Here(!spec.workspace))) {
        const store = spec.workspace ? { workspace: spec.workspace } : { volume: volumeName(id) };
        const made = await this.layoutRun(store, image, "make", hex(randomBytes(16)));
        const wrong = made.code !== 0 ? redact(made.stderr.trim()).slice(0, 300) : await this.checkTrees(store, image).then(() => null, (error: Error) => error.message);
        if (wrong !== null) {
          if (spec.workspace) await this.opts.workspaces!.remove(id).catch(() => {});
          else await this.docker(["volume", "rm", "-f", volumeName(id)]);
          if (tokenHash) this.opts.tokens.revoke(tokenHash);
          throw new SandboxError(`could not make the agent's store: ${wrong}`, 500);
        }
        spec.layout = { path: await this.imagePath(image) };
      }
      // Nothing shares a store whose move is under way, or about to be: half moved, its root holds neither layout as it
      // should. And what it shares is decided again as it is made (R5-1): its tree in layout 2, the store in layout 1.
      if (seated.shares && (this.moving.has(seated.shares.sandbox) || this.moves.started(seated.shares.sandbox))) {
        if (tokenHash) this.opts.tokens.revoke(tokenHash);
        throw new SandboxError("that agent's store is being moved to layout 2: nothing shares it until its move is done or put back", 409);
      }
      if (seated.shares) {
        try {
          const now = await this.layoutOf(seated.shares.sandbox);
          if ((now === 2) !== Boolean(seated.shares.tree)) throw new SandboxError(`that agent's store is in layout ${now} now, not as this VM was to share it: ask again`, 409);
          if (seated.shares.tree) await this.rootFree(seated.shares.sandbox);
        } catch (error) {
          if (tokenHash) this.opts.tokens.revoke(tokenHash);
          throw error;
        }
      }
      // One that shares an agent's store in layout 2 (another node's task, a run on a seat): its trees checked as they are
      // about to be mounted, as the agent's VM's are.
      if (seated.shares?.tree) {
        const shared = "volume" in seated.shares ? { volume: seated.shares.volume } : { workspace: seated.shares.workspace };
        try {
          await this.checkTrees(shared, (await this.get(seated.shares.sandbox))?.image ?? image);
        } catch (error) {
          if (tokenHash) this.opts.tokens.revoke(tokenHash);
          throw error;
        }
      }
      const args = this.apple ? containerRunArgs(spec) : runArgs(spec);
      let ran = await this.docker(args, 10 * 60_000);
      // A microVM that lost its files as it started (lostItsFiles) is started once more, once the teardown it raced is done.
      if (ran.code !== 0 && lostItsFiles(ran.stderr)) {
        await this.docker(this.removeArgs(containerName(id)));
        await (this.opts.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(2_000);
        ran = await this.docker(args, 10 * 60_000);
      }
      if (ran.code !== 0) {
        await this.docker(this.removeArgs(containerName(id)));
        if (spec.workspace) await this.opts.workspaces!.remove(id).catch(() => {});
        else if (!seated.shares) await this.docker(["volume", "rm", "-f", volumeName(id)]);
        if (tokenHash) this.opts.tokens.revoke(tokenHash);
        throw new SandboxError(`could not start sandbox: ${redact(ran.stderr.trim()).slice(0, 500)}`, 500);
      }
    } finally {
      this.creating.delete(id);
    }
    if (tokenHash) this.tokenStore.put(id, tokenHash);
    const models = providers.filter((p) => p !== SEARCH_SCOPE);
    this.opts.ledger({
      class: "create",
      resource: "docker.container",
      target: containerName(id),
      verdict: "allow",
      run,
      detail: `${isolation === "vm" ? "microVM" : "container"} · ${input.network} · ${input.cpus} cpu · ${input.memoryGb} GB · ${seated.shares ? `the /work of ${containerName(seated.shares.sandbox)}` : spec.workspace ? `${diskGb} GB disk` : "unlimited disk"} · ${image}${seated.seat ? ` · seat ${seated.seat.id}'s home` : ""}${models.length ? ` · models: ${models.join(", ")}` : ""}${providers.includes(SEARCH_SCOPE) ? " · web search" : ""}`,
    });
    return (await this.get(id))!;
  }

  /**
   * Copy a directory out of a sandbox (by default its /work/out) into `dest`, treating
   * what comes out as hostile: see tar.ts. Null when there's nothing there.
   */
  async collect(id: string, from: string, dest: string, limits: ExtractLimits): Promise<CollectResult | null> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("no such sandbox on this node", 404);
    const path = `/${from.split("/").filter(Boolean).join("/")}`;
    if (!/^\/work(\/|$)/.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
      throw new SandboxError("only directories under /work can be kept");
    }
    // A stand-in for Docker has no files to copy out.
    if (this.opts.runner) return null;
    // The VM writes it, by the walk (walk.ts COLLECT_SCRIPT): as hostile as any tar, to the same parser, and never through a
    // link out of /work nor, in a VM whose HOME is its /work, of that HOME (27 November 2026: docker cp followed the links on
    // its path, and took every entry of the folder).
    const proc = Bun.spawn([this.bin, ...(this.apple ? containerCollectArgs(id, path) : collectArgs(id, path))], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 15 * 60_000);
    try {
      return await collectFrom(proc, path, dest, limits);
    } finally {
      clearTimeout(timer);
    }
  }

  async list(): Promise<SandboxView[]> {
    return (await this.listed()) ?? [];
  }

  /** This node's sandboxes as Docker lists them, or null when Docker couldn't say (never mistaken for "none"). */
  async listed(): Promise<SandboxView[] | null> {
    return (await this.inspected())?.map((c) => c.view) ?? null;
  }

  /**
   * This node's sandboxes as Docker lists them, each with its container's own name (an agent's VM set aside as it is made
   * again is `…-replaced`), or null when Docker couldn't say.
   */
  private async inspected(): Promise<{ view: SandboxView; name: string }[] | null> {
    if (!(await this.available())) return null;
    if (this.apple) {
      const listing = await this.docker(containerListArgs());
      const found = listing.code === 0 ? parseContainers(listing.stdout) : null;
      if (!found) return null;
      const usage = await this.workspaceStats();
      return found
        .filter((c) => c.labels[LABEL] === "1" && c.labels[`${LABEL}.node`] === this.opts.node)
        .map((c) => toView(c.labels, c.image, c.status, usage, { ...(c.cpus ? { NanoCpus: c.cpus * 1e9 } : {}), ...(c.memoryBytes ? { Memory: c.memoryBytes } : {}) }))
        .filter((v): v is SandboxView => v !== null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((view) => ({ view, name: view.name }));
    }
    const listing = await this.docker(["ps", "-aq", "--filter", `label=${LABEL}=1`, "--filter", `label=${LABEL}.node=${this.opts.node}`]);
    if (listing.code !== 0) return null;
    const ids = listing.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return [];
    const inspected = await this.docker(["inspect", ...ids]);
    // One removed since the listing (another run's, ending) makes Docker exit 1, and it still prints every other: they
    // are the listing. Any other failure is Docker not saying (listing-race.test.ts).
    const ended = inspected.code !== 0 && inspected.stderr.trim().split("\n").every((line) => /no such object/i.test(line));
    if (inspected.code !== 0 && !ended) return null;
    const containers = JSON.parse(inspected.stdout) as { Name?: string; Config: { Labels: Record<string, string>; Image: string }; State: { Status: string }; HostConfig?: { NanoCpus?: number; Memory?: number } }[];
    const usage = await this.workspaceStats();
    return containers
      .map((c) => {
        const view = toView(c.Config.Labels, c.Config.Image, c.State.Status, usage, c.HostConfig);
        return view ? { view, name: c.Name?.replace(/^\//, "") || view.name } : null;
      })
      .filter((c): c is { view: SandboxView; name: string } => c !== null)
      .sort((a, b) => b.view.createdAt - a.view.createdAt);
  }

  private async workspaceStats(): Promise<WorkspaceStats | null> {
    if (!this.opts.workspaces) return null;
    try {
      return await this.opts.workspaces.stats();
    } catch {
      return null;
    }
  }

  async get(id: string): Promise<SandboxView | null> {
    return (await this.list()).find((s) => s.id === id) ?? null;
  }

  /** Owner/controller only. Resume the exact existing VM and give this run bounded model access. */
  /**
   * An agent's VM, ready for a task: started if it isn't, and given a fresh lease. `providers`: what the lease covers,
   * the providers with a key now (the controller says), so a key added since the VM was made reaches it; absent, what
   * the VM was made with. `models`: a lease good for those models alone (work in sensitive mode, or another node's task
   * on the models its budget counts).
   */
  async prepareTeam(id: string, run: string, git?: { connector: string; owner: string; repo: string }, providers?: readonly string[], models?: readonly string[], keys?: readonly string[]): Promise<SandboxView> {
    const name = containerName(id);
    const found = ((await this.inspected()) ?? []).filter((c) => c.view.id === id);
    let sandbox = found.find((c) => c.name === name)?.view ?? found[0]?.view ?? null;
    if (!sandbox) throw new SandboxError("the agent's VM is missing; its workspace must be recovered, not replaced", 404);
    if (!TeamWorkspaceRun.safeParse(run).success || sandbox.run !== run || sandbox.ephemeral || sandbox.isolation !== "vm") {
      throw new SandboxError("that is not this agent's persistent VM", 403);
    }
    if (sandbox.disk) {
      if (!this.opts.workspaces?.mount || !this.opts.workspaces.retain) throw new SandboxError("update the workspace helper before resuming this agent", 424);
      await this.opts.workspaces.retain(id);
      await this.opts.workspaces.mount(id);
    }
    // One set aside by a move or a remake the node was cut off in (it stopped as the new VM was being made): it gets its
    // name back first, as remakeTeam does; or, where the new one was made, it goes, as a remake's last step would have.
    if (found.some((c) => c.name === `${name}-replaced`)) {
      const named = found.some((c) => c.name === name);
      const settled = named ? await this.docker(["rm", "--force", `${name}-replaced`]) : await this.docker(["rename", `${name}-replaced`, name]);
      if (settled.code !== 0 && !named) throw new SandboxError("the agent's VM is missing; its workspace must be recovered, not replaced", 404);
      sandbox = (await this.get(id)) ?? sandbox;
    }
    // A move the node was cut off at the very end of (its VM made again in layout 2, never said): said now, and done.
    const cut = this.moves.started(id);
    if (cut && (await this.layoutOf(id)) === 2) {
      this.moves.end(id);
      this.saidMoved(id, run, cut.entries, "a move the node was cut off at the end of");
    }
    // Still in layout 1: moved to layout 2 now, while nothing runs in it. One that can't be is put back as it was, and its
    // work goes on in layout 1 (it is tried again at its next prepare). One whose store couldn't be put back (its move is
    // still under way, as the node keeps it) isn't started on that store, whose root is its /work in layout 1: its next
    // prepare takes the move up again.
    // (Docker is asked which layout it is in only where it may be moved, or its move is under way.)
    const here = await this.layout2Here(!sandbox.disk);
    if ((here || this.moves.started(id) !== null) && (await this.layoutOf(id)) === 1) {
      // (Marked as moving before it is asked whether anything shares its store, so nothing begins to share it from then
      // on: a share under way holds the move off instead. The fifth fabric review's R5-1.)
      const mayMove = here && !this.moving.has(id) && !(this.sharing.get(id) ?? 0);
      if (mayMove) this.moving.add(id);
      try {
        if (mayMove && (await this.idle(id))) {
          try {
            await this.moveToLayout2(sandbox, run);
          } catch (error) {
            const why = redact(String((error as Error).message ?? error)).slice(0, 300);
            const half = this.moves.started(id) !== null;
            this.opts.ledger({ class: "modify", resource: "docker.container", target: containerName(id), verdict: "allow", run, detail: half ? `not moved to layout 2, and its store isn't as it was: its VM isn't started on it until a prepare takes the move up again: ${why}` : `not moved to layout 2, so it stays as it was: ${why}` });
            if (half) throw new SandboxError("the agent's store is half moved to layout 2 and couldn't be put back, so its VM isn't started on it: its next prepare takes the move up again", 424);
          }
          sandbox = (await this.get(id)) ?? sandbox;
        } else if (this.moves.started(id) && !here) {
          // Layout 2 turned off since its move began: the move is put back, by its own word, and its work goes on in layout 1.
          await this.putMoveBack(sandbox, run);
        } else if (this.moves.started(id)) {
          throw new SandboxError("the agent's store is half moved to layout 2, so its VM isn't started on it: its next prepare while nothing runs in it takes the move up again", 424);
        }
      } finally {
        if (mayMove) this.moving.delete(id);
      }
    }
    if (sandbox.status !== "running") {
      if (!['exited', 'created'].includes(sandbox.status)) throw new SandboxError(`the agent's VM is ${sandbox.status}`, 409);
      // (On a Mac it rejoins its networks as it starts: they are held up, and its firewall on, first.)
      if (this.apple) await this.readyForVm();
      await this.startTeamVm(sandbox);
    }
    // Fresh credentials are written directly inside the VM, never returned through an API or logged.
    // Revocation and request caps remain real: this is a new lease, not an indefinitely extended token.
    const previous = this.tokenStore.take(id);
    if (previous) this.opts.tokens.revoke(previous);
    const covered = providers ? [...providers] : sandbox.providers;
    // (And the keys of yours its agent may use but never see, key:…, which only the key gateway reads.)
    const scopes = [...covered, ...(git ? [`git:${git.connector}:${git.owner}:${git.repo}`] : []), ...(keys ?? [])];
    const minted = this.opts.tokens.mint({ label: `sandbox:${id}`, providers: scopes, ...(models?.length ? { models: [...models] } : {}), ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
    this.tokenStore.put(id, minted.info.hash);
    const env = gatewayEnv(minted.token, covered, Boolean(keys?.length));
    if (git) env.INVINCIBLE_REPO_URL = repositoryUrl(env.INVINCIBLE_GATEWAY!, git);
    if (!(await this.writeLease(id, env))) {
      this.opts.tokens.revoke(minted.info.hash);
      throw new SandboxError("could not prepare the agent's model access", 424);
    }
    this.leased.set(id, { scopes, covered, ...(models?.length ? { models: [...models] } : {}), keys: Boolean(keys?.length), ...(git ? { git } : {}) });
    this.opts.ledger({ class: "modify", resource: "sandbox.team-ready", target: sandbox.name, verdict: "allow", run, detail: `existing VM resumed; model access capped at ${TEAM_LEASE_MINUTES} minutes and 500 requests${models?.length ? `, for ${models.join(", ")} alone` : ""}` });
    return { ...sandbox, status: "running" };
  }

  /**
   * An agent's VM, its lease kept while its task runs (the controller asks every ten minutes, as the work goes on): the
   * same lease, so whatever holds it (a coding tool's run) works on, valid TEAM_LEASE_MINUTES more and with 500 more
   * requests from now. Whether it was: one that lapsed or was revoked is not brought back.
   */
  async renewTeam(id: string, run: string): Promise<boolean> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("the agent's VM is missing", 404);
    if (!TeamWorkspaceRun.safeParse(run).success || sandbox.run !== run || sandbox.ephemeral || sandbox.isolation !== "vm") {
      throw new SandboxError("that is not this agent's persistent VM", 403);
    }
    const hash = this.tokenStore.peek?.(id) ?? null;
    const renewed = hash !== null && (this.opts.tokens.extend?.(hash, { ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 }) ?? false);
    // (A seat's VM that shares it holds a lease as its own is, with a token of its own: renewed with it, and only then.)
    if (renewed) {
      for (const vm of await this.sharingVms(id)) {
        const own = this.tokenStore.peek?.(vm) ?? null;
        if (own !== null) this.opts.tokens.extend?.(own, { ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
      }
    }
    return renewed;
  }

  /** The VMs on this host that share an agent's VM's workspace, by their own ids (never that VM itself). */
  private async sharingVms(id: string): Promise<string[]> {
    const listed = await this.docker(["ps", "-a", "--filter", `label=${LABEL}=1`, "--filter", `label=${LABEL}.node=${this.opts.node}`, "--filter", `label=${LABEL}.shares=${id}`, "--format", `{{.Label "${LABEL}.id"}}`]);
    return listed.code === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter((vm) => vm && vm !== id) : [];
  }

  /**
   * A seat's VM that shares an agent's workspace, leased as that agent's VM is now (the owner's decision of 27 November
   * 2026: a run on a seat is the agent's own, in its trust domain): the same scopes (its models, and its keys and its
   * repository when it has them), a token of its own, as many minutes and requests, renewed with the agent's (renewTeam)
   * and revoked as the VM goes (destroy). Written in its own HOME, where its commands read it. An agent's VM this
   * process didn't prepare has no lease to share: none is made, and the ledger says so.
   */
  private async leaseSeatVm(vm: SandboxView, agent: string, run: string): Promise<void> {
    const lease = this.leased.get(agent);
    if (!lease) {
      this.opts.ledger({ class: "modify", resource: "sandbox.seat-lease", target: vm.name, verdict: "allow", run, detail: `no lease: ${containerName(agent)} wasn't prepared by this process, so it has none to share` });
      return;
    }
    // (Under the agent's VM's label: what the gateway counts by it is what a task's spend is read by, so what a run on a seat
    // spends through the gateway is its task's, as it was when it used the agent's lease. Its token is its own.)
    const minted = this.opts.tokens.mint({ label: `sandbox:${agent}`, providers: [...lease.scopes], ...(lease.models ? { models: [...lease.models] } : {}), ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
    this.tokenStore.put(vm.id, minted.info.hash);
    const env = gatewayEnv(minted.token, [...lease.covered], lease.keys);
    if (lease.git) env.INVINCIBLE_REPO_URL = repositoryUrl(env.INVINCIBLE_GATEWAY!, lease.git);
    if (!(await this.writeLease(vm.id, env))) {
      // (Removed, which revokes its token: a run on it would find no lease where its commands read one.)
      await this.destroy(vm.id, { run }).catch(() => {});
      throw new SandboxError("could not give the seat's VM its lease, so it was removed", 424);
    }
    this.opts.ledger({ class: "modify", resource: "sandbox.seat-lease", target: vm.name, verdict: "allow", run, detail: `a lease of its own, as ${containerName(agent)}'s is: model access capped at ${TEAM_LEASE_MINUTES} minutes and 500 requests${lease.models ? `, for ${lease.models.join(", ")} alone` : ""}` });
  }

  /** A lease written inside a sandbox, in its HOME (core's LEASE_FILE): JSON, never a shell's configuration. Whether it was. */
  private async writeLease(id: string, env: Record<string, string>): Promise<boolean> {
    const payload = Buffer.from(JSON.stringify(env)).toString("base64");
    // In its HOME: /work in layout 1, its own tree in layout 2, where no VM sharing its workspace reaches it.
    const write = `import os,sys,base64,tempfile; h=os.path.expanduser('~'); f,p=tempfile.mkstemp(prefix='.invincible-gateway-',dir=h); os.write(f,base64.b64decode(sys.argv[1])); os.fsync(f); os.close(f); os.replace(p,os.path.join(h,'${LEASE_FILE}'))`;
    try {
      return (await this.docker(this.commandArgs(id, ["python3", "-I", "-c", write, payload], 30), 45_000)).code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Owner only. A commit of a GitHub repository put in a sandbox that isn't an agent's VM (an eval of your own work's),
   * through the git gateway: a lease for that one repository is written inside the sandbox, where the fetch reads it
   * and removes it (it is in no command, answer or ledger line), and revoked once the fetch is over, whatever happened.
   * The commit and up to 50 commits of its history are checked out at `path`, detached, with no remote: nothing after it.
   */
  async checkoutRepository(id: string, git: { connector: string; owner: string; repo: string }, commit: string, path: string): Promise<{ commit: string }> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("no such sandbox on this node", 404);
    if (!sandbox.ephemeral) throw new SandboxError("an agent's VM is given its repository as it is prepared, not this way", 409);
    if (sandbox.network === "isolated") throw new SandboxError("a sandbox with no network can't reach the git gateway", 409);
    if (sandbox.status !== "running") throw new SandboxError(`sandbox is ${sandbox.status}`, 409);
    const minted = this.opts.tokens.mint({ label: `sandbox:${id}`, providers: [`git:${git.connector}:${git.owner}:${git.repo}`], ttlMinutes: 15, maxRequests: 100 });
    try {
      const { INVINCIBLE_GATEWAY } = gatewayEnv(minted.token, []);
      if (!(await this.writeLease(id, { INVINCIBLE_GATEWAY: INVINCIBLE_GATEWAY!, INVINCIBLE_TOKEN: minted.token, INVINCIBLE_REPO_URL: repositoryUrl(INVINCIBLE_GATEWAY!, git) }))) {
        throw new SandboxError("could not give the sandbox its lease on the repository", 424);
      }
      const fetched = await this.docker(this.commandArgs(id, ["python3", "-I", "-c", CHECKOUT_SCRIPT, path, commit], 600), 615_000);
      if (fetched.code !== 0) {
        const said = redact((fetched.stderr || fetched.stdout).replaceAll(minted.token, "…")).trim().split("\n").at(-1) ?? "";
        throw new SandboxError(`couldn't fetch ${commit.slice(0, 12)} of ${git.owner}/${git.repo}: ${said.slice(0, 300) || `exit ${fetched.code}`}`, 424);
      }
      this.opts.ledger({ class: "read", resource: "sandbox.checkout", target: sandbox.name, verdict: "allow", run: sandbox.run, detail: `${git.owner}/${git.repo} at ${commit.slice(0, 12)} through ${git.connector}, into ${path}; its lease revoked once fetched` });
      return { commit };
    } finally {
      this.opts.tokens.revoke(minted.info.hash);
    }
  }

  /**
   * Owner only. Make an agent's VM again from its image as it is now: the same VM (its id, its `/work`, what it
   * was given), a new container. A VM is made from the image as it was that day, so a fix to the image, or a
   * newer tool in it, reaches an existing agent only this way. The container that was is set aside under
   * another name and removed only once the new one runs; one that won't start is cleared away and the old one
   * is put back as it was. Its network may change with it (a microVM's can't be changed any other way), and its
   * gateway token covers `providers`, as for a VM made today. Everything outside `/work` is the image's again.
   */
  // ---- Layout 2 (layout.ts): an agent's HOME apart from its workspace ----

  /**
   * Which layout an agent's VM is in, as its container's label says (none: 1, as every VM was made before 2). One Docker
   * can't say is in neither (the fifth fabric review's R5-8): taken for layout 1, a VM in layout 2 would be started
   * without its trees checked, moved again, made again on its store's root, or shared by that root. So whatever asked
   * mounts nothing of its store, and says why.
   */
  private async layoutOf(id: string): Promise<1 | 2> {
    const said = await this.docker(["inspect", "--format", `{{index .Config.Labels "${LABEL}.layout"}}`, containerName(id)]);
    const label = said.stdout.trim();
    if (said.code === 0 && label === "2") return 2;
    if (said.code === 0 && (label === "" || label === "<no value>")) return 1;
    const why = said.code !== 0 ? redact(said.stderr).trim().split("\n").at(-1)?.slice(0, 300) || `docker inspect exited ${said.code}` : `its label says ${JSON.stringify(label.slice(0, 40))}`;
    throw new SandboxError(`could not tell which layout the agent's VM is in, so nothing of its store is mounted: ${why}`, 424);
  }

  /** Docker Engine's major version here, asked once: a store on a volume is mounted as its subpaths from 26 on. */
  private async engine(): Promise<number | null> {
    this.engineMajor ??= this.docker(["version", "--format", "{{.Server.Version}}"]).then((said) => {
      const major = said.code === 0 ? Number.parseInt(said.stdout.trim(), 10) : Number.NaN;
      return Number.isFinite(major) ? major : null;
    });
    return this.engineMajor;
  }

  /** Whether layout 2 is switched on here (the node's own setting, as it is now). */
  private layout2On(): boolean {
    return typeof this.opts.layout2 === "function" ? this.opts.layout2() : this.opts.layout2 === true;
  }

  /** Whether an agent's store may be in layout 2 here: told so, on Docker, and on a volume only where subpaths are mounted. */
  private async layout2Here(onVolume: boolean): Promise<boolean> {
    if (!this.layout2On() || this.apple) return false;
    return !onVolume || ((await this.engine()) ?? 0) >= 26;
  }

  /**
   * An agent's store: its Docker volume, or its workspace image's directory on this host, as its container says (in
   * layout 2 its /work is that directory's work tree). Never worked out from its id alone.
   */
  private async storeOf(sandbox: SandboxView): Promise<{ volume: string } | { workspace: string }> {
    if (!sandbox.disk) return { volume: volumeName(sandbox.id) };
    const mounts = await this.docker(["inspect", "--format", "{{json .Mounts}}", containerName(sandbox.id)]);
    let found: { Type?: string; Source?: string; Destination?: string }[] = [];
    try {
      found = mounts.code === 0 ? (JSON.parse(mounts.stdout) as typeof found) : [];
    } catch {
      // (Not JSON: the same as not told.)
    }
    const work = found.find((m) => m.Destination === "/work" && m.Type === "bind")?.Source;
    if (!work?.startsWith("/")) throw new SandboxError("could not tell where this agent's workspace disk is; nothing was changed", 424);
    return { workspace: (await this.layoutOf(sandbox.id)) === 2 && work.endsWith(`/${WORK_TREE}`) ? work.slice(0, -WORK_TREE.length - 1) : work };
  }

  /**
   * MOVE_PY in a one-off container of the store's own, which holds nothing else of the host: its image, its user (uid
   * 1000), no network, no capability, a read-only root, and the whole store at /work (read only for a list or a check).
   * `nonce`: the move's own word (LayoutMove), which a move, its putting back and a store made new are given.
   */
  private async layoutRun(store: { volume: string } | { workspace: string }, image: string, mode: "list" | "check" | "make" | "move" | "back", nonce?: string): Promise<Run> {
    const mount = "volume" in store ? `type=volume,src=${store.volume},dst=/work` : `type=bind,src=${store.workspace},dst=/work`;
    return this.docker(
      ["run", "--rm", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
        "--mount", mode === "list" || mode === "check" ? `${mount},readonly` : mount, image, "python3", "-I", "-c", MOVE_PY, mode, "/work", JSON.stringify(WORKSPACE_OWN), LEASE_FILE, NOTES_DIR, ...(nonce ? [nonce] : [])],
      10 * 60_000,
      mode === "list" ? LAYOUT_LIST_MAX : MAX_OUTPUT,
    );
  }

  /**
   * An agent's store in layout 2, as the host is about to mount its trees (a VM made, made again or started; one that
   * shares its workspace made): MOVE_PY's check, that each of work/, home/ and notes/ is a folder at the store's root, by
   * lstat, never a link nor anything that resolves out of it, and the VMs' user's. Anything else and nothing of it is
   * mounted, so no link the agent left there (its /work was that root in layout 1) is a bind's source on this host.
   */
  private async checkTrees(store: { volume: string } | { workspace: string }, image: string): Promise<void> {
    const checked = await this.layoutRun(store, image, "check");
    if (checked.code === 0) return;
    const why = redact(checked.stderr).trim().split("\n").at(-1)?.slice(0, 300) || `its check exited ${checked.code}`;
    throw new SandboxError(`nothing of the agent's store was mounted: ${why}`, 424);
  }

  /**
   * A store's list as MOVE_PY's `list` says it: read whole, or refused, never in part. Its lines are its top-level
   * entries' names, which the agent chooses, so it is as long as they make it: past LAYOUT_LIST_MAX it is cut, and a list
   * cut is no list. A move whose list is refused waits (it stays in layout 1, and the ledger says why).
   */
  private layoutEntries(listed: Run): LayoutEntry[] {
    if (listed.code !== 0) throw new SandboxError(`could not list the agent's store: ${redact(listed.stderr).split("\n").at(-1)?.slice(0, 300) ?? ""}`, 424);
    if (listed.truncated) throw new SandboxError(`the agent's store lists more than the node reads (${LAYOUT_LIST_MAX / 2 ** 20} MB of its entries' names): it is neither shown in part nor moved`, 424);
    return listed.stdout.trim().split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as LayoutEntry;
      } catch {
        throw new SandboxError("the agent's store's list says what isn't a list", 500);
      }
    });
  }

  /**
   * An agent's VM started again under its own name, its mounts made again as it starts: in layout 2 its store's trees
   * checked first (checkTrees), and it isn't started unless they are the store's own. Throws, saying why, if it isn't.
   */
  private async startTeamVm(sandbox: SandboxView): Promise<void> {
    if (!this.apple && (await this.layoutOf(sandbox.id)) === 2) {
      await this.rootFree(sandbox.id);
      await this.checkTrees(await this.storeOf(sandbox), sandbox.image);
    }
    const started = await this.docker(["start", containerName(sandbox.id)], 120_000);
    if (started.code !== 0) throw new SandboxError(`could not resume the agent's VM: ${redact(started.stderr).slice(0, 300)}`, 424);
  }

  /** What a move to layout 2 would do with an agent's store, by entry name and size: nothing of any file is read. */
  async layoutList(id: string): Promise<LayoutEntry[]> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.ephemeral) throw new SandboxError("that is not an agent's persistent VM", 404);
    return this.layoutEntries(await this.layoutRun(await this.storeOf(sandbox), sandbox.image, "list"));
  }

  /** Whether nothing runs in an agent's VM: no command, no terminal, no desktop session, and no VM sharing its /work. */
  private async idle(id: string): Promise<boolean> {
    if (this.busy.has(id) || this.sessions.has(id) || (this.sharing.get(id) ?? 0) > 0) return false;
    // (Any VM that shares its store, in any state: one stopped would mount the store's root again as it started. R5-1.)
    const sharing = await this.docker(["ps", "-a", "-q", "--filter", `label=${LABEL}.shares=${id}`]);
    return sharing.code === 0 && sharing.stdout.trim() === "";
  }

  /**
   * An agent's store in layout 2 is mounted only where no VM holds its root (R5-1): one that shares it without a tree, made
   * before its move, in any state, could put a link where a tree was as the store was mounted, and the mount would follow
   * it. Throws, saying which, if one does, or if Docker can't say.
   */
  private async rootFree(id: string): Promise<void> {
    const all = await this.docker(["ps", "-a", "--filter", `label=${LABEL}.shares=${id}`, "--format", "{{.Names}}"]);
    const treed = await this.docker(["ps", "-a", "--filter", `label=${LABEL}.shares=${id}`, "--filter", `label=${LABEL}.shares.tree`, "--format", "{{.Names}}"]);
    if (all.code !== 0 || treed.code !== 0) throw new SandboxError("docker couldn't say which VMs share that agent's store, so nothing of it is mounted", 424);
    const withTree = new Set(treed.stdout.split("\n").filter(Boolean));
    const held = all.stdout.split("\n").filter((name) => name && !withTree.has(name));
    if (held.length) throw new SandboxError(`a VM made before that agent's move to layout 2 shares its whole store (${held.slice(0, 3).join(", ")}), and holds its root: nothing of the store is mounted until it is gone`, 409);
  }

  /** An image's own PATH, as it was built: a VM in layout 2 runs with it, followed by its HOME (layoutPath). */
  private async imagePath(image: string): Promise<string> {
    const said = await this.docker(["image", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", image]);
    const path = said.code === 0 ? said.stdout.split("\n").find((line) => line.startsWith("PATH="))?.slice(5) : undefined;
    return layoutPath(path ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  }

  /**
   * An agent's VM in layout 1 moved to layout 2, while nothing runs in it: its store's entries renamed into its two trees
   * (MOVE_PY), and its VM made again on them as it was (remakeTeam, with the store moved between), or put back as it was,
   * its store's entries back where they were. Said in the ledger, and to its owner (`moved`).
   */
  private async moveToLayout2(sandbox: SandboxView, run: string): Promise<void> {
    const store = await this.storeOf(sandbox);
    // A move still under way (one whose store couldn't be put back) is taken up again with its own word, and what its
    // store listed before it began. A new one is given its word here, kept before anything of the store is renamed: never
    // in the store, which the agent's VM writes.
    const underway = this.moves.started(sandbox.id);
    const entries = underway?.entries ?? this.layoutEntries(await this.layoutRun(store, sandbox.image, "list"));
    const nonce = underway?.nonce ?? hex(randomBytes(16));
    if (!underway) this.moves.start(sandbox.id, { nonce, entries });
    let touched = underway !== null;
    try {
      await this.remakeTeam(sandbox.id, run, {
        providers: sandbox.providers.filter((p) => p !== SEARCH_SCOPE),
        approvedBy: "",
        layout: {
          store,
          move: async () => {
            touched = true;
            const moved = await this.layoutRun(store, sandbox.image, "move", nonce);
            if (moved.code !== 0) throw new Error(`its store couldn't be moved: ${redact(moved.stderr).trim().split("\n").at(-1)?.slice(0, 300) ?? ""}`);
          },
          back: async () => {
            const back = await this.layoutRun(store, sandbox.image, "back", nonce);
            if (back.code === 0) this.moves.end(sandbox.id);
            return back.code === 0;
          },
        },
      });
    } catch (error) {
      // (Nothing of its store was renamed: there is no move to take up again.)
      if (!touched) this.moves.end(sandbox.id);
      throw error;
    }
    this.moves.end(sandbox.id);
    this.saidMoved(sandbox.id, run, entries, underway ? "taking up a move that was under way" : null);
  }

  /** An agent's VM moved to layout 2, said once: a line in the ledger, by names and sizes alone, and its owner's notice. */
  private saidMoved(id: string, run: string, entries: readonly LayoutEntry[], how: string | null): void {
    const sum = (to: LayoutEntry["to"]) => entries.filter((e) => e.to === to);
    const notes = sum("notes")[0];
    this.opts.ledger({
      class: "modify",
      resource: "docker.container",
      target: containerName(id),
      verdict: "allow",
      reason: "layout 2: its HOME apart from its workspace, made again at a prepare while nothing ran in it",
      run,
      detail: `made again in layout 2${how ? `, ${how}` : ""} · to its HOME: ${sum("home").length} entries, ${sum("home").reduce((n, e) => n + e.bytes, 0)} bytes · its notes: ${notes ? `${notes.bytes} bytes, to a tree of their own` : "none yet, a tree of their own made for them"} · kept in its workspace: ${sum("work").length} entries · its old lease dropped`,
    });
    this.opts.moved?.(run, entries);
  }

  /**
   * A move under way put back, by its own word, where it can't be taken up (layout 2 was turned off since it began): its
   * store's entries where they were, and its VM as it was, in layout 1. One that can't be put back isn't started on it.
   */
  private async putMoveBack(sandbox: SandboxView, run: string): Promise<void> {
    const move = this.moves.started(sandbox.id)!;
    const back = await this.layoutRun(await this.storeOf(sandbox), sandbox.image, "back", move.nonce);
    if (back.code !== 0) {
      throw new SandboxError(`the agent's store is half moved to layout 2 and couldn't be put back, so its VM isn't started on it: ${redact(back.stderr).trim().split("\n").at(-1)?.slice(0, 300) || `exit ${back.code}`}`, 424);
    }
    this.moves.end(sandbox.id);
    this.opts.ledger({ class: "modify", resource: "docker.container", target: containerName(sandbox.id), verdict: "allow", run, detail: "a move to layout 2 under way was put back, layout 2 being off here now: its store's entries are where they were, and its VM in layout 1" });
  }

  async remakeTeam(
    id: string,
    run: string,
    opts: {
      providers: string[];
      network?: "online" | "gateway";
      desktop?: boolean;
      hardware?: boolean;
      approvedBy: string;
      /**
       * Its store moved to layout 2 as it is made again (moveToLayout2): `move` once it is set aside, `back` if it can't be
       * made (whether its store is as it was again).
       */
      layout?: { store: { volume: string } | { workspace: string }; move(): Promise<void>; back(): Promise<boolean> };
    },
  ): Promise<SandboxView> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("the agent's VM is missing; its workspace must be recovered, not replaced", 404);
    if (!TeamWorkspaceRun.safeParse(run).success || sandbox.run !== run || sandbox.ephemeral || sandbox.isolation !== "vm") {
      throw new SandboxError("that is not this agent's persistent VM", 403);
    }
    // (Not while its store's move is under way, but by that move itself: half moved, its root holds neither layout.)
    if (!opts.layout && this.moves.started(id)) throw new SandboxError("the agent's store is being moved to layout 2: its VM is made again by its next prepare, which takes the move up or puts it back", 409);
    const name = containerName(id);
    const aside = `${name}-replaced`;
    const network = opts.network ?? (sandbox.network === "isolated" ? "gateway" : sandbox.network);
    const providers = sandboxScopes({ network, providers: opts.providers, search: sandbox.providers.includes(SEARCH_SCOPE) });
    // With a desktop or the hardware tools from now on, or without, when asked; else the image it has (by its name: as it
    // is built now).
    const image = remadeImage(sandbox.image, opts);
    const cannot = this.apple ? containerCannot({ desktop: image === DESKTOP_IMAGE || image === HARDWARE_IMAGE }) : null;
    if (cannot) throw new SandboxError(cannot, 424);
    if (!(await this.hasImage(image))) throw new SandboxError(`${image} is not built on this node: run \`${buildCommand(image)}\` first`, 424);
    if (this.apple) {
      // On a Mac: stopped, deleted and made again on the same volume (no rename there), or put back as it was.
      await this.replaceTeamVm(sandbox, run, { image, network, providers, cpus: sandbox.cpus, memoryGb: sandbox.memoryGb });
      this.opts.ledger({
        class: "modify",
        resource: "docker.container",
        target: containerName(id),
        verdict: "approved",
        reason: `approved by ${opts.approvedBy.slice(0, 12)}`,
        run,
        detail: `made again from ${image} as it is now · /work kept · ${network} · ${sandbox.cpus} cpu · ${sandbox.memoryGb} GB`,
      });
      return (await this.get(id))!;
    }
    const ws = this.opts.workspaces;
    if (sandbox.disk && (!ws?.mount || !ws.retain)) throw new SandboxError("update the workspace helper before making this agent's VM again", 424);
    // A remake that was cut short after the old container was set aside left it there: it gets its name back first.
    if ((await this.docker(["inspect", "--format", "{{.Name}}", name])).code !== 0) {
      const back = await this.docker(["rename", aside, name]);
      if (back.code !== 0) throw new SandboxError("the agent's VM is missing; its workspace must be recovered, not replaced", 404);
    }
    let workspace: string | undefined;
    if (sandbox.disk) {
      // Where its disk is on this host, as the container that has it says: never worked out from its id.
      const mounts = await this.docker(["inspect", "--format", "{{json .Mounts}}", name]);
      let found: { Type?: string; Source?: string; Destination?: string }[] = [];
      try {
        found = mounts.code === 0 ? (JSON.parse(mounts.stdout) as typeof found) : [];
      } catch {
        // (Not JSON: the same as not told.)
      }
      workspace = found.find((m) => m.Destination === "/work" && m.Type === "bind")?.Source;
      if (!workspace?.startsWith("/")) throw new SandboxError("could not tell where this agent's workspace disk is; nothing was changed", 424);
      // Kept, whatever becomes of its container.
      await ws!.retain!(id);
    }
    // Made again in the layout it is in, or moved to layout 2 as it is (its PATH as the image it is made from has it).
    const inLayout2 = opts.layout !== undefined || (await this.layoutOf(id)) === 2;
    if (inLayout2 && workspace?.endsWith(`/${WORK_TREE}`) && !opts.layout) workspace = workspace.slice(0, -WORK_TREE.length - 1);
    const layout = inLayout2 ? { path: await this.imagePath(image) } : undefined;
    if (inLayout2) await this.rootFree(id);
    await this.ensureNetworks();

    this.endSession(id);
    // (Stopped, or nothing of it is set aside, moved or made again: a VM still running on its store would see it change. R5-1.)
    const stopped = await this.docker(["stop", "-t", "10", name], 60_000);
    if (stopped.code !== 0 && (await this.get(id))?.status === "running") throw new SandboxError(`could not stop the agent's VM, so it isn't made again: ${redact(stopped.stderr).trim().slice(0, 300)}`, 424);
    let moved = await this.docker(["rename", name, aside]);
    if (moved.code !== 0) {
      // (A remake before this one may have ended with its new VM running and the old container still set aside: that one goes.)
      await this.docker(["rm", "--force", aside]);
      moved = await this.docker(["rename", name, aside]);
    }
    if (moved.code !== 0) {
      const why = redact(moved.stderr).split("\n")[0]!.slice(0, 300);
      const notStarted = sandbox.status === "running" ? await this.startTeamVm(sandbox).then(() => null, (error: Error) => error.message) : null;
      throw new SandboxError(notStarted ? `could not set the agent's VM aside: ${why}; and it isn't started again: ${notStarted}` : `could not set the agent's VM aside, so it is as it was: ${why}`, 424);
    }
    /**
     * The old container under its own name again, running if it was, and its store as it was when it was being moved.
     * One whose store couldn't be put back isn't started: in layout 1 its /work is that store's root, as the move left
     * it, so it waits for its next prepare to take the move up again. Says why it isn't as it was, or null.
     */
    let storeMoved = false;
    const putBack = async (): Promise<string | null> => {
      await this.docker(["rm", "--force", name]);
      const restored = !storeMoved || (await opts.layout!.back());
      await this.docker(["rename", aside, name]);
      if (!restored) return "its store couldn't be put back as it was, so its VM isn't started on it: its next prepare takes the move up again";
      if (sandbox.status !== "running") return null;
      return this.startTeamVm(sandbox).then(
        () => null,
        (error) => (error instanceof SandboxError ? error.message : String(error)),
      );
    };
    let minted: { token: string; hash: string } | undefined;
    try {
      if (sandbox.disk) await ws!.mount!(id);
      if (opts.layout) {
        storeMoved = true;
        await opts.layout.move();
      }
      let env: Record<string, string> = {};
      if (providers.length) {
        const lease = this.opts.tokens.mint({ label: `sandbox:${id}`, providers, ttlMinutes: 7 * 24 * 60, maxRequests: 100_000 });
        env = gatewayEnv(lease.token, providers);
        minted = { token: lease.token, hash: lease.info.hash };
      }
      const spec: SandboxSpec = {
        id,
        run,
        node: this.opts.node,
        image,
        network,
        cpus: sandbox.cpus,
        memoryGb: sandbox.memoryGb,
        pidsLimit: 1024,
        ttlMinutes: Math.max(0, Math.round((sandbox.expiresAt - sandbox.createdAt) / 60_000)),
        ephemeral: false,
        providers,
        createdAt: sandbox.createdAt,
        env,
        isolation: "vm",
        ...(this.opts.resolvConf ? { resolvConf: this.opts.resolvConf } : {}),
        ...(minted ? { tokenHash: minted.hash } : {}),
        ...(workspace && sandbox.disk ? { workspace, diskGb: sandbox.disk.limitGb } : {}),
        ...(layout ? { layout } : {}),
      };
      // (In layout 2, its trees as they are about to be mounted: folders of the store's own, never a link.)
      if (layout) await this.checkTrees(opts.layout?.store ?? (workspace && sandbox.disk ? { workspace } : { volume: volumeName(id) }), image);
      const ran = await this.docker(runArgs(spec), 10 * 60_000);
      if (ran.code !== 0) throw new Error(ran.stderr.trim() || `docker run exited ${ran.code}`);
    } catch (error) {
      const notAsItWas = await putBack();
      if (minted) this.opts.tokens.revoke(minted.hash);
      // (Docker may say the new container's arguments back, and its token is among them.)
      let why = redact(String((error as Error).message ?? error)).split("\n")[0]!.slice(0, 300);
      if (minted) why = why.replaceAll(minted.token, "[its token]");
      throw new SandboxError(notAsItWas ? `could not make the agent's VM again: ${why}; and ${notAsItWas}` : `could not make the agent's VM again, so it is as it was: ${why}`, 424);
    }
    await this.docker(["rm", "--force", aside]);
    const previous = this.tokenStore.take(id);
    if (previous) this.opts.tokens.revoke(previous);
    if (minted) this.tokenStore.put(id, minted.hash);
    // (A move to layout 2 is said by moveToLayout2: it was nobody's word but the layout's.)
    if (!opts.layout) {
      this.opts.ledger({
        class: "modify",
        resource: "docker.container",
        target: name,
        verdict: "approved",
        reason: `approved by ${opts.approvedBy.slice(0, 12)}`,
        run,
        detail: `made again from ${image} as it is now · /work kept · ${network} · ${sandbox.cpus} cpu · ${sandbox.memoryGb} GB${layout ? " · layout 2" : ""}`,
      });
    }
    return (await this.get(id))!;
  }

  /**
   * An agent's VM made bigger while it runs, on the owner's word: more threads and memory (the microVM takes them as it
   * runs, hot-added), and more disk (its workspace grows where it is mounted). Nothing stops and nothing is lost. Never
   * smaller this way: what a running VM was given isn't taken from under it (`remakeTeam` makes it again, and a smaller
   * size takes effect then). `fits` says why what it adds doesn't fit the node's ceiling, or null. Returns it as it is now.
   */
  async resizeTeam(id: string, run: string, opts: { cpus?: number; memoryGb?: number; diskGb?: number; approvedBy: string; why?: string; /** The node's own reason, where it grows a VM itself (its desktop's first use). */ reason?: string; fits?: (more: { cpus: number; memoryGb: number }) => string | null; /** Told when it had to stop and start again to take it (a Mac's VM). */ paused?: () => void }): Promise<SandboxView> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("the agent's VM is missing; its workspace must be recovered, not replaced", 404);
    if (!TeamWorkspaceRun.safeParse(run).success || sandbox.run !== run || sandbox.ephemeral || sandbox.isolation !== "vm") {
      throw new SandboxError("that is not this agent's persistent VM", 403);
    }
    const cpus = opts.cpus ?? sandbox.cpus;
    const memoryGb = opts.memoryGb ?? sandbox.memoryGb;
    const disk = sandbox.disk?.limitGb ?? null;
    if (cpus < sandbox.cpus || memoryGb < sandbox.memoryGb || (opts.diskGb !== undefined && disk !== null && opts.diskGb < disk)) {
      throw new SandboxError(`a running VM only grows (it has ${sandbox.cpus} cpu, ${sandbox.memoryGb} GB${disk !== null ? `, ${disk} GB of disk` : ""}): to give it less, make it again`, 409);
    }
    if (opts.diskGb !== undefined && opts.diskGb !== disk && disk === null) throw new SandboxError("this VM's /work has no size of its own to grow: it was made before workspaces had one", 409);
    const maxDiskGb = this.opts.maxDiskGb ?? 200;
    if (opts.diskGb !== undefined && opts.diskGb > maxDiskGb) throw new SandboxError(`at most ${maxDiskGb} GB of workspace per sandbox on this node`);
    const more = { cpus: cpus - sandbox.cpus, memoryGb: memoryGb - sandbox.memoryGb };
    const grows = disk !== null && opts.diskGb !== undefined && opts.diskGb > disk;
    if (!more.cpus && !more.memoryGb && !grows) return sandbox;
    // (container fixes a volume's size as it makes it, and has no way to change it after.)
    if (grows && this.apple) throw new SandboxError("a VM's disk on a Mac keeps the size it was made with: container fixes a volume's size as it makes it, so it can't grow there yet", 409);
    if (grows) {
      if (!this.opts.workspaces?.grow) throw new SandboxError("update the workspace helper before growing an agent's disk", 424);
      const problem = budgetProblem(await this.opts.workspaces.stats(), opts.diskGb! - disk!);
      if (problem) throw new SandboxError(problem, 507);
    }
    const unfit = more.cpus || more.memoryGb ? (opts.fits?.(more) ?? null) : null;
    if (unfit) throw new SandboxError(unfit, 409);
    const name = containerName(id);
    const record = (now: { cpus: number; memoryGb: number }) =>
      this.opts.ledger({
        class: "modify",
        resource: "docker.container",
        target: name,
        // The primary's own giving (growAgent) is its, and says why; the node's own (a desktop's first use) says why too;
        // anything else was approved by a device of yours.
        verdict: opts.why || opts.reason ? "allow" : "approved",
        reason: opts.reason ? opts.reason.slice(0, 240) : opts.why ? `grown by your agent: ${redact(opts.why).slice(0, 200)}` : `approved by ${opts.approvedBy.slice(0, 12)}`,
        run,
        detail: `${this.apple ? "paused to grow (a Mac's VM can't grow while it runs)" : "grown while it runs"}: ${now.cpus} cpu · ${now.memoryGb} GB${grows ? ` · ${opts.diskGb} GB disk` : disk !== null ? ` · ${disk} GB disk` : ""}`,
      });
    if (this.apple) {
      // A Mac's VM can't take more as it runs: it stops, is made again with more on its own /work, and starts.
      await this.replaceTeamVm(sandbox, run, { image: sandbox.image, network: sandbox.network === "isolated" ? "gateway" : sandbox.network, providers: sandbox.providers, cpus, memoryGb });
      opts.paused?.();
      record({ cpus, memoryGb });
      return (await this.get(id))!;
    }
    // The disk first: it isn't the governor's, so when it can't grow nothing the governor counts has changed, and its
    // giving back (governed-host) is true. Threads and memory after: when they can't be added, the disk has grown, and
    // the ledger and the error both say so.
    if (grows) await this.opts.workspaces!.grow!(id, opts.diskGb!);
    if (more.cpus || more.memoryGb) {
      const memory = `${Math.round(memoryGb * 1024)}m`;
      const updated = await this.docker(["update", "--cpus", String(cpus), "--memory", memory, "--memory-swap", memory, name]);
      if (updated.code !== 0) {
        if (grows) record({ cpus: sandbox.cpus, memoryGb: sandbox.memoryGb });
        throw new SandboxError(`could not give the agent's VM more threads or memory, so they are as they were${grows ? `; its disk did grow, to ${opts.diskGb} GB` : ""}: ${redact(updated.stderr).split("\n")[0]!.slice(0, 300)}`, 424);
      }
    }
    record({ cpus, memoryGb });
    return (await this.get(id))!;
  }

  /**
   * An agent's desktop, from outside its VM, for you (watching it, or taking it over to sign in for it): do one thing
   * there, then bring back a picture of the screen, or none with `picture` false (what you watch shows it). Through your
   * own held session with deskd where the VM's image has take-over (ownerSession): your looks never wait, and your input
   * takes the desktop over if no one has it, so the agent's commands and its looks wait meanwhile; each answer says
   * whether you have it (`held`). Where the image is older, through the agent's held session (deskd); older still, with
   * the VM's own `desktop` command, an exec each. The picture is taken once the screen has settled after an action (and
   * the page a click opened has loaded), never before; a look takes the screen as it is. No port is opened into the VM.
   * Each thing done is a line in the ledger, and so is your taking the desktop over; looking is not (whoever watches asks
   * again every second or two); what is typed is carried to the VM as one argument no shell reads, and the ledger says
   * only how much.
   */
  /**
   * Room for an agent's desktop as it is about to be used (C1 step 10, light by default). An agent's VM is made with 2 GB,
   * desktop or not (COMPUTER_START), so one whose desktop is never used holds of the ceiling what one without a desktop
   * does. Before the first use that may start its desktop (anything but asking whether it is up, how to use it, or
   * stopping it), it is grown, live, to COMPUTER_START.desktopMemoryGb, as a browser needs room. It is never made again
   * for it: where it can't grow (the ceiling has no room, the microVM can't take more), its desktop runs with what the VM
   * has, its work as it was, the ledger says why, and it is tried again a minute later at the soonest. A VM with no limit
   * of its own, or as much already, or not an agent's own, is left as it is.
   */
  private async desktopRoom(sandbox: SandboxView, verb: string): Promise<void> {
    if (this.apple || !sandbox.image.includes("desktop") || DESKTOP_ASKING.has(verb)) return;
    if (!sandbox.run || sandbox.ephemeral || sandbox.isolation !== "vm") return;
    if (!sandbox.memoryGb || sandbox.memoryGb >= COMPUTER_START.desktopMemoryGb) return;
    // (Once grown it has as much, and is left as it is; a view from before reaches resizeTeam, which finds nothing to add.)
    const tried = this.desktopRoomTried.get(sandbox.id);
    if (tried !== undefined && Date.now() - tried < DESKTOP_ROOM_AGAIN_MS) return;
    this.desktopRoomTried.set(sandbox.id, Date.now());
    try {
      await this.resizeTeam(sandbox.id, sandbox.run, {
        memoryGb: COMPUTER_START.desktopMemoryGb,
        approvedBy: "node",
        reason: `its desktop's first use: an agent's VM is made with ${COMPUTER_START.memoryGb} GB and grows to ${COMPUTER_START.desktopMemoryGb} GB as its desktop starts`,
      });
    } catch (error) {
      this.opts.ledger({
        class: "modify",
        resource: "docker.container",
        target: sandbox.name,
        verdict: "deny",
        reason: `its desktop starts with ${sandbox.memoryGb} GB, not grown to ${COMPUTER_START.desktopMemoryGb}: ${redact((error as Error).message).slice(0, 240)}`,
        run: sandbox.run,
        detail: `kept as it is, ${sandbox.cpus} cpu · ${sandbox.memoryGb} GB, its work as it was`,
      });
    }
  }

  async desktop(id: string, run: string, action: DesktopAction, picture = true): Promise<DesktopView | DesktopDone> {
    const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
    const refuse = (why: string): never => { throw new SandboxError(why, 400); };
    let argv: string[] | null = null;
    let did = "";
    switch (action.do) {
      case "look": break;
      case "click":
        if (!whole(action.x, 10_000) || !whole(action.y, 10_000)) refuse("a place on the screen is two whole numbers");
        argv = ["desktop", "click", String(action.x), String(action.y), action.button ?? "left"];
        break;
      case "move":
        if (!whole(action.x, 10_000) || !whole(action.y, 10_000)) refuse("a place on the screen is two whole numbers");
        argv = ["desktop", "move", String(action.x), String(action.y)];
        break;
      case "scroll":
        if (!whole(action.times ?? 1, 50) || (action.times ?? 1) < 1) refuse("scroll takes a whole number of times, from 1 to 50");
        argv = ["desktop", "scroll", action.direction, String(action.times ?? 1)];
        break;
      case "key":
        if (!action.keys.length || action.keys.length > 8 || action.keys.some((k) => !/^[A-Za-z0-9_+]{1,40}$/.test(k))) refuse("keys are names like Return, Tab, Escape, ctrl+l");
        argv = ["desktop", "key", ...action.keys];
        break;
      case "open":
        if (action.address.length > 2000 || !/^(https?:\/\/|file:\/\/|about:)/.test(action.address)) refuse("an address begins with http, https, file or about");
        argv = ["desktop", "open", action.address];
        break;
      case "type":
        if (!action.text.length || action.text.length > 2000) refuse("type takes some text, at most 2,000 characters");
        argv = ["desktop", "type", action.text];
        did = `type (${action.text.length} characters, not recorded)`;
        break;
    }
    const sandbox = await this.desktopVm(id, run);
    await this.desktopRoom(sandbox, action.do);
    const ledger = (detail: string) => this.opts.ledger({ class: "modify", resource: "sandbox.desktop", target: sandbox.name, verdict: "allow", run, detail });
    const what = did || redact(argv?.slice(1).join(" ") ?? "").slice(0, 300);
    /** The action and the picture on a held session, in one exchange: yours, with whether you have the desktop. */
    const through = async (session: DesktopSession, yours: boolean): Promise<DesktopView | DesktopDone> => {
      let said: Record<string, unknown> | null = null;
      if (argv) {
        const done = await session.call({ argv: argv.slice(1) }, 75_000);
        // (Taken before it acted: said whether or not the action then did what it was asked.)
        if (yours && done.took) ledger(`took over its desktop by your input: ${holdSaid(holdOf(done))}`);
        if (done.code !== 0) throw new SandboxError(`the desktop could not do that: ${redact(String(done.stderr ?? "").trim().split("\n").at(-1) ?? "").replace(/^desktop: /, "").slice(0, 300) || `exit ${done.code}`}`, done.code === 2 ? 400 : 424);
        ledger(what);
        said = done;
      }
      if (!picture) {
        if (yours) said ??= await session.call({ name: "hold" }, 75_000);
        return { done: true, ...(yours ? { held: holdOf(said!) } : {}) };
      }
      const shot = await session.call({ name: "screenshot", input: { format: "jpeg", settle: argv !== null } }, 75_000);
      const image = shot.image as { media_type: string; data: string; width: number; height: number } | undefined;
      if (!shot.ok || !image) throw new SandboxError(`the desktop could not show its screen: ${String(shot.error ?? "no picture").slice(0, 300)}`, 424);
      return { shot: { mediaType: image.media_type === "image/png" ? "image/png" : "image/jpeg", data: image.data }, width: image.width, height: image.height, ...(yours ? { held: holdOf(shot) } : {}) } as DesktopView;
    };
    // (What you watch shows your input at 25 frames a second for 2 s, from now.)
    if (argv) this.streams.get(sandbox.id)?.fast();
    const owner = this.ownerSession(sandbox);
    if (owner) {
      try {
        return await through(owner, true);
      } catch (error) {
        if (!this.olderThanTakeOver(sandbox.id, owner, error)) throw error;
      }
    }
    const session = this.desktopSession(sandbox);
    if (session) {
      try {
        return await through(session, false);
      } catch (error) {
        // A session that ended before it ever answered was none (an image older than deskd): asked the old way.
        if (!(error instanceof SessionEnded) || session.answered) throw error;
      }
    }
    /** Why the VM's command failed, as the owner should read it. */
    const failed = (ran: Run): never => {
      if (ran.code === 127 || /desktop: (command )?not found/.test(ran.stderr)) throw new SandboxError(NO_DESKTOP, 424);
      throw new SandboxError(`the desktop could not do that: ${redact(ran.stderr.trim().split("\n").at(-1) ?? "").slice(0, 300) || `exit ${ran.code}`}`, 424);
    };
    if (argv) {
      // (Typed text as base64 to a line of Python there, which hands it to the command as one argument.)
      const asRun = action.do === "type" ? ["python3", "-I", "-c", "import base64,subprocess,sys; sys.exit(subprocess.run(['desktop','type',base64.b64decode(sys.argv[1]).decode()]).returncode)", Buffer.from(action.text, "utf8").toString("base64")] : argv;
      const ran = await this.docker(this.commandArgs(id, asRun, 60), 75_000);
      if (ran.code !== 0) failed(ran);
      ledger(what);
    }
    if (!picture) return { done: true };
    const shot = await this.docker(this.commandArgs(id, ["sh", "-c", 'f="${TMPDIR:-/tmp}/watch-$$.jpg"; desktop shot "$f" >/dev/null && base64 -w0 "$f"; code=$?; rm -f "$f"; exit $code'], 60), 75_000);
    if (shot.code !== 0 || !shot.stdout.trim()) failed(shot);
    return { shot: { mediaType: "image/jpeg", data: shot.stdout.trim() }, width: 1280, height: 800 };
  }

  /**
   * You take an agent's desktop over (`take`), or give it back, through your own session with deskd (C1 step 9): while
   * you have it, the agent's desktop commands and its looks wait, and are told so (deskd.py's hold). It ends when you give
   * it back, after 120 s with no input from you, or after 15 min at most; a second take starts a fresh window. Whether
   * you have it after; the ledger says each. Refused where the VM's image is older than take-over.
   */
  async desktopHold(id: string, run: string, take: boolean): Promise<DesktopHold | null> {
    const sandbox = await this.desktopVm(id, run);
    if (take) await this.desktopRoom(sandbox, "take");
    const desk = sandbox.image.includes("desktop");
    const older = new SandboxError(desk ? "this agent's desktop is older than take-over: have its VM made again (invincible agents provision <id> --remake --desktop)" : NO_DESKTOP, 424);
    const owner = desk ? this.ownerSession(sandbox) : null;
    if (!owner) throw older;
    let answer: Record<string, unknown>;
    try {
      answer = await owner.call({ name: take ? "take" : "release" }, 75_000);
    } catch (error) {
      if (this.olderThanTakeOver(sandbox.id, owner, error)) throw older;
      throw error;
    }
    if (!answer.ok) throw new SandboxError(`the desktop could not do that: ${redact(String(answer.error ?? "")).slice(0, 300)}`, 424);
    const hold = holdOf(answer);
    const ledger = (detail: string) => this.opts.ledger({ class: "modify", resource: "sandbox.desktop", target: sandbox.name, verdict: "allow", run, detail });
    if (take) ledger(`took over its desktop: ${holdSaid(hold)}`);
    else if (answer.released) ledger("gave its desktop back");
    return hold;
  }

  /**
   * You watch an agent's desktop (C1 step 9): its frames (core's desktop-frames.ts), from one `desktop stream` in its VM
   * however many of your devices watch, given once the first keyframe is in them (desktop-stream.ts). `signal`: whoever
   * asked went away. Nothing is written down: watching is looking. Refused with how it ended where the encoder ends
   * before it shows anything (an image older than the stream: exit 2).
   */
  async desktopWatch(id: string, run: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const sandbox = await this.desktopVm(id, run);
    if (this.apple || !sandbox.image.includes("desktop")) throw new SandboxError(NO_DESKTOP, 424);
    await this.desktopRoom(sandbox, "stream");
    // (An engine run by tests has a stream only where they give one.)
    if (this.opts.runner && !this.opts.spawnFrames) throw new SandboxError("this node streams no desktop: its engine is a stand-in", 424);
    let stream = this.streams.get(id);
    if (!stream) {
      const spawn = this.opts.spawnFrames ?? spawnFrames(this.bin);
      stream = new DesktopStream(() => {
        const proc = spawn(["exec", "--interactive", containerName(id), "desktop", "stream"]);
        void proc.exited.finally(this.streaming(id));
        return proc;
      });
      this.streams.set(id, stream);
    }
    try {
      return await stream.watch(signal);
    } catch (error) {
      if (error instanceof StreamEnded) throw new SandboxError(`${error.message}${error.code === 2 ? ": a desktop older than its stream has none (have its VM made again: invincible agents provision <id> --remake --desktop), or its encoder couldn't start" : ""}`, 424);
      throw new SandboxError((error as Error).message, 504);
    }
  }

  /** A VM's encoder began (one, however many watch): how to say it ended. Nothing here; the governed host counts it as work in the VM. */
  protected streaming(_id: string): () => void {
    return () => {};
  }

  /** An agent's own running persistent VM, its desktop asked of from outside it (by you alone: the routes that ask are yours). */
  private async desktopVm(id: string, run: string): Promise<SandboxView> {
    const held = this.sessions.get(id);
    const sandbox = held?.session.open ? held.view : await this.get(id);
    if (!sandbox) throw new SandboxError("the agent's VM is missing", 404);
    if (!TeamWorkspaceRun.safeParse(run).success || sandbox.run !== run || sandbox.ephemeral || sandbox.isolation !== "vm") throw new SandboxError("that is not this agent's persistent VM", 403);
    if (sandbox.status !== "running") throw new SandboxError(`the agent's VM is ${sandbox.status}`, 409);
    return sandbox;
  }

  /**
   * Your own held session with a VM's desktop (C1 step 9): an exec of its own as DESKTOP_OWNER_UID, never the agent's
   * uid, on deskd's owner socket, where deskd counts it as yours: your looks never wait, your input takes the desktop
   * over, and only it takes the desktop over or gives it back. deskd runs as the agent, started by the agent's own
   * session: that one is opened beside yours if it isn't open, with a word that never waits, and yours waits for deskd.
   * Null where the VM has no agent's session (a Mac, an image older than deskd), or its image was found older than
   * take-over.
   */
  private ownerSession(sandbox: SandboxView): DesktopSession | null {
    const agent = this.desktopSession(sandbox);
    const held = agent ? this.sessions.get(sandbox.id) : undefined;
    if (!agent || !held || held.owner === null) return null;
    if (!agent.open) void agent.call({ argv: ["status"] }, 75_000).catch(() => {});
    const spawn = this.opts.spawnSession ?? spawnSession(this.bin);
    held.owner ??= new DesktopSession(() => spawn(["exec", "--interactive", "--user", `${DESKTOP_OWNER_UID}:${DESKTOP_OWNER_UID}`, "--workdir", "/", containerName(sandbox.id), "desktop", "--owner-session"]));
    return held.owner;
  }

  /**
   * Whether your session's failing says the VM's image is older than take-over (its `desktop` takes no --owner-session,
   * exit 2, or there is none, 127: it never answered), noted so: yours go the agent's way until it is made again. Any
   * other end before it answered (on an image that has take-over, or later, deskd gone from under it) is an error to try
   * again, never the agent's way: what you do is never done unheld.
   */
  private olderThanTakeOver(id: string, owner: DesktopSession, error: unknown): boolean {
    if (!(error instanceof SessionEnded)) return false;
    if (!owner.answered && (error.code === 2 || error.code === 127)) {
      const held = this.sessions.get(id);
      if (held?.owner === owner) held.owner = null;
      return true;
    }
    throw new SandboxError(`your session with this desktop ended before it answered (exit ${error.code}): try again`, 503);
  }

  /**
   * The VM's held desktop session, begun with the VM as it is now (null on a Mac, which makes no desktop, and for a
   * VM whose image was found to have no deskd).
   */
  private desktopSession(sandbox: SandboxView): DesktopSession | null {
    // (An engine run by tests has a session only where they give one.)
    if (this.apple || (this.opts.runner && !this.opts.spawnSession)) return null;
    const held = this.sessions.get(sandbox.id);
    if (held) {
      // An image older than deskd (no `desktop`, or the one that takes no --session) is asked the old way until it is made again.
      if (!held.session.answered && (held.session.ended === 127 || held.session.ended === 2)) return null;
      held.view = sandbox;
      return held.session;
    }
    const spawn = this.opts.spawnSession ?? spawnSession(this.bin);
    const session = new DesktopSession(() => spawn(["exec", "--interactive", "--workdir", "/work", containerName(sandbox.id), "desktop", "--session"]));
    this.sessions.set(sandbox.id, { session, view: sandbox });
    return session;
  }

  /** A VM's held desktop sessions ended, the agent's and yours, and its stream, as the VM did (removed, stopped, made again). */
  private endSession(id: string): void {
    const held = this.sessions.get(id);
    held?.session.close();
    held?.owner?.close();
    this.sessions.delete(id);
    this.streams.get(id)?.close();
    this.streams.delete(id);
  }

  async exec(id: string, cmd: string[], timeoutSec = 600): Promise<ExecResult> {
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    try {
      return await this.execNow(id, cmd, timeoutSec);
    } finally {
      const left = (this.busy.get(id) ?? 1) - 1;
      if (left > 0) this.busy.set(id, left);
      else this.busy.delete(id);
    }
  }

  private async execNow(id: string, cmd: string[], timeoutSec: number): Promise<ExecResult> {
    // The VM's own `desktop` command alone goes to its held session where it has one: the same command, its answer
    // the same, in milliseconds; while the session is open the VM is running, so no listing comes first.
    const held = cmd[0] === "desktop" && cmd.length > 1 ? this.sessions.get(id) : undefined;
    const sandbox = held?.session.open ? held.view : await this.get(id);
    if (!sandbox) throw new SandboxError("no such sandbox on this node", 404);
    if (sandbox.status !== "running") throw new SandboxError(`sandbox is ${sandbox.status}`, 409);
    const started = performance.now();
    let result: Run | null = null;
    if (cmd[0] === "desktop" && cmd.length > 1 && sandbox.image.includes("desktop")) {
      await this.desktopRoom(sandbox, String(cmd[1]));
      const session = this.desktopSession(sandbox);
      try {
        const done = session ? await session.call({ argv: cmd.slice(1) }, timeoutSec * 1000) : null;
        if (done) result = { code: Number(done.code ?? 1), stdout: String(done.stdout ?? ""), stderr: String(done.stderr ?? done.error ?? ""), truncated: false };
      } catch (error) {
        // (One that ended before it answered was no session: the command is run as any other.)
        if (!(error instanceof SessionEnded) || session?.answered) result = { code: 1, stdout: "", stderr: `desktop: ${(error as Error).message}\n`, truncated: false };
      }
    }
    result ??= await this.docker(this.commandArgs(id, cmd, timeoutSec), (timeoutSec + 15) * 1000);
    this.opts.ledger({
      class: "modify",
      resource: "sandbox.exec",
      target: sandbox.name,
      verdict: "allow",
      run: sandbox.run,
      detail: `${truncateLedgerDetail(redact(cmd.join(" ")))} → exit ${result.code}`,
    });
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.round(performance.now() - started),
      truncated: result.truncated,
    };
  }

  /**
   * A shell in a running sandbox on a terminal of its own, for its owner: `docker exec --tty` under a pseudo-terminal
   * here, so what runs there (an editor, a vendor's sign-in, a coding tool's screen) has a real terminal. Killing it
   * hangs up what it started in the sandbox too (TERMINAL_HANG_UP). Not ledgered here: whoever keeps the terminal
   * says when it opened and closed, and never what was typed or shown.
   */
  async terminal(id: string, size: { cols: number; rows: number }, onData: (bytes: Uint8Array) => void): Promise<{ name: string; run: string | null; process: TerminalProcess }> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("no such sandbox on this node", 404);
    if (sandbox.status !== "running") throw new SandboxError(`sandbox is ${sandbox.status}`, 409);
    const tag = hex(randomBytes(8));
    const shell = (this.opts.spawnTerminal ?? spawnTerminal)([this.bin, ...(this.apple ? containerTerminalArgs(id, tag) : terminalArgs(id, tag))], size, onData);
    // (Open, it counts as something running there: a store isn't moved under a terminal.)
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    void shell.exited.finally(() => {
      const left = (this.busy.get(id) ?? 1) - 1;
      if (left > 0) this.busy.set(id, left);
      else this.busy.delete(id);
    });
    const hangUp = () => void this.docker(this.commandArgs(id, ["sh", "-c", TERMINAL_HANG_UP, "hang-up", tag], 30), 45_000).catch(() => {});
    return {
      name: sandbox.name,
      run: sandbox.run || null,
      process: {
        write: (data) => shell.write(data),
        resize: (cols, rows) => shell.resize(cols, rows),
        kill: () => {
          shell.kill();
          hangUp();
        },
        exited: shell.exited,
      },
    };
  }

  /**
   * Destroy through approvals. `approvedBy` is set when the owner asked for it
   * directly (their request *is* the approval); autonomous callers pass a run.
   */
  /**
   * A VM for a seat (core's seats.ts), from the pinned tools' image: the seat's home mounted (made the first time and given
   * to the VMs' user), for its sign-in or for a run on it, and then sharing an agent's own /work. A seat's home is in no
   * more VMs at once than it takes (`runs`: D4); one more is refused, never made. On a Linux host with Docker alone: a
   * Mac's volumes are disk images only one VM may mount.
   */
  async createSeatVm(input: SeatVmInput): Promise<SandboxView> {
    if (this.apple) throw new SandboxError("a seat's VM is made on a Linux host with Docker", 424);
    const before = this.seating.get(input.seat.id);
    const work = (async () => {
      await before?.catch(() => {});
      const using = await this.seatVms(input.seat.id);
      if (using === null) throw new SandboxError("docker couldn't say which VMs have this seat's home, so none was made", 503);
      if (using.length >= input.seat.runs) throw new SandboxError(`this seat's home is in use (${using.length} VM${using.length === 1 ? "" : "s"}, and it takes ${input.seat.runs} at once): it waits`, 409);
      await this.seatHome(input.seat.id);
      // A run on a seat is the agent's own work: in layout 2 its notes' tree too, never its HOME. (Counted as sharing the
      // store from before its layout is asked, so no move begins under it: R5-1.)
      const seated = async () => {
        const shared = input.shares ? await this.sharedWork(input.shares) : undefined;
        const shares = shared?.tree ? { ...shared, notes: true as const } : shared;
        return this.create(
          { network: input.network, image: HARNESS_IMAGE, cpus: input.cpus, memoryGb: input.memoryGb, ttlMinutes: input.ttlMinutes, persistent: false, run: input.run },
          { seat: input.seat, ...(shares ? { shares } : {}) },
        );
      };
      if (input.shares && this.moving.has(input.shares)) throw new SandboxError("that agent's store is being moved to layout 2: nothing shares it until its move is done or put back", 409);
      const vm = input.shares ? await this.sharingWhile(input.shares, seated) : await seated();
      if (input.shares) await this.leaseSeatVm(vm, input.shares, input.run);
      return vm;
    })();
    this.seating.set(input.seat.id, work);
    try {
      return await work;
    } finally {
      if (this.seating.get(input.seat.id) === work) this.seating.delete(input.seat.id);
    }
  }

  /**
   * A VM of its own for another node's task (the owner's decision of 27 November 2026, the fabric's R3-1 (a)), made like a
   * seat's VM: from the agent's VM's image, as big as it and on its network, sharing the agent's workspace alone (its work/
   * tree: never its HOME, nor its notes) with a HOME of its own in memory; leased the task's models alone (never your keys,
   * nor its repository), renewed with the agent's (renewTeam); labelled with its task. It goes as the task ends (destroy),
   * and with it whatever the task started there; one an earlier process left is swept as its node starts. On a Linux host
   * with Docker, beside an agent's VM in layout 2: one whose HOME is its /work would share that HOME. A Mac refuses (no VM
   * there shares a workspace).
   */
  async createTaskVm(input: TaskVmInput, signal?: AbortSignal): Promise<SandboxView> {
    if (this.apple) throw new SandboxError("another node's task is taken only on a Linux host with Docker: on a Mac no VM shares an agent's workspace", 424);
    if (this.moving.has(input.shares)) throw new SandboxError("that agent's store is being moved to layout 2: nothing shares it until its move is done or put back", 409);
    // (Counted as sharing the store from before its layout is asked, so no move begins under it: R5-1.)
    const vm = await this.sharingWhile(input.shares, async () => {
      const own = await this.get(input.shares);
      if (!own || own.ephemeral) throw new SandboxError("another node's task shares an agent's own VM on this host, and that one is not here", 404);
      const shares = await this.sharedWork(input.shares);
      if (!shares.tree) {
        throw new SandboxError(
          this.layout2On()
            ? "another node's task shares only an agent's workspace, and this agent's VM has no HOME apart from it yet (layout 2): it is moved at its next prepare while nothing runs in it"
            : "another node's task shares only an agent's workspace, and layout 2 (a HOME apart from it) is off on this node: invincible sandbox layout on",
          409,
        );
      }
      // (A task that ends while its VM waits for room leaves the queue: none is made for it then. The fourth review's I-2.)
      return this.create(
        { network: own.network, image: own.image, cpus: own.cpus, memoryGb: own.memoryGb, ttlMinutes: input.ttlMinutes, persistent: false, run: input.run, isolation: own.isolation },
        { shares, task: input.task, ...(signal ? { signal } : {}) },
      );
    });
    // (Under the agent's VM's label, which its task's spend and budget are counted by. Its token is its own.)
    const minted = this.opts.tokens.mint({ label: `sandbox:${input.shares}`, providers: [...input.providers], models: [...input.models], ttlMinutes: TEAM_LEASE_MINUTES, maxRequests: 500 });
    this.tokenStore.put(vm.id, minted.info.hash);
    if (!(await this.writeLease(vm.id, gatewayEnv(minted.token, [...input.providers])))) {
      // (Removed, which revokes its token: its commands would find no lease where they read one.)
      await this.destroy(vm.id, { run: input.run }).catch(() => {});
      throw new SandboxError("could not give another node's task's VM its lease, so it was removed", 424);
    }
    this.opts.ledger({ class: "modify", resource: "sandbox.task-lease", target: vm.name, verdict: "allow", run: input.run, detail: `another node's task ${input.task}: a VM of its own beside ${containerName(input.shares)}, sharing its workspace alone; model access capped at ${TEAM_LEASE_MINUTES} minutes and 500 requests, for ${input.models.join(", ") || "no model"} alone` });
    return vm;
  }

  /**
   * A VM's lease ended now, whatever becomes of the VM (another node's task's, as its task ends: the fourth fabric
   * review's R4-7): its token revoked and forgotten here, so renewTeam, which renews only a token this host still holds,
   * never renews it again. A VM that then can't be removed spends nothing more of yours.
   */
  endLease(id: string): void {
    const hash = this.tokenStore.take(id);
    if (hash) this.opts.tokens.revoke(hash);
    this.leased.delete(id);
  }

  /** The VMs on this host made for other nodes' tasks, in any state, by their own ids: null when docker can't say. */
  async taskVms(): Promise<string[] | null> {
    const listed = await this.docker(["ps", "-a", "--filter", `label=${LABEL}=1`, "--filter", `label=${LABEL}.node=${this.opts.node}`, "--filter", `label=${LABEL}.task`, "--format", `{{.Label "${LABEL}.id"}}`]);
    return listed.code === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : null;
  }

  /** The VMs on this host that have a seat's home, in any state (a stopped one still holds it), by their own ids: null when docker can't say. */
  async seatVms(seat: string): Promise<string[] | null> {
    const listed = await this.docker(["ps", "-a", "--filter", `label=${LABEL}=1`, "--filter", `label=${LABEL}.node=${this.opts.node}`, "--filter", `label=${LABEL}.seat=${seat}`, "--format", `{{.Label "${LABEL}.id"}}`]);
    return listed.code === 0 ? listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : null;
  }

  /** A seat's home: made the first time, and given to the VMs' user (uid 1000), with nothing else of the host in reach. */
  private async seatHome(seat: string): Promise<void> {
    const name = seatVolumeName(seat);
    if ((await this.docker(["volume", "inspect", name])).code === 0) return;
    const made = await this.docker(["volume", "create", "--label", `${LABEL}=1`, "--label", `${LABEL}.seat=${seat}`, "--label", `${LABEL}.node=${this.opts.node}`, name]);
    if (made.code !== 0) throw new SandboxError(`could not make this seat's home: ${redact(made.stderr.trim()).slice(0, 300)}`, 500);
    // (A new volume is root's: a one-off container, with no network and only the capabilities to hand it over, makes it the VMs' user's alone.)
    const given = await this.docker(["run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges:true", "--mount", `type=volume,src=${name},dst=/home-of-seat`, DEFAULT_IMAGE, "sh", "-c", "chown 1000:1000 /home-of-seat && chmod 0700 /home-of-seat"], 120_000);
    if (given.code !== 0) {
      await this.docker(["volume", "rm", name]);
      throw new SandboxError(`could not give this seat's home to the VMs' user: ${redact(given.stderr.trim()).slice(0, 300)}`, 500);
    }
  }

  /** Where an agent's VM on this host has its /work, as its container says: never worked out from its id. */
  private async sharedWork(id: string): Promise<NonNullable<SandboxSpec["shares"]>> {
    const sandbox = await this.get(id);
    if (!sandbox || sandbox.ephemeral) throw new SandboxError("a run on a seat shares an agent's own VM on this host, and that one is not here", 404);
    const mounts = await this.docker(["inspect", "--format", "{{json .Mounts}}", containerName(id)]);
    let found: { Type?: string; Source?: string; Name?: string; Destination?: string }[] = [];
    try {
      found = mounts.code === 0 ? (JSON.parse(mounts.stdout) as typeof found) : [];
    } catch {
      // (Not JSON: the same as not told.)
    }
    const work = found.find((m) => m.Destination === "/work");
    // An agent's VM in layout 2: its workspace's tree alone, never its HOME (its /work is already that tree's directory).
    const layout2 = (await this.layoutOf(id)) === 2;
    if (work?.Type === "volume" && work.Name === volumeName(id)) return { sandbox: id, volume: work.Name, ...(layout2 ? { tree: WORK_TREE } : {}) };
    // (A workspace image's in layout 2: its /work is its work tree's directory, and the store is the one it is in.)
    if (work?.Type === "bind" && work.Source?.startsWith("/")) return layout2 && work.Source.endsWith(`/${WORK_TREE}`) ? { sandbox: id, workspace: work.Source.slice(0, -WORK_TREE.length - 1), tree: WORK_TREE } : { sandbox: id, workspace: work.Source };
    throw new SandboxError("could not tell where that agent's /work is; nothing was made", 424);
  }

  /**
   * A process in one of this host's sandboxes that runs while it's wanted, its stdin open and its stdout read as lines
   * (a seat's sign-in, which waits for you): under the same deadline as any command (execArgs' timeout). The ledger says
   * that it ran and where, never what it was told.
   */
  async stream(id: string, cmd: string[], timeoutSec: number): Promise<SandboxStream> {
    if (this.apple) throw new SandboxError("a process that runs while it's wanted is made on a Linux host with Docker", 424);
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("no such sandbox on this node", 404);
    if (sandbox.status !== "running") throw new SandboxError(`sandbox is ${sandbox.status}`, 409);
    this.opts.ledger({ class: "modify", resource: "sandbox.stream", target: sandbox.name, verdict: "allow", run: sandbox.run, detail: truncateLedgerDetail(redact(cmd.slice(0, 2).join(" ").slice(0, 120))) });
    return (this.opts.spawnStream ?? spawnStream)([this.bin, ...execArgs(id, cmd, timeoutSec)]);
  }

  /** Remove a seat's home, and the sign-in its tool keeps there: never while a VM has it. */
  async removeSeatHome(seat: string): Promise<void> {
    if (this.apple) return;
    const using = await this.seatVms(seat);
    if (using === null) throw new SandboxError("docker couldn't say which VMs have this seat's home, so it was kept", 503);
    if (using.length) throw new SandboxError("a VM has this seat's home: its run ends first", 409);
    const name = seatVolumeName(seat);
    if ((await this.docker(["volume", "inspect", name])).code !== 0) return;
    const removed = await this.docker(["volume", "rm", name]);
    if (removed.code !== 0) throw new SandboxError(`could not remove this seat's home: ${redact(removed.stderr.trim()).slice(0, 300)}`, 500);
    this.opts.ledger({ class: "delete", resource: "docker.volume", target: name, verdict: "allow", detail: "a seat you removed: its home, and the sign-in its tool kept there" });
  }

  async destroy(id: string, opts: { approvedBy?: string; run?: string } = {}): Promise<Decision> {
    const sandbox = await this.get(id);
    if (!sandbox) throw new SandboxError("no such sandbox on this node", 404);
    const decision: Decision = opts.approvedBy
      ? { verdict: "allow", reason: `approved by ${opts.approvedBy.slice(0, 12)}` }
      : decide({
          class: "delete",
          resource: "docker.container",
          target: sandbox.name,
          createdBy: { run: sandbox.run, ephemeral: sandbox.ephemeral },
          ...(opts.run ? { run: opts.run } : {}),
        });
    if (decision.verdict !== "allow") {
      this.opts.ledger({
        class: "delete",
        resource: "docker.container",
        target: sandbox.name,
        verdict: decision.verdict,
        reason: decision.reason,
        run: sandbox.run,
      });
      return decision;
    }
    this.endSession(id);
    await this.docker(this.apple ? containerDeleteArgs(containerName(id)) : ["rm", "--force", "--volumes", containerName(id)]);
    if (sandbox.disk) {
      const ws = this.opts.workspaces;
      const remove = opts.approvedBy && !sandbox.ephemeral && ws?.removeRetained ? ws.removeRetained.bind(ws) : ws?.remove.bind(ws);
      await remove?.(id).catch((error) => this.opts.ledger({ class: "delete", resource: "sandbox.workspace", target: id, verdict: "allow", detail: `not removed: ${(error as Error).message}` }));
    }
    else await this.docker(this.apple ? containerVolumeDeleteArgs(id) : ["volume", "rm", "--force", volumeName(id)]);
    const tokenHash = this.tokenStore.take(id);
    if (tokenHash) this.opts.tokens.revoke(tokenHash);
    this.leased.delete(id);
    this.opts.ledger({
      class: "delete",
      resource: "docker.container",
      target: sandbox.name,
      verdict: opts.approvedBy ? "approved" : "allow",
      reason: decision.reason,
      run: sandbox.run,
    });
    return decision;
  }

  /** Clean up expired ephemeral sandboxes on behalf of the runs that created them. */
  async reap(): Promise<string[]> {
    const now = this.now();
    const reaped: string[] = [];
    const sandboxes = await this.list();
    for (const sandbox of sandboxes) {
      if (!sandbox.ephemeral || sandbox.expiresAt > now) continue;
      const decision = await this.destroy(sandbox.id, { run: sandbox.run });
      if (decision.verdict === "allow") reaped.push(sandbox.name);
    }
    // A workspace whose sandbox is gone (its container removed by hand, a crash mid-create) holds
    // disk for nothing: its data was the sandbox's, which no longer exists.
    const stats = await this.workspaceStats();
    if (stats) {
      const alive = await this.aliveIds();
      for (const image of stats.images) {
        // Any primary container on this Docker counts (another node or a test may share the host), and a
        // young workspace may belong to a sandbox that is still starting in another process.
        if (image.retained || !alive || alive.has(image.id) || this.creating.has(image.id) || now - image.createdAt < 10 * 60_000) continue;
        await this.opts.workspaces!.remove(image.id).catch(() => {});
        this.opts.ledger({ class: "delete", resource: "sandbox.workspace", target: image.id, verdict: "allow", reason: "cleaning up the workspace of a sandbox that no longer exists" });
        reaped.push(`workspace ${image.id}`);
      }
    }
    return reaped;
  }

  /** The ids of every invincible sandbox the engine has, any node's; null when it couldn't say (never read as "none"). */
  private async aliveIds(): Promise<Set<string> | null> {
    if (this.apple) {
      const listing = await this.docker(containerListArgs());
      const found = listing.code === 0 ? parseContainers(listing.stdout) : null;
      return found ? new Set(found.filter((c) => c.labels[LABEL] === "1").map((c) => c.labels[`${LABEL}.id`] ?? "")) : null;
    }
    const listed = await this.docker(["ps", "-a", "--filter", `label=${LABEL}=1`, "--format", `{{.Label "${LABEL}.id"}}`]);
    return listed.code === 0 ? new Set(listed.stdout.split("\n").map((s) => s.trim())) : null;
  }

  /**
   * An agent's VM on a Mac made again as `next`, its /work kept. container can't change a container that exists, nor
   * rename one, so the old one is stopped and deleted (its /work is a volume of its own, made to be kept, which
   * stays), and the new one is made under the same name on the same volume. What ran in it stops, so it paused.
   * One that won't start is cleared away, and the old one is made again as it was (from its image's name, with a
   * fresh lease for what it had) and the error says so. The token store keeps the lease it runs with after.
   */
  private async replaceTeamVm(sandbox: SandboxView, run: string, next: { image: string; network: "online" | "gateway"; providers: string[]; cpus: number; memoryGb: number }): Promise<void> {
    const id = sandbox.id;
    const name = containerName(id);
    const asWas = { image: sandbox.image, network: sandbox.network === "isolated" ? "gateway" as const : sandbox.network, providers: sandbox.providers, cpus: sandbox.cpus, memoryGb: sandbox.memoryGb };
    const made: string[] = [];
    /** Run it as `as`, with a lease of its own; the lease's hash, or the error. */
    const runAs = async (as: typeof next): Promise<{ hash?: string; error?: string }> => {
      let env: Record<string, string> = {};
      let minted: { token: string; hash: string } | undefined;
      if (as.providers.length) {
        const lease = this.opts.tokens.mint({ label: `sandbox:${id}`, providers: as.providers, ttlMinutes: 7 * 24 * 60, maxRequests: 100_000 });
        env = gatewayEnv(lease.token, as.providers);
        minted = { token: lease.token, hash: lease.info.hash };
      }
      const spec: SandboxSpec = {
        id,
        run,
        node: this.opts.node,
        image: as.image,
        network: as.network,
        cpus: as.cpus,
        memoryGb: as.memoryGb,
        pidsLimit: 1024,
        ttlMinutes: Math.max(0, Math.round((sandbox.expiresAt - sandbox.createdAt) / 60_000)),
        ephemeral: false,
        providers: as.providers,
        createdAt: sandbox.createdAt,
        env,
        isolation: "vm",
        ...(minted ? { tokenHash: minted.hash } : {}),
        ...(sandbox.disk ? { workspace: volumeName(id), diskGb: sandbox.disk.limitGb } : {}),
      };
      const ran = await this.docker(containerRunArgs(spec), 10 * 60_000);
      if (ran.code === 0) return minted ? { hash: minted.hash } : {};
      await this.docker(containerDeleteArgs(name));
      if (minted) this.opts.tokens.revoke(minted.hash);
      // (container may say the new VM's arguments back, and its lease is among them.)
      let why = redact(ran.stderr.trim() || `container run exited ${ran.code}`).split("\n")[0]!.slice(0, 300);
      if (minted) why = why.replaceAll(minted.token, "[its lease]");
      return { error: why };
    };
    // Its volume is never an orphan's while this runs (the reaper skips what is being made).
    this.creating.add(id);
    try {
      await this.readyForVm();
      await this.docker(containerStopArgs(name), 60_000);
      const removed = await this.docker(containerDeleteArgs(name));
      if (removed.code !== 0) {
        if (sandbox.status === "running") await this.docker(["start", name], 120_000);
        throw new SandboxError(`could not set the agent's VM aside, so it is as it was: ${redact(removed.stderr).split("\n")[0]!.slice(0, 300)}`, 424);
      }
      const now = await runAs(next);
      if (now.error) {
        const back = await runAs(asWas);
        if (back.error) throw new SandboxError(`could not make the agent's VM again (${now.error}), nor put it back as it was (${back.error}): its /work is kept, in ${volumeName(id)}`, 424);
        if (sandbox.status !== "running") await this.docker(containerStopArgs(name), 60_000);
        made.push(...(back.hash ? [back.hash] : []));
        throw new SandboxError(`could not make the agent's VM again, so it is as it was: ${now.error}`, 424);
      }
      made.push(...(now.hash ? [now.hash] : []));
    } finally {
      this.creating.delete(id);
      // The lease it runs with now (new, or the one it was put back with) is the one the store keeps.
      if (made.length) {
        const previous = this.tokenStore.take(id);
        if (previous) this.opts.tokens.revoke(previous);
        this.tokenStore.put(id, made[0]!);
      }
    }
  }
}

/** Where Kata's shim may be: on containerd's PATH (installed by scripts/remote-setup.sh). */
const KATA_SHIMS = ["/usr/local/bin/containerd-shim-kata-v2", "/usr/bin/containerd-shim-kata-v2"];

/** Whether this machine can run sandboxes as KVM microVMs: /dev/kvm and Kata's shim. */
export function microVMsAvailable(exists: (path: string) => boolean = existsSync): boolean {
  return process.platform === "linux" && exists("/dev/kvm") && KATA_SHIMS.some((path) => exists(path));
}

/** Cheap readiness probe for capability reporting (no side effects). */
export async function probeSandbox(bin = "docker"): Promise<{ image: boolean; networks: boolean; vm: boolean; images: string[] } | null> {
  if (!Bun.which(bin)) return null;
  const check = async (args: string[]) => {
    try {
      const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => proc.kill(), 8000);
      const code = await proc.exited;
      clearTimeout(timer);
      return code === 0;
    } catch {
      return false;
    }
  };
  if (!(await check(["info", "--format", "{{.ServerVersion}}"]))) return null;
  const [image, gw] = await Promise.all([
    check(["image", "inspect", DEFAULT_IMAGE, "--format", "{{.Id}}"]),
    check(["network", "inspect", NETWORKS.gateway.name, "--format", "{{.Id}}"]),
  ]);
  // (Which of its images it makes: every one its release knows, built when a sandbox first needs it.)
  return { image, networks: gw, vm: microVMsAvailable(), images: Object.keys(OWN_IMAGES) };
}

/** What a Mac's sandbox host is, as its capabilities say it: every sandbox a VM, what it won't make, and its VMs don't grow live. */
export interface ContainerHostCaps {
  image: boolean;
  networks: boolean;
  vm: true;
  engine: "container";
  cannot: Unmade[];
  grows: false;
  images: string[];
}

/**
 * Cheap readiness probe of Apple's container on a Mac (no side effects): its version and whether its service answers
 * (`system version`: the API server's row is there only then), and when it does, at a release this node speaks, the
 * host it makes. Null: no container here.
 */
export async function probeContainer(runner?: DockerRunner, bin = "container"): Promise<{ container: { version: string | null; running: boolean }; sandbox: ContainerHostCaps | null } | null> {
  if (!runner && !Bun.which(bin)) return null;
  const run = runner ?? runnerOf(bin);
  let version: ReturnType<typeof parseContainerVersion> = null;
  try {
    version = parseContainerVersion((await run(containerVersionArgs(), 8000)).stdout);
  } catch {
    /* it didn't answer */
  }
  const container = { version: version?.version ?? null, running: !!version?.running };
  if (!version?.running || version.major !== CONTAINER_MAJOR) return { container, sandbox: null };
  const [image, gw, net] = await Promise.all([run(containerImageInspectArgs(DEFAULT_IMAGE), 8000), run(containerNetworkInspectArgs("gateway"), 8000), run(containerNetworkInspectArgs("online"), 8000)]);
  return { container, sandbox: { image: image.code === 0, networks: gw.code === 0 && net.code === 0, vm: true, engine: "container", cannot: [...CONTAINER_UNMADE], grows: false, images: [...CONTAINER_IMAGES] } };
}

/**
 * The most of a collect's stderr the node keeps: what the walk says of what it left out (COLLECT_SKIPPED_MAX lines at most,
 * and a count) fits well within it. Past it, the rest is drained and never kept, and the collect says it was cut.
 */
export const COLLECT_STDERR_MAX = 512 * 1024;

/** A collect's result: the extractor's, with what the walk left out beside what the extractor refused. */
export interface CollectResult extends ExtractResult {
  /** How many were left out in all, when that is more than `skipped` names (the walk names a thousand, and counts the rest). */
  skippedCount?: number;
  /** The VM said more of what it left out than the node reads (COLLECT_STDERR_MAX): more may be left out than counted. */
  skippedCut?: true;
}

/** A collect's process, as the node reads it: its tar on stdout, the walk's words on stderr, and its end. */
export interface CollectProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

/**
 * A collect read as the node reads it (SandboxHost.collect): its tar into the extractor, within `limits`, and what the
 * walk says on its stderr (collectSkipped) beside what the extractor refused. Null: no such folder there.
 */
export async function collectFrom(proc: CollectProcess, path: string, dest: string, limits: ExtractLimits): Promise<CollectResult | null> {
  const [result, err, code] = await Promise.all([
    extractTar(proc.stdout, dest, limits, 1).catch((error: Error) => {
      proc.kill();
      throw error;
    }),
    // (Within its cap, the rest drained and never kept: the VM writes it, so it says what it likes, as much as it likes.)
    readCapped(proc.stderr, COLLECT_STDERR_MAX),
    proc.exited,
  ]);
  if (code !== 0) {
    if (code === COLLECT_MISSING) return null;
    if (code === COLLECT_REFUSED) throw new SandboxError(`${path} isn't kept: it is outside the workspace, or what the agent's tools keep for themselves`, 403);
    throw new SandboxError(`could not copy ${path}: ${redact(err.text.trim()).slice(0, 300)}`, 500);
  }
  // What the VM couldn't read, named with why (collectSkipped): in the artifact's skipped list, never left out in silence;
  // past those it names, how many more; and its words cut, said to be.
  const walk = collectSkipped(err.text);
  const skipped = [...result.skipped, ...walk.named];
  return {
    ...result,
    skipped,
    ...(walk.more || err.truncated ? { skippedCount: skipped.length + walk.more } : {}),
    ...(err.truncated ? { skippedCut: true as const } : {}),
  };
}

/** The binary's commands, spawned: what each prints, and its exit code. */
const runnerOf =
  (bin: string): DockerRunner =>
  async (args, timeoutMs) => {
    const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    // (Within the cap of every engine command's answer, the rest drained: a binary's words are no more than that.)
    const [out, code] = await Promise.all([readCapped(proc.stdout, MAX_OUTPUT), proc.exited]);
    clearTimeout(timer);
    return { code, stdout: out.text, stderr: "" };
  };

/**
 * On a Mac: container's service started, when it is installed and stopped. It doesn't start itself at boot (the Mac
 * mini found it stopped after macOS updated itself and restarted, 17 November 2026), and a node there hosts nothing
 * until it runs. It never fetches a kernel (`invincible sandbox setup` does, the app's step 3, with the owner): without
 * one the service runs and no VM starts. "running": it was; "started"; "failed"; null: no container here.
 */
export async function startContainerService(runner?: DockerRunner, bin = "container"): Promise<"running" | "started" | "failed" | null> {
  const found = await probeContainer(runner, bin);
  if (!found) return null;
  if (found.container.running) return "running";
  const started = await (runner ?? runnerOf(bin))(containerSystemStartArgs(false), 90_000);
  return started.code === 0 && (await probeContainer(runner, bin))?.container.running ? "started" : "failed";
}

const LEDGER_DETAIL_LIMIT = 400;

/** Keep a long command's start and end for the ledger, with a note of how many characters were omitted. */
function truncateLedgerDetail(command: string): string {
  if (command.length <= LEDGER_DETAIL_LIMIT) return command;
  const note = (omitted: number) => `…[${omitted} characters omitted]…`;
  // The note's size depends on the omitted count's digit count: settle it in a couple of passes.
  let omitted = command.length - LEDGER_DETAIL_LIMIT;
  for (let i = 0; i < 3; i++) omitted = command.length - (LEDGER_DETAIL_LIMIT - note(omitted).length);
  const kept = LEDGER_DETAIL_LIMIT - note(omitted).length;
  const head = Math.floor(kept / 2);
  const tail = kept - head;
  return command.slice(0, head) + note(omitted) + command.slice(command.length - tail);
}

function toView(labels: Record<string, string>, image: string, status: string, usage: WorkspaceStats | null, held?: { NanoCpus?: number; Memory?: number }): SandboxView | null {
  const id = labels[`${LABEL}.id`];
  if (!id || labels[LABEL] !== "1") return null;
  // A VM may have been grown since its labels were written: what Docker holds it to now, and its workspace's size as
  // the helper has it, say what it is (its labels, what it was made with, where those can't be had).
  const workspace = usage?.images.find((i) => i.id === id);
  const labelled = Number(labels[`${LABEL}.disk`]);
  // (A workspace only grows: never less than it was made with.)
  const limit = labelled > 0 && workspace ? Math.max(labelled, Math.round(workspace.sizeBytes / 2 ** 30)) : labelled;
  const used = workspace?.usedBytes;
  return {
    id,
    name: containerName(id),
    node: labels[`${LABEL}.node`] ?? "",
    run: labels[`${LABEL}.run`] ?? "",
    image,
    network: (labels[`${LABEL}.network`] ?? "isolated") as SandboxView["network"],
    cpus: held?.NanoCpus ? held.NanoCpus / 1e9 : Number(labels[`${LABEL}.cpus`] ?? 0),
    memoryGb: held?.Memory ? Math.round((held.Memory / 2 ** 30) * 100) / 100 : Number(labels[`${LABEL}.memory`] ?? 0),
    createdAt: Number(labels[`${LABEL}.created`] ?? 0),
    expiresAt: Number(labels[`${LABEL}.expires`] ?? 0),
    status,
    ephemeral: labels[`${LABEL}.ephemeral`] !== "false",
    providers: (labels[`${LABEL}.providers`] ?? "").split(",").filter((p) => p),
    disk: limit > 0 ? { limitGb: limit, usedGb: used === undefined ? null : Math.round((used / 2 ** 30) * 10) / 10 } : null,
    isolation: labels[`${LABEL}.isolation`] === "vm" ? "vm" : "container",
    // (Its seat's label is set by createSeatVm alone: never by a route.)
    ...(labels[`${LABEL}.seat`] ? { seat: labels[`${LABEL}.seat`] } : {}),
    ...(labels[`${LABEL}.task`] ? { task: labels[`${LABEL}.task`] } : {}),
  };
}
