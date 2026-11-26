import type { MarkState } from "@invincible/core/agent-mark";
import { orbTone, type OrbTone } from "../lib/orb.ts";
import type { OrbMood } from "../lib/orb-motion.ts";
import { MARK_POLYGON } from "../../../../scripts/mark.ts";
import { h, svg } from "./dom.ts";
import { agentMark, markStateOfMood } from "./mark.ts";

/*
 * Your agent and the app are the I-beam (orb, appMark), in one ink and still: never the gold field (the owner's word, 26
 * November 2026: the I-beam as the mark, monochrome, colour kept for the agents; as the iPhone's UI/Mark.swift draws it).
 * Its shape has one place, scripts/mark.ts. Every agent's face is its mark, the Grille (agentFace, ui/mark.ts): a disc in
 * its own colour cut into slats, its state in its shape. Nothing in either comes from a name's meaning, a profile's words
 * or a model: an agent's colour and form are the ones its node gave it, or its handle's.
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
 * Your agent's mark, wherever it is (Home's header, its row, its seat, a speaker in a conversation): the I-beam in one
 * ink, still, in the box an orb takes (`size`). Where it stands is said beside it in words, and kept on it as `data-tone`;
 * what it is doing doesn't move it (`mood` is taken for the call's sake, and moves nothing).
 */
export function orb(options: OrbOptions = {}): HTMLElement {
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(320, options.size!))) : 36;
  const named = options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" };
  return h("span", { class: "orb orb-mark", "data-tone": orbTone(options.tone), style: `--orb-size:${size}px`, ...named }, ibeam());
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

/** An agent's face options: whose (its handle), its saved avatar (its mark, or a colour chosen before the marks: core's
 * markOf), its size in CSS pixels, what it shows (its state), and whether it is the one you are looking at (`mood`, the
 * orbs' word for it: given, it moves in its state's way). */
export interface AgentFaceOptions {
  id: string;
  profile?: unknown;
  size: number;
  /** What it is doing, where it is looked at: it moves as its state does. Left out: still (a row, the history). */
  mood?: OrbMood;
  /** What its mark shows, still or moving (left out: its mood's, else idle). */
  state?: MarkState;
  /** Its accessible name; left out, it is decorative (its name is beside it). */
  label?: string;
  /** Which mark it is, so its face drawn again in a new state arrives in it (`face:<handle>` when left out). */
  key?: string;
}

/**
 * An agent's face: its mark, the Grille (ui/mark.ts, O2: the owner's choice, 26 November 2026), in its own colour and
 * form as its node gave them, the same on every device. Still wherever it is one of many; where it is looked at
 * (`mood`), it moves in its state's way, slowly, and at rest asks for nothing.
 */
export function agentFace(options: AgentFaceOptions): HTMLElement {
  const id = String(options.id ?? "");
  return agentMark({
    id,
    profile: options.profile,
    size: options.size,
    state: options.state ?? markStateOfMood(options.mood),
    live: options.mood !== undefined,
    ...(options.label ? { label: options.label } : {}),
    key: options.key ?? `face:${id}`,
  });
}
