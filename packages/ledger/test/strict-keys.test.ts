import { describe, expect, test } from "bun:test";
import { b64u, encodeHlc, eventId, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, OWNER_SCOPES, SIGNATURES_STRICT_FROM, type UnsignedEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "../src/index.ts";

/*
 * The lead's word of 27 November 2026: no node whose key fails Ed25519's strict rule (core's isStrictNodeId: a small-order
 * or mixed-order point, or one written two ways) is enrolled or founds a fleet, from today. As input validation: what is
 * in a log already is judged as it always was until the cutoff.
 */

const identityPoint = (() => {
  const point = new Uint8Array(32);
  point[0] = 1;
  return point;
})();
const WEAK = `n_${b64u(identityPoint)}`;

describe("a node's key, held to the strict rule as it enters", () => {
  test("a fleet is founded by no node whose key fails it", () => {
    const store = new LedgerStore(":memory:");
    const weak: NodeIdentity = { ...newNodeIdentity(), id: WEAK };
    expect(() => foundFleet(store, weak, { fleetName: "homelab", nodeName: "here" })).toThrow("this node's key fails Ed25519's strict rule: it can found no fleet");
    expect(store.fleet).toBeNull();
    // A real node founds one.
    expect(() => foundFleet(store, newNodeIdentity(), { fleetName: "homelab", nodeName: "here" })).not.toThrow();
  });

  test("no node is enrolled whose key fails it, nor any device with a node's id that does", () => {
    const store = new LedgerStore(":memory:");
    const founder = newNodeIdentity();
    foundFleet(store, founder, { fleetName: "homelab", nodeName: "here" });
    const box = b64u(new Uint8Array(32).fill(9));
    expect(() => enrollDevice(store, founder, { device: WEAK, name: "weak", kind: "node", box })).toThrow("isn't enrolled: its key fails Ed25519's strict rule");
    expect(() => enrollDevice(store, founder, { device: WEAK, name: "weak", kind: "client" })).toThrow("isn't enrolled: its key fails Ed25519's strict rule");
    expect(store.device(WEAK)).toBeFalsy();
    const peer = newNodeIdentity();
    enrollDevice(store, founder, { device: peer.id, name: "peer", kind: "node", box: b64u(peer.boxPublic) });
    expect(store.activeDevice(peer.id)).toBeTruthy();
  });
});

describe("the log, from the cutoff", () => {
  // The lead's word of 27 November 2026: from 14 December 2026 the log holds a node's signature to the strict rule, by the
  // event's own HLC. What is stamped before it is judged as it always was, so every replica keeps the same log of it, in
  // any order, and a rebuild gives the same state (convergence: any order, the same digest).
  test("a weak key's forged events: the one stamped before the cutoff is kept as ever, the one after refused, on every replica in any order; a rebuild keeps the state", () => {
    const before = SIGNATURES_STRICT_FROM - 3_600_000;
    const founder = newNodeIdentity();
    const origin = new LedgerStore(":memory:", new HlcClock(() => before));
    const fleet = foundFleet(origin, founder, { fleetName: "homelab", nodeName: "here" });
    // A node of the fleet enrolled the weak key before today's rule, as enrollDevice wrote an enrollment then.
    origin.emit(founder, "device.enrolled", { device: WEAK, name: "weak", kind: "node", role: "full", box: b64u(new Uint8Array(32).fill(9)), scopes: OWNER_SCOPES });
    // What the weak key "signs" (R the identity, S zero), which ZIP-215's rules take for any message.
    const universal = new Uint8Array(64);
    universal.set(identityPoint, 0);
    const forged = (ms: number, prev: string | null, key: string): GEvent => {
      const unsigned: UnsignedEvent = { v: 2, fleet, hlc: encodeHlc({ ms, counter: 0 }), device: WEAK, prev, kind: "notice.raised", body: { key, severity: "info", title: key, body: "", source: "weak", at: ms } };
      return { ...unsigned, id: eventId(unsigned), sig: b64u(universal) } as GEvent;
    };
    const early = forged(before + 60_000, null, "weak:before");
    const late = forged(SIGNATURES_STRICT_FROM + 60_000, early.id, "weak:after");
    // A real node's event after the cutoff, beside them.
    const later = new LedgerStore(":memory:", new HlcClock(() => SIGNATURES_STRICT_FROM + 120_000));
    later.expectFleet(fleet);
    later.ingest(origin.eventsSince({}, 1000).events);
    later.emit(founder, "notice.raised", { key: "real:after", severity: "info", title: "real", body: "", source: "real", at: SIGNATURES_STRICT_FROM + 120_000 });
    const all = [...later.eventsSince({}, 1000).events, early, late];
    // Replicas past the cutoff (so no event of these is from their future), each given them in another order.
    const replica = (events: GEvent[]) => {
      const store = new LedgerStore(":memory:", new HlcClock(() => SIGNATURES_STRICT_FROM + 86_400_000));
      store.expectFleet(fleet);
      const result = { invalid: [] as { id?: string; error: string }[] };
      for (const event of events) result.invalid.push(...store.ingest([event]).invalid);
      return { store, invalid: result.invalid };
    };
    const orders = [all, [...all].reverse(), [late, early, ...all.slice(0, -2).reverse()], [early, ...all.slice(0, -2), late]];
    const replicas = orders.map(replica);
    for (const { store, invalid } of replicas) {
      expect(invalid).toEqual([{ id: late.id, error: "bad event signature" }]);
      expect(store.event(early.id)).not.toBeNull();
      expect(store.event(late.id)).toBeNull();
      expect(store.lww("notice:weak:before")).not.toBeNull();
      expect(store.lww("notice:weak:after")).toBeNull();
      expect(store.lww("notice:real:after")).not.toBeNull();
    }
    const digests = new Set(replicas.map(({ store }) => store.digest()));
    expect(digests.size).toBe(1);
    for (const { store } of replicas) {
      store.rebuild();
      expect(store.digest()).toBe([...digests][0]!);
    }
  });
});
