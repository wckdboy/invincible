import { type AvatarExpression, handleSeed, isOrbProfile } from "./avatar.ts";

/*
 * An agent's mark: the Grille (O2: shown five directions on 26 November 2026, the owner chose "2 · Grille"). A solid
 * disc in the agent's own colour, cut into slats by two or three slots at its own angle, the I-beam's bars through the
 * orb. The primary (your agent) stays the I-beam in one ink: never a Grille.
 *
 * Its colour and its form are the node's to give, once, as the agent joins (assignMark, in the order agents joined:
 * joinOrder), and are saved as its avatar ({v: 3, color, form}: markProfile), so every device draws the same mark and
 * no mark shifts when another agent comes or goes. Everything here is data and pure geometry: every app draws the mark
 * from these numbers, held to them by the vectors' `marks`. Its design, the palette and the motion are O1's
 * (o1-grille/src/marks.ts), the sheet the owner chose from being the specification.
 */

export type MarkTheme = "light" | "dark";

/**
 * The palette: eight hues (OKLCH 72 to 334 degrees; none between pink-red and red-orange, which are failure's red),
 * each a light-page form at least 3:1 against the page and a dark-page form, neighbours alternating in lightness so they
 * part further. A colour is saved and compared as its light form.
 */
export const MARK_PALETTE = [
  { name: "Amber", light: "#c88200", dark: "#ffbc63" },
  { name: "Lime", light: "#699700", dark: "#b1ef4a" },
  { name: "Green", light: "#007745", dark: "#18c376" },
  { name: "Teal", light: "#04a19b", dark: "#34eee5" },
  { name: "Sky", light: "#0084ba", dark: "#3bb7f7" },
  { name: "Blue", light: "#3453d3", dark: "#5b81fe" },
  { name: "Violet", light: "#9a68da", dark: "#ccabff" },
  { name: "Magenta", light: "#a23493", dark: "#e26ace" },
] as const;

/** The page a mark is drawn on, the ink (the owner's own, what asks you turns), and the shared red (what failed). */
export const MARK_PAGE: Record<MarkTheme, string> = { light: "#ffffff", dark: "#000000" };
export const MARK_INK: Record<MarkTheme, string> = { light: "#0a0a0b", dark: "#ffffff" };
export const MARK_RED: Record<MarkTheme, string> = { light: "#c4141b", dark: "#ee2c36" };

/**
 * Each hue while queued: pale, 60 % of the way to the light page and 50 % to the dark one; and every mark while paused:
 * grey, 42 % and 40 % of the way from the page to the ink. Mixed in OKLab (as CSS color-mix(in oklab) does) once, here,
 * so every app draws the same colours without doing the mixing itself (agent-mark.test.ts mixes them again).
 */
export const MARK_QUEUED: readonly { light: string; dark: string }[] = [
  { light: "#ebcdaa", dark: "#634721" }, { light: "#c1d6a9", dark: "#425c17" }, { light: "#a5c8b1", dark: "#044a29" }, { light: "#b0d9d6", dark: "#0e5c58" },
  { light: "#aacee5", dark: "#114560" }, { light: "#a7bdf2", dark: "#1e2e63" }, { light: "#d5c3f3", dark: "#4e4063" }, { light: "#deafd4", dark: "#57244e" },
];
export const MARK_PAUSED: Record<MarkTheme, string> = { light: "#8c8c8d", dark: "#484848" };

/** The forms: the slots' angle, one of six, and two or three slots: form n is MARK_ANGLES[n % 6] with MARK_SLOTS[n / 6]. */
export const MARK_ANGLES = [-40, -27, -14, 14, 27, 40] as const;
export const MARK_SLOTS = [2, 3] as const;
export const MARK_FORMS = MARK_ANGLES.length * MARK_SLOTS.length;

export function markForm(form: number): { slots: 2 | 3; angle: number } {
  return { slots: MARK_SLOTS[Math.floor(form / MARK_ANGLES.length) % MARK_SLOTS.length]!, angle: MARK_ANGLES[form % MARK_ANGLES.length]! };
}

