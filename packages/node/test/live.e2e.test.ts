import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_DEFAULT_SCOPES, clientIdFromKey, LIVE_BEAT_MS, LIVE_TOPICS, LiveCursor, type LiveEvent, livePath, type LiveTopic, newNodeIdentity, type RouteName, routes, type Scope, signRequest, utf8 } from "@invincible/core";
import { requestPairing, waitForApproval } from "@invincible/link";
import { foundFleet, LedgerStore } from "@invincible/ledger";
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

const root = mkdtempSync(join(tmpdir(), "invincible-live-"));
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
  beats: number[];
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
  /** A route with a body, signed over it as it is sent. */
  const call = async <T = any>(route: RouteName, input: unknown = {}): Promise<{ status: number; body: T }> => {
    const r = routes[route];
    const body = utf8(JSON.stringify(input));
    const headers = await signRequest(device, signer, r.method, r.path, body);
    const response = await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
  };
  /** Its stream, opened again from where one left off when `since` is given (core's livePath). */
  const listen = async (since?: string): Promise<Listening> => listenAt(livePath(since));
  /** Its stream at exactly this path and query, signed over them as they are sent. */
  const listenAt = async (path: string): Promise<Listening> => listenWith(await signRequest(device, signer, "GET", path, new Uint8Array()), path);
  return { device, read, call, listen, listenAt };
}

async function listenWith(headers: Record<string, string>, path: string = routes.live.path): Promise<Listening> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: controller.signal });
  const heard: Heard[] = [];
  /** When each of its beats came (a comment: nothing to tell, but alive). */
  const beats: number[] = [];
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
            if (block.startsWith(":")) beats.push(performance.now());
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
    beats,
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

/** A stream's hello, as it came. */
async function helloOf(live: Listening): Promise<Extract<LiveEvent, { type: "hello" }>> {
  const { event } = await live.next((e) => e.type === "hello", 0);
  if (event.type !== "hello") throw new Error("not a hello");
  return event;
}

/** Where the stream left a device: the `at` of the last event it heard (a device keeps the last it was given). */
function lastAt(live: Listening): string | undefined {
  for (let i = live.heard.length - 1; i >= 0; i--) {
    const { event } = live.heard[i]!;
    if (event.type !== "bye" && event.at) return event.at;
  }
  return undefined;
}

/** Its hello, then a look's time more, so what a write just before it moved is heard too: where it left the device. */
async function settled(live: Listening): Promise<string> {
  await helloOf(live);
  await Bun.sleep(300);
  return lastAt(live)!;
}

/** Until the node has let a closed stream go (its end reaches the node a moment after the device's). */
const letGo = async (live: Listening): Promise<void> => {
  live.close();
  await live.ended;
  await Bun.sleep(150);
};

