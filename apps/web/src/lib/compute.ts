import type { Calibration, ComputeLimit, ComputeNodeView, ComputeView, EffortWork } from "@galahad/core";

/*
 * Compute, in words, for the Fleet page: what a node measured, its ceiling and whose
 * it is, its slots in use and waiting, the fleet's totals, the day's budget. Pure
 * (types only from core), so every sentence is unit-tested.
 */

const one = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);
const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const gbText = (x: number): string => `${Number.isInteger(x) ? x : one(x)} GB`;

export interface Fact {
  label: string;
  value: string;
  /** The longer way of saying it (a tooltip, a screen reader's label). */
  title: string;
}

/** A node's measured strength, in a few words ("13.9 cores' worth"), or that it isn't measured. */
export function strengthText(node: Pick<ComputeNodeView, "capacity">): string {
  const strength = node.capacity?.strength;
  return strength === null || strength === undefined ? "Not measured yet" : `${one(strength)} cores' worth`;
}

/** What a calibration measured, a fact each: the work it did at once, one thread's speed, memory, disk, sandbox start-up, a local model. */
export function measuredFacts(c: Calibration, node: Pick<ComputeNodeView, "capacity">): Fact[] {
  const facts: Fact[] = [];
  const delivered = c.cpu.multi / c.cpu.single;
  facts.push({ label: "At once", value: `${one(delivered)}× on ${plural(c.cpu.threads, "thread")}`, title: `${plural(c.cpu.threads, "thread")} did ${one(delivered)} cores' worth of work at once` });
  if (node.capacity?.speed) facts.push({ label: "One thread", value: `${node.capacity.speed.toFixed(2)}×`, title: `One thread is ${node.capacity.speed.toFixed(2)} times the reference core` });
  if (c.memoryGbps !== undefined) facts.push({ label: "Memory", value: `${one(c.memoryGbps)} GB/s`, title: `Memory copied at ${one(c.memoryGbps)} GB a second` });
  if (c.disk) facts.push({ label: "Disk", value: `${c.disk.writeMbps.toLocaleString("en")} / ${c.disk.readMbps.toLocaleString("en")} MB/s`, title: `A file written at ${c.disk.writeMbps} MB a second and read back at ${c.disk.readMbps}` });
  for (const s of c.sandbox ?? []) {
    const kind = s.kind === "vm" ? "microVM" : "container";
    facts.push({ label: `Sandbox (${kind})`, value: `${(s.startMs / 1000).toFixed(1)} s`, title: `A ${kind} sandbox is ready in ${(s.startMs / 1000).toFixed(1)} seconds` });
  }
  for (const m of c.models ?? []) facts.push({ label: m.model, value: `${one(m.tps)} tok/s`, title: `${m.runtime}/${m.model} wrote ${one(m.tps)} tokens a second` });
  return facts;
}

/** "14 of 32 threads · 91 of 182 GB": what he may use of the machine. */
export function ceilingText(node: Pick<ComputeNodeView, "body" | "capacity">): string {
  if (!node.body || !node.capacity) return "Not known yet";
  return `${node.capacity.cores} of ${plural(node.body.cores, "thread")} · ${node.capacity.memoryGb} of ${gbText(Math.round(node.body.memoryGb))}`;
}

/**
 * Whose ceiling it is, and what it says: yours (with what you set; what you left out is the default
 * half), or the default. A node that hasn't measured itself counts less than its ceiling, and says so.
 */
export function ceilingOwner(node: Pick<ComputeNodeView, "limit" | "capacity">): string {
  const limit = node.limit;
  const yours: string[] = [];
  if (limit?.cores !== undefined) yours.push(plural(limit.cores, "thread"));
  if (limit?.memoryGb !== undefined) yours.push(gbText(limit.memoryGb));
  const whose = yours.length ? `Your ceiling: ${yours.join(", ")}${yours.length === 1 ? (limit?.cores !== undefined ? " (memory: the default half)" : " (threads: the default half)") : ""}` : "The default: half of the machine";
  return node.capacity && !node.capacity.measured ? `${whose} · he counts one sandbox's worth until it's measured` : whose;
}

