import { readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DoctorReport, freeSlots, type NodeCapacity, type NodeIdentity, nextRun, type PeerStatus, redact, type Teammate } from "@galahad/core";
import { type BrainContext, chat, embed, installedConnectors, isEmbeddingModel, keyState, onPlan, parseRef, planOf, providerRecord, providerRecords, refusalsStillSaid, resolveProvider, ROLES, roster, windowsOf } from "@galahad/brain";
import type { MindStore, Vault } from "@galahad/mind";
import { containerKernel, macFirewallInstalled, type SandboxHost } from "@galahad/sandbox";
import type { ArchiveService } from "./archive/service.ts";
import { ungivable } from "./key-gateway.ts";
import type { Assets } from "./assets.ts";
import { type Capabilities, isAlwaysOn, servedOriginFrom } from "./capabilities.ts";
import type { Governor } from "./compute/governor.ts";
import type { ComputeService } from "./compute/service.ts";
import { type Diagnosis, diagnose, type DoctorFacts, type DoctorFinding, doctorFindings, type FileFact, reportOf, type RoleFact, TOOL_ROLES, VM_TOOLS_CANT } from "./doctor.ts";
import { hlcMs, loopRecords } from "./loops.ts";

/*
 * The doctor's eyes: the facts `diagnose` judges, gathered from this node. Reading
 * only. It writes to no file and no database, starts nothing that outlives it, and
 * keeps secrets out of what it gathers (a file is only stat'ed, never opened; an
 * error's text is redacted).
 *
 * Three things reach beyond reading, and each is bounded and said plainly:
 *  - a full check starts one sandbox per kind this host has, runs `true` in it and
 *    removes it, through the node's own governed host (so it takes a slot, never
 *    queues behind real work, and is in the ledger like every sandbox);
 *  - a full check that isn't offline asks the first usable model of each role for
 *    one word, and sends each connector's service one request that carries nothing;
 *  - a local embedder is asked to embed one word (it never leaves the machine).
 */

/** What the doctor asks of the machine itself. Tests hand it stand-ins; `noSystem` asks nothing. */
export interface DoctorSystem {
  /** A file's permission bits (never its content). null: not looked at. */
  file(path: string): FileFact | null;
  /** A local command that only reads: its exit code and output, or null when it isn't there or takes too long. */
  run(cmd: string[], timeoutMs?: number): Promise<{ code: number; stdout: string } | null>;
  platform: string;
  /** This process was started by systemd. */
  underSystemd: boolean;
  disk(path: string): { freeGb: number; totalGb: number } | null;
  /** The files in a backups directory: how many, and the newest one's time. null: not looked for. */
  backups(dir: string): { exists: boolean; newestAt: number | null; files: number } | null;
  /** Another node's clock minus this one's, in ms, from the Date of its answer to a request that carries nothing. */
  peerClock(endpoint: string): Promise<number | null>;
  /**
   * A Mac's sandbox firewall as it is in root's places (its helper and launchd job, which anyone may read): this
   * release's, another's, or none. null: not looked at (off a Mac).
   */
  macFirewallFiles(): "current" | "other" | "none" | null;
}

async function runCommand(cmd: string[], timeoutMs = 3000): Promise<{ code: number; stdout: string } | null> {
  if (!Bun.which(cmd[0]!)) return null;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout: stdout.trim() };
  } catch {
    return null;
  }
}

