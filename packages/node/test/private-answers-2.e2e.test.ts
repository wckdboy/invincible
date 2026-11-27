// What private-answers left a gap in (the re-review of 27 November, B2, B3, B4; its PoCs turned around): what was
// recorded before it, a private connector's call a standing order answers, and one removed. And the side doors a
// private run's words took after it: a loop once private, a run's web searches, a private loop's calls to connectors that
// aren't private, and what a private run kept. Against a real daemon (startDaemon) and its routes, with stand-ins for
// Google, for Home Assistant on its LAN address, for a notes service and for the search engine: only loopback reaches
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
/** A notes service that isn't private: what it answers holds what it was given. */
const NOTES = "https://notes.example.test";
const stand = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  // The search engine (search.ts SEARXNG) is answered here, never reached: no search leaves the test.
  if (url.origin === "http://127.0.0.1:8889") return Response.json({ results: [{ title: "A result", url: "https://example.test/a", content: "A page." }], suggestions: [] });
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fetch(input, init);
  const method = init?.method ?? "GET";
  if (url.origin === NOTES && method === "GET" && url.pathname === "/notes/1") return Response.json({ id: 1, text: "Ingrid Vestergaard wrote about the rent arrears" });
  if (url.origin === NOTES && method === "POST" && url.pathname === "/notes") return Response.json({ id: 2 });
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
  const notes = { id: "notes", label: "Notes", origin: NOTES, tools: { look: { description: "Read a note", method: "GET", path: "/notes/{id}", class: "read", params: { id: { type: "string", required: true } } }, post: { description: "Post a note", method: "POST", path: "/notes", class: "outward", params: { text: { type: "string", required: true } } } } };
  expect((await admin("setConnector", { id: "notes", manifest: notes })).status).toBe(200);
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

test("a loop once private stays private: set again without its mail, or removed, its runs' words still reach no agent", async () => {
  expect((await admin("setLoop", { name: "lease", schedule: "0 9 * * 1", task: { kind: "tell", text: "New mail came." }, wakes: [{ kind: "mail", connector: "gmail", query: "from:ingrid" }] })).status).toBe(200);
  const t = Date.now() - 86_400_000;
  daemon.store.emit(daemon.identity, "loop.ran", { loop: "lease", run: "wlease", slot: null, status: "ok", started: t, finished: t + 60_000, summary: "Woken by new Gmail mail from Ingrid Vestergaard <ingrid@example.test>: Quarterly rent arrears." });
  expect((await admin("setLoop", { name: "lease", wakes: [] })).status).toBe(200);
  expect(held(JSON.stringify((await send(agent, "loopRuns", { name: "lease" })).body))).toEqual([]);
  expect((await admin("removeLoop", { name: "lease" })).status).toBe(200);
  expect(held(JSON.stringify((await send(agent, "loopRuns", { name: "lease" })).body))).toEqual([]);
  expect(JSON.stringify((await admin("loopRuns", { name: "lease" })).body)).toContain("Quarterly rent arrears");
});

test("a web search carries the run that made it, as every line of a run does", async () => {
  const scout = (await admin("mintArm", { label: "scout", scopes: ["connect", "mind:read"] })).body.token;
  expect((await send(scout, "webSearch", { q: "quarterly reports" })).status).toBe(200);
  const line = ((await admin("ledger")).body.entries as { resource: string; run: string | null; target: string }[]).find((e) => e.resource === "search")!;
  expect([line.run, line.target]).toEqual(["arm.scout", "quarterly reports"]);
});

