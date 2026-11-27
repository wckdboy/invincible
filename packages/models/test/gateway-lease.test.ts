import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { addUsage, costOf, newNodeIdentity, sha256B64u, type Usage, type UsageLine } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { GatewayTokens, handleGateway } from "../src/index.ts";

/*
 * A lease kept while its work runs (GatewayTokens.extend): the same token, valid longer and with more requests, so
 * whatever holds it works on. Never one that lapsed or was revoked.
 */

test("kept: the same token, valid its minutes more from now, and its requests more than it has used", () => {
  let now = 1_000_000;
  const tokens = new GatewayTokens(new Database(":memory:"), () => now);
  const { token, info } = tokens.mint({ label: "sandbox:0123456789", providers: ["local"], ttlMinutes: 30, maxRequests: 2 });
  expect(tokens.consume(token, "local")).toEqual({ ok: true });
  expect(tokens.consume(token, "local")).toEqual({ ok: true });
  expect(tokens.consume(token, "local")).toEqual({ ok: false, reason: "token request budget exhausted" });
  now += 20 * 60_000;
  expect(tokens.extend(info.hash, { ttlMinutes: 30, maxRequests: 2 })).toBe(true);
  // Twenty-nine minutes after it was kept, forty-nine after it was made: still good, with two requests more.
  now += 29 * 60_000;
  expect(tokens.consume(token, "local")).toEqual({ ok: true });
  expect(tokens.consume(token, "local")).toEqual({ ok: true });
  expect(tokens.consume(token, "local")).toEqual({ ok: false, reason: "token request budget exhausted" });
  // Its scope is what it was: never another provider's.
  expect(tokens.consume(token, "other")).toEqual({ ok: false, reason: "token not valid for other" });
  now += 2 * 60_000;
  expect(tokens.consume(token, "local")).toEqual({ ok: false, reason: "token expired" });
});

test("never brought back: one that lapsed, or was revoked, stays so", () => {
  let now = 1_000_000;
  const tokens = new GatewayTokens(new Database(":memory:"), () => now);
  const lapsed = tokens.mint({ label: "sandbox:a", ttlMinutes: 30, maxRequests: 5 });
  const revoked = tokens.mint({ label: "sandbox:b", ttlMinutes: 30, maxRequests: 5 });
  tokens.revoke(revoked.info.hash);
  now += 31 * 60_000;
  expect(tokens.extend(lapsed.info.hash, { ttlMinutes: 30, maxRequests: 5 })).toBe(false);
  expect(tokens.extend(revoked.info.hash, { ttlMinutes: 30, maxRequests: 5 })).toBe(false);
  expect(tokens.consume(lapsed.token, "local")).toEqual({ ok: false, reason: "token expired" });
  expect(tokens.consume(revoked.token, "local")).toEqual({ ok: false, reason: "unknown token" });
});

/*
 * Sensitive mode's lease (an agent's, or a task's): good for its models alone, whatever its providers serve. A provider
 * that serves other vendors' models too (NEAR AI Cloud does) serves the VM only those it is held to.
 */
const KEY = ["FAKE", "sensitive", "lease", "key"].join("-");
const asked: string[] = [];
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    asked.push(`${req.method} ${new URL(req.url).pathname}${req.method === "POST" ? ` ${(JSON.parse(await req.text()) as { model: string }).model}` : ""}`);
    return new URL(req.url).pathname.endsWith("/models") ? Response.json({ data: [{ id: "Qwen/Qwen3.8-27B-abliterated" }, { id: "anthropic/claude-opus-5-5" }] }) : Response.json({ choices: [{ message: { content: "aye" } }] });
  },
});
afterAll(async () => await upstream.stop(true));

