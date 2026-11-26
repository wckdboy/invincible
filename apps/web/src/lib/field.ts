/*
 * Galahad's field: lines of force looping from pole to pole round a dark core, lit from the upper left and burning at
 * the rim on the far side (your choice for the app icon, 26 November 2026: "field aurum"). Pure: points in space with
 * a colour and a size, and their place on a square picture. The icon's renderer (scripts/field-icon.ts) draws them as
 * light; the orbs draw the same points (lib/field-orb.ts says whose field, at what size and in what mood; ui/orb.ts
 * draws it), Galahad's in gold and each knight's in its own colours.
 *
 * A field is made in two steps, so an orb that turns does the costly part once: its model (fieldModel: each line's
 * longitude and width from its seed, each step's angle, its lean, its colours in linear light), then its points at a
 * turn (fieldAt, into buffers it keeps). fieldPoints is the two at once, as the icon takes them: the same numbers to the
 * last bit.
 */

/** A colour in linear light (not sRGB): 0 to 1 and beyond, before tone mapping. */
export type Rgb = [number, number, number];

/** sRGB hex to linear light, as three.js reads a colour. */
export function linear(hex: string): Rgb {
  const channel = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [channel(1), channel(3), channel(5)];
}

/** A field's colours: its key light (the lit face, bright then deep) and the rim burning on its far side. */
export interface FieldColours {
  key: [string, string];
  rim: string;
}

/** Gold and copper: the Grail's fire. */
export const AURUM: FieldColours = { key: ["#fff4d6", "#ffb12e"], rim: "#ff5a2a" };

/** One point of light: where it is (the field's own units, the core at 0), its colour and its size. */
export interface FieldPoint {
  x: number;
  y: number;
  z: number;
  rgb: Rgb;
  size: number;
}

