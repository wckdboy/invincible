/*
 * Galahad's orb, as data (your word, 23 November 2026: he is the one you talk to, "a Jarvis … like visual, the orb
 * graphic"): a sphere of glyphs round a bright nucleus inside the rings of a heads-up display, with a ring of data
 * turning in it, in the colour of his state. On 25 November 2026 his glass sphere became glyphs, as every knight's orb
 * is (your words: "custom/procedurally generated colored particle orbs", "also update Galahad's orb", "use glyph and
 * randomness on the orbs, like Jarvis/Ultron in the movies, and my other project Phren"); the glyphs are
 * lib/orb-sphere.ts's. Pure: the parts
 * it is drawn from, in a square 200 wide centred on its middle (y down), and each state's colours. How it moves in each
 * mood (your word of 24 November 2026: "pulsing/moving when doing a task, sitting idle, waiting, done") is
 * lib/orb-motion.ts. Nothing in it comes from a name, a profile or a model but his own handle's sphere.
 *
 * Since 26 November 2026 the PWA draws his field instead (lib/field-orb.ts, ui/orb.ts: the glyphs and their bright
 * nucleus read "almost like nipples"), and uses only the tones here. The Apple and Android apps still draw these parts,
 * held to them by the vectors (apps/apple/scripts/vectors.ts), until they port the field (PLAN #60); then they go.
 */

export type OrbTone = "neutral" | "accent" | "warn" | "ok" | "danger";
export const ORB_TONES: readonly OrbTone[] = ["neutral", "accent", "warn", "ok", "danger"];

/**
 * Each state's light (lib/now.ts's tone): a calm blue at rest, a brighter blue at work, amber when something waits on
 * you, green for an answer new to you, red for a failure. The bright tints in both themes: the light theme's darker
 * ones made a bronze ball of him.
 */
const TINTS: Record<OrbTone, string> = { neutral: "#8ab8ff", accent: "#58a6ff", warn: "#f0b549", ok: "#4cc38a", danger: "#ff6b6b" };

/** A state's colours: its tint, the tint lit (45 % of it, with white) and in shadow (52 %, with black), mixed in OKLab. */
export interface OrbPalette {
  tint: string;
  light: string;
  deep: string;
}

/** What a part is coloured with: one of its palette's colours, or white. */
export type OrbInk = keyof OrbPalette | "white";
/** A gradient's stop: how far along it (0 to 1), its colour, and how opaque. */
export interface OrbStop {
  at: number;
  ink: OrbInk;
  opacity: number;
}

/**
 * A part, drawn in order, each over those before it. Angles are degrees clockwise from the top.
 * - disc: a circle filled by a radial gradient, lit from (cx, cy) as fractions of its box, reaching `spread` of its width.
 * - ring: a circle's stroke, whole or only its arcs ([from, to] each).
 * - ticks: `count` short strokes across a circle, evenly round from `offset`, each `length` long and `width` wide.
 * - glyphs: `count` places round a circle `r` from the middle, about `share` of them lit with a hex digit `size` high,
 *   each changing on a slow beat of its own (lib/orb-sphere.ts' dataGlyph): his data ring.
 * - sphere: `count` glyphs on a sphere `r` from the middle, its nearest `glyph` high (lib/orb-sphere.ts), his own
 *   handle's sphere; some of them are `second`'s colour.
 */
export type OrbPart =
  | { name: string; kind: "disc"; r: number; cx: number; cy: number; spread: number; stops: readonly OrbStop[] }
  | { name: string; kind: "ring"; r: number; width: number; ink: OrbInk; opacity: number; arcs: readonly (readonly [from: number, to: number])[] | null }
  | { name: string; kind: "ticks"; r: number; count: number; offset: number; length: number; width: number; ink: OrbInk; opacity: number }
  | { name: string; kind: "glyphs"; r: number; count: number; size: number; share: number; ink: OrbInk }
  | { name: string; kind: "sphere"; r: number; count: number; glyph: number; second: OrbInk };

/** How much of him a size can show: a badge (beside his words), a seat (at the Roundtable), or all of him (his welcome). */
export type OrbLevel = "badge" | "seat" | "full";
/** From these sizes (CSS pixels, points, dp), a seat's rings and then the full display's ticks can be told apart. */
export const ORB_SEAT_FROM = 48;
export const ORB_FULL_FROM = 120;

export const orbLevel = (size: number): OrbLevel => (size >= ORB_FULL_FROM ? "full" : size >= ORB_SEAT_FROM ? "seat" : "badge");

/** The four gaps of the outer ring, at the top, the sides and the foot, where its notches stand. */
const quarters = (gap: number): [number, number][] => [0, 90, 180, 270].map((at) => [at + gap, at + 90 - gap]);
/** Three arcs a third of the way round from each other: the display's segments. */
const thirds: [number, number][] = [[20, 90], [140, 210], [260, 330]];

