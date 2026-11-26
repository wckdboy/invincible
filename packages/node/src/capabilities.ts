import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { preset } from "@galahad/brain";
import type { Presence } from "@galahad/core";
import { type ContainerHostCaps, probeContainer, probeSandbox } from "@galahad/sandbox";

/*
 * What this body can do. Stable facts go into the node's profile in the mind
 * (re-published only when they change); live load travels with sync as presence.
 */

export interface Capabilities {
  os: string;
  arch: string;
  hostname: string;
  cores: number;
  cpu: string;
  memoryGb: number;
  hasBattery: boolean;
  gpu: { name: string; memoryGb: number | null }[];
  docker: boolean;
  vm: { kvm: boolean; tools: string[] };
  tools: string[];
  localModels: { runtime: string; models: string[] }[];
  tailscale: { ip: string | null; dnsName: string | null } | null;
  /** Present when this node can host sandboxes (Docker reachable, or on a Mac Apple's container answering). */
  /** vm: it can also run sandboxes as KVM microVMs (Kata); on a Mac every one is a VM. A Mac's says more (ContainerHostCaps):
   *  engine "container", what it won't make (`cannot`: placement sends that elsewhere), and `grows: false` (its VMs pause to). */
  sandbox?: { image: boolean; networks: boolean; vm?: boolean; engine?: ContainerHostCaps["engine"]; cannot?: string[]; grows?: false; images?: string[] } | null;
  /** Apple's container, where this Mac has its binary: its version, and whether its service answers. Absent: not found. */
  container?: { version: string | null; running: boolean };
  /** This node keeps its Mac from sleeping while it runs (`galahad awake on`: keep-awake.ts). Absent: it doesn't. */
  awake?: boolean;
  /** This Mac's own screen can be Galahad's (mac-screen.ts: its node runs from the app). Whether macOS allows it now is asked of it. */
  screen?: true;
}

const TOOLS = [
  "git", "gh", "docker", "podman", "incus", "virsh", "qemu-system-x86_64", "multipass", "nix",
  "ollama", "llama-server", "vllm", "mlx_lm.server",
  "opencode", "hermes", "claude", "codex", "cursor-agent", "t3", "sccache", "uv", "python3", "node", "bun",
];

async function run(cmd: string[], timeoutMs = 3000): Promise<string | null> {
  if (!Bun.which(cmd[0]!)) return null;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

async function gpus(): Promise<Capabilities["gpu"]> {
  const nvidia = await run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (nvidia) {
    return nvidia.split("\n").filter(Boolean).map((line) => {
      const [name, mem] = line.split(",").map((s) => s.trim());
      return { name: name ?? "nvidia", memoryGb: mem ? Math.round(Number(mem) / 1024) : null };
    });
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return [{ name: "Apple Silicon (unified memory)", memoryGb: Math.round(os.totalmem() / 2 ** 30) }];
  }
  return [];
}

/** The local runtimes asked what they serve: each at the address its preset points to (providers.ts), its /models. */
export const RUNTIME_PROBES: [string, string][] = ["ollama", "llamacpp"].map((id) => [id, `${preset(id)!.baseUrl}/models`]);

async function localModels(): Promise<Capabilities["localModels"]> {
  const out: Capabilities["localModels"] = [];
  await Promise.all(
    RUNTIME_PROBES.map(async ([runtime, url]) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(800) });
        if (!response.ok) return;
        const json = (await response.json()) as { data?: { id: string }[] };
        out.push({ runtime, models: (json.data ?? []).map((m) => m.id).slice(0, 50) });
      } catch {
        /* runtime not running */
      }
    }),
  );
  return out;
}

export async function tailscaleInfo(): Promise<Capabilities["tailscale"]> {
  const raw = await run(["tailscale", "status", "--json", "--self", "--peers=false"]);
  if (!raw) return null;
  try {
    const status = JSON.parse(raw) as { Self?: { TailscaleIPs?: string[]; DNSName?: string } };
    const ip = status.Self?.TailscaleIPs?.find((a) => a.includes(".")) ?? null;
    return { ip, dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null };
  } catch {
    return null;
  }
}

/**
 * Where `tailscale serve` publishes the PWA that this node's proxy port serves, from
 * `tailscale serve status --json`: its https origin (the port left out when it's 443),
 * or null when no web handler proxies to that port.
 */
export function servedOriginFrom(statusJson: string, proxyPort: number): string | null {
  let status: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  try {
    status = JSON.parse(statusJson);
  } catch {
    return null;
  }
  const targets = ["127.0.0.1", "localhost", "[::1]"].flatMap((host) => ["http", "https"].flatMap((scheme) => [`${scheme}://${host}:${proxyPort}`, `${scheme}://${host}:${proxyPort}/`]));
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string" || !targets.includes(proxy)) continue;
    const m = hostPort.match(/^([A-Za-z0-9.-]+):(\d+)$/);
    if (!m) continue;
    return m[2] === "443" ? `https://${m[1]}` : `https://${m[1]}:${m[2]}`;
  }
  return null;
}

