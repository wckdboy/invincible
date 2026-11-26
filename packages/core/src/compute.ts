import { z } from "zod";
import { canonical, type Json } from "./canonical.ts";
import { sha256B64u } from "./crypto.ts";

/*
 * Compute: what the fleet can carry, and how Galahad spends it.
 *
 * He grows by having machines added to him, never by acquiring any: a node is one
 * the owner enrolled through pairing, and nothing here provisions, rents or reaches
 * for more. Each node measures itself (a calibration, recorded in the mind), may
 * use no more than a ceiling the owner sets (by default half of the machine, so
 * whatever else runs there keeps the rest), and carries a number of slots derived
 * from both. Work that doesn't fit waits; it never oversubscribes a host.
 *
 * Everything in this file is pure: the same mind gives every node the same
 * capacities and the same plan. The measuring and the waiting are the node's
 * (packages/node/src/compute/).
 */

/** One sandbox slot: what a sandbox gets unless it asks otherwise (SandboxRequest's defaults). */
export const SLOT_CPUS = 4;
export const SLOT_MEMORY_GB = 8;
/** The default ceiling: this share of a machine's threads and memory. The rest stays the host's. */
export const DEFAULT_SHARE = 0.5;
/** Whatever the ceiling, this share of the machine's threads is never his while other work wants it. */
export const HOST_RESERVE = 0.1;
/** And this share of its memory must stay free after a sandbox is admitted. */
export const MEMORY_RESERVE = 0.05;
/** Model calls a node carries at once unless the owner says otherwise (calls to providers cost it almost nothing). */
export const MODEL_CALLS_DEFAULT = 8;
/** What a VM takes on top of its sandbox's limits (its own kernel and VMM). */
export type VmOverhead = { readonly cpus: number; readonly memoryGb: number };
/** A microVM (Kata's, on Linux) takes this on top of its sandbox's limits. */
export const VM_OVERHEAD: VmOverhead = { cpus: 1, memoryGb: 2 };
/**
 * A VM of Apple's container takes this on a Mac: a thread (container counts one for each VM itself, its cpuOverhead) and
 * half a GB. Measured on the Mac mini (17 November 2026): a 2 GB VM's process held 0.39 GB idle, and its guest's 1.5 GB
 * and 0.38 GB more while its guest held that; container's runtime beside it, 36 MB. What a guest has touched stays the
 * Mac's until the VM stops, so a VM is counted at all it was given, and this on top.
 */
export const MAC_VM_OVERHEAD: VmOverhead = { cpus: 1, memoryGb: 0.5 };
/** The most attempts one quest runs at once. */
export const MAX_EFFORT = 3;
/** Extra attempts (beyond each quest's first) Galahad may spend in any 24 hours unless the owner says otherwise. */
export const EFFORT_BUDGET_DEFAULT = 12;
/** A local model slower than this (tokens a second) isn't worth suggesting for a role. */
export const WORTH_HIRING_TPS = 10;
/** A GPU with at least this much memory could run a local model worth having. */
export const LOCAL_MODEL_VRAM_GB = 8;
/**
 * The calibration kernel's version (packages/node/src/compute/bench.ts), and its score on one thread of the
 * reference machine (an i7-11700 core, 2021). Strength is in "reference cores": a node of strength 12 does
 * the work of twelve of them.
 *
 * A score means something only against the reference of the kernel that made it. So a calibration says which
 * kernel measured it, one from another kernel is taken again (calibrationDue), and until it is, it's read
 * against its own kernel's reference.
 *
 * Measured on that machine (Bun 1.4.4, the best of repeated runs while it was doing other work): good to
 * about one part in ten, which is all that ranking machines against each other needs.
 */
export const KERNEL = 2;
export const REFERENCE_SINGLE = 62_000;
/**
 * Each kernel's reference. Kernel 1 took a remainder of doubles, which is a C library call: its score was the
 * library's as much as the machine's (a Ryzen 9 9950X under Linux read 0.44× this i7-11700 under Windows).
 */
const REFERENCES: Readonly<Record<number, number>> = { 1: 70_000, [KERNEL]: REFERENCE_SINGLE };
/** The ledger's resource for an extra attempt: the day's budget is counted from these entries. */
export const ATTEMPT_RESOURCE = "compute.attempt";
/** The ledger's resource for a calibration, and for anything he re-derived. */
export const COMPUTE_RESOURCE = "compute";

const Name = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/* ---------- what a node measured ---------- */

export const CalibrationReason = z.enum(["joined", "changed", "asked"]);
export type CalibrationReason = z.infer<typeof CalibrationReason>;

/**
 * A node's own measurement of itself. Read leniently (unknown fields are ignored), so a
 * newer node that measures more never makes an older one lose the numbers it knows.
 */
