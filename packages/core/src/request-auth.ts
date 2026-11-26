import { b64u, type Bytes, fromB64u, randomId } from "./bytes.ts";
import { sha256B64u } from "./crypto.ts";
import { type DeviceId, domain, verifyDeviceSignature } from "./identity.ts";

/**
 * Every node-to-node and client-to-node request is signed by the caller's device
 * key over (method, path, time, nonce, body hash). Tailscale already encrypts the
 * wire; this proves *which enrolled device* is calling, independently of the network.
 */
export const AUTH = {
  device: "x-galahad-device",
  ts: "x-galahad-ts",
  nonce: "x-galahad-nonce",
  sig: "x-galahad-sig",
} as const;

export const MAX_REQUEST_SKEW_MS = 60_000;

/**
 * The asking device's time zone (an IANA name), sent with each request beside the signature: what time it is where you
 * are, in an answer of his. Only a hint, outside what is signed, and trusted for nothing else; a node from before it
 * ignores it, and one with none, or a name that isn't a zone, reads your day in your notifications' zone.
 */
export const ZONE_HEADER = "x-galahad-tz";

export const requestSigningInput = (
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: Bytes,
): Uint8Array<ArrayBuffer> => domain("galahad-req/v1", [method.toUpperCase(), path, ts, nonce, sha256B64u(body)].join("\n"));

export type Signer = (message: Uint8Array<ArrayBuffer>) => Bytes | Promise<Bytes>;

export async function signRequest(
  device: DeviceId,
  signer: Signer,
  method: string,
  path: string,
  body: Bytes,
  now = Date.now(),
): Promise<Record<string, string>> {
  const ts = String(now);
  const nonce = randomId(12);
  const sig = await signer(requestSigningInput(method, path, ts, nonce, body));
  return { [AUTH.device]: device, [AUTH.ts]: ts, [AUTH.nonce]: nonce, [AUTH.sig]: b64u(sig) };
}

export interface RequestProof {
  device: DeviceId;
  nonce: string;
  ts: number;
}

interface HeaderReader {
  get(name: string): string | null;
}

/** Returns the proven device, or null. Callers must still check enrollment, scope and nonce reuse. */
export function verifyRequestSignature(
  headers: HeaderReader,
  method: string,
  path: string,
  body: Bytes,
  now = Date.now(),
): RequestProof | null {
  const device = headers.get(AUTH.device);
  const ts = headers.get(AUTH.ts);
  const nonce = headers.get(AUTH.nonce);
  const sig = headers.get(AUTH.sig);
  if (!device || !ts || !nonce || !sig) return null;
  if (!/^\d{1,16}$/.test(ts) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return null;
  const time = Number(ts);
  if (Math.abs(now - time) > MAX_REQUEST_SKEW_MS) return null;
  let signature: Bytes;
  try {
    signature = fromB64u(sig);
  } catch {
    return null;
  }
  if (!verifyDeviceSignature(device, signature, requestSigningInput(method, path, ts, nonce, body))) return null;
  return { device, nonce, ts: time };
}

/** Remembers nonces for the skew window so a captured request cannot be replayed. */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  /** Returns false if this (device, nonce) was already used. */
  claim(device: string, nonce: string, now = Date.now()): boolean {
    if (this.seen.size > 10_000) this.sweep(now);
    const key = `${device}:${nonce}`;
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.seen.set(key, now + 2 * MAX_REQUEST_SKEW_MS);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
  }
}
