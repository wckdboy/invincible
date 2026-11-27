// What private-answers left a gap in (the re-review of 27 November, B2, B3, B4; its PoCs turned around): what was
// recorded before it, a private connector's call a standing order answers, and one removed. Against a real daemon
// (startDaemon) and its routes, with stand-ins for Google and for Home Assistant on its LAN address: only loopback reaches
// the network, and every other origin gets a stand-in's 404. Every name, address and message is made up; the keys are
// obviously fake.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActionView, clientIdFromKey, type RouteName, routes, signRequest, utf8 } from "@invincible/core";
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
const HA = "http://homeassistant.local:8123";
/** Home Assistant's REST answer to a service call: the states that changed while it ran (its documented answer). */
const changed = [
  { entity_id: "lock.front_door", state: "unlocked", attributes: { friendly_name: "Front door" }, last_changed: "2026-11-27T17:00:01+00:00" },
  { entity_id: "alarm_control_panel.home", state: "disarmed", attributes: { friendly_name: "Home alarm" }, last_changed: "2026-11-27T17:00:01+00:00" },
];
const stand = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fetch(input, init);
  const method = init?.method ?? "GET";
  if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") return Response.json({ access_token: "test-access-FAKE", expires_in: 3600, token_type: "Bearer" });
  if (url.origin === HA && method === "POST" && url.pathname === "/api/services/scene/turn_on") return Response.json(changed);
  if (url.origin === HA && method === "GET" && url.pathname === "/api/states") return Response.json(changed);
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
const primary = { kind: "agent" as const, by: "primary" };

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "private" });
  store.close();
  home.writeConfig({ v: 1, name: "private", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, fetch: stand });
  expect((await admin("setConnector", { id: "gmail" })).status).toBe(200);
  expect((await admin("setSecret", { name: "gmail", value: writeKeep({ client: "client-id.apps.example.test", secret: "test-secret-FAKE", refresh: "test-refresh-FAKE", account: "you@example.test" }), provider: "gmail" })).status).toBe(200);
  expect((await admin("setConnector", { id: "home-assistant", origin: HA })).status).toBe(200);
  expect((await admin("setSecret", { name: "home-assistant", value: "test-ha-token-FAKE", connector: "home-assistant" })).status).toBe(200);
  agent = (await admin("mintArm", { label: "coder" })).body.token;
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Which of the mail's and the home's words a text holds. */
const WORDS = ["Ingrid", "Vestergaard", "ingrid@example.test", "rent arrears", "lock.front_door", "unlocked", "alarm_control_panel", "disarmed", "lars@example.test", "18,400", "pay the"];
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

test("B3: a private connector's call that a standing order answers keeps its mark: the chat's gate holds, and a loop records no word of it", async () => {
  const scene = { domain: "scene", service: "turn_on", entity_id: "scene.evening" };
  expect((await admin("setOrder", { connector: "home-assistant", tool: "service", args: scene, label: "The evening scene" })).status).toBe(200);
  const ordered = await daemon.connectors.call({ connector: "home-assistant", tool: "service", args: scene }, primary);
  expect(ordered.status === "done" && [ordered.order?.label, ordered.private]).toEqual(["The evening scene", true]);
  // A loop that runs the scene every evening, under the order: its record says how it went, never what came back.
  expect((await admin("setLoop", { name: "evening", schedule: "0 17 * * *", task: { kind: "call", connector: "home-assistant", tool: "service", args: scene } })).status).toBe(200);
  expect((await admin("runLoop", { name: "evening" })).status).toBe(200);
  for (let n = 0; n < 300 && daemon.store.loopRuns("evening").length === 0; n++) await Bun.sleep(10);
  const summary = daemon.store.loopRuns("evening")[0]!.body.summary;
  expect(summary).toMatch(/^home-assistant\.service → ok \(200\), \d+ bytes \(\d+ ms\)$/);
  expect(held(JSON.stringify((await send(agent, "loopRuns", { name: "evening" })).body))).toEqual([]);
});

test("B4: a private connector installed under its own id stays private once it is removed: its waiting call's words reach no agent", async () => {
  const manifest = { id: "family-mail", label: "Family mail", origin: "https://mail.example.test", private: true, tools: { send: { description: "Send a mail", method: "POST", path: "/send", class: "outward", params: { to: { type: "string", required: true }, body: { type: "string", required: true } } } } };
  expect((await admin("setConnector", { id: "family-mail", manifest })).status).toBe(200);
  const asked = await daemon.connectors.call({ connector: "family-mail", tool: "send", args: { to: "lars@example.test", body: "I will pay the 18,400 on Thursday." }, why: "Ingrid asked about the rent arrears" }, primary);
  expect(asked.status).toBe("asked");
  for (const removed of [false, true]) {
    if (removed) expect((await admin("removeConnector", { id: "family-mail" })).status).toBe(200);
    const theirs = ((await send(agent, "actions")).body.actions as ActionView[]).find((a) => a.connector === "family-mail")!;
    expect([removed, theirs.state, theirs.args, held(JSON.stringify(theirs))]).toEqual([removed, "waiting", {}, []]);
  }
  // Yours, on your devices, as it is.
  const yours = ((await admin("actions")).body.actions as ActionView[]).find((a) => a.connector === "family-mail")!;
  expect(yours.args).toEqual({ to: "lars@example.test", body: "I will pay the 18,400 on Thursday." });
});
