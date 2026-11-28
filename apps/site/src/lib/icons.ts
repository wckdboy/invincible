/*
 * The site's icons, made from its mark (mark.ts) when it is built: a browser tab's (favicon.svg, the bare I-beam whose
 * ink follows the mode, and icon-64.png for a browser that takes no SVG), the touch icon iOS asks for
 * (apple-touch-icon.png) and the picture a link's preview shows (og.png), these three the I-beam in white on black. Pure: a shape filled with its exact coverage along each row and sixteen
 * samples down each pixel, written as a PNG with Node's zlib, so every build makes the same bytes.
 */
import { deflateSync } from "node:zlib";
import { MARK_FORMS } from "../../../../scripts/mark.ts";
import { MARK, markCorners, markSvg } from "./mark.ts";

type Rgb = [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/**
 * A browser tab's icon, which follows the mode (the owner's word, 28 November 2026: "light/dark mode, preferred bare
 * I-beam logo/no background"): the bare I-beam, near black on a light tab and white on a dark one (the icons' inks,
 * scripts/mark.ts MARK_FORMS), the same as the web app's tab.
 */
export const FAVICON_SVG = markSvg({ light: MARK_FORMS.light.mark, dark: MARK_FORMS.dark.mark });

/** The same, 64 pixels across, for a browser that takes no SVG icon. */
export const icon64 = (): Uint8Array<ArrayBuffer> => tile(64, 0.22);
/** iOS's touch icon: square (iOS rounds it), 180 across. */
export const touchIcon = (): Uint8Array<ArrayBuffer> => tile(180, 0);

/** A link's preview: the mark in white on black, 1200×630, as large as it reads beside a preview's words. */
export function ogImage(): Uint8Array<ArrayBuffer> {
  const w = 1200, h = 630, mark = 330;
  const rgba = new Uint8Array(w * h * 4);
  paint(rgba, w, h, rect(0, 0, w, h), BLACK);
  paint(rgba, w, h, placed(markCorners(), (w - mark) / 2, (h - mark) / 2, mark / MARK.box), WHITE);
  return png(rgba, w, h);
}

/** The mark in white on a black tile `size` across, its corners rounded `radius` of its width (0: square). */
function tile(size: number, radius: number): Uint8Array<ArrayBuffer> {
  const rgba = new Uint8Array(size * size * 4);
  paint(rgba, size, size, radius > 0 ? rounded(size, radius * size) : rect(0, 0, size, size), BLACK);
  paint(rgba, size, size, placed(markCorners(), 0, 0, size / MARK.box), WHITE);
  return png(rgba, size, size);
}

const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const placed = (corners: [number, number][], dx: number, dy: number, scale: number): [number, number][] => corners.map(([x, y]) => [dx + x * scale, dy + y * scale]);

/** A square `size` across with corners of radius `r`, as a polygon (each corner in 24 steps). */
function rounded(size: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const corners: [number, number, number][] = [[size - r, r, -Math.PI / 2], [size - r, size - r, 0], [r, size - r, Math.PI / 2], [r, r, Math.PI]];
  for (const [cx, cy, from] of corners) for (let i = 0; i <= 24; i++) {
    const a = from + (i / 24) * (Math.PI / 2);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Fills a polygon (even-odd) over the image in a colour, each pixel by how much of it the polygon covers. */
function paint(rgba: Uint8Array, w: number, h: number, polygon: [number, number][], [r, g, b]: Rgb): void {
  const SUB = 16;
  const cover = new Float32Array(w);
  for (let row = 0; row < h; row++) {
    cover.fill(0);
    for (let s = 0; s < SUB; s++) {
      const y = row + (s + 0.5) / SUB;
      const xs: number[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const [x1, y1] = polygon[i]!, [x2, y2] = polygon[(i + 1) % polygon.length]!;
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
      xs.sort((a, c) => a - c);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, xs[i]!), to = Math.min(w, xs[i + 1]!);
        for (let px = Math.floor(from); px < Math.ceil(to); px++) cover[px] = cover[px]! + (Math.min(to, px + 1) - Math.max(from, px)) / SUB;
      }
    }
    for (let px = 0; px < w; px++) {
      const a = Math.min(1, cover[px]!);
      if (a <= 0) continue;
      const at = (row * w + px) * 4, under = rgba[at + 3]! / 255, alpha = a + under * (1 - a);
      for (const [c, v] of [[0, r], [1, g], [2, b]] as const) rgba[at + c] = Math.round((v * a + rgba[at + c]! * under * (1 - a)) / alpha);
      rgba[at + 3] = Math.round(alpha * 255);
    }
  }
}

const CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** An RGBA image as a PNG: RGB where every pixel is opaque, no metadata. */
export function png(rgba: Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
  const opaque = rgba.every((v, i) => i % 4 !== 3 || v === 255), channels = opaque ? 3 : 4, stride = w * channels;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = rgba[(y * w + x) * 4 + c]!;
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const head = new Uint8Array(13), hv = new DataView(head.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  head.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
