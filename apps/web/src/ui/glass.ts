import { GLASS_DOT, GLASS_GLOW, GLASS_IBEAM, GLASS_PAINT, GLASS_PEARL, GLASS_PEARL_TILE, GLASS_RAMPS, GLASS_SHAPES, type GlassRamp, type GlassShape, type GlassState, type GlassStops, glassOf } from "@invincible/core/glass";
import { MARK_POLYGON } from "../../../../scripts/mark.ts";
import { h, svg } from "./dom.ts";

/*
 * An agent's glass (core's glass.ts): a soft shape of our own, lit by its ramp, with its glow; its state a dot beside
 * the word. Drawn from core's numbers alone, as every app draws it, and held to them (glass.test.ts).
 *
 * A page holds one sprite (every shape in both its forms, the nine paints, the blur), made once, the first time a glass
 * is drawn; an avatar is a `<use>` of it in a box of its own size, so it never moves what is around it. Its colours
 * follow the page's theme by themselves (light-dark()), and so does its glow (--gl-dark): a pool of its light behind it
 * on a dark page, a tinted shadow under it on a light one. Only working moves: its light breathes, by opacity alone,
 * on the compositor; still where motion is reduced, and paused while the page is hidden.
 *
 * Your agent wears the app's I-beam, bare, in the page's ink, as the app's own mark is (the squircle round it is the app
 * icon's alone: the owner's word, 27 November 2026); or, set so on this device, the I-beam in pearl glass, on its tile
 * on a light page (guardianStyle: the owner chooses between them).
 */

const SPRITE = "glass-sprite";
const ld = (ramp: GlassRamp, key: keyof GlassStops): string => `light-dark(${ramp.light[key]}, ${ramp.dark[key]})`;
/** A colour at an opacity, as #rrggbbaa. */
const alpha = (hex: string, a: number): string => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
const stopOf = (offset: number, ramp: GlassRamp, key: keyof GlassStops, a = 1) => svg("stop", { offset: String(offset), style: `stop-color:light-dark(${alpha(ramp.light[key], a)}, ${alpha(ramp.dark[key], a)})` });

function shapeOf(s: GlassShape, small: boolean): SVGElement {
  const width = String(small ? s.smallWidth : s.width);
  if (s.kind === "tube") return svg("path", { d: s.d, fill: "none", "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" });
  return svg("path", s.width || small ? { d: s.d, "stroke-width": width, "stroke-linejoin": "round" } : { d: s.d, stroke: "none" });
}

/** A ramp's paint (GLASS_PAINT): its four layers over the shape's 100-unit box, as one pattern. */
function paintOf(id: string, ramp: GlassRamp): SVGElement[] {
  const p = GLASS_PAINT;
  const at = (n: number) => String(n / 100);
  const shade = (a: number, b: number) => svg("stop", { offset: "0", style: `stop-color:light-dark(${alpha(ramp.light.deep, a)}, ${alpha(ramp.dark.deep, b)})` });
  return [
    svg("linearGradient", { id: `gl-${id}`, x1: "0", y1: "0", x2: "1", y2: "1" }, stopOf(0, ramp, "a"), stopOf(1, ramp, "b")),
    svg("radialGradient", { id: `gc-${id}`, cx: at(p.accent.at[0]), cy: at(p.accent.at[1]), r: at(p.accent.r) }, stopOf(0, ramp, "accent", p.accent.opacity), stopOf(1, ramp, "accent", 0)),
    svg("radialGradient", { id: `gw-${id}`, cx: at(p.highlight.at[0]), cy: at(p.highlight.at[1]), r: at(p.highlight.r) }, ...p.highlight.stops.map(([o, a]) => stopOf(o, ramp, "highlight", a))),
    svg("radialGradient", { id: `gd-${id}`, cx: at(p.shade.at[0]), cy: at(p.shade.at[1]), r: at(p.shade.r) }, shade(p.shade.opacity.light, p.shade.opacity.dark), stopOf(1, ramp, "deep", 0)),
    svg("pattern", { id: `gp-${id}`, patternUnits: "userSpaceOnUse", width: "100", height: "100" }, ...["gl", "gc", "gw", "gd"].map((layer) => svg("rect", { width: "100", height: "100", fill: `url(#${layer}-${id})` }))),
  ];
}

