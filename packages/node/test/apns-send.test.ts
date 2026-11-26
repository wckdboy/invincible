import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { fromB64u, type NotifyPayload, utf8 } from "@galahad/core";
import { APPLE_TOKEN_MS, appleEndpoint, type ApplePushKey, ApplePushSender, appleTarget, readApplePushKey, storedApplePushKey, applePayload } from "../src/apns-send.ts";

/*
 * Sending to the owner's iPhone app through a stand-in for Apple's push service: an HTTP/2 server on loopback that keeps
 * what it was sent and answers as each test tells it. The key is made fresh here for the run: never anyone's.
 */

const TOKEN = "ab".repeat(32);
const PAYLOAD: NotifyPayload = { v: 1, kind: "approval", title: "Approve: GitHub pull request", body: "“Fix the importer”, asked 2 min ago", open: "inbox", tag: "approval-1" };
const DELIVERY = { ttlSeconds: 3600, urgency: "high" as const };

interface Seen {
  headers: http2.IncomingHttpHeaders;
  body: Record<string, any>;
}

let server: ReturnType<typeof http2.createServer>;
let origin = "";
const seen: Seen[] = [];
let answers: { status: number; reason?: string; retryAfter?: number }[] = [];
let key: ApplePushKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // As the secure prompt hands it over: the .p8's text on one line.
  key = { teamId: "TEAM000001", keyId: "KEY0000001", topic: "org.example.galahad", key: `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}${btoa(String.fromCharCode(...der))}${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}` };
  publicKey = pair.publicKey;
  server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (text += chunk));
    stream.on("end", () => {
      seen.push({ headers, body: JSON.parse(text) });
      const answer = answers.shift() ?? { status: 200 };
      stream.respond({ ":status": answer.status, ...(answer.retryAfter ? { "retry-after": String(answer.retryAfter) } : {}) });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
afterEach(() => { seen.length = 0; answers = []; });

function sender(over: { key?: ApplePushKey | null; now?: () => number } = {}) {
  const pauses: number[] = [];
  const made = new ApplePushSender({ key: () => (over.key === undefined ? key : over.key), now: over.now ?? (() => 1_800_000_000_000), sleep: async (ms) => void pauses.push(ms), origins: { development: origin, production: origin } });
  return { sender: made, pauses };
}

const claims = (jwt: string) => jwt.split(".").slice(0, 2).map((part) => JSON.parse(new TextDecoder().decode(fromB64u(part))));
async function signedByKey(jwt: string): Promise<boolean> {
  const [head, body, signature] = jwt.split(".");
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromB64u(signature!) as Uint8Array<ArrayBuffer>, utf8(`${head}.${body}`) as Uint8Array<ArrayBuffer>);
}

describe("a notification to the iPhone app", () => {
  test("goes to the app's own token, signed with the owner's key, as the alert and what a tap opens", async () => {
    const { sender: apple } = sender();
    const outcome = await apple.send({ endpoint: appleEndpoint("production", TOKEN), p256dh: "", auth: "" }, PAYLOAD, DELIVERY);
    expect(outcome).toEqual({ ok: true, gone: false, status: 200, error: null, attempts: 1 });
    const [request] = seen;
    expect(request!.headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(request!.headers["apns-topic"]).toBe("org.example.galahad");
    expect(request!.headers["apns-push-type"]).toBe("alert");
    expect(request!.headers["apns-priority"]).toBe("10");
    expect(request!.headers["apns-expiration"]).toBe(String(1_800_000_000 + 3600));
    const jwt = String(request!.headers.authorization).replace(/^bearer /, "");
    expect(claims(jwt)).toEqual([{ alg: "ES256", kid: "KEY0000001" }, { iss: "TEAM000001", iat: 1_800_000_000 }]);
    expect(await signedByKey(jwt)).toBe(true);
    expect(request!.body).toEqual({
      aps: { alert: { title: PAYLOAD.title, body: PAYLOAD.body }, sound: "default", "interruption-level": "active", "thread-id": "approval" },
      galahad: { v: 1, kind: "approval", open: "inbox", tag: "approval-1" },
    });
    apple.close();
  });

  test("news is passive: no sound, no lighting the screen, held by a Focus or a Scheduled Summary (PLAN #59)", async () => {
    const { sender: apple } = sender();
    const news = { ...PAYLOAD, kind: "finished" as const, title: "Galahad has finished", body: "A chat you left him working in has his answer." };
    await apple.send({ endpoint: appleEndpoint("production", TOKEN), p256dh: "", auth: "" }, news, { ttlSeconds: 3600, urgency: "low" });
    expect(seen[0]!.headers["apns-priority"]).toBe("5");
    expect(seen[0]!.body.aps).toEqual({ alert: { title: news.title, body: news.body }, "interruption-level": "passive", "thread-id": "finished" });
    // A quiet kind is passive whatever the delivery says; what's told now sounds.
    expect(JSON.parse(applePayload({ ...news, kind: "limit" })).aps["interruption-level"]).toBe("passive");
    expect(JSON.parse(applePayload(PAYLOAD, { urgency: "normal" })).aps).toMatchObject({ sound: "default", "interruption-level": "active" });
    apple.close();
  });

  test("an approval told alone carries its buttons: approve and decline, or decline alone for a delete; the action rides with ours", () => {
    const action = "a_1234567890123456789012";
    expect(JSON.parse(applePayload({ ...PAYLOAD, action, approvable: true }))).toEqual({
      aps: { alert: { title: PAYLOAD.title, body: PAYLOAD.body }, sound: "default", "interruption-level": "active", "thread-id": "approval", category: "approval" },
      galahad: { v: 1, kind: "approval", open: "inbox", tag: "approval-1", action },
    });
    expect(JSON.parse(applePayload({ ...PAYLOAD, action, approvable: false })).aps.category).toBe("approval-decline");
    expect(JSON.parse(applePayload(PAYLOAD)).aps.category).toBeUndefined();
  });

  test("anything that looks like a secret never leaves: the general notification goes instead", async () => {
    const { sender: apple } = sender();
    await apple.send({ endpoint: appleEndpoint("production", TOKEN), p256dh: "", auth: "" }, { ...PAYLOAD, body: `sk-ant-api03-${"FAKE".repeat(8)}` }, DELIVERY);
    expect(seen[0]!.body.aps.alert).toEqual({ title: "Galahad", body: "Something needs you. Open the app to see it." });
    apple.close();
  });

  test("its token is made once and used for 50 minutes, then made again", async () => {
    let now = 1_800_000_000_000;
    const { sender: apple } = sender({ now: () => now });
    const target = { endpoint: appleEndpoint("development", TOKEN), p256dh: "", auth: "" };
    await apple.send(target, PAYLOAD, DELIVERY);
    now += APPLE_TOKEN_MS - 1000;
    await apple.send(target, PAYLOAD, DELIVERY);
    now += 2000;
    await apple.send(target, PAYLOAD, DELIVERY);
    const tokens = seen.map((s) => s.headers.authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
    apple.close();
  });

  test("a token Apple no longer knows for the app is gone; a refused key is said, and signed anew next time", async () => {
    const { sender: apple } = sender();
    const target = { endpoint: appleEndpoint("production", TOKEN), p256dh: "", auth: "" };
    answers = [{ status: 410, reason: "Unregistered" }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: true, status: 410, attempts: 1 });
    answers = [{ status: 400, reason: "DeviceTokenNotForTopic" }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: true, status: 400 });
    answers = [{ status: 403, reason: "InvalidProviderToken" }];
    const refused = await apple.send(target, PAYLOAD, DELIVERY);
    expect(refused).toMatchObject({ ok: false, gone: false, status: 403, attempts: 1 });
    expect(refused.error).toContain("InvalidProviderToken");
    expect(refused.error).not.toContain(TOKEN);
    apple.close();
  });

  test("a token Apple's other service made is asked there once, and kept there when it is taken", async () => {
    const { sender: apple } = sender();
    // A TestFlight build that told its node it was a development one: the sandbox doesn't know its token.
    const target = { endpoint: appleEndpoint("development", TOKEN), p256dh: "", auth: "" };
    answers = [{ status: 400, reason: "BadDeviceToken" }, { status: 200 }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toEqual({ ok: true, gone: false, status: 200, error: null, attempts: 2, endpoint: appleEndpoint("production", TOKEN) });
    expect(seen).toHaveLength(2);
    // Unknown on both: gone.
    answers = [{ status: 400, reason: "BadDeviceToken" }, { status: 400, reason: "BadDeviceToken" }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: true, status: 400 });
    // The other service failing otherwise leaves the first answer standing; any other refusal isn't asked again.
    answers = [{ status: 400, reason: "BadDeviceToken" }, { status: 403, reason: "InvalidProviderToken" }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: true, status: 400 });
    seen.length = 0;
    answers = [{ status: 410, reason: "Unregistered" }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: true, status: 410 });
    expect(seen).toHaveLength(1);
    apple.close();
  });

  test("busy or failing: tried again, twice at most, after the pause Apple asks for", async () => {
    const { sender: apple, pauses } = sender();
    const target = { endpoint: appleEndpoint("production", TOKEN), p256dh: "", auth: "" };
    answers = [{ status: 503 }, { status: 200 }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: true, attempts: 2 });
    answers = [{ status: 429, reason: "TooManyRequests", retryAfter: 3 }, { status: 429 }, { status: 429 }, { status: 200 }];
    expect(await apple.send(target, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: false, status: 429, attempts: 3 });
    expect(pauses).toEqual([2000, 3000, 8000]);
    expect(seen).toHaveLength(5);
    apple.close();
  });

  test("with no key on the node, or a subscription that isn't an iPhone's, nothing is sent", async () => {
    const { sender: apple } = sender({ key: null });
    expect((await apple.send({ endpoint: appleEndpoint("production", TOKEN), p256dh: "", auth: "" }, PAYLOAD, DELIVERY)).error).toContain("galahad notify apple-key");
    expect(await apple.send({ endpoint: "https://web.push.apple.com/x", p256dh: "", auth: "" }, PAYLOAD, DELIVERY)).toMatchObject({ ok: false, gone: true });
    expect(seen).toHaveLength(0);
    apple.close();
  });
});

describe("the key and the subscription as kept", () => {
  test("the key round-trips the vault's form, its ID last (what the vault shows), and nothing else reads as a key", () => {
    const stored = storedApplePushKey(key);
    expect(stored.endsWith("\nKEY0000001")).toBe(true);
    expect(readApplePushKey(stored)).toEqual(key);
    for (const bad of [null, "", "{}", JSON.stringify(key), `${JSON.stringify({ teamId: "T", topic: "t", key: "k" })}\nnot-an-id`]) expect(readApplePushKey(bad)).toBeNull();
  });
  test("an iPhone's endpoint names Apple's service and the token, and only Apple's two", () => {
    expect(appleTarget(appleEndpoint("development", TOKEN))).toEqual({ environment: "development", token: TOKEN });
    for (const bad of [`apns:staging:${TOKEN}`, `apns:production:${TOKEN.toUpperCase()}`, "apns:production:abc", "https://api.push.apple.com/3/device/x"]) expect(appleTarget(bad)).toBeNull();
  });
});
