/*
 * The agents' marks as invincible.sh shows them: their glass (core's glass.ts: a shape of our own in its ramp), drawn
 * from core's numbers once, when the site is built, as SVG: sharp at any screen's density, with no script on the page.
 * The agents are the only colour on the site (the owner's word, 26 November 2026: monochrome, colour for the agents
 * alone, so they are told apart at a glance); your agent is the I-beam, in ink (mark.ts).
 *
 * Each is still (nothing moves at rest) and drawn twice: in its ramp's form for a dark page and for a light one, with the
 * blur the app gives a glass from 40 px. Each file holds all it needs: it refers to nothing outside itself. Pure and
 * deterministic: the same SVG from the same repository, every build.
 */
import { type Glass, GLASS_GLOW, GLASS_PAINT, GLASS_RAMPS, GLASS_SHAPES, type GlassStops } from "../../../../packages/core/src/glass.ts";
import type { MarkTheme } from "../../../../packages/core/src/agent-mark.ts";

/** A mark drawn for both pages: its size (the SVG's width and height, in CSS pixels), and its two drawings. */
export interface MarkSvg {
  size: number;
  /** For a dark page: its ramp's dark form. */
  dark: string;
  /** For a light page: its ramp's light form. */
  light: string;
}

const at = (n: number) => String(n / 100);

/** An agent's glass, `size` CSS pixels across, at rest, as an SVG file for each page. */
export function agentMarkSvg(glass: Glass, size: number): MarkSvg {
  const shape = GLASS_SHAPES[glass.shape]!;
  const ramp = GLASS_RAMPS[glass.color]!;
  const small = size <= 16;
  const width = small ? shape.smallWidth : shape.width;
  const draw = (theme: MarkTheme): string => {
    const s: GlassStops = ramp[theme];
    const p = GLASS_PAINT;
    const defs =
      `<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${s.a}"/><stop offset="1" stop-color="${s.b}"/></linearGradient>` +
      `<radialGradient id="c" cx="${at(p.accent.at[0])}" cy="${at(p.accent.at[1])}" r="${at(p.accent.r)}"><stop offset="0" stop-color="${s.accent}" stop-opacity="${p.accent.opacity}"/><stop offset="1" stop-color="${s.accent}" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="h" cx="${at(p.highlight.at[0])}" cy="${at(p.highlight.at[1])}" r="${at(p.highlight.r)}">${p.highlight.stops.map(([o, a]) => `<stop offset="${o}" stop-color="${s.highlight}" stop-opacity="${a}"/>`).join("")}</radialGradient>` +
      `<radialGradient id="d" cx="${at(p.shade.at[0])}" cy="${at(p.shade.at[1])}" r="${at(p.shade.r)}"><stop offset="0" stop-color="${s.deep}" stop-opacity="${p.shade.opacity[theme]}"/><stop offset="1" stop-color="${s.deep}" stop-opacity="0"/></radialGradient>` +
      `<pattern id="p" patternUnits="userSpaceOnUse" width="100" height="100">${["a", "c", "h", "d"].map((layer) => `<rect width="100" height="100" fill="url(#${layer})"/>`).join("")}</pattern>` +
      `<filter id="b" x="-45%" y="-45%" width="190%" height="190%"><feGaussianBlur stdDeviation="${GLASS_GLOW.blur.radius}"/></filter>`;
    const paint = shape.kind === "tube"
      ? `fill="none" stroke="url(#p)" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`
      : width ? `fill="url(#p)" stroke="url(#p)" stroke-width="${width}" stroke-linejoin="round"` : `fill="url(#p)"`;
    const blur = size >= GLASS_GLOW.blur.minSize
      ? `<path d="${shape.d}" ${paint} filter="url(#b)" opacity="${GLASS_GLOW.blur.opacity[theme]}"${GLASS_GLOW.blur.dy[theme] ? ` transform="translate(0 ${GLASS_GLOW.blur.dy[theme]})"` : ""}/>`
      : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><defs>${defs}</defs>${blur}<path d="${shape.d}" ${paint}/></svg>`;
  };
  return { size, dark: draw("dark"), light: draw("light") };
}
