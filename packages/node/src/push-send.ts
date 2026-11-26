import { b64u, encryptPush, findSecrets, fromB64u, GENERIC_NOTIFICATION, type NotifyPayload, type PushKeyPair, pushService, readNotifyPayload, sha256Bytes, utf8, VAPID_TTL_S, vapidAuthorization, vapidToken } from "@galahad/core";

/*
 * Sending one notification to one subscription: outward traffic the owner chose.
 *
 *  - The only host called is the push service in the subscription the owner's browser
 *    handed over, and only when it is one: checked again here, at the moment of sending,
 *    whatever was checked when it was kept. Redirects are never followed.
 *  - The message is encrypted to that browser (RFC 8291), so the push service carries
 *    bytes it can't read; the node proves itself with its own VAPID key (RFC 8292).
 *  - The payload gets a last look before it's encrypted: it must be a payload of ours,
 *    and nothing in it may look like a secret. Otherwise the general one goes instead.
 *  - A push service that's busy (429) or failing (5xx) is tried again, twice at most,
 *    after a pause. Never a loop.
 *  - Nothing here logs or returns the endpoint: an outcome names the service.
 */

export interface PushTarget {
  endpoint: string;
  /** Base64url, as the browser gave them. */
  p256dh: string;
  auth: string;
}

export interface PushOutcome {
  ok: boolean;
  /** The push service says this subscription no longer exists (404, 410): drop it. */
  gone: boolean;
  status: number | null;
  /** In words that are safe to show and log: the service by name and its status, never the endpoint. */
  error: string | null;
  attempts: number;
  /** Where it was taken, when that isn't where the subscription is kept (an iPhone's token on Apple's other service):
   * the subscription is kept there from now on. */
  endpoint?: string;
}

export interface PushSenderOptions {
  /** This node's VAPID key (asked for when first needed; never logged). */
  key: () => Promise<PushKeyPair>;
  /** Who operates this node, for push services (a mailto: or https: address; RFC 8292's `sub`). */
  contact: string;
  /** Push services the owner allowed beyond the known ones (notify.ts `pushService`). */
  allowed: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The node's contact for push services unless the owner names one: it identifies nobody. */
export const DEFAULT_PUSH_CONTACT = "mailto:node-owner@example.com";
export const PUSH_TIMEOUT_MS = 10_000;
/** Every message is padded to this before it's sealed (a title and a line at their longest fit well inside). */
export const PUSH_PAD_BYTES = 1024;
/** Pauses before a second and a third try. */
export const PUSH_RETRY_MS = [2_000, 8_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * How long a push service keeps a message for a device that's away, and how urgent it is (RFC 8030): `low` is news,
 * passive on every platform (no sound; delivered when the device is on power or Wi-Fi), `normal` a finding, `high` an
 * ask or an alert.
 */
export interface PushDelivery {
  ttlSeconds: number;
  urgency: "low" | "normal" | "high";
}

export class PushSender {
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PushSenderOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /** The key browsers subscribe to (public by nature), base64url. */
  async publicKey(): Promise<string> {
    return b64u((await this.opts.key()).publicKey);
  }

  /** A VAPID token for one push service, reused while it has an hour left. */
  private async authorization(origin: string): Promise<string> {
    const key = await this.opts.key();
    const nowS = Math.floor(this.now() / 1000);
    let cached = this.tokens.get(origin);
    if (!cached || cached.expires - nowS < 3600) {
      const expires = nowS + VAPID_TTL_S;
      cached = { token: vapidToken({ audience: origin, subject: this.opts.contact, expires, privateKey: key.privateKey }), expires };
      this.tokens.set(origin, cached);
    }
    return vapidAuthorization(cached.token, key.publicKey);
  }

  async send(target: PushTarget, payload: NotifyPayload, delivery: PushDelivery, signal?: AbortSignal): Promise<PushOutcome> {
    const service = pushService(target.endpoint, this.opts.allowed);
    if (!service.ok) return { ok: false, gone: false, status: null, error: service.why, attempts: 0 };
    // The last look: a payload of ours, with nothing that looks like a secret. Otherwise it says only that something needs you.
    const checked = readNotifyPayload(payload);
    const safe = checked && !findSecrets(`${checked.title}\n${checked.body}`).length ? checked : GENERIC_NOTIFICATION;
    let body: Uint8Array;
    let authorization: string;
    try {
      // Padded: every notification is the same size on the wire, whatever it says.
      body = encryptPush({ p256dh: fromB64u(target.p256dh), auth: fromB64u(target.auth) }, utf8(JSON.stringify(safe)), { padTo: PUSH_PAD_BYTES });
      authorization = await this.authorization(service.origin);
    } catch (error) {
      return { ok: false, gone: false, status: null, error: `the message couldn't be prepared: ${String((error as Error).message).slice(0, 120)}`, attempts: 0 };
    }
    const headers = {
      authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(delivery.ttlSeconds),
      urgency: delivery.urgency,
      // A message that replaces an undelivered one about the same thing (RFC 8030 §5.4): 32 characters at most.
      topic: b64u(sha256Bytes(utf8(safe.tag))).slice(0, 32),
    };
    let attempts = 0;
    let last: PushOutcome = { ok: false, gone: false, status: null, error: `${service.service}'s push service couldn't be reached`, attempts: 0 };
    for (;;) {
      attempts += 1;
      let retryAfterMs: number | null = null;
      try {
        // The address as it was read and checked, never the text it came as.
        const response = await this.fetchImpl(service.href, {
          method: "POST",
          headers,
          body: body as Uint8Array<ArrayBuffer>,
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PUSH_TIMEOUT_MS)]) : AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status >= 200 && status < 300) return { ok: true, gone: false, status, error: null, attempts };
        if (status === 404 || status === 410) return { ok: false, gone: true, status, error: `${service.service}'s push service says this subscription is gone (${status})`, attempts };
        last = { ok: false, gone: false, status, error: `${service.service}'s push service answered ${status}`, attempts };
        // Anything but "busy" and "failing" is an answer: trying again wouldn't change it.
        if (status !== 429 && status < 500) return last;
        const after = Number(response.headers.get("retry-after"));
        if (Number.isFinite(after) && after > 0) retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, after * 1000);
      } catch {
        if (signal?.aborted) return { ...last, attempts };
        last = { ok: false, gone: false, status: null, error: `${service.service}'s push service couldn't be reached`, attempts };
      }
      const pause = PUSH_RETRY_MS[attempts - 1];
      if (pause === undefined || signal?.aborted) return { ...last, attempts };
      await this.sleep(retryAfterMs ?? pause);
    }
  }
}
