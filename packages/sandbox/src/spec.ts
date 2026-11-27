import { type SandboxNetwork, type SeatKind, VM_HOME, VM_WORK } from "@invincible/core";
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
  /** A VM made for a seat (a run on it, or its sign-in): the seat's home mounted, and its tool told where (seatEnv). */
  seat?: { id: string; kind: SeatKind };
  /** A VM made for another node's task (createTaskVm): its own, removed as the task ends, by the task it is for. */
  task?: string;
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
   * A HOME of its own, empty and in memory, at /home/agent (a VM that shares an agent's workspace: a run on a seat, another
   * node's task): never the agent's, whose sign-ins and lease its tools would otherwise find there, nor the workspace it
   * shares. Its environment and PATH (`path`, layoutPath) follow it, as layout 2's do.
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
 * The vendors' own coding tools in the workshop image, pinned (sandbox/harnesses): where every run of Claude Code or Codex
 * is made, on a seat or through the gateway. Tagged by the releases it pins, so a new pin is a new image.
 */
export const HARNESS_IMAGE = "invincible/harnesses:claude-2.1.326.codex-0.172.0";
/** The pins it holds, as the tools say their versions (`--version`): what readiness names. */
export const HARNESS_PINS = { claude: "2.1.326", codex: "0.172.0" } as const;

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
 * Where a seat's tool keeps its sign-in, inside the seat's home, told to the tool by the variable its vendor documents
 * for keeping accounts apart (Anthropic's Authentication page, OpenAI's Codex configuration). This is the one place that
 * names them: nothing of Invincible's reads, copies or moves what a tool keeps there.
 */
export function seatEnv(seat: string, kind: SeatKind): Record<string, string> {
  const home = seatHome(seat);
  if (kind === "claude-subscription") return { CLAUDE_CONFIG_DIR: `${home}/claude` };
  if (kind === "chatgpt-codex") return { CODEX_HOME: `${home}/codex` };
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
    "--workdir",
    "/work",
    // Its HOME: /work in layout 1; in layout 2 its own tree, and with it where it installs for itself and its PATH. One
    // that shares a workspace has one of its own, in memory (its notes' tree, when it has it, is mounted inside it).
    ...(spec.ownHome ? ["--tmpfs", `${VM_HOME}:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700`] : []),
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
  for (const [key, value] of Object.entries({ ...spec.env, ...(spec.seat ? seatEnv(spec.seat.id, spec.seat.kind) : {}) })) args.push("--env", `${key}=${value}`);
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

/** Commands run under a hard deadline inside the container (killing `docker exec` alone would not stop them). */
/**
 * A folder under /work copied out as a tar from inside the VM, by the walk (walk.ts COLLECT_SCRIPT), under a deadline: never
 * `docker cp`, which follows the links on its path and takes every entry of a folder, its HOME's among them where the
 * VM's HOME is its /work.
 */
export const collectArgs = (id: string, path: string): string[] => execArgs(id, collectCommand(path), 900);

export const execArgs = (id: string, cmd: string[], timeoutSec: number): string[] => [
  "exec",
  "--interactive",
  "--workdir",
  "/work",
  containerName(id),
  "timeout",
  "--signal=KILL",
  `${timeoutSec}s`,
  ...cmd,
];

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