test("a private loop's calls to a connector that isn't private are written as a private one's, and an agent reads none of their words", async () => {
  const mail = [{ kind: "mail", connector: "gmail", query: "from:ingrid" }];
  // One it may make, a read: its line names the tool and says how it went, and so does the loop's run.
  expect((await admin("setLoop", { name: "mailread", schedule: "0 9 * * 1", task: { kind: "call", connector: "notes", tool: "look", args: { id: "1" } }, wakes: mail })).status).toBe(200);
  expect((await admin("runLoop", { name: "mailread" })).status).toBe(200);
  for (let n = 0; n < 300 && daemon.store.loopRuns("mailread").length === 0; n++) await Bun.sleep(10);
  expect(daemon.store.loopRuns("mailread")[0]!.body.summary).toMatch(/^notes\.look → ok \(200\), \d+ bytes \(\d+ ms\)$/);
  const line = daemon.store.ledger(100).find((e) => e.body.resource === "connector.notes" && e.body.run === "loop.mailread")!;
  expect([line.body.target, held(JSON.stringify(line.body))]).toEqual(["notes.look", []]);
  // One that asks you, a post: an agent reads that it waits, not what it would say or why.
  expect((await admin("setLoop", { name: "mailpost", schedule: "0 9 * * 1", task: { kind: "call", connector: "notes", tool: "post", args: { text: "Ingrid wrote about the rent arrears" } }, wakes: mail })).status).toBe(200);
  expect((await admin("runLoop", { name: "mailpost" })).status).toBe(200);
  for (let n = 0; n < 300 && daemon.store.loopRuns("mailpost").length === 0; n++) await Bun.sleep(10);
  const theirs = ((await send(agent, "actions")).body.actions as ActionView[]).find((a) => a.by === "loop:mailpost")!;
  expect([theirs.state, theirs.args, theirs.target, held(JSON.stringify(theirs))]).toEqual(["waiting", {}, "notes.post", []]);
  const yours = ((await admin("actions")).body.actions as ActionView[]).find((a) => a.by === "loop:mailpost")!;
  expect(yours.args).toEqual({ text: "Ingrid wrote about the rent arrears" });
});

test("what a private run kept is listed on your devices alone, and an agent is told it isn't there", async () => {
  // (A loop that runs on a node with sandboxes; its mail is what makes it private.)
  expect((await admin("setLoop", { name: "keeper", schedule: "0 9 * * 1", task: { kind: "tell", text: "New mail came." }, wakes: [{ kind: "mail", connector: "gmail", query: "from:ingrid" }] })).status).toBe(200);
  // As a loop's run keeps its /work/out (run-cli.ts closeWorkshop): recorded for its sandbox's run, arm.loop.<name>.
  const file = (path: string) => ({ path, size: 10, sha256: "0".repeat(64) });
  const kept = "art_PRIVATEPRIVATEPRIVATE0";
  daemon.store.emit(daemon.identity, "artifact.saved", { id: kept, label: "Ingrid Vestergaard: Quarterly rent arrears", run: "arm.loop.keeper", sandbox: "0123456789", bytes: 10, count: 1, files: [file("ingrid-rent-arrears.md")] });
  daemon.store.emit(daemon.identity, "artifact.saved", { id: "art_PLAINPLAINPLAINPLAIN00", label: "A report", run: "arm.coder", sandbox: "abcdef0123", bytes: 10, count: 1, files: [file("report.md")] });
  const theirs = (await send(agent, "artifacts")).body.artifacts as { id: string }[];
  expect([theirs.some((a) => a.id === kept), theirs.some((a) => a.id === "art_PLAINPLAINPLAINPLAIN00"), held(JSON.stringify(theirs))]).toEqual([false, true, []]);
  const unknown = await send(agent, "artifactFile", { id: "art_NOWHERENOWHERENOWHERE0", path: "a.md" });
  expect([unknown.status, (await send(agent, "artifactFile", { id: kept, path: "ingrid-rent-arrears.md" })).body]).toEqual([404, unknown.body]);
  // Yours: listed, and its file asked of the node that holds it (here none: the stand-in kept no files).
  expect(((await admin("artifacts")).body.artifacts as { id: string }[]).some((a) => a.id === kept)).toBe(true);
  expect((await admin("artifactFile", { id: kept, path: "ingrid-rent-arrears.md" })).status).toBe(421);
});
