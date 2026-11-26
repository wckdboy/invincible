import { readFileSync } from "node:fs";
import os from "node:os";
import {
  ATTEMPT_IDLE_MS,
  ATTEMPT_RESOURCE,
  type AttemptStation,
  type AttemptTag,
  Calibration,
  calibrationDue,
  type CalibrationReason,
  COMPUTE_RESOURCE,
  type ComputeBody,
  computeBody,
  ComputeLimit,
  type ComputeNodeView,
  ComputePlan,
  computeSuggestions,
  type ComputeUsage,
  type ComputeView,
  decideEffort,
  deriveCapacity,
  derivePlan,
  type EffortAsk,
  type EffortGrant,
  type EffortLevel,
  type EffortWork,
  freeSlots,
  type HostLoad,
  MODEL_CALLS_DEFAULT,
  type NodeCapacity,
  type NodeIdentity,
  type PeerStatus,
  planChanges,
  planDigest,
  type PlanNode,
  policyOf,
  redact,
  SELF_ACTION_QUEST,
  whatMoreBuys,
} from "@galahad/core";
import { roster } from "@galahad/brain";
import type { Device, MindStore } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";
import type { Capabilities } from "../capabilities.ts";
import type { Governor } from "./governor.ts";

/*
 * Compute on this node: the census (every node's body, what it measured, its
 * ceiling, what its work holds now), this node's own calibration, the plan he
 * derives and records when the fleet's compute changes, how much effort a quest may
 * spend, and the attempts at work.
 *
 * Everything he does here is internal and reversible: he measures the machine he's
 * on, counts, and records what he derived. He never provisions, rents, installs or
 * downloads anything, and nothing here can reach a machine the owner didn't enroll.
 */

export type Measure = (reason: CalibrationReason, body: ComputeBody, limit: ComputeLimit | null) => Promise<Calibration>;

export interface ComputeDeps {
  store: MindStore;
  identity: NodeIdentity;
  nodeName: string;
  caps: () => Capabilities | null;
  /** The other nodes, as sync last saw them (their presence carries what their work holds). */
  peers: () => PeerStatus[];
  governor: Governor;
  ledger: (entry: LedgerEntryInput) => void;
  log: (message: string) => void;
  now?: () => number;
  /** How this node measures itself (null: it can't here). */
  measure: Measure | null;
}

/**
 * The share of memory macOS's memory pressure calls free (what `memory_pressure` prints as "System-wide memory free
 * percentage"), from 0 to 1; null if it won't say.
 */
export function macFreeShare(read: () => string | null = () => {
  const out = Bun.spawnSync(["sysctl", "-n", "kern.memorystatus_level"], { stdout: "pipe", stderr: "ignore" });
  return out.exitCode === 0 ? out.stdout.toString() : null;
}): number | null {
  const text = read()?.trim() ?? "";
  if (!/^\d{1,3}$/.test(text) || Number(text) > 100) return null;
  return Number(text) / 100;
}

/**
 * The machine, live: load and memory free. On Linux, memory "available" (free plus what the cache would give back); on
 * a Mac, what its memory pressure calls free. What the OS calls free counts only the pages no cache holds, which macOS
 * keeps few of: 5.7 GB of a 36 GB Mac whose memory pressure said 48% free, and a VM would wait for memory that was there.
 */
export function liveHost(): Omit<HostLoad, "oursRecently"> {
  let freeBytes = os.freemem();
  if (process.platform === "linux") {
    try {
      const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
      if (kb) freeBytes = Number(kb) * 1024;
    } catch {
      /* what the OS calls free, then */
    }
  } else if (process.platform === "darwin") {
    const share = macFreeShare();
    if (share !== null) freeBytes = os.totalmem() * share;
  }
  return { load: process.platform === "win32" ? 0 : (os.loadavg()[0] ?? 0), cores: os.cpus().length, freeMemoryGb: freeBytes / 2 ** 30, totalMemoryGb: os.totalmem() / 2 ** 30 };
}

interface AttemptState {
  index: number;
  of: number;
  station: AttemptStation;
  doing: string;
  model: string | null;
  sandbox: string | null;
  node: string | null;
  /** Calls under way (a model thinking, a command running). */
  active: number;
  since: number;
  last: number;
}

