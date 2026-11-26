import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectorView, type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Signing in to a connector as you, end to end over real HTTP: a node, you (the admin token), an agent (an arm token),
 * a stand-in for Google's sign-in and a stand-in mail service. The app you registered is sealed; Google's consent page
 * returns to the node's /oauth/callback, which keeps the sign-in; a call carries a short-lived access token, never the
 * sign-in; signing out forgets it. Every key here is a fake.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "oauth-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };

const root = mkdtempSync(join(tmpdir(), "galahad-oauth-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
let google: ReturnType<typeof Bun.serve>;
let service: ReturnType<typeof Bun.serve>;
let armToken: string;
/** The challenge the consent page was given: the token endpoint takes only the verifier whose hash it is. */
let challenge = "";
const tokenAsks: URLSearchParams[] = [];
const serviceCalls: { auth: string | null }[] = [];

const ACCESS = "test-access-FAKE-0123456789abcdef";
const SIGN_IN = "test-refresh-FAKE-0123456789abcdef";

async function as<T = any>(token: string, name: RouteName, input?: unknown): Promise<{ status: number; body: T }> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  return { status: response.status, body: (await response.json()) as T };
}
const admin = <T = any>(name: RouteName, input?: unknown) => as<T>(home.adminToken(), name, input);
const mailbox = async () => (await admin<{ connectors: ConnectorView[] }>("connectors")).body.connectors.find((c) => c.id === "mailbox")!;

beforeAll(async () => {
  google = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      tokenAsks.push(form);
      if (form.get("grant_type") === "authorization_code") {
        if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const claims = Buffer.from(JSON.stringify({ email: "you@example.com" })).toString("base64url");
        return Response.json({ access_token: ACCESS, refresh_token: SIGN_IN, expires_in: 3600, id_token: `e30.${claims}.sig` });
      }
      if (form.get("refresh_token") !== SIGN_IN) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: ACCESS, expires_in: 3600 });
    },
  });
  service = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      serviceCalls.push({ auth: req.headers.get("authorization") });
      // A service that echoes what it was sent: the token must not come back to anyone.
      return Response.json({ messages: 3, youSent: req.headers.get("authorization") });
    },
  });
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  const ends = `http://127.0.0.1:${google.port}`;
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, oauthEndpoints: { google: { authorize: `${ends}/auth`, token: `${ends}/token` } } });
  armToken = (await admin<{ token: string }>("mintArm", { label: "test-arm" })).body.token;
  const installed = await admin("setConnector", {
    id: "mailbox",
    manifest: {
      id: "mailbox",
      label: "Mailbox",
      origin: `http://127.0.0.1:${service.port}`,
      auth: { secret: "mailbox", scheme: "oauth", oauth: { provider: "google", scopes: ["https://mail.example.test/modify", "openid", "email"] } },
      tools: { inbox: { description: "Your inbox.", method: "GET", path: "/inbox", class: "read" } },
      access: { only: "galahad", allowed: [] },
      private: true,
    },
  });
  expect(installed.status).toBe(200);
});

afterAll(async () => {
  await daemon?.stop();
  google?.stop(true);
  service?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("signing in to a connector as you", () => {
  test("installed, it asks for the app you registered; only a device that may write the vault sets it, and then it's signed out", async () => {
    expect(await mailbox()).toMatchObject({ key: "missing", oauth: { provider: "google", account: null }, private: true });
    expect((await as(armToken, "setOAuthApp", { connector: "mailbox", client: "client-id.apps.example", secret: "test-secret-FAKE" })).status).toBe(403);
    expect((await admin("setOAuthApp", { connector: "mailbox", client: "client-id.apps.example" })).body.error).toBe("Google's web app has a client secret too: give both");
    const set = await admin<{ connector: ConnectorView }>("setOAuthApp", { connector: "mailbox", client: "client-id.apps.example", secret: "test-secret-FAKE" });
    expect(set.status).toBe(200);
    expect(set.body.connector).toMatchObject({ key: "signed-out", oauth: { account: null } });
    // Nothing of the app comes back: not its secret, not its id.
    expect(JSON.stringify(set.body)).not.toContain("test-secret-FAKE");
  });

  test("Google's consent page returns to the node, which keeps the sign-in and says whose it is, on a page that runs nothing", async () => {
    expect((await admin("oauthStart", { connector: "mailbox", redirect: "http://evil.example.test/oauth/callback" })).status).toBe(400);
    const started = await admin<{ flow: string; url: string }>("oauthStart", { connector: "mailbox", redirect: `http://127.0.0.1:${port}/oauth/callback` });
    expect(started.body.flow).toBe("code");
    const page = new URL(started.body.url);
    challenge = page.searchParams.get("code_challenge")!;
    const back = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=${page.searchParams.get("state")}&code=auth-code`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Signed in to Mailbox as you@example.com");
    expect(back.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(back.headers.get("cache-control")).toBe("no-store");
    expect(await mailbox()).toMatchObject({ key: "ready", oauth: { provider: "google", account: "you@example.com" } });
    // Used once: the same return again is refused, and says so.
    const again = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=${page.searchParams.get("state")}&code=auth-code`);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("expired or was already used");
  });

  test("what comes back on the page is text, never markup", async () => {
    const started = await admin<{ url: string }>("oauthStart", { connector: "mailbox", redirect: `http://127.0.0.1:${port}/oauth/callback` });
    const state = new URL(started.body.url).searchParams.get("state")!;
    const back = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=${state}&error=${encodeURIComponent("<script>alert(1)</script>")}`);
    const text = await back.text();
    expect(text).not.toContain("<script>alert");
    expect(text).toContain("&#60;script&#62;");
  });

  test("a call carries a short-lived access token; the sign-in never leaves for the service, and the token never comes back", async () => {
    const before = tokenAsks.length;
    const called = await admin<{ status: string; result: { body: string } }>("callConnector", { connector: "mailbox", tool: "inbox" });
    expect(called.body.status).toBe("done");
    expect(serviceCalls.at(-1)!.auth).toBe(`Bearer ${ACCESS}`);
    expect(called.body.result.body).not.toContain(ACCESS);
    expect(tokenAsks.slice(before).every((form) => form.get("grant_type") === "refresh_token")).toBe(true);
    // Mail is Galahad's alone: another agent asks first.
    expect((await as(armToken, "callConnector", { connector: "mailbox", tool: "inbox" })).status).toBe(403);
  });

  test("signing out forgets the sign-in, keeps the app, and a call then says to sign in", async () => {
    const out = await admin<{ connector: ConnectorView }>("oauthSignOut", { connector: "mailbox" });
    expect(out.body.connector).toMatchObject({ key: "signed-out", oauth: { account: null } });
    const calls = serviceCalls.length;
    const refused = await admin<{ error: string }>("callConnector", { connector: "mailbox", tool: "inbox" });
    expect(refused.status).toBe(424);
    expect(refused.body.error).toContain("isn't signed in yet");
    expect(serviceCalls).toHaveLength(calls);
  });
});
