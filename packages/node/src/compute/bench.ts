import { closeSync, fsyncSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

/*
 * The calibration benchmark, as its own short-lived process (and, for the many-thread
 * part, its own worker threads): `bun bench.ts '<json options>'` prints one JSON line.
 *
 * It lowers its own priority before it does anything, so the few seconds it runs give
 * way to whatever else the machine is doing; the node that started it is untouched. It
 * measures only this machine: one thread, then as many at once as it is told (never
 * more than the ceiling), memory copied, a file written and read back in the node's
 * home. Nothing leaves the machine and nothing is installed.
 */

export interface BenchOptions {
  /** Threads for the many-at-once part. */
  threads: number;
  /** How long each CPU part runs (ms). */
  windowMs: number;
  /** Where the disk part writes its file (the node's home); absent: no disk part. */
  dir?: string;
}

export interface BenchResult {
  single: number;
  multi: number;
  threads: number;
  memoryGbps?: number;
  disk?: { writeMbps: number; readMbps: number };
}

/** What the kernel works on: a table of words bigger than a first-level cache, a buffer of reals that fits in one. */
interface KernelState {
  words: Int32Array;
  reals: Float64Array;
  x: number;
  h: number;
  acc: number;
}

function kernelState(): KernelState {
  const words = new Int32Array(65536);
  let s = 0x2545f491 | 0;
  for (let i = 0; i < words.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    words[i] = s;
  }
  const reals = new Float64Array(2048);
  for (let i = 0; i < reals.length; i++) reals[i] = i * 0.5;
  return { words, reals, x: 0x9e3779b9 | 0, h: 0, acc: 0 };
}

/** Integer work: hashing, lookups all over the table, a branch that depends on what was read. */
function integers(s: KernelState): void {
  const words = s.words;
  let x = s.x;
  let h = s.h;
  for (let i = 0; i < 2048; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = words[(x >>> 0) & 65535]!;
    if (((w ^ x) & 7) === 0) h = (Math.imul(h ^ w, 0x01000193) + i) | 0;
    else h = (h + (w >>> 3)) | 0;
    words[(h >>> 0) & 65535] = h ^ x;
  }
  s.x = x;
  s.h = h;
}

/** Floating-point work: multiply, add, square root and floor over the buffer, each element on its own. */
function reals(s: KernelState): void {
  const r = s.reals;
  let acc = s.acc;
  for (let i = 0; i < 2048; i++) {
    const v = r[i]! * 1.0000001 + Math.sqrt(r[(i * 7 + 1) & 2047]! + 1);
    acc += v;
    r[i] = v - Math.floor(v * 0.015625) * 64;
  }
  s.acc = acc - Math.floor(acc * 0.0009765625) * 1024;
}

/**
 * The kernel (version KERNEL in packages/core/src/compute.ts): blocks of a fixed mix of integer and
 * floating-point work. Returns how many blocks it did a second, over about `ms`; its score on one thread of
 * the reference machine is REFERENCE_SINGLE there.
 *
 * Only operations the engine compiles in place and that are exact everywhere, and nothing that grows as it
 * runs: so the score is the machine's, the same under any OS and over any window. (The first kernel took a
 * remainder of doubles, which is a call into the C library, as slow as that library is.)
 */
export function kernel(ms: number): number {
  const state = kernelState();
  let blocks = 0;
  const started = performance.now();
  const end = started + ms;
  do {
    integers(state);
    reals(state);
    blocks++;
  } while (performance.now() < end);
  return blocks / ((performance.now() - started) / 1000);
}

/**
 * The kernel's state after `blocks` blocks, in eight hex digits: one value on every machine and OS. A test
 * holds it, so the kernel can't change without KERNEL and REFERENCE_SINGLE changing with it.
 */
export function kernelDigest(blocks = 64): string {
  const state = kernelState();
  for (let b = 0; b < blocks; b++) {
    integers(state);
    reals(state);
  }
  let d = 0x811c9dc5 | 0;
  for (const w of state.words) d = Math.imul(d ^ w, 0x01000193);
  for (const w of new Int32Array(state.reals.buffer)) d = Math.imul(d ^ w, 0x01000193);
  for (const w of new Int32Array(new Float64Array([state.acc]).buffer)) d = Math.imul(d ^ w, 0x01000193);
  d = Math.imul(d ^ state.x, 0x01000193);
  d = Math.imul(d ^ state.h, 0x01000193);
  return (d >>> 0).toString(16).padStart(8, "0");
}

/** Memory copied, GB a second (64 MB back and forth for about `ms`). */
function memory(ms: number): number {
  const size = 64 * 2 ** 20;
  const a = new Uint8Array(size).fill(1);
  const b = new Uint8Array(size);
  const started = performance.now();
  let copied = 0;
  do {
    b.set(a);
    a.set(b);
    copied += 2 * size;
  } while (performance.now() - started < ms);
  return copied / 2 ** 30 / ((performance.now() - started) / 1000);
}

/** A 32 MB file written (and synced) then read back, MB a second; undefined when the directory can't be written. */
function disk(dir: string): BenchResult["disk"] {
  const path = join(dir, `calibration-${process.pid}.tmp`);
  const chunk = new Uint8Array(2 ** 20).fill(7);
  const mb = 32;
  try {
    mkdirSync(dir, { recursive: true });
    let started = performance.now();
    let fd = openSync(path, "w", 0o600);
    for (let i = 0; i < mb; i++) writeSync(fd, chunk);
    fsyncSync(fd);
    closeSync(fd);
    const writeMbps = mb / ((performance.now() - started) / 1000);
    started = performance.now();
    fd = openSync(path, "r");
    while (readSync(fd, chunk) > 0);
    closeSync(fd);
    const readMbps = mb / ((performance.now() - started) / 1000);
    return { writeMbps: Math.round(writeMbps), readMbps: Math.round(readMbps) };
  } catch {
    return undefined;
  } finally {
    rmSync(path, { force: true });
  }
}

/** `threads` workers running the kernel over the same window, started together: the sum of their scores. */
async function many(threads: number, windowMs: number): Promise<number> {
  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url)));
  /** A worker's next message (it says "ready", then its score). */
  const next = <T>(w: Worker): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      w.once("message", (value: T) => resolve(value));
      w.once("error", reject);
    });
  try {
    await Promise.all(workers.map((w) => next<string>(w)));
    const scores = await Promise.all(
      workers.map((w) => {
        const score = next<number>(w);
        w.postMessage(windowMs);
        return score;
      }),
    );
    return scores.reduce((sum, s) => sum + s, 0);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

export async function bench(options: BenchOptions): Promise<BenchResult> {
  // Warm the kernel up (the first run is compiled as it goes), then measure.
  kernel(Math.min(60, options.windowMs / 4));
  // The best of three: whatever else ran just then, or a core still coming up to speed, only ever lowers a score.
  const single = Math.max(kernel(options.windowMs), kernel(options.windowMs), kernel(options.windowMs));
  const threads = Math.max(1, Math.floor(options.threads));
  let multi = single;
  let used = 1;
  if (threads > 1) {
    try {
      multi = await many(threads, options.windowMs * 2);
      used = threads;
    } catch {
      /* no worker threads here: one thread is what was measured */
    }
  }
  return { single, multi: Math.max(multi, single * 0.5), threads: used, memoryGbps: Math.round(memory(250) * 10) / 10, ...(options.dir ? { disk: disk(options.dir) } : {}) };
}

if (!isMainThread) {
  // A worker of the many-thread part: say it's ready, run the kernel when told, report.
  parentPort!.once("message", (windowMs: number) => parentPort!.postMessage(kernel(windowMs)));
  parentPort!.postMessage("ready");
} else if (import.meta.main) {
  // Give way to everything else on the machine before doing any work.
  try {
    os.setPriority(os.constants.priority.PRIORITY_LOW);
  } catch {
    /* not allowed here: it runs at the priority it has */
  }
  const options = JSON.parse(process.argv[2] ?? "{}") as BenchOptions;
  const result = await bench({ threads: Number(options.threads) || 1, windowMs: Math.min(5_000, Math.max(20, Number(options.windowMs) || 400)), ...(typeof options.dir === "string" ? { dir: options.dir } : {}) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