function gateway(models?: string[]) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  vault.set("nearai", KEY, { provider: "nearai", origin: new URL(baseUrl).origin });
  store.emit(identity, "provider.set", { id: "nearai", kind: "openai", baseUrl, secret: "nearai" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["nearai"], ...(models ? { models } : {}), ttlMinutes: 10, maxRequests: 10 });
  const call = (model: string) => handleGateway(new Request("http://127.0.0.1:7400/gw/nearai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [] }) }), { store, vault, tokens });
  const list = () => handleGateway(new Request("http://127.0.0.1:7400/gw/nearai/models", { headers: { authorization: `Bearer ${token}` } }), { store, vault, tokens });
  return { tokens, token, call, list };
}

test("sensitive mode's lease: its models through, any other refused before a byte of the call leaves, on its own provider too", async () => {
  asked.length = 0;
  const g = gateway(["nearai/Qwen/Qwen3.8-27B-abliterated"]);
  expect(g.tokens.modelsOf(g.token)).toEqual(["nearai/Qwen/Qwen3.8-27B-abliterated"]);
  expect((await g.call("Qwen/Qwen3.8-27B-abliterated")).status).toBe(200);
  const refused = await g.call("anthropic/claude-opus-5-5");
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("this lease is for nearai/Qwen/Qwen3.8-27B-abliterated alone");
  // A listing asks no model: it is let through.
  expect((await g.list()).status).toBe(200);
  expect(asked).toEqual(["POST /v1/chat/completions Qwen/Qwen3.8-27B-abliterated", "GET /v1/models"]);
  // A lease not in sensitive mode is good for any model of its providers, as ever.
  const plain = gateway();
  expect(plain.tokens.modelsOf(plain.token)).toBeNull();
  expect((await plain.call("anthropic/claude-opus-5-5")).status).toBe(200);
});

test("a token kept from before leases could be held to models is still good, for any model of its providers", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE gw_tokens (hash TEXT PRIMARY KEY, label TEXT NOT NULL, providers TEXT, expires_at INTEGER NOT NULL, max_requests INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  // (Obviously not a real token: one minted before, kept as its hash in a table without the column.)
  const token = `gw_${"a".repeat(43)}`;
  db.query("INSERT INTO gw_tokens (hash, label, providers, expires_at, max_requests, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sha256B64u(token), "sandbox:a", JSON.stringify(["local"]), 10_000, 5, 1_000);
  const tokens = new GatewayTokens(db, () => 1_000);
  expect(tokens.modelsOf(token)).toBeNull();
  expect(tokens.consume(token, "local")).toEqual({ ok: true });
  // And one minted now, in the table brought up to date, is held to its models.
  const held = tokens.mint({ label: "sandbox:b", providers: ["local"], models: ["local/qwen"], ttlMinutes: 30, maxRequests: 5 });
  expect(tokens.modelsOf(held.token)).toEqual(["local/qwen"]);
});

/*
 * A lease held to models (another node's task's, as createTaskVm mints it; or sensitive mode's) is good for its models'
 * calls and their listing alone (the fourth fabric review's R4-3, its PoC turned around): no GET of your files, stored
 * responses or batches with your key, no batch made, no other method, on either protocol.
 */
const HELD_KEY = ["FAKE", "owner", "provider", "key"].join("-");
const reached: string[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    reached.push(`${req.method} ${new URL(req.url).pathname}`);
    return Response.json({ ok: true });
  },
});
afterAll(async () => await provider.stop(true));