/** An agent's mark: its colour (an index into MARK_PALETTE) and its form (0 to 11). */
export interface AgentMark {
  color: number;
  form: number;
}

/** A mark as an agent's avatar saves it: its colour as its light form, and its form. */
export interface MarkProfile {
  v: 3;
  color: string;
  form: number;
}

const paletteIndex = (hex: string): number => MARK_PALETTE.findIndex((hue) => hue.light === hex);

/** A saved mark, read strictly: exactly v 3, a colour that is one of the eight (its light form, lowercase) and a whole form. */
export function isMarkProfile(profile: unknown): profile is MarkProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const p = profile as Record<string, unknown>;
  return Object.keys(p).length === 3 && p.v === 3 && typeof p.color === "string" && paletteIndex(p.color) >= 0 && Number.isInteger(p.form) && (p.form as number) >= 0 && (p.form as number) < MARK_FORMS;
}

export function readMarkProfile(profile: unknown): AgentMark | null {
  return isMarkProfile(profile) ? { color: paletteIndex(profile.color), form: profile.form } : null;
}

export function markProfile(mark: AgentMark): MarkProfile {
  return { v: 3, color: MARK_PALETTE[mark.color]!.light, form: mark.form };
}

/**
 * Which of the eight a colour is nearest: by the sum of each channel's difference squared (whole numbers, so every app
 * comes to the same one), to either of each hue's forms, the first on a tie. A colour you pick snaps to one of them,
 * never to red: there is no red among them.
 */
export function snapColor(hex: string): number {
  const rgb = (h: string) => [1, 3, 5].map((at) => parseInt(h.slice(at, at + 2), 16));
  const [r, g, b] = rgb(hex.toLowerCase());
  let best = 0, bestApart = Infinity;
  MARK_PALETTE.forEach((hue, n) => {
    for (const form of [hue.light, hue.dark]) {
      const [fr, fg, fb] = rgb(form);
      const apart = (r! - fr!) ** 2 + (g! - fg!) ** 2 + (b! - fb!) ** 2;
      if (apart < bestApart) [best, bestApart] = [n, apart];
    }
  });
  return best;
}

/** The handle's own mark, before any is given: its seed's colour and form (an agent's, where a node gave it none). */
function seeded(id: string): AgentMark {
  const seed = handleSeed(id);
  return { color: seed % MARK_PALETTE.length, form: (seed >>> 8) % MARK_FORMS };
}

/**
 * An agent's mark, from what it has: its own (v 3); a colour chosen for it before the marks (v 2, an OrbProfile),
 * snapped, with its handle's form; else its handle's. The node gives every agent here its own; the rest are for a
 * profile that came from elsewhere.
 */
export function markOf(id: string, profile?: unknown): AgentMark {
  const own = readMarkProfile(profile);
  if (own) return own;
  const handle = seeded(String(id ?? ""));
  return isOrbProfile(profile) ? { color: snapColor(profile.color), form: handle.form } : handle;
}

/**
 * The mark a node gives an agent as it joins, after `others` (the marks of the agents here before it, in the order they
 * joined): its colour the one its handle's seed points to, or the next one free, so no two share a colour until all
 * eight are taken (or the one you chose, snapped); its form the one its seed points to, or the next one no agent wears,
 * so colour and form both differ while they can; once every form is worn, the next one no agent of its colour wears, so
 * a ninth agent repeats a colour but never a form. O1's assign, as the sheet was drawn: hashing alone collides (three
 * of the dev fleet's ten shared a tint).
 */
