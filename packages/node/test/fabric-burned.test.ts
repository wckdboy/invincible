import { describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { b64u, type GEvent, newNodeIdentity, type Presence } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "@invincible/ledger";
import { Fabric } from "../src/fabric/service.ts";
import type { Sidecar } from "../src/fabric/sidecar.ts";
import { transportKeyOf } from "../src/home.ts";

/*
 * The keys revoked nodes ever held are read once per revocation, not on every rebuild of the door's map (the fabric
 * re-review, N4). The map of who holds each key is read again after any profile or device event, and each rebuild read
 * every profile every revoked node had ever signed, checking each one's proof: 16,000 profiles took 3.9 s, in the door,
 * on the next call after any node's routine profile. What is counted here is those reads, not time. Test keys only;
 * in-memory fleets; addresses from 192.0.2.0/24.
 */

async function fleetWith(profiles: number, lateSeed?: Uint8Array) {
  const founder = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  const fleet = foundFleet(store, founder, { fleetName: "f", nodeName: "founder" });
  const node = (name: string) => {
    const id = newNodeIdentity();
    enrollDevice(store, founder, { device: id.id, name, kind: "node", box: b64u(id.boxPublic) });
    return id;
  };
  const publish = (who: ReturnType<typeof newNodeIdentity>, seed: Uint8Array = randomBytes(32)) => {
    const key = transportKeyOf(seed, who.id);
    store.emit(who, "node.profile", { endpoint: "http://192.0.2.10:7400", caps: { qamp: { did: key.did, address: `qamp://${key.did}@192.0.2.10:7410`, pop: key.pop } } });
    return { key, seed };
  };
  const x = node("x");
  const held = Array.from({ length: profiles }, () => publish(x));
  // A profile x signs before it is revoked that reaches this node only after (a peer's sync): made on a copy.
  let late: GEvent | null = null;
  if (lateSeed) {
    const copy = new LedgerStore(":memory:");
    copy.expectFleet(fleet);
    copy.ingest(store.eventsSince({}, 10_000).events);
    const key = transportKeyOf(lateSeed, x.id);
    late = copy.emit(x, "node.profile", { endpoint: "http://192.0.2.10:7400", caps: { qamp: { did: key.did, address: `qamp://${key.did}@192.0.2.10:7410`, pop: key.pop } } });
    copy.close();
    await Bun.sleep(5);
  }
  revokeDevice(store, founder, x.id, "test: compromised");
  const fabric = new Fabric({ store, identity: founder, sidecar: { state: "off" } as unknown as Sidecar, log: () => {}, presence: async () => ({}) as Presence });
  return { founder, store, fabric, node, publish, x, held, late };
}

describe("the door's map of keys, with revoked nodes' keys in the ledger", () => {
  test("a routine profile doesn't read a revoked node's profiles again; a revocation does, and its keys stay nobody's", async () => {
    const f = await fleetWith(50);
    f.fabric.nodeOfKey(f.held[0]!.key.did);
    const reads = spyOn(f.store, "profilesOf");
    // Any node's routine profile resets the map; the next call through the door rebuilds it.
    for (let i = 0; i < 3; i++) {
      f.store.emit(f.founder, "node.profile", { endpoint: "http://192.0.2.11:7400", caps: { n: i } });
      f.fabric.nodeOfKey(f.held[0]!.key.did);
    }
    expect(reads).toHaveBeenCalledTimes(0);
    // A key x held, named by an active node with a proof of its own: still nobody's.
    const z = f.node("z");
    f.publish(z, f.held[1]!.seed);
    expect(f.fabric.nodeOfKey(f.held[1]!.key.did)).toBeNull();
    // Another node revoked: what it held is read once, and burned too.
    const y = f.node("y");
    const yKey = f.publish(y);
    expect(f.fabric.nodeOfKey(yKey.key.did)?.id).toBe(y.id);
    reads.mockClear();
    revokeDevice(f.store, f.founder, y.id, "test: lost");
    expect(f.fabric.nodeOfKey(yKey.key.did)).toBeNull();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    reads.mockRestore();
    f.fabric.close();
    f.store.close();
  });

  test("a profile a revoked node signed before its revocation, arriving late, burns its key too", async () => {
    const seed = randomBytes(32);
    const f = await fleetWith(1, seed);
    f.fabric.nodeOfKey(f.held[0]!.key.did);
    // The same key, named by an active node with its own proof, is that node's until x's older profile arrives.
    const z = f.node("z");
    const zKey = f.publish(z, seed);
    expect(f.fabric.nodeOfKey(zKey.key.did)?.id).toBe(z.id);
    f.store.ingest([f.late!]);
    expect(f.fabric.nodeOfKey(zKey.key.did)).toBeNull();
    f.fabric.close();
    f.store.close();
  });
});
