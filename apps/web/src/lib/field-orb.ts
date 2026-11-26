import { blendHex, knightColors } from "@galahad/core/avatar";
import { AURUM, FIELD_RIM, type FieldColours } from "./field.ts";
import { ORB_LONGEST_STEP, orbRand, orbSeed, type OrbMood } from "./orb-motion.ts";

/*
 * The orbs as fields (26 November 2026): Galahad's field (lib/field.ts) is every orb, his in gold inside his heads-up
 * ring, each knight's in its own colours. The owner's words: the glyph spheres "still look a little strange/not cool
 * enough, and almost like nipples", and "i dont want them to be too visually distractin". So a field has no bright
 * middle (its core stays dark), no regular lattice of dots (the icon's rounds said a lattice on a sphere reads as a
 * disco ball), and no ring round a knight; it is still where it is one of many, and moves slowly where it is the one
 * you are looking at. Pure: whose field an orb is, how it is drawn at a size, how it moves in each mood, its embers and
 * its ink on a light page. The PWA draws it (ui/orb.ts); the Apple and Android apps will draw the same, held to these
 * numbers by the vectors (apps/apple/scripts/vectors.ts).
 */

/** Whose field an orb is: its seed (its lines' longitudes and widths), its lean (lib/field.ts' tilt), how many lines,
 * and its colours. */
export interface FieldIdentity {
  seed: number;
  tilt: [number, number, number];
  lines: number;
  colours: FieldColours;
}

/** Galahad's: the icon's own field, in gold. */
export const GALAHAD_FIELD: Readonly<FieldIdentity> = { seed: 11, tilt: [0.42, 0.3, -0.18], lines: 46, colours: AURUM };

/**
 * A knight's: its colours are core's knightColors (the one you chose for it, or its handle's): its key light its tint
 * lit and its tint, its rim its second colour. Its handle gives the rest: 12 to 20 lines (fewer than his 46, so it reads
 * at 14 px), their longitudes and widths (its seed), and its lean: its axis turned up to about 40 degrees either way in
 * the picture, and leaning towards you by 0.25 to 0.5 (the sine of its angle with the picture), so it is always seen
 * from the side, never end on (a ring round a dark middle) or flat.
 */
export function knightField(id: string, profile?: unknown): FieldIdentity {
  const handle = String(id ?? "");
  const colours = knightColors(handle, profile);
  const seed = orbSeed(handle);
  const ay = -0.5 + orbRand(seed, 0, 61);
  const az = -0.65 + 1.3 * orbRand(seed, 0, 62);
  const towards = 0.25 + 0.25 * orbRand(seed, 0, 60);
  // The axis (y, before the lean) ends up with z = cos(az)·sin(ax) + sin(az)·sin(ay)·cos(ax) = R·sin(ax + δ): the lean
  // about x that gives it `towards`.
  const a = Math.cos(az), b = Math.sin(az) * Math.sin(ay);
  const ax = Math.asin(towards / Math.hypot(a, b)) - Math.atan2(b, a);
  return { seed: 1 + (seed % 2147483646), tilt: [ax, ay, az], lines: 12 + Math.floor(9 * orbRand(seed, 0, 63)), colours: { key: [colours.light, colours.tint], rim: colours.second } };
}

/** How a field is drawn at a size (CSS pixels, points, dp): how many of its lines, points along each, how bold
 * (lib/field.ts' weight), and how far it reaches in its square (lib/field.ts' zoom: at 1 its widest point is 0.44 to
 * 0.47 of its width from the middle). */
export interface FieldLook {
  lines: number;
  steps: number;
  weight: number;
  zoom: number;
}

/** A field at a size. In Galahad's ring (`ringed`) it is drawn smaller, clear of the ring, and with fewer of his lines
 * where he is small; a knight's fills its square. The larger, the more points along a line (so its dots stay close),
 * and the smaller, the bolder. */
export function fieldLook(identity: FieldIdentity, size: number, ringed: boolean): FieldLook {
  const s = Number.isFinite(size) ? Math.max(8, size) : 36;
  const lines = ringed ? Math.min(identity.lines, s < 30 ? 26 : s < 56 ? 34 : 46) : identity.lines;
  return { lines, steps: Math.round(Math.max(20, Math.min(96, s * 0.55))), weight: s <= 24 ? 1.5 : s <= 48 ? 1.25 : 1, zoom: ringed ? 0.86 : 0.94 };
}

/** Galahad's heads-up ring round his field (as the mockup you chose has it): five arcs of ink a sixth of the way round
 * each, with gaps between, and at the top, alone, his seat in oxblood. Angles are degrees clockwise from the top; the
 * radius and widths are shares of the orb's width, never thinner than a pixel. */