export const Calibration = z.object({
  /** When it was taken (the node's clock, ms), and how long it took. */
  at: z.number().int().min(0),
  tookMs: z.number().int().min(0).max(3_600_000),
  reason: CalibrationReason,
  /** The body it measured (bodyFingerprint): when the body or the ceiling changes, it's taken again. */
  body: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  /** The kernel's score on one thread, and on `threads` at once (never more threads than his ceiling). */
  cpu: z.object({
    single: z.number().positive().max(1e9),
    multi: z.number().positive().max(1e12),
    threads: z.number().int().min(1).max(4096),
    /** Which kernel measured it (KERNEL then); absent: the first. */
    kernel: z.number().int().min(1).max(1_000_000).optional(),
  }),
  /** Memory copied, GB a second. */
  memoryGbps: z.number().min(0).max(1e5).optional(),
  /** A file in the node's home written and read back, MB a second. */
  disk: z.object({ writeMbps: z.number().min(0).max(1e6), readMbps: z.number().min(0).max(1e6) }).optional(),
  /** How long a sandbox takes to be ready, by kind. */
  sandbox: z.array(z.object({ kind: z.enum(["container", "vm"]), startMs: z.number().int().min(0).max(3_600_000) })).max(4).optional(),
  /** Tokens a second a local model wrote. */
  models: z.array(z.object({ runtime: Name, model: z.string().min(1).max(200), tps: z.number().min(0).max(1e6) })).max(8).optional(),
  /** The machine's load (1 minute, in threads) when it was measured. */
  load: z.number().min(0).max(1e5).optional(),
  note: z.string().max(500).optional(),
});
export type Calibration = z.infer<typeof Calibration>;

/* ---------- what the owner allows ---------- */

/** The owner's ceiling for one node. What's left out keeps its default. */
export const ComputeLimit = z.object({
  /** Threads he may use at once (never more than the machine has). */
  cores: z.number().int().min(1).max(4096).optional(),
  memoryGb: z.number().min(1).max(65_536).optional(),
  /** Sandboxes at once (0: none on this node). */
  sandboxes: z.number().int().min(0).max(256).optional(),
  modelCalls: z.number().int().min(1).max(256).optional(),
});
export type ComputeLimit = z.infer<typeof ComputeLimit>;

export const EffortLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type EffortLevel = z.infer<typeof EffortLevel>;
export const EffortAsk = z.union([z.literal("auto"), EffortLevel]);
export type EffortAsk = z.infer<typeof EffortAsk>;

/** How he spends compute on a quest: the level `auto` may go up to, and the day's budget of extra attempts. */
export const ComputePolicy = z.object({
  effort: EffortAsk.optional(),
  attemptsPerDay: z.number().int().min(0).max(500).optional(),
});
export type ComputePolicy = z.infer<typeof ComputePolicy>;

export const policyOf = (raw: unknown): { effort: EffortAsk; attemptsPerDay: number } => {
  const parsed = ComputePolicy.safeParse(raw ?? {});
  return { effort: (parsed.success ? parsed.data.effort : undefined) ?? "auto", attemptsPerDay: (parsed.success ? parsed.data.attemptsPerDay : undefined) ?? EFFORT_BUDGET_DEFAULT };
};

/* ---------- a node's body, as compute reads it ---------- */

export interface ComputeBody {
  /** Threads, as the OS counts them. */
  cores: number;
  memoryGb: number;
  gpu: { name: string; memoryGb: number | null }[];
  /** It can host sandboxes (Docker reachable). */
  sandboxHost: boolean;
  microVMs: boolean;
  localModels: { runtime: string; models: string[] }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** A node's capabilities (node.profile's `caps`, written by any version), as far as compute needs them; null when they can't be read. */
export function computeBody(caps: unknown): ComputeBody | null {
  if (!isObj(caps) || !positive(caps.cores) || !positive(caps.memoryGb)) return null;
  const gpu = (Array.isArray(caps.gpu) ? caps.gpu : []).flatMap((g) =>
    isObj(g) && typeof g.name === "string" ? [{ name: g.name.slice(0, 120), memoryGb: positive(g.memoryGb) ? g.memoryGb : null }] : [],
  );
  const localModels = (Array.isArray(caps.localModels) ? caps.localModels : []).flatMap((r) =>
    isObj(r) && typeof r.runtime === "string" && Array.isArray(r.models) ? [{ runtime: r.runtime.slice(0, 64), models: r.models.filter((m): m is string => typeof m === "string").slice(0, 50) }] : [],
  );
  const sandbox = isObj(caps.sandbox) ? caps.sandbox : null;
  return { cores: Math.floor(caps.cores), memoryGb: caps.memoryGb, gpu: gpu.slice(0, 16), sandboxHost: sandbox !== null, microVMs: sandbox?.vm === true, localModels: localModels.slice(0, 8) };
}

/** The threads he may use at once on a node: the owner's ceiling, else half of them. Never more than it has. */
export function ceilingThreads(body: ComputeBody, limit: ComputeLimit | null): number {
  return Math.max(1, Math.min(body.cores, limit?.cores ?? Math.floor(body.cores * DEFAULT_SHARE)));
}

