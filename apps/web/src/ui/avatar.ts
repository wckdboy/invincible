import { MARK_PALETTE, type MarkProfile, markOf, markProfile, markState, readMarkProfile } from "@invincible/core/agent-mark";
import { AVATAR_EXPRESSIONS, type AvatarExpression } from "@invincible/core/avatar";
import { type AgentState, STATES } from "../lib/agent-state.ts";
import { orbToneOfState } from "../lib/orb.ts";
import { orbMoodOfExpression } from "../lib/orb-motion.ts";
import { button, dot } from "./controls.ts";
import { h, replace } from "./dom.ts";
import { markStateOfAgent } from "./mark.ts";
import { agentFace, orb } from "./orb.ts";

/*
 * An agent as its mark, the Grille (O2, the owner's choice on 26 November 2026: ui/mark.ts): a disc in its own colour, cut
 * into slats at its own angle, the colour and the form its node gave it as it joined. Its state is in its shape (the top
 * slat in ink while it asks you, the bottom one red and loose once it failed, pale while queued, grey while paused), and
 * said beside it in words (stateChip(), the row's line), so colour never tells it alone. It moves only where it is the one
 * you are looking at and its state moves it; in a row (seat()) it is still. The primary itself is the I-beam. A speaker in
 * a conversation's history is drawn still, and nothing moves when the device asks for reduced motion. Nothing from a
 * profile reaches a URL, a style or a paint: its colour is only ever one of core's eight.
 */

/** How a face is put on the page, and the colour picker's swatches: given to the page once, by the first drawn. */
export const AGENT_CSS = `
.worker-avatar { position: relative; display: inline-grid; place-items: center; flex: none; }
.agent-orb { position: relative; display: block; flex: none; width: var(--orb-size, 40px); height: var(--orb-size, 40px); }
.agent-orb > svg, .agent-orb > canvas { display: block; width: 100%; height: 100%; }
.orb-editor-stage { display: flex; align-items: center; gap: var(--sp-4, 16px); }
.orb-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 6px; }
.orb-swatch { width: 36px; height: 36px; margin: 4px; padding: 0; border: 0; border-radius: 50%; background: var(--swatch); cursor: pointer; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.14); }
.orb-swatch:focus-visible { outline: 2px solid var(--focus, currentColor); outline-offset: 2px; }
.orb-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg, #000), 0 0 0 4px var(--accent, currentColor); }
`;

function ensureStyles(): void {
  // (In tests and the design sheet there is no page to give it to.)
  if (typeof document === "undefined" || typeof document.getElementById !== "function" || document.getElementById("agent-css")) return;
  const style = document.createElement("style");
  style.id = "agent-css";
  style.textContent = AGENT_CSS;
  document.head.append(style);
}

export interface WorkerAvatarOptions {
  /** An agent's handle, or "primary" for the primary itself (a handle no other agent can have). */
  id: string;
  name: string;
  /** Its saved avatar: its mark as its node gave it (v 3), or a colour chosen before the marks (v 2): core's markOf. */
  profile?: unknown;
  /** What it is doing (core's avatarExpression): its mark shows it (core's markState), and moves as it does. */
  expression?: AvatarExpression;
  size?: number;
  /** Historical messages identify a speaker, without inventing a past state: drawn still. */
  still?: boolean;
}

const sized = (size: number | undefined, fallback = 40): number => (Number.isFinite(size) ? Math.round(Math.max(16, Math.min(256, size!))) : fallback);

/** An agent's face, alone (beside its words, in a header, in a pick list): its orb, turning while it works (still
 * otherwise, in its mood's light). */
export function workerAvatar(options: WorkerAvatarOptions): HTMLElement {
  ensureStyles();
  const id = typeof options.id === "string" ? options.id : "agent";
  const size = sized(options.size);
  const name = String(options.name || "Agent").slice(0, 160);
  const expression = !options.still && AVATAR_EXPRESSIONS.includes(options.expression!) ? options.expression! : "idle";
  const mood = options.still ? undefined : orbMoodOfExpression(expression);
  const label = options.still ? `${name}'s mark` : `${name} · ${expression}`;
  if (id === "primary") return h("span", { class: "worker-avatar", "data-primary": "true" }, orb({ size, label, mood, key: "invincible:face" }));
  return h("span", { class: "worker-avatar", "data-expression": expression }, agentFace({ id, profile: options.profile, size, mood, state: markState(expression), label, key: `face:${id}` }));
}

/** What a seat leaves round its face, by its size (the stylesheet's --seat-pad): the room its ring took, kept so a row
 * keeps its height. */
const SEAT_PAD = { s: 4, m: 7, l: 9 } as const;

