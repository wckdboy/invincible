/*
 * The agents' orbs as invincible.sh shows them: the app's own drawing (apps/web/src/ui/orb.ts' paintField, which draws
 * every orb in the app on a canvas), done once when the site is built, onto a 2D context that writes SVG instead of
 * pixels. So an agent's field on the site is the app's, line for line and colour for colour, sharp at any screen's
 * density, with no script on the page. The agents are the only colour on the site (the owner's word, 26 November 2026:
 * monochrome, colour for the agents alone, so they are told apart at a glance, and for a real failure); your agent is
 * the I-beam, in ink (mark.ts).
 *
 * Each is still, at rest (nothing moves at rest), and drawn twice: as light added to light for a dark page, and as ink
 * for a light one. Pure and deterministic: the same SVG from the same repository, every build.
 */
import { paintField } from "../../../web/src/ui/orb.ts";
import { agentField, FIELD_MOTION, fieldStill } from "../../../web/src/lib/field-orb.ts";

/** An orb drawn for both pages: its size (the SVG's own units are CSS pixels), and its two drawings. */
export interface OrbSvg {
  size: number;
  /** As light, for a dark page: every shape added to what is under it (`plus-lighter`, as the app's canvas adds). */
  dark: string;
  /** As ink, for a light page. */
  light: string;
}

/**
 * An agent's orb, by its handle (its colours and its field are its handle's, as in the app: lib/field-orb.ts'
 * agentField), `size` CSS pixels across, at rest, as an SVG file for each page.
 */
export function agentOrbSvg(handle: string, size: number): OrbSvg {
  const field = { identity: agentField(handle), beam: false, primary: false };
  const draw = (paper: boolean) => {
    const g = new SvgContext(size);
    paintField(g as unknown as CanvasRenderingContext2D, size, 1, field, fieldStill(FIELD_MOTION.idle), paper);
    return g.svg(`o${paper ? "l" : "d"}`, paper ? "ink" : "light");
  };
  return { size, dark: draw(false), light: draw(true) };
}

// ---- a 2D context that writes SVG ------------------------------------------------------------------------------------

type Gradient =
  | { kind: "linear"; x0: number; y0: number; x1: number; y1: number; stops: [number, string][] }
  | { kind: "radial"; x0: number; y0: number; r0: number; x1: number; y1: number; r1: number; stops: [number, string][] };
type Paint = string | Gradient;
type Subpath = { points: number[]; closed: boolean } | { circle: [number, number, number] };
interface Shape {
  op: "stroke" | "fill";
  path: Subpath[];
  paint: Paint;
  width: number;
  composite: string;
}

/**
 * What paintField uses of a CanvasRenderingContext2D, and no more: lines, circles, linear and radial gradients, a
 * width, round caps and joins, and how a shape is laid over what is under it. Anything else it is asked fails, loudly,
 * so a change in the app's drawing can't quietly draw something else here.
 */
class SvgContext {
  lineWidth = 1;
  strokeStyle: Paint = "#000000";
  fillStyle: Paint = "#000000";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  lineCap = "butt";
  lineJoin = "miter";
  private path: Subpath[] = [];
  private shapes: Shape[] = [];

