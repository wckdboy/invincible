import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopArgv } from "../../packages/agents/src/desktop-command.ts";
import { withGateway } from "../../packages/agents/src/team-runtime.ts";
import { spawnSession } from "../../packages/sandbox/src/desktop-session.ts";
import { type DesktopAction, type DesktopView, microVMsAvailable, SandboxHost } from "../../packages/sandbox/src/host.ts";
import type { SandboxView } from "../../packages/core/src/index.ts";
import { pick, rng, subSeed } from "../lib.ts";
import { scratchArgs, scratchNames, scratchRunner, spawnDocker } from "./scratch.ts";
import { spawned } from "../spawned.ts";

/*
 * A VM of the desktop bench's: made by the node's own SandboxHost, as an agent's VM is made (its run arguments: Kata, a
 * read-only root, no capabilities, uid 1000), under the bench's names (scratch.ts), with no network: the pages it opens
 * are served from its own loopback (kit/server.py). Three ways in, as C0 measured them:
 *  - raw: `docker exec` straight in, for the bench's own setup and what is timed inside the VM;
 *  - agent: SandboxHost.exec of `bash -lc withGateway(…)`, as team-runtime runs every command of an agent's task;
 *  - owner: SandboxHost.desktop, which is what POST /api/team/desktop does on the VM's host.
 */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const KIT = join(dirname(fileURLToPath(import.meta.url)), "kit");
/** Where the kit is in the VM. */
export const IN_VM = "/work/bench";
/** The stand-in eyes' lease: a gateway on the VM's own loopback (kit/server.py), and a token that is obviously none. */
const LEASE = JSON.stringify({ INVINCIBLE_GATEWAY: "http://127.0.0.1:8000/stub", INVINCIBLE_TOKEN: "bench-not-a-token" });

/** Why the desktop suite can't run on this machine, or null when it can: Linux, KVM, Kata's shim, and a Docker that answers. */
export async function cannotRunHere(): Promise<string | null> {
  if (process.platform !== "linux") return `it needs Docker with Kata microVMs on Linux, and this is ${process.platform}`;
  if (!microVMsAvailable()) return "it needs Kata microVMs (KVM and containerd-shim-kata-v2), and this machine has none";
  if (!Bun.which("docker")) return "it needs Docker, and there is none here";
  const info = await spawnDocker(["info", "--format", "{{.ServerVersion}}"], 15_000);
  if (info.code !== 0) return `Docker isn't answering here: ${info.stderr.trim().split("\n")[0]?.slice(0, 200)}`;
  return null;
}

export interface Bench {
  prefix: string;
  names: ReturnType<typeof scratchNames>;
  host: SandboxHost;
  log: (line: string) => void;
}

