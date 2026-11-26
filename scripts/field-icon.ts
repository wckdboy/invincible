#!/usr/bin/env bun
/*
 * Galahad's icon, drawn as light: his field (apps/web/src/lib/field.ts) rendered the way the chosen picture was (26
 * November 2026, "field aurum"): each point a soft sprite added in linear light, the bright parts bloomed in five
 * widening blurs, tone-mapped by ACES filmic and written as sRGB. Pure TypeScript and Bun's zlib: no browser, no WebGL,
 * no dependency, and the same pixels on every machine. scripts/brand.ts and apps/apple/scripts/brand.ts call it; on
 * its own it writes the icon's forms to a folder to look at:
 *
 *   bun scripts/field-icon.ts <folder>
 */
import { deflateSync } from "node:zlib";
import { AURUM, fieldPoints, linear, project, type FieldColours, type Rgb } from "../apps/web/src/lib/field.ts";

/** The tile the field sits on: a warm night, lit a little from the upper left, darker at its edges. */
export interface Backdrop {
  top: string;
  bottom: string;
  /** The light from the upper left: its colour and how strong (0 to 1). */
  glow: [string, number];
}
export const NIGHT: Backdrop = { top: "#1a1206", bottom: "#040301", glow: ["#ffaa28", 0.1] };

export interface Render {
  size: number;
  /** Tone-mapped sRGB, 0 to 1, three values a pixel. */
  rgb: Float32Array;
  /** How much light the field itself put on each pixel, 0 to 1 (for the forms with no tile: a foreground, a mask). */
  light: Float32Array;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hexSrgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The backdrop in linear light, painted as a canvas paints it (in sRGB, one layer over another), then linearised. */
function backdrop(size: number, b: Backdrop): Float32Array {
  const out = new Float32Array(size * size * 3), top = hexSrgb(b.top), bottom = hexSrgb(b.bottom), glow = hexSrgb(b.glow[0]);
  const s = size / 512;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = y / (size - 1);
      let c: Rgb = [top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t];
      const g = b.glow[1] * Math.max(0, 1 - Math.hypot(x - 150 * s, y - 110 * s) / (420 * s));
      c = [c[0] + (glow[0] - c[0]) * g, c[1] + (glow[1] - c[1]) * g, c[2] + (glow[2] - c[2]) * g];
      const v = 0.55 * Math.max(0, Math.min(1, (Math.hypot(x - 256 * s, y - 256 * s) - 180 * s) / (200 * s)));
      c = [c[0] * (1 - v), c[1] * (1 - v), c[2] * (1 - v)];
      const i = (y * size + x) * 3;
      out[i] = srgbToLinear(c[0]);
      out[i + 1] = srgbToLinear(c[1]);
      out[i + 2] = srgbToLinear(c[2]);
    }
  }
  return out;
}

/** Each point as a sprite: a square as wide as the point, its light falling off from 0.3 to 0.5 of the way out, added
 * as additive blending adds it (its colour times its coverage, twice: the colour's and the blend's). */
function splat(size: number, points: ReturnType<typeof fieldPoints>, zoom: number): Float32Array {
  const acc = new Float32Array(size * size * 3);
  for (const p of points) {
    const q = project(p, size, { zoom });
    if (!q.visible) continue;
    const d = Math.max(1, q.d), half = d / 2;
    const x0 = Math.max(0, Math.floor(q.x - half)), x1 = Math.min(size - 1, Math.ceil(q.x + half));
    const y0 = Math.max(0, Math.floor(q.y - half)), y1 = Math.min(size - 1, Math.ceil(q.y + half));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - q.x) / d, dy = (y + 0.5 - q.y) / d;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) continue;
        const a = smoothstep(0.5, 0.3, Math.hypot(dx, dy)), w = a * a, i = (y * size + x) * 3;
        acc[i] = acc[i]! + p.rgb[0] * w;
        acc[i + 1] = acc[i + 1]! + p.rgb[1] * w;
        acc[i + 2] = acc[i + 2]! + p.rgb[2] * w;
      }
    }
  }
  return acc;
}