  constructor(private readonly size: number) {}

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1 || e !== 0 || f !== 0) throw new Error("field-svg: only the identity transform is drawn");
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    if (x > 0 || y > 0 || x + w < this.size || y + h < this.size) throw new Error("field-svg: only the whole picture is cleared");
    this.shapes = [];
  }
  beginPath(): void {
    this.path = [];
  }
  moveTo(x: number, y: number): void {
    this.path.push({ points: [x, y], closed: false });
  }
  lineTo(x: number, y: number): void {
    const last = this.path.at(-1);
    if (!last || "circle" in last || last.closed) this.path.push({ points: [x, y], closed: false });
    else last.points.push(x, y);
  }
  closePath(): void {
    const last = this.path.at(-1);
    if (last && "points" in last) last.closed = true;
  }
  arc(x: number, y: number, r: number, start: number, end: number): void {
    if (Math.abs(end - start) < 2 * Math.PI - 1e-9) throw new Error("field-svg: only whole circles are drawn");
    this.path.push({ circle: [x, y, r] });
  }
  stroke(path?: unknown): void {
    if (path !== undefined) throw new Error("field-svg: a Path2D isn't drawn (paintField draws from points where there is none)");
    if (this.lineCap !== "round" || this.lineJoin !== "round") throw new Error("field-svg: lines are drawn with round caps and joins");
    this.shapes.push({ op: "stroke", path: this.path, paint: this.strokeStyle, width: this.lineWidth, composite: this.composite() });
  }
  fill(): void {
    this.shapes.push({ op: "fill", path: this.path, paint: this.fillStyle, width: 0, composite: this.composite() });
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(offset: number, color: string): void } {
    const gradient: Gradient = { kind: "linear", x0, y0, x1, y1, stops: [] };
    return Object.assign(gradient, { addColorStop: (offset: number, color: string) => void gradient.stops.push([offset, color]) });
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void } {
    const gradient: Gradient = { kind: "radial", x0, y0, r0, x1, y1, r1, stops: [] };
    return Object.assign(gradient, { addColorStop: (offset: number, color: string) => void gradient.stops.push([offset, color]) });
  }

  private composite(): string {
    if (this.globalAlpha !== 1) throw new Error("field-svg: shapes are drawn at full alpha (their colours carry it)");
    if (this.globalCompositeOperation !== "source-over" && this.globalCompositeOperation !== "lighter") throw new Error(`field-svg: ${this.globalCompositeOperation} isn't drawn`);
    return this.globalCompositeOperation;
  }

  /** The picture as an SVG file: every shape in the order it was drawn, each laid over what is under it as it was (as
   * light, every shape added to what is under it; as ink, over it). */
  svg(id: string, as: "light" | "ink"): string {
    const composites = new Set(this.shapes.map((s) => s.composite));
    const added = composites.has("lighter");
    if (composites.size > 1 || (composites.size === 1 && added !== (as === "light"))) throw new Error(`field-svg: a drawing as ${as} laid its shapes ${[...composites].join(" and ")}`);
    // Coordinates to a tenth of a CSS pixel (a hundredth on an orb under 32 px): finer than a screen shows either way.
    const places = this.size >= 32 ? 1 : 2;
    const defs: string[] = [];
    let n = 0;
    const paint = (p: Paint): string => {
      if (typeof p === "string") return colour(p);
      const gid = `${id}${++n}`;
      const stops = p.stops.map(([offset, c]) => `<stop offset="${num(offset, 3)}"${colour(c, "stop-color", "stop-opacity")}/>`).join("");
      defs.push(
        p.kind === "linear"
          ? `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${num(p.x0, places)}" y1="${num(p.y0, places)}" x2="${num(p.x1, places)}" y2="${num(p.y1, places)}">${stops}</linearGradient>`
          : `<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="${num(p.x1, places)}" cy="${num(p.y1, places)}" r="${num(p.r1, places)}"${focus(p, places)}>${stops}</radialGradient>`,
      );
      return ` fill="url(#${gid})"`;
    };
    const body = this.shapes.map((shape) => {
      const circles = shape.path.filter((s) => "circle" in s);
      if (circles.length && (circles.length > 1 || shape.path.length > 1 || shape.op !== "fill")) throw new Error("field-svg: a circle is drawn alone, and filled");
      if (circles.length) {
        const [cx, cy, r] = (circles[0] as { circle: [number, number, number] }).circle;
        return `<circle cx="${num(cx, places)}" cy="${num(cy, places)}" r="${num(r, places)}"${paint(shape.paint)}/>`;
      }
      const d = pathData(shape.path as { points: number[]; closed: boolean }[], places);
      if (shape.op === "fill") return `<path d="${d}"${paint(shape.paint)}/>`;
      if (typeof shape.paint !== "string") throw new Error("field-svg: lines are drawn in one colour each");
      return `<path d="${d}"${colour(shape.paint, "stroke", "stroke-opacity")} stroke-width="${num(shape.width, 3)}"/>`;
    });
    const size = num(this.size, places);
    // (Light added to light needs a style: SVG has no attribute for it. The file is an image, served with a policy of
    // its own that allows this one style and nothing else: public/_headers.)
    const style = added ? "<style>path,circle{mix-blend-mode:plus-lighter}</style>" : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${style}${defs.length ? `<defs>${defs.join("")}</defs>` : ""}<g fill="none" stroke-linecap="round" stroke-linejoin="round">${body.join("")}</g></svg>\n`;
  }
}

/** A radial gradient's focus, where it isn't its centre with no radius of its own (SVG's defaults: an ember's is). */
function focus(p: Extract<Gradient, { kind: "radial" }>, places: number): string {
  const same = num(p.x0, places) === num(p.x1, places) && num(p.y0, places) === num(p.y1, places);
  return `${same ? "" : ` fx="${num(p.x0, places)}" fy="${num(p.y0, places)}"`}${p.r0 > 0 ? ` fr="${num(p.r0, places)}"` : ""}`;
}

/** `rgba(r,g,b,a)`, `rgb(r,g,b)` or `#rrggbb` as an SVG colour and its opacity, in the attributes named. */
function colour(css: string, name = "fill", opacity = "fill-opacity"): string {
  let hex: string, alpha = 1;
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css);
  if (rgba) {
    hex = `#${[rgba[1], rgba[2], rgba[3]].map((c) => Math.max(0, Math.min(255, Math.round(Number(c)))).toString(16).padStart(2, "0")).join("")}`;
    alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
  } else if (/^#[0-9a-f]{6}$/i.test(css)) hex = css.toLowerCase();
  else throw new Error(`field-svg: a colour it can't read: ${css}`);
  return ` ${name}="${hex}"${alpha < 1 ? ` ${opacity}="${num(alpha, 3)}"` : ""}`;
}

/** A number as short as SVG takes it: `places` decimals at most, no trailing zeros, no leading zero. */
function num(v: number, places: number): string {
  const s = (Math.round(v * 10 ** places) / 10 ** places).toFixed(places).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s.replace(/^(-?)0\./, "$1.");
}

/** Subpaths as path data: each starts where it is (M) and goes on by steps (l), rounded first so no error builds up. */
function pathData(subpaths: { points: number[]; closed: boolean }[], places: number): string {
  const k = 10 ** places;
  const out: string[] = [];
  for (const { points, closed } of subpaths) {
    if (points.length < 2) continue;
    const at = points.map((v) => Math.round(v * k));
    let d = `M${num(at[0]! / k, places)} ${num(at[1]! / k, places)}`;
    if (at.length > 2) {
      d += "l";
      for (let i = 2; i < at.length; i += 2) {
        for (const delta of [at[i]! - at[i - 2]!, at[i + 1]! - at[i - 1]!]) {
          const s = num(delta / k, places);
          d += d.endsWith("l") || s.startsWith("-") ? s : ` ${s}`;
        }
      }
    }
    out.push(closed ? `${d}z` : d);
  }
  return out.join("");
}