/** What a calibration is of: the hardware facts and the ceiling's threads. A different one means: measure again. */
export function bodyFingerprint(body: ComputeBody, limit: ComputeLimit | null): string {
  const facts = {
    cores: body.cores,
    memoryGb: body.memoryGb,
    gpu: body.gpu.map((g) => `${g.name}:${g.memoryGb ?? "?"}`).sort(),
    sandboxHost: body.sandboxHost,
    microVMs: body.microVMs,
    localModels: body.localModels.map((r) => `${r.runtime}:${[...r.models].sort().join(",")}`).sort(),
    threads: ceilingThreads(body, limit),
  };
  return sha256B64u(canonical(facts as unknown as Json)).slice(0, 16);
}

/**
 * Whether a node should measure itself: it never has, its body or ceiling isn't what it measured, it
 * measured with another benchmark kernel than this one, or it measured on fewer threads than it may use
 * (the machine was busy then).
 */
export function calibrationDue(body: ComputeBody, calibration: Calibration | null, limit: ComputeLimit | null): "joined" | "changed" | null {
  if (!calibration) return "joined";
  if (calibration.body !== bodyFingerprint(body, limit)) return "changed";
  if ((calibration.cpu.kernel ?? 1) !== KERNEL) return "changed";
  return calibration.cpu.threads < ceilingThreads(body, limit) ? "changed" : null;
}

/** An automatic calibration isn't taken again sooner than this after the last one (a flapping runtime, a busy day). */
export const RECALIBRATE_AFTER_MS = 60 * 60_000;

/* ---------- capacity: what a node carries at once ---------- */