/** A separable Gaussian blur of a w×h RGB image. */
function blur(img: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = new Float32Array(img.length), out = new Float32Array(img.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let i = -r; i <= r; i++) v += img[(y * w + Math.min(w - 1, Math.max(0, x + i))) * 3 + c]! * k[i + r]!;
        tmp[(y * w + x) * 3 + c] = v;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let i = -r; i <= r; i++) v += tmp[(Math.min(h - 1, Math.max(0, y + i)) * w + x) * 3 + c]! * k[i + r]!;
        out[(y * w + x) * 3 + c] = v;
      }
  return out;
}
/** Halve an image (each pixel the mean of four). */
function half(img: Float32Array, w: number): Float32Array {
  const hw = w >> 1, out = new Float32Array(hw * hw * 3);
  for (let y = 0; y < hw; y++)
    for (let x = 0; x < hw; x++)
      for (let c = 0; c < 3; c++) {
        const at = (yy: number, xx: number) => img[(yy * w + xx) * 3 + c]!;
        out[(y * hw + x) * 3 + c] = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4;
      }
  return out;
}
/** Sample a small image at full size (bilinear). */
function sample(img: Float32Array, w: number, size: number, x: number, y: number, c: number): number {
  const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / size - 0.5)), fy = Math.min(w - 1, Math.max(0, ((y + 0.5) * w) / size - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(w - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  const at = (yy: number, xx: number) => img[(yy * w + xx) * 3 + c]!;
  return (at(y0, x0) * (1 - tx) + at(y0, x1) * tx) * (1 - ty) + (at(y1, x0) * (1 - tx) + at(y1, x1) * tx) * ty;
}

/** UnrealBloomPass's way (three.js r160): what is brighter than the threshold, blurred at five halving sizes (each from
 * the last), added back with a weight each. Tuned for a clear read (your word, 26 November 2026: "less fog, so it reads
 * clearer"): the glow kept close to the lines, the wide halos a trace, only the brightest light blooming. */
function bloom(hdr: Float32Array, size: number, { strength = 0.7, threshold = 0.55, factors = [0.9, 0.55, 0.25, 0.1, 0.04] } = {}): Float32Array {
  const bright = new Float32Array(hdr.length);
  for (let i = 0; i < hdr.length; i += 3) {
    const lum = 0.299 * hdr[i]! + 0.587 * hdr[i + 1]! + 0.114 * hdr[i + 2]!, a = smoothstep(threshold, threshold + 0.01, lum);
    bright[i] = hdr[i]! * a;
    bright[i + 1] = hdr[i + 1]! * a;
    bright[i + 2] = hdr[i + 2]! * a;
  }
  const sigmas = [3, 5, 7, 9, 11];
  const scale = size / 768; // the chosen picture was 768 across: its blurs, in its pixels
  const mips: [Float32Array, number][] = [];
  let level: Float32Array = bright, w = size;
  for (let m = 0; m < 5; m++) {
    level = half(level, w);
    w >>= 1;
    level = blur(level, w, w, sigmas[m]! * scale);
    mips.push([level, w]);
  }
  const out = new Float32Array(hdr);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 3; c++) {
        let v = 0;
        mips.forEach(([img, mw], m) => (v += factors[m]! * sample(img, mw, size, x, y, c)));
        const at = (y * size + x) * 3 + c;
        out[at] = out[at]! + strength * v;
      }
  return out;
}

/** three.js' ACES filmic tone mapping (r160), at an exposure, to sRGB. */
function aces(c: Rgb, exposure: number): Rgb {
  const e = exposure / 0.6, [r, g, b] = [c[0] * e, c[1] * e, c[2] * e];
  // ACESInputMat (rows as GLSL's column-major mat3 multiplies)
  const v: Rgb = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.076 * r + 0.90834 * g + 0.01566 * b, 0.0284 * r + 0.13383 * g + 0.83777 * b];
  const fit = (x: number) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
  const f: Rgb = [fit(v[0]), fit(v[1]), fit(v[2])];
  const o: Rgb = [1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2], -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2], -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2]];
  return [linearToSrgb(Math.max(0, Math.min(1, o[0]))), linearToSrgb(Math.max(0, Math.min(1, o[1]))), linearToSrgb(Math.max(0, Math.min(1, o[2])))];
}

/** The field, `size` across: on its tile (a backdrop) or on nothing; `zoom` below 1 draws it smaller in the same square
 * (for a mask's safe zone), `weight` above 1 makes its points bolder (for the small sizes). */
export function renderField(size: number, { colours = AURUM, tile = NIGHT as Backdrop | null, zoom = 1, weight = 1.4, exposure = 1.12, field = true } = {}): Render {
  const points = field ? fieldPoints({ colours, weight, lines: 52 }) : [];
  const light = bloom(splat(size, points, zoom), size);
  const base = tile ? backdrop(size, tile) : new Float32Array(size * size * 3);
  const rgb = new Float32Array(size * size * 3), amount = new Float32Array(size * size);
  const black = aces([0, 0, 0], exposure)[0];
  for (let i = 0; i < size * size; i++) {
    const j = i * 3, l: Rgb = [light[j]!, light[j + 1]!, light[j + 2]!];
    const t = aces([base[j]! + l[0], base[j + 1]! + l[1], base[j + 2]! + l[2]], exposure);
    rgb[j] = t[0];
    rgb[j + 1] = t[1];
    rgb[j + 2] = t[2];
    const lt = aces(l, exposure);
    amount[i] = Math.max(0, Math.max(lt[0], lt[1], lt[2]) - black);
  }
  return { size, rgb, light: amount };
}

/* ---------- pixels out ---------- */

