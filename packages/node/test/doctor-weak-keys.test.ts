import { expect, test } from "bun:test";
import { b64u, encodeHlc, eventId, type GEvent, HlcClock, newNodeIdentity, OWNER_SCOPES, SIGNATURES_STRICT_FROM, type UnsignedEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "@invincible/ledger";
import { weakNodeKeys } from "../src/doctor-facts.ts";

/*
 * The review of log-strict, F4: a node whose key fails Ed25519's strict rule, enrolled before the cutoff (by any node
 * before 27 November 2026, or by an older node since), is anyone's to sign as, stamping before the cutoff. The doctor
 * names each (mind.keys) until it is revoked, which pins its head.
 */

test("an enrolled node whose key fails the strict rule is named until it is revoked; a node whose key holds it never is", () => {
  const now = SIGNATURES_STRICT_FROM - 3_600_000;
  const founder = newNodeIdentity();
  const store = new LedgerStore(":memory:", new HlcClock(() => now));
  foundFleet(store, founder, { fleetName: "homelab", nodeName: "here" });
  const peer = newNodeIdentity();
  enrollDevice(store, founder, { device: peer.id, name: "rack", kind: "node", box: b64u(peer.boxPublic) });
  // As an older node's enrollDevice wrote one, before the cutoff: the identity's point, as a node's key.
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const weak = `n_${b64u(identity)}`;
  store.emit(founder, "device.enrolled", { device: weak, name: "old-pi", kind: "node", role: "full", box: b64u(new Uint8Array(32).fill(9)), scopes: OWNER_SCOPES });
  expect(weakNodeKeys(store)).toEqual([{ id: weak, name: "old-pi" }]);
  revokeDevice(store, founder, weak, "its key fails Ed25519's strict rule");
  expect(weakNodeKeys(store)).toEqual([]);
});

// The final re-check of the v2 stack, D1: whoever signs as a weak key can enroll what they like as it, stamping before
// the cutoff: a strong full node of their own, which signs as itself past the cutoff and enrolls more, or a client
// whose key fails the rule too. Revoking the weak node leaves those, so the doctor names them, however far down, and
// only once each is revoked says every key holds.
test("what was enrolled through a weak key, however far down, is named until each is revoked", () => {
  let now = SIGNATURES_STRICT_FROM - 3_600_000;
  const founder = newNodeIdentity();
  const store = new LedgerStore(":memory:", new HlcClock(() => now));
  const fleet = foundFleet(store, founder, { fleetName: "homelab", nodeName: "here" });
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const weak = `n_${b64u(identity)}`;
  const weakClient = `n_${b64u(new Uint8Array(32))}`; // the order-4 point y = 0
  store.emit(founder, "device.enrolled", { device: weak, name: "old-pi", kind: "node", role: "full", box: b64u(new Uint8Array(32).fill(9)), scopes: OWNER_SCOPES });
  // Signed as old-pi with no key at all (R the identity, S zero: ZIP-215 takes it for any message), before the cutoff.
  const universal = new Uint8Array(64);
  universal.set(identity, 0);
  const forge = (u: UnsignedEvent): GEvent => ({ ...u, id: eventId(u), sig: b64u(universal) }) as GEvent;
  const backup = newNodeIdentity();
  const t0 = SIGNATURES_STRICT_FROM - 600_000;
  const e1 = forge({ v: 2, fleet, hlc: encodeHlc({ ms: t0, counter: 0 }), device: weak, prev: null, kind: "device.enrolled", body: { device: backup.id, name: "backup", kind: "node", role: "full", box: b64u(backup.boxPublic), scopes: OWNER_SCOPES } });
  const e2 = forge({ v: 2, fleet, hlc: encodeHlc({ ms: t0 + 1, counter: 0 }), device: weak, prev: e1.id, kind: "device.enrolled", body: { device: weakClient, name: "phone", kind: "client", role: "client", scopes: OWNER_SCOPES } });
  now = t0 + 60_000;
  expect(store.ingest([e1, e2]).invalid).toEqual([]);
  expect([store.rejection(e1.id), store.rejection(e2.id)]).toEqual([null, null]);
  // The forger's own full node enrolls one more, as itself, past the cutoff.
  now = SIGNATURES_STRICT_FROM + 86_400_000;
  const desk = newNodeIdentity();
  const backupStore = new LedgerStore(":memory:", new HlcClock(() => now));
  backupStore.expectFleet(fleet);
  backupStore.ingest(store.eventsSince({}, 10_000).events);
  backupStore.emit(backup, "device.enrolled", { device: desk.id, name: "desk", kind: "node", role: "full", box: b64u(desk.boxPublic), scopes: OWNER_SCOPES });
  store.ingest(backupStore.eventsSince({}, 10_000).events);

  expect(weakNodeKeys(store)).toEqual([
    { id: weak, name: "old-pi" },
    { id: backup.id, name: "backup", through: "old-pi" },
    { id: weakClient, name: "phone" },
    { id: desk.id, name: "desk", through: "old-pi" },
  ]);
  revokeDevice(store, founder, weak, "its key fails Ed25519's strict rule");
  expect(weakNodeKeys(store).map((d) => d.name)).toEqual(["backup", "phone", "desk"]);
  for (const id of [backup.id, weakClient, desk.id]) revokeDevice(store, founder, id, "enrolled through a key that fails Ed25519's strict rule");
  expect(weakNodeKeys(store)).toEqual([]);
});