export const GALAHAD_RING = {
  r: 0.465,
  width: 1 / 64,
  arcs: [[38, 82], [98, 142], [158, 202], [218, 262], [278, 322]] as readonly (readonly [number, number])[],
  seat: { from: -15, to: 15, width: 1.8 },
  ink: { dark: "#e8eaf0", paper: "#181a22", alpha: { dark: 0.26, paper: 0.28 } },
  oxblood: { dark: "#c8323f", paper: "#9a1f2b" },
} as const;

/** How wide his ring's line is, in pixels, for an orb `size` pixels wide (its seat's is GALAHAD_RING.seat.width as wide). */
export const ringWidth = (size: number): number => Math.max(1, size * GALAHAD_RING.width);

// ---- how it moves --------------------------------------------------------------------------------------------------

/**
 * A mood's motion (lib/orb-motion.ts' moods, from where its owner stands), slow and calm (your word, 25 November 2026:
 * "slow and calming movement"):
 * - turn: radians a second it turns about its own axis (0.1 is a turn a minute).
 * - glow: how bright it is, 1 as at rest.
 * - breath: a slow breath of brightness, its seconds and its depth (0.2 is a fifth brighter and dimmer), or none.
 * - embers: whether a few embers drift off its rim and fade (his orb's alone).
 * - rim: how far its burning rim has dimmed towards red-brown, 0 to 1.
 */
export interface FieldMotion {
  turn: number;
  glow: number;
  breath: { period: number; depth: number } | null;
  embers: boolean;
  rim: number;
}

/** Galahad's moods: at rest it turns slowly; at work a little quicker, embers drifting off its rim; waiting on you it
 * breathes; queued and paused it dims and slows (paused stops); done, it settles; failed, its rim dims to red-brown. */
export const FIELD_MOTION: Readonly<Record<OrbMood, FieldMotion>> = {
  idle: { turn: 0.1, glow: 1, breath: null, embers: false, rim: 0 },
  working: { turn: 0.2, glow: 1.08, breath: null, embers: true, rim: 0 },
  waiting: { turn: 0.08, glow: 1, breath: { period: 5.2, depth: 0.2 }, embers: false, rim: 0 },
  queued: { turn: 0.06, glow: 0.85, breath: null, embers: false, rim: 0 },
  paused: { turn: 0, glow: 0.7, breath: null, embers: false, rim: 0 },
  done: { turn: 0.035, glow: 1, breath: null, embers: false, rim: 0 },
  failed: { turn: 0.03, glow: 0.88, breath: null, embers: false, rim: 1 },
};

/** A knight's: it moves only while it works (your word, 26 November 2026: still in rows, moving only in its own
 * thread's header while it works), turning as his does at work, with no embers; in every other mood it comes to rest,
 * in that mood's light. */
export function fieldMotion(mood: OrbMood, knight: boolean): FieldMotion {
  const m = FIELD_MOTION[mood] ?? FIELD_MOTION.idle;
  if (!knight) return m;
  return mood === "working" ? { ...m, embers: false } : { ...m, turn: 0, breath: null, embers: false };
}

/** Seconds a speed, a light or a tint takes to ease most of the way (63 %) to a new mood's: a mood arrives over about
 * two seconds. */
export const FIELD_EASE = 0.6;

/** What a field carries from one frame to the next, so a change of mood speeds or slows its turning, brightens or dims
 * it, with no jump:
 * - turn: radians it has turned, 0 to 2π; speed: radians a second now.
 * - glow, rim: its brightness and its rim's dimming now.
 * - depth, breath, period: its breath's depth now, how far through a breath it is (0 to 1), and a breath's seconds (its
 *   mood's, or the last one's while its depth fades).
 * - embers: how much of its embers show, 0 to 1. */
export interface FieldClock {
  turn: number;
  speed: number;
  glow: number;
  rim: number;
  depth: number;
  breath: number;
  period: number;
  embers: number;
}

/** A field as it is first seen: settled in its motion, at its rest (turned 0, a breath not begun). */
export function fieldClock(motion: FieldMotion): FieldClock {
  return { turn: 0, speed: motion.turn, glow: motion.glow, rim: motion.rim, depth: motion.breath?.depth ?? 0, breath: 0, period: motion.breath?.period ?? 6, embers: motion.embers ? 1 : 0 };
}

/** The clock `dt` seconds on, in a motion: each speed and light eased towards the motion's, then turned on. A step longer
 * than a frame takes (a tab coming back) turns nothing a long way at once. */
