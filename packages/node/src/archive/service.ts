import { cpus, loadavg } from "node:os";
import { type ArchiveFilters, type ArchiveSearchView, type ArchiveStatusView, archiveId, type NodeIdentity, sha256B64u, type Trust } from "@galahad/core";
import { type BrainContext, chat, type Embedding, embed, embedderRef, isEmbeddingModel, listModels, parseRef, resolveProvider, roleModels } from "@galahad/brain";
import type { MindStore } from "@galahad/mind";
import { reconcile } from "../heartbeat.ts";
import type { ArchiveAdapter } from "./adapters.ts";
import { scrub } from "./guard.ts";
import { type ContextRecord, fence } from "./retrieval.ts";
import { queryTerms } from "./search.ts";
import { ArchiveError, type ArchiveStore, type IncomingEntry } from "./store.ts";
import { lessonEntry, parseUnderstanding, understandingPrompt } from "./understand.ts";

/*
 * The archive at work, in the background: each tick pulls every source from its
 * cursor, embeds a batch of passages, links what's newly embedded to its nearest
 * neighbours, summarises a few entries within the day's budget, and once a day
 * re-hashes every stored file. A tick does a bounded amount of work, never two run at
 * once, and none runs while answers stream or the machine is loaded: the owner's chats
 * come first.
 */

export interface ArchiveServiceOptions {
  store: ArchiveStore;
  brain: BrainContext;
  /** For notices (the integrity check's findings). */
  mind: MindStore;
  identity: NodeIdentity;
  nodeName: string;
  adapters: ArchiveAdapter[];
  log: (message: string) => void;
  now?: () => number;
  /** The node is serving answers right now: background work waits. */
  busy?: () => boolean;
  /** How the machine's load is read (tests pass one). */
  load?: () => number;
  /** One call to the swift role (tests pass a stand-in). */
  summarise?: (prompt: string, signal: AbortSignal, allowCloud: boolean) => Promise<{ text: string; model: string } | null>;
  /** Embedding (tests pass a stand-in; default: the embedder role). */
  embed?: (texts: string[], as: "query" | "document", timeoutMs?: number) => Promise<Embedding>;
  intervalMs?: number;
}

const DAY = 86_400_000;
const SECOND = 1000;
/** Default nearest-neighbour bar for "similar" links, and for retrieval (cosine). */
const LINK_THRESHOLD = 0.75;
const RETRIEVAL_THRESHOLD = 0.5;
/** Summaries a day when the swift role is local and you haven't set a budget. */
const LOCAL_DAILY = 200;

