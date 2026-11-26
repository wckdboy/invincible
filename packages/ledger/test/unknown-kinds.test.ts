import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, Bodies, type GEvent, isKnownKind, newNodeIdentity, type NodeIdentity, signEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "../src/index.ts";

/*
 * Features come and go; the log stays. A kind this version has never known (a newer
 * node's, or one an older version wrote and this one dropped) is kept, relayed and
 * left out of the views, the same on every replica.
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

function fleet(): { a: NodeIdentity; b: NodeIdentity; storeA: LedgerStore; storeB: LedgerStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new LedgerStore(":memory:");
  foundFleet(storeA, a, { fleetName: "homelab", nodeName: "laptop" });
  enrollDevice(storeA, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new LedgerStore(":memory:");
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

/** An event of a kind this version doesn't know, signed and chained like any other. */
const unknownKind = (store: LedgerStore, signer: NodeIdentity, kind: string, body: unknown): GEvent =>
  signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never }, signer);

/** What the views hold that an event's kind decides: the settings, the memories, the refusals (a device's chain head moves for any event). */
const folded = (store: LedgerStore): unknown => ({
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
      const replica = new LedgerStore(":memory:");
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
