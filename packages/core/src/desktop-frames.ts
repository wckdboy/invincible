/*
 * The frames of an agent's desktop stream as you watch it (C1 step 9; docs/DESKTOP.md): as its VM's encoder writes them
 * (sandbox/desktop/stream.c) and as the node sends them on to your devices.
 *
 * Each is a 4-byte big-endian length of what follows it, a byte for its kind, an 8-byte big-endian time in milliseconds
 * since the epoch, then its payload:
 * - a keyframe (1): the screen's H.264 NAL units, Annex B, Constrained Baseline, its SPS and PPS first, the time when it
 *   was captured. A reader starts at one;
 * - any other frame (2): the same, against the frames before it;
 * - a beat (0): nothing, the time when the node sent it. The node sends one while the screen is still, so that whatever
 *   carries the stream knows it is alive.
 * A kind not listed here is kept, for a reader to pass by.
 */

export const DESKTOP_FRAME_KIND = { beat: 0, key: 1, delta: 2 } as const;

/** The stream's media type, as the node answers teamDesktopStream. */
export const DESKTOP_FRAMES_TYPE = "application/vnd.invincible.desktop-frames";

/** The length, the kind and the time: what comes before a frame's payload. */
export const DESKTOP_FRAME_HEADER = 13;

/** The most a frame may be. A keyframe of a busy 1280 by 800 screen is under 200 KB (C1 step 9.1). */
export const DESKTOP_FRAME_MAX = 8 * 1024 * 1024;

export interface DesktopFrame {
  kind: number;
  /** Milliseconds since the epoch. */
  time: number;
  /** The NAL units, Annex B; nothing for a beat. */
  payload: Uint8Array;
  /** The whole frame as it came, its header too, to send on as it is. */
  bytes: Uint8Array;
}

/** A stream's frames, as its bytes come in pieces of any size. A length no frame has is no stream of frames: it throws. */
export class DesktopFrames {
  private held: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): DesktopFrame[] {
    let bytes = chunk;
    if (this.held.length) {
      bytes = new Uint8Array(this.held.length + chunk.length);
      bytes.set(this.held);
      bytes.set(chunk, this.held.length);
    }
    const frames: DesktopFrame[] = [];
    let at = 0;
    while (bytes.length - at >= 4) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
      if (length < DESKTOP_FRAME_HEADER - 4 || length > DESKTOP_FRAME_MAX) throw new Error(`not a desktop frame: a length of ${length} bytes`);
      if (bytes.length - at < 4 + length) break;
      // (Each frame a copy of its own, and what is left too: the chunk they came in may be used again.)
      const whole = bytes.slice(at, at + 4 + length);
      frames.push({ kind: whole[4]!, time: Number(new DataView(whole.buffer).getBigUint64(5)), payload: whole.subarray(DESKTOP_FRAME_HEADER), bytes: whole });
      at += 4 + length;
    }
    this.held = bytes.slice(at);
    return frames;
  }
}

/** A beat at `time` (ms since the epoch): a frame with nothing to show, sent while the screen is still. */
export function desktopBeat(time: number): Uint8Array {
  const out = new Uint8Array(DESKTOP_FRAME_HEADER);
  const view = new DataView(out.buffer);
  view.setUint32(0, DESKTOP_FRAME_HEADER - 4);
  out[4] = DESKTOP_FRAME_KIND.beat;
  view.setBigUint64(5, BigInt(Math.max(0, Math.floor(time))));
  return out;
}