export const realSystem: DoctorSystem = {
  file(path) {
    try {
      const stats = statSync(path);
      // Windows has no permission bits worth reading: the profile's ACL is what guards the file.
      return { exists: true, mode: process.platform === "win32" ? null : stats.mode & 0o777 };
    } catch {
      return { exists: false, mode: null };
    }
  },
  run: runCommand,
  platform: process.platform,
  underSystemd: !!process.env.INVOCATION_ID,
  disk(path) {
    try {
      const stats = statfsSync(path);
      const gb = (blocks: number) => (blocks * stats.bsize) / 2 ** 30;
      return { freeGb: Math.round(gb(stats.bavail) * 10) / 10, totalGb: Math.round(gb(stats.blocks)) };
    } catch {
      return null;
    }
  },
  backups(dir) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return { exists: false, newestAt: null, files: 0 };
    }
    let newestAt: number | null = null;
    let files = 0;
    for (const name of names.slice(0, 5000)) {
      try {
        const stats = statSync(join(dir, name));
        if (!stats.isFile()) continue;
        files += 1;
        if (newestAt === null || stats.mtimeMs > newestAt) newestAt = Math.round(stats.mtimeMs);
      } catch {
        /* gone since it was listed */
      }
    }
    return { exists: true, newestAt, files };
  },
  async peerClock(endpoint) {
    try {
      const sent = Date.now();
      const response = await fetch(`${endpoint}/api/whoami`, { signal: AbortSignal.timeout(3000), redirect: "manual", cache: "no-store" });
      const got = Date.now();
      await response.body?.cancel().catch(() => {});
      const theirs = Date.parse(response.headers.get("date") ?? "");
      // A Date header counts whole seconds: its middle, against the middle of the round trip.
      return Number.isFinite(theirs) ? Math.round(theirs + 500 - (sent + got) / 2) : null;
    } catch {
      return null;
    }
  },
  macFirewallFiles() {
    if (process.platform !== "darwin") return null;
    return macFirewallInstalled((path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  },
};

/** Asks the machine nothing (tests that pass their own capabilities): every such fact is "not known". */
export const noSystem: DoctorSystem = {
  file: () => null,
  run: async () => null,
  platform: "test",
  underSystemd: false,
  disk: () => null,
  backups: () => null,
  peerClock: async () => null,
  macFirewallFiles: () => null,
};

/* ---------- the node's own log, as far as it reads like trouble ---------- */

const TROUBLE = /\b(fail(ed|s|ure)?|errors?|unavailable|unreachable|refus(ed|es)|rejected|denied|timed out|timeout|crash(ed)?|not (created|refreshed|published|written)|skipped|can't|couldn't|is off)\b/i;

/** The last lines of the node's log that read like trouble, redacted when they're kept. In memory only. */
export class TroubleLog {
  private readonly lines: { at: number; text: string }[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly keep = 60,
  ) {}

  note(message: string): void {
    if (!TROUBLE.test(message)) return;
    this.lines.unshift({ at: this.now(), text: redact(message).replace(/\s+/g, " ").slice(0, 300) });
    if (this.lines.length > this.keep) this.lines.length = this.keep;
  }

  /** Newest first. */
  recent(): { at: number; text: string }[] {
    return [...this.lines];
  }
}

/* ---------- gathering ---------- */

export interface DoctorDeps {
  store: MindStore;
  vault: Vault;
  identity: NodeIdentity;
  nodeName: string;
  home: { dir: string; keyFilePath: string; adminTokenPath: string; pushKeyPath: string };
  keystore: "os" | "file";
  sync: { status(): PeerStatus[] };
  caps: () => Capabilities | null;
  /** The node's own governed sandbox host (null: it hosts none). */
  sandbox: SandboxHost | null;
  governor: Governor;
  compute: ComputeService;
  archive: ArchiveService | null;
  /** The archive's background work was turned off (GALAHAD_ARCHIVE=off). */
  archiveOff: boolean;
  assets: Assets;
  port: number;
  proxyPort: number;
  startedAt: number;
  trouble: TroubleLog;
  system: DoctorSystem;
  /** Where backups of the mind are kept, when the owner said (GALAHAD_BACKUP_DIR). */
  backupDir?: string;
  /** How the node reaches models and services (tests pass a stand-in). */
  fetch?: typeof fetch;
  now?: () => number;
  /** Push notifications, as this node holds them (set once there are any). */
  notify?: () => DoctorFacts["notify"];
  /** The Roundtable's knights (absent: a node with no Roundtable). */
  knights?: () => readonly Teammate[];
}

export interface DoctorOptions {
  /** Only what costs nothing to look at. */
  quick?: boolean;
  /** Nothing is sent outward: no model is asked, no connector's service probed. */
  offline?: boolean;
  signal?: AbortSignal;
}

/** One model is asked for at most this long; a connector's service, a local embedder and a sandbox's command likewise bounded. */
export const MODEL_PROBE_MS = 20_000;
const CONNECTOR_PROBE_MS = 5_000;
const EMBED_PROBE_MS = 10_000;
/** At most this many models are asked in one check, whatever the roster holds. */
const MAX_MODEL_PROBES = 6;
const DOCTOR_QUEST = "galahad.doctor";
/** The files the app can't open without. */
const APP_FILES = ["/", "/app.js", "/boot.js", "/sw.js", "/pair.js", "/manifest.webmanifest"];
const SILENT_ROLES = new Set(["decider", "embedder"]);
/** The local runtimes a node probes for (capabilities.ts). */
const LOCAL_RUNTIMES = new Set(["ollama", "llamacpp"]);

const message = (error: unknown): string => redact(String((error as Error)?.message ?? error)).replace(/\s+/g, " ").slice(0, 300);

/** Why this node can't use a model (null: it can), in the words a skipped model gets in chat. */
function modelProblem(deps: DoctorDeps, ref: string): string | null {
  let parsed: { provider: string; model: string };
  try {
    parsed = parseRef(ref);
  } catch {
    return "not a <provider>/<model> reference";
  }
  // Its allowance spent until a time its provider gave: passed over until then (brain/windows.ts), and said so.
  const spent = windowsOf(deps.store).spentFor(ref);
  if (spent) return windowsOf(deps.store).why(spent);
  // (A coding plan's model is the knights' tools' to use: what is asked of it is whether a tool would get its key.)
  const provider = resolveProvider(deps.store, deps.vault, parsed.provider, onPlan(ref) ? "tool" : "own");
  if (!provider) return `provider "${parsed.provider}" is not configured`;
  if (provider.local) {
    // The two runtimes this node looks for itself; any other local address is judged by asking it (a full check).
    if (!LOCAL_RUNTIMES.has(parsed.provider)) return null;
    const runtime = (deps.caps()?.localModels ?? []).find((r) => r.runtime === parsed.provider);
    return runtime?.models.length ? null : "its local runtime isn't running on this machine";
  }
  return provider.apiKey ? null : `provider "${parsed.provider}" has no key in the vault`;
}

/** The model a reference means on this node: `<runtime>/*` is the first chat model that runtime serves here. */
function concrete(deps: DoctorDeps, ref: string): string | null {
  const { provider, model } = parseRef(ref);
  if (model !== "*") return ref;
  const served = (deps.caps()?.localModels ?? []).find((r) => r.runtime === provider)?.models.find((m) => !isEmbeddingModel(m));
  return served ? `${provider}/${served}` : null;
}

/** One word from one model, through the same door every answer of his goes through. Stopped at its first word. */
async function askOneWord(ctx: BrainContext, ref: string, outer?: AbortSignal): Promise<{ ref: string; ok: boolean; ms: number; error: string | null }> {
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, MODEL_PROBE_MS);
  const abort = () => stop.abort();
  outer?.addEventListener("abort", abort, { once: true });
  const started = performance.now();
  let ok = false;
  let error: string | null = null;
  try {
    for await (const event of chat(ctx, { model: ref, messages: [{ role: "user", content: "Reply with the single word: ok" }], signal: stop.signal })) {
      if (event.type === "text" && event.text.trim()) {
        ok = true;
        break;
      }
      if (event.type === "fallback") error = event.error;
      else if (event.type === "error") {
        // Why this model was passed over says more than "no model could answer".
        error ??= event.error;
        break;
      } else if (event.type === "done") break;
    }
    if (!ok && !error) error = timedOut ? `no answer within ${MODEL_PROBE_MS / 1000} s (timed out)` : "it ended without a word";
  } catch (failure) {
    error = timedOut ? `no answer within ${MODEL_PROBE_MS / 1000} s (timed out)` : message(failure);
  } finally {
    stop.abort();
    clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
  return { ref, ok, ms: Math.round(performance.now() - started), error: ok ? null : redact(error ?? "no answer").slice(0, 300) };
}

async function rolesOf(deps: DoctorDeps, ask: boolean, signal?: AbortSignal): Promise<RoleFact[]> {
  const roles: RoleFact[] = Object.entries(roster(deps.store)).map(([role, spec]) => ({
    role,
    ...(spec.custom ? { custom: true } : {}),
    chats: !SILENT_ROLES.has(role),
    models: spec.models.slice(0, 16).map((ref) => {
      // A role a VM's tools play can't have a plan its terms keep to a tool you run yourself (the gateway refuses a VM it).
      const kept = TOOL_ROLES.has(role) && onPlan(ref) && planOf(ref.slice(0, ref.indexOf("/")))?.allows.tools !== "unattended";
      // A provider whose allowance is spent now: marked so the doctor can leave it out of a role's plan and first lines
      // (the window ends by itself, so it is no fault) while its problem still says what the provider said.
      const spent = !kept && windowsOf(deps.store).spentFor(ref) !== null;
      return { ref, problem: kept ? VM_TOOLS_CANT : modelProblem(deps, ref), ...(spent ? { spent: true } : {}), ...(onPlan(ref) ? { plan: true } : {}) };
    }),
    ...(!spec.configured && spec.models.every((ref) => providerRecord(deps.store, ref.slice(0, ref.indexOf("/"))) === null) ? { unset: true } : {}),
    probe: null,
  }));
  if (!ask) return roles;
  // Each role's first usable model, asked once however many roles share it.
  const wanted = new Map<string, RoleFact[]>();
  for (const role of roles) {
    if (!role.chats) continue;
    // (His own: a coding plan's model is never asked a word by him.)
    const first = role.models.find((m) => m.problem === null && !m.plan);
    const ref = first ? concrete(deps, first.ref) : null;
    if (!ref) continue;
    if (!wanted.has(ref) && wanted.size >= MAX_MODEL_PROBES) continue;
    wanted.set(ref, [...(wanted.get(ref) ?? []), role]);
  }
  const ctx: BrainContext = { store: deps.store, vault: deps.vault, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  await Promise.all(
    [...wanted].map(async ([ref, askers]) => {
      const probe = await askOneWord(ctx, ref, signal);
      for (const role of askers) role.probe = probe;
    }),
  );
  return roles;
}

/** A sandbox of each kind this host has (a Mac's are all VMs): started, one command run, removed. Never when no slot is free. */
async function startSandboxes(host: SandboxHost, governor: Governor, capacity: () => NodeCapacity): Promise<NonNullable<NonNullable<DoctorFacts["sandbox"]["host"]>["start"]>> {
  const out: { kind: "container" | "vm"; ok: boolean; ms: number; error: string | null }[] = [];
  for (const kind of host.kinds) {
    if (freeSlots(capacity(), governor.use(), governor.hostNow()) < 1 || governor.usage().queued > 0) return out.length ? out : "busy";
    const started = performance.now();
    let id: string | null = null;
    try {
      // (As cut off as this host cuts one off: no network, or on a Mac, which has none such, the gateway's alone.)
      const sandbox = await host.create({ cpus: 1, memoryGb: 1, ttlMinutes: 5, persistent: false, quest: DOCTOR_QUEST, network: host.strictest, isolation: kind });
      id = sandbox.id;
      const ran = await host.exec(sandbox.id, ["true"], 30);
      out.push({ kind, ok: ran.exitCode === 0, ms: Math.round(performance.now() - started), error: ran.exitCode === 0 ? null : `its command exited ${ran.exitCode}: ${message(ran.stderr || ran.stdout)}` });
    } catch (error) {
      out.push({ kind, ok: false, ms: Math.round(performance.now() - started), error: message(error) });
    } finally {
      // His own, ephemeral, made for this look: the oath lets him remove it.
      if (id) await host.destroy(id, { quest: DOCTOR_QUEST }).catch(() => {});
    }
  }
  return out;
}

async function sandboxOf(deps: DoctorDeps, deep: boolean): Promise<DoctorFacts["sandbox"]> {
  const caps = deps.caps();
  const others = deps.store
    .devices()
    .filter((d) => d.kind === "node" && d.id !== deps.identity.id && (d.profile?.caps as Partial<Capabilities> | undefined)?.sandbox)
    .map((d) => {
      const status = deps.sync.status().find((s) => s.device === d.id);
      return { name: d.name, online: !!status?.online, image: !!(d.profile?.caps as Partial<Capabilities>).sandbox?.image };
    });
  const host = deps.sandbox;
  // (A Mac's Apple's container, where it has one: running or not, it is what the Mac hosts through; and whether it has
  // the kernel its VMs boot, which it keeps under your home.)
  const container = caps?.container ? { container: { ...caps.container, kernel: !!deps.system.file(containerKernel(homedir()))?.exists } } : {};
  if (!host) return { host: null, others, ...container };
  const [status, diskLimited] = await Promise.all([host.status().catch(() => ({ docker: false, image: false, networks: { gateway: false, online: false } })), host.diskLimited().catch(() => false)]);
  const microVMs = !!caps?.sandbox?.vm;
  let firewall: NonNullable<DoctorFacts["sandbox"]["host"]>["firewall"] = null;
  if (deps.system.platform === "linux") {
    const unit = await deps.system.run(["systemctl", "is-active", "galahad-firewall.service"]);
    // is-active prints the state and exits non-zero unless it's active; a unit that doesn't exist reads "inactive" too.
    if (unit) firewall = unit.stdout === "active" ? "active" : (await deps.system.run(["systemctl", "cat", "galahad-firewall.service"]))?.code === 0 ? "inactive" : "missing";
  }
  // A Mac's own, as the node reads it (its helper's status and the bridges): no sandbox is made there while it is off.
  const wall = await host.firewallState().catch(() => null);
  const files = wall ? deps.system.macFirewallFiles() : null;
  const macFirewall = wall ? { macFirewall: { on: wall.on, installed: wall.on || wall.installed, soon: !wall.on && wall.soon, why: wall.on ? null : wall.why, ...(files ? { release: files } : {}) } } : {};
  // Never when the image is missing: creating a sandbox would rebuild it, and the doctor changes nothing.
  // (Nor on a Mac whose firewall is off: it refuses to, by design, and its own line says so.)
  const start = deep && status.docker && status.image && (!wall || wall.on) ? await startSandboxes(host, deps.governor, () => deps.compute.selfCapacity()).catch(() => null) : null;
  return {
    host: { docker: status.docker, ...(caps?.sandbox?.engine === "container" ? { engine: "container" as const } : {}), image: status.image, networks: status.networks.gateway && status.networks.online, diskLimited, kvm: !!caps?.vm.kvm, microVMs, firewall, ...macFirewall, start },
    others,
    ...container,
  };
}

async function archiveOf(deps: DoctorDeps, deep: boolean, offline: boolean): Promise<DoctorFacts["archive"]> {
  if (!deps.archive) return null;
  const status = deps.archive.status();
  const e = status.embedder;
  let probe: { ok: boolean; ms: number; error: string | null } | null = null;
  // A local embedder is always asked (nothing leaves the machine); a remote one only by a full check that isn't offline.
  if (e.model && (e.local === true || (deep && !offline))) {
    const started = performance.now();
    try {
      await embed({ store: deps.store, vault: deps.vault, ...(deps.fetch ? { fetch: deps.fetch } : {}) }, ["ok"], { as: "query", timeoutMs: EMBED_PROBE_MS });
      probe = { ok: true, ms: Math.round(performance.now() - started), error: null };
    } catch (error) {
      probe = { ok: false, ms: Math.round(performance.now() - started), error: message(error) };
    }
  }
  return {
    off: deps.archiveOff,
    entries: status.entries,
    chunks: status.chunks,
    backlog: status.backlog,
    embedder: { model: e.model, state: e.state, error: e.error ? redact(e.error) : null, local: e.local, probe },
    integrity: { lastAt: status.integrity.lastAt, ok: status.integrity.ok, problems: status.integrity.problems.length },
    sourceErrors: status.sources.flatMap((s) => (s.lastError ? [{ name: s.name, error: redact(s.lastError).slice(0, 200) }] : [])),
  };
}

/** Does a connector's service answer at all? One request that carries no key, no cookie and no argument; any answer counts. */
async function reach(origin: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; ms: number; error: string | null }> {
  const started = performance.now();
  try {
    const response = await fetchImpl(`${origin}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(CONNECTOR_PROBE_MS), headers: { accept: "*/*" } });
    await response.body?.cancel().catch(() => {});
    return { ok: true, ms: Math.round(performance.now() - started), error: null };
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, ms: Math.round(performance.now() - started), error: timedOut ? `no answer within ${CONNECTOR_PROBE_MS / 1000} s` : "the connection failed" };
  }
}

async function connectorsOf(deps: DoctorDeps, probe: boolean): Promise<DoctorFacts["connectors"]> {
  return Promise.all(
    installedConnectors(deps.store).map(async (c) => {
      const origin = c.manifest?.origin ?? null;
      let host: string | null = null;
      try {
        host = origin ? new URL(origin).host : null;
      } catch {
        host = null;
      }
      const key = c.manifest ? keyState(deps.vault, c.manifest) : "none-needed";
      return { id: c.id, label: c.manifest?.label ?? c.id, host, key, problem: c.problem, reach: probe && origin && !c.problem ? await reach(origin, deps.fetch ?? fetch) : null };
    }),
  );
}

export async function gatherFacts(deps: DoctorDeps, opts: DoctorOptions = {}): Promise<DoctorFacts> {
  const now = (deps.now ?? Date.now)();
  const quick = !!opts.quick;
  const offline = !!opts.offline;
  const deep = !quick;
  const store = deps.store;
  const self = deps.identity.id;
  const caps = deps.caps();
  const system = deps.system;
  const statuses = new Map(deps.sync.status().map((s) => [s.device, s]));
  const active = new Set(store.devices().map((d) => d.id));

  const peerNodes = store.devices().filter((d) => d.kind === "node" && d.id !== self && typeof d.profile?.endpoint === "string");
  const [peers, timeSynced, sandbox, archive, roles, connectors, published, restarts] = await Promise.all([
    Promise.all(
      peerNodes.map(async (d) => {
        const status = statuses.get(d.id);
        return {
          name: d.name,
          alwaysOn: isAlwaysOn(d.profile?.caps as Partial<Capabilities> | undefined),
          online: !!status?.online,
          lastSeen: status?.lastSeen ?? null,
          error: status?.error ? redact(status.error).slice(0, 200) : null,
          clockOffsetMs: status?.online ? await system.peerClock(d.profile!.endpoint!) : null,
        };
      }),
    ),
    system.platform === "linux" ? system.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"]).then((r) => (r && r.code === 0 && /^(yes|no)$/.test(r.stdout) ? r.stdout === "yes" : null)) : Promise.resolve(null),
    sandboxOf(deps, deep),
    archiveOf(deps, deep, offline),
    rolesOf(deps, deep && !offline, opts.signal),
    connectorsOf(deps, deep && !offline),
    // undefined: this machine can't be asked (no Tailscale here, or a test). null: asked, and nothing publishes the app.
    system.run(["tailscale", "serve", "status", "--json"]).then((r) => (r && r.code === 0 ? servedOriginFrom(r.stdout || "{}", deps.proxyPort) : undefined)),
    system.underSystemd
      ? system.run(["systemctl", "show", "galahad.service", "-p", "NRestarts", "--value"]).then((r) => (r && r.code === 0 && /^\d+$/.test(r.stdout) ? Number(r.stdout) : null))
      : Promise.resolve(null),
  ]);

  let integrity: string | null = null;
  if (deep) {
    try {
      const rows = store.db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
      integrity = rows.length === 1 && rows[0]!.quick_check === "ok" ? "ok" : rows.map((r) => r.quick_check).join("; ").slice(0, 400) || "the check returned nothing";
    } catch (error) {
      integrity = message(error);
    }
  }
  const newest = Object.values(store.frontier()).reduce((max, hlc) => Math.max(max, hlcMs(hlc)), 0);

  // Where backups are looked for: where the owner said, else beside the node's home, as the server's are kept.
  const backupDirs = deps.backupDir ? [deps.backupDir] : [join(deps.home.dir, "backups"), join(dirname(deps.home.dir), "backups")];
  let backup: DoctorFacts["mind"]["backup"] = null;
  for (const dir of backupDirs) {
    const found = system.backups(dir);
    if (!found) continue;
    if (!backup || (found.exists && !backup.exists)) backup = { dir, ...found };
  }

  let computeFacts: DoctorFacts["compute"] = null;
  try {
    const due = deps.compute.due();
    const usage = deps.governor.usage();
    computeFacts = { canMeasure: deps.compute.canMeasure(), lastAt: due.lastAt, due: due.due, slots: deps.sandbox ? deps.compute.selfCapacity().sandboxes : null, inUse: usage.sandboxes, waiting: usage.queued };
  } catch {
    computeFacts = null;
  }

  const device = store.device(self);
  return {
    now,
    quick,
    offline,
    self: { id: self, name: deps.nodeName, fleetName: store.genesis?.name ?? "", active: !!store.activeDevice(self), role: device?.role ?? null, alwaysOn: isAlwaysOn(caps), startedAt: deps.startedAt },
    keys: {
      keystore: deps.keystore,
      keyFile: deps.keystore === "file" ? system.file(deps.home.keyFilePath) : null,
      pushKeyFile: deps.keystore === "file" ? system.file(deps.home.pushKeyPath) : null,
      home: system.file(deps.home.dir),
      adminToken: system.file(deps.home.adminTokenPath),
    },
    mind: { events: store.eventCount(), integrity, head: store.head(self), forks: store.forks().map((id) => ({ id, name: store.device(id)?.name ?? id.slice(0, 12) })), newestEventAt: newest || null, timeSynced, peers, backup },
    vault: { unlocked: deps.vault.unlocked(), secrets: deps.vault.list().length, requests: deps.vault.requests().map((r) => r.name) },
    providers: { setUp: providerRecords(store).length, byDefault: [...new Set(ROLES.planner!.defaults.map((ref) => ref.slice(0, ref.indexOf("/"))))] },
    spent: windowsOf(store).list().map((w) => ({ provider: w.provider, until: w.until })),
    // A provider whose key a call got refused, unless the key was set again since (its secret's last set is newer than
    // the refusal): the doctor says each still remembered, and leaves out a refusal a replaced key has mooted.
    refused: refusalsStillSaid(store, deps.vault).map((refusal) => ({ provider: refusal.provider, at: refusal.at, said: refusal.said })),
    roles,
    archive,
    sandbox,
    compute: computeFacts,
    loops: loopRecords(store).map((loop) => {
      const runs = store.loopRuns(loop.name, 3);
      const since = Math.max(store.lastSlot(loop.name, loop.on) ?? Number.NEGATIVE_INFINITY, loop.updatedAt);
      let next: number | null = null;
      try {
        next = loop.enabled && loop.schedule ? nextRun(loop.schedule, Number.isFinite(since) ? since : now, loop.tz) : null;
      } catch {
        next = null;
      }
      return {
        name: loop.name,
        enabled: loop.enabled,
        runner: active.has(loop.on) ? (store.device(loop.on)?.name ?? loop.on.slice(0, 12)) : null,
        runnerOnline: loop.on === self || !!statuses.get(loop.on)?.online,
        problem: loop.problem,
        recent: runs.map((r) => r.body.status),
        lastAt: runs[0]?.body.finished ?? null,
        next,
      };
    }),
    connectors,
    app: { missing: APP_FILES.filter((path) => !deps.assets.has(path)), published, local: `http://127.0.0.1:${deps.proxyPort}` },
    disk: system.disk(deps.home.dir),
    service: { restarts, warnings: deps.trouble.recent() },
    ...(deps.notify ? { notify: deps.notify() } : {}),
    // (Only knights whose own setup can stop their work: sensitive mode, keys of yours.)
    ...(deps.knights ? { knights: deps.knights().filter((k) => k.sensitive || k.keys?.length).map((k) => ({ id: k.id, name: k.name, sensitive: k.sensitive && k.models?.length ? k.models.map((ref) => ({ ref, problem: modelProblem(deps, ref) })) : null, keys: (k.keys ?? []).map((g) => ({ secret: g.secret, problem: ungivable(deps.vault, g.secret) })) })) } : {}),
  };
}

export interface DoctorRun {
  report: DoctorReport;
  diagnoses: Diagnosis[];
}

/** The whole look: gather, judge, report. */
export async function runDoctor(deps: DoctorDeps, opts: DoctorOptions = {}): Promise<DoctorRun> {
  const started = performance.now();
  const facts = await gatherFacts(deps, opts);
  const diagnoses = diagnose(facts);
  return { report: reportOf(deps.nodeName, facts, diagnoses, Math.round(performance.now() - started)), diagnoses };
}

/** What the heartbeat adds from a quick look: the lines it doesn't check itself. Never stops a beat. */
export async function heartbeatFromDoctor(deps: DoctorDeps): Promise<DoctorFinding[]> {
  return doctorFindings((await runDoctor(deps, { quick: true, offline: true })).diagnoses);
}
