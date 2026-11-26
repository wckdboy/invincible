import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openReadOnly, tablesOf } from "./sqlite.ts";

/*
 * This node's home as the import finds it, read without writing: what it holds already is never brought again, and a
 * dry run must change nothing here either (the node may be running: its stores, opened as the node opens them, would
 * write as they open, and the chats' would end its answers under way).
 */

/** Where a memory is the same as another: its words and its tags, in any order. */
export const memoryKey = (text: string, tags: readonly string[]): string => JSON.stringify([text, [...tags].sort()]);

export class TargetView {
  private readonly ledger: Database;
  private readonly team: Database | null;
  private readonly chats: Database | null;

  constructor(dir: string, ledgerPath: string) {
    this.ledger = openReadOnly(ledgerPath);
    const optional = (name: string, table: string): Database | null => {
      const path = join(dir, name);
      if (!existsSync(path)) return null;
      const db = openReadOnly(path);
      if (tablesOf(db).has(table)) return db;
      db.close();
      return null;
    };
    this.team = optional("team.db", "team_agents");
    this.chats = optional("chats.db", "conversations");
  }

  close(): void {
    for (const db of [this.ledger, this.team, this.chats]) db?.close();
  }

  /** What its mind holds under `key`: a value (canonical JSON), or null where it was removed here; undefined: never set. */
  lww(key: string): string | null | undefined {
    const row = this.ledger.query<{ v: string | null }, [string]>("SELECT v FROM v_lww WHERE k = ?").get(key);
    return row === null ? undefined : row.v;
  }

  /** Why this node can't seal a secret in its vault (null: it can): its vault's key is one it holds no grant for. */
  vaultLocked(node: string): string | null {
    const current = this.lww("vault:current");
    if (!current) return null; // none yet: the first secret makes one
    let kid: string;
    try {
      kid = (JSON.parse(current) as { kid: string }).kid;
    } catch {
      return null;
    }
    return this.ledger.query("SELECT 1 FROM v_grants WHERE kid = ? AND device = ?").get(kid, node) ? null : "this node holds no grant for its vault's key, so it can't seal anything in it";
  }

  /** Its memories by words and tags, with how many hold each: those forgotten here too, which are never brought back. */
  memories(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of this.ledger.query<{ text: string; tags: string }, []>("SELECT text, tags FROM v_memories").all()) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(row.tags) as string[];
      } catch {
        /* a row it can't read is no match for one */
      }
      const key = memoryKey(row.text, tags);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** An agent's record here (one removed too: its handle stays its own), as kept; null: none by that handle. */
  agent(id: string): Record<string, unknown> | null {
    const raw = this.team?.query<{ value: string }, [string]>("SELECT value FROM team_agents WHERE id = ?").get(id)?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Whether a chat by that id is here. */
  chat(id: string): boolean {
    return !!this.chats?.query("SELECT 1 FROM conversations WHERE id = ?").get(id);
  }
}
