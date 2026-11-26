import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { b64u, concat, fromB64u, utf8 } from "./bytes.ts";
import { CborError, type CborValue, cborDecode, cborEncode } from "./cbor.ts";
import { ed25519OfDidKey } from "./qamp.ts";
import { signEd25519, signingPublicKey, verifyEd25519 } from "./crypto.ts";

/*
 * Q-AMP delegation tokens (QDT, its SPEC 9.3), as far as a node writes them itself: a run's own Ed25519 key passing on
 * what its node was given for it (docs/ARCHITECTURE.md §2, a run's key; §3, the fabric). Everything else of a chain (the
 * node's grants, their renewals and revocations, and every check of a chain that reaches this node) is the sidecar's,
 * which holds the node's transport key and checks each call in full before the node hears of it.
 *
 * The format is the spec's, byte for byte: a CBOR map {p, s}; `p` the encoded payload, signed exactly as sent;
 * `s` the issuer's Ed25519 signature over the label qamp-delegation-v1, a zero byte, and `p`; the token's id SHA-256(p);
 * a chain as text `qdt1.` and base64url of the CBOR array of the encoded tokens, root first.
 */

/** A token's largest encoding (SPEC 9.3), and a chain's most links (9.4). */
export const QDT_MAX_TOKEN_BYTES = 2048;
export const QDT_MAX_CHAIN = 8;
export const QDT_CHAIN_PREFIX = "qdt1.";
const SIGNATURE_DST = utf8("qamp-delegation-v1\0");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc of bytes (Bitcoin's alphabet), leading zeros as `1`s. */
function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = `1${out}`;
  return out;
}

