import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { b64u, decodeHlc, encodeHlc, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, SetHash, sha256B64u, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MAX_WALKS, MindStore, PullState } from "../src/index.ts";

/*
 * What sync and the loops read on a timer is kept as events arrive, so it costs the same
 * at any log size. These hold it to what the log itself says, computed from scratch here:
 * after any delivery order, after a rebuild, and after migrating a replica written by the
 * store as it was before (fixtures/mind-v0.db).
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

const pull = (from: MindStore, to: MindStore, limit = 50) => {
  const state = new PullState(to);
  state.begin();
  for (let i = 0; i < 10_000; i++) {
    const { have, sets, after } = state.request(true);
    if (!state.receive(from.eventsSince(have, limit, sets, after)).more) return;
  }
  throw new Error("the pull never ended");
};

/** What the log says, from scratch: per device, its count, newest hlc and set hash. */
function fromScratch(store: MindStore) {
  const rows = store.db.query<{ id: string; hlc: string; device: string }, []>("SELECT id, hlc, device FROM events").all();
  const devices = new Map<string, { ids: string[]; top: string }>();
  for (const row of rows) {
    const d = devices.get(row.device) ?? { ids: [], top: "" };
    d.ids.push(row.id);
    if (row.hlc > d.top) d.top = row.hlc;
    devices.set(row.device, d);
  }
  const digests = Object.fromEntries([...devices].map(([device, d]) => [device, { n: d.ids.length, h: SetHash.of(d.ids).digest() }]));
  const frontier = Object.fromEntries([...devices].map(([device, d]) => [device, d.top]));
  // Exactly the query lastSlot used to run over the whole log.
  const slots = store.db
    .query<{ loop: string; device: string; slot: number }, []>(
      `SELECT json_extract(e.raw, '$.body.loop') AS loop, e.device AS device, MAX(json_extract(e.raw, '$.body.slot')) AS slot
       FROM events e LEFT JOIN v_rejected r ON r.id = e.id
       WHERE e.kind = 'loop.ran' AND r.id IS NULL AND json_extract(e.raw, '$.body.slot') IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`,
    )
    .all();
  return { digests, frontier, count: rows.length, slots };
}

function kept(store: MindStore) {
  const slots = store.db.query<{ loop: string; device: string; slot: number }, []>("SELECT loop, device, slot FROM v_slots ORDER BY loop, device").all();
  for (const { loop, device, slot } of slots) expect(store.lastSlot(loop, device)).toBe(slot);
  return { digests: store.deviceDigests(), frontier: store.frontier(), count: store.eventCount(), slots };
}

const expectKeptMatchesLog = (store: MindStore) => expect(kept(store)).toEqual(fromScratch(store));

interface Busy {
  nodes: NodeIdentity[];
  stores: MindStore[];
  events: GEvent[];
}

/**
 * Three nodes writing at once on their own replicas, mostly ledger entries and loop runs
 * (what a busy sandbox host writes), syncing now and then: so the union is full of events
 * that reach every other replica late.
 */
function busyFleet(seed: number, rounds = 120): Busy {
  const random = rng(seed);
  let now = Date.UTC(2026, 10, 1);
  const clock = () => now;
  const nodes = [newNodeIdentity(), newNodeIdentity(), newNodeIdentity()];
  const [a, b, c] = nodes as [NodeIdentity, NodeIdentity, NodeIdentity];
  const founder = new MindStore(":memory:", new HlcClock(clock));
  foundFleet(founder, a, { fleetName: "busy", nodeName: "a" });
  enrollDevice(founder, a, { device: b.id, name: "b", kind: "node", box: b64u(b.boxPublic) });
  enrollDevice(founder, a, { device: c.id, name: "c", kind: "node", box: b64u(c.boxPublic) });
  for (const [node, name] of [[a, "backup"], [b, "heartbeat"], [c, "poll"]] as const) {
    founder.emit(a, "loop.set", { name, schedule: "every 30m", on: node.id, enabled: true, task: { kind: "heartbeat" } });
  }
  const stores = [founder, ...[b, c].map(() => {
    const s = new MindStore(":memory:", new HlcClock(clock));
    s.expectFleet(founder.fleet!);
    s.ingest(founder.eventsSince({}, 100_000).events);
    return s;
  })];
  const loops = ["backup", "heartbeat", "poll"];
  const slots = [0, 0, 0];
  for (let round = 0; round < rounds; round++) {
    now += Math.floor(random() * 3_000);
    const i = Math.floor(random() * 3);
    const store = stores[i]!;
    const node = nodes[i]!;
    const k = random();
    if (k < 0.6) store.emit(node, "ledger.recorded", { class: "create", resource: "sandbox.exec", target: `sb${round}`, verdict: "allow" });
    else if (k < 0.8) {
      const slot = Date.UTC(2026, 10, 1) + ++slots[i]! * 1_800_000;
      store.emit(node, "loop.ran", { loop: loops[i]!, run: `s${slot.toString(36)}`, slot, status: "ok", started: slot, finished: slot, summary: "ok" });
    } else if (k < 0.9) store.remember(node, `note ${round}`, { tags: ["busy"] });
    else store.emit(node, "loop.ran", { loop: loops[i]!, run: `m${round}`, slot: null, status: "ok", started: now, finished: now, summary: "by hand" });
    // Now and then two replicas meet.
    if (random() < 0.15) {
      const x = stores[Math.floor(random() * 3)]!;
      const y = stores[Math.floor(random() * 3)]!;
      if (x !== y) y.ingest(x.eventsSince(y.frontier(), 100_000).events);
    }
  }
  const union = new Map<string, GEvent>();
  for (const store of stores) for (const event of store.eventsSince({}, 100_000).events) union.set(event.id, event);
  return { nodes, stores, events: [...union.values()] };
}