/** Its styles: the glow, the dot and the breathing (GLASS_GLOW, GLASS_DOT), your agent's bare I-beam and pearl tile. */
export const GLASS_CSS = `
:root { --gl-dark: 0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --gl-dark: 1; } }
:root[data-theme="dark"] { --gl-dark: 1; }
.agent-glass, .guardian-mark { position: relative; display: inline-block; flex: none; width: var(--orb-size); height: var(--orb-size); }
.agent-glass > svg, .guardian-mark > svg { position: relative; display: block; width: 100%; height: 100%; overflow: visible; }
.agent-glass::before, .agent-glass::after { content: ""; position: absolute; pointer-events: none; border-radius: 50%; }
.agent-glass.gl-pool::before {
  inset: ${-GLASS_GLOW.pool.spread * 100}%;
  background: radial-gradient(closest-side, light-dark(transparent, color-mix(in oklab, var(--ga) ${GLASS_GLOW.pool.stops[0]![2] * 100}%, transparent)), light-dark(transparent, color-mix(in oklab, var(--gb) ${GLASS_GLOW.pool.stops[1]![2] * 100}%, transparent)) ${GLASS_GLOW.pool.stops[1]![0] * 100}%, transparent);
  opacity: ${GLASS_GLOW.pool.opacity.dark};
}
.agent-glass.gl-shade::after {
  left: ${GLASS_GLOW.shadow.box.left * 100}%; right: ${GLASS_GLOW.shadow.box.right * 100}%; top: ${GLASS_GLOW.shadow.box.top * 100}%; bottom: ${(1 - GLASS_GLOW.shadow.box.bottom) * 100}%;
  background: radial-gradient(closest-side, light-dark(color-mix(in oklab, var(--gb) ${GLASS_GLOW.shadow.stops[0]![2] * 100}%, transparent), transparent), transparent);
  opacity: ${GLASS_GLOW.shadow.opacity.light};
}
.agent-glass .gl-blur { opacity: calc(${GLASS_GLOW.blur.opacity.light} + var(--gl-dark) * ${+(GLASS_GLOW.blur.opacity.dark - GLASS_GLOW.blur.opacity.light).toFixed(2)}); transform: translateY(calc((1 - var(--gl-dark)) * ${GLASS_GLOW.blur.dy.light}px)); }
.agent-glass[data-state="working"]::before { animation: gl-pool ${GLASS_GLOW.period}s ease-in-out infinite; }
.agent-glass[data-state="working"]::after { animation: gl-shade ${GLASS_GLOW.period}s ease-in-out infinite; }
@keyframes gl-pool { 0%, 100% { opacity: ${GLASS_GLOW.pool.breathe}; } 50% { opacity: 1; } }
@keyframes gl-shade { 0%, 100% { opacity: ${GLASS_GLOW.shadow.breathe}; } 50% { opacity: 1; } }
:root[data-hidden] .agent-glass::before, :root[data-hidden] .agent-glass::after { animation-play-state: paused; }
:root[data-motion="reduce"] .agent-glass[data-state="working"]::before, :root[data-motion="reduce"] .agent-glass[data-state="working"]::after { animation: none; }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) .agent-glass[data-state="working"]::before, :root:not([data-motion="full"]) .agent-glass[data-state="working"]::after { animation: none; } }
.gl-dot { position: absolute; right: calc(-1 * var(--gl-dot-out)); bottom: calc(-1 * var(--gl-dot-out)); width: var(--gl-dot); height: var(--gl-dot); border-radius: 50%; background: var(--gl-dot-c); box-shadow: 0 0 0 var(--gl-dot-cut) var(--gl-surface, var(--bg)); }
[data-state="working"] > .gl-dot { --gl-dot-c: light-dark(${GLASS_DOT.colors.working.light}, ${GLASS_DOT.colors.working.dark}); }
[data-state="needs"] > .gl-dot { --gl-dot-c: light-dark(${GLASS_DOT.colors.needs.light}, ${GLASS_DOT.colors.needs.dark}); }
[data-state="failed"] > .gl-dot { --gl-dot-c: light-dark(${GLASS_DOT.colors.failed.light}, ${GLASS_DOT.colors.failed.dark}); }
[data-state="idle"] > .gl-dot { --gl-dot-c: var(--gl-surface, var(--bg)); box-shadow: inset 0 0 0 ${GLASS_DOT.idleRing}px light-dark(${GLASS_DOT.colors.idle.light}, ${GLASS_DOT.colors.idle.dark}), 0 0 0 var(--gl-dot-cut) var(--gl-surface, var(--bg)); }
.guardian-mark.gm-mono polygon { fill: var(--accent); }
.guardian-mark.gm-pearl { border-radius: 28%; background: light-dark(${GLASS_PEARL_TILE.light}, transparent); }
`;

