import type { Teammate, TeamTask, TeamDelivery } from "./team.ts";

/** Cosmetic identity only. This module stays schema-free for the apps. A knight is an orb (KNIGHT_TINTS, knightColors):
 * its colour one you chose (OrbProfile) or one picked by its handle. The older profile (AvatarProfile, v 1) is still
 * read and kept, so an app from before the orbs can save one, but it colours nothing now: it named one of the owner's
 * drawings, which are gone (25 November 2026). */
export const AVATAR_FORMS = ["round", "armored", "hooded"] as const;
export const AVATAR_EYES = ["oval", "round", "visor"] as const;
export const AVATAR_ACCESSORIES = ["none", "plume", "ears", "crown"] as const;
export const AVATAR_TEMPERAMENTS = ["calm", "curious", "lively"] as const;
/** What a knight can be seen doing (avatarExpression); its avatar acts each one out. */
export const AVATAR_EXPRESSIONS = ["idle", "thinking", "working", "reading", "browsing", "checking", "waiting", "asking", "pleased", "concerned", "resting"] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

export interface AvatarProfile {
  v: 1;
  form: (typeof AVATAR_FORMS)[number];
  /** Validated six-digit CSS hex colors, never URLs or arbitrary styles. */
  color: string;
  accent: string;
  eyes: (typeof AVATAR_EYES)[number];
  accessory: (typeof AVATAR_ACCESSORIES)[number];
  temperament: (typeof AVATAR_TEMPERAMENTS)[number];
}

/** A knight's colour and its accent (the plume or crown it wears), the accent another tincture so the two stand apart.
 * The editor's presets, and what an unconfigured knight wears. Galahad's own (off-white, navy, oxblood) is none of
 * these. An identity's seeded palette is its place in this list, so the order is kept. */
export const AVATAR_PALETTES = [
  { name: "Gold", color: "#d9a43c", accent: "#2fa36b" },
  { name: "Steel", color: "#b9c8d6", accent: "#2a9d94" },
  { name: "Violet", color: "#9077de", accent: "#dcd6f2" },
  { name: "Copper", color: "#c9713b", accent: "#f2b65f" },
  { name: "Jade", color: "#4fb98a", accent: "#e8c35a" },
  { name: "Rose", color: "#e07a9a", accent: "#a65bd1" },
  { name: "Azure", color: "#4f8fe0", accent: "#f0e8d6" },
  { name: "Crimson", color: "#dd5a52", accent: "#d9d9e0" },
] as const;

/** Stable across devices and renames: seed only from the immutable teammate id.
 * This cosmetic hash is deliberately not used for security or ownership. */
export function defaultAvatar(id: string): AvatarProfile {
  let seed = 2166136261;
  for (let n = 0; n < id.length; n++) seed = Math.imul(seed ^ id.charCodeAt(n), 16777619) >>> 0;
  const next = (count: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % count; };
  const palette = AVATAR_PALETTES[next(AVATAR_PALETTES.length)]!;
  return { v: 1, form: AVATAR_FORMS[next(AVATAR_FORMS.length)]!, color: palette.color, accent: palette.accent,
    eyes: AVATAR_EYES[next(AVATAR_EYES.length)]!, accessory: AVATAR_ACCESSORIES[next(AVATAR_ACCESSORIES.length)]!,
    temperament: AVATAR_TEMPERAMENTS[next(AVATAR_TEMPERAMENTS.length)]! };
}

const PROFILE_KEYS = ["v", "form", "color", "accent", "eyes", "accessory", "temperament"];
const memberOf = <T extends readonly string[]>(values: T, value: unknown): value is T[number] => typeof value === "string" && values.includes(value);
const hexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/** The accent that belongs with an armor color (a six-digit hex): a preset's own for a preset's color,
 * otherwise a deeper, quieter tone of the same hue. Dark armor gets a lighter one, so it still shows. */
