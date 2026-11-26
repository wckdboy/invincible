import type { SandboxNetwork } from "@galahad/core";
import { containerName, DEFAULT_IMAGE, LABEL, labels, NETWORKS, type SandboxSpec, volumeName } from "./spec.ts";

/*
 * Apple's `container` (github.com/apple/container, 1.x): Linux containers on a Mac, each in a lightweight VM of its
 * own, as Kata gives on Linux. This module is pure, as spec.ts is for Docker: it turns a spec into `container`'s
 * arguments and reads what `container` prints, so the posture is unit-tested. Every flag and output format here is
 * from its documentation at the 1.7.1 tag (docs/command-reference.md, and networking.md, volumes.md,
 * resource-usage.md, ulimits.md, runtime-configuration.md and container-inspection.md beside it); each is there
 * from 1.0.0 on. A flag Docker's path sets that `container` hasn't says why its promise holds without it
 * (DOCKER_ON_A_MAC), and what a Mac can't give is refused with the reason (CONTAINER_CANNOT): never weaker.
 */

/** The major release whose command line this driver speaks. */
export const CONTAINER_MAJOR = 1;

/**
 * Apple's container as a Mac is given it when it has none (`galahad sandbox setup`, the app's step 3): Apple's signed
 * installer at the release this driver was checked against on the Mac mini, pinned to the SHA-256 GitHub records for
 * it (signed "Developer ID Installer: Apple Inc. - Containerization" and notarized, as pkgutil read it, 17 November
 * 2026). It installs to /usr/local. A Mac that has container already keeps the one it has.
 */
export const CONTAINER_RELEASE = {
  version: "1.7.1",
  url: "https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg",
  sha256: "b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97",
  bytes: 169_630_704,
  command: "/usr/local/bin/container",
} as const;

/**
 * Where container keeps its default kernel for this Mac's VMs, under its own data (its default app root): there once
 * `container system start --enable-kernel-install` or `container system kernel set --recommended` has fetched it.
 */
export const containerKernel = (home: string): string => `${home}/Library/Application Support/com.apple.container/kernels/default.kernel-arm64`;

/**
 * container's service started: with `kernel`, its recommended kernel fetched too when there is none (container checks
 * it against the digest its configuration names). Started again while it runs, it changes nothing.
 */
export const containerSystemStartArgs = (kernel: boolean): string[] => ["system", "start", kernel ? "--enable-kernel-install" : "--disable-kernel-install", "--timeout", "60"];

/**
 * The network `container system start` makes, which its builder joins (`container build`). No sandbox is put on it: an
 * online sandbox's way out is Galahad's own galahad-net, as on Docker, so the Mac's firewall knows every address.
 */
export const DEFAULT_NETWORK = "default";

/**
 * Every VM here boots without IPv6 (a kernel argument, so nothing inside can bring it back): Docker's networks are
 * IPv4 alone, and on a Mac IPv6 would reach the host and the sandboxes beside it by their link-local addresses
 * (seen on the Mac mini, 17 November 2026), past rules written for IPv4.
 */
const NO_IPV6 = ["--kernel-arg", "ipv6.disable=1"];

/** How long a sandbox has to stop before it is killed (Docker's path gives 10 s too). */
const STOP_SECONDS = 10;

/** What a Mac can't make yet, each with why: its capabilities carry the list, so placement sends such work elsewhere. */
export const CONTAINER_CANNOT = {
  isolated:
    "a Mac can't make a sandbox with no network at all: Apple's container has no network like Docker's none, and none of its networks is proven to isolate yet, so an isolated sandbox is made on a Linux host with Docker",
  desktop: "the desktop image (Computer Use) isn't built for Apple silicon yet: a desktop is made on a Linux host",
  lab: "the Lab isn't proven on Apple silicon yet: a Lab sandbox is made on a Linux host",
  gazebo: "Gazebo's image is built for x86-64 alone: a Gazebo sandbox is made on a Linux host",
} as const;
export type Unmade = keyof typeof CONTAINER_CANNOT;
export const CONTAINER_UNMADE = Object.keys(CONTAINER_CANNOT) as Unmade[];
/** The images of his own a Mac makes: the workshop's (the others aren't built or proven for Apple silicon yet). */
export const CONTAINER_IMAGES: readonly string[] = [DEFAULT_IMAGE];

/** A sandbox as asked for, as far as what a host can't make goes. `image`: one named (Galahad's own, or any to pull). */
export interface SandboxAsk {
  network?: SandboxNetwork;
  desktop?: boolean;
  lab?: boolean;
  gazebo?: boolean;
  image?: string;
}

