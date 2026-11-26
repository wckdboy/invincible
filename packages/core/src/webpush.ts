import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { extract, expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, type Bytes, concat, fromB64u, randomBytes, utf8 } from "./bytes.ts";

/*
 * Web Push, the standards and nothing else:
 *
 *   RFC 8292 (VAPID)   the node proves which application server it is: a JWT (ES256) over the push
 *                      service's origin, signed with the node's own P-256 key.
 *   RFC 8291           the message is encrypted to the browser: ECDH with the subscription's key,
 *                      mixed with its authentication secret, so the push service carries bytes it
 *                      can't read.
 *   RFC 8188           the encoding of those bytes (aes128gcm): a header (salt, record size, the
 *                      sender's public key) and one AES-128-GCM record.
 *
 * On the noble libraries, like every other primitive here. The RFCs' own test vectors are in
 * test/webpush.test.ts, with a round trip decrypted by WebCrypto, as a browser would.
 */

/** A P-256 key in the form Web Push uses: the private scalar (32 bytes) and the uncompressed public point (65 bytes). */
export interface PushKeyPair {
  privateKey: Bytes;
  publicKey: Bytes;
}

export function newPushKeyPair(): PushKeyPair {
  const { secretKey } = p256.keygen();
  return { privateKey: secretKey, publicKey: p256.getPublicKey(secretKey, false) };
}

/** The public key of a private one, uncompressed. Throws if it isn't a P-256 private key. */
export const pushPublicKey = (privateKey: Bytes): Bytes => p256.getPublicKey(privateKey, false);

/** An uncompressed P-256 point that is on the curve (what a browser's `p256dh` and a VAPID key are). */
export function isP256Point(bytes: Bytes): boolean {
  if (bytes.length !== 65 || bytes[0] !== 0x04) return false;
  try {
    p256.Point.fromBytes(bytes).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/* ---------- RFC 8292: VAPID ---------- */

/** A VAPID token may live a day at most (RFC 8292 §2); this one lives half of one. */
export const VAPID_TTL_S = 12 * 60 * 60;

const JWT_HEADER = b64u(utf8('{"typ":"JWT","alg":"ES256"}'));

/**
 * The JWT a push service checks: who is sending (`sub`, a contact), to which service (`aud`, its origin),
 * until when (`exp`, seconds). Signed ES256: ECDSA P-256 over SHA-256, as r || s (RFC 7515).
 */
export function vapidToken(input: { audience: string; subject: string; expires: number; privateKey: Bytes }): string {
  const claims = b64u(utf8(JSON.stringify({ aud: input.audience, exp: input.expires, sub: input.subject })));
  const signing = `${JWT_HEADER}.${claims}`;
  const signature = p256.sign(utf8(signing), input.privateKey, { prehash: true });
  return `${signing}.${b64u(signature)}`;
}

/** The Authorization header of a push request (RFC 8292 §3): the token, and the public key it verifies under. */
export const vapidAuthorization = (token: string, publicKey: Bytes): string => `vapid t=${token}, k=${b64u(publicKey)}`;

/** Checks a VAPID token's signature and reads its claims (tests, and a stand-in push service). Null: not a valid token under that key. */
export function readVapidToken(token: string, publicKey: Bytes): { aud: string; exp: number; sub: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64u(parts[0]!))) as { typ?: string; alg?: string };
    if (header.alg !== "ES256") return null;
    if (!p256.verify(fromB64u(parts[2]!), utf8(`${parts[0]}.${parts[1]}`), publicKey, { prehash: true, lowS: false })) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!))) as { aud?: unknown; exp?: unknown; sub?: unknown };
    if (typeof claims.aud !== "string" || typeof claims.exp !== "number" || typeof claims.sub !== "string") return null;
    return { aud: claims.aud, exp: claims.exp, sub: claims.sub };
  } catch {
    return null;
  }
}

/* ---------- RFC 8188: the aes128gcm content coding (one record) ---------- */

