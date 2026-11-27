import { b64u, type Bytes, fromB64u, randomBytes, randomId } from "./bytes.ts";
import { sha256B64u } from "./crypto.ts";
import { verifyEd25519Strict } from "./crypto.ts";
import { type DeviceId, domain, isStrictNodeId, verifyDeviceSignature } from "./identity.ts";

/**
 * Every node-to-node and client-to-node request is signed by the caller's device
 * key over (method, path, time, nonce, body hash) and the node it is for. Tailscale
 * already encrypts the wire; this proves *which enrolled device* is calling, and to
 * which node, independently of the network.
 */
export const AUTH = {
  device: "x-invincible-device",
  ts: "x-invincible-ts",
  nonce: "x-invincible-nonce",
  sig: "x-invincible-sig",
} as const;

export const MAX_REQUEST_SKEW_MS = 60_000;

/**
 * From 14 December 2026, a request names the node it is for in what it signs, or it is refused: one for one node is no
 * request at another (the slice 8 note's item 11; the lead's word of 27 November 2026). Before then, one that names
 * none (v1, what a device signed before) is taken too. Whoami's always is: a device asks it to learn, proven, which node
 * it speaks to (verifyNodeProof), before it can name it.
 */
export const REQUESTS_NAME_THEIR_NODE_FROM = Date.UTC(2026, 11, 14);

/**
 * What a node's profile says it reads (`caps.requests`): requests that name it (v2). A node names a peer that says so;
 * one that doesn't yet (an older node, which reads v1 alone) it asks as before, until REQUESTS_NAME_THEIR_NODE_FROM,
 * so a fleet whose nodes update one by one keeps its sync.
 */
export const REQUESTS_READ = 2;
export const readsNamedRequests = (caps: unknown): boolean =>
  typeof caps === "object" && caps !== null && typeof (caps as { requests?: unknown }).requests === "number" && (caps as { requests: number }).requests >= REQUESTS_READ;

/**
 * The asking device's time zone (an IANA name), sent with each request beside the signature: what time it is where you
 * are, in an answer of its. Only a hint, outside what is signed, and trusted for nothing else; a node from before it
 * ignores it, and one with none, or a name that isn't a zone, reads your day in your notifications' zone.
 */
export const ZONE_HEADER = "x-invincible-tz";

/** What a request's signature covers: v2 names the node it is for, last; v1, from before, names none. */
export const requestSigningInput = (method: string, path: string, ts: string, nonce: string, body: Bytes, node?: DeviceId): Uint8Array<ArrayBuffer> =>
  node === undefined
    ? domain("invincible-req/v1", [method.toUpperCase(), path, ts, nonce, sha256B64u(body)].join("\n"))
    : domain("invincible-req/v2", [method.toUpperCase(), path, ts, nonce, sha256B64u(body), node].join("\n"));

export type Signer = (message: Uint8Array<ArrayBuffer>) => Bytes | Promise<Bytes>;

/** A request's headers, signed by `device` for the node `node` (v2); without `node`, for none (v1, as before). */
export async function signRequest(
  device: DeviceId,
  signer: Signer,
  method: string,
  path: string,
  body: Bytes,
  now = Date.now(),
  node?: DeviceId,
): Promise<Record<string, string>> {
  const ts = String(now);
  const nonce = randomId(12);
  const sig = await signer(requestSigningInput(method, path, ts, nonce, body, node));
  return { [AUTH.device]: device, [AUTH.ts]: ts, [AUTH.nonce]: nonce, [AUTH.sig]: b64u(sig) };
}

export interface RequestProof {
  device: DeviceId;
  nonce: string;
  ts: number;
  /** Whether it names the node that checked it (v2); false: it names none (v1). */
  named: boolean;
}

interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Returns the proven device, or null. Callers must still check enrollment, scope and nonce reuse. `node`: the node
 * checking it, by its own id: a request that names it (v2) is taken, and one that names none (v1) only while `legacy`
 * says so (before REQUESTS_NAME_THEIR_NODE_FROM; or whoami's, which its caller says). Without `node`, v1 alone: a link
 * call over Q-AMP, which its transport key already binds to its caller.
 */
export function verifyRequestSignature(
  headers: HeaderReader,
  method: string,
  path: string,
  body: Bytes,
  now = Date.now(),
  node?: DeviceId,
  legacy = now < REQUESTS_NAME_THEIR_NODE_FROM,
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
  // Only as its bytes encode: the last character's unused bits set would be the same signature written another way.
  // So a link call (a node's Ed25519 signature) has one form. A client's P-256 signature still has a second, (r, n − s),
  // since WebCrypto's signatures aren't low-S (verifyP256): harmless, as the nonce cache keys on the device and the
  // nonce, and refuses the second form of a request once the first is seen.
  if (b64u(signature) !== sig) return null;
  // A link call's node signature is held to Ed25519's strict rule from the cutoff, by the request's own time (identity.ts).
  if (node !== undefined && verifyDeviceSignature(device, signature, requestSigningInput(method, path, ts, nonce, body, node), time)) return { device, nonce, ts: time, named: true };
  if ((node === undefined || legacy) && verifyDeviceSignature(device, signature, requestSigningInput(method, path, ts, nonce, body), time)) return { device, nonce, ts: time, named: false };
  return null;
}

/** What a node signs to prove, to a device that asks, that it is the node its id names: the device's challenge. */
export const nodeProofInput = (challenge: string): Uint8Array<ArrayBuffer> => domain("invincible-node/v1", challenge);
/** A challenge as a device poses one: 16 to 64 base64url characters, fresh each time it asks. */
export const NODE_CHALLENGE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Whether `proof` (base64url) is the node `node`'s signature of `challenge` (nodeProofInput): it holds the key its id is,
 * so it is that node. A device pins the id it proved and names it in what it signs (whoami's `proof`). Held to the strict
 * rule (crypto.ts verifyEd25519Strict), as the apps hold it, so a node id that is a small-order point proves nothing.
 */
export function verifyNodeProof(node: string, challenge: string, proof: string): boolean {
  if (!isStrictNodeId(node) || !NODE_CHALLENGE.test(challenge)) return false;
  let signature: Bytes;
  try {
    signature = fromB64u(proof);
  } catch {
    return false;
  }
  return b64u(signature) === proof && verifyEd25519Strict(signature, nodeProofInput(challenge), fromB64u(node.slice(2)));
}

/** A fresh challenge, as a device poses one to whoami (NODE_CHALLENGE). */
export const nodeChallenge = (): string => b64u(randomBytes(24));

/**
 * What a whoami's answer to `challenge` says of the node a device speaks to, against the one it pinned (`pinned`):
 * - `pin`: proven, and none pinned yet: the device pins it, and names it in what it signs from then on;
 * - `same`: proven, and the one it pinned;
 * - `older`: no proof, none pinned yet, and before the cutoff: a node from before, spoken to as before (v1);
 * - `other`: proven, but another node than the one it pinned: not this device's node, and nothing more is asked of it;
 * - `false`: a proof that fails: never taken. So is an answer whose proof isn't one (null, not a string, no node), and,
 *   once a node is pinned, an answer that gives no proof: that node won't say which it is (the review of apps-name-node,
 *   L7 and I1). From the cutoff (`now`: when it was answered) every node proves which it is, so an answer with no proof
 *   fails pinned or not (the lead's word of 27 November 2026).
 */
export type NodeProven = { kind: "pin"; node: string } | { kind: "same"; node: string } | { kind: "other"; node: string } | { kind: "older" } | { kind: "false" };

export function judgeNodeProof(pinned: string | undefined, said: { node?: unknown; proof?: unknown }, challenge: string, now = Date.now()): NodeProven {
  if (said.proof === undefined) return pinned === undefined && now < REQUESTS_NAME_THEIR_NODE_FROM ? { kind: "older" } : { kind: "false" };
  if (typeof said.node !== "string" || typeof said.proof !== "string" || !verifyNodeProof(said.node, challenge, said.proof)) return { kind: "false" };
  if (pinned === undefined) return { kind: "pin", node: said.node };
  return said.node === pinned ? { kind: "same", node: said.node } : { kind: "other", node: said.node };
}

/**
 * Remembers nonces for the skew window so a captured request cannot be replayed. It remembers only since it began (a
 * node that restarts forgets what it saw), so a request signed before then is refused: it may have been taken already
 * (the slice 8 note's item 11, 27 November 2026). `since`: when it began.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly since = Date.now()) {}

  /** Whether a request signed at `signedAt` was signed before this cache began, so it may have been taken already. */
  signedBefore(signedAt: number): boolean {
    return signedAt < this.since;
  }

  /** Returns false if this (device, nonce) was already used, or was signed (`signedAt`) before this cache began. */
  claim(device: string, nonce: string, now: number, signedAt: number): boolean {
    if (signedAt < this.since) return false;
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
