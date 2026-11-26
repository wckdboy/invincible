import { describe, expect, test } from "bun:test";
import { b64u, decodeHlc, encodeHlc, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, signEvent } from "@galahad/core";
import { adoptChains, enrollDevice, foundFleet, MindStore } from "../src/index.ts";

/*
 * Convergence under misbehaving signers (written by the review of the incremental paths:
 * "late", v_chainbad, v_slots), in a fleet chained from its founding and in one that adopted
 * chains: forks, children dated before their parents, same-instant twins, a revoked node that
 * keeps writing, a node that writes before its enrollment, unknown signers, unchained events.
 * Any delivery order and batching must give the state a rebuild gives, including v_slots
 * (lastSlot) and v_chainbad, which the digest doesn't cover. More seeds: REVIEW_SEEDS=60.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * `legacy`: the fleet was founded before chains (v1 events, the owner's fleet among them) and
 * adopted them, so an unchained event after that is refused for a reason of its own.
 */
function universe(seed: number, rounds = 220, legacy = false): { fleet: string; events: GEvent[] } {
  const random = rng(seed);
  let now = Date.UTC(2026, 10, 1);
  const nodes = Array.from({ length: 5 }, () => newNodeIdentity());
  const [a, b, c, d, e] = nodes as [NodeIdentity, NodeIdentity, NodeIdentity, NodeIdentity, NodeIdentity];
  const founder = new MindStore(":memory:", new HlcClock(() => now));
  if (legacy) {
    const clock = new HlcClock(() => now);
    const v1 = (signer: NodeIdentity, kind: string, body: unknown, fleet: string) =>
      signEvent({ v: 1, fleet, hlc: clock.tick(), device: signer.id, kind, body } as never, signer);
    const genesis = v1(a, "fleet.genesis", { name: "chaos", created: 1 }, "");
    founder.expectFleet(genesis.id);
    const enroll = (node: NodeIdentity, name: string) =>
      v1(a, "device.enrolled", { device: node.id, name, kind: "node", role: "full", box: b64u(node.boxPublic), scopes: [] }, genesis.id);
    founder.ingest([genesis, enroll(a, "a"), enroll(b, "b"), enroll(c, "c")]);
    founder.ingest([v1(b, "memory.added", { text: "legacy b" }, genesis.id), v1(c, "memory.added", { text: "legacy c" }, genesis.id)]);
    adoptChains(founder, a);
  } else {
    foundFleet(founder, a, { fleetName: "chaos", nodeName: "a" });
    enrollDevice(founder, a, { device: b.id, name: "b", kind: "node", box: b64u(b.boxPublic) });
    enrollDevice(founder, a, { device: c.id, name: "c", kind: "node", box: b64u(c.boxPublic) });
  }
  for (const [node, name] of [[a, "backup"], [b, "heartbeat"], [c, "poll"]] as const) {
    founder.emit(a, "loop.set", { name, schedule: "every 30m", on: node.id, enabled: true, task: { kind: "heartbeat" } });
  }
  const stores = new Map<string, MindStore>([[a.id, founder]]);
  for (const node of [b, c, d]) {
    const s = new MindStore(":memory:", new HlcClock(() => now));
    s.expectFleet(founder.fleet!);
    s.ingest(founder.eventsSince({}, 100_000).events);
    stores.set(node.id, s);
  }
  const all = new Map<string, GEvent>();
  const keep = (event: GEvent) => all.set(event.id, event);
  const forge = (store: MindStore, node: NodeIdentity, body: Record<string, unknown>, over: Partial<GEvent>) => {
    const event = signEvent({ v: 2, fleet: store.fleet!, hlc: encodeHlc({ ms: now, counter: 0 }), device: node.id, prev: store.head(node.id), kind: "ledger.recorded", body, ...over } as never, node);
    store.ingest([event]);
    keep(event);
    return event;
  };
  let dPrev: string | null = null;
  const slot = [0, 0, 0];
  let enrolledD = false;
  let revokedC = false;
  for (let round = 0; round < rounds; round++) {
    now += Math.floor(random() * 2_000);
    const pick = Math.floor(random() * 3);
    const node = [a, b, c][pick]!;
    const store = stores.get(node.id)!;
    const k = random();
    try {
      if (k < 0.45) keep(store.emit(node, "ledger.recorded", { class: "create", resource: "sandbox.exec", target: `t${round}`, verdict: "allow" }));
      else if (k < 0.65) {
        const s = Date.UTC(2026, 10, 1) + ++slot[pick]! * 60_000;
        keep(store.emit(node, "loop.ran", { loop: ["backup", "heartbeat", "poll"][pick]!, run: `r${round}`, slot: s, status: "ok", started: s, finished: s, summary: "ok" }));
      } else if (k < 0.72) keep(store.remember(node, `note ${round}`));
      else if (k < 0.76) {
        // A same-instant twin of the head, chain-valid (id ground to sort after).
        const head = store.head(node.id);
        if (head) {
          const parent = store.event(head)!;
          for (let nonce = 0; nonce < 64; nonce++) {
            const twin = signEvent({ v: 2, fleet: store.fleet!, hlc: parent.hlc, device: node.id, prev: parent.id, kind: "ledger.recorded", body: { class: "read", resource: "twin", target: `${round}.${nonce}`, verdict: "allow" } } as never, node);
            if (twin.id > parent.id) {
              store.ingest([twin]);
              keep(twin);
              break;
            }
          }
        }
      } else if (k < 0.8 && node === b) {
        // b forks: a sibling of its head (or of its head's parent), dated now.
        const head = store.head(b.id);
        const parent = head ? (store.event(head)?.prev ?? null) : null;
        forge(store, b, { class: "read", resource: "fork", target: `f${round}`, verdict: "allow" }, { hlc: encodeHlc({ ms: now, counter: 7 }), prev: random() < 0.5 ? parent : head });
      } else if (k < 0.82 && node === c) {
        // c signs a child dated before its parent.
        const head = store.head(c.id);
        if (head) {
          const { ms } = decodeHlc(store.event(head)!.hlc);
          forge(store, c, { class: "read", resource: "early", target: `e${round}`, verdict: "allow" }, { hlc: encodeHlc({ ms: ms - 1, counter: 0 }) });
        }
      } else if (k < 0.86) {
        // d keeps signing, enrolled or not (before its enrollment: parked, then refused for its date).
        const ds = stores.get(d.id)!;
        const isRun = random() < 0.5;
        const ev = signEvent(
          {
            v: 2,
            fleet: ds.fleet!,
            hlc: encodeHlc({ ms: now, counter: 0 }),
            device: d.id,
            prev: dPrev,
            kind: isRun ? "loop.ran" : "ledger.recorded",
            body: isRun
              ? { loop: "backup", run: `d${round}`, slot: Date.UTC(2026, 10, 1) + round * 1000, status: "ok", started: 1, finished: 2, summary: "d" }
              : { class: "read", resource: "d", target: `d${round}`, verdict: "allow" },
          } as never,
          d,
        );
        dPrev = ev.id;
        ds.ingest([ev]);
        keep(ev);
      } else if (k < 0.88) {
        keep(signEvent({ v: 2, fleet: store.fleet!, hlc: encodeHlc({ ms: now, counter: 0 }), device: e.id, prev: null, kind: "memory.added", body: { text: `e ${round}` } } as never, e));
      } else if (k < 0.9) {
        // An unchained (v1) event, from an old binary say: refused, and no part of the node's chain.
        const v1 = signEvent({ v: 1, fleet: store.fleet!, hlc: encodeHlc({ ms: now, counter: 3 }), device: node.id, kind: "ledger.recorded", body: { class: "read", resource: "v1", target: `v${round}`, verdict: "allow" } } as never, node);
        store.ingest([v1]);
        keep(v1);
      }
    } catch {
      /* an emit the writer's own replica refused (a forked writer, say) */
    }
    if (!enrolledD && round > rounds / 3) {
      enrolledD = true;
      enrollDevice(founder, a, { device: d.id, name: "d", kind: "node", box: b64u(d.boxPublic) });
    }
    if (!revokedC && round > (2 * rounds) / 3) {
      revokedC = true;
      founder.ingest(stores.get(c.id)!.eventsSince(founder.frontier(), 100_000).events);
      try {
        keep(founder.emit(a, "device.revoked", { device: c.id, reason: "lost", head: founder.head(c.id) }));
      } catch {
        /* */
      }
    }
    if (random() < 0.2) {
      const ids = [...stores.keys()];
      const x = stores.get(ids[Math.floor(random() * ids.length)]!)!;
      const y = stores.get(ids[Math.floor(random() * ids.length)]!)!;
      if (x !== y) y.ingest(x.eventsSince(y.frontier(), 100_000).events);
    }
  }
  for (const store of stores.values()) for (const event of store.eventsSince({}, 100_000).events) keep(event);
  return { fleet: founder.fleet!, events: [...all.values()] };
}

