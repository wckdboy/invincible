import { type SandboxNetwork, type SeatKind, VM_BUN_CACHE, VM_GATES, VM_GATES_USER, VM_HOME, VM_WORK } from "@invincible/core";
import { GATE_VM_ENV } from "./gate.ts";
import { cacheMount } from "./install-cache.ts";
import { HOME_TREE, LAYOUT_ENV, NOTES_TREE, VM_NOTES, WORK_TREE } from "./layout.ts";
import { collectCommand } from "./walk.ts";

/*
 * A sandbox is where an agent works: an unprivileged, resource-capped container
 * with its own workspace and nothing else of the host. This module is pure: it
 * turns a spec into `docker` arguments, so the security posture is unit-tested.
 */

export const LABEL = "dev.invincible";
export const DEFAULT_IMAGE = "invincible/sandbox:1";
/**
 * Kata Containers' shim: the container runs inside its own KVM microVM with its own kernel.
 * Docker finds `containerd-shim-kata-v2` on containerd's PATH, so Docker's config never changes.
 */
export const KATA_RUNTIME = "io.containerd.kata.v2";
/** Port of the sandbox-only model gateway listener on the gateway network's bridge IP. */
export const SANDBOX_GATEWAY_PORT = 7402;

/**
 * gateway: Docker `--internal` network: no route out; the only reachable host
 *          service is the sandbox gateway (UFW allows just that port on inv0).
 * online:  ordinary bridge with egress, plus the gateway network for models.
 * Inter-container traffic is disabled on both, so sandboxes cannot reach each other.
 */
export const NETWORKS = {
  gateway: { name: "invincible-gw", bridge: "inv0", subnet: "172.31.248.0/24", gateway: "172.31.248.1", internal: true },
  online: { name: "invincible-net", bridge: "inv1", subnet: "172.31.247.0/24", gateway: "172.31.247.1", internal: false },
} as const;

export interface SandboxSpec {
  id: string;
  run: string;
  node: string;
  image: string;
  network: SandboxNetwork;
  cpus: number;
  memoryGb: number;
  pidsLimit: number;
  ttlMinutes: number;
  ephemeral: boolean;
  providers: string[];
  createdAt: number;
  env: Record<string, string>;
  tokenHash?: string;
  /** Host path of a size-limited workspace (see workspaces.ts); without one, /work is an unlimited Docker volume. */
  workspace?: string;
  /** The workspace's limit, when it has one. */
  diskGb?: number;
  /** container: the host's kernel · vm: its own KVM microVM (Kata). */
  isolation: "container" | "vm";
  /**
   * A microVM can't use Docker's embedded DNS (127.0.0.11 is the guest's own loopback), so an online
   * VM gets this resolv.conf: the host's upstream resolvers, read-only.
   */
  resolvConf?: string;
  /**
   * A VM made for a seat (a run on it, its status check, or its sign-in): the seat's home mounted, and its tool told where
   * (seatEnv). `signsIn`: the VM made for its sign-in, the only one whose mount of a Gemini seat's sealed sign-in is
   * writable (seatSealed).
   */
  seat?: { id: string; kind: SeatKind; signsIn?: true };
  /** A VM made for another node's task (createTaskVm): its own, removed as the task ends, by the task it is for. */
  task?: string;
  /**
   * A VM for a round of that task's gates (createGateVm): made beside its task's VM, with no network and no lease, and no
   * process of the task's ever in it (gate.ts). Its environment says so (GATE_VM_ENV), which the sweep between its gates
   * asks before it runs.
   */
  gate?: true;
  /** The node's install cache's folder on its host (install-cache.ts), mounted read-only into a round of gates' VM alone. */
  cache?: string;
  /**
   * The agent's VM another node's task's VM is made beside (createTaskVm), sharing nothing of it: its lease is renewed with
   * that agent's, and that agent's VM isn't idle while it is there (no move to layout 2 begins under the task's work).
   */
  beside?: string;
  /**
   * A VM made for an agent's run: that agent's own /work (its volume, or its workspace's path on this host), never one of
   * its own. Removing this VM leaves it as it was: it has no disk of its own to remove.
   */
  shares?: ({ sandbox: string; volume: string } | { sandbox: string; workspace: string }) & {
    /** The agent's store is in layout 2 (layout.ts): its workspace's tree alone is mounted, never its HOME. */
    tree?: typeof WORK_TREE;
    /**
     * And its notes' tree, where they are kept in this VM's own HOME (VM_NOTES): a run on a seat of yours, which is the
     * agent's own work. Never another node's task. With `tree` alone: in layout 1 its notes are in the /work it shares.
     */
    notes?: true;
  };
  /**
   * Layout 2 (layout.ts): its store's three trees mounted on their own, work/ at /work, home/ at its HOME and notes/
   * where its notes are kept in it (VM_NOTES), which its environment names (LAYOUT_ENV), with `path` its PATH
   * (layoutPath). Absent: layout 1, /work its HOME too.
   */
  layout?: { path: string };
  /**
   * A HOME of its own, empty and in memory, at /home/agent (a VM that shares an agent's workspace, a run on a seat's, and
   * another node's task's own VM): never the agent's, whose sign-ins and lease its tools would otherwise find there, nor a
   * workspace. Its environment and PATH (`path`, layoutPath) follow it, as layout 2's do.
   */
  ownHome?: { path: string };
}

