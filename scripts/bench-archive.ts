// The archive's index at 1k, 10k and 100k passages: ingest (scrub, chunk, FTS5), storing
// vectors, and search by words, by meaning (the int8 brute-force scan) and both fused;
// plus how often int8 finds the same top 10 as Float32 would.
//
//   bun scripts/bench-archive.ts [--sizes 1000,10000,100000] [--dims 1024]
//
// Synthetic and deterministic: passages drawn from 200 topics (each topic its own words
// and its own direction in vector space, with noise), so search has right answers and
// near neighbours compete the way real ones do. Runs in a temporary directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LocalDiskBackend } from "../packages/node/src/archive/blobs.ts";
import { ArchiveStore } from "../packages/node/src/archive/store.ts";
import { TopK } from "../packages/node/src/archive/vectors.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { sizes: { type: "string" }, dims: { type: "string" } } });
const SIZES = (values.sizes ?? "1000,10000,100000").split(",").map(Number);
const DIMS = Number(values.dims ?? 1024);
const TOPICS = 200;
const PER_ENTRY = 4;

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

const r0 = rng(42);
const centroids = Array.from({ length: TOPICS }, () => unit(Float32Array.from({ length: DIMS }, () => gauss(r0))));
const COMMON = "the a of and to in is for on with that by this from at as it be are was".split(" ");
const topicWords = Array.from({ length: TOPICS }, (_, t) => Array.from({ length: 12 }, (_, w) => `t${t}w${w}${String.fromCharCode(97 + ((t * 7 + w) % 26))}`));