interface Tracked {
  quest: string;
  label: string;
  effort: EffortLevel;
  asked: EffortAsk;
  by: string;
  since: number;
  reasons: string[];
  grant: EffortGrant;
  attempts: Map<number, AttemptState>;
}

/** Quests whose effort was granted are remembered this long without a call (a quest's longest silence is one command's time limit). */
const QUEST_KEPT_MS = 2 * 60 * 60_000;
const MAX_TRACKED = 64;

const clean = (text: string, max: number): string =>
  redact(text)
    // Control and bidirectional-override characters never reach a screen through a label.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const NO_BODY: NodeCapacity = { cores: 1, memoryGb: 1, sandboxes: 0, modelCalls: MODEL_CALLS_DEFAULT, strength: null, speed: null, measured: false, reasons: ["No capability profile yet."] };

export class ComputeService {
  private readonly tracked = new Map<string, Tracked>();
  private calibrating: Promise<Calibration> | null = null;

  constructor(private readonly deps: ComputeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /* ---------- reading the mind ---------- */

  limitOf(node: string): ComputeLimit | null {
    const parsed = ComputeLimit.safeParse(this.deps.store.lww(`compute-limit:${node}`)?.value ?? null);
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
  }

  calibrationOf(node: string): Calibration | null {
    const parsed = Calibration.safeParse(this.deps.store.lww(`calibration:${node}`)?.value ?? null);
    return parsed.success ? parsed.data : null;
  }

  private bodyOf(device: Device): ComputeBody | null {
    return computeBody(device.id === this.deps.identity.id ? this.deps.caps() : device.profile?.caps);
  }

  private selfBody(): ComputeBody | null {
    return computeBody(this.deps.caps());
  }

  /** What this node may carry now (its governor's ceiling). */
  selfCapacity(): NodeCapacity {
    const body = this.selfBody();
    if (!body) return NO_BODY;
    const self = this.deps.identity.id;
    return deriveCapacity(body, this.calibrationOf(self), this.limitOf(self));
  }

  usage(): ComputeUsage {
    return this.deps.governor.usage();
  }

  /** Extra attempts recorded in the last 24 hours, by every node (the ledger is the count). */
  usedToday(): number {
    return this.deps.store.ledgerCount(ATTEMPT_RESOURCE, this.now() - 24 * 60 * 60_000);
  }

  policy(): { effort: EffortAsk; attemptsPerDay: number } {
    return policyOf(this.deps.store.lww("compute-policy")?.value);
  }

  /** Every active node, this one first: body, calibration, ceiling, capacity, and what its work holds when that's known. */
  nodes(): ComputeNodeView[] {
    const self = this.deps.identity.id;
    const peers = new Map(this.deps.peers().map((p) => [p.device, p]));
    return this.deps.store
      .devices()
      .filter((d) => d.kind === "node")
      .map((d): ComputeNodeView => {
        const mine = d.id === self;
        const body = this.bodyOf(d);
        const calibration = this.calibrationOf(d.id);
        const limit = this.limitOf(d.id);
        const capacity = body ? deriveCapacity(body, calibration, limit) : null;
        const peer = peers.get(d.id);
        const online = mine || !!peer?.online;
        const use = mine ? this.deps.governor.usage() : online ? (peer?.presence?.compute ?? null) : null;
        // What's already waiting there goes first.
        const free = capacity && use ? Math.max(0, freeSlots(capacity, use, mine ? this.deps.governor.hostNow() : null) - use.queued) : null;
        return { id: d.id, name: d.name, self: mine, online, body, calibration, due: body ? calibrationDue(body, calibration, limit) : null, limit, capacity, use, free, queue: mine ? this.deps.governor.queue() : [] };
      })
      .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  }

  private planOf(nodes: readonly ComputeNodeView[]): ComputePlan {
    return derivePlan(nodes.flatMap((n): PlanNode[] => (n.body && n.capacity ? [{ id: n.id, name: n.name, body: n.body, capacity: n.capacity }] : [])));
  }

  /** His defaults, derived now from the mind (every node derives the same). */
  planNow(): ComputePlan {
    return this.planOf(this.nodes());
  }

  private recorded(): { at: number; digest: string; plan: ComputePlan | null; changes: string[] } | null {
    const value = this.deps.store.lww<{ at: number; digest: string; plan: unknown; changes: string[] }>("compute-plan")?.value;
    if (!value) return null;
    const plan = ComputePlan.safeParse(value.plan);
    return { at: value.at, digest: value.digest, plan: plan.success ? plan.data : null, changes: value.changes ?? [] };
  }

  /** What the heartbeat reads: the suggestions he'd make, and nodes that should have measured themselves by now. */
  suggestions(nodes = this.nodes()) {
    const models = Object.fromEntries(Object.entries(roster(this.deps.store)).map(([role, spec]) => [role, spec.models]));
    return computeSuggestions(nodes.flatMap((n) => (n.body ? [{ id: n.id, name: n.name, body: n.body, calibration: n.calibration, online: n.online }] : [])), models);
  }

  view(): ComputeView {
    this.sweep();
    const nodes = this.nodes();
    const plan = this.planOf(nodes);
    const policy = this.policy();
    const recorded = this.recorded();
    return {
      self: this.deps.identity.id,
      nodes,
      policy,
      budget: { perDay: policy.attemptsPerDay, usedToday: this.usedToday() },
      plan,
      adapted: recorded ? { at: recorded.at, changes: recorded.changes } : null,
      work: this.work(),
      more: whatMoreBuys(nodes.flatMap((n) => (n.body && n.capacity ? [{ name: n.name, body: n.body, capacity: n.capacity, limit: n.limit }] : [])), plan),
      suggestions: this.suggestions(nodes),
    };
  }

  /* ---------- calibration: this node measures itself ---------- */

  canMeasure(): boolean {
    return this.deps.measure !== null && this.selfBody() !== null;
  }

  /** Whether this node should measure itself, and when it last did. */
  due(): { due: "joined" | "changed" | null; lastAt: number | null; limitSetAt: number | null } {
    const self = this.deps.identity.id;
    const body = this.selfBody();
    const calibration = this.calibrationOf(self);
    const limit = this.deps.store.lww(`compute-limit:${self}`);
    return { due: body ? calibrationDue(body, calibration, this.limitOf(self)) : null, lastAt: calibration?.at ?? null, limitSetAt: limit ? Number(limit.hlc.slice(0, 15)) : null };
  }

  /**
   * Measure this node now and record it. One at a time: callers that arrive while one runs get that one.
   * `by`: who asked, for the ledger ("you", or his own upkeep).
   */
  calibrate(reason: CalibrationReason, by: string): Promise<Calibration> {
    if (this.calibrating) return this.calibrating;
    const measure = this.deps.measure;
    const body = this.selfBody();
    if (!measure || !body) return Promise.reject(new Error(`${this.deps.nodeName} can't measure itself here`));
    const self = this.deps.identity.id;
    this.calibrating = (async () => {
      const calibration = Calibration.parse(await measure(reason, body, this.limitOf(self)));
      this.deps.store.emit(this.deps.identity, "compute.calibrated", { measured: calibration as unknown as Record<string, unknown> });
      const capacity = this.selfCapacity();
      this.deps.ledger({
        class: "create",
        resource: COMPUTE_RESOURCE,
        target: `calibration:${this.deps.nodeName}`.slice(0, 256),
        verdict: "allow",
        reason: `${this.deps.nodeName} measured itself (${reason}), asked by ${by}`.slice(0, 500),
        quest: SELF_ACTION_QUEST,
        detail: `${calibration.cpu.threads} thread(s) did ${(calibration.cpu.multi / calibration.cpu.single).toFixed(1)} cores' worth in ${calibration.tookMs} ms · he counts ${capacity.cores} threads, ${capacity.memoryGb} GB, ${capacity.sandboxes} sandbox slot(s)`,
      });
      return calibration;
    })().finally(() => {
      this.calibrating = null;
    });
    return this.calibrating;
  }

  /* ---------- the plan: re-derived when the fleet's compute changes ---------- */

  /** Whether his recorded plan is still what the mind gives. */
  planDrift(): { digest: string; recorded: string | null } {
    return { digest: planDigest(this.planNow()), recorded: this.recorded()?.digest ?? null };
  }

  /**
   * Record the plan as it is now, if it isn't what he last recorded, and tell the owner in a line each what
   * changed (a notice; an unchanged plan writes nothing). Returns the lines, or null when nothing changed.
   */
  adapt(): string[] | null {
    const plan = this.planNow();
    const digest = planDigest(plan);
    const recorded = this.recorded();
    if (recorded?.digest === digest) return null;
    const changes = planChanges(recorded?.plan ?? null, plan).map((c) => c.slice(0, 400)).slice(0, 24);
    const at = this.now();
    this.deps.store.emit(this.deps.identity, "compute.adapted", { at, digest, plan: plan as unknown as Record<string, unknown>, changes });
    if (changes.length) {
      this.deps.store.emit(this.deps.identity, "notice.raised", {
        key: "compute-adapted",
        severity: "info",
        title: recorded ? "Galahad adapted to a change in his compute" : "Galahad took stock of his compute",
        body: `${changes.join("\n")}\nHis own defaults, re-derived: a ceiling of yours overrides them (galahad compute limit <node> …).`.slice(0, 2000),
        source: "compute",
        at,
      });
    }
    return changes;
  }

  /* ---------- effort ---------- */

  /** The room there is for a quest's sandboxes: on one node, or on every sandbox host that's online. */
  room(on?: string): { name: string; slots: number; free: number } {
    const nodes = this.nodes().filter((n) => (on ? n.id === on : n.online) && (n.capacity?.sandboxes ?? 0) > 0);
    if (!nodes.length) return { name: on ? (this.deps.store.device(on)?.name ?? "that node") : "the fleet", slots: 0, free: 0 };
    return {
      name: nodes.length === 1 ? nodes[0]!.name : "the fleet",
      slots: nodes.reduce((sum, n) => sum + n.capacity!.sandboxes, 0),
      // A node whose use isn't known (older, or just back) is counted as full: auto never guesses room.
      free: nodes.reduce((sum, n) => sum + (n.free ?? 0), 0),
    };
  }

  /**
   * How many attempts a quest runs at once. Each extra attempt is recorded in the ledger (that's what the
   * day's budget counts), once per quest: asking again for the same quest gives the same answer.
   */
  grant(input: { quest: string; effort: EffortAsk; on?: string; label?: string }, who: { by: string; owner: boolean }): EffortGrant {
    this.sweep();
    const known = this.tracked.get(input.quest);
    if (known) return known.grant;
    const room = this.room(input.on);
    const policy = this.policy();
    const usedToday = this.usedToday();
    const usage = this.deps.governor.usage();
    const decision = decideEffort({
      asked: input.effort,
      policy,
      usedToday,
      freeSlots: room.free,
      slots: room.slots,
      freeModelCalls: Math.max(0, this.selfCapacity().modelCalls - usage.modelCalls - usage.modelQueued),
      explicitOwner: who.owner && input.effort !== "auto",
      host: room.name,
    });
    const label = clean(input.label ?? "", 120);
    for (let i = 2; i <= decision.attempts; i++) {
      this.deps.ledger({
        class: "create",
        resource: ATTEMPT_RESOURCE,
        target: `${input.quest}#${i}`,
        verdict: "allow",
        reason: `attempt ${i} of ${decision.attempts} at one quest (effort ${input.effort}), asked by ${who.by}`.slice(0, 500),
        quest: input.quest.slice(0, 64),
        ...(label ? { detail: label } : {}),
      });
    }
    const grant: EffortGrant = { quest: input.quest, attempts: decision.attempts, asked: input.effort, host: room.slots ? room.name : null, reasons: decision.reasons, budget: { perDay: policy.attemptsPerDay, usedToday: usedToday + decision.attempts - 1 } };
    this.tracked.set(input.quest, { quest: input.quest, label, effort: decision.attempts, asked: input.effort, by: who.by, since: this.now(), reasons: decision.reasons, grant, attempts: new Map() });
    while (this.tracked.size > MAX_TRACKED) this.tracked.delete(this.tracked.keys().next().value!);
    return grant;
  }

  /* ---------- helpers at work: the attempts of quests in hand ---------- */

  /** An attempt's call starts (a model thinking, a command running). Returns how to say it ended. Unknown quests are ignored. */
  attemptBegin(tag: AttemptTag, what: { station: AttemptStation; doing: string; model?: string | null }): () => void {
    const quest = this.tracked.get(tag.quest);
    if (!quest || tag.index > quest.effort) return () => {};
    const now = this.now();
    const was = quest.attempts.get(tag.index);
    const state: AttemptState = was ?? { index: tag.index, of: quest.effort, station: what.station, doing: "", model: null, sandbox: null, node: null, active: 0, since: now, last: now };
    state.station = what.station;
    state.doing = clean(what.doing, 120);
    if (what.model !== undefined) state.model = what.model;
    state.active += 1;
    state.last = now;
    quest.attempts.set(tag.index, state);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      state.active = Math.max(0, state.active - 1);
      state.last = this.now();
    };
  }