export function matchingAccent(color: string): string {
  if (!hexColor(color)) throw new TypeError("a six-digit hex color");
  const hex = color.toLowerCase();
  const preset = AVATAR_PALETTES.find((palette) => palette.color === hex);
  if (preset) return preset.accent;
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), spread = max - Math.min(r, g, b);
  const light = max - spread / 2;
  const hue = !spread ? 0 : max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4;
  const vivid = spread ? spread / (1 - Math.abs(2 * light - 1)) : 0;
  const tone = light < 0.4 ? light + 0.26 : light - 0.22;
  const chroma = (1 - Math.abs(2 * tone - 1)) * Math.min(1, vivid) * 0.72;
  // HSL back to RGB: where a channel sits round the hue circle decides how much of the chroma it carries.
  const channel = (n: number) => { const k = (n + hue + 6) % 6; return tone - chroma / 2 + chroma * (1 - Math.max(0, Math.min(k, 4 - k, 1))); };
  return `#${[5, 3, 1].map((n) => Math.round(channel(n) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** A new armor color. Its accent follows, unless the owner had chosen one apart from the armor's own;
 * a value that isn't a color is left for the boundary to refuse. */
export function withBodyColor(profile: AvatarProfile, color: string): AvatarProfile {
  if (!hexColor(color)) return { ...profile, color };
  const next = color.toLowerCase();
  return { ...profile, color: next, accent: profile.accent === matchingAccent(profile.color) ? matchingAccent(next) : profile.accent };
}

/** A profile as it is saved: exactly its seven fields, each one valid. Anything else is old or malformed. */
export function isAvatarProfile(profile: unknown): profile is AvatarProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const p = profile as Record<string, unknown>;
  return Object.keys(p).length === PROFILE_KEYS.length && Object.keys(p).every((key) => PROFILE_KEYS.includes(key))
    && p.v === 1 && memberOf(AVATAR_FORMS, p.form) && hexColor(p.color) && hexColor(p.accent)
    && memberOf(AVATAR_EYES, p.eyes) && memberOf(AVATAR_ACCESSORIES, p.accessory) && memberOf(AVATAR_TEMPERAMENTS, p.temperament);
}

/**
 * A knight is an orb (your word, 25 November 2026: "drop the knight avatars, and just use custom/procedurally generated
 * colored particle orbs"): a sphere of points of light, turning, in a colour of its own. Its colour is one you chose for
 * it (an OrbProfile, saved as its avatar), or else one of these 24, picked by its handle, the same on every device. Each
 * is OKLCH lightness 0.76 and chroma 0.15 (less where a screen can't show it), every 15 degrees round the hue circle
 * from 10. A profile from the drawings (AvatarProfile, v 1) colours nothing any more: its colour was a drawing's.
 */
export const KNIGHT_TINTS = [
  "#fe879c", "#ff8a83", "#ff8d65", "#f99549", "#ed9e2f", "#dca81c", "#c8b222", "#afbc3a", "#91c456", "#6eca73", "#41ce90", "#0cceac",
  "#0dcbc3", "#11c8d8", "#04c4ed", "#3abeff", "#6fb6fe", "#8bafff", "#a2a8fe", "#b89ffe", "#ce94f8", "#e08ee5", "#ef89cf", "#fa86b6",
] as const;
/** Each tint's name, as a colour picker says it. */
export const KNIGHT_TINT_NAMES = [
  "Rose", "Coral", "Salmon", "Orange", "Amber", "Gold", "Mustard", "Olive", "Lime", "Green", "Jade", "Mint",
  "Teal", "Turquoise", "Cyan", "Sky", "Azure", "Cornflower", "Periwinkle", "Lavender", "Violet", "Orchid", "Pink", "Blush",
] as const;

/** A colour you chose for a knight's orb: a six-digit hex colour, and nothing else. */
export interface OrbProfile {
  v: 2;
  color: string;
}

export function isOrbProfile(profile: unknown): profile is OrbProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const p = profile as Record<string, unknown>;
  return Object.keys(p).length === 2 && p.v === 2 && hexColor(p.color);
}

/** A whole number for a handle: FNV-1a over its UTF-16 code units, unsigned 32-bit (the apps' orbSeed is the same). */
export function handleSeed(id: string): number {
  let seed = 0x811c9dc5;
  for (let n = 0; n < id.length; n++) seed = Math.imul(seed ^ id.charCodeAt(n), 0x01000193) >>> 0;
  return seed >>> 0;
}

/** Each channel `t` of the way from one colour to another (sRGB, as whole numbers: `c + (to - c) * t`, rounded), so
 * every app comes to the same colour. */
export function blendHex(from: string, to: string, t: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => { const c = channel(from, at); return Math.round(c + (channel(to, at) - c) * t).toString(16).padStart(2, "0"); }).join("")}`;
}

