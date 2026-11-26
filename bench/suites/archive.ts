import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskBackend } from "../../packages/node/src/archive/blobs.ts";
import { ArchiveStore } from "../../packages/node/src/archive/store.ts";
import { TopK } from "../../packages/node/src/archive/vectors.ts";
import { rng, subSeed, type Suite, type SuiteContext } from "../lib.ts";

/*
 * The archive: does a search find what it should, and what does it cost? A
 * labelled, seeded set (after scripts/bench-archive.ts, which times the index at
 * 1k to 100k passages): entries drawn from topics, each topic with its own words
 * and its own direction in vector space. So that neither words nor meaning can
 * do it alone, every topic has two others that are easily taken for it, in two
 * different ways: a sibling that shares half its words (a question asked in those
 * words can't tell the two apart), and a neighbour that lies close to it in
 * vector space (a question's vector lands between them). A question names its
 * topic in three of the shared words and a vector near it; what's relevant is
 * that topic's entries, and nothing else. Words alone should find about half,
 * meaning alone most, and the two fused nearly all: that is what fusing is for.
 *
 * Quality is exact for the seed: no model is called, the vectors are made here.
 */

const DIMS = 384;
const TOPICS = 60;
const WORDS = 12;
/** Passages (of about a thousand characters) an entry: two. */
const PER_ENTRY = 2;
const COMMON = "the a of and to in is for on with that by this from at as it be are was".split(" ");

/**
 * Near enough a normal deviate (twelve uniforms added: mean 0, variance 1), by additions alone: a logarithm or a
 * cosine differs in its last bit from one platform's maths library to the next, and these vectors must be the
 * same bytes everywhere for the answers to be.
 */
const gauss = (r: () => number): number => {
  let sum = -6;
  for (let i = 0; i < 12; i++) sum += r();
  return sum;
};
function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

interface World {
  /** Each topic's words: the first half its own, the second half shared with its sibling (topic ^ 1). */
  words: string[][];
  /** Each topic's direction: mostly one it shares with its neighbour (topic ^ 2), a little its own. */
  centroids: Float32Array[];
}

function world(seed: number): World {
  const r = rng(subSeed(seed, "archive-topics"));
  const words = Array.from({ length: TOPICS }, (_, t) => {
    const pair = t >> 1;
    return [...Array.from({ length: WORDS / 2 }, (_, w) => `own${t}x${w}`), ...Array.from({ length: WORDS / 2 }, (_, w) => `pair${pair}x${w}`)];
  });
  const direction = (): Float32Array => unit(Float32Array.from({ length: DIMS }, () => gauss(r)));
  // Topics in fours: 4g and 4g+2 share one direction, 4g+1 and 4g+3 another (so a topic's sibling in words is never its neighbour in meaning).
  const shared = Array.from({ length: TOPICS / 2 }, direction);
  const centroids = Array.from({ length: TOPICS }, (_, t) => {
    const own = direction();
    const with_ = shared[(t >> 2) * 2 + (t & 1)]!;
    return unit(Float32Array.from(with_, (x, i) => x + 0.5 * own[i]!));
  });
  return { words, centroids };
}

function passage(r: () => number, w: World, topic: number): string {
  const out: string[] = [];
  for (let i = 0; i < 160; i++) out.push(r() < 0.2 ? w.words[topic]![Math.floor(r() * WORDS)]! : COMMON[Math.floor(r() * COMMON.length)]!);
  return out.join(" ");
}
const near = (r: () => number, c: Float32Array, noise: number): Float32Array => unit(Float32Array.from(c, (x) => x + (noise / Math.sqrt(DIMS)) * gauss(r)));

interface Built {
  store: ArchiveStore;
  dir: string;
  /** Each entry's topic, by its archive id; and each passage's, by its chunk id. */
  topicOf: Map<string, number>;
  chunkTopic: Map<number, number>;
  chunkEntry: Map<number, string>;
  reference: Float32Array;
  ids: number[];
  passages: number;
  perTopic: number;
  ingestMs: number;
  vectorsMs: number;
  spans: { ingest: [number, number]; vectors: [number, number] };
}