export function fieldStep(clock: FieldClock, motion: FieldMotion, dt: number): FieldClock {
  const d = Math.min(ORB_LONGEST_STEP, Math.max(0, dt));
  const ease = 1 - Math.exp(-d / FIELD_EASE);
  const toward = (value: number, target: number) => value + (target - value) * ease;
  const speed = toward(clock.speed, motion.turn);
  const period = motion.breath?.period ?? clock.period;
  return {
    turn: turned(clock.turn + speed * d),
    speed,
    glow: toward(clock.glow, motion.glow),
    rim: toward(clock.rim, motion.rim),
    depth: toward(clock.depth, motion.breath?.depth ?? 0),
    breath: fract(clock.breath + d / period),
    period,
    embers: toward(clock.embers, motion.embers ? 1 : 0),
  };
}

/** Whether a clock has come to its motion: nothing left to ease. */
export function fieldSettled(clock: FieldClock, motion: FieldMotion): boolean {
  const near = (a: number, b: number, by = 0.002) => Math.abs(a - b) <= by;
  return near(clock.speed, motion.turn, 0.0005) && near(clock.glow, motion.glow) && near(clock.rim, motion.rim) && near(clock.depth, motion.breath?.depth ?? 0) && near(clock.embers, motion.embers ? 1 : 0, 0.005);
}

/** How many frames a second a field needs now: as few as look smooth (each frame costs a battery). While it eases to a
 * mood or its embers drift, 30; breathing, 20; only turning, 15; and none once it has come to rest. */
export function fieldFps(clock: FieldClock, motion: FieldMotion): number {
  if (!fieldSettled(clock, motion) || clock.embers > 0.01) return 30;
  if (clock.depth > 0.002) return 20;
  return clock.speed > 0.0005 ? 15 : 0;
}

/** An ember: where it is in the orb's square (its middle 0, its edge 1; x right, y down), its radius there, and how
 * opaque. */
