import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/*
 * Connectors an agent asked you for (core api.ts, ConnectorRequestInput): who asked, for which service, and what for.
 * A request is only a question waiting in your Inbox: it never installs anything, and it goes once that connector is
 * installed or you dismiss it. Kept in this node's own database (local.db), never in the mind's log: what an agent
 * asked for and you didn't add leaves no trace in every replica. A week unanswered and it's gone; at most a few wait at
 * once, the oldest giving way, and a service asked for again replaces its older ask.
 */

export const REQUEST_TTL_MS = 7 * 24 * 3600 * 1000;
export const MOST_REQUESTS = 20;

export interface ConnectorRequest {
  id: string;
  connector: string;
  /** It's installed and Galahad's alone: this asks to use it (connector access), not for it to be added. */
  access: boolean;
  why: string;
  /** Who asked: the asker's label (galahad, a knight's, an agent's) or its kind. */
  by: string;
  at: number;
  expires: number;
}

export class ConnectorRequests {
  constructor(private readonly db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS connector_requests (id TEXT PRIMARY KEY, at INTEGER NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL)");
  }

  /**
   * Keeps a new request and gives it its id. One for a service already asked for replaces the older; asking to use one,
   * the same agent's older ask.
   */
  add(request: Omit<ConnectorRequest, "id" | "at" | "expires">, now = Date.now()): ConnectorRequest {
    this.sweep(now);
    for (const old of this.list(now).filter((r) => r.connector === request.connector && r.access === request.access && (!r.access || r.by === request.by))) this.remove(old.id);
    const kept: ConnectorRequest = { ...request, id: `cr_${randomBytes(16).toString("base64url").slice(0, 22)}`, at: now, expires: now + REQUEST_TTL_MS };
    this.db.query("INSERT INTO connector_requests (id, at, expires, data) VALUES (?, ?, ?, ?)").run(kept.id, kept.at, kept.expires, JSON.stringify(kept));
    const extra = this.list(now).length - MOST_REQUESTS;
    if (extra > 0) for (const old of this.list(now).slice(-extra)) this.remove(old.id);
    return kept;
  }

  /** The requests still waiting, newest first. */
  list(now = Date.now()): ConnectorRequest[] {
    return this.db
      .query<{ data: string }, [number]>("SELECT data FROM connector_requests WHERE expires > ? ORDER BY at DESC, id")
      .all(now)
      .map((row) => JSON.parse(row.data) as ConnectorRequest);
  }

  /** Dismissed. Whether there was one. */
  remove(id: string): boolean {
    return this.db.query("DELETE FROM connector_requests WHERE id = ?").run(id).changes > 0;
  }

  /** Answered: the connector was installed. How many requests for it went. */
  resolve(connector: string, now = Date.now()): number {
    return this.list(now).filter((r) => r.connector === connector && !r.access && this.remove(r.id)).length;
  }

  /** Answered: the agent may use the connector now. */
  resolveAccess(connector: string, agent: string, now = Date.now()): number {
    return this.list(now).filter((r) => r.connector === connector && r.access && r.by === agent && this.remove(r.id)).length;
  }

  private sweep(now: number): void {
    this.db.query("DELETE FROM connector_requests WHERE expires <= ?").run(now);
  }
}
