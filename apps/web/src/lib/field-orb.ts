import { blendHex, agentColors } from "@invincible/core/avatar";
import { AURUM, FIELD_RIM, linear, project, type FieldColours, type Rgb } from "./field.ts";
import { ORB_LONGEST_STEP, orbRand, orbSeed, type OrbMood } from "./orb-motion.ts";

/*
 * The orbs as fields (26 November 2026): The primary's field (lib/field.ts) is every orb, its in gold with its beam of light
 * through it, each agent's in its own colours. The owner's words: the glyph spheres "still look a little strange/not
 * cool enough, and almost like nipples", and "i dont want them to be too visually distractin"; then, of the heads-up ring
 * it had worn round its field, "remove the old mark around [the primary]. make the primary agent distinct in some other cool
 * way". So a field has no bright middle (its core stays dark), no regular lattice of dots (the icon's rounds said a
 * lattice on a sphere reads as a disco ball), and no ring round it, its or an agent's; it is still where it is one of
 * many, and moves slowly where it is the one you are looking at. Pure: whose field an orb is, how it is drawn at a size,
 * its beam, how it moves in each mood, its embers and its ink on a light page. The PWA draws it (ui/orb.ts); the Apple
 * and Android apps draw the same, held to these numbers by the vectors (apps/apple/scripts/vectors.ts).
 */

/** Whose field an orb is: its seed (its lines' longitudes and widths), its lean (lib/field.ts' tilt), how many lines,
 * and its colours. */
export interface FieldIdentity {
  seed: number;
  tilt: [number, number, number];
  lines: number;
  colours: FieldColours;
}

/** The primary's: the icon's own field, in gold. */
export const PRIMARY_FIELD: Readonly<FieldIdentity> = { seed: 11, tilt: [0.42, 0.3, -0.18], lines: 46, colours: AURUM };

/**
 * An agent's: its colours are core's agentColors (the one you chose for it, or its handle's): its key light its tint
 * lit and its tint, its rim its second colour. Its handle gives the rest: 12 to 20 lines (fewer than its 46, so it reads
 * at 14 px), their longitudes and widths (its seed), and its lean: its axis turned up to about 40 degrees either way in
 * the picture, and leaning towards you by 0.25 to 0.5 (the sine of its angle with the picture), so it is always seen
 * from the side, never end on (a ring round a dark middle) or flat.
 */
