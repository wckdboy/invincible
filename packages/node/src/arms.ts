import type { Database } from "bun:sqlite";
import { randomId, type Scope, sha256B64u } from "@galahad/core";

/*
 * Arm tokens: how coding agents (Claude Code, OpenCode, Codex, Hermes, T3 Code)
 * talk to Galahad through the MCP server, with least privilege.
 *
 * An arm may read and write memory (tagged as *agent*, never *owner*), run
 * sandboxes, read the ledger and ask for secrets. It can never touch the vault,
 * devices, providers or the gateway: those scopes are refused at mint time.
 * Tokens are node-local, stored as hashes, valid on the loopback listener only.
 */

export const ARM_DEFAULT_SCOPES: Scope[] = ["mind:read", "mind:write", "sandbox", "vault:read", "chat", "connect"];
export const ARM_FORBIDDEN_SCOPES: Scope[] = ["vault:write", "fleet:admin", "gateway:mint", "brain:write"];

/** Galahad himself, when his own chat runs tools: an agent's name no minted agent may take. */
export const GALAHAD_ARM = "galahad";
export const ARM_LABEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export interface ArmInfo {
  label: string;
  scopes: Scope[];
  createdAt: number;
}

export class ArmTokens {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS arm_tokens (
      label TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }

  /** Mint (or re-mint, replacing the old token) a credential for one arm. */
  mint(label: string, scopes: Scope[] = ARM_DEFAULT_SCOPES): { token: string; info: ArmInfo } {
    if (!ARM_LABEL.test(label)) throw new Error("arm labels are lowercase letters, digits, . _ - (max 48)");
    if (label === GALAHAD_ARM) throw new Error(`"${GALAHAD_ARM}" is Galahad himself (his tools in chat); choose another name`);
    if (label.startsWith("team.")) throw new Error(`"${label}" is reserved for Galahad's internal workers; choose another name`);
    const forbidden = scopes.filter((s) => ARM_FORBIDDEN_SCOPES.includes(s));
    if (forbidden.length) throw new Error(`arms may never hold: ${forbidden.join(", ")}`);
    const token = `arm_${randomId(32)}`;
    this.db
      .query(
        `INSERT INTO arm_tokens (label, hash, scopes, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (label) DO UPDATE SET hash = excluded.hash, scopes = excluded.scopes, created_at = excluded.created_at`,
      )
      .run(label, sha256B64u(token), JSON.stringify([...new Set(scopes)]), this.now());
    return { token, info: this.get(label)! };
  }

  /** Change an arm's scopes and keep its token (granting bank:read, say). */
  grant(label: string, add: Scope[] = [], remove: Scope[] = []): ArmInfo {
    const current = this.get(label);
    if (!current) throw new Error(`no agent named ${label}`);
    const forbidden = add.filter((s) => ARM_FORBIDDEN_SCOPES.includes(s));
    if (forbidden.length) throw new Error(`arms may never hold: ${forbidden.join(", ")}`);
    const scopes = [...new Set([...current.scopes.filter((s) => !remove.includes(s)), ...add.filter((s) => !remove.includes(s))])];
    this.db.query("UPDATE arm_tokens SET scopes = ? WHERE label = ?").run(JSON.stringify(scopes), label);
    return this.get(label)!;
  }

  verify(token: string): ArmInfo | null {
    if (!/^arm_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.query<Row, [string]>("SELECT * FROM arm_tokens WHERE hash = ?").get(sha256B64u(token));
    // Tokens minted before workers existed must not acquire an internal worker's identity; nor one minted
    // before his own name was reserved, Galahad's: what he alone may do is decided by that name.
    if (row?.label.startsWith("team.") || row?.label === GALAHAD_ARM) return null;
    return row ? toInfo(row) : null;
  }

  get(label: string): ArmInfo | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM arm_tokens WHERE label = ?").get(label);
    return row ? toInfo(row) : null;
  }

  list(): ArmInfo[] {
    return this.db.query<Row, []>("SELECT * FROM arm_tokens ORDER BY label").all().map(toInfo);
  }

  revoke(label: string): boolean {
    return this.db.query("DELETE FROM arm_tokens WHERE label = ?").run(label).changes > 0;
  }
}

interface Row {
  label: string;
  hash: string;
  scopes: string;
  created_at: number;
}

const toInfo = (row: Row): ArmInfo => ({ label: row.label, scopes: JSON.parse(row.scopes) as Scope[], createdAt: row.created_at });

/** The quest every sandbox an arm creates belongs to: it may clean those up, nothing else. */
export const armQuest = (label: string) => `arm.${label}`;