function passage(r: () => number, topic: number): string {
  const words: string[] = [];
  for (let i = 0; i < 160; i++) words.push(r() < 0.25 ? topicWords[topic]![Math.floor(r() * 12)]! : COMMON[Math.floor(r() * COMMON.length)]!);
  return words.join(" ");
}
function vectorNear(r: () => number, topic: number, noise = 0.9): Float32Array {
  const c = centroids[topic]!;
  return unit(Float32Array.from({ length: DIMS }, (_, i) => c[i]! + (noise / Math.sqrt(DIMS)) * gauss(r) * Math.sqrt(DIMS) * 0.05));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;
const ms = (x: number) => (x < 10 ? x.toFixed(2) : x.toFixed(0));

interface Row {
  chunks: number;
  ingestS: number;
  ingestPerChunkMs: number;
  vectorsS: number;
  loadMs: number;
  textMs: [number, number];
  meaningMs: [number, number];
  hybridMs: [number, number];
  float32Ms: number;
  recall: number;
  topic8: number;
  topic32: number;
  indexMb: number;
  dbMb: number;
}

async function bench(target: number): Promise<Row> {
  const dir = mkdtempSync(join(tmpdir(), "galahad-bench-archive-"));
  const store = new ArchiveStore(join(dir, "archive.db"), new LocalDiskBackend(join(dir, "blobs")));
  const r = rng(target);
  const entries = Math.ceil(target / PER_ENTRY);
  const topicOf: number[] = [];
  let t = performance.now();
  for (let e = 0; e < entries; e++) {
    const topic = Math.floor(r() * TOPICS);
    topicOf.push(topic);
    // Four paragraphs of about 1,000 characters: four passages.
    const description = Array.from({ length: PER_ENTRY }, () => passage(r, topic)).join("\n\n");
    await store.ingest({ kind: e % 3 ? "teaching" : "idea", source: "bench", sourceId: String(e), title: `Entry ${e} on ${topicWords[topic]![0]}`, description, trust: "agent", createdAt: 1_700_000_000_000 + e });
  }
  const ingestS = (performance.now() - t) / 1000;
  const chunks = store.chunkCount();

  // Vectors: what the embedder would return, stored a batch of 32 at a time as the service does.
  const reference = new Float32Array(chunks * DIMS);
  const ids: number[] = [];
  const chunkTopic = new Map<number, number>();
  t = performance.now();
  let after = 0;
  for (;;) {
    const pending = store.pendingChunks("bench", 512, after);
    if (!pending.length) break;
    after = pending.at(-1)!.id;
    for (let i = 0; i < pending.length; i += 32) {
      const batch = pending.slice(i, i + 32).map((c) => {
        const topic = topicOf[c.entryRow - 1]!;
        const v = vectorNear(r, topic);
        reference.set(v, ids.length * DIMS);
        ids.push(c.id);
        chunkTopic.set(c.id, topic);
        return { chunk: c.id, entryRow: c.entryRow, vector: v };
      });
      store.storeVectors("bench", batch);
    }
  }
  const vectorsS = (performance.now() - t) / 1000;

  // Loading every vector into memory (once per process, or after a model change).
  t = performance.now();
  const index = store.vectors("bench")!;
  const loadMs = performance.now() - t;

  const queries = Array.from({ length: 40 }, (_, i) => {
    const topic = (i * 37) % TOPICS;
    return { topic, text: `${topicWords[topic]![1]} ${topicWords[topic]![4]} what about it`, vector: vectorNear(r, topic, 0.6) };
  });
  const text: number[] = [];
  const meaning: number[] = [];
  const hybrid: number[] = [];
  let agree = 0;
  let float32 = 0;
  let onTopic8 = 0;
  let onTopic32 = 0;
  for (const q of queries) {
    let s = performance.now();
    store.search(q.text, {}, { limit: 10 });
    text.push(performance.now() - s);
    s = performance.now();
    const found = index.search(q.vector, 10);
    meaning.push(performance.now() - s);
    s = performance.now();
    store.search(q.text, {}, { limit: 10, model: "bench", query: q.vector });
    hybrid.push(performance.now() - s);
    // Float32 brute force with the same top-k, for the reference ranking (and its cost).
    s = performance.now();
    const top = new TopK(10);
    for (let i = 0; i < ids.length; i++) {
      let dot = 0;
      const base = i * DIMS;
      for (let d = 0; d < DIMS; d++) dot += reference[base + d]! * q.vector[d]!;
      top.push(ids[i]!, dot);
    }
    float32 += performance.now() - s;
    const truth = new Set(top.ids);
    agree += found.filter((f) => truth.has(f.chunk)).length;
    onTopic8 += found.filter((f) => chunkTopic.get(f.chunk) === q.topic).length;
    onTopic32 += top.ids.filter((id) => chunkTopic.get(id) === q.topic).length;
  }
  const row: Row = {
    chunks,
    ingestS,
    ingestPerChunkMs: (ingestS * 1000) / chunks,
    vectorsS,
    loadMs,
    textMs: [median(text), p95(text)],
    meaningMs: [median(meaning), p95(meaning)],
    hybridMs: [median(hybrid), p95(hybrid)],
    float32Ms: float32 / queries.length,
    recall: agree / (queries.length * 10),
    topic8: onTopic8 / (queries.length * 10),
    topic32: onTopic32 / (queries.length * 10),
    indexMb: (index.size * (DIMS + 12)) / 2 ** 20,
    dbMb: store.indexBytes() / 2 ** 20,
  };
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return row;
}

console.log(`archive benchmark · ${DIMS} dims · Bun ${Bun.version} · ${process.platform}/${process.arch}`);
const rows: Row[] = [];
for (const size of SIZES) {
  const row = await bench(size);
  rows.push(row);
  console.log(`  ${row.chunks} passages done`);
}
console.log("\n| passages | ingest (s) | per passage (ms) | store vectors (s) | load index (ms) | words p50/p95 (ms) | meaning p50/p95 (ms) | hybrid p50/p95 (ms) | Float32 scan (ms) | int8 top-10 = Float32's | on-topic in top 10, int8 / Float32 | vectors in memory (MB) | archive.db (MB) |");
console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(
    `| ${r.chunks.toLocaleString("en")} | ${r.ingestS.toFixed(1)} | ${r.ingestPerChunkMs.toFixed(2)} | ${r.vectorsS.toFixed(1)} | ${ms(r.loadMs)} | ${ms(r.textMs[0])} / ${ms(r.textMs[1])} | ${ms(r.meaningMs[0])} / ${ms(r.meaningMs[1])} | ${ms(r.hybridMs[0])} / ${ms(r.hybridMs[1])} | ${ms(r.float32Ms)} | ${(r.recall * 100).toFixed(1)} % | ${(r.topic8 * 100).toFixed(1)} % / ${(r.topic32 * 100).toFixed(1)} % | ${r.indexMb.toFixed(1)} | ${r.dbMb.toFixed(0)} |`,
  );
}
