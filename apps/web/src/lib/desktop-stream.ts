/*
 * The live picture of an agent's desktop (C1 step 9.3; docs/DESKTOP.md), as the app decodes it: the stream's frames (core's
 * desktop-frames.ts) handed to the browser's own decoder (WebCodecs), H.264 from a keyframe; and your take-over as the
 * node says it. Pure (no DOM): views/desktop.ts draws it.
 */

import { DESKTOP_FRAME_KIND, type DesktopFrame } from "@invincible/core/desktop-frames";

/** Each NAL unit of an Annex B stretch, without its start code (00 00 01, or 00 00 00 01). */
export function nalUnits(annexB: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1]! - 3 : annexB.length;
    // (A four-byte start code's leading zero belongs to it, not to the unit before.)
    if (n + 1 < starts.length && end > start && annexB[end - 1] === 0) end--;
    return annexB.subarray(start, end);
  });
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

/** The codec a keyframe is decoded as (RFC 6381): avc1, then its SPS's profile, constraints and level. Null with no SPS. */
export function codecOf(keyframe: Uint8Array): string | null {
  for (const unit of nalUnits(keyframe)) if ((unit[0]! & 0x1f) === 7 && unit.length >= 4) return `avc1.${hex(unit[1]!)}${hex(unit[2]!)}${hex(unit[3]!)}`;
  return null;
}

/** A frame as the decoder takes it (an EncodedVideoChunk's fields), or null for what isn't one to decode: a beat, a kind this app doesn't know. */
export function chunkOf(frame: DesktopFrame): { type: "key" | "delta"; timestamp: number; data: Uint8Array } | null {
  const type = frame.kind === DESKTOP_FRAME_KIND.key ? "key" : frame.kind === DESKTOP_FRAME_KIND.delta ? "delta" : null;
  return type ? { type, timestamp: frame.time * 1000, data: frame.payload } : null;
}

/** Your take-over as the node says it (`held` on each answer of teamDesktop, teamDesktopTake and teamDesktopRelease). */
export interface DesktopHold {
  /** When you took it, in milliseconds since the epoch. */
  since: number;
  idleSec: number;
  mostSec: number;
  /** How long it had left when the node said it: your next input starts its idle time again. */
  endsInSec: number;
}

/** When your take-over ends by this device's clock, if nothing more is done there: `at`, when the node said it. */
export const holdEnds = (held: DesktopHold, at: number): number => at + held.endsInSec * 1000;

/** How long to wait before watching again, after the stream's nth end in a row (from 1): 0.5, 1, 2 and 4 s, then 5 s. */
export const againIn = (n: number): number => Math.min(5000, 500 * 2 ** Math.max(0, n - 1));

/** After this many ends in a row, the live picture gives way to a picture every two seconds, and says so. */
export const LIVE_TRIES = 4;

/**
 * The most frames that may wait to be decoded. Past that, this device has fallen behind the screen: the stream is ended
 * and watched again from a fresh keyframe, so what it holds, and how far behind what it shows is, stay bounded.
 */
export const BEHIND = 20;

/**
 * Falling behind again and again: this many times in a row, each within BEHIND_WITHIN_MS of the last, and the live
 * picture gives way to a picture every two seconds, said once. Watched again each time, a device too slow for the screen
 * would go live, fall behind and go live again for ever, spending a keyframe each time and looking broken. Behinds are
 * counted apart from ends: a frame drawn starts the count of ends again, never this one.
 */
export const BEHIND_TIMES = 3;
export const BEHIND_WITHIN_MS = 30_000;

/** Behinds in a row: how many, and when the last was (ms since the epoch). */
export interface Behinds {
  count: number;
  at: number;
}

/** The row once the stream has fallen behind at `at`: one more, or a new row of one when the last was over BEHIND_WITHIN_MS before. */
export const behindAgain = (row: Behinds | null, at: number): Behinds => ({ count: row && at - row.at <= BEHIND_WITHIN_MS ? row.count + 1 : 1, at });

/** Whether falling behind that often gives way to the picture. */
export const behindTooOften = (row: Behinds): boolean => row.count >= BEHIND_TIMES;
