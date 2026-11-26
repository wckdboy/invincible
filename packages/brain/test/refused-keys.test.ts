import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { chat, GatewayTokens, handleGateway, RefusedKeys, refusedKeysOf, refusesKey } from "../src/index.ts";

/*
 * A provider that refuses its key (a 401 or 403 to a model call) is remembered, as a spent allowance is: which
 * provider, when, and what it said. A later call to that provider that succeeds forgets it, whichever of chat or a
 * tool's call through the gateway got through. The doctor and the Inbox say each still remembered.
 */

const NOW = Date.UTC(2026, 10, 22, 1, 28); // 22 Nov 2026 01:28 UTC

describe("a provider that refused its key", () => {
  test("is remembered with its words; a later success forgets it", () => {
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    const kept: string[] = [];
    const forgot: string[] = [];
    refusals.kept = (r) => void kept.push(r.provider);
    refusals.forgot = (p) => void forgot.push(p);

    const refusal = refusals.note("mimo-token", 'mimo-token → 401 {"error":{"message":"Invalid API Key"}}')!;
    expect(refusal).toEqual({ provider: "mimo-token", at: NOW, said: "401: Invalid API Key" });
    expect(refusals.refused("mimo-token")).toEqual(refusal);
    expect(refusals.list()).toEqual([refusal]);
    expect(kept).toEqual(["mimo-token"]);

    refusals.forget("mimo-token");
    expect(refusals.list()).toEqual([]);
    expect(refusals.refused("mimo-token")).toBeNull();
    expect(forgot).toEqual(["mimo-token"]);
  });

  test("only a 401 or 403 is a refused key: a 429, a 500 and an empty answer aren't", () => {
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    expect(refusals.note("deepseek", 'deepseek → 429 {"error":{"message":"slow down"}}')).toBeNull();
    expect(refusals.note("deepseek", "deepseek → 500 Internal Server Error")).toBeNull();
    expect(refusals.note("deepseek", "ended its answer without saying anything")).toBeNull();
    expect(refusals.list()).toEqual([]);
  });

  test("the status is the answer's own, where a call's error says it: a 5xx whose words mention a 401 isn't a refused key", () => {
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    expect(refusals.note("orcarouter", 'orcarouter → 502 {"error":{"message":"the upstream provider answered 401"}}')).toBeNull();
    expect(refusals.note("deepseek", "500 the engine said 403 to itself")).toBeNull();
    expect(refusals.list()).toEqual([]);
  });

  test("a 403 is a refused key only when it speaks of the key: one about what was asked (a moderation flag, a region) isn't", () => {
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    // OpenRouter, when a model's moderation flags what was sent; OpenAI, from a country it doesn't serve: the key is fine.
    expect(refusals.note("openrouter", 'openrouter → 403 {"error":{"message":"Your chosen model requires moderation and your input was flagged"}}')).toBeNull();
    expect(refusals.note("openai", '403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","type":"request_forbidden"}}')).toBeNull();
    expect(refusals.list()).toEqual([]);
    // Anthropic, of a key without the permission: the key's.
    expect(refusals.note("anthropic", 'anthropic → 403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}')).toEqual({
      provider: "anthropic",
      at: NOW,
      said: "403: Your API key does not have permission to use the specified resource.",
    });
  });

  test("a 403's words of an author or a token limit aren't of the key (Percival's review, 22 November 2026)", () => {
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    expect(refusals.note("forge", 'forge → 403 {"error":{"message":"you are not the author of this resource"}}')).toBeNull();
    expect(refusals.note("router", '403 {"error":{"message":"request exceeds your token limit for this tier"}}')).toBeNull();
    expect(refusals.list()).toEqual([]);
    // Words that are the key's still are: its credentials, its authentication, a 403 that says unauthorized.
    expect(refusals.note("a", "403 {\"error\":{\"message\":\"Authentication failed for this credential\"}}")).not.toBeNull();
    expect(refusals.note("b", '403 {"error":"Unauthorized"}')).not.toBeNull();
    expect(refusals.note("c", '403 {"error":{"message":"Invalid token"}}')).not.toBeNull();
  });

  test("a 401 said mid-stream (\"deepseek: 401 …\", the adapter's form for an error in the stream) is a refused key", () => {
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    expect(refusals.note("deepseek", "deepseek: 401 your api key is invalid")).toMatchObject({ provider: "deepseek", said: "401 your api key is invalid" });
    expect(refusals.note("deepseek", "deepseek: the engine said 401 to itself")).toBeNull();
  });

  test("whether an error is a refused key is one rule, for the doctor's advice too: the words after its status, never a name", () => {
    expect(refusesKey("deepseek → 401: Authentication Fails")).toBe(true);
    expect(refusesKey("local:8080 → 401 denied")).toBe(true);
    expect(refusesKey("anthropic → 403: Your API key does not have permission to use the specified resource.")).toBe(true);
    expect(refusesKey("openrouter → 403: Your chosen model requires moderation and your input was flagged")).toBe(false);
    // A plan's name may hold a word of the key's (mimo-token): only what it said counts.
    expect(refusesKey("mimo-token → 403: quota exceeded for this plan")).toBe(false);
    expect(refusesKey("orcarouter → 502: the upstream provider answered 401")).toBe(false);
  });

  test("what is kept holds nothing shaped like a key, whatever its caller scrubbed", () => {
    // (Its callers redact the key by its value; a key the provider echoes that isn't the one sent is caught here when it
    // is shaped like one: one that isn't, as "abc123xyz456", is kept as said.)
    const refusals = new RefusedKeys();
    refusals.now = () => NOW;
    const shaped = ["sk", "proj", "A".repeat(20), "B".repeat(20)].join("-");
    const kept = refusals.note("openai", `openai → 401 {"error":{"message":"Incorrect API key provided: ${shaped}."}}`)!;
    expect(kept.said).toStartWith("401: Incorrect API key provided:");
    expect(kept.said).not.toContain("A".repeat(20));
  });

  test("kept through a restart: restored refusals are as they were told", () => {
    const before = new RefusedKeys();
    before.now = () => NOW;
    const refusal = before.note("mimo-token", '401 {"error":{"message":"Invalid API Key"}}')!;
    const after = new RefusedKeys();
    after.restore([refusal]);
    expect(after.list()).toEqual([refusal]);
    expect(after.refused("mimo-token")).toEqual(refusal);
  });

  test("each node keeps its own: another mind's refusals are not this one's", () => {
    const a = new RefusedKeys();
    const b = new RefusedKeys();
    a.note("mimo-token", "401 denied");
    expect(b.list()).toEqual([]);
  });
});