async function build(seed: number, w: World, entries: number): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), "galahad-bench-archive-"));
  const store = new ArchiveStore(join(dir, "archive.db"), new LocalDiskBackend(join(dir, "blobs")));
  const r = rng(subSeed(seed, `archive-${entries}`));
  const topicOf = new Map<string, number>();
  const byRow: number[] = [];
  let t0 = performance.now();
  for (let e = 0; e < entries; e++) {
    const topic = e % TOPICS;
    const { id } = await store.ingest({ kind: e % 3 ? "teaching" : "idea", source: "bench", sourceId: String(e), title: `Entry ${e}`, description: Array.from({ length: PER_ENTRY }, () => passage(r, w, topic)).join("\n\n"), trust: "agent", createdAt: 1_700_000_000_000 + e });
    topicOf.set(id, topic);
    byRow.push(topic);
  }
  const ingest: [number, number] = [t0, performance.now()];
  const passages = store.chunkCount();
  const reference = new Float32Array(passages * DIMS);
  const ids: number[] = [];
  const chunkTopic = new Map<number, number>();
  const chunkEntry = new Map<number, string>();
  t0 = performance.now();
  for (let after = 0; ; ) {
    const pending = store.pendingChunks("bench", 512, after);
    if (!pending.length) break;
    after = pending.at(-1)!.id;
    for (let i = 0; i < pending.length; i += 32) {
      store.storeVectors(
        "bench",
        pending.slice(i, i + 32).map((c) => {
          const topic = byRow[c.entryRow - 1]!;
          const v = near(r, w.centroids[topic]!, 1.0);
          reference.set(v, ids.length * DIMS);
          ids.push(c.id);
          chunkTopic.set(c.id, topic);
          chunkEntry.set(c.id, c.entry);
          return { chunk: c.id, entryRow: c.entryRow, vector: v };
        }),
      );
    }
  }
  const vectors: [number, number] = [t0, performance.now()];
  return { store, dir, topicOf, chunkTopic, chunkEntry, reference, ids, passages, perTopic: Math.floor(entries / TOPICS), ingestMs: ingest[1] - ingest[0], vectorsMs: vectors[1] - vectors[0], spans: { ingest, vectors } };
}

interface Query {
  topic: number;
  text: string;
  vector: Float32Array;
}

/** Forty questions: three of the words a topic shares with its sibling, in a sentence; and a vector near the topic. */
function queries(seed: number, w: World): Query[] {
  const r = rng(subSeed(seed, "archive-queries"));
  return Array.from({ length: 40 }, (_, i) => {
    const topic = (i * 7) % TOPICS;
    const words = w.words[topic]!;
    const shared = Array.from({ length: 3 }, () => words[WORDS / 2 + Math.floor(r() * (WORDS / 2))]!);
    return { topic, text: `${shared.join(" ")} what about it`, vector: near(r, w.centroids[topic]!, 1.6) };
  });
}

/** Of the first ten entries found: the share of what's relevant that's among them, and one over the place of the first that is. */
function judge(found: readonly string[], b: Built, topic: number): { recall: number; rr: number } {
  const top = found.slice(0, 10);
  const hits = top.filter((id) => b.topicOf.get(id) === topic).length;
  const first = top.findIndex((id) => b.topicOf.get(id) === topic);
  return { recall: hits / Math.min(10, b.perTopic), rr: first < 0 ? 0 : 1 / (first + 1) };
}

