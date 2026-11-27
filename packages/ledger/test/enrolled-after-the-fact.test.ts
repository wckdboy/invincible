import { expect, test } from "bun:test";
import { b64u, encodeHlc, type GEvent, HlcClock, newNodeIdentity, signEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "../src/index.ts";

/*
 * Convergence when an enrollment is refused only after the fact (the review of log-strict, F1): its enroller's
 * revocation arrives late, or its enroller forks its own chain below it. Whichever replica took the enrollment first,
 * and whatever came in what order, every replica must end with the same log, nothing parked, and the same digest; and a
 * rebuild keeps it. Two replicas, given the same events in two orders, then gossiping both ways as sync does.
 */

const all = (...stores: LedgerStore[]): GEvent[] => {
  const union = new Map<string, GEvent>();
  for (const store of stores) for (const event of store.eventsSince({}, 100_000).events) union.set(event.id, event);
  return [...union.values()].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : 1));
};

function converged(a: LedgerStore, b: LedgerStore): void {
  a.ingest(b.eventsSince({}, 100_000).events);
  b.ingest(a.eventsSince({}, 100_000).events);
  expect([a.pendingCount(), b.pendingCount()]).toEqual([0, 0]);
  expect(a.eventCount()).toBe(b.eventCount());
  expect(a.digest()).toBe(b.digest());
  const digest = a.digest();
  for (const store of [a, b]) {
    store.rebuild();
    expect(store.digest()).toBe(digest);
  }
}

test("its enroller revoked late: the node it enrolled, and what that node wrote, are logged alike on every replica", () => {
  let now = Date.UTC(2026, 10, 20);
  const founder = newNodeIdentity();
  const x = newNodeIdentity();
  const w = newNodeIdentity();
  const sF = new LedgerStore(":memory:", new HlcClock(() => now));
  const fleet = foundFleet(sF, founder, { fleetName: "homelab", nodeName: "f" });
  now += 1_000;
  enrollDevice(sF, founder, { device: x.id, name: "x", kind: "node", box: b64u(x.boxPublic) });
  const sX = new LedgerStore(":memory:", new HlcClock(() => now));
  sX.expectFleet(fleet);
  sX.ingest(sF.eventsSince({}, 100_000).events);
  now += 1_000;
  revokeDevice(sF, founder, x.id, "lost"); // x doesn't hear of it
  now += 1_000;
  enrollDevice(sX, x, { device: w.id, name: "w", kind: "node", box: b64u(w.boxPublic) });
  const sW = new LedgerStore(":memory:", new HlcClock(() => now));
  sW.expectFleet(fleet);
  sW.ingest(sX.eventsSince({}, 100_000).events);
  now += 1_000;
  sW.remember(w, "w's note");
  const events = all(sF, sX, sW);
  const revoked = events.find((e) => e.kind === "device.revoked")!;
  // The revocation and the vault's rotation after it: what replica A hears of last.
  const late = events.filter((e) => e.device === founder.id && e.hlc >= revoked.hlc);
  expect(late.length).toBeGreaterThan(0);
  expect(events.some((e) => e.device === w.id)).toBe(true);
  now += 60_000;
  const replica = () => {
    const store = new LedgerStore(":memory:", new HlcClock(() => now));
    store.expectFleet(fleet);
    return store;
  };
  const a = replica();
  a.ingest(events.filter((e) => !late.includes(e)));
  a.ingest(late);
  const b = replica();
  b.ingest(events);
  converged(a, b);
  // Its enrollment refused (its enroller was revoked before it), w is active nowhere.
  expect([a.activeDevice(w.id), b.activeDevice(w.id)]).toEqual([null, null]);
});

test("its enroller forks its own chain below it: the node it enrolled, and what that node wrote, are logged alike on every replica", () => {
  let now = Date.UTC(2026, 10, 20);
  const founder = newNodeIdentity();
  const x = newNodeIdentity();
  const w = newNodeIdentity();
  const sF = new LedgerStore(":memory:", new HlcClock(() => now));
  const fleet = foundFleet(sF, founder, { fleetName: "homelab", nodeName: "f" });
  now += 1_000;
  enrollDevice(sF, founder, { device: x.id, name: "x", kind: "node", box: b64u(x.boxPublic) });
  const sX = new LedgerStore(":memory:", new HlcClock(() => now));
  sX.expectFleet(fleet);
  sX.ingest(sF.eventsSince({}, 100_000).events);
  now += 2_000;
  // One branch: x's first event, then x enrolls w on top of it.
  sX.remember(x, "x's note");
  now += 1_000;
  enrollDevice(sX, x, { device: w.id, name: "w", kind: "node", box: b64u(w.boxPublic) });
  const sW = new LedgerStore(":memory:", new HlcClock(() => now));
  sW.expectFleet(fleet);
  sW.ingest(sX.eventsSince({}, 100_000).events);
  now += 1_000;
  sW.remember(w, "w's note");
  // The other branch: another "first" event of x's, stamped before the first branch's (x equivocates, or was restored
  // from a backup and wrote from its old head).
  const other = signEvent({ v: 2, fleet, hlc: encodeHlc({ ms: now - 4_500, counter: 0 }), device: x.id, prev: null, kind: "memory.added", body: { text: "the other branch" } }, x);
  const events = all(sF, sX, sW);
  now += 60_000;
  const replica = () => {
    const store = new LedgerStore(":memory:", new HlcClock(() => now));
    store.expectFleet(fleet);
    return store;
  };
  const a = replica();
  a.ingest(events); // one branch first: w is enrolled, its note taken
  a.ingest([other]); // then the fork, which refuses x's events from it, w's enrollment among them
  const b = replica();
  b.ingest([...events, other]);
  converged(a, b);
});

// The final re-check of the v2 stack, RC-2: the founder is known from its genesis in the log, not from the genesis
// applied. A fork of the founder's own chain at its root (a second first event) refuses the genesis after the fact, and
// with the applied one gone, a replica that had the fork first parked every other device's events for good.
test("the founder forks its own chain at its root: what the others wrote is logged alike on every replica", () => {
  let now = Date.UTC(2026, 10, 20);
  const founder = newNodeIdentity();
  const x = newNodeIdentity();
  const sF = new LedgerStore(":memory:", new HlcClock(() => now));
  const fleet = foundFleet(sF, founder, { fleetName: "homelab", nodeName: "f" });
  now += 1_000;
  enrollDevice(sF, founder, { device: x.id, name: "x", kind: "node", box: b64u(x.boxPublic) });
  const sX = new LedgerStore(":memory:", new HlcClock(() => now));
  sX.expectFleet(fleet);
  sX.ingest(sF.eventsSince({}, 10_000).events);
  now += 1_000;
  const note = sX.emit(x, "memory.added", { text: "x's note" });
  const root = signEvent({ v: 2, fleet, hlc: encodeHlc({ ms: now + 1_000, counter: 0 }), device: founder.id, prev: null, kind: "memory.added", body: { text: "a second first event" } }, founder);
  const events = [...sF.eventsSince({}, 10_000).events, note];
  const replica = () => {
    const store = new LedgerStore(":memory:", new HlcClock(() => now));
    store.expectFleet(fleet);
    return store;
  };
  const a = replica();
  a.ingest(events); // x's note logged while the genesis stands
  a.ingest([root]); // then the fork, which refuses the genesis
  const b = replica();
  b.ingest([...events, root]);
  expect([a.rejection(fleet), b.rejection(fleet)]).toEqual(["the device forked its own chain (equivocation)", "the device forked its own chain (equivocation)"]);
  converged(a, b);
  expect(b.event(note.id)).not.toBeNull();
});