function gateway(id = "mimo-token") {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const baseUrl = "https://plan.invalid/v1";
  vault.set(id, ["FAKE", id, "key"].join("-"), { provider: id, origin: new URL(baseUrl).origin });
  store.emit(identity, "provider.set", { id, kind: "openai", baseUrl, secret: id });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: [id], ttlMinutes: 10, maxRequests: 20 });
  const ctx = {
    store,
    vault,
    tokens,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ data: [{ id: "glm-5.3" }] });
      return answer(init);
    }) as typeof fetch,
  };
  let answer = (_init: RequestInit) => new Response('{"error":{"message":"Invalid API Key"}}', { status: 401, headers: { "content-type": "application/json" } });
  refusedKeysOf(store).now = () => NOW;
  const call = () =>
    handleGateway(
      new Request(`http://127.0.0.1:7777/gw/${id}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", messages: [] }),
      }),
      ctx,
    );
  const list = () => handleGateway(new Request(`http://127.0.0.1:7777/gw/${id}/models`, { headers: { authorization: `Bearer ${token}` } }), ctx);
  return { store, call, list, setAnswer: (next: (init: RequestInit) => Response) => (answer = next) };
}

describe("through the gateway", () => {
  test("a tool's 401 is remembered with its words, and a later call that got through forgets it", async () => {
    const g = gateway();
    const refused = await g.call();
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("Invalid API Key");
    expect(refusedKeysOf(g.store).list()).toEqual([{ provider: "mimo-token", at: NOW, said: "401: Invalid API Key" }]);

    g.setAnswer(() => Response.json({ choices: [{ message: { content: "aye" } }] }));
    const through = await g.call();
    expect(through.status).toBe(200);
    expect(refusedKeysOf(g.store).list()).toEqual([]);
  });

  test("a listing that got through doesn't forget it: some providers list their models to anyone, so only a model call proves the key", async () => {
    const g = gateway();
    expect((await g.call()).status).toBe(401);
    expect((await g.list()).status).toBe(200);
    expect(refusedKeysOf(g.store).list()).toHaveLength(1);
    g.setAnswer(() => Response.json({ choices: [{ message: { content: "aye" } }] }));
    expect((await g.call()).status).toBe(200);
    expect(refusedKeysOf(g.store).list()).toEqual([]);
  });

  test("a refusal that says the key back keeps none of it: not the provider's own, nor anything shaped like a key", async () => {
    // A provider refusing a key often says it back ("Incorrect API key provided: sk-…"): the reviewer of this work asked
    // that what is remembered (and so kept in the node's database and said in the doctor and the Inbox) never holds it.
    const g = gateway();
    const own = ["FAKE", "mimo-token", "key"].join("-");
    const shaped = ["sk", "proj", "A".repeat(20), "B".repeat(20)].join("-");
    g.setAnswer(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${own}. Another seen: ${shaped}` } }), { status: 401, headers: { "content-type": "application/json" } }));
    expect((await g.call()).status).toBe(401);
    const [kept] = refusedKeysOf(g.store).list();
    expect(kept!.said).toStartWith("401: Incorrect API key provided:");
    expect(kept!.said).not.toContain(own);
    expect(kept!.said).not.toContain("A".repeat(20));
  });

  test("a 429 (a spent allowance, not a refused key) is not remembered as a refused key", async () => {
    const g = gateway();
    g.setAnswer(() => new Response('{"error":{"message":"Too Many Requests"}}', { status: 429, headers: { "content-type": "application/json" } }));
    expect((await g.call()).status).toBe(429);
    expect(refusedKeysOf(g.store).list()).toEqual([]);
  });
});

describe("through chat", () => {
  function brain(key = "sk-test") {
    const id = "deepseek";
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "n" });
    const vault = new Vault(store, identity);
    const baseUrl = "https://deepseek.invalid/v1";
    vault.set(id, key, { provider: id, origin: new URL(baseUrl).origin });
    store.emit(identity, "provider.set", { id, kind: "openai", baseUrl, secret: id });
    store.emit(identity, "roster.set", { role: "planner", models: [`${id}/deepseek-chat`] });
    return { store, vault };
  }

  test("a call's 401 is remembered with its words, and a later call that got through forgets it", async () => {
    const ctx0 = brain();
    let refused = true;
    const fetch = (async (_url: string | URL | Request) => {
      if (refused) return new Response('{"error":{"message":"Invalid API Key"}}', { status: 401, headers: { "content-type": "application/json" } });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answered." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const ctx = { ...ctx0, fetch };
    refusedKeysOf(ctx.store).now = () => NOW;
    const run = async () => {
      for await (const _ of chat(ctx, { models: ["deepseek/deepseek-chat"], messages: [{ role: "user", content: "Go on" }] }));
    };

    await run();
    expect(refusedKeysOf(ctx.store).list()).toEqual([{ provider: "deepseek", at: NOW, said: "401: Invalid API Key" }]);

    refused = false;
    await run();
    expect(refusedKeysOf(ctx.store).list()).toEqual([]);
  });

  test("a refusal that says the key back keeps none of it, as through the gateway", async () => {
    const own = ["FAKE", "deepseek", "key"].join("-");
    const ctx0 = brain(own);
    const fetch = (async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ error: { message: `Authentication Fails, your api key: ${own} is invalid` } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
    const ctx = { ...ctx0, fetch };
    refusedKeysOf(ctx.store).now = () => NOW;
    for await (const _ of chat(ctx, { models: ["deepseek/deepseek-chat"], messages: [{ role: "user", content: "Go on" }] }));
    const [kept] = refusedKeysOf(ctx.store).list();
    expect(kept!.said).toStartWith("401: Authentication Fails, your api key:");
    expect(kept!.said).not.toContain(own);
  });

  test("a failure that is not a refused key is not remembered as one", async () => {
    const ctx0 = brain();
    const fetch = (async (_url: string | URL | Request) => new Response('{"error":{"message":"the engine hiccupped"}}', { status: 500, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
    const ctx = { ...ctx0, fetch };
    refusedKeysOf(ctx.store).now = () => NOW;
    for await (const _ of chat(ctx, { models: ["deepseek/deepseek-chat"], messages: [{ role: "user", content: "Go on" }] }));
    expect(refusedKeysOf(ctx.store).list()).toEqual([]);
  });
});
