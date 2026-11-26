import {
  aeadOpen,
  aeadSeal,
  fromB64u,
  fromUtf8,
  type NodeIdentity,
  openSealed,
  randomBytes,
  randomId,
  type SealedBox,
  sealTo,
  utf8,
} from "@galahad/core";
import { isFullNode, type MindStore } from "./store.ts";

/*
 * The vault: one key adds an API key everywhere, without the key ever appearing
 * in the log in plaintext.
 *
 *   vault key (per key id, "kid")   random 32 bytes
 *   grant                            vault key sealed to one full node's X25519 key
 *   secret.set                       XChaCha20-Poly1305(vault key, value), AAD = fleet|name|kid
 *
 * Only full nodes ever hold the vault key. Clients (the PWA, phones) and arms
 * (sandboxes, coding agents) never see provider keys: they go through the
 * model gateway with scoped, revocable tokens.
 */

export interface SecretMetaInput {
  provider?: string;
  label?: string;
  /** Origin the key may be sent to, e.g. https://api.deepseek.com */
  origin?: string;
}

export interface SecretInfo {
  name: string;
  kid: string;
  provider: string | null;
  label: string | null;
  hint: string | null;
  origin: string | null;
  hlc: string;
  device: string;
}

interface SecretRecord {
  name: string;
  kid: string;
  nonce: string;
  ct: string;
  meta: { provider?: string; hint?: string; label?: string; origin?: string };
}

export class VaultLockedError extends Error {
  constructor(kid: string) {
    super(`this node holds no grant for vault key ${kid}`);
  }
}

export class Vault {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(
    private readonly store: MindStore,
    private readonly identity: NodeIdentity,
  ) {}

  private get fleet(): string {
    const fleet = this.store.fleet;
    if (!fleet) throw new Error("no fleet");
    return fleet;
  }

  private grantContext = (kid: string, device: string) => `vault-grant|${this.fleet}|${kid}|${device}`;
  private secretAad = (name: string, kid: string) => `galahad/secret/v1|${this.fleet}|${name}|${kid}`;

  currentKid(): string | null {
    return this.store.lww<{ kid: string }>("vault:current")?.value?.kid ?? null;
  }

  /** True if this node can decrypt secrets under the current key. */
  unlocked(): boolean {
    const kid = this.currentKid();
    return !!kid && !!this.store.grant(kid, this.identity.id);
  }

  private key(kid: string): Uint8Array {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    const grant = this.store.grant(kid, this.identity.id);
    if (!grant) throw new VaultLockedError(kid);
    const key = openSealed(this.identity.boxSecret, JSON.parse(grant) as SealedBox, this.grantContext(kid, this.identity.id));
    this.keys.set(kid, key);
    return key;
  }

  /** Create a fresh vault key, sealed to every active full node. */
  createKey(): string {
    const kid = randomId(16);
    const key = randomBytes(32);
    const grants: Record<string, SealedBox> = {};
    for (const device of this.store.devices()) {
      if (isFullNode(device) && device.box) grants[device.id] = sealTo(fromB64u(device.box), key, this.grantContext(kid, device.id));
    }
    if (!grants[this.identity.id]) throw new Error("this node is not an active full node");
    this.store.emit(this.identity, "vault.key", { kid, grants });
    this.keys.set(kid, key);
    return kid;
  }

  private ensureKey(): string {
    return this.currentKid() ?? this.createKey();
  }

  /** Seal every vault key still in use to a newly enrolled full node. */
  grantTo(deviceId: string): string[] {
    const device = this.store.activeDevice(deviceId);
    if (!isFullNode(device) || !device.box) throw new Error("grants go to active full nodes only");
    const kids = new Set<string>();
    const current = this.currentKid();
    if (current) kids.add(current);
    for (const secret of this.records()) kids.add(secret.kid);
    const granted: string[] = [];
    for (const kid of kids) {
      if (this.store.grant(kid, deviceId)) continue;
      const box = sealTo(fromB64u(device.box), this.key(kid), this.grantContext(kid, deviceId));
      this.store.emit(this.identity, "vault.grant", { kid, device: deviceId, box });
      granted.push(kid);
    }
    return granted;
  }