export interface FieldEmber {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

/** A moment of a field: how far it is turned, how bright, how far its rim has dimmed, and its embers. */
export interface FieldFrame {
  turn: number;
  glow: number;
  rim: number;
  embers: FieldEmber[];
}

/**
 * His embers: how many; each lives 2.8 to 4.4 seconds (then another sets out); where they set out (a share of the way
 * from the middle to the edge of the orb's square) and how far each drifts; how much they rise as they go; how far
 * round from the rim's burning side they may set out (degrees either way); and their radius. Inside his ring always.
 */
export const FIELD_EMBERS = { count: 7, life: [2.8, 4.4], from: [0.56, 0.64], drift: [0.1, 0.2], rise: 0.06, spread: 70, size: [0.016, 0.028] } as const;
/** Where the rim burns, in degrees clockwise from the top (lib/field.ts' rim light, seen from the front: lower right). */
export const RIM_ANGLE = (Math.atan2(FIELD_RIM[0], FIELD_RIM[1]) * 180) / Math.PI;

/** A field at `t` seconds, as its clock stands: its breath in its brightness, and (where it has them, `embers`) its
 * embers, seeded by `seed` so two never drift as one. */
export function fieldFrame(clock: FieldClock, t: number, options: { seed?: number; embers?: boolean } = {}): FieldFrame {
  const glow = clock.glow * (1 + clock.depth * Math.sin(2 * Math.PI * clock.breath));
  const embers = options.embers && clock.embers > 0.01 ? embersAt((options.seed ?? 0) >>> 0, t, clock.embers) : [];
  return { turn: clock.turn, glow, rim: clock.rim, embers };
}

/** A field still: at its rest (turned 0), in its mood's light (dimmed, or its rim red-brown), with no breath and no
 * embers. What a row shows, a conversation's history, and every orb when motion is reduced. */
export function fieldStill(motion: FieldMotion): FieldFrame {
  return { turn: 0, glow: motion.glow, rim: motion.rim, embers: [] };
}

function embersAt(seed: number, t: number, share: number): FieldEmber[] {
  const E = FIELD_EMBERS;
  const embers: FieldEmber[] = [];
  for (let i = 0; i < E.count; i++) {
    const life = E.life[0] + (E.life[1] - E.life[0]) * orbRand(seed, i, 70);
    const at = t / life + orbRand(seed, i, 71);
    const round = Math.floor(at);
    const u = at - round;
    // Each time it sets out, from somewhere else (as a glyph's beat picks its next, lib/orb-sphere.ts).
    const lot = (seed + Math.imul(round, 0x9e3779b1)) >>> 0;
    const angle = ((RIM_ANGLE + E.spread * (2 * orbRand(lot, i, 72) - 1)) * Math.PI) / 180;
    const reach = E.from[0] + (E.from[1] - E.from[0]) * orbRand(lot, i, 73) + (E.drift[0] + (E.drift[1] - E.drift[0]) * orbRand(lot, i, 74)) * u;
    const fadeIn = Math.min(1, u / 0.15);
    embers.push({
      x: reach * Math.sin(angle),
      y: -reach * Math.cos(angle) - E.rise * u,
      r: (E.size[0] + (E.size[1] - E.size[0]) * orbRand(lot, i, 75)) * (1 - 0.4 * u),
      alpha: share * fadeIn * fadeIn * (3 - 2 * fadeIn) * (1 - u) * (1 - u),
    });
  }
  return embers;
}

// ---- its colours ----------------------------------------------------------------------------------------------------

/** Where a failed field's rim dims to: a red-brown, an ember going out. */
export const RIM_DIM = "#5a2416";

/** A field's colours in a moment: its rim dimmed `rim` of the way (0.7 at most) towards red-brown. */
export function fieldColours(colours: FieldColours, rim: number): FieldColours {
  return rim > 0.001 ? { key: colours.key, rim: blendHex(colours.rim, RIM_DIM, 0.7 * Math.min(1, rim)) } : colours;
}

/** How a point's light is shown on a dark page, as the icon shows it (scripts/field-icon.ts): three.js' ACES filmic tone
 * mapping (r160) at the icon's exposure, to sRGB, 0 to 1 a channel, into `out`. Bright light goes towards white and the
 * faintest towards black, as on film: the lit face pale gold, the rim copper, the far lines all but gone. */
export const FIELD_EXPOSURE = 1.12;
export function fieldTone(r: number, g: number, b: number, exposure = FIELD_EXPOSURE, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const e = exposure / 0.6;
  const x = r * e, y = g * e, z = b * e;
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const f0 = fit(0.59719 * x + 0.35458 * y + 0.04823 * z), f1 = fit(0.076 * x + 0.90834 * y + 0.01566 * z), f2 = fit(0.0284 * x + 0.13383 * y + 0.83777 * z);
  const srgb = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  out[0] = srgb(1.60475 * f0 - 0.53108 * f1 - 0.07367 * f2);
  out[1] = srgb(-0.10208 * f0 + 1.10813 * f1 - 0.00605 * f2);
  out[2] = srgb(-0.00327 * f0 - 0.07276 * f1 + 1.07602 * f2);
  return out;
}

/**
 * How a field's lines are drawn, from point to point along each (CSS pixels, points, dp):
 * - least, more: a line's width, from `least` where it is faintest to `least + more` where brightest, times its look's
 *   weight.
 * - glow: under each line on a dark page, its light again as `width` times as wide and `alpha` as strong: close, so no
 *   fog (your word, 26 November 2026: "less fog, so it reads clearer").
 * - ink: a line's width on a light page, as a share of its width on a dark one.
 * - light: how much of its points' light a line shows on a dark page (a line is lit along its length where the icon's
 *   points are dots); less again where it is smaller than `full`, where its lines lie closer and their light adds up.
 */
export const FIELD_STROKE = { least: 0.42, more: 0.5, glow: { width: 3.2, alpha: 0.12 }, ink: 0.85, light: 0.22, full: 96 } as const;
/** How much of its points' light a field `size` wide shows on a dark page. */
export const strokeLight = (size: number): number => FIELD_STROKE.light * Math.min(1, size / FIELD_STROKE.full);

/** A field's inks on a light page, as sRGB (0 to 255 each): where its key light falls, its key's deep colour darkened
 * (it would be white on white otherwise), and where its rim burns, its rim's, darkened less. */
export interface FieldInks {
  key: [number, number, number];
  rim: [number, number, number];
}
export function fieldInks(colours: FieldColours): FieldInks {
  const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  return { key: rgb(blendHex(colours.key[1], "#000000", 0.38)), rim: rgb(blendHex(colours.rim, "#000000", 0.22)) };
}

/** A point's ink on a light page, from the key's light on it and the rim's (lib/field.ts' shadeLit): between its two
 * inks by their shares, and as opaque as it is lit, faint where it is dark (so the field keeps its depth on paper). */
export function fieldInk(inks: FieldInks, lit: number, rim: number): { rgb: [number, number, number]; alpha: number } {
  const total = lit + rim;
  const share = total > 0 ? rim / total : 0;
  const mix = (at: 0 | 1 | 2) => inks.key[at] + (inks.rim[at] - inks.key[at]) * share;
  return { rgb: [mix(0), mix(1), mix(2)], alpha: Math.min(1, 0.1 + 0.95 * Math.max(lit, rim)) };
}

function fract(x: number): number {
  return x - Math.floor(x);
}
/** An angle as 0 up to 2π radians. */
function turned(radians: number): number {
  const r = radians % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
}
