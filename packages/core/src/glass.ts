import { type AgentMark, MARK_PALETTE, type MarkState, readMarkProfile, snapColor } from "./agent-mark.ts";
import { handleSeed, isOrbProfile } from "./avatar.ts";

/*
 * An agent's glass: a soft shape of our own, lit by a gradient ramp. It replaces the Grille on every surface (the owner,
 * 27 November 2026: "i hate the agent avatars. come up with something else", then the style of a glass-shapes file
 * "for the avatars"; the designer's sheet, shadcn-3/avatars.html, drew 24 shapes of our own in it, and is the
 * specification). Nothing here is copied from that file.
 *
 * Everything is data, so the web, SwiftUI and Compose draw the same thing, held to it by the vectors' `glass`:
 *   - A shape is one path in a 100 × 100 box, of lines and curves alone (its arcs are written as cubics here, once). It
 *     is drawn as a fill (nonzero winding: every part clockwise, its holes the other way) whose round stroke of `width`
 *     softens its corners, or as a tube: a round line `width` wide along it. At 16 px it uses `smallWidth`.
 *   - A ramp is five colours, laid down as one paint over the box (GLASS_PAINT): a diagonal blend from `a` to `b`, a pool
 *     of `accent` at the bottom right, a pool of `highlight` at the top left, and the `deep` shade in the corner. The
 *     light falls from the top left on every shape. There are eight, one for each of the palette's hues, so a colour you
 *     chose keeps its meaning; a ninth, pearl, is the Guardian's.
 *   - Its glow (GLASS_GLOW): on a dark page a pool of its light behind it from 24 px, and a blurred copy of it from 40 px;
 *     on a light page both are a tinted shadow under it. 16 px has none.
 *   - Its state is a dot cut out of what it sits on, beside the word. Only working moves: its light breathes, by opacity
 *     alone, and is still under reduced motion.
 *
 * Who wears what is the node's to give, once, as an agent joins (assignGlass, in the order agents joined), and is saved
 * as its avatar ({v: 4, color, shape}: glassProfile), so every device draws the same and none changes when another comes
 * or goes. The shapes' order is a contract: a saved shape is its index, so a new one is only ever added at the end.
 */

export type GlassFamily = "disc" | "lobes" | "line" | "ring" | "point" | "blob";

export interface GlassShape {
  id: string;
  name: string;
  family: GlassFamily;
  /** A fill, softened by a round stroke `width` wide (0: none), or a tube, a round line `width` wide along its path. */
  kind: "fill" | "tube";
  width: number;
  /** Its width at 16 px: a tube 1.28 times as thick, a fill's corners 3 softer. */
  smallWidth: number;
  /** Its path in the 100 × 100 box: M, L, C, Q and Z alone, absolute. */
  d: string;
}

/* ---------- the designer's geometry (shadcn-3/kit/glass.js), as it drew them ---------- */

const g1 = (n: number): number => +n.toFixed(1);
const gpt = (x: number, y: number): string => `${g1(x)} ${g1(y)}`;
const gRange = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const gPolar = (cx: number, cy: number, r: number, deg: number): [number, number] => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];

