import { b64u, type Bytes, fromB64u, utf8 } from "./bytes.ts";
import {
  boxPublicKey,
  newBoxKeyPair,
  newP256Secret,
  newSigningKeyPair,
  p256PublicKey,
  signEd25519,
  signingPublicKey,
  signP256,
  verifyEd25519,
  verifyP256,
} from "./crypto.ts";

/**
 * Device ids are self-certifying: the id *is* the public key.
 *   n_<ed25519 pub>  → a Galahad node (signs log events and link requests)
 *   c_<p256 pub>     → a client such as the PWA (signs API requests only)
 */
export type DeviceId = string;

export const nodeIdFromKey = (publicKey: Bytes): DeviceId => `n_${b64u(publicKey)}`;
export const clientIdFromKey = (publicKey: Bytes): DeviceId => `c_${b64u(publicKey)}`;
export const isNodeId = (id: string): boolean => /^n_[A-Za-z0-9_-]{43}$/.test(id);
export const isClientId = (id: string): boolean => /^c_[A-Za-z0-9_-]{87}$/.test(id);

export function verifyDeviceSignature(device: DeviceId, signature: Bytes, message: Bytes): boolean {
  if (isNodeId(device)) return verifyEd25519(signature, message, fromB64u(device.slice(2)));
  if (isClientId(device)) return verifyP256(signature, message, fromB64u(device.slice(2)));
  return false;
}

export const shortId = (id: DeviceId): string => id.slice(2, 10);

/**
 * A client a node runs itself (a chat app's gateway): a device of its own, paired with the scopes you gave it and
 * revoked like any other, whose P-256 key the node keeps sealed in the vault. It signs API requests only.
 */
export interface ClientIdentity {
  id: DeviceId;
  sign(message: Bytes): Bytes;
}

export function clientIdentity(secret: Bytes): ClientIdentity {
  return { id: clientIdFromKey(p256PublicKey(secret)), sign: (message) => signP256(secret, message) };
}

export const newClientSecret = (): Bytes => newP256Secret();

/** A node's private identity. Never leaves the device; never enters the log. */
export interface NodeIdentity {
  id: DeviceId;
  signSecret: Bytes;
  boxSecret: Bytes;
  boxPublic: Bytes;
  sign(message: Bytes): Bytes;
}

export function nodeIdentity(signSecret: Bytes, boxSecret: Bytes): NodeIdentity {
  return {
    id: nodeIdFromKey(signingPublicKey(signSecret)),
    signSecret,
    boxSecret,
    boxPublic: boxPublicKey(boxSecret),
    sign: (message) => signEd25519(signSecret, message),
  };
}

export function newNodeIdentity(): NodeIdentity {
  return nodeIdentity(newSigningKeyPair().secretKey, newBoxKeyPair().secretKey);
}

export const exportIdentity = (identity: NodeIdentity): string =>
  JSON.stringify({ v: 1, sign: b64u(identity.signSecret), box: b64u(identity.boxSecret) });

export function importIdentity(text: string): NodeIdentity {
  const parsed = JSON.parse(text) as { v: number; sign: string; box: string };
  if (parsed.v !== 1) throw new Error("unsupported identity format");
  return nodeIdentity(fromB64u(parsed.sign), fromB64u(parsed.box));
}

/** Domain-separated signing input: a signature for one purpose is never valid for another. */
export const domain = (label: string, payload: string): Uint8Array<ArrayBuffer> => utf8(`${label}\n${payload}`);
