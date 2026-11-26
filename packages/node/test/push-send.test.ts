import { describe, expect, test } from "bun:test";
import { b64u, newPushKeyPair, type NotifyPayload } from "@invincible/core";
import { PushSender } from "../src/push-send.ts";

/*
 * One notification to one subscription (push-send.ts), against a stand-in fetch: what a push service's answer is said as.
 * The whole path over HTTP, with a stand-in push service, is notify.e2e.test.ts.
 */

const payload: NotifyPayload = { v: 1, kind: "test", title: "Invincible", body: "This is a test. Notifications reach this device.", open: "settings", tag: "test" };

function sender(status: number) {
  const node = newPushKeyPair();
  const calls: string[] = [];
  const push = new PushSender({
    key: async () => node,
    contact: "mailto:node-owner@example.test",
    allowed: [],
    fetch: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status });
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });
  const phone = newPushKeyPair();
  const target = { endpoint: "https://ntfy.sh/upAbCdEfGhIj?up=1", p256dh: b64u(phone.publicKey), auth: b64u(new Uint8Array(16).fill(7)) };
  return { push, calls, target };
}

describe("a push service's answer, in words", () => {
  test("ntfy's 507 is its server holding no connection from the phone's ntfy, and says what to do", async () => {
    // (26 November 2026: Android wouldn't let ntfy start its connection from the background; "answered 507" said nothing.)
    const { push, calls, target } = sender(507);
    const out = await push.send(target, payload, { ttlSeconds: 60, urgency: "high" });
    expect(out).toMatchObject({ ok: false, gone: false, status: 507 });
    expect(out.error).toBe("ntfy (UnifiedPush)'s server holds no connection from the phone's ntfy (507): open ntfy on the phone, and let it run in the background");
    // Tried again, twice at most: the phone's ntfy may connect meanwhile.
    expect(calls).toHaveLength(3);
  });

  test("anything else is the service by name and its status, never its address", async () => {
    const { push, target } = sender(503);
    const out = await push.send(target, payload, { ttlSeconds: 60, urgency: "high" });
    expect(out.error).toBe("ntfy (UnifiedPush)'s push service answered 503");
    expect(out.error).not.toContain("upAbCdEfGhIj");
  });
});
