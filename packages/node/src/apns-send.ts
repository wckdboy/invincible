import http2 from "node:http2";
import { b64u, findSecrets, GENERIC_NOTIFICATION, isQuietKind, type NotifyPayload, readNotifyPayload, sha256Bytes, utf8 } from "@galahad/core";
import type { PushDelivery, PushOutcome, PushTarget } from "./push-send.ts";

/*
 * Sending one notification to the owner's iPhone app, through Apple's push service (APNs): outward traffic the owner
 * chose, as a browser's is (push-send.ts).
 *
 *  - The only hosts called are Apple's two push services: the one the app's own build answers to (`development` for a
 *    build from Xcode, `production` for TestFlight and the App Store), whatever else a subscription might say.
 *  - The node proves itself with its owner's Apple push key (a .p8 from their developer account), sealed in the vault
 *    and pinned to Apple's push service, read here and nowhere else. It signs a short token with it (ES256), made again
 *    every 50 minutes: APNs takes one that is less than an hour old and refuses one renewed too often.
 *  - The payload gets the same last look as a browser's: a payload of ours with nothing that looks like a secret, or
 *    else the general one. What a tap may open is core's fixed list.
 *  - Apple busy (429) or failing (5xx): tried again, twice at most. A token Apple no longer knows for this app (410, or
 *    400 BadDeviceToken or DeviceTokenNotForTopic) is gone.
 *  - Nothing here logs or returns a device token or the key.
 */

export const APPLE_PUSH = { development: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" } as const;
export type ApplePushEnvironment = keyof typeof APPLE_PUSH;
/** The vault's name for the owner's Apple push key. */
export const APPLE_PUSH_SECRET = "apple-push";
export const APPLE_PUSH_TIMEOUT_MS = 10_000;
/** A token is used for 50 minutes, then made again (Apple: at most an hour old, and not renewed more than every 20). */
export const APPLE_TOKEN_MS = 50 * 60_000;
const RETRY_MS = [2_000, 8_000] as const;
const GONE = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const KEY_REFUSED = new Set(["InvalidProviderToken", "ExpiredProviderToken", "MissingProviderToken"]);

/** How an iPhone's subscription is kept beside browsers' (notify-store.ts): its endpoint names Apple's service and the token. */
export const appleEndpoint = (environment: ApplePushEnvironment, token: string): string => `apns:${environment}:${token}`;
export function appleTarget(endpoint: string): { environment: ApplePushEnvironment; token: string } | null {
  const found = /^apns:(development|production):([0-9a-f]{64,200})$/.exec(endpoint);
  return found ? { environment: found[1] as ApplePushEnvironment, token: found[2]! } : null;
}

/** The owner's Apple push key, as the vault keeps it: their team, the key's id, the app it may notify, and the key (PEM). */
export interface ApplePushKey {
  teamId: string;
  keyId: string;
  topic: string;
  key: string;
}

/** The key as the vault keeps it: its JSON, then its ID on a line of its own (the vault shows a secret's last four characters). */
export const storedApplePushKey = (key: ApplePushKey): string => `${JSON.stringify({ teamId: key.teamId, topic: key.topic, key: key.key })}\n${key.keyId}`;

/** The key as stored, read back strictly: anything else is no key at all. */
export function readApplePushKey(stored: string | null): ApplePushKey | null {
  if (!stored) return null;
  const cut = stored.lastIndexOf("\n");
  try {
    const value = JSON.parse(stored.slice(0, cut)) as Partial<ApplePushKey>;
    const keyId = stored.slice(cut + 1);
    if (cut > 0 && /^[A-Z0-9]{10}$/.test(keyId) && typeof value.teamId === "string" && typeof value.topic === "string" && typeof value.key === "string") return { teamId: value.teamId, keyId, topic: value.topic, key: value.key };
  } catch {}
  return null;
}

const pemBytes = (pem: string): Uint8Array => Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));