export class ArchiveService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly failures = new Map<string, number>();
  private embedderError: string | null = null;
  private embedderDims: number | null = null;
  private embedderLocal: boolean | null = null;
  private embedRetryAt = 0;
  private embedFailures = 0;
  /** Where embedding got to (a passage id), for the model it was embedding with. */
  private embedFrom = 0;
  private embedModel: string | null = null;
  private understandError: string | null = null;
  private understandRetryAt = 0;
  private lastUnderstand: number | null = null;
  private pausedNow = false;
  private quietUntil = 0;
  private readonly abort = new AbortController();

  constructor(readonly o: ArchiveServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  get store(): ArchiveStore {
    return this.o.store;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.o.intervalMs ?? 20 * SECOND;
    // The first look a little after start, once the node is serving.
    this.timer = setInterval(() => void this.tick().catch((error) => this.o.log(`archive: ${(error as Error).message}`)), interval);
    this.first = setTimeout(() => void this.tick().catch((error) => this.o.log(`archive: ${(error as Error).message}`)), Math.min(interval, 5 * SECOND));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
    this.abort.abort();
    await this.running?.catch(() => {});
  }

  private answers = 0;

  /** An answer is streaming: background work waits until it's done (and a little after). Returns its end. */
  answering(): () => void {
    this.answers++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.answers--;
      this.noteActivity(10 * SECOND);
    };
  }

  /** Something happened that wants the machine: background work keeps out of its way for a while. */
  noteActivity(ms = 30 * SECOND): void {
    this.quietUntil = Math.max(this.quietUntil, this.now() + ms);
  }

  /** Whether background work waits: answers streaming, recent activity, or the machine loaded. */
  paused(): boolean {
    if (this.answers > 0 || this.o.busy?.() || this.now() < this.quietUntil) return true;
    const load = this.o.load ? this.o.load() : (loadavg()[0] ?? 0) / Math.max(1, cpus().length);
    return load > 0.9;
  }

  /** One round of background work (bounded). Concurrent calls share the round that's running. */
  tick(opts: { force?: boolean; budgetMs?: number } = {}): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      this.pausedNow = !opts.force && this.paused();
      if (this.pausedNow) return;
      const deadline = this.now() + (opts.budgetMs ?? 10 * SECOND);
      await this.pullAll(deadline);
      await this.embedSome(deadline);
      this.linkSome();
      await this.understandSome();
      await this.integrityIfDue();
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Run ticks until nothing is left to do (tests, `archive reindex` from a terminal). */
  async drain(rounds = 50): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      const before = JSON.stringify([this.store.counts().entries, this.store.backlog(this.model()), this.store.understandingBacklog(), this.cursors()]);
      await this.tick({ force: true, budgetMs: 60 * SECOND });
      const after = JSON.stringify([this.store.counts().entries, this.store.backlog(this.model()), this.store.understandingBacklog(), this.cursors()]);
      if (before === after) return;
    }
  }

  private cursors(): (string | null)[] {
    return this.o.adapters.map((a) => this.store.cursor(a.name).cursor);
  }

  // ---- Pulling ---------------------------------------------------------------------

  private async ingest(entry: IncomingEntry): Promise<boolean> {
    const key = `${entry.source}\u0000${entry.sourceId}`;
    try {
      await this.store.ingest(entry);
      this.failures.delete(key);
      return true;
    } catch (error) {
      const n = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, n);
      this.o.log(`archive: couldn't keep ${entry.source} ${entry.sourceId.slice(0, 40)}: ${(error as Error).message}${n >= 3 ? " (skipped after 3 tries)" : ""}`);
      // A record that fails three times is passed over, so one bad record can't stop a source for good.
      return n >= 3;
    }
  }

  private async pullOne(adapter: ArchiveAdapter, cursor: string | null): Promise<{ cursor: string | null; more: boolean; pulled: number; complete: boolean }> {
    const page = await adapter.pull(cursor, 50);
    let pulled = 0;
    for (const entry of page.entries) {
      if (!(await this.ingest(entry))) return { cursor, more: false, pulled, complete: false };
      pulled++;
    }
    return { cursor: page.cursor, more: page.more, pulled, complete: true };
  }

  private async pullAll(deadline: number): Promise<void> {
    for (const adapter of this.o.adapters) {
      if (adapter.waiting) continue;
      try {
        // From the cursor, as far as there's time.
        for (let page = 0; page < 40 && this.now() < deadline; page++) {
          const { cursor } = this.store.cursor(adapter.name);
          const r = await this.pullOne(adapter, cursor);
          if (!r.complete) break;
          this.store.advance(adapter.name, r.cursor, r.pulled);
          if (!r.more) break;
        }
        // Now and then from the start: what arrived late with an older cursor.
        if (adapter.sweepEveryMs && this.now() < deadline) {
          const last = Number(this.store.setting(`sweep:${adapter.name}`) ?? 0);
          const at = this.store.setting(`sweep-at:${adapter.name}`);
          if (at !== null || this.now() - last >= adapter.sweepEveryMs) {
            const r = await this.pullOne(adapter, at === null || at === "" ? null : at);
            if (r.complete && r.more) this.store.setSetting(`sweep-at:${adapter.name}`, r.cursor ?? "");
            else if (r.complete) {
              this.store.setSetting(`sweep:${adapter.name}`, String(this.now()));
              this.store.db.query("DELETE FROM meta WHERE k = ?").run(`sweep-at:${adapter.name}`);
            }
          }
        }
      } catch (error) {
        this.store.sourceFailed(adapter.name, (error as Error).message);
      }
    }
  }

  // ---- Ideas ---------------------------------------------------------------------

  /** An idea, kept: yours (owner), Galahad's (agent) or an outside agent's (untrusted). Noting the same one twice is a no-op. */
  async noteIdea(input: { title: string; text: string; tags?: string[] }, by: { trust: Trust; who: string }): Promise<{ id: string; created: boolean }> {
    const sourceId = sha256B64u(`${by.who}\u0000${input.title}\u0000${input.text}`).slice(0, 24);
    const result = await this.store.ingest({
      kind: "idea",
      source: "ideas",
      sourceId,
      title: input.title,
      description: input.text,
      trust: by.trust,
      createdAt: this.now(),
      tags: ["idea", ...(input.tags ?? [])],
      meta: { by: by.who },
    });
    return result;
  }

  // ---- Embedding -----------------------------------------------------------------

  /** The archive's embedding model now (the embedder role's first), or null. */
  model(): string | null {
    return embedderRef(this.o.brain);
  }

  private embedWith(texts: string[], as: "query" | "document", timeoutMs?: number): Promise<Embedding> {
    if (this.o.embed) return this.o.embed(texts, as, timeoutMs);
    return embed(this.o.brain, texts, { as, signal: this.abort.signal, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private async embedSome(deadline: number): Promise<void> {
    const model = this.model();
    if (!model) {
      this.embedderError = null;
      return;
    }
    if (this.store.setting("embedder.model") !== model) {
      // A new model: its vectors can't be compared with the old one's, so everything is embedded again.
      this.store.setSetting("embedder.model", model);
      this.embedderError = null;
      this.embedRetryAt = 0;
    }
    this.store.dropOtherModels(model);
    if (this.now() < this.embedRetryAt) return;
    if (this.embedModel !== model) {
      this.embedModel = model;
      this.embedFrom = 0;
    }
    while (this.now() < deadline) {
      const pending = this.store.pendingChunks(model, 32, this.embedFrom);
      if (!pending.length) {
        // At the end: one more look from the start (a passage that arrived with a lower id), then done.
        if (this.embedFrom === 0) return;
        this.embedFrom = 0;
        continue;
      }
      // What's embedded goes to the embedder's provider: scanned again first, as everything that leaves is.
      const texts = pending.map((c) => scrub(c.text, "passage").text.slice(0, 4000));
      try {
        const e = await this.embedWith(texts, "document");
        this.store.storeVectors(model, pending.map((c, i) => ({ chunk: c.id, entryRow: c.entryRow, vector: e.vectors[i]! })));
        this.embedFrom = pending.at(-1)!.id;
        this.embedderError = null;
        this.embedFailures = 0;
        this.embedderDims = e.dims;
        this.embedderLocal = e.local;
      } catch (error) {
        this.embedderError = String((error as Error).message ?? error).slice(0, 300);
        // Try again later: a minute, then twice as long each time it fails, up to half an hour.
        this.embedFailures++;
        this.embedRetryAt = this.now() + Math.min(30 * 60 * SECOND, 60 * SECOND * 2 ** (this.embedFailures - 1));
        return;
      }
    }
  }

  private linkSome(): void {
    const model = this.model();
    if (!model || !this.store.vectors(model)) return;
    const threshold = Number(this.store.setting("links.threshold") ?? LINK_THRESHOLD);
    for (const id of this.store.unlinked(model, 25)) this.store.linkSimilar(id, model, threshold);
  }

  // ---- Understanding ---------------------------------------------------------------

  /** Summaries a day: what you set, or (unset) a local default when the swift role is local, else none. */
  budget(): { perDay: number; set: boolean } {
    const raw = this.store.setting("understanding.perDay");
    if (raw !== null) return { perDay: Number(raw), set: true };
    return { perDay: LOCAL_DAILY, set: false };
  }

  setBudget(perDay: number): void {
    this.store.setSetting("understanding.perDay", String(Math.max(0, Math.floor(perDay))));
    this.understandRetryAt = 0;
  }

  private async understandSome(): Promise<void> {
    const { perDay, set } = this.budget();
    const left = perDay - this.store.usedToday();
    if (left <= 0 || this.now() < this.understandRetryAt) return;
    const batch = this.store.pendingUnderstanding(Math.min(4, left));
    if (!batch.length) return;
    let reply: { text: string; model: string } | null;
    try {
      // Unless you set a budget yourself, summaries are made only by a local model: nothing leaves.
      reply = await (this.o.summarise ?? ((p, s, cloud) => defaultSummarise(this.o.brain, p, s, cloud)))(understandingPrompt(batch), this.abort.signal, set);
    } catch (error) {
      this.understandError = String((error as Error).message ?? error).slice(0, 300);
      this.understandRetryAt = this.now() + 5 * 60 * SECOND;
      return;
    }
    if (!reply) {
      this.understandError = set ? "no swift model answered" : "waiting for a local swift model (or a budget you set: galahad archive budget <n>)";
      this.understandRetryAt = this.now() + 10 * 60 * SECOND;
      return;
    }
    this.store.use(batch.length);
    this.lastUnderstand = this.now();
    this.understandError = null;
    const understood = parseUnderstanding(reply.text, batch.map((b) => b.id));
    for (const entry of batch) {
      const u = understood.get(entry.id);
      if (!u) {
        const key = `understand\u0000${entry.id}`;
        const n = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, n);
        if (n >= 3) this.store.understandingSkipped(entry.id);
        continue;
      }
      this.store.understand(entry.id, {
        summary: u.summary,
        facts: u.facts,
        tags: u.tags,
        entities: u.entities,
        lessons: u.lessons ?? null,
        model: reply.model,
        at: this.now(),
      });
      const full = this.store.get(entry.id);
      const lesson = full ? lessonEntry(full, u.lessons, reply.model) : null;
      if (lesson) await this.ingest(lesson);
    }
  }

  // ---- Integrity -----------------------------------------------------------------

  private async integrityIfDue(): Promise<void> {
    const last = this.store.lastIntegrity().lastAt;
    if (last !== null && this.now() - last < DAY) return;
    await this.verify();
  }

  /** Re-hash every stored file; problems become a notice in your inbox (and clear when they're gone). */
  async verify(): Promise<{ checked: number; problems: string[] }> {
    const result = await this.store.verify({ yieldEvery: 50 });
    const key = `archive-integrity:${this.o.identity.id.slice(2, 14)}`;
    const findings = result.problems.length
      ? [
          {
            key,
            severity: "warn" as const,
            title: `The archive on ${this.o.nodeName} has ${result.problems.length === 1 ? "a damaged or missing file" : `${result.problems.length} damaged or missing files`}`,
            body: `${result.problems.slice(0, 6).join("\n")}${result.problems.length > 6 ? `\n… ${result.problems.length - 6} more` : ""}\nNothing was deleted. \`galahad archive verify\` checks again.`.slice(0, 2000),
            node: this.o.identity.id,
          },
        ]
      : [];
    try {
      reconcile(this.o.mind, this.o.identity, findings, this.now(), "archive");
    } catch (error) {
      this.o.log(`archive: integrity notice not written: ${(error as Error).message}`);
    }
    return result;
  }

  // ---- Search and retrieval ---------------------------------------------------------

  /** The query's vector, if an embedder is ready and the archive has its vectors (null: words only). */
  private async queryVector(q: string, timeoutMs: number): Promise<{ model: string; vector: Float32Array } | null> {
    const model = this.model();
    if (!model || !q.trim() || this.store.embeddedCount(model) === 0 || this.now() < this.embedRetryAt) return null;
    try {
      const e = await this.embedWith([scrub(q, "query").text.slice(0, 2000)], "query", timeoutMs);
      return { model, vector: e.vectors[0]! };
    } catch (error) {
      this.embedderError = String((error as Error).message ?? error).slice(0, 300);
      return null;
    }
  }

  async search(input: ArchiveFilters & { q?: string; limit?: number; offset?: number }, opts: { hideKinds?: string[] } = {}): Promise<ArchiveSearchView> {
    const started = performance.now();
    const { q = "", limit, offset, ...filters } = input;
    const query = await this.queryVector(q, 4000);
    const result = this.store.search(q, filters, { limit: limit ?? 10, offset: offset ?? 0, model: query?.model ?? null, query: query?.vector ?? null, hideKinds: opts.hideKinds ?? [] });
    return { ...result, embedder: this.model(), tookMs: Math.round(performance.now() - started) };
  }

  /**
   * What Galahad is given from the archive for a question: the most relevant entries
   * above a bar (by meaning: cosine similarity; by words: at least half the question's
   * terms), fenced as data. Null when nothing clears the bar.
   */
  async context(question: string, opts: { hideKinds?: string[]; limit?: number; nonce?: string } = {}): Promise<{ text: string; entries: { id: string; title: string; kind: string; trust: Trust }[] } | null> {
    if (!question.trim() || this.store.counts().entries === 0) return null;
    const query = await this.queryVector(question, 1500);
    const result = this.store.search(question, {}, { limit: 12, model: query?.model ?? null, query: query?.vector ?? null, hideKinds: opts.hideKinds ?? [] });
    const terms = queryTerms(question);
    const bar = terms.length <= 1 ? 1 : Math.max(2, Math.ceil(terms.length / 2));
    const threshold = Number(this.store.setting("retrieval.threshold") ?? RETRIEVAL_THRESHOLD);
    const relevant = result.hits.filter((h) => (h.similarity !== null && h.similarity >= threshold) || this.store.termsMatched(h, question) >= bar).slice(0, opts.limit ?? 5);
    const records: ContextRecord[] = relevant.map((hit) => ({ hit, text: hit.snippet }));
    return fence(records, opts.nonce);
  }

  // ---- Owner's actions -------------------------------------------------------------

  async delete(id: string, reason: string, by: string): Promise<{ deleted: string[]; blobs: number }> {
    return this.store.delete(id, reason, by);
  }

  /** Embed again (and optionally summarise again), in the background. */
  reindex(opts: { embeddings?: boolean; understanding?: boolean }): { backlog: number; understanding: number } {
    if (opts.embeddings ?? true) this.store.dropVectors();
    if (opts.understanding) this.store.forgetUnderstanding();
    this.embedRetryAt = 0;
    this.embedFailures = 0;
    this.embedFrom = 0;
    this.understandRetryAt = 0;
    void this.tick().catch(() => {});
    return { backlog: this.store.backlog(this.model()), understanding: this.store.understandingBacklog() };
  }

  status(): ArchiveStatusView {
    const model = this.model();
    const counts = this.store.counts();
    const { perDay, set } = this.budget();
    const embedded = this.store.embeddedCount(model);
    return {
      node: this.o.nodeName,
      entries: counts.entries,
      byKind: counts.byKind,
      deleted: counts.deleted,
      chunks: this.store.chunkCount(),
      embedded,
      backlog: model ? this.store.backlog(model) : 0,
      embedder: {
        model,
        state: !model ? "none" : this.embedderError ? "failing" : "ready",
        error: this.embedderError,
        dims: this.embedderDims ?? this.store.vectors(model ?? "")?.dims ?? null,
        local: this.embedderLocal ?? (model ? providerIsLocal(this.o.brain, model) : null),
      },
      understanding: {
        perDay,
        localOnly: !set,
        usedToday: this.store.usedToday(),
        backlog: this.store.understandingBacklog(),
        lastError: this.understandError,
        lastRun: this.lastUnderstand,
      },
      integrity: this.store.lastIntegrity(),
      disk: { blobBytes: counts.blobBytes, blobs: counts.blobs, indexBytes: this.store.indexBytes(), backend: this.store.blobs.name, root: this.store.blobs.where },
      sources: this.o.adapters.map((a) => {
        const c = this.store.cursor(a.name);
        return { name: a.name, cursor: c.cursor, lastRun: c.lastRun, lastError: c.lastError, pulled: c.pulled, waiting: !!a.waiting };
      }),
      paused: this.pausedNow,
    };
  }

  /** One entry by id (null: none, deleted, or hidden from this caller). */
  entry(id: string, opts: { hideKinds?: string[] } = {}) {
    return this.store.get(id, opts);
  }

  async file(id: string, path: string, opts: { hideKinds?: string[] } = {}) {
    return this.store.file(id, path, opts);
  }
}

function providerIsLocal(brain: BrainContext, ref: string): boolean | null {
  try {
    return resolveProvider(brain.store, brain.vault, parseRef(ref).provider)?.local ?? null;
  } catch {
    return null;
  }
}

/**
 * One summarising call to the swift role. Without a budget you set (allowCloud false),
 * only the role's local models are asked, so nothing in the archive leaves the machine;
 * with one, the role's models in order, as any swift call.
 */
export async function defaultSummarise(brain: BrainContext, prompt: string, signal: AbortSignal, allowCloud: boolean): Promise<{ text: string; model: string } | null> {
  let model: string | undefined;
  if (!allowCloud) {
    for (const ref of roleModels(brain.store, "swift")) {
      const { provider, model: name } = parseRef(ref);
      const resolved = resolveProvider(brain.store, brain.vault, provider);
      if (!resolved?.local) continue;
      if (name !== "*") {
        model = ref;
        break;
      }
      try {
        const first = (await listModels(resolved, brain.fetch)).find((m) => !isEmbeddingModel(m));
        if (first) {
          model = `${provider}/${first}`;
          break;
        }
      } catch {
        /* not running here */
      }
    }
    if (!model) return null;
  }
  let text = "";
  let used = model ?? "";
  for await (const event of chat(brain, { role: "swift", ...(model ? { model } : {}), messages: [{ role: "user", content: prompt }], signal: AbortSignal.any([signal, AbortSignal.timeout(180 * SECOND)]) })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "model") used = event.ref;
    else if (event.type === "error") throw new ArchiveError(502, event.error);
  }
  return text ? { text, model: used } : null;
}

export { archiveId };
