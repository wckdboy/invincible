import { b64u, fromB64u } from "./bytes.ts";
import { canonical, type Json } from "./canonical.ts";
import { sha256B64u, verifyP256 } from "./crypto.ts";
import { type ClientIdentity, domain, isClientId } from "./identity.ts";
import type { Scope } from "./scopes.ts";

/*
 * Your word, signed end to end (slice 8; the design note of 27 November 2026, approved). Each event that is a word of
 * yours goes with a companion, word.signed, which the node that records the word writes just before it (the word's
 * prev), carrying the deciding device's P-256 signature over a statement of the word: its kind, its body's digest, the
 * fleet, a nonce and a time. From WORDS_SIGNED_FROM, by the word's own HLC, every replica applies a word only when its
 * companion holds; before it, as always. Old nodes keep the companion, a kind they don't know, and ignore it.
 *
 * 8a, this: the statement, its domain and verify, which events are words, the companion's kind and the log's rule, with
 * the cutoff far off. The routes that take a signed word (8b), the apps and `inv` signing (8c), enrollment, revocation
 * and rotation as words with the recovery key (8d), and the cutoff itself (8e) follow.
 */

/** From then (a word's HLC), a word of yours applies only with a companion that holds. Far off until every node and app
 * signs its words (8e). */
export const WORDS_SIGNED_FROM = Date.UTC(2100, 0, 1);

/** What a device of yours signs for a word: `domain(WORD_DOMAIN, canonical(statement))`, ECDSA P-256 over SHA-256, the
 * signature `r||s` raw, as requests are signed. */
export const WORD_DOMAIN = "invincible-word/v1";

/** How far a statement's own time (`at`) may be from its companion's HLC. */
export const WORD_SKEW_MS = 5 * 60_000;

/** A statement's nonce, as a request's is made (16 to 64 base64url characters). */
export const WORD_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The events that are your words, each with the scope a device of yours must hold to sign one: the scope of the route
 * that writes it. Enrollment, revocation and scoping (device.*) become words with the root of trust (8d).
 */
export const WORD_SCOPES = {
  "action.decided": "fleet:admin",
  "order.set": "fleet:admin",
  "order.revoked": "fleet:admin",
  "rule.set": "fleet:admin",
  "rule.removed": "fleet:admin",
  "seat.added": "fleet:admin",
  "seat.policy": "fleet:admin",
  "seat.serves": "fleet:admin",
  "seat.removed": "fleet:admin",
  "screen.decided": "fleet:admin",
  "skill.written": "mind:write",
  "skill.approved": "fleet:admin",
  "skill.marked": "fleet:admin",
  "skill.reverted": "fleet:admin",
  "handoff.granted": "fleet:admin",
  "handoff.revoked": "fleet:admin",
  "price.set": "brain:write",
  "compute.limit": "fleet:admin",
  "project.set": "brain:write",
} as const satisfies Record<string, Scope>;

export type WordKind = keyof typeof WORD_SCOPES;

/** Whether an event is a word of yours: its kind is one, a decision says it is yours (your agent's own is its own word),
 * and a skill's text was written by you. */
export function isWord(event: { kind: string; body: unknown; prov?: { trust?: string } }): event is { kind: WordKind; body: unknown; prov?: { trust?: string } } {
  if (!Object.hasOwn(WORD_SCOPES, event.kind)) return false;
  if (event.kind === "action.decided") return event.prov?.trust === "owner";
  if (event.kind === "skill.written") return (event.body as { by?: unknown } | null)?.by === "owner";
  return true;
}

/** What a device of yours signs for one word. */
export interface WordStatement {
  v: 1;
  fleet: string;
  kind: string;
  /** wordDigest of the word's body. */
  digest: string;
  nonce: string;
  /** When the device signed it, in ms since the epoch. */
  at: number;
}

/** A word's body, as its statement names it: the SHA-256 of its canonical JSON, base64url. */
export const wordDigest = (body: unknown): string => sha256B64u(canonical(body as Json));

/** The bytes a device of yours signs for a word: the domain, then the canonical statement (its six fields alone). */
export const wordSigningInput = (s: WordStatement): Uint8Array<ArrayBuffer> =>
  domain(WORD_DOMAIN, canonical({ v: s.v, fleet: s.fleet, kind: s.kind, digest: s.digest, nonce: s.nonce, at: s.at }));

/** A word's signature by a device of yours (the node's own clients sign so too; a phone, the web and `inv` sign the same
 * bytes with their own keys). */
export const signWord = (signer: ClientIdentity, s: WordStatement): string => b64u(signer.sign(wordSigningInput(s)));

/** Whether `sig` is the statement's signature by the client device `device` (its id is its P-256 key). */
export function verifyWordSignature(device: string, sig: string, s: WordStatement): boolean {
  if (!isClientId(device)) return false;
  try {
    return verifyP256(fromB64u(sig), wordSigningInput(s), fromB64u(device.slice(2)));
  } catch {
    return false;
  }
}
