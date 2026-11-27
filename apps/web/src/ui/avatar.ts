import { MARK_PALETTE, markState } from "@invincible/core/agent-mark";
import { GLASS_RAMPS, GLASS_SHAPES, glassOf, glassProfile, type GlassProfile } from "@invincible/core/glass";
import { AVATAR_EXPRESSIONS, type AvatarExpression } from "@invincible/core/avatar";
import { type AgentState, STATES } from "../lib/agent-state.ts";
import { orbToneOfState } from "../lib/orb.ts";
import { orbMoodOfExpression } from "../lib/orb-motion.ts";
import { button, dot } from "./controls.ts";
import { h, replace } from "./dom.ts";
import { glassAvatar } from "./glass.ts";
import { markStateOfAgent } from "./mark.ts";
import { agentFace, orb } from "./orb.ts";

/*
 * An agent as its glass (ui/glass.ts, the owner's word of 27 November 2026 that the Grille goes): a shape of our own in
 * one of eight ramps, the shape and the colour its node gave it as it joined. Its state is a dot cut out beside it, and
 * said beside it in words (stateChip(), the row's line), so colour never tells it alone; only working moves, its light
 * breathing. The primary itself is the I-beam. A speaker in a conversation's history has no dot, and nothing moves when
 * the device asks for reduced motion. Nothing from a profile reaches a URL, a style or a paint: its colour is only ever
 * one of core's eight ramps and its shape one of core's 22.
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
.glass-shapes { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 4px; margin-top: 8px; }
.glass-shape { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 10px; background: transparent; cursor: pointer; }
.glass-shape:hover { background: var(--hover, rgb(127 127 127 / 0.08)); }
.glass-shape:focus-visible { outline: 2px solid var(--focus, currentColor); outline-offset: 2px; }
.glass-shape[aria-pressed="true"] { box-shadow: inset 0 0 0 2px var(--accent, currentColor); }
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
  /** Its saved avatar: its glass as its node gave it (v 4), or what it had before (v 3, v 2): core's glassOf. */
  profile?: unknown;
  /** What it is doing (core's avatarExpression): its dot shows it (core's markState), its light breathing while it works. */
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
  return h("span", { class: "worker-avatar", "data-expression": expression }, agentFace({ id, profile: options.profile, size, ...(options.still ? {} : { mood, state: markState(expression) }), label }));
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
  return h("span", { class: `seat seat-${scale}`, "data-state": state }, h("span", { class: "worker-avatar" }, agentFace({ id, profile: options.profile, size, state: markStateOfAgent(state), label })));
}

/** An agent's state in words, beside its name (a badge in the state's tone; working has a live dot, so it isn't read as
 * a quiet state). Null at rest: its line says what it is for. */
export function stateChip(state: AgentState | undefined): HTMLElement | null {
  const look = STATES[state ?? "resting"];
  if (!look.words) return null;
  return h("span", { class: "badge state-chip", "data-tone": look.tone }, state === "working" ? dot("work", { live: true }) : null, look.words);
}

/**
 * An agent's glass, as you choose it: it as it will be, the eight colours (core's ramps, on the palette's hues) and the
 * 22 shapes to choose from, each kept as you leave it when you choose the other. An unsaved draft: the form it is in
 * decides whether to save it. Its value: its glass as you chose it (v 4), null for the one its node would give it now,
 * or undefined when nothing was touched (what is saved stays).
 */
export function avatarEditor(options: { id(): string; name(): string; profile?: unknown }): { element: HTMLElement; value(): GlassProfile | null | undefined; refreshIdentity(): void } {
  ensureStyles();
  // (Its glass, or what it had before, read as core's glassOf reads it.)
  const had = options.profile !== null && options.profile !== undefined;
  const own = () => glassOf(options.id() || "agent", options.profile);
  let color: number | null = had ? own().color : null;
  let shape: number | null = had ? own().shape : null;
  let touched = false;
  const preview = h("div", { class: "orb-editor-preview" });
  const note = h("p", { class: "small muted" });
  const swatches = h("div", { class: "orb-swatches", role: "group", "aria-label": "Its colour" });
  const shapes = h("div", { class: "glass-shapes", role: "group", "aria-label": "Its shape" });
  const glassNow = (): GlassProfile | undefined => (color === null && shape === null ? undefined : glassProfile({ color: color ?? own().color, shape: shape ?? own().shape }));
  const reset = () => ((color = null), (shape = null), (touched = true), render());
  function render(): void {
    const id = options.id() || "agent";
    const now = glassNow();
    const shown = glassOf(id, now ?? options.profile);
    replace(preview, workerAvatar({ id, name: options.name() || "Your agent", profile: now ?? options.profile, expression: "idle", size: 96 }));
    replace(note, touched && now === undefined ? "The glass its node gives it when it is saved: a colour and a shape no other agent near it has, while there are some to go round." : now ? `${MARK_PALETTE[shown.color]!.name}, ${GLASS_SHAPES[shown.shape]!.name}.` : "The glass its node gives it as it joins: a colour and a shape no other agent near it has, while there are some to go round.");
    replace(swatches, ...GLASS_RAMPS.map((ramp, n) =>
      h("button", { type: "button", class: "orb-swatch", style: `--swatch:linear-gradient(135deg, light-dark(${ramp.light.a}, ${ramp.dark.a}), light-dark(${ramp.light.b}, ${ramp.dark.b}))`, title: MARK_PALETTE[n]!.name, "aria-label": MARK_PALETTE[n]!.name, "aria-pressed": String(now !== undefined && shown.color === n), onclick: () => ((color = n), (shape ??= shown.shape), (touched = true), render()) })));
    replace(shapes, ...GLASS_SHAPES.map((s, n) =>
      h("button", { type: "button", class: "glass-shape", title: s.name, "aria-label": s.name, "aria-pressed": String(now !== undefined && shown.shape === n), onclick: () => ((shape = n), (color ??= shown.color), (touched = true), render()) },
        glassAvatar({ id, profile: glassProfile({ color: shown.color, shape: n }), size: 28 }))));
  }
  const element = h(
    "fieldset",
    { class: "avatar-editor" },
    h("legend", {}, "Its glass"),
    h("div", { class: "orb-editor-stage" }, preview, h("div", { class: "stack" }, note, button("The glass it would be given", { variant: "ghost", size: "sm", onClick: reset }))),
    swatches,
    shapes,
  );
  render();
  return {
    element,
    value: () => (!touched ? undefined : (glassNow() ?? null)),
    refreshIdentity: () => render(),
  };
}
