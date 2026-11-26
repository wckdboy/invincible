import { findSecrets, GENERIC_NOTIFICATION, type NotifyPayload, readNotifyPayload } from "@invincible/core";
import type { NotifyStore } from "./notify-store.ts";
import type { PushDelivery, PushOutcome, PushTarget } from "./push-send.ts";

/*
 * The Android app's notifications: no push service at all, or one that refused them. A device that collects is told as every device is (the same
 * rules, the same one door), but the message isn't sent anywhere: the node keeps it for that device, and the app takes
 * it over its own signed connection (`notifyCollect`). Nobody else carries it, so there's no key to give a third party
 * and nothing to allow.
 *
 *  - The payload gets the same last look as one sent to a push service: a payload of ours with nothing that looks like
 *    a secret, or the general one instead.
 *  - It's kept as long as a push service would keep it (the delivery's time to live), then dropped untold.
 *  - A newer one about the same thing replaces one not yet collected (a push service's topic does the same).
 */

const PREFIX = "collect:";

/** The endpoint a collecting device's subscription is kept under: its own id, so no other device can claim it. */
export const collectEndpoint = (device: string): string => `${PREFIX}${device}`;

/** The device a subscription's endpoint says collects its own, or null when it's a push service's. */
export function collectTarget(endpoint: string): string | null {
  return endpoint.startsWith(PREFIX) && endpoint.length > PREFIX.length ? endpoint.slice(PREFIX.length) : null;
}

/** How a collecting device's subscription is named where devices are listed ("Through …"). */
export const COLLECT_SERVICE = "the node itself (the app collects them)";

/**
 * Kept for a device to collect: the same last look as a push service's (a payload of ours with nothing that looks like a
 * secret, or the general one), for as long as a push service would keep it. Also what a phone's push service refused,
 * for a phone whose app collects (notify.ts `send`): nothing is lost while its distributor can't be reached.
 */
export function keepToCollect(db: NotifyStore, device: string, payload: NotifyPayload, delivery: PushDelivery, now: number): void {
  const checked = readNotifyPayload(payload);
  const safe = checked && !findSecrets(`${checked.title}\n${checked.body}`).length ? checked : GENERIC_NOTIFICATION;
  db.keepFor(device, safe, now + delivery.ttlSeconds * 1000);
}

export class CollectSender {
  constructor(private readonly o: { db: NotifyStore; now?: () => number }) {}

  async send(target: PushTarget, payload: NotifyPayload, delivery: PushDelivery): Promise<PushOutcome> {
    const device = collectTarget(target.endpoint);
    if (!device) return { ok: false, gone: false, status: null, error: "not a device that collects its notifications", attempts: 0 };
    keepToCollect(this.o.db, device, payload, delivery, (this.o.now ?? Date.now)());
    return { ok: true, gone: false, status: null, error: null, attempts: 1 };
  }
}