/** A stopped container that keeps the sandbox image in use, so image pruning (Coolify's nightly cleanup) leaves it alone. */
export const KEEPER = "invincible-sandbox-image";

/** The Lab: mathematics, physics and engineering tools (sandbox/lab/Dockerfile). */
export const LAB_IMAGE = "invincible/lab:1";

/** The agents' desktop: the workshop with a display, a window manager and a browser (sandbox/desktop/Dockerfile). Built after the workshop image, which it is made from. */
export const DESKTOP_IMAGE = "invincible/desktop:1";
/**
 * The hardware tools (C1 step 11): the desktop with KiCad and FreeCAD (sandbox/hardware/Dockerfile), a choice per agent.
 * Built after the desktop image, which it is made from. Its name says "desktop", as the desktop's does: whatever asks
 * whether a VM has one reads the name (the node, its controller, the web app, a release older than this image), and
 * this one has.
 */
export const HARDWARE_IMAGE = "invincible/desktop-hardware:1";
/** Claude Code in the workshop image, for evals alone (sandbox/claude-code): tagged by its pinned release. */
export const CLAUDE_CODE_IMAGE = "invincible/claude-code:2.1.319";
/**
 * The vendors' own coding tools in the workshop image, pinned (sandbox/harnesses): where every run of Claude Code, Codex
 * or Antigravity is made, on a seat or through the gateway. Tagged by the releases it pins, so a new pin is a new image.
 */
export const HARNESS_IMAGE = "invincible/harnesses:claude-2.1.326.codex-0.172.0.agy-1.5.18";
/** The pins it holds, as the tools say their versions (`--version`): what readiness names. */
export const HARNESS_PINS = { claude: "2.1.326", codex: "0.172.0", agy: "1.5.18" } as const;

/**
 * The primary's own images: where each is built from (under the sandbox directory) and the keeper that holds it. `base`:
 * the one of its own it is made from, which is in no registry, so it is never pulled, and is made first when it's gone.
 */
