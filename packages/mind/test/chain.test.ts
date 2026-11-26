import { describe, expect, test } from "bun:test";
import { b64u, decodeHlc, encodeHlc, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, signEvent } from "@galahad/core";
import { adoptChains, enrollDevice, foundFleet, MindStore, PullState, revokeDevice } from "../src/index.ts";

/*
 * Review findings #1 and #4: every device's events form a hash chain.
 *  - A stolen key cannot write "in the past": revocation pins the chain head.
 *  - A device that forks its own chain (equivocates) is caught by every replica.
 *  - A device's events that only some replicas received are found by digests.
 */

/** One pull, as the sync engine makes it (PullState), with the peer answering directly. */
function sync(from: MindStore, to: MindStore, withDigests = true): void {
  const pull = new PullState(to);
  pull.begin();
  for (let i = 0; i < 1000; i++) {
    const { have, sets, after } = pull.request(withDigests);
    if (!pull.receive(from.eventsSince(have, 50, sets, after)).more) return;
  }
  throw new Error("the pull never ended");
}

function fleet() {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:");
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "a" });
  enrollDevice(storeA, a, { device: b.id, name: "b", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:");
  storeB.expectFleet(storeA.fleet!);
  sync(storeA, storeB);
  return { a, b, storeA, storeB };
}

/** What an attacker holding a node's private key can forge. */
function forge(store: MindStore, key: NodeIdentity, kind: string, body: unknown, opts: { hlc: string; prev: string | null }): GEvent {
  return signEvent(
    { v: 2, fleet: store.fleet!, hlc: opts.hlc, device: key.id, prev: opts.prev, kind, body: body as never },
    key,
  );
}

describe("hash chains", () => {
  test("a revoked node's stolen key cannot backdate an enrollment of its own device (review #1)", () => {
    const { a, b, storeA, storeB } = fleet();
    storeB.remember(b, "b was honest once");
    sync(storeB, storeA);
    const headBeforeTheft = storeB.head(b.id);
    revokeDevice(storeA, a, b.id, "key stolen");

    // The thief, on a replica that has not heard of the revocation, enrolls a device of
    // its own, signed with b's stolen key and dated *before* the revocation (right after
    // b's last real event, which is the latest a thief can make look legitimate).
    const intruder = newNodeIdentity();
    const headEvent = storeB.event(headBeforeTheft!)!;
    const [ms, counter] = headEvent.hlc.split(".");
    const backdated = `${ms}.${String(Number(counter) + 1).padStart(6, "0")}`;
    const evil = forge(
      storeB,
      b,
      "device.enrolled",
      { device: intruder.id, name: "intruder", kind: "node", role: "full", box: b64u(intruder.boxPublic), scopes: ["fleet:admin"] },
      { hlc: backdated, prev: headBeforeTheft },
    );
    storeB.ingest([evil]);
    expect(storeB.activeDevice(intruder.id)).not.toBeNull(); // b's replica is fooled… for now

    sync(storeA, storeB);
    sync(storeB, storeA);
    // Once the revocation (with b's pinned head) is known anywhere, the intruder is gone everywhere.
    for (const store of [storeA, storeB]) {
      expect(store.device(intruder.id)).toBeNull();
      expect(store.rejection(evil.id)).toMatch(/after the device was revoked/);
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("a device that forks its own chain is caught by every replica, in any order", () => {
    const { a, b, storeA, storeB } = fleet();
    storeB.remember(b, "before the fork");
    sync(storeB, storeA);
    const head = storeB.head(b.id)!;
    // Both branches dated after their parent, as a fork is (the wall clock made this depend on whether a
    // millisecond had passed: a sibling dated with its parent is refused for its date, which is another test).
    const clock = new HlcClock(() => decodeHlc(storeB.event(head)!.hlc).ms + 1_000);
    const left = forge(storeB, b, "memory.added", { text: "left branch" }, { hlc: clock.tick(), prev: head });
    const right = forge(storeB, b, "memory.added", { text: "right branch" }, { hlc: clock.tick(), prev: head });
    storeA.ingest([left]);
    storeB.ingest([right]);
    sync(storeA, storeB);
    sync(storeB, storeA);
    for (const store of [storeA, storeB]) {
      expect(store.recall("branch")).toEqual([]);
      expect(store.recall("before the fork").length).toBe(1); // history before the fork survives
      expect(store.rejection(left.id)).toMatch(/forked/);
      expect(store.rejection(right.id)).toMatch(/forked/);
    }
    expect(storeA.digest()).toBe(storeB.digest());
    // b's later honest-looking writes are refused too: the device is compromised.
    expect(() => storeB.remember(b, "after the fork")).toThrow();
    void a;
  });

  test("an event only some replicas received is found by digests, so replicas never silently fork (review #4)", () => {
    const { a, b, storeA, storeB } = fleet();
    const storeC = new MindStore(":memory:");
    storeC.expectFleet(storeA.fleet!);
    sync(storeA, storeC);
    // b writes two events; C only ever receives the newer one through some relay.
    storeB.remember(b, "first");
    storeB.remember(b, "second");
    const all = storeB.eventsSince({}, 10_000).events.filter((e) => e.device === b.id);
    storeA.ingest(all);
    // C first gets only the *second* (its predecessor is missing: a gap).
    storeC.ingest([all.at(-1)!]);
    expect(storeC.recall("second")).toEqual([]);
    // Frontier-only sync would skip the hole; digests find it.
    sync(storeA, storeC);
    expect(storeC.recall("first").length).toBe(1);
    expect(storeC.recall("second").length).toBe(1);
    expect(storeC.digest()).toBe(storeA.digest());
    void a;
  });

  test("a legacy fleet adopts chains once; no unchained event is accepted after that", () => {
    // Build a legacy (v1) fleet by hand, as it existed before chains.
    const founder = newNodeIdentity();
    const store = new MindStore(":memory:");
    const clock = new HlcClock();
    const v1 = (kind: string, body: unknown, fleetId: string) =>
      signEvent({ v: 1, fleet: fleetId, hlc: clock.tick(), device: founder.id, kind, body: body as never }, founder);
    const genesis = v1("fleet.genesis", { name: "old", created: 1 }, "");
    store.expectFleet(genesis.id);
    store.ingest([
      genesis,
      v1("device.enrolled", { device: founder.id, name: "f", kind: "node", role: "full", box: b64u(founder.boxPublic), scopes: [] }, genesis.id),
      v1("memory.added", { text: "legacy memory" }, genesis.id),
    ]);
    expect(store.recall("legacy").length).toBe(1);

    expect(adoptChains(store, founder)).toBe(3);
    expect(adoptChains(store, founder)).toBeNull(); // idempotent
    expect(store.recall("legacy").length).toBe(1); // grandfathered

    // A stolen key forging a backdated unchained event gets nowhere.
    const forged = signEvent(
      { v: 1, fleet: genesis.id, hlc: new HlcClock(() => 1).tick(), device: founder.id, kind: "memory.added", body: { text: "forged legacy" } },
      founder,
    );
    store.ingest([forged]);
    expect(store.recall("forged").length).toBe(0);
    expect(store.rejection(forged.id)).toMatch(/adopted chains/);
    // New writes are chained and work normally.
    store.remember(founder, "chained memory");
    expect(store.recall("chained").length).toBe(1);
  });

  test("a fleet founded today is chained from birth: unchained events are refused", () => {
    const { a, storeA } = fleet();
    const v1 = signEvent(
      { v: 1, fleet: storeA.fleet!, hlc: new HlcClock().tick(), device: a.id, kind: "memory.added", body: { text: "sneaky v1" } },
      a,
    );
    storeA.ingest([v1]);
    expect(storeA.rejection(v1.id)).toMatch(/chained fleet/);
  });

  test("a sibling refused for its date still forks the chain: the next event is judged as a rebuild would", () => {
    const { b, storeA, storeB } = fleet();
    storeB.remember(b, "honest");
    sync(storeB, storeA);
    const head = storeA.event(storeA.head(b.id)!)!;
    const { ms } = decodeHlc(head.hlc);
    // b signs a child of its head dated *before* it (refused: dated before its predecessor)…
    const early = forge(storeA, b, "memory.added", { text: "early sibling" }, { hlc: encodeHlc({ ms: ms - 1_000, counter: 0 }), prev: head.id });
    storeA.ingest([early]);
    expect(storeA.rejection(early.id)).toMatch(/dated before/);
    // …then another child of the same head, in order. Two children of one event: a fork.
    const later = forge(storeA, b, "memory.added", { text: "later sibling" }, { hlc: encodeHlc({ ms: ms + 1_000, counter: 0 }), prev: head.id });
    storeA.ingest([later]);
    const live = storeA.digest();
    expect(storeA.rejection(later.id)).toMatch(/forked/);
    storeA.rebuild();
    expect(storeA.digest()).toBe(live);
  });

  test("a gap's child dated before the event that fills it keeps the reason a rebuild gives it", () => {
    const { b, storeA, storeB } = fleet();
    const first = storeB.remember(b, "first");
    const second = forge(storeB, b, "memory.added", { text: "second" }, { hlc: encodeHlc({ ms: decodeHlc(first.hlc).ms + 5_000, counter: 0 }), prev: first.id });
    // A child of `second`, dated between `first` and `second`.
    const child = forge(storeB, b, "memory.added", { text: "child" }, { hlc: encodeHlc({ ms: decodeHlc(first.hlc).ms + 2_000, counter: 0 }), prev: second.id });
    storeA.ingest([first]);
    storeA.ingest([child]); // its predecessor is missing
    storeA.ingest([second]);
    const live = storeA.digest();
    storeA.rebuild();
    expect(storeA.digest()).toBe(live);
    expect(storeA.rejection(child.id)).toMatch(/dated before/);
  });

  test("what a revoked node signs after its revocation is refused for the reason a rebuild gives", () => {
    const { a, b, storeA, storeB } = fleet();
    storeB.remember(b, "before");
    sync(storeB, storeA);
    revokeDevice(storeA, a, b.id, "key stolen");
    const revocation = storeA.event(storeA.head(a.id)!)!;
    // In order: dated a second after everything storeA holds.
    const after = forge(storeA, b, "memory.added", { text: "after" }, { hlc: encodeHlc({ ms: decodeHlc(revocation.hlc).ms + 1_000, counter: 0 }), prev: storeA.head(b.id) });
    storeA.ingest([after]);
    const live = storeA.digest();
    const reason = storeA.rejection(after.id);
    storeA.rebuild();
    expect(storeA.rejection(after.id)).toBe(reason);
    expect(storeA.digest()).toBe(live);
    void storeB;
  });

  test("a far-future counter from an unknown key cannot wedge the clock (review #3)", () => {
    const { a, storeA } = fleet();
    const stranger = newNodeIdentity();
    const now = Date.now();
    const poison = signEvent(
      {
        v: 2,
        fleet: storeA.fleet!,
        hlc: `${String(now + 60_000).padStart(15, "0")}.999999`,
        device: stranger.id,
        prev: null,
        kind: "memory.added",
        body: { text: "poison" },
      },
      stranger,
    );
    storeA.ingest([poison]);
    expect(() => storeA.remember(a, "still writing")).not.toThrow();
  });
});
