import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, type Prov, signEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "../src/index.ts";

/*
 * Your word that one node may hand tasks to another's agents (handoff.granted, handoff.revoked; core's fabric.ts
 * HandoffTerms): given once for the pair, replaced by the next one for it, ended by a revocation, and only ever your
 * word, from a full node, between two nodes. Every replica applies the same checks on replay, so grants converge like
 * everything else: any order, duplicates, a rebuild; and a replica that held them before it knew the kinds applies them
 * once it is upgraded.
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

const allEvents = (store: LedgerStore): GEvent[] => store.eventsSince({}, 100_000).events;

function syncInto(from: LedgerStore, to: LedgerStore): void {
  for (;;) {
    const { events, more } = from.eventsSince(to.frontier(), 7);
    to.ingest(events);
    if (!more) return;
  }
}

/** Two full nodes of one fleet. With `now`, both keep that time. */
function fleet(now?: () => number): { a: NodeIdentity; b: NodeIdentity; storeA: LedgerStore; storeB: LedgerStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new LedgerStore(":memory:", now ? new HlcClock(now) : undefined);
  foundFleet(storeA, a, { fleetName: "homelab", nodeName: "laptop" });
  enrollDevice(storeA, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new LedgerStore(":memory:", now ? new HlcClock(now) : undefined);
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const YOURS: Prov = { trust: "owner" };
const terms = (budgetUsdPerDay = 5, more: Record<string, unknown> = {}) => ({ tools: ["fleet"], budgetUsdPerDay, ...more });

/** Grant `from` hand-offs to `to`, as you, recorded by `signer`. */
const grant = (store: LedgerStore, signer: NodeIdentity, from: string, to: string, t: Record<string, unknown> = terms(), prov: Prov = YOURS): GEvent =>
  store.emit(signer, "handoff.granted", { from, to, terms: t }, prov);
const revoke = (store: LedgerStore, signer: NodeIdentity, from: string, to: string, prov: Prov = YOURS): GEvent => store.emit(signer, "handoff.revoked", { from, to }, prov);

/** Grants by pair, in the code units' order: the same order whatever the ids are (a locale's order isn't). */
const byPair = (x: { from: string; to: string }, y: { from: string; to: string }) => {
  const [p, q] = [`${x.from}:${x.to}`, `${y.from}:${y.to}`];
  return p < q ? -1 : p > q ? 1 : 0;
};

/** The grants as a reader sees them, by pair. */
const seen = (store: LedgerStore) => store.handoffGrants().map((g) => ({ from: g.from, to: g.to, terms: g.terms, via: g.via })).sort(byPair);

/** An event signed by an enrolled node but never checked by a store's emit: what a misbehaving (or newer) node could send. */
function forged(store: LedgerStore, signer: NodeIdentity, kind: string, body: unknown, p?: Prov): GEvent {
  return signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never, ...(p ? { prov: p } : {}) }, signer);
}

