import { describe, expect, test } from "bun:test";
import { b64u, bodyFingerprint, type Calibration, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, revokeDevice } from "../src/index.ts";

/*
 * Compute in the log: a node's own calibration, the owner's ceilings and policy, the
 * plan he re-derived, a trial run's effort. Who may write each, what stands when two
 * race, and that every replica agrees whatever order they arrive in.
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

const syncInto = (from: MindStore, to: MindStore) => {
  for (;;) {
    const { events, more } = from.eventsSince(to.frontier(), 50);
    to.ingest(events);
    if (!more) return;
  }
};

function fleet() {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:");
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "ultra" });
  enrollDevice(storeA, a, { device: b.id, name: "rack", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:");
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const body = { cores: 32, memoryGb: 182, gpu: [], sandboxHost: true, microVMs: true, localModels: [] };
const measured = (multi: number, at = 1_000): Calibration => ({ at, tookMs: 3000, reason: "joined", body: bodyFingerprint(body, null), cpu: { single: 1000, multi, threads: 16 } });
const plan = (slots: number) => ({ nodes: { n: { name: "ultra", sandboxes: slots, modelCalls: 8, cores: 16, memoryGb: 91, strength: 15.6 } }, sandboxHost: "n", effort: 3 });
const digest = (n: number) => String(n).padStart(22, "0");

describe("calibrations", () => {
  test("a node records its own measurement; its latest stands, on every replica", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.emit(a, "compute.calibrated", { measured: measured(15_600) });
    storeB.emit(b, "compute.calibrated", { measured: measured(9_200) });
    storeA.emit(a, "compute.calibrated", { measured: measured(14_100, 2_000) });
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) {
      expect(store.lww<Calibration>(`calibration:${a.id}`)?.value?.cpu.multi).toBe(14_100);
      expect(store.lww<Calibration>(`calibration:${b.id}`)?.value?.cpu.multi).toBe(9_200);
    }
    expect(storeA.digest()).toBe(storeB.digest());
    // The measurement is the signer's own: there's no way to say whose it is but by signing it.
    expect(storeA.lwwPrefix("calibration:").map((e) => e.device).sort()).toEqual([a.id, b.id].sort());
  });

  test("what a newer node measured beyond what this one knows is kept as written", () => {
    const { a, storeA } = fleet();
    storeA.emit(a, "compute.calibrated", { measured: { ...measured(15_600), gpuTps: 412, future: { anything: true } } });
    expect(storeA.lww<Record<string, unknown>>(`calibration:${a.id}`)?.value).toMatchObject({ gpuTps: 412, cpu: { multi: 15_600 } });
  });

  test("a revoked node's calibrations no longer count", () => {
    const { a, b, storeA, storeB } = fleet();
    revokeDevice(storeA, a, b.id, "gone");
    // It doesn't know yet, and writes on.
    storeB.emit(b, "compute.calibrated", { measured: measured(9_200) });
    syncInto(storeB, storeA);
    expect(storeA.lww(`calibration:${b.id}`)).toBeNull();
  });
});

describe("the owner's ceiling and policy", () => {
  test("a ceiling is for an active node, written by a full node; the latest stands; an empty one is the default again", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.emit(a, "compute.limit", { node: b.id, limit: { cores: 8, memoryGb: 24 } });
    storeB.ingest(storeA.eventsSince(storeB.frontier()).events);
    storeB.emit(b, "compute.limit", { node: b.id, limit: { cores: 12 } });
    syncInto(storeB, storeA);
    expect(storeA.lww(`compute-limit:${b.id}`)?.value).toEqual({ cores: 12 });
    storeA.emit(a, "compute.limit", { node: b.id, limit: {} });
    expect(storeA.lww(`compute-limit:${b.id}`)?.value).toEqual({});
    const stranger = newNodeIdentity();
    expect(() => storeA.emit(a, "compute.limit", { node: stranger.id, limit: { cores: 2 } })).toThrow(/active node/);
    const phone = `c_${"A".repeat(43)}`;
    expect(() => storeA.emit(a, "compute.limit", { node: phone, limit: { cores: 2 } })).toThrow(/active node/);
  });

  test("a ceiling for a node since revoked is refused", () => {
    const { a, b, storeA } = fleet();
    revokeDevice(storeA, a, b.id, "gone");
    expect(() => storeA.emit(a, "compute.limit", { node: b.id, limit: { cores: 8 } })).toThrow(/active node/);
  });

  test("the policy and the plan are last-writer-wins", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.emit(a, "compute.policy", { policy: { effort: 2, attemptsPerDay: 6 } });
    storeA.emit(a, "compute.adapted", { at: 1, digest: digest(1), plan: plan(4), changes: ["ultra carries 4 sandbox slots."] });
    syncInto(storeA, storeB);
    storeB.emit(b, "compute.policy", { policy: { effort: "auto" } });
    storeB.emit(b, "compute.adapted", { at: 2, digest: digest(2), plan: plan(5), changes: ["ultra: 4 → 5 sandbox slots."] });
    syncInto(storeB, storeA);
    expect(storeA.lww("compute-policy")?.value).toEqual({ effort: "auto" });
    expect(storeA.lww<{ digest: string }>("compute-plan")?.value?.digest).toBe(digest(2));
    expect(storeA.digest()).toBe(storeB.digest());
  });
});

describe("a trial run's effort", () => {
  test("recorded once per run: the first stands", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.emit(a, "trial.run", { run: "r-abc", suite: "engineering", settings: { effort: 3, parallel: 4 } });
    expect(() => storeA.emit(a, "trial.run", { run: "r-abc", suite: "engineering", settings: { effort: 1 } })).toThrow(/already recorded/);
    syncInto(storeA, storeB);
    expect(storeB.lww<{ settings: { effort: number } }>("trial-run:r-abc")?.value?.settings.effort).toBe(3);
    storeB.emit(b, "trial.run", { run: "r-def", suite: "engineering", settings: { effort: 2 } });
    expect(storeB.lwwPrefix("trial-run:")).toHaveLength(2);
  });
});

describe("convergence", () => {
  function busyFleet() {
    const { a, b, storeA, storeB } = fleet();
    const c = newNodeIdentity();
    enrollDevice(storeA, a, { device: c.id, name: "nuc", kind: "node", box: b64u(c.boxPublic) });
    const storeC = new MindStore(":memory:", new HlcClock(() => Date.now() + 45_000));
    storeC.expectFleet(storeA.fleet!);
    syncInto(storeA, storeC);
    syncInto(storeA, storeB);
    const nodes: [NodeIdentity, MindStore][] = [[a, storeA], [b, storeB], [c, storeC]];
    for (let i = 0; i < 8; i++) {
      for (const [id, store] of nodes) {
        store.emit(id, "compute.calibrated", { measured: measured(9_000 + 100 * i, i) });
        if (i % 2 === 0) store.emit(id, "compute.limit", { node: nodes[i % 3]![0].id, limit: { cores: 4 + i } });
        if (i % 3 === 0) store.emit(id, "compute.policy", { policy: { effort: ((i % 3) + 1) as 1 | 2 | 3, attemptsPerDay: i } });
        if (i % 4 === 1) store.emit(id, "compute.adapted", { at: i, digest: digest(i), plan: plan(i), changes: [`change ${i}`] });
        store.emit(id, "trial.run", { run: `r-${store === storeA ? "a" : store === storeB ? "b" : "c"}${i}`, suite: "engineering", settings: { effort: 1 + (i % 3) } });
        store.remember(id, `note ${i}`);
      }
    }
    // Two nodes record the same run: one of them stands, the same one everywhere.
    storeA.emit(a, "trial.run", { run: "r-same", suite: "engineering", settings: { effort: 3 } });
    storeB.emit(b, "trial.run", { run: "r-same", suite: "engineering", settings: { effort: 1 } });
    // A node is revoked while it's still measuring.
    revokeDevice(storeA, a, c.id, "retired");
    storeC.emit(c, "compute.calibrated", { measured: measured(1, 99) });
    const all = (store: MindStore): GEvent[] => store.eventsSince({}, 100_000).events;
    return { a, storeA, everything: [...all(storeA), ...all(storeB), ...all(storeC)] };
  }

  test("PROPERTY: any delivery order, with duplicates, yields the identical mind; a rebuild reproduces it", () => {
    const { storeA, everything } = busyFleet();
    let reference: string | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const random = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const order = shuffle([...everything, ...everything.slice(0, 12)], random);
      for (let i = 0; i < order.length; i += 1 + Math.floor(random() * 9)) replica.ingest(order.slice(i, i + 9));
      replica.ingest(order);
      reference ??= replica.digest();
      expect(replica.digest()).toBe(reference);
      if (seed === 1) {
        expect(replica.lww<{ settings: { effort: number } }>("trial-run:r-same")?.value).not.toBeNull();
        expect(replica.lwwPrefix("calibration:").length).toBeGreaterThan(0);
        replica.rebuild();
        expect(replica.digest()).toBe(reference);
      }
      replica.close();
    }
  }, 60_000);

  test("a node from before compute stores the events and ignores them (and a kind it will never know)", () => {
    const { a, storeA } = fleet();
    const future = signEvent({ v: 2, fleet: storeA.fleet!, hlc: storeA.clock.tick(), device: a.id, prev: storeA.head(a.id), kind: "compute.rented", body: { gpus: 8 } }, a);
    expect(storeA.ingest([future])).toMatchObject({ added: 1, invalid: [] });
    expect(storeA.rejection(future.id)).toBeNull();
    // Its chain goes on after the kind it didn't know.
    storeA.emit(a, "compute.calibrated", { measured: measured(15_600) });
    expect(storeA.lww(`calibration:${a.id}`)).not.toBeNull();
  });
});