/** The record size this sender declares; a message is one record, so it must fit in it. */
export const PUSH_RECORD_SIZE = 4096;
/** The most plaintext one message carries: push services take about 4 KB in all, and a notification is a line or two. */
export const PUSH_MAX_PLAINTEXT = 3000;

const info = (label: string): Bytes => utf8(`Content-Encoding: ${label}\0`);

/**
 * One aes128gcm record from input keying material: header (salt, record size, key id) and the ciphertext.
 * The plaintext is followed by the last-record delimiter (0x02), then sealed with a key and nonce derived
 * from the salt and the keying material (RFC 8188 §2.2, §2.3).
 */
export function aes128gcmEncode(input: { ikm: Bytes; salt: Bytes; keyId: Bytes; plaintext: Bytes; recordSize?: number; padTo?: number }): Bytes {
  if (input.salt.length !== 16) throw new Error("the salt is 16 bytes");
  if (input.keyId.length > 255) throw new Error("the key id is at most 255 bytes");
  const rs = input.recordSize ?? PUSH_RECORD_SIZE;
  // Padding (RFC 8188 §2): zeros after the delimiter, so a message's length doesn't say what it holds.
  const padding = Math.max(0, Math.min(input.padTo ?? 0, rs - 17) - input.plaintext.length);
  // One record: the plaintext, its delimiter, any padding and the tag must fit.
  if (input.plaintext.length + 1 + padding + 16 > rs) throw new Error("the message doesn't fit in one record");
  const prk = extract(sha256, input.ikm, input.salt);
  const cek = expand(sha256, prk, info("aes128gcm"), 16);
  const nonce = expand(sha256, prk, info("nonce"), 12);
  const sealed = gcm(cek, nonce).encrypt(concat(input.plaintext, new Uint8Array([0x02]), new Uint8Array(padding)));
  const header = new Uint8Array(21 + input.keyId.length);
  header.set(input.salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = input.keyId.length;
  header.set(input.keyId, 21);
  return concat(header, sealed);
}

/* ---------- RFC 8291: message encryption for Web Push ---------- */

/** What a browser hands over when it subscribes: its P-256 public key (65 bytes) and its authentication secret (16 bytes). */
export interface PushRecipient {
  p256dh: Bytes;
  auth: Bytes;
}

/**
 * Encrypts a message to one subscription (RFC 8291 §3): a fresh sender key and salt for every message
 * (`sender` and `salt` are given only by tests, to reproduce the RFC's example). `padTo`: the message is
 * padded to that many bytes before it's sealed, so every message of a kind is the same size on the wire.
 * Returns the request body, to send with `Content-Encoding: aes128gcm`.
 */
export function encryptPush(recipient: PushRecipient, plaintext: Bytes, fixed: { sender?: PushKeyPair; salt?: Bytes; padTo?: number } = {}): Bytes {
  if (!isP256Point(recipient.p256dh)) throw new Error("the subscription's key isn't a P-256 public key");
  if (recipient.auth.length !== 16) throw new Error("the subscription's authentication secret is 16 bytes");
  if (plaintext.length > PUSH_MAX_PLAINTEXT) throw new Error(`a push message carries at most ${PUSH_MAX_PLAINTEXT} bytes`);
  const sender = fixed.sender ?? newPushKeyPair();
  const salt = fixed.salt ?? randomBytes(16);
  // The shared secret is the x coordinate of the ECDH point.
  const shared = p256.getSharedSecret(sender.privateKey, recipient.p256dh, true).slice(1);
  // Mixed with the authentication secret and both public keys: only this browser and this sender derive it.
  const keyInfo = concat(utf8("WebPush: info\0"), recipient.p256dh, sender.publicKey);
  const ikm = expand(sha256, extract(sha256, shared, recipient.auth), keyInfo, 32);
  return aes128gcmEncode({ ikm, salt, keyId: sender.publicKey, plaintext, ...(fixed.padTo ? { padTo: fixed.padTo } : {}) });
}
