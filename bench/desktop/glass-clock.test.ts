import { describe, expect, test } from "bun:test";
import { bitsOf, readStrip, STRIP } from "./glass-clock.ts";

/*
 * The clock the glass-to-glass harness reads off an agent's screen: a time and a count of clicks drawn as a strip of
 * black and white blocks, read back from each frame as the app draws it.
 */

/** A screen drawn as the page draws the strip, at `top` (the browser's own bar above it), with what H.264 does to it: blur and noise. */
function screen(time: number, clicks: number, top: number, damage = 0): (x: number, y: number) => number {
  const bits = bitsOf(time, clicks);
  return (x, y) => {
    const i = Math.floor((x - STRIP.x) / STRIP.block);
    const inside = y >= top + STRIP.y && y < top + STRIP.y + STRIP.block && i >= 0 && i < STRIP.bits;
    const level = inside ? (bits[i] ? 235 : 16) : 128;
    // (Damage: a level pulled towards grey, and noise that changes with the place.)
    return level + (128 - level) * damage + (((x * 31 + y * 17) % 23) - 11);
  };
}

describe("the glass clock", () => {
  test("a time and a count of clicks come back as they were drawn", () => {
    for (const [time, clicks] of [[1_764_216_000_123, 0], [1_764_216_999_999, 7], [2 ** 42 - 1, 255], [0, 1]] as const) {
      expect(readStrip(screen(time, clicks, 0))).toMatchObject({ time, clicks });
    }
    // Clicks past 255 wrap, as a byte does.
    expect(readStrip(screen(5, 256 + 3, 0))?.clicks).toBe(3);
  });

  test("it is found below the browser's own bar, wherever that ends, and read through what compression does to it", () => {
    for (const top of [0, 37, 80, 122]) {
      const read = readStrip(screen(1_764_216_000_456, 12, top, 0.35))!;
      expect(read).toMatchObject({ time: 1_764_216_000_456, clicks: 12 });
      // (Where the page begins, to within half a block: the next frame's search starts there, and reads at once.)
      expect(Math.abs(read.row - top)).toBeLessThanOrEqual(STRIP.block / 2);
      const next = screen(1_764_216_000_556, 13, top, 0.35);
      expect(readStrip(next, STRIP, 200, read.row)).toEqual({ time: 1_764_216_000_556, clicks: 13, row: read.row });
    }
  });

  test("what isn't the strip, or a strip a block has turned in, reads as nothing, never a wrong time", () => {
    expect(readStrip(() => 128)).toBeNull();
    expect(readStrip(() => 0)).toBeNull();
    const drawn = screen(1_764_216_000_789, 3, 40);
    // One block of the time read the other way: its check doesn't hold.
    const flipped = (x: number, y: number) => (Math.floor((x - STRIP.x) / STRIP.block) === 20 && y >= 40 + STRIP.y && y < 40 + STRIP.y + STRIP.block ? 255 - drawn(x, y) : drawn(x, y));
    expect(readStrip(flipped)).toBeNull();
  });

  test("the strip fits a 1280-pixel screen, its blocks big enough to outlast compression", () => {
    expect(STRIP.x + STRIP.bits * STRIP.block).toBeLessThanOrEqual(1280);
    expect(STRIP.block).toBeGreaterThanOrEqual(16);
    expect(bitsOf(1, 1)).toHaveLength(STRIP.bits);
  });
});
