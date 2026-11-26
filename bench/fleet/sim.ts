import { b64u, compareEvents, type GEvent, HlcClock, MAX_CLOCK_DRIFT_MS, NonceCache, nodeIdentity, type NodeIdentity, PushRequest, signEvent, SyncRequest, verifyRequestSignature } from "../../packages/core/src/index.ts";
import { answerPush, answerSync, type FetchLike, signedPost, SyncEngine } from "../../packages/link/src/index.ts";
import { enrollDevice, foundFleet, MindStore, revokeDevice, Vault } from "../../packages/mind/src/index.ts";
import { intBelow, rng, shuffle, subSeed } from "../lib.ts";

/*
 * A fleet in one process: N replicas, each a real MindStore with its own keys and
 * its own (skewed) clock, exchanging real signed events through the real sync
 * engine (SyncEngine, PullState, answerSync, signed requests checked at the door
 * with the real verifier and nonce cache) over a transport that is a function
 * call. The transport does what real networks do, from a seed: it delays,
 * reorders, duplicates and drops, it partitions and heals, a node goes away for a
 * long while and returns, a clock runs ahead (inside the five minutes the log
 * allows, and beyond them), a revoked device keeps talking, and a stranger knocks.
 *
 * Everything is drawn from the seed, virtual time included, so a run can be
 * repeated exactly: the same seed gives the same events, the same bytes on the
 * wire and the same final state, to the digest. For that the simulation owns two
 * things while it runs (and puts them back): the wall clock (Date.now reads the
 * virtual time of whichever node is acting) and the random source (keys, nonces
 * and vault keys come from a seeded stream; every key here is a throwaway).
 *
 * The door (`deliver`) is the one part that isn't the daemon's own code: it does
 * what packages/node/src/server.ts does for /link/sync and /link/push (signature,
 * skew, nonce, an enrolled node, then answerSync or answerPush).
 */

/** Virtual time starts here (an arbitrary instant in 2027) and moves only when the simulation moves it. */
const EPOCH = 1_800_000_000_000;
/** One tick: the sync engine's own interval. */
const TICK_MS = 5_000;
/** A node's clock, looked after: within this of true time. */
const HEALTHY_SKEW_MS = 2_000;
/** A clock that drifted: inside what the log allows (5 minutes), outside what the door allows (60 seconds). */
const DRIFT_MS = 3 * 60_000;
/** A clock far ahead: beyond what the log allows. */
const FAR_MS = 20 * 60_000;

export interface FleetSimOptions {
  seed: number;
  /** Replicas, at least 2. */
  nodes: number;
  /** Events of the shared workload (the same shape whatever the fleet's size). */
  events: number;
  /**
   * Take every pushed event as it comes, as nodes did before answerPush left an event that overtook its
   * predecessor for the next pull. Only to show what that buys: the same run, the door as it was.
   */
  pushesAsTheyCome?: boolean;
}

export interface PhaseCost {
  /** Events of the workload written in it. */
  written: number;
  /** Events carried, bytes and requests on the wire, and full replays (every replica's). */
  carried: number;
  bytes: number;
  requests: number;
  replays: number;
}

