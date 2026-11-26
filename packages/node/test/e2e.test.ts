import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, clientIdFromKey, type FleetView, newNodeIdentity, routes, type RouteName, signRequest, utf8 } from "@galahad/core";
import { requestPairing, signedFetch, signedPost, type SyncPage, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * M0, end to end, over real HTTP:
 *   laptop founds a fleet → invites the server → you approve the matching code →
 *   memories flow both ways → a key added on the laptop is used by the server's
 *   gateway on behalf of an arm that never sees it → a browser-style client pairs
 *   with a WebCrypto key and is held to its scopes.
 */

const fakeCaps = (hostname: string, extra: Partial<Capabilities> = {}): Capabilities => ({
  os: "linux",
  arch: "x64",
  hostname,
  cores: 8,
  cpu: "test",
  memoryGb: 16,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: ["git"],
  localModels: [],
  tailscale: null,
  ...extra,
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}

function admin(home: Home, port: number) {
  const token = home.adminToken();
  return async <T = any>(name: RouteName, input?: unknown): Promise<T> => {
    const route = routes[name];
    const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      method: route.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });
    if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
}

const root = mkdtempSync(join(tmpdir(), "galahad-e2e-"));
const homeA = new Home(join(root, "laptop"));
const homeB = new Home(join(root, "server"));
const portA = freePort();
const portB = freePort();
const proxyA = freePort();
const proxyB = freePort();
let laptop: Daemon;
let server: Daemon;
let upstream: ReturnType<typeof Bun.serve>;
let upstreamAuth: string | null | undefined = null;
let upstreamAgent: string | null | undefined = null;
/** What the stand-in provider was last sent. */
let upstreamBody: unknown = null;

beforeAll(async () => {
  // A stand-in for any OpenAI-compatible provider (DeepSeek, OrcaRouter, Verda, Ollama…).
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      upstreamAuth = req.headers.get("authorization");
      upstreamAgent = req.headers.get("user-agent");
      const body = (await req.json()) as { stream?: boolean; messages: { content: string }[] };
      upstreamBody = body;
      if (!body.stream) return Response.json({ choices: [{ message: { content: "pong" } }] });
      const chunks = ["Good ", "day, ", "my liege."].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });

  // The laptop founds the fleet.
  const { identity, keystore } = await homeA.createIdentity("file");
  const store = new MindStore(homeA.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "laptop" });
  store.close();
  homeA.writeConfig({ v: 1, name: "laptop", fleet, port: portA, keystore, advertise: "127.0.0.1" });
  laptop = await startDaemon(homeA, {
    capabilities: fakeCaps("laptop", { hasBattery: true }),
    syncIntervalMs: 150,
    proxyPort: proxyA,
    log: () => {},
  });
});

