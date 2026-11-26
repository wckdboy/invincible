import {
  b64u,
  bodyFingerprint,
  type Calibration,
  ceilingThreads,
  clampNeed,
  computeBody,
  type ComputeLimit,
  type ComputeUsage,
  deriveCapacity,
  HlcClock,
  KERNEL,
  type NodeCapacity,
  nodeIdentity,
  type NodeIdentity,
  type PeerStatus,
  REFERENCE_SINGLE,
  SLOT_CPUS,
  SLOT_MEMORY_GB,
} from "../../packages/core/src/index.ts";
import { enrollDevice, foundFleet, MindStore } from "../../packages/mind/src/index.ts";
import type { Capabilities } from "../../packages/node/src/capabilities.ts";
import { Governor } from "../../packages/node/src/compute/governor.ts";
import { ComputeService } from "../../packages/node/src/compute/service.ts";
import { Dispatched, fleetCandidates, sandboxHost } from "../../packages/node/src/placement.ts";
import { planParallel } from "../../packages/node/src/trial-cli.ts";
import { intBelow, rng, subSeed } from "../lib.ts";

/*
 * A fleet's compute in one process and in virtual time: a queue of independent
 * quests (the Trials' shape), run the way `galahad trial run` runs them, on fleets
 * of machines of different measured strengths. What decides is the real code: a
 * real mind holds each node's profile, its calibration and the owner's ceilings;
 * the real census (ComputeService) derives what each carries; the real placement
 * ranks hosts for every sandbox from what the asking node knows (its own numbers
 * live, the others' as old as their last sync); each host's real governor admits
 * a sandbox or makes it wait; and the asking node's governor rations model calls.
 * Only the work is a stand-in: a sandbox and a model call take a seeded, known
 * time. Nothing sleeps: time is a number.
 *
 * A quest here: its sandbox (placed, then a slot on its host), then a plan, a
 * number of steps (the engineer thinks: a model call; then a command runs in the
 * sandbox: the host's processor), then the review. With effort E, E attempts at
 * once, each its own sandbox, and one more call to pick.
 */

/** Sync's interval: what the asking node knows of another's slots is at most this old (seconds). */
const PRESENCE_S = 5;
/** A sandbox waits this long for a slot before its attempt is lost (the governor's own limit, in virtual time). */
const MAX_WAIT_S = 30 * 60;
/** A container takes this long to be ready. */
const START_S = 2;

export interface Machine {
  name: string;
  /** Threads, memory. */
  cores: number;
  memoryGb: number;
  /** One thread's speed against the reference machine's, and the share of its ceiling's threads that delivered when measured. */
  speed: number;
  share: number;
  /** The owner's ceiling, when there is one. */
  limit?: ComputeLimit;
}

/**
 * The fleet, in the order machines are added to it. The first is the node asked (it hosts sandboxes too).
 * By default a node may use half of a machine, and a slot is 4 threads and 8 GB: so these carry 3, 6, 1, 1,
 * 5, 2 slots, then one the owner holds to a single sandbox, and one told to take none.
 */
export const MACHINES: readonly Machine[] = [
  { name: "keep", cores: 32, memoryGb: 128, speed: 1.0, share: 0.88 },
  { name: "rack", cores: 64, memoryGb: 256, speed: 1.5, share: 0.85 },
  { name: "tower", cores: 16, memoryGb: 64, speed: 1.2, share: 0.9 },
  { name: "mini", cores: 8, memoryGb: 32, speed: 0.7, share: 0.95 },
  { name: "forge", cores: 48, memoryGb: 192, speed: 1.3, share: 0.86 },
  { name: "attic", cores: 24, memoryGb: 48, speed: 0.8, share: 0.9 },
  { name: "vault", cores: 32, memoryGb: 64, speed: 1.1, share: 0.87, limit: { sandboxes: 1 } },
  { name: "annex", cores: 16, memoryGb: 32, speed: 0.9, share: 0.9, limit: { sandboxes: 0 } },
];

