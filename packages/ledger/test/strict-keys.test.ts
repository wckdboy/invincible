import { describe, expect, test } from "bun:test";
import { b64u, newNodeIdentity, type NodeIdentity } from "@invincible/core";
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
