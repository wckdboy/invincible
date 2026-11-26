import { describe, expect, test } from "bun:test";
import { b64u, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, revokeDevice } from "../src/index.ts";

/*
 * What model calls cost, in the log: your prices (the latest for each model stands)
 * and what a trial spent (once, beside its trial, by the node that ran it). Who may
 * write each, and that every replica agrees whatever order they arrive in.
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

/** Two nodes of one fleet. With `now`, both keep that time: a test that says which of two things came first sets it itself. */
function fleet(now?: () => number) {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "ultra" });
  enrollDevice(storeA, a, { device: b.id, name: "rack", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const trialId = (n: number) => `tr_${String(n).padStart(22, "0")}`;
const record = (run = "r-abc") => ({
  run,
  suite: "engineering",
  problem: "cantilever-beam",
  title: "Cantilever",
  domain: "structures",
  seed: 7,
  status: "scored" as const,
  score: 1,
  answers: [{ key: "f1_hz", units: "Hz", expected: 2, got: 2, tolerance: 0.1, ok: true }],
  models: ["stand-in/m"],
  version: "abc1234",
  seconds: 12,
});
const lines = (input: number) => ({ lines: [{ role: "engineer", model: "stand-in/m", calls: 3, unknown: 0, input, output: 120, cached: 0, reasoning: 0 }] });

describe("prices", () => {
  test("the latest price for a model stands on every replica; one that's removed is gone", () => {
    const { a, b, storeA, storeB } = fleet();
    storeA.emit(a, "price.set", { model: "deepseek/deepseek-v4-pro", price: { input: 0.5, output: 2 } });
    storeA.emit(a, "price.set", { model: "ollama/*", price: { input: 0, output: 0 } });
    syncInto(storeA, storeB);
    storeB.emit(b, "price.set", { model: "deepseek/deepseek-v4-pro", price: { input: 0.6, output: 2.4, cached: 0.1 } });
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) {
      expect(store.lww("price:deepseek/deepseek-v4-pro")?.value).toEqual({ input: 0.6, output: 2.4, cached: 0.1 });
      expect(store.lwwPrefix("price:").map((e) => e.key)).toEqual(["price:deepseek/deepseek-v4-pro", "price:ollama/*"]);
    }
    storeA.emit(a, "price.removed", { model: "ollama/*" });
    syncInto(storeA, storeB);
    expect(storeB.lwwPrefix("price:").map((e) => e.key)).toEqual(["price:deepseek/deepseek-v4-pro"]);
  });

  test("a price a newer node wrote with more in it is kept as written, never refused", () => {
    const { a, storeA, storeB } = fleet();
    storeA.emit(a, "price.set", { model: "x/y", price: { input: 1, output: 2, batch: 0.5, currency: "USD" } });
    syncInto(storeA, storeB);
    expect(storeB.lww("price:x/y")?.value).toEqual({ input: 1, output: 2, batch: 0.5, currency: "USD" });
  });
});

describe("what a model was seen to do", () => {
  test("the latest check of a model stands on every replica, whichever came first, and what a newer node added is kept", () => {
    // The time is the test's own, so which came first is said here and never left to how fast the machine is:
    // inside one millisecond two nodes' checks are ordered by their ids, and either order is a history they agree on.
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    storeA.emit(a, "model.checked", { model: "opencode-go/kimi-k3.1-pro", check: { at: 1, format: { replies: 25, good: 8 } } });
    now += 5;
    storeB.emit(b, "model.checked", { model: "opencode-go/kimi-k3.1-pro", check: { at: 2, format: { replies: 6, good: 2 }, reads: { ok: true, said: "x" }, latencyMs: 800 } });
    storeA.emit(a, "model.checked", { model: "opencode-go/gpt-6-luna", check: { at: 3, places: { targets: 8, landed: 8, meanErrorPx: 4 } } });
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) {
      expect(store.lww("modelcheck:opencode-go/kimi-k3.1-pro")?.value).toEqual({ at: 2, format: { replies: 6, good: 2 }, reads: { ok: true, said: "x" }, latencyMs: 800 });
      expect(store.lwwPrefix("modelcheck:").map((e) => e.key)).toEqual(["modelcheck:opencode-go/gpt-6-luna", "modelcheck:opencode-go/kimi-k3.1-pro"]);
    }
  });
});

