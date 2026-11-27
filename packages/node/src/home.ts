import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { b64u, didKeyOfEd25519, exportIdentity, fromB64u, importIdentity, newNodeIdentity, newPushKeyPair, type NodeIdentity, type PushKeyPair, pushPublicKey, randomId, signingPublicKey, signTransportClaim } from "@invincible/core";
import { z } from "zod";
import { loadEnv } from "./env.ts";

/*
 * ~/.invincible/
 *   config.json   node name, fleet id, port, keystore choice
 *   ledger.db       this node's replica of the mind (the log + views)
 *   local.db      node-local state that never replicates (gateway tokens)
 *   admin.token   local CLI credential (0600)
 *   keys.json     device private keys, only when the OS keychain is unavailable (0600)
 *   push-key.json this node's notification key (VAPID), only when the OS keychain is unavailable (0600)
 *   transport-key.json  its Q-AMP transport key (the fabric), only when the OS keychain is unavailable (0600)
 *   push.db       who gets notifications and what was sent (node-local, 0600; see notify-store.ts)
 */

const Config = z.strictObject({
  v: z.literal(1),
  name: z.string().min(1).max(64),
  fleet: z.string().nullable(),
  port: z.number().int(),
  keystore: z.enum(["os", "file"]),
  /** Address this node advertises to peers (normally its tailnet IP). */
  advertise: z.string().nullable(),
  /** On a Mac: keep it from sleeping while the node runs (`invincible awake on`; keep-awake.ts). Absent: off. */
  keepAwake: z.boolean().optional(),
  /**
   * Its agents across nodes over Q-AMP, through its sidecar (`invincible fabric on`; docs/FABRIC.md). Absent: off, whatever
   * binary it has: a `qamp` with a sidecar in its place switches nothing on by being there (the grants' bridges run it either way).
   */
  fabric: z.boolean().optional(),
  /**
   * Layout 2 for its agents' VMs, a HOME apart from each one's workspace (`invincible sandbox layout on`; the sandbox's
   * layout.ts), on a Linux host with Docker. Absent: off, every agent's VM in layout 1, and another node's task refused here.
   */
  layout2: z.boolean().optional(),
});
export type NodeConfig = z.infer<typeof Config>;

const KEYCHAIN_SERVICE = "dev.invincible.node";
/** How Q-AMP reads an Ed25519 key: `qamp-sk1.` and base64url of its 32-byte seed. */
const QAMP_KEY_PREFIX = "qamp-sk1.";

/** The OS keychain, as Bun gives it (tests: a stand-in, so no test touches the real one). */
export interface Secrets {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

/**
 * The node's transport key (fabric/sidecar.ts): Ed25519, its sidecar's alone, never the device key. It carries calls and
 * nothing more: each link call is signed by the device key too. Kept where the device keys are, for this node's id: a
 * home enrolled again as another node gets a key of its own.
 */
export interface TransportKey {
  did: string;
  /** As Q-AMP reads a key (`qamp-sk1.…`), for the sidecar's stdin and nothing else. */
  text: string;
  /** Its signature that it is this node's (core's signTransportClaim), for its profile. */
  pop: string;
}

export class Home {
  readonly configPath: string;
  readonly ledgerPath: string;
  readonly localPath: string;
  readonly adminTokenPath: string;
  readonly keyFilePath: string;
  readonly pushKeyPath: string;
  /** The transport key, only when the OS keychain is unavailable (0600); before the keystore, it was <home>/qamp/node.qamp-key. */
  readonly transportKeyPath: string;

  constructor(
    readonly dir: string,
    private readonly secrets: Secrets = Bun.secrets,
  ) {
    this.transportKeyPath = join(dir, "transport-key.json");
    this.pushKeyPath = join(dir, "push-key.json");
    this.configPath = join(dir, "config.json");
    this.ledgerPath = join(dir, "ledger.db");
    this.localPath = join(dir, "local.db");
    this.adminTokenPath = join(dir, "admin.token");
    this.keyFilePath = join(dir, "keys.json");
  }

  static resolve(dir?: string): Home {
    return new Home(resolve(dir ?? loadEnv().INVINCIBLE_HOME ?? join(homedir(), ".invincible")));
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  readConfig(): NodeConfig {
    if (!this.exists()) throw new Error(`no Invincible node at ${this.dir} — run \`invincible init\` or \`invincible join\``);
    return Config.parse(JSON.parse(readFileSync(this.configPath, "utf8")));
  }

  writeConfig(config: NodeConfig): void {
    this.ensureDir();
    writeFileSync(this.configPath, `${JSON.stringify(Config.parse(config), null, 2)}\n`, { mode: 0o600 });
  }

  // ---- device keys ---------------------------------------------------------

  async createIdentity(keystore: "os" | "file"): Promise<{ identity: NodeIdentity; keystore: "os" | "file" }> {
    this.ensureDir();
    const identity = newNodeIdentity();
    const serialized = exportIdentity(identity);
    if (keystore === "os") {
      try {
        await Bun.secrets.set({ service: KEYCHAIN_SERVICE, name: this.dir, value: serialized });
        return { identity, keystore: "os" };
      } catch {
        // Headless Linux without a Secret Service, for example: fall back to a 0600 file.
      }
    }
    writeSecretFile(this.keyFilePath, serialized);
    return { identity, keystore: "file" };
  }

  async loadIdentity(keystore: "os" | "file"): Promise<NodeIdentity> {
    const serialized =
      keystore === "os"
        ? await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name: this.dir })
        : existsSync(this.keyFilePath)
          ? readFileSync(this.keyFilePath, "utf8")
          : null;
    if (!serialized) throw new Error(`device keys not found in the ${keystore} keystore for ${this.dir}`);
    return importIdentity(serialized);
  }