export function bench(prefix: string, log: (line: string) => void): Bench {
  const names = scratchNames(prefix);
  const host = new SandboxHost({
    node: "bench",
    tokens: { mint: () => { throw new Error("a bench VM has no network, so no lease"); }, revoke: () => false },
    ledger: () => {},
    maxCpus: 8,
    maxMemoryGb: 16,
    microVMs: true,
    workspaces: null,
    runner: scratchRunner(prefix),
    // Its held desktop sessions under the bench's names too.
    spawnSession: (args) => spawnSession("docker")(scratchArgs(args, prefix)),
  });
  return { prefix, names, host, log };
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

const hex = (random: () => number, n: number): string => Array.from({ length: n }, () => pick(random, [..."0123456789abcdef"])).join("");

/** The pages a long text is made of: the same words, in the same order, from the seed. */
function longPage(seed: number, title: string): string {
  const random = rng(subSeed(seed, title));
  const words = ["a", "acts", "again", "agent", "and", "before", "changed", "checks", "clicks", "field", "into", "it", "link", "on", "opens", "page", "reads", "screen", "the", "types", "what"];
  const paragraphs = Array.from({ length: 120 }, () => `<p>${Array.from({ length: 120 }, () => pick(random, words)).join(" ")}</p>`);
  return `<!doctype html><meta charset=utf-8><title>${title}</title><style>body{font:16px serif;margin:40px;max-width:900px}</style><h1>Long page</h1>${paragraphs.join("\n")}\n`;
}

/** The kit as a tar: its files, and the long pages made from the seed. */
export async function kitTar(seed: number): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "invincible-bench-kit-"));
  try {
    cpSync(KIT, dir, { recursive: true });
    writeFileSync(join(dir, "pages/long.html"), longPage(seed, "long"));
    const tar = await spawned(["tar", "-C", dir, "-cf", "-", "."], { stdout: "pipe", stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`the kit couldn't be packed: ${tar.stderr.toString()}`);
    return tar.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class BenchVm {
  private constructor(
    readonly bench: Bench,
    readonly view: SandboxView,
    readonly run: string,
  ) {}

  get id(): string {
    return this.view.id;
  }

  /** The VM's container, by the bench's own name. */
  get container(): string {
    return this.bench.names.container(this.view.id);
  }

  /** A VM as the node makes an agent's: kept (persistent), a microVM, no network; the desktop image (with the hardware tools, where asked) or the workshop. */
  static async make(b: Bench, opts: { desktop: boolean; hardware?: boolean; cpus?: number; memoryGb?: number; seed: number }): Promise<{ vm: BenchVm; ms: number }> {
    const run = `arm.team.${hex(rng(subSeed(opts.seed, `${Date.now()}`)), 10)}.bench`;
    const t0 = performance.now();
    const view = await b.host.create({ network: "isolated", isolation: "vm", desktop: opts.desktop, ...(opts.hardware ? { hardware: true } : {}), cpus: opts.cpus ?? 1, memoryGb: opts.memoryGb ?? 4, ttlMinutes: 240, persistent: true, run });
    return { vm: new BenchVm(b, view, run), ms: performance.now() - t0 };
  }

  /** `docker exec` straight into the VM (as uid 1000, in /work): the bench's own path, with its time. */
  async raw(argv: string[], opts: { stdin?: Uint8Array | string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Ran> {
    const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const t0 = performance.now();
    const proc = Bun.spawn(["docker", "exec", ...(opts.stdin !== undefined ? ["--interactive"] : []), "--workdir", "/work", ...env, this.container, ...argv], {
      stdin: opts.stdin === undefined ? "ignore" : new Blob([typeof opts.stdin === "string" ? opts.stdin : new Uint8Array(opts.stdin)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr, ms: performance.now() - t0 };
  }

  /** Started detached in the VM (its server). */
  async detached(argv: string[]): Promise<void> {
    const ran = await spawnDocker(["exec", "--detach", "--workdir", "/work", this.container, ...argv], 60_000);
    if (ran.code !== 0) throw new Error(`couldn't start ${argv.join(" ")} in the VM: ${ran.stderr.trim()}`);
  }

  /** The kit in /work/bench, the stand-in eyes' lease in place, and its server on the VM's loopback. */
  async ready(seed: number): Promise<void> {
    const put = await this.raw(["sh", "-c", `mkdir -p ${IN_VM}/out && tar -xf - -C ${IN_VM} && printf '%s' "$1" > /work/.invincible-gateway.json`, "sh", LEASE], { stdin: await kitTar(seed) });
    if (put.code !== 0) throw new Error(`the kit couldn't be put in the VM: ${put.stderr.trim()}`);
    await this.detached(["python3", `${IN_VM}/server.py`, "8000"]);
    for (let i = 0; i < 50; i++) {
      if ((await this.raw(["python3", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/type.html',timeout=2)"])).code === 0) return;
      await Bun.sleep(100);
    }
    throw new Error("the bench's server in the VM never answered");
  }

  /**
   * One command the way an agent's task runs it, as team-runtime's exec does: a plain `desktop …` as its words alone
   * (to the VM's held desktop session, where its image has one: desktop-command.ts), anything else SandboxHost.exec of
   * `bash -lc withGateway(…)`, with the task's temporary directory and its eyes named.
   */
  async agent(command: string, timeoutSec = 120): Promise<Ran> {
    const temp = "/work/.tmp/bench";
    const t0 = performance.now();
    const direct = desktopArgv(command, "stub/eyes");
    const r = await this.bench.host.exec(this.id, direct ? ["desktop", ...direct] : ["bash", "-lc", withGateway(`mkdir -p '${temp}' && export TMPDIR='${temp}' && export INVINCIBLE_EYES=stub/eyes && cd /work && ${command}`)], timeoutSec);
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t0 };
  }

  /** One thing done the way the owner does it from the app: SandboxHost.desktop, which brings back a fresh picture. */
  async owner(action: DesktopAction): Promise<{ view: DesktopView; ms: number }> {
    const t0 = performance.now();
    const view = await this.bench.host.desktop(this.id, this.run, action);
    if (!("shot" in view)) throw new Error("the desktop brought back no picture");
    return { view, ms: performance.now() - t0 };
  }

  /** The container's whole id, which its microVM's processes on the host carry. */
  async containerId(): Promise<string> {
    const r = await spawnDocker(["inspect", "--format", "{{.Id}}", this.container], 30_000);
    if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(r.stdout.trim())) throw new Error(`couldn't read ${this.container}'s id`);
    return r.stdout.trim();
  }

  async remove(): Promise<void> {
    await this.bench.host.destroy(this.id, { approvedBy: "bench" });
  }
}

/** Whatever of the bench's own a run before this one left behind: its VMs and their volumes, by its label alone. */
export async function clearLeftovers(b: Bench): Promise<number> {
  const listed = await spawnDocker(["ps", "-aq", "--filter", `label=${b.names.label}=1`], 30_000);
  const ids = listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) await spawnDocker(["rm", "--force", "--volumes", ...ids], 120_000);
  const volumes = await spawnDocker(["volume", "ls", "-q", "--filter", `label=${b.names.label}=1`], 30_000);
  const named = volumes.stdout.split("\n").map((s) => s.trim()).filter((v) => v.startsWith(`${b.prefix}-sbx-`));
  if (named.length) await spawnDocker(["volume", "rm", "--force", ...named], 120_000);
  return ids.length + named.length;
}

/* ---------- what a VM costs its host (Linux: /proc) ---------- */

export interface Usage {
  /** CPU ticks (1/100 s) of each part. */
  ticks: { qemu: number; virtiofsd: number; shim: number };
  /** Proportional set size of all its processes, MB, and the VM's own process's resident size. */
  pssMb: number;
  qemuRssMb: number;
}

/** The host's processes of a microVM: its QEMU, its virtiofsd daemons and its shim, found by the container's id in their command lines. */
export function vmProcesses(containerId: string): { qemu: number[]; virtiofsd: number[]; shim: number[] } {
  const found = { qemu: [] as number[], virtiofsd: [] as number[], shim: [] as number[] };
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ");
    } catch {
      continue;
    }
    if (!cmdline.includes(containerId)) continue;
    const pid = Number(entry);
    if (/qemu-system/.test(cmdline)) found.qemu.push(pid);
    else if (/virtiofsd/.test(cmdline)) found.virtiofsd.push(pid);
    else if (/containerd-shim-kata/.test(cmdline)) found.shim.push(pid);
  }
  return found;
}

const ticksOf = (pid: number): number => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
};
const kbOf = (pid: number, file: string, key: string): number => {
  try {
    const line = readFileSync(`/proc/${pid}/${file}`, "utf8").split("\n").find((l) => l.startsWith(`${key}:`));
    return line ? Number(line.split(/\s+/)[1]) : 0;
  } catch {
    return 0;
  }
};

export function usage(containerId: string): Usage {
  const p = vmProcesses(containerId);
  if (!p.qemu.length) throw new Error(`no QEMU for ${containerId.slice(0, 12)} on this host`);
  const sum = (pids: number[], f: (pid: number) => number) => pids.reduce((s, pid) => s + f(pid), 0);
  const all = [...p.qemu, ...p.virtiofsd, ...p.shim];
  return {
    ticks: { qemu: sum(p.qemu, ticksOf), virtiofsd: sum(p.virtiofsd, ticksOf), shim: sum(p.shim, ticksOf) },
    pssMb: sum(all, (pid) => kbOf(pid, "smaps_rollup", "Pss")) / 1024,
    qemuRssMb: sum(p.qemu, (pid) => kbOf(pid, "status", "VmRSS")) / 1024,
  };
}

/** A window of `seconds` on a VM: its host CPU as a percentage of one core, and its memory at the end. */
export async function window(containerId: string, seconds: number, during?: (end: number) => Promise<void>): Promise<{ cpuPct: number; pssMb: number; qemuRssMb: number }> {
  const a = usage(containerId);
  const t0 = performance.now();
  const end = t0 + seconds * 1000;
  await Promise.all([Bun.sleep(seconds * 1000), during?.(end)]);
  const b = usage(containerId);
  const elapsed = (performance.now() - t0) / 1000;
  const ticks = b.ticks.qemu + b.ticks.virtiofsd + b.ticks.shim - (a.ticks.qemu + a.ticks.virtiofsd + a.ticks.shim);
  return { cpuPct: ticks / elapsed, pssMb: b.pssMb, qemuRssMb: b.qemuRssMb };
}

