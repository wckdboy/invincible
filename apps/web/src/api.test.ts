import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { routes } from "@invincible/core";
import { b64u } from "@invincible/core/bytes";
import { desktopBeat } from "@invincible/core/desktop-frames";
import { clientIdFromKey, nodeIdentity } from "@invincible/core/identity";
import { nodeProofInput, verifyRequestSignature } from "@invincible/core/request-auth";
import { ApiError, apiFor, provenWhoami, READING_POSTS, READS_UNDER_OTHER_SCOPES, setNetworkHandler } from "./api.ts";
import type { BrowserIdentity } from "./identity.ts";

/*
 * The PWA reaches its node through `tailscale serve`. While the node restarts, the proxy
 * itself answers (502, not JSON): that is the node being away, and the app must say so
 * (and heal when it's back), not show "502 Bad Gateway" as if the node had refused.
 * A 502 the node itself sends (a connector's service unreachable) is an ordinary answer.
 */

const proxyDown = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } }) });
const nodeSays502 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "Forge unreachable: connection refused" }, { status: 502 }) });
afterAll(() => {
  proxyDown.stop(true);
  nodeSays502.stop(true);
});

let identity: BrowserIdentity;
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  identity = { device: "c_test-device", privateKey: pair.privateKey, publicKey: pair.publicKey, enrolled: true, name: "Test browser" };
});

const at = (port: number) => {
  (globalThis as { location?: unknown }).location = new URL(`http://127.0.0.1:${port}/`);
};

describe("a node that is away", () => {
  test("the proxy's own 502 means the node isn't answering: the app hears 'unreachable' and a plain reason", async () => {
    const seen: boolean[] = [];
    setNetworkHandler((ok) => seen.push(ok));
    at(proxyDown.port!);
    const error = await apiFor(identity).get("/api/fleet").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toMatch(/isn't answering/);
    expect(seen).toEqual([false]);
  });

  test("a 502 from the node itself is its answer: reachable, with its own words", async () => {
    const seen: boolean[] = [];
    setNetworkHandler((ok) => seen.push(ok));
    at(nodeSays502.port!);
    const error = await apiFor(identity).post("/api/connectors/call", {}).catch((e: unknown) => e);
    expect((error as ApiError).message).toBe("Forge unreachable: connection refused");
    expect(seen).toEqual([true]);
  });
});

describe("what a place showed last time", () => {
  let asked = 0;
  const node = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      asked += 1;
      const url = new URL(request.url);
      await Bun.sleep(20);
      if (request.method === "POST") return Response.json(url.pathname === "/api/team/room" ? { room: await request.json() } : { ok: true });
      return Response.json({ path: url.pathname, at: Date.now() });
    },
  });
  afterAll(() => node.stop(true));

  test("each answer is kept by its address, to show at once on a revisit while the fresh one is asked for", async () => {
    at(node.port!);
    const api = apiFor(identity);
    expect(api.peek("/api/loops")).toBeUndefined();
    const first = await api.get<{ path: string }>("/api/loops");
    expect(api.peek("/api/loops")).toEqual(first);
    // Another address keeps its own.
    expect(api.peek("/api/overview")).toBeUndefined();
  });

  test("a POST that changes nothing keeps its answer by what it was asked, and forgets nothing", async () => {
    at(node.port!);
    const api = apiFor(identity);
    const loops = await api.get("/api/loops");
    const room = await api.post("/api/team/room", { id: "forge" });
    expect(api.peek("/api/team/room", { id: "forge" })).toEqual(room);
    expect(api.peek("/api/team/room", { id: "other" })).toBeUndefined();
    expect(api.peek("/api/loops")).toEqual(loops);
  });

  test("a read asked for ahead of a tap is shared by the place that asks while it's on its way: one request, not two", async () => {
    at(node.port!);
    const api = apiFor(identity);
    asked = 0;
    const ahead = api.get("/api/artifacts");
    const place = api.get("/api/artifacts", new AbortController().signal);
    expect(await place).toEqual(await ahead);
    const room = api.post("/api/team/room", { id: "forge" });
    expect(await api.post("/api/team/room", { id: "forge" }, new AbortController().signal)).toEqual(await room);
    expect(asked).toBe(2);
    // One a place asked for itself (with its own signal, which may end it) is never shared.
    asked = 0;
    await Promise.all([api.get("/api/skills", new AbortController().signal), api.get("/api/skills", new AbortController().signal)]);
    expect(asked).toBe(2);
  });

  test("anything you change forgets them all: no place shows what was there before your change, even for a moment", async () => {
    at(node.port!);
    const api = apiFor(identity);
    await api.get("/api/loops");
    await api.post("/api/loops/remove", { name: "nightly" });
    expect(api.peek("/api/loops")).toBeUndefined();
  });
});

