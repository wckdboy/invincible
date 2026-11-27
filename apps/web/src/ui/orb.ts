import type { MarkState } from "@invincible/core/agent-mark";
import { orbTone, type OrbTone } from "../lib/orb.ts";
import type { OrbMood } from "../lib/orb-motion.ts";
import { MARK_POLYGON } from "../../../../scripts/mark.ts";
import { h, svg } from "./dom.ts";
import { guardianMark } from "./glass.ts";
import { agentMark, markStateOfMood } from "./mark.ts";

/*
 * Your agent and the app are the I-beam (orb, appMark), still: never the gold field (the owner's word, 26 November 2026:
 * the I-beam as the mark, monochrome, colour kept for the agents). Your agent's is on a tile of its own in one ink, or
 * in pearl glass where this device is set so (ui/glass.ts' guardianMark, until the owner chooses); the app's is the
 * I-beam alone. Its shape has one place, scripts/mark.ts. Every agent's face is its glass (agentFace, ui/mark.ts): a
 * shape of our own in its ramp, its state a dot beside the word. Nothing in either comes from a name's meaning, a
 * profile's words or a model: an agent's colour and shape are the ones its node gave it, or its handle's.
 */

export type { OrbTone };

export interface OrbOptions {
  /** Its width and height in CSS pixels (16 to 320; 36 when left out). */
  size?: number;
  /** Where it stands (lib/now.ts' tone): kept on the orb as `data-tone`. Its field is gold in every state; its mood
   * moves it, and the words beside it say where it stands. */
  tone?: OrbTone;
  /** Its accessible name ("The primary: at work"). Leave it out beside the word "The primary": the orb is then decorative. */
  label?: string;
  /** What it is doing: it moves as that mood does while motion is allowed. Left out: still. */
  mood?: OrbMood;
  /** Which orb it is, so one drawn again (a new state, its page drawn anew) carries on where it was, and a change of mood
   * eases rather than starting afresh. Its own when left out: all its orbs move as one. */
  key?: string;
}

/** The I-beam in a 100-unit box, in the page's ink (`.ibeam polygon` in index.html): its shape from scripts/mark.ts. */
const ibeam = (): SVGSVGElement => svg("svg", { class: "ibeam", viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }, svg("polygon", { points: MARK_POLYGON }));

/**
 * Your agent's mark, wherever it is (Home's header, its row, its seat, a speaker in a conversation): the I-beam on its
 * tile, still, in the box an orb takes (`size`). Where it stands is said beside it in words, and kept on it as
 * `data-tone`; what it is doing doesn't move it (`mood` is taken for the call's sake, and moves nothing).
 */
export function orb(options: OrbOptions = {}): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(320, options.size!))) : 36;
  return guardianMark({ size, cls: "orb orb-mark", attrs: { "data-tone": orbTone(options.tone) }, ...(options.label ? { label: options.label } : {}) });
}

/**
 * The app's mark where a page shows it (the sidebar's head, a phone's way Home, Settings' About, the welcome): the
 * I-beam alone, on nothing, in the page's ink, so it sits on a light page as on a dark one (your word, 26 November 2026:
 * "make sure the app icon is transparent so it works in dark and white mode"). Decorative: what it is in is named.
 */
export function appMark(size: number): HTMLElement {
  const px = Number.isFinite(size) ? Math.round(Math.max(16, Math.min(320, size))) : 20;
  return h("span", { class: "orb app-mark", style: `--orb-size:${px}px`, "aria-hidden": "true" }, ibeam());
}

/** An agent's face options: whose (its handle), its saved avatar (its glass, or what it had before: core's glassOf), its
 * size in CSS pixels, and what it shows (its state, or its mood's: its dot). */
export interface AgentFaceOptions {
  id: string;
  profile?: unknown;
  size: number;
  /** What it is doing, where it is looked at: its dot says so. */
  mood?: OrbMood;
  /** What its dot shows (left out: its mood's; with neither, no dot: a speaker in the history). */
  state?: MarkState;
  /** Its accessible name; left out, it is decorative (its name is beside it). */
  label?: string;
}

/**
 * An agent's face: its glass (ui/mark.ts), in its own shape and ramp as its node gave them, the same on every device; its
 * state a dot where it is known. Only a working one moves: its light breathes, by opacity alone.
 */
export function agentFace(options: AgentFaceOptions): HTMLElement {
  const state = options.state ?? (options.mood !== undefined ? markStateOfMood(options.mood) : undefined);
  return agentMark({ id: String(options.id ?? ""), profile: options.profile, size: options.size, ...(state ? { state } : {}), ...(options.label ? { label: options.label } : {}) });
}
