// A request's signature as a node checks it (the slice 8 note's item 11; the lead's word of 27 November). A node that
// restarts forgets the nonces it saw, so a request signed before it began is refused once it has: a request taken once
// isn't taken twice across a restart. A request names the node it is for, so one for another node is refused; and a
// device learns which node it speaks to from whoami, proven, before it names it. Against a real daemon over real HTTP, on
// loopback, its client a P-256 key of this test's. Every name is made up; the keys are the test's own.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, clientIdFromKey, type DeviceId, newNodeIdentity, randomBytes, REQUESTS_READ, routes, signRequest, verifyNodeProof } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "@invincible/ledger";
import { provenNode } from "@invincible/link";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

const root = mkdtempSync(join(tmpdir(), "invincible-request-auth-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "request-auth", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
let daemon: Daemon;
let device: string;
let keys: CryptoKeyPair;
const start = () => startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
const sign = async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m as Uint8Array<ArrayBuffer>));
const signed = () => signRequest(device, sign, routes.notices.method, routes.notices.path, new Uint8Array());
/** Signed for the node `node` (v2): what it signs names it. */
const signedFor = (node: string) => signRequest(device, sign, routes.notices.method, routes.notices.path, new Uint8Array(), Date.now(), node as DeviceId);
const ask = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${routes.notices.path}`, { headers });

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "auth" });
  keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  device = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  enrollDevice(store, identity, { device, name: "A phone", kind: "client", scopes: ["mind:read"] });
  store.close();
  home.writeConfig({ v: 1, name: "auth", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await start();
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a request signed before the node began is refused once it has: a restart, which forgets its nonces, takes none twice", async () => {
  const before = await signed();
  expect((await ask(before)).status).toBe(200);
  expect((await ask(before)).status).toBe(401); // its nonce is spent
  await daemon.stop();
  daemon = await start();
  // Within the minute its time allows: signed before this node began, it may have been taken already.
  expect((await ask(before)).status).toBe(401);
  // One signed now is taken, once.
  const now = await signed();
  expect((await ask(now)).status).toBe(200);
  expect((await ask(now)).status).toBe(401);
});

test("a request names the node it is for: this node takes it, and refuses one signed for another", async () => {
  expect((await ask(await signedFor(daemon.identity.id))).status).toBe(200);
  // One for another node of the fleet, sent here (as a node it went to would relay it): refused.
  expect((await ask(await signedFor(newNodeIdentity().id))).status).toBe(401);
});

test("asked with a challenge, whoami proves which node answers: a device verifies it against the id it says", async () => {
  const challenge = b64u(randomBytes(24));
  const path = `${routes.whoami.path}?challenge=${challenge}`;
  // (Whoami's is taken as v1, always: a device asks it to learn which node it speaks to, before it can name it.)
  const said = (await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: await signRequest(device, sign, "GET", path, new Uint8Array()) })).json()) as { node: string; proof?: string; device: string };
  expect([said.device, said.node, verifyNodeProof(said.node, challenge, said.proof ?? "")]).toEqual([device, daemon.identity.id, true]);
  // Without a challenge, it says what it said before, and nothing more.
  const plain = (await (await fetch(`http://127.0.0.1:${port}${routes.whoami.path}`, { headers: await signRequest(device, sign, "GET", routes.whoami.path, new Uint8Array()) })).json()) as { proof?: string };
  expect(plain.proof).toBeUndefined();
});

test("a node that knows a peer only by its address learns, proven, which node answers there, and is never told another", async () => {
  const joining = newNodeIdentity();
  enrollDevice(daemon.store, daemon.identity, { device: joining.id, name: "joining", kind: "node", box: b64u(joining.boxPublic) });
  expect(await provenNode(joining, `http://127.0.0.1:${port}`)).toBe(daemon.identity.id);
  // This node says, in its profile, that it reads requests that name it: so its peers name it.
  expect((daemon.store.device(daemon.identity.id)?.profile?.caps as { requests?: number }).requests).toBe(REQUESTS_READ);
  // An older node, whose whoami offers no proof: it is asked as before (it reads that alone), not refused.
  const older = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ node: newNodeIdentity().id }) });
  try {
    expect(await provenNode(joining, `http://127.0.0.1:${older.port}`)).toBeNull();
  } finally {
    older.stop(true);
  }
  // A node that says it is another: its proof proves nothing.
  const other = newNodeIdentity();
  const liar = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.json({ node: other.id, proof: b64u(daemon.identity.sign(new TextEncoder().encode(new URL(req.url).search) as Uint8Array<ArrayBuffer>)) }) });
  try {
    await expect(provenNode(joining, `http://127.0.0.1:${liar.port}`)).rejects.toThrow("didn't prove which node it is");
  } finally {
    liar.stop(true);
  }
});
