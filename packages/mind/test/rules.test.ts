import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, type Prov, readRule, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore } from "../src/index.ts";

/*
 * Your rules in the mind (rule.set, rule.removed): set, replaced and removed by name, the last writer winning, and
 * only ever your word, from a full node. Every replica applies the same rules on replay, so they converge like
 * everything else: any order, duplicates, a rebuild; and a replica that held them before it knew them applies them
 * once it is upgraded, while a mind with none keeps the digest an older node computes.
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

const allEvents = (store: MindStore): GEvent[] => store.eventsSince({}, 100_000).events;

function syncInto(from: MindStore, to: MindStore): void {
  for (;;) {
    const { events, more } = from.eventsSince(to.frontier(), 7);
    to.ingest(events);
    if (!more) return;
  }
}

/** Two nodes of one fleet. With `now`, both keep that time: a test that says which of two things came first sets it itself. */
function fleet(now?: () => number): { a: NodeIdentity; b: NodeIdentity; storeA: MindStore; storeB: MindStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "laptop" });
  enrollDevice(storeA, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const YOURS: Prov = { trust: "owner" };
const lockRule = (does = "halt") => ({ on: "command", does, words: ["*.lock"] });

/** Set a rule as you, from `signer`. */
const set = (store: MindStore, signer: NodeIdentity, name: string, rule: Record<string, unknown> = lockRule(), prov: Prov = YOURS): GEvent => store.emit(signer, "rule.set", { name, rule }, prov);

/** The rules as a reader sees them: each name and what it holds. */
const seen = (store: MindStore) => store.rules().map((r) => ({ name: r.name, rule: r.rule, via: r.via }));

/** An event signed by an enrolled node but never checked by a store's emit: what a misbehaving (or newer) node could send. */
function forged(store: MindStore, signer: NodeIdentity, kind: string, body: unknown, p?: Prov): GEvent {
  return signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never, ...(p ? { prov: p } : {}) }, signer);
}

