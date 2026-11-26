import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { newNodeIdentity, sha256B64u } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
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
 * Sensitive mode's lease (a knight's, or a task's): good for its models alone, whatever its providers serve. A provider
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
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  vault.set("nearai", KEY, { provider: "nearai", origin: new URL(baseUrl).origin });
  store.emit(identity, "provider.set", { id: "nearai", kind: "openai", baseUrl, secret: "nearai" });
  const tokens = new GatewayTokens(new Database(":memory:"));
  const { token } = tokens.mint({ label: "sandbox:0123456789", providers: ["nearai"], ...(models ? { models } : {}), ttlMinutes: 10, maxRequests: 10 });
  const call = (model: string) => handleGateway(new Request("http://127.0.0.1:7777/gw/nearai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [] }) }), { store, vault, tokens });
  const list = () => handleGateway(new Request("http://127.0.0.1:7777/gw/nearai/models", { headers: { authorization: `Bearer ${token}` } }), { store, vault, tokens });
  return { tokens, token, call, list };
}

test("sensitive mode's lease: its models through, any other refused before a byte of the call leaves, on its own provider too", async () => {
  asked.length = 0;
  const g = gateway(["nearai/Qwen/Qwen3.8-27B-abliterated"]);
  expect(g.tokens.modelsOf(g.token)).toEqual(["nearai/Qwen/Qwen3.8-27B-abliterated"]);
  expect((await g.call("Qwen/Qwen3.8-27B-abliterated")).status).toBe(200);
  const refused = await g.call("anthropic/claude-opus-5-5");
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("this lease is for work in sensitive mode, on nearai/Qwen/Qwen3.8-27B-abliterated alone");
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
