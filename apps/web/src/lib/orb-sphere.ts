import { blendHex } from "@galahad/core/avatar";
import { orbRand, orbSeed, type OrbMood } from "./orb-motion.ts";
import type { OrbLevel } from "./orb.ts";

/*
 * An orb as a sphere of glyphs round a bright nucleus (your words, 25 November 2026: "custom/procedurally generated
 * colored particle orbs", "use glyph and randomness on the orbs, like Jarvis/Ultron in the movies, and my other project
 * Phren", "slow and calming movement"). Its points are spread evenly over a sphere turning slowly about an axis that
 * leans towards you; each is a monospace glyph from a ladder of brightness, as Phren's field is (`.` at the back to `@`
 * at the front), the nearer ones larger, lighter and more opaque. Each glyph changes, now and then, on a slow beat of its
 * own, fading a little as it does; and once in a while a few become data (a hex digit), more often while it works. Its
 * handle makes it its own: how far it leans, which way it turns, where it starts, which points are its second colour,
 * and which glyphs it shows when. Its colours are core's knightColors for a knight, and his state's for Galahad
 * (lib/orb.ts). Pure: everything in the orb's square, 200 wide and centred on its middle (y down).
 *
 * The PWA no longer draws it (26 November 2026: every orb is Galahad's field, lib/field-orb.ts; the owner's word on the
 * glyph spheres was "almost like nipples"). The Apple and Android apps still do, held to these by the vectors
 * (apps/apple/scripts/vectors.ts), until they port the field (PLAN #60); then it goes.
 */

/** An orb's own way of being a sphere, from its handle:
 * - tilt: how far its axis leans towards you, 12 to 32 degrees.
 * - spin: which way it turns (1: the near side to the right).
 * - phase: where it starts, 0 to 360 degrees.
 * - share: how many of its points are its second colour, 18 % to 34 %. */
export interface OrbSphere {
  seed: number;
  tilt: number;
  spin: 1 | -1;
  phase: number;
  share: number;
}

export function orbSphere(handle: string): OrbSphere {
  const seed = orbSeed(handle);
  return { seed, tilt: 12 + 20 * orbRand(seed, 0, 21), spin: orbRand(seed, 0, 22) < 0.5 ? -1 : 1, phase: 360 * orbRand(seed, 0, 23), share: 0.18 + 0.16 * orbRand(seed, 0, 24) };
}

/** How a sphere looks at a size (lib/orb.ts' levels): how many glyphs, the size of its nearest (in the square's units),
 * its radius, and its nucleus's. Few and large where it is small, many and fine where it is large. */
export interface SphereLook {
  count: number;
  glyph: number;
  r: number;
  nucleus: number;
}

/** A knight's face's sphere, at each size. */
export const KNIGHT_SPHERE: Readonly<Record<OrbLevel, SphereLook>> = {
  badge: { count: 30, glyph: 32, r: 74, nucleus: 24 },
  seat: { count: 72, glyph: 24, r: 72, nucleus: 20 },
  full: { count: 150, glyph: 16, r: 68, nucleus: 17 },
};

/** How much further a sphere turns than its ring (lib/orb-motion.ts' `ring`, in degrees): a whole number, so the turn
 * goes on smoothly where the ring's comes round to 0 again. */
export const SPHERE_TURN = 3;

/** The glyphs, by brightness: six levels, three of each (Phren's ladder), the farthest first. */
export const GLYPH_LADDER: readonly (readonly [string, string, string])[] = [
  [".", "·", "'"],
  ["·", ":", "-"],
  ["+", ":", "="],
  ["o", "+", "x"],
  ["*", "o", "0"],
  ["#", "*", "@"],
];
/** What a glyph becomes when it is data for a moment. */
export const DATA_GLYPHS = "0123456789ABCDEF";

/** How often, in each mood, a glyph is data for its beat (at work it reads more), as a share of its beats. Never while
 * paused or failed. */
export const SPHERE_FLASH: Readonly<Record<OrbMood, number>> = { idle: 0.008, working: 0.03, waiting: 0.015, queued: 0.01, paused: 0, done: 0.01, failed: 0 };

/** A point on the unit sphere (x right, y down, z towards you), whether it is the second colour, and its size (0.7 to 1
 * of its orb's largest). */
export interface SpherePoint {
  x: number;
  y: number;
  z: number;
  second: boolean;
  size: number;
}

/** `count` points spread evenly over the sphere (a Fibonacci lattice: each a golden angle round from the last, from the
 * top to the bottom in even steps). */
export function spherePoints(sphere: OrbSphere, count: number): SpherePoint[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: SpherePoint[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    points.push({ x: r * Math.cos(a), y, z: r * Math.sin(a), second: orbRand(sphere.seed, i, 25) < sphere.share, size: 0.7 + 0.3 * orbRand(sphere.seed, i, 26) });
  }
  return points;
}

/** Glyph `i`'s character at `t` seconds, by its brightness `level` (0 to 5): it keeps one for a slow beat of its own (2
 * to 6 seconds), then another of its level, at random; for `flash` of its beats it is data instead. `fade` is how far
 * it is lit through its beat (0.7 at its ends, where it changes, to 1 in its middle), so a change is soft. */
export function sphereGlyph(seed: number, i: number, level: number, t: number, flash: number): { char: string; data: boolean; fade: number } {
  const beat = 2 + 4 * orbRand(seed, i, 30);
  const at = t / beat + orbRand(seed, i, 31);
  const slot = Math.floor(at);
  const pick = orbRand((seed + Math.imul(slot, 0x9e3779b1)) >>> 0, i, 32);
  const data = flash > 0 && orbRand((seed + Math.imul(slot, 0x85ebca77)) >>> 0, i, 33) < flash;
  const fade = 0.7 + 0.3 * Math.sin(Math.PI * (at - slot));
  const ladder = GLYPH_LADDER[Math.max(0, Math.min(5, level))]!;
  return { char: data ? DATA_GLYPHS[Math.floor(16 * pick)]! : ladder[Math.floor(3 * pick)]!, data, fade };
}

