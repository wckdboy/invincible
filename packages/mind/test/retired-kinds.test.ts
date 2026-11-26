import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, Bodies, type GEvent, isKnownKind, newNodeIdentity, type NodeIdentity, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore } from "../src/index.ts";

/*
 * Features come and go; the log stays. A fleet's log may hold events of kinds this
 * version no longer uses: his dog's name (companion.named, companion.unnamed), from
 * the 3D world that was removed on 14 November 2026. Nothing writes or reads them
 * now, and nothing may change for a fleet that holds them: they fold to the same
 * state they always did, in any order, after a rebuild, on a replica upgraded in
 * place, and their refusals are the same. And a kind this version has never known
 * (a newer node's, or one an older version wrote and this one dropped) is kept,
 * relayed and left out of the views, the same on every replica.
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

function fleet(): { a: NodeIdentity; b: NodeIdentity; storeA: MindStore; storeB: MindStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:");
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "laptop" });
  enrollDevice(storeA, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:");
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

/** What the retired kinds fold to: the last name written, or null once it was taken back (or never given). */
const held = (store: MindStore): unknown => store.lww("companion")?.value ?? null;

/** An event of a kind this version doesn't know, signed and chained like any other. */
const unknownKind = (store: MindStore, signer: NodeIdentity, kind: string, body: unknown): GEvent =>
  signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never }, signer);