/** A provider token for APNs: an ES256 JWT naming the key and the team, issued at `issuedAt` (seconds). */
export async function appleProviderToken(key: ApplePushKey, issuedAt: number): Promise<string> {
  const signer = await crypto.subtle.importKey("pkcs8", pemBytes(key.key) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = `${b64u(utf8(JSON.stringify({ alg: "ES256", kid: key.keyId })))}.${b64u(utf8(JSON.stringify({ iss: key.teamId, iat: issuedAt })))}`;
  return `${head}.${b64u(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, utf8(head) as Uint8Array<ArrayBuffer>)))}`;
}

/** The notification's buttons, as the app registers them: an approval answered there (approve and decline), or declined. */
export const APPLE_CATEGORY = { approve: "approval", decline: "approval-decline" } as const;

/**
 * What the iPhone app is sent: Apple's part (the alert, how it interrupts, the thread it joins, the buttons it shows) and
 * ours (what a tap opens, and an approval's action for its buttons). An iPhone shows the same buttons on its Watch.
 * What's told now is `active`, with the default sound; news (`urgency` low, or a quiet kind) is `passive`, with none:
 * iOS shows it in the list without lighting the screen or sounding, and a Focus or a Scheduled Summary holds it.
 */
export function applePayload(payload: NotifyPayload, delivery?: Pick<PushDelivery, "urgency">): string {
  const category = payload.action ? (payload.approvable ? APPLE_CATEGORY.approve : APPLE_CATEGORY.decline) : null;
  const quiet = delivery?.urgency === "low" || isQuietKind(payload.kind);
  return JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, ...(quiet ? {} : { sound: "default" }), "interruption-level": quiet ? "passive" : "active", "thread-id": payload.kind, ...(category ? { category } : {}) },
    galahad: { v: 1, kind: payload.kind, open: payload.open, tag: payload.tag, ...(payload.conversation ? { conversation: payload.conversation } : {}), ...(payload.action ? { action: payload.action } : {}) },
  });
}

export interface ApplePushOptions {
  /** The key, read from the vault when it is needed; null: none was added (`galahad notify apple-key`). */
  key: () => ApplePushKey | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where each of Apple's services is reached: tests point them at a stand-in. Apple's own, otherwise. */
  origins?: Partial<Record<ApplePushEnvironment, string>>;
}

interface Answer {
  status: number;
  reason: string | null;
  retryAfterMs: number | null;
}

export class ApplePushSender {
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private token: { keyId: string; teamId: string; value: string; madeAt: number } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: ApplePushOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /** The token for this key, made again once it is 50 minutes old (or Apple refused it). */
  private async authorization(key: ApplePushKey): Promise<string> {
    const now = this.now();
    if (!this.token || this.token.keyId !== key.keyId || this.token.teamId !== key.teamId || now - this.token.madeAt >= APPLE_TOKEN_MS) {
      this.token = { keyId: key.keyId, teamId: key.teamId, value: await appleProviderToken(key, Math.floor(now / 1000)), madeAt: now };
    }
    return this.token.value;
  }