export interface ComputeSimOptions {
  seed: number;
  /** The fleet: the first `nodes` of MACHINES, or its own list. */
  nodes: number;
  machines?: readonly Machine[];
  quests: number;
  effort: 1 | 2 | 3;
  /** Trials at once: "auto" (what `galahad trial run` does by default), or as many as the slots carry. */
  parallel: "auto" | "slots";
  /**
   * What the asking node knows of the other hosts' slots: "synced" (as old as their last sync, the real thing),
   * or "live" (as if every host's numbers were this instant's: what placement would do if it knew).
   */
  knowledge?: "synced" | "live";
  /** Leave out what the asking node itself did on a host since it last reported (as nodes did before placement counted it). */
  forgetSent?: boolean;
  /** Model calls at once on the asking node, when the owner's ceiling says other than the default. */
  modelCalls?: number;
}

export interface ComputeSimResult {
  nodes: number;
  /** Sandbox slots in the fleet, and model calls at once on the asking node. */
  slots: number;
  modelCalls: number;
  /** Trials at once, as planned. */
  parallel: number;
  /** Virtual seconds from the first quest's start to the last one's end. */
  makespanS: number;
  /**
   * No schedule could finish sooner: the work spread perfectly over every slot (each sandbox on the fastest
   * host), the thinking over every model call, and no quest shorter than itself.
   */
  lowerBoundS: number;
  /** Instants at which a host held more than it may: sandboxes, threads or memory over its ceiling. */
  overCeiling: number;
  /** Sandboxes on a node whose ceiling takes none. */
  onClosedNode: number;
  /** Attempts lost waiting for a slot past the limit, and quests that never finished. */
  lost: number;
  unfinished: number;
  /** A sandbox admitted on a host before one that asked earlier. */
  queueJumps: number;
  /** The longest and the mean wait for a slot (virtual seconds). */
  maxWaitS: number;
  meanWaitS: number;
  /** Slot-seconds a sandbox spent waiting on one host while a slot stood free on another, as a share of all slot-seconds used. */
  idleWhileWaiting: number;
  /** The share of the fleet's slot-seconds in use over the run. */
  utilisation: number;
  /** Sandboxes each host ran, by name. */
  ran: Record<string, number>;
  /** One placement decision as the server makes it (the census, the candidates, the ranking), timed at the end: ms, and when. */
  placeMs: number[];
  placeSpan: [number, number];
}

interface Host {
  machine: Machine;
  identity: NodeIdentity;
  capacity: NodeCapacity;
  governor: Governor;
  /** What its governor held, each time it changed. */
  history: { t: number; usage: ComputeUsage }[];
  /** The order sandboxes asked for a slot here, and the order they got one. */
  asked: number[];
  admitted: number[];
  ran: number;
}

interface Quest {
  /** Each attempt: its steps as [think seconds, work in reference-core seconds]. */
  attempts: { plan: number; steps: [number, number][]; review: number }[];
  pick: number;
}

const capsOf = (m: Machine): Capabilities => ({
  os: "linux",
  arch: "x64",
  hostname: m.name,
  cores: m.cores,
  cpu: "simulated",
  memoryGb: m.memoryGb,
  hasBattery: false,
  gpu: [],
  docker: true,
  vm: { kvm: false, tools: [] },
  tools: ["git"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true },
});

const bytes32 = (random: () => number): Uint8Array => Uint8Array.from({ length: 32 }, () => intBelow(random, 256));

/** The quests of a run: the same for the same seed, whatever fleet runs them. */
export function drawQuests(seed: number, count: number, effort: number): Quest[] {
  const random = rng(subSeed(seed, "compute-quests"));
  const between = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  return Array.from({ length: count }, () => ({
    // Every attempt at a quest is the same size of work (they differ in models, not in the problem).
    attempts: (() => {
      const plan = between(8, 30);
      const steps = Array.from({ length: between(6, 14) }, (): [number, number] => [between(8, 40), between(2, 60)]);
      const review = between(10, 40);
      return Array.from({ length: effort }, () => ({ plan, steps, review }));
    })(),
    pick: between(10, 30),
  }));
}

