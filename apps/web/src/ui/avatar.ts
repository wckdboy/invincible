import { AVATAR_EXPRESSIONS, isOrbProfile, AGENT_TINT_NAMES, AGENT_TINTS, agentColors, type AvatarExpression, type OrbProfile } from "@invincible/core/avatar";
import { type AgentState, STATES } from "../lib/agent-state.ts";
import { orbToneOfState } from "../lib/orb.ts";
import { orbMoodOfExpression } from "../lib/orb-motion.ts";
import { button, dot } from "./controls.ts";
import { h, replace } from "./dom.ts";
import { agentFace, orb } from "./orb.ts";

/*
 * An agent as an orb (your word, 25 November 2026: "drop the agent avatars, and just use custom/procedurally generated
 * colored particle orbs"): since 26 November 2026, the primary's field in a colour of its own, the one you chose for it or
 * its handle's (ui/orb.ts' agentFace, lib/field-orb.ts). It moves only where it is the one you are looking at and it
 * is at work; in a row (seat()) it is still, with no ring round it (a ring round a lit middle read as a nipple): what it
 * is doing is said beside it, in words and its state's colour (stateChip(), the row's line). The primary itself is its orb.
 * A speaker in a conversation's history is drawn still, and nothing moves when the device asks for reduced motion.
 * Nothing from a profile reaches a URL, a style or a paint but a colour checked to be six hex digits.
 */

/** How a face is put on the page, and the colour picker's swatches: given to the page once, by the first drawn. */
export const AGENT_CSS = `
.worker-avatar { position: relative; display: inline-grid; place-items: center; flex: none; }
.agent-orb { position: relative; display: block; flex: none; width: var(--orb-size, 40px); height: var(--orb-size, 40px); }
.agent-orb > svg, .agent-orb > canvas { display: block; width: 100%; height: 100%; }
.orb-editor-stage { display: flex; align-items: center; gap: var(--sp-4, 16px); }
.orb-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 6px; }
.orb-swatch { width: 30px; height: 30px; margin: 2px; padding: 0; border: 0; border-radius: 50%; background: var(--swatch); cursor: pointer; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.14); }
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
  /** Its saved avatar: a colour you chose for it (core's OrbProfile); anything else is its handle's colour. */
  profile?: unknown;
  /** What it is doing (core's avatarExpression): its orb moves as that does. */
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
  const label = options.still ? `${name}'s orb` : `${name} · ${expression}`;
  if (id === "primary") return h("span", { class: "worker-avatar", "data-primary": "true" }, orb({ size, label, mood, key: "invincible:face" }));
  return h("span", { class: "worker-avatar", "data-expression": expression }, agentFace({ id, profile: options.profile, size, mood, label, key: `face:${id}` }));
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
  const label = options.still ? `${name}'s orb` : words ? `${name} · ${words}` : name;
  return h("span", { class: `seat seat-${scale}`, "data-state": state }, h("span", { class: "worker-avatar" }, agentFace({ id, profile: options.profile, size, label, key: `seat:${id}` })));
}

/** An agent's state in words, beside its name (a badge in the state's tone; working has a live dot, so it isn't read as
 * a quiet state). Null at rest: its line says what it is for. */
export function stateChip(state: AgentState | undefined): HTMLElement | null {
  const look = STATES[state ?? "resting"];
  if (!look.words) return null;
  return h("span", { class: "badge state-chip", "data-tone": look.tone }, state === "working" ? dot("work", { live: true }) : null, look.words);
}

/**
 * An agent's colour, as you choose it: its orb as it will be, and the 24 colours to choose from, or the one its handle
 * gives it. An unsaved draft: the form it is in decides whether to save it. Its value: the colour you chose (an
 * OrbProfile), null to let it go back to its handle's, or undefined when nothing was touched (what is saved stays).
 */
export function avatarEditor(options: { id(): string; name(): string; profile?: unknown }): { element: HTMLElement; value(): OrbProfile | null | undefined; refreshIdentity(): void } {
  ensureStyles();
  let chosen: string | null = isOrbProfile(options.profile) ? options.profile.color.toLowerCase() : null;
  let touched = false;
  const preview = h("div", { class: "orb-editor-preview" });
  const note = h("p", { class: "small muted" });
  const swatches = h("div", { class: "orb-swatches", role: "group", "aria-label": "Its colour" });
  const choose = (color: string | null) => ((chosen = color), (touched = true), render());
  function render(): void {
    const id = options.id() || "agent";
    const colors = agentColors(id, chosen ? { v: 2, color: chosen } : undefined);
    replace(preview, workerAvatar({ id, name: options.name() || "Your agent", profile: chosen ? { v: 2, color: chosen } : undefined, expression: "idle", size: 96 }));
    replace(note, chosen ? "The colour you chose." : `Its handle gives it ${AGENT_TINT_NAMES[AGENT_TINTS.indexOf(colors.tint as never)] ?? "this colour"}: change its handle and its colour comes with it, until you choose one.`);
    replace(swatches, ...AGENT_TINTS.map((tint, n) =>
      h("button", { type: "button", class: "orb-swatch", style: `--swatch:${tint}`, title: AGENT_TINT_NAMES[n], "aria-label": AGENT_TINT_NAMES[n], "aria-pressed": String(chosen === tint), onclick: () => choose(tint) })));
  }
  const element = h(
    "fieldset",
    { class: "avatar-editor" },
    h("legend", {}, "Colour"),
    h("div", { class: "orb-editor-stage" }, preview, h("div", { class: "stack" }, note, button("Its handle's colour", { variant: "ghost", size: "sm", onClick: () => choose(null) }))),
    swatches,
  );
  render();
  return {
    element,
    value: () => (!touched ? undefined : chosen ? { v: 2, color: chosen } : null),
    refreshIdentity: () => render(),
  };
}