/** Which of the 24 tints is nearest a colour (by the sum of each channel's difference squared; the first, on a tie). */
export function nearestTint(color: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [r, g, b] = rgb(color.toLowerCase());
  let best = 0, bestApart = Infinity;
  KNIGHT_TINTS.forEach((tint, n) => {
    const [tr, tg, tb] = rgb(tint);
    const apart = (r! - tr!) ** 2 + (g! - tg!) ** 2 + (b! - tb!) ** 2;
    if (apart < bestApart) [best, bestApart] = [n, apart];
  });
  return best;
}

/** A knight's orb's colours: its tint, the tint lit (45 % of the way to white) and in shadow (52 % of the way to black),
 * a second colour a few of its points are (the tint three to six steps on round the circle from its own), and whether
 * you chose its tint. */
export interface KnightColors {
  tint: string;
  light: string;
  deep: string;
  second: string;
  chosen: boolean;
}

export function knightColors(id: string, profile?: unknown): KnightColors {
  const seed = handleSeed(String(id ?? ""));
  const chosen = isOrbProfile(profile) ? profile.color.toLowerCase() : null;
  const at = chosen ? nearestTint(chosen) : seed % KNIGHT_TINTS.length;
  const tint = chosen ?? KNIGHT_TINTS[at]!;
  return { tint, light: blendHex(tint, "#ffffff", 0.45), deep: blendHex(tint, "#000000", 0.52), second: KNIGHT_TINTS[(at + 3 + ((seed >>> 8) % 4)) % KNIGHT_TINTS.length]!, chosen: chosen !== null };
}

/** Old or malformed snapshots get a safe deterministic appearance. Never pass
 * arbitrary CSS, URLs or extra properties through to an SVG/world renderer. */
export function resolveAvatar(id: string, profile?: unknown): AvatarProfile {
  if (!isAvatarProfile(profile)) return defaultAvatar(id);
  return { v: 1, form: profile.form, color: profile.color.toLowerCase(), accent: profile.accent.toLowerCase(), eyes: profile.eyes, accessory: profile.accessory, temperament: profile.temperament };
}

/** The owner's ten drawings of knights, each by the name it was drawn as, its helm's colour, and its helmet's shape.
 * (Galahad's own drawing, and the Black Knight's he becomes in beast mode, are his alone: not among these.) */
export const AVATAR_LOOKS = [
  { id: "kay", name: "Kay", color: "#f9e9d9", form: "hooded" },
  { id: "gaheris", name: "Gaheris", color: "#9c494f", form: "armored" },
  { id: "percival", name: "Percival", color: "#d5adc7", form: "armored" },
  { id: "palamedes", name: "Palamedes", color: "#945764", form: "armored" },
  { id: "gawain", name: "Gawain", color: "#84845e", form: "round" },
  { id: "tristan", name: "Tristan", color: "#999aab", form: "armored" },
  { id: "lancelot", name: "Lancelot", color: "#93a2c0", form: "armored" },
  { id: "bedivere", name: "Bedivere", color: "#9dac9e", form: "armored" },
  { id: "bors", name: "Bors", color: "#be7153", form: "round" },
  { id: "gareth", name: "Gareth", color: "#fbc866", form: "round" },
] as const satisfies readonly { id: string; name: string; color: string; form: AvatarProfile["form"] }[];
export type AvatarLook = (typeof AVATAR_LOOKS)[number]["id"];

/** The profile saved for a look: the drawing's own colour names it. */
export function lookProfile(look: AvatarLook, temperament: AvatarProfile["temperament"] = "calm"): AvatarProfile {
  const { color, form } = AVATAR_LOOKS.find((each) => each.id === look) ?? AVATAR_LOOKS[0];
  return { v: 1, form, color, accent: matchingAccent(color), eyes: "oval", accessory: "none", temperament };
}

