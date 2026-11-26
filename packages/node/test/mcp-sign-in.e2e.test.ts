import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ConnectorLibraryView, ConnectorView, McpIndexEntry, RouteName } from "@galahad/core";
import { routes } from "@galahad/core";
import { installedConnector } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import { z } from "zod";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Signing in to a hosted MCP server as you (MCP's authorization spec), over real HTTP: a stand-in that, as Linear's or
 * Notion's does, answers only with a token its own authorization server gave, names that server in its protected
 * resource metadata, and lets a client register itself. Galahad installs it, you sign in (a browser's visit and its
 * return to the node's /oauth/callback, played here), its tools are listed by themselves, a tool runs on a token renewed
 * where it was pinned, and the sign-in is never shown or sent anywhere else.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "mcp-sign-in-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
const root = mkdtempSync(join(tmpdir(), "galahad-mcp-sign-in-"));
const home = new Home(join(root, "node"));
const port = freePort();
const callback = `http://127.0.0.1:${port}/oauth/callback`;
let daemon: Daemon;
let upstream: ReturnType<typeof Bun.serve>;
let url: string;
/** What the stand-in was asked: the client that registered, the sign-in your browser was sent to, each token asked for, each MCP request's Authorization. */
const seen: { registered: Record<string, unknown> | null; authorize: URLSearchParams | null; token: URLSearchParams[]; mcp: string[] } = { registered: null, authorize: null, token: [], mcp: [] };

/** What the stand-in index lists: a server that takes a key in a header of its own, and one you sign in to. */
const indexed = (over: Partial<McpIndexEntry>): McpIndexEntry => ({ id: "acme-builds", label: "Acme Builds", description: "Builds and their logs.", url: "https://mcp.acme.example/mcp", site: "acme.example", category: "Developer tools", auth: "key", header: "X-API-Key", rank: 900, registry: "example.acme/mcp", updated: "2026-11-01T00:00:00Z", ...over });
const INDEXED = [indexed({}), indexed({ id: "acme-tickets", label: "Acme Tickets", url: "https://tickets.acme.example/mcp", category: "Project management", auth: "oauth", header: undefined, rank: 901, description: "Tickets and boards." })];

function issues(): McpServer {
  const server = new McpServer({ name: "issues", version: "2.0.0" });
  server.registerTool("list_issues", { description: "List your open issues.", inputSchema: { team: z.string().optional() }, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "3 open issues" }] }));
  return server;
}

async function admin<T = any>(name: RouteName, input?: unknown): Promise<{ status: number; body: T }> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  return { status: response.status, body: (await response.json()) as T };
}
const card = async () => (await admin<{ connectors: ConnectorView[] }>("connectors")).body.connectors.find((c) => c.id === "issues")!;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const at = new URL(req.url);
      const origin = at.origin;
      switch (at.pathname) {
        // A stand-in for the index at mcp.galahad.sh (GALAHAD_MCP_INDEX).
        case "/library.json":
          return Response.json({ v: 1, generated: "2026-11-18T00:00:00Z", count: INDEXED.length, entries: INDEXED });
        case "/.well-known/oauth-protected-resource/mcp":
        case "/.well-known/oauth-protected-resource":
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
        case "/.well-known/oauth-authorization-server":
          return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
        case "/register": {
          seen.registered = (await req.json()) as Record<string, unknown>;
          return Response.json({ ...seen.registered, client_id: "client-123", client_id_issued_at: 1 }, { status: 201 });
        }
        case "/authorize": {
          // What your browser meets once you've allowed it: back where it was sent from, with a code and the state.
          seen.authorize = at.searchParams;
          const back = new URL(at.searchParams.get("redirect_uri")!);
          back.searchParams.set("code", "code-abc");
          back.searchParams.set("state", at.searchParams.get("state")!);
          return new Response(null, { status: 302, headers: { location: back.toString() } });
        }
        case "/token": {
          const form = new URLSearchParams(await req.text());
          seen.token.push(form);
          if (form.get("grant_type") === "authorization_code") {
            // PKCE: the verifier must be the one whose challenge your browser carried.
            const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
            if (form.get("code") !== "code-abc" || challenge !== seen.authorize?.get("code_challenge")) return Response.json({ error: "invalid_grant" }, { status: 400 });
            return Response.json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 });
          }
          if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "refresh-1") return Response.json({ access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 });
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        case "/mcp": {
          const auth = req.headers.get("authorization") ?? "";
          seen.mcp.push(auth);
          if (!/^Bearer access-\d$/.test(auth)) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await issues().connect(transport);
          return transport.handleRequest(req);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  url = `http://127.0.0.1:${upstream.port}/mcp`;
  process.env.GALAHAD_MCP_INDEX = `http://127.0.0.1:${upstream.port}/library.json`;
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
});

