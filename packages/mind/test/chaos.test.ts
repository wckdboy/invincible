import { describe, expect, test } from "bun:test";
import { b64u, HlcClock, newNodeIdentity, type NodeIdentity } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, revokeDevice, Vault } from "../src/index.ts";

/*
 * Chaos for the mind. Five nodes with skewed clocks gossip through a hostile
 * network: random partitions, duplicated and reordered deliveries, arbitrary page
 * sizes, crashes (rebuild from the log), and a node revoked while it is cut off
 * and still writing. After the network heals, every replica must hold the
 * identical state, and rebuilding any of them must reproduce it exactly.
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

interface Node {
  name: string;
  identity: NodeIdentity;
  store: MindStore;
  vault: Vault;
  clockOffsetMs: number;
}

function makeNode(name: string, fleet: string | null, offsetMs: number, identity = newNodeIdentity()): Node {
  const store = new MindStore(":memory:", new HlcClock(() => Date.now() + offsetMs));
  if (fleet) store.expectFleet(fleet);
  return { name, identity, store, vault: new Vault(store, identity), clockOffsetMs: offsetMs };
}

/** One pull, possibly paged, possibly duplicated, possibly shuffled. */
function pull(from: Node, to: Node, random: () => number): void {
  const page = 1 + Math.floor(random() * 12);
  for (let guard = 0; guard < 10_000; guard++) {
    const { events, more } = from.store.eventsSince(to.store.frontier(), page);
    const batch = random() < 0.3 ? [...events].reverse() : events;
    to.store.ingest(batch);
    if (random() < 0.2) to.store.ingest(batch); // duplicate delivery
    if (!more) return;
  }
}

function runChaos(seed: number) {
  const random = rng(seed);
  const offsets = [0, 90_000, -120_000, 45_000, -30_000]; // within the 5-minute drift bound
  const founder = makeNode("n0", null, offsets[0]!);
  const fleet = foundFleet(founder.store, founder.identity, { fleetName: "camelot", nodeName: "n0" });
  const nodes: Node[] = [founder];
  for (let i = 1; i < 5; i++) {
    const node = makeNode(`n${i}`, fleet, offsets[i]!);
    enrollDevice(founder.store, founder.identity, { device: node.identity.id, name: node.name, kind: "node", box: b64u(node.identity.boxPublic) });
    nodes.push(node);
  }
  for (const node of nodes.slice(1)) pull(founder, node, random);
  founder.vault.set("deepseek", "sk-chaos-initial-0000000000");

  const victim = nodes[4]!;
  let partition: Set<string> | null = null;
  let revoked = false;

  for (let tick = 0; tick < 160; tick++) {
    // The network: partitions come and go.
    if (tick === 40) partition = new Set(["n3", "n4"]); // n4 is cut off with n3
    if (tick === 110) partition = null; // heal
    if (tick > 40 && tick < 110 && random() < 0.05) partition = partition ? null : new Set(["n2", "n4"]);
    if (tick >= 100 && tick < 110) partition = new Set(["n4"]); // ensure the victim misses the revocation for a while

    // While n4 is cut off, the founder revokes it and rotates the vault.
    if (tick === 60 && !revoked && (!partition || !partition.has("n0") === partition.has("n4"))) {
      revokeDevice(founder.store, founder.identity, victim.identity.id, "lost in the partition");
      founder.vault.set("orcarouter", "sk-orca-after-revocation-1234");
      revoked = true;
    }

    // Everyone works. Writes are concurrent, out of sync, on skewed clocks.
    for (const node of nodes) {
      if (random() < 0.5) {
        const roll = random();
        try {
          if (roll < 0.45) node.store.remember(node.identity, `${node.name} note ${tick}`, { tags: [`t${tick % 7}`] });
          else if (roll < 0.6) node.store.emit(node.identity, "roster.set", { role: "planner", models: [`p/${node.name}-${tick}`] });
          else if (roll < 0.7) node.store.emit(node.identity, "provider.set", { id: "deepseek", kind: "openai", baseUrl: `https://x.test/${node.name}/${tick}` });
          else if (roll < 0.8) {
            const memory = node.store.recall(undefined, 30)[Math.floor(random() * 30)];
            if (memory) node.store.emit(node.identity, "memory.forgotten", { memory: memory.id });
          } else if (roll < 0.88) node.vault.set(`k${tick % 3}`, `sk-chaos-${node.name}-${tick}-abcdef`);
          else node.store.rebuild(); // crash + restart from the log
        } catch {
          // A revoked node (once it knows), or a node without a vault grant, is refused. That's expected.
        }
      }
    }

    // Gossip: random pulls that respect the partition.
    for (let k = 0; k < 4; k++) {
      const a = nodes[Math.floor(random() * nodes.length)]!;
      const b = nodes[Math.floor(random() * nodes.length)]!;
      if (a === b) continue;
      if (partition && partition.has(a.name) !== partition.has(b.name)) continue;
      pull(a, b, random);
    }
  }

  // Heal completely and gossip until quiescent.
  for (let round = 0; round < 6; round++) for (const a of nodes) for (const b of nodes) if (a !== b) pull(a, b, random);
  return { nodes, founder, victim };
}

describe("chaos: the mind under a hostile network", () => {
  for (const seed of [1, 7, 42, 1337, 9001]) {
    test(`seed ${seed}: every replica converges to the identical state`, () => {
      const { nodes, founder, victim } = runChaos(seed);
      const digests = new Set(nodes.map((n) => n.store.digest()));
      expect(digests.size).toBe(1);
      expect(new Set(nodes.map((n) => n.store.eventCount())).size).toBe(1);

      // A restart from the log reproduces the same mind on every node.
      const [reference] = digests;
      for (const node of nodes) {
        node.store.rebuild();
        expect(node.store.digest()).toBe(reference!);
      }

      // The revoked node is out everywhere, and cannot write any more.
      for (const node of nodes) expect(node.store.activeDevice(victim.identity.id)).toBeNull();
      expect(() => victim.store.remember(victim.identity, "after the heal")).toThrow(/not authorized/);

      // The vault was rotated without it: remaining full nodes read the new secret, the victim can't.
      for (const node of nodes) {
        if (node === victim) continue;
        expect(node.vault.reveal("orcarouter")).toBe("sk-orca-after-revocation-1234");
      }
      expect(() => victim.vault.reveal("orcarouter")).toThrow();
      expect(founder.vault.reveal("deepseek")).toBe("sk-chaos-initial-0000000000");
    }, 60_000); // full replays under heavy churn are the known slow path
  }
});
