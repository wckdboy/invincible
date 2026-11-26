import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Bodies, type BodyOf, type Bytes, importIdentity, type NodeIdentity, type SealedBox, Trust } from "@invincible/core";
import { openGrant, openSecret } from "./seal.ts";
import { ImportError, openReadOnly, tablesOf } from "./sqlite.ts";

/*
 * A Galahad home, read as Galahad keeps it and never written: its config, its node's keys (the file keystore a server
 * uses, GALAHAD_KEYSTORE=file), its mind (mind.db: the log and the views folded from it), its knights (team.db), its
 * chats (chats.db) and their uploads. Galahad's formats are this code's before the rename, so each row is read with
 * Invincible's own schemas, the old names mapped where they differ; a row that doesn't read is said by name, never
 * guessed at.
 */

/** One row of the old home: as it reads here, or why it doesn't. */
export type Row<T> = { name: string; value: T } | { name: string; problem: string };

/** The first thing wrong with a row, by where it is and never by what it holds. */
const issue = (error: z.ZodError): string => {
  const first = error.issues[0];
  return first ? `${first.path.join(".") || "its value"}: ${first.message}` : "it doesn't read";
};

const OldConfig = z.object({ v: z.literal(1), name: z.string().min(1).max(64), fleet: z.string().nullable(), keystore: z.enum(["os", "file"]) });

/** A knight as its team store kept it (core's team.ts Teammate, before the rename): the fields an agent's profile takes. */
const OldKnight = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string().default(""),
  role: z.string().default("engineer"),
  models: z.array(z.string()).optional(),
  sensitive: z.boolean().optional(),
  harness: z.string().default("native"),
  acp: z.string().optional(),
  keys: z.array(z.object({ secret: z.string(), header: z.string().optional(), write: z.boolean().optional() })).optional(),
  enabled: z.boolean().default(true),
  dailyTurns: z.number().int().default(40),
  repository: z.string().nullable().default(null),
  memory: z.string().default(""),
  createdBy: z.string().optional(),
  instructionsBy: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  removedAt: z.number().int().optional(),
});
export type OldKnight = z.infer<typeof OldKnight>;

export type SecretRecord = BodyOf<"secret.set">;

export interface OldMemory {
  id: string;
  text: string;
  tags: string[];
  trust: Trust;
  /** Where it came from, as its event says (a page's address, an agent's label); absent: nowhere said. */
  source?: string;
  forgotten: boolean;
}

export interface OldChat {
  id: string;
  title: string;
  project: string | null;
  role: string;
  pinned: boolean;
  /** It read the bank (a feature Invincible left behind, with the guard that kept such a chat to the devices allowed it). */
  bank: boolean;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
  seenAt: number | null;
  count: number;
}

export interface OldMessage {
  id: number;
  role: string;
  content: string;
  attachments: string | null;
  model: string | null;
  steps: string;
  status: string;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  lookSet: number | null;
  lookNote: string | null;
}

/** The views this importer reads, which every version of Galahad's mind has kept alike. */
const MIND_TABLES = ["meta", "events", "v_lww", "v_memories", "v_grants", "v_devices"];

export class GalahadHome {
  /** Its node's name, as its config says. */
  readonly name: string;
  /** Its fleet (its genesis event's id), as its mind holds it: what its vault's boxes are bound to. */
  readonly fleet: string;
  /** Its node's id: whose knights' labels its connectors named. */
  readonly node: string | null;
  /** Why its vault can't be opened at all (null: it can be tried, key by key). */
  readonly locked: string | null;
  private readonly identity: NodeIdentity | null;
  private readonly mind: Database;
  private readonly team: Database | null;
  private readonly chats: Database | null;
  private readonly keys = new Map<string, Bytes | string>();