export const OWN_IMAGES: Readonly<Record<string, { context: string; keeper: string; base?: string }>> = {
  [DEFAULT_IMAGE]: { context: ".", keeper: KEEPER },
  [LAB_IMAGE]: { context: "lab", keeper: "invincible-lab-image" },
  [DESKTOP_IMAGE]: { context: "desktop", keeper: "invincible-desktop-image", base: DEFAULT_IMAGE },
  [HARDWARE_IMAGE]: { context: "hardware", keeper: "invincible-hardware-image", base: DESKTOP_IMAGE },
  [CLAUDE_CODE_IMAGE]: { context: "claude-code", keeper: "invincible-claude-code-image", base: DEFAULT_IMAGE },
  [HARNESS_IMAGE]: { context: "harnesses", keeper: "invincible-harnesses-image", base: DEFAULT_IMAGE },
};

/**
 * The images of its own every release has made: what a host is taken to make when its release says nothing of its
 * images (it is older than saying), so a sandbox in an image newer than that host goes where it is made.
 */
export const FIRST_IMAGES: readonly string[] = [DEFAULT_IMAGE, LAB_IMAGE, DESKTOP_IMAGE];

/** What an image of its own is made by, its bases first and the image last (the hardware's: the workshop, the desktop, itself). */
export function madeFrom(image: string): string[] {
  const chain: string[] = [];
  for (let at: string | undefined = image; at && OWN_IMAGES[at] && !chain.includes(at); at = OWN_IMAGES[at]!.base) chain.unshift(at);
  return chain;
}

/**
 * The node's own images in the order a refresh makes them again: each after its base, so a base made anew makes the
 * ones made from it anew too, as their builds follow it (the desktop before the hardware's). Otherwise as OWN_IMAGES
 * lists them.
 */
export function refreshOrder(): string[] {
  return Object.keys(OWN_IMAGES).sort((a, b) => madeFrom(a).length - madeFrom(b).length);
}

/** How one of its own images is built on a node, when it isn't there: `invincible sandbox build` and its flag. */
export const buildCommand = (image: string): string =>
  `invincible sandbox build${image === LAB_IMAGE ? " --lab" : image === DESKTOP_IMAGE ? " --desktop" : image === HARDWARE_IMAGE ? " --hardware" : ""}`;

/**
 * The image an agent's VM is made again from: the hardware's when it is asked for, the desktop's or the workshop's when
 * a desktop is asked for or taken away, else the one it has. The hardware tools come with a desktop, so a VM given them
 * has one (they win over a desktop taken away in the same breath), and one whose desktop is taken away loses them too.
 */
export function remadeImage(current: string, ask: { desktop?: boolean; hardware?: boolean }): string {
  if (ask.hardware === true) return HARDWARE_IMAGE;
  if (ask.desktop === false) return DEFAULT_IMAGE;
  if (ask.hardware === false && current === HARDWARE_IMAGE) return DESKTOP_IMAGE;
  if (ask.desktop === true) return current === HARDWARE_IMAGE ? current : DESKTOP_IMAGE;
  return current;
}

/**
 * What of a remake's ask the VM's host is told: all of it, but the hardware tools taken away only from a VM that has
 * them. Taking away what it hasn't changes nothing (remadeImage), and a host older than them knows no such word.
 */
export function remakeAsk(current: string, ask: { desktop?: boolean; hardware?: boolean }): { desktop?: boolean; hardware?: boolean } {
  if (ask.hardware !== false || current === HARDWARE_IMAGE) return ask;
  const { hardware: _, ...rest } = ask;
  return rest;
}

export const containerName = (id: string) => `invincible-sbx-${id}`;
export const volumeName = (id: string) => `invincible-sbx-${id}-work`;

/**
 * A seat's home (core's seats.ts): a volume of its own, where the vendor's tool keeps that seat's sign-in. Mounted at
 * /seats/<id> in a VM made for a run on that seat or for its sign-in, and in no other VM at once (the host leases it).
 */
export const seatVolumeName = (seat: string) => `invincible-seat-${seat}`;
export const seatHome = (seat: string) => `/seats/${seat}`;

