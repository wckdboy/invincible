import { fieldAt, fieldBuffer, fieldLight, fieldModel, type FieldBuffer, type FieldModel } from "../lib/field.ts";
import {
  FIELD_STROKE, fieldClock, fieldColours, fieldFps, fieldFrame, fieldInk, fieldInks, fieldLook, fieldMotion, fieldStep, fieldStill, fieldTone, GALAHAD_FIELD, GALAHAD_RING, knightField, ringWidth, strokeLight,
  type FieldClock, type FieldFrame, type FieldIdentity, type FieldLook, type FieldMotion,
} from "../lib/field-orb.ts";
import { orbTone, type OrbTone } from "../lib/orb.ts";
import { orbSeed, type OrbMood } from "../lib/orb-motion.ts";
import { h, svg } from "./dom.ts";
import { motionAllowed, move } from "./motion.ts";

/*
 * The orbs (26 November 2026): every orb is Galahad's field (lib/field.ts, lib/field-orb.ts). His is in gold, inside his
 * heads-up ring with its oxblood seat (your word, 23 November 2026: he is the one you talk to, "a Jarvis … like visual,
 * the orb graphic"); a knight's is in its own colours, with no ring (knightFace). Each point of a field is a dot of
 * light added to the others on a dark page (a canvas's "lighter"), with a close, faint glow of its own and no fog; on a
 * light page it is ink. Where it is one of many (a row, a conversation's history) an orb is still, and drawn once;
 * where it is the one you are looking at, it moves as its mood does (lib/field-orb.ts' FIELD_MOTION: slowly; your
 * words of 25 and 26 November 2026, "slow and calming movement", "i dont want them to be too visually distractin"),
 * on the page's one clock (ui/motion.ts), only while on screen, and never where motion is reduced. Nothing in it comes
 * from a name's meaning, a profile's words or a model: a knight's colour is one you chose or its handle's, and its
 * handle gives its field.
 */

export type { OrbTone };

export interface OrbOptions {
  /** Its width and height in CSS pixels (16 to 320; 36 when left out). */
  size?: number;
  /** Where he stands (lib/now.ts' tone): kept on the orb as `data-tone`. His field is gold in every state; his mood
   * moves it, and the words beside him say where he stands. */
  tone?: OrbTone;
  /** Its accessible name ("Galahad: at work"). Leave it out beside the word "Galahad": the orb is then decorative. */
  label?: string;
  /** What he is doing: it moves as that mood does while motion is allowed. Left out: still. */
  mood?: OrbMood;
  /** Which orb it is, so one drawn again (a new state, its page drawn anew) carries on where it was, and a change of mood
   * eases rather than starting afresh. His own when left out: all his orbs move as one. */
  key?: string;
}

/** Galahad's orb: his field in gold inside his heads-up ring. */
export function orb(options: OrbOptions = {}): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(320, options.size!))) : 36;
  const tone = orbTone(options.tone);
  const named = options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" };
  const canvas = fieldCanvas(size, { identity: GALAHAD_FIELD, ringed: true, knight: false, mood: options.mood, key: options.key ?? "galahad" });
  const box = { class: options.mood && canvas ? "orb orb-live" : "orb", "data-tone": tone, ...(options.mood ? { "data-mood": options.mood } : {}), style: `--orb-size:${size}px`, ...named };
  // (Where there is no canvas to draw on, his ring and seat alone.)
  return h("span", box, canvas ?? ringSvg());
}

/** A knight's face options: whose (its handle), its saved avatar (a colour you chose for it, core's knightColors), its
 * size in CSS pixels, and its mood (lib/orb-motion.ts; left out, still: in a row, or as a speaker in a conversation's
 * history). */
export interface KnightFaceOptions {
  id: string;
  profile?: unknown;
  size: number;
  mood?: OrbMood;
  /** Its accessible name; left out, it is decorative (its name is beside it). */
  label?: string;
  /** Which course it moves on, so its face drawn again carries on where it was (`face:<handle>` when left out). */
  key?: string;
}

/**
 * A knight's face: its field in its own colours (lib/field-orb.ts' knightField: the colour you chose or its handle's, and
 * its handle's lines and lean, the same on every device). It moves only while it works (your word, 26 November 2026),
 * turning slowly; in any other mood it is still, in that mood's light (dimmer while paused or queued, its rim red-brown
 * when its work failed). Drawn once wherever it is still.
 */
