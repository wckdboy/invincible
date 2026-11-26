import { describe, expect, test } from "bun:test";
import { b64u, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, signEvent } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, revokeDevice, Vault } from "../src/index.ts";

/** Deterministic PRNG so property tests are reproducible. */
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

function allEvents(store: MindStore): GEvent[] {
  return store.eventsSince({}, 100_000).events;
}

/** Pull-based sync until the receiver has everything the sender has. */
function syncInto(from: MindStore, to: MindStore): void {
  for (;;) {
    const { events, more } = from.eventsSince(to.frontier(), 7);
    to.ingest(events);
    if (!more) return;
  }
}

function joinedReplica(founder: MindStore): MindStore {
  const replica = new MindStore(":memory:");
  replica.expectFleet(founder.fleet!);
  return replica;
}

interface Fleet {
  a: NodeIdentity;
  b: NodeIdentity;
  storeA: MindStore;
  storeB: MindStore;
}

function twoNodeFleet(): Fleet {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:");
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "laptop" });
  enrollDevice(storeA, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
  const storeB = joinedReplica(storeA);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

describe("one mind, many replicas", () => {
  test("a memory written on one node appears on the other after sync", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    storeB.remember(b, "wckdboy prefers main over master", { tags: ["git"] });
    storeA.remember(a, "the beefy server can run docker and VMs");
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.recall("master").map((m) => m.text)).toEqual(["wckdboy prefers main over master"]);
    expect(storeB.recall("docker")[0]?.text).toBe("the beefy server can run docker and VMs");
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("offline writes on both sides converge when they reconnect", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    for (let i = 0; i < 20; i++) storeA.remember(a, `laptop offline note ${i}`);
    for (let i = 0; i < 20; i++) storeB.remember(b, `server offline note ${i}`);
    storeA.emit(a, "roster.set", { role: "planner", models: ["anthropic/claude-opus-5-5"] });
    storeB.emit(b, "roster.set", { role: "planner", models: ["verda/kimi-k3.1-pro"] });
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.eventCount()).toBe(storeB.eventCount());
    expect(storeA.digest()).toBe(storeB.digest());
    // Last-writer-wins picks the same winner on both replicas.
    expect(storeA.lww("roster:planner")?.value).toEqual(storeB.lww("roster:planner")!.value);
  });

  test("PROPERTY: any delivery order, with duplicates, yields the identical mind", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    const c = newNodeIdentity();
    enrollDevice(storeA, a, { device: c.id, name: "desktop", kind: "node", box: b64u(c.boxPublic) });
    const storeC = joinedReplica(storeA);
    syncInto(storeA, storeC);
    syncInto(storeA, storeB);
    const vaultA = new Vault(storeA, a);
    vaultA.set("anthropic", "sk-ant-api03-example-key-0001", { provider: "anthropic" });
    for (let i = 0; i < 15; i++) {
      storeA.remember(a, `a${i}`);
      storeB.remember(b, `b${i}`);
      storeC.remember(c, `c${i}`);
      if (i % 5 === 0) storeB.emit(b, "provider.set", { id: "deepseek", kind: "openai", baseUrl: `https://api.deepseek.com/v${i}` });
    }
    const memoryA = storeA.recall(undefined, 1)[0]!;
    storeA.emit(a, "memory.forgotten", { memory: memoryA.id });

    const everything = [...allEvents(storeA), ...allEvents(storeB), ...allEvents(storeC)];
    let reference: string | null = null;
    for (let seed = 1; seed <= 12; seed++) {
      const random = rng(seed);
      const replica = joinedReplica(storeA);
      const order = shuffle([...everything, ...everything.slice(0, 10)], random);
      for (let i = 0; i < order.length; i += 1 + Math.floor(random() * 9)) replica.ingest(order.slice(i, i + 9));
      replica.ingest(order); // ensure nothing was skipped by the chunking
      reference ??= replica.digest();
      expect(replica.digest()).toBe(reference);
      replica.close();
    }
    // 12 replicas, each verifying every event's signature: a few seconds of real work, not a hang.
  }, 30_000);

  test("rebuilding from the log reproduces the exact same state", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    new Vault(storeA, a).set("orcarouter", "sk-orca-0123456789abcdef");
    storeB.remember(b, "galahad is courteous");
    syncInto(storeB, storeA);
    const before = storeA.digest();
    storeA.rebuild();
    expect(storeA.digest()).toBe(before);
  });
});