/** A glyph as it is seen: where it is in the square, how near (0 at the back, 1 at the front), its size (its height, in
 * the square's units), how opaque, which of its colour's six shades it takes (0 the farthest), whether that colour is
 * its second, and its character (data or not). */
export interface ShownGlyph {
  x: number;
  y: number;
  near: number;
  size: number;
  alpha: number;
  shade: number;
  second: boolean;
  char: string;
  data: boolean;
}

/**
 * The sphere's glyphs at a moment, the farthest first (where two are as near, the one listed first): turned `angle`
 * degrees about its axis, then its axis leant `tilt` towards you; `radius` in the square's units, `scale` its breath
 * (lib/orb-motion.ts' frame), `glyph` its nearest glyph's size, `t` the time its glyphs change by, and `mood` how often
 * they are data and whether its lower glyphs sag (failed). `paper`: drawn on a light page, where the near glyphs are
 * the deeper and the far ones fade to the page, so it is opaque further back.
 */
export function sphereFrame(
  sphere: OrbSphere,
  points: readonly SpherePoint[],
  options: { angle: number; radius: number; scale: number; glyph: number; t: number; mood: OrbMood; paper?: boolean },
): ShownGlyph[] {
  const a = ((sphere.phase + sphere.spin * options.angle) * Math.PI) / 180;
  const tilt = (sphere.tilt * Math.PI) / 180;
  const [ca, sa, ct, st] = [Math.cos(a), Math.sin(a), Math.cos(tilt), Math.sin(tilt)];
  const reach = options.radius * options.scale;
  const flash = SPHERE_FLASH[options.mood] ?? 0;
  const sag = options.mood === "failed" ? 0.17 * reach : 0;
  const shown = points.map((p, i) => {
    const x = p.x * ca - p.z * sa;
    const z = p.x * sa + p.z * ca;
    const y = p.y * ct - z * st;
    const depth = p.y * st + z * ct;
    const near = (depth + 1) / 2;
    const shade = Math.min(5, Math.floor(near * 6));
    const glyph = sphereGlyph(sphere.seed, i, shade, options.t, flash);
    const alpha = (options.paper ? 0.45 + 0.55 * near : 0.25 + 0.75 * near) * glyph.fade;
    return { i, depth, shown: { x: x * reach, y: y * reach + (y > 0 ? sag * y * y : 0), near, size: options.glyph * p.size * (0.6 + 0.55 * near), alpha, shade, second: p.second, char: glyph.char, data: glyph.data } };
  });
  shown.sort((p, q) => p.depth - q.depth || p.i - q.i);
  return shown.map((each) => each.shown);
}

/** A colour's six shades for a dark page, farthest to nearest: from its shadow two thirds of the way to it, then it,
 * then 30 % and 60 % of the way to its light. */
export function sphereShades(ink: string, light: string, deep: string): string[] {
  return [deep, blendHex(deep, ink, 1 / 3), blendHex(deep, ink, 2 / 3), ink, blendHex(ink, light, 0.3), blendHex(ink, light, 0.6)];
}

/** The same for a light page (Phren's ink on paper): the far side fades towards white, the near side deepens. */
export function paperShades(ink: string, deep: string): string[] {
  return [blendHex(ink, "#ffffff", 0.6), blendHex(ink, "#ffffff", 0.4), blendHex(ink, "#ffffff", 0.18), ink, blendHex(ink, deep, 0.3), blendHex(ink, deep, 0.55)];
}

/** One of a knight's own arcs round its face (Jarvis's rings, each knight's its own): its radius and width, where it
 * starts and how long it is (degrees), and how fast it turns against its ring's turning: once or twice as fast, either
 * way, a whole number so that where the ring comes round to 0 the arc goes on smoothly. */
export interface KnightArc {
  r: number;
  width: number;
  from: number;
  length: number;
  speed: number;
}

/** A knight's arcs at a size: one or two, of lengths and paces its handle gives it; none on a small face. */
export function knightArcs(sphere: OrbSphere, level: OrbLevel): KnightArc[] {
  if (level === "badge") return [];
  const count = 1 + Math.floor(2 * orbRand(sphere.seed, 0, 40));
  return Array.from({ length: count }, (_, k) => ({
    r: 95 - 5 * k,
    width: k ? 1.1 : 1.8,
    from: 360 * orbRand(sphere.seed, k, 41),
    length: 50 + 130 * orbRand(sphere.seed, k, 42),
    speed: (orbRand(sphere.seed, k, 43) < 0.5 ? -1 : 1) * (1 + Math.floor(2 * orbRand(sphere.seed, k, 44))),
  }));
}

/** One place of Galahad's data ring at `t`: whether it is lit (about `share` of them are, by his handle), its hex digit,
 * changing on a slow beat of its own (2.5 to 7 seconds), and how bright it is (0.45 to 0.85). */
export function dataGlyph(seed: number, k: number, t: number, share: number): { char: string; alpha: number } | null {
  if (orbRand(seed, k, 50) >= share) return null;
  const beat = 2.5 + 4.5 * orbRand(seed, k, 51);
  const slot = Math.floor(t / beat + orbRand(seed, k, 52));
  const lot = (seed + Math.imul(slot, 0x9e3779b1)) >>> 0;
  return { char: DATA_GLYPHS[Math.floor(16 * orbRand(lot, k, 53))]!, alpha: 0.45 + 0.4 * orbRand(lot, k, 54) };
}
