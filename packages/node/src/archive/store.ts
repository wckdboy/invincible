import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import {
  type ArchiveEntryView,
  type ArchiveFileView,
  type ArchiveFilters,
  type ArchiveHit,
  type ArchiveLinkView,
  type ArchiveSearchView,
  type ArchiveUnderstanding,
  archiveId,
  type Trust,
} from "@galahad/core";
import { type BlobBackend, fileSize } from "./blobs.ts";
import { asText, chunkEntry, fileTextKind } from "./chunk.ts";
import { type Redaction, refuseFile, scrub } from "./guard.ts";
import { ftsQuery, fuse, matchedTerms, queryTerms, type Ranked, snippet } from "./search.ts";
import { quantize, type Quantized, fromBlob, toBlob, VectorIndex } from "./vectors.ts";

/*
 * The archive's index: one SQLite database in the node's home (archive.db, mode 600,
 * never the mind's), beside a blob store. Entries are append-only: once archived, an
 * entry's words and files never change. What's derived from them (passages, vectors,
 * summaries, links) can always be rebuilt. Only the owner deletes, and a deletion keeps
 * a tombstone (the entry's id, kind, source and source id) so it's never archived again.
 */

export interface IncomingFile {
  path: string;
  /** The bytes, or a file on this node to stream in (large models, recordings). */
  bytes?: Uint8Array;
  fromPath?: string;
  type?: string;
}

export interface IncomingEntry {
  kind: string;
  source: string;
  sourceId: string;
  title: string;
  description: string;
  trust: Trust;
  /** When the record was made (its source's time, ms). */
  createdAt: number;
  tags?: string[];
  meta?: Record<string, unknown>;
  files?: IncomingFile[];
  /** Explicit links: a record and the kept work it used, an investigation and its evidence. */
  links?: { rel: string; to: string }[];
}

export interface StoredChunk {
  id: number;
  entryRow: number;
  entry: string;
  text: string;
}

const TRUST_RANK: Record<Trust, number> = { owner: 2, agent: 1, untrusted: 0 };
/** The less trusted of two: what's derived from an entry is never more trusted than it. */
export const lowerTrust = (a: Trust, b: Trust): Trust => (TRUST_RANK[a] <= TRUST_RANK[b] ? a : b);