export interface FleetSimResult {
  nodes: number;
  /** Events in an active replica's log at the end. */
  logSize: number;
  /** 1: every active replica holds the same events and the same state, a replica fed everything in order agrees, and so does each after a rebuild. */
  converged: 0 | 1;
  /** Events of nodes in good standing that some replica refuses, or doesn't hold. */
  wronglyRejected: number;
  missing: number;
  /** Events that must not count (a revoked device's after its pin) that some replica accepts; a stranger's that some replica stores. */
  wronglyKept: number;
  foreignStored: number;
  /** Whether a device was revoked (a fleet of two has nobody to revoke and still be a fleet), and how many of its later events the others hold (and must refuse). */
  revoked: boolean;
  refusedHeld: number;
  /** Rounds of pulls, after the hazard ended, until every active replica agreed. */
  healRounds: number;
  rejoinRounds: number;
  driftRounds: number;
  /** The returning node's catch-up: requests it made, and events it was behind. */
  rejoinRequests: number;
  rejoinBacklog: number;
  /** Virtual seconds, after a far-ahead clock was put right, until the fleet held everything that node wrote meanwhile. */
  farClockMuteS: number;
  /** Events carried (pages and pushes that passed the door), and how many a perfect sync would have carried. */
  eventsCarried: number;
  eventsNeeded: number;
  /** Bytes of request and answer bodies, all told. */
  bytes: number;
  requests: number;
  /** Requests the door refused (a revoked device, a clock out of bounds, a nonce seen before, a stranger). */
  refused: number;
  /** Full replays of the log (an arrival out of order that couldn't be applied in place), over the active replicas. */
  replays: number;
  /** One round with nothing to exchange: every node asks every other. */
  idleRoundBytes: number;
  idleRoundRequests: number;
  idleRoundMs: number[];
  /** One event written and delivered to every replica (emit, pushes, their ingest), in a quiet fleet. */
  writeFanoutMs: number[];
  /** Wall time of the whole run (ms). */
  wallMs: number;
  /** When each of those was timed (performance.now(), from and to), for whoever paces them against the machine. */
  spans: { run: [number, number]; idle: [number, number]; fanout: [number, number] };
  /** The final state's digest (the same for the same seed and code). */
  digest: string;
  /** What each part of the run cost: founding, steady, partition, away, drift, far, rest. */
  phases: Record<string, PhaseCost>;
  /** What went wrong, in words (empty when all is well). */
  problems: string[];
}

interface SimNode {
  name: string;
  identity: NodeIdentity;
  store: MindStore;
  vault: Vault;
  engine: SyncEngine;
  endpoint: string;
  offsetMs: number;
  nonces: NonceCache;
  /** Not on the network at all (both ways). */
  offline: boolean;
  replays: number;
  /** The loop this node runs, and its last slot. */
  loop: string;
  slot: number;
}

interface Push {
  to: SimNode;
  headers: Headers;
  body: Uint8Array;
  /** When it arrives (virtual ms), and its place among those that arrive the same instant. */
  at: number;
  seq: number;
}

const bytes32 = (random: () => number): Uint8Array => Uint8Array.from({ length: 32 }, () => intBelow(random, 256));

/** One at a time: a run owns the wall clock and the random source while it lasts. */
let running = false;

