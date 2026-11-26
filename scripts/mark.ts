/*
 * Invincible's mark: the I-beam. One solid form in one ink, the steel section and the letter I, chosen by the owner on
 * 26 November 2026 ("simpler, still sleek and cool, logo, minimal bold monochrome"). It replaces Field · Aurum as the
 * app icon everywhere, and it is how the primary is shown in one ink.
 *
 * It is three rectangles (two flanges and the web between them), so each pixel's share of it is worked out exactly, not
 * sampled: the edges are as smooth as a pixel can make them, and the same pixels come out on every machine.
 */

/** The mark in a 100-unit box: the top flange, the web, the bottom flange (x0, y0, x1, y1). */
export const MARK_RECTS: readonly (readonly [number, number, number, number])[] = [
  [22, 14, 78, 30],
  [41, 30, 59, 70],
  [22, 70, 78, 86],
];

/** The same as one polygon, for SVG (`<polygon points="…"/>` in a `viewBox="0 0 100 100"`). */
export const MARK_POLYGON = "22,14 78,14 78,30 59,30 59,70 78,70 78,86 22,86 22,70 41,70 41,30 22,30";

/** How much of a square image the 100-unit box spans at zoom 1: the mark itself is then half the image's height. */
export const MARK_BOX = 0.7;

/** The ink and the tile: white on near black (the app icon), and the tile's own colour. */
export const MARK_INK = { mark: "#ffffff", tile: "#0a0a0b" } as const;

/** The farthest corner of the mark from the image's middle, as a share of the image's width, at a zoom: what a mask
 * keeps (a maskable icon's 0.4, an adaptive icon's 66/108/2) must reach past it. */
export function markReach(zoom = 1): number {
  const scale = MARK_BOX * zoom;
  let far = 0;
  for (const [x0, y0, x1, y1] of MARK_RECTS)
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) far = Math.max(far, Math.hypot(((x - 50) / 100) * scale, ((y - 50) / 100) * scale));
  return far;
}

/** Each pixel's share of the mark, 0 to 1, in a `size` × `size` image, centred, at `zoom`. */
export function markCoverage(size: number, zoom = 1): Float32Array {
  const out = new Float32Array(size * size);
  const unit = (MARK_BOX * zoom * size) / 100;
  const at = (u: number) => size / 2 + (u - 50) * unit;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  for (const [ux0, uy0, ux1, uy1] of MARK_RECTS) {
    const x0 = at(ux0), x1 = at(ux1), y0 = at(uy0), y1 = at(uy1);
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(size, Math.ceil(y1)); y++) {
      const dy = overlap(y, y + 1, y0, y1);
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(size, Math.ceil(x1)); x++) out[y * size + x]! += overlap(x, x + 1, x0, x1) * dy;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i]!);
  return out;
}

const hex = (colour: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(colour.slice(i, i + 2), 16)) as [number, number, number];

/**
 * The mark as 8-bit RGBA. On a tile it is opaque: the mark's ink over the tile, edge pixels blended. With no tile
 * (`tile: null`) it lies on nothing: the ink everywhere, the mark's coverage as alpha (a foreground, a mask, a badge).
 */
export function renderMark(size: number, { zoom = 1, tile = MARK_INK.tile as string | null, ink = MARK_INK.mark as string } = {}): Uint8Array {
  const cover = markCoverage(size, zoom), out = new Uint8Array(size * size * 4);
  const m = hex(ink), t = tile ? hex(tile) : m;
  for (let i = 0; i < size * size; i++) {
    const k = cover[i]!;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = tile ? Math.round(t[c]! + (m[c]! - t[c]!) * k) : m[c]!;
    out[i * 4 + 3] = tile ? 255 : Math.round(255 * k);
  }
  return out;
}