export function knightFace(options: KnightFaceOptions): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(256, options.size))) : 40;
  const id = String(options.id ?? "");
  const identity = knightField(id, options.profile);
  const named = options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" };
  const canvas = fieldCanvas(size, { identity, ringed: false, knight: true, mood: options.mood, key: options.key ?? `face:${id}` });
  if (canvas) canvas.className = "knight-orb-canvas";
  return h("span", { class: "knight-orb", style: `--orb-size:${size}px`, "data-tint": identity.colours.key[1], ...named }, canvas);
}

// ---- an orb on its canvas ---------------------------------------------------------------------------------------------

/** What is drawn: whose field, in his ring or not, a knight's (which moves only while it works) or his (with embers),
 * in what mood (none: still), and on what course. */
interface Spec {
  identity: FieldIdentity;
  ringed: boolean;
  knight: boolean;
  mood: OrbMood | undefined;
  key: string;
}

/** An orb's canvas, drawn: still and once where it has no mood (from the stills already drawn, where one is the same);
 * in a mood, on its course, moving on the page's clock while it has something to move. Null where there's no canvas. */
function fieldCanvas(size: number, spec: Spec): HTMLCanvasElement | null {
  const prepared = canvasFor(size);
  if (!prepared) return null;
  const { canvas, g, dpr } = prepared;
  canvas.className = "orb-canvas";
  const px = canvas.width;
  const look = fieldLook(spec.identity, size, spec.ringed);
  const motion = spec.mood ? fieldMotion(spec.mood, spec.knight) : STILL;
  // Still: no mood (a row, the history), or a mood with nothing to move (a knight not at work) and no course under way
  // to come to rest from. Drawn once, in its mood's light.
  if (!spec.mood || (!moves(motion) && !courses.has(spec.key))) {
    const frame = fieldStill(motion);
    const paint = () => stamp(g, px, `${who(spec.identity)}|${look.lines}/${look.steps}/${look.weight}/${look.zoom}|${spec.ringed}|${frame.glow}/${frame.rim}|${size}@${dpr}|${paper()}`, (target) => drawField(target, px, dpr, size, spec, look, frame, paper()));
    paint();
    onTheme(canvas, paint);
    return canvas;
  }
  const course = keep(spec.key, motion);
  const seed = orbSeed(spec.key);
  const draw = (t: number, moving: boolean) => {
    const frame = moving ? advance(course, t, seed, !spec.knight) : { ...fieldStill(course.motion), turn: course.clock.turn };
    drawField(g, px, dpr, size, spec, look, frame, paper());
  };
  draw(now(), motionAllowed());
  move(canvas, draw, () => fieldFps(course.clock, course.motion));
  onTheme(canvas, () => draw(now(), motionAllowed()));
  return canvas;
}

/** What a still orb shows: a field at rest, in no mood's light. */
const STILL: FieldMotion = { turn: 0, glow: 1, breath: null, embers: false, rim: 0 };
/** Whether a motion moves anything once it has arrived. */
const moves = (motion: FieldMotion): boolean => motion.turn > 0 || motion.breath !== null || motion.embers;

/** A field's identity as a key (for the models and the stills drawn already). */
const who = (identity: FieldIdentity): string => `${identity.seed}/${identity.tilt.join(",")}/${identity.lines}/${identity.colours.key.join(",")}/${identity.colours.rim}`;

/** Whether the page is light (the app's theme, or the device's when it follows the device): a field is ink there. */
function paper(): boolean {
  if (typeof document === "undefined" || !document.documentElement?.dataset) return false;
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme === "light";
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

// ---- each moving orb's course: its motion and its clock, kept by its key ------------------------------------------

interface Course {
  motion: FieldMotion;
  clock: FieldClock;
  /** The moment its clock was last stepped to. */
  last: number;
}

const courses = new Map<string, Course>();
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

/** An orb's course, by its key: begun settled on first sight, at its rest; drawn again in a new mood, it eases there
 * from where it was. */
function keep(key: string, motion: FieldMotion): Course {
  let course = courses.get(key);
  if (!course) {
    course = { motion, clock: fieldClock(motion), last: now() };
    courses.set(key, course);
  } else course.motion = motion;
  return course;
}

/** Its frame at `t`, its clock stepped on to it first (once a moment, however many of its orbs are drawn). */
function advance(course: Course, t: number, seed: number, embers: boolean): FieldFrame {
  if (t > course.last) {
    course.clock = fieldStep(course.clock, course.motion, t - course.last);
    course.last = t;
  }
  return fieldFrame(course.clock, t, { seed, embers });
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

/** A canvas `size` CSS pixels wide, sharp on this screen (up to three device pixels to one). */
function canvasFor(size: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; dpr: number } | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const canvas = document.createElement("canvas");
  const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!g) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = canvas.height = Math.round(size * dpr);
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.setAttribute("aria-hidden", "true");
  return { canvas, g, dpr };
}