describe("authorization is part of the log's rules", () => {
  test("events from unknown signers are parked (capped, never relayed), not written to the mind (review #8)", () => {
    const { storeA } = twoNodeFleet();
    const stranger = newNodeIdentity();
    const replica = joinedReplica(storeA);
    syncInto(storeA, replica);
    const junk = Array.from({ length: 5 }, (_, i) =>
      signEvent(
        { v: 2, fleet: storeA.fleet!, hlc: new HlcClock().tick(), device: stranger.id, prev: null, kind: "memory.added", body: { text: `junk ${i}` } },
        stranger,
      ),
    );
    replica.ingest(junk);
    expect(replica.recall("junk")).toEqual([]);
    expect(replica.event(junk[0]!.id)).toBeNull();
    expect(replica.pendingCount()).toBe(5);
    // Nothing parked is ever offered to peers.
    expect(replica.eventsSince({}, 10_000).events.some((e) => e.device === stranger.id)).toBe(false);
  });

  test("a device enrolled later can write, and replicas agree regardless of arrival order", () => {
    const { a, storeA } = twoNodeFleet();
    const d = newNodeIdentity();
    enrollDevice(storeA, a, { device: d.id, name: "pi", kind: "node", box: b64u(d.boxPublic) });
    const storeD = joinedReplica(storeA);
    syncInto(storeA, storeD);
    storeD.remember(d, "the pi watches the greenhouse");

    const replica = joinedReplica(storeA);
    // Deliver D's memory before its enrollment: replay fixes it up.
    replica.ingest(allEvents(storeD).reverse());
    expect(replica.recall("greenhouse")[0]?.text).toBe("the pi watches the greenhouse");
    syncInto(storeD, storeA);
    expect(replica.digest()).toBe(storeA.digest());
  });

  test("clients cannot sign log events and revoked devices cannot write", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    revokeDevice(storeA, a, b.id, "lost laptop");
    syncInto(storeA, storeB);
    expect(() => storeB.remember(b, "after revocation")).toThrow(/not authorized/);
  });

  test("the last full node cannot be revoked", () => {
    const a = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, a, { fleetName: "solo", nodeName: "only" });
    expect(() => revokeDevice(store, a, a.id, "oops")).toThrow(/last full node/);
  });

  test("events from another fleet or with far-future clocks are refused", () => {
    const { storeA } = twoNodeFleet();
    const other = newNodeIdentity();
    const otherStore = new MindStore(":memory:");
    foundFleet(otherStore, other, { fleetName: "mordor", nodeName: "x" });
    expect(storeA.ingest(allEvents(otherStore)).invalid.length).toBeGreaterThan(0);
    const future = signEvent(
      {
        v: 1,
        fleet: storeA.fleet!,
        hlc: new HlcClock(() => Date.now() + 3_600_000).tick(),
        device: other.id,
        kind: "memory.added",
        body: { text: "from the future" },
      },
      other,
    );
    expect(storeA.ingest([future]).invalid[0]?.error).toMatch(/future/);
  });
});

describe("vault: add a key once, use it on every full node", () => {
  test("a secret set on the laptop decrypts on the server, never appears in plaintext in the log", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    const key = "sk-ant-api03-THIS-IS-A-TEST-KEY-123456";
    new Vault(storeA, a).set("anthropic", key, { provider: "anthropic" });
    syncInto(storeA, storeB);
    expect(new Vault(storeB, b).reveal("anthropic")).toBe(key);
    const log = JSON.stringify(allEvents(storeB));
    expect(log).not.toContain(key);
    expect(new Vault(storeB, b).info("anthropic")?.hint).toBe("…3456");
  });

  test("a node that joins later receives grants for keys already in use", () => {
    const { a, storeA } = twoNodeFleet();
    new Vault(storeA, a).set("deepseek", "sk-deepseek-0123456789");
    const late = newNodeIdentity();
    enrollDevice(storeA, a, { device: late.id, name: "gpu-box", kind: "node", box: b64u(late.boxPublic) });
    const storeLate = joinedReplica(storeA);
    syncInto(storeA, storeLate);
    expect(new Vault(storeLate, late).reveal("deepseek")).toBe("sk-deepseek-0123456789");
  });

  test("revocation rotates the vault: the revoked node cannot read secrets written afterwards", () => {
    const { a, b, storeA, storeB } = twoNodeFleet();
    const vaultA = new Vault(storeA, a);
    vaultA.set("abliteration", "abl-old-value-0000000");
    const { resealed } = revokeDevice(storeA, a, b.id, "server compromised");
    expect(resealed).toEqual(["abliteration"]);
    vaultA.set("verda", "verda-new-value-111111");
    syncInto(storeA, storeB);
    expect(() => new Vault(storeB, b).reveal("verda")).toThrow();
    expect(vaultA.reveal("verda")).toBe("verda-new-value-111111");
    expect(vaultA.reveal("abliteration")).toBe("abl-old-value-0000000");
  });

  test("a stranger who copies the whole log learns nothing", () => {
    const { a, storeA } = twoNodeFleet();
    new Vault(storeA, a).set("anthropic", "sk-ant-api03-zzzzzzzzzzzzzzzz");
    const spy = newNodeIdentity();
    const stolen = joinedReplica(storeA);
    syncInto(storeA, stolen);
    expect(() => new Vault(stolen, spy).reveal("anthropic")).toThrow();
  });
});