/** The `did:key` of an Ed25519 public key: `z`, then base58btc of the multicodec 0xed 0x01 and the key. */
export function didKeyOfEd25519(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return `did:key:z${base58btc(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
}

/** One statement of an argument policy (SPEC 9.7): what a token's `pol` holds. Checked by the sidecar, not here. */
export type QdtStatement = readonly unknown[];

export interface QdtPayload {
  iss: string;
  aud: string;
  /** The subject (the callee's DID); null: any node that trusts the chain's root. */
  sub: string | null;
  /** The capability: `/tool/<name>`, or a prefix of commands (SPEC 9.2). */
  cmd: string;
  nbf: number | null;
  /** Unix seconds: valid while now < exp. */
  exp: number;
  nonce: Uint8Array;
  pol: QdtStatement[] | null;
  meta: Record<string, unknown> | null;
}

/** A token as it travels (its envelope's bytes), its id (SHA-256 of its payload, hex), and what it says. */
export interface QdtToken {
  encoded: Uint8Array;
  id: string;
  payload: QdtPayload;
}

const COMMAND = /^\/$|^(\/[a-z0-9][a-z0-9_-]*)+$/;

/**
 * A token from an Ed25519 key (its 32-byte secret), signed as the spec says. Refused, never trimmed: a command that
 * isn't one, a lifetime already over, an audience or subject that isn't an Ed25519 or P-256 did:key, a token over 2 KiB.
 */
export function signQdt(
  secret: Uint8Array,
  input: { aud: string; cmd: string; exp: number; sub?: string | null; nbf?: number | null; pol?: QdtStatement[] | null; meta?: Record<string, unknown> | null; nonce?: Uint8Array },
): QdtToken {
  const iss = didKeyOfEd25519(signingPublicKey(secret));
  if (!COMMAND.test(input.cmd) || input.cmd.length > 256) throw new Error(`not a command: ${JSON.stringify(input.cmd).slice(0, 80)}`);
  if (!Number.isSafeInteger(input.exp) || input.exp <= 0) throw new Error("exp is Unix seconds");
  if (input.nbf != null && (!Number.isSafeInteger(input.nbf) || input.nbf < 0)) throw new Error("nbf is Unix seconds");
  for (const [field, did] of [["aud", input.aud], ["sub", input.sub ?? null]] as const) {
    if (did !== null && !/^did:key:z(6Mk|Dn)[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(did)) throw new Error(`${field} is not a did:key`);
  }
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(16));
  if (nonce.length !== 16) throw new Error("a nonce is 16 bytes");
  // A Map keeps this order on the wire; the order is not the signature's business (it covers p as sent).
  const fields = new Map<string, unknown>([
    ["iss", iss],
    ["aud", input.aud],
    ["sub", input.sub ?? null],
    ["cmd", input.cmd],
  ]);
  if (input.nbf != null) fields.set("nbf", input.nbf);
  fields.set("exp", input.exp);
  fields.set("nonce", nonce);
  if (input.pol?.length) fields.set("pol", input.pol);
  if (input.meta) fields.set("meta", input.meta);
  const p = cborEncode(fields);
  const s = signEd25519(secret, concat(SIGNATURE_DST, p));
  const encoded = cborEncode(new Map<string, unknown>([["p", p], ["s", s]]));
  if (encoded.length > QDT_MAX_TOKEN_BYTES) throw new Error(`a token is at most ${QDT_MAX_TOKEN_BYTES} bytes; this one is ${encoded.length}`);
  return { encoded, id: bytesToHex(sha256(p)), payload: { iss, aud: input.aud, sub: input.sub ?? null, cmd: input.cmd, nbf: input.nbf ?? null, exp: input.exp, nonce, pol: input.pol?.length ? input.pol : null, meta: input.meta ?? null } };
}

const asMap = (v: CborValue, what: string): Record<string, CborValue> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array) throw new CborError(`${what}: expected a map`);
  return v as Record<string, CborValue>;
};

const PAYLOAD_KEYS = new Set(["iss", "aud", "sub", "cmd", "nbf", "exp", "nonce", "pol", "meta"]);

/**
 * What a token says, and whether its issuer signed it, read as strictly as the spec reads it (no tags, no trailing
 * bytes, no duplicate or unknown keys, a 16-byte nonce, integer times). Only an Ed25519 issuer's signature is checked
 * here (`signed` false otherwise): this is for reading the node's own chains back and for tests, never a door, which
 * is the sidecar's.
 */
export function readQdt(encoded: Uint8Array): QdtToken & { signed: boolean } {
  if (encoded.length > QDT_MAX_TOKEN_BYTES) throw new CborError("a token is at most 2 KiB");
  const envelope = asMap(cborDecode(encoded, { rejectDuplicateKeys: true, rejectFloats: true }), "token");
  const keys = Object.keys(envelope);
  if (keys.length !== 2 || !(envelope.p instanceof Uint8Array) || !(envelope.s instanceof Uint8Array) || envelope.s.length !== 64) throw new CborError("token: a map of p and a 64-byte s");
  const p = envelope.p;
  const raw = asMap(cborDecode(p, { rejectDuplicateKeys: true }), "payload");
  for (const key of Object.keys(raw)) if (!PAYLOAD_KEYS.has(key)) throw new CborError(`payload: unknown key ${JSON.stringify(key)}`);
  const text = (v: CborValue | undefined, what: string): string => {
    if (typeof v !== "string") throw new CborError(`payload: ${what} is text`);
    return v;
  };
  const uint = (v: CborValue | undefined, what: string): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new CborError(`payload: ${what} is an unsigned integer`);
    return v;
  };
  if (!(raw.nonce instanceof Uint8Array) || raw.nonce.length !== 16) throw new CborError("payload: a 16-byte nonce");
  const payload: QdtPayload = {
    iss: text(raw.iss, "iss"),
    aud: text(raw.aud, "aud"),
    sub: raw.sub == null ? null : text(raw.sub, "sub"),
    cmd: text(raw.cmd, "cmd"),
    nbf: raw.nbf == null ? null : uint(raw.nbf, "nbf"),
    exp: uint(raw.exp, "exp"),
    nonce: raw.nonce,
    pol: raw.pol == null ? null : (raw.pol as QdtStatement[]),
    meta: raw.meta == null ? null : (asMap(raw.meta, "meta") as Record<string, unknown>),
  };
  const key = ed25519OfDidKey(payload.iss);
  const signed = key !== null && verifyEd25519(envelope.s, concat(SIGNATURE_DST, p), key);
  return { encoded, id: bytesToHex(sha256(p)), payload, signed };
}

/** A chain as text: `qdt1.` and base64url (no padding) of the CBOR array of its encoded tokens, root first. */
export function qdtChainText(tokens: readonly Uint8Array[]): string {
  if (!tokens.length || tokens.length > QDT_MAX_CHAIN) throw new Error(`a chain has 1 to ${QDT_MAX_CHAIN} tokens`);
  return `${QDT_CHAIN_PREFIX}${b64u(cborEncode([...tokens]))}`;
}

/** A chain's encoded tokens, root first, from its text (bounded first; each token is read by readQdt when it matters). */
export function qdtChainTokens(text: string): Uint8Array[] {
  const body = text.trim();
  if (!body.startsWith(QDT_CHAIN_PREFIX)) throw new Error("a chain's text begins qdt1.");
  const b64 = body.slice(QDT_CHAIN_PREFIX.length);
  if (b64.length > Math.ceil(((9 + QDT_MAX_CHAIN * (9 + QDT_MAX_TOKEN_BYTES)) * 4) / 3)) throw new Error("that chain is too long to be one");
  const items = cborDecode(fromB64u(b64), { rejectDuplicateKeys: true, rejectFloats: true });
  if (!Array.isArray(items) || !items.length || items.length > QDT_MAX_CHAIN || !items.every((t) => t instanceof Uint8Array)) throw new Error(`a chain is 1 to ${QDT_MAX_CHAIN} encoded tokens`);
  return items as Uint8Array[];
}
