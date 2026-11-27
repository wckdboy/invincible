/*
 * The clock the glass-to-glass harness reads (C1 step 9.3). The agent's screen shows a page (glass-page.ts) that
 * draws its own time, and how many clicks it has had, as a strip of black and white blocks; the browser that watches
 * it reads the strip back out of each frame as the app draws it (glass.ts), so a frame's age is its own pixels' word.
 * Pure. readStrip names nothing outside itself: it is sent to the browser as its own source.
 */

/** Where the strip is in the page, and its blocks: 8 to find it by, 42 of the time (ms), 8 of clicks, 6 to check them. */
export const STRIP = { x: 32, y: 24, block: 18, bits: 64 } as const;

/** The strip's blocks, left to right: 1 is white, 0 black. Clicks past 255 wrap, as a byte does. */
export function bitsOf(time: number, clicks: number): number[] {
  const data: number[] = [];
  for (let i = 41; i >= 0; i--) data.push(Math.floor(time / 2 ** i) % 2);
  for (let i = 7; i >= 0; i--) data.push(Math.floor((clicks % 256) / 2 ** i) % 2);
  let check = 0;
  data.forEach((bit, i) => (check += bit * (i + 1)));
  const checks: number[] = [];
  for (let i = 5; i >= 0; i--) checks.push(Math.floor((check % 64) / 2 ** i) % 2);
  return [1, 0, 1, 1, 0, 0, 1, 0, ...data, ...checks];
}

/**
 * The strip read from a frame (`level`: the brightness at a place, 0 to 255): its time, its clicks, and a row it reads
 * at, where the next frame's search starts (`from`). It is looked for at each row down to `most` (the browser's own bar
 * is above the page). A block is read only when it is plainly black or plainly white. Null where there is no strip, or
 * its check fails: never a wrong time.
 */
export function readStrip(level: (x: number, y: number) => number, strip: { x: number; y: number; block: number; bits: number } = { x: 32, y: 24, block: 18, bits: 64 }, most = 200, from = -1): { time: number; clicks: number; row: number } | null {
  const sync = [1, 0, 1, 1, 0, 0, 1, 0];
  /** A block's bit, read from a few pixels about its middle (compression's noise is at its edges): -1 where unclear. */
  const bit = (i: number, y: number): number => {
    const x = strip.x + i * strip.block + strip.block / 2;
    let sum = 0;
    for (const dx of [-3, 0, 3]) for (const dy of [-3, 0, 3]) sum += level(x + dx, y + dy);
    const mean = sum / 9;
    return mean > 160 ? 1 : mean < 96 ? 0 : -1;
  };
  /** The strip at a row, or null. */
  const at = (top: number): { time: number; clicks: number } | null => {
    const y = top + strip.y + strip.block / 2;
    for (let i = 0; i < 8; i++) if (bit(i, y) !== sync[i]) return null;
    const bits: number[] = [];
    for (let i = 8; i < strip.bits; i++) {
      const b = bit(i, y);
      if (b < 0) return null;
      bits.push(b);
    }
    let check = 0;
    for (let i = 0; i < 50; i++) check += bits[i]! * (i + 1);
    let said = 0;
    for (let i = 50; i < 56; i++) said = said * 2 + bits[i]!;
    if (check % 64 !== said) return null;
    let time = 0;
    for (let i = 0; i < 42; i++) time = time * 2 + bits[i]!;
    let clicks = 0;
    for (let i = 42; i < 50; i++) clicks = clicks * 2 + bits[i]!;
    return { time, clicks };
  };
  // (The last frame's row first: the page seldom moves.)
  const hinted = from >= 0 && from <= most ? at(from) : null;
  if (hinted) return { ...hinted, row: from };
  for (let top = 0; top <= most; top++) {
    const first = at(top);
    if (!first) continue;
    // (It reads at a run of rows: their middle is the surest for the next frame.)
    let last = top;
    while (last < most && at(last + 1)) last++;
    return { ...first, row: Math.floor((top + last) / 2) };
  }
  return null;
}
