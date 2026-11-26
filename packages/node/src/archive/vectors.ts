/*
 * The archive's vectors. Each is unit length (cosine similarity is a dot product) and
 * kept as int8 with one scale per vector: a quarter of Float32's size, and a ranking
 * that agrees with Float32's on all but near-ties (scripts/bench-archive.ts measures
 * both). Search is a brute-force scan over every vector of the current model, held in
 * one contiguous array: at the archive's size that's simpler and faster than an
 * approximate index (see the benchmark for where it stops being fine).
 */

export interface Quantized {
  q: Int8Array;
  scale: number;
}

/** int8 with a per-vector scale: x ≈ q · scale. */
export function quantize(v: Float32Array): Quantized {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]!));
  const scale = max / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i]! / scale)));
  return { q, scale };
}

export function dequantize({ q, scale }: Quantized): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i]! * scale;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.sqrt(dot(a, a) * dot(b, b));
  return n ? dot(a, b) / n : 0;
}

/** Bytes as stored in SQLite: the int8 values. */
export const toBlob = (q: Int8Array): Uint8Array => new Uint8Array(q.buffer, q.byteOffset, q.byteLength).slice();
export const fromBlob = (blob: Uint8Array): Int8Array => new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength).slice();

/** Keep the k best (highest score) in a small sorted array: k is tens, so insertion is cheap. */
export class TopK {
  readonly ids: number[] = [];
  readonly scores: number[] = [];

  constructor(readonly k: number) {}

  get floor(): number {
    return this.ids.length < this.k ? Number.NEGATIVE_INFINITY : this.scores[this.scores.length - 1]!;
  }

  push(id: number, score: number): void {
    if (score <= this.floor) return;
    let i = this.scores.length;
    while (i > 0 && this.scores[i - 1]! < score) i--;
    this.ids.splice(i, 0, id);
    this.scores.splice(i, 0, score);
    if (this.ids.length > this.k) {
      this.ids.pop();
      this.scores.pop();
    }
  }
}

/**
 * Every vector of one model in memory: chunk ids, int8 values back to back, scales, and
 * which entry each chunk belongs to (so filters apply during the scan).
 */
export class VectorIndex {
  private q: Int8Array;
  private scales: Float32Array;
  private chunks: Int32Array;
  private entries: Int32Array;
  private count = 0;
  private readonly at = new Map<number, number>();

  constructor(
    readonly model: string,
    readonly dims: number,
    capacity = 1024,
  ) {
    this.q = new Int8Array(capacity * dims);
    this.scales = new Float32Array(capacity);
    this.chunks = new Int32Array(capacity);
    this.entries = new Int32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  private grow(): void {
    const capacity = this.chunks.length * 2;
    const q = new Int8Array(capacity * this.dims);
    q.set(this.q);
    this.q = q;
    const scales = new Float32Array(capacity);
    scales.set(this.scales);
    this.scales = scales;
    const chunks = new Int32Array(capacity);
    chunks.set(this.chunks);
    this.chunks = chunks;
    const entries = new Int32Array(capacity);
    entries.set(this.entries);
    this.entries = entries;
  }

  add(chunk: number, entry: number, v: Quantized): void {
    if (v.q.length !== this.dims) throw new Error(`a ${v.q.length}-dimensional vector in a ${this.dims}-dimensional index`);
    const existing = this.at.get(chunk);
    const slot = existing ?? this.count;
    if (existing === undefined) {
      if (this.count === this.chunks.length) this.grow();
      this.count++;
      this.at.set(chunk, slot);
    }
    this.q.set(v.q, slot * this.dims);
    this.scales[slot] = v.scale;
    this.chunks[slot] = chunk;
    this.entries[slot] = entry;
  }

  /** Drop every chunk of these entries (a deletion): the last slot moves into each gap. */
  removeEntries(entries: Set<number>): void {
    for (let slot = 0; slot < this.count; ) {
      if (!entries.has(this.entries[slot]!)) {
        slot++;
        continue;
      }
      const last = this.count - 1;
      this.at.delete(this.chunks[slot]!);
      if (slot !== last) {
        this.q.copyWithin(slot * this.dims, last * this.dims, (last + 1) * this.dims);
        this.scales[slot] = this.scales[last]!;
        this.chunks[slot] = this.chunks[last]!;
        this.entries[slot] = this.entries[last]!;
        this.at.set(this.chunks[slot]!, slot);
      }
      this.count--;
    }
  }

  /** Drop one passage's vector (a summary written again). */
  removeChunk(chunk: number): void {
    const slot = this.at.get(chunk);
    if (slot === undefined) return;
    const last = this.count - 1;
    this.at.delete(chunk);
    if (slot !== last) {
      this.q.copyWithin(slot * this.dims, last * this.dims, (last + 1) * this.dims);
      this.scales[slot] = this.scales[last]!;
      this.chunks[slot] = this.chunks[last]!;
      this.entries[slot] = this.entries[last]!;
      this.at.set(this.chunks[slot]!, slot);
    }
    this.count--;
  }

  has(chunk: number): boolean {
    return this.at.has(chunk);
  }

  /** The k chunks most similar to a unit query vector, among the entries `allow` lets through. */
  search(query: Float32Array, k: number, allow?: (entry: number) => boolean): { chunk: number; entry: number; similarity: number }[] {
    if (query.length !== this.dims) return [];
    // Quantize the query too: an int8 · int8 dot product, then both scales.
    const { q: qq, scale: qs } = quantize(query);
    const top = new TopK(k);
    const dims = this.dims;
    const data = this.q;
    for (let slot = 0; slot < this.count; slot++) {
      if (allow && !allow(this.entries[slot]!)) continue;
      let sum = 0;
      const base = slot * dims;
      for (let i = 0; i < dims; i++) sum += data[base + i]! * qq[i]!;
      top.push(slot, sum * this.scales[slot]! * qs);
    }
    return top.ids.map((slot, i) => ({ chunk: this.chunks[slot]!, entry: this.entries[slot]!, similarity: top.scores[i]! }));
  }

  /** One stored vector (for links between entries). */
  vector(chunk: number): Float32Array | null {
    const slot = this.at.get(chunk);
    if (slot === undefined) return null;
    return dequantize({ q: this.q.subarray(slot * this.dims, (slot + 1) * this.dims), scale: this.scales[slot]! });
  }
}