test("the POSTs that leave what places showed are every reading route, and a named few that read under another scope", () => {
  const reading = Object.values(routes).filter((route) => route.method === "POST" && /:read$/.test(route.scope ?? "")).map((route) => route.path);
  expect([...READING_POSTS].sort()).toEqual([...reading, ...READS_UNDER_OTHER_SCOPES].sort());
  // Each of those few is a POST route that exists.
  for (const path of READS_UNDER_OTHER_SCOPES) expect([path, Object.values(routes).some((route) => route.path === path && route.method === "POST")]).toEqual([path, true]);
});

describe("the node this browser speaks to, proven (the slice 8 note's item 11)", () => {
  // Obviously fake node keys: seeds of sevens and eights, as the parity vectors' nodes.
  const theNode = nodeIdentity(new Uint8Array(32).fill(7), new Uint8Array(32).fill(9));
  const anotherNode = nodeIdentity(new Uint8Array(32).fill(8), new Uint8Array(32).fill(10));
  /**
   * Who answers at this address: `theNode` or `anotherNode` as a node does from the cutoff (it takes a request that
   * names it, and whoami's, which names none); one that lies (says it is `theNode`, signs as `anotherNode`); or a node
   * from before, which proves nothing and reads a request that names no node alone.
   */
  let speaking: "theNode" | "anotherNode" | "liar" | "older" = "theNode";
  const node = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const whoami = url.pathname === "/api/whoami";
      const body = new Uint8Array(await request.arrayBuffer());
      const self = speaking === "anotherNode" ? anotherNode : theNode;
      const proof = speaking === "older" ? verifyRequestSignature(request.headers, request.method, `${url.pathname}${url.search}`, body) : verifyRequestSignature(request.headers, request.method, `${url.pathname}${url.search}`, body, Date.now(), self.id, whoami);
      if (!proof) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (!whoami) return Response.json({ named: proof.named });
      const said = { device: proof.device, kind: "client", scopes: ["mind:read"], node: self.id, nodeName: "test node", fleet: "f_test", fleetName: null };
      if (speaking === "older") return Response.json(said);
      const challenge = url.searchParams.get("challenge") ?? "";
      return Response.json({ ...said, proof: b64u((speaking === "liar" ? anotherNode : self).sign(nodeProofInput(challenge))) });
    },
  });
  // The pin is saved with the key, in IndexedDB: a stand-in that keeps what was put (read through `saved`, as the
  // stand-in writes it where the compiler doesn't look).
  let stored: { node?: string } | undefined;
  const saved = (): { node?: string } | undefined => stored;
  const indexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
  /** A browser's key, as the app makes one: its id is its public key, which the node checks the signature by. */
  let browserKey: BrowserIdentity;
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    browserKey = { device: clientIdFromKey(raw), privateKey: pair.privateKey, publicKey: pair.publicKey, enrolled: true, name: "Test browser" };
    const done = (put: () => void) => {
      const r: { onsuccess?: () => void } = {};
      queueMicrotask(() => {
        put();
        r.onsuccess?.();
      });
      return r;
    };
    const db = { transaction: () => ({ objectStore: () => ({ put: (value: object) => done(() => (stored = { ...value })) }) }), close: () => {} };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        const r: { result?: unknown; onsuccess?: () => void } = {};
        setTimeout(() => {
          r.result = db;
          r.onsuccess?.();
        }, 0);
        return r;
      },
    };
  });
  afterAll(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = indexedDb;
    node.stop(true);
  });

  test("a browser paired before this pins its node at its first proven whoami, keeps it, and names it in all it signs from then on", async () => {
    at(node.port!);
    speaking = "theNode";
    stored = undefined;
    const browser: BrowserIdentity = { ...browserKey };
    // Unpinned, what it signs names no node: a node that takes only what names it refuses it.
    expect(await apiFor(browser).get("/api/fleet").catch((e: unknown) => (e as ApiError).status)).toBe(401);
    const { whoami, proven } = await provenWhoami(browser);
    expect(proven).toEqual({ kind: "pin", node: theNode.id });
    expect([whoami.node, browser.node, saved()?.node]).toEqual([theNode.id, theNode.id, theNode.id]);
    expect(await apiFor(browser).get("/api/fleet")).toEqual({ named: true });
    // The same node again is the same, and nothing is saved over the pin.
    stored = undefined;
    expect((await provenWhoami(browser)).proven).toEqual({ kind: "same", node: theNode.id });
    expect(saved()).toBeUndefined();
  });

  test("another node at this address, or one whose proof fails, is said so, and the pin stays the browser's own", async () => {
    at(node.port!);
    const browser: BrowserIdentity = { ...browserKey, node: theNode.id };
    speaking = "anotherNode";
    expect((await provenWhoami(browser)).proven).toEqual({ kind: "other", node: anotherNode.id });
    // What it signs names its own node, so the other refuses it.
    expect(await apiFor(browser).get("/api/fleet").catch((e: unknown) => (e as ApiError).status)).toBe(401);
    speaking = "liar";
    expect((await provenWhoami(browser)).proven).toEqual({ kind: "false" });
    // Unpinned, a lie pins nothing either.
    const fresh: BrowserIdentity = { ...browserKey };
    expect((await provenWhoami(fresh)).proven).toEqual({ kind: "false" });
    expect([browser.node, fresh.node]).toEqual([theNode.id, undefined]);
  });

  test("a node from before, which proves nothing, is spoken to as before, and nothing is pinned", async () => {
    at(node.port!);
    speaking = "older";
    const browser: BrowserIdentity = { ...browserKey };
    expect((await provenWhoami(browser)).proven).toEqual({ kind: "older" });
    expect(browser.node).toBeUndefined();
    expect(await apiFor(browser).get("/api/fleet")).toEqual({ named: false });
  });

  // The review of apps-name-node, L7: once this browser pinned its node, one that proves nothing won't say which it is:
  // a proof that fails, so its page says so and nothing more is asked of it.
  test("pinned, a node that proves nothing is a proof that fails", async () => {
    at(node.port!);
    speaking = "older";
    const browser: BrowserIdentity = { ...browserKey, node: theNode.id };
    expect((await provenWhoami(browser)).proven).toEqual({ kind: "false" });
    expect(browser.node).toBe(theNode.id);
  });
});