/** A node's slots in words, and how full they are (null: not known, or none). */
export function slotsText(node: Pick<ComputeNodeView, "body" | "capacity" | "use" | "limit">): { text: string; waiting: number; fraction: number | null } {
  if (!node.body || !node.capacity) return { text: "No capability profile yet", waiting: 0, fraction: null };
  if (!node.body.sandboxHost) return { text: "No sandboxes: not a sandbox host", waiting: 0, fraction: null };
  const slots = node.capacity.sandboxes;
  if (slots <= 0) return { text: "No sandboxes: your ceiling", waiting: 0, fraction: null };
  const capped = node.limit?.sandboxes !== undefined && node.limit.sandboxes <= slots ? " (your ceiling)" : "";
  if (!node.use) return { text: `${plural(slots, "slot")}${capped} · in use: not known`, waiting: 0, fraction: null };
  // Knights' own VMs hold their threads and memory, and no slot: said beside the slots, never among them.
  const kept = node.use.kept ? ` · ${plural(node.use.kept, "knight's VM", "knights' VMs")} besides` : "";
  return { text: `${node.use.sandboxes} of ${plural(slots, "slot")} in use${capped}${kept}`, waiting: node.use.queued, fraction: Math.min(1, node.use.sandboxes / slots) };
}

/** A node's model calls in words. */
export function modelCallsText(node: Pick<ComputeNodeView, "capacity" | "use">): string {
  if (!node.capacity) return "";
  if (!node.use) return plural(node.capacity.modelCalls, "model call");
  return `${node.use.modelCalls} of ${plural(node.capacity.modelCalls, "model call")}${node.use.modelQueued ? ` · ${node.use.modelQueued} waiting` : ""}`;
}

/** The fleet's sandbox slots: how many there are, in use, free now and waiting (over the nodes whose use is known). */
export function fleetSlots(view: Pick<ComputeView, "nodes">): { slots: number; inUse: number; free: number; waiting: number; unknown: number } {
  let slots = 0;
  let inUse = 0;
  let free = 0;
  let waiting = 0;
  let unknown = 0;
  for (const n of view.nodes) {
    const here = n.capacity?.sandboxes ?? 0;
    if (!here) continue;
    slots += here;
    if (!n.use) {
      unknown += 1;
      continue;
    }
    inUse += n.use.sandboxes;
    waiting += n.use.queued;
    free += n.free ?? 0;
  }
  return { slots, inUse, free, waiting, unknown };
}

/** "Auto, up to 3 attempts", "2 attempts", "One attempt". */
export function effortText(view: Pick<ComputeView, "policy" | "plan">): string {
  const effort = view.policy.effort;
  if (effort === "auto") return view.plan.effort > 1 ? `Auto, up to ${view.plan.effort} attempts` : "Auto: one attempt";
  return effort === 1 ? "One attempt" : `Up to ${effort} attempts`;
}

/** "2 of 12 used today". */
export const budgetText = (budget: ComputeView["budget"]): string => `${budget.usedToday} of ${budget.perDay} used today`;

/** One attempt of a quest in hand, in a line: "Attempt 2 · at the forge · The engineer is thinking". */
export function attemptLine(a: EffortWork["attempts"][number]): string {
  return [`Attempt ${a.index}`, `at the ${a.station}`, a.active ? a.doing : "between steps"].filter(Boolean).join(" · ");
}

/** The ceiling sheet's ranges for a machine: threads from 1 to all of them, memory from 1 GB to all of it (every whole value, so the default half is one of them). */
export function limitRanges(body: { cores: number; memoryGb: number }): { cores: { min: number; max: number; step: number }; memory: { min: number; max: number; step: number } } {
  return { cores: { min: 1, max: Math.max(1, body.cores), step: 1 }, memory: { min: 1, max: Math.max(1, Math.floor(body.memoryGb)), step: 1 } };
}

/**
 * What the ceiling sheet sends: only what you set. A slider left where it was, on a ceiling that was the
 * default, stays the default (so "half of the machine" doesn't turn into a number of yours by accident).
 */
export function ceilingChange(
  before: ComputeLimit | null,
  opened: { cores: number; memoryGb: number },
  now: { cores: number; memoryGb: number; sandboxes: boolean },
): { reset: true; cores?: number; memoryGb?: number; sandboxes?: number; modelCalls?: number } {
  return {
    reset: true,
    ...(before?.cores !== undefined || now.cores !== opened.cores ? { cores: now.cores } : {}),
    ...(before?.memoryGb !== undefined || now.memoryGb !== opened.memoryGb ? { memoryGb: now.memoryGb } : {}),
    ...(now.sandboxes ? (before?.sandboxes !== undefined && before.sandboxes > 0 ? { sandboxes: before.sandboxes } : {}) : { sandboxes: 0 }),
    ...(before?.modelCalls !== undefined ? { modelCalls: before.modelCalls } : {}),
  };
}