function held() {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  // An OpenAI-style provider whose base URL holds its /v1, and Anthropic's, whose doesn't.
  vault.set("openai", HELD_KEY, { provider: "openai", origin: `http://127.0.0.1:${provider.port}` });
  store.emit(identity, "provider.set", { id: "openai", kind: "openai", baseUrl: `http://127.0.0.1:${provider.port}/v1`, secret: "openai" });
  vault.set("anthropic", HELD_KEY, { provider: "anthropic", origin: `http://127.0.0.1:${provider.port}` });
  store.emit(identity, "provider.set", { id: "anthropic", kind: "anthropic", baseUrl: `http://127.0.0.1:${provider.port}`, secret: "anthropic" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["openai", "anthropic"], models: ["openai/gpt-paid", "anthropic/claude-paid"], ttlMinutes: 30, maxRequests: 500 });
  const ask = (method: string, path: string, model?: string) =>
    handleGateway(
      new Request(`http://127.0.0.1:7400/gw/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(model !== undefined ? { body: JSON.stringify({ model, messages: [] }) } : {}) }),
      { store, vault, tokens },
    );
  return { ask };
}

test("a lease held to models: its models' calls and their listing through, nothing else of the provider's (R4-3)", async () => {
  reached.length = 0;
  const { ask } = held();
  // Its models' calls, by each protocol's own routes, and their listing.
  for (const [method, path, model] of [
    ["POST", "openai/chat/completions", "gpt-paid"],
    ["POST", "openai/responses", "gpt-paid"],
    ["POST", "openai/completions", "gpt-paid"],
    ["GET", "openai/models"],
    ["GET", "openai/models/gpt-paid"],
    ["POST", "anthropic/v1/messages", "claude-paid"],
    ["POST", "anthropic/v1/messages/count_tokens", "claude-paid"],
    ["GET", "anthropic/v1/models"],
  ] as const) {
    expect([method, path, (await ask(method, path, model)).status]).toEqual([method, path, 200]);
  }
  // Nothing else: your files, stored responses, batches and vector stores, by any method, on either protocol.
  for (const [method, path, model] of [
    ["GET", "openai/files"],
    ["GET", "openai/files/file-abc123/content"],
    ["GET", "openai/responses/resp_x"],
    ["GET", "openai/batches"],
    ["GET", "openai/vector_stores"],
    ["POST", "openai/batches", "gpt-paid"],
    ["POST", "openai/files", "gpt-paid"],
    ["DELETE", "openai/models/gpt-paid"],
    ["PUT", "openai/chat/completions", "gpt-paid"],
    ["GET", "anthropic/v1/files"],
    ["GET", "anthropic/v1/messages/batches/msgbatch_x/results"],
    ["POST", "anthropic/v1/messages/batches", "claude-paid"],
    ["GET", "anthropic/v1/messages"],
  ] as const) {
    const refused = await ask(method, path, model);
    expect([method, path, refused.status]).toEqual([method, path, 403]);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toStartWith("this lease is for model calls alone (openai/gpt-paid, anthropic/claude-paid)");
  }
  // None of those reached the provider, with your key or any.
  expect(reached).toEqual(["POST /v1/chat/completions", "POST /v1/responses", "POST /v1/completions", "GET /v1/models", "GET /v1/models/gpt-paid", "POST /v1/messages", "POST /v1/messages/count_tokens", "GET /v1/models"]);
  // And a model call on another model is still refused, as before.
  expect((await ask("POST", "openai/chat/completions", "gpt-free")).status).toBe(403);
});

/*
 * A held call's usage is never left unsaid (the fourth fabric review's I-l, its PoC turned around): a streamed
 * OpenAI-style call is asked to say it, and one whose answer says none all the same is counted at the most it could have
 * been, so `stream: true` no longer spends a handed task's budget for nothing. A lease not held to models is as before.
 */
const streamed: { stream_options?: unknown }[] = [];
let tells = true;
const streaming = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    const asked = (await req.json()) as { stream_options?: { include_usage?: boolean } };
    streamed.push({ ...(asked.stream_options ? { stream_options: asked.stream_options } : {}) });
    // As OpenAI streams: a usage chunk last, only when asked for it (and a provider that never says one).
    const usage = asked.stream_options?.include_usage && tells ? ['data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":300,"total_tokens":1500}}'] : [];
    const sse = ['data: {"choices":[{"delta":{"content":"a long answer"}}]}', ...usage, "data: [DONE]", ""].join("\n\n");
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(async () => await streaming.stop(true));

function counted(models?: string[]) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  vault.set("openai", HELD_KEY, { provider: "openai", origin: `http://127.0.0.1:${streaming.port}` });
  store.emit(identity, "provider.set", { id: "openai", kind: "openai", baseUrl: `http://127.0.0.1:${streaming.port}/v1`, secret: "openai" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["openai"], ...(models ? { models } : {}), ttlMinutes: 30, maxRequests: 500 });
  const usage: (Usage | null)[] = [];
  const call = async (body: Record<string, unknown>) => {
    const answer = await handleGateway(new Request("http://127.0.0.1:7400/gw/openai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { store, vault, tokens, onUsage: (c) => void usage.push(c.usage) });
    const text = await answer.text();
    await Bun.sleep(5);
    return { status: answer.status, text };
  };
  return { call, usage };
}

test("a held lease's streamed call is asked to say its usage; one that says none all the same counts at its most, never $0 (I-l)", async () => {
  streamed.length = 0;
  tells = true;
  const held = counted(["openai/gpt-paid"]);
  const ask = { model: "gpt-paid", stream: true, messages: [{ role: "user", content: "x".repeat(1000) }], max_tokens: 100000 };
  expect((await held.call(ask)).status).toBe(200);
  // Asked for its usage, the provider says it: counted as it said.
  expect(streamed.at(-1)).toEqual({ stream_options: { include_usage: true } });
  expect(held.usage.at(-1)).toEqual({ input: 1200, output: 300 });
  // A stream_options of its own is kept, with the ask beside it; one that already asks is sent as it is.
  await held.call({ ...ask, stream_options: { other: 1 } });
  expect(streamed.at(-1)).toEqual({ stream_options: { other: 1, include_usage: true } });
  // A provider that says none all the same: every byte sent and answered counted, so the call is priced above $0.
  tells = false;
  const said = await held.call(ask);
  const counted0 = held.usage.at(-1)!;
  expect(counted0.input).toBeGreaterThanOrEqual(JSON.stringify(ask).length);
  expect(counted0.output).toBe(Buffer.byteLength(said.text));
  const lines: UsageLine[] = [];
  addUsage(lines, "engineer", "openai/gpt-paid", counted0);
  const cost = costOf(lines, { "openai/gpt-paid": { input: 10, output: 40 } });
  expect(cost.usd).toBeGreaterThan(0);
  expect(cost.complete).toBe(true);
  // A lease not held to models is as before: its call is sent as it was, and a usage unsaid is unknown.
  streamed.length = 0;
  const plain = counted();
  await plain.call(ask);
  expect(streamed).toEqual([{}]);
  expect(plain.usage).toEqual([null]);
});

/*
 * A held lease's embeddings (the fifth fabric review's R5-7): sensitive mode's lease is held to its models as a handed
 * task's is, and its work embeds, on its own local provider too. So an embeddings call passes by either route, and is
 * counted as its answer says: its input's tokens, and no output, as embeddings are billed.
 */
const embedded: string[] = [];
let embeddingsSay = true;
const embedding = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    embedded.push(`${req.method} ${new URL(req.url).pathname}`);
    const vector = Array.from({ length: 1536 }, (_, i) => Math.sin(i) / 7);
    return Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: vector }], model: "embed-paid", ...(embeddingsSay ? { usage: { prompt_tokens: 8, total_tokens: 8 } } : {}) });
  },
});
afterAll(async () => await embedding.stop(true));