// Its streams, its pairings and its reads are processes' time to give: at 2 % of a core (SIGSTOP 980 ms of every second,
// then SIGCONT: what each of about 585 runnable tasks gets of 12 cores), "opened again after some of what it may read
// changed" took 5.10 and 5.14 s, past bun's 5 s (the Mac mini, 28 November 2026). The limit is how long a busy machine
// may take, never what a test checks: the tests that time the stream say so themselves.
setDefaultTimeout(20_000);

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  // (Its notifications don't look by themselves: every 15 s, and 1.5 s after anything that may be worth telling, such as a
  // device paired. With a device that collects its own, from the test that says so, each look kept what had newly come
  // up for it and moved `notify` in whatever test ran then: during "nothing at rest", 1.5 s after its pairing. Its tests
  // send theirs themselves.)
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 3_600_000, defaultHeartbeat: false, archiveIntervalMs: false, backups: false, shutdownGraceMs: 100, push: { tickMs: false } });
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
    // Opened afresh: where things stand, to open it again from, and nothing said of what changed (read everything).
    const hello = await helloOf(full);
    expect(LiveCursor.safeParse(hello.at).success).toBe(true);
    expect(hello.changed).toBeUndefined();
    full.close();
    narrow.close();
  });

  test("a key it asks for reaches a listening device in about one round trip: told as it is written, shown by the one read after", async () => {
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

  test("what the node writes by itself, with no request (a chat kept, its turn's end), is told within a look", async () => {
    const phone = await pair("phone-4", CLIENT_DEFAULT_SCOPES);
    const live = await phone.listen();
    await live.next((e) => e.type === "hello", 0);
    const wrote = performance.now();
    daemon.chats.create({ title: "Release notes", project: null, role: "planner" });
    const heard = await live.next(told("turns"), 0);
    expect(heard.at - wrote).toBeLessThan(1_000);
    live.close();
  });

  test("a notification kept for a device that collects its own is told to it as `notify` within a look: it collects on that", async () => {
    const mac = await pair("mac-4", CLIENT_DEFAULT_SCOPES);
    const live = await mac.listen();
    await live.next((e) => e.type === "hello", 0);
    expect((await mac.call("collectSubscribe")).status).toBe(200);
    const asked = performance.now();
    expect((await mac.call("notifyTest")).status).toBe(200);
    const heard = await live.next(told("notify"), asked);
    expect(heard.at - asked).toBeLessThan(1_000);
    const { body } = await mac.call<{ on: boolean; notifications: { kind: string }[] }>("notifyCollect");
    expect(body.on).toBe(true);
    expect(body.notifications.map((n) => n.kind)).toContain("test");
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

  test("its hello says how often it beats, and it beats that often, so a phone tells a dead link within seconds", async () => {
    const phone = await pair("phone-beat", CLIENT_DEFAULT_SCOPES);
    const live = await phone.listen();
    const hello = (await live.next((e) => e.type === "hello", 0)).event;
    expect(hello.type === "hello" && hello.beat).toBe(LIVE_BEAT_MS);
    // Three silent beats and a stream is gone: within five seconds.
    expect(3 * LIVE_BEAT_MS).toBeLessThanOrEqual(5_000);
    await Bun.sleep(2 * LIVE_BEAT_MS + 400);
    expect(live.beats.length).toBeGreaterThanOrEqual(2);
    live.close();
  });

  test("opened again from where it left off with nothing changed since, its hello says nothing changed: a renewal costs the stream alone", async () => {
    const phone = await pair("phone-resume", CLIENT_DEFAULT_SCOPES);
    const first = await phone.listen();
    const left = await settled(first);
    await letGo(first);
    const again = await phone.listen(left);
    expect(again.status).toBe(200);
    const hello = await helloOf(again);
    expect(hello.changed).toEqual([]);
    expect(hello.at).toBe(left);
    // And it is a stream as any other: what changes from now on is told, with where things stand after it.
    await admin("requestSecret", { name: "resume-token", purpose: "To check that a resumed stream tells what changes." });
    const heard = (await again.next(told("secretRequests"), 0)).event;
    expect(heard.type === "changed" && LiveCursor.safeParse(heard.at).success && heard.at !== left).toBe(true);
    again.close();
  });

  test("opened again after some of what it may read changed, its hello names those and only those, each once", async () => {
    const phone = await pair("phone-resume-2", CLIENT_DEFAULT_SCOPES);
    const first = await phone.listen();
    const left = await settled(first);
    await letGo(first);
    // Another stream listens meanwhile, so each change is told as it is written.
    const other = await phone.listen();
    await settled(other);
    await admin("requestSecret", { name: "resume-token-2", purpose: "To check what a resumed stream names." });
    await admin("requestSecret", { name: "resume-token-3", purpose: "To check that a topic is named once." });
    await other.next(told("secretRequests"), 0);
    await Bun.sleep(300);
    const again = await phone.listen(left);
    expect((await helloOf(again)).changed).toEqual(["secretRequests"]);
    // From where the other stood after the changes, nothing changed.
    const later = await phone.listen(lastAt(other));
    expect((await helloOf(later)).changed).toEqual([]);
    for (const live of [other, again, later]) live.close();
  });

  test("what changed while no device listened is named to the device that comes back", async () => {
    const phone = await pair("phone-resume-3", CLIENT_DEFAULT_SCOPES);
    const first = await phone.listen();
    const left = await settled(first);
    await letGo(first);
    // Written with nobody listening: nothing is read then, so it is counted when someone listens again.
    await admin("requestSecret", { name: "away-token", purpose: "To check what changed while nobody listened." });
    daemon.chats.create({ title: "While you were away", project: null, role: "planner" });
    const again = await phone.listen(left);
    expect((await helloOf(again)).changed).toEqual(["secretRequests", "turns"]);
    again.close();
  });

  test("a cursor this node can't answer for (not one it sealed: another boot's, one altered) is no cursor: a fresh hello", async () => {
    const phone = await pair("phone-resume-4", CLIENT_DEFAULT_SCOPES);
    const first = await phone.listen();
    const left = await settled(first);
    first.close();
    // Opaque: it says nothing of where things stand, in the one form a cursor takes.
    expect(left).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const altered = `${left.slice(0, 5)}${left[5] === "A" ? "B" : "A"}${left.slice(6)}`;
    for (const since of ["A".repeat(22), altered, "r3st4rt3d.0"]) {
      const again = await phone.listen(since);
      expect(again.status).toBe(200);
      const hello = await helloOf(again);
      expect(hello.changed).toBeUndefined();
      expect(hello.at).toBe(left);
      again.close();
    }
  });

  test("a since that isn't a cursor is treated as none (a fresh hello), never an error: the stream still opens", async () => {
    const phone = await pair("phone-resume-5", CLIENT_DEFAULT_SCOPES);
    const first = await phone.listen();
    const left = await settled(first);
    first.close();
    // Empty, too long, a character outside the cursor's, one escaped, two of them, and one beside another parameter.
    const paths = ["/api/live?since=", `/api/live?since=${"a".repeat(65)}`, "/api/live?since=a!b", "/api/live?since=a%20b", "/api/live?since=a%2Eb", `/api/live?since=${left}&since=${left}`];
    for (const path of paths) {
      const again = await phone.listenAt(path);
      expect([path, again.status]).toEqual([path, 200]);
      expect([path, (await helloOf(again)).changed]).toEqual([path, undefined]);
      again.close();
    }
    // (A parameter it doesn't know is no reason to refuse: it is left alone.)
    const beside = await phone.listenAt(`/api/live?since=${left}&later=1`);
    expect((await helloOf(beside)).changed).toEqual([]);
    beside.close();
  });

  test("a resumed hello names only what the device may read: one without the vault's scope is never told of a key asked for", async () => {
    const phone = await pair("phone-resume-6", CLIENT_DEFAULT_SCOPES);
    const reader = await pair("reader-resume-6", ["mind:read"]);
    const full = await phone.listen();
    const narrow = await reader.listen();
    const [fullLeft, narrowLeft] = [await settled(full), await settled(narrow)];
    await letGo(full);
    await letGo(narrow);
    await admin("requestSecret", { name: "scoped-token", purpose: "To check whom a resumed stream names it to." });
    // A key asked for moves nothing the reader may read: it stands where it stood.
    const fresh = await reader.listen();
    expect((await helloOf(fresh)).at).toBe(narrowLeft);
    fresh.close();
    const phoneFresh = await phone.listen();
    const phoneAt = (await helloOf(phoneFresh)).at!;
    expect(phoneAt).not.toBe(fullLeft);
    phoneFresh.close();
    // The phone's cursor stands past the reader's: no cursor to the reader, so asking from it tells the reader nothing.
    const past = await reader.listen(phoneAt);
    expect((await helloOf(past)).changed).toBeUndefined();
    past.close();
    await admin("remember", { text: "The release goes out on Thursdays." });
    const fullAgain = await phone.listen(fullLeft);
    const narrowAgain = await reader.listen(narrowLeft);
    expect((await helloOf(fullAgain)).changed).toEqual(["secretRequests", "aboutYou"]);
    expect((await helloOf(narrowAgain)).changed).toEqual(["aboutYou"]);
    fullAgain.close();
    narrowAgain.close();
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
