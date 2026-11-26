import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { LoopTask, LoopWake } from "@galahad/core";

/*
 * Loops Galahad drafted when you asked for one in chat (core api.ts, LoopDraftInput). A draft is only a suggestion
 * waiting in your Inbox: it never runs, and it becomes a loop only when you add it through setLoop, as any loop is
 * made. Kept in this node's own database (local.db), never in the mind's log: what he proposed and you didn't take
 * leaves no trace in every replica. A week unanswered and it's gone; at most a few wait at once, the oldest giving way.
 */

export const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;
export const MOST_DRAFTS = 20;

export interface LoopDraft {
  id: string;
  name: string;
  schedule: string;
  tz: string;
  /** The node it would run on (its id), when the draft names one. */
  on: string | null;
  task: LoopTask;
  /** What else would wake it (a draft from before these were kept has none). */
  wakes: LoopWake[];
  cooldownMs: number | null;
  label: string | null;
  why: string | null;
  by: string;
  at: number;
  expires: number;
}

export class LoopDrafts {
  constructor(private readonly db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS loop_drafts (id TEXT PRIMARY KEY, at INTEGER NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL)");
  }

  /** Keeps a new draft (a draft of a loop with the same name replaces the older one) and gives it its id. */
  add(draft: Omit<LoopDraft, "id" | "at" | "expires">, now = Date.now()): LoopDraft {
    this.sweep(now);
    for (const old of this.list(now).filter((d) => d.name === draft.name)) this.remove(old.id);
    const kept: LoopDraft = { ...draft, id: `ld_${randomBytes(16).toString("base64url").slice(0, 22)}`, at: now, expires: now + DRAFT_TTL_MS };
    this.db.query("INSERT INTO loop_drafts (id, at, expires, data) VALUES (?, ?, ?, ?)").run(kept.id, kept.at, kept.expires, JSON.stringify(kept));
    const extra = this.list(now).length - MOST_DRAFTS;
    if (extra > 0) for (const old of this.list(now).slice(-extra)) this.remove(old.id);
    return kept;
  }

  /** The drafts still waiting, newest first. */
  list(now = Date.now()): LoopDraft[] {
    return this.db
      .query<{ data: string }, [number]>("SELECT data FROM loop_drafts WHERE expires > ? ORDER BY at DESC, id")
      .all(now)
      .map((row) => ({ wakes: [], cooldownMs: null, ...(JSON.parse(row.data) as Partial<LoopDraft>) }) as LoopDraft);
  }

  get(id: string, now = Date.now()): LoopDraft | null {
    return this.list(now).find((d) => d.id === id) ?? null;
  }

  /** Gone: added as a loop, or dismissed. Whether there was one. */
  remove(id: string): boolean {
    return this.db.query("DELETE FROM loop_drafts WHERE id = ?").run(id).changes > 0;
  }

  private sweep(now: number): void {
    this.db.query("DELETE FROM loop_drafts WHERE expires <= ?").run(now);
  }
}
