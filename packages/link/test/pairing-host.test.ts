import { describe, expect, test } from "bun:test";
import { b64u, decodeInvite, fromB64u, newNodeIdentity, pairProof } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { PairingHost } from "../src/pairing-host.ts";

/*
 * The lead's word of 27 November 2026: a node that asks to pair with a key failing Ed25519's strict rule (a small-order
 * or mixed-order point, or one written two ways) is refused there, before anyone can approve it: so such a key is never
 * enrolled, from today.
 */

describe("a node pairing in", () => {
  function host() {
    const store = new LedgerStore(":memory:");
    const identity = newNodeIdentity();
    foundFleet(store, identity, { fleetName: "homelab", nodeName: "here" });
    const pairing = new PairingHost(store, identity, "https://node.example.test");
    const made = pairing.createInvite("node");
    const invite = decodeInvite(made.invite);
    const ask = (device: string) => {
      const fields = { invite: invite.i, device, name: "joining", kind: "node" as const, box: b64u(new Uint8Array(32).fill(9)) };
      return pairing.request({ ...fields, proof: pairProof(fromB64u(invite.s), fields) });
    };
    return { ask };
  }

  test("with a key that fails the strict rule is refused, before anyone is asked to approve it", () => {
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    expect(() => host().ask(`n_${b64u(identityPoint)}`)).toThrow("that node's key isn't one a node may have: it fails Ed25519's strict rule");
    expect(host().ask(newNodeIdentity().id)).toMatchObject({ status: "pending" });
  });
});