/**
 * A Gemini seat's sealed sign-in (design (a), 28 November 2026): a volume of its own beside the seat's home, holding agy's
 * sign-in as the seat's last sign-in that took left it, and nothing else. Mounted at /seats/<id>.sealed: writable only in
 * the VM made for the seat's sign-in (`signsIn`), read-only in a run's and a status check's, so what a run does to the
 * copy each start of agy is given (packages/agents/src/antigravity.ts) never reaches the seat's. (A seat's id has no dot,
 * so no seat's home is ever named as another's sealed sign-in.)
 */
export const SEALS_SIGN_IN: readonly SeatKind[] = ["google-antigravity"];
export const seatSealedName = (seat: string) => `invincible-seat-${seat}.sealed`;
export const seatSealed = (seat: string) => `/seats/${seat}.sealed`;

/**
 * Where a seat's tool keeps its sign-in, inside the seat's home, told to the tool by the variable its vendor documents
 * for keeping accounts apart (Anthropic's Authentication page, OpenAI's Codex configuration), or, for Antigravity's CLI,
 * which has none, the profile its bridge runs it in (agy's own --gemini-dir, as T3 Code gives each of its profiles one:
 * packages/agents/src/antigravity.ts), and the seat's sealed sign-in beside it. This is the one place that names them:
 * nothing of Invincible's reads, copies or moves what a tool keeps there, but agy's sign-in, which a Gemini seat's sign-in
 * seals and each start of agy copies in, whole and never opened for what it says (seatSealed).
 */
export function seatEnv(seat: string, kind: SeatKind): Record<string, string> {
  const home = seatHome(seat);
  if (kind === "claude-subscription") return { CLAUDE_CONFIG_DIR: `${home}/claude` };
  if (kind === "chatgpt-codex") return { CODEX_HOME: `${home}/codex` };
  if (kind === "google-antigravity") return { INVINCIBLE_AGY_DIR: `${home}/antigravity`, INVINCIBLE_AGY_SEALED: seatSealed(seat) };
  return {};
}

export function labels(spec: SandboxSpec): Record<string, string> {
  return {
    [LABEL]: "1",
    [`${LABEL}.id`]: spec.id,
    [`${LABEL}.run`]: spec.run,
    [`${LABEL}.node`]: spec.node,
    [`${LABEL}.network`]: spec.network,
    [`${LABEL}.ephemeral`]: String(spec.ephemeral),
    [`${LABEL}.created`]: String(spec.createdAt),
    [`${LABEL}.expires`]: String(spec.createdAt + spec.ttlMinutes * 60_000),
    [`${LABEL}.providers`]: spec.providers.join(","),
    [`${LABEL}.cpus`]: String(spec.cpus),
    [`${LABEL}.memory`]: String(spec.memoryGb),
    [`${LABEL}.disk`]: spec.workspace && spec.diskGb ? String(spec.diskGb) : "none",
    [`${LABEL}.isolation`]: spec.isolation,
    ...(spec.seat ? { [`${LABEL}.seat`]: spec.seat.id } : {}),
    ...(spec.task ? { [`${LABEL}.task`]: spec.task } : {}),
    ...(spec.gate ? { [`${LABEL}.gate`]: "1" } : {}),
    ...(spec.beside ? { [`${LABEL}.beside`]: spec.beside } : {}),
    ...(spec.shares ? { [`${LABEL}.shares`]: spec.shares.sandbox } : {}),
    // (A tree of the store alone, in layout 2: one without holds the store's root, so no layout-2 mount is made beside it.)
    ...(spec.shares?.tree ? { [`${LABEL}.shares.tree`]: spec.shares.tree } : {}),
    ...(spec.layout ? { [`${LABEL}.layout`]: "2" } : {}),
    // The gateway token's hash is deliberately NOT a label: images can carry labels of
    // their own, so anything security-relevant lives in node-local state instead.
  };
}

/**
 * Its /work, and in layout 2 its HOME and its notes, from its store (layout.ts): in layout 2 each tree on its own, as a
 * subpath of its volume or a directory of its workspace image. A VM that shares an agent's workspace mounts that
 * workspace's tree alone, and its notes' tree too when it is a run on a seat of yours (`notes`).
 */