export interface NodeCapacity {
  /** Threads' worth of work he may run at once (measured, never above the ceiling). */
  cores: number;
  memoryGb: number;
  /** Sandboxes at once. */
  sandboxes: number;
  /** Model calls at once. */
  modelCalls: number;
  /** What it measured, in reference cores (null: not measured yet), and one thread's speed against the reference. */
  strength: number | null;
  speed: number | null;
  measured: boolean;
  /** Why these numbers, a line each: every one is shown. */
  reasons: string[];
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const fixed1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

/** What a node carries at once, from what it measured and what the owner allows. Pure: every node derives the same. */
export function deriveCapacity(body: ComputeBody, calibration: Calibration | null, limit: ComputeLimit | null): NodeCapacity {
  const reasons: string[] = [];
  const threads = ceilingThreads(body, limit);
  reasons.push(
    limit?.cores !== undefined
      ? `Your ceiling: ${threads} of ${body.cores} threads.`
      : `The default ceiling: ${threads} of ${body.cores} threads (half; the rest stays with whatever else this machine runs).`,
  );
  let cores: number;
  let strength: number | null = null;
  let speed: number | null = null;
  if (calibration) {
    const delivered = calibration.cpu.multi / calibration.cpu.single;
    // Measured on other threads than the ceiling's now (it changed since): the same share of fewer, never more than was measured.
    const counted = delivered * Math.min(1, threads / calibration.cpu.threads);
    cores = Math.max(1, Math.min(threads, Math.round(counted)));
    const reference = REFERENCES[calibration.cpu.kernel ?? 1];
    // A kernel this node doesn't know: what it did at once still counts, as that many reference cores until a node that knows it says.
    strength = reference ? calibration.cpu.multi / reference : delivered;
    speed = reference ? calibration.cpu.single / reference : null;
    reasons.push(`Measured: ${plural(calibration.cpu.threads, "thread")} did ${fixed1(delivered)} cores' worth of work at once, so he counts ${cores}.`);
    if (!reference) reasons.push("Measured with a newer benchmark than this node knows: how fast one of its threads is against the reference isn't known here.");
    if (calibration.cpu.threads !== threads) reasons.push(`That was measured on ${plural(calibration.cpu.threads, "thread")}; he measures again for ${threads}.`);
  } else {
    cores = Math.max(1, Math.min(threads, SLOT_CPUS));
    reasons.push(`Not measured yet: one sandbox's worth (${plural(cores, "thread")}) until he has calibrated.`);
  }
  const memoryGb = Math.max(1, Math.floor(Math.min(body.memoryGb, limit?.memoryGb ?? body.memoryGb * DEFAULT_SHARE)));
  reasons.push(`Memory: ${memoryGb} of ${Math.round(body.memoryGb)} GB (${limit?.memoryGb !== undefined ? "your ceiling" : "half by default"}).`);

  let sandboxes = 0;
  if (!body.sandboxHost) reasons.push("No sandboxes: it isn't a sandbox host (no Docker).");
  else {
    const byCores = Math.floor(cores / SLOT_CPUS);
    const byMemory = Math.floor(memoryGb / SLOT_MEMORY_GB);
    sandboxes = Math.max(1, Math.min(byCores, byMemory));
    if (limit?.sandboxes !== undefined && limit.sandboxes < sandboxes) {
      sandboxes = limit.sandboxes;
      reasons.push(`${plural(sandboxes, "sandbox", "sandboxes")} at once: your ceiling.`);
    } else {
      reasons.push(`${plural(sandboxes, "sandbox", "sandboxes")} at once (${SLOT_CPUS} threads and ${SLOT_MEMORY_GB} GB each: the threads allow ${Math.max(1, byCores)}, the memory ${Math.max(1, byMemory)}).`);
    }
    reasons.push("A knight's own VM takes no slot: it holds its memory of the ceiling as long as it is kept, and its threads while it works (and a few minutes after).");
  }
  const modelCalls = limit?.modelCalls ?? MODEL_CALLS_DEFAULT;
  reasons.push(`${plural(modelCalls, "model call")} at once (${limit?.modelCalls !== undefined ? "your ceiling" : "the default"}).`);
  for (const m of calibration?.models ?? []) reasons.push(`Its local model ${m.runtime}/${m.model} wrote ${fixed1(m.tps)} tokens a second.`);
  if (calibration?.note) reasons.push(calibration.note);
  return { cores, memoryGb, sandboxes, modelCalls, strength, speed, measured: !!calibration, reasons };
}

/** What a node's own work holds now. */
export interface ComputeUse {
  sandboxes: number;
  cores: number;
  memoryGb: number;
}

/** The machine, live: its load (1 minute, in threads), memory free, and how many threads his own sandboxes held lately. */
export interface HostLoad {
  load: number;
  cores: number;
  freeMemoryGb: number;
  totalMemoryGb: number;
  /** The most threads his own sandboxes held in the last minute or so: load that is his, not the host's. */
  oursRecently: number;
}

export type Admission = { ok: true } | { ok: false; why: string; /** The machine is busy with other work: it eases by itself. */ busy: boolean };

/** What a sandbox takes of the ceiling: what it asked for (a VM's own overhead on top, `vm`: its host's), cut to the ceiling. */
export function clampNeed(capacity: NodeCapacity, request: { cpus: number; memoryGb: number }, vm: VmOverhead | null): { cpus: number; memoryGb: number; clamped: boolean } {
  const cpus = request.cpus + (vm?.cpus ?? 0);
  const memoryGb = request.memoryGb + (vm?.memoryGb ?? 0);
  const fit = { cpus: Math.min(cpus, capacity.cores), memoryGb: Math.min(memoryGb, capacity.memoryGb) };
  return { ...fit, clamped: fit.cpus < cpus || fit.memoryGb < memoryGb };
}

/** Load on the machine that isn't his own sandboxes' (in threads). */
const othersLoad = (used: ComputeUse, host: HostLoad): number => Math.max(0, host.load - Math.max(used.cores, host.oursRecently));

/** `counted`: one more sandbox, so the count of them counts too (a sandbox that grows is already counted). */
function fits(capacity: NodeCapacity, used: ComputeUse, need: { cpus: number; memoryGb: number }, host: HostLoad | null, others: number, counted = true): Admission {
  const no = (why: string, busy = false): Admission => ({ ok: false, why, busy });
  if (capacity.sandboxes <= 0) return no("this node takes no sandboxes");
  if (counted && used.sandboxes >= capacity.sandboxes) return no(`every slot is in use (${used.sandboxes} of ${capacity.sandboxes} sandboxes)`);
  if (used.cores + need.cpus > capacity.cores + 1e-9) return no(`${fixed1(used.cores)} of the ${capacity.cores} threads he may use are taken, and this needs ${fixed1(need.cpus)}`);
  if (used.memoryGb + need.memoryGb > capacity.memoryGb + 1e-9) return no(`${fixed1(used.memoryGb)} of the ${capacity.memoryGb} GB he may use are taken, and this needs ${fixed1(need.memoryGb)}`);
  if (host) {
    const room = host.cores * (1 - HOST_RESERVE) - others;
    if (used.cores + need.cpus > room + 1e-9) {
      return no(
        others > 0.05 * host.cores
          ? `the machine is busy with other work (about ${fixed1(others)} of its ${host.cores} threads): he waits for it to ease`
          : `a tenth of the machine's threads always stays the host's (${fixed1(room)} of ${host.cores} are his to use at most)`,
        true,
      );
    }
    if (host.freeMemoryGb - need.memoryGb < host.totalMemoryGb * MEMORY_RESERVE) return no(`the machine has only ${fixed1(host.freeMemoryGb)} GB of memory free: he waits for it to ease`, true);
  }
  return { ok: true };
}

/**
 * Whether one more sandbox fits now: inside the ceiling, and with room left on the machine itself
 * (he backs off while other work is using it). `host` null: the live load isn't known (another node).
 */
export function admit(capacity: NodeCapacity, used: ComputeUse, need: { cpus: number; memoryGb: number }, host: HostLoad | null, opts: { slot?: boolean } = {}): Admission {
  return fits(capacity, used, need, host, host ? othersLoad(used, host) : 0, opts.slot ?? true);
}

/** Whether a sandbox may grow by `more` now: what it adds fits the ceiling and the machine as a new one's would, its slot the same. */
export function admitGrowth(capacity: NodeCapacity, used: ComputeUse, more: { cpus: number; memoryGb: number }, host: HostLoad | null): Admission {
  return admit(capacity, used, more, host, { slot: false });
}

/** How many more standard sandboxes fit now. */
export function freeSlots(capacity: NodeCapacity, used: ComputeUse, host: HostLoad | null): number {
  const slot = clampNeed(capacity, { cpus: SLOT_CPUS, memoryGb: SLOT_MEMORY_GB }, null);
  const others = host ? othersLoad(used, host) : 0;
  let free = 0;
  let now = { ...used };
  // The machine's free memory falls as each is admitted too.
  let live = host;
  while (free < capacity.sandboxes && fits(capacity, now, slot, live, others).ok) {
    free += 1;
    now = { sandboxes: now.sandboxes + 1, cores: now.cores + slot.cpus, memoryGb: now.memoryGb + slot.memoryGb };
    if (live) live = { ...live, freeMemoryGb: live.freeMemoryGb - slot.memoryGb };
  }
  return free;
}

/* ---------- effort: how many attempts a quest runs at once ---------- */

export interface EffortInput {
  asked: EffortAsk;
  policy: { effort: EffortAsk; attemptsPerDay: number };
  /** Extra attempts spent in the last 24 hours. */
  usedToday: number;
  /** Standard sandboxes that fit now on the host that would take the work (less what's already waiting), and how many it carries at all. */
  freeSlots: number;
  slots: number;
  freeModelCalls: number;
  /** You named the level yourself, at a terminal or on a paired device (never an agent, a loop or another node). */
  explicitOwner: boolean;
  host: string;
}

/**
 * How many attempts a quest may run at once. `auto` (and anything an agent or a loop asks for)
 * takes only what is free now and never goes past the day's budget or the owner's level. A level
 * you name yourself stands: attempts beyond the free slots wait their turn, and a budget already
 * spent is said, not enforced against you.
 */
export function decideEffort(input: EffortInput): { attempts: EffortLevel; reasons: string[] } {
  const reasons: string[] = [];
  const level = (n: number): EffortLevel => Math.max(1, Math.min(MAX_EFFORT, Math.floor(n))) as EffortLevel;
  const remaining = Math.max(0, input.policy.attemptsPerDay - input.usedToday);
  const explicit = input.asked !== "auto" && input.explicitOwner;
  if (explicit) {
    let attempts = level(input.asked as number);
    if (attempts > Math.max(1, input.slots)) {
      attempts = level(Math.max(1, input.slots));
      reasons.push(`${input.host} carries ${plural(input.slots, "sandbox", "sandboxes")} at all: ${plural(attempts, "attempt")}, not ${input.asked}.`);
    }
    if (attempts > 1) reasons.push(`Effort ${attempts}: ${attempts} attempts in parallel, as you asked.`);
    if (attempts > Math.max(1, input.freeSlots)) reasons.push(`Only ${plural(input.freeSlots, "slot")} free on ${input.host} now: the other attempts wait their turn.`);
    if (attempts - 1 > remaining) reasons.push(`This goes past today's budget of ${plural(input.policy.attemptsPerDay, "extra attempt")} (${input.usedToday} used): your explicit level stands.`);
    return { attempts, reasons };
  }
  const wanted = input.asked === "auto" ? MAX_EFFORT : input.asked;
  let attempts: number = wanted;
  if (input.policy.effort !== "auto" && attempts > input.policy.effort) {
    attempts = input.policy.effort;
    reasons.push(`Your default effort is ${input.policy.effort}.`);
  }
  if (attempts > Math.max(1, input.freeSlots)) {
    attempts = Math.max(1, input.freeSlots);
    reasons.push(input.freeSlots <= 0 ? `One attempt: no slot is free on ${input.host} now, and it waits for one.` : `${plural(input.freeSlots, "slot")} free on ${input.host} now.`);
  }
  if (attempts > Math.max(1, input.freeModelCalls)) {
    attempts = Math.max(1, input.freeModelCalls);
    reasons.push(`${plural(input.freeModelCalls, "model call")} free now.`);
  }
  if (attempts - 1 > remaining) {
    attempts = 1 + remaining;
    reasons.push(remaining ? `Today's budget leaves ${plural(remaining, "extra attempt")} (${input.usedToday} of ${input.policy.attemptsPerDay} used).` : `Today's budget of ${plural(input.policy.attemptsPerDay, "extra attempt")} is spent: one attempt.`);
  }
  const final = level(attempts);
  if (final > 1 && !reasons.length) reasons.push(`Effort ${final}: ${plural(input.freeSlots, "slot")} free on ${input.host}, ${plural(remaining, "extra attempt")} left in today's budget.`);
  return { attempts: final, reasons };
}

/* ---------- the plan he derives, and what changed ---------- */

/** His defaults, derived from the fleet's compute. Recorded when it changes (compute.adapted), so he can say what changed. */
export const ComputePlan = z.object({
  nodes: z.record(
    z.string().max(100),
    z.object({ name: z.string().max(64), sandboxes: z.number().int().min(0), modelCalls: z.number().int().min(0), cores: z.number().min(0), memoryGb: z.number().min(0), strength: z.number().nullable() }),
  ),
  /** The host that takes sandboxes first. */
  sandboxHost: z.string().max(100).nullable(),
  /** The effort `auto` may go up to with everything free. */
  effort: EffortLevel,
});
export type ComputePlan = z.infer<typeof ComputePlan>;

export interface PlanNode {
  id: string;
  name: string;
  body: ComputeBody;
  capacity: NodeCapacity;
}

/** His defaults for a fleet: each node's slots, the host that takes sandboxes first, the effort it can carry. Pure. */
export function derivePlan(nodes: readonly PlanNode[]): ComputePlan {
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const plan: ComputePlan = { nodes: {}, sandboxHost: null, effort: 1 };
  let best: PlanNode | null = null;
  let slots = 0;
  for (const node of sorted) {
    const c = node.capacity;
    plan.nodes[node.id] = { name: node.name, sandboxes: c.sandboxes, modelCalls: c.modelCalls, cores: c.cores, memoryGb: c.memoryGb, strength: c.strength === null ? null : Math.round(c.strength * 10) / 10 };
    slots += c.sandboxes;
    if (c.sandboxes > 0 && (!best || c.sandboxes > best.capacity.sandboxes || (c.sandboxes === best.capacity.sandboxes && (c.strength ?? 0) > (best.capacity.strength ?? 0)))) best = node;
  }
  plan.sandboxHost = best?.id ?? null;
  plan.effort = Math.max(1, Math.min(MAX_EFFORT, slots)) as EffortLevel;
  return plan;
}

export const planDigest = (plan: ComputePlan): string => sha256B64u(canonical(plan as unknown as Json)).slice(0, 22);

const carries = (n: { sandboxes: number; modelCalls: number; strength: number | null }): string =>
  `${n.sandboxes ? plural(n.sandboxes, "sandbox slot") : "no sandboxes"}, ${plural(n.modelCalls, "model call")} at once${n.strength === null ? " (not measured yet)" : ` (measured ${fixed1(n.strength)} reference cores' worth)`}`;

/** What changed between two plans, a line each, for the owner. Empty: nothing did. */
export function planChanges(before: ComputePlan | null, after: ComputePlan): string[] {
  const lines: string[] = [];
  const ids = Object.keys(after.nodes).sort((a, b) => after.nodes[a]!.name.localeCompare(after.nodes[b]!.name));
  if (!before) {
    for (const id of ids) lines.push(`${after.nodes[id]!.name} carries ${carries(after.nodes[id]!)}.`);
    lines.push(`Default effort ${after.effort}: auto may run up to ${plural(after.effort, "attempt")} at a quest at once.`);
    return lines;
  }
  for (const id of ids) {
    const now = after.nodes[id]!;
    const was = before.nodes[id];
    if (!was) {
      lines.push(`${now.name} joined: ${carries(now)}.`);
      continue;
    }
    if (was.sandboxes !== now.sandboxes) lines.push(`${now.name}: ${was.sandboxes} → ${now.sandboxes} sandbox slots.`);
    if (was.modelCalls !== now.modelCalls) lines.push(`${now.name}: ${was.modelCalls} → ${now.modelCalls} model calls at once.`);
    if (was.sandboxes === now.sandboxes && was.modelCalls === now.modelCalls) {
      if (was.strength === null && now.strength !== null) lines.push(`${now.name} measured itself: ${fixed1(now.strength)} reference cores' worth.`);
      else if (was.strength !== null && now.strength !== null && Math.abs(now.strength - was.strength) > 0.1 * was.strength) lines.push(`${now.name} measured itself again: ${fixed1(now.strength)} reference cores' worth (it was ${fixed1(was.strength)}).`);
      else if (was.cores !== now.cores || was.memoryGb !== now.memoryGb) lines.push(`${now.name}: he may use ${now.cores} threads and ${now.memoryGb} GB now (it was ${was.cores} and ${was.memoryGb}).`);
    }
  }
  for (const id of Object.keys(before.nodes).sort((a, b) => before.nodes[a]!.name.localeCompare(before.nodes[b]!.name))) {
    if (after.nodes[id]) continue;
    const was = before.nodes[id]!;
    lines.push(`${was.name} left the fleet: its ${was.sandboxes ? `${plural(was.sandboxes, "sandbox slot")} ${was.sandboxes === 1 ? "is" : "are"} gone` : "model calls are gone"}.`);
  }
  if (before.effort !== after.effort) lines.push(`Default effort ${before.effort} → ${after.effort}: auto may now run up to ${plural(after.effort, "attempt")} at a quest at once.`);
  if (before.sandboxHost !== after.sandboxHost && after.sandboxHost && before.sandboxHost) lines.push(`Sandboxes go to ${after.nodes[after.sandboxHost]!.name} first now (the stronger host).`);
  return lines;
}

/* ---------- what more would buy, and what he suggests ---------- */

/**
 * What more compute would buy, in a line each: a raised ceiling, another machine, a GPU. Pure, from the census
 * (the node that's asked first: its model calls are the ones a quest's calls take).
 */
export function whatMoreBuys(nodes: readonly { name: string; body: ComputeBody; capacity: NodeCapacity; limit: ComputeLimit | null }[], plan: Pick<ComputePlan, "effort">): string[] {
  const lines: string[] = [];
  const hosts = nodes.filter((n) => n.body.sandboxHost);
  for (const n of hosts) {
    if (!n.capacity.measured) {
      lines.push(`${n.name} isn't measured yet, so he counts one slot on it: galahad compute calibrate ${n.name}.`);
      continue;
    }
    if (n.limit?.cores !== undefined) continue;
    // Three quarters of the machine instead of half, at the share of its threads it delivered when measured.
    // That share is the most the added threads could give, and no more is known until they are measured: where
    // two threads share a core, half the machine's threads can be every core it has, and the rest add far less
    // (ultra, 16 cores: 13.2 cores' worth on 16 threads, 16.2 on 24). So it is said as a most, never as a count.
    const now = ceilingThreads(n.body, n.limit);
    const more = Math.floor(n.body.cores * 0.75);
    const delivered = Math.min(1, n.capacity.cores / now);
    const slots = Math.min(Math.floor(Math.round(delivered * more) / SLOT_CPUS), Math.floor(n.capacity.memoryGb / SLOT_MEMORY_GB));
    if (more > now && slots > n.capacity.sandboxes) {
      lines.push(
        `${n.name}: a ceiling of ${more} threads instead of ${now} could carry up to ${plural(slots, "sandbox slot")} instead of ${n.capacity.sandboxes}, if nothing else there needs them: galahad compute limit ${n.name} --cores ${more}. ` +
          "Up to, because threads that share a core add less than a core each: he measures again on the new ceiling and counts what that shows.",
      );
    }
  }
  const slots = hosts.reduce((sum, n) => sum + n.capacity.sandboxes, 0);
  const strongest = [...hosts].sort((a, b) => b.capacity.sandboxes - a.capacity.sandboxes)[0];
  if (strongest) {
    const after = slots + strongest.capacity.sandboxes;
    const together = Math.floor(after / MAX_EFFORT);
    const also =
      plan.effort < MAX_EFFORT
        ? `, and auto could spend effort ${Math.min(MAX_EFFORT, after)} on a quest`
        : together > Math.floor(slots / MAX_EFFORT)
          ? `, and ${plural(together, "quest")} could run at effort ${MAX_EFFORT} together instead of ${Math.floor(slots / MAX_EFFORT)}`
          : "";
    lines.push(`Another machine like ${strongest.name} would carry ${plural(after, "slot")} instead of ${slots}: the Trials would run ${fixed1(after / Math.max(1, slots))}× as many problems at once${also}. Enroll it with galahad invite; he calibrates it and adapts.`);
    // More slots only help while the model calls keep up: a quest's calls each take one on the node that's asked, and wait
    // their turn beyond its ceiling (measured: bun run bench compute, where a ninth machine bought 1 % at eight calls).
    const asked = nodes[0]!;
    const calls = asked.capacity.modelCalls;
    if (after > calls) {
      lines.push(`A quest's model calls go through the node that's asked, ${calls} at once on ${asked.name}: with ${plural(after, "slot")}, model calls ${slots > calls ? "are already" : "would be"} what limits him, not sandboxes. galahad compute limit ${asked.name} --model-calls n raises it.`);
    }
  } else lines.push("A machine with Docker would give him sandboxes: quests and trials need one. Enroll it with galahad invite.");
  if (!nodes.some((n) => n.body.gpu.length)) lines.push("A node with a GPU would let a local model answer for the swift role (and the Lab's GPU work run), with nothing leaving the fleet.");
  return lines;
}

export interface ComputeSuggestion {
  /** A notice key: the same suggestion keeps it, so it's raised once. */
  key: string;
  title: string;
  body: string;
}

/**
 * What he'd suggest about the fleet's compute, never do: anything that installs, downloads or
 * changes who is hired is yours. Pure, from the census and the roster. A machine that's away
 * (`online: false`) gets none: it can't be set up, measured or answer until it's back, and a
 * machine you keep off on purpose shouldn't be asked for again and again.
 */
export function computeSuggestions(
  nodes: readonly { id: string; name: string; body: ComputeBody; calibration: Calibration | null; online?: boolean }[],
  roster: Record<string, readonly string[]>,
): ComputeSuggestion[] {
  const out: ComputeSuggestion[] = [];
  const swift = roster.swift ?? [];
  for (const node of nodes) {
    if (node.online === false) continue;
    const vram = Math.max(0, ...node.body.gpu.map((g) => g.memoryGb ?? 0));
    const serving = node.body.localModels.some((r) => r.models.length > 0);
    if (vram >= LOCAL_MODEL_VRAM_GB && !serving) {
      const gpu = node.body.gpu.find((g) => (g.memoryGb ?? 0) === vram)!;
      out.push({
        key: `compute-suggest:local-runtime:${node.id}`,
        title: `Galahad suggests: a local model on ${node.name}`.slice(0, 200),
        body: `${node.name} has a ${gpu.name} with ${Math.round(vram)} GB and no local model runtime. A model that fits it could answer for the swift role without anything leaving the fleet. He won't install or download anything himself: if you'd like it, install a runtime there (Ollama, say) and pull a model; he then measures it and tells you how fast it is.`,
      });
    }
    const hired = (ref: string) => swift.includes(ref) || swift.includes(`${ref.split("/")[0]}/*`);
    const best = [...(node.calibration?.models ?? [])].filter((m) => m.tps >= WORTH_HIRING_TPS && !hired(`${m.runtime}/${m.model}`)).sort((a, b) => b.tps - a.tps)[0];
    if (best) {
      const ref = `${best.runtime}/${best.model}`;
      out.push({
        key: `compute-suggest:hire-local:${node.id}`,
        title: `Galahad suggests: hire ${ref} for the swift role`.slice(0, 200),
        body: `${ref} wrote ${fixed1(best.tps)} tokens a second on ${node.name}, and nobody has hired it. Changing the roster is yours: galahad roster set swift ${[ref, ...swift].join(" ")}`.slice(0, 2000),
      });
    }
  }
  return out;
}

/* ---------- the census, as the API gives it ---------- */

/** What a node's work holds now, and what waits. Travels with presence (never the log). */
export interface ComputeUsage extends ComputeUse {
  /** Knights' own VMs: kept, holding their threads and memory of the ceiling, and no slot (absent: a node from before). */
  kept?: number;
  /** Sandboxes waiting for a slot. */
  queued: number;
  modelCalls: number;
  modelQueued: number;
}

export interface QueuedWork {
  quest: string;
  cpus: number;
  memoryGb: number;
  since: number;
  /** Why it waits, as the last look found. */
  why: string;
}

export interface ComputeNodeView {
  id: string;
  name: string;
  self: boolean;
  online: boolean;
  /** null: no capability profile yet. */
  body: ComputeBody | null;
  calibration: Calibration | null;
  /** It should measure itself (it never has, or its body, its ceiling or the benchmark changed). */
  due: "joined" | "changed" | null;
  /** The owner's ceiling (null: the defaults). */
  limit: ComputeLimit | null;
  capacity: NodeCapacity | null;
  /** What its work holds now (null: not known; the node is offline or older). */
  use: ComputeUsage | null;
  /** Standard sandboxes that fit now (null: not known). */
  free: number | null;
  /** What waits for a slot (known on the node itself only). */
  queue: QueuedWork[];
}

/** A quest in hand that asked for effort: its attempts, and where each is. */
/** Where an attempt's work is, in the census's words: at the council (planning), the forge (working in its sandbox), the observatory (being reviewed). */
export type AttemptStation = "council" | "forge" | "observatory";
/** An attempt that's made no call for this long, with none under way, has finished (or was abandoned). */
export const ATTEMPT_IDLE_MS = 3 * 60_000;

export interface EffortWork {
  quest: string;
  label: string;
  effort: EffortLevel;
  asked: EffortAsk;
  by: string;
  since: number;
  reasons: string[];
  attempts: { index: number; doing: string; station: string; model: string | null; sandbox: string | null; active: boolean; last: number }[];
}

export interface ComputeView {
  self: string;
  nodes: ComputeNodeView[];
  policy: { effort: EffortAsk; attemptsPerDay: number };
  budget: { perDay: number; usedToday: number };
  /** His defaults as derived now, and as he last recorded them (with what changed then). */
  plan: ComputePlan;
  adapted: { at: number; changes: string[] } | null;
  work: EffortWork[];
  /** What more compute would buy. */
  more: string[];
  suggestions: ComputeSuggestion[];
}

/** An effort grant: how many attempts this quest runs at once, and why. */
export interface EffortGrant {
  quest: string;
  attempts: EffortLevel;
  asked: EffortAsk;
  host: string | null;
  reasons: string[];
  budget: { perDay: number; usedToday: number };
}
