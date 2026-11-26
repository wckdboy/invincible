import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { routes } from "@galahad/core";
import { ApiError, apiFor, READING_POSTS, READS_UNDER_OTHER_SCOPES, setNetworkHandler } from "./api.ts";
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