describe("your rules in the mind", () => {
  test("set, replaced and removed by name, the same on every node", () => {
    const { a, b, storeA, storeB } = fleet();
    set(storeA, a, "no-locks");
    set(storeA, a, "no-push", { on: "command", does: "refuse", words: [], contains: "git push" }, { trust: "owner", via: "c_phone000000000000000000000000000000000000000" });
    syncInto(storeA, storeB);
    expect(seen(storeB)).toEqual([
      { name: "no-locks", rule: lockRule(), via: null },
      { name: "no-push", rule: { on: "command", does: "refuse", words: [], contains: "git push" }, via: "c_phone000000000000000000000000000000000000000" },
    ]);
    // Replaced: the rule by that name is the newer one.
    set(storeB, b, "no-locks", lockRule("refuse"));
    storeB.emit(b, "rule.removed", { name: "no-push" }, YOURS);
    syncInto(storeB, storeA);
    expect(seen(storeA)).toEqual([{ name: "no-locks", rule: lockRule("refuse"), via: null }]);
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("two nodes that changed the same rule apart agree once they meet: the later one stands", () => {
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    set(storeA, a, "no-locks");
    syncInto(storeA, storeB);
    now += 5;
    storeB.emit(b, "rule.removed", { name: "no-locks" }, YOURS);
    now += 5;
    set(storeA, a, "no-locks", lockRule("refuse"));
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) expect(seen(store)).toEqual([{ name: "no-locks", rule: lockRule("refuse"), via: null }]);
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("only your word is a rule: an agent's, a stranger's or one with no word on whose it is is refused, on every replica", () => {
    const { a, storeA, storeB } = fleet();
    for (const prov of [{ trust: "agent" }, { trust: "untrusted" }] as Prov[]) {
      expect(() => set(storeA, a, "sneaky", lockRule(), prov)).toThrow("a rule is your word alone");
      expect(() => storeA.emit(a, "rule.removed", { name: "no-locks" }, prov)).toThrow("a rule is your word alone");
    }
    expect(() => storeA.emit(a, "rule.set", { name: "sneaky", rule: lockRule() })).toThrow("a rule is your word alone");
    // Sent anyway, by a node that never checked: kept in the log, refused by every replica, the same way.
    const sent = forged(storeA, a, "rule.set", { name: "sneaky", rule: lockRule() }, { trust: "agent" });
    storeA.ingest([sent]);
    syncInto(storeA, storeB);
    expect(storeB.rejection(sent.id)).toBe("a rule is your word alone");
    expect(seen(storeB)).toEqual([]);
    set(storeA, a, "kept");
    const removal = forged(storeA, a, "rule.removed", { name: "kept" }, { trust: "untrusted" });
    storeA.ingest([removal]);
    syncInto(storeA, storeB);
    for (const store of [storeA, storeB]) {
      expect(store.rejection(sent.id)).toBe("a rule is your word alone");
      expect(store.rejection(removal.id)).toBe("a rule is your word alone");
      expect(seen(store).map((r) => r.name)).toEqual(["kept"]);
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("only a full node writes one: a limited node's is refused", () => {
    const { a, storeA } = fleet();
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    expect(() => set(storeA, limited, "no-locks")).toThrow("only full nodes may record rules");
    expect(() => storeA.emit(limited, "rule.removed", { name: "no-locks" }, YOURS)).toThrow("only full nodes may record rules");
    expect(seen(storeA)).toEqual([]);
  });

  test("a rule is open in the log: a newer node's is kept as it was written, and this node reads what it understands of it", () => {
    const { a, storeA } = fleet();
    set(storeA, a, "later", { on: "answer", does: "halt", words: ["password"] });
    set(storeA, a, "narrower", { ...lockRule(), only: ["ada"] });
    const [later, narrower] = storeA.rules();
    expect(later!.rule).toEqual({ on: "answer", does: "halt", words: ["password"] });
    expect(readRule(later!.rule)).toBeNull();
    expect(readRule(narrower!.rule)).toEqual(lockRule() as never);
  });

  test("PROPERTY: any delivery order, with duplicates, yields identical rules and the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    const random = rng(23);
    const names = ["no-locks", "no-env", "no-push"];
    const quietly = (work: () => unknown): void => {
      try {
        work();
      } catch {
        /* refused by this replica's rules: not in its log */
      }
    };
    // Two nodes set, replace and remove rules apart, now and then a word that isn't yours among them, and meet now and then.
    for (let round = 0; round < 60; round++) {
      const [store, signer] = random() < 0.5 ? [storeA, a] : [storeB, b];
      const name = names[Math.floor(random() * names.length)]!;
      const pick = random();
      const prov: Prov = random() < 0.15 ? { trust: "agent" } : YOURS;
      if (pick < 0.6) quietly(() => set(store, signer, name, { on: "command", does: random() < 0.5 ? "halt" : "refuse", words: [`*.r${round}`] }, prov));
      else if (pick < 0.85) quietly(() => store.emit(signer, "rule.removed", { name }, prov));
      else store.ingest([forged(store, signer, "rule.set", { name, rule: lockRule() }, { trust: "untrusted" })]);
      store.remember(signer, `note ${round}`);
      if (round % 13 === 12) {
        syncInto(storeA, storeB);
        syncInto(storeB, storeA);
      }
    }
    const everything = [...new Map([...allEvents(storeA), ...allEvents(storeB)].map((e) => [e.id, e])).values()];
    expect(everything.filter((e) => e.kind === "rule.set").length).toBeGreaterThan(5);
    let reference: { digest: string; rules: unknown } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const order = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const shuffled = shuffle([...everything, ...everything.slice(0, 12)], order);
      for (let i = 0; i < shuffled.length; i += 1 + Math.floor(order() * 5)) replica.ingest(shuffled.slice(i, i + 5));
      replica.ingest(shuffled);
      reference ??= { digest: replica.digest(), rules: seen(replica) };
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.rules as never);
      replica.rebuild();
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.rules as never);
      replica.close();
    }
    // The two nodes that lived it agree with every replica that only heard of it.
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(reference!.digest);
    expect(storeB.digest()).toBe(reference!.digest);
  }, 60_000);

  test("an older node keeps them in its log, ignores them, and passes them on whole: a node that knows them applies them as one that always did", () => {
    // (A mind with no rule keeps the digest an older node computes: log.test.ts opens a replica the store before
    // schema versions wrote, and its digest is still the one recorded then.)
    const dir = mkdtempSync(join(tmpdir(), "galahad-rules-"));
    try {
      const path = join(dir, "mind.db");
      const a = newNodeIdentity();
      const store = new MindStore(path);
      foundFleet(store, a, { fleetName: "camelot", nodeName: "laptop" });
      store.remember(a, "before any rule");
      set(store, a, "no-locks");
      set(store, a, "no-env", { on: "command", does: "refuse", words: [".env*"] });
      store.emit(a, "rule.removed", { name: "no-locks" }, YOURS);
      const sent = forged(store, a, "rule.set", { name: "sneaky", rule: lockRule() }, { trust: "agent" });
      store.ingest([sent]);
      store.remember(a, "after them");
      const digest = store.digest();
      const rules = seen(store);
      // As an older node holds the same log: the events kept, nothing of them in its views (it never knew the kinds).
      const raw = new Database(path);
      raw.exec(`DELETE FROM v_lww WHERE k LIKE 'rule:%'; DELETE FROM v_rejected WHERE id = '${sent.id}';`);
      raw.close();
      expect(seen(store)).toEqual([]);
      expect(allEvents(store).filter((e) => e.kind.startsWith("rule.")).length).toBe(4);
      // A node that knows rules, hearing them only through it.
      const newer = new MindStore(":memory:");
      newer.expectFleet(store.fleet!);
      syncInto(store, newer);
      expect(seen(newer)).toEqual(rules);
      expect(newer.rejection(sent.id)).toBe("a rule is your word alone");
      expect(newer.digest()).toBe(digest);
      store.close();
      newer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("a replica that held rules before it knew them applies them when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-rules-"));
    try {
      const path = join(dir, "mind.db");
      const a = newNodeIdentity();
      const store = new MindStore(path);
      foundFleet(store, a, { fleetName: "camelot", nodeName: "laptop" });
      set(store, a, "no-locks");
      set(store, a, "no-push", { on: "command", does: "refuse", words: [], contains: "git push" });
      store.emit(a, "rule.removed", { name: "no-push" }, YOURS);
      const sent = forged(store, a, "rule.set", { name: "sneaky", rule: lockRule() }, { trust: "agent" });
      store.ingest([sent]);
      const digest = store.digest();
      const rules = seen(store);
      store.close();
      // As the older code left it: the events in the log, nothing of them in the views, the older schema version.
      const raw = new Database(path);
      raw.exec(`DELETE FROM v_lww WHERE k LIKE 'rule:%'; DELETE FROM v_rejected WHERE id = '${sent.id}'; PRAGMA user_version = 3;`);
      raw.close();
      const upgraded = new MindStore(path);
      expect(upgraded.schemaVersion()).toBe(6);
      expect(seen(upgraded)).toEqual(rules);
      expect(upgraded.rejection(sent.id)).toBe("a rule is your word alone");
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