  /** One connection a service, kept for the next notification (as Apple asks), and never what keeps the node running. */
  private session(origin: string): http2.ClientHttp2Session {
    let session = this.sessions.get(origin);
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(origin);
      // A connection that fails fails its request; the next notification connects again.
      session.on("error", () => {});
      session.unref();
      this.sessions.set(origin, session);
    }
    return session;
  }

  private ask(origin: string, headers: http2.OutgoingHttpHeaders, body: string, signal?: AbortSignal): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      let request: http2.ClientHttp2Stream;
      try {
        request = this.session(origin).request(headers);
      } catch (error) {
        return reject(error);
      }
      let status = 0;
      let retryAfterMs: number | null = null;
      let text = "";
      const cancel = (why: string) => { request.close(http2.constants.NGHTTP2_CANCEL); finish(); reject(new Error(why)); };
      const onAbort = () => cancel("aborted");
      const timer = setTimeout(() => cancel("timed out"), APPLE_PUSH_TIMEOUT_MS);
      // (The signal outlives every notification: what one request hangs on it, it takes off again.)
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("response", (h) => {
        status = Number(h[":status"]);
        const after = Number(h["retry-after"]);
        if (Number.isFinite(after) && after > 0) retryAfterMs = Math.min(30_000, after * 1000);
      });
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { if (text.length < 4096) text += chunk; });
      request.on("end", () => {
        finish();
        let reason: string | null = null;
        try {
          const said = JSON.parse(text) as { reason?: unknown };
          if (typeof said.reason === "string") reason = said.reason.slice(0, 64);
        } catch {}
        resolve({ status, reason, retryAfterMs });
      });
      request.on("error", (error) => { finish(); reject(error); });
      request.end(body);
    });
  }

  async send(target: PushTarget, payload: NotifyPayload, delivery: PushDelivery, signal?: AbortSignal): Promise<PushOutcome> {
    const device = appleTarget(target.endpoint);
    if (!device) return { ok: false, gone: true, status: null, error: "this isn't an iPhone app's subscription", attempts: 0 };
    const key = this.o.key();
    if (!key) return { ok: false, gone: false, status: null, error: "this node has no Apple push key: add it with `galahad notify apple-key`", attempts: 0 };
    // The last look: a payload of ours, with nothing that looks like a secret. Otherwise it says only that something needs you.
    const checked = readNotifyPayload(payload);
    const safe = checked && !findSecrets(`${checked.title}\n${checked.body}`).length ? checked : GENERIC_NOTIFICATION;
    let authorization: string;
    try {
      authorization = `bearer ${await this.authorization(key)}`;
    } catch (error) {
      return { ok: false, gone: false, status: null, error: `this node's Apple push key can't sign: ${String((error as Error).message).slice(0, 120)}`, attempts: 0 };
    }
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization,
      "apns-topic": key.topic,
      "apns-push-type": "alert",
      "apns-priority": delivery.urgency === "high" ? "10" : "5",
      "apns-expiration": String(Math.floor(this.now() / 1000) + delivery.ttlSeconds),
      // The same thing told again replaces its notification rather than stacking (64 bytes at most).
      "apns-collapse-id": b64u(sha256Bytes(utf8(safe.tag))).slice(0, 32),
      "content-type": "application/json",
    };
    const body = applePayload(safe, delivery);
    const first = await this.attempt(device.environment, headers, body, signal);
    // A token Apple's other service made (an app that told its node the wrong one: a TestFlight build said to be a
    // development one, or the other way round) is a BadDeviceToken here: asked there once, and kept there when it is taken.
    if (first.reason === "BadDeviceToken") {
      const other: ApplePushEnvironment = device.environment === "production" ? "development" : "production";
      const second = await this.attempt(other, headers, body, signal);
      if (second.outcome.ok) return { ...second.outcome, attempts: first.outcome.attempts + second.outcome.attempts, endpoint: appleEndpoint(other, device.token) };
      if (!second.outcome.gone) return first.outcome;
    }
    return first.outcome;
  }

  /** One message to one of Apple's two services, tried again when it's busy or failing; with Apple's reason when it said one. */
  private async attempt(environment: ApplePushEnvironment, headers: http2.OutgoingHttpHeaders, body: string, signal?: AbortSignal): Promise<{ outcome: PushOutcome; reason: string | null }> {
    const origin = this.o.origins?.[environment] ?? APPLE_PUSH[environment];
    const service = environment === "production" ? "Apple's push service" : "Apple's development push service";
    let last: PushOutcome = { ok: false, gone: false, status: null, error: `${service} couldn't be reached`, attempts: 0 };
    for (let attempts = 1; ; attempts++) {
      let retryAfterMs: number | null = null;
      try {
        const answer = await this.ask(origin, headers, body, signal);
        if (answer.status === 200) return { outcome: { ok: true, gone: false, status: 200, error: null, attempts }, reason: null };
        const why = answer.reason ? `${answer.status} ${answer.reason}` : String(answer.status);
        if (answer.status === 410 || (answer.status === 400 && GONE.has(answer.reason ?? ""))) return { outcome: { ok: false, gone: true, status: answer.status, error: `${service} no longer knows this iPhone for the app (${why})`, attempts }, reason: answer.reason };
        // A refused token is made again next time (the key may have been replaced, or the clock was off).
        if (answer.status === 403 && KEY_REFUSED.has(answer.reason ?? "")) this.token = null;
        last = { ok: false, gone: false, status: answer.status, error: `${service} answered ${why}`, attempts };
        if (answer.status !== 429 && answer.status < 500) return { outcome: last, reason: answer.reason };
        retryAfterMs = answer.retryAfterMs;
      } catch {
        if (signal?.aborted) return { outcome: { ...last, attempts }, reason: null };
        last = { ok: false, gone: false, status: null, error: `${service} couldn't be reached`, attempts };
      }
      const pause = RETRY_MS[attempts - 1];
      if (pause === undefined || signal?.aborted) return { outcome: { ...last, attempts }, reason: null };
      await this.sleep(retryAfterMs ?? pause);
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