/** Why a host that can't make `cannot` can't make this sandbox (its first reason), or null when it can. */
export function cannotMake(ask: SandboxAsk, cannot: readonly string[]): string | null {
  const why = (what: Unmade) => (cannot.includes(what) ? CONTAINER_CANNOT[what] : null);
  return (ask.network === "isolated" ? why("isolated") : null) ?? (ask.desktop ? why("desktop") : null) ?? (ask.lab ? why("lab") : null) ?? (ask.gazebo ? why("gazebo") : null);
}

/** Why a Mac can't make this sandbox, or null when it can. */
export const containerCannot = (ask: SandboxAsk): string | null => cannotMake(ask, CONTAINER_UNMADE);

/**
 * What each flag of Docker's run and network commands (spec.ts) becomes on a Mac, and whether its promise holds:
 * `same` (container has the flag), `replaced` (another of its flags or its own way keeps it), `vm` (no flag, and the
 * VM of its own keeps the promise), `moot` (no promise rides on it), `refused` (what needs it isn't made on a Mac),
 * `weaker` (no flag, and the promise doesn't hold here: said, never hidden). A test holds every Docker flag to an entry.
 */
export const DOCKER_ON_A_MAC: Readonly<Record<string, { container: string | null; holds: "same" | "replaced" | "vm" | "moot" | "refused" | "weaker"; why: string }>> = {
  "--detach": { container: "--detach", holds: "same", why: "It runs the container and detaches from it, as Docker's does." },
  "--name": { container: "--name", holds: "same", why: "The name is the container's ID in container, so every command finds it by name, as on Docker." },
  "--hostname": { container: null, holds: "moot", why: "container has no flag for it: the VM is named after its container. A name, not a defence." },
  "--init": { container: "--init", holds: "same", why: "An init process forwards signals and reaps what its children leave." },
  "--user": { container: "--user", holds: "same", why: "uid 1000 for the container, and for every command and terminal too: container's default user for exec isn't documented, so it is never left to it." },
  "--cap-drop": { container: "--cap-drop", holds: "same", why: "Every capability dropped (`--cap-drop ALL`), and none added back." },
  "--security-opt": {
    container: null,
    holds: "vm",
    why: "container has no no-new-privileges. A setuid file in the image could still make a process uid 0 inside the container, but with every capability dropped it has none of root's powers, the root it would write is read-only, and the VM is the boundary to the host either way. To be confirmed on the Mac mini: NoNewPrivs and CapBnd in /proc/self/status.",
  },
  "--read-only": { container: "--read-only", holds: "same", why: "The image's root is read-only; it writes only to /work and /tmp." },
  "--tmpfs": {
    container: "--tmpfs /tmp:size=2G,mode=1777",
    holds: "replaced",
    why: "container's tmpfs takes size and mode alone (volumes.md), not nosuid or nodev. Their promise holds by the dropped capabilities: no device can be made there (CAP_MKNOD), and no file can be made setuid to root (CAP_CHOWN, CAP_FSETID).",
  },
  "--mount": {
    container: "--mount type=volume,source=…,target=/work",
    holds: "replaced",
    why: "/work is the sandbox's own named volume, made with a fixed size (`volume create -s`): an ext4 image of its own, as the workspace helper gives on Linux, and the one thing of the host's it is given. An online microVM's read-only resolv.conf isn't needed: container writes a VM's resolver itself.",
  },
  "--workdir": { container: "--workdir", holds: "same", why: "Its commands start in /work." },
  "--env": { container: "--env", holds: "same", why: "HOME=/work and the gateway's lease go in as the environment, never as a label." },
  "--cpus": { container: "--cpus", holds: "same", why: "A VM's CPUs are whole: a part of one is given as a whole one, and the governor counts what it gets." },
  "--memory": { container: "--memory", holds: "same", why: "The VM's memory, in MiB as container takes it." },
  "--memory-swap": {
    container: null,
    holds: "vm",
    why: "No flag: the VM has its memory and no more (its guest has no swap, to be confirmed on the Mac mini: /proc/swaps). macOS may page a VM's memory out under pressure, which never gives the sandbox more.",
  },
  "--pids-limit": {
    container: "--ulimit nproc=1024:1024",
    holds: "vm",
    why: "No cgroup limit on processes: a fork bomb fills its own VM (its CPUs and memory) and never the host. RLIMIT_NPROC holds the knight's own processes near Docker's count.",
  },
  "--ulimit": { container: "--ulimit", holds: "same", why: "nofile=8192:8192, as on Docker (ulimits.md)." },
  "--network": {
    container: "--network galahad-net --network galahad-gw (online) · --network galahad-gw --no-dns (gateway)",
    holds: "refused",
    why: "online: Galahad's own NAT network, then the gateway network, egress first, as on Docker (its resolver is the network's gateway). gateway: the internal network alone, with no resolver (it reaches the gateway by its address). isolated (--network none) has no counterpart: it isn't made on a Mac (CONTAINER_CANNOT).",
  },
  "--runtime": { container: null, holds: "vm", why: "Every container is its own lightweight VM, with its own kernel: what Kata's runtime gives on Linux." },
  "--label": { container: "--label", holds: "same", why: "The same labels, and the image it was made from (a VM made again is made from it)." },
  "--internal": {
    container: "--internal",
    holds: "same",
    why: "Host-only, with no way out (the reference: \"Restrict to host-only network\"). What galahad-firewall adds on Ultra, one port of the host and nothing else, is the Mac's firewall (mac-firewall.ts): pf, from a root helper, and no sandbox is made here while it isn't on.",
  },
  "--subnet": { container: "--subnet", holds: "same", why: "Docker's subnets, 172.31.250.0/24 and 172.31.249.0/24, so the gateway's address and the lease's URL are the same." },
  "--gateway": {
    container: null,
    holds: "replaced",
    why: "No flag: vmnet gives the host the subnet's first address, which is Docker's: 172.31.250.1 and 172.31.249.1 (seen on the Mac mini, 17 November 2026).",
  },
  "-o": {
    container: "the Mac's firewall",
    holds: "replaced",
    why: "Docker's bridge options: its name (moot here) and enable_icc=false, which keeps sandboxes on one network from reaching each other. container has no such option (\"always reachable by that IP from … other containers on the same network\", networking.md), so the Mac's firewall has pf see what passes between a bridge's VMs (its member filter) and its rules refuse it.",
  },
};

