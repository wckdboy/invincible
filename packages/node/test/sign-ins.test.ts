import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readKeep, writeKeep } from "@galahad/brain";
import { ConnectorManifest, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { callbackOf, emailFrom, SignInError, SignIns } from "../src/sign-ins.ts";

/*
 * Signing in to a connector as you (sign-ins.ts), against stand-ins for Google's and Microsoft's endpoints: Google's
 * consent page with PKCE and a state used once, its return traded for a lasting sign-in; Microsoft's code you type,
 * asked for at the pace it sets. Nothing waits after the node stops, and every key here is a fake.
 */

const ENDS = {
  google: { authorize: "https://accounts.example.test/auth", token: "https://accounts.example.test/token" },
  microsoft: { device: "https://login.example.test/devicecode", token: "https://login.example.test/token" },
};

const manifest = (id: string, provider: "google" | "microsoft") =>
  ConnectorManifest.parse({
    id,
    label: provider === "google" ? "Gmail" : "Outlook",
    origin: provider === "google" ? "https://gmail.example.test" : "https://graph.example.test",
    auth: { secret: id, scheme: "oauth", oauth: { provider, scopes: provider === "google" ? ["https://mail.example.test/modify", "openid", "email"] : ["Mail.ReadWrite", "offline_access", "openid"] } },
    tools: { inbox: { description: "Your inbox.", method: "GET", path: "/inbox", class: "read" } },
    access: { only: "galahad", allowed: [] },
    private: true,
  });

// Two things asked of Google, each with a box of its own on its page.
const drive = ConnectorManifest.parse({
  id: "drive",
  label: "Google Drive",
  origin: "https://drive.example.test",
  auth: { secret: "drive", scheme: "oauth", oauth: { provider: "google", scopes: ["https://drive.example.test/drive.readonly", "https://drive.example.test/drive.file", "openid", "email"] } },
  tools: { files: { description: "Your files.", method: "GET", path: "/files", class: "read" } },
  access: { only: "galahad", allowed: [] },
  private: true,
});

/** An ID token as a provider's token endpoint gives one (unsigned here: it is read, never trusted for more). */
const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function rig(answer: (url: string, form: URLSearchParams) => Response) {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const manifests = { gmail: manifest("gmail", "google"), outlook: manifest("outlook", "microsoft"), drive };
  const asked: { url: string; form: URLSearchParams }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body ?? ""));
    asked.push({ url, form });
    return answer(url, form);
  }) as typeof globalThis.fetch;
  const slept: number[] = [];
  const said: string[] = [];
  let now = 1_763_200_000_000;
  const signIns = new SignIns({
    vault,
    manifest: (id) => (manifests as Record<string, ConnectorManifest>)[id] ?? null,
    fetch,
    endpoints: ENDS,
    log: (line) => said.push(line),
    now: () => now,
    // The pace it was asked to keep, recorded; the wait itself a moment, so the test's own timers run too.
    sleep: async (ms) => {
      slept.push(ms);
      await Bun.sleep(1);
    },
  });
  const keep = (id: string) => (vault.has(id) ? readKeep(vault.reveal(id)) : null);
  return { vault, signIns, asked, slept, said, keep, later: (ms: number) => (now += ms) };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};

describe("the app you registered", () => {
  test("Google's takes its secret too; a new client id ends the sign-in it had, the same one keeps it; it's pinned like any key", () => {
    const r = rig(() => new Response("{}"));
    expect(() => r.signIns.setApp("gmail", "client-id.apps.example")).toThrow(SignInError);
    r.signIns.setApp("gmail", "client-id.apps.example", "test-secret-FAKE");
    expect(r.vault.info("gmail")).toMatchObject({ origin: "https://gmail.example.test", provider: "gmail" });
    r.vault.set("gmail", writeKeep({ client: "client-id.apps.example", secret: "test-secret-FAKE", refresh: "test-refresh-FAKE", account: "you@example.com" }), { origin: "https://gmail.example.test", provider: "gmail" });
    r.signIns.setApp("gmail", "client-id.apps.example", "test-secret-FAKE-2");
    expect(r.keep("gmail")).toEqual({ client: "client-id.apps.example", secret: "test-secret-FAKE-2", refresh: "test-refresh-FAKE", account: "you@example.com" });
    r.signIns.setApp("gmail", "another-client", "test-secret-FAKE-3");
    expect(r.keep("gmail")).toEqual({ client: "another-client", secret: "test-secret-FAKE-3" });
    // Microsoft's public client has no secret.
    r.signIns.setApp("outlook", "public-client-id");
    expect(r.keep("outlook")).toEqual({ client: "public-client-id" });
    expect(() => r.signIns.setApp("nothing", "x")).toThrow("nothing isn't installed");
  });
});

