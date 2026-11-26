import type { Agent, TeamTask, TeamDelivery } from "./team.ts";

/** Cosmetic identity only. This module stays schema-free for the apps. An agent is an orb (AGENT_TINTS, agentColors):
 * its colour one you chose (OrbProfile) or one picked by its handle. */
/** What an agent can be seen doing (avatarExpression); its orb shows each one. */
export const AVATAR_EXPRESSIONS = ["idle", "thinking", "working", "reading", "browsing", "checking", "waiting", "asking", "pleased", "concerned", "resting"] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

const hexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/**
 * An agent is an orb (your word, 25 November 2026: "drop the agent avatars, and just use custom/procedurally generated
 * colored particle orbs"): a sphere of points of light, turning, in a colour of its own. Its colour is one you chose for
 * it (an OrbProfile, saved as its avatar), or else one of these 24, picked by its handle, the same on every device. Each
 * is OKLCH lightness 0.76 and chroma 0.15 (less where a screen can't show it), every 15 degrees round the hue circle
 * from 10.
 */
export const AGENT_TINTS = [
  "#fe879c", "#ff8a83", "#ff8d65", "#f99549", "#ed9e2f", "#dca81c", "#c8b222", "#afbc3a", "#91c456", "#6eca73", "#41ce90", "#0cceac",
  "#0dcbc3", "#11c8d8", "#04c4ed", "#3abeff", "#6fb6fe", "#8bafff", "#a2a8fe", "#b89ffe", "#ce94f8", "#e08ee5", "#ef89cf", "#fa86b6",
] as const;
/** Each tint's name, as a colour picker says it. */
export const AGENT_TINT_NAMES = [
  "Rose", "Coral", "Salmon", "Orange", "Amber", "Gold", "Mustard", "Olive", "Lime", "Green", "Jade", "Mint",
  "Teal", "Turquoise", "Cyan", "Sky", "Azure", "Cornflower", "Periwinkle", "Lavender", "Violet", "Orchid", "Pink", "Blush",
] as const;

/** A colour you chose for an agent's orb: a six-digit hex colour, and nothing else. */
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
  AGENT_TINTS.forEach((tint, n) => {
    const [tr, tg, tb] = rgb(tint);
    const apart = (r! - tr!) ** 2 + (g! - tg!) ** 2 + (b! - tb!) ** 2;
    if (apart < bestApart) [best, bestApart] = [n, apart];
  });
  return best;
}

/** An agent's orb's colours: its tint, the tint lit (45 % of the way to white) and in shadow (52 % of the way to black),
 * a second colour a few of its points are (the tint three to six steps on round the circle from its own), and whether
 * you chose its tint. */
export interface AgentColors {
  tint: string;
  light: string;
  deep: string;
  second: string;
  chosen: boolean;
}

export function agentColors(id: string, profile?: unknown): AgentColors {
  const seed = handleSeed(String(id ?? ""));
  const chosen = isOrbProfile(profile) ? profile.color.toLowerCase() : null;
  const at = chosen ? nearestTint(chosen) : seed % AGENT_TINTS.length;
  const tint = chosen ?? AGENT_TINTS[at]!;
  return { tint, light: blendHex(tint, "#ffffff", 0.45), deep: blendHex(tint, "#000000", 0.52), second: AGENT_TINTS[(at + 3 + ((seed >>> 8) % 4)) % AGENT_TINTS.length]!, chosen: chosen !== null };
}

export interface AvatarActivity {
  /** `progress`, a task's latest line, where the caller has it: without it a running task is simply at work. */
  tasks: readonly (Pick<TeamTask, "assignee" | "status" | "verified" | "updatedAt"> & Partial<Pick<TeamTask, "progress">>)[];
  deliveries: readonly Pick<TeamDelivery, "agent" | "status" | "updatedAt">[];
}

/**
 * What a running task is at, from the mark that starts the latest line its run reported (the runner's own, one for
 * each step: "Plan · ", "Thinking · ", "Running · ", "Exit N · ", "Gate i/n · " and so on; packages/agents/src/team-runtime.ts
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
export function avatarExpression(member: Pick<Agent, "id" | "enabled">, activity: AvatarActivity, now: number): AvatarExpression {
  const tasks = activity.tasks.filter((task) => task.assignee === member.id);
  const deliveries = activity.deliveries.filter((delivery) => delivery.agent === member.id);
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