  /** Whether a call is a helper's: one of several attempts at a quest whose effort was granted here. */
  isHelper(tag: AttemptTag): boolean {
    const quest = this.tracked.get(tag.quest);
    return !!quest && quest.effort > 1 && tag.index <= quest.effort;
  }

  /** The model an attempt's call is being answered by (for the census; never shown to the reviewer). */
  attemptModel(tag: AttemptTag, model: string): void {
    const state = this.tracked.get(tag.quest)?.attempts.get(tag.index);
    if (state) state.model = model.slice(0, 120);
  }

  /** An attempt's sandbox exists: its commands are its own from here on. */
  attemptSandbox(tag: AttemptTag, sandbox: string, node: string): void {
    const quest = this.tracked.get(tag.quest);
    if (!quest || tag.index > quest.effort) return;
    const now = this.now();
    const state = quest.attempts.get(tag.index) ?? { index: tag.index, of: quest.effort, station: "forge" as AttemptStation, doing: "Setting up its sandbox", model: null, sandbox: null, node: null, active: 0, since: now, last: now };
    state.sandbox = sandbox;
    state.node = node.slice(0, 64);
    state.last = now;
    quest.attempts.set(tag.index, state);
  }

  /** Which attempt a sandbox is, if any. */
  attemptOf(sandbox: string): AttemptTag | null {
    for (const quest of this.tracked.values()) {
      for (const a of quest.attempts.values()) if (a.sandbox === sandbox) return { quest: quest.quest, index: a.index, of: a.of };
    }
    return null;
  }

