import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { b64u, exportIdentity, fromB64u, importIdentity, newNodeIdentity, newPushKeyPair, type NodeIdentity, type PushKeyPair, pushPublicKey, randomId } from "@galahad/core";
import { z } from "zod";
import { loadEnv } from "./env.ts";

/*
 * ~/.galahad/
 *   config.json   node name, fleet id, port, keystore choice
 *   mind.db       this node's replica of the mind (the log + views)
 *   local.db      node-local state that never replicates (gateway tokens)
 *   admin.token   local CLI credential (0600)
 *   keys.json     device private keys, only when the OS keychain is unavailable (0600)
 *   push-key.json this node's notification key (VAPID), only when the OS keychain is unavailable (0600)
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
  /** On a Mac: keep it from sleeping while the node runs (`galahad awake on`; keep-awake.ts). Absent: off. */
  keepAwake: z.boolean().optional(),
});
export type NodeConfig = z.infer<typeof Config>;

const KEYCHAIN_SERVICE = "dev.galahad.node";

export class Home {
  readonly configPath: string;
  readonly mindPath: string;
  readonly localPath: string;
  readonly adminTokenPath: string;
  readonly keyFilePath: string;
  readonly pushKeyPath: string;

  constructor(readonly dir: string) {
    this.pushKeyPath = join(dir, "push-key.json");
    this.configPath = join(dir, "config.json");
    this.mindPath = join(dir, "mind.db");
    this.localPath = join(dir, "local.db");
    this.adminTokenPath = join(dir, "admin.token");
    this.keyFilePath = join(dir, "keys.json");
  }

  static resolve(dir?: string): Home {
    return new Home(resolve(dir ?? loadEnv().GALAHAD_HOME ?? join(homedir(), ".galahad")));
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  readConfig(): NodeConfig {
    if (!this.exists()) throw new Error(`no Galahad node at ${this.dir} — run \`galahad init\` or \`galahad join\``);
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
    if (!existsSync(path)) throw new Error(`no arm token for "${label}" — run \`galahad mcp install <target> --label ${label}\``);
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

function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: the user profile ACL already restricts access */
  }
}