export interface FieldOptions {
  /** How many lines: more is denser. */
  lines?: number;
  /** Points along each line. */
  steps?: number;
  /** The field's lean (radians, about x, y and z in turn, as three.js turns an Euler). */
  tilt?: [number, number, number];
  /** A turn about the field's own axis (radians): the field turning. */
  turn?: number;
  /** Bolder points (1: as chosen). */
  weight?: number;
  colours?: FieldColours;
  seed?: number;
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const KEY = norm([-0.55, 0.58, 0.6]);
const RIM = norm([0.8, -0.45, -0.35]);
/** Where the key light comes from and where the rim light burns: unit vectors in the field's space (x right, y up, z
 * towards you). */
export const FIELD_KEY: readonly [number, number, number] = KEY;
export const FIELD_RIM: readonly [number, number, number] = RIM;

/** A field's colours in linear light, read once (shade reads them on every point). */
export interface FieldLight {
  deep: Rgb;
  bright: Rgb;
  rim: Rgb;
}
export const fieldLight = (colours: FieldColours): FieldLight => ({ deep: linear(colours.key[1]), bright: linear(colours.key[0]), rim: linear(colours.rim) });

/** A point's colour by the key light on it and the rim light behind it, and how strongly it is lit (0 to 1). */
export function shade(n: V3, colours: FieldColours): { rgb: Rgb; k: number } {
  const { rgb, k } = shadeLit(n, fieldLight(colours));
  return { rgb, k };
}

/** shade, with the colours read already; and the two lights apart: the key's (`lit`) and the rim's (`rim`), 0 to 1 each
 * (`k` is the greater). */
export function shadeLit(n: V3, light: FieldLight): { rgb: Rgb; k: number; lit: number; rim: number } {
  const lit = Math.pow(Math.max(0, dot(n, KEY)), 1.2);
  const facing = Math.max(0, n[2]);
  const rimK = Math.pow(1 - facing, 2.4) * Math.max(0, dot(n, RIM) + 0.25);
  const { deep, bright, rim } = light;
  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  let c: Rgb = [deep[0] * 0.12, deep[1] * 0.12, deep[2] * 0.12];
  c = mix(c, deep, Math.min(1, lit * 1.5));
  c = mix(c, bright, Math.max(0, lit - 0.4) * 1.7);
  const k = Math.max(lit, rimK), gain = 0.12 + 1.9 * k;
  return { rgb: [(c[0] + rim[0] * rimK * 2.2) * gain, (c[1] + rim[1] * rimK * 2.2) * gain, (c[2] + rim[2] * rimK * 2.2) * gain], k, lit, rim: rimK };
}

/** The same random numbers every time (Park and Miller's), so a field is the same picture on every machine. */
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** A field's fixed part: its lines' longitudes before any turn and their widths (its seed's), each step's angle along
 * a line (its sine, cosine and sine squared), its lean's cosines and sines, its weight and its colours. */
export interface FieldModel {
  lines: number;
  steps: number;
  weight: number;
  phi: Float64Array;
  width: Float64Array;
  sin: Float64Array;
  cos: Float64Array;
  sin2: Float64Array;
  /** The lean: cos and sin about x, y and z. */
  lean: [cx: number, sx: number, cy: number, sy: number, cz: number, sz: number];
  light: FieldLight;
}

export function fieldModel(options: FieldOptions = {}): FieldModel {
  const { lines = 46, steps = 260, tilt = [0.42, 0.3, -0.18], weight = 1, colours = AURUM, seed = 11 } = options;
  const rnd = random(seed);
  const phi = new Float64Array(lines), width = new Float64Array(lines);
  for (let line = 0; line < lines; line++) {
    phi[line] = (line / lines) * Math.PI * 2 + rnd() * 0.12;
    width[line] = 1.05 + 0.75 * Math.pow(rnd(), 0.7);
  }
  const sin = new Float64Array(steps), cos = new Float64Array(steps), sin2 = new Float64Array(steps);
  for (let j = 1; j < steps; j++) {
    const th = (j / steps) * Math.PI;
    sin[j] = Math.sin(th);
    cos[j] = Math.cos(th);
    sin2[j] = Math.sin(th) ** 2;
  }
  const [ax, ay, az] = tilt;
  return { lines, steps, weight, phi, width, sin, cos, sin2, lean: [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)], light: fieldLight(colours) };
}

/** Where a field's points go: x, y, z, their colour (r, g, b, linear), size, the key's and the rim's light on each
 * (shadeLit's `lit` and `rim`), and where each is on its line (`at`: its line times the model's steps, plus its step,
 * so two points follow each other on a line where one's is the other's plus one), as many as a model can have. */
export interface FieldBuffer {
  at: Int32Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  size: Float64Array;
  lit: Float64Array;
  rim: Float64Array;
}
export function fieldBuffer(model: FieldModel): FieldBuffer {
  const n = model.lines * model.steps;
  const make = () => new Float64Array(n);
  return { at: new Int32Array(n), x: make(), y: make(), z: make(), r: make(), g: make(), b: make(), size: make(), lit: make(), rim: make() };
}

/**
 * The field's points turned `turn` radians about its axis, into `out`, and how many there are: each line a loop from
 * pole to pole (a dipole's, r = L·sin²θ) at its own longitude and width, none inside the core (r < 0.32) and none the
 * lights leave dark. `light` colours it otherwise than its model (a mood's tint, lib/field-orb.ts).
 */
export function fieldAt(model: FieldModel, turn: number, out: FieldBuffer, light: FieldLight = model.light): number {
  const { lines, steps, weight, phi, width, sin, cos, sin2 } = model;
  const [cx, sx, cy, sy, cz, sz] = model.lean;
  let n = 0;
  for (let line = 0; line < lines; line++) {
    const p = phi[line]! + turn, cp = Math.cos(p), sp = Math.sin(p), w = width[line]!;
    for (let j = 1; j < steps; j++) {
      const r = w * sin2[j]!;
      if (r < 0.32) continue;
      const rs = r * sin[j]!;
      const a0 = rs * cp, a1 = r * cos[j]!, a2 = rs * sp;
      // The lean, as an XYZ Euler turns (three.js' default order: the matrix Rx·Ry·Rz applied to the point).
      let x = a0 * cz - a1 * sz, y = a0 * sz + a1 * cz, z = a2;
      const x2 = x * cy + z * sy, z2 = -x * sy + z * cy;
      x = x2;
      z = z2;
      const y3 = y * cx - z * sx, z3 = y * sx + z * cx;
      y = y3;
      z = z3;
      const s = shadeLit(norm([x, y, z]), light);
      if (s.k < 0.02) continue;
      const near = Math.min(1, 1.9 / (0.6 + r)), g = 0.35 + 0.65 * near;
      out.at[n] = line * steps + j;
      out.x[n] = x * 1.05;
      out.y[n] = y * 1.05;
      out.z[n] = z * 1.05;
      out.r[n] = s.rgb[0] * g;
      out.g[n] = s.rgb[1] * g;
      out.b[n] = s.rgb[2] * g;
      out.size[n] = (0.009 + 0.02 * s.k) * weight;
      out.lit[n] = s.lit;
      out.rim[n] = s.rim;
      n++;
    }
  }
  return n;
}

/** The field's points: each line a loop from pole to pole (a dipole's, r = L·sin²θ) at its own longitude and width. */
export function fieldPoints(options: FieldOptions = {}): FieldPoint[] {
  const model = fieldModel(options);
  const out = fieldBuffer(model);
  const count = fieldAt(model, options.turn ?? 0, out);
  const points: FieldPoint[] = [];
  for (let i = 0; i < count; i++) points.push({ x: out.x[i]!, y: out.y[i]!, z: out.z[i]!, rgb: [out.r[i]!, out.g[i]!, out.b[i]!], size: out.size[i]! });
  return points;
}

/** Where a point falls on a square picture `size` across, seen from a camera on the z axis (as the icon is drawn):
 * its pixel position, its diameter in pixels, and whether it is in front of the camera at all. */
export function project(p: FieldPoint, size: number, { fov = 28, distance = 8.3, zoom = 1 } = {}): { x: number; y: number; d: number; visible: boolean } {
  const depth = distance - p.z;
  const f = (size / 2 / Math.tan(((fov / 2) * Math.PI) / 180)) * zoom;
  return { x: size / 2 + (p.x * f) / depth, y: size / 2 - (p.y * f) / depth, d: (p.size * (size / 2) * zoom) / depth, visible: depth > 0.1 };
}
