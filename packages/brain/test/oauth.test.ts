import { beforeEach, describe, expect, test } from "bun:test";
import { ConnectorManifest, newNodeIdentity } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import { accessToken, authFor, forgetAccess, keyState, readKeep, sendConnectorRequest, writeKeep } from "../src/index.ts";

/*
 * Signing in to a service as you (oauth.ts): the vault keeps the app you registered and, once you've signed in, the
 * sign-in; a call carries a short-lived access token the node trades the sign-in for, never the sign-in itself, and
 * an agent never sees either. A stand-in for the provider's token endpoint answers here.
 */

function vault() {
  const identity = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  return new Vault(store, identity);
}

const mail = (provider: "google" | "microsoft" = "google") =>
  ConnectorManifest.parse({
    id: "mailbox",
    label: "Mailbox",
    origin: "https://mail.example.test",
    auth: { secret: "mailbox", scheme: "oauth", oauth: { provider, scopes: ["mail.read", "offline_access"] } },
    tools: { inbox: { description: "Your inbox.", method: "GET", path: "/inbox", class: "read" } },
    access: { only: "galahad", allowed: [] },
    private: true,
  });

const TOKEN = "https://login.example.test/token";
const endpoints = { google: { token: TOKEN }, microsoft: { token: TOKEN } };
const pinned = { origin: "https://mail.example.test", provider: "mailbox" };
// Fakes, made for these tests: nothing here is anyone's sign-in.
const SIGN_IN = "test-refresh-FAKE-0001";

/** A stand-in provider: its token endpoint, and the mail service behind it. */
function provider(answer: (form: URLSearchParams) => Response = () => Response.json({ access_token: "test-access-FAKE-one", expires_in: 3600 })) {
  const asked: URLSearchParams[] = [];
  const calls: Request[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    if (req.url === TOKEN) {
      const form = new URLSearchParams(await req.text());
      asked.push(form);
      return answer(form);
    }
    calls.push(req);
    return Response.json({ messages: 2, echo: req.headers.get("authorization") });
  }) as typeof globalThis.fetch;
  return { fetch, asked, calls };
}

beforeEach(() => forgetAccess("mailbox"));

describe("what the vault keeps for a connector that signs in", () => {
  test("reads back as written, and the vault's plaintext hint holds none of a token", () => {
    const keep = { client: "client-id.apps.example", secret: "test-client-secret-FAKE", refresh: SIGN_IN, account: "you@example.com" };
    expect(readKeep(writeKeep(keep))).toEqual(keep);
    const v = vault();
    v.set("mailbox", writeKeep(keep), pinned);
    // The hint is a value's last four characters: the keep ends with its version, so they're `":1}`.
    expect(v.info("mailbox")!.hint).toBe('…":1}');
    expect(readKeep("not json")).toBeNull();
    expect(readKeep('{"client":""}')).toBeNull();
    expect(readKeep('{"client":"c","refresh":5}')).toEqual({ client: "c" });
  });

  test("its key state: missing with nothing, signed-out with the app alone, ready signed in, and never used pinned elsewhere", () => {
    const v = vault();
    expect(keyState(v, mail())).toBe("missing");
    v.set("mailbox", writeKeep({ client: "c", secret: "s" }), pinned);
    expect(keyState(v, mail())).toBe("signed-out");
    v.set("mailbox", writeKeep({ client: "c", secret: "s", refresh: SIGN_IN }), pinned);
    expect(keyState(v, mail())).toBe("ready");
    v.set("mailbox", writeKeep({ client: "c", secret: "s", refresh: SIGN_IN }), { ...pinned, origin: "https://elsewhere.example.test" });
    expect(keyState(v, mail())).toBe("wrong-origin");
  });

  test("it is never put on a call as a key: what goes is an access token", () => {
    const v = vault();
    v.set("mailbox", writeKeep({ client: "c", secret: "s", refresh: SIGN_IN }), pinned);
    expect(() => authFor(v, mail())).toThrow(/signs in/);
  });
});