/** 8-bit RGBA from a render: opaque on its tile; on nothing, the field's own light as its alpha (its colour un-
 * premultiplied), so it lies over any dark ground as it would glow there. `mono`: white, the light as alpha. */
export function rgba(r: Render, { mono = false, opaque = true } = {}): Uint8Array {
  const out = new Uint8Array(r.size * r.size * 4);
  for (let i = 0; i < r.size * r.size; i++) {
    const a = opaque ? 1 : Math.min(1, r.light[i]! * (mono ? 1.6 : 1.25));
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(255 * (mono ? 1 : opaque ? r.rgb[i * 3 + c]! : Math.min(1, r.rgb[i * 3 + c]! / Math.max(a, 1e-4))));
    out[i * 4 + 3] = Math.round(255 * a);
  }
  return out;
}

/** The tile's shape on an RGBA image: a rounded square (corners `radius` of its width), transparent outside, its edge
 * antialiased over four samples a pixel. For the forms a platform shows as they are (a manifest's "any" icon). */
export function roundTile(img: Uint8Array, size: number, radius = 0.2237): Uint8Array {
  const out = new Uint8Array(img), r = radius * size;
  const inside = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return Math.hypot(x - cx, y - cy) <= r;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (x > r && x < size - r - 1 && y > r && y < size - r - 1) continue;
      let k = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) if (inside(x + dx, y + dy)) k++;
      out[(y * size + x) * 4 + 3] = Math.round((img[(y * size + x) * 4 + 3]! * k) / 4);
    }
  return out;
}

/** iOS's tinted icon: the picture in grey (its light, as luminance) on black, for the system to colour. */
export function greyscale(img: Uint8Array): Uint8Array {
  const out = new Uint8Array(img.length);
  for (let i = 0; i < img.length; i += 4) {
    const l = Math.round(0.2126 * img[i]! + 0.7152 * img[i + 1]! + 0.0722 * img[i + 2]!);
    out[i] = out[i + 1] = out[i + 2] = l;
    out[i + 3] = img[i + 3]!;
  }
  return out;
}

/** Shrink an RGBA image to `to` across, each pixel the mean of the pixels it covers (alpha-weighted colour). */
export function downscale(img: Uint8Array, from: number, to: number): Uint8Array {
  const out = new Uint8Array(to * to * 4), k = from / to;
  for (let y = 0; y < to; y++)
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y * k); yy < Math.min(from, Math.ceil((y + 1) * k)); yy++)
        for (let xx = Math.floor(x * k); xx < Math.min(from, Math.ceil((x + 1) * k)); xx++) {
          const i = (yy * from + xx) * 4, al = img[i + 3]! / 255;
          r += img[i]! * al;
          g += img[i + 1]! * al;
          b += img[i + 2]! * al;
          a += al;
          n++;
        }
      const o = (y * to + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((255 * a) / n);
    }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (bytes: Uint8Array) => {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
/** A PNG of an RGBA image (8 bits a channel; RGB alone when every pixel is opaque). No metadata. */
export function png(img: Uint8Array, size: number): Uint8Array {
  const opaque = img.every((v, i) => i % 4 !== 3 || v === 255), channels = opaque ? 3 : 4, stride = size * channels;
  // Each row filtered the way that leaves it smallest (PNG's five, by the usual measure: the least sum of its bytes as
  // signed values), as an encoder does: a glow compresses to a fraction of what it does unfiltered, and nothing is lost.
  const raw = new Uint8Array(size * (stride + 1)), row = new Uint8Array(stride), prev = new Uint8Array(stride), trial = new Uint8Array(stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) for (let c = 0; c < channels; c++) row[x * channels + c] = img[(y * size + x) * 4 + c]!;
    let best = 0, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels]! : 0, b = prev[i]!, cc = i >= channels ? prev[i - channels]! : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); return pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; })();
        const v = (row[i]! - pred) & 0xff;
        trial[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = f;
        raw.set(trial, y * (stride + 1) + 1);
      }
    }
    raw[y * (stride + 1)] = best;
    prev.set(row);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

if (import.meta.main) {
  const dir = Bun.argv[2];
  if (!dir) throw new Error("usage: bun scripts/field-icon.ts <folder>");
  const t0 = performance.now();
  const icon = renderField(1024);
  await Bun.write(`${dir}/icon-1024.png`, png(rgba(icon), 1024));
  for (const s of [180, 60, 32]) await Bun.write(`${dir}/icon-${s}.png`, png(downscale(rgba(icon), 1024, s), s));
  const fg = renderField(1024, { tile: null, zoom: 0.7 });
  await Bun.write(`${dir}/foreground-1024.png`, png(rgba(fg, { opaque: false }), 1024));
  await Bun.write(`${dir}/mono-1024.png`, png(rgba(fg, { opaque: false, mono: true }), 1024));
  console.log(`rendered in ${Math.round(performance.now() - t0)} ms`);
}

export type { FieldColours };
export { linear };
