import { describe, expect, test } from "bun:test";
import { b64u, encodeHlc, type GEvent, HlcClock, newNodeIdentity, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore } from "../src/index.ts";

/*
 * What the live stream hears of the mind (MindStore.onApplied): every event that entered the views, this node's own and
 * a peer's, once it is committed; a replay, as one that may have changed anything; never one that was refused.
 */

function heard(store: MindStore) {
  const calls: { kinds: string[]; rebuilt: boolean; committed: boolean; held: boolean }[] = [];
  const stop = store.onApplied((events: readonly GEvent[], rebuilt) => {
    calls.push({ kinds: events.map((e) => e.kind), rebuilt, committed: !store.db.inTransaction, held: events.every((e) => store.event(e.id) !== null) });
  });
  return { calls, stop };
}

function founded() {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  let now = Date.UTC(2026, 10, 25);
  const store = new MindStore(":memory:", new HlcClock(() => now));
  foundFleet(store, a, { fleetName: "camelot", nodeName: "keep" });
  enrollDevice(store, a, { device: b.id, name: "tower", kind: "node", box: b64u(b.boxPublic) });
  return { a, b, store, tick: () => (now += 1_000) };
}

describe("what the mind says it took", () => {
  test("this node's own event is said once, after it is committed and in the views", () => {
    const { a, store } = founded();
    const { calls } = heard(store);
    store.remember(a, "the owner likes short answers");
    expect(calls).toEqual([{ kinds: ["memory.added"], rebuilt: false, committed: true, held: true }]);
  });

  test("one the views refuse is never said: it never entered the log", () => {
    const { a, store } = founded();
    const { calls } = heard(store);
    expect(() => store.emit(a, "notice.dismissed", { key: "no-such-notice" })).toThrow(/not authorized/);
    expect(calls).toEqual([]);
  });

  test("a peer's events are said as one batch when they arrive, and a copy already held is not said again", () => {
    const { a, store } = founded();
    const peer = new MindStore(":memory:");
    peer.expectFleet(store.fleet!);
    peer.ingest(store.eventsSince({}, 1000).events);
    const { calls } = heard(peer);
    const first = store.remember(a, "first");
    const second = store.emit(a, "notice.raised", { key: "disk", severity: "warn", title: "Disk nearly full", body: "", source: "heartbeat", at: Date.now() });
    expect(peer.ingest([first, second]).added).toBe(2);
    expect(peer.ingest([first]).added).toBe(0);
    expect(calls).toEqual([{ kinds: ["memory.added", "notice.raised"], rebuilt: false, committed: true, held: true }]);
  });

  test("an event that comes late and replays the log is said as one that may have changed anything", () => {
    const { a, b, store, tick } = founded();
    tick();
    const entry = signEvent({ v: 2, fleet: store.fleet!, hlc: encodeHlc({ ms: Date.UTC(2026, 10, 25) + 500, counter: 0 }), device: b.id, prev: null, kind: "memory.added", body: { text: "late" } }, b);
    tick();
    store.remember(a, "newer");
    const { calls } = heard(store);
    expect(store.ingest([entry]).rebuilt).toBe(true);
    expect(calls).toEqual([{ kinds: ["memory.added"], rebuilt: true, committed: true, held: true }]);
  });

  test("a listener that throws breaks nothing, and one that stopped hears nothing more", () => {
    const { a, store } = founded();
    store.onApplied(() => {
      throw new Error("a listener's trouble");
    });
    const { calls, stop } = heard(store);
    store.remember(a, "one");
    stop();
    store.remember(a, "two");
    expect(calls.map((c) => c.kinds)).toEqual([["memory.added"]]);
    expect(store.recall("two")).toHaveLength(1);
  });
});