describe("a call to a connector that signs in", () => {
  test("carries an access token got with the sign-in and kept until it nearly expires; the sign-in never goes to the service", async () => {
    const v = vault();
    v.set("mailbox", writeKeep({ client: "client-id", secret: "test-client-secret-FAKE", refresh: SIGN_IN }), pinned);
    const p = provider();
    let now = 1_000_000;
    const ctx = { vault: v, fetch: p.fetch, oauth: { endpoints, now: () => now } };
    const request = { kind: "http" as const, method: "GET" as const, url: "https://mail.example.test/inbox", headers: {}, class: "read" as const, target: "GET /inbox" };
    const first = await sendConnectorRequest(ctx, mail(), request);
    expect(p.calls[0]!.headers.get("authorization")).toBe("Bearer test-access-FAKE-one");
    // The access token echoed back is redacted like any key.
    expect(first.body).not.toContain("test-access-FAKE-one");
    // Google's refresh carries the app's secret, and the sign-in goes to the provider alone.
    expect(Object.fromEntries(p.asked[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: SIGN_IN, client_id: "client-id", client_secret: "test-client-secret-FAKE" });
    expect(p.calls.some((c) => JSON.stringify([...c.headers]).includes(SIGN_IN))).toBe(false);
    await sendConnectorRequest(ctx, mail(), request);
    expect(p.asked).toHaveLength(1);
    // A minute before it expires, a new one.
    now += 3600_000 - 30_000;
    await sendConnectorRequest(ctx, mail(), request);
    expect(p.asked).toHaveLength(2);
  });

  test("Microsoft's refresh names its scopes and has no secret; a sign-in the provider rotates is kept, sealed and pinned as before", async () => {
    const v = vault();
    v.set("mailbox", writeKeep({ client: "public-client", refresh: SIGN_IN, account: "you@example.com" }), pinned);
    const p = provider(() => Response.json({ access_token: "test-access-FAKE-two", refresh_token: "test-refresh-FAKE-0002", expires_in: 3600 }));
    const kept: { name: string; value: string }[] = [];
    const token = await accessToken({ vault: v, fetch: p.fetch, endpoints, save: (name, value) => kept.push({ name, value }) }, mail("microsoft"));
    expect(token).toBe("test-access-FAKE-two");
    expect(Object.fromEntries(p.asked[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: SIGN_IN, client_id: "public-client", scope: "mail.read offline_access" });
    expect(kept).toHaveLength(1);
    expect(readKeep(kept[0]!.value)).toEqual({ client: "public-client", refresh: "test-refresh-FAKE-0002", account: "you@example.com" });
  });

  test("an ended sign-in says to sign in again; with no sign-in yet, or no app, it says what's missing; nothing is sent", async () => {
    const v = vault();
    const p = provider(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const ctx = { vault: v, fetch: p.fetch, oauth: { endpoints } };
    const request = { kind: "http" as const, method: "GET" as const, url: "https://mail.example.test/inbox", headers: {}, class: "read" as const, target: "GET /inbox" };
    await expect(sendConnectorRequest(ctx, mail(), request)).rejects.toThrow("Mailbox needs the app you registered: its client id");
    v.set("mailbox", writeKeep({ client: "c", secret: "s" }), pinned);
    await expect(sendConnectorRequest(ctx, mail(), request)).rejects.toThrow("Mailbox isn't signed in yet: sign in from its card in Connectors");
    v.set("mailbox", writeKeep({ client: "c", secret: "s", refresh: SIGN_IN }), pinned);
    await expect(sendConnectorRequest(ctx, mail(), request)).rejects.toThrow("Mailbox's sign-in has ended: sign in again from its card in Connectors");
    v.set("mailbox", writeKeep({ client: "c", secret: "s", refresh: SIGN_IN }), { ...pinned, origin: "https://elsewhere.example.test" });
    await expect(sendConnectorRequest(ctx, mail(), request)).rejects.toThrow(/pinned to another origin/);
    expect(p.calls).toHaveLength(0);
  });
});
