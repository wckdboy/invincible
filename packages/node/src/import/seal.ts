import { aeadOpen, type Bytes, fromUtf8, openSealed, type SealedBox } from "@invincible/core";

/*
 * Galahad's vault, as its code before the rename sealed it (its mind's vault.ts, its core's crypto.ts): the vault key
 * sealed to each full node's X25519 key under its own label, each secret sealed with the vault key under its own. The
 * same primitives as Invincible's vault, the old labels: a value opens here only where it opened there.
 */

/** The label each sealed box's key was derived under (core's sealTo, before the rename). */
const SEAL = "galahad/seal/v1";

/** What a grant of a vault key to one node was bound to. */
const grantContext = (fleet: string, kid: string, device: string) => `vault-grant|${fleet}|${kid}|${device}`;

/** What a secret's ciphertext was bound to. */
const secretAad = (fleet: string, name: string, kid: string) => `galahad/secret/v1|${fleet}|${name}|${kid}`;

/** The vault key `kid`, from its grant to `device` (whose X25519 secret is `boxSecret`). Throws when it doesn't open. */
export function openGrant(boxSecret: Bytes, box: SealedBox, fleet: string, kid: string, device: string): Bytes {
  return openSealed(boxSecret, box, grantContext(fleet, kid, device), SEAL);
}

/** A secret's value, in memory only. Throws when it doesn't open (another key, or bytes changed). */
export function openSecret(key: Bytes, record: { name: string; kid: string; nonce: string; ct: string }, fleet: string): string {
  return fromUtf8(aeadOpen(key, { nonce: record.nonce, ct: record.ct }, secretAad(fleet, record.name, record.kid)));
}
