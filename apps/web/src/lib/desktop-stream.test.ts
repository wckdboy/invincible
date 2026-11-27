import { describe, expect, test } from "bun:test";
import { DESKTOP_FRAME_KIND, type DesktopFrame } from "@invincible/core/desktop-frames";
import { againIn, BEHIND, BEHIND_TIMES, BEHIND_WITHIN_MS, behindAgain, behindTooOften, chunkOf, codecOf, holdEnds, LIVE_TRIES, nalUnits } from "./desktop-stream.ts";

/*
 * The live picture of an agent's desktop, as the app decodes it: the stream's frames to the browser's own decoder, and
 * your take-over as the node says it. Pure: views/desktop.ts draws it.
 */

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
/** A keyframe's NAL units as an encoder writes them: an access unit delimiter, the SPS, the PPS, then the IDR slice. */
const AUD = [0, 0, 0, 1, 0x09, 0xf0];
const SPS = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40];
const PPS = [0, 0, 1, 0x68, 0xce, 0x3c, 0x80];
const IDR = [0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33];

const frame = (kind: number, time: number, payload: Uint8Array): DesktopFrame => ({ kind, time, payload, bytes: new Uint8Array(0) });

describe("a frame's NAL units", () => {
  test("each one without its start code, three bytes or four", () => {
    expect(nalUnits(bytes(AUD, SPS, PPS, IDR)).map((n) => [...n])).toEqual([
      [0x09, 0xf0],
      [0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40],
      [0x68, 0xce, 0x3c, 0x80],
      [0x65, 0x88, 0x84, 0x00, 0x33],
    ]);
    expect(nalUnits(new Uint8Array(0))).toEqual([]);
    expect(nalUnits(bytes([0x65, 1, 2]))).toEqual([]);
  });
});

describe("the codec a keyframe is decoded as", () => {
  test("avc1, then its SPS's profile, constraints and level, as RFC 6381 writes them", () => {
    // Constrained Baseline, level 3.1: what the VM's encoder makes.
    expect(codecOf(bytes(AUD, SPS, PPS, IDR))).toBe("avc1.42C01F");
    expect(codecOf(bytes([0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac]))).toBe("avc1.640028");
  });

  test("none from a frame with no SPS, or one cut short", () => {
    expect(codecOf(bytes(IDR))).toBeNull();
    expect(codecOf(bytes([0, 0, 1, 0x67, 0x42]))).toBeNull();
  });
});

describe("a frame as the decoder takes it", () => {
  test("a keyframe and any other, at their capture time in microseconds", () => {
    const key = bytes(SPS, PPS, IDR);
    expect(chunkOf(frame(DESKTOP_FRAME_KIND.key, 1_764_216_000_123, key))).toEqual({ type: "key", timestamp: 1_764_216_000_123_000, data: key });
    const delta = bytes([0, 0, 1, 0x41, 0x9a]);
    expect(chunkOf(frame(DESKTOP_FRAME_KIND.delta, 1_764_216_000_223, delta))).toEqual({ type: "delta", timestamp: 1_764_216_000_223_000, data: delta });
  });

  test("a beat is nothing to decode, and nor is a kind this app doesn't know", () => {
    expect(chunkOf(frame(DESKTOP_FRAME_KIND.beat, 1, new Uint8Array(0)))).toBeNull();
    expect(chunkOf(frame(7, 1, bytes(IDR)))).toBeNull();
  });
});

describe("your take-over, and watching again", () => {
  test("it ends when the node said it would, by this device's clock, if nothing more is done there", () => {
    const said = 1_764_216_000_000;
    expect(holdEnds({ since: said - 30_000, idleSec: 120, mostSec: 900, endsInSec: 119.5 }, said)).toBe(said + 119_500);
  });

  test("after the stream ends, it is watched again a little later each time, at most 5 s, and given up for pictures after a few", () => {
    expect([1, 2, 3, 4, 5, 9].map(againIn)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(LIVE_TRIES).toBe(4);
  });
});

describe("falling behind", () => {
  const T = Date.UTC(2026, 10, 27, 10, 0, 0);
  test("past twenty frames waiting, a device has fallen behind; three times in a row, each within 30 s, gives way", () => {
    expect([BEHIND, BEHIND_TIMES, BEHIND_WITHIN_MS]).toEqual([20, 3, 30_000]);
    const first = behindAgain(null, T);
    const second = behindAgain(first, T + 10_000);
    // (Exactly 30 s after the last is still within it.)
    const third = behindAgain(second, T + 40_000);
    expect([first, second, third]).toEqual([
      { count: 1, at: T },
      { count: 2, at: T + 10_000 },
      { count: 3, at: T + 40_000 },
    ]);
    expect([first, second, third].map(behindTooOften)).toEqual([false, false, true]);
  });

  test("a behind more than 30 s after the last starts a new row", () => {
    const second = behindAgain(behindAgain(null, T), T + 10_000);
    expect(behindAgain(second, T + 40_001)).toEqual({ count: 1, at: T + 40_001 });
    expect(behindTooOften(behindAgain(second, T + 40_001))).toBe(false);
  });
});
