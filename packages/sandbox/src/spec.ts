import type { SandboxNetwork } from "@galahad/core";

/*
 * A sandbox is where a knight works: an unprivileged, resource-capped container
 * with its own workspace and nothing else of the host. This module is pure: it
 * turns a spec into `docker` arguments, so the security posture is unit-tested.
 */

export const LABEL = "dev.galahad";
export const DEFAULT_IMAGE = "galahad/sandbox:1";
/**
 * Kata Containers' shim: the container runs inside its own KVM microVM with its own kernel.
 * Docker finds `containerd-shim-kata-v2` on containerd's PATH, so Docker's config never changes.
 */
export const KATA_RUNTIME = "io.containerd.kata.v2";
/** Port of the sandbox-only model gateway listener on the gateway network's bridge IP. */
export const SANDBOX_GATEWAY_PORT = 7779;

/**
 * gateway: Docker `--internal` network: no route out; the only reachable host
 *          service is the sandbox gateway (UFW allows just that port on galahad0).
 * online:  ordinary bridge with egress, plus the gateway network for models.
 * Inter-container traffic is disabled on both, so sandboxes cannot reach each other.
 */
export const NETWORKS = {
  gateway: { name: "galahad-gw", bridge: "galahad0", subnet: "172.31.250.0/24", gateway: "172.31.250.1", internal: true },
  online: { name: "galahad-net", bridge: "galahad1", subnet: "172.31.249.0/24", gateway: "172.31.249.1", internal: false },
} as const;

export interface SandboxSpec {
  id: string;
  quest: string;
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
}

/** A stopped container that keeps the sandbox image in use, so image pruning (Coolify's nightly cleanup) leaves it alone. */
export const KEEPER = "galahad-sandbox-image";

/** The Lab: mathematics, physics and engineering tools (sandbox/lab/Dockerfile). */
export const LAB_IMAGE = "galahad/lab:1";

/** Gazebo: robotics simulation, headless (sandbox/gazebo/Dockerfile). */
export const GAZEBO_IMAGE = "galahad/gazebo:1";

/** The knights' desktop: the workshop with a display, a window manager and a browser (sandbox/desktop/Dockerfile). Built after the workshop image, which it is made from. */
export const DESKTOP_IMAGE = "galahad/desktop:1";
/** Claude Code in the workshop image, for trials alone (sandbox/claude-code): tagged by its pinned release. */
export const CLAUDE_CODE_IMAGE = "galahad/claude-code:2.1.319";

/**
 * Galahad's own images: where each is built from (under the sandbox directory) and the keeper that holds it. `base`:
 * the one of his own it is made from, which is in no registry, so it is never pulled, and is made first when it's gone.
 */
export const OWN_IMAGES: Readonly<Record<string, { context: string; keeper: string; base?: string }>> = {
  [DEFAULT_IMAGE]: { context: ".", keeper: KEEPER },
  [LAB_IMAGE]: { context: "lab", keeper: "galahad-lab-image" },
  [GAZEBO_IMAGE]: { context: "gazebo", keeper: "galahad-gazebo-image" },
  [DESKTOP_IMAGE]: { context: "desktop", keeper: "galahad-desktop-image", base: DEFAULT_IMAGE },
  [CLAUDE_CODE_IMAGE]: { context: "claude-code", keeper: "galahad-claude-code-image", base: DEFAULT_IMAGE },
};

/**
 * The images of his own every release has made: what a host is taken to make when its release says nothing of its
 * images (it is older than saying), so a sandbox in an image newer than that host goes where it is made.
 */
export const FIRST_IMAGES: readonly string[] = [DEFAULT_IMAGE, LAB_IMAGE, GAZEBO_IMAGE, DESKTOP_IMAGE];

export const containerName = (id: string) => `galahad-sbx-${id}`;
export const volumeName = (id: string) => `galahad-sbx-${id}-work`;

export function labels(spec: SandboxSpec): Record<string, string> {
  return {
    [LABEL]: "1",
    [`${LABEL}.id`]: spec.id,
    [`${LABEL}.quest`]: spec.quest,
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
    // The gateway token's hash is deliberately NOT a label: images can carry labels of
    // their own, so anything security-relevant lives in node-local state instead.
  };
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
    "knight",
    "--init",
    // Nobody inside is root, nothing can gain privileges, the kernel surface is minimal.
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    // The image is immutable; the knight writes only to its workspace and /tmp.
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
    "--mount",
    spec.workspace ? `type=bind,src=${spec.workspace},dst=/work` : `type=volume,src=${volumeName(spec.id)},dst=/work`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/work",
    // Bounded resources: a runaway knight cannot starve the host.
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
  for (const [key, value] of Object.entries(spec.env)) args.push("--env", `${key}=${value}`);
  args.push(spec.image, "sleep", "infinity");
  return args;
}

/** The gateway scope for web search (the node's own SearXNG): not a model provider. */
export const SEARCH_SCOPE = "search";
/**
 * A scope every networked sandbox carried until 14 November 2026 (for the SANDBOX world, since removed). A
 * sandbox from before still names it in its label: it is read as nothing, never as a model provider.
 */
export const RETIRED_SCOPE = "world";

/** Environment that points tools at the sandbox gateway with a scoped token (never a key). */
/** `keys`: the lease is good for keys of yours (PLAN #17): GALAHAD_KEYS says where the key gateway is. */
export function gatewayEnv(token: string, providers: string[], keys = false): Record<string, string> {
  const root = `http://${NETWORKS.gateway.gateway}:${SANDBOX_GATEWAY_PORT}`;
  const base = `${root}/gw`;
  const models = providers.filter((p) => p !== SEARCH_SCOPE);
  const openai = models.find((p) => p !== "anthropic");
  return {
    GALAHAD_GATEWAY: base,
    ...(models.includes("anthropic") ? { ANTHROPIC_BASE_URL: `${base}/anthropic`, ANTHROPIC_AUTH_TOKEN: token } : {}),
    ...(openai ? { OPENAI_BASE_URL: `${base}/${openai}`, OPENAI_API_KEY: token } : {}),
    ...(providers.includes(SEARCH_SCOPE) ? { GALAHAD_SEARCH: `${root}/search` } : {}),
    ...(keys ? { GALAHAD_KEYS: `${root}/key` } : {}),
    GALAHAD_TOKEN: token,
  };
}

/** Commands run under a hard deadline inside the container (killing `docker exec` alone would not stop them). */
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
  `GALAHAD_TERMINAL=${tag}`,
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
tagged() { for d in /proc/[0-9]*; do tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx "GALAHAD_TERMINAL=$t" && echo "\${d#/proc/}"; done; }
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