/** The PWA's address on the tailnet, as `tailscale serve` publishes this node's proxy port; null when it doesn't. */
export async function servedOrigin(proxyPort: number): Promise<string | null> {
  const raw = await run(["tailscale", "serve", "status", "--json"]);
  return raw ? servedOriginFrom(raw, proxyPort) : null;
}

/**
 * A server: Linux and no battery; or a Mac with no battery that its node keeps awake (a Mac mini set to stay on:
 * `galahad awake on`, docs/MAC.md). Other Windows and macOS machines are personal bodies that sleep and travel,
 * battery or not (Windows doesn't always report a laptop's battery).
 */
export const isAlwaysOn = (caps: Partial<Pick<Capabilities, "os" | "hasBattery" | "awake">> | null | undefined): boolean =>
  caps?.hasBattery === false && (caps.os === "linux" || (caps.os === "darwin" && caps.awake === true));

function hasBattery(macPower: string | null): boolean {
  if (process.platform === "linux") {
    return ["BAT0", "BAT1"].some((b) => existsSync(`/sys/class/power_supply/${b}`));
  }
  // A Mac's own word (pmset), not a guess from its name: a laptop has an internal battery, a Mac mini none.
  return process.platform === "darwin" ? macHasBattery(macPower) : false;
}

/** Whether `pmset -g batt` speaks of an internal battery (null: it couldn't be asked, so none is assumed). */
export const macHasBattery = (pmsetBatt: string | null): boolean => !!pmsetBatt && /InternalBattery/.test(pmsetBatt);

/**
 * Which sandbox host this body is. A Mac with Apple's container hosts through it, running or not (never through
 * Docker one day and container the next, which would leave one's sandboxes unseen by the other), and says it found
 * it; any other body through Docker where Docker answers, as before.
 */
export function sandboxHostOf(
  platform: string,
  container: Awaited<ReturnType<typeof probeContainer>>,
  docker: Capabilities["sandbox"] | null,
): Pick<Capabilities, "sandbox" | "container"> {
  if (platform === "darwin" && container) return { sandbox: container.sandbox, container: container.container };
  return { sandbox: docker };
}

export async function probeCapabilities(): Promise<Capabilities> {
  const tools = TOOLS.filter((tool) => Bun.which(tool));
  const [gpu, models, docker, tailscale, windowsBattery, sandbox, macPower, container] = await Promise.all([
    gpus(),
    localModels(),
    tools.includes("docker") ? run(["docker", "info", "--format", "{{.ServerVersion}}"], 5000) : Promise.resolve(null),
    tailscaleInfo(),
    process.platform === "win32" ? batteryWindows() : Promise.resolve(null),
    tools.includes("docker") ? probeSandbox() : Promise.resolve(null),
    process.platform === "darwin" ? run(["pmset", "-g", "batt"]) : Promise.resolve(null),
    process.platform === "darwin" ? probeContainer() : Promise.resolve(null),
  ]);
  const cpus = os.cpus();
  return {
    os: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cores: cpus.length,
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    hasBattery: process.platform === "win32" ? windowsBattery !== null : hasBattery(macPower),
    gpu,
    docker: !!docker,
    vm: {
      kvm: process.platform === "linux" && existsSync("/dev/kvm"),
      tools: tools.filter((t) => ["incus", "virsh", "qemu-system-x86_64", "multipass"].includes(t)),
    },
    tools,
    localModels: models,
    tailscale,
    ...sandboxHostOf(process.platform, container, sandbox),
  };
}

async function batteryWindows(): Promise<{ onBattery: boolean; percent: number } | null> {
  const out = await run(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress",
    ],
    5000,
  );
  if (!out) return null;
  try {
    const b = JSON.parse(out) as { BatteryStatus?: number; EstimatedChargeRemaining?: number };
    return { onBattery: b.BatteryStatus === 1, percent: b.EstimatedChargeRemaining ?? 0 };
  } catch {
    return null;
  }
}

function batteryLinux(): { onBattery: boolean; percent: number } | null {
  for (const bat of ["BAT0", "BAT1"]) {
    const dir = `/sys/class/power_supply/${bat}`;
    if (!existsSync(dir)) continue;
    try {
      const status = readFileSync(`${dir}/status`, "utf8").trim();
      const percent = Number(readFileSync(`${dir}/capacity`, "utf8").trim());
      return { onBattery: status === "Discharging", percent };
    } catch {
      return null;
    }
  }
  return null;
}

let batteryCache: { at: number; value: { onBattery: boolean; percent: number } | null } | null = null;

export async function presence(): Promise<Presence> {
  if (!batteryCache || Date.now() - batteryCache.at > 60_000) {
    const value = process.platform === "win32" ? await batteryWindows() : process.platform === "linux" ? batteryLinux() : null;
    batteryCache = { at: Date.now(), value };
  }
  const cores = os.cpus().length;
  return {
    load: process.platform === "win32" ? 0 : (os.loadavg()[0] ?? 0),
    cores,
    freeMemoryGb: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
    onBattery: batteryCache.value?.onBattery ?? null,
    batteryPercent: batteryCache.value?.percent ?? null,
  };
}