/** The page's sprite and styles, made once, the first time a glass is drawn (none where there is no page: the tests'). */
function ensureSprite(): void {
  if (typeof document === "undefined" || typeof document.getElementById !== "function" || document.getElementById(SPRITE)) return;
  const defs = svg(
    "defs",
    {},
    ...GLASS_SHAPES.flatMap((s, n) => [svg("g", { id: `gs-${n}` }, shapeOf(s, false)), svg("g", { id: `gs-${n}-s` }, shapeOf(s, true))]),
    svg("g", { id: "gs-ibeam" }, shapeOf(GLASS_IBEAM, false)),
    svg("g", { id: "gs-ibeam-s" }, shapeOf(GLASS_IBEAM, true)),
    ...GLASS_RAMPS.flatMap((ramp, n) => paintOf(String(n), ramp)),
    ...paintOf("pearl", GLASS_PEARL),
    svg("filter", { id: "gl-blur", x: "-45%", y: "-45%", width: "190%", height: "190%" }, svg("feGaussianBlur", { stdDeviation: String(GLASS_GLOW.blur.radius) })),
  );
  const sprite = svg("svg", { id: SPRITE, width: "0", height: "0", "aria-hidden": "true", focusable: "false", style: "position:absolute;width:0;height:0;overflow:hidden" }, defs);
  document.body.prepend(sprite);
  const style = document.createElement("style");
  style.id = `${SPRITE}-css`;
  style.textContent = GLASS_CSS;
  document.head.append(style);
  // Hidden, nothing breathes: kept on the root, so CSS pauses it.
  const hidden = () => document.documentElement.toggleAttribute("data-hidden", document.visibilityState === "hidden");
  document.addEventListener?.("visibilitychange", hidden);
  hidden();
}

/** The dot's size for an avatar's (GLASS_DOT): its diameter, how far past the corner it sits, its cut. */
function dotStyle(size: number): string {
  const d = GLASS_DOT.sizes.find((s) => size <= s.upTo) ?? GLASS_DOT.sizes[GLASS_DOT.sizes.length - 1]!;
  return `--gl-dot:${d.size}px;--gl-dot-out:${d.out}px;--gl-dot-cut:${d.cut}px`;
}