function storeMounts(spec: SandboxSpec): string[] {
  const mount = (source: { volume: string } | { workspace: string }, tree: string | null, target: string) =>
    "volume" in source
      ? `type=volume,src=${source.volume},dst=${target}${tree ? `,volume-subpath=${tree}` : ""}`
      : `type=bind,src=${tree ? `${source.workspace}/${tree}` : source.workspace},dst=${target}`;
  if (spec.shares) return ["--mount", mount(spec.shares, spec.shares.tree ?? null, VM_WORK), ...(spec.shares.tree && spec.shares.notes ? ["--mount", mount(spec.shares, NOTES_TREE, VM_NOTES)] : [])];
  const store = spec.workspace ? { workspace: spec.workspace } : { volume: volumeName(spec.id) };
  if (!spec.layout) return ["--mount", mount(store, null, VM_WORK)];
  return ["--mount", mount(store, WORK_TREE, VM_WORK), "--mount", mount(store, HOME_TREE, VM_HOME), "--mount", mount(store, NOTES_TREE, VM_NOTES)];
}

/** `docker run` arguments. Every hardening flag here is asserted by tests. */
export function runArgs(spec: SandboxSpec): string[] {
  const memory = `${Math.round(spec.memoryGb * 1024)}m`;
  const args = [
    "run",
    "--detach",
    "--name",
    containerName(spec.id),
    "--hostname",
    "agent",
    "--init",
    // Nobody inside is root, nothing can gain privileges, the kernel surface is minimal.
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    // The image is immutable; the agent writes only to its workspace and /tmp.
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
    ...storeMounts(spec),
    ...(spec.seat ? ["--mount", `type=volume,src=${seatVolumeName(spec.seat.id)},dst=${seatHome(spec.seat.id)}`] : []),
    ...(spec.seat && SEALS_SIGN_IN.includes(spec.seat.kind) ? ["--mount", `type=volume,src=${seatSealedName(spec.seat.id)},dst=${seatSealed(spec.seat.id)}${spec.seat.signsIn ? "" : ",readonly"}`] : []),
    "--workdir",
    "/work",
    // Its HOME: /work in layout 1; in layout 2 its own tree, and with it where it installs for itself and its PATH. One
    // that shares a workspace has one of its own, in memory (its notes' tree, when it has it, is mounted inside it).
    ...(spec.ownHome ? ["--tmpfs", `${VM_HOME}:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700`] : []),
    // A round of another node's task's gates' own folder, their user's alone, where a tree's scripts may run (VM_GATES):
    // in that round's VM alone, where nothing of the task's runs.
    ...(spec.gate && spec.cache ? cacheMount(spec.cache) : []),
    ...(spec.gate ? ["--tmpfs", `${VM_GATES}:rw,exec,nosuid,nodev,size=2g,uid=${VM_GATES_USER.split(":")[0]},gid=${VM_GATES_USER.split(":")[1]},mode=0700`] : []),
    ...((spec.layout ?? spec.ownHome) ? Object.entries({ ...LAYOUT_ENV, PATH: (spec.layout ?? spec.ownHome)!.path }).flatMap(([key, value]) => ["--env", `${key}=${value}`]) : ["--env", "HOME=/work"]),
    // Bounded resources: a runaway agent cannot starve the host.
    "--cpus",
    String(spec.cpus),
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--pids-limit",
    String(spec.pidsLimit),
    "--ulimit",
    "nofile=8192:8192",
    // Online sandboxes join both networks at start (egress first, so it holds the default route):
    // a microVM can't be given a network after it boots.
    ...(spec.network === "isolated"
      ? ["--network", "none"]
      : spec.network === "gateway"
        ? ["--network", NETWORKS.gateway.name]
        : ["--network", NETWORKS.online.name, "--network", NETWORKS.gateway.name]),
    ...(spec.isolation === "vm" ? ["--runtime", KATA_RUNTIME] : []),
    ...(spec.isolation === "vm" && spec.network === "online" && spec.resolvConf
      ? ["--mount", `type=bind,src=${spec.resolvConf},dst=/etc/resolv.conf,readonly`]
      : []),
  ];
  for (const [key, value] of Object.entries(labels(spec))) args.push("--label", `${key}=${value}`);
  for (const [key, value] of Object.entries({ ...spec.env, ...(spec.seat ? seatEnv(spec.seat.id, spec.seat.kind) : {}), ...(spec.gate ? { [GATE_VM_ENV]: "1", ...(spec.cache ? { BUN_INSTALL_CACHE_DIR: VM_BUN_CACHE } : {}) } : {}) })) args.push("--env", `${key}=${value}`);
  args.push(spec.image, "sleep", "infinity");
  return args;
}

