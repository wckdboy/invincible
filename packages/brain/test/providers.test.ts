import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, GatewayTokens, handleGateway, keyHeaders, listModels, offeredModels, originOf, preset, providerViews, resolveProvider, streamAnthropic, streamOpenAICompatible } from "../src/index.ts";

/*
 * Where a provider's key goes. Most OpenAI-compatible endpoints take it as
 * `Authorization: Bearer`; Cloudflare AI Gateway takes its own token as
 * `cf-aig-authorization` and must get no Authorization header, or it forwards that
 * to the provider instead of the key you stored with Cloudflare.
 */

const CF = "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/galahad/compat";
const TOKEN = "cf_aig_FAKE_token_for_tests_0123456789";

describe("key headers", () => {
  test("by protocol and host", () => {
    expect(keyHeaders({ kind: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" })).toEqual({ authorization: "Bearer k" });
    expect(keyHeaders({ kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k" })).toEqual({ "x-api-key": "k" });
    expect(keyHeaders({ kind: "openai", baseUrl: CF, apiKey: "k" })).toEqual({ "cf-aig-authorization": "Bearer k" });
    expect(keyHeaders({ kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null })).toEqual({});
  });

  test("Cloudflare AI Gateway is a preset that says how to point it", () => {
    expect(preset("cloudflare-ai")).toMatchObject({ kind: "openai", baseUrl: "" });
    expect(preset("cloudflare-ai")!.note).toContain("gateway.ai.cloudflare.com/v1/<account id>/<gateway id>/compat");
  });

  test("chat through Cloudflare sends the gateway token in its own header, and no Authorization", async () => {
    const seen: Headers[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    let text = "";
    for await (const chunk of streamOpenAICompatible({
      provider: { id: "cloudflare-ai", kind: "openai", baseUrl: CF, apiKey: TOKEN, local: false },
      model: "deepseek/deepseek-chat",
      system: "s",
      messages: [{ role: "user", content: "hello" }],
      effort: "medium",
      fetch,
    })) text += chunk;
    expect(text).toBe("hi");
    expect(seen[0]!.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.has("authorization")).toBe(false);
  });

  test("the model gateway lends Cloudflare to tools the same way", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    const vault = new Vault(store, identity);
    vault.set("cloudflare-ai", TOKEN, { provider: "cloudflare-ai", origin: "https://gateway.ai.cloudflare.com" });
    store.emit(identity, "provider.set", { id: "cloudflare-ai", kind: "openai", baseUrl: CF, secret: "cloudflare-ai" });
    const tokens = new GatewayTokens(new Database(":memory:"));
    const { token } = tokens.mint({ label: "arm", providers: ["cloudflare-ai"], ttlMinutes: 10, maxRequests: 5 });
    const seen: { url: string; headers: Headers }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json({ ok: true });
    }) as typeof globalThis.fetch;
    const response = await handleGateway(
      new Request("http://127.0.0.1:7777/gw/cloudflare-ai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }),
      { store, vault, tokens, fetch },
    );
    expect(response.status).toBe(200);
    expect(seen[0]!.url).toBe(`${CF}/chat/completions`);
    expect(seen[0]!.headers.get("cf-aig-authorization")).toBe(`Bearer ${TOKEN}`);
    // The tool's own gateway token stays behind; nothing goes out as Authorization.
    expect(seen[0]!.headers.has("authorization")).toBe(false);
  });
});

/*
 * A preset's address is the one its vendor's documentation gives now (read 16 November 2026), so a key is pinned
 * where the vendor says calls go.
 */
describe("a preset points where its vendor's docs say", () => {
  test("DeepSeek: base_url https://api.deepseek.com, its OpenAI format (api-docs.deepseek.com), with no /v1", () => {
    expect(preset("deepseek")).toMatchObject({ kind: "openai", baseUrl: "https://api.deepseek.com" });
  });

  test("Verda: its inference API at https://inference.verda.com/v1 (docs.verda.com/inference/openai-compatibility), not an address you must find", () => {
    expect(preset("verda")).toMatchObject({ kind: "openai", baseUrl: "https://inference.verda.com/v1" });
    // A container of your own on Verda has an endpoint of its own: the note says how to point at it.
    expect(preset("verda")!.note).toContain("--base-url");
  });
});

/*
 * The models the roster is offered for a provider. Most endpoints say what they serve (GET /models). Z.ai's API has
 * no such endpoint (docs.z.ai's API reference has none), so its preset names the models its docs list; a Cloudflare
 * AI Gateway routes to whatever you set it up for, so its models are yours to name; a coding plan isn't asked.
 */
describe("the models a provider is offered with", () => {
  const asked = () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return String(url).endsWith("/models") ? Response.json({ data: [{ id: "m-2" }, { id: "m-1" }] }) : new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;
    return { seen, fetch };
  };
  const KEY = ["FAKE", "offered", "models", "key"].join("-");
  const provider = (id: string, baseUrl = preset(id)!.baseUrl) => ({ id, kind: preset(id)?.kind ?? ("openai" as const), baseUrl, apiKey: KEY, local: false });

  test("Z.ai: the models its docs name, and Z.ai is never asked for a list it doesn't have", async () => {
    const { seen, fetch } = asked();
    expect(await offeredModels(provider("zai"), fetch)).toEqual(["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2"]);
    expect(seen).toEqual([]);
  });

  test("whatever Z.ai serves first (zai/*) is the first of them, and the call goes to its chat completions", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    vault.set("zai", KEY, { provider: "zai", origin: originOf(preset("zai")!.baseUrl)! });
    store.emit(identity, "provider.set", { id: "zai", kind: "openai", baseUrl: preset("zai")!.baseUrl, secret: "zai" });
    store.emit(identity, "roster.set", { role: "planner", models: ["zai/*"] });
    const seen: { url: string; body: { model?: string } }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response('data: {"choices":[{"delta":{"content":"aye"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const events = [];
    for await (const event of chat({ store, vault, fetch }, { messages: [{ role: "user", content: "hello" }] })) events.push(event);
    expect(events[0]).toEqual({ type: "model", ref: "zai/glm-5.3" });
    expect(seen.map((s) => [s.url, s.body.model])).toEqual([["https://api.z.ai/api/paas/v4/chat/completions", "glm-5.3"]]);
  });

  test("Cloudflare AI Gateway: its models are yours to name, and it says so, without asking for a list it doesn't have", async () => {
    const { seen, fetch } = asked();
    await expect(offeredModels(provider("cloudflare-ai", "https://gateway.ai.cloudflare.com/v1/0123/galahad/compat"), fetch)).rejects.toThrow("cloudflare-ai doesn't list its models: name them yourself in the roster, as cloudflare-ai/<model>");
    expect(seen).toEqual([]);
  });

  test("a coding plan's are the ones its preset names: the plan isn't asked", async () => {
    const { seen, fetch } = asked();
    expect(await offeredModels(provider("zai-coding"), fetch)).toEqual(preset("zai-coding")!.plan!.models);
    expect(seen).toEqual([]);
  });

  test("any other is asked, with its key, as ever", async () => {
    const { seen, fetch } = asked();
    expect(await offeredModels(provider("moonshot"), fetch)).toEqual(["m-1", "m-2"]);
    expect(seen.map((s) => [s.url, s.headers.get("authorization")])).toEqual([["https://api.moonshot.ai/v1/models", `Bearer ${KEY}`]]);
  });
});

/*
 * A key goes only to the address it was added for (SECURITY.md, finding 2). A provider pointed somewhere else since
 * keeps its key out of the new address, and says so: which address the key was for, so the owner knows to add it
 * again there (Xiaomi's Token Plan answers at one of three addresses, by region; its preset knows Singapore's).
 */
describe("a provider pointed elsewhere says its key was added for another address", () => {
  const KEY = ["tp", "FAKE", "elsewhere", "key"].join("-");
  const AMS = "https://token-plan-ams.xiaomimimo.com/v1";
  const setUp = () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    vault.set("mimo-token", KEY, { provider: "mimo-token", origin: originOf(preset("mimo-token")!.baseUrl)! });
    store.emit(identity, "provider.set", { id: "mimo-token", kind: "openai", baseUrl: preset("mimo-token")!.baseUrl, secret: "mimo-token" });
    return { identity, store, vault };
  };

  test("where its key was added for, it has its key and says nothing more", () => {
    const { store, vault } = setUp();
    expect(providerViews(store, vault)).toEqual([{ id: "mimo-token", kind: "openai", baseUrl: preset("mimo-token")!.baseUrl, secret: "mimo-token", label: null, hasKey: true }]);
  });

  test("pointed at another region, the key isn't sent there, and the view says which address it was for", () => {
    const { identity, store, vault } = setUp();
    store.emit(identity, "provider.set", { id: "mimo-token", kind: "openai", baseUrl: AMS, secret: "mimo-token" });
    expect(providerViews(store, vault)[0]).toMatchObject({ baseUrl: AMS, hasKey: false, keyElsewhere: "https://token-plan-sgp.xiaomimimo.com" });
    expect(resolveProvider(store, vault, "mimo-token", "tool")?.apiKey).toBeNull();
  });

  test("added again for its address now, it has its key and nothing is said", () => {
    const { identity, store, vault } = setUp();
    store.emit(identity, "provider.set", { id: "mimo-token", kind: "openai", baseUrl: AMS, secret: "mimo-token" });
    vault.set("mimo-token", KEY, { provider: "mimo-token", origin: originOf(AMS)! });
    const [view] = providerViews(store, vault);
    expect(view).toMatchObject({ hasKey: true });
    expect(view).not.toHaveProperty("keyElsewhere");
  });

  test("a key added for another provider isn't one added for another address: nothing is said of it", () => {
    const { identity, store, vault } = setUp();
    vault.set("borrowed", KEY, { provider: "openrouter", origin: originOf(AMS)! });
    store.emit(identity, "provider.set", { id: "mimo-token", kind: "openai", baseUrl: AMS, secret: "borrowed" });
    const [view] = providerViews(store, vault);
    expect(view).toMatchObject({ hasKey: false });
    expect(view).not.toHaveProperty("keyElsewhere");
  });
});

/*
 * A local runtime's preset is where that runtime listens when it is started with its defaults: Ollama on 11434
 * (docs.ollama.com/api/openai-compatibility), and llama.cpp's llama-server on 9931 (its tools/server/README.md and
 * common/common.h; it was 8080 before, which is now only what its Docker examples map).
 */
describe("a local runtime is looked for where it listens by default", () => {
  test("Ollama and llama.cpp's llama-server, each at its own default address", () => {
    expect(preset("ollama")).toMatchObject({ kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", local: true });
    expect(preset("llamacpp")).toMatchObject({ kind: "openai", baseUrl: "http://127.0.0.1:9931/v1", local: true });
  });
});

/*
 * A key is pinned to the origin it was entered for. A redirect answered by that origin
 * must not carry the key (or the conversation) on to another one: fetch keeps custom
 * headers such as x-api-key and cf-aig-authorization across origins, and resends the body.
 */
describe("a provider's key never follows a redirect", () => {
  const KEY = "sk-FAKE-key-for-redirect-tests-0000";
  const elsewhere: { path: string; key: string | null }[] = [];
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      elsewhere.push({ path: new URL(req.url).pathname, key: req.headers.get("x-api-key") ?? req.headers.get("authorization") });
      return Response.json({ data: [] });
    },
  });
  // The provider the key is pinned to answers every request by pointing somewhere else.
  const pinned = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://localhost:${other.port}/elsewhere`, 307) });
  const baseUrl = `http://127.0.0.1:${pinned.port}`;
  afterAll(async () => {
    await pinned.stop(true);
    await other.stop(true);
  });

  test("through the model gateway", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    const vault = new Vault(store, identity);
    vault.set("claude", KEY, { provider: "claude", origin: baseUrl });
    store.emit(identity, "provider.set", { id: "claude", kind: "anthropic", baseUrl, secret: "claude" });
    const tokens = new GatewayTokens(new Database(":memory:"));
    const { token } = tokens.mint({ label: "arm", providers: ["claude"], ttlMinutes: 10, maxRequests: 5 });
    elsewhere.length = 0;
    const response = await handleGateway(
      new Request("http://127.0.0.1:7777/gw/claude/v1/messages", { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: "{}" }),
      { store, vault, tokens },
    );
    expect(elsewhere).toEqual([]);
    // The tool sees that the provider redirected; it isn't told where to.
    expect(response.status).toBe(307);
    expect(response.headers.has("location")).toBe(false);
  });

  test("when listing a provider's models", async () => {
    elsewhere.length = 0;
    await expect(listModels({ id: "claude", kind: "anthropic", baseUrl, apiKey: KEY, local: false })).rejects.toThrow("307");
    expect(elsewhere).toEqual([]);
  });

  test("in chat with an OpenAI-compatible provider", async () => {
    elsewhere.length = 0;
    const answer = (async () => {
      for await (const _ of streamOpenAICompatible({ provider: { id: "p", kind: "openai", baseUrl, apiKey: KEY, local: false }, model: "m", system: "s", messages: [{ role: "user", content: "hello" }], effort: "medium" })) void _;
    })();
    await expect(answer).rejects.toThrow("307");
    expect(elsewhere).toEqual([]);
  });

  test("in chat with Claude", async () => {
    elsewhere.length = 0;
    const answer = (async () => {
      for await (const _ of streamAnthropic({ provider: { id: "claude", kind: "anthropic", baseUrl, apiKey: KEY, local: false }, model: "claude-opus-5-5", system: "s", messages: [{ role: "user", content: "hello" }], effort: "medium" })) void _;
    })();
    await expect(answer).rejects.toThrow();
    expect(elsewhere).toEqual([]);
  });
});
