import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync } from "node:fs";
import { type AnswerStatus, AttachmentRef, type ChatMessage, chatState, type ConversationSummary, LookHeld, type LookView, type QueueHold, randomId, type StoredMessage, type StoredStep } from "@galahad/core";
import { z } from "zod";

/*
 * Your chat history, on the node that served it: a private database (mode 600, in the
 * node's 700 home), never replicated. Deleting a conversation deletes it: SQLite's
 * secure_delete overwrites what it held. Only you read it; the server decides who
 * "you" is (see the conversation routes).
 *
 * It also keeps what you queued behind a chat while Galahad worked (your messages,
 * in order, until their turn comes), so a queue survives a reload and a restart; the
 * looks he set himself in a chat (looks.ts), until they come; and which knights' tasks
 * he gave from each chat, for its row of what is under way.
 */

interface ConversationRow {
  id: string;
  title: string;
  project: string | null;
  role: string;
  pinned: number;
  bank: number;
  created_at: number;
  updated_at: number;
  count: number;
  queued: number;
  queue_held: QueueHold | null;
  waiting: string | null;
  last: AnswerStatus | null;
  /** When his latest answer in it ended (null: none has). */
  answered_at: number | null;
  /** When you last read it: up to his answer that ended then (null: never). */
  seen_at: number | null;
}

interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Your files with it (JSON: AttachmentRef[]), or null. */
  attachments: string | null;
  model: string | null;
  steps: string;
  status: StoredMessage["status"];
  error: string | null;
  created_at: number;
  ended_at: number | null;
  /** A look of his: when he set it, and his note (null: a message of yours, or his answer). */
  look_set: number | null;
  look_note: string | null;
}

interface LookRow {
  id: string;
  conversation: string;
  at: number;
  note: string;
  set_at: number;
  zone: string;
  by_kind: "admin" | "client";
  by_device: string;
  held: string | null;
  state: LookView["state"];
  why: string | null;
}

/** A look as the node keeps it: who set it going (whose device it runs as when it comes), and what its answer held. */
export interface KeptLook extends LookView {
  by: QueuedBy;
  held: LookHeld | null;
}

const lookOf = (row: LookRow): KeptLook => {
  let held: LookHeld | null = null;
  try {
    const parsed = row.held ? LookHeld.safeParse(JSON.parse(row.held)) : null;
    held = parsed?.success ? parsed.data : row.held ? { what: "bank" } : null;
  } catch {
    // What it held can't be read back: held as the strictest there is.
    held = { what: "bank" };
  }
  return { id: row.id, conversation: row.conversation, at: row.at, note: row.note, set: row.set_at, zone: row.zone, state: row.state, why: row.why, by: { kind: row.by_kind, device: row.by_device }, held };
};

