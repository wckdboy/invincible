import { type AgentMark, type MarkGeometry, type MarkState, MARK_TIMING, markColors, markGeometry, markOf } from "@invincible/core/agent-mark";
import { handleSeed } from "@invincible/core/avatar";
import type { AgentState } from "../lib/agent-state.ts";
import type { OrbMood } from "../lib/orb-motion.ts";
import { h, svg } from "./dom.ts";
import { motionAllowed, move } from "./motion.ts";

/*
 * An agent's mark, the Grille (O2: shown five directions on 26 November 2026, the owner chose "2 · Grille"): a solid
 * disc in the agent's own colour, cut into slats by two or three slots at its own angle. Drawn from core's numbers alone
 * (@invincible/core/agent-mark: its colour and form, its state's colours, its slats' geometry), as every app draws it,
 * and held to them by the vectors' marks (mark.test.ts). The shape carries its state: the top slat in ink while it asks
 * you, the bottom one red and loose once it failed, pale while queued, grey while paused.
 *
 * Still in every row. The one you are looking at moves in its state's way, slowly (its slats slide while it works, its
 * top slat beats while it asks you; done settles once as it arrives, failed drops once), on the page's one clock
 * (ui/motion.ts), only while on screen, and never where motion is reduced. At rest it asks for nothing. Its colours
 * follow the page's theme by themselves (light-dark()), so a change of theme draws nothing again.
 */

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** A band of the disc between u = a and u = b (across the slots, downward), as a path about the disc's middle (O1's band:
 * two chords and the two arcs between them). */
export function bandPath(r: number, a: number, b: number): string {
  const ha = Math.sqrt(Math.max(0, r * r - a * a));
  const hb = Math.sqrt(Math.max(0, r * r - b * b));
  return `M${f(-ha)},${f(a)} L${f(ha)},${f(a)} A${r},${r} 0 0 1 ${f(hb)},${f(b)} L${f(-hb)},${f(b)} A${r},${r} 0 0 1 ${f(-ha)},${f(a)} Z`;
}

/** A slat as SVG draws it in the mark's 100-unit box: its band (`d`), slid along its slot (`slid`), turned to the mark's
 * angle about the box's middle (`turned`), and, knocked loose, turned about its pivot and dropped (`loose`, null: in its
 * place); filled as the body or the key. */
export interface MarkPart {
  d: string;
  slid: string;
  turned: string;
  loose: string | null;
  fill: "body" | "key";
}

/** A mark's slats as SVG draws them: core's geometry, said as paths and transforms. */
export function markParts(geometry: MarkGeometry): MarkPart[] {
  return geometry.slats.map((slat) => ({
    d: bandPath(geometry.radius, slat.from, slat.to),
    slid: `translate(${f(slat.slide)} 0)`,
    turned: `translate(50 50) rotate(${f(geometry.angle)})`,
    loose: slat.drop || slat.turn ? `translate(0 ${f(slat.drop)}) rotate(${f(slat.turn)} ${f(slat.pivot[0])} ${f(slat.pivot[1])})` : null,
    fill: slat.fill,
  }));
}

/** The state a mark shows for an orb's mood (what the app said of a face before the marks). */
export const markStateOfMood = (mood: OrbMood | undefined): MarkState => (mood === "waiting" ? "needs" : (mood ?? "idle"));

/** The state a mark shows for an agent's state in a seat (lib/agent-state.ts): work that passed review is done; new to
 * you, or at rest, idle. */
export function markStateOfAgent(state: AgentState | undefined): MarkState {
  switch (state) {
    case "working": case "needs": case "failed": case "paused": case "queued": return state;
    case "verified": return "done";
    default: return "idle";
  }
}

/** How often a mark in a state is drawn while it moves, frames a second: slow enough to be calm, often enough to be smooth
 * at its size; its arrival a little more often, then nothing. */
const PACE = { moving: 15, arriving: 30 } as const;

/** When each mark that moves came to its state, by its key: drawn again in a new state, it arrives in it once (done
 * settles, failed drops); in the same state it carries on where it was. A mark first seen in a state is long in it. */
const arrivals = new Map<string, { state: MarkState; at: number | null }>();

export interface AgentMarkOptions {
  id: string;
  /** Its saved avatar: its mark (v 3), a colour chosen before the marks (v 2), or nothing (core's markOf). */
  profile?: unknown;
  /** Its width and height in CSS pixels (16 to 256). */
  size: number;
  state?: MarkState;
  /** The one you are looking at: it moves in its state's way. Left out: still, as in a row. */
  live?: boolean;
  /** Its accessible name; left out, it is decorative (its name is beside it). */
  label?: string;
  /** Which mark it is, so one drawn again in a new state arrives in it (`mark:<handle>` when left out). */
  key?: string;
}

/** An agent's mark, drawn: still, or (live) moving on the page's clock while its state moves it. */
export function agentMark(options: AgentMarkOptions): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(256, options.size))) : 40;
  const id = String(options.id ?? "");
  const mark: AgentMark = markOf(id, options.profile);
  const seed = handleSeed(id);
  const state: MarkState = options.state ?? "idle";
  const light = markColors(mark.color, state, "light");
  const dark = markColors(mark.color, state, "dark");
  const named = options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" };
  const geometryAt = (t: number | null, since: number | null): MarkGeometry => markGeometry({ mark, seed, state, size, t, since });
  const slats = markParts(geometryAt(null, null)).map((part) => {
    const path = svg("path", { class: part.fill, d: part.d, transform: part.slid });
    const group = svg("g", part.loose ? { transform: part.loose } : {}, svg("g", { transform: part.turned }, path));
    return { path, group };
  });
  const el = h(
    "span",
    {
      class: "agent-orb agent-mark",
      "data-state": state,
      // (Its colours are core's palette's, never a profile's words: markOf reads a saved colour only as one of the eight.)
      style: `--orb-size:${size}px;--mark-body:light-dark(${light.body}, ${dark.body});--mark-key:light-dark(${light.key}, ${dark.key})`,
      ...named,
    },
    svg("svg", { class: "agent-mark-svg", viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }, ...slats.map((slat) => slat.group)),
  );
  if (!options.live) return el;

  const key = options.key ?? `mark:${id}`;
  const was = arrivals.get(key);
  // (On the page's clock, as its frames are.)
  const at = was === undefined ? null : was.state === state ? was.at : performance.now();
  arrivals.set(key, { state, at });
  const arriving = (): number | null => (at === null ? null : (performance.now() - at) / 1000);
  const moves = state === "working" || state === "needs";
  const lasts = state === "done" ? MARK_TIMING.doneSettle : state === "failed" ? MARK_TIMING.failDrop : 0;
  if (!motionAllowed() || (!moves && !(lasts && at !== null && (arriving() ?? Infinity) < lasts))) return el;
  const draw = (t: number, moving: boolean): void => {
    const since = moving ? arriving() : null;
    markParts(geometryAt(moving ? t : null, since !== null && since >= lasts && !moves ? null : since)).forEach((part, n) => {
      const slat = slats[n];
      if (!slat) return;
      if (slat.path.getAttribute("d") !== part.d) slat.path.setAttribute("d", part.d);
      slat.path.setAttribute("transform", part.slid);
      if (part.loose) slat.group.setAttribute("transform", part.loose);
      else slat.group.removeAttribute("transform");
    });
  };
  draw(performance.now() / 1000, true);
  move(el, draw, () => (moves ? PACE.moving : (arriving() ?? Infinity) < lasts ? PACE.arriving : 0));
  return el;
}