/** `container run` arguments for a sandbox: Docker's posture (runArgs), flag for flag, as DOCKER_ON_A_MAC says. */
export function containerRunArgs(spec: SandboxSpec): string[] {
  const cannot = containerCannot({ network: spec.network });
  if (cannot) throw new Error(cannot);
  const args = [
    "run",
    "--detach",
    "--name",
    containerName(spec.id),
    "--init",
    // Nobody inside is root and no capability is left; the VM is its own kernel.
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    // The image is immutable; the knight writes only to its workspace and /tmp.
    "--read-only",
    "--tmpfs",
    "/tmp:size=2G,mode=1777",
    "--mount",
    `type=volume,source=${volumeName(spec.id)},target=/work`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/work",
    // Bounded: a VM's whole CPUs and its memory.
    "--cpus",
    String(Math.max(1, Math.ceil(spec.cpus))),
    "--memory",
    `${Math.round(spec.memoryGb * 1024)}M`,
    "--ulimit",
    "nofile=8192:8192",
    "--ulimit",
    `nproc=${spec.pidsLimit}:${spec.pidsLimit}`,
    ...NO_IPV6,
    // Online joins its egress first (it holds the default route), then the gateway's network.
    ...(spec.network === "online" ? ["--network", NETWORKS.online.name, "--network", NETWORKS.gateway.name] : ["--network", NETWORKS.gateway.name, "--no-dns"]),
  ];
  for (const [key, value] of Object.entries({ ...labels(spec), [`${LABEL}.image`]: spec.image })) args.push("--label", `${key}=${value}`);
  for (const [key, value] of Object.entries(spec.env)) args.push("--env", `${key}=${value}`);
  args.push(spec.image, "sleep", "infinity");
  return args;
}

/** A sandbox network, on Docker's subnet: the gateway's host-only (`--internal`), online's with a way out (vmnet's NAT). */
export const containerNetworkCreateArgs = (kind: "gateway" | "online"): string[] => [
  "network",
  "create",
  ...(kind === "gateway" ? ["--internal"] : []),
  "--subnet",
  NETWORKS[kind].subnet,
  "--label",
  `${LABEL}=1`,
  NETWORKS[kind].name,
];

/** A command as uid 1000 in /work, under a hard deadline inside the VM (killing `container exec` alone may not stop it). */
export const containerExecArgs = (id: string, cmd: string[], timeoutSec: number): string[] => [
  "exec",
  "--interactive",
  "--user",
  "1000:1000",
  "--workdir",
  "/work",
  containerName(id),
  "timeout",
  "--signal=KILL",
  `${timeoutSec}s`,
  ...cmd,
];