describe("your grants for hand-offs, in the mind", () => {
  test("given, replaced and revoked by pair, the same on every node", () => {
    const { a, b, storeA, storeB } = fleet();
    grant(storeA, a, a.id, b.id);
    grant(storeA, a, b.id, a.id, terms(2), { trust: "owner", via: "c_phone000000000000000000000000000000000000000" });
    syncInto(storeA, storeB);
    expect(seen(storeB)).toEqual(
      [
        { from: a.id, to: b.id, terms: terms(), via: null },
        { from: b.id, to: a.id, terms: terms(2), via: "c_phone000000000000000000000000000000000000000" },
      ].sort(byPair),
    );
    expect(storeB.handoffGrant(a.id, b.id)?.terms).toEqual(terms());
    // Replaced: the pair's grant is the newer one; revoked: none.
    grant(storeB, b, a.id, b.id, terms(9, { agents: ["ada"] }));
    revoke(storeB, b, b.id, a.id);
    syncInto(storeB, storeA);
    expect(seen(storeA)).toEqual([{ from: a.id, to: b.id, terms: terms(9, { agents: ["ada"] }), via: null }]);
    expect(storeA.handoffGrant(b.id, a.id)).toBeNull();
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("two nodes that changed the same grant apart agree once they meet: the later word stands", () => {
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    grant(storeA, a, a.id, b.id);
    syncInto(storeA, storeB);
    now += 5;
    revoke(storeB, b, a.id, b.id);
    now += 5;
    grant(storeA, a, a.id, b.id, terms(3));
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) expect(seen(store)).toEqual([{ from: a.id, to: b.id, terms: terms(3), via: null }]);
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("only your word is a grant: an agent's, a stranger's or one with no word on whose it is is refused, on every replica", () => {
    const { a, b, storeA, storeB } = fleet();
    for (const prov of [{ trust: "agent" }, { trust: "untrusted" }] as Prov[]) {
      expect(() => grant(storeA, a, a.id, b.id, terms(), prov)).toThrow("a hand-off grant is your word alone");
      expect(() => revoke(storeA, a, a.id, b.id, prov)).toThrow("a hand-off grant is your word alone");
    }
    expect(() => storeA.emit(a, "handoff.granted", { from: a.id, to: b.id, terms: terms() })).toThrow("a hand-off grant is your word alone");
    // Sent anyway, by a node that never checked: kept in the log, refused by every replica, the same way.
    const sent = forged(storeA, a, "handoff.granted", { from: a.id, to: b.id, terms: terms(100) }, { trust: "agent" });
    storeA.ingest([sent]);
    syncInto(storeA, storeB);
    for (const store of [storeA, storeB]) {
      expect(store.rejection(sent.id)).toBe("a hand-off grant is your word alone");
      expect(seen(store)).toEqual([]);
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("only a full node records one, and only from one node to another", () => {
    const { a, b, storeA } = fleet();
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    expect(() => grant(storeA, limited, limited.id, b.id)).toThrow("only full nodes record your word");
    expect(() => grant(storeA, a, a.id, a.id)).toThrow("a hand-off grant is from one node to another");
    expect(() => grant(storeA, a, "c_phone000000000000000000000000000000000000000", b.id)).toThrow("a hand-off grant is from one node to another");
    expect(seen(storeA)).toEqual([]);
  });

  test("its terms are open in the log: a newer node's are kept as they were written", () => {
    const { a, b, storeA } = fleet();
    grant(storeA, a, a.id, b.id, terms(5, { hours: [9, 17] }));
    expect(storeA.handoffGrant(a.id, b.id)?.terms).toEqual(terms(5, { hours: [9, 17] }));
  });

  test("PROPERTY: any delivery order, with duplicates, yields identical grants and the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    const random = rng(41);
    const pairs: [string, string][] = [
      [a.id, b.id],
      [b.id, a.id],
    ];
    const quietly = (work: () => unknown): void => {
      try {
        work();
      } catch {
        /* refused by this replica: not in its log */
      }
    };
    for (let round = 0; round < 60; round++) {
      const [store, signer] = random() < 0.5 ? [storeA, a] : [storeB, b];
      const [from, to] = pairs[Math.floor(random() * pairs.length)]!;
      const pick = random();
      const prov: Prov = random() < 0.15 ? { trust: "agent" } : YOURS;
      if (pick < 0.6) quietly(() => grant(store, signer, from, to, terms(1 + round), prov));
      else if (pick < 0.85) quietly(() => revoke(store, signer, from, to, prov));
      else store.ingest([forged(store, signer, "handoff.granted", { from, to, terms: terms(500) }, { trust: "untrusted" })]);
      store.remember(signer, `note ${round}`);
      if (round % 13 === 12) {
        syncInto(storeA, storeB);
        syncInto(storeB, storeA);
      }
    }
    const everything = [...new Map([...allEvents(storeA), ...allEvents(storeB)].map((e) => [e.id, e])).values()];
    expect(everything.filter((e) => e.kind === "handoff.granted").length).toBeGreaterThan(5);
    let reference: { digest: string; grants: unknown } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const order = rng(seed);
      const replica = new LedgerStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const shuffled = shuffle([...everything, ...everything.slice(0, 12)], order);
      for (let i = 0; i < shuffled.length; i += 1 + Math.floor(order() * 5)) replica.ingest(shuffled.slice(i, i + 5));
      replica.ingest(shuffled);
      reference ??= { digest: replica.digest(), grants: seen(replica) };
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.grants as never);
      replica.rebuild();
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.grants as never);
      replica.close();
    }
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(reference!.digest);
    expect(storeB.digest()).toBe(reference!.digest);
  }, 60_000);

  test("a replica that held grants before it knew them applies them when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "invincible-handoffs-"));
    try {
      const path = join(dir, "ledger.db");
      const a = newNodeIdentity();
      const b = newNodeIdentity();
      const store = new LedgerStore(path);
      foundFleet(store, a, { fleetName: "homelab", nodeName: "laptop" });
      enrollDevice(store, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
      grant(store, a, a.id, b.id);
      grant(store, a, b.id, a.id, terms(2));
      revoke(store, a, b.id, a.id);
      const sent = forged(store, a, "handoff.granted", { from: b.id, to: a.id, terms: terms(100) }, { trust: "agent" });
      store.ingest([sent]);
      const digest = store.digest();
      const grants = seen(store);
      store.close();
      // As the older code left it: the events in the log, nothing of them in the views, the older schema version.
      const raw = new Database(path);
      raw.exec(`DELETE FROM v_lww WHERE k LIKE 'handoff:%'; DELETE FROM v_rejected WHERE id = '${sent.id}'; PRAGMA user_version = 6;`);
      raw.close();
      const upgraded = new LedgerStore(path);
      expect(upgraded.schemaVersion()).toBe(9);
      expect(seen(upgraded)).toEqual(grants);
      expect(upgraded.rejection(sent.id)).toBe("a hand-off grant is your word alone");
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
