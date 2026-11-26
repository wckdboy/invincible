import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, type Prov, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore } from "../src/index.ts";

/*
 * Sessions on a Mac's own screen in the mind (screen.asked, screen.decided, screen.ended; docs/MAC.md, M4): asked for
 * Galahad by a full node, allowed or not by you alone (the first answer stands), and ended once, by you or by him.
 * Every replica applies them the same way, so they converge like everything else: any order, duplicates, a rebuild;
 * and a replica that held them before it knew them applies them once it is upgraded.
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

function fleet(now?: () => number): { a: NodeIdentity; b: NodeIdentity; storeA: MindStore; storeB: MindStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "ultra" });
  enrollDevice(storeA, a, { device: b.id, name: "mini", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const PHONE = "c_phone000000000000000000000000000000000000000";
const YOURS: Prov = { trust: "owner", via: PHONE };
let n = 0;
const sessionId = () => `sc_${String(++n).padStart(22, "0")}`;
const ask = (store: MindStore, signer: NodeIdentity, mac: NodeIdentity, minutes = 30, id = sessionId()) => (store.emit(signer, "screen.asked", { id, node: mac.id, why: "build the app in Xcode", minutes }), id);
const seen = (store: MindStore) => store.screenSessions().map((s) => ({ id: s.id, verdict: s.decision?.verdict ?? null, via: s.decision?.via ?? null, ended: s.endedAt !== null, minutes: s.minutes }));

function forged(store: MindStore, signer: NodeIdentity, kind: string, body: unknown, p?: Prov): GEvent {
  return signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never, ...(p ? { prov: p } : {}) }, signer);
}

describe("screen sessions in the mind", () => {
  test("asked on one node, allowed by you on another, ended: the same on both, the time counted from your answer", () => {
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    const id = ask(storeA, a, b);
    syncInto(storeA, storeB);
    expect(seen(storeB)).toEqual([{ id, verdict: null, via: null, ended: false, minutes: 30 }]);
    now += 60_000;
    storeB.emit(b, "screen.decided", { id, verdict: "allowed" }, YOURS);
    syncInto(storeB, storeA);
    const [session] = storeA.screenSessions();
    expect(session).toMatchObject({ node: b.id, why: "build the app in Xcode", askedBy: a.id, decision: { verdict: "allowed", via: PHONE }, endedAt: null });
    expect(session!.decision!.at - session!.askedAt).toBeGreaterThanOrEqual(60_000);
    storeA.emit(a, "screen.ended", { id });
    syncInto(storeA, storeB);
    expect(seen(storeB)).toEqual([{ id, verdict: "allowed", via: PHONE, ended: true, minutes: 30 }]);
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("allowed by you alone, and the first answer stands; ended once; never one that wasn't asked", () => {
    const { a, b, storeA } = fleet();
    const id = ask(storeA, a, b);
    for (const prov of [{ trust: "agent" }, { trust: "untrusted" }] as Prov[]) {
      expect(() => storeA.emit(a, "screen.decided", { id, verdict: "allowed" }, prov)).toThrow("a screen session is yours alone to allow");
    }
    expect(() => storeA.emit(a, "screen.decided", { id, verdict: "allowed" })).toThrow("a screen session is yours alone to allow");
    storeA.emit(a, "screen.decided", { id, verdict: "denied" }, YOURS);
    expect(() => storeA.emit(a, "screen.decided", { id, verdict: "allowed" }, YOURS)).toThrow("screen session already decided");
    expect(seen(storeA)[0]!.verdict).toBe("denied");
    storeA.emit(a, "screen.ended", { id });
    expect(() => storeA.emit(a, "screen.ended", { id })).toThrow("screen session already ended");
    expect(() => storeA.emit(a, "screen.decided", { id: sessionId(), verdict: "allowed" }, YOURS)).toThrow("no such screen session");
    expect(() => storeA.emit(a, "screen.ended", { id: sessionId() })).toThrow("no such screen session");
    expect(() => ask(storeA, a, b, 30, id)).toThrow("screen session already asked");
  });

  test("only a full node writes them: a limited node's is refused, and a word that isn't yours is refused on every replica", () => {
    const { a, b, storeA, storeB } = fleet();
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    expect(() => ask(storeA, limited, b)).toThrow("only full nodes may ask for a screen session");
    const id = ask(storeA, a, b);
    const sent = forged(storeA, a, "screen.decided", { id, verdict: "allowed" }, { trust: "agent" });
    storeA.ingest([sent]);
    syncInto(storeA, storeB);
    for (const store of [storeA, storeB]) {
      expect(store.rejection(sent.id)).toBe("a screen session is yours alone to allow");
      expect(seen(store)[0]!.verdict).toBeNull();
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("PROPERTY: any delivery order, with duplicates, yields identical sessions and the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    const random = rng(31);
    const asked: string[] = [];
    const quietly = (work: () => unknown): void => {
      try {
        work();
      } catch {
        /* refused by this replica's rules: not in its log */
      }
    };
    for (let round = 0; round < 70; round++) {
      const [store, signer] = random() < 0.5 ? [storeA, a] : [storeB, b];
      const pick = random();
      if (pick < 0.3 || !asked.length) asked.push(ask(store, signer, b, 1 + Math.floor(random() * 60)));
      else {
        const id = asked[Math.floor(random() * asked.length)]!;
        const prov: Prov = random() < 0.15 ? { trust: "agent" } : YOURS;
        if (pick < 0.7) quietly(() => store.emit(signer, "screen.decided", { id, verdict: random() < 0.7 ? "allowed" : "denied" }, prov));
        else if (pick < 0.9) quietly(() => store.emit(signer, "screen.ended", { id }));
        else store.ingest([forged(store, signer, "screen.decided", { id, verdict: "allowed" }, { trust: "untrusted" })]);
      }
      store.remember(signer, `note ${round}`);
      if (round % 11 === 10) {
        syncInto(storeA, storeB);
        syncInto(storeB, storeA);
      }
    }
    const everything = [...new Map([...allEvents(storeA), ...allEvents(storeB)].map((e) => [e.id, e])).values()];
    expect(everything.filter((e) => e.kind === "screen.decided").length).toBeGreaterThan(5);
    let reference: { digest: string; sessions: unknown } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const order = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const shuffled = shuffle([...everything, ...everything.slice(0, 12)], order);
      for (let i = 0; i < shuffled.length; i += 1 + Math.floor(order() * 5)) replica.ingest(shuffled.slice(i, i + 5));
      replica.ingest(shuffled);
      reference ??= { digest: replica.digest(), sessions: seen(replica) };
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.sessions as never);
      replica.rebuild();
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.sessions as never);
      replica.close();
    }
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(reference!.digest);
    expect(storeB.digest()).toBe(reference!.digest);
  }, 60_000);

  test("a replica that held them before it knew them applies them when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-screen-"));
    try {
      const path = join(dir, "mind.db");
      const a = newNodeIdentity();
      const b = newNodeIdentity();
      const store = new MindStore(path);
      foundFleet(store, a, { fleetName: "camelot", nodeName: "ultra" });
      enrollDevice(store, a, { device: b.id, name: "mini", kind: "node", box: b64u(b.boxPublic) });
      const allowed = ask(store, a, b);
      store.emit(a, "screen.decided", { id: allowed, verdict: "allowed" }, YOURS);
      const ended = ask(store, a, b, 5);
      store.emit(a, "screen.ended", { id: ended });
      const sent = forged(store, a, "screen.decided", { id: ended, verdict: "allowed" }, { trust: "agent" });
      store.ingest([sent]);
      const digest = store.digest();
      const sessions = seen(store);
      store.close();
      // As the older code left it: the events in the log, nothing of them in the views, the older schema version.
      const raw = new Database(path);
      raw.exec(`DELETE FROM v_lww WHERE k LIKE 'screen%'; DELETE FROM v_rejected WHERE id = '${sent.id}'; PRAGMA user_version = 4;`);
      raw.close();
      const upgraded = new MindStore(path);
      expect(upgraded.schemaVersion()).toBe(6);
      expect(seen(upgraded)).toEqual(sessions);
      expect(upgraded.rejection(sent.id)).toBe("a screen session is yours alone to allow");
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