function snapshot(store: MindStore) {
  return {
    digest: store.digest(),
    slots: store.db.query("SELECT loop, device, slot FROM v_slots ORDER BY loop, device").all(),
    chainbad: store.db.query("SELECT device FROM v_chainbad ORDER BY device").all(),
    frontier: store.frontier(),
    digests: store.deviceDigests(),
  };
}

describe("convergence with misbehaving signers", () => {
  const seeds = Number(process.env.REVIEW_SEEDS ?? 12);
  const cases = [
    ...Array.from({ length: seeds }, (_, i) => ({ seed: i + 1, legacy: false })),
    ...Array.from({ length: Math.ceil(seeds / 2) }, (_, i) => ({ seed: 1000 + i, legacy: true })),
  ];
  for (const { seed, legacy } of cases) {
    test(`PROPERTY seed ${seed}${legacy ? " (a fleet that adopted chains)" : ""}: any order and batching gives what a rebuild gives`, () => {
      const { fleet, events } = universe(seed, 220, legacy);
      const random = rng(seed * 7919);
      const reference = new MindStore(":memory:");
      reference.expectFleet(fleet);
      reference.ingest(events);
      reference.rebuild();
      const want = snapshot(reference);
      for (let trial = 0; trial < 3; trial++) {
        const replica = new MindStore(":memory:");
        replica.expectFleet(fleet);
        const delivery = shuffle([...events, ...events.filter(() => random() < 0.1)], random);
        while (delivery.length) replica.ingest(delivery.splice(0, 1 + Math.floor(random() * (random() < 0.5 ? 3 : 40))));
        expect(snapshot(replica)).toEqual(want);
      }
      // As sync delivers: each device's events in its own order, the devices interleaved at random.
      for (let trial = 0; trial < 3; trial++) {
        const replica = new MindStore(":memory:");
        replica.expectFleet(fleet);
        const lanes = new Map<string, GEvent[]>();
        const ordered = [...events].sort((x, y) => (x.hlc < y.hlc ? -1 : x.hlc > y.hlc ? 1 : x.id < y.id ? -1 : 1));
        for (const event of ordered) lanes.set(event.device, [...(lanes.get(event.device) ?? []), event]);
        const queues = [...lanes.values()];
        while (queues.some((q) => q.length)) {
          const live = queues.filter((q) => q.length);
          const q = live[Math.floor(random() * live.length)]!;
          replica.ingest(q.splice(0, 1 + Math.floor(random() * 6)));
        }
        expect(snapshot(replica)).toEqual(want);
      }
    }, 30_000); // seven replicas of a few hundred events, most of them replaying: 2-3 s alone, more beside the whole suite
  }
});
