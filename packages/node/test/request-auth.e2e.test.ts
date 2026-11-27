// A request's signature as a node checks it (the slice 8 note's item 11; the lead's word of 27 November). A node that
// restarts forgets the nonces it saw, so a request signed before it began is refused once it has: a request taken once
// isn't taken twice across a restart. Against a real daemon over real HTTP, on loopback, its client a P-256 key of this
// test's. Every name is made up; the keys are the test's own.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientIdFromKey, routes, signRequest } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "@invincible/ledger";
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
const signed = () => signRequest(device, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), routes.notices.method, routes.notices.path, new Uint8Array());
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