/** A fresh replica of the busy fleet (its clock is the real one: the events are all in the past). */
function replicaOf(fleet: Busy): MindStore {
  const store = new MindStore(":memory:");
  store.expectFleet(fleet.stores[0]!.fleet!);
  return store;
}

/** A founder `a` and a node `b` on one replica, a clock that moves only when told, and more replicas. */
function twoNodes() {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  let now = Date.UTC(2026, 10, 1);
  const full = new MindStore(":memory:", new HlcClock(() => now));
  foundFleet(full, a, { fleetName: "twins", nodeName: "a" });
  enrollDevice(full, a, { device: b.id, name: "b", kind: "node", box: b64u(b.boxPublic) });
  const replica = () => {
    const store = new MindStore(":memory:", new HlcClock(() => now));
    store.expectFleet(full.fleet!);
    return store;
  };
  return { a, b, full, replica, tick: () => (now += 10) };
}

/** `node`'s next event, dated exactly like its head, with an id ground to sort after it: chain-valid. */
function twin(store: MindStore, node: NodeIdentity, text: string): GEvent {
  const parent = store.event(store.head(node.id)!)!;
  for (let nonce = 0; ; nonce++) {
    const event = signEvent({ v: 2, fleet: store.fleet!, hlc: parent.hlc, device: node.id, prev: parent.id, kind: "memory.added", body: { text: `${text} ${nonce}` } }, node);
    if (event.id > parent.id) return event;
  }
}

describe("the log's running summaries equal the log", () => {
  for (const seed of [1, 2, 3, 4]) {
    test(`PROPERTY seed ${seed}: any delivery order and batching, with duplicates and late arrivals, keeps them exact`, () => {
      const fleet = busyFleet(seed);
      const random = rng(seed * 101);
      const reference = replicaOf(fleet);
      reference.ingest(fleet.events);
      const referenceDigest = reference.digest();
      for (let trial = 0; trial < 4; trial++) {
        const replica = replicaOf(fleet);
        const delivery = shuffle([...fleet.events, ...fleet.events.filter(() => random() < 0.2)], random);
        while (delivery.length) {
          replica.ingest(delivery.splice(0, 1 + Math.floor(random() * 25)));
          // After every batch, not just at the end.
          expectKeptMatchesLog(replica);
        }
        expect(replica.digest()).toBe(referenceDigest);
        replica.rebuild();
        expect(replica.digest()).toBe(referenceDigest);
        expectKeptMatchesLog(replica);
      }
    });
  }

  test("the writers' own replicas agree with the log too, and a rebuild changes nothing", () => {
    const fleet = busyFleet(9);
    for (const store of fleet.stores) {
      expectKeptMatchesLog(store);
      const before = { digest: store.digest(), ...kept(store) };
      store.rebuild();
      expect({ digest: store.digest(), ...kept(store) }).toEqual(before);
    }
  });

  test("late ledger entries and loop runs from a sound chain skip the replay, and land where a replay puts them", () => {
    const fleet = busyFleet(5, 200);
    const replica = replicaOf(fleet);
    // Everyone's history up to the last 30 events, then the stragglers one by one, oldest last.
    const ordered = [...fleet.events].sort((x, y) => (x.hlc < y.hlc ? -1 : x.hlc > y.hlc ? 1 : x.id < y.id ? -1 : 1));
    const head = ordered.slice(0, -30);
    const tail = ordered.slice(-30);
    replica.ingest(head);
    // Deliver each device's stragglers in its own order, but the devices one after another,
    // so most arrive after newer events of other devices.
    const byDevice = [...new Set(tail.map((e) => e.device))].map((d) => tail.filter((e) => e.device === d));
    let replays = 0;
    let late = 0;
    for (const events of byDevice.reverse()) {
      for (const event of events) {
        const lateNow = Object.values(replica.frontier()).some((top) => top > event.hlc);
        const result = replica.ingest([event]);
        if (lateNow) late++;
        if (result.rebuilt) replays++;
      }
    }
    expect(late).toBeGreaterThan(0);
    // Memories still replay when late; ledger entries and loop runs don't.
    const lateOthers = tail.filter((e) => e.kind !== "ledger.recorded" && e.kind !== "loop.ran").length;
    expect(replays).toBeLessThanOrEqual(lateOthers);
    const live = { digest: replica.digest(), ...kept(replica) };
    replica.rebuild();
    expect({ digest: replica.digest(), ...kept(replica) }).toEqual(live);
    expectKeptMatchesLog(replica);
  });
});

