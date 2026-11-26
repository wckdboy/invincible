import type { ScoreMetric } from "../packages/core/src/scorecard.ts";
import { kernel } from "../packages/node/src/compute/bench.ts";

/*
 * What every suite uses: a seeded random source, timing that holds up on a busy
 * machine, and the two ways a number enters a scorecard (docs/BENCHMARKS.md).
 */

/** The seed of a run unless `--seed` says otherwise. */
export const DEFAULT_SEED = 20_261_112;

/** A small deterministic PRNG (mulberry32): the same seed, the same stream, on every machine. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed of its own for one part of a suite, so adding a draw in one place never shifts another's inputs. */
export function subSeed(seed: number, label: string): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

export const intBelow = (random: () => number, n: number): number => Math.floor(random() * n);
export const pick = <T>(random: () => number, list: readonly T[]): T => list[intBelow(random, list.length)]!;

/** Fisher–Yates, in place. */
export function shuffle<T>(random: () => number, list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = intBelow(random, i + 1);
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export interface Summary {
  median: number;
  /** The interquartile range: where the middle half of the samples lie. */
  iqr: number;
  min: number;
  n: number;
}

export function summarise(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), iqr: quantile(sorted, 0.75) - quantile(sorted, 0.25), min: sorted[0] ?? Number.NaN, n: sorted.length };
}

/** To `digits` significant digits: a scorecard says what was measured, not the noise below it. */
export function sig(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scale = 10 ** (digits - 1 - Math.floor(Math.log10(Math.abs(value))));
  return Math.round(value * scale) / scale;
}

export interface TimeOptions {
  /** Samples kept (default 9). */
  n?: number;
  /** Calls before the first sample, so compilation and caches aren't measured (default 2). */
  warm?: number;
  /** Calls a sample (default 1): a sample is their mean, for work too short to time once. */
  batch?: number;
  /** Items a call handles (default 1): the metric is milliseconds an item. */
  per?: number;
  /** Run before each sample, untimed. */
  before?: () => void;
  note?: string;
}

/**
 * How fast this machine is at each moment of a suite: the calibration kernel (the one a node measures itself
 * with, packages/node/src/compute/bench.ts), on one thread, in windows of a few milliseconds.
 *
 * A node calibrating itself takes the best of three windows once, to learn what the machine can do. A benchmark
 * needs something else: what the machine was doing while each timing was taken. This machine is busy with other
 * work at times, in bursts of seconds, and a timing taken in a burst is slower by about as much as the kernel
 * is just then. So a window is taken beside every sample, each sample is brought to the suite's own pace by the
 * windows either side of it, and the suite's calibration is the median of all its windows. (Measured before
 * settling on this: with one reading before a forty-second suite, the same code read 31 % to 51 % "faster"
 * than itself; with one median for the whole suite, a burst in its last seconds read as a regression.)
 */
export class Pace {
  private readonly windows: { at: number; score: number }[] = [];

  constructor() {
    kernel(60); // compiled before the first window counts
    for (let i = 0; i < 3; i++) this.window(80);
  }

  /** One window, now: the kernel's score over `ms`. */
  window(ms = 6): number {
    const score = kernel(ms);
    this.windows.push({ at: performance.now() - ms / 2, score });
    return score;
  }

  /** One window if there hasn't been one for a while: for wherever a suite pauses. */
  pulse(): void {
    const last = this.windows.at(-1);
    if (!last || performance.now() - last.at >= 200) this.window(8);
  }

  /** The suite's calibration: the median of all its windows. */
  calibration(): number {
    return Math.round(summarise(this.windows.map((w) => w.score)).median);
  }

  /**
   * The machine's pace over a stretch of time (performance.now(), from and to): the median of the windows in
   * it and of the nearest on either side, and how much they scatter (interquartile range over median; with
   * fewer than four, their whole range).
   */
  around(from: number, to: number): { score: number; jitter: number } {
    const inside = this.windows.filter((w) => w.at >= from && w.at <= to);
    const before = this.windows.filter((w) => w.at < from).at(-1);
    const after = this.windows.find((w) => w.at > to);
    const scores = [...(before ? [before.score] : []), ...inside.map((w) => w.score), ...(after ? [after.score] : [])];
    const s = summarise(scores);
    const range = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
    return { score: s.median, jitter: s.median > 0 ? (scores.length >= 4 ? s.iqr : range) / s.median : 0 };
  }
}

export interface SuiteContext {
  seed: number;
  /** `--full`: the long sizes too. Their metrics' ids start "full.". */
  full: boolean;
  /**
   * An exact, deterministic number. `resolution`: differences below it aren't a change (for a value that passes
   * through the machine's own sine and cosine, whose last digit differs between platforms).
   */
  quality(id: string, value: number, unit: string, better: "higher" | "lower", extra?: { note?: string; resolution?: number; n?: number }): void;
  /**
   * Time `fn`: milliseconds a call (an item, with `per`), `n` samples after warming up. Recorded as their median
   * with their interquartile range, each sample brought to the suite's pace by the kernel windows either side.
   * Nothing is retried or dropped. Returns the samples as measured.
   */
  time(id: string, fn: () => unknown, options?: TimeOptions): number[];
  timeAsync(id: string, fn: () => Promise<unknown>, options?: Omit<TimeOptions, "batch">): Promise<number[]>;
  /**
   * Samples timed elsewhere (milliseconds, or a rate): recorded as their median and interquartile range, brought
   * to the suite's pace by the windows taken over `span` (performance.now(), from and to: when they were taken).
   */
  speed(id: string, samples: readonly number[], unit: string, better: "higher" | "lower", span: readonly [number, number], note?: string): void;
  /** A kernel window if there hasn't been one for a while: call it in the gaps of long work that is timed elsewhere. */
  pulse(): void;
  /** A line of progress (stderr), for whoever watches a run. */
  log(line: string): void;
}

