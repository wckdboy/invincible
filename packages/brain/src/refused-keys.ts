/*
 * A provider that refuses its key (an answer of 401 to a model call, or a 403 that says it is the key's) is remembered,
 * as a spent allowance is: which provider, when, and what it said. A later model call to that provider that succeeds
 * forgets it, whichever of chat or a tool's call through the gateway got through. The doctor (node/doctor.ts) says each one still remembered, with what
 * to do, and the Inbox carries the same words; a refusal from before the provider's key was last set is not said (the
 * key was replaced since). Kept in memory and in the node's own database (node/usage.ts), so a restart remembers it.
 *
 * Only the words matter here: no key, token or header is ever kept or said. Its callers take the provider's own key out
 * of what it said (the gateway and chat redact it by its value), and what is kept is scanned again here for anything
 * shaped like a secret, since a provider refusing a key often says it back ("Incorrect API key provided: sk-…").
 */

import { decodeHlc, redact } from "@galahad/core";
import type { MindStore, Vault } from "@galahad/mind";
import { refusalWords } from "./adapters.ts";
import { providerRecord } from "./providers.ts";

/**
 * The status a call's error begins with: "401 …" as the gateway says it, "mimo-token → 401 …" as chat does, and
 * "deepseek: 401 …" as an error said in the middle of a stream is.
 */
const STATUS = /^(?:[\w.:-]+?(?: \/models)?(?: →|:) )?(\d{3})\b/;

/**
 * A 403's words that speak of the key: the key, its credentials, its authentication, a token that is invalid, expired or
 * revoked. A 403 refuses what was asked as often as the key that asked it (OpenRouter's, when a model's moderation flags
 * what was sent; OpenAI's, from a country it doesn't serve; an author's rights, a tier's token limit), and replacing a
 * key that works is no fix for any of them. (A bare "403 Forbidden" says nothing either way, and is not said.)
 */
const OF_THE_KEY = /\b(?:api[ _-]?keys?|keys?|credentials?|authenticat\w*|unauthenticated|unauthori[sz]ed|(?:invalid|expired|revoked)\s+(?:\w+\s+)?tokens?|tokens?\s+(?:is\s+|has\s+been\s+)?(?:invalid|expired|revoked))\b/i;

/** Whether a call's error refused its key: a 401, or a 403 whose words after its status speak of the key (never a name). */
export function refusesKey(error: string): boolean {
  const said = error.trim();
  const found = STATUS.exec(said);
  if (!found) return false;
  const status = Number(found[1]);
  return status === 401 || (status === 403 && OF_THE_KEY.test(said.slice(found[0].length)));
}

/** One provider whose key a call got refused: who, when, and what it said. */
export interface RefusedKey {
  provider: string;
  /** When it was refused (ms). */
  at: number;
  /** What its provider said, in its own words (a status and a message; cut short). */
  said: string;
}

export class RefusedKeys {
  /** The clock (tests set their own). */
  now: () => number = Date.now;
  /** Told of each refusal as it is noted, to keep it through a restart (a node's database; none: memory alone). */
  kept: ((refusal: RefusedKey) => void) | null = null;
  /** Told when a refusal is forgotten, to forget it in what keeps it. */
  forgot: ((provider: string) => void) | null = null;
  private readonly refusals = new Map<string, RefusedKey>();

  /**
   * Read a provider's refusal: a 401, or a 403 whose words speak of the key (an answer that refused its key), is
   * remembered, with what it said, for that provider. Anything else is not a refused key and is left alone. `error` may
   * carry the provider's name before the status ("mimo-token → 401 …"), as a call's error says it; the status is read
   * where it stands there, never from the words after it, and the words kept are the status and the message alone.
   */
  note(provider: string, error: string): RefusedKey | null {
    if (!refusesKey(error)) return null;
    const words = refusalWords(redact(error), 200);
    const named = [`${provider} → `, `${provider}: `].find((prefix) => words.startsWith(prefix));
    const said = named ? words.slice(named.length) : words;
    const refusal: RefusedKey = { provider, at: this.now(), said };
    this.refusals.set(provider, refusal);
    this.kept?.(refusal);
    return refusal;
  }

  /** A later model call that got through: the key works, so the refusal of it is forgotten. */
  forget(provider: string): void {
    if (this.refusals.delete(provider)) this.forgot?.(provider);
  }

  /** The refusal a provider is under, or null. */
  refused(provider: string): RefusedKey | null {
    return this.refusals.get(provider) ?? null;
  }

  /** Refusals kept from before a restart. */
  restore(refusals: readonly RefusedKey[]): void {
    for (const refusal of refusals) this.refusals.set(refusal.provider, refusal);
  }

  /** Every refusal still remembered. */
  list(): RefusedKey[] {
    return [...this.refusals.values()].sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.at - b.at));
  }
}

const kept = new WeakMap<object, RefusedKeys>();

/** A node's own record of refused keys: one for each mind it keeps (a node keeps one). */
export function refusedKeysOf(store: object): RefusedKeys {
  let refusals = kept.get(store);
  if (!refusals) {
    refusals = new RefusedKeys();
    kept.set(store, refusals);
  }
  return refusals;
}

/**
 * The refusals a node still says: each one remembered, unless the provider's key was set again since it was refused
 * (its secret's last set is newer than the refusal: the key has been replaced, so the refusal is moot and not said).
 */
export function refusalsStillSaid(store: MindStore, vault: Vault): RefusedKey[] {
  return refusedKeysOf(store)
    .list()
    .filter((refusal) => {
      const record = providerRecord(store, refusal.provider);
      const info = record?.secret ? vault.info(record.secret) : null;
      return !info || decodeHlc(info.hlc).ms <= refusal.at;
    });
}