export async function runFleetSim(options: FleetSimOptions): Promise<FleetSimResult> {
  if (options.nodes < 2) throw new Error("a fleet simulation needs at least two nodes");
  if (running) throw new Error("a fleet simulation is already running in this process (it owns the clock and the random source)");
  running = true;
  const started = performance.now();
  const work = rng(subSeed(options.seed, "fleet-work"));
  const net = rng(subSeed(options.seed, "fleet-net"));
  const entropy = rng(subSeed(options.seed, "fleet-entropy"));
  const keys = rng(subSeed(options.seed, "fleet-keys"));

  let now = EPOCH;
  let current: SimNode | null = null;
  const timeOf = (node: SimNode | null): number => now + (node?.offsetMs ?? 0);
  /** Run as `node`: the wall clock reads its clock. */
  const as = <T>(node: SimNode, fn: () => T): T => {
    const previous = current;
    current = node;
    try {
      return fn();
    } finally {
      current = previous;
    }
  };

  const realNow = Date.now;
  const realRandom = crypto.getRandomValues;
  Date.now = () => timeOf(current);
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < view.length; i++) view[i] = intBelow(entropy, 256);
    }
    return array;
  }) as typeof crypto.getRandomValues;

  const nodes: SimNode[] = [];
  try {
    /* ---------- the network ---------- */

    const byEndpoint = new Map<string, SimNode>();
    const byDevice = new Map<string, SimNode>();
    /** Which side of a partition each node is on (null: no partition). */
    let sides: Map<SimNode, number> | null = null;
    /** Pushes on their way. */
    const inFlight: Push[] = [];
    let pushSeq = 0;
    /** The transport's own faults (off while a single hazard's cost is being counted). */
    let noisy = true;
    const stats = { bytes: 0, requests: 0, refused: 0, eventsCarried: 0, syncRequestsBy: new Map<SimNode, number>() };
    const reachable = (a: SimNode | undefined, b: SimNode): boolean => !!a && !a.offline && !b.offline && (!sides || sides.get(a) === sides.get(b));
    /**
     * How long a request takes to arrive (whole ms): a few to a few tens of milliseconds, and now and then
     * seconds. So two pushes sent a millisecond apart often arrive the other way round, and two sent half a
     * second apart almost never do.
     */
    const latency = (): number => (!noisy ? 5 : net() < 0.02 ? 800 + intBelow(net, 3_200) : 4 + Math.floor(60 * net() * net()));

    /** The door: what server.ts does for a link request. */
    const deliver = (to: SimNode, path: string, headers: Headers, body: Uint8Array): { status: number; answer: unknown } =>
      as(to, () => {
        const proof = verifyRequestSignature(headers, "POST", path, body, timeOf(to));
        const device = proof ? to.store.activeDevice(proof.device) : null;
        if (!proof || !device || device.kind !== "node" || !to.nonces.claim(proof.device, proof.nonce, timeOf(to))) {
          stats.refused++;
          return { status: 401, answer: { error: "link requests must come from an enrolled node" } };
        }
        const payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
        if (path === "/link/sync") {
          const page = answerSync(to.store, SyncRequest.parse(payload));
          stats.eventsCarried += page.events.length;
          return { status: 200, answer: { ...page, presence: null } };
        }
        const { events } = PushRequest.parse(payload);
        stats.eventsCarried += events.length;
        return { status: 200, answer: options.pushesAsTheyCome ? { added: to.store.ingest(events).added } : answerPush(to.store, events) };
      });

    const transport: FetchLike = async (url, init) => {
      const at = new URL(url);
      const to = byEndpoint.get(at.origin);
      const headers = new Headers(init?.headers);
      const from = byDevice.get(headers.get("x-galahad-device") ?? "");
      const body = init?.body as Uint8Array;
      if (!to || !reachable(from, to)) throw new Error("unreachable");
      stats.requests++;
      stats.bytes += body.length;
      if (at.pathname === "/link/push") {
        // A push is fire-and-forget: it arrives a little later, now and then twice (the network's copy), now and then never.
        const roll = noisy ? net() : 0.5;
        if (roll >= 0.03) inFlight.push({ to, headers, body, at: now + latency(), seq: pushSeq++ });
        if (roll >= 0.97) inFlight.push({ to, headers, body, at: now + latency() + latency(), seq: pushSeq++ });
        return Response.json({ added: 0 });
      }
      if (noisy && net() < 0.04) throw new Error("timed out");
      stats.syncRequestsBy.set(from!, (stats.syncRequestsBy.get(from!) ?? 0) + 1);
      const { status, answer } = deliver(to, at.pathname, headers, body);
      if (status !== 200) return Response.json(answer, { status });
      const page = answer as { events: GEvent[] };
      // The answer comes back reordered now and then, and now and then twice (the copy is ingested as it arrives).
      if (noisy && net() < 0.3) shuffle(net, page.events);
      const text = JSON.stringify(page);
      stats.bytes += text.length;
      if (noisy && net() < 0.15 && page.events.length) as(from!, () => from!.store.ingest(page.events));
      return new Response(text, { headers: { "content-type": "application/json" } });
    };

    /** Let fire-and-forget pushes reach the transport. */
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    /** Move virtual time on to `to`, delivering each push on its way at the instant it arrives. */
    const advance = (to: number): void => {
      for (;;) {
        let next = -1;
        for (let i = 0; i < inFlight.length; i++) {
          const p = inFlight[i]!;
          if (p.at <= to && (next < 0 || p.at < inFlight[next]!.at || (p.at === inFlight[next]!.at && p.seq < inFlight[next]!.seq))) next = i;
        }
        if (next < 0) break;
        const p = inFlight.splice(next, 1)[0]!;
        now = Math.max(now, p.at);
        // The link may have gone since it was sent.
        const from = byDevice.get(p.headers.get("x-galahad-device") ?? "");
        if (reachable(from, p.to)) deliver(p.to, "/link/push", p.headers, p.body);
      }
      now = Math.max(now, to);
    };

    /* ---------- the fleet ---------- */

    const emitted = new Map<SimNode, string[]>();
    const makeNode = (index: number, name: string): SimNode => {
      const identity = nodeIdentity(bytes32(keys), bytes32(keys));
      const offsetMs = index === 0 ? 0 : Math.round((keys() * 2 - 1) * HEALTHY_SKEW_MS);
      const node = { name, identity, endpoint: `http://${name}.sim`, offsetMs, nonces: new NonceCache(), offline: false, replays: 0, loop: `poll-${name}`, slot: EPOCH } as SimNode;
      node.store = new MindStore(":memory:", new HlcClock(() => timeOf(node)));
      node.vault = new Vault(node.store, identity);
      node.engine = new SyncEngine(node.store, identity, { fetch: transport });
      // Count full replays where they happen.
      const ingest = node.store.ingest.bind(node.store);
      node.store.ingest = (raws) => {
        const result = ingest(raws);
        if (result.rebuilt) node.replays++;
        return result;
      };
      const ids: string[] = [];
      emitted.set(node, ids);
      // As the daemon does: what this node writes is pushed at once.
      node.store.onEmit((event) => {
        ids.push(event.id);
        node.engine.push([event]);
      });
      nodes.push(node);
      byEndpoint.set(node.endpoint, node);
      byDevice.set(identity.id, node);
      return node;
    };
    const caps = (index: number) => ({ os: "linux", arch: "x64", cores: 8 + 4 * (index % 4), memoryGb: 16 * (1 + (index % 3)), docker: index % 2 === 1, tools: ["git"], gpu: [], localModels: [], vm: { kvm: false, tools: [] } });

    const founder = makeNode(0, "n0");
    as(founder, () => {
      foundFleet(founder.store, founder.identity, { fleetName: "camelot", nodeName: founder.name });
      founder.store.emit(founder.identity, "node.profile", { endpoint: founder.endpoint, caps: caps(0) });
      founder.vault.set("deepseek", "sk-sim-not-a-real-key-0000000000");
      founder.vault.set("orcarouter", "sk-sim-not-a-real-key-1111111111");
      founder.store.emit(founder.identity, "provider.set", { id: "deepseek", kind: "openai", baseUrl: "https://api.deepseek.test/v1", secret: "deepseek" });
      founder.store.emit(founder.identity, "roster.set", { role: "planner", models: ["deepseek/plan-1"] });
    });
    const fleet = founder.store.fleet!;

    /** Every reachable pair pulls once; a round is what the engines do every five seconds. */
    const round = async (): Promise<void> => {
      for (const node of shuffle(net, [...nodes])) {
        if (node.offline) continue;
        for (const peer of shuffle(net, as(node, () => node.engine.peers()))) {
          current = node;
          await node.engine.pullFrom(peer);
          current = null;
        }
      }
    };

    // The others join one at a time: enrolled by the founder, a first copy of the mind from it, then their own profile.
    for (let i = 1; i < options.nodes; i++) {
      advance(now + 1_000);
      const node = makeNode(i, `n${i}`);
      as(founder, () => {
        enrollDevice(founder.store, founder.identity, { device: node.identity.id, name: node.name, kind: "node", box: b64u(node.identity.boxPublic) });
        founder.store.emit(founder.identity, "loop.set", { name: node.loop, schedule: "every 30m", on: node.identity.id, enabled: true, task: { kind: "heartbeat" } });
      });
      await settle();
      advance(now + 500);
      node.store.expectFleet(fleet);
      for (let after: Record<string, string> = {}; ; after = node.store.frontier()) {
        const page = founder.store.eventsSince(after, 500);
        as(node, () => node.store.ingest(page.events));
        if (!page.more) break;
      }
      advance(now + 500);
      as(node, () => {
        node.store.emit(node.identity, "node.profile", { endpoint: node.endpoint, caps: caps(i) });
        node.store.emit(node.identity, "compute.calibrated", { measured: { at: timeOf(node), tookMs: 2_400, reason: "joined", body: "simulated-body-0", cpu: { single: 60_000 + 1_000 * i, multi: 300_000, threads: 4 + (i % 4), kernel: 2 } } });
      });
      await settle();
      advance(now + 500);
    }
    as(founder, () => founder.store.emit(founder.identity, "loop.set", { name: founder.loop, schedule: "every 30m", on: founder.identity.id, enabled: true, task: { kind: "heartbeat" } }));
    await settle();
    advance(now + TICK_MS);
    await round();
    advance(now + TICK_MS);
    await round();

    /* ---------- the work ---------- */

    const server = nodes[1]!;
    const victim = options.nodes >= 3 ? nodes[options.nodes - 1]! : null;
    let pinned: string | null | undefined;
    /** Memories written by nodes that stay in good standing (so forgetting one is always allowed). */
    const memories: string[] = [];
    const inGoodStanding = (node: SimNode): boolean => node !== victim || pinned === undefined;
    const active = (): SimNode[] => nodes.filter((n) => inGoodStanding(n));

    /** One event of the shared workload, by `node`: shaped like a real log (mostly the ledger of a busy sandbox host). */
    const write = (node: SimNode, n: number): void => {
      as(node, () => {
        const store = node.store;
        const roll = work();
        if (roll < 0.82) {
          store.emit(node.identity, "ledger.recorded", { class: "create", resource: "sandbox.exec", target: `sb${(n % 97).toString(16)}`, verdict: "allow", quest: `q${n % 23}`, detail: `python3 -c "print(${n})"` });
        } else if (roll < 0.9) {
          node.slot += 1_800_000;
          store.emit(node.identity, "loop.ran", { loop: node.loop, run: `s${node.slot.toString(36)}`, slot: node.slot, status: "ok", started: node.slot, finished: node.slot + 1_000, summary: "All quiet." });
        } else if (roll < 0.95) {
          const event = store.remember(node.identity, `${node.name} noticed that build ${n} took ${intBelow(work, 100)} seconds`, { tags: [`t${n % 5}`], prov: { trust: "agent" } });
          if (node !== victim) memories.push(event.id);
        } else if (roll < 0.97) {
          // The same few keys from every node: last-writer-wins races.
          store.emit(node.identity, "notice.raised", { key: `sim:${n % 4}`, severity: "info", title: "A simulated notice", body: `from ${node.name}, number ${n}`, source: "heartbeat", at: timeOf(node) });
        } else if (roll < 0.98) {
          store.emit(node.identity, "notice.cleared", { key: `sim:${n % 4}` });
        } else if (roll < 0.99) {
          store.emit(node.identity, "roster.set", { role: n % 2 ? "planner" : "engineer", models: [`deepseek/${node.name}-${n}`] });
        } else {
          const memory = memories.length ? memories[intBelow(work, memories.length)]! : null;
          // Only one it holds: forgetting a memory it has never seen isn't something a node does.
          if (memory && store.event(memory)) store.emit(node.identity, "memory.forgotten", { memory });
          else store.emit(node.identity, "roster.set", { role: "reviewer", models: [`deepseek/${node.name}-${n}`] });
        }
      });
    };

    let written = 0;
    /** Who writes the next event: the sandbox host most of the time, the founder often, anyone otherwise. */
    const writer = (among: readonly SimNode[]): SimNode => {
      const roll = work();
      const preferred = roll < 0.6 ? server : roll < 0.75 ? founder : among[intBelow(work, among.length)]!;
      return among.includes(preferred) ? preferred : among[intBelow(work, among.length)]!;
    };
    /** The work is done in about sixteen ticks, whatever its size: a busier fleet, not a longer run. */
    const perTick = Math.max(2, Math.round(options.events / 16));

    /**
     * A tick of work: about `count` events by whoever may write, spread over the five seconds (now and then two
     * or three at once from one node, as when a step records its ledger entry and what it learned), each pushed
     * as it's written; then a round of pulls.
     */
    const workTick = async (count: number, writers: readonly SimNode[]): Promise<void> => {
      const end = now + TICK_MS;
      const step = Math.floor(TICK_MS / (count + 1));
      for (let k = 0; k < count && writers.length; k++) {
        advance(now + step);
        const node = writer(writers);
        const burst = work() < 0.15 ? 2 + intBelow(work, 2) : 1;
        for (let b = 0; b < burst; b++) {
          if (b) now += 1;
          write(node, written++);
        }
        k += burst - 1;
        await settle();
      }
      advance(Math.max(end, now));
      await round();
    };

    /** A replica's log as a set: each device's count and set hash, in one order. */
    const logOf = (node: SimNode): string =>
      Object.entries(node.store.deviceDigests())
        .map(([device, d]) => `${device}:${d.n}:${d.h}`)
        .sort()
        .join(" ");
    /** The same events and the same state. */
    const agreed = (group: readonly SimNode[]): boolean => {
      const reference = group[0]!;
      const digest = reference.store.digest();
      const log = logOf(reference);
      return group.every((n) => n.store.digest() === digest && logOf(n) === log);
    };
    /** Rounds of pulls, with no new work, until every active replica agrees (at most `limit`; -1 if they never do). */
    const untilAgreed = async (limit = 40, stepMs = TICK_MS): Promise<number> => {
      for (let rounds = 0; rounds <= limit; rounds++) {
        if (inFlight.length === 0 && agreed(active())) return rounds;
        await settle();
        advance(now + stepMs);
        await round();
      }
      return -1;
    };
    /** What each part of the run cost. */
    const phases: Record<string, PhaseCost> = {};
    let mark = { carried: 0, bytes: 0, requests: 0, replays: 0, written: 0 };
    const phase = (name: string): void => {
      const at = { carried: stats.eventsCarried, bytes: stats.bytes, requests: stats.requests, replays: nodes.reduce((sum, n) => sum + n.replays, 0), written };
      phases[name] = { written: at.written - mark.written, carried: at.carried - mark.carried, bytes: at.bytes - mark.bytes, requests: at.requests - mark.requests, replays: at.replays - mark.replays };
      mark = at;
    };
    /** Ticks for this share of the workload. */
    const share = (fraction: number): number => Math.max(1, Math.round((options.events * fraction) / perTick));
    const problems: string[] = [];
    phase("founding");

    // 1. Steady work, everyone connected.
    for (let t = 0; t < share(0.2); t++) await workTick(perTick, active());
    phase("steady");

    // 2. A partition. While it lasts, the founder revokes a node on the other side, which keeps working and talking.
    const half = Math.max(1, Math.floor(options.nodes / 2));
    sides = new Map(nodes.map((n, i) => [n, i < half ? 0 : 1]));
    const partitionTicks = share(0.25);
    for (let t = 0; t < partitionTicks; t++) {
      if (victim && t === Math.floor(partitionTicks / 3)) {
        advance(now + 50);
        as(founder, () => {
          pinned = founder.store.head(victim.identity.id);
          revokeDevice(founder.store, founder.identity, victim.identity.id, "lost in the partition");
        });
      }
      // The revoked node doesn't know: it goes on writing.
      await workTick(perTick, nodes);
    }
    sides = null;
    noisy = false;
    const healRounds = await untilAgreed();
    if (healRounds < 0) problems.push("the partition never healed: replicas still differ");
    noisy = true;
    phase("partition");

    // 3. One node is away for a long while (it works on, alone), then returns.
    const away = nodes[options.nodes >= 4 ? options.nodes - 2 : 1]!;
    away.offline = true;
    for (let t = 0; t < share(0.35); t++) {
      const here = active().filter((n) => n !== away);
      await workTick(perTick, [...here, ...(victim ? [victim] : [])]);
      if (t % 2 === 0) {
        advance(now + 7);
        write(away, written++);
        await settle();
      }
    }
    const before = stats.syncRequestsBy.get(away) ?? 0;
    // What it's behind by: every event the others hold that it doesn't.
    const theirs = active().find((n) => n !== away)!.store.deviceDigests();
    const held = away.store.deviceDigests();
    const rejoinBacklog = Object.entries(theirs).reduce((sum, [device, d]) => sum + Math.max(0, d.n - (held[device]?.n ?? 0)), 0);
    away.offline = false;
    noisy = false;
    const rejoinRounds = await untilAgreed();
    if (rejoinRounds < 0) problems.push("the node that was away never caught up");
    const rejoinRequests = (stats.syncRequestsBy.get(away) ?? 0) - before;
    noisy = true;
    phase("away");

    // 4. A clock that drifted three minutes ahead: the log would take its events, the door doesn't take its requests.
    const drifted = nodes[options.nodes >= 5 ? 2 : options.nodes - (victim ? 2 : 1)]!;
    const honest = drifted.offsetMs;
    drifted.offsetMs = honest + DRIFT_MS;
    for (let t = 0; t < share(0.1); t++) {
      await workTick(perTick, active());
      // Whoever else writes, the node with the wrong clock does.
      advance(now + 3);
      write(drifted, written++);
      await settle();
    }
    drifted.offsetMs = honest;
    noisy = false;
    const driftRounds = await untilAgreed();
    if (driftRounds < 0) problems.push("the node whose clock drifted never converged after it was put right");
    noisy = true;
    phase("drift");

    // 5. A clock far ahead, beyond the five minutes: what it writes then is refused until time catches up with it.
    const far = nodes[options.nodes >= 6 ? 3 : options.nodes - (victim ? 2 : 1)]!;
    const farHonest = far.offsetMs;
    far.offsetMs = farHonest + FAR_MS;
    for (let t = 0; t < share(0.1); t++) {
      await workTick(perTick, active());
      advance(now + 3);
      write(far, written++);
      await settle();
    }
    far.offsetMs = farHonest;
    const fixedAt = now;
    noisy = false;
    // The wait is the clock's, not the network's: nothing it wrote can be taken before the last of it is within
    // five minutes, so a pull every five minutes until shortly before, then one a minute.
    const earliest = fixedAt + FAR_MS - MAX_CLOCK_DRIFT_MS - 3 * 60_000;
    while (now + 5 * 60_000 <= earliest) {
      advance(now + 5 * 60_000);
      await round();
    }
    const farRounds = await untilAgreed(20, 60_000);
    if (farRounds < 0) problems.push("what the far-ahead node wrote was never accepted");
    const farClockMuteS = (now - fixedAt) / 1000;
    noisy = true;
    phase("far");

    // 6. A stranger: a key nobody enrolled knocks at the door, and an enrolled node passes on what the stranger signed.
    const stranger = nodeIdentity(bytes32(keys), bytes32(keys));
    const foreign: GEvent[] = [];
    for (let k = 0; k < 3; k++) {
      foreign.push(signEvent({ v: 2, fleet, hlc: `${String(now + k).padStart(15, "0")}.000000`, device: stranger.id, prev: foreign.at(-1)?.id ?? null, kind: "memory.added", body: { text: `a stranger's word ${k}` } }, stranger));
    }
    // A real event with its body changed after it was signed: its id no longer matches its content.
    const real = founder.store.ledger(1)[0] ?? null;
    const tampered = real ? { ...real, body: { class: "create", resource: "sandbox.exec", target: "tampered", verdict: "allow" } } : null;
    /** Straight to a node's door, past the transport's faults. */
    const knock =
      (node: SimNode): FetchLike =>
      async (url, init) => {
        const { status, answer } = deliver(node, new URL(url).pathname, new Headers(init?.headers), init?.body as Uint8Array);
        return Response.json(answer, { status });
      };
    const carriedBefore = stats.eventsCarried;
    const refusedBefore = stats.refused;
    for (const node of active()) await signedPost(stranger, node.endpoint, "/link/push", { events: foreign }, { fetch: knock(node) }).catch(() => {});
    if (stats.refused - refusedBefore !== active().length) problems.push("a stranger's request passed the door");
    const relay = active()[active().length - 1]!;
    for (const node of active()) {
      if (node === relay) continue;
      current = relay;
      await signedPost(relay.identity, node.endpoint, "/link/push", { events: [...foreign, ...(tampered ? [tampered] : [])] }, { fetch: knock(node) });
      current = null;
    }
    // What a stranger sent isn't sync's cost.
    stats.eventsCarried = carriedBefore;

    // 7. The rest of the work, then quiet until everyone agrees.
    while (written < options.events) await workTick(perTick, active());
    noisy = false;
    const settled = await untilAgreed();
    if (settled < 0) problems.push("the fleet never settled at the end");
    phase("rest");

    /* ---------- the verdict ---------- */

    const standing = active();
    const reference = standing[0]!;
    // What must count: everything a node in good standing wrote; what must not: what the revoked device signed past its pin.
    const mustCount = new Set<string>();
    const mustNot = new Set<string>();
    for (const [node, ids] of emitted) {
      if (node !== victim) for (const id of ids) mustCount.add(id);
      else {
        const cut = pinned ? ids.indexOf(pinned) : -1;
        ids.forEach((id, i) => (i <= cut ? mustCount : mustNot).add(id));
      }
    }
    let wronglyRejected = 0;
    let missing = 0;
    let wronglyKept = 0;
    let foreignStored = 0;
    let refusedHeld = 0;
    for (const node of standing) {
      for (const id of mustCount) {
        if (!node.store.event(id)) {
          missing++;
          if (problems.length < 12) problems.push(`${node.name} doesn't hold ${id.slice(0, 8)}`);
        } else if (node.store.rejection(id)) {
          wronglyRejected++;
          if (problems.length < 12) problems.push(`${node.name} refuses ${node.store.event(id)!.kind} ${id.slice(0, 8)}: ${node.store.rejection(id)}`);
        }
      }
      // What it holds of the revoked device's later events, it must refuse.
      for (const id of mustNot) {
        if (!node.store.event(id)) continue;
        if (node === reference) refusedHeld++;
        if (!node.store.rejection(id)) wronglyKept++;
      }
      // A stranger's events are in nobody's log, and the event that was tampered with is still as its author signed it.
      for (const event of foreign) if (node.store.event(event.id)) foreignStored++;
      if (tampered && JSON.stringify(node.store.event(tampered.id)?.body) === JSON.stringify(tampered.body)) foreignStored++;
    }
    if (wronglyKept) problems.push(`${wronglyKept} of the revoked device's later events count somewhere`);
    if (foreignStored) problems.push(`${foreignStored} of a stranger's events are in a log`);
    let converged = agreed(standing);
    if (!converged) problems.push("replicas differ at the end");
    // A replica that receives everything in order, in one go, must be the same mind; and so must each after a rebuild.
    const digest = reference.store.digest();
    const fresh = new MindStore(":memory:", new HlcClock(() => now));
    try {
      fresh.expectFleet(fleet);
      const all = reference.store.db
        .query<{ raw: string }, []>("SELECT raw FROM events")
        .all()
        .map((row) => JSON.parse(row.raw) as GEvent)
        .sort(compareEvents);
      const result = fresh.ingest(all);
      if (result.invalid.length || fresh.digest() !== digest) {
        converged = false;
        problems.push(`a replica fed the whole log in order differs (${result.invalid.length} refused at ingest)`);
      }
    } finally {
      fresh.close();
    }
    for (const node of standing) {
      node.store.rebuild();
      if (node.store.digest() !== digest) {
        converged = false;
        problems.push(`${node.name} differs after a rebuild`);
      }
    }

    // What a perfect sync would have carried: to each replica, once, every event it holds and didn't write.
    const eventsNeeded = standing.reduce((sum, node) => sum + node.store.eventCount() - (node.store.deviceDigests()[node.identity.id]?.n ?? 0), 0);
    const totals = { ...stats };
    const replays = standing.reduce((sum, n) => sum + n.replays, 0);

    // A quiet fleet: what a round costs when there's nothing to exchange, and what one write costs to spread.
    await round();
    const idleBytes = stats.bytes;
    const idleRequests = stats.requests;
    advance(now + TICK_MS);
    await round();
    const idleRoundBytes = stats.bytes - idleBytes;
    const idleRoundRequests = stats.requests - idleRequests;
    const idleRoundMs: number[] = [];
    const idleFrom = performance.now();
    for (let k = 0; k < 5; k++) {
      advance(now + TICK_MS);
      const t = performance.now();
      await round();
      idleRoundMs.push(performance.now() - t);
    }
    const idleTo = performance.now();
    const writeFanoutMs: number[] = [];
    for (let k = 0; k < 7; k++) {
      advance(now + 500);
      const t = performance.now();
      as(server, () => server.store.emit(server.identity, "ledger.recorded", { class: "create", resource: "sandbox.exec", target: `quiet${k}`, verdict: "allow" }));
      await settle();
      advance(now + 100);
      writeFanoutMs.push(performance.now() - t);
    }

    return {
      nodes: options.nodes,
      logSize: reference.store.eventCount() - writeFanoutMs.length,
      converged: converged && problems.length === 0 ? 1 : 0,
      wronglyRejected,
      missing,
      wronglyKept,
      foreignStored,
      revoked: victim !== null,
      refusedHeld,
      healRounds,
      rejoinRounds,
      driftRounds,
      rejoinRequests,
      rejoinBacklog,
      farClockMuteS,
      eventsCarried: totals.eventsCarried,
      eventsNeeded,
      bytes: totals.bytes,
      requests: totals.requests,
      refused: totals.refused,
      replays,
      idleRoundBytes,
      idleRoundRequests,
      idleRoundMs,
      writeFanoutMs,
      wallMs: performance.now() - started,
      spans: { run: [started, performance.now()], idle: [idleFrom, idleTo], fanout: [idleTo, performance.now()] },
      digest,
      phases,
      problems,
    };
  } finally {
    // Whatever was still on its way arrives nowhere, before the clock and the random source go back.
    await new Promise((resolve) => setImmediate(resolve));
    running = false;
    Date.now = realNow;
    crypto.getRandomValues = realRandom;
    for (const node of nodes) {
      try {
        node.store.close();
      } catch {
        /* already closed */
      }
    }
  }
}
