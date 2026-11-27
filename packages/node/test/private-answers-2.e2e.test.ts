// What private-answers left a gap in (the re-review of 27 November, B2; its PoC turned around): what was recorded
// before it. Against a real daemon (startDaemon) and its routes, with a stand-in for Google: only loopback reaches the
// network, and every other origin gets a stand-in's 404. Every name, address and message is made up; the keys are
// obviously fake.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientIdFromKey, type RouteName, routes, signRequest, utf8 } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "@invincible/ledger";
import { writeKeep } from "@invincible/models";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

const root = mkdtempSync(join(tmpdir(), "invincible-private-2-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "private-2", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
let daemon: Daemon;
let agent: string;
const stand = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fetch(input, init);
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") return Response.json({ access_token: "test-access-FAKE", expires_in: 3600, token_type: "Bearer" });
  return Response.json({ message: "not here" }, { status: 404 });
}) as unknown as typeof fetch;
const send = (token: string, name: RouteName, input?: unknown) =>
  fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: routes[name].method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const admin = (name: RouteName, input?: unknown) => send(home.adminToken(), name, input);
/** A client of yours with a chat bridge's scopes (TELEGRAM_SCOPES, SLACK_SCOPES): no fleet:admin. Its requests signed with its P-256 key. */
async function bridge(): Promise<(name: RouteName, input?: unknown) => Promise<{ status: number; body: any }>> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const device = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  enrollDevice(daemon.store, daemon.identity, { device, name: "Chat bridge", kind: "client", scopes: ["chat", "mind:read"] });
  return async (name, input) => {
    const r = routes[name];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(device, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    const res = await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "private" });
  store.close();
  home.writeConfig({ v: 1, name: "private", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, fetch: stand });
  expect((await admin("setConnector", { id: "gmail" })).status).toBe(200);
  expect((await admin("setSecret", { name: "gmail", value: writeKeep({ client: "client-id.apps.example.test", secret: "test-secret-FAKE", refresh: "test-refresh-FAKE", account: "you@example.test" }), provider: "gmail" })).status).toBe(200);
  agent = (await admin("mintArm", { label: "coder" })).body.token;
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Which of the mail's words a text holds. */
const WORDS = ["Ingrid", "Vestergaard", "ingrid@example.test", "rent arrears"];
const held = (text: string) => WORDS.filter((word) => text.includes(word));

test("B2: a loop's runs and its tell notice recorded before private-answers, with the mail's words, reach no agent and no chat bridge; you still read them", async () => {
  // (The owner's own words for a loop, its label and what it tells, are read as they are: the re-review's B5.)
  expect((await admin("setLoop", { name: "rent", schedule: "0 9 * * 1", task: { kind: "tell", text: "New mail came." }, wakes: [{ kind: "mail", connector: "gmail", query: "from:ingrid" }] })).status).toBe(200);
  // As 33a3d2f recorded a run that mail woke: "new Gmail mail from <who>: <subject>" first in its summary, and its
  // tell notice's body the same. One run failed: the "while you were away" lines name a failed run by its summary.
  const t = Date.now() - 86_400_000;
  const said = "Woken by new Gmail mail from Ingrid Vestergaard <ingrid@example.test>: Quarterly rent arrears. New mail came.";
  daemon.store.emit(daemon.identity, "loop.ran", { loop: "rent", run: "wold", slot: null, status: "ok", started: t, finished: t + 60_000, summary: said });
  daemon.store.emit(daemon.identity, "loop.ran", { loop: "rent", run: "wfailed", slot: null, status: "failed", started: t + 120_000, finished: t + 180_000, summary: said });
  daemon.store.emit(daemon.identity, "notice.raised", { key: "tell:rent:wold", severity: "info", title: "Loop rent", body: said, source: "tell:rent", at: t + 60_000 });
  for (const [name, input] of [["loopRuns", { name: "rent" }], ["loops"], ["notices"]] as [RouteName, unknown?][]) {
    const theirs = await send(agent, name, input);
    expect([name, theirs.status, held(JSON.stringify(theirs.body))]).toEqual([name, 200, []]);
  }
  // A chat bridge's client reads as an agent does, "while you were away" too: that the loop failed, not what it said.
  const chat = await bridge();
  for (const [name, input] of [["loopRuns", { name: "rent" }], ["loops"], ["notices"], ["away", { since: 0 }]] as [RouteName, unknown?][]) {
    const theirs = await chat(name, input);
    expect([name, theirs.status, held(JSON.stringify(theirs.body))]).toEqual([name, 200, []]);
  }
  expect(JSON.stringify((await chat("away", { since: 0 })).body)).toContain("The loop rent failed");
  // You read them as they were recorded: the log keeps what it was given.
  for (const [name, input] of [["loopRuns", { name: "rent" }], ["notices"], ["away", { since: 0 }]] as [RouteName, unknown?][]) {
    expect([name, JSON.stringify((await admin(name, input)).body).includes("Quarterly rent arrears")]).toEqual([name, true]);
  }
});