/** A field's model and the buffer its points are written to, made once for each field and look. */
const models = new Map<string, { model: FieldModel; buffer: FieldBuffer }>();
function modelOf(identity: FieldIdentity, look: FieldLook): { model: FieldModel; buffer: FieldBuffer } {
  const key = `${who(identity)}|${look.lines}/${look.steps}/${look.weight}`;
  let made = models.get(key);
  if (!made) {
    const model = fieldModel({ lines: look.lines, steps: look.steps, tilt: identity.tilt, weight: look.weight, colours: identity.colours, seed: identity.seed });
    made = { model, buffer: fieldBuffer(model) };
    if (models.size >= 64) models.delete(models.keys().next().value!);
    models.set(key, made);
  }
  return made;
}

/** How many steps of brightness (or of an ink's opacity) its strokes are drawn in, and of each colour channel. */
const LEVELS = 16;
const HUES = 16;
/** The camera lib/field.ts' project places: 28 degrees across, 8.3 from the core. */
const FOCAL = 1 / Math.tan((14 * Math.PI) / 180);
const DISTANCE = 8.3;

/** What a frame draws, kept from one to the next: each point's place on the canvas and the stroke it belongs to. */
let placed = { x: new Float32Array(0), y: new Float32Array(0), stroke: new Int32Array(0) };
const toned: [number, number, number] = [0, 0, 0];

/**
 * A frame of a field on `g`, a square `px` device pixels wide (`size` CSS pixels at `dpr`): its lines turned as the frame
 * says, as continuous strokes from point to point, each in its light as the icon shows it (lib/field-orb.ts' fieldTone),
 * added to the others on a dark page ("lighter") with a close, faint glow under them; on a light page, in ink. The
 * strokes of one colour and brightness are one path, so a frame is a few dozen draws, not one for each point. Then its
 * embers, and his ring and seat.
 */