afterAll(async () => {
  delete process.env.GALAHAD_MCP_INDEX;
  await daemon?.stop();
  upstream?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a server you sign in to: installed without tools, nothing asked for in the vault, no app of yours to give", async () => {
  const installed = await admin("setConnector", { id: "issues", mcp: { url, label: "Issues", auth: "oauth" } });
  expect(installed.status).toBe(200);
  expect(installed.body.discovered).toMatchObject({ needsSignIn: true, needsKey: false, tools: 0 });
  expect(await card()).toMatchObject({ kind: "mcp", url, key: "missing", oauth: { provider: "mcp" }, tools: [] });
  expect((await admin<{ requests: unknown[] }>("secretRequests")).body.requests).toEqual([]);
  expect((await admin("setOAuthApp", { connector: "issues", client: "anything" })).status).toBe(400);
});

test("you sign in: Galahad registers itself, your browser allows it with PKCE, comes back, and the tools are listed by themselves", async () => {
  const started = await admin<{ flow: string; url: string }>("oauthStart", { connector: "issues", redirect: callback });
  expect(started.status).toBe(200);
  expect(started.body.flow).toBe("code");
  const sent = new URL(started.body.url);
  expect(`${sent.origin}${sent.pathname}`).toBe(`http://127.0.0.1:${upstream.port}/authorize`);
  expect(Object.fromEntries(sent.searchParams)).toMatchObject({ client_id: "client-123", response_type: "code", redirect_uri: callback, code_challenge_method: "S256", resource: url, scope: "read" });
  expect(seen.registered).toMatchObject({ client_name: "Galahad", redirect_uris: [callback], token_endpoint_auth_method: "none" });

  // Your browser: to the sign-in, which sends it back to the node.
  const allowed = await fetch(started.body.url, { redirect: "manual" });
  expect(allowed.status).toBe(302);
  const page = await fetch(allowed.headers.get("location")!);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Signed in to Issues");
  expect(Object.fromEntries(seen.token[0]!)).toMatchObject({ grant_type: "authorization_code", code: "code-abc", redirect_uri: callback, client_id: "client-123", resource: url });

  // Its tools are listed once you've signed in, and the card says it's ready; nothing of the sign-in is shown.
  const end = Date.now() + 8000;
  while (Date.now() < end && !(await card()).tools.length) await Bun.sleep(25);
  const ready = await card();
  expect(ready).toMatchObject({ key: "ready", tools: [expect.objectContaining({ name: "list_issues" })] });
  expect(JSON.stringify(ready)).not.toMatch(/refresh-|access-|code-abc/);

  // A call carries an access token, renewed where it was pinned when you signed in, for this server alone.
  const called = await admin<{ result: { ok: boolean; body: string } }>("callConnector", { connector: "issues", tool: "list_issues", args: {} });
  expect(called.body.result).toMatchObject({ ok: true, body: expect.stringContaining("3 open issues") });
  expect(seen.mcp.at(-1)).toMatch(/^Bearer access-\d$/);
  expect(seen.token.filter((form) => form.get("grant_type") === "refresh_token").every((form) => form.get("resource") === url)).toBe(true);
  // A sign-in comes back once: a second return with the same state keeps nothing.
  expect(await (await fetch(allowed.headers.get("location")!)).text()).toContain("expired or was already used");
});