/** The gateway scope for web search (the node's own SearXNG): not a model provider. */
export const SEARCH_SCOPE = "search";
/** Environment that points tools at the sandbox gateway with a scoped token (never a key). */
/** `keys`: the lease is good for keys of yours (PLAN #17): INVINCIBLE_KEYS says where the key gateway is. */
export function gatewayEnv(token: string, providers: string[], keys = false): Record<string, string> {
  const root = `http://${NETWORKS.gateway.gateway}:${SANDBOX_GATEWAY_PORT}`;
  const base = `${root}/gw`;
  const models = providers.filter((p) => p !== SEARCH_SCOPE);
  const openai = models.find((p) => p !== "anthropic");
  return {
    INVINCIBLE_GATEWAY: base,
    ...(models.includes("anthropic") ? { ANTHROPIC_BASE_URL: `${base}/anthropic`, ANTHROPIC_AUTH_TOKEN: token } : {}),
    ...(openai ? { OPENAI_BASE_URL: `${base}/${openai}`, OPENAI_API_KEY: token } : {}),
    ...(providers.includes(SEARCH_SCOPE) ? { INVINCIBLE_SEARCH: `${root}/search` } : {}),
    ...(keys ? { INVINCIBLE_KEYS: `${root}/key` } : {}),
    INVINCIBLE_TOKEN: token,
  };
}

/**
 * A folder under /work copied out as a tar from inside the VM, by the walk (walk.ts COLLECT_SCRIPT), under a deadline: never
 * `docker cp`, which follows the links on its path and takes every entry of a folder, its HOME's among them where the
 * VM's HOME is its /work.
 */
export const collectArgs = (id: string, path: string): string[] => execArgs(id, collectCommand(path), 900);

/**
 * A command in a sandbox, in /work, under its deadline inside the container (killing `docker exec` alone would not stop
 * it), and given nothing to read: no `--interactive`, and its input /dev/null inside the VM. Given `--interactive` with
 * nothing to read (the node's own /dev/null), Kata 4.3.1's shim closes the command's input holding the lock every exec
 * of its VM takes, and waits there for the copy of that input, which ends only with the command's output: so each command
 * held every other of its VM until it ended (a second `true` 2 s into a 12 s command took 10,066 ms in Kata and 53 ms in
 * runc; Ultra, 28 November 2026, Q5's audit), and a command that read its input never saw it end. `sh` execs into the
 * command, so the deadline's process group and what it starts stay as they were (withoutInput). A command given input as
 * it runs (`input`: a stream held open) keeps `--interactive`, and reads what it is given; a pipe's sides are pipeArgs'.
 * `as`: "gates", as another node's task's gates' own user, from their own folder (VM_GATES, a round of its gates' VM's
 * alone: gate.ts), never as the VMs' user.
 */