/** A login shell on a terminal of its own, as uid 1000, tagged (TERMINAL_HANG_UP finds what it started by its tag). */
export const containerTerminalArgs = (id: string, tag: string): string[] => [
  "exec",
  "--interactive",
  "--tty",
  "--user",
  "1000:1000",
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

/** A directory under /work copied out as a tar from inside the VM (its entries start with the directory's own name). */
export function containerCollectArgs(id: string, path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const base = parts.pop()!;
  return ["exec", "--user", "1000:1000", containerName(id), "timeout", "--signal=KILL", "900s", "tar", "-C", `/${parts.join("/")}`, "-cf", "-", base];
}

export const containerVersionArgs = (): string[] => ["system", "version", "--format", "json"];
export const containerListArgs = (): string[] => ["list", "--all", "--format", "json"];
export const containerInspectArgs = (names: string[]): string[] => ["inspect", ...names];

/**
 * What holds each sandbox network up on a Mac: one small VM of the node's own on it, hardened as a sandbox is, doing
 * nothing. container gives the host its address on a network only while a VM is attached to it (seen on the Mac mini,
 * 17 November 2026), and the node's gateway listens on that address. And a network whose last VM has gone can lose
 * its bridge to another network's as its next one comes, which cuts both off (apple/container#2051, open at 1.7.1):
 * held up, a bridge never goes. Each is no sandbox and carries none of a sandbox's labels, so it is never listed,
 * counted or reaped as one. The gateway's is made first.
 */
export const KEEPERS = { gateway: "galahad-gateway-keeper", online: "galahad-online-keeper" } as const;
export const GATEWAY_KEEPER = KEEPERS.gateway;
export const containerKeeperArgs = (image: string, kind: "gateway" | "online"): string[] => [
  "run",
  "-d",
  "--name",
  KEEPERS[kind],
  "--label",
  `${LABEL}.keeper=${kind}`,
  "--cpus",
  "1",
  "--memory",
  "256M",
  ...NO_IPV6,
  "--network",
  NETWORKS[kind].name,
  "--no-dns",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--user",
  "1000:1000",
  image,
  "sleep",
  "infinity",
];
export const containerStopArgs = (name: string): string[] => ["stop", "--time", String(STOP_SECONDS), name];
export const containerStartArgs = (name: string): string[] => ["start", name];
export const containerDeleteArgs = (name: string): string[] => ["delete", "--force", name];
export const containerStatsArgs = (names: string[]): string[] => ["stats", "--format", "json", "--no-stream", ...names];
export const containerImageInspectArgs = (image: string): string[] => ["image", "inspect", image];
export const containerNetworkInspectArgs = (kind: "gateway" | "online"): string[] => ["network", "inspect", NETWORKS[kind].name];

/**
 * A network's helper restarted, before the first VM on it: a restarted helper has no bridge fixed yet, so that VM's
 * takes one no live bridge holds (apple/container#2051). Only ever while nothing runs on that network. The label is
 * container's own launchd agent's, under the login session (gui/<uid>) or, over SSH, the user's domain (user/<uid>).
 */
export const networkHelper = (network: string): string => `com.apple.container.container-network-vmnet.${network}`;
export const helperRestartArgs = (domain: string, network: string): string[] => ["kickstart", "-k", `${domain}/${networkHelper(network)}`];
/** Galahad's images on a Mac: Apple silicon's, their base pulled afresh (`pull` false: a base of his own, in no registry). */
export const containerBuildArgs = (image: string, contextDir: string, pull = true): string[] => ["build", ...(pull ? ["--pull"] : []), "--platform", "linux/arm64", "--tag", image, contextDir];
/**
 * container's builder (its BuildKit, a VM of 2 CPUs and 2 GB) stopped: a build starts it and leaves it running, which
 * held 2 GB of the Mac mini's memory, outside the governor's count, after a single build (17 November 2026). The next
 * build starts it again.
 */
export const containerBuilderStopArgs = (): string[] => ["builder", "stop"];
/** A workspace: a volume whose size is fixed as it is made, labelled as its sandbox's (and kept for good: a knight's). */
/**
 * A new volume's /work handed to the sandbox's user (uid 1000). container makes a volume's root root's and, unlike Docker,
 * doesn't copy the image's ownership into it (seen on the Mac mini, 17 November 2026, under Galahad's own image), and a
 * sandbox can't take it itself: every capability is dropped. So a one-off container of the node's own does, as root,
 * from the local image (built before any workspace is made), on the gateway network, and is gone when it ends.
 */
export const containerVolumeOwnArgs = (id: string, image: string): string[] => [
  "run",
  "--rm",
  "--user",
  "0:0",
  "--entrypoint",
  "chown",
  ...NO_IPV6,
  "--network",
  NETWORKS.gateway.name,
  "--no-dns",
  "--mount",
  `type=volume,source=${volumeName(id)},target=/work`,
  image,
  "1000:1000",
  "/work",
];

export const containerVolumeCreateArgs = (id: string, gib: number, retained: boolean): string[] => [
  "volume",
  "create",
  "-s",
  `${gib}G`,
  "--label",
  `${LABEL}=1`,
  "--label",
  `${LABEL}.id=${id}`,
  ...(retained ? ["--label", `${LABEL}.retained=1`] : []),
  volumeName(id),
];
export const containerVolumeDeleteArgs = (id: string): string[] => ["volume", "delete", volumeName(id)];
export const containerVolumeListArgs = (): string[] => ["volume", "list", "--format", "json"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {});
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
function array(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `system version --format json`: the CLI's version, and whether its service answered (the API server's row is there only then). */
export function parseContainerVersion(text: string): { version: string; major: number; running: boolean } | null {
  const rows = array(text)?.filter(isObj);
  const cli = rows?.find((r) => r.appName === "container");
  if (!rows || typeof cli?.version !== "string") return null;
  const major = Number.parseInt(cli.version, 10);
  if (!Number.isInteger(major)) return null;
  return { version: cli.version, major, running: rows.some((r) => r.appName === "container-apiserver") };
}

/** A container as `list --format json` gives it, read: its labels, its image, its state in Docker's words, what it was given. */
export interface ListedContainer {
  id: string;
  labels: Record<string, string>;
  image: string;
  status: string;
  cpus: number | null;
  memoryBytes: number | null;
  /** The networks it is attached to while it runs (none once stopped). */
  networks: string[];
}

/** `list --all --format json` (or `inspect`), read; null when it isn't a list (never mistaken for "none"). */
export function parseContainers(text: string): ListedContainer[] | null {
  const rows = array(text);
  if (!rows) return null;
  return rows.flatMap((row) => {
    const config = isObj(row) && isObj(row.configuration) ? row.configuration : null;
    const id = config?.id;
    if (!config || typeof id !== "string") return [];
    const given = strings(config.labels);
    const image = given[`${LABEL}.image`] ?? (isObj(config.image) && typeof config.image.reference === "string" ? config.image.reference : "");
    const status = isObj(row) && isObj(row.status) ? row.status : {};
    const state = typeof status.state === "string" ? status.state : "unknown";
    const resources = isObj(config.resources) ? config.resources : {};
    const networks = (Array.isArray(status.networks) ? status.networks : []).flatMap((n) => (isObj(n) && typeof n.network === "string" ? [n.network] : []));
    // (A stopped container is what Docker calls exited: the rest of the node reads Docker's words.)
    return [{ id, labels: given, image, status: state === "stopped" ? "exited" : state, cpus: number(resources.cpus), memoryBytes: number(resources.memoryInBytes), networks }];
  });
}

/** `stats --format json --no-stream`, read: each container's memory, its use of CPUs (1.0 a whole one) and its processes. */
export function parseContainerStats(text: string): { id: string; memoryUsedBytes: number | null; memoryLimitBytes: number | null; cpus: number | null; processes: number | null }[] | null {
  const rows = array(text);
  if (!rows) return null;
  return rows.flatMap((r) =>
    isObj(r) && typeof r.id === "string" ? [{ id: r.id, memoryUsedBytes: number(r.memoryUsageBytes), memoryLimitBytes: number(r.memoryLimitBytes), cpus: number(r.cpuUtilization), processes: number(r.numProcesses) }] : [],
  );
}

/** `volume list --format json`, read: each volume's name, labels, the size it may grow to, its image on the host, and when it was made. */
export function parseContainerVolumes(text: string): { name: string; labels: Record<string, string>; sizeBytes: number; source: string | null; createdAt: number }[] | null {
  const rows = array(text);
  if (!rows) return null;
  return rows.flatMap((r) => {
    const config = isObj(r) && isObj(r.configuration) ? r.configuration : null;
    const name = typeof config?.name === "string" ? config.name : isObj(r) && typeof r.id === "string" ? r.id : null;
    if (!config || !name) return [];
    const made = typeof config.creationDate === "string" ? Date.parse(config.creationDate) : Number.NaN;
    return [{ name, labels: strings(config.labels), sizeBytes: number(config.sizeInBytes) ?? 0, source: typeof config.source === "string" ? config.source : null, createdAt: Number.isFinite(made) ? made : 0 }];
  });
}