afterAll(async () => {
  await server?.stop();
  await laptop?.stop();
  upstream?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("M0: one mind, two bodies", () => {
  test("the server joins with a one-time invite and a matching code", async () => {
    const callA = admin(homeA, portA);
    const invite = await callA<{ invite: string; id: string }>("createInvite", { kind: "node" });

    const { identity, keystore } = await homeB.createIdentity("file");
    const join = await requestPairing(invite.invite, {
      device: identity.id,
      name: "server",
      kind: "node",
      box: b64u(identity.boxPublic),
      endpoint: `http://127.0.0.1:${portB}`,
    });

    // The approving side shows the same code the joining side shows.
    const { pairings } = await callA("pairings");
    expect(pairings).toHaveLength(1);
    expect(pairings[0].sas).toBe(join.sas);
    await callA("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });

    const { fleet } = await waitForApproval(join, { intervalMs: 50 });
    const store = new MindStore(homeB.mindPath);
    store.expectFleet(fleet);
    const page = await signedPost<SyncPage>(identity, laptop.endpoint, "/link/sync", { have: {} });
    store.ingest(page.events);
    expect(store.activeDevice(identity.id)?.name).toBe("server");
    store.close();
    homeB.writeConfig({ v: 1, name: "server", fleet, port: portB, keystore, advertise: "127.0.0.1" });
    server = await startDaemon(homeB, {
      capabilities: fakeCaps("server", { docker: true, cores: 32, memoryGb: 128, vm: { kvm: true, tools: ["incus"] } }),
      syncIntervalMs: 150,
      proxyPort: proxyB,
      log: () => {},
    });
  });

  test("an invite used by two devices is locked (possible interception)", async () => {
    const invite = await admin(homeA, portA)<{ invite: string }>("createInvite", { kind: "node" });
    const fields = (device: string) => ({ device, name: "intruder?", kind: "node" as const, box: b64u(new Uint8Array(32)) });
    await requestPairing(invite.invite, fields(newNodeIdentity().id));
    await expect(requestPairing(invite.invite, fields(newNodeIdentity().id))).rejects.toThrow(/two devices/);
    expect((await admin(homeA, portA)("pairings")).pairings).toHaveLength(0);
  });

  test("the same device id presenting different keys also locks the invite (review #11)", async () => {
    const invite = await admin(homeA, portA)<{ invite: string }>("createInvite", { kind: "node" });
    const id = newNodeIdentity();
    await requestPairing(invite.invite, { device: id.id, name: "x", kind: "node", box: b64u(id.boxPublic) });
    await expect(
      requestPairing(invite.invite, { device: id.id, name: "x", kind: "node", box: b64u(newNodeIdentity().boxPublic) }),
    ).rejects.toThrow(/two devices/);
  });

  test("memories written on either body reach the other", async () => {
    const callA = admin(homeA, portA);
    const callB = admin(homeB, portB);
    await callB("remember", { text: "the server has 32 cores and KVM", tags: ["fleet"] });
    await callA("remember", { text: "wckdboy uses tailscale everywhere" });
    await until(async () => (await callA("recall", { q: "KVM" })).memories.length === 1);
    await until(async () => (await callB("recall", { q: "tailscale" })).memories.length === 1);
    await until(async () => {
      const [a, b] = await Promise.all([callA<FleetView>("fleet"), callB<FleetView>("fleet")]);
      return a.digest === b.digest;
    });
  });

  test("a key added on the laptop is used by the server's gateway; the arm never sees it", async () => {
    const callA = admin(homeA, portA);
    const callB = admin(homeB, portB);
    const realKey = "sk-test-REAL-PROVIDER-KEY-0123456789";
    await callA("setSecret", { name: "mock", value: realKey, provider: "mock", baseUrl: `http://127.0.0.1:${upstream.port}/v1` });
    await callA("setProvider", { id: "mock", kind: "openai", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, secret: "mock" });
    await until(async () => (await callB("providers")).providers.some((p: any) => p.id === "mock" && p.hasKey));

    const { token } = await callB<{ token: string }>("mintToken", { label: "opencode", providers: ["mock"], ttlMinutes: 5, maxRequests: 2 });
    const call = () =>
      fetch(`http://127.0.0.1:${portB}/gw/mock/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "ping" }] }),
      });
    const response = await call();
    expect(response.status).toBe(200);
    expect(upstreamAuth).toBe(`Bearer ${realKey}`);
    expect(JSON.stringify(await response.json())).not.toContain(realKey);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(401); // request budget exhausted
    const wrongProvider = await fetch(`http://127.0.0.1:${portB}/gw/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token },
      body: "{}",
    });
    expect(wrongProvider.status).toBe(401);
  });

  test("a provider repointed to another host never receives the key (review #2)", async () => {
    const callA = admin(homeA, portA);
    let evilAuth: string | null | undefined;
    const evil = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        evilAuth = req.headers.get("authorization");
        return Response.json({ data: [{ id: "stolen" }] });
      },
    });
    try {
      await callA("setProvider", { id: "mock", kind: "openai", baseUrl: `http://127.0.0.1:${evil.port}/v1`, secret: "mock" });
      // The model list call would have carried the key to the new host. It goes out keyless.
      await callA("providerModels", { id: "mock" });
      expect(evilAuth).toBeNull();
      expect((await callA("providers")).providers.find((p: any) => p.id === "mock").hasKey).toBe(false);
      // Borrowing another provider's key does not work either.
      await callA("setProvider", { id: "thief", kind: "openai", baseUrl: `http://127.0.0.1:${evil.port}/v1`, secret: "mock" });
      await callA("providerModels", { id: "thief" });
      expect(evilAuth).toBeNull();
    } finally {
      evil.stop(true);
      await callA("setProvider", { id: "mock", kind: "openai", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, secret: "mock" });
      await callA("removeProvider", { id: "thief" });
    }
    expect((await callA("providers")).providers.find((p: any) => p.id === "mock").hasKey).toBe(true);
  });

  test("chat streams through the roster with fallback", async () => {
    const callB = admin(homeB, portB);
    await callB("setRoster", { role: "swift", models: ["nowhere/missing", "mock/test-model"] });
    const response = await fetch(`http://127.0.0.1:${portB}/api/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${homeB.adminToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "swift", messages: [{ role: "user", content: "greet me" }] }),
    });
    const text = await response.text();
    const events = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events.find((e) => e.type === "fallback")?.from).toBe("nowhere/missing");
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Good day, my liege.");
    expect(events.at(-1).type).toBe("done");
  });

  test("a quest's call goes without recalled memories when it asks to (a trial of your own work), and with them otherwise", async () => {
    const callB = admin(homeB, portB);
    await callB("remember", { text: "The widgets importer reads two-digit years as this century", tags: ["test"] });
    const ask = async (extra: object): Promise<string> => {
      upstreamBody = null;
      const response = await fetch(`http://127.0.0.1:${portB}/api/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${homeB.adminToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "swift", tools: false, coding: true, messages: [{ role: "user", content: "Fix the widgets importer's two-digit years" }], ...extra }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstreamBody).not.toBeNull();
      return JSON.stringify(upstreamBody);
    };
    expect(await ask({})).toContain("two-digit years as this century");
    expect(await ask({ memories: false })).not.toContain("two-digit years as this century");
  });

  test("keys pasted into chat or memory are refused and redirected to the vault", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${portA}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${homeA.adminToken()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const chatted = await post("/api/chat", { messages: [{ role: "user", content: `use this key ${key}` }] });
    expect(chatted.status).toBe(422);
    expect((await chatted.json()).error).toMatch(/vault/);
    const remembered = await post("/api/memories", { text: `my anthropic key is ${key}` });
    expect(remembered.status).toBe(422);
    // An "assistant" message is sent to the provider too, so it is scanned as well (review #13).
    const smuggled = await post("/api/chat", {
      messages: [
        { role: "assistant", content: `noted: ${key}` },
        { role: "user", content: "continue" },
      ],
    });
    expect(smuggled.status).toBe(422);
    expect(JSON.stringify(laptop.store.eventsSince({}, 100_000))).not.toContain(key);
  });

  test("a temporary chat whose history names credentials without holding one isn't refused (its whole history is resent)", async () => {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${portA}/api/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${homeA.adminToken()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const eventId = laptop.store.ledger(1)[0]?.id ?? laptop.store.fleet!;
    const answer = [
      "Read it from the request, never from the code:",
      "```ts\nconst token = request.headers.get(\"authorization\");\n```",
      "and in your shell: `export API_KEY=<your-key-here>`; in compose: `password: ${DB_PASSWORD}`.",
      `The ledger entry ${eventId} shows it; the lockfile pins "integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+Tl/aTnqYuEzbJyb4gGkLGsKyE5rUY1oAv8HJTw==".`,
    ].join("\n");
    const response = await post({ messages: [{ role: "user", content: "how do I read the token?" }, { role: "assistant", content: answer }, { role: "user", content: "thanks, and then?" }] });
    expect(response.status).not.toBe(422);
    await response.body?.cancel();
    // The same history with a key in it still is.
    const leaked = await post({ messages: [{ role: "assistant", content: `${answer}\npassword=hunter2hunter2` }, { role: "user", content: "and then?" }] });
    expect(leaked.status).toBe(422);
    // An id of the same shape that isn't an event in the mind is still refused.
    const random = await post({ messages: [{ role: "user", content: "is this one? Xq7vB2mK9pL4wR8tZ3nC6yH1sD5fG0jQzz9Ab3Cd7Ef" }] });
    expect(random.status).toBe(422);
  });

  test("Galahad can request a credential; filling it on another device resolves the request", async () => {
    const callA = admin(homeA, portA);
    const callB = admin(homeB, portB);
    await callB("requestSecret", { name: "verda", provider: "verda", purpose: "Kimi K3.1 Pro for the engineer role" });
    await until(async () => (await callA("secretRequests")).requests.some((r: any) => r.name === "verda"));
    await callA("setSecret", { name: "verda", value: "verda-key-0123456789abcdef", provider: "verda" });
    await until(async () => (await callB("secretRequests")).requests.length === 0);
  });

  test("a key request you dismiss leaves the Inbox on every node until he asks again; an agent can't dismiss one", async () => {
    const callA = admin(homeA, portA);
    const callB = admin(homeB, portB);
    await callB("requestSecret", { name: "orca", purpose: "a second opinion on the reviewer's answers" });
    await until(async () => (await callA("secretRequests")).requests.some((r: any) => r.name === "orca"));
    // An agent may ask for a key, never clear your Inbox: dismissing needs vault:write, which no arm holds.
    const { token } = await callA<{ token: string }>("mintArm", { label: "tidier" });
    const route = routes.dismissSecretRequest;
    const refused = await fetch(`http://127.0.0.1:${portA}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "orca" }) });
    expect(refused.status).toBe(403);
    await refused.body?.cancel();
    expect((await callA("secretRequests")).requests.some((r: any) => r.name === "orca")).toBe(true);
    await callA("dismissSecretRequest", { name: "orca" });
    await until(async () => !(await callB("secretRequests")).requests.some((r: any) => r.name === "orca"));
    // Nothing open by that name is said, never a silent success.
    await expect(callA("dismissSecretRequest", { name: "orca" })).rejects.toThrow(/404.*no such request/);
    await callB("requestSecret", { name: "orca", purpose: "the reviewer's answers, again" });
    await until(async () => (await callA("secretRequests")).requests.some((r: any) => r.name === "orca" && r.purpose === "the reviewer's answers, again"));
  });

  test("a subscription's sign-in pasted as a provider's key is refused, and never sealed; the presets say which are coding plans", async () => {
    const callA = admin(homeA, portA);
    // (Fake: the form of a token from `claude setup-token`, not one.)
    const oat = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
    await expect(callA("setSecret", { name: "anthropic", value: oat, provider: "anthropic" })).rejects.toThrow(/400.*sign-in, not an API key/);
    await expect(callA("setSecret", { name: "glm", value: oat, provider: "zai-coding" })).rejects.toThrow(/400.*sign-in/);
    const { secrets } = await callA("secrets");
    expect(secrets.some((s: any) => s.name === "anthropic" || s.name === "glm")).toBe(false);
    // Kept as a plain secret of your own, with no provider, it is yours to keep: it is pinned nowhere, so it is never sent.
    await callA("setSecret", { name: "my-claude-sign-in", value: oat });
    expect((await callA("secrets")).secrets.find((s: any) => s.name === "my-claude-sign-in")).toMatchObject({ provider: null, origin: null });
    await callA("deleteSecret", { name: "my-claude-sign-in" });
    const { presets } = await callA("providers");
    expect(presets.find((p: any) => p.id === "zai-coding").plan).toMatchObject({ name: "GLM Coding Plan" });
    expect(presets.find((p: any) => p.id === "anthropic").plan).toBeUndefined();
    // A plan's models are the ones its preset names: the plan isn't called to list them (nothing answers at its address here).
    await callA("setSecret", { name: "zai-coding", value: "0123456789abcdef0123456789abcdef.FAKEfakeFAKEfake", provider: "zai-coding" });
    await callA("setProvider", { id: "zai-coding", secret: "zai-coding" });
    expect((await callA("providerModels", { id: "zai-coding" })).models).toEqual(["glm-5.3", "glm-5.3-flash"]);
    await callA("removeProvider", { id: "zai-coding" });
    await callA("deleteSecret", { name: "zai-coding" });
    // The page is told the forms of sign-ins too, so it can say so before anything is sent.
    expect((await callA("providers")).signIns).toEqual(expect.arrayContaining([expect.objectContaining({ prefix: "sk-ant-oat" })]));
  });

  test("a coding plan made for coding agents (OpenCode Go) answers a quest's call, as Galahad, and never his talk with you", async () => {
    const callA = admin(homeA, portA);
    // (The plan's own preset, pointed at the stand-in provider: a key pinned to where you say it goes.)
    const planKey = "0123456789abcdef0123456789abcdef.FAKEfakeFAKEfake";
    const base = `http://127.0.0.1:${upstream.port}/v1`;
    await callA("setSecret", { name: "opencode-go", value: planKey, provider: "opencode-go", baseUrl: base });
    await callA("setProvider", { id: "opencode-go", baseUrl: base, secret: "opencode-go" });
    await callA("setRoster", { role: "engineer", models: ["opencode-go/glm-5.3"] });
    const ask = async (extra: object) => {
      const response = await fetch(`http://127.0.0.1:${portA}/api/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${homeA.adminToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "engineer", tools: false, messages: [{ role: "user", content: "write the function" }], ...extra }),
      });
      return (await response.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    };
    try {
      const forget = (): void => void (upstreamAuth = upstreamAgent = undefined);
      forget();
      const talk = await ask({});
      expect(talk.at(-1)).toMatchObject({ type: "error" });
      expect(talk.at(-1).error).toContain("coding plan");
      expect(upstreamAuth).toBeUndefined();
      const work = await ask({ coding: true });
      expect(work.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Good day, my liege.");
      expect(work.find((e) => e.type === "model")).toEqual({ type: "model", ref: "opencode-go/glm-5.3" });
      expect(upstreamAuth).toBe(`Bearer ${planKey}`);
      expect(upstreamAgent).toMatch(/^Galahad\b/);
    } finally {
      await callA("setRoster", { role: "engineer", models: ["anthropic/claude-opus-5-5"] });
      await callA("removeProvider", { id: "opencode-go" });
      await callA("deleteSecret", { name: "opencode-go" });
    }
  });

  test("sandbox requests are routed to a named node, with its answer relayed faithfully", async () => {
    const callA = admin(homeA, portA);
    // Neither test node runs Docker: unpinned work finds no host…
    await expect(callA("createSandbox", { network: "isolated" })).rejects.toThrow(/424.*no sandbox host/);
    // …and work pinned to the server is forwarded there (signed as the laptop) and refused by it.
    await expect(callA("createSandbox", { network: "isolated", on: "server" })).rejects.toThrow(/424.*server: this node is not a sandbox host/);
    await expect(callA("sandboxes", { on: "nowhere" })).rejects.toThrow(/404/);
  });

  test("a repository is put in a sandbox only by you, through a GitHub connector, and only under /work", async () => {
    const callA = admin(homeA, portA);
    const asked = { id: "0123456789", repository: "https://github.com/example/widgets", commit: "0123456789abcdef0123456789abcdef01234567", path: "/work/tasks/task-abc_def-1234" };
    await expect(callA("checkoutRepository", asked)).rejects.toThrow(/424.*add the GitHub connector/);
    // An agent may have sandboxes, never read a repository into one: the lease it takes is yours to give.
    const { token } = await callA<{ token: string }>("mintArm", { label: "outsider", scopes: ["sandbox"] });
    const asAgent = await fetch(`http://127.0.0.1:${portA}${routes.checkoutRepository.path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(asked) });
    expect(asAgent.status).toBe(403);
    for (const path of ["/work", "/work/../etc", "/etc/repo", "/work/tasks/./x"]) await expect(callA("checkoutRepository", { ...asked, path })).rejects.toThrow(/400/);
  });

  test("the Apple push key is yours alone to set, as every notification route is: another node, which holds vault:write, is refused", async () => {
    // Found by a knight's audit of the docs (22 November 2026): this route alone checked only its scope, which a full
    // node holds (an agent never may).
    const callA = admin(homeA, portA);
    const dashes = "-".repeat(5);
    const body = { key: `${dashes}BEGIN PRIVATE KEY${dashes}\nRkFLRQ==\n${dashes}END PRIVATE KEY${dashes}`, keyId: "FAKEKEY001", teamId: "FAKETEAM01", topic: "org.example.fake" };
    const asNode = await signedFetch(server.identity, laptop.endpoint, routes.setApplePushKey.path, body);
    expect(asNode.status).toBe(403);
    expect(await asNode.text()).toContain("notifications are yours alone");
    // You at a terminal are asked for a key that can sign, as ever.
    await expect(callA("setApplePushKey", body)).rejects.toThrow(/400.*isn't an Apple push key/);
  });

  test("a kept file is fetched from whichever node holds it, under the same scope, fenced the same way", async () => {
    // The server keeps a sandbox's work (the collector stands in for docker cp).
    const kept = (await server.artifacts.save(
      async (_sandbox, _from, dest) => {
        writeFileSync(join(dest, "report.md"), "# Held on the server\n");
        writeFileSync(join(dest, "page.html"), "<script>alert(1)</script>");
        return {
          files: [
            { path: "report.md", size: 21, sha256: createHash("sha256").update("# Held on the server\n").digest("hex") },
            { path: "page.html", size: 25, sha256: createHash("sha256").update("<script>alert(1)</script>").digest("hex") },
          ],
          bytes: 46,
          skipped: [],
        };
      },
      { sandbox: "0123456789", label: "server work" },
    ))!;
    await until(() => laptop.store.lww(`artifact:${kept.id}`) !== null);
    const fetchFile = (token: string, path: string) =>
      fetch(`http://127.0.0.1:${portA}${routes.artifactFile.path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: kept.id, path }),
      });
    // Asked of the laptop, which doesn't hold it: forwarded to the server, and back.
    const md = await fetchFile(homeA.adminToken(), "report.md");
    expect(md.status).toBe(200);
    expect(await md.text()).toBe("# Held on the server\n");
    expect(md.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await fetchFile(homeA.adminToken(), "page.html");
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    // A holder that answers for the page as HTML to render, under another name and without a
    // length: the type and the name are the laptop's own, from the path it asked for.
    const holder = laptop.store.device(server.identity.id)!.profile!.endpoint!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (!String(input).startsWith(holder)) return response;
      const bytes = await response.arrayBuffer();
      const chunked = new ReadableStream({ start: (controller) => (controller.enqueue(new Uint8Array(bytes)), controller.close()) });
      return new Response(chunked, { status: response.status, headers: { "content-type": "text/html", "content-disposition": 'inline; filename="index.html"' } });
    }) as typeof fetch;
    try {
      const lied = await fetchFile(homeA.adminToken(), "page.html");
      expect(lied.status).toBe(200);
      expect(lied.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(lied.headers.get("content-disposition")).toBe('inline; filename="page.html"');
      expect(lied.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(await lied.text()).toBe("<script>alert(1)</script>");
    } finally {
      globalThis.fetch = realFetch;
    }
    // An agent with mind:read reads it too; what the holder refuses comes back refused.
    const { token: armToken } = await admin(homeA, portA)<{ token: string }>("mintArm", { label: "far-reader" });
    expect(await (await fetchFile(armToken, "report.md")).text()).toBe("# Held on the server\n");
    const missing = await fetchFile(homeA.adminToken(), "../manifest.json");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toMatch(/server: no such file/);
    // A node's forwarded request runs where it lands: the laptop never forwards one on.
    const relayed = await signedPost(server.identity, laptop.endpoint, routes.artifactFile.path, { id: kept.id, path: "report.md" }).catch((error: Error) => error.message);
    expect(String(relayed)).toMatch(/421/);
  });

  test("the ledger is readable fleet-wide", async () => {
    const { entries } = await admin(homeB, portB)("ledger");
    expect(Array.isArray(entries)).toBe(true);
  });

  test("placement sends long, untrusted work to the always-on sandbox host", async () => {
    const callA = admin(homeA, portA);
    // Placement only considers peers the laptop has actually reached.
    await until(async () => (await callA<FleetView>("fleet")).peers.some((p) => p.online));
    const result = await callA("place", { longRunning: true, untrusted: true });
    expect(result.ranked[0].name).toBe("server");
    expect(result.ranked[0].reasons).toContain("always-on");
    expect(result.rejected.find((r: any) => r.name === "laptop")?.reason).toMatch(/sandbox/);
  });
});

describe("a browser client (the PWA path)", () => {
  let keys: CryptoKeyPair;
  let device: string;
  const sign = async (method: string, path: string, body: unknown) => {
    const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
    const headers = await signRequest(device, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), method, path, bytes);
    return { headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : bytes };
  };

  test("pairs with a non-extractable WebCrypto key and calls the API within its scopes", async () => {
    keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    device = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const callA = admin(homeA, portA);
    const invite = await callA<{ invite: string }>("createInvite", { kind: "client", scopes: ["mind:read", "chat"] });
    const join = await requestPairing(invite.invite, { device, name: "iphone", kind: "client" });
    const { pairings } = await callA("pairings");
    await callA("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });
    await waitForApproval(join, { intervalMs: 50 });

    const who = await sign("GET", "/api/whoami", undefined);
    const whoami = await fetch(`http://127.0.0.1:${portA}/api/whoami`, { headers: who.headers });
    expect((await whoami.json()).scopes).toEqual(["mind:read", "chat"]);

    const recall = await sign("POST", "/api/memories/search", { q: "tailscale" });
    const found = await fetch(`http://127.0.0.1:${portA}/api/memories/search`, { method: "POST", ...recall });
    expect((await found.json()).memories[0].text).toContain("tailscale");

    // Outside its scopes:
    const write = await sign("POST", "/api/secrets", { name: "x", value: "y" });
    expect((await fetch(`http://127.0.0.1:${portA}/api/secrets`, { method: "POST", ...write })).status).toBe(403);
    // Clients can never speak the node-to-node protocol:
    const link = await sign("POST", "/link/sync", { have: {} });
    expect((await fetch(`http://127.0.0.1:${portA}/link/sync`, { method: "POST", ...link })).status).toBe(401);
  });

  test("a phone can approve phones but never a new machine (review #2)", async () => {
    const callA = admin(homeA, portA);
    const nodeInvite = await callA<{ invite: string }>("createInvite", { kind: "node" });
    const joiner = newNodeIdentity();
    await requestPairing(nodeInvite.invite, { device: joiner.id, name: "rogue", kind: "node", box: b64u(joiner.boxPublic) });
    const pending = (await callA("pairings")).pairings.find((p: any) => p.device === joiner.id);
    // Give this phone fleet:admin for the test, then try to approve the machine with it.
    const invite = await callA<{ invite: string }>("createInvite", { kind: "client", scopes: ["fleet:admin"] });
    const phone = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const phoneId = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", phone.publicKey)));
    const join = await requestPairing(invite.invite, { device: phoneId, name: "phone", kind: "client" });
    const p2 = (await callA("pairings")).pairings.find((p: any) => p.device === phoneId);
    await callA("approvePairing", { invite: p2.invite, device: p2.device });
    await waitForApproval(join, { intervalMs: 50 });
    const body = utf8(JSON.stringify({ invite: pending.invite, device: pending.device }));
    const headers = await signRequest(phoneId, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.privateKey, m)), "POST", "/api/pairings/approve", body);
    const response = await fetch(`http://127.0.0.1:${portA}/api/pairings/approve`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
    expect(response.status).toBe(403);
    expect(laptop.store.device(joiner.id)).toBeNull();
    await callA("rejectPairing", { invite: pending.invite, device: pending.device });
  });

  test("an invite carries no more than its maker holds: a phone can't pair itself a stronger device", async () => {
    const callA = admin(homeA, portA);
    const invite = await callA<{ invite: string }>("createInvite", { kind: "client", scopes: ["fleet:admin", "chat"] });
    const phone = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const phoneId = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", phone.publicKey)));
    const join = await requestPairing(invite.invite, { device: phoneId, name: "small-phone", kind: "client" });
    const pending = (await callA("pairings")).pairings.find((p: any) => p.device === phoneId);
    await callA("approvePairing", { invite: pending.invite, device: pending.device });
    await waitForApproval(join, { intervalMs: 50 });
    const asPhone = async (input: object) => {
      const body = utf8(JSON.stringify(input));
      const headers = await signRequest(phoneId, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.privateKey, m)), "POST", "/api/invites", body);
      const response = await fetch(`http://127.0.0.1:${portA}/api/invites`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
      return { status: response.status, error: ((await response.json()) as { error?: string }).error };
    };
    // Asking for more, by name or by the default, is refused and says what it lacks.
    expect(await asPhone({ kind: "client", scopes: ["chat", "gateway:mint", "vault:write"] })).toEqual({
      status: 403,
      error: "an invite can't carry scopes this device doesn't hold: gateway:mint, vault:write",
    });
    expect((await asPhone({ kind: "client" })).status).toBe(403);
    // Within what it holds, it invites as before.
    expect((await asPhone({ kind: "client", scopes: ["chat"] })).status).toBe(200);
  });

  test("client invites default to every scope but gateway minting", async () => {
    const callA = admin(homeA, portA);
    const invite = await callA<{ invite: string }>("createInvite", { kind: "client" });
    const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)));
    const join = await requestPairing(invite.invite, { device: id, name: "tablet", kind: "client" });
    const pending = (await callA("pairings")).pairings.find((p: any) => p.device === id);
    await callA("approvePairing", { invite: pending.invite, device: pending.device });
    await waitForApproval(join, { intervalMs: 50 });
    expect(laptop.store.device(id)?.scopes).not.toContain("gateway:mint");
  });

  test("permissions can be granted to a paired device from a terminal, never by the device itself", async () => {
    // Even a phone that holds fleet:admin cannot raise its own permissions.
    await admin(homeA, portA)("setDeviceScopes", { device, scopes: [...laptop.store.device(device)!.scopes, "fleet:admin"] });
    const before = laptop.store.device(device)!.scopes;
    expect(before).toContain("fleet:admin");
    expect(before).not.toContain("sandbox");
    const self = await sign("POST", "/api/devices/scopes", { device, scopes: [...before, "sandbox", "gateway:mint"] });
    const refused = await fetch(`http://127.0.0.1:${portA}/api/devices/scopes`, { method: "POST", ...self });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/terminal/);
    // You grant it from the terminal:
    await admin(homeA, portA)("setDeviceScopes", { device, scopes: [...before, "sandbox"] });
    const who = await sign("GET", "/api/whoami", undefined);
    expect((await (await fetch(`http://127.0.0.1:${portA}/api/whoami`, { headers: who.headers })).json()).scopes).toContain("sandbox");
  });

  test("a key pasted into a provider's URL or label never lands in the log", async () => {
    const response = await fetch(`http://127.0.0.1:${portA}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${homeA.adminToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "oops", kind: "openai", baseUrl: "https://example.com/v1", label: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123" }),
    });
    expect(response.status).toBe(422);
  });

  test("replayed and unsigned requests are refused", async () => {
    const signed = await sign("GET", "/api/whoami", undefined);
    expect((await fetch(`http://127.0.0.1:${portA}/api/whoami`, { headers: signed.headers })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${portA}/api/whoami`, { headers: signed.headers })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${portA}/api/fleet`)).status).toBe(401);
  });

  test("the client's enrollment replicated to the server too", async () => {
    await until(() => server.store.activeDevice(device) !== null);
  });

  test("the tailscale-serve listener serves the PWA and signed clients, but never the admin token or gateway", async () => {
    const proxied = `http://127.0.0.1:${proxyA}`;
    expect((await fetch(`${proxied}/`)).status).toBe(200);
    const signed = await sign("GET", "/api/whoami", undefined);
    expect((await fetch(`${proxied}/api/whoami`, { headers: signed.headers })).status).toBe(200);
    const asAdmin = await fetch(`${proxied}/api/whoami`, { headers: { authorization: `Bearer ${homeA.adminToken()}` } });
    expect(asAdmin.status).toBe(401);
    const { token } = await admin(homeA, portA)<{ token: string }>("mintToken", { label: "t", ttlMinutes: 1, maxRequests: 5 });
    const viaGateway = await fetch(`${proxied}/gw/mock/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(viaGateway.status).toBe(404);
  });
});
