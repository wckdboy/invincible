import { b64u, concat, fromB64u, type NotifyPayload, readNotifyPayload, readVapidToken, utf8 } from "@galahad/core";

/*
 * Stand-ins for the two things a node's notifications reach, for tests that must never
 * contact a real push service:
 *
 *  - a browser: a WebCrypto ECDH key pair and an authentication secret, as
 *    `pushManager.subscribe()` makes them, and the decryption a browser does (RFC 8291),
 *    on WebCrypto, sharing no code with the node's own encryption;
 *  - a push service on localhost: it takes the POST, checks what a real one checks (the
 *    VAPID token under the key it names, for this service's own origin; the encoding),
 *    keeps what arrived, and answers as it's told to (201, 410, 429, 500).
 */

type Bytes = Uint8Array;
const buf = (bytes: Bytes): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, key, length * 8));
}

export interface Delivery {
  /** The payload as the browser decrypted it. */
  payload: NotifyPayload | null;
  /** The decrypted text, whatever it was. */
  text: string;
  /** The bytes as the push service carried them. */
  body: Bytes;
  headers: { authorization: string; ttl: string | null; urgency: string | null; encoding: string | null; topic: string | null };
  /** The VAPID claims, verified under the key the request named. */
  vapid: { aud: string; exp: number; sub: string; key: string } | null;
}

export interface StandInBrowser {
  name: string;
  /** What the page would POST to the node: `PushSubscription.toJSON()`. */
  subscription: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
  /** Everything that reached this browser, in order (a 201 answer only). */
  received: Delivery[];
  /** How the push service answers the next requests for this browser (default 201). */
  answers: { status: number; retryAfter?: string }[];
  /** Every request made for it, whatever the answer. */
  requests: number;
}

export interface StandInPushService {
  origin: string;
  /** A new browser subscribed at this service. */
  browser(name: string): Promise<StandInBrowser>;
  /** Every path asked for, in order. */
  paths: string[];
  stop(): void;
}

/** `now`: the service's clock (a test that moves the node's clock moves this one with it: a token must be current here). */
export function standInPushService(now: () => number = Date.now): StandInPushService {
  const browsers = new Map<string, { view: StandInBrowser; privateKey: CryptoKey; p256dh: Bytes; auth: Bytes }>();
  const paths: string[] = [];

  async function decrypt(body: Bytes, to: { privateKey: CryptoKey; p256dh: Bytes; auth: Bytes }): Promise<string> {
    const salt = body.slice(0, 16);
    const idLength = body[20]!;
    const senderPublic = body.slice(21, 21 + idLength);
    const ciphertext = body.slice(21 + idLength);
    const sender = await crypto.subtle.importKey("raw", buf(senderPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, to.privateKey, 256));
    const ikm = await hkdf(to.auth, shared, concat(utf8("WebPush: info\0"), to.p256dh, senderPublic), 32);
    const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["decrypt"]);
    const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(ciphertext)));
    let end = record.length - 1;
    while (end >= 0 && record[end] === 0) end -= 1;
    if (record[end] !== 0x02) throw new Error("no last-record delimiter");
    return new TextDecoder().decode(record.slice(0, end));
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      paths.push(url.pathname);
      const browser = browsers.get(url.pathname);
      if (req.method !== "POST" || !browser) return new Response("no such subscription", { status: 404 });
      browser.view.requests += 1;
      const body = new Uint8Array(await req.arrayBuffer());
      const answer = browser.view.answers.shift() ?? { status: 201 };
      if (answer.status < 200 || answer.status >= 300) return new Response(null, { status: answer.status, headers: answer.retryAfter ? { "retry-after": answer.retryAfter } : {} });
      const authorization = req.headers.get("authorization") ?? "";
      const match = /^vapid t=([A-Za-z0-9._-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
      const claims = match ? readVapidToken(match[1]!, fromB64u(match[2]!)) : null;
      // What a real push service refuses: no VAPID, a token for another service, an expired one, another encoding.
      if (!claims || claims.aud !== url.origin || claims.exp * 1000 < now() || claims.exp * 1000 > now() + 24 * 3600_000 + 60_000) return new Response(null, { status: 403 });
      if (req.headers.get("content-encoding") !== "aes128gcm") return new Response(null, { status: 400 });
      let text: string;
      try {
        text = await decrypt(body, browser);
      } catch {
        return new Response(null, { status: 400 });
      }
      let payload: NotifyPayload | null = null;
      try {
        payload = readNotifyPayload(JSON.parse(text));
      } catch {
        payload = null;
      }
      browser.view.received.push({
        payload,
        text,
        body,
        headers: { authorization, ttl: req.headers.get("ttl"), urgency: req.headers.get("urgency"), encoding: req.headers.get("content-encoding"), topic: req.headers.get("topic") },
        vapid: { ...claims, key: match![2]! },
      });
      return new Response(null, { status: answer.status });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    paths,
    async browser(name) {
      const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
      const auth = crypto.getRandomValues(new Uint8Array(16));
      // Like a real endpoint: a long random token in the path, which is the capability.
      const path = `/push/${name}-${b64u(crypto.getRandomValues(new Uint8Array(24)))}`;
      const view: StandInBrowser = { name, subscription: { endpoint: `${origin}${path}`, expirationTime: null, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } }, received: [], answers: [], requests: 0 };
      browsers.set(path, { view, privateKey: keys.privateKey, p256dh, auth });
      return view;
    },
    stop: () => void server.stop(true),
  };
}