export interface Suite {
  name: string;
  /** One line: what it measures. */
  about: string;
  /** The metrics a reader should see first, in order. */
  headline: readonly string[];
  run(ctx: SuiteContext): Promise<void> | void;
}

/** A speed metric until the suite ends: its samples, and the pace they were taken at. */
interface Timed {
  metric: ScoreMetric;
  /** As measured. */
  samples: readonly number[];
  /** Each sample times the kernel's score beside it (time): the suite's calibration divides it out at the end. */
  paced?: number[];
  /** Or when they were taken (speed). */
  span?: readonly [number, number];
}

/**
 * Collects one suite's metrics. With a `pace`, timings are brought to the suite's own calibration when it
 * `finish`es (see Pace); without one (tests of a suite's logic) they are recorded as measured.
 */
export function collector(seed: number, full: boolean, log: (line: string) => void, pace?: Pace): { ctx: SuiteContext; metrics: ScoreMetric[]; finish(): number | null } {
  const metrics: ScoreMetric[] = [];
  const timed: Timed[] = [];
  const seen = new Set<string>();
  const add = (metric: ScoreMetric): ScoreMetric => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(metric.id)) throw new Error(`metric "${metric.id}" isn't a name a scorecard takes (lower-case letters, digits, dots and dashes)`);
    if (seen.has(metric.id)) throw new Error(`metric ${metric.id} recorded twice`);
    if (!Number.isFinite(metric.value)) throw new Error(`metric ${metric.id} is not a finite number (${metric.value})`);
    seen.add(metric.id);
    metrics.push(metric);
    return metric;
  };
  const speedMetric = (id: string, samples: readonly number[], unit: string, better: "higher" | "lower", note?: string): ScoreMetric => {
    if (!samples.length) throw new Error(`metric ${id} has no samples`);
    const s = summarise(samples);
    return add({ id, value: sig(s.median, 4), unit, kind: "speed", better, spread: sig(s.iqr, 3), n: s.n, ...(note ? { note } : {}) });
  };
  /** The suite's calibration, with every timing brought to it. Null without a pace. */
  const finish = (): number | null => {
    if (!pace) return null;
    for (let i = 0; i < 3; i++) pace.window(80);
    const calibration = pace.calibration();
    for (const t of timed) {
      const m = t.metric;
      if (t.paced) {
        const s = summarise(t.paced.map((x) => x / calibration));
        m.value = sig(s.median, 4);
        m.spread = sig(s.iqr, 3);
      } else if (t.span) {
        // A time stretches as the machine slows; a rate shrinks.
        const local = pace.around(t.span[0], t.span[1]);
        const factor = m.better === "lower" ? local.score / calibration : calibration / local.score;
        const s = summarise(t.samples);
        m.value = sig(s.median * factor, 4);
        // Samples taken in one stretch share its load: they can't say how unsteady the machine was. The windows can.
        m.spread = sig(Math.max(s.iqr * factor, s.median * factor * local.jitter), 3);
      }
    }
    return calibration;
  };
  const ctx: SuiteContext = {
    seed,
    full,
    quality(id, value, unit, better, extra = {}) {
      add({ id, value: sig(value, 9), unit, kind: "quality", better, ...(extra.resolution !== undefined ? { spread: extra.resolution } : {}), ...(extra.n !== undefined ? { n: extra.n } : {}), ...(extra.note ? { note: extra.note } : {}) });
    },
    time(id, fn, options = {}) {
      const batch = options.batch ?? 1;
      const per = options.per ?? 1;
      for (let i = 0; i < (options.warm ?? 2); i++) {
        options.before?.();
        fn();
      }
      const samples: number[] = [];
      const paced: number[] = [];
      let k0 = pace?.window() ?? 1;
      for (let i = 0; i < (options.n ?? 9); i++) {
        options.before?.();
        const started = performance.now();
        for (let b = 0; b < batch; b++) fn();
        const ms = (performance.now() - started) / batch / per;
        const k1 = pace?.window() ?? 1;
        samples.push(ms);
        paced.push((ms * (k0 + k1)) / 2);
        k0 = k1;
      }
      const metric = speedMetric(id, samples, "ms", "lower", options.note);
      if (pace) timed.push({ metric, samples, paced });
      return samples;
    },
    async timeAsync(id, fn, options = {}) {
      const per = options.per ?? 1;
      for (let i = 0; i < (options.warm ?? 2); i++) {
        options.before?.();
        await fn();
      }
      const samples: number[] = [];
      const paced: number[] = [];
      let k0 = pace?.window() ?? 1;
      for (let i = 0; i < (options.n ?? 9); i++) {
        options.before?.();
        const started = performance.now();
        await fn();
        const ms = (performance.now() - started) / per;
        const k1 = pace?.window() ?? 1;
        samples.push(ms);
        paced.push((ms * (k0 + k1)) / 2);
        k0 = k1;
      }
      const metric = speedMetric(id, samples, "ms", "lower", options.note);
      if (pace) timed.push({ metric, samples, paced });
      return samples;
    },
    speed(id, samples, unit, better, span, note) {
      const metric = speedMetric(id, samples, unit, better, note);
      if (pace) timed.push({ metric, samples, span });
    },
    pulse: () => pace?.pulse(),
    log,
  };
  return { ctx, metrics, finish };
}