describe("Google: its consent page, and its return", () => {
  test("the page asks with PKCE (S256), a state, offline access each time, and returns only to your app's /oauth/callback", async () => {
    const r = rig(() => new Response("{}"));
    await expect(r.signIns.start("gmail", "https://keep.example.test/oauth/callback")).rejects.toThrow("Gmail needs the app you registered first: its client id and secret");
    r.signIns.setApp("gmail", "client-id.apps.example", "test-secret-FAKE");
    await expect(r.signIns.start("gmail", undefined)).rejects.toThrow(/give the address Google returns to/);
    for (const wrong of ["http://keep.example.test/oauth/callback", "https://keep.example.test/elsewhere", "https://keep.example.test/oauth/callback?x=1", "not a url"]) {
      expect(() => callbackOf(wrong)).toThrow(SignInError);
    }
    expect(callbackOf("http://localhost:7778/oauth/callback")).toBe("http://localhost:7778/oauth/callback");
    const started = await r.signIns.start("gmail", "https://keep.example.test/oauth/callback");
    expect(started.flow).toBe("code");
    const url = new URL((started as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(ENDS.google.authorize);
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => !["state", "code_challenge"].includes(k)))).toEqual({
      client_id: "client-id.apps.example",
      redirect_uri: "https://keep.example.test/oauth/callback",
      response_type: "code",
      scope: "https://mail.example.test/modify openid email",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("its return is traded with the verifier for a lasting sign-in, kept with whose it is; a state works once, and an error keeps nothing", async () => {
    let challenge = "";
    const r = rig((url, form) => {
      if (url !== ENDS.google.token) return new Response("{}", { status: 404 });
      // The verifier is the one whose hash the page was given: only the device that started the sign-in holds it.
      if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (form.get("code") === "no-lasting") return Response.json({ access_token: "test-access-FAKE", expires_in: 3600 });
      return Response.json({ access_token: "test-access-FAKE", refresh_token: "test-refresh-FAKE-google", expires_in: 3600, id_token: idToken({ email: "you@example.com" }) });
    });
    r.signIns.setApp("gmail", "client-id.apps.example", "test-secret-FAKE");
    const begin = async () => {
      const url = new URL(((await r.signIns.start("gmail", "https://keep.example.test/oauth/callback")) as { url: string }).url);
      challenge = url.searchParams.get("code_challenge")!;
      return url.searchParams.get("state")!;
    };
    const state = await begin();
    const back = await r.signIns.callback(new URLSearchParams({ state, code: "auth-code" }));
    expect(back).toEqual({ ok: true, message: "Signed in to Gmail as you@example.com. You can close this page and go back to Galahad." });
    expect(Object.fromEntries(r.asked.at(-1)!.form)).toMatchObject({ grant_type: "authorization_code", code: "auth-code", redirect_uri: "https://keep.example.test/oauth/callback", client_id: "client-id.apps.example", client_secret: "test-secret-FAKE" });
    expect(r.keep("gmail")).toMatchObject({ refresh: "test-refresh-FAKE-google", account: "you@example.com" });
    expect(await r.signIns.callback(new URLSearchParams({ state, code: "auth-code" }))).toMatchObject({ ok: false, message: expect.stringMatching(/expired or was already used/) });
    // Turned down at Google: nothing is asked of its token endpoint, and nothing changes.
    const asked = r.asked.length;
    expect(await r.signIns.callback(new URLSearchParams({ state: await begin(), error: "access_denied" }))).toEqual({ ok: false, message: "Google said access_denied. Nothing was kept." });
    expect(r.asked).toHaveLength(asked);
    expect(await r.signIns.callback(new URLSearchParams({ state: await begin(), code: "no-lasting" }))).toMatchObject({ ok: false, message: expect.stringMatching(/no lasting sign-in/) });
    // Ten minutes is how long a started sign-in waits.
    const stale = await begin();
    r.later(10 * 60_000 + 1);
    expect(await r.signIns.callback(new URLSearchParams({ state: stale, code: "auth-code" }))).toMatchObject({ ok: false, message: expect.stringMatching(/expired/) });
    expect(r.keep("gmail")).toMatchObject({ refresh: "test-refresh-FAKE-google" });
  });

  test("what Google allowed is held to what was asked: a box left unticked is said, and a sign-in that allows none of it isn't kept", async () => {
    let allowed = "";
    const r = rig(() => Response.json({ access_token: "test-access-FAKE", refresh_token: "test-refresh-FAKE-google", expires_in: 3600, scope: allowed, id_token: idToken({ email: "you@example.com" }) }));
    r.signIns.setApp("drive", "client-id.apps.example", "test-secret-FAKE");
    const back = async (scope: string) => {
      allowed = scope;
      const url = new URL(((await r.signIns.start("drive", "https://keep.example.test/oauth/callback")) as { url: string }).url);
      return r.signIns.callback(new URLSearchParams({ state: url.searchParams.get("state")!, code: "auth-code" }));
    };
    expect(await back("openid https://www.googleapis.com/auth/userinfo.email")).toEqual({ ok: false, message: "Google allowed none of what Google Drive asks for (drive.readonly, drive.file). Sign in again and tick each box. Nothing was kept." });
    expect(r.keep("drive")).toEqual({ client: "client-id.apps.example", secret: "test-secret-FAKE" });
    expect(await back("https://drive.example.test/drive.file openid")).toEqual({ ok: true, message: "Signed in to Google Drive as you@example.com, but without drive.readonly: sign in again and tick its box to give it. You can close this page and go back to Galahad." });
    expect(r.keep("drive")).toMatchObject({ refresh: "test-refresh-FAKE-google", account: "you@example.com" });
    expect(await back("https://drive.example.test/drive.readonly https://drive.example.test/drive.file openid")).toEqual({ ok: true, message: "Signed in to Google Drive as you@example.com. You can close this page and go back to Galahad." });
    expect(r.said).toEqual(["signed in to drive, without drive.readonly", "signed in to drive"]);
  });
});

describe("Microsoft: a code you type at its page", () => {
  test("the node asks at the pace it sets, slower when told to, until you've typed it; then the sign-in is kept with whose it is", async () => {
    let tries = 0;
    const r = rig((url, form) => {
      if (url === ENDS.microsoft.device) {
        expect(Object.fromEntries(form)).toEqual({ client_id: "public-client-id", scope: "Mail.ReadWrite offline_access openid" });
        return Response.json({ device_code: "device-code-FAKE", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.example.test/devicelogin", expires_in: 900, interval: 5 });
      }
      expect(Object.fromEntries(form)).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "public-client-id", device_code: "device-code-FAKE" });
      tries++;
      if (tries === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      if (tries === 2) return Response.json({ error: "slow_down" }, { status: 400 });
      return Response.json({ access_token: "test-access-FAKE", refresh_token: "test-refresh-FAKE-ms", expires_in: 3600, id_token: idToken({ preferred_username: "you@work.example.com" }) });
    });
    r.signIns.setApp("outlook", "public-client-id");
    const started = await r.signIns.start("outlook", undefined);
    expect(started).toMatchObject({ flow: "device", code: "ABCD-EFGH", url: "https://microsoft.example.test/devicelogin" });
    await until(() => r.keep("outlook")?.refresh === "test-refresh-FAKE-ms");
    expect(r.keep("outlook")).toEqual({ client: "public-client-id", refresh: "test-refresh-FAKE-ms", account: "you@work.example.com" });
    expect(r.slept).toEqual([5000, 5000, 10_000]);
    expect(r.signIns.waitingFor("outlook")).toBe(false);
    expect(r.said).toContain("signed in to outlook");
  });

  test("signing out stops the asking and forgets the sign-in; the app stays. A code not typed in time lapses", async () => {
    const r = rig((url) =>
      url === ENDS.microsoft.device
        ? Response.json({ device_code: "device-code-FAKE", user_code: "WXYZ-1234", expires_in: 900, interval: 1 })
        : Response.json({ error: "authorization_pending" }, { status: 400 }),
    );
    r.vault.set("outlook", writeKeep({ client: "public-client-id", refresh: "test-refresh-FAKE-old", account: "you@work.example.com" }), { origin: "https://graph.example.test", provider: "outlook" });
    await r.signIns.start("outlook", undefined);
    await until(() => r.asked.length >= 3);
    expect(r.signIns.waitingFor("outlook")).toBe(true);
    r.signIns.signOut("outlook");
    expect(r.signIns.waitingFor("outlook")).toBe(false);
    expect(r.keep("outlook")).toEqual({ client: "public-client-id" });
    // Started again and left: past its fifteen minutes it ends, said in the log.
    await r.signIns.start("outlook", undefined);
    r.later(900_000);
    await until(() => !r.signIns.waitingFor("outlook"));
    expect(r.said.at(-1)).toBe("outlook sign-in lapsed: the code wasn't entered in time");
  });

  test("a client id Microsoft won't start a sign-in for is said plainly", async () => {
    const r = rig(() => Response.json({ error: "unauthorized_client" }, { status: 400 }));
    r.signIns.setApp("outlook", "public-client-id");
    await expect(r.signIns.start("outlook", undefined)).rejects.toThrow("Microsoft didn't start a sign-in (unauthorized_client): check the app's client id, and that it allows public client flows");
  });
});

test("whose account it is comes from the ID token's email, preferred username or UPN, and only when it is an address", () => {
  expect(emailFrom(idToken({ email: "you@example.com" }))).toBe("you@example.com");
  expect(emailFrom(idToken({ preferred_username: "you@work.example.com" }))).toBe("you@work.example.com");
  expect(emailFrom(idToken({ upn: "you@corp.example.com" }))).toBe("you@corp.example.com");
  expect(emailFrom(idToken({ preferred_username: "not an address" }))).toBeNull();
  expect(emailFrom("garbage")).toBeNull();
  expect(emailFrom(undefined)).toBeNull();
});
