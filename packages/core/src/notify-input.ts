import { z } from "zod";
import { CLOCK, NOTIFY_PER_DAY } from "./notify.ts";
import { isTimeZone } from "./schedule.ts";

/*
 * What a node takes for notifications, checked at its door (notify.ts is the contract
 * and the rules, without zod, for the PWA).
 */

/**
 * A browser's push subscription, as `PushSubscription.toJSON()` gives it: where its push service takes
 * messages for it, its P-256 public key (65 bytes) and its authentication secret (16 bytes). Whether the
 * endpoint is a push service the node may call is the node's own check (`pushService`): it knows what
 * its owner allowed.
 */
export const PushSubscriptionInput = z.strictObject({
  endpoint: z.string().url().max(2048),
  /** Browsers include it (always null today); nothing here uses it. */
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/, "a P-256 public key, base64url (65 bytes)"),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/, "an authentication secret, base64url (16 bytes)"),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/**
 * The iPhone app's own: the device token Apple's push service gave it (32 bytes today, in hex; Apple may lengthen it)
 * and which of Apple's two push services its build answers to: `development` for a build from Xcode, `production` for
 * TestFlight and the App Store. The node sends only to that service, with its owner's Apple push key.
 */
export const ApplePushInput = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64,200}$/, "an APNs device token, in lowercase hex").refine((token) => token.length % 2 === 0, "whole bytes"),
  environment: z.enum(["development", "production"]),
});
export type ApplePushInput = z.infer<typeof ApplePushInput>;

/**
 * The owner's Apple push key (Apple Developer: Keys, with Apple Push Notifications service), as the node keeps it: the
 * .p8 file's text, the key's ID, their Team ID and the app it notifies (its bundle id). Sealed in the vault, pinned to
 * Apple's push service; given on stdin (`galahad notify apple-key`), never on a command line.
 */
export const ApplePushKeyInput = z.strictObject({
  // (Written as -{5} so the pattern itself never reads as a key to a secret scanner.)
  key: z.string().max(4096).regex(/-{5}BEGIN PRIVATE KEY-{5}[A-Za-z0-9+/=\s]+-{5}END PRIVATE KEY-{5}/, "the .p8 file's whole text, as Apple gave it"),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/, "the key's ID: ten capital letters and digits"),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/, "your Team ID: ten capital letters and digits"),
  topic: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/, "the app's bundle id").default("org.amirite.galahad"),
});
export type ApplePushKeyInput = z.infer<typeof ApplePushKeyInput>;

const Clock = z.string().regex(CLOCK, "a time of day, HH:MM");

/** What he sends and when he stays silent: any part of it; what's left out stays as it is. Every kind is a switch (a test
 * holds this list to NOTIFY_KINDS: `told` was once left out, and the node refused the switch its apps offered), and so
 * is the day's digest. */
export const NotifyPrefsInput = z.strictObject({
  kinds: z
    .strictObject({ "needs-you": z.boolean().optional(), approval: z.boolean().optional(), finished: z.boolean().optional(), question: z.boolean().optional(), told: z.boolean().optional() })
    .optional(),
  quiet: z
    .strictObject({ on: z.boolean().optional(), from: Clock.optional(), to: Clock.optional(), tz: z.string().max(64).refine(isTimeZone, "an IANA time zone, such as Europe/Copenhagen").optional() })
    .optional(),
  perDay: z.number().int().min(NOTIFY_PER_DAY.min).max(NOTIFY_PER_DAY.max).optional(),
  /** The day's digest: on or off, and when (in your own time). Older nodes refuse it (unrecognized key); older apps never send it. */
  digest: z.strictObject({ on: z.boolean().optional(), at: Clock.optional() }).optional(),
});
export type NotifyPrefsInput = z.infer<typeof NotifyPrefsInput>;

/** A paired device, by id (what `whoami` and the fleet call it). */
export const NotifyDeviceRef = z.string().regex(/^c_[A-Za-z0-9_-]{43,87}$/, "a paired device's id");