export const execArgs = (id: string, cmd: string[], timeoutSec: number, opts: { input?: boolean; as?: "gates" } = {}): string[] => [
  "exec",
  ...(opts.input ? ["--interactive"] : []),
  ...(opts.as === "gates" ? ["--user", VM_GATES_USER, "--workdir", VM_GATES] : ["--workdir", "/work"]),
  containerName(id),
  "timeout",
  "--signal=KILL",
  `${timeoutSec}s`,
  ...(opts.input ? cmd : withoutInput(cmd)),
];

/**
 * A side of a pipe between two VMs (SandboxHost.pipe), run as an exec is (execArgs: its deadline, /work), with the pipe's
 * tag in its environment. What the side starts inherits the tag unless it is given an environment of its own (as the
 * node's git is), and stays in the process group its `timeout` leads unless it makes one of its own. The tag and that
 * group are how what the side started is found again in its VM and ended there when the pipe ends it (PIPE_END; the
 * seventh fabric review's I-c). Only the receiving side is given its input (`input`): a Kata VM starts no other exec
 * while an interactive one whose input has ended still runs, and one given no input has its input end at once (on Ultra,
 * 28 November 2026, a second exec waited out the first; with neither interactive it ran in 42 ms; the Kata audit found
 * why). So the sending side, which reads none, is no interactive exec, and its end can run beside it.
 */
export const pipeArgs = (id: string, cmd: string[], timeoutSec: number, tag: string, input: boolean): string[] => ["exec", "--env", `INVINCIBLE_PIPE=${tag}`, ...(input ? ["--interactive"] : []), "--workdir", "/work", containerName(id), "timeout", "--signal=KILL", `${timeoutSec}s`, ...cmd];

/**
 * A command given no input at all: its stdin /dev/null in its VM, as a pipe's receiving side runs when the sending side
 * gave nothing (SandboxHost.pipe). A command that reads stdin in a Kata VM never sees its end otherwise, with or without
 * --interactive (the Kata audit, 28 November 2026). `sh` execs into the command, so its `timeout`'s group and the pipe's
 * tag are as they were.
 */
export const withoutInput = (cmd: string[]): string[] => ["sh", "-c", 'exec "$@" </dev/null', "sh", ...cmd];

/**
 * A pipe's end, run in one of its VMs with the pipe's tag (`sh -c PIPE_END end <tag>`) once a side's docker client has
 * been killed (SandboxHost.pipe; the seventh fabric review's I-c). Docker leaves what an exec started running when its
 * client goes, so without this a side's command would run on in its VM until its input ended or its own deadline came.
 *
 * Everything with the tag in its environment is killed (SIGKILL), and so is the process group of each such process that
 * leads its own. That is a side's GNU `timeout`: it makes a group of its own (setpgid), which holds the whole command, the
 * node's git among it, though git runs with an environment of its own and so without the tag. A group is killed only
 * where its leader has the tag, never group 0 or 1 or a group an untagged process leads, so nothing else is ended; this
 * script runs without the tag, and so it is never among what it kills. Each look finds every group a tagged process
 * leads before it kills anything: killed first, the leader's child (the side's shell) lets the leader, its `timeout`,
 * exit, and the group, an untagged child of the node's git in it, would then have no leader to be found by (on Ultra's
 * Docker, 28 November 2026: /proc lists 13 before 7). It looks twice, for anything a tagged process started between the
 * first look and its kill. The tag is matched whole, as a fixed string, so no other pipe's processes
 * match it, and one that isn't 32 or more lowercase hex digits is refused (exit 2) before anything is looked at.
 *
 * What it can't find runs on: a process that dropped the tag from its environment and also left the group (as a daemon
 * does) runs on in its VM, as it would after any exec.
 */