  // ---- this node's notification key (VAPID) --------------------------------

  /**
   * The key this node proves itself to push services with (RFC 8292), a P-256 pair. Made here, on the node, the first
   * time a device asks to be notified, and kept where its device keys are: the OS keychain, or a 0600 file in its home.
   * Never shown, logged or put in the mind; only its public half ever leaves (a browser subscribes to it).
   */
  async pushKey(keystore: "os" | "file"): Promise<PushKeyPair> {
    const read = (text: string | null): PushKeyPair | null => {
      if (!text) return null;
      const stored = JSON.parse(text) as { v?: number; d?: unknown };
      if (stored.v !== 1 || typeof stored.d !== "string") throw new Error("this node's notification key isn't in a form this version reads");
      const privateKey = fromB64u(stored.d);
      // Throws unless it is a P-256 private key.
      return { privateKey, publicKey: pushPublicKey(privateKey) };
    };
    const account = `${this.dir}#push`;
    if (keystore === "os") {
      const kept = read(await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name: account }));
      if (kept) return kept;
    } else if (existsSync(this.pushKeyPath)) {
      const kept = read(readFileSync(this.pushKeyPath, "utf8"));
      if (kept) return kept;
    }
    this.ensureDir();
    const pair = newPushKeyPair();
    const serialized = JSON.stringify({ v: 1, d: b64u(pair.privateKey) });
    if (keystore === "os") await Bun.secrets.set({ service: KEYCHAIN_SERVICE, name: account, value: serialized });
    else writeSecretFile(this.pushKeyPath, serialized);
    return pair;
  }

  // ---- this node's transport key (Q-AMP; fabric/sidecar.ts) -----------------

  /**
   * The node's transport key for `node` (its device id): made the first time its sidecar starts, kept where its device
   * keys are (the OS keychain, or a 0600 file in its home), and made anew when the one kept is another node's (a home
   * enrolled again). A key from before the keystore (<home>/qamp/node.qamp-key) is replaced and removed: nothing ran on it.
   */
  async transportKey(keystore: "os" | "file", node: string): Promise<TransportKey> {
    const kept = await this.keptTransport(keystore);
    if (kept && kept.node === node) return transportKeyOf(fromB64u(kept.seed), node);
    return this.rotateTransportKey(keystore, node);
  }

  /** A new transport key for `node`, in place of the one kept (its sidecar is started again on it, and its profile names it). */
  async rotateTransportKey(keystore: "os" | "file", node: string): Promise<TransportKey> {
    this.ensureDir();
    const seed = randomBytes(32);
    const serialized = JSON.stringify({ v: 1, node, seed: b64u(seed) });
    if (keystore === "os") await this.secrets.set({ service: KEYCHAIN_SERVICE, name: `${this.dir}#qamp`, value: serialized });
    else writeSecretFile(this.transportKeyPath, serialized);
    rmSync(join(this.dir, "qamp", "node.qamp-key"), { force: true });
    const key = transportKeyOf(seed, node);
    seed.fill(0);
    return key;
  }

  private async keptTransport(keystore: "os" | "file"): Promise<{ node: string; seed: string } | null> {
    const text = keystore === "os" ? await this.secrets.get({ service: KEYCHAIN_SERVICE, name: `${this.dir}#qamp` }) : existsSync(this.transportKeyPath) ? readFileSync(this.transportKeyPath, "utf8") : null;
    if (!text) return null;
    const stored = JSON.parse(text) as { v?: number; node?: unknown; seed?: unknown };
    if (stored.v !== 1 || typeof stored.node !== "string" || typeof stored.seed !== "string") throw new Error("this node's transport key isn't in a form this version reads");
    return { node: stored.node, seed: stored.seed };
  }

  // ---- arm tokens (MCP) ----------------------------------------------------

  armTokenPath(label: string): string {
    return join(this.dir, "arms", `${label}.token`);
  }

  writeArmToken(label: string, token: string): string {
    const path = this.armTokenPath(label);
    mkdirSync(join(this.dir, "arms"), { recursive: true, mode: 0o700 });
    writeSecretFile(path, token);
    return path;
  }

  readArmToken(label: string): string {
    const path = this.armTokenPath(label);
    if (!existsSync(path)) throw new Error(`no arm token for "${label}" — run \`invincible mcp install <target> --label ${label}\``);
    return readFileSync(path, "utf8").trim();
  }

  // ---- local admin credential ---------------------------------------------

  adminToken(): string {
    if (existsSync(this.adminTokenPath)) return readFileSync(this.adminTokenPath, "utf8").trim();
    const token = `adm_${randomId(32)}`;
    writeSecretFile(this.adminTokenPath, token);
    return token;
  }
}

/** A transport key from its seed: its DID, its text for the sidecar, and its proof that it is `node`'s. */
export function transportKeyOf(seed: Uint8Array, node: string): TransportKey {
  if (seed.length !== 32) throw new Error("this node's transport key isn't an Ed25519 key's seed");
  return { did: didKeyOfEd25519(signingPublicKey(seed)), text: `${QAMP_KEY_PREFIX}${b64u(seed)}\n`, pop: signTransportClaim(seed, node) };
}

function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: the user profile ACL already restricts access */
  }
}