export function agentField(id: string, profile?: unknown): FieldIdentity {
  const handle = String(id ?? "");
  const colours = agentColors(handle, profile);
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

/** A field at a size. Its (`primary`) keeps fewer of its 46 lines where it is small, so it reads at 18 px; every field
 * fills its square alike (its no longer drawn in, clear of a ring). The larger, the more points along a line (so its dots
 * stay close), and the smaller, the bolder. */
export function fieldLook(identity: FieldIdentity, size: number, primary: boolean): FieldLook {
  const s = Number.isFinite(size) ? Math.max(8, size) : 36;
  const lines = primary ? Math.min(identity.lines, s < 30 ? 26 : s < 56 ? 34 : 46) : identity.lines;
  return { lines, steps: Math.round(Math.max(20, Math.min(96, s * 0.55))), weight: s <= 24 ? 1.5 : s <= 48 ? 1.25 : 1, zoom: 0.94 };
}

/**
 * Its beam: what marks it out, now its heads-up ring has gone (the owner's word, 26 November 2026: "make the primary
 * agent distinct in some other cool way"). A beam of light along its field's own axis, out of both its poles, as a
 * pulsar's jets go: no agent has one. Each half runs from `from` to `to` of the field's units out
 * of its middle (so the core, r < 0.32, stays dark), `width` of the orb's width across at its root (never under a pixel),
 * narrowing to nothing at its tip, its light fading as it goes (beamAt). On a dark page its light is added as the
 * field's is, with a close glow `glow.width` times as wide and `glow.alpha` as strong (no fog); on a light page it is ink,
 * `ink.width` times as wide and `ink.alpha` times as strong as its light (ink on white reads thinner than light on black),
 * its root never under `ink.least` CSS pixels each side (so at 34 px it holds as a blade, not a needle), its ink fading
 * slower than its light does (beamAt's light to the power `ink.fade`), over a close tint of its ink (`ink.glow`). Its
 * outline is taken at `steps` steps along it. The field turns about it; it shines as the field does, never past its
 * light at rest (breathing while something waits, dimmer while queued or paused, its tip red-brown when its work failed).
 */
export const PRIMARY_BEAM = { from: 0.36, to: 1.72, width: 1 / 40, steps: 16, glow: { width: 3.2, alpha: 0.2 }, ink: { width: 1.6, alpha: 1.5, least: 0.85, fade: 0.6, glow: { width: 3.2, alpha: 0.24 } } } as const;

/** A direction in the field's own space turned as its lean turns its points (lib/field.ts' fieldAt: Rx·Ry·Rz). */
function leaned([x0, y0, z0]: [number, number, number], [ax, ay, az]: [number, number, number]): [number, number, number] {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  let x = x0 * cz - y0 * sz, y = x0 * sz + y0 * cz, z = z0;
  const x2 = x * cy + z * sy, z2 = -x * sy + z * cy;
  x = x2;
  z = z2;
  const y3 = y * cx - z * sx, z3 = y * sx + z * cx;
  return [x, y3, z3];
}

/** Its beam in an orb's square at a zoom (its middle 0, its edge 1; x right, y down, as an ember's): each half's root
 * and tip, along its axis (lib/field.ts' camera, as its points are seen), the upper half first. */
export function beamLine(identity: FieldIdentity, zoom: number): { root: [number, number]; tip: [number, number] }[] {
  const axis = leaned([0, 1, 0], identity.tilt);
  const seen = (k: number): [number, number] => {
    // (Placed as a point is: lib/field.ts' points are its units times 1.05.)
    const q = project({ x: axis[0] * k * 1.05, y: axis[1] * k * 1.05, z: axis[2] * k * 1.05, rgb: [0, 0, 0], size: 0 }, 2, { zoom });
    return [q.x - 1, q.y - 1];
  };
  const L = PRIMARY_BEAM;
  const halves = [1, -1].map((dir) => ({ root: seen(dir * L.from), tip: seen(dir * L.to) }));
  return halves[0]!.tip[1] <= halves[1]!.tip[1] ? halves : [halves[1]!, halves[0]!];
}

/** Along a half of its beam, `u` of the way from its root (0) to its tip (1): its width as a share of the root's (it
 * narrows to a point), how much of its light is left, and how far its colour has gone from its key's lit gold (0) through
 * its gold (0.5) to its rim's copper (1). */
export function beamAt(u: number): { width: number; light: number; hue: number } {
  const t = Math.max(0, Math.min(1, u));
  return { width: Math.pow(1 - t, 0.55), light: Math.pow(1 - t, 1.1), hue: t };
}

// ---- how it moves --------------------------------------------------------------------------------------------------

/**
 * A mood's motion (lib/orb-motion.ts' moods, from where its owner stands), slow and calm (your word, 25 November 2026:
 * "slow and calming movement"):
 * - turn: radians a second it turns about its own axis (0.1 is a turn a minute).
 * - glow: how bright it is, 1 as at rest.
 * - breath: a slow breath of brightness, its seconds and its depth (0.2 is a fifth brighter and dimmer), or none.
 * - embers: whether a few embers drift off its rim and fade (its orb's alone).
 * - rim: how far its burning rim has dimmed towards red-brown, 0 to 1.
 */
export interface FieldMotion {
  turn: number;
  glow: number;
  breath: { period: number; depth: number } | null;
  embers: boolean;
  rim: number;
}

/** the primary's moods: only while something is going on does it move (your word, 26 November 2026: "nothing animating at
 * rest"): at work it turns, embers drifting off its rim; waiting on you it breathes, turning slowly. At rest (idle), done
 * (it settles), queued, paused and failed it comes to rest, still, in its mood's light: dimmer while queued or paused, its
 * rim red-brown when its work failed. (Until 26 November 2026 it turned at rest too, a turn a minute.) */
export const FIELD_MOTION: Readonly<Record<OrbMood, FieldMotion>> = {
  idle: { turn: 0, glow: 1, breath: null, embers: false, rim: 0 },
  working: { turn: 0.2, glow: 1.08, breath: null, embers: true, rim: 0 },
  waiting: { turn: 0.08, glow: 1, breath: { period: 5.2, depth: 0.2 }, embers: false, rim: 0 },
  queued: { turn: 0, glow: 0.85, breath: null, embers: false, rim: 0 },
  paused: { turn: 0, glow: 0.7, breath: null, embers: false, rim: 0 },
  done: { turn: 0, glow: 1, breath: null, embers: false, rim: 0 },
  failed: { turn: 0, glow: 0.88, breath: null, embers: false, rim: 1 },
};

/** An agent's: it moves only while it works (your word, 26 November 2026: still in rows, moving only in its own
 * thread's header while it works), turning as its does at work, with no embers; in every other mood it comes to rest,
 * in that mood's light. */
export function fieldMotion(mood: OrbMood, agent: boolean): FieldMotion {
  const m = FIELD_MOTION[mood] ?? FIELD_MOTION.idle;
  if (!agent) return m;
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
 * mood, 30; while its embers drift (slowly: a frame moves one a third of a pixel at 168 px) or it breathes, 20; only
 * turning, 15; and none once it has come to rest. */
export function fieldFps(clock: FieldClock, motion: FieldMotion): number {
  if (!fieldSettled(clock, motion)) return 30;
  if (clock.embers > 0.01 || clock.depth > 0.002) return 20;
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
 * Its embers, refined (26 November 2026: few, small and slow, so they say it works without pulling the eye): how many;
 * each lives 3.6 to 5.6 seconds (then another sets out); where they set out (a share of the way from the middle to the
 * edge of the orb's square) and how far each drifts; how much they rise as they go; how far round from the rim's burning
 * side they may set out (degrees either way); their radius; and how long each takes to come into sight (a share of its
 * life). Always inside its square. Drawn soft (a light that falls away from its middle), never a hard dot.
 */
export const FIELD_EMBERS = { count: 5, life: [3.6, 5.6], from: [0.58, 0.64], drift: [0.08, 0.15], rise: 0.05, spread: 60, size: [0.012, 0.022], fadeIn: 0.25 } as const;
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
    const fadeIn = Math.min(1, u / E.fadeIn);
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
 * - ink: a line's width on a light page, as a share of its width on a dark one at its largest, the same at every size (a
 *   look's weight, its boldness where small, is for light, which spreads): wider, as ink on paper has no glow to carry it
 *   (until 26 November 2026, 0.85 of the dark page's at each size: the agents read as thin scribbles there).
 * - inkLeast: no line on a light page is narrower than this (CSS pixels), so a 14 px face keeps its lines. (No glow under
 *   them there: a tint of 6 % showed next to nothing and cost a second pass of every stroke, each frame.)
 * - light: how much of its points' light a line shows on a dark page (a line is lit along its length where the icon's
 *   points are dots); less again where it is smaller than `full`, where its lines lie closer and their light adds up.
 */
export const FIELD_STROKE = { least: 0.42, more: 0.5, glow: { width: 3.2, alpha: 0.12 }, ink: 1.35, inkLeast: 0.55, light: 0.22, full: 96 } as const;
/** How much of its points' light a field `size` wide shows on a dark page. */
export const strokeLight = (size: number): number => FIELD_STROKE.light * Math.min(1, size / FIELD_STROKE.full);

/**
 * A field's ink on a light page (26 November 2026: it read as "flat line art" there, the agents' above all, which the icon
 * rounds had turned down): each colour as a saturated ink rather than darkened towards black (which made gold brown and
 * every tint muddy):
 * - key, rim: how far its key's ink and its rim's stand from the page (#fafafa) where fully lit, as a contrast ratio
 *   (3:1 is a graphic's floor; the key, nearer you, stronger);
 * - chroma: how much more saturated each ink is than its colour, as far as sRGB allows at its lightness;
 * - sheen: where the key light strikes hardest (past `from` of its light), its ink goes up to `most` of the way to its lit
 *   colour as an ink `contrast` to 1 from the page: the light page's white-hot, so it reads as lit, not drawn;
 * - floor, curve: how opaque a line is by its light, from `floor` where the lights leave it to whole where it is fully
 *   lit, along `curve` (under 1, it gains sooner): the far lines faint but there, so the field keeps its volume.
 */
export const FIELD_INK = { key: 3.4, rim: 3.1, sheen: { contrast: 2.2, from: 0.55, most: 0.7 }, chroma: 1.2, floor: 0.22, curve: 0.9 } as const;

/** A field's inks on a light page, as sRGB (0 to 255 each): where its key light falls, its key's deep colour as ink, and
 * where its rim burns, its rim's (FIELD_INK). */
export interface FieldInks {
  key: [number, number, number];
  rim: [number, number, number];
  /** Where the key light strikes hardest, its lit colour as a lighter ink: the sheen that says it is lit. */
  sheen: [number, number, number];
}
export function fieldInks(colours: FieldColours): FieldInks {
  // (Worked out once for each field's colours: a frame on a light page reads them, and an ink takes a few hundred steps.)
  const key = `${colours.key[0]}|${colours.key[1]}|${colours.rim}`;
  let inks = inked.get(key);
  if (!inks) {
    inks = { key: inkOf(colours.key[1], FIELD_INK.key), rim: inkOf(colours.rim, FIELD_INK.rim), sheen: inkOf(colours.key[0], FIELD_INK.sheen.contrast) };
    if (inked.size >= 64) inked.delete(inked.keys().next().value!);
    inked.set(key, inks);
  }
  return inks;
}
const inked = new Map<string, FieldInks>();

/** A colour as an ink on the light page: its hue kept, its chroma FIELD_INK.chroma times its own (as far as sRGB goes),
 * and as light as it can be while it stands `contrast` to 1 from the page (or as it is, where it is darker already). */
export function inkOf(hex: string, contrast: number): [number, number, number] {
  const [L, a, b] = oklab(linear(hex));
  const C = Math.hypot(a, b) * FIELD_INK.chroma, h = Math.atan2(b, a);
  const ch = Math.cos(h), sh = Math.sin(h);
  // The most chroma up to C that sRGB holds at a lightness (bisected: 16 steps, under a ten-thousandth of the range,
  // finer than a byte of sRGB can tell).
  const held = (l: number): [number, number, number] => {
    let lo = 0, hi = C;
    if (inGamut(fromOklab(l, C * ch, C * sh))) lo = C;
    else for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(fromOklab(l, mid * ch, mid * sh))) lo = mid;
      else hi = mid;
    }
    return fromOklab(l, lo * ch, lo * sh);
  };
  const most = (PAGE_LUMINANCE + 0.05) / contrast - 0.05;
  let shown = held(L);
  if (relativeLuminance(shown) > most) {
    // As light as it may be: the lightness that stands `contrast` from the page (bisected, 16 steps).
    let lo = 0, hi = L;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (relativeLuminance(held(mid)) > most) hi = mid;
      else lo = mid;
    }
    shown = held(lo);
  }
  return [srgb8(shown[0]), srgb8(shown[1]), srgb8(shown[2])];
}

/** A point's ink on a light page, from the key's light on it and the rim's (lib/field.ts' shadeLit): between its two
 * inks by their shares, and as opaque as it is lit (FIELD_INK's floor and curve), so the field keeps its depth on paper
 * and its far lines don't vanish. */
export function fieldInk(inks: FieldInks, lit: number, rim: number): { rgb: [number, number, number]; alpha: number } {
  const total = lit + rim;
  const share = total > 0 ? rim / total : 0;
  // Where the key strikes hardest (past `sheen.from` of its light), its sheen: up to `sheen.most` of the way to it.
  const S = FIELD_INK.sheen;
  const sheen = S.most * Math.max(0, Math.min(1, (lit - S.from) / (1 - S.from))) * (1 - share);
  const mix = (at: 0 | 1 | 2) => {
    const ink = inks.key[at] + (inks.rim[at] - inks.key[at]) * share;
    return ink + (inks.sheen[at] - ink) * sheen;
  };
  const light = Math.min(1, Math.max(0, lit, rim));
  return { rgb: [mix(0), mix(1), mix(2)], alpha: FIELD_INK.floor + (1 - FIELD_INK.floor) * Math.pow(light, FIELD_INK.curve) };
}

/** fieldInk for each point of each frame on a light page, making nothing: its colour into `out` (0 to 255 a channel) and
 * its opacity as `out[3]`, read from FIELD_INK's curve taken in 1024 steps (within a thousandth of fieldInk's; a stroke is
 * drawn in sixteen steps of it anyway). */
export function fieldInkInto(inks: FieldInks, lit: number, rim: number, out: Float64Array | number[]): void {
  const total = lit + rim;
  const share = total > 0 ? rim / total : 0;
  const S = FIELD_INK.sheen;
  const sheen = S.most * Math.max(0, Math.min(1, (lit - S.from) / (1 - S.from))) * (1 - share);
  for (let c = 0; c < 3; c++) {
    const ink = inks.key[c]! + (inks.rim[c]! - inks.key[c]!) * share;
    out[c] = ink + (inks.sheen[c]! - ink) * sheen;
  }
  out[3] = INK_ALPHA[Math.round(Math.min(1, Math.max(0, lit, rim)) * 1023)]!;
}
const INK_ALPHA = Float64Array.from({ length: 1024 }, (_, i) => FIELD_INK.floor + (1 - FIELD_INK.floor) * Math.pow(i / 1023, FIELD_INK.curve));

// (Colour in OKLab, Björn Ottosson's: a lightness and two axes of hue, so an ink keeps its hue as it darkens.)
/** The light page's own luminance (#fafafa, --bg). */
const PAGE_LUMINANCE = Math.pow((250 / 255 + 0.055) / 1.055, 2.4);
function oklab([r, g, b]: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (rgb: Rgb): boolean => rgb.every((c) => c >= -1e-9 && c <= 1 + 1e-9);
const relativeLuminance = ([r, g, b]: Rgb): number => 0.2126 * Math.max(0, r) + 0.7152 * Math.max(0, g) + 0.0722 * Math.max(0, b);
/** Linear light to an sRGB byte. */
function srgb8(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

function fract(x: number): number {
  return x - Math.floor(x);
}
/** An angle as 0 up to 2π radians. */
function turned(radians: number): number {
  const r = radians % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
}