function quality(ctx: SuiteContext, w: World, b: Built): void {
  {
    const index = b.store.vectors("bench")!;
    const qs = queries(ctx.seed, w);
    const sums = { words: { recall: 0, rr: 0 }, meaning: { recall: 0, rr: 0 }, both: { recall: 0, rr: 0 } };
    let agree = 0;
    for (const q of qs) {
      const byWords = b.store.search(q.text, {}, { limit: 10 }).hits.map((h) => h.id);
      // By meaning alone: the nearest passages, each entry once, in the order found.
      const byMeaning = [...new Set(index.search(q.vector, 40).map((f) => b.chunkEntry.get(f.chunk)!))];
      const byBoth = b.store.search(q.text, {}, { limit: 10, model: "bench", query: q.vector }).hits.map((h) => h.id);
      for (const [name, found] of [["words", byWords], ["meaning", byMeaning], ["both", byBoth]] as const) {
        const j = judge(found, b, q.topic);
        sums[name].recall += j.recall;
        sums[name].rr += j.rr;
      }
      // The int8 scan against the same scan in Float32: do they find the same ten passages?
      const top = new TopK(10);
      for (let i = 0; i < b.ids.length; i++) {
        let dot = 0;
        const at = i * DIMS;
        for (let d = 0; d < DIMS; d++) dot += b.reference[at + d]! * q.vector[d]!;
        top.push(b.ids[i]!, dot);
      }
      const truth = new Set(top.ids);
      agree += index.search(q.vector, 10).filter((f) => truth.has(f.chunk)).length;
    }
    const n = qs.length;
    const about = `${n} questions over ${b.passages} passages (${TOPICS} topics, ${b.perTopic} entries each)`;
    ctx.quality("archive.words.recall-at-10", sums.words.recall / n, "", "higher", { n, note: `by words alone: the share of a topic's entries among the first ten; ${about}` });
    ctx.quality("archive.words.mrr", sums.words.rr / n, "", "higher", { n, note: "one over the place of the first relevant entry, averaged" });
    ctx.quality("archive.meaning.recall-at-10", sums.meaning.recall / n, "", "higher", { n, note: "by meaning alone (the int8 scan)" });
    ctx.quality("archive.meaning.mrr", sums.meaning.rr / n, "", "higher", { n });
    ctx.quality("archive.both.recall-at-10", sums.both.recall / n, "", "higher", { n, note: "words and meaning fused, as a search with an embedder does" });
    ctx.quality("archive.both.mrr", sums.both.rr / n, "", "higher", { n });
    ctx.quality("archive.int8-top-10-agreement", agree / (n * 10), "", "higher", { note: "of the ten nearest passages by the int8 scan, the share that are the Float32 scan's ten" });
  }
}

/** One archive of `entries` entries: timed; and, with ten entries a topic (everything relevant fits in the first ten), asked its questions. */
async function measure(ctx: SuiteContext, w: World, entries: number, full: boolean): Promise<void> {
  const b = await build(ctx.seed, w, entries);
  const id = `${full ? "full." : ""}archive.n${b.passages}`;
  try {
    if (b.perTopic === 10) quality(ctx, w, b);
    ctx.speed(`${id}.ingest`, [b.ingestMs / b.passages], "ms", "lower", b.spans.ingest, "a passage scrubbed, chunked and indexed for words");
    ctx.speed(`${id}.store-vector`, [b.vectorsMs / b.passages], "ms", "lower", b.spans.vectors, "a passage's vector quantised to int8 and stored");
    const index = b.store.vectors("bench")!;
    const qs = queries(ctx.seed, w);
    let k = 0;
    const next = (): Query => qs[k++ % qs.length]!;
    ctx.time(`${id}.search-words`, () => b.store.search(next().text, {}, { limit: 10 }), { n: 15, warm: 3 });
    ctx.time(`${id}.search-meaning`, () => index.search(next().vector, 10), { n: 15, warm: 3, note: "the int8 scan over every passage" });
    ctx.time(`${id}.search-both`, () => {
      const q = next();
      b.store.search(q.text, {}, { limit: 10, model: "bench", query: q.vector });
    }, { n: 15, warm: 3 });
  } finally {
    b.store.close();
    rmSync(b.dir, { recursive: true, force: true });
  }
}

export const suite: Suite = {
  name: "archive",
  about: "the archive's search on a labelled set: does it find what it should by words, by meaning and by both, and at what cost?",
  headline: ["archive.words.recall-at-10", "archive.meaning.recall-at-10", "archive.both.recall-at-10", "archive.words.mrr", "archive.meaning.mrr", "archive.both.mrr", "archive.int8-top-10-agreement", "archive.n1200.search-both", "archive.n4800.search-both", "archive.n4800.ingest"],
  async run(ctx) {
    const w = world(ctx.seed);
    await measure(ctx, w, TOPICS * 10, false);
    ctx.log("the labelled set: asked by words, by meaning and by both");
    await measure(ctx, w, TOPICS * 40, false);
    if (ctx.full) for (const entries of [TOPICS * 160, TOPICS * 640]) await measure(ctx, w, entries, true);
  },
};
