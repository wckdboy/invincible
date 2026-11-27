import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, type Bytes, concat, fromB64u, randomBytes, utf8 } from "./bytes.ts";

/*
 * All primitives come from the audited, dependency-free noble libraries so the
 * exact same code runs in Bun on every node and in the browser PWA.
 */

export const sha256Bytes = (data: Bytes): Bytes => sha256(data);
export const sha256B64u = (data: Bytes | string): string =>
  b64u(sha256(typeof data === "string" ? utf8(data) : data));

export const deriveKey = (ikm: Bytes, info: string, length = 32, salt?: Bytes): Bytes =>
  hkdf(sha256, ikm, salt, utf8(info), length);

export const mac = (key: Bytes, message: Bytes | string): Bytes =>
  hmac(sha256, key, typeof message === "string" ? utf8(message) : message);

// --- Ed25519: device signing keys (nodes) ---------------------------------

export interface KeyPair {
  secretKey: Bytes;
  publicKey: Bytes;
}

export function newSigningKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export const signingPublicKey = (secretKey: Bytes): Bytes => ed25519.getPublicKey(secretKey);
export const signEd25519 = (secretKey: Bytes, message: Bytes): Bytes => ed25519.sign(message, secretKey);

export function verifyEd25519(signature: Bytes, message: Bytes, publicKey: Bytes): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Whether 32 bytes are a point fit for a node's Ed25519 key, or a signature's R, under the strict rule (the lead's word
 * of 27 November 2026): a canonical encoding (y < p, never x = 0 with x's sign bit set), a point of the prime-order
 * subgroup, and not the identity. So no small-order point (the identity's key verifies any signature for any message),
 * and no mixed-order one, which a cofactored check and a cofactorless one judge differently: core, Swift and Kotlin
 * answer alike on every input. (noble's own default, ZIP-215, takes non-canonical encodings and small-order keys.)
 */
export function strictEd25519Point(bytes: Bytes): boolean {
  if (bytes.length !== 32) return false;
  try {
    const point = ed25519.Point.fromBytes(bytes, false);
    return !point.is0() && point.isTorsionFree();
  } catch {
    return false;
  }
}

/** An Ed25519 signature under the strict rule: A and R strict points (strictEd25519Point), S < L, and [S]B = R + [k]A. */
export function verifyEd25519Strict(signature: Bytes, message: Bytes, publicKey: Bytes): boolean {
  if (signature.length !== 64 || !strictEd25519Point(publicKey) || !strictEd25519Point(signature.subarray(0, 32))) return false;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]!);
  if (s >= ed25519.Point.Fn.ORDER) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

// --- P-256: browser/PWA client keys (WebCrypto, non-extractable) ------------

/**
 * Verifies a WebCrypto ECDSA P-256 / SHA-256 signature (IEEE P1363 r||s).
 * WebCrypto does not normalize to low-S, so `lowS` must be relaxed here.
 */
export function verifyP256(signature: Bytes, message: Bytes, publicKey: Bytes): boolean {
  try {
    return p256.verify(signature, message, publicKey, { lowS: false, prehash: true });
  } catch {
    return false;
  }
}

/** A P-256 key a node holds for a client of its own (a chat app's gateway): signed as a browser's key signs. */
export const newP256Secret = (): Bytes => p256.utils.randomSecretKey();
export const p256PublicKey = (secret: Bytes): Bytes => p256.getPublicKey(secret, false);
export const signP256 = (secret: Bytes, message: Bytes): Bytes => p256.sign(message, secret, { prehash: true });

// --- X25519 + XChaCha20-Poly1305: sealing secrets to devices ---------------

export function newBoxKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

export const boxPublicKey = (secretKey: Bytes): Bytes => x25519.getPublicKey(secretKey);

export interface Ciphertext {
  nonce: string;
  ct: string;
}

export function aeadSeal(key: Bytes, plaintext: Bytes, aad: string): Ciphertext {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext);
  return { nonce: b64u(nonce), ct: b64u(ct) };
}

/** Throws if the ciphertext, nonce, key or AAD was tampered with. */
export function aeadOpen(key: Bytes, box: Ciphertext, aad: string): Bytes {
  return xchacha20poly1305(key, fromB64u(box.nonce), utf8(aad)).decrypt(fromB64u(box.ct));
}

export interface SealedBox extends Ciphertext {
  /** Ephemeral X25519 public key. */
  eph: string;
}

/**
 * Anonymous sealed box (ECIES): ephemeral X25519 → HKDF-SHA256 → XChaCha20-Poly1305.
 * `context` is bound into both the KDF and the AAD so a box can never be replayed
 * into a different slot (e.g. another fleet, key id or recipient).
 */
export function sealTo(recipient: Bytes, plaintext: Bytes, context: string): SealedBox {
  const eph = x25519.keygen();
  const shared = x25519.getSharedSecret(eph.secretKey, recipient);
  const key = deriveKey(shared, `invincible/seal/v1|${context}`, 32, concat(eph.publicKey, recipient));
  return { eph: b64u(eph.publicKey), ...aeadSeal(key, plaintext, context) };
}

/**
 * Opens a box sealed to this recipient. `domain`: the label its key was derived under, Invincible's own unless a box
 * sealed by another system is opened (the import of the one it succeeds, which sealed its vault under its own label).
 */
export function openSealed(recipientSecret: Bytes, box: SealedBox, context: string, domain = "invincible/seal/v1"): Bytes {
  const eph = fromB64u(box.eph);
  const shared = x25519.getSharedSecret(recipientSecret, eph);
  const key = deriveKey(shared, `${domain}|${context}`, 32, concat(eph, boxPublicKey(recipientSecret)));
  return aeadOpen(key, box, context);
}
