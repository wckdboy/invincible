import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_DEFAULT_SCOPES, clientIdFromKey, LIVE_TOPICS, type LiveEvent, type LiveTopic, newNodeIdentity, type RouteName, routes, type Scope, signRequest, utf8 } from "@galahad/core";
import { requestPairing, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Your devices' live stream over real HTTP (GET /api/live; core's live.ts): signed as every request is, it tells a
 * device which of what it may read changed, as it changes, and the device reads that through its own route. Before it,
 * a device learned of a change at its next poll, 3 to 15 seconds later (the web app's live.ts, until 25 November 2026);
 * here a change reaches a listening device's page in about one round trip: the stream says so as it is written, and
 * the device's one read shows it.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "live-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [],
  tailscale: null,
};

const root = mkdtempSync(join(tmpdir(), "galahad-live-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

const admin = async <T = any>(name: RouteName, input?: unknown): Promise<T> => {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

interface Heard {
  at: number;
  event: LiveEvent;
}

/** A live stream as a device reads it: what came, when, and whether it ended. */
interface Listening {
  status: number;
  heard: Heard[];
  /** The first event from now on (or already heard after `since`) that matches, within `ms`. */
  next(match: (event: LiveEvent) => boolean, since?: number, ms?: number): Promise<Heard>;
  ended: Promise<void>;
  close(): void;
}

/** A browser paired with the node, holding the scopes given: its signed reads, and its live stream. */
async function pair(name: string, scopes: Scope[]) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const device = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = await admin<{ invite: string }>("createInvite", { kind: "client", scopes });
  const joining = await requestPairing(invite, { device, name, kind: "client" });
  const { pairings } = await admin<{ pairings: { invite: string; device: string }[] }>("pairings");
  const mine = pairings.find((p) => p.device === device)!;
  await admin("approvePairing", { invite: mine.invite, device: mine.device });
  await waitForApproval(joining, { intervalMs: 20 });
  const signer: Parameters<typeof signRequest>[1] = async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m));
  const read = async <T = any>(route: RouteName): Promise<{ status: number; body: T }> => {
    const r = routes[route];
    const headers = await signRequest(device, signer, r.method, r.path, new Uint8Array());
    const response = await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
  };
  const listen = async (): Promise<Listening> => {
    const headers = await signRequest(device, signer, "GET", routes.live.path, new Uint8Array());
    return listenWith(headers);
  };
  return { device, read, listen };
}

