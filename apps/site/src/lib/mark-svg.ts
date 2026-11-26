/*
 * The agents' marks as invincible.sh shows them: the Grille (O2), drawn from core's numbers by the app's own drawing
 * (apps/web/src/ui/mark.ts' markParts: a disc in the agent's colour cut into slats by its slots), once, when the site is
 * built, as SVG: sharp at any screen's density, with no script on the page. The agents are the only colour on the site
 * (the owner's word, 26 November 2026: monochrome, colour for the agents alone, so they are told apart at a glance, and
 * for a real failure); your agent is the I-beam, in ink (mark.ts).
 *
 * Each is still, at rest (nothing moves at rest), and drawn twice: in its colour's form for a dark page and for a light
 * one. Pure and deterministic: the same SVG from the same repository, every build.
 */
import { type AgentMark, markColors, markGeometry, type MarkTheme } from "../../../../packages/core/src/agent-mark.ts";
import { handleSeed } from "../../../../packages/core/src/avatar.ts";
import { markParts } from "../../../web/src/ui/mark.ts";

/** A mark drawn for both pages: its size (the SVG's width and height, in CSS pixels), and its two drawings. */
export interface MarkSvg {
  size: number;
  /** For a dark page: its colour's dark form. */
  dark: string;
  /** For a light page: its colour's light form. */
  light: string;
}

/** An agent's mark, by its handle and the mark it was given, `size` CSS pixels across, at rest, as an SVG file for each page. */
export function agentMarkSvg(handle: string, mark: AgentMark, size: number): MarkSvg {
  const parts = markParts(markGeometry({ mark, seed: handleSeed(handle), state: "idle", size, t: null, since: null }));
  const draw = (theme: MarkTheme): string => {
    const colours = markColors(mark.color, "idle", theme);
    const slats = parts.map((part) => `<g${part.loose ? ` transform="${part.loose}"` : ""}><g transform="${part.turned}"><path d="${part.d}" transform="${part.slid}" fill="${part.fill === "key" ? colours.key : colours.body}"/></g></g>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${slats.join("")}</svg>`;
  };
  return { size, dark: draw("dark"), light: draw("light") };
}