export function assignMark(id: string, others: readonly AgentMark[], chosen?: string | null): AgentMark {
  const seed = handleSeed(String(id ?? ""));
  let color = seed % MARK_PALETTE.length;
  if (chosen) color = snapColor(chosen);
  else {
    const taken = new Set(others.map((m) => m.color));
    if (taken.size < MARK_PALETTE.length) while (taken.has(color)) color = (color + 1) % MARK_PALETTE.length;
  }
  const anyWorn = new Set(others.map((m) => m.form));
  const worn = new Set(others.filter((m) => m.color === color).map((m) => m.form));
  let form = (seed >>> 8) % MARK_FORMS;
  if (anyWorn.size < MARK_FORMS) while (anyWorn.has(form)) form = (form + 1) % MARK_FORMS;
  else if (worn.size < MARK_FORMS) while (worn.has(form)) form = (form + 1) % MARK_FORMS;
  return { color, form };
}

/** The order agents joined in: when each was made, then its handle (so a tie comes out the same on every node). */
export function joinOrder<T extends { id: string; createdAt: number }>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ---------- its states ---------- */

/**
 * What a mark shows: idle (solid and still); working (its slats slide, each in its own phase, calmly); needs (it asks
 * you: its top slat turns ink and beats); queued (pale); paused (grey); done (its slots close and open once as it
 * arrives, then still); failed (its bottom slat turns the shared red and drops loose: the shape carries the state, never
 * colour alone). Rows are always still, reduced motion stills everything, and nothing is drawn at rest.
 */
export const MARK_STATES = ["idle", "working", "needs", "queued", "paused", "done", "failed"] as const;
export type MarkState = (typeof MARK_STATES)[number];

/** Its motion's numbers: seconds. */
export const MARK_TIMING = { workCycle: 5.5, needsBeat: 4.2, doneSettle: 1.4, failDrop: 0.6 } as const;

/** The state an agent's mark shows for what it is seen doing (core's avatarExpression). */
export function markState(expression: AvatarExpression): MarkState {
  switch (expression) {
    case "thinking": case "working": case "reading": case "browsing": case "checking": return "working";
    case "asking": return "needs";
    case "waiting": return "queued";
    case "resting": return "paused";
    case "pleased": return "done";
    case "concerned": return "failed";
    default: return "idle";
  }
}

/** The colours it is drawn in: its body, and its key slat (the top one in ink when it asks you, the bottom one red when it failed). */
export function markColors(color: number, state: MarkState, theme: MarkTheme): { body: string; key: string } {
  const hue = MARK_PALETTE[color]![theme];
  const body = state === "queued" ? MARK_QUEUED[color]![theme] : state === "paused" ? MARK_PAUSED[theme] : hue;
  return { body, key: state === "needs" ? MARK_INK[theme] : state === "failed" ? MARK_RED[theme] : body };
}

/* ---------- its geometry ---------- */

/**
 * A slat, in a 100-unit box, about the box's middle and turned by the mark's angle: it lies across the disc from `from`
 * to `to` (along the slots' normal, downward before turning), as a band of the disc between those lines; slid `slide`
 * along its slot; filled as the body or the key; and, knocked loose, moved down `drop` units on the page and turned
 * `turn` degrees about `pivot` (a point of the box), the turn applied first.
 */
export interface MarkSlat {
  from: number;
  to: number;
  slide: number;
  fill: "body" | "key";
  drop: number;
  turn: number;
  pivot: [number, number];
}

export interface MarkGeometry {
  /** The slots' angle, degrees, clockwise. */
  angle: number;
  /** The disc's radius, units of the 100-unit box. */
  radius: number;
  slats: MarkSlat[];
}

/* ---------- its arithmetic: the same to the last bit everywhere ---------- */

/*
 * A mark's sines and cosines come from + − × ÷ and floor alone, in one fixed order, never from Math.sin, Math.cos or
 * Math.pow. What those say in their last bit is each platform's own: CI's Linux runner read one frame of the vectors one
 * bit off the Mac's (26 November 2026, a working slat's slide). Each of these operations is correctly rounded in
 * TypeScript, Swift and Kotlin, so every app draws a mark from exactly the vectors' numbers, as its colour is.
 *
 * An angle is taken to its quarter turn, q (the nearest), and what is left, r (|r| ≤ π/4, and a few ulps of reduction),
 * then Taylor's series to the 13th power for sine and the 14th for cosine: within 1e-13 of the true value for any angle
 * of a mark's, and 1e-10 a day into a page's clock (the reduction's share), far finer than any screen draws. The ports
 * copy these lines in this order.
 */
