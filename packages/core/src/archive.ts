import { z } from "zod";
import { sha256B64u } from "./crypto.ts";
import { Trust } from "./events.ts";

/*
 * The archive: everything Galahad made, was taught or thought of, kept for good and
 * learned from. Node-local (its own SQLite index and a blob store in the node's home,
 * never the mind's log), append-only and content-addressed: an entry's files are
 * stored once by SHA-256, and an entry's id follows from where it came from, so the
 * same record is never archived twice. Only you delete, and a deletion leaves a
 * tombstone so it never comes back.
 *
 * Entries are data. What strangers wrote (web pages, an agent's text) keeps its
 * trust, `untrusted`, everywhere it goes: search results, Galahad's context, summaries.
 */

/** Kinds Galahad archives today; an entry of any other kind (a newer node's, or one this version no longer archives) is kept and shown as it is. */
/** (`trial`: a trial's record and what it kept. Searchable by you; never offered to a model as context: trials.ts.) */
export const ARCHIVE_KINDS = ["model", "teaching", "idea", "artifact", "chat", "lesson", "trial"] as const;
export type KnownArchiveKind = (typeof ARCHIVE_KINDS)[number];

export const ArchiveKind = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "a lowercase kind, e.g. idea");
export const ArchiveSource = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "a lowercase source, e.g. memories");
export const ArchiveId = z.string().regex(/^arc_[A-Za-z0-9_-]{22}$/);
export type ArchiveId = z.infer<typeof ArchiveId>;
export const ArchiveTag = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._:/-]*$/u, "letters, digits, spaces and . _ : / -");

/** An entry's id: the hash of where it came from, so archiving the same record again is a no-op. */
export const archiveId = (source: string, sourceId: string): string => `arc_${sha256B64u(`galahad/archive/v1\u0000${source}\u0000${sourceId}`).slice(0, 22)}`;

/** Filters every search takes: kind, trust, source and time (ms since the epoch, by when the record was made). */
export const ArchiveFilters = z.strictObject({
  kinds: z.array(ArchiveKind).max(16).optional(),
  trust: z.array(Trust).min(1).max(3).optional(),
  sources: z.array(ArchiveSource).max(16).optional(),
  since: z.number().int().min(0).optional(),
  until: z.number().int().min(0).optional(),
});
export type ArchiveFilters = z.infer<typeof ArchiveFilters>;

export const ArchiveSearchInput = ArchiveFilters.extend({
  /** Words or a question; empty lists the newest entries. */
  q: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
});

export const NoteIdeaInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
  tags: z.array(ArchiveTag).max(16).optional(),
});

/** Deleting is yours alone, with a reason; the index keeps a tombstone so the record is never archived again. */
export const ArchiveDeleteInput = z.strictObject({ id: ArchiveId, reason: z.string().trim().min(3).max(500) });

export const ArchiveReindexInput = z.strictObject({
  /** Embed every chunk again (the embedder's model changed, or you want it fresh). Default true. */
  embeddings: z.boolean().optional(),
  /** Summarise every entry again, within the daily budget. Default false. */
  understanding: z.boolean().optional(),
});

export const ArchiveBudgetInput = z.strictObject({
  /** Entries the swift role may summarise per day (0 stops it). */
  summariesPerDay: z.number().int().min(0).max(10_000),
});

// ---- Response shapes -------------------------------------------------------

export interface ArchiveFileView {
  path: string;
  sha256: string;
  size: number;
  type: string;
  /** Text Galahad can read (and did index). */
  text: boolean;
}

export interface ArchiveLinkView {
  id: string;
  /** similar (nearest neighbours) · uses · used-by · part-of · has-part · lesson-of · lessons · continues · continued-by · evidence · evidence-for */
  rel: string;
  title: string;
  kind: string;
  trust: z.infer<typeof Trust>;
  score: number | null;
}

export interface ArchiveLessons {
  worked: string[];
  failed: string[];
  next: string[];
}

export interface ArchiveUnderstanding {
  summary: string;
  facts: string[];
  tags: string[];
  /** Named things: people, machines, projects, tools, materials, places. */
  entities: string[];
  lessons: ArchiveLessons | null;
  /** The model that wrote it, and when. Model output: data, never instructions. */
  model: string;
  at: number;
}

export interface ArchiveEntryView {
  id: string;
  kind: string;
  title: string;
  description: string;
  source: string;
  sourceId: string;
  trust: z.infer<typeof Trust>;
  /** When the record was made (its source's time). */
  createdAt: number;
  archivedAt: number;
  tags: string[];
  meta: Record<string, unknown>;
  files: ArchiveFileView[];
  understanding: ArchiveUnderstanding | null;
  links: ArchiveLinkView[];
  /** What was taken out of its text before it was stored (secret-shaped), and where. */
  redactions: { where: string; kind: string }[];
  /** Files that were never stored, and why (key material, secret-shaped text). */
  refused: { path: string; why: string }[];
  chunks: number;
  embedded: number;
}

export interface ArchiveHit {
  id: string;
  kind: string;
  title: string;
  trust: z.infer<typeof Trust>;
  source: string;
  createdAt: number;
  /** The best-matching passage. */
  snippet: string;
  /** Where the snippet is from: the description, or a file's path. */
  from: string;
  summary: string | null;
  /** Reciprocal-rank-fused score (higher is better). */
  score: number;
  /** Cosine similarity of the best chunk, when it was found by meaning. */
  similarity: number | null;
  /** How it was found: by its words (BM25), by its meaning (vectors), or both. */
  matched: ("text" | "meaning")[];
}

export interface ArchiveSearchView {
  hits: ArchiveHit[];
  /** hybrid: words and meaning fused · text: words only (no embedder, or it failed) · recent: no query */
  mode: "hybrid" | "text" | "recent";
  embedder: string | null;
  tookMs: number;
}

export interface ArchiveSourceStatus {
  name: string;
  /** Where it has read up to (opaque), or null before its first pull. */
  cursor: string | null;
  lastRun: number | null;
  lastError: string | null;
  /** Records it pulled in total. */
  pulled: number;
  /** Not connected on this node yet. */
  waiting: boolean;
}

export interface ArchiveStatusView {
  node: string;
  entries: number;
  byKind: Record<string, number>;
  /** Tombstones: deleted by you, never archived again. */
  deleted: number;
  chunks: number;
  /** Chunks with a vector from the current embedder's model. */
  embedded: number;
  /** Chunks still waiting for one. */
  backlog: number;
  embedder: { model: string | null; state: "ready" | "none" | "failing"; error: string | null; dims: number | null; local: boolean | null };
  /** Summaries by the swift role: per day, used today. Until you set a budget, only a local model writes them (nothing leaves). */
  understanding: { perDay: number; localOnly: boolean; usedToday: number; backlog: number; lastError: string | null; lastRun: number | null };
  integrity: { lastAt: number | null; ok: boolean | null; checked: number; problems: string[] };
  disk: { blobBytes: number; blobs: number; indexBytes: number; backend: string; root: string };
  sources: ArchiveSourceStatus[];
  /** Background work is waiting for the node to be less busy (answers stream, high load). */
  paused: boolean;
}

/** One archived entry Galahad was given as context for an answer (shown with the answer's steps). */
export interface ArchiveContextEntry {
  id: string;
  title: string;
  kind: string;
  trust: z.infer<typeof Trust>;
}
