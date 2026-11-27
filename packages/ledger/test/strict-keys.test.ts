import { describe, expect, test } from "bun:test";
import { b64u, encodeHlc, eventId, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, OWNER_SCOPES, signEvent, SIGNATURES_STRICT_FROM, type UnsignedEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "../src/index.ts";

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

  // The review of apps-name-node, M1: an older node of the fleet still enrolls a weak key (only an upgraded node's
  // enrollDevice refuses it), and every upgraded node took that enrollment by sync. From the cutoff, by the enrollment's
  // own HLC, the log refuses it at apply as enrollDevice does; one stamped before is kept as ever.
  test("an older node's enrollment of a weak key stamped from the cutoff is refused on every replica in any order, one stamped before kept; a rebuild keeps the state", () => {
    const before = SIGNATURES_STRICT_FROM - 3_600_000;
    const founder = newNodeIdentity();
    const origin = new LedgerStore(":memory:", new HlcClock(() => before));
    const fleet = foundFleet(origin, founder, { fleetName: "homelab", nodeName: "older" });
    // The point of order 2: as weak a key as the identity, written another way.
    const order2 = Uint8Array.from("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f".match(/../g)!, (b) => parseInt(b, 16));
    const weakAfter = `n_${b64u(order2)}`;
    const box = b64u(new Uint8Array(32).fill(9));
    // What the older node signs, as its enrollDevice wrote it: once before the cutoff, once after.
    const enroll = (ms: number, device: string, prev: string): GEvent =>
      signEvent({ v: 2, fleet, hlc: encodeHlc({ ms, counter: 0 }), device: founder.id, prev, kind: "device.enrolled", body: { device, name: device.slice(2, 8), kind: "node", role: "full", box, scopes: OWNER_SCOPES } }, founder);
    const early = enroll(before + 60_000, WEAK, origin.head(founder.id)!);
    const late = enroll(SIGNATURES_STRICT_FROM, weakAfter, early.id); // (the cutoff itself is after it)
    const all = [...origin.eventsSince({}, 1000).events, early, late];
    const replica = (events: GEvent[]) => {
      const store = new LedgerStore(":memory:", new HlcClock(() => SIGNATURES_STRICT_FROM + 86_400_000));
      store.expectFleet(fleet);
      for (const event of events) store.ingest([event]);
      return store;
    };
    const replicas = [all, [...all].reverse(), [late, early, ...all.slice(0, -2)], [early, ...all.slice(0, -2).reverse(), late]].map(replica);
    for (const store of replicas) {
      expect(store.activeDevice(WEAK)?.kind).toBe("node");
      expect(store.activeDevice(weakAfter)).toBeFalsy();
      expect(store.rejection(late.id)).toBe("its key fails Ed25519's strict rule");
    }
    const digests = new Set(replicas.map((store) => store.digest()));
    expect(digests.size).toBe(1);
    for (const store of replicas) {
      store.rebuild();
      expect(store.digest()).toBe([...digests][0]!);
    }
  });

  // The review of log-strict, F2 (its P2): before the cutoff's refusal, a weak key's second enrollment (from the cutoff)
  // made it known on every replica, whatever came late; refused, it must still leave every replica the same.
  test("a weak key enrolled before the cutoff and again from it, its first enroller's revocation arriving late: every replica the same", () => {
    let now = SIGNATURES_STRICT_FROM - 3 * 3_600_000;
    const founder = newNodeIdentity();
    const x = newNodeIdentity();
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
    // x, an older node, enrolls the weak key before the cutoff (E0), as its enrollDevice wrote one.
    const box = b64u(new Uint8Array(32).fill(9));
    sX.emit(x, "device.enrolled", { device: WEAK, name: "weak", kind: "node", role: "full", box, scopes: OWNER_SCOPES });
    // The weak key's forgery (R the identity, S zero), stamped before the cutoff.
    const universal = new Uint8Array(64);
    universal.set(identityPoint, 0);
    const unsigned: UnsignedEvent = { v: 2, fleet, hlc: encodeHlc({ ms: now + 1_000, counter: 0 }), device: WEAK, prev: null, kind: "memory.added", body: { text: "weak's note" } };
    const forged = { ...unsigned, id: eventId(unsigned), sig: b64u(universal) } as GEvent;
    // From the cutoff the founder, an older node too, enrolls the weak key again (E1).
    now = SIGNATURES_STRICT_FROM + 60_000;
    const e1 = signEvent({ v: 2, fleet, hlc: encodeHlc({ ms: now, counter: 0 }), device: founder.id, prev: sF.head(founder.id), kind: "device.enrolled", body: { device: WEAK, name: "weak-again", kind: "node", role: "full", box, scopes: OWNER_SCOPES } }, founder);
    const union = new Map<string, GEvent>();
    for (const store of [sF, sX]) for (const event of store.eventsSince({}, 100_000).events) union.set(event.id, event);
    const events = [...union.values(), forged, e1];
    const revoked = events.find((e) => e.kind === "device.revoked")!;
    // The revocation, and the vault's rotation after it: what replica A hears of last.
    const late = events.filter((e) => e.device === founder.id && e.hlc >= revoked.hlc && e.id !== e1.id);
    now = SIGNATURES_STRICT_FROM + 86_400_000;
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
    // Gossip both ways, as sync would.
    a.ingest(b.eventsSince({}, 100_000).events);
    b.ingest(a.eventsSince({}, 100_000).events);
    expect([a.pendingCount(), b.pendingCount()]).toEqual([0, 0]);
    expect(a.eventCount()).toBe(b.eventCount());
    expect(a.digest()).toBe(b.digest());
    // The weak key is active on neither: its first enrollment's signer was revoked before it, and its second is refused.
    for (const store of [a, b]) expect(store.activeDevice(WEAK)).toBeFalsy();
  });
});