const QUARTER = Math.PI / 2;
const quarterOf = (x: number): { q: number; r: number } => {
  const q = Math.floor(x / QUARTER + 0.5);
  return { q, r: x - q * QUARTER };
};
const sinNear = (r: number): number => {
  const r2 = r * r;
  return r + r * r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800))))));
};
const cosNear = (r: number): number => {
  const r2 = r * r;
  return 1 + r2 * (-1 / 2 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600 + r2 * (-1 / 87178291200)))))));
};
/** Which quarter turn, 0 to 3, of a whole number of them. */
const turnOf = (q: number): number => q - 4 * Math.floor(q / 4);

/** The sine of `x` radians, the same to the last bit on every platform. */
export function markSin(x: number): number {
  const { q, r } = quarterOf(x);
  const m = turnOf(q);
  return m === 0 ? sinNear(r) : m === 1 ? cosNear(r) : m === 2 ? -sinNear(r) : -cosNear(r);
}

/** The cosine of `x` radians, the same to the last bit on every platform. */
export function markCos(x: number): number {
  const { q, r } = quarterOf(x);
  const m = turnOf(q);
  return m === 0 ? cosNear(r) : m === 1 ? -sinNear(r) : m === 2 ? -cosNear(r) : sinNear(r);
}

const TAU = Math.PI * 2;
const beat = (t: number, period: number) => 0.5 - 0.5 * markCos((TAU * t) / period);
const easeOut = (x: number) => {
  const left = 1 - Math.min(1, Math.max(0, x));
  return 1 - left * left * left;
};

/**
 * Its slats as they stand: `size` the mark's square in points (a slot is 7.5 units, or 1.35 pt where that is wider);
 * `t` seconds on the page's clock (null: still, as every row and reduced motion draw it); `since` seconds since it came
 * to its state (null: long ago, settled). `seed`: its handle's (handleSeed), which sets its slats' phase.
 */
export function markGeometry(input: { mark: AgentMark; seed: number; state: MarkState; size: number; t: number | null; since: number | null }): MarkGeometry {
  const { mark, seed, state, size, t, since } = input;
  const { slots, angle } = markForm(mark.form);
  const radius = 44;
  let gap = Math.max(7.5, (1.35 * 100) / size);
  if (state === "done") gap *= 1 - 0.85 * (since !== null && since < MARK_TIMING.doneSettle ? markSin(Math.PI * (since / MARK_TIMING.doneSettle)) : 0);
  const n = slots + 1;
  const width = (2 * radius - slots * gap) / n;
  const turned = (angle * Math.PI) / 180;
  const slats: MarkSlat[] = [];
  for (let i = 0; i < n; i++) {
    const from = -radius + i * (width + gap);
    const to = from + width;
    const key = state === "needs" ? i === 0 : state === "failed" ? i === n - 1 : false;
    let slide = 0;
    if (state === "working" && t !== null) slide = 6 * markSin(TAU * (t / MARK_TIMING.workCycle) + (i * TAU) / n + (seed % 7));
    if (key && state === "needs") slide = t !== null ? 3 + 4 * beat(t, MARK_TIMING.needsBeat) : 5;
    let drop = 0, turn = 0;
    const middle = (from + to) / 2;
    const pivot: [number, number] = [50 - middle * markSin(turned), 50 + middle * markCos(turned)];
    if (key && state === "failed") {
      const k = since === null ? 1 : easeOut(since / MARK_TIMING.failDrop);
      drop = 8 * k;
      turn = 10 * k;
    }
    slats.push({ from, to, slide, fill: key ? "key" : "body", drop, turn, pivot });
  }
  return { angle, radius, slats };
}
