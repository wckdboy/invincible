/**
 * Hybrid logical clock. Encoded as a fixed-width string so lexicographic order
 * equals causal order: `<15-digit wall ms>.<6-digit counter>`.
 * Ties between devices are broken by event id wherever a total order is needed.
 */

export const MAX_CLOCK_DRIFT_MS = 5 * 60_000;
const MAX_COUNTER = 999_999;
const HLC_RE = /^\d{15}\.\d{6}$/;

export interface Hlc {
  ms: number;
  counter: number;
}

export const encodeHlc = ({ ms, counter }: Hlc): string =>
  `${ms.toString().padStart(15, "0")}.${counter.toString().padStart(6, "0")}`;

export function decodeHlc(text: string): Hlc {
  if (!HLC_RE.test(text)) throw new Error(`invalid hlc: ${text}`);
  const [ms, counter] = text.split(".");
  return { ms: Number(ms), counter: Number(counter) };
}

export const isHlc = (text: string): boolean => HLC_RE.test(text);

export class ClockSkewError extends Error {
  constructor(readonly remote: string) {
    super(`remote clock too far in the future: ${remote}`);
  }
}

export class HlcClock {
  private last: Hlc = { ms: 0, counter: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  /** A new timestamp strictly greater than every timestamp issued or observed. */
  tick(): string {
    const wall = this.now();
    if (wall > this.last.ms) this.last = { ms: wall, counter: 0 };
    // The counter is 6 digits; carry into the millisecond field instead of ever
    // producing an invalid timestamp (an observed counter of 999999 must not wedge writes).
    else if (this.last.counter >= MAX_COUNTER) this.last = { ms: this.last.ms + 1, counter: 0 };
    else this.last = { ms: this.last.ms, counter: this.last.counter + 1 };
    return encodeHlc(this.last);
  }

  /**
   * Fold in a remote timestamp so later local events sort after it.
   * Refuses timestamps far in the future: a device with a broken (or hostile)
   * clock must not be able to win every last-writer-wins race forever.
   */
  observe(remote: string): void {
    const r = decodeHlc(remote);
    if (r.ms - this.now() > MAX_CLOCK_DRIFT_MS) throw new ClockSkewError(remote);
    if (r.ms > this.last.ms || (r.ms === this.last.ms && r.counter > this.last.counter)) this.last = r;
  }

  /** True when `remote` is acceptable under the drift bound. */
  acceptable(remote: string): boolean {
    return decodeHlc(remote).ms - this.now() <= MAX_CLOCK_DRIFT_MS;
  }
}