/** How a link reads from the other end. */
const INVERSE: Record<string, string> = {
  uses: "used-by",
  "used-by": "uses",
  "part-of": "has-part",
  "has-part": "part-of",
  "lesson-of": "lessons",
  lessons: "lesson-of",
  continues: "continued-by",
  "continued-by": "continues",
  evidence: "evidence-for",
  "evidence-for": "evidence",
  similar: "similar",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  row INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  trust TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  redactions TEXT NOT NULL DEFAULT '[]',
  refused TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  understanding TEXT,
  understood_at INTEGER,
  deleted_at INTEGER,
  deleted_reason TEXT,
  deleted_by TEXT,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS entries_by_time ON entries (created_at);
CREATE INDEX IF NOT EXISTS entries_by_kind ON entries (kind, created_at);
CREATE TABLE IF NOT EXISTS files (entry TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, text INTEGER NOT NULL, PRIMARY KEY (entry, path));
CREATE INDEX IF NOT EXISTS files_by_blob ON files (sha256);
CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_at INTEGER NOT NULL, verified_at INTEGER, ok INTEGER);
CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, entry_row INTEGER NOT NULL, ord INTEGER NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (entry_row, ord));
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, text, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS vectors (chunk INTEGER PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, scale REAL NOT NULL, q BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS vectors_by_model ON vectors (model);
CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL, score REAL, PRIMARY KEY (src, dst, rel));
CREATE INDEX IF NOT EXISTS links_by_dst ON links (dst);
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, cursor TEXT, last_run INTEGER, last_error TEXT, pulled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, summaries INTEGER NOT NULL DEFAULT 0);
`;

interface EntryRow {
  row: number;
  id: string;
  kind: string;
  source: string;
  source_id: string;
  title: string;
  description: string;
  trust: Trust;
  tags: string;
  meta: string;
  redactions: string;
  refused: string;
  created_at: number;
  archived_at: number;
  understanding: string | null;
  understood_at: number | null;
  deleted_at: number | null;
  deleted_reason: string | null;
  deleted_by: string | null;
}

export class ArchiveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Strings in a JSON-shaped value, each scrubbed of secrets. */
function scrubValue(value: unknown, where: string, out: Redaction[]): unknown {
  if (typeof value === "string") {
    const s = scrub(value, where);
    out.push(...s.redactions);
    return s.text;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, where, out));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, `${where}.${k}`, out)]));
  return value;
}

/** A file's media type, from its name, as it's served: text as text, never HTML or SVG rendered. */
export function mediaType(path: string): string {
  const ext = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const images: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  if (images[ext]) return images[ext]!;
  if (ext === ".pdf") return "application/pdf";
  if (fileTextKind(path) || ext === ".ipynb") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export interface ArchiveStoreOptions {
  now?: () => number;
}

export class ArchiveStore {
  readonly db: Database;
  private readonly now: () => number;
  private index: VectorIndex | null = null;

  constructor(
    readonly path: string,
    readonly blobs: BlobBackend,
    opts: ArchiveStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    // Private from the first byte: the node's user alone.
    if (path !== ":memory:" && !existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    this.db = new Database(path, { strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- Settings, cursors, usage --------------------------------------------------

  setting(key: string): string | null {
    return this.db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?").get(key)?.v ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  cursor(source: string): { cursor: string | null; lastRun: number | null; lastError: string | null; pulled: number } {
    const row = this.db.query<{ cursor: string | null; last_run: number | null; last_error: string | null; pulled: number }, [string]>("SELECT * FROM cursors WHERE source = ?").get(source);
    return { cursor: row?.cursor ?? null, lastRun: row?.last_run ?? null, lastError: row?.last_error ?? null, pulled: row?.pulled ?? 0 };
  }

  /** Record a pull: where it got to, how many it read. A cursor only moves on once its records are in. */
  advance(source: string, cursor: string | null, pulled: number): void {
    this.db
      .query("INSERT INTO cursors (source, cursor, last_run, last_error, pulled) VALUES (?, ?, ?, NULL, ?) ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, last_run = excluded.last_run, last_error = NULL, pulled = cursors.pulled + excluded.pulled")
      .run(source, cursor, this.now(), pulled);
  }

  sourceFailed(source: string, error: string): void {
    this.db
      .query("INSERT INTO cursors (source, cursor, last_run, last_error) VALUES (?, NULL, ?, ?) ON CONFLICT (source) DO UPDATE SET last_run = excluded.last_run, last_error = excluded.last_error")
      .run(source, this.now(), error.slice(0, 500));
  }

  /** Days are the node's local calendar days, as the owner reads "per day". */
  private today(): string {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  usedToday(): number {
    return this.db.query<{ summaries: number }, [string]>("SELECT summaries FROM usage WHERE day = ?").get(this.today())?.summaries ?? 0;
  }

  use(summaries: number): void {
    this.db.query("INSERT INTO usage (day, summaries) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET summaries = usage.summaries + excluded.summaries").run(this.today(), summaries);
  }

  // ---- Ingest --------------------------------------------------------------------

  /** Source ids of one source beginning with a prefix (a chat's archived segments), tombstones included. */
  sourceIds(source: string, prefix: string): string[] {
    return this.db
      .query<{ source_id: string }, [string, string]>("SELECT source_id FROM entries WHERE source = ? AND substr(source_id, 1, length(?)) = ?2")
      .all(source, prefix)
      .map((r) => r.source_id);
  }

  /** Already archived (or deleted by you: a tombstone keeps it out for good). */
  has(source: string, sourceId: string): boolean {
    return !!this.db.query("SELECT 1 FROM entries WHERE source = ? AND source_id = ?").get(source, sourceId);
  }

  /**
   * Keep a record. Idempotent: the same source and source id is archived once (its id
   * is their hash). Every text is scrubbed of secrets, every file checked: key material
   * is refused, secret-shaped text is stored redacted, and the entry says which.
   */
  async ingest(input: IncomingEntry): Promise<{ id: string; created: boolean }> {
    const id = archiveId(input.source, input.sourceId);
    if (this.has(input.source, input.sourceId)) return { id, created: false };
    const redactions: Redaction[] = [];
    const clean = (text: string, where: string) => {
      const s = scrub(text, where);
      redactions.push(...s.redactions);
      return s.text;
    };
    const title = clean(input.title.replace(/\s+/g, " ").trim().slice(0, 300) || "(untitled)", "title");
    const description = clean(input.description.slice(0, 2_000_000), "description");
    const tags = [...new Set((input.tags ?? []).map((t) => clean(t.trim().slice(0, 64), "tags")).filter(Boolean))].slice(0, 32);
    const meta = scrubValue(input.meta ?? {}, "meta", redactions) as Record<string, unknown>;

    const files: { path: string; sha256: string; size: number; type: string; text: string | null }[] = [];
    const refused: { path: string; why: string }[] = [];
    const seenPaths = new Set<string>();
    for (const file of input.files ?? []) {
      const path = file.path.replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 512);
      if (!path || seenPaths.has(path) || path.split("/").some((p) => p === ".." || p === ".")) continue;
      seenPaths.add(path);
      const head = file.bytes ?? (file.fromPath ? readHead(file.fromPath) : null);
      if (!head) continue;
      const why = refuseFile(path, head);
      if (why) {
        refused.push({ path, why });
        continue;
      }
      const type = file.type ?? mediaType(path);
      const size = file.bytes ? file.bytes.length : fileSize(file.fromPath!);
      // Text is read whole (up to 32 MB: what the index keeps of it is bounded anyway); anything else streams.
      const small = file.bytes ?? (size <= 32 * 2 ** 20 && fileTextKind(path) ? new Uint8Array(readFileSync(file.fromPath!)) : null);
      const text = small && fileTextKind(path) ? asText(small) : null;
      if (text !== null) {
        const whole = small!.length <= 2 * 2 ** 20 ? new TextDecoder().decode(small!) : text;
        const s = scrub(whole, path);
        if (s.redactions.length) {
          // Secret-shaped text is kept without the secret: a new file, so a new hash.
          redactions.push(...s.redactions);
          const stored = await this.blobs.put(new TextEncoder().encode(s.text));
          files.push({ path, ...stored, type, text: s.text.slice(0, 200 * 1024) });
          continue;
        }
      }
      const stored = small ? await this.blobs.put(small) : await this.blobs.putFile(file.fromPath!);
      files.push({ path, ...stored, type, text: text ?? null });
    }

    const at = this.now();
    const chunks = chunkEntry({ kind: input.kind, title, description, files: files.filter((f) => f.text !== null).map((f) => ({ path: f.path, text: f.text! })) });
    const write = this.db.transaction(() => {
      const row = this.db
        .query<{ row: number }, [string, string, string, string, string, string, string, string, string, string, string, number, number]>(
          `INSERT INTO entries (id, kind, source, source_id, title, description, trust, tags, meta, redactions, refused, created_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING row`,
        )
        .get(id, input.kind, input.source, input.sourceId, title, description, input.trust, JSON.stringify(tags), JSON.stringify(meta), JSON.stringify(redactions), JSON.stringify(refused), Math.round(input.createdAt), at)!.row;
      for (const f of files) {
        this.db.query("INSERT OR IGNORE INTO files (entry, path, sha256, size, type, text) VALUES (?, ?, ?, ?, ?, ?)").run(id, f.path, f.sha256, f.size, f.type, f.text !== null ? 1 : 0);
        this.db.query("INSERT OR IGNORE INTO blobs (sha256, size, stored_at) VALUES (?, ?, ?)").run(f.sha256, f.size, at);
      }
      this.addChunks(row, title, chunks, 0);
      for (const link of input.links ?? []) if (link.to !== id) this.link(id, link.to, link.rel, null);
    });
    write();
    return { id, created: true };
  }

  private addChunks(row: number, title: string, chunks: { origin: string; text: string }[], from: number): void {
    chunks.forEach((c, i) => {
      const chunk = this.db.query<{ id: number }, [number, number, string, string]>("INSERT INTO chunks (entry_row, ord, origin, text) VALUES (?, ?, ?, ?) RETURNING id").get(row, from + i, c.origin, c.text)!.id;
      this.db.query("INSERT INTO chunks_fts (rowid, title, text) VALUES (?, ?, ?)").run(chunk, title, c.text);
    });
  }

  link(src: string, dst: string, rel: string, score: number | null): void {
    this.db.query("INSERT INTO links (src, dst, rel, score) VALUES (?, ?, ?, ?) ON CONFLICT (src, dst, rel) DO UPDATE SET score = excluded.score").run(src, dst, rel, score);
  }

  // ---- Reading -------------------------------------------------------------------

  private row(id: string): EntryRow | null {
    return this.db.query<EntryRow, [string]>("SELECT * FROM entries WHERE id = ?").get(id);
  }

  /** One live entry, as the API shows it (null when there's none, or it was deleted). */
  get(id: string, opts: { hideKinds?: string[] } = {}): ArchiveEntryView | null {
    const r = this.row(id);
    if (!r || r.deleted_at !== null || opts.hideKinds?.includes(r.kind)) return null;
    const files = this.db
      .query<{ path: string; sha256: string; size: number; type: string; text: number }, [string]>("SELECT path, sha256, size, type, text FROM files WHERE entry = ? ORDER BY path")
      .all(id)
      .map((f): ArchiveFileView => ({ path: f.path, sha256: f.sha256, size: f.size, type: f.type, text: f.text === 1 }));
    const counts = this.db
      .query<{ chunks: number; embedded: number }, [string, number]>(
        "SELECT COUNT(*) AS chunks, SUM(CASE WHEN v.chunk IS NULL THEN 0 ELSE 1 END) AS embedded FROM chunks c LEFT JOIN vectors v ON v.chunk = c.id AND v.model = ? WHERE c.entry_row = ?",
      )
      .get(this.setting("embedder.model") ?? "", r.row)!;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      description: r.description,
      source: r.source,
      sourceId: r.source_id,
      trust: r.trust,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      tags: JSON.parse(r.tags) as string[],
      meta: JSON.parse(r.meta) as Record<string, unknown>,
      files,
      understanding: r.understanding ? (JSON.parse(r.understanding) as ArchiveUnderstanding) : null,
      links: this.links(id, opts.hideKinds),
      redactions: JSON.parse(r.redactions) as Redaction[],
      refused: JSON.parse(r.refused) as { path: string; why: string }[],
      chunks: counts.chunks,
      embedded: counts.embedded ?? 0,
    };
  }

  /** An entry's links, both ways, to entries that are here and live. */
  links(id: string, hideKinds: string[] = []): ArchiveLinkView[] {
    const rows = this.db
      .query<{ other: string; rel: string; score: number | null; out: number }, [string, string]>(
        "SELECT dst AS other, rel, score, 1 AS out FROM links WHERE src = ? UNION ALL SELECT src AS other, rel, score, 0 AS out FROM links WHERE dst = ?",
      )
      .all(id, id);
    const seen = new Set<string>();
    const out: ArchiveLinkView[] = [];
    for (const l of rows) {
      const rel = l.out ? l.rel : (INVERSE[l.rel] ?? l.rel);
      const key = `${l.other}:${rel}`;
      if (seen.has(key)) continue;
      const other = this.row(l.other);
      if (!other || other.deleted_at !== null || hideKinds.includes(other.kind)) continue;
      seen.add(key);
      out.push({ id: other.id, rel, title: other.title, kind: other.kind, trust: other.trust, score: l.score });
    }
    const order = (rel: string) => (rel === "similar" ? 1 : 0);
    return out.sort((a, b) => order(a.rel) - order(b.rel) || (b.score ?? 1) - (a.score ?? 1)).slice(0, 40);
  }

  /** One stored file's bytes, checked against its SHA-256 before anyone sees them. */
  async file(id: string, path: string, opts: { hideKinds?: string[] } = {}): Promise<{ bytes: Uint8Array; type: string; name: string }> {
    const entry = this.row(id);
    if (!entry || entry.deleted_at !== null || opts.hideKinds?.includes(entry.kind)) throw new ArchiveError(404, "no such entry");
    const f = this.db.query<{ sha256: string; type: string }, [string, string]>("SELECT sha256, type FROM files WHERE entry = ? AND path = ?").get(id, path);
    if (!f) throw new ArchiveError(404, "no such file in that entry");
    const bytes = await this.blobs.get(f.sha256);
    if (!bytes) throw new ArchiveError(410, "that file is missing from the archive's store (the integrity check reports it)");
    const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (actual !== f.sha256) throw new ArchiveError(500, "that file no longer matches its SHA-256 (the integrity check reports it)");
    return { bytes, type: f.type, name: path.split("/").at(-1)! };
  }

  // ---- Deleting (the owner's alone) -------------------------------------------------

  /**
   * Gone, except its tombstone: the passages, vectors, links and summary go, the words go
   * (secure_delete overwrites them in the file), and each file goes unless another entry
   * still holds it. Lessons drawn from it go with it. The id, kind and source stay, so
   * it's never archived again.
   */
  async delete(id: string, reason: string, by: string): Promise<{ deleted: string[]; blobs: number }> {
    const target = this.row(id);
    if (!target || target.deleted_at !== null) throw new ArchiveError(404, "no such entry");
    const lessons = this.db.query<{ src: string }, [string]>("SELECT src FROM links WHERE dst = ? AND rel = 'lesson-of'").all(id).map((r) => r.src);
    const doomed = [id, ...lessons.filter((l) => this.row(l)?.deleted_at === null)];
    const shas = new Set<string>();
    const rows = new Set<number>();
    const at = this.now();
    const write = this.db.transaction(() => {
      for (const which of doomed) {
        const r = this.row(which)!;
        rows.add(r.row);
        for (const f of this.db.query<{ sha256: string }, [string]>("SELECT sha256 FROM files WHERE entry = ?").all(which)) shas.add(f.sha256);
        for (const c of this.db.query<{ id: number }, [number]>("SELECT id FROM chunks WHERE entry_row = ?").all(r.row)) {
          this.db.query("DELETE FROM chunks_fts WHERE rowid = ?").run(c.id);
          this.db.query("DELETE FROM vectors WHERE chunk = ?").run(c.id);
        }
        this.db.query("DELETE FROM chunks WHERE entry_row = ?").run(r.row);
        this.db.query("DELETE FROM files WHERE entry = ?").run(which);
        this.db.query("DELETE FROM links WHERE src = ? OR dst = ?").run(which, which);
        this.db
          .query("UPDATE entries SET title = '', description = '', tags = '[]', meta = '{}', redactions = '[]', refused = '[]', understanding = NULL, deleted_at = ?, deleted_reason = ?, deleted_by = ? WHERE id = ?")
          .run(at, which === id ? reason.slice(0, 500) : `its source ${id} was deleted`, by.slice(0, 120), which);
      }
    });
    write();
    this.index?.removeEntries(rows);
    let removed = 0;
    for (const sha of shas) {
      const still = this.db.query("SELECT 1 FROM files WHERE sha256 = ? LIMIT 1").get(sha);
      if (still) continue;
      await this.blobs.delete(sha);
      this.db.query("DELETE FROM blobs WHERE sha256 = ?").run(sha);
      removed++;
    }
    return { deleted: doomed, blobs: removed };
  }

  // ---- Search ----------------------------------------------------------------------

  /** Live entries' rows that pass the filters (null: every live entry passes). */
  private allowed(filters: ArchiveFilters, hideKinds: string[]): Set<number> | null {
    const { where, params } = this.filterSql(filters, hideKinds);
    if (where === "e.deleted_at IS NULL") return null;
    return new Set(this.db.query<{ row: number }, any[]>(`SELECT e.row FROM entries e WHERE ${where}`).all(...params).map((r) => r.row));
  }

  private filterSql(filters: ArchiveFilters, hideKinds: string[]): { where: string; params: (string | number)[] } {
    const clauses = ["e.deleted_at IS NULL"];
    const params: (string | number)[] = [];
    const list = (column: string, values: readonly string[] | undefined, not = false) => {
      if (!values?.length) return;
      clauses.push(`e.${column} ${not ? "NOT IN" : "IN"} (${values.map(() => "?").join(", ")})`);
      params.push(...values);
    };
    list("kind", filters.kinds);
    list("trust", filters.trust);
    list("source", filters.sources);
    list("kind", hideKinds, true);
    if (filters.since !== undefined) {
      clauses.push("e.created_at >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      clauses.push("e.created_at <= ?");
      params.push(filters.until);
    }
    return { where: clauses.join(" AND "), params };
  }

  /** The newest entries that pass the filters. */
  recent(filters: ArchiveFilters, limit: number, offset = 0, hideKinds: string[] = []): ArchiveHit[] {
    const { where, params } = this.filterSql(filters, hideKinds);
    return this.db
      .query<EntryRow, any[]>(`SELECT e.* FROM entries e WHERE ${where} ORDER BY e.created_at DESC, e.row DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        trust: r.trust,
        source: r.source,
        createdAt: r.created_at,
        snippet: snippet(r.description, [], 240),
        from: "description",
        summary: r.understanding ? (JSON.parse(r.understanding) as ArchiveUnderstanding).summary : null,
        score: 0,
        similarity: null,
        matched: [],
      }));
  }

  /** Passages by their words: BM25 over title and text (the title weighs more). */
  textMatches(terms: string[], filters: ArchiveFilters, limit: number, hideKinds: string[] = []): { chunk: number; entry: number; rank: number }[] {
    if (!terms.length) return [];
    const { where, params } = this.filterSql(filters, hideKinds);
    return this.db
      .query<{ chunk: number; entry: number; rank: number }, any[]>(
        `SELECT c.id AS chunk, c.entry_row AS entry, bm25(chunks_fts, 2.0, 1.0) AS rank
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN entries e ON e.row = c.entry_row
         WHERE chunks_fts MATCH ? AND ${where} ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery(terms), ...params, limit);
  }

  /** The vectors of one model, loaded once and kept in step with every write. */
  vectors(model: string): VectorIndex | null {
    if (this.index?.model === model) return this.index;
    const first = this.db.query<{ dims: number }, [string]>("SELECT dims FROM vectors WHERE model = ? LIMIT 1").get(model);
    if (!first) {
      this.index = null;
      return null;
    }
    const index = new VectorIndex(model, first.dims, Math.max(1024, this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM vectors WHERE model = ?").get(model)!.n));
    for (const v of this.db
      .query<{ chunk: number; entry: number; scale: number; q: Uint8Array; dims: number }, [string]>(
        "SELECT v.chunk, c.entry_row AS entry, v.scale, v.q, v.dims FROM vectors v JOIN chunks c ON c.id = v.chunk JOIN entries e ON e.row = c.entry_row WHERE v.model = ? AND e.deleted_at IS NULL",
      )
      .iterate(model)) {
      if (v.dims === first.dims) index.add(v.chunk, v.entry, { q: fromBlob(v.q), scale: v.scale });
    }
    this.index = index;
    return index;
  }

  /**
   * Words and meaning, fused. `query` is the query's vector from the current embedder
   * (null: words only). Results are entries, best first, each with its best passage.
   */
  search(
    q: string,
    filters: ArchiveFilters,
    opts: { limit?: number; offset?: number; model?: string | null; query?: Float32Array | null; hideKinds?: string[] } = {},
  ): Omit<ArchiveSearchView, "tookMs" | "embedder"> {
    const limit = opts.limit ?? 10;
    const offset = opts.offset ?? 0;
    const hideKinds = opts.hideKinds ?? [];
    const terms = queryTerms(q);
    if (!q.trim()) return { hits: this.recent(filters, limit, offset, hideKinds), mode: "recent" };
    const depth = Math.max(50, (limit + offset) * 4);
    const text = this.textMatches(terms, filters, depth, hideKinds);
    let meaning: { chunk: number; entry: number; similarity: number }[] = [];
    const index = opts.model && opts.query ? this.vectors(opts.model) : null;
    if (index && opts.query) {
      const allowed = this.allowed(filters, hideKinds);
      meaning = index.search(opts.query, depth, allowed ? (entry) => allowed.has(entry) : undefined);
      // A scan always finds k nearest, however far: keep those within reach of the best (half its
      // similarity, and above 0.1), so a passage about nothing like the query isn't offered as a result.
      // Relative, because what counts as close differs from one embedding model to the next.
      const floor = Math.max(0.1, (meaning[0]?.similarity ?? 0) * 0.5);
      meaning = meaning.filter((m) => m.similarity >= floor);
    }
    const lists: Ranked[][] = [text.map((t) => ({ entry: t.entry, chunk: t.chunk })), meaning.map((m) => ({ entry: m.entry, chunk: m.chunk }))];
    const fused = fuse(lists).slice(offset, offset + limit);
    const similarity = new Map<number, number>();
    for (const m of meaning) if (!similarity.has(m.entry)) similarity.set(m.entry, m.similarity);
    const hits = fused.map((f): ArchiveHit => {
      const r = this.db.query<EntryRow, [number]>("SELECT * FROM entries WHERE row = ?").get(f.entry)!;
      const best = f.best[0]! >= 0 ? f.best[0]! : f.best[1]!;
      const chunk = this.db.query<{ text: string; origin: string }, [number]>("SELECT text, origin FROM chunks WHERE id = ?").get(best)!;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        trust: r.trust,
        source: r.source,
        createdAt: r.created_at,
        snippet: snippet(chunk.text, terms),
        from: chunk.origin,
        summary: r.understanding ? (JSON.parse(r.understanding) as ArchiveUnderstanding).summary : null,
        score: +f.score.toFixed(6),
        similarity: similarity.has(f.entry) ? +similarity.get(f.entry)!.toFixed(4) : null,
        matched: f.found.map((w) => (w === 0 ? "text" : "meaning")),
      };
    });
    return { hits, mode: index ? "hybrid" : "text" };
  }

  /** How many of a query's terms the passage behind a hit holds (the words-only relevance bar). */
  termsMatched(hit: ArchiveHit, q: string): number {
    return matchedTerms(`${hit.title} ${hit.snippet}`, queryTerms(q));
  }

  // ---- Embedding ---------------------------------------------------------------------

  /**
   * Passages without a vector from this model, oldest first, after a passage id (where the
   * last batch ended: without it, each batch would walk every embedded passage again).
   */
  pendingChunks(model: string, limit: number, after = 0): StoredChunk[] {
    return this.db
      .query<StoredChunk, [string, number, number]>(
        `SELECT c.id, c.entry_row AS entryRow, e.id AS entry, c.text FROM chunks c JOIN entries e ON e.row = c.entry_row
         LEFT JOIN vectors v ON v.chunk = c.id AND v.model = ? WHERE c.id > ? AND v.chunk IS NULL AND e.deleted_at IS NULL ORDER BY c.id LIMIT ?`,
      )
      .all(model, after, limit);
  }

  backlog(model: string | null): number {
    if (!model) return this.chunkCount();
    return this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM chunks c JOIN entries e ON e.row = c.entry_row LEFT JOIN vectors v ON v.chunk = c.id AND v.model = ? WHERE v.chunk IS NULL AND e.deleted_at IS NULL",
      )
      .get(model)!.n;
  }

  chunkCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()!.n;
  }

  embeddedCount(model: string | null): number {
    if (!model) return 0;
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM vectors WHERE model = ?").get(model)!.n;
  }

  /** Store vectors (unit length) for passages, under the model that made them. */
  storeVectors(model: string, items: { chunk: number; entryRow: number; vector: Float32Array }[]): void {
    const quantized: { chunk: number; entryRow: number; v: Quantized }[] = items.map((i) => ({ chunk: i.chunk, entryRow: i.entryRow, v: quantize(i.vector) }));
    const write = this.db.transaction(() => {
      for (const { chunk, v } of quantized) {
        this.db.query("INSERT INTO vectors (chunk, model, dims, scale, q) VALUES (?, ?, ?, ?, ?) ON CONFLICT (chunk) DO UPDATE SET model = excluded.model, dims = excluded.dims, scale = excluded.scale, q = excluded.q").run(chunk, model, v.q.length, v.scale, toBlob(v.q));
      }
    });
    write();
    const index = this.index;
    if (!index) return;
    if (index.model !== model) {
      this.index = null;
      return;
    }
    for (const { chunk, entryRow, v } of quantized) if (v.q.length === index.dims) index.add(chunk, entryRow, v);
  }

  /** Vectors another model made, which can't be compared with this one's: dropped a batch at a time. */
  dropOtherModels(model: string, batch = 5000): number {
    return this.db.query("DELETE FROM vectors WHERE chunk IN (SELECT chunk FROM vectors WHERE model != ? LIMIT ?)").run(model, batch).changes;
  }

  /** Every vector, for a fresh start (reindex). */
  dropVectors(): void {
    this.db.exec("DELETE FROM vectors");
    this.index = null;
  }

  /** An entry's mean vector (its passages, current model), for its nearest neighbours. */
  entryVector(id: string, model: string): Float32Array | null {
    const r = this.row(id);
    const index = this.vectors(model);
    if (!r || !index) return null;
    const mean = new Float32Array(index.dims);
    let n = 0;
    for (const { id: chunk } of this.db.query<{ id: number }, [number]>("SELECT id FROM chunks WHERE entry_row = ?").all(r.row)) {
      const v = index.vector(chunk);
      if (!v) continue;
      for (let i = 0; i < v.length; i++) mean[i] = mean[i]! + v[i]!;
      n++;
    }
    if (!n) return null;
    let norm = 0;
    for (let i = 0; i < mean.length; i++) norm += mean[i]! * mean[i]!;
    norm = Math.sqrt(norm);
    for (let i = 0; i < mean.length; i++) mean[i] = mean[i]! / norm;
    return mean;
  }

  /** Link an entry to its nearest neighbours above a similarity threshold. Returns how many. */
  linkSimilar(id: string, model: string, threshold: number, k = 5): number {
    const r = this.row(id);
    const v = this.entryVector(id, model);
    const index = this.vectors(model);
    if (!r || !v || !index) return 0;
    const best = new Map<number, number>();
    for (const hit of index.search(v, k * 8, (entry) => entry !== r.row)) {
      if (hit.similarity < threshold) break;
      if (!best.has(hit.entry)) best.set(hit.entry, hit.similarity);
      if (best.size >= k) break;
    }
    for (const [row, score] of best) {
      const other = this.db.query<{ id: string }, [number]>("SELECT id FROM entries WHERE row = ?").get(row);
      if (!other) continue;
      const [a, b] = id < other.id ? [id, other.id] : [other.id, id];
      this.link(a, b, "similar", +score.toFixed(4));
    }
    this.db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(`linked:${id}`, model);
    return best.size;
  }

  /** Entries whose passages are all embedded but whose neighbours haven't been looked for (with this model). */
  unlinked(model: string, limit: number): string[] {
    return this.db
      .query<{ id: string }, [string, string, number]>(
        `SELECT e.id FROM entries e WHERE e.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.k = 'linked:' || e.id AND m.v = ?)
         AND NOT EXISTS (SELECT 1 FROM chunks c LEFT JOIN vectors v ON v.chunk = c.id AND v.model = ? WHERE c.entry_row = e.row AND v.chunk IS NULL)
         ORDER BY e.row LIMIT ?`,
      )
      .all(model, model, limit)
      .map((r) => r.id);
  }

  // ---- Understanding -------------------------------------------------------------

  /** Entries not yet summarised, oldest first (lessons are summaries already). */
  pendingUnderstanding(limit: number): { id: string; kind: string; title: string; description: string; trust: Trust; files: { path: string; text: string }[] }[] {
    return this.db
      .query<EntryRow, [number]>("SELECT * FROM entries WHERE deleted_at IS NULL AND understood_at IS NULL AND kind != 'lesson' ORDER BY row LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        description: r.description,
        trust: r.trust,
        // What the passages already hold of its text files (bounded, scrubbed).
        files: this.db
          .query<{ origin: string; text: string }, [number]>("SELECT origin, text FROM chunks WHERE entry_row = ? AND origin NOT IN ('description', 'summary') ORDER BY ord LIMIT 6")
          .all(r.row)
          .map((c) => ({ path: c.origin, text: c.text })),
      }));
  }

  understandingBacklog(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NULL AND understood_at IS NULL AND kind != 'lesson'").get()!.n;
  }

  /** Summarising this entry failed in a way trying again won't fix (it's marked, so the queue moves on). */
  understandingSkipped(id: string): void {
    this.db.query("UPDATE entries SET understood_at = ? WHERE id = ? AND understood_at IS NULL").run(this.now(), id);
  }

  /**
   * What the swift role understood of an entry: kept with it, searchable as one more
   * passage (model output: the entry's trust at most). Secret-shaped text is scrubbed.
   */
  understand(id: string, u: ArchiveUnderstanding): void {
    const r = this.row(id);
    if (!r || r.deleted_at !== null) return;
    const redactions: Redaction[] = [];
    const clean = scrubValue(u, "understanding", redactions) as ArchiveUnderstanding;
    const text = [
      clean.summary,
      clean.facts.length ? `Facts: ${clean.facts.join("; ")}` : "",
      clean.tags.length ? `Tags: ${clean.tags.join(", ")}` : "",
      clean.entities.length ? `Named: ${clean.entities.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const write = this.db.transaction(() => {
      for (const c of this.db.query<{ id: number }, [number]>("SELECT id FROM chunks WHERE entry_row = ? AND origin = 'summary'").all(r.row)) {
        this.index?.removeChunk(c.id);
        this.db.query("DELETE FROM chunks_fts WHERE rowid = ?").run(c.id);
        this.db.query("DELETE FROM vectors WHERE chunk = ?").run(c.id);
        this.db.query("DELETE FROM chunks WHERE id = ?").run(c.id);
      }
      const next = this.db.query<{ n: number | null }, [number]>("SELECT MAX(ord) AS n FROM chunks WHERE entry_row = ?").get(r.row)!.n ?? -1;
      this.addChunks(r.row, r.title, [{ origin: "summary", text: `${r.title} · summary\n${text}` }], next + 1);
      this.db.query("UPDATE entries SET understanding = ?, understood_at = ? WHERE id = ?").run(JSON.stringify(clean), this.now(), id);
    });
    write();
  }

  /** Summaries to be written again (a reindex that asks for it). */
  forgetUnderstanding(): void {
    this.db.exec("UPDATE entries SET understood_at = NULL WHERE deleted_at IS NULL AND kind != 'lesson'");
  }

  // ---- Integrity -----------------------------------------------------------------

  /**
   * Re-hash every stored file and compare it with its name; check every entry's files
   * are there. Problems are reported, never "fixed" by deleting anything.
   */
  async verify(opts: { yieldEvery?: number } = {}): Promise<{ checked: number; problems: string[] }> {
    const problems: string[] = [];
    let checked = 0;
    const blobs = this.db.query<{ sha256: string; size: number }, []>("SELECT sha256, size FROM blobs ORDER BY sha256").all();
    for (const blob of blobs) {
      const actual = await this.blobs.rehash(blob.sha256);
      checked++;
      const ok = actual === blob.sha256;
      if (!ok) {
        const holders = this.db.query<{ entry: string; path: string }, [string]>("SELECT entry, path FROM files WHERE sha256 = ? LIMIT 3").all(blob.sha256);
        const where = holders.map((h) => `${h.entry} ${h.path}`).join(", ") || "no entry";
        problems.push(actual === null ? `missing: ${blob.sha256.slice(0, 16)}… (${where})` : `changed: ${blob.sha256.slice(0, 16)}… now hashes to ${actual.slice(0, 16)}… (${where})`);
      }
      this.db.query("UPDATE blobs SET verified_at = ?, ok = ? WHERE sha256 = ?").run(this.now(), ok ? 1 : 0, blob.sha256);
      if (opts.yieldEvery && checked % opts.yieldEvery === 0) await Bun.sleep(0);
    }
    const orphans = this.db.query<{ entry: string; path: string }, []>("SELECT f.entry, f.path FROM files f LEFT JOIN blobs b ON b.sha256 = f.sha256 WHERE b.sha256 IS NULL LIMIT 20").all();
    for (const o of orphans) problems.push(`unrecorded: ${o.entry} ${o.path}`);
    const result = { at: this.now(), checked, problems: problems.slice(0, 50) };
    this.setSetting("integrity", JSON.stringify({ ...result, ok: problems.length === 0 }));
    return { checked, problems };
  }

  lastIntegrity(): { lastAt: number | null; ok: boolean | null; checked: number; problems: string[] } {
    const raw = this.setting("integrity");
    if (!raw) return { lastAt: null, ok: null, checked: 0, problems: [] };
    const v = JSON.parse(raw) as { at: number; ok: boolean; checked: number; problems: string[] };
    return { lastAt: v.at, ok: v.ok, checked: v.checked, problems: v.problems };
  }

  // ---- Counts --------------------------------------------------------------------

  counts(): { entries: number; byKind: Record<string, number>; deleted: number; blobBytes: number; blobs: number } {
    const byKind = Object.fromEntries(
      this.db.query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) AS n FROM entries WHERE deleted_at IS NULL GROUP BY kind ORDER BY n DESC").all().map((r) => [r.kind, r.n]),
    );
    const blobs = this.db.query<{ n: number; bytes: number | null }, []>("SELECT COUNT(*) AS n, SUM(size) AS bytes FROM blobs").get()!;
    return {
      entries: Object.values(byKind).reduce((a, b) => a + b, 0),
      byKind,
      deleted: this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NOT NULL").get()!.n,
      blobBytes: blobs.bytes ?? 0,
      blobs: blobs.n,
    };
  }

  /** The index file's size on disk, its write-ahead log included. */
  indexBytes(): number {
    if (this.path === ":memory:") return 0;
    let total = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        total += Bun.file(`${this.path}${suffix}`).size;
      } catch {
        /* not there */
      }
    }
    return total;
  }
}

/** The first bytes of a file on disk (enough to recognise key material), or null when it can't be read. */
function readHead(path: string): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = new Uint8Array(256 * 1024);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