/** How far apart two colours look: RGB weighted by how much red there is ("redmean"), plenty for picking a nearest. */
function apart(a: string, b: string): number {
  const [r1, g1, b1] = [1, 3, 5].map((at) => parseInt(a.slice(at, at + 2), 16));
  const [r2, g2, b2] = [1, 3, 5].map((at) => parseInt(b.slice(at, at + 2), 16));
  const red = (r1! + r2!) / 2;
  return Math.sqrt((2 + red / 256) * (r1! - r2!) ** 2 + 4 * (g1! - g2!) ** 2 + (2 + (255 - red) / 256) * (b1! - b2!) ** 2);
}

/**
 * Which drawing a knight wears. A look chosen for it (its profile has one of the drawings' colours) is the one; else
 * the drawing its first name is (a knight called Gareth is drawn as Gareth); else, for an older profile, the drawing
 * nearest its colour; else one of the ten from its handle alone, the same on every device.
 */
export function avatarLook(id: string, name: string, profile?: unknown): AvatarLook {
  const saved = isAvatarProfile(profile) ? profile.color.toLowerCase() : null;
  const chosen = AVATAR_LOOKS.find((look) => look.color === saved);
  if (chosen) return chosen.id;
  const first = String(name ?? "").trim().toLowerCase().split(/\s+/)[0];
  const named = AVATAR_LOOKS.find((look) => look.id === first);
  if (named) return named.id;
  if (saved) return AVATAR_LOOKS.reduce((best, look) => (apart(look.color, saved) < apart(best.color, saved) ? look : best)).id;
  let seed = 2166136261;
  for (let n = 0; n < id.length; n++) seed = Math.imul(seed ^ id.charCodeAt(n), 16777619) >>> 0;
  return AVATAR_LOOKS[seed % AVATAR_LOOKS.length]!.id;
}

export interface AvatarActivity {
  /** `progress`, a task's latest line, where the caller has it: without it a running task is simply at work. */
  tasks: readonly (Pick<TeamTask, "assignee" | "status" | "verified" | "updatedAt"> & Partial<Pick<TeamTask, "progress">>)[];
  deliveries: readonly Pick<TeamDelivery, "teammate" | "status" | "updatedAt">[];
}

/**
 * What a running task is at, from the mark that starts the latest line its run reported (the runner's own, one for
 * each step: "Plan · ", "Thinking · ", "Running · ", "Exit N · ", "Gate i/n · " and so on; packages/node/src/team-runtime.ts
 * writes them, and its tests hold the two together). Only the mark is read, never the words after it: a line without
 * one is work, whatever it says.
 */
export function taskStep(progress: string): Extract<AvatarExpression, "thinking" | "working" | "reading" | "browsing" | "checking"> {
  const line = progress.trimStart();
  if (line.startsWith("Plan · ") || line.startsWith("Thinking · ")) return "thinking";
  if (/^Running · desktop(\s|$)/.test(line)) return "browsing";
  if (line.startsWith("Running · ")) return "working";
  if (/^Exit -?\d+ · /.test(line)) return "reading";
  // (A bare "gates" or "gated" is how a task's line said them before they were said in words.)
  if (/^(Gate \d+\/\d+ · |Gates · |Gates before the work · |Review · |Submitted for review · )/.test(line) || /^gate[sd]$/.test(line.trimEnd())) return "checking";
  return "working";
}

/** Expressions describe observable work, never inferred mood or private text. */
export function avatarExpression(member: Pick<Teammate, "id" | "enabled">, activity: AvatarActivity, now: number): AvatarExpression {
  const tasks = activity.tasks.filter((task) => task.assignee === member.id);
  const deliveries = activity.deliveries.filter((delivery) => delivery.teammate === member.id);
  const running = tasks.find((task) => task.status === "running");
  if (running) return taskStep(running.progress ?? "");
  if (deliveries.some((delivery) => delivery.status === "running")) return "thinking";
  if (!member.enabled) return "resting";
  const work = [...tasks, ...deliveries];
  if (tasks.some((task) => task.status === "proposed")) return "asking";
  if (work.some((job) => job.status === "queued")) return "waiting";
  const recent = (at: number) => now >= at && now - at < 30_000;
  if (work.some((job) => (job.status === "failed" || job.status === "interrupted") && recent(job.updatedAt))) return "concerned";
  if (tasks.some((task) => task.status === "done" && task.verified && recent(task.updatedAt))) return "pleased";
  return "idle";
}