  private constructor(readonly dir: string) {
    const configPath = join(dir, "config.json");
    if (!existsSync(join(dir, "mind.db"))) throw new ImportError(`no Galahad home at ${dir}: its mind.db isn't there`);
    let config: z.infer<typeof OldConfig>;
    try {
      config = OldConfig.parse(JSON.parse(readFileSync(configPath, "utf8")));
    } catch {
      throw new ImportError(`no Galahad home at ${dir}: its config.json doesn't read`);
    }
    this.name = config.name;
    this.mind = openReadOnly(join(dir, "mind.db"));
    try {
      const tables = tablesOf(this.mind);
      const missing = MIND_TABLES.filter((t) => !tables.has(t));
      if (missing.length) throw new ImportError(`its mind.db isn't a mind this import reads (no ${missing.join(", ")})`);
      const fleet = this.mind.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'fleet'").get()?.v;
      if (!fleet) throw new ImportError("its mind belongs to no fleet yet: there is nothing in it to bring");
      this.fleet = fleet;
      let identity: NodeIdentity | null = null;
      let locked: string | null = null;
      const keyFile = join(dir, "keys.json");
      if (existsSync(keyFile)) {
        try {
          identity = importIdentity(readFileSync(keyFile, "utf8"));
        } catch {
          locked = "its node's keys (keys.json) don't read";
        }
      } else {
        locked = config.keystore === "os" ? "its node keeps its keys in the OS keychain, which this import doesn't open (a server's file keystore, GALAHAD_KEYSTORE=file, it does)" : "its node's keys (keys.json) aren't there";
      }
      this.identity = identity;
      this.locked = locked;
      this.node =
        identity?.id ??
        this.mind.query<{ id: string }, [string]>("SELECT id FROM v_devices WHERE kind = 'node' AND name = ? AND revoked_hlc IS NULL").get(config.name)?.id ??
        null;
      this.team = existsSync(join(dir, "team.db")) ? openReadOnly(join(dir, "team.db")) : null;
      this.chats = existsSync(join(dir, "chats.db")) ? openReadOnly(join(dir, "chats.db")) : null;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Where a home is, as its real path: one that isn't there, and one this user can't read, said apart. */
  static locate(dir: string): string {
    try {
      accessSync(dir, constants.R_OK | constants.X_OK);
      return realpathSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ImportError(`no Galahad home at ${dir}`);
      // (A home of another user's, 700 as homes are, is otherwise taken for one that isn't there.)
      const user = userInfo().username;
      throw new ImportError(`this user (${user}) can't read Galahad's home at ${dir}: let it read it (setfacl -R -m u:${user}:rX ${dir}), or import a copy`);
    }
  }

  static open(dir: string): GalahadHome {
    return new GalahadHome(GalahadHome.locate(dir));
  }

  close(): void {
    for (const db of [this.mind, this.team, this.chats]) {
      try {
        db?.close();
      } catch {
        /* never opened */
      }
    }
  }

  // ---- the mind's last-writer-wins view ----------------------------------------------------------------------------

  /** Its rows under `prefix`, each as it reads with `schema`; what was removed there (a null row) has nothing to bring. */
  private rows<T>(prefix: string, schema: z.ZodType<T>, shape: (name: string, value: unknown) => unknown): Row<T>[] {
    return this.mind
      .query<{ k: string; v: string }, [string]>("SELECT k, v FROM v_lww WHERE substr(k, 1, length(?1)) = ?1 AND v IS NOT NULL ORDER BY k")
      .all(prefix)
      .map(({ k, v }) => {
        const name = k.slice(prefix.length);
        let value: unknown;
        try {
          value = JSON.parse(v);
        } catch {
          return { name, problem: "its row isn't JSON" };
        }
        const read = schema.safeParse(shape(name, value));
        return read.success ? { name, value: read.data } : { name, problem: `its row doesn't read (${issue(read.error)})` };
      });
  }

  /** How many of its rows under `prefix` stand (for what stays behind). */
  count(prefix: string): number {
    return this.mind.query<{ n: number }, [string]>("SELECT count(*) AS n FROM v_lww WHERE substr(k, 1, length(?1)) = ?1 AND v IS NOT NULL").get(prefix)!.n;
  }

  providers = (): Row<BodyOf<"provider.set">>[] => this.rows("provider:", Bodies["provider.set"], (_, value) => value);
  roster = (): Row<BodyOf<"roster.set">>[] => this.rows("roster:", Bodies["roster.set"], (role, models) => ({ role, models }));
  efforts = (): Row<BodyOf<"roster.effort">>[] => this.rows("effort:", Bodies["roster.effort"], (role, effort) => ({ role, effort }));
  prices = (): Row<BodyOf<"price.set">>[] => this.rows("price:", Bodies["price.set"], (model, price) => ({ model, price }));
  projects = (): Row<BodyOf<"project.set">>[] => this.rows("project:", Bodies["project.set"], (_, value) => value);
  connectors = (): Row<BodyOf<"connector.set">>[] => this.rows("connector:", Bodies["connector.set"], (id, manifest) => ({ id, manifest }));
  secrets = (): Row<SecretRecord>[] => this.rows("secret:", Bodies["secret.set"], (_, value) => value);

  /** Its skills, by how many it has (for what stays behind). */
  skills(): number {
    return tablesOf(this.mind).has("v_skills") ? this.mind.query<{ n: number }, []>("SELECT count(*) AS n FROM v_skills").get()!.n : 0;
  }

  /** Standing orders still in force (for what stays behind). */
  orders(): number {
    return this.mind.query<{ n: number }, []>("SELECT count(*) AS n FROM v_lww WHERE substr(k, 1, 6) = 'order:' AND v IS NOT NULL AND json_extract(v, '$.revoked') = 0").get()!.n;
  }

  /** Whether a word is one of its log's event ids: public, so never taken for a key. */
  isEvent = (token: string): boolean => this.mind.query("SELECT 1 FROM events WHERE id = ?").get(token) !== null;

  // ---- the vault -------------------------------------------------------------------------------------------------------

  /** A secret's value, opened in memory and never kept; or why it doesn't open. */
  open(record: SecretRecord): { value: string } | { problem: string } {
    if (!this.identity) return { problem: `it won't open: ${this.locked}` };
    let key = this.keys.get(record.kid);
    if (key === undefined) {
      const grant = this.mind.query<{ box: string }, [string, string]>("SELECT box FROM v_grants WHERE kid = ? AND device = ?").get(record.kid, this.identity.id)?.box;
      if (!grant) key = "it won't open: its vault key isn't sealed to the node whose keys this home holds";
      else {
        try {
          key = openGrant(this.identity.boxSecret, JSON.parse(grant) as SealedBox, this.fleet, record.kid, this.identity.id);
        } catch {
          key = "it won't open: its vault key doesn't open with this home's node key";
        }
      }
      this.keys.set(record.kid, key);
    }
    if (typeof key === "string") return { problem: key };
    try {
      return { value: openSecret(key, record, this.fleet) };
    } catch {
      return { problem: "it won't open: its sealed value doesn't open with its vault key" };
    }
  }

  // ---- memory ------------------------------------------------------------------------------------------------------------

  /** Every memory it holds, in the order it was kept, those forgotten too (they stay behind, and are counted). */
  memories(): Row<OldMemory>[] {
    const prov = this.mind.query<{ raw: string }, [string]>("SELECT raw FROM events WHERE id = ?");
    return this.mind
      .query<{ id: string; text: string; tags: string; trust: string; forgotten: number }, []>("SELECT id, text, tags, trust, forgotten FROM v_memories ORDER BY hlc, id")
      .all()
      .map((row) => {
        let tags: unknown;
        try {
          tags = JSON.parse(row.tags);
        } catch {
          return { name: row.id, problem: "its tags aren't JSON" };
        }
        const read = z.object({ tags: z.array(z.string()), trust: Trust }).safeParse({ tags, trust: row.trust });
        if (!read.success) return { name: row.id, problem: `it doesn't read (${issue(read.error)})` };
        let source: string | undefined;
        try {
          const raw = prov.get(row.id)?.raw;
          const said = raw ? (JSON.parse(raw) as { prov?: { source?: unknown } }).prov?.source : undefined;
          if (typeof said === "string" && said) source = said;
        } catch {
          /* its event doesn't read: where it came from isn't said */
        }
        return { name: row.id, value: { id: row.id, text: row.text, tags: read.data.tags, trust: read.data.trust, ...(source ? { source } : {}), forgotten: row.forgotten !== 0 } };
      });
  }

  // ---- knights (team.db) -------------------------------------------------------------------------------------------------

  knights(): Row<OldKnight>[] {
    if (!this.team || !tablesOf(this.team).has("team_teammates")) return [];
    return this.team
      .query<{ id: string; value: string }, []>("SELECT id, value FROM team_teammates ORDER BY id")
      .all()
      .map((row) => {
        let value: unknown;
        try {
          value = JSON.parse(row.value);
        } catch {
          return { name: row.id, problem: "its record isn't JSON" };
        }
        const read = OldKnight.safeParse(value);
        return read.success ? { name: row.id, value: read.data } : { name: row.id, problem: `its record doesn't read (${issue(read.error)})` };
      });
  }

  // ---- chats (chats.db) and their files ----------------------------------------------------------------------------------

  chatList(): OldChat[] {
    if (!this.chats || !tablesOf(this.chats).has("conversations")) return [];
    const columns = new Set(this.chats.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().map((c) => c.name));
    const col = (name: string, otherwise: string) => (columns.has(name) ? `c.${name}` : otherwise);
    return this.chats
      .query<{ id: string; title: string; project: string | null; role: string; pinned: number; bank: number; created_at: number; updated_at: number; answered_at: number | null; seen_at: number | null; count: number }, []>(
        `SELECT c.id, c.title, c.project, c.role, c.pinned, ${col("bank", "0")} AS bank, c.created_at, c.updated_at, ${col("answered_at", "NULL")} AS answered_at,
           ${col("seen_at", "NULL")} AS seen_at, (SELECT count(*) FROM messages m WHERE m.conversation = c.id) AS count
         FROM conversations c ORDER BY c.updated_at DESC, c.id`,
      )
      .all()
      .map((r) => ({ id: r.id, title: r.title, project: r.project, role: r.role, pinned: r.pinned === 1, bank: r.bank === 1, createdAt: r.created_at, updatedAt: r.updated_at, answeredAt: r.answered_at, seenAt: r.seen_at, count: r.count }));
  }

  /** One chat's messages in order, and its story (the older ones summed up, through message `through`). */
  chat(id: string): { messages: OldMessage[]; story: { text: string; through: number; updatedAt: number } | null } {
    if (!this.chats) return { messages: [], story: null };
    const columns = new Set(this.chats.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name));
    const col = (name: string) => (columns.has(name) ? name : "NULL");
    const messages = this.chats
      .query<{ id: number; role: string; content: string; attachments: string | null; model: string | null; steps: string; status: string; error: string | null; created_at: number; ended_at: number | null; look_set: number | null; look_note: string | null }, [string]>(
        `SELECT id, role, content, ${col("attachments")} AS attachments, model, steps, status, error, created_at, ended_at, ${col("look_set")} AS look_set, ${col("look_note")} AS look_note
         FROM messages WHERE conversation = ? ORDER BY id`,
      )
      .all(id)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, attachments: m.attachments, model: m.model, steps: m.steps, status: m.status, error: m.error, createdAt: m.created_at, endedAt: m.ended_at, lookSet: m.look_set, lookNote: m.look_note }));
    const story = tablesOf(this.chats).has("stories")
      ? (this.chats.query<{ text: string; through: number; updated_at: number }, [string]>("SELECT text, through, updated_at FROM stories WHERE conversation = ?").get(id) ?? null)
      : null;
    return { messages, story: story ? { text: story.text, through: story.through, updatedAt: story.updated_at } : null };
  }

  /** Whether its uploads keep an attachment by that id (its bytes are read only when it is brought). */
  hasUpload(id: string): boolean {
    return /^[a-f0-9]{64}$/.test(id) && existsSync(join(this.dir, "uploads", id));
  }

  /** An attachment's bytes as its uploads keep them (by their SHA-256), or null when it isn't there or isn't what it says. */
  upload(id: string): Uint8Array | null {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const path = join(this.dir, "uploads", id);
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    return createHash("sha256").update(bytes).digest("hex") === id ? bytes : null;
  }
}