/** A circle as two arcs, clockwise; reverse: anticlockwise, which makes a hole. */
function gCircle(cx: number, cy: number, r: number, reverse = false): string {
  const s = reverse ? 0 : 1;
  return `M${gpt(cx - r, cy)}A${g1(r)} ${g1(r)} 0 1 ${s} ${gpt(cx + r, cy)}A${g1(r)} ${g1(r)} 0 1 ${s} ${gpt(cx - r, cy)}Z`;
}
/** A capsule (a pill) of radius r from (x1, y1) to (x2, y2), clockwise. */
function gCapsule(x1: number, y1: number, x2: number, y2: number, r: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1), vx = (-(y2 - y1) / len) * r, vy = ((x2 - x1) / len) * r;
  return `M${gpt(x1 - vx, y1 - vy)}L${gpt(x2 - vx, y2 - vy)}A${g1(r)} ${g1(r)} 0 0 1 ${gpt(x2 + vx, y2 + vy)}` + `L${gpt(x1 + vx, y1 + vy)}A${g1(r)} ${g1(r)} 0 0 1 ${gpt(x1 - vx, y1 - vy)}Z`;
}
/** A petal: an ellipse whose long half-axis a points along deg, centred d out from (cx, cy). Clockwise. */
function gPetal(cx: number, cy: number, d: number, deg: number, a: number, b: number): string {
  const [ex, ey] = gPolar(cx, cy, d, deg), dx = Math.cos((deg * Math.PI) / 180) * a, dy = Math.sin((deg * Math.PI) / 180) * a;
  return `M${gpt(ex - dx, ey - dy)}A${g1(a)} ${g1(b)} ${g1(deg)} 0 1 ${gpt(ex + dx, ey + dy)}A${g1(a)} ${g1(b)} ${g1(deg)} 0 1 ${gpt(ex - dx, ey - dy)}Z`;
}
/** A closed polygon; its corners are rounded by the shape's soft stroke. */
function gPoly(points: readonly (readonly [number, number])[]): string {
  return `M${points.map(([x, y]) => gpt(x, y)).join("L")}Z`;
}
/** The points of an n-pointed star (outer radius R, inner r), clockwise from deg. */
function gStar(cx: number, cy: number, n: number, R: number, r: number, deg = -90): [number, number][] {
  return gRange(n * 2).map((i) => gPolar(cx, cy, i % 2 ? r : R, deg + (i * 180) / n));
}
/** A smooth curve through points (Catmull–Rom, written as cubic Béziers), open or closed. */
function gSmooth(points: readonly [number, number][], closed = false): string {
  const n = points.length, P = (i: number) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))]!;
  let d = `M${gpt(...P(0))}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    d += `C${gpt(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)} ${gpt(p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)} ${gpt(...p2)}`;
  }
  return d + (closed ? "Z" : "");
}
/** A crescent: the disc (cx, cy, R) less a disc (ix, iy, r) that overlaps its edge. */
function gCrescent(cx: number, cy: number, R: number, ix: number, iy: number, r: number): string {
  const d = Math.hypot(ix - cx, iy - cy), a = (R * R - r * r + d * d) / (2 * d), h = Math.sqrt(R * R - a * a);
  const mx = cx + (a * (ix - cx)) / d, my = cy + (a * (iy - cy)) / d, ox = (h * (iy - cy)) / d, oy = (-h * (ix - cx)) / d;
  const [p, q] = [[mx + ox, my + oy] as const, [mx - ox, my - oy] as const];
  // The long way round the outer disc from p to q (away from the bite), then back along the bite's edge.
  return `M${gpt(...p)}A${g1(R)} ${g1(R)} 0 1 0 ${gpt(...q)}A${g1(r)} ${g1(r)} 0 0 1 ${gpt(...p)}Z`;
}
function gSpiral(cx: number, cy: number, r0: number, r1: number, turns: number): [number, number][] {
  const steps = Math.round(turns * 16);
  return gRange(steps + 1).map((i) => gPolar(cx, cy, r0 + (r1 - r0) * (i / steps), -90 + (i / steps) * turns * 360));
}
function gLemniscate(cx: number, cy: number, a: number, n: number): [number, number][] {
  return gRange(n).map((i) => {
    const t = (i / n) * Math.PI * 2, s = Math.sin(t), c = Math.cos(t), k = 1 + s * s;
    return [cx + (a * c) / k, cy + (a * s * c) / k];
  });
}

/* ---------- an arc, written as cubics (SVG's own reckoning, its appendix B.2.4 and B.2.5) ---------- */

const n2 = (n: number): string => String(+n.toFixed(2));

/** An elliptical arc from (x1, y1) to (x2, y2) as cubic Béziers, each of at most a quarter turn: [c1x, c1y, c2x, c2y, x, y]. */
function arcCubics(x1: number, y1: number, rx0: number, ry0: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) [rx, ry] = [rx * Math.sqrt(lambda), ry * Math.sqrt(lambda)];
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num) / den);
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry, vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  let start = angle(1, 0, ux, uy), turn = angle(ux, uy, vx, vy);
  if (!sweep && turn > 0) turn -= 2 * Math.PI;
  else if (sweep && turn < 0) turn += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(turn) / (Math.PI / 2) - 1e-9)), step = turn / parts, k = (4 / 3) * Math.tan(step / 4);
  const at = (px: number, py: number): [number, number] => [cx + rx * cos * px - ry * sin * py, cy + rx * sin * px + ry * cos * py];
  const out: number[][] = [];
  for (let i = 0; i < parts; i++, start += step) {
    const c1 = Math.cos(start), s1 = Math.sin(start), c2 = Math.cos(start + step), s2 = Math.sin(start + step);
    out.push([...at(c1 - k * s1, s1 + k * c1), ...at(c2 + k * s2, s2 - k * c2), ...at(c2, s2)]);
  }
  out[out.length - 1]![4] = x2;
  out[out.length - 1]![5] = y2;
  return out;
}

/** A path of the designer's (absolute M, L, A, C, Q, Z) as lines and curves alone, its numbers to a hundredth. */
function cubicPath(d: string): string {
  const tokens = d.match(/[MLACQZ]|-?\d*\.?\d+/g) ?? [];
  let i = 0, out = "", cx = 0, cy = 0, sx = 0, sy = 0, command = "";
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLACQZ]/.test(tokens[i]!)) command = tokens[i++]!;
    if (command === "M") {
      [cx, cy] = [num(), num()];
      [sx, sy] = [cx, cy];
      out += `M${n2(cx)} ${n2(cy)}`;
      command = "L";
    } else if (command === "L") {
      [cx, cy] = [num(), num()];
      out += `L${n2(cx)} ${n2(cy)}`;
    } else if (command === "C") {
      const p = [num(), num(), num(), num(), num(), num()];
      [cx, cy] = [p[4]!, p[5]!];
      out += `C${p.map(n2).join(" ")}`;
    } else if (command === "Q") {
      const p = [num(), num(), num(), num()];
      [cx, cy] = [p[2]!, p[3]!];
      out += `Q${p.map(n2).join(" ")}`;
    } else if (command === "A") {
      const [rx, ry, rot, large, sweep, x, y] = [num(), num(), num(), num(), num(), num(), num()];
      for (const c of arcCubics(cx, cy, rx!, ry!, rot!, large === 1, sweep === 1, x!, y!)) out += `C${c.map(n2).join(" ")}`;
      [cx, cy] = [x!, y!];
    } else if (command === "Z") {
      out += "Z";
      [cx, cy] = [sx, sy];
      command = "";
    } else throw new Error(`a path of the glass's has a command it can't write: ${command}`);
  }
  return out;
}

/* ---------- the shapes: 22 of our own ---------- */

type Drawn = { id: string; name: string; tube?: number; soft?: number; d: string };
/** The designer's 24, less Sprout and Zigzag (they read as V and W): their order is the saved index's. */
const DRAWN: Drawn[] = [
  { id: "bolt", name: "Bolt", tube: 12, d: gPoly([[58, 15], [35, 54], [61, 49], [42, 86]]).replace("Z", "") },
  { id: "ring", name: "Ring", tube: 15, d: gCircle(50, 50, 28) },
  { id: "loop", name: "Loop", tube: 11.5, d: gSmooth(gLemniscate(50, 50, 37, 24), true) },
  { id: "spiral", name: "Spiral", tube: 10.5, d: gSmooth(gSpiral(50, 51, 3, 32, 1.15)) },
  { id: "arch", name: "Arch", tube: 16, d: `M${gpt(23, 68)}A27 27 0 0 1 ${gpt(77, 68)}` },
  { id: "triangle", name: "Triangle", tube: 12, d: gPoly([[50, 22], [80, 74], [20, 74]]) },
  { id: "bloom", name: "Bloom", soft: 3, d: gCircle(50, 50, 10) + gRange(6).map((i) => gPetal(50, 50, 17.5, -90 + i * 60, 16, 10.5)).join("") },
  { id: "clover", name: "Clover", soft: 4, d: [[0, -16.5], [16.5, 0], [0, 16.5], [-16.5, 0]].map(([x, y]) => gCircle(50 + x!, 50 + y!, 16.5)).join("") },
  { id: "trefoil", name: "Trefoil", soft: 4, d: [-90, 30, 150].map((a) => gCircle(...gPolar(50, 53, 16, a), 18.5)).join("") },
  { id: "blossom", name: "Blossom", soft: 3, d: gRange(5).map((i) => gCircle(...gPolar(50, 51, 20.5, -90 + i * 72), 14.5)).join("") },
  { id: "diamond", name: "Diamond", soft: 10, d: gPoly([[50, 17], [82, 50], [50, 83], [18, 50]]) },
  {
    id: "blob",
    name: "Blob",
    soft: 3,
    d: gSmooth(gRange(8).map((i) => gPolar(50, 50, [34, 27, 35, 28.5, 34.5, 26, 33, 29.5][i]!, i * 45 - 20)), true) + gCircle(40, 43, 7.5, true) + gCircle(60, 58, 7, true),
  },
  { id: "pill", name: "Pill", soft: 0, d: gCapsule(32, 68, 68, 32, 17.5) },
  { id: "cross", name: "Cross", soft: 2, d: gCapsule(27, 27, 73, 73, 11) + gCapsule(73, 27, 27, 73, 11) },
  {
    id: "asterisk",
    name: "Asterisk",
    soft: 2,
    d: [90, 30, 150]
      .map((a) => {
        const [x1, y1] = gPolar(50, 50, 30, a), [x2, y2] = gPolar(50, 50, 30, a + 180);
        return gCapsule(x1, y1, x2, y2, 8.5);
      })
      .join(""),
  },
  { id: "sparkle", name: "Sparkle", soft: 6, d: "M50 15Q55.5 44.5 85 50Q55.5 55.5 50 85Q44.5 55.5 15 50Q44.5 44.5 50 15Z" },
  { id: "nova", name: "Nova", soft: 9, d: gPoly(gStar(50, 50, 6, 34, 20)) },
  { id: "scallop", name: "Scallop", soft: 2, d: gCircle(50, 50, 24) + gRange(10).map((i) => gCircle(...gPolar(50, 50, 25.5, i * 36), 9.5)).join("") },
  { id: "drop", name: "Drop", soft: 4, d: "M50 15C58 29 73.5 42 73.5 60A23.5 23.5 0 0 1 26.5 60C26.5 42 42 29 50 15Z" },
  { id: "crescent", name: "Crescent", soft: 3, d: gCrescent(48, 52, 33, 64, 38, 26) },
  { id: "nut", name: "Nut", soft: 12, d: gPoly(gRange(6).map((i) => gPolar(50, 50, 30, i * 60))) + gCircle(50, 50, 16.5, true) },
  { id: "pebbles", name: "Pebbles", soft: 2, d: gCircle(50, 29, 14) + gCircle(29.5, 65, 14) + gCircle(70.5, 65, 14) },
];

/** Silhouette families: the rule spreads agents across them, so no two round blobs sit side by side at 16 px. */
export const GLASS_FAMILIES: Readonly<Record<string, GlassFamily>> = {
  scallop: "disc", blossom: "disc", clover: "disc", bloom: "disc", trefoil: "lobes", pebbles: "lobes",
  pill: "line", cross: "line", asterisk: "line", bolt: "line", ring: "ring", nut: "ring", loop: "ring",
  spiral: "ring", arch: "ring", crescent: "ring", nova: "point", sparkle: "point", diamond: "point", triangle: "point",
  drop: "point", blob: "blob",
};

const shapeOf = (s: Drawn): GlassShape => {
  const kind = s.tube ? "tube" : "fill";
  const width = s.tube ?? s.soft ?? 0;
  return { id: s.id, name: s.name, family: GLASS_FAMILIES[s.id]!, kind, width, smallWidth: kind === "tube" ? g1(width * 1.28) : width + 3, d: cubicPath(s.d) };
};

export const GLASS_SHAPES: readonly GlassShape[] = DRAWN.map(shapeOf);
export const GLASS_SHAPE_COUNT = GLASS_SHAPES.length;

/** The I-beam of the app icon (the Guardian's mark, on its own tile in one ink), and its glass form for pearl. */
export const IBEAM_POINTS: readonly (readonly [number, number])[] = [[22, 14], [78, 14], [78, 30], [59, 30], [59, 70], [78, 70], [78, 86], [22, 86], [22, 70], [41, 70], [41, 30], [22, 30]];
export const GLASS_IBEAM: GlassShape = { ...shapeOf({ id: "ibeam", name: "I-beam", soft: 9, d: gPoly(IBEAM_POINTS.map(([x, y]) => [50 + (x - 50) * 0.92, 50 + (y - 50) * 0.92])) }), family: "point" };

/* ---------- the ramps ---------- */

export interface GlassStops {
  highlight: string;
  a: string;
  b: string;
  accent: string;
  deep: string;
}
export interface GlassRamp {
  id: string;
  name: string;
  light: GlassStops;
  dark: GlassStops;
}

/**
 * The designer's ramps in OKLCH (highlight, a, b, accent, deep; light page, dark page): kept for the record, and so
 * glass.test.ts brings them into sRGB again (CSS Color 4's gamut mapping) and finds GLASS_RAMPS. Citrus and Meadow are
 * deeper on a light page, so they hold on white.
 */
export const GLASS_RAMP_OKLCH: Readonly<Record<string, { light: readonly (readonly number[])[]; dark: readonly (readonly number[])[] }>> = {
  ember: { light: [[0.95, 0.06, 70], [0.74, 0.17, 55], [0.62, 0.21, 25], [0.86, 0.16, 90], [0.42, 0.15, 25]], dark: [[0.97, 0.05, 70], [0.8, 0.16, 55], [0.68, 0.2, 25], [0.9, 0.15, 90], [0.32, 0.11, 25]] },
  citrus: { light: [[0.95, 0.08, 110], [0.76, 0.17, 115], [0.56, 0.16, 145], [0.78, 0.15, 85], [0.36, 0.1, 150]], dark: [[0.98, 0.07, 110], [0.9, 0.17, 110], [0.74, 0.19, 145], [0.88, 0.15, 85], [0.34, 0.09, 150]] },
  meadow: { light: [[0.95, 0.07, 155], [0.68, 0.15, 155], [0.52, 0.1, 185], [0.8, 0.15, 120], [0.34, 0.08, 185]], dark: [[0.97, 0.06, 155], [0.84, 0.15, 155], [0.7, 0.12, 185], [0.9, 0.16, 120], [0.32, 0.08, 185]] },
  lagoon: { light: [[0.94, 0.06, 205], [0.72, 0.13, 205], [0.56, 0.18, 255], [0.76, 0.13, 170], [0.38, 0.13, 255]], dark: [[0.97, 0.04, 205], [0.8, 0.13, 205], [0.64, 0.17, 255], [0.82, 0.13, 170], [0.3, 0.1, 255]] },
  glacier: { light: [[0.96, 0.04, 230], [0.78, 0.11, 230], [0.6, 0.15, 268], [0.84, 0.1, 195], [0.4, 0.12, 268]], dark: [[0.98, 0.03, 230], [0.86, 0.1, 230], [0.7, 0.14, 268], [0.9, 0.1, 195], [0.32, 0.1, 268]] },
  aurora: { light: [[0.93, 0.07, 330], [0.7, 0.19, 330], [0.56, 0.21, 275], [0.72, 0.15, 235], [0.38, 0.15, 275]], dark: [[0.97, 0.04, 330], [0.78, 0.18, 330], [0.64, 0.2, 275], [0.78, 0.14, 235], [0.3, 0.12, 275]] },
  dusk: { light: [[0.94, 0.05, 290], [0.66, 0.16, 290], [0.66, 0.18, 25], [0.78, 0.15, 150], [0.36, 0.1, 290]], dark: [[0.96, 0.04, 290], [0.74, 0.15, 290], [0.74, 0.17, 25], [0.84, 0.15, 150], [0.3, 0.09, 290]] },
  orchid: { light: [[0.94, 0.06, 350], [0.72, 0.18, 350], [0.58, 0.2, 305], [0.74, 0.15, 25], [0.4, 0.15, 305]], dark: [[0.97, 0.04, 350], [0.8, 0.16, 350], [0.66, 0.19, 305], [0.8, 0.14, 25], [0.32, 0.12, 305]] },
  pearl: { light: [[0.7, 0.016, 270], [0.41, 0.018, 290], [0.27, 0.017, 230], [0.5, 0.031, 85], [0.16, 0.009, 260]], dark: [[0.99, 0.01, 270], [0.9, 0.025, 290], [0.74, 0.035, 230], [0.9, 0.07, 85], [0.36, 0.03, 260]] },
};

/**
 * The eight agent ramps in sRGB, in the palette's order: ramp n is MARK_PALETTE[n]'s, so a colour you chose keeps its
 * meaning. Paired by hue (27 November 2026): each ramp's paint over a disc, averaged in OKLab, matched to the palette's
 * hues with the least squared distance in all (Amber–Ember 23°, Lime–Citrus 5°, Green–Meadow 0°, Teal–Lagoon 31°,
 * Sky–Glacier 6°, Blue–Aurora 20°, Violet–Dusk 29°, Magenta–Orchid 3°).
 */
export const GLASS_RAMPS: readonly GlassRamp[] = [
  { id: "ember", name: "Ember", light: { highlight: "#ffe8c4", a: "#fa8927", b: "#ea3c3f", accent: "#facb39", deep: "#8d1a1e" }, dark: { highlight: "#fff0d1", a: "#ff9f4d", b: "#fc5855", accent: "#ffd95a", deep: "#5f1113" } },
  { id: "citrus", name: "Citrus", light: { highlight: "#f1f4b6", a: "#afbc0d", b: "#218b30", accent: "#e3ae28", deep: "#004b1e" }, dark: { highlight: "#fbfdc7", a: "#e5e74d", b: "#4bc957", accent: "#ffcf53", deep: "#05441d" } },
  { id: "meadow", name: "Meadow", light: { highlight: "#cafdda", a: "#32b36e", b: "#007b70", accent: "#b2cb52", deep: "#00453d" }, dark: { highlight: "#d6ffe4", a: "#6fe79f", b: "#17b6a8", accent: "#d1ed6a", deep: "#003f38" } },
  { id: "lagoon", name: "Lagoon", light: { highlight: "#bcf8fe", a: "#00bbcb", b: "#0a72da", accent: "#43cba4", deep: "#004085" }, dark: { highlight: "#d7feff", a: "#2ad5e5", b: "#388cf0", accent: "#5bdfb7", deep: "#002c5e" } },
  { id: "glacier", name: "Glacier", light: { highlight: "#d8f8ff", a: "#64c4f0", b: "#5a79d9", accent: "#73dfdf", deep: "#2c4188" }, dark: { highlight: "#e5fdff", a: "#88deff", b: "#7999f5", accent: "#87f3f2", deep: "#1d2e65" } },
  { id: "aurora", name: "Aurora", light: { highlight: "#ffd8ff", a: "#dd6cd6", b: "#575eec", accent: "#12b2f4", deep: "#2f3390" }, dark: { highlight: "#ffecff", a: "#f689ed", b: "#6d7aff", accent: "#48c5ff", deep: "#202268" } },
  { id: "dusk", name: "Dusk", light: { highlight: "#eae6ff", a: "#927eec", b: "#ec5b57", accent: "#67d283", deep: "#3e316d" }, dark: { highlight: "#f1eeff", a: "#aa98ff", b: "#ff7a73", accent: "#7ce695", deep: "#2e2357" } },
  { id: "orchid", name: "Orchid", light: { highlight: "#ffdbf1", a: "#f46eb4", b: "#9751d7", accent: "#fb817a", deep: "#5b2987" }, dark: { highlight: "#ffebf9", a: "#ff90cc", b: "#ae6dee", accent: "#ff9890", deep: "#421c62" } },
];

/**
 * The Guardian's, when it wears glass: pearl on a dark page, glowing on its own; on a light one the pearl inked, a darker
 * glass at its own hues, on nothing (the owner's word of 27 November 2026: the logo is just the I-beam, so no tile
 * anywhere, pearl's on a light page too).
 */
export const GLASS_PEARL: GlassRamp = { id: "pearl", name: "Pearl", light: { highlight: "#9a9ea9", a: "#4a4954", b: "#1e282d", accent: "#6b624f", deep: "#0b0d11" }, dark: { highlight: "#f9fcff", a: "#dddcee", b: "#95afbd", accent: "#f3dba9", deep: "#343e4d" } };

/**
 * The paint, in the shape's 100 × 100 box, its layers in this order: `a` to `b` along the diagonal; `accent` in a pool
 * at the bottom right, fading from `opacity` to nothing at its radius; `highlight` in a pool at the top left (its
 * opacity at each stop); and the `deep` shade in the bottom-right corner, at `opacity` for the page, to nothing.
 */
export const GLASS_PAINT = {
  blend: { from: [0, 0], to: [100, 100] },
  accent: { at: [82, 78], r: 55, opacity: 0.95 },
  highlight: { at: [27, 20], r: 50, stops: [[0, 0.95], [0.45, 0.38], [1, 0]] },
  shade: { at: [96, 100], r: 82, opacity: { light: 0.42, dark: 0.72 } },
} as const;

/**
 * Its glow, by the avatar's size in points. On a dark page a pool of its light behind it from 24 (a circle 160 % of the
 * avatar, `a` at 46 % to `b` at 16 % by 64 % of its radius, then nothing); on a light page a tinted shadow under it
 * from 20 (`b` at 30 % to nothing, over the box's bottom from 64 % to 116 %, inset 4 % each side). From 40 a blurred
 * copy of the shape (a Gaussian of `radius` in the box) at the page's opacity, moved down `dy` on a light page. Only
 * working breathes: the pool and the shadow from `breathe` to their full opacity and back, every `period` seconds.
 */
export const GLASS_GLOW = {
  pool: { minSize: 24, spread: 0.3, stops: [[0, "a", 0.46], [0.64, "b", 0.16], [1, "b", 0]], opacity: { light: 0, dark: 0.7 }, breathe: 0.45 },
  shadow: { minSize: 20, box: { left: 0.04, right: 0.04, top: 0.64, bottom: 1.16 }, stops: [[0, "b", 0.3], [1, "b", 0]], opacity: { light: 0.9, dark: 0 }, breathe: 0.55 },
  blur: { minSize: 40, radius: 6.5, opacity: { light: 0.32, dark: 0.7 }, dy: { light: 7, dark: 0 } },
  period: 3.6,
} as const;

/* ---------- its state: a dot and the word ---------- */

export const GLASS_STATES = ["working", "needs", "idle", "failed"] as const;
export type GlassState = (typeof GLASS_STATES)[number];

/** The dot an agent shows for what its mark would (core's markState): working, needs and failed are their own; the rest
 * (idle, queued, paused, done) are idle, and the word beside it says which. */
export function glassState(state: MarkState): GlassState {
  return state === "working" || state === "needs" || state === "failed" ? state : "idle";
}

/** The dots' colours (the designs' state colours; idle is a ring in it, the page inside), and their size by the avatar's:
 * diameter, how far past the box's bottom-right corner it sits, and the ring of the page that cuts it out. */
export const GLASS_DOT = {
  colors: {
    working: { light: "#155dfc", dark: "#51a2ff" },
    needs: { light: "#e17100", dark: "#ffba00" },
    failed: { light: "#e7000b", dark: "#ff6467" },
    idle: { light: "#a1a1a1", dark: "#737373" },
  },
  idleRing: 1.5,
  sizes: [
    { upTo: 16, size: 6, out: 2, cut: 1.5 },
    { upTo: 28, size: 8, out: 2, cut: 2 },
    { upTo: 40, size: 10, out: 1, cut: 2 },
    { upTo: 1000, size: 13, out: -1, cut: 3 },
  ],
} as const;

/* ---------- who wears what ---------- */

/** An agent's glass: its colour (an index into MARK_PALETTE, and so into GLASS_RAMPS) and its shape (into GLASS_SHAPES). */
export interface Glass {
  color: number;
  shape: number;
}

/** A glass as an agent's avatar saves it: its colour as its light form in the palette, and its shape. */
export interface GlassProfile {
  v: 4;
  color: string;
  shape: number;
}

const paletteIndex = (hex: string): number => MARK_PALETTE.findIndex((hue) => hue.light === hex);

/** A saved glass, read strictly: exactly v 4, a colour that is one of the eight (its light form) and a whole shape. */
export function isGlassProfile(profile: unknown): profile is GlassProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const p = profile as Record<string, unknown>;
  return Object.keys(p).length === 3 && p.v === 4 && typeof p.color === "string" && paletteIndex(p.color) >= 0 && Number.isInteger(p.shape) && (p.shape as number) >= 0 && (p.shape as number) < GLASS_SHAPE_COUNT;
}

export function readGlassProfile(profile: unknown): Glass | null {
  return isGlassProfile(profile) ? { color: paletteIndex(profile.color), shape: profile.shape } : null;
}

export function glassProfile(glass: Glass): GlassProfile {
  return { v: 4, color: MARK_PALETTE[glass.color]!.light, shape: glass.shape };
}

/** A handle's own glass, before any is given: its seed's shape and colour (what the rule gives an agent with none before it). */
function seeded(id: string): Glass {
  const seed = handleSeed(id);
  return { shape: seed % GLASS_SHAPE_COUNT, color: (seed >>> 7) % MARK_PALETTE.length };
}

/**
 * An agent's glass, from what it has: its own (v 4); a mark's colour (v 3) or a colour chosen before the marks (v 2),
 * snapped, with its handle's shape; else its handle's (an avatar of a version yet to come too). The node gives every
 * agent its own; the rest are for a profile that came from elsewhere.
 */
export function glassOf(id: string, profile?: unknown): Glass {
  const own = readGlassProfile(profile);
  if (own) return own;
  const handle = seeded(String(id ?? ""));
  const mark: AgentMark | null = readMarkProfile(profile);
  if (mark) return { color: mark.color, shape: handle.shape };
  return isOrbProfile(profile) ? { color: snapColor(profile.color), shape: handle.shape } : handle;
}

/**
 * The glass a node gives an agent as it joins, after `others` (the glass of the agents here before it, in the order they
 * joined). Its shape: among those no agent wears, the one from the least-used silhouette family, tried in the order its
 * handle's seed gives; once all are worn, the least worn, then the least-used family, then that order. Its colour: the
 * one you chose (snapped to the eight), else the least worn, tried from its seed's, and never the same as either of the
 * two agents before it. Twelve agents so wear twelve shapes of all six families, and all eight colours, four twice.
 */
export function assignGlass(id: string, others: readonly Glass[], chosen?: string | number | null): Glass {
  const seed = handleSeed(String(id ?? ""));
  const wear = GLASS_SHAPES.map((_, n) => others.filter((g) => g.shape === n).length);
  const familyUse = (family: GlassFamily) => others.filter((g) => GLASS_SHAPES[g.shape]?.family === family).length;
  const free = wear.some((w) => w === 0);
  let shape = -1;
  for (let i = 0; i < GLASS_SHAPE_COUNT; i++) {
    const c = (seed + i) % GLASS_SHAPE_COUNT;
    if (free && wear[c]! > 0) continue;
    if (shape < 0) shape = c;
    else if (wear[c]! < wear[shape]! || (wear[c] === wear[shape] && familyUse(GLASS_SHAPES[c]!.family) < familyUse(GLASS_SHAPES[shape]!.family))) shape = c;
  }
  let color: number;
  if (typeof chosen === "number" && chosen >= 0 && chosen < MARK_PALETTE.length) color = chosen;
  else if (typeof chosen === "string" && chosen) color = snapColor(chosen);
  else {
    const recent = others.slice(-2).map((g) => g.color);
    const worn = MARK_PALETTE.map((_, n) => others.filter((g) => g.color === n).length);
    color = -1;
    for (let i = 0; i < MARK_PALETTE.length; i++) {
      const c = ((seed >>> 7) + i) % MARK_PALETTE.length;
      if (recent.includes(c)) continue;
      if (color < 0 || worn[c]! < worn[color]!) color = c;
    }
  }
  return { color, shape };
}

/**
 * A node's agents given their glass, in the order they joined (core's joinOrder), as they had it: a glass of their own
 * (v 4) is kept; a mark (v 3) keeps its colour and gets a shape; a colour chosen before the marks (v 2) keeps it, snapped;
 * anything else gets both. Each after the ones before it, by the rule.
 */
export function backfillGlass(agents: readonly { id: string; avatar?: unknown }[]): Glass[] {
  const out: Glass[] = [];
  for (const agent of agents) {
    const own = readGlassProfile(agent.avatar);
    if (own) {
      out.push(own);
      continue;
    }
    const mark = readMarkProfile(agent.avatar);
    const chosen = mark ? mark.color : isOrbProfile(agent.avatar) ? agent.avatar.color : null;
    out.push(assignGlass(agent.id, out, chosen));
  }
  return out;
}