describe("what a trial spent", () => {
  test("recorded once, beside its trial, by the node that ran it", () => {
    const { a, b, storeA, storeB } = fleet();
    // No trial yet: nothing to be beside.
    expect(() => storeA.emit(a, "trial.spent", { trial: trialId(1), spent: lines(900) })).toThrow(/no such trial/);
    storeA.emit(a, "trial.scored", { id: trialId(1), ...record() });
    storeA.emit(a, "trial.spent", { trial: trialId(1), spent: lines(900) });
    // The first stands.
    expect(() => storeA.emit(a, "trial.spent", { trial: trialId(1), spent: lines(5) })).toThrow(/already recorded/);
    syncInto(storeA, storeB);
    // Another node can't say what this node's trial cost.
    storeA.emit(a, "trial.scored", { id: trialId(2), ...record() });
    syncInto(storeA, storeB);
    expect(() => storeB.emit(b, "trial.spent", { trial: trialId(2), spent: lines(1) })).toThrow(/only the node that ran a trial/);
    expect(storeB.lww<{ lines: { input: number }[] }>(`trial-spent:${trialId(1)}`)?.value?.lines[0]?.input).toBe(900);
    expect(storeB.lww(`trial-spent:${trialId(2)}`)).toBeNull();
    // The trial itself is untouched by it: a node that doesn't know the kind still has the trial.
    expect(storeB.lww<{ score: number }>(`trial:${trialId(1)}`)?.value?.score).toBe(1);
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
    const nodes: [NodeIdentity, MindStore, string][] = [[a, storeA, "a"], [b, storeB, "b"], [c, storeC, "c"]];
    let n = 0;
    for (let i = 0; i < 6; i++) {
      for (const [id, store, name] of nodes) {
        // Every node prices the same models: the latest of each stands, the same one everywhere.
        store.emit(id, "price.set", { model: "deepseek/deepseek-v4-pro", price: { input: 0.5 + i / 10, output: 2 } });
        store.emit(id, "price.set", { model: `local-${name}/*`, price: { input: 0, output: 0 } });
        if (i % 3 === 2) store.emit(id, "price.removed", { model: `local-${name}/*` });
        const id1 = trialId(++n);
        store.emit(id, "trial.scored", { id: id1, ...record(`r-${name}${i}`) });
        if (i % 2 === 0) store.emit(id, "trial.spent", { trial: id1, spent: lines(1000 + n) });
        store.remember(id, `note ${i}`);
      }
    }
    // A node is revoked while its run is still being counted: what it had said by then stands, nothing after.
    syncInto(storeC, storeA);
    revokeDevice(storeA, a, c.id, "retired");
    const late = trialId(++n);
    storeC.emit(c, "trial.scored", { id: late, ...record("r-late") });
    storeC.emit(c, "trial.spent", { trial: late, spent: lines(1) });
    const all = (store: MindStore): GEvent[] => store.eventsSince({}, 100_000).events;
    return { storeA, everything: [...all(storeA), ...all(storeB), ...all(storeC)], late };
  }

  test("PROPERTY: any delivery order, with duplicates, yields the identical mind; a rebuild reproduces it", () => {
    const { storeA, everything, late } = busyFleet();
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
        expect(replica.lwwPrefix("trial-spent:")).toHaveLength(9);
        expect(replica.lww("price:deepseek/deepseek-v4-pro")?.value).not.toBeNull();
        // What a revoked node said after it was revoked counts for nothing, here as anywhere.
        expect(replica.lww(`trial-spent:${late}`)).toBeNull();
        replica.rebuild();
        expect(replica.digest()).toBe(reference);
      }
      replica.close();
    }
  });
});