/** A row's attachments, read back: what was kept (each still checked to be one), or none. */
function attachmentsOf(json: string | null): AttachmentRef[] {
  if (!json) return [];
  try {
    const parsed = z.array(AttachmentRef).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** `{ attachments }` for a message that carries any, else nothing (a message without them has no such field). */
function attachedTo(row: { attachments: string | null }): { attachments?: AttachmentRef[] } {
  const attachments = attachmentsOf(row.attachments);
  return attachments.length ? { attachments } : {};
}

interface QueueRow {
  id: number;
  content: string;
  role: string | null;
  by_kind: "admin" | "client";
  by_device: string;
  created_at: number;
}

/** What a turn left waiting on you: the approvals it filed, the keys it asked for, and whether its answer ended by asking. */
export interface Waits {
  actions: string[];
  secrets: string[];
  question: boolean;
}

/** Who queued a message: enough to act as them again when its turn comes, and never more than they may do then. */
export interface QueuedBy {
  kind: "admin" | "client";
  device: string;
}

/** A queued message as the node keeps it. */
export interface Queued {
  id: number;
  text: string;
  role: string | null;
  at: number;
  by: QueuedBy;
}

/** A conversation as the store knows it: the summary, plus what the server resolves into its state (a running turn, what still waits on you). */
export interface KeptSummary extends ConversationSummary {
  /** How its last answer ended. */
  last: AnswerStatus | null;
  /** What its last turn left waiting on you, as recorded then. */
  waits: Waits | null;
}

function waitsOf(raw: string | null): Waits | null {
  if (!raw) return null;
  try {
    const w = JSON.parse(raw) as Partial<Waits>;
    return { actions: Array.isArray(w.actions) ? w.actions.filter((a) => typeof a === "string") : [], secrets: Array.isArray(w.secrets) ? w.secrets.filter((s) => typeof s === "string") : [], question: w.question === true };
  } catch {
    return null;
  }
}

const summaryOf = (r: ConversationRow): KeptSummary => ({
  id: r.id,
  title: r.title,
  project: r.project,
  role: r.role,
  pinned: r.pinned === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  count: r.count,
  bank: r.bank === 1,
  // What the store alone knows: no running turn, nothing resolved as waiting on you (the server adds both).
  state: chatState({ running: false, needs: null, queued: r.queued, last: r.last }),
  queued: r.queued,
  held: r.queued > 0 ? r.queue_held : null,
  needs: null,
  // An answer of his ended after you last read it: new to you, on every device, until you read it on one.
  unread: r.answered_at !== null && r.answered_at > (r.seen_at ?? 0),
  last: r.last,
  waits: waitsOf(r.waiting),
});

const queuedOf = (r: QueueRow): Queued => ({ id: r.id, text: r.content, role: r.role, at: r.created_at, by: { kind: r.by_kind, device: r.by_device } });

const SUMMARY = `SELECT c.*,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation = c.id) AS count,
    (SELECT COUNT(*) FROM queue q WHERE q.conversation = c.id) AS queued,
    (SELECT m.status FROM messages m WHERE m.conversation = c.id AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1) AS last
  FROM conversations c`;

/** A long chat's older messages, summed up: what it says, and the last message it covers. */
export interface ChatStory {
  text: string;
  through: number;
}

/**
 * When a chat is folded, and how far: once the messages after its story pass `high` characters, all but the newest are
 * folded into it; the newest that fit in `keep` stay whole, starting with one of yours (a model is given a conversation
 * that starts with the user). Rarely, so what a provider keeps in its cache, the beginning, changes rarely.
 */
export const FOLD = { high: 48_000, keep: 16_000 } as const;

/** Where to fold: the index of the first message said whole (one of yours), or null when there is nothing to fold yet. */
export function foldAt(recent: readonly { role: string; content: string }[], limits: { high: number; keep: number } = FOLD): number | null {
  const tail: number[] = [];
  let size = 0;
  for (let i = recent.length - 1; i >= 0; i--) tail[i] = size += recent[i]!.content.length;
  if (size <= limits.high) return null;
  const yours = recent.flatMap((message, i) => (i > 0 && message.role === "user" ? [i] : []));
  // The earliest of yours whose tail fits; if none does, your last, so at least it and what answered it stay whole.
  return yours.find((i) => tail[i]! <= limits.keep) ?? yours.at(-1) ?? null;
}

export class ChatStore {
  private readonly db: Database;
  /** When this node opened it: with the rows written since, which writing of the chats a device saw. */
  private readonly opened: string;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:" && !existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    this.db = new Database(path);
    this.opened = this.now().toString(36);
    this.db.exec("PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT, role TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, bank INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, steps TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation, id);
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL, content TEXT NOT NULL, role TEXT,
        by_kind TEXT NOT NULL, by_device TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS queue_by_conversation ON queue (conversation, ord, id);
      CREATE TABLE IF NOT EXISTS stories (
        conversation TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        text TEXT NOT NULL, through INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS looks (
        id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, note TEXT NOT NULL, set_at INTEGER NOT NULL, zone TEXT NOT NULL,
        by_kind TEXT NOT NULL, by_device TEXT NOT NULL, held TEXT,
        state TEXT NOT NULL DEFAULT 'waiting', why TEXT, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS looks_waiting ON looks (state, at);
      CREATE TABLE IF NOT EXISTS handoffs (
        conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        task TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (conversation, task));`);
    // A database from before queues: two more columns on a conversation (why its queue is held; what waits on you).
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().map((c) => c.name));
    if (!columns.has("queue_held")) this.db.exec("ALTER TABLE conversations ADD COLUMN queue_held TEXT");
    if (!columns.has("waiting")) this.db.exec("ALTER TABLE conversations ADD COLUMN waiting TEXT");
    // A database from before read and unread: when his latest answer in each chat ended, and when you last read it.
    // Everything he answered before then counts as read.
    if (!columns.has("answered_at")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN answered_at INTEGER");
      this.db.exec("UPDATE conversations SET answered_at = (SELECT MAX(m.ended_at) FROM messages m WHERE m.conversation = conversations.id AND m.role = 'assistant')");
    }
    if (!columns.has("seen_at")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN seen_at INTEGER");
      this.db.exec("UPDATE conversations SET seen_at = answered_at");
    }
    // A database from before attachments: a message of yours may carry files (kept on the node: uploads.ts).
    const fields = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name));
    if (!fields.has("attachments")) this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
    // A database from before his looks: a message may be one of his, which starts the turn a look of his comes back as.
    if (!fields.has("look_set")) this.db.exec("ALTER TABLE messages ADD COLUMN look_set INTEGER; ALTER TABLE messages ADD COLUMN look_note TEXT;");
    // An answer the node was writing when it stopped can't finish any more.
    this.db.exec("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'");
    // Nothing is sent just because the node came back: what was queued then is held until you resume it.
    this.db.exec("UPDATE conversations SET queue_held = COALESCE(queue_held, 'restart') WHERE id IN (SELECT conversation FROM queue)");
  }

  create(input: { title: string; project: string | null; role: string }): KeptSummary {
    const id = `cv_${randomId(16)}`;
    const at = this.now();
    this.db.query("INSERT INTO conversations (id, title, project, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.title, input.project, input.role, at, at);
    return this.summary(id)!;
  }

  /**
   * Which writing of your chats this is: when the node opened them, and how many rows it has written since. A device
   * that saw another one knows something kept has changed (a chat begun, answered, renamed or deleted, on any device),
   * and reads the chats again. It says nothing of what.
   */
  version(): string {
    const { n } = this.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!;
    return `${this.opened}.${n}`;
  }

  summary(id: string): KeptSummary | null {
    const row = this.db.query<ConversationRow, [string]>(`${SUMMARY} WHERE c.id = ?`).get(id);
    return row ? summaryOf(row) : null;
  }

  /** Pinned first, then the most recently active. */
  list(): KeptSummary[] {
    return this.db.query<ConversationRow, []>(`${SUMMARY} ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 2000`).all().map(summaryOf);
  }

  get(id: string): (KeptSummary & { messages: StoredMessage[] }) | null {
    const summary = this.summary(id);
    if (!summary) return null;
    const messages = this.db
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE conversation = ? ORDER BY id")
      .all(id)
      .map(
        (m): StoredMessage => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ...attachedTo(m),
          ...(m.look_set !== null && m.look_note !== null ? { look: { set: m.look_set, note: m.look_note } } : {}),
          model: m.model,
          steps: JSON.parse(m.steps) as StoredStep[],
          status: m.status,
          error: m.error,
          createdAt: m.created_at,
          endedAt: m.ended_at,
        }),
      );
    return { ...summary, messages };
  }

  /**
   * What the model is told of it, once it is long: its story (its older messages summed up, through message `through`)
   * and every question and answer with words in it after that, whole, up to message `upTo` (absent: the newest). Null
   * story: nothing folded yet.
   */
  told(id: string, upTo: number = Number.MAX_SAFE_INTEGER): { story: ChatStory | null; recent: (ChatMessage & { id: number })[] } {
    const story = this.db.query<ChatStory, [string]>("SELECT text, through FROM stories WHERE conversation = ?").get(id) ?? null;
    const recent = this.db
      .query<Pick<MessageRow, "id" | "role" | "content" | "attachments">, [string, number, number]>(
        "SELECT id, role, content, attachments FROM messages WHERE conversation = ? AND (content != '' OR attachments IS NOT NULL) AND id > ? AND id <= ? ORDER BY id",
      )
      .all(id, story?.through ?? 0, upTo)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, ...attachedTo(m) }));
    return { story, recent };
  }

  /** Its older messages, through `through`, folded into its story. */
  keepStory(id: string, text: string, through: number): void {
    this.db.query("INSERT INTO stories (conversation, text, through, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation) DO UPDATE SET text = excluded.text, through = excluded.through, updated_at = excluded.updated_at").run(id, text, through, this.now());
  }

  /** What the model sees of it: every question, and every answer that has words in it. */
  history(id: string): ChatMessage[] {
    return this.db
      .query<Pick<MessageRow, "role" | "content" | "attachments">, [string]>("SELECT role, content, attachments FROM messages WHERE conversation = ? AND (content != '' OR attachments IS NOT NULL) ORDER BY id")
      .all(id)
      .map((m) => ({ role: m.role, content: m.content, ...attachedTo(m) }));
  }

  /** Every attachment a kept message carries (in one chat, or in all): what uploads.ts keeps whatever its age. */
  attachmentIds(conversation?: string): Set<string> {
    const ids = new Set<string>();
    const rows = conversation
      ? this.db.query<{ attachments: string }, [string]>("SELECT attachments FROM messages WHERE attachments IS NOT NULL AND conversation = ?").all(conversation)
      : this.db.query<{ attachments: string }, []>("SELECT attachments FROM messages WHERE attachments IS NOT NULL").all();
    for (const row of rows) {
      for (const a of attachmentsOf(row.attachments)) ids.add(a.id);
    }
    return ids;
  }

  /** A message of yours. Whatever the turn before it left waiting on you is no longer where the chat stands. */
  /** A message that starts a turn: yours, or one of his looks coming back (`look`: when he set it, and his note). */
  addUser(id: string, content: string, attachments?: readonly AttachmentRef[], look?: { set: number; note: string }): number {
    const at = this.now();
    const row = this.db
      .query<{ id: number }, [string, string, string | null, number, number, number | null, string | null]>(
        "INSERT INTO messages (conversation, role, content, attachments, status, created_at, ended_at, look_set, look_note) VALUES (?, 'user', ?, ?, 'done', ?, ?, ?, ?) RETURNING id",
      )
      .get(id, content, attachments?.length ? JSON.stringify(attachments) : null, at, at, look?.set ?? null, look?.note ?? null)!;
    this.db.query("UPDATE conversations SET waiting = NULL WHERE id = ?").run(id);
    this.touch(id);
    return row.id;
  }

  /** An answer begins: it's kept even if nothing comes of it (an error, a stop). */
  startAnswer(id: string): number {
    return this.db.query<{ id: number }, [string, number]>("INSERT INTO messages (conversation, role, content, status, created_at) VALUES (?, 'assistant', '', 'streaming', ?) RETURNING id").get(id, this.now())!.id;
  }

  /** His answer, ended. `read`: a device was watching it to its end, so it was read there; otherwise it's new to you. */
  finishAnswer(conversation: string, message: number, answer: { content: string; model: string | null; steps: StoredStep[]; status: "done" | "error" | "stopped" | "steered"; error: string | null; bank: boolean }, read = false): void {
    const at = this.now();
    this.db
      .query("UPDATE messages SET content = ?, model = ?, steps = ?, status = ?, error = ?, ended_at = ? WHERE id = ? AND conversation = ?")
      .run(answer.content, answer.model, JSON.stringify(answer.steps), answer.status, answer.error, at, message, conversation);
    this.db.query("UPDATE conversations SET answered_at = ? WHERE id = ?").run(at, conversation);
    if (read) this.see(conversation);
    if (answer.bank) this.db.query("UPDATE conversations SET bank = 1 WHERE id = ?").run(conversation);
    this.touch(conversation);
  }

  /** You read it: what he has answered in it so far is no longer new. True when that changed anything. */
  see(id: string): boolean {
    return this.db.query("UPDATE conversations SET seen_at = answered_at WHERE id = ? AND answered_at > COALESCE(seen_at, 0)").run(id).changes > 0;
  }

  /** The chats with an answer you haven't read, the newest answer first. */
  unread(limit = 20): { id: string; title: string; bank: boolean; answeredAt: number }[] {
    return this.db
      .query<{ id: string; title: string; bank: number; answered_at: number }, [number]>("SELECT id, title, bank, answered_at FROM conversations WHERE answered_at > COALESCE(seen_at, 0) ORDER BY answered_at DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ id: r.id, title: r.title, bank: r.bank === 1, answeredAt: r.answered_at }));
  }

  /** An answer that never came to anything (you steered before he'd said or done a thing): it isn't kept. */
  dropAnswer(conversation: string, message: number): void {
    this.db.query("DELETE FROM messages WHERE id = ? AND conversation = ? AND role = 'assistant'").run(message, conversation);
  }

  /** What a turn left waiting on you (null: nothing). */
  setWaits(conversation: string, waits: Waits | null): void {
    const empty = !waits || (!waits.actions.length && !waits.secrets.length && !waits.question);
    this.db.query("UPDATE conversations SET waiting = ? WHERE id = ?").run(empty ? null : JSON.stringify(waits), conversation);
  }

  update(id: string, change: { title?: string; project?: string | null; pinned?: boolean }): KeptSummary | null {
    if (change.title !== undefined) this.db.query("UPDATE conversations SET title = ? WHERE id = ?").run(change.title, id);
    if (change.project !== undefined) this.db.query("UPDATE conversations SET project = ? WHERE id = ?").run(change.project, id);
    if (change.pinned !== undefined) this.db.query("UPDATE conversations SET pinned = ? WHERE id = ?").run(change.pinned ? 1 : 0, id);
    return this.summary(id);
  }

  /**
   * Asked again: the last question and its answer go, so the new ones take their place. Only when it was this question:
   * one the chat never had (it never reached the node) is simply asked, and nothing kept before it goes.
   */
  dropLastExchange(id: string, question: string): void {
    const last = this.db.query<{ id: number; content: string }, [string]>("SELECT id, content FROM messages WHERE conversation = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(id);
    if (last && last.content === question) this.db.query("DELETE FROM messages WHERE conversation = ? AND id >= ?").run(id, last.id);
  }

  /** Gone for good: secure_delete overwrites its pages in the file (what was queued behind it goes with it). */
  delete(id: string): boolean {
    return this.db.query("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
  }

  /** A project that's gone leaves its chats where they were, outside any project. */
  projectRemoved(project: string): void {
    this.db.query("UPDATE conversations SET project = NULL WHERE project = ?").run(project);
  }

  /* ---------- the queue: your messages waiting for their turn ---------- */

  /** A chat's queued messages, in the order they'll be sent. */
  /** A look he set in a chat, waiting until it comes. */
  lookAdd(look: { conversation: string; at: number; note: string; zone: string; by: QueuedBy; held: LookHeld | null }): KeptLook {
    const id = `lk_${randomId(12)}`;
    this.db
      .query("INSERT INTO looks (id, conversation, at, note, set_at, zone, by_kind, by_device, held) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, look.conversation, look.at, look.note, this.now(), look.zone, look.by.kind, look.by.device, look.held ? JSON.stringify(look.held) : null);
    return this.look(id)!;
  }

  look(id: string): KeptLook | null {
    const row = this.db.query<LookRow, [string]>("SELECT * FROM looks WHERE id = ?").get(id);
    return row ? lookOf(row) : null;
  }

  /** His looks that wait, soonest first: in one chat, or in all. */
  looksWaiting(conversation?: string): KeptLook[] {
    const rows = conversation
      ? this.db.query<LookRow, [string]>("SELECT * FROM looks WHERE state = 'waiting' AND conversation = ? ORDER BY at, id").all(conversation)
      : this.db.query<LookRow, []>("SELECT * FROM looks WHERE state = 'waiting' ORDER BY at, id LIMIT 500").all();
    return rows.map(lookOf);
  }

  /** His looks whose time has come, soonest first. */
  looksDue(now: number): KeptLook[] {
    return this.db.query<LookRow, [number]>("SELECT * FROM looks WHERE state = 'waiting' AND at <= ? ORDER BY at, id LIMIT 50").all(now).map(lookOf);
  }

  /** A look ended: taken (done), called off, or failed, and why. Only one that still waits. */
  lookEnd(id: string, state: "done" | "cancelled" | "failed", why: string | null): boolean {
    return this.db.query("UPDATE looks SET state = ?, why = ?, ended_at = ? WHERE id = ? AND state = 'waiting'").run(state, why, this.now(), id).changes > 0;
  }

  /** A knight's task he gave from a chat (its row above that chat's message box while it's under way). */
  handoff(conversation: string, task: string): void {
    if (!this.summary(conversation)) return;
    this.db.query("INSERT OR IGNORE INTO handoffs (conversation, task, at) VALUES (?, ?, ?)").run(conversation, task, this.now());
  }

  /** The tasks he gave from a chat, newest first. */
  handoffs(conversation: string, limit = 50): string[] {
    return this.db.query<{ task: string }, [string, number]>("SELECT task FROM handoffs WHERE conversation = ? ORDER BY at DESC, task LIMIT ?").all(conversation, limit).map((row) => row.task);
  }

  queue(conversation: string): Queued[] {
    return this.db.query<QueueRow, [string]>("SELECT * FROM queue WHERE conversation = ? ORDER BY ord, id").all(conversation).map(queuedOf);
  }

  /** Queue a message behind a chat (`front`: ahead of the others, for one that was already on its way to him). */
  queueAdd(conversation: string, message: { text: string; role: string | null; by: QueuedBy }, front = false): Queued {
    const edge = this.db.query<{ lo: number | null; hi: number | null }, [string]>("SELECT MIN(ord) AS lo, MAX(ord) AS hi FROM queue WHERE conversation = ?").get(conversation)!;
    const ord = front ? (edge.lo ?? 0) - 1 : (edge.hi ?? 0) + 1;
    const row = this.db
      .query<QueueRow, [string, number, string, string | null, string, string, number]>("INSERT INTO queue (conversation, ord, content, role, by_kind, by_device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(conversation, ord, message.text, message.role, message.by.kind, message.by.device, this.now())!;
    return queuedOf(row);
  }

  /** Change a queued message's words. It becomes its editor's: when its turn comes it runs as them, with what they may do then. */
  queueEdit(conversation: string, id: number, text: string, by: QueuedBy): boolean {
    return this.db.query("UPDATE queue SET content = ?, by_kind = ?, by_device = ? WHERE id = ? AND conversation = ?").run(text, by.kind, by.device, id, conversation).changes > 0;
  }

  /** Take a queued message out (the first, or the one named): its turn has come, or you removed it. An emptied queue holds nothing. */
  queueTake(conversation: string, id?: number): Queued | null {
    const row =
      id === undefined
        ? this.db.query<QueueRow, [string]>("SELECT * FROM queue WHERE conversation = ? ORDER BY ord, id LIMIT 1").get(conversation)
        : this.db.query<QueueRow, [string, number]>("SELECT * FROM queue WHERE conversation = ? AND id = ?").get(conversation, id);
    if (!row) return null;
    this.db.query("DELETE FROM queue WHERE id = ?").run(row.id);
    this.releaseIfEmpty(conversation);
    return queuedOf(row);
  }

  /** Discard everything queued behind a chat. */
  queueClear(conversation: string): number {
    const removed = this.db.query("DELETE FROM queue WHERE conversation = ?").run(conversation).changes;
    this.releaseIfEmpty(conversation);
    return removed;
  }

  /** Why a chat's queue is held (null: it isn't). */
  held(conversation: string): QueueHold | null {
    return this.db.query<{ queue_held: QueueHold | null }, [string]>("SELECT queue_held FROM conversations WHERE id = ?").get(conversation)?.queue_held ?? null;
  }

  /** Hold a chat's queue (nothing is sent until you resume), or let it go on. */
  hold(conversation: string, why: QueueHold | null): void {
    this.db.query("UPDATE conversations SET queue_held = ? WHERE id = ?").run(why, conversation);
    if (why) this.releaseIfEmpty(conversation);
  }

  /** The chats with messages queued, the one whose next message has waited longest first. */
  queuedConversations(): string[] {
    return this.db
      .query<{ conversation: string }, []>("SELECT conversation, MIN(created_at) AS oldest FROM queue GROUP BY conversation ORDER BY oldest, conversation")
      .all()
      .map((r) => r.conversation);
  }

  close(): void {
    this.db.close();
  }

  private releaseIfEmpty(conversation: string): void {
    this.db.query("UPDATE conversations SET queue_held = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM queue WHERE conversation = ?)").run(conversation, conversation);
  }

  private touch(id: string): void {
    this.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run(this.now(), id);
  }
}