/** A late ledger entry, signed for `node` after its head, dated just after its parent. */
function lateEntry(store: MindStore, node: NodeIdentity, extra: Partial<GEvent> = {}): GEvent {
  const prev = store.head(node.id);
  const parent = prev ? store.event(prev)! : null;
  const { ms, counter } = decodeHlc(parent?.hlc ?? store.clock.tick());
  return signEvent(
    {
      v: 2,
      fleet: store.fleet!,
      hlc: encodeHlc({ ms, counter: counter + 1 }),
      device: node.id,
      prev,
      kind: "ledger.recorded",
      body: { class: "read", resource: "t", target: "late", verdict: "allow" },
      ...extra,
    } as never,
    node,
  );
}

describe("a late arrival replays whenever a replay could judge it differently", () => {
  // The clock moves only when told, so "newer" is newer however fast the test runs.
  function twoWriters() {
    const a = newNodeIdentity();
    const b = newNodeIdentity();
    let now = Date.UTC(2026, 10, 1);
    const store = new MindStore(":memory:", new HlcClock(() => now));
    foundFleet(store, a, { fleetName: "late", nodeName: "a" });
    enrollDevice(store, a, { device: b.id, name: "b", kind: "node", box: b64u(b.boxPublic) });
    now += 1_000;
    /** Something of a's, a second after everything so far. */
    const newer = () => {
      now += 1_000;
      return store.remember(a, "newer");
    };
    return { a, b, store, newer };
  }

  test("a sound late ledger entry doesn't replay; a late memory does", () => {
    const { b, store, newer } = twoWriters();
    const entry = lateEntry(store, b);
    newer();
    expect(store.ingest([entry])).toMatchObject({ added: 1, rebuilt: false });
    const late = signEvent(
      { v: 2, fleet: store.fleet!, hlc: encodeHlc({ ms: decodeHlc(entry.hlc).ms, counter: decodeHlc(entry.hlc).counter + 1 }), device: b.id, prev: entry.id, kind: "memory.added", body: { text: "late memory" } },
      b,
    );
    expect(store.ingest([late])).toMatchObject({ added: 1, rebuilt: true });
    const live = store.digest();
    store.rebuild();
    expect(store.digest()).toBe(live);
  });

  test("from a revoked device, or one enrolled at the same instant, it replays", () => {
    const { a, b, store, newer } = twoWriters();
    const c = newNodeIdentity();
    enrollDevice(store, a, { device: c.id, name: "c", kind: "node", box: b64u(c.boxPublic) });
    const enrollment = store.device(c.id)!.enrolledHlc;
    // c signs an entry dated the very moment it was enrolled: who came first is the ids' to say.
    const tie = signEvent({ v: 2, fleet: store.fleet!, hlc: enrollment, device: c.id, prev: null, kind: "ledger.recorded", body: { class: "read", resource: "t", target: "tie", verdict: "allow" } }, c);
    newer();
    expect(store.ingest([tie]).rebuilt).toBe(true);
    // b's entry from before its revocation reaches us after the revocation: replayed.
    const entry = lateEntry(store, b);
    store.emit(a, "device.revoked", { device: b.id, reason: "lost", head: store.head(b.id) });
    expect(store.ingest([entry]).rebuilt).toBe(true);
    const live = store.digest();
    store.rebuild();
    expect(store.digest()).toBe(live);
  });

  test("a late entry beside a refused sibling replays, and the fork is found", () => {
    const { b, store, newer } = twoWriters();
    const first = lateEntry(store, b);
    store.ingest([first]);
    const { ms } = decodeHlc(first.hlc);
    const early = lateEntry(store, b, { hlc: encodeHlc({ ms: ms - 1, counter: 0 }) } as Partial<GEvent>);
    newer();
    store.ingest([early]); // dated before its parent: refused
    const sibling = lateEntry(store, b);
    expect(store.ingest([sibling]).rebuilt).toBe(true);
    expect(store.rejection(sibling.id)).toMatch(/forked/);
    const live = store.digest();
    store.rebuild();
    expect(store.digest()).toBe(live);
  });

  test("a refused unchained (v1) event is no part of its node's chain: that node's later events don't replay", () => {
    // Found by the review: a v1 refusal marked its node's chain as broken, so every later event
    // of that node, in order or late, replayed the whole log.
    const { b, full, replica, tick } = twoNodes();
    const other = replica();
    pull(full, other);
    // One unchained (v1) event signed by b: an old binary, say. Refused, harmlessly.
    tick();
    const v1 = signEvent({ v: 1, fleet: full.fleet!, hlc: new HlcClock(() => Date.UTC(2026, 10, 1) + 5).tick(), device: b.id, kind: "memory.added", body: { text: "old binary" } } as never, b);
    other.ingest([v1]);
    expect(other.rejection(v1.id)).toMatch(/unchained/);
    expect(other.db.query("SELECT device FROM v_chainbad").all()).toEqual([]);
    // b's ordinary, in-order, chained events from then on are applied in place.
    let replays = 0;
    for (let i = 0; i < 5; i++) {
      tick();
      const event = full.emit(b, "ledger.recorded", { class: "read", resource: "t", target: `x${i}`, verdict: "allow" });
      if (other.ingest([event]).rebuilt) replays++;
    }
    expect(replays).toBe(0);
    // And a rebuild judges b's chain the same way.
    const live = other.digest();
    other.rebuild();
    expect(other.digest()).toBe(live);
    expect(other.db.query("SELECT device FROM v_chainbad").all()).toEqual([]);
  });
});

