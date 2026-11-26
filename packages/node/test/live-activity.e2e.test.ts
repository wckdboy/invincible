import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientIdFromKey, readActivityState, type RouteName, routes, type Scope, signRequest, utf8 } from "@invincible/core";
import { requestPairing, waitForApproval } from "@invincible/link";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A task's proof on the iPhone's Lock Screen, end to end (I10): a paired iPhone hands its node one of its Live
 * Activities' push tokens, and the node tells it how the task stands through a stand-in for Apple's push service (an
 * HTTP/2 server on loopback that keeps what it was sent), with the owner's Apple push key, made fresh here for the run.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "activity-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["docker"], localModels: [], tailscale: null };
const root = mkdtempSync(join(tmpdir(), "invincible-activity-"));
const home = new Home(join(root, "node"));
const port = freePort();
const TOKEN = "ef".repeat(80);
let daemon: Daemon;
let apple: ReturnType<typeof http2.createServer>;
let appleOrigin = "";
const pushed: { headers: http2.IncomingHttpHeaders; body: Record<string, any> }[] = [];

type Caller = (route: RouteName, input?: unknown) => Promise<Response>;
const withToken =
  (token: () => string): Caller =>
  (name, input) => {
    const route = routes[name];
    return fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  };
const admin = withToken(() => home.adminToken());
const json = async <T = any>(response: Promise<Response> | Response): Promise<T> => {
  const r = await response;
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`${r.status} ${body.error ?? ""}`);
  return body;
};

/** An iPhone paired with the node, signing as the app does, with the scopes given. */
async function pair(name: string, scopes: Scope[]): Promise<{ id: string; call: Caller }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = await json<{ invite: string }>(admin("createInvite", { kind: "client", scopes }));
  const joining = await requestPairing(invite, { device: id, name, kind: "client" });
  const { pairings } = await json<{ pairings: { invite: string; device: string }[] }>(admin("pairings"));
  const mine = pairings.find((p) => p.device === id)!;
  await json(admin("approvePairing", { invite: mine.invite, device: mine.device }));
  await waitForApproval(joining, { intervalMs: 20 });
  const call: Caller = async (route, input) => {
    const r = routes[route];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(id, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    return fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined });
  };
  return { id, call };
}

let phone: { id: string; call: Caller };
let task = "";

beforeAll(async () => {
  apple = http2.createServer();
  apple.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (text += chunk));
    stream.on("end", () => {
      pushed.push({ headers, body: JSON.parse(text) });
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  await new Promise<void>((resolve) => apple.listen(0, "127.0.0.1", () => resolve()));
  appleOrigin = `http://127.0.0.1:${(apple.address() as { port: number }).port}`;
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: () => {},
    docker: fakeDocker().runner,
    loopIntervalMs: 3_600_000,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
    shutdownGraceMs: 150,
    push: { tickMs: false, apple: { development: appleOrigin, production: appleOrigin } },
  });
  // The owner's Apple push key, made here for the run: never anyone's.
  const pair2 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair2.privateKey));
  const p8 = `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}\n${btoa(String.fromCharCode(...der))}\n${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}`;
  await json(admin("setApplePushKey", { key: p8, keyId: "KEY0000001", teamId: "TEAM000001", topic: "org.example.primary" }));
  phone = await pair("phone", ["mind:read", "chat", "fleet:admin"]);
  // Paused, so its task waits in the queue for as long as the test needs.
  await json(admin("saveAgent", { id: "builder", name: "Builder", role: "engineer", instructions: "Builds things, with tests.", enabled: false }));
  const room = (await json<{ room: { id: string } }>(admin("directAgent", { id: "builder" }))).room.id;
  task = (await json<{ task: { id: string } }>(admin("createTeamTask", { room, assignee: "builder", title: "Fix the importer", goal: "Make the importer read ISO dates, with a test.", dependsOn: [], gates: ["bun test importer"] }))).task.id;
});

afterAll(async () => {
  await daemon?.stop();
  apple.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a task's Live Activity, from the iPhone to Apple through its node", () => {
  test("only a paired device hands one over, for itself: never a terminal", async () => {
    const asTerminal = await admin("notifyActivity", { task, token: TOKEN, environment: "development" });
    expect(asTerminal.status).toBe(403);
    const refused = await phone.call("notifyActivity", { task, token: TOKEN, environment: "development", title: "Fix the importer" });
    expect(refused.status).toBe(400);
  });

  test("kept, it is told how its task stands: Apple's liveactivity push, on its own topic, fixed words and counts only", async () => {
    expect(await json(phone.call("notifyActivity", { task, token: TOKEN, environment: "development" }))).toEqual({ kept: true });
    await daemon.notify.lookAtActivities();
    expect(pushed).toHaveLength(1);
    const [push] = pushed;
    expect(push!.headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(push!.headers["apns-push-type"]).toBe("liveactivity");
    expect(push!.headers["apns-topic"]).toBe("org.example.primary.push-type.liveactivity");
    expect(push!.body.aps.event).toBe("update");
    const state = readActivityState(push!.body.aps["content-state"]);
    expect(state).toMatchObject({ phase: "queued", gates: ["waiting"], review: null, verdict: null, gate: null });
    // Nothing of the task's words: not its title, not its goal.
    expect(JSON.stringify(push!.body)).not.toMatch(/importer|ISO|Fix the/);
  });

  test("while its task doesn't move, nothing more is said; forgotten, nothing at all", async () => {
    await daemon.notify.lookAtActivities();
    expect(pushed).toHaveLength(1);
    expect(await json(phone.call("notifyActivity", { task, token: null, environment: "development" }))).toEqual({ kept: false });
    await daemon.notify.lookAtActivities();
    expect(pushed).toHaveLength(1);
  });
});
