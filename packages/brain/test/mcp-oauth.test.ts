import { describe, expect, test } from "bun:test";
import { ConnectorManifest, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { accessToken, clientAuthMethod, finishMcpSignIn, forgetAccess, keyState, startMcpSignIn, writeKeep } from "../src/index.ts";

/*
 * Signing in to a remote MCP server (mcp-oauth.ts): where it is found, what is refused, and what the vault keeps. A
 * stand-in fetch plays the server and its authorization server; nothing here is anyone's sign-in.
 */

const SERVER = "https://mcp.example.test/mcp";
const AUTH = "https://auth.example.test";
const BACK = "https://ultra.example.test/oauth/callback";

/** A stand-in: its protected resource metadata (or none), its authorization server's metadata, and its registration. */
function hosted(over: { resource?: Record<string, unknown> | null; metadata?: Record<string, unknown> } = {}) {
  const asked: string[] = [];
  const registered: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url.includes("/.well-known/oauth-protected-resource")) return over.resource === null ? new Response("no", { status: 404 }) : Response.json(over.resource ?? { resource: SERVER, authorization_servers: [AUTH] });
    if (url.includes("/.well-known/oauth-authorization-server")) {
      const at = new URL(url).origin;
      return Response.json({ issuer: at, authorization_endpoint: `${at}/authorize`, token_endpoint: `${at}/token`, registration_endpoint: `${at}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...over.metadata });
    }
    if (url.endsWith("/register")) {
      // As Visma Connect (Dinero's) does: a server that takes no client without a secret hands one back.
      const asked = JSON.parse(String(init?.body ?? "{}")) as { token_endpoint_auth_method?: string };
      registered.push(asked.token_endpoint_auth_method ?? "");
      const method = asked.token_endpoint_auth_method ?? "none";
      return Response.json({ client_id: "client-123", redirect_uris: [BACK], token_endpoint_auth_method: method, ...(method === "none" ? {} : { client_secret: "test-client-secret-FAKE" }) }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked, registered };
}

describe("signing in to an MCP server", () => {
  test("its authorization server as its metadata names it: your browser goes there, for this server alone, with PKCE", async () => {
    const h = hosted();
    const started = await startMcpSignIn({ server: SERVER, redirect: BACK, state: "state-1", scopes: [], fetch: h.fetch });
    const sent = new URL(started.url);
    expect(sent.origin).toBe(AUTH);
    expect(Object.fromEntries(sent.searchParams)).toMatchObject({ client_id: "client-123", redirect_uri: BACK, state: "state-1", code_challenge_method: "S256", resource: SERVER });
    expect(started.verifier.length).toBeGreaterThan(40);
    expect(started.pending).toMatchObject({ server: SERVER, authServer: AUTH, client: { client_id: "client-123" } });
  });

  test("Galahad registers with no secret where the server allows it; one that takes only clients with a secret gets one asked for, and it is kept", async () => {
    expect([clientAuthMethod(undefined), clientAuthMethod([]), clientAuthMethod(["none", "client_secret_basic"])]).toEqual(["none", "none", "none"]);
    expect([clientAuthMethod(["client_secret_basic", "client_secret_post"]), clientAuthMethod(["client_secret_basic"]), clientAuthMethod(["private_key_jwt"])]).toEqual(["client_secret_post", "client_secret_basic", "client_secret_post"]);
    const open = hosted({ metadata: { token_endpoint_auth_methods_supported: ["none"] } });
    await startMcpSignIn({ server: SERVER, redirect: BACK, state: "s", scopes: [], fetch: open.fetch });
    expect(open.registered).toEqual(["none"]);
    const strict = hosted({ metadata: { token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] } });
    const started = await startMcpSignIn({ server: SERVER, redirect: BACK, state: "s", scopes: [], fetch: strict.fetch });
    expect(strict.registered).toEqual(["client_secret_post"]);
    expect(started.pending.client).toMatchObject({ client_id: "client-123", client_secret: "test-client-secret-FAKE" });
  });

  test("a server from before that metadata: its own origin answers for it", async () => {
    const h = hosted({ resource: null });
    const started = await startMcpSignIn({ server: SERVER, redirect: BACK, state: "s", scopes: [], fetch: h.fetch });
    expect(new URL(started.url).origin).toBe("https://mcp.example.test");
  });

  test("refused: an authorization server off https, a sign-in page off https, one that won't let Galahad register", async () => {
    await expect(startMcpSignIn({ server: SERVER, redirect: BACK, state: "s", scopes: [], fetch: hosted({ resource: { resource: SERVER, authorization_servers: ["http://auth.example.test"] } }).fetch })).rejects.toThrow("isn't on https");
    await expect(startMcpSignIn({ server: SERVER, redirect: BACK, state: "s", scopes: [], fetch: hosted({ metadata: { authorization_endpoint: "http://auth.example.test/authorize" } }).fetch })).rejects.toThrow("isn't on https");
    await expect(startMcpSignIn({ server: SERVER, redirect: BACK, state: "s", scopes: [], fetch: hosted({ metadata: { registration_endpoint: undefined } }).fetch })).rejects.toThrow("give it a key instead");
  });
});

const vault = () => {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  return new Vault(store, identity);
};
const issues = ConnectorManifest.parse({ id: "issues", label: "Issues", origin: "https://mcp.example.test", auth: { secret: "issues", scheme: "oauth", oauth: { provider: "mcp", scopes: [] } }, mcp: { path: "/mcp" }, tools: {} });
const pinned = { origin: "https://mcp.example.test", provider: "issues" };

describe("what the vault keeps of it, and each call's token", () => {
  test("a lasting sign-in is renewed only where it was pinned, for this server alone", async () => {
    const v = vault();
    const asked: { url: string; form: URLSearchParams }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
      return Response.json({ access_token: "test-access-FAKE-2", refresh_token: "test-refresh-FAKE-2", expires_in: 3600 });
    }) as typeof globalThis.fetch;
    v.set("issues", writeKeep({ client: "client-123", refresh: "test-refresh-FAKE-1", token: `${AUTH}/token`, resource: SERVER }), pinned);
    forgetAccess("issues");
    let saved = "";
    expect(await accessToken({ vault: v, fetch, save: (_name, value) => void (saved = value) }, issues)).toBe("test-access-FAKE-2");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(`${AUTH}/token`);
    expect(Object.fromEntries(asked[0]!.form)).toMatchObject({ grant_type: "refresh_token", refresh_token: "test-refresh-FAKE-1", client_id: "client-123", resource: SERVER });
    // A rotated sign-in is kept in its place.
    expect(saved).toContain("test-refresh-FAKE-2");
    expect(keyState(v, issues)).toBe("ready");
  });

  test("a server that gives no lasting sign-in: its access token is kept sealed and used until it lapses, then you sign in again", async () => {
    const v = vault();
    let now = 1_000_000;
    const fetch = (async () => Response.json({ access_token: "test-access-FAKE-only", token_type: "Bearer", expires_in: 600 })) as unknown as typeof globalThis.fetch;
    const keep = await finishMcpSignIn({ server: SERVER, authServer: AUTH, metadata: { issuer: AUTH, authorization_endpoint: `${AUTH}/authorize`, token_endpoint: `${AUTH}/token`, response_types_supported: ["code"] }, client: { client_id: "client-123", redirect_uris: [BACK] } }, { code: "c", verifier: "v".repeat(43), redirect: BACK, fetch, now });
    expect(keep).toEqual({ client: "client-123", token: `${AUTH}/token`, resource: SERVER, access: "test-access-FAKE-only", expires: now + 600_000 });
    v.set("issues", writeKeep(keep), pinned);
    forgetAccess("issues");
    expect(await accessToken({ vault: v, now: () => now }, issues)).toBe("test-access-FAKE-only");
    now += 601_000;
    await expect(accessToken({ vault: v, now: () => now }, issues)).rejects.toThrow("sign in again");
  });

  test("a client given a secret renews with it: in the body, or in the header where the server registered it so", async () => {
    for (const basic of [false, true]) {
      const v = vault();
      const asked: { form: URLSearchParams; authorization: string | null }[] = [];
      const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        asked.push({ form: new URLSearchParams(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ access_token: "test-access-FAKE-3", expires_in: 3600 });
      }) as typeof globalThis.fetch;
      const pending = { server: SERVER, authServer: AUTH, metadata: { issuer: AUTH, authorization_endpoint: `${AUTH}/authorize`, token_endpoint: `${AUTH}/token`, response_types_supported: ["code"] }, client: { client_id: "client-123", client_secret: "test-client-secret-FAKE", token_endpoint_auth_method: basic ? "client_secret_basic" : "client_secret_post", redirect_uris: [BACK] } };
      const keep = await finishMcpSignIn(pending, { code: "c", verifier: "v".repeat(43), redirect: BACK, fetch: (async () => Response.json({ access_token: "a", token_type: "Bearer", refresh_token: "test-refresh-FAKE-9", expires_in: 3600 })) as unknown as typeof globalThis.fetch });
      expect(keep).toMatchObject({ client: "client-123", secret: "test-client-secret-FAKE", refresh: "test-refresh-FAKE-9", ...(basic ? { basic: true } : {}) });
      expect("basic" in keep).toBe(basic);
      v.set("issues", writeKeep(keep), pinned);
      forgetAccess("issues");
      expect(await accessToken({ vault: v, fetch }, issues)).toBe("test-access-FAKE-3");
      if (basic) {
        expect(asked[0]!.authorization).toBe(`Basic ${Buffer.from("client-123:test-client-secret-FAKE").toString("base64")}`);
        expect(asked[0]!.form.has("client_secret")).toBe(false);
      } else {
        expect(asked[0]!.authorization).toBeNull();
        expect(asked[0]!.form.get("client_secret")).toBe("test-client-secret-FAKE");
      }
    }
  });

  test("never signed in: says so, and never asks for an app of yours", async () => {
    await expect(accessToken({ vault: vault() }, issues)).rejects.toThrow("isn't signed in yet");
  });
});