describe("a log that holds the retired kinds", () => {
  test("they are still known kinds, taken by the log as they always were: a replica never treats them as unknown", () => {
    expect(isKnownKind("companion.named")).toBe(true);
    expect(isKnownKind("companion.unnamed")).toBe(true);
    expect(Bodies["companion.named"].safeParse({ name: "Bors" }).success).toBe(true);
    expect(Bodies["companion.named"].safeParse({ name: "Rex the 3rd!" }).success).toBe(true);
    expect(Bodies["companion.named"].safeParse({ name: "" }).success).toBe(false);
    expect(Bodies["companion.named"].safeParse({ name: "x".repeat(65) }).success).toBe(false);
    expect(Bodies["companion.unnamed"].safeParse({}).success).toBe(true);
  });

  test("folds to the same state on every node, and the last writer wins", () => {
    const { a, b, storeA, storeB } = fleet();
    expect(held(storeA)).toBeNull();
    storeA.emit(a, "companion.named", { name: "Bors" });
    syncInto(storeA, storeB);
    expect(held(storeB)).toEqual({ name: "Bors" });
    storeB.emit(b, "companion.unnamed", {});
    syncInto(storeB, storeA);
    expect(held(storeA)).toBeNull();
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("two nodes that wrote them while apart agree once they meet", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.emit(a, "companion.named", { name: "Bors" });
    storeB.emit(b, "companion.named", { name: "Cavall" });
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(held(storeA)).toEqual(held(storeB));
    expect([{ name: "Bors" }, { name: "Cavall" }] as unknown[]).toContainEqual(held(storeA));
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("PROPERTY: any delivery order, with duplicates, yields the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    for (let i = 0; i < 6; i++) {
      storeA.emit(a, "companion.named", { name: `Bors ${i}` });
      storeB.emit(b, i % 2 ? "companion.unnamed" : "companion.named", i % 2 ? {} : { name: `Cavall ${i}` });
      storeA.remember(a, `note ${i}`);
    }
    const everything = [...allEvents(storeA), ...allEvents(storeB)];
    let reference: { digest: string; held: unknown } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const random = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const order = shuffle([...everything, ...everything.slice(0, 8)], random);
      for (let i = 0; i < order.length; i += 1 + Math.floor(random() * 5)) replica.ingest(order.slice(i, i + 5));
      replica.ingest(order);
      reference ??= { digest: replica.digest(), held: held(replica) };
      expect({ digest: replica.digest(), held: held(replica) }).toEqual(reference);
      replica.rebuild();
      expect({ digest: replica.digest(), held: held(replica) }).toEqual(reference);
      replica.close();
    }
  }, 30_000);

  test("a refusal is the same refusal, in the same words (its reason is part of the digest)", () => {
    const { a, storeA } = fleet();
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    const store = new MindStore(":memory:");
    store.expectFleet(storeA.fleet!);
    syncInto(storeA, store);
    expect(() => store.emit(limited, "companion.named", { name: "Mordred" })).toThrow("only full nodes may name his dog");
    expect(() => store.emit(limited, "companion.unnamed", {})).toThrow("only full nodes may name his dog");
    expect(held(store)).toBeNull();
  });

  test("a replica upgraded in place, one that held them before it knew them, and a rebuilt one all agree", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-retired-"));
    try {
      const path = join(dir, "mind.db");
      const a = newNodeIdentity();
      const store = new MindStore(path);
      foundFleet(store, a, { fleetName: "camelot", nodeName: "laptop" });
      store.emit(a, "companion.named", { name: "Bors" });
      store.remember(a, "the round table seats twelve");
      const digest = store.digest();
      const events = allEvents(store);
      store.close();

      // Upgraded in place: the file as a node left it, opened again by this version. Nothing moves.
      const inPlace = new MindStore(path);
      expect(inPlace.digest()).toBe(digest);
      expect(held(inPlace)).toEqual({ name: "Bors" });
      // And rebuilt from its log: the same.
      inPlace.rebuild();
      expect(inPlace.digest()).toBe(digest);
      inPlace.close();

      // As a version from before the kinds left it: the events in the log, nothing in the views, the older schema version.
      const raw = new Database(path);
      raw.exec("DELETE FROM v_lww WHERE k = 'companion'; PRAGMA user_version = 1;");
      raw.close();
      const upgraded = new MindStore(path);
      expect(upgraded.schemaVersion()).toBe(6);
      expect(held(upgraded)).toEqual({ name: "Bors" });
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();

      // A node that joins today and is sent the log: the same again.
      const joined = new MindStore(":memory:");
      joined.expectFleet(events[0]!.id);
      joined.ingest(events);
      expect(joined.digest()).toBe(digest);
      joined.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

/** What the views hold that an event's kind decides: the settings, the memories, the refusals (a device's chain head moves for any event). */
const folded = (store: MindStore): unknown => ({
  lww: store.db.query("SELECT k, v FROM v_lww ORDER BY k").all(),
  memories: store.db.query("SELECT id, text FROM v_memories ORDER BY id").all(),
  rejected: store.db.query("SELECT id, reason FROM v_rejected ORDER BY id").all(),
});

describe("a log that holds kinds this version has never known", () => {
  test("they are kept, relayed and left out of the views: the same mind in any order, and after a rebuild", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.remember(a, "before");
    const before = folded(storeA);
    for (const [kind, body] of [
      ["world.settings", { quality: "high", sound: false }],
      ["journal.kept", { day: "2026-11-11", text: "a day" }],
      ["experiment.saved", { id: "ex_000000000000", title: "an arm" }],
    ] as const) {
      const event = unknownKind(storeA, a, kind, body);
      expect(isKnownKind(event.kind)).toBe(false);
      expect(storeA.ingest([event])).toMatchObject({ added: 1, invalid: [] });
      expect(storeA.rejection(event.id)).toBeNull();
    }
    // Kept in the log, and nothing they say is in the views.
    expect(folded(storeA)).toEqual(before);
    // The device's chain goes on after them, and they travel with the rest.
    storeA.remember(a, "after");
    syncInto(storeA, storeB);
    storeB.ingest([unknownKind(storeB, b, "board.item", { kind: "note", text: "from another node" })]);
    syncInto(storeB, storeA);
    expect(allEvents(storeB).filter((e) => !isKnownKind(e.kind)).map((e) => e.kind).sort()).toEqual(["board.item", "experiment.saved", "journal.kept", "world.settings"]);
    expect(storeA.digest()).toBe(storeB.digest());

    const everything = allEvents(storeA);
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const order = shuffle([...everything, ...everything.slice(0, 5)], random);
      for (let i = 0; i < order.length; i += 1 + Math.floor(random() * 4)) replica.ingest(order.slice(i, i + 4));
      replica.ingest(order);
      expect(replica.digest()).toBe(storeA.digest());
      replica.rebuild();
      expect(replica.digest()).toBe(storeA.digest());
      expect(replica.eventCount()).toBe(everything.length);
      replica.close();
    }
  }, 30_000);
});