const stop = (at: number, ink: OrbInk, opacity: number): OrbStop => ({ at, ink, opacity });
const halo: OrbPart = { name: "halo", kind: "disc", r: 99, cx: 0.5, cy: 0.5, spread: 0.5, stops: [stop(0, "tint", 0.55), stop(0.62, "tint", 0.2), stop(1, "tint", 0)] };
// The light the sphere sits in, brightest at its middle: its glyphs are seen against it.
const glow = (r: number): OrbPart => ({ name: "glow", kind: "disc", r, cx: 0.5, cy: 0.5, spread: 0.5, stops: [stop(0, "tint", 0.45), stop(0.55, "tint", 0.16), stop(1, "tint", 0)] });
// The bright nucleus at its heart (Phren's): white at its middle, into his tint, and gone.
const nucleus = (r: number): OrbPart => ({ name: "nucleus", kind: "disc", r, cx: 0.5, cy: 0.5, spread: 0.5, stops: [stop(0, "white", 0.95), stop(0.3, "tint", 0.65), stop(1, "tint", 0)] });
const sphere = (r: number, count: number, glyph: number): OrbPart => ({ name: "sphere", kind: "sphere", r, count, glyph, second: "white" });

const PARTS: Record<OrbLevel, readonly OrbPart[]> = {
  full: [
    halo,
    { name: "ring", kind: "ring", r: 95, width: 1.1, ink: "tint", opacity: 0.5, arcs: quarters(6) },
    { name: "notches", kind: "ticks", r: 95, count: 4, offset: 0, length: 9, width: 1.6, ink: "tint", opacity: 0.8 },
    { name: "ticks", kind: "ticks", r: 89, count: 72, offset: 0, length: 3, width: 0.8, ink: "tint", opacity: 0.45 },
    { name: "marks", kind: "ticks", r: 89, count: 12, offset: 0, length: 7, width: 1.4, ink: "tint", opacity: 0.75 },
    { name: "data", kind: "glyphs", r: 80.5, count: 48, size: 7, share: 0.62, ink: "light" },
    { name: "segments", kind: "ring", r: 72, width: 2.4, ink: "tint", opacity: 0.55, arcs: thirds },
    glow(64),
    nucleus(37),
    sphere(54, 170, 14),
  ],
  seat: [
    halo,
    { name: "ring", kind: "ring", r: 94, width: 2.4, ink: "tint", opacity: 0.55, arcs: quarters(8) },
    { name: "notches", kind: "ticks", r: 94, count: 4, offset: 0, length: 12, width: 3.2, ink: "tint", opacity: 0.85 },
    { name: "segments", kind: "ring", r: 80, width: 4.5, ink: "tint", opacity: 0.5, arcs: thirds },
    glow(74),
    nucleus(44),
    sphere(64, 72, 22),
  ],
  badge: [
    { name: "ring", kind: "ring", r: 94, width: 5, ink: "tint", opacity: 0.5, arcs: null },
    glow(88),
    nucleus(53),
    sphere(70, 30, 30),
  ],
};

/** The parts of an orb this size, in the order they're drawn. */
export const orbParts = (size: number): readonly OrbPart[] => PARTS[orbLevel(size)];

/** A tone the orb knows, or its rest. */
export const orbTone = (tone: unknown): OrbTone => (ORB_TONES.includes(tone as OrbTone) ? (tone as OrbTone) : "neutral");

/**
 * Where he stands at the Roundtable (lib/knight-state.ts' state), as his ring there would show it: blue at work, amber
 * when he needs you, red when his work failed, green for what's new to you, his calm blue otherwise.
 */
const STATE_TONES: Readonly<Record<string, OrbTone>> = { working: "accent", needs: "warn", failed: "danger", verified: "ok", unread: "ok" };
export const orbToneOfState = (state: string | undefined): OrbTone => (state && Object.hasOwn(STATE_TONES, state) ? STATE_TONES[state]! : "neutral");

const PALETTES = Object.fromEntries(
  ORB_TONES.map((tone) => [tone, { tint: TINTS[tone], light: mix(TINTS[tone], "#ffffff", 0.45), deep: mix(TINTS[tone], "#000000", 0.52) }]),
) as Record<OrbTone, OrbPalette>;

export const orbPalette = (tone: OrbTone): OrbPalette => PALETTES[orbTone(tone)];

/** `a` weighing `share` against `b`, mixed in OKLab as CSS's color-mix(in oklab, …) does; both opaque sRGB hex. */
function mix(a: string, b: string, share: number): string {
  const [x, y] = [toOklab(a), toOklab(b)];
  return fromOklab(x.map((value, i) => value * share + y[i]! * (1 - share)) as Lab);
}

type Lab = [number, number, number];
// (Declared, not assigned: the palettes are mixed as the module loads, above.)
function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function gamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toOklab(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map((at) => linear(parseInt(hex.slice(at, at + 2), 16) / 255)) as Lab;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, A, B]: Lab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, gamma(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, "0")).join("")}`;
}