/**
 * An agent in its seat (a row, a card, a portrait): its face, still (your word, 26 November 2026: the agents still in
 * rows, only the one you are looking at moving). Its state is said beside it, in words and colour (stateChip(), the
 * row's line), and kept on the seat as `data-state`; its accessible name says it too. Its size follows the face's:
 * `seat-s` for a row's, `seat-m` for a card's, `seat-l` for a portrait. The primary itself is its orb (your word, 23
 * November 2026) in the room a face and its seat take, still too.
 */
export function seat(options: WorkerAvatarOptions & { state?: AgentState }): HTMLElement {
  ensureStyles();
  const size = sized(options.size);
  const scale = size <= 48 ? "s" : size <= 96 ? "m" : "l";
  const state = options.state ?? "resting";
  const name = String(options.name || "Agent").slice(0, 160);
  if (options.id === "primary") {
    return h("span", { class: `seat seat-${scale} seat-orb`, "data-state": state }, orb({ size: size + 2 * SEAT_PAD[scale], tone: orbToneOfState(state), label: "Your agent" }));
  }
  const id = String(options.id);
  const words = STATES[state]?.words;
  const label = options.still ? `${name}'s mark` : words ? `${name} · ${words}` : name;
  return h("span", { class: `seat seat-${scale}`, "data-state": state }, h("span", { class: "worker-avatar" }, agentFace({ id, profile: options.profile, size, state: markStateOfAgent(state), label, key: `seat:${id}` })));
}

/** An agent's state in words, beside its name (a badge in the state's tone; working has a live dot, so it isn't read as
 * a quiet state). Null at rest: its line says what it is for. */
export function stateChip(state: AgentState | undefined): HTMLElement | null {
  const look = STATES[state ?? "resting"];
  if (!look.words) return null;
  return h("span", { class: "badge state-chip", "data-tone": look.tone }, state === "working" ? dot("work", { live: true }) : null, look.words);
}

/**
 * An agent's colour, as you choose it: its mark as it will be, and the eight colours to choose from (core's MARK_PALETTE),
 * its form kept. An unsaved draft: the form it is in decides whether to save it. Its value: its mark in the colour you
 * chose (v 3), null for the one its node would give it now, or undefined when nothing was touched (what is saved stays).
 */
export function avatarEditor(options: { id(): string; name(): string; profile?: unknown }): { element: HTMLElement; value(): MarkProfile | null | undefined; refreshIdentity(): void } {
  ensureStyles();
  // (A mark it has, or a colour chosen before the marks, snapped to the eight: core's markOf.)
  const had = readMarkProfile(options.profile) !== null || (options.profile !== null && options.profile !== undefined);
  let chosen: number | null = had ? markOf(options.id() || "agent", options.profile).color : null;
  let touched = false;
  const preview = h("div", { class: "orb-editor-preview" });
  const note = h("p", { class: "small muted" });
  const swatches = h("div", { class: "orb-swatches", role: "group", "aria-label": "Its colour" });
  const choose = (color: number | null) => ((chosen = color), (touched = true), render());
  const markNow = (): MarkProfile | undefined => {
    const id = options.id() || "agent";
    return chosen === null ? undefined : markProfile({ color: chosen, form: markOf(id, options.profile).form });
  };
  function render(): void {
    const id = options.id() || "agent";
    replace(preview, workerAvatar({ id, name: options.name() || "Your agent", profile: markNow() ?? options.profile, expression: "idle", size: 96 }));
    replace(note, touched && chosen === null ? "The colour its node gives it when it is saved: one no other agent has, while there are colours to go round." : chosen !== null ? `${MARK_PALETTE[chosen]!.name}. Its form, the angle and the slots its colour is cut by, stays its own.` : "The colour its node gives it as it joins: one no other agent has, while there are colours to go round.");
    replace(swatches, ...MARK_PALETTE.map((hue, n) =>
      h("button", { type: "button", class: "orb-swatch", style: `--swatch:light-dark(${hue.light}, ${hue.dark})`, title: hue.name, "aria-label": hue.name, "aria-pressed": String(chosen === n), onclick: () => choose(n) })));
  }
  const element = h(
    "fieldset",
    { class: "avatar-editor" },
    h("legend", {}, "Colour"),
    h("div", { class: "orb-editor-stage" }, preview, h("div", { class: "stack" }, note, button("The colour it would be given", { variant: "ghost", size: "sm", onClick: () => choose(null) }))),
    swatches,
  );
  render();
  return {
    element,
    value: () => (!touched ? undefined : (markNow() ?? null)),
    refreshIdentity: () => render(),
  };
}