export async function runComputeSim(options: ComputeSimOptions): Promise<ComputeSimResult> {
  const machines = (options.machines ?? MACHINES).slice(0, options.nodes);
  if (machines.length < options.nodes) throw new Error(`the fleet has ${machines.length} machines, not ${options.nodes}`);
  const keys = rng(subSeed(options.seed, "compute-keys"));
  const knowledge = options.knowledge ?? "synced";

  /* ---------- virtual time ---------- */

  let t = 0;
  let seq = 0;
  const timers: { at: number; seq: number; run: () => void }[] = [];
  const at = (delay: number, run: () => void): void => void timers.push({ at: t + delay, seq: seq++, run });
  const sleep = (seconds: number): Promise<void> => new Promise((resolve) => at(seconds, resolve));
  /** Let everything that can run now run (promise continuations: a slot granted, a call ended). */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /* ---------- the fleet, in a real mind ---------- */

  const epoch = 1_800_000_000_000;
  let tick = 0;
  const store = new MindStore(":memory:", new HlcClock(() => epoch + tick++));
  const hosts: Host[] = [];
  try {
    const identities = machines.map(() => nodeIdentity(bytes32(keys), bytes32(keys)));
    const self = identities[0]!;
    foundFleet(store, self, { fleetName: "bench", nodeName: machines[0]!.name });
    machines.forEach((m, i) => {
      const identity = identities[i]!;
      if (i > 0) enrollDevice(store, self, { device: identity.id, name: m.name, kind: "node", box: b64u(identity.boxPublic) });
      const caps = capsOf(m);
      store.emit(identity, "node.profile", { endpoint: `http://${m.name}.sim`, caps: caps as unknown as Record<string, unknown> });
      const limit = { ...m.limit, ...(i === 0 && options.modelCalls ? { modelCalls: options.modelCalls } : {}) };
      if (Object.keys(limit).length) store.emit(self, "compute.limit", { node: identity.id, limit });
      // What it measured: its ceiling's threads delivered `share` of themselves, each at `speed` times the reference.
      const body = computeBody(caps)!;
      const threads = ceilingThreads(body, m.limit ?? null);
      const single = REFERENCE_SINGLE * m.speed;
      const calibration: Calibration = { at: epoch, tookMs: 2_400, reason: "joined", body: bodyFingerprint(body, m.limit ?? null), cpu: { single, multi: single * threads * m.share, threads, kernel: KERNEL } };
      store.emit(identity, "compute.calibrated", { measured: calibration as unknown as Record<string, unknown> });
    });

    /** When each other host last reported (its sync is asked for every PRESENCE_S). */
    const reportedAt = (): number => Math.floor(t / PRESENCE_S) * PRESENCE_S;
    /** What the asking node last heard of a host: what it held just before its report was asked for (or, "live", this instant). */
    const usageAsKnown = (host: Host): ComputeUsage => {
      for (let i = host.history.length - 1; i >= 0; i--) if (knowledge === "live" || host.history[i]!.t < reportedAt()) return host.history[i]!.usage;
      return host.history[0]!.usage;
    };
    const peers = (): PeerStatus[] =>
      hosts.slice(1).map((h) => ({
        device: h.identity.id,
        online: true,
        lastSeen: epoch + reportedAt() * 1000,
        rttMs: 0,
        error: null,
        presence: { load: 0, cores: h.machine.cores, freeMemoryGb: h.machine.memoryGb, onBattery: null, batteryPercent: null, compute: usageAsKnown(h) },
      }));

    // Each host's governor: its slots. The machine's own load isn't simulated, so only the ceiling decides (as for a
    // host that reports none). Its waits are counted in virtual time below, never by its own (real) timers.
    for (const [i, m] of machines.entries()) {
      const host = { machine: m, identity: identities[i]!, history: [], asked: [], admitted: [], ran: 0 } as unknown as Host;
      host.governor = new Governor({ capacity: () => host.capacity, host: () => null, now: () => epoch + t * 1000, maxWaitMs: 2 ** 30, retryMs: 2 ** 30, onChange: () => host.history.push({ t, usage: host.governor.usage() }) });
      hosts.push(host);
    }
    // The asking node's census: every capacity is what it derives from the mind (as every node would).
    const service = new ComputeService({ store, identity: self, nodeName: machines[0]!.name, caps: () => capsOf(machines[0]!), peers: () => (hosts[0]!.capacity ? peers() : []), governor: hosts[0]!.governor, ledger: () => {}, log: () => {}, now: () => epoch + t * 1000, measure: null });
    for (const host of hosts) {
      const body = computeBody(capsOf(host.machine))!;
      host.capacity = deriveCapacity(body, service.calibrationOf(host.identity.id), service.limitOf(host.identity.id));
      host.history.push({ t: 0, usage: host.governor.usage() });
    }
    const byId = new Map(hosts.map((h) => [h.identity.id, h]));
    const slots = hosts.reduce((sum, h) => sum + h.capacity.sandboxes, 0);
    const modelCalls = hosts[0]!.capacity.modelCalls;

    /* ---------- watching it ---------- */

    let overCeiling = 0;
    let onClosedNode = 0;
    let idleWaitSlotS = 0;
    let usedSlotS = 0;
    let lastT = 0;
    /** After every instant: nobody over a ceiling; and the books of slot-seconds. */
    const observe = (): void => {
      const dt = t - lastT;
      lastT = t;
      let waiting = 0;
      let free = 0;
      for (const h of hosts) {
        const use = h.governor.usage();
        if (use.sandboxes > h.capacity.sandboxes || use.cores > h.capacity.cores + 1e-9 || use.memoryGb > h.capacity.memoryGb + 1e-9) overCeiling++;
        if (h.capacity.sandboxes === 0 && use.sandboxes > 0) onClosedNode++;
        waiting += use.queued;
        free += Math.max(0, h.capacity.sandboxes - use.sandboxes);
        usedSlotS += use.sandboxes * dt;
      }
      idleWaitSlotS += Math.min(waiting, free) * dt;
    };

    /* ---------- the run ---------- */

    const quests = drawQuests(options.seed, options.quests, options.effort);
    const census = { nodes: service.nodes() };
    const parallel = planParallel(census, options.parallel === "auto" ? "auto" : options.quests, options.effort, quests.length).parallel;
    const need = (h: Host) => clampNeed(h.capacity, { cpus: SLOT_CPUS, memoryGb: SLOT_MEMORY_GB }, null);
    const waits: number[] = [];
    let lost = 0;
    let finished = 0;
    let sandboxes = 0;
    /** What the asking node did on other hosts since each last reported: placement's own bookkeeping, as the server keeps it. */
    const dispatched = knowledge === "live" || options.forgetSent ? undefined : new Dispatched();

    /** A model call on the asking node: waits its turn for a slot, as a quest's calls do. */
    const think = async (seconds: number): Promise<void> => {
      const leave = await hosts[0]!.governor.enterModel({ wait: true });
      await sleep(seconds);
      leave();
    };

    /** One attempt: its sandbox where placement puts it, then its plan, steps and review. False: lost waiting for a slot. */
    const attempt = async (quest: number, index: number, work: Quest["attempts"][number]): Promise<boolean> => {
      // Where: asked of the node as `createSandbox` is, for work nobody pinned (server.ts: placeSandbox, then onNode).
      const chosen = sandboxHost(fleetCandidates({ devices: store.devices(), self: self.id, selfCaps: capsOf(machines[0]!), statuses: peers(), compute: service.nodes(), ...(dispatched ? { dispatched } : {}) }));
      if (!chosen) throw new Error("no sandbox host in the fleet");
      const host = byId.get(chosen.device)!;
      const never = host !== hosts[0] ? dispatched?.note(host.identity.id, 1, epoch + t * 1000) : undefined;
      const id = ++sandboxes;
      const asked = t;
      host.asked.push(id);
      // Its slot: at once, or in its turn. Past the limit, the attempt is lost.
      const gaveUp = new AbortController();
      let waiting = true;
      at(MAX_WAIT_S, () => waiting && gaveUp.abort());
      let ticket: Awaited<ReturnType<Governor["acquire"]>>;
      try {
        ticket = await host.governor.acquire(need(host), { quest: `q${quest}#${index}` }, gaveUp.signal);
      } catch {
        waiting = false;
        never?.();
        lost++;
        return false;
      }
      waiting = false;
      host.admitted.push(id);
      host.governor.bind(ticket, `sb${id}`);
      waits.push(t - asked);
      host.ran++;
      await sleep(START_S);
      await think(work.plan);
      for (const [thinking, working] of work.steps) {
        await think(thinking);
        await sleep(working / host.machine.speed);
      }
      await think(work.review);
      host.governor.release(`sb${id}`);
      if (host !== hosts[0]) dispatched?.note(host.identity.id, -1, epoch + t * 1000);
      return true;
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < quests.length) {
        const index = next++;
        const quest = quests[index]!;
        const done = await Promise.all(quest.attempts.map((work, a) => attempt(index, a + 1, work)));
        // Several passed their own review: the reviewer picks.
        if (done.filter(Boolean).length > 1) await think(quest.pick);
        if (done.some(Boolean)) finished++;
      }
    };
    const running = Promise.all(Array.from({ length: parallel }, worker));
    let failure: unknown = null;
    running.catch((error) => (failure = error));
    await settle();
    observe();
    while (timers.length && !failure) {
      let first = 0;
      for (let i = 1; i < timers.length; i++) if (timers[i]!.at < timers[first]!.at || (timers[i]!.at === timers[first]!.at && timers[i]!.seq < timers[first]!.seq)) first = i;
      const timer = timers.splice(first, 1)[0]!;
      t = Math.max(t, timer.at);
      observe();
      timer.run();
      await settle();
      observe();
    }
    if (failure) throw failure;
    await running;
    const makespanS = t;

    /* ---------- what no schedule could beat ---------- */

    const fastest = Math.max(...hosts.filter((h) => h.capacity.sandboxes > 0).map((h) => h.machine.speed));
    let slotSeconds = 0;
    let thinkSeconds = 0;
    let longest = 0;
    for (const quest of quests) {
      let questLongest = 0;
      for (const a of quest.attempts) {
        const thinking = a.plan + a.review + a.steps.reduce((sum, [s]) => sum + s, 0);
        const working = a.steps.reduce((sum, [, w]) => sum + w, 0) / fastest;
        slotSeconds += START_S + thinking + working;
        thinkSeconds += thinking;
        questLongest = Math.max(questLongest, START_S + thinking + working);
      }
      if (quest.attempts.length > 1) thinkSeconds += quest.pick;
      longest = Math.max(longest, questLongest + (quest.attempts.length > 1 ? quest.pick : 0));
    }
    const lowerBoundS = Math.max(slotSeconds / Math.min(slots, parallel * options.effort), thinkSeconds / modelCalls, longest);

    let queueJumps = 0;
    for (const h of hosts) {
      // Among those that got a slot, the order they got it is the order they asked (all ask for the same).
      const order = h.asked.filter((id) => h.admitted.includes(id));
      for (let i = 0; i < order.length; i++) if (order[i] !== h.admitted[i]) queueJumps++;
    }
    // What a decision costs: the census read from the mind, every node a candidate, ranked.
    const placeMs: number[] = [];
    const placeFrom = performance.now();
    for (let i = 0; i < 12; i++) {
      const started = performance.now();
      for (let k = 0; k < 20; k++) sandboxHost(fleetCandidates({ devices: store.devices(), self: self.id, selfCaps: capsOf(machines[0]!), statuses: peers(), compute: service.nodes(), ...(dispatched ? { dispatched } : {}) }));
      placeMs.push((performance.now() - started) / 20);
    }
    const placeSpan: [number, number] = [placeFrom, performance.now()];
    for (const h of hosts) h.governor.close();
    return {
      nodes: hosts.length,
      slots,
      modelCalls,
      parallel,
      makespanS,
      lowerBoundS,
      overCeiling,
      onClosedNode,
      lost,
      unfinished: quests.length - finished,
      queueJumps,
      maxWaitS: Math.max(0, ...waits),
      meanWaitS: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      idleWhileWaiting: usedSlotS ? idleWaitSlotS / usedSlotS : 0,
      utilisation: makespanS && slots ? usedSlotS / (makespanS * slots) : 0,
      ran: Object.fromEntries(hosts.map((h) => [h.machine.name, h.ran])),
      placeMs,
      placeSpan,
    };
  } finally {
    store.close();
  }
}