  /** A sandbox is gone: the attempt it was has finished. */
  sandboxGone(sandbox: string): void {
    for (const quest of this.tracked.values()) {
      for (const [index, a] of quest.attempts) {
        if (a.sandbox !== sandbox) continue;
        quest.attempts.delete(index);
      }
    }
  }

  /** Attempts that went quiet have finished; quests nobody has spoken for in a long while are forgotten. */
  sweep(): void {
    const now = this.now();
    for (const [id, quest] of this.tracked) {
      for (const [index, a] of quest.attempts) {
        if (a.active > 0 || now - a.last < ATTEMPT_IDLE_MS) continue;
        quest.attempts.delete(index);
      }
      const last = Math.max(quest.since, ...[...quest.attempts.values()].map((a) => a.last));
      if (!quest.attempts.size && now - last > QUEST_KEPT_MS) this.tracked.delete(id);
    }
  }

  /** Quests in hand whose attempts are at work now. */
  work(): EffortWork[] {
    return [...this.tracked.values()]
      .filter((q) => q.attempts.size > 0)
      .map((q) => ({
        quest: q.quest,
        label: q.label,
        effort: q.effort,
        asked: q.asked,
        by: q.by,
        since: q.since,
        reasons: q.reasons,
        attempts: [...q.attempts.values()].sort((a, b) => a.index - b.index).map((a) => ({ index: a.index, doing: a.doing, station: a.station, model: a.model, sandbox: a.sandbox, active: a.active > 0, last: a.last })),
      }));
  }
}