describe("repairing a hole is paged", () => {
  test("a replica missing an old event is walked back to whole, one page at a time", () => {
    const fleet = busyFleet(7, 300);
    const full = replicaOf(fleet);
    full.ingest(fleet.events);
    const holed = replicaOf(fleet);
    const b = fleet.nodes[1]!;
    const bEvents = fleet.events.filter((e) => e.device === b.id).sort((x, y) => (x.hlc < y.hlc ? -1 : 1));
    const missing = bEvents[3]!;
    holed.ingest(fleet.events.filter((e) => e.id !== missing.id));
    expect(holed.event(missing.id)).toBeNull();
    expect(full.eventsSince(holed.frontier(), 20, holed.deviceDigests()).repair).toEqual([b.id]);

    const state = new PullState(holed);
    state.begin();
    let pages = 0;
    for (;;) {
      const { have, sets, after } = state.request(true);
      const page = full.eventsSince(have, 20, sets, after);
      expect(page.events.length).toBeLessThanOrEqual(20);
      pages++;
      if (!state.receive(page).more) break;
    }
    expect(pages).toBeGreaterThan(bEvents.length / 20);
    expect(holed.event(missing.id)).not.toBeNull();
    expect(holed.deviceDigests()).toEqual(full.deviceDigests());
    expect(holed.digest()).toBe(full.digest());
    // Whole again: nothing more to repair.
    expect(full.eventsSince(holed.frontier(), 20, holed.deviceDigests()).repair).toBeUndefined();
  });

  // (A fleet of eight devices and 2,400 events, walked: 0.7 s alone, past 5 s once under a load of 17 on 12 cores (19 November 2026): 30 s.)
  test("a walk goes on in the next pull, and a device is walked once per pull", () => {
    const fleet = busyFleet(8, 300);
    const full = replicaOf(fleet);
    full.ingest(fleet.events);
    const holed = replicaOf(fleet);
    const b = fleet.nodes[1]!;
    const missing = fleet.events.filter((e) => e.device === b.id).sort((x, y) => (x.hlc < y.hlc ? -1 : 1))[2]!;
    holed.ingest(fleet.events.filter((e) => e.id !== missing.id));
    const state = new PullState(holed);
    state.begin();
    // Two pages, then the pull is cut short (a timeout, say).
    for (let i = 0; i < 2; i++) {
      const { have, sets, after } = state.request(true);
      state.receive(full.eventsSince(have, 10, sets, after));
    }
    expect(state.walking()).toEqual([b.id]);
    state.begin();
    for (let i = 0; i < 1000; i++) {
      const { have, sets, after } = state.request(true);
      // A peer that keeps saying "repair" can't start the same walk twice in one pull.
      const page = { ...full.eventsSince(have, 10, sets, after), repair: [b.id] };
      if (!state.receive(page).more) break;
    }
    expect(state.walking()).toEqual([]);
    expect(holed.digest()).toBe(full.digest());
  }, 30_000);

  test("a peer's `repair` is a claim: only devices we hold some of are walked, at most MAX_WALKS a pull", () => {
    const a = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, a, { fleetName: "claims", nodeName: "a" });
    const nodes = Array.from({ length: MAX_WALKS + 4 }, () => newNodeIdentity());
    for (const [i, node] of nodes.entries()) enrollDevice(store, a, { device: node.id, name: `n${i}`, kind: "node", box: b64u(node.boxPublic) });
    for (const node of nodes) store.emit(node, "memory.added", { text: `from ${node.id}` });
    const state = new PullState(store);
    state.begin();
    // A device we hold nothing of comes by frontier anyway; junk, and a `repair` that isn't a list, start nothing.
    state.receive({ events: [], more: true, repair: [newNodeIdentity().id, 42 as never, "__proto__", "constructor"] });
    state.receive({ events: [], more: true, repair: "n_x" as never });
    expect(state.walking()).toEqual([]);
    // Every device we hold, named at once: MAX_WALKS of them are walked.
    const all = [a.id, ...nodes.map((node) => node.id)];
    state.receive({ events: [], more: true, repair: all });
    expect(state.walking()).toEqual(all.slice(0, MAX_WALKS));
    // In the next pull the walks carried over count, so none start until they end.
    state.begin();
    state.receive({ events: [], more: true, repair: all });
    expect(state.walking()).toEqual(all.slice(0, MAX_WALKS));
    // They end when the peer has nothing more; a pull after that starts at most MAX_WALKS again.
    expect(state.receive({ events: [], more: false }).more).toBe(false);
    expect(state.walking()).toEqual([]);
    state.begin();
    state.receive({ events: [], more: true, repair: all.slice(MAX_WALKS) });
    expect(state.walking()).toEqual(all.slice(MAX_WALKS));
  });

  test("a replica that's merely behind is caught up by frontier, with nothing to repair", () => {
    const fleet = busyFleet(3, 200);
    const full = replicaOf(fleet);
    full.ingest(fleet.events);
    const behind = replicaOf(fleet);
    const ordered = [...fleet.events].sort((x, y) => (x.hlc < y.hlc ? -1 : 1));
    behind.ingest(ordered.slice(0, ordered.length - 15));
    const page = full.eventsSince(behind.frontier(), 500, behind.deviceDigests());
    expect(page.repair).toBeUndefined();
    pull(full, behind);
    expect(behind.digest()).toBe(full.digest());
  });

  test("a page that ends between two events dated the same instant: the walk goes on after the event, not the instant", () => {
    // Found by the review: the walk's place was an hlc, so the second of two events dated the
    // same instant never came when a page ended at the first, and the replicas disagreed for good.
    const { b, full, replica, tick } = twoNodes();
    // b (a stolen key) writes 500 ordinary events...
    for (let i = 0; i < 500; i++) {
      tick();
      full.emit(b, "memory.added", { text: `b ${i}` });
    }
    const first500 = full.eventsSince({}, 100_000).events;
    // ...then a 501st dated the same instant as the 500th, then more.
    const hidden = twin(full, b, "hidden");
    full.ingest([hidden]);
    expect(full.rejection(hidden.id)).toBeNull();
    tick();
    const after = full.emit(b, "memory.added", { text: "after the twin" });

    // Another replica got b's first 500 straight from b (a partial delivery: SECURITY.md #4).
    const other = replica();
    other.ingest(first500);
    for (let i = 0; i < 5; i++) pull(full, other, 500);

    // The walk's page ends at the 500th event, and the next page goes on after that event.
    expect(other.event(hidden.id)).not.toBeNull();
    expect(other.rejection(after.id)).toBe(full.rejection(after.id));
    expect(other.digest()).toBe(full.digest());
    expect(full.eventsSince(other.frontier(), 500, other.deviceDigests()).repair).toBeUndefined();
  }, 20_000); // 500 signed events, then pulls that walk them: about a second alone

  test("`after` moves a device's answer on by event; without it (an older node) the answer is by hlc, as before", () => {
    const { a, b, full, tick } = twoNodes();
    for (let i = 0; i < 3; i++) {
      tick();
      full.emit(b, "memory.added", { text: `b ${i}` });
    }
    const head = full.event(full.head(b.id)!)!;
    const second = twin(full, b, "twin");
    full.ingest([second]);
    const have = { ...full.frontier(), [b.id]: head.hlc };
    expect(full.eventsSince(have).events).toEqual([]);
    expect(full.eventsSince(have, 500, undefined, { [b.id]: head.id }).events.map((e) => e.id)).toEqual([second.id]);
    // A place without an hlc means nothing: that device's log from its start.
    const whole = full.eventsSince({ [a.id]: full.frontier()[a.id]! }, 500, undefined, { [b.id]: head.id }).events;
    expect(whole.filter((e) => e.device === b.id).length).toBe(4);
    // A device being walked isn't checked for a hole (its set would only flag it again).
    expect(full.eventsSince(have, 500, { [b.id]: { n: 1, h: "elsewhere" } }, { [b.id]: head.id }).repair).toBeUndefined();
    expect(full.eventsSince(have, 500, { [b.id]: { n: 1, h: "elsewhere" } }).repair).toEqual([b.id]);
  });
});