describe("an agent's desktop as a stream of frames", () => {
  /** A frame as the node sends one (core's desktop-frames.ts), its payload a byte that says which. */
  const frame = (kind: number, n: number) => {
    const out = new Uint8Array(14);
    new DataView(out.buffer).setUint32(0, 10);
    out[4] = kind;
    new DataView(out.buffer).setBigUint64(5, BigInt(1_764_216_000_000 + n));
    out[13] = n;
    return out;
  };
  let cancelled = false;
  const node = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/api/team/desktop/stream") return Response.json({ error: "not found" }, { status: 404 });
      return request.json().then((asked: { id?: string }) => {
        if (asked.id !== "rio") return Response.json({ error: "this agent has no VM yet" }, { status: 424 });
        // Three frames and a beat, cut across their bounds, then nothing more until the watcher goes.
        const all = new Uint8Array([...frame(1, 1), ...frame(2, 2), ...desktopBeat(1_764_216_000_003), ...frame(2, 4)]);
        const cuts = [0, 3, 17, 30, all.length];
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i + 1 < cuts.length; i++) controller.enqueue(all.slice(cuts[i], cuts[i + 1]));
            },
            cancel: () => void (cancelled = true),
          }),
          { headers: { "content-type": "application/vnd.invincible.desktop-frames" } },
        );
      });
    },
  });
  afterAll(() => node.stop(true));

  test("its frames come whole however the bytes are cut, beats among them; leaving ends the watching", async () => {
    at(node.port!);
    const leave = new AbortController();
    const seen: [number, number][] = [];
    for await (const f of apiFor(identity).frames("/api/team/desktop/stream", { id: "rio" }, leave.signal)) {
      seen.push([f.kind, f.payload[0] ?? -1]);
      if (seen.length === 4) break;
    }
    expect(seen).toEqual([[1, 1], [2, 2], [0, -1], [2, 4]]);
    leave.abort();
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(5);
    expect(cancelled).toBe(true);
  });

  test("a refusal is the node's own words, as any answer's is", async () => {
    at(node.port!);
    const error = await (async () => {
      for await (const _ of apiFor(identity).frames("/api/team/desktop/stream", { id: "nobody" }, new AbortController().signal)) return null;
      return null;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 424, message: "this agent has no VM yet" });
  });
});
