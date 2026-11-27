import { expect, test } from "bun:test";
import { b64u, HlcClock, newNodeIdentity, OWNER_SCOPES, SIGNATURES_STRICT_FROM } from "@invincible/core";
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