export const PIPE_END = `t=$1
case $t in ''|*[!0-9a-f]*) exit 2;; esac
[ \${#t} -ge 32 ] || exit 2
tagged() { for d in /proc/[0-9]*; do tr '\\0' '\\n' 2>/dev/null < "$d/environ" | grep -qxF "INVINCIBLE_PIPE=$t" && echo "\${d#/proc/}"; done; }
group() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f3; }
for look in 1 2; do
  found=$(tagged)
  leads=
  for p in $found; do [ "$p" -gt 1 ] && [ "$(group "$p")" = "$p" ] && leads="$leads $p"; done
  for g in $leads; do kill -KILL "-$g" 2>/dev/null; done
  for p in $found; do [ "$p" -gt 1 ] && kill -KILL "$p" 2>/dev/null; done
done
exit 0`;

/**
 * A login shell on a terminal of its own (bash where the image has it), as `docker exec` runs it under a pseudo-terminal
 * on the host. Nothing bounds its time but its closing: a terminal is yours, open while you use it. Its tag, in the
 * environment of everything it starts, is how what it started is found again when it closes (TERMINAL_HANG_UP).
 */
export const terminalArgs = (id: string, tag: string): string[] => [
  "exec",
  "--interactive",
  "--tty",
  "--workdir",
  "/work",
  "--env",
  "TERM=xterm-256color",
  "--env",
  `INVINCIBLE_TERMINAL=${tag}`,
  containerName(id),
  "sh",
  "-c",
  "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l",
];

/**
 * A closed terminal's hang-up, run in its sandbox with its tag (`sh -c TERMINAL_HANG_UP hang-up <tag>`): Docker leaves
 * what an exec started running when its client goes. Everything with the tag in its environment is sent SIGHUP, as a
 * terminal's hang-up sends (what was started with nohup stays); two seconds on, the tagged process that leads its own
 * session (the shell) is killed if it is still there.
 */
export const TERMINAL_HANG_UP = `t=$1
tagged() { for d in /proc/[0-9]*; do tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx "INVINCIBLE_TERMINAL=$t" && echo "\${d#/proc/}"; done; }
for p in $(tagged); do kill -HUP "$p" 2>/dev/null; done
sleep 2
for p in $(tagged); do [ "$(sed 's/.*) //' "/proc/$p/stat" 2>/dev/null | cut -d' ' -f4)" = "$p" ] && kill -KILL "$p" 2>/dev/null; done
exit 0`;

export function networkCreateArgs(kind: keyof typeof NETWORKS): string[] {
  const n = NETWORKS[kind];
  return [
    "network",
    "create",
    ...(n.internal ? ["--internal"] : []),
    "--subnet",
    n.subnet,
    "--gateway",
    n.gateway,
    "-o",
    `com.docker.network.bridge.name=${n.bridge}`,
    "-o",
    "com.docker.network.bridge.enable_icc=false",
    "--label",
    `${LABEL}=1`,
    n.name,
  ];
}

/**
 * Where a sandbox runs when you don't say: online sandboxes (code and content from the
 * internet, the least trusted) in a microVM where the host has them; the rest in a container.
 */
export function chooseIsolation(network: SandboxNetwork, asked: "container" | "vm" | undefined, microVMs: boolean): "container" | "vm" {
  if (asked) return asked;
  return network === "online" && microVMs ? "vm" : "container";
}

/**
 * A resolv.conf for online microVMs from the host's own: its upstream nameservers (never a
 * loopback stub such as systemd-resolved's 127.0.0.53, which a VM can't reach), else public ones.
 */
export function vmResolvConf(...sources: (string | null | undefined)[]): string {
  for (const text of sources) {
    const servers = (text ?? "")
      .split("\n")
      .map((line) => line.trim().match(/^nameserver\s+([0-9a-fA-F.:]+)\s*$/)?.[1])
      .filter((ip): ip is string => !!ip && !/^(127\.|::1$|0\.0\.0\.0$)/.test(ip))
      .slice(0, 3);
    if (servers.length) return `${servers.map((ip) => `nameserver ${ip}`).join("\n")}\noptions timeout:2 attempts:2\n`;
  }
  return "nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n";
}

