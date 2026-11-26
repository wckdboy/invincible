import { z } from "zod";
import { b64u, type Bytes, equalBytes, fromB64u, fromUtf8, randomBytes, randomId, utf8 } from "./bytes.ts";
import { canonical } from "./canonical.ts";
import { deriveKey, mac } from "./crypto.ts";

/*
 * Pairing a new device:
 *  1. A trusted node mints a one-time invite (32-byte secret, 10 min, single use).
 *  2. The joining device proves it holds the invite (HMAC over its own public keys)
 *     without ever sending the secret.
 *  3. Both sides derive a 6-digit SAS code from (secret, fleet, joining device key).
 *     You approve only if the codes match — someone who intercepted the invite
 *     has a different device key and therefore a different code.
 *  4. The approving node enrolls the device in the mind and, for full nodes,
 *     seals the vault key to it.
 */

export const INVITE_TTL_MS = 10 * 60_000;
const B64 = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const Invite = z.strictObject({
  v: z.literal(1),
  /** Endpoint of the inviting node, reachable over the tailnet. */
  e: z.string().url(),
  /** Fleet id the joiner must end up in (self-certifying: = genesis event id). */
  f: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  i: B64,
  s: B64,
  k: z.enum(["node", "client"]),
});
export type Invite = z.infer<typeof Invite>;

export function newInvite(endpoint: string, fleet: string, kind: "node" | "client"): { invite: Invite; secret: Bytes } {
  const secret = randomBytes(32);
  return { invite: { v: 1, e: endpoint, f: fleet, i: randomId(16), s: b64u(secret), k: kind }, secret };
}

export const encodeInvite = (invite: Invite): string => `gi1.${b64u(utf8(canonical(invite)))}`;

/** Accepts a bare invite or any URL carrying `#pair=<invite>`. */
export function decodeInvite(text: string): Invite {
  const trimmed = text.trim();
  const fromUrl = trimmed.match(/[#&?]pair=([A-Za-z0-9._-]+)/)?.[1];
  const token = fromUrl ?? trimmed;
  if (!token.startsWith("gi1.")) throw new Error("not a Galahad invite");
  return Invite.parse(JSON.parse(fromUtf8(fromB64u(token.slice(4)))));
}

const pairKey = (secret: Bytes) => deriveKey(secret, "galahad/pair/v1/mac");

/**
 * What a joining device calls itself, shown in terminals and the app: no control characters
 * (an escape sequence would be acted on), line breaks or bidirectional overrides (which can make
 * the name read as something else next to the approval code).
 */
export const DeviceName = z
  .string()
  .min(1)
  .max(64)
  .refine((name) => !/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(name), { message: "a device name can't hold control characters" });

export const PairRequestFields = z.strictObject({
  invite: B64,
  device: z.string().regex(/^[nc]_[A-Za-z0-9_-]{43,87}$/),
  name: DeviceName,
  kind: z.enum(["node", "client"]),
  box: B64.optional(),
  endpoint: z.string().url().max(512).optional(),
});
export type PairRequestFields = z.infer<typeof PairRequestFields>;
export const PairRequest = PairRequestFields.extend({ proof: B64 });
export type PairRequest = z.infer<typeof PairRequest>;

export const pairProof = (secret: Bytes, fields: PairRequestFields): string =>
  b64u(mac(pairKey(secret), `request|${canonical(fields)}`));

export const statusProof = (secret: Bytes, invite: string, device: string): string =>
  b64u(mac(pairKey(secret), `status|${invite}|${device}`));

export const approvalProof = (secret: Bytes, invite: string, device: string, fleet: string): string =>
  b64u(mac(pairKey(secret), `approved|${invite}|${device}|${fleet}`));

export function proofMatches(expected: string, given: string): boolean {
  try {
    return equalBytes(fromB64u(expected), fromB64u(given));
  } catch {
    return false;
  }
}

/** Short authentication string shown on both screens, e.g. "482 913". */
export function sasCode(secret: Bytes, fleet: string, device: string): string {
  const bytes = deriveKey(secret, `galahad/pair/v1/sas|${fleet}|${device}`, 4);
  const n = (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0) % 1_000_000;
  const digits = n.toString().padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