test("signed out: its calls stop, saying why", async () => {
  expect((await admin("oauthSignOut", { connector: "issues" })).status).toBe(200);
  expect((await card()).key).toBe("signed-out");
  const refused = await admin<{ error?: string; result?: { ok: boolean; body: string } }>("callConnector", { connector: "issues", tool: "list_issues", args: {} });
  expect(JSON.stringify(refused.body)).toContain("isn't signed in");
});

test("the library: hosted MCP servers listed before they're added, and one added by its id alone, signing in as it does", async () => {
  const { connectors } = (await admin<{ connectors: ConnectorView[] }>("connectors")).body;
  expect(connectors.find((c) => c.id === "linear")).toMatchObject({ installed: false, kind: "mcp", url: "https://mcp.linear.app/mcp", oauth: { provider: "mcp" }, key: "missing" });
  expect(connectors.find((c) => c.id === "cloudflare-docs")).toMatchObject({ installed: false, kind: "mcp", oauth: null, key: "none-needed" });
  // Added by its id alone: nothing asked of it over the network until you sign in.
  const added = await admin("setConnector", { id: "linear" });
  expect(added.status).toBe(200);
  expect(added.body.discovered).toMatchObject({ needsSignIn: true, tools: 0 });
  expect(added.body.connector).toMatchObject({ installed: true, kind: "mcp", url: "https://mcp.linear.app/mcp", oauth: { provider: "mcp" }, key: "missing" });
  expect((await admin("setConnector", { id: "nothing-like-it" })).status).toBe(404);
});

test("the library: your company's books (Dinero) are added as Galahad's alone and private, and stay so when added again", async () => {
  const added = await admin("setConnector", { id: "dinero" });
  expect(added.status).toBe(200);
  expect(added.body.connector).toMatchObject({ installed: true, kind: "mcp", url: "https://mcp.dinero.dk/", oauth: { provider: "mcp" }, private: true });
  const stored = () => installedConnector(daemon.store, "dinero")!;
  expect(stored()).toMatchObject({ access: { only: "galahad", allowed: [] }, private: true });
  // A knight you allow may; added again, the one you allowed still may.
  expect((await admin("setConnectorAccess", { id: "dinero", agent: "team.abc.bors", allow: true })).status).toBe(200);
  expect((await admin("setConnector", { id: "dinero" })).status).toBe(200);
  expect(stored().access).toEqual({ only: "galahad", allowed: ["team.abc.bors"] });
});

test("the library: the reviewed list and the index, searched; one added by its id takes its key, or signs in, as the index says", async () => {
  const library = async (input: object) => (await admin<ConnectorLibraryView>("connectorLibrary", input)).body;
  // The first ask starts the index's first read; the reviewed list answers meanwhile.
  expect((await library({})).entries.length).toBeGreaterThan(0);
  const end = Date.now() + 8000;
  while (Date.now() < end && !(await library({})).index.count) await Bun.sleep(25);
  const found = await library({ q: "acme" });
  expect(found.index).toMatchObject({ count: 2, problem: null });
  expect(found.entries.map((e) => e.id)).toEqual(["acme-builds", "acme-tickets"]);
  expect((await library({ auth: "key" })).entries.map((e) => e.id)).toContain("acme-builds");
  expect((await library({ category: "Project management", q: "acme" })).entries.map((e) => e.id)).toEqual(["acme-tickets"]);
  // Reviewed ones lead an unsearched page.
  expect((await library({ limit: 3 })).entries.every((e) => e.reviewed)).toBe(true);

  // Added by its id, with nothing asked of the network: the key's header as the index says, then the sign-in.
  const keyed = await admin("setConnector", { id: "acme-builds" });
  expect(keyed.status).toBe(200);
  expect(keyed.body.discovered).toMatchObject({ needsKey: true, tools: 0 });
  expect(keyed.body.connector).toMatchObject({ installed: true, kind: "mcp", url: "https://mcp.acme.example/mcp", key: "missing" });
  const signed = await admin("setConnector", { id: "acme-tickets" });
  expect(signed.body.discovered).toMatchObject({ needsSignIn: true });
  expect((await library({ q: "acme" })).entries.every((e) => e.installed)).toBe(true);
});