describe("ingest", () => {
  test("an event already held is skipped before its signature is checked, so a tampered copy changes nothing", () => {
    const a = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, a, { fleetName: "dup", nodeName: "a" });
    const memory = store.remember(a, "original");
    const before = store.digest();
    const tampered = { ...memory, body: { text: "tampered" }, sig: memory.sig.replace(/^./, (ch) => (ch === "A" ? "B" : "A")) };
    expect(store.ingest([tampered])).toEqual({ added: 0, invalid: [], rebuilt: false });
    expect(store.digest()).toBe(before);
    expect(store.recall("tampered")).toEqual([]);
    // A forged event we don't hold is still refused.
    const forged = { ...store.remember(a, "another"), id: sha256B64u("not the content") };
    expect(store.ingest([forged]).invalid.length).toBe(1);
  });

  test("a refused emit leaves the running summaries as the log says", () => {
    const { a, full } = twoNodes();
    const before = { n: full.eventCount(), d: full.deviceDigests() };
    expect(() => full.emit(a, "notice.dismissed", { key: "no-such-notice" })).toThrow(/not authorized/);
    expect({ n: full.eventCount(), d: full.deviceDigests() }).toEqual(before);
    expect(full.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(before.n);
  });
});

describe("the cached state digest", () => {
  test("another process writing the same replica (galahad rebuild, say) doesn't leave a stale digest behind", () => {
    // Found by the review: the digest was kept until this connection's views changed.
    const dir = mkdtempSync(join(tmpdir(), "galahad-digest-"));
    const { b, full } = twoNodes();
    const path = join(dir, "mind.db");
    const daemon = new MindStore(path);
    let cli: MindStore | null = null;
    try {
      daemon.expectFleet(full.fleet!);
      daemon.ingest(full.eventsSince({}, 1000).events);
      const cached = daemon.digest();
      expect(daemon.digest()).toBe(cached); // kept while nothing changes
      cli = new MindStore(path);
      cli.ingest([full.emit(b, "memory.added", { text: "written by another process" })]);
      const theirs = cli.digest();
      cli.close();
      cli = null;
      expect(daemon.digest()).not.toBe(cached);
      expect(daemon.digest()).toBe(theirs);
    } finally {
      cli?.close();
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrating a replica in place", () => {
  const fixture = join(import.meta.dir, "fixtures", "mind-v0.db");
  const expected = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "mind-v0.json"), "utf8"));

  function copyOf(path: string): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "galahad-migrate-"));
    const copy = join(dir, "mind.db");
    copyFileSync(path, copy);
    return { dir, path: copy };
  }

  const logHash = (store: MindStore) =>
    sha256B64u(
      store.db
        .query<{ id: string; raw: string }, []>("SELECT id, raw FROM events ORDER BY id")
        .all()
        .map((e) => `${e.id}:${e.raw}`)
        .join("\n"),
    );

  test("a replica made by the store before schema versions opens with nothing lost or changed", () => {
    const { dir, path } = copyOf(fixture);
    try {
      const raw = new Database(path);
      expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(0);
      raw.close();
      const store = new MindStore(path);
      expect(store.schemaVersion()).toBe(6);
      expect(store.fleet).toBe(expected.fleet);
      expect(logHash(store)).toBe(expected.log);
      expect(store.eventCount()).toBe(expected.eventCount);
      expect(store.digest()).toBe(expected.digest);
      expect(store.frontier()).toEqual(expected.frontier);
      expect({ a: store.head(expected.devices.a), b: store.head(expected.devices.b), c: store.head(expected.devices.c) }).toEqual(expected.heads);
      expect({
        heartbeatOnB: store.lastSlot("heartbeat", expected.devices.b),
        pollOnC: store.lastSlot("poll", expected.devices.c),
        heartbeatOnA: store.lastSlot("heartbeat", expected.devices.a),
      }).toEqual(expected.lastSlot);
      expect(store.loopRuns(undefined, 1000).map((e) => e.id)).toEqual(expected.loopRuns);
      expect(store.ledger(1000).map((e) => e.id)).toEqual(expected.ledger);
      expect(store.db.query("SELECT id, reason FROM v_rejected ORDER BY id").all()).toEqual(expected.rejected);
      expect(store.forks()).toEqual(expected.forks);
      expect(store.pendingCount()).toBe(expected.pending);
      expect(store.recall(undefined, 50).map((m) => m.id)).toEqual(expected.recall);
      expectKeptMatchesLog(store);
      // The forked node's chain is known to be broken, so its next events replay.
      expect(store.db.query("SELECT device FROM v_chainbad").all()).toEqual([{ device: expected.devices.c }]);
      store.close();

      // Opening it again migrates nothing twice, and a rebuild agrees with what migration derived.
      const again = new MindStore(path);
      expect(again.digest()).toBe(expected.digest);
      const derived = kept(again);
      again.rebuild();
      expect(again.digest()).toBe(expected.digest);
      expect(kept(again)).toEqual(derived);
      expect(logHash(again)).toBe(expected.log);

      // And it syncs, hole-finding included, with a replica made today.
      const fresh = new MindStore(":memory:");
      fresh.expectFleet(expected.fleet);
      pull(again, fresh);
      expect(fresh.digest()).toBe(expected.digest);
      expect(fresh.deviceDigests()).toEqual(again.deviceDigests());
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Undo version 1 by hand: exactly the schema the store had before it. */
  function downgrade(path: string): void {
    const db = new Database(path);
    db.exec(`DROP TABLE log_devices; DROP TABLE v_slots; DROP TABLE v_chainbad;
      DROP INDEX events_kind; DROP INDEX events_loop; DROP INDEX events_device_order;
      CREATE INDEX events_device ON events (device, hlc); PRAGMA user_version = 0;`);
    db.close();
  }

  for (const seed of [21, 22]) {
    test(`PROPERTY seed ${seed}: a busy replica taken back to the old schema migrates to exactly what it kept live`, () => {
      const fleet = busyFleet(seed, 150);
      const dir = mkdtempSync(join(tmpdir(), "galahad-migrate-"));
      try {
        const path = join(dir, "mind.db");
        const store = new MindStore(path);
        store.expectFleet(fleet.stores[0]!.fleet!);
        store.ingest(shuffle(fleet.events, rng(seed)));
        const live = { digest: store.digest(), log: logHash(store), ...kept(store) };
        store.close();
        downgrade(path);
        const migrated = new MindStore(path);
        expect({ digest: migrated.digest(), log: logHash(migrated), ...kept(migrated) }).toEqual(live);
        expectKeptMatchesLog(migrated);
        migrated.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("a replica an older version wrote to in between is recounted on the next start", () => {
    const fleet = busyFleet(31, 80);
    const dir = mkdtempSync(join(tmpdir(), "galahad-migrate-"));
    try {
      const path = join(dir, "mind.db");
      const store = new MindStore(path);
      store.expectFleet(fleet.stores[0]!.fleet!);
      const ordered = [...fleet.events].sort((x, y) => (x.hlc < y.hlc ? -1 : 1));
      store.ingest(ordered.slice(0, -10));
      // What an older version would leave: the new events in the log and its views, but not
      // in what it doesn't know about.
      const stale = {
        log: store.db.query("SELECT * FROM log_devices").all() as { device: string; n: number; top: string; ids: Uint8Array }[],
        slots: store.db.query("SELECT * FROM v_slots").all() as { loop: string; device: string; slot: number }[],
      };
      store.ingest(ordered.slice(-10));
      const live = { digest: store.digest(), ...kept(store) };
      store.db.exec("DELETE FROM log_devices; DELETE FROM v_slots");
      for (const row of stale.log) store.db.query("INSERT INTO log_devices VALUES (?, ?, ?, ?)").run(row.device, row.n, row.top, row.ids);
      for (const row of stale.slots) store.db.query("INSERT INTO v_slots VALUES (?, ?, ?)").run(row.loop, row.device, row.slot);
      expect(store.eventCount()).toBeLessThan(fleet.events.length);
      store.close();
      const reopened = new MindStore(path);
      expect({ digest: reopened.digest(), ...kept(reopened) }).toEqual(live);
      expectKeptMatchesLog(reopened);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * From the review: a fleet founded before chains that adopted them, as the owner's is, written
   * by the store at 391be80 (throwaway keys). Node b wrote an unchained event after the adoption
   * (an old binary), and the revoked node c wrote in order after its revocation, which that store
   * refused as "signer is not an active device" where a rebuild says "written after the device
   * was revoked": a state no other replica could reach, kept by every later in-order event.
   */
  describe("a fleet that adopted chains (fixtures/review-legacy-v0.db)", () => {
    const legacyFixture = join(import.meta.dir, "fixtures", "review-legacy-v0.db");
    const legacy = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "review-legacy-v0.json"), "utf8"));
    /** What the old store refused, with the reason a rebuild gives (the one it got wrong). */
    const rebuilt = (legacy.rejected as { id: string; reason: string }[]).map((r) =>
      r.reason === "signer is not an active device" ? { ...r, reason: "written after the device was revoked" } : r,
    );
    const rejected = (db: { query: Database["query"] }) => db.query("SELECT id, reason FROM v_rejected ORDER BY id").all();

    test("it migrates with nothing lost, to what a rebuild holds and a replica that joins today", () => {
      const { dir, path } = copyOf(legacyFixture);
      try {
        const store = new MindStore(path);
        expect(store.schemaVersion()).toBe(6);
        expect(store.eventCount()).toBe(legacy.count);
        expect(store.pendingCount()).toBe(legacy.pending);
        expect(rejected(store.db)).toEqual(rebuilt);
        const migrated = store.digest();
        expect(migrated).not.toBe(legacy.digest); // the old store's own, which no other replica has
        const fresh = new MindStore(":memory:");
        fresh.expectFleet(store.fleet!);
        pull(store, fresh);
        expect(fresh.digest()).toBe(migrated);
        store.rebuild();
        expect(store.digest()).toBe(migrated);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("after migrating, the replica agrees with a rebuild of the same log", () => {
      const { dir, path } = copyOf(legacyFixture);
      try {
        const store = new MindStore(path);
        const migrated = store.digest();
        store.rebuild();
        expect(store.digest()).toBe(migrated);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the node that once wrote an unchained event doesn't replay the log for each of its events from now on", () => {
      const { dir, path } = copyOf(legacyFixture);
      try {
        const store = new MindStore(path);
        expect(store.db.query("SELECT device FROM v_chainbad").all()).toEqual([{ device: legacy.devices.c }]);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a first start killed mid-migration leaves the replica as the old store left it, and the next start migrates it whole", () => {
      const { dir, path } = copyOf(legacyFixture);
      try {
        // A process that starts migrating it and is killed partway through the replay: no
        // exception, no rollback statement, as when the power goes.
        const script = join(dir, "killed.mjs");
        writeFileSync(
          script,
          `import { writeSync } from "node:fs";
const { MindStore } = await import(process.env.MIND_SRC);
const apply = MindStore.prototype.apply;
let applied = 0;
MindStore.prototype.apply = function (...args) {
  if (++applied === 150) {
    writeSync(2, "killed after " + applied + " applied\\n");
    process.kill(process.pid, "SIGKILL");
  }
  return apply.apply(this, args);
};
new MindStore(process.env.MIND_DB);
writeSync(2, "opened after " + applied + " applied\\n");
`,
        );
        const child = Bun.spawnSync([process.execPath, script], {
          env: { ...process.env, MIND_SRC: pathToFileURL(join(import.meta.dir, "..", "src", "index.ts")).href, MIND_DB: path },
          stdout: "pipe",
          stderr: "pipe",
        });
        // (Computed in the child, so an error that quotes its source can't pass for it.)
        expect(child.stderr.toString()).toContain("killed after 150 applied");
        expect(child.stderr.toString()).not.toContain("opened after");
        expect(child.success).toBe(false);

        const raw = new Database(path);
        expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(0);
        expect(rejected(raw)).toEqual(legacy.rejected); // the old store's views, untouched
        expect(raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM log_devices").get()!.n).toBe(0);
        raw.close();

        const store = new MindStore(path);
        expect(store.schemaVersion()).toBe(6);
        expect(store.eventCount()).toBe(legacy.count);
        expect(rejected(store.db)).toEqual(rebuilt);
        const migrated = store.digest();
        store.rebuild();
        expect(store.digest()).toBe(migrated);
        expectKeptMatchesLog(store);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
