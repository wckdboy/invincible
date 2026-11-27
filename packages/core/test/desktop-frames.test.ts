import { describe, expect, test } from "bun:test";
import { DESKTOP_FRAME_HEADER, DESKTOP_FRAME_KIND, DESKTOP_FRAME_MAX, DesktopFrames, desktopBeat } from "../src/index.ts";

/*
 * The frames of an agent's desktop stream, as its VM's encoder writes them (sandbox/desktop/stream.c) and the node
 * sends them on: a 4-byte big-endian length of what follows, a kind, an 8-byte big-endian time in ms, the payload.
 */

/** A frame as stream.c writes one. */
function frame(kind: number, time: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(DESKTOP_FRAME_HEADER + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 9 + payload.length);
  out[4] = kind;
  view.setBigUint64(5, BigInt(time));
  out.set(payload, DESKTOP_FRAME_HEADER);
  return out;
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("a desktop stream's frames", () => {
  const key = frame(DESKTOP_FRAME_KIND.key, 1_764_216_000_123, [0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65, 0x88]);
  const delta = frame(DESKTOP_FRAME_KIND.delta, 1_764_216_000_223, [0, 0, 0, 1, 0x41, 0x9a]);

  test("come out whole however their bytes are cut, each with its kind, its time and its payload, and its bytes as they came", () => {
    const all = join(key, delta);
    for (const cut of [1, 3, 4, 5, 12, 13, 14, key.length - 1, key.length, key.length + 1, all.length - 1]) {
      const frames = new DesktopFrames();
      const out = [...frames.push(all.subarray(0, cut)), ...frames.push(all.subarray(cut))];
      expect(out.map((f) => [f.kind, f.time, [...f.payload]])).toEqual([
        [1, 1_764_216_000_123, [0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65, 0x88]],
        [2, 1_764_216_000_223, [0, 0, 0, 1, 0x41, 0x9a]],
      ]);
      expect(out.map((f) => [...f.bytes])).toEqual([[...key], [...delta]]);
    }
    // One byte at a time too.
    const frames = new DesktopFrames();
    const out = [...all].flatMap((b) => frames.push(new Uint8Array([b])));
    expect(out).toHaveLength(2);
  });

  test("a beat is a frame with nothing to show: the node's, while the screen is still", () => {
    const beat = desktopBeat(1_764_216_001_500);
    expect([...beat]).toEqual([...frame(DESKTOP_FRAME_KIND.beat, 1_764_216_001_500, [])]);
    expect(new DesktopFrames().push(beat)).toEqual([{ kind: 0, time: 1_764_216_001_500, payload: new Uint8Array(0), bytes: beat }]);
  });

  test("a kind it doesn't know is kept, for a reader to pass by; a length no frame has is no stream of frames", () => {
    expect(new DesktopFrames().push(frame(7, 5, [1, 2])).map((f) => f.kind)).toEqual([7]);
    const short = new Uint8Array([0, 0, 0, 8, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => new DesktopFrames().push(short)).toThrow(/not a desktop frame/);
    const long = new Uint8Array(4);
    new DataView(long.buffer).setUint32(0, DESKTOP_FRAME_MAX + 1);
    expect(() => new DesktopFrames().push(long)).toThrow(/not a desktop frame/);
    // (Text where frames should be, such as an error printed on stdout, is a length no frame has.)
    expect(() => new DesktopFrames().push(new TextEncoder().encode("desktop: unknown command\n"))).toThrow(/not a desktop frame/);
  });
});