function drawField(g: CanvasRenderingContext2D, px: number, dpr: number, size: number, spec: Spec, look: FieldLook, frame: FieldFrame, onPaper: boolean): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, px, px);
  const { model, buffer } = modelOf(spec.identity, look);
  const colours = fieldColours(spec.identity.colours, frame.rim);
  const count = fieldAt(model, frame.turn, buffer, colours === spec.identity.colours ? model.light : fieldLight(colours));
  if (placed.x.length < count) placed = { x: new Float32Array(count), y: new Float32Array(count), stroke: new Int32Array(count) };
  const half = px / 2, f = half * FOCAL * look.zoom;
  const inks = onPaper ? fieldInks(colours) : null;
  const glow = Math.max(0, frame.glow);
  const light = strokeLight(size);
  const q = (v: number, steps: number) => Math.max(0, Math.min(steps - 1, Math.round(v * (steps - 1))));
  for (let i = 0; i < count; i++) {
    const depth = DISTANCE - buffer.z[i]!;
    placed.x[i] = half + (buffer.x[i]! * f) / depth;
    placed.y[i] = half - (buffer.y[i]! * f) / depth;
    let r: number, gg: number, b: number, level: number;
    if (inks) {
      const ink = fieldInk(inks, buffer.lit[i]!, buffer.rim[i]!);
      r = ink.rgb[0] / 255;
      gg = ink.rgb[1] / 255;
      b = ink.rgb[2] / 255;
      level = Math.min(1, ink.alpha * glow);
    } else {
      fieldTone(buffer.r[i]! * glow * light, buffer.g[i]! * glow * light, buffer.b[i]! * glow * light, undefined, toned);
      // Its colour at full brightness, and how bright: so a stroke of one colour can be drawn at a step of brightness.
      level = Math.max(toned[0], toned[1], toned[2]);
      const m = level || 1;
      r = toned[0] / m;
      gg = toned[1] / m;
      b = toned[2] / m;
    }
    // (A stroke: its colour, its channels each in sixteen steps, and how bright or opaque, in sixteen.)
    const shown = q(level, LEVELS);
    placed.stroke[i] = shown === 0 ? -1 : (((q(r, HUES) << 8) | (q(gg, HUES) << 4) | q(b, HUES)) << 4) | shown;
  }
  // Each line's points one after another on it, joined; the strokes of each kind gathered into one path.
  const paths = new Map<number, { path: Path2D | number[]; last: number }>();
  const usePath = typeof Path2D === "function";
  for (let i = 1; i < count; i++) {
    const kind = placed.stroke[i]!;
    if (buffer.at[i] !== buffer.at[i - 1]! + 1 || kind < 0 || placed.stroke[i - 1]! < 0) continue;
    let held = paths.get(kind);
    if (!held) paths.set(kind, (held = { path: usePath ? new Path2D() : [], last: -2 }));
    if (Array.isArray(held.path)) {
      if (held.last !== i - 1) held.path.push(Number.NaN, placed.x[i - 1]!, placed.y[i - 1]!);
      held.path.push(placed.x[i]!, placed.y[i]!);
    } else {
      if (held.last !== i - 1) held.path.moveTo(placed.x[i - 1]!, placed.y[i - 1]!);
      held.path.lineTo(placed.x[i]!, placed.y[i]!);
    }
    held.last = i;
  }
  const weight = look.weight * dpr;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.globalCompositeOperation = onPaper ? "source-over" : "lighter";
  for (const pass of onPaper ? (["line"] as const) : (["glow", "line"] as const)) {
    for (const [kind, held] of paths) {
      const level = (kind & 0xf) / (LEVELS - 1);
      const hue = kind >> 4;
      const channel = (shift: number) => Math.round((((hue >> shift) & 0xf) / (HUES - 1)) * 255);
      const width = (FIELD_STROKE.least + FIELD_STROKE.more * level) * weight * (onPaper ? FIELD_STROKE.ink : 1);
      g.lineWidth = pass === "glow" ? width * FIELD_STROKE.glow.width : width;
      g.strokeStyle = `rgba(${channel(8)},${channel(4)},${channel(0)},${Math.round((pass === "glow" ? level * FIELD_STROKE.glow.alpha : level) * 1000) / 1000})`;
      strokeOf(g, held.path);
    }
  }
  if (frame.embers.length) {
    const [er, eg, eb] = onPaper ? fieldInks(colours).rim : emberLight(colours);
    for (const e of frame.embers) {
      if (e.alpha < 0.01) continue;
      const r = Math.max(0.6 * dpr, e.r * half);
      if (!onPaper) {
        g.fillStyle = `rgba(${Math.round(er)},${Math.round(eg)},${Math.round(eb)},${Math.round(e.alpha * FIELD_STROKE.glow.alpha * 2 * 1000) / 1000})`;
        g.beginPath();
        g.arc(half + e.x * half, half + e.y * half, r * 2.4, 0, 2 * Math.PI);
        g.fill();
      }
      g.fillStyle = `rgba(${Math.round(er)},${Math.round(eg)},${Math.round(eb)},${Math.round(Math.min(1, e.alpha) * 1000) / 1000})`;
      g.beginPath();
      g.arc(half + e.x * half, half + e.y * half, r, 0, 2 * Math.PI);
      g.fill();
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  if (spec.ringed) ring(g, px, ringWidth(size) * dpr, onPaper);
}

/** A path made of strokes: a Path2D, or where the page has none, its points (a NaN before each new start). */
function strokeOf(g: CanvasRenderingContext2D, path: Path2D | number[]): void {
  if (!Array.isArray(path)) return g.stroke(path);
  g.beginPath();
  for (let i = 0; i < path.length; ) {
    if (Number.isNaN(path[i])) {
      g.moveTo(path[i + 1]!, path[i + 2]!);
      i += 3;
    } else {
      g.lineTo(path[i]!, path[i + 1]!);
      i += 2;
    }
  }
  g.stroke();
}

/** An ember's colour on a dark page: its rim's, a third of the way to its key's deep gold. */
function emberLight(colours: { key: [string, string]; rim: string }): [number, number, number] {
  const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [a, b] = [rgb(colours.rim), rgb(colours.key[1])];
  return [0, 1, 2].map((c) => a[c]! + (b[c]! - a[c]!) / 3) as [number, number, number];
}

/** His heads-up ring: five arcs of ink, and his seat at the top in oxblood (lib/field-orb.ts' GALAHAD_RING). */
function ring(g: CanvasRenderingContext2D, px: number, width: number, onPaper: boolean): void {
  const R = GALAHAD_RING;
  const r = px * R.r, c = px / 2;
  const radians = (degrees: number) => ((degrees - 90) * Math.PI) / 180;
  g.lineCap = "butt";
  g.lineWidth = width;
  g.strokeStyle = onPaper ? R.ink.paper : R.ink.dark;
  g.globalAlpha = onPaper ? R.ink.alpha.paper : R.ink.alpha.dark;
  g.beginPath();
  for (const [from, to] of R.arcs) {
    g.moveTo(c + r * Math.cos(radians(from)), c + r * Math.sin(radians(from)));
    g.arc(c, c, r, radians(from), radians(to));
  }
  g.stroke();
  g.globalAlpha = 1;
  g.lineWidth = width * R.seat.width;
  g.strokeStyle = onPaper ? R.oxblood.paper : R.oxblood.dark;
  g.beginPath();
  g.arc(c, c, r, radians(R.seat.from), radians(R.seat.to));
  g.stroke();
}

/** His ring and seat as SVG, where there is no canvas: in the orb's square, 200 wide and centred on its middle. */
function ringSvg(): SVGElement {
  const R = GALAHAD_RING;
  const onPaper = paper();
  const point = (r: number, degrees: number) => {
    const a = (degrees * Math.PI) / 180;
    const round = (n: number) => String(Math.round(n * 1000) / 1000);
    return `${round(r * Math.sin(a))} ${round(-r * Math.cos(a))}`;
  };
  const r = 200 * R.r;
  const arc = (from: number, to: number) => `M${point(r, from)}A${r} ${r} 0 0 1 ${point(r, to)}`;
  return svg(
    "svg",
    { viewBox: "-100 -100 200 200", focusable: "false" },
    svg("path", { class: "orb-ring", d: R.arcs.map(([from, to]) => arc(from, to)).join(""), fill: "none", stroke: onPaper ? R.ink.paper : R.ink.dark, "stroke-width": "3", opacity: String(onPaper ? R.ink.alpha.paper : R.ink.alpha.dark) }),
    svg("path", { class: "orb-seat", d: arc(R.seat.from, R.seat.to), fill: "none", stroke: onPaper ? R.oxblood.paper : R.oxblood.dark, "stroke-width": String(3 * R.seat.width) }),
  );
}

/** A still orb's picture, drawn once and stamped from then on wherever the same orb is still (a knight in twenty rows is
 * drawn once). The latest forty kept, small ones only. */
const stills = new Map<string, HTMLCanvasElement>();
function stamp(g: CanvasRenderingContext2D, px: number, key: string, paint: (target: CanvasRenderingContext2D) => void): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  if (px > 192) {
    paint(g);
    return;
  }
  let made = stills.get(key);
  if (made) stills.delete(key);
  else {
    made = document.createElement("canvas");
    made.width = made.height = px;
    const c = made.getContext("2d");
    if (!c) {
      paint(g);
      return;
    }
    paint(c);
    if (stills.size >= 40) stills.delete(stills.keys().next().value!);
  }
  stills.set(key, made);
  g.clearRect(0, 0, px, px);
  g.drawImage(made, 0, 0);
}

// ---- a change of theme: every orb on the page drawn again in the new one --------------------------------------------

interface Themed {
  canvas: HTMLCanvasElement;
  redraw: () => void;
  born: number;
  seen: boolean;
}
const themed = new Set<Themed>();
let watchingTheme = false;
let prunedAt = 0;

/** Draws `canvas` again with `redraw` whenever the page turns light or dark, while it is on the page. */
function onTheme(canvas: HTMLCanvasElement, redraw: () => void): void {
  themed.add({ canvas, redraw, born: now(), seen: false });
  if (themed.size > 2 * prunedAt + 64) prune();
  if (watchingTheme || typeof document === "undefined") return;
  watchingTheme = true;
  if (typeof MutationObserver === "function" && document.documentElement) new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (typeof matchMedia === "function") matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", themeChanged);
}

function themeChanged(): void {
  prune();
  for (const each of themed) if (each.canvas.isConnected) each.redraw();
}

/** Forgets the orbs that have left the page, and those never put on it within five seconds. */
function prune(): void {
  const t = now();
  for (const each of themed) {
    if (each.canvas.isConnected) each.seen = true;
    else if (each.seen || t - each.born > 5) themed.delete(each);
  }
  prunedAt = themed.size;
}