async function listenWith(headers: Record<string, string>): Promise<Listening> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${routes.live.path}`, { headers, signal: controller.signal });
  const heard: Heard[] = [];
  const waiting = new Set<() => void>();
  let done!: () => void;
  const ended = new Promise<void>((resolve) => (done = resolve));
  if (response.ok && response.body) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const line of block.split("\n")) if (line.startsWith("data:")) heard.push({ at: performance.now(), event: JSON.parse(line.slice(5)) as LiveEvent });
            for (const wake of [...waiting]) wake();
          }
        }
      } catch {
        /* closed by the test */
      }
      done();
      for (const wake of [...waiting]) wake();
    })();
  } else {
    await response.body?.cancel();
    done();
  }
  let ending = false;
  void ended.then(() => (ending = true));
  return {
    status: response.status,
    heard,
    ended,
    close: () => controller.abort(),
    next: (match, since = performance.now(), ms = 5_000) =>
      new Promise<Heard>((resolve, reject) => {
        const look = () => {
          const found = heard.find((h) => h.at >= since && match(h.event));
          if (found) {
            clearTimeout(timer);
            waiting.delete(look);
            resolve(found);
          } else if (ending) {
            clearTimeout(timer);
            waiting.delete(look);
            reject(new Error(`the stream ended without it: ${JSON.stringify(heard.map((h) => h.event))}`));
          }
        };
        const timer = setTimeout(() => {
          waiting.delete(look);
          reject(new Error(`not heard within ${ms} ms: ${JSON.stringify(heard.map((h) => h.event))}`));
        }, ms);
        waiting.add(look);
        look();
      }),
  };
}

const told = (topic: LiveTopic) => (event: LiveEvent) => event.type === "changed" && event.topics.includes(topic);
const said = (event: LiveEvent): string[] => (event.type === "hello" || event.type === "changed" ? [...event.topics] : [event.reason]);
const MIND_READ_TOPICS = LIVE_TOPICS.filter((topic) => routes[topic].scope === "mind:read");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 3_600_000, defaultHeartbeat: false, archiveIntervalMs: false, backups: false, shutdownGraceMs: 100 });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("your devices' live stream", () => {
  test("it opens with the topics this device may read, each by its route's own scope, and nothing it may not", async () => {
    const phone = await pair("phone", CLIENT_DEFAULT_SCOPES);
    const reader = await pair("reader", ["mind:read"]);
    const full = await phone.listen();
    const narrow = await reader.listen();
    expect([full.status, narrow.status]).toEqual([200, 200]);
    expect(said((await full.next((e) => e.type === "hello", 0)).event).sort()).toEqual([...LIVE_TOPICS].sort());
    expect(said((await narrow.next((e) => e.type === "hello", 0)).event).sort()).toEqual([...MIND_READ_TOPICS].sort());
    full.close();
    narrow.close();
  });

  test("a key he asks for reaches a listening device in about one round trip: told as it is written, shown by the one read after", async () => {
    const phone = await pair("phone-2", CLIENT_DEFAULT_SCOPES);
    const reader = await pair("reader-2", ["mind:read"]);
    const live = await phone.listen();
    const narrow = await reader.listen();
    await live.next((e) => e.type === "hello", 0);
    await narrow.next((e) => e.type === "hello", 0);
    const wrote = performance.now();
    await admin("requestSecret", { name: "github-token", purpose: "To open the pull request for the sync fix." });
    const heard = await live.next(told("secretRequests"), 0);
    const { body } = await phone.read<{ requests: { name: string }[] }>("secretRequests");
    const shown = performance.now();
    expect(body.requests.map((r) => r.name)).toContain("github-token");
    // Told within a second of the write (a poll found it 3 to 15 s later), and shown one read after that.
    expect(heard.at - wrote).toBeLessThan(1_000);
    expect(shown - wrote).toBeLessThan(1_000);
    // A device that may not read the vault's requests is never told of them.
    await Bun.sleep(100);
    expect(narrow.heard.some((h) => h.event.type === "changed" && h.event.topics.includes("secretRequests"))).toBe(false);
    live.close();
    narrow.close();
  });

  test("a device asking to join is told at once to a device that may let it in, and to no other", async () => {
    const phone = await pair("phone-3", CLIENT_DEFAULT_SCOPES);
    const reader = await pair("reader-3", ["mind:read"]);
    const live = await phone.listen();
    const narrow = await reader.listen();
    await live.next((e) => e.type === "hello", 0);
    await narrow.next((e) => e.type === "hello", 0);
    const { invite } = await admin<{ invite: string }>("createInvite", { kind: "client" });
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const asked = performance.now();
    await requestPairing(invite, { device: clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))), name: "tablet", kind: "client" });
    const heard = await live.next(told("pairings"), 0);
    expect(heard.at - asked).toBeLessThan(1_000);
    expect((await phone.read<{ pairings: { name: string }[] }>("pairings")).body.pairings.map((p) => p.name)).toContain("tablet");
    await Bun.sleep(100);
    expect(narrow.heard.some((h) => said(h.event).includes("pairings"))).toBe(false);
    live.close();
    narrow.close();
  });

  test("what the node writes by itself, with no request (a chat kept, his turn's end), is told within a look", async () => {
    const phone = await pair("phone-4", CLIENT_DEFAULT_SCOPES);
    const live = await phone.listen();
    await live.next((e) => e.type === "hello", 0);
    const wrote = performance.now();
    daemon.chats.create({ title: "Release notes", project: null, role: "planner" });
    const heard = await live.next(told("turns"), 0);
    expect(heard.at - wrote).toBeLessThan(1_000);
    live.close();
  });

  test("nothing at rest: a stream with nothing to tell says nothing but its beats", async () => {
    const phone = await pair("phone-5", CLIENT_DEFAULT_SCOPES);
    const live = await phone.listen();
    await live.next((e) => e.type === "hello", 0);
    await Bun.sleep(1_200);
    expect(live.heard.map((h) => h.event.type)).toEqual(["hello"]);
    live.close();
  });

  test("an agent, another node or an unsigned request can't open it", async () => {
    const { token } = await admin<{ token: string }>("mintArm", { label: "live-arm" });
    const arm = await fetch(`http://127.0.0.1:${port}${routes.live.path}`, { headers: { authorization: `Bearer ${token}` } });
    expect(arm.status).toBe(403);
    await arm.body?.cancel();
    const node = newNodeIdentity();
    const forged = await signRequest(node.id, async (m) => node.sign(m), "GET", routes.live.path, utf8(""));
    const stranger = await fetch(`http://127.0.0.1:${port}${routes.live.path}`, { headers: forged });
    expect(stranger.status).toBe(401);
    await stranger.body?.cancel();
    const unsigned = await fetch(`http://127.0.0.1:${port}${routes.live.path}`);
    expect(unsigned.status).toBe(401);
    await unsigned.body?.cancel();
  });

  test("revoked, the device's stream ends at once, and opening it again is refused", async () => {
    const lost = await pair("lost-phone", CLIENT_DEFAULT_SCOPES);
    const live = await lost.listen();
    await live.next((e) => e.type === "hello", 0);
    await admin("revokeDevice", { device: lost.device, reason: "left on a train" });
    expect((await live.next((e) => e.type === "bye", 0)).event).toEqual({ type: "bye", reason: "revoked" });
    await live.ended;
    expect((await lost.listen()).status).toBe(401);
  });

  test("its scopes changed, it ends; opened again, it tells of what the device may read now", async () => {
    const phone = await pair("phone-6", CLIENT_DEFAULT_SCOPES);
    const live = await phone.listen();
    await live.next((e) => e.type === "hello", 0);
    await admin("setDeviceScopes", { device: phone.device, scopes: ["mind:read"] });
    expect((await live.next((e) => e.type === "bye", 0)).event).toEqual({ type: "bye", reason: "rescoped" });
    await live.ended;
    const again = await phone.listen();
    expect(said((await again.next((e) => e.type === "hello", 0)).event).sort()).toEqual([...MIND_READ_TOPICS].sort());
    again.close();
  });

  test("a device with too many open closes its oldest", async () => {
    const phone = await pair("phone-7", CLIENT_DEFAULT_SCOPES);
    const streams: Listening[] = [];
    for (let i = 0; i < 9; i++) {
      const live = await phone.listen();
      await live.next((e) => e.type === "hello", 0);
      streams.push(live);
    }
    expect((await streams[0]!.next((e) => e.type === "bye", 0)).event).toEqual({ type: "bye", reason: "replaced" });
    expect(streams.slice(1).every((s) => !s.heard.some((h) => h.event.type === "bye"))).toBe(true);
    for (const s of streams) s.close();
  });

  test("the node stopping ends every stream with a word, so a device opens it again when it is back", async () => {
    const phone = await pair("phone-8", CLIENT_DEFAULT_SCOPES);
    const live = await phone.listen();
    await live.next((e) => e.type === "hello", 0);
    const stopped = daemon.stop();
    expect((await live.next((e) => e.type === "bye", 0)).event).toEqual({ type: "bye", reason: "stopping" });
    await live.ended;
    await stopped;
    daemon = undefined as unknown as Daemon;
  });
});