  set(name: string, value: string, meta: SecretMetaInput = {}): SecretInfo {
    const kid = this.ensureKey();
    const sealed = aeadSeal(this.key(kid), utf8(value), this.secretAad(name, kid));
    const hint = value.length >= 12 ? `…${value.slice(-4)}` : undefined;
    this.store.emit(this.identity, "secret.set", {
      name,
      kid,
      ...sealed,
      meta: {
        ...(meta.provider ? { provider: meta.provider } : {}),
        ...(meta.label ? { label: meta.label } : {}),
        ...(meta.origin ? { origin: meta.origin } : {}),
        ...(hint ? { hint } : {}),
      },
    });
    return this.info(name)!;
  }

  /** Pin an existing, unpinned key to an origin (one-time migration; the value is re-sealed unchanged). */
  pin(name: string, origin: string): boolean {
    const record = this.store.lww<SecretRecord>(`secret:${name}`)?.value;
    if (!record || record.meta.origin) return false;
    const value = this.reveal(name);
    const kid = this.ensureKey();
    const sealed = aeadSeal(this.key(kid), utf8(value), this.secretAad(name, kid));
    this.store.emit(this.identity, "secret.set", { name, kid, ...sealed, meta: { ...record.meta, origin } });
    return true;
  }

  /** Plaintext, in memory only. Never log it, never return it to a client. */
  reveal(name: string): string {
    const record = this.store.lww<SecretRecord>(`secret:${name}`)?.value;
    if (!record) throw new Error(`no secret named ${name}`);
    return fromUtf8(aeadOpen(this.key(record.kid), record, this.secretAad(name, record.kid)));
  }

  has(name: string): boolean {
    return !!this.store.lww(`secret:${name}`)?.value;
  }

  delete(name: string): void {
    if (this.has(name)) this.store.emit(this.identity, "secret.deleted", { name });
  }

  info(name: string): SecretInfo | null {
    const entry = this.store.lww<SecretRecord>(`secret:${name}`);
    if (!entry?.value) return null;
    const { kid, meta } = entry.value;
    return {
      name,
      kid,
      provider: meta.provider ?? null,
      label: meta.label ?? null,
      hint: meta.hint ?? null,
      origin: meta.origin ?? null,
      hlc: entry.hlc,
      device: entry.device,
    };
  }

  list(): SecretInfo[] {
    return this.records().map((r) => this.info(r.name)!);
  }

  /** Ask your liege for a credential. Fulfilled when a secret with that name is set afterwards. */
  request(name: string, purpose: string, provider?: string): void {
    this.store.emit(this.identity, "secret.requested", { name, purpose, ...(provider ? { provider } : {}) });
  }

  /** Dismisses an open request: it leaves the Inbox until he asks for it again. False when none is open by that name. */
  dismissRequest(name: string): boolean {
    if (!this.requests().some((r) => r.name === name)) return false;
    this.store.emit(this.identity, "secret.request.dismissed", { name });
    return true;
  }

  /** Open requests: asked for, and not set or dismissed since. */
  requests(): { name: string; provider: string | null; purpose: string; hlc: string; device: string }[] {
    return this.store
      .lwwPrefix<{ name: string; provider?: string; purpose: string }>("secret-request:")
      .filter((entry) => {
        const secret = this.store.lww(`secret:${entry.value!.name}`);
        return !secret?.value || secret.hlc < entry.hlc;
      })
      .map((entry) => ({
        name: entry.value!.name,
        provider: entry.value!.provider ?? null,
        purpose: entry.value!.purpose,
        hlc: entry.hlc,
        device: entry.device,
      }));
  }

  private records(): SecretRecord[] {
    return this.store.lwwPrefix<SecretRecord>("secret:").map((e) => e.value!);
  }

  /**
   * New vault key for the remaining full nodes; every live secret is re-sealed.
   * Run after revoking a device. The revoked device may have seen plaintext
   * before, so the returned names should also be rotated at the provider.
   */
  rotate(): { kid: string; resealed: string[] } {
    const plaintexts = this.records().map((r) => ({ name: r.name, value: this.reveal(r.name), meta: r.meta }));
    const kid = this.createKey();
    for (const { name, value, meta } of plaintexts) {
      const sealed = aeadSeal(this.key(kid), utf8(value), this.secretAad(name, kid));
      this.store.emit(this.identity, "secret.set", { name, kid, ...sealed, meta });
    }
    return { kid, resealed: plaintexts.map((p) => p.name) };
  }
}