const clampSize = (size: number): number => (Number.isFinite(size) ? Math.round(Math.max(16, Math.min(256, size))) : 40);
const named = (label: string | undefined) => (label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" });

function glassUse(href: string, paint: string, big: boolean): SVGElement[] {
  const use = (extra: Record<string, string>) => svg("use", { href, fill: paint, stroke: paint, ...extra });
  return big ? [use({ class: "gl-blur", filter: "url(#gl-blur)" }), use({})] : [use({})];
}

export interface GlassAvatarOptions {
  id: string;
  /** Its saved avatar: its glass (v 4), a mark (v 3) or a colour chosen before (v 2), or nothing (core's glassOf). */
  profile?: unknown;
  /** Its width and height in CSS pixels (16 to 256). */
  size: number;
  /** Its state, as a dot; left out, none (its row says it, or nothing is said). */
  state?: GlassState;
  /** Its accessible name; left out, it is decorative (its name is beside it). */
  label?: string;
}

/** An agent's glass: its shape in its ramp, its glow, and its state's dot. */
export function glassAvatar(options: GlassAvatarOptions): HTMLElement {
  ensureSprite();
  const size = clampSize(options.size);
  const glass = glassOf(String(options.id ?? ""), options.profile);
  const small = size <= 16;
  const ramp = GLASS_RAMPS[glass.color]!;
  const classes = ["agent-orb", "agent-glass", size >= GLASS_GLOW.pool.minSize ? "gl-pool" : "", size >= GLASS_GLOW.shadow.minSize ? "gl-shade" : ""].filter(Boolean).join(" ");
  return h(
    "span",
    {
      class: classes,
      ...(options.state ? { "data-state": options.state } : {}),
      // (Its colours are core's ramps', never a profile's words: glassOf reads a saved colour only as one of the eight.)
      style: `--orb-size:${size}px;--ga:${ld(ramp, "a")};--gb:${ld(ramp, "b")};${dotStyle(size)}`,
      "data-shape": GLASS_SHAPES[glass.shape]!.id,
      "data-ramp": ramp.id,
      ...named(options.label),
    },
    svg("svg", { viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }, ...glassUse(`#gs-${glass.shape}${small ? "-s" : ""}`, `url(#gp-${glass.color})`, size >= GLASS_GLOW.blur.minSize)),
    ...(options.state ? [h("i", { class: "gl-dot" })] : []),
  );
}

/* ---------- your agent ---------- */

export type GuardianStyle = "mono" | "pearl";
const GUARDIAN_KEY = "invincible.guardian-mark";

/** How your agent's mark is drawn on this device: the bare I-beam in one ink (mono, until the owner chooses), or in
 * pearl glass. */
export function guardianStyle(): GuardianStyle {
  try {
    return globalThis.localStorage?.getItem(GUARDIAN_KEY) === "pearl" ? "pearl" : "mono";
  } catch {
    return "mono";
  }
}

export function setGuardianStyle(style: GuardianStyle): void {
  try {
    globalThis.localStorage?.setItem(GUARDIAN_KEY, style);
  } catch {
    /* a private window keeps it for this visit at most */
  }
}

/** Your agent's mark, in the box an orb takes: the bare I-beam in one ink, or in pearl glass; still. `cls` and
 * `attrs` are its caller's own (an orb's class and where it stands). */
export function guardianMark(options: { size: number; label?: string; style?: GuardianStyle; state?: GlassState; cls?: string; attrs?: Record<string, string> }): HTMLElement {
  // (An orb's bounds: 16 to 320.)
  const size = Number.isFinite(options.size) ? Math.round(Math.max(16, Math.min(320, options.size))) : 36;
  const dotted = options.state ? `;${dotStyle(size)}` : "";
  const style = options.style ?? guardianStyle();
  const extra = options.cls ? ` ${options.cls}` : "";
  const state = { ...(options.attrs ?? {}), ...(options.state ? { "data-state": options.state } : {}) };
  const dot = options.state ? [h("i", { class: "gl-dot" })] : [];
  if (style === "pearl") {
    ensureSprite();
    // Lit as an agent's glass is (its rules: the pool, and the blur's opacity and drop by page), in the pearl: its pool on a
    // dark page from 24; on a light one it sits on its graphite tile, so no shadow under it (the designer's gl-guardian).
    const pool = size >= GLASS_GLOW.pool.minSize ? " gl-pool" : "";
    return h(
      "span",
      { class: `guardian-mark gm-pearl agent-glass${pool}${extra}`, style: `--orb-size:${size}px;--ga:${ld(GLASS_PEARL, "a")};--gb:${ld(GLASS_PEARL, "b")}${dotted}`, ...state, ...named(options.label) },
      svg("svg", { viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }, ...glassUse(`#gs-ibeam${size <= 16 ? "-s" : ""}`, "url(#gp-pearl)", size >= GLASS_GLOW.blur.minSize)),
      ...dot,
    );
  }
  ensureSprite();
  return h(
    "span",
    { class: `guardian-mark gm-mono${extra}`, style: `--orb-size:${size}px${dotted}`, ...state, ...named(options.label) },
    svg("svg", { class: "ibeam", viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }, svg("polygon", { points: MARK_POLYGON })),
    ...dot,
  );
}