function embeds(models?: string[]) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  // (Its base URL without a /v1, so a tool calls v1/embeddings; and with one, so it calls embeddings.)
  vault.set("local", HELD_KEY, { provider: "local", origin: `http://127.0.0.1:${embedding.port}` });
  store.emit(identity, "provider.set", { id: "local", kind: "openai", baseUrl: `http://127.0.0.1:${embedding.port}`, secret: "local" });
  vault.set("openai", HELD_KEY, { provider: "openai", origin: `http://127.0.0.1:${embedding.port}` });
  store.emit(identity, "provider.set", { id: "openai", kind: "openai", baseUrl: `http://127.0.0.1:${embedding.port}/v1`, secret: "openai" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["local", "openai"], ...(models ? { models } : {}), ttlMinutes: 30, maxRequests: 500 });
  const usage: (Usage | null)[] = [];
  const call = async (path: string) => {
    const answer = await handleGateway(new Request(`http://127.0.0.1:7400/gw/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "embed-paid", input: "a sentence of the owner's" }) }), { store, vault, tokens, onUsage: (c) => void usage.push(c.usage) });
    const text = await answer.text();
    await Bun.sleep(5);
    return { status: answer.status, text };
  };
  return { call, usage };
}

test("a held lease's embeddings pass by either route, and are counted as their answer says, its input alone (R5-7)", async () => {
  embedded.length = 0;
  embeddingsSay = true;
  const held = embeds(["local/embed-paid", "openai/embed-paid"]);
  expect((await held.call("local/v1/embeddings")).status).toBe(200);
  expect((await held.call("openai/embeddings")).status).toBe(200);
  expect(embedded).toEqual(["POST /v1/embeddings", "POST /v1/embeddings"]);
  expect(held.usage).toEqual([{ input: 8, output: 0 }, { input: 8, output: 0 }]);
  // One whose answer says no usage is still counted at its most, never $0: every byte sent an input token, every byte
  // answered an output token.
  embeddingsSay = false;
  const said = await held.call("openai/embeddings");
  expect(held.usage.at(-1)).toEqual({ input: JSON.stringify({ model: "embed-paid", input: "a sentence of the owner's" }).length, output: Buffer.byteLength(said.text) });
  // A lease not held to models reads an embedding's usage the same way (it was unknown before).
  embeddingsSay = true;
  const plain = embeds();
  await plain.call("openai/embeddings");
  expect(plain.usage).toEqual([{ input: 8, output: 0 }]);
  // And a model call's usage that leaves out its output tokens is still no usage: embeddings' own reading is for embeddings.
  await plain.call("openai/chat/completions");
  expect(plain.usage.at(-1)).toBeNull();
});

/*
 * A held call whose client goes before its answer ends (the fifth fabric review's R5-2, its PoC turned around): the
 * provider bills what it was sent, and what it generated, all the same. So the call is counted as it ends, however it
 * ends, at its upper bound from what was sent: each byte sent an input token, and as many output tokens as it was
 * allowed (its max_tokens), or as many bytes as were answered if that is more. Never $0.
 */
let holding = false;
const slow = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    await req.arrayBuffer();
    const first = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"the start of a long answer"}}]}\n\n');
    // One event, then nothing more until the client goes, as a long generation is.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        holding = true;
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(async () => await slow.stop(true));

test("a held call whose client goes before its answer ends is counted at once at its most, from what was sent (R5-2)", async () => {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  vault.set("openai", HELD_KEY, { provider: "openai", origin: `http://127.0.0.1:${slow.port}` });
  store.emit(identity, "provider.set", { id: "openai", kind: "openai", baseUrl: `http://127.0.0.1:${slow.port}/v1`, secret: "openai" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["openai"], models: ["openai/gpt-paid"], ttlMinutes: 30, maxRequests: 500 });
  const usage: (Usage | null)[] = [];
  const ask = { model: "gpt-paid", stream: true, max_tokens: 4000, messages: [{ role: "user", content: "x".repeat(100_000) }] };
  const client = new AbortController();
  holding = false;
  const answer = await handleGateway(new Request("http://127.0.0.1:7400/gw/openai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(ask), signal: client.signal }), { store, vault, tokens, onUsage: (c) => void usage.push(c.usage) });
  const body = answer.body!.getReader();
  // The client reads the answer's first event, then goes.
  const first = await body.read();
  expect(first.done).toBe(false);
  await body.cancel();
  client.abort();
  for (let i = 0; i < 100 && usage.length === 0; i++) await Bun.sleep(10);
  expect(usage).toHaveLength(1);
  const counted = usage[0]!;
  // (Every byte sent an input token: at least its prompt, and the stream_options the gateway asked for with it.)
  expect(counted.input).toBeGreaterThanOrEqual(JSON.stringify(ask).length);
  expect(counted.output).toBeGreaterThanOrEqual(4000);
  const lines: UsageLine[] = [];
  addUsage(lines, "engineer", "openai/gpt-paid", counted);
  expect(costOf(lines, { "openai/gpt-paid": { input: 10, output: 40 } }).usd).toBeGreaterThan(0);
});

test("a held call whose client goes before any answer comes is counted at its most all the same (R5-2)", async () => {
  // A provider that answers nothing until its caller goes, as one generating a long answer not streamed does.
  const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => resolve(new Response("late")))) });
  try {
    const identity = newNodeIdentity();
    const store = new LedgerStore(":memory:");
    foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
    const vault = new Vault(store, identity);
    vault.set("openai", HELD_KEY, { provider: "openai", origin: `http://127.0.0.1:${silent.port}` });
    store.emit(identity, "provider.set", { id: "openai", kind: "openai", baseUrl: `http://127.0.0.1:${silent.port}/v1`, secret: "openai" });
    const tokens = new GatewayTokens(new Database(":memory:"));
    const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["openai"], models: ["openai/gpt-paid"], ttlMinutes: 30, maxRequests: 500 });
    const usage: (Usage | null)[] = [];
    // (Three answers asked, each up to its cap: it allowed itself three times as much.)
    const ask = { model: "gpt-paid", max_completion_tokens: 2500, n: 3, messages: [{ role: "user", content: "y".repeat(50_000) }] };
    const client = new AbortController();
    const asked = handleGateway(new Request("http://127.0.0.1:7400/gw/openai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(ask), signal: client.signal }), { store, vault, tokens, onUsage: (c) => void usage.push(c.usage) });
    await Bun.sleep(100);
    client.abort();
    await asked.catch(() => {});
    expect(usage).toHaveLength(1);
    expect(usage[0]!.input).toBeGreaterThanOrEqual(JSON.stringify(ask).length);
    expect(usage[0]!.output).toBe(7500);
  } finally {
    await silent.stop(true);
  }
});
