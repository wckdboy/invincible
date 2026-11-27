import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { b64u, clientIdentity, type ClientIdentity, fromB64u, newClientSecret } from "@invincible/core";
import { z } from "zod";
import { CliError, EXIT } from "./exit.ts";

/*
 * Where inv keeps its pairing with a node (docs/CLI.md, "Reaching a node"):
 *
 *   $INVINCIBLE_CLI_HOME, else $XDG_CONFIG_HOME/invincible, else ~/.config/invincible
 *     cli.json   the node's address, the fleet, this device's id and name: no secret (0600 all the same)
 *     key.json   this device's P-256 key, where there is no keychain for it (0600)
 *
 * On a Mac the key is kept in the login keychain instead, under KEYCHAIN_SERVICE and this home's path, unless
 * INVINCIBLE_KEYSTORE=file (the tests' way: they never touch a keychain). The key never leaves the machine: the node
 * knows the device by its public half, which is its id.
 */

export const KEYCHAIN_SERVICE = "dev.invincible.cli";

export type Keystore = "keychain" | "file";

const Pairing = z.strictObject({
  v: z.literal(1),
  /** The node's address, as its invite gave it. */
  node: z.string().url(),
  /** What the node is called, as it said when the pairing was made (null: it didn't say). */
  nodeName: z.string().max(200).nullable(),
  fleet: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** This device's id: its P-256 public key (core's clientIdFromKey). */
  device: z.string().regex(/^c_[A-Za-z0-9_-]{87}$/),
  name: z.string().min(1).max(64),
  keystore: z.enum(["keychain", "file"]),
  pairedAt: z.number().int().min(0),
  /**
   * The node it speaks to, as that node proved (client.ts provenWhoami): what this device signs names it (the slice 8
   * note's item 11). Absent from a pairing made before it, or with a node from before it: proved, and kept, at the next
   * connection.
   */
  nodeId: z.string().regex(/^n_[A-Za-z0-9_-]{43}$/).optional(),
});
export type Pairing = z.infer<typeof Pairing>;

const StoredKey = z.strictObject({ v: z.literal(1), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

/** The environment inv reads for its home and its keystore. */
export interface CliEnv {
  [name: string]: string | undefined;
  INVINCIBLE_CLI_HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  INVINCIBLE_KEYSTORE?: string | undefined;
}

/** The keystore a new key goes to: the login keychain on a Mac, a 0600 file elsewhere or when asked for. */
export const keystoreFor = (env: CliEnv, platform: NodeJS.Platform = process.platform): Keystore =>
  env.INVINCIBLE_KEYSTORE === "file" || platform !== "darwin" ? "file" : "keychain";

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* a file system that keeps no modes: the user's own directory is what guards it */
  }
}

export class CliHome {
  readonly pairingPath: string;
  readonly keyPath: string;

  constructor(readonly dir: string) {
    this.pairingPath = join(dir, "cli.json");
    this.keyPath = join(dir, "key.json");
  }

  static resolve(env: CliEnv = process.env): CliHome {
    const config = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
    return new CliHome(resolve(env.INVINCIBLE_CLI_HOME?.trim() ? env.INVINCIBLE_CLI_HOME : join(config, "invincible")));
  }

  /** The pairing, or null when there is none. One that can't be read is said, never taken for none. */
  pairing(): Pairing | null {
    if (!existsSync(this.pairingPath)) return null;
    const parsed = Pairing.safeParse(JSON.parse(readFileSync(this.pairingPath, "utf8")));
    if (!parsed.success) throw new CliError(`${this.pairingPath} isn't a pairing this inv can read: inv pair --forget, then pair again`);
    return parsed.data;
  }

  savePairing(pairing: Pairing): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivate(this.pairingPath, `${JSON.stringify(Pairing.parse(pairing), null, 2)}\n`);
  }

  /** A new key for this device, kept in `keystore` before anything is asked of a node. */
  async newKey(keystore: Keystore): Promise<ClientIdentity> {
    const secret = newClientSecret();
    const text = JSON.stringify({ v: 1, d: b64u(secret) });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (keystore === "keychain") {
      try {
        await Bun.secrets.set({ service: KEYCHAIN_SERVICE, name: this.dir, value: text });
      } catch (error) {
        throw new CliError(`the login keychain didn't take this device's key (${(error as Error).message}): unlock it, or keep the key in a 0600 file with INVINCIBLE_KEYSTORE=file`);
      }
    } else writePrivate(this.keyPath, text);
    return clientIdentity(secret);
  }

  /** This device's key, as the pairing says where it is kept. */
  async key(pairing: Pick<Pairing, "keystore" | "device">): Promise<ClientIdentity> {
    const text = pairing.keystore === "keychain" ? await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name: this.dir }) : existsSync(this.keyPath) ? readFileSync(this.keyPath, "utf8") : null;
    if (!text) throw new CliError(`this device's key isn't in its ${pairing.keystore === "keychain" ? "login keychain" : `file (${this.keyPath})`}: inv pair --forget, then pair again`, EXIT.refused);
    const stored = StoredKey.safeParse(JSON.parse(text));
    if (!stored.success) throw new CliError("this device's key isn't in a form this inv reads: inv pair --forget, then pair again");
    const identity = clientIdentity(fromB64u(stored.data.d));
    if (identity.id !== pairing.device) throw new CliError("this device's key isn't the one it was paired with: inv pair --forget, then pair again", EXIT.refused);
    return identity;
  }

  /** The pairing and the key, gone from here (the node keeps the device until it is revoked there). */
  async forget(keystore: Keystore | null): Promise<void> {
    if (keystore === "keychain") await Bun.secrets.delete({ service: KEYCHAIN_SERVICE, name: this.dir }).catch(() => false);
    rmSync(this.keyPath, { force: true });
    rmSync(this.pairingPath, { force: true });
  }
}
