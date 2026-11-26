import type { OrbLevel } from "./orb.ts";

/*
 * How Galahad's orb and a knight's seat move (your word, 24 November 2026: "cool orbs/particles, pulsing/moving when
 * doing a task, sitting idle, waiting, done"), as data and one pure function of time. The Apple app and the Android app
 * draw a frame from it, held to it by the vectors (apps/apple/scripts/vectors.ts). Since 26 November 2026 the PWA draws
 * fields (lib/field-orb.ts, whose moods are these moods) and takes from here only the moods of a state and of an
 * expression, the seeds and the longest step; the rest goes when the apps port the field (PLAN #60).
 *
 * Each state has a mood:
 * - idle: a slow breath, with a few motes drifting round.
 * - working: the display turns, a light runs round its inner ring, and motes stream in.
 * - waiting on you: an amber beat that sends out waves.
 * - queued: a slow grey light goes round.
 * - paused: nearly still.
 * - done: a burst, then green with a glint going round.
 * - failed: the turning stops and the motes run down its sides.
 *
 * All of it slow and calm (your word, 25 November 2026: "slow and calming movement"): a breath takes 4 to 12 seconds, a
 * ring turns a few degrees a second, and a mood arrives over more than a second. This replaces the stillness asked for
 * on 18 November 2026, on your later word. Nothing moves when the device asks for
 * reduced motion: the still orb (lib/orb.ts) is drawn then, which is this function's frame with nothing under way.
 * Nothing here comes from a name's meaning, a profile or a model; a knight's handle only seeds where its motes start.
 */

export type OrbMood = "idle" | "working" | "waiting" | "queued" | "paused" | "done" | "failed";
export const ORB_MOODS: readonly OrbMood[] = ["idle", "working", "waiting", "queued", "paused", "done", "failed"];

export interface OrbMotion {
  /** Seconds a breath takes, in and out. */
  breath: number;
  /** How much the sphere swells with each breath (0.02 is 2 % of its size); its glow swells ten times as much. */
  swell: number;
  /** Degrees a second the display's rings turn (negative: the other way). Three rings turn: the outer ring with its
   * notches, the ticks with their marks, and the segments. */
  turn: { ring: number; ticks: number; segments: number };
  /** A light running round the inner ring (on a knight's seat, round its own ring): degrees a second, and the length of
   * its tail in degrees. */
  comet: { speed: number; tail: number } | null;
  /** Seconds between two waves sent out from its edge. */
  ripple: number | null;
  /** Its motes:
   * - count: how many.
   * - speed: degrees a second they go round; each mote between half and one and a half times this.
   * - sway: how far each strays across its band, as a share of the band.
   * - flow: round (orbit), streaming in from outside (inward), or running down its sides (fall). */
  motes: { count: number; speed: number; sway: number; flow: "orbit" | "inward" | "fall" };
  /** How strongly a knight's ring glows round it in this mood, 0 to 1 (the glow breathes with it). Galahad's own glow
   * is his orb's halo. */
  aura: number;
}

export const ORB_MOTION: Readonly<Record<OrbMood, OrbMotion>> = {
  idle: { breath: 9, swell: 0.01, turn: { ring: 1.6, ticks: 0, segments: -2.4 }, comet: null, ripple: null, motes: { count: 10, speed: 3.5, sway: 0.2, flow: "orbit" }, aura: 0.1 },
  working: { breath: 5.2, swell: 0.016, turn: { ring: 9, ticks: 2.2, segments: -14 }, comet: { speed: 55, tail: 110 }, ripple: null, motes: { count: 16, speed: 9, sway: 0, flow: "inward" }, aura: 0.26 },
  waiting: { breath: 4.2, swell: 0.024, turn: { ring: 2.5, ticks: 0, segments: -3.5 }, comet: null, ripple: 4.2, motes: { count: 10, speed: 4, sway: 0.35, flow: "orbit" }, aura: 0.34 },
  queued: { breath: 7, swell: 0.01, turn: { ring: 4, ticks: 0, segments: -4 }, comet: { speed: 18, tail: 60 }, ripple: null, motes: { count: 6, speed: 5, sway: 0.12, flow: "orbit" }, aura: 0.14 },
  paused: { breath: 12, swell: 0.005, turn: { ring: 0, ticks: 0, segments: 0 }, comet: null, ripple: null, motes: { count: 0, speed: 0, sway: 0, flow: "orbit" }, aura: 0.05 },
  done: { breath: 8, swell: 0.012, turn: { ring: 1, ticks: 0, segments: -1.5 }, comet: { speed: 20, tail: 40 }, ripple: null, motes: { count: 8, speed: 4, sway: 0.25, flow: "orbit" }, aura: 0.24 },
  failed: { breath: 6, swell: 0.014, turn: { ring: 0, ticks: 0, segments: 0 }, comet: null, ripple: null, motes: { count: 6, speed: 0, sway: 0, flow: "fall" }, aura: 0.24 },
};

/** Seconds a new mood takes to arrive: its motes, its light and its waves fade in over them (slowly: your word, 25
 * November 2026, "slow and calming movement"). */
export const ORB_ARRIVE = 1.6;
/** Seconds a burst takes (done, and a task's end), and how many motes drift out in it: a soft one. */
export const ORB_BURST = 2.6;
export const ORB_BURST_MOTES = 12;

/**
 * Where a knight stands at the Roundtable (lib/knight-state.ts' state), as its seat moves. Work is working. Needing you
 * is waiting. Verified and new are done. Failed, paused and queued are their own moods. At rest is idle.
 */
const STATE_MOODS: Readonly<Record<string, OrbMood>> = { working: "working", needs: "waiting", failed: "failed", paused: "paused", queued: "queued", verified: "done", unread: "done" };
export const orbMoodOfState = (state: string | undefined): OrbMood => (state && Object.hasOwn(STATE_MOODS, state) ? STATE_MOODS[state]! : "idle");

/**
 * What a knight is doing where only that is known (core's avatarExpression), as its orb's mood: thinking, at work,
 * reading, browsing and checking are work; waiting is queued; asking your leave waits on you; pleased is done;
 * concerned is failed; resting is paused; idle is idle.
 */
const EXPRESSION_MOODS: Readonly<Record<string, OrbMood>> = {
  idle: "idle", thinking: "working", working: "working", reading: "working", browsing: "working", checking: "working",
  waiting: "queued", asking: "waiting", pleased: "done", concerned: "failed", resting: "paused",
};
// (Only its own keys: an object answers to "constructor" and "toString" too.)
export const orbMoodOfExpression = (expression: string | undefined): OrbMood => (expression && Object.hasOwn(EXPRESSION_MOODS, expression) ? EXPRESSION_MOODS[expression]! : "idle");

/** Whether a change of mood bursts: arriving at done from any other mood, or at idle straight from work (a task's end
 * you watched). Never on first sight (`from` null): opening a page shows where things stand, settled. */
export const orbBursts = (from: OrbMood | null, to: OrbMood): boolean => from !== null && from !== to && (to === "done" || (to === "idle" && from === "working"));

/** A mote:
 * - angle: degrees clockwise from the top.
 * - u: where it is across its band, from 0 at the inner edge to 1 at the outer.
 * - size: a share of the largest mote's size, 0.5 to 1.
 * - alpha: how opaque, 0 to 1. */
export interface OrbMote {
  angle: number;
  u: number;
  size: number;
  alpha: number;
}

/** What an orb carries from one frame to the next, so a change of mood turns or swells nothing with a jump:
 * - ring, ticks, segments: degrees each turning ring has turned, 0 to 360.
 * - head: where its light's head is, in degrees.
 * - ringSpeed, ticksSpeed, segmentsSpeed, headSpeed: how fast each is turning now, in degrees a second, each easing to
 *   its mood's, so a ring speeds up and slows down rather than jumping to its new pace.
 * - tail: its light's tail, in degrees, kept while the light fades after a mood without one.
 * - breath: how far through a breath it is, 0 to 1.
 * - swell, light, aura: its swell, how bright its light is (0 to 1), and how strongly a knight's ring glows, each easing
 *   to its mood's. */
export interface OrbClock {
  ring: number;
  ticks: number;
  segments: number;
  head: number;
  ringSpeed: number;
  ticksSpeed: number;
  segmentsSpeed: number;
  headSpeed: number;
  tail: number;
  breath: number;
  swell: number;
  light: number;
  aura: number;
}

/** An orb as it is first seen, settled in its mood: its light's head and its breath where its seed puts them, so a
 * roster of seats never breathes or turns as one. */
export function orbClock(mood: OrbMood, seed = 0): OrbClock {
  const m = ORB_MOTION[mood] ?? ORB_MOTION.idle;
  return {
    ring: 0, ticks: 0, segments: 0, head: 360 * orbRand(seed >>> 0, 0, 7),
    ringSpeed: m.turn.ring, ticksSpeed: m.turn.ticks, segmentsSpeed: m.turn.segments, headSpeed: m.comet?.speed ?? 0,
    tail: m.comet?.tail ?? 0, breath: orbRand(seed >>> 0, 0, 8), swell: m.swell, light: m.comet ? 1 : 0, aura: m.aura,
  };
}

/** Seconds a speed, the swell and the light take to ease most of the way (63 %) to a new mood's. */
export const ORB_EASE = 0.35;
/** The longest step a frame takes: one late by more (a tab coming back) turns nothing a long way at once. */
export const ORB_LONGEST_STEP = 0.25;

/** The clock `dt` seconds on, in a mood: each speed, the swell and the light eased towards the mood's, then each ring
 * and the light's head turned on at its speed, and the breath further through. */
export function orbStep(clock: OrbClock, mood: OrbMood, dt: number): OrbClock {
  const m = ORB_MOTION[mood] ?? ORB_MOTION.idle;
  const d = Math.min(ORB_LONGEST_STEP, Math.max(0, dt));
  const ease = 1 - Math.exp(-d / ORB_EASE);
  const toward = (value: number, target: number) => value + (target - value) * ease;
  const [ringSpeed, ticksSpeed, segmentsSpeed] = [toward(clock.ringSpeed, m.turn.ring), toward(clock.ticksSpeed, m.turn.ticks), toward(clock.segmentsSpeed, m.turn.segments)];
  // A light fading after its mood slows to a stop where it was going; one coming in picks up speed.
  const headSpeed = toward(clock.headSpeed, m.comet?.speed ?? 0);
  return {
    ring: turned(clock.ring + ringSpeed * d),
    ticks: turned(clock.ticks + ticksSpeed * d),
    segments: turned(clock.segments + segmentsSpeed * d),
    head: turned(clock.head + headSpeed * d),
    ringSpeed,
    ticksSpeed,
    segmentsSpeed,
    headSpeed,
    tail: m.comet?.tail ?? clock.tail,
    breath: fract(clock.breath + d / m.breath),
    swell: toward(clock.swell, m.swell),
    light: toward(clock.light, m.comet ? 1 : 0),
    aura: toward(clock.aura, m.aura),
  };
}

/** A moment of an orb:
 * - scale: the sphere's size about its middle.
 * - glow: its glow, as a share of the still one's.
 * - aura: how strongly a knight's ring glows round it now, 0 to 1: its mood's, breathing with its glow.
 * - ring, ticks, segments: degrees each turning ring is turned.
 * - comet: its light's head and tail in degrees, and how bright it is; none once it has faded.
 * - ripples: how far each wave under way has gone, from 0 at its edge to 1 at its reach, the newest first.
 * - motes: the mood's own motes.
 * - leaving: while it arrives, the last mood's, fading.
 * - sparks: a burst's, flying out. */
export interface OrbFrame {
  scale: number;
  glow: number;
  aura: number;
  ring: number;
  ticks: number;
  segments: number;
  comet: { head: number; tail: number; alpha: number } | null;
  ripples: number[];
  motes: OrbMote[];
  leaving: OrbMote[];
  sparks: OrbMote[];
}

/** The still orb, as lib/orb.ts draws it: nothing turned, swollen or under way. What reduced motion shows. */
export const ORB_STILL: OrbFrame = { scale: 1, glow: 1, aura: 0, ring: 0, ticks: 0, segments: 0, comet: null, ripples: [], motes: [], leaving: [], sparks: [] };

export interface OrbFrameOptions {
  /** Whose orb: where its motes start and how fast each goes (orbSeed of a knight's handle; Galahad's own is 0). */
  seed?: number;
  /** Seconds since it arrived at this mood. Left out (or null): long ago, settled. */
  since?: number | null;
  /** The mood it arrived from, whose motes fade as this one's come in. */
  from?: OrbMood | null;
  /** Whether it arrived with a burst (orbBursts). */
  burst?: boolean;
}

/**
 * An orb in a mood at `t` seconds, measured from any fixed moment, with its clock as it stands then. Its motes and
 * waves are a function of the time alone, seeded; the rest is the clock's. Pure, and the same in every app.
 */
export function orbFrame(mood: OrbMood, clock: OrbClock, t: number, options: OrbFrameOptions = {}): OrbFrame {
  const m = ORB_MOTION[mood] ?? ORB_MOTION.idle;
  const seed = (options.seed ?? 0) >>> 0;
  const since = options.since == null ? Number.POSITIVE_INFINITY : Math.max(0, options.since);
  const arrived = Math.min(1, since / ORB_ARRIVE);
  // A burst's motes fly out first; the mood's own come in over its second half.
  const burst = options.burst === true;
  const settled = burst ? clamp01((since - ORB_BURST / 2) / (ORB_BURST / 2)) : arrived;
  const leaving = options.from && options.from !== mood && arrived < 1 ? moodMotes(options.from, seed, t, 1 - arrived) : [];
  const sparks: OrbMote[] = [];
  if (burst && since < ORB_BURST) {
    // Out from the edge to the band's reach and gone: fast, then slowing, as a spark does.
    const progress = since / ORB_BURST;
    const out = 1 - (1 - progress) ** 3;
    for (let i = 0; i < ORB_BURST_MOTES; i++) {
      const [a, z] = [orbRand(seed, i, 5), orbRand(seed, i, 6)];
      sparks.push({ angle: turned((360 * (i + a)) / ORB_BURST_MOTES + 25 * out), u: out, size: 0.6 + 0.4 * z, alpha: 1 - progress });
    }
  }

  // Each wave lasts one and a half times the time between two, so the next sets out before the last has gone; only
  // those set out since the mood arrived.
  const ripples: number[] = [];
  if (m.ripple) {
    const life = 1.5 * m.ripple;
    for (let k = Math.floor(t / m.ripple); k * m.ripple > t - life; k--) {
      const gone = (t - k * m.ripple) / life;
      if (gone >= 0 && gone < 1 && t - k * m.ripple <= since) ripples.push(gone);
    }
  }

  const breath = Math.sin(2 * Math.PI * clock.breath);
  const glow = 1 + Math.min(0.4, 10 * clock.swell) * breath;
  return {
    scale: 1 + clock.swell * breath,
    glow,
    aura: Math.min(1, clock.aura * glow),
    ring: clock.ring,
    ticks: clock.ticks,
    segments: clock.segments,
    comet: clock.light > 0.01 ? { head: clock.head, tail: clock.tail, alpha: clock.light } : null,
    ripples,
    motes: moodMotes(mood, seed, t, settled),
    leaving,
    sparks,
  };
}

/** A mood's own motes at `t`, as opaque as `share` of their own. */
function moodMotes(mood: OrbMood, seed: number, t: number, share: number): OrbMote[] {
  const m = ORB_MOTION[mood] ?? ORB_MOTION.idle;
  const motes: OrbMote[] = [];
  for (let i = 0; i < m.motes.count; i++) {
    const [a, s, u0, p, z] = [0, 1, 2, 3, 4].map((k) => orbRand(seed, i, k)) as [number, number, number, number, number];
    const speed = m.motes.speed * (0.5 + s);
    // Each twinkles on a slow breath of its own, between 3 and 7 seconds.
    const twinkle = 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / (3 + 4 * s) + p));
    let angle: number, u: number, alpha: number;
    if (m.motes.flow === "inward") {
      // From the band's outer edge to its inner one, turning as it comes, 4 to 7 seconds a pass, then again.
      const phase = fract(t / (4 + 3 * s) + p);
      angle = 360 * a + speed * t + 120 * phase;
      u = 1 - phase;
      alpha = Math.sin(Math.PI * phase) * (0.55 + 0.45 * twinkle);
    } else if (m.motes.flow === "fall") {
      // Down one side, from high on it to the foot, faster as it goes, fading, 6 to 10 seconds a run.
      const phase = fract(t / (6 + 4 * s) + p);
      const side = a < 0.5 ? -1 : 1;
      const from = side * (20 + 70 * u0);
      angle = from + (side * 180 - from) * phase * phase;
      u = clamp01(0.15 + 0.5 * u0 - 0.15 * phase);
      alpha = (1 - phase) * (0.45 + 0.55 * twinkle);
    } else {
      angle = 360 * a + speed * t;
      u = clamp01(u0 + m.motes.sway * 0.5 * Math.sin(2 * Math.PI * (t / (1.7 * m.breath) + p)));
      alpha = 0.35 + 0.65 * twinkle;
    }
    motes.push({ angle: turned(angle), u, size: 0.5 + 0.5 * z, alpha: alpha * share });
  }
  return motes;
}

/** Where a frame's moving parts are drawn, at each size of orb and round a knight's face. Units are those of the orb's
 * square, which is 200 wide and centred on its middle; on a knight's seat, 100 is its ring's outer edge.
 * - reach: how far from the middle anything is drawn. Past 100 it draws outside its square, and nothing round it moves
 *   for that.
 * - band: where its motes go, from and to.
 * - mote: the largest mote's radius.
 * - share: how many of a mood's motes it shows.
 * - waves: where its waves set out and how far they reach.
 * - wave: how wide a wave's line is as it sets out (it thins as it goes).
 * - comet: the ring its light runs round, and how wide; none on a knight's seat, whose light runs round its own ring. */
export interface OrbStage {
  reach: number;
  band: readonly [from: number, to: number];
  mote: number;
  share: number;
  waves: readonly [from: number, to: number];
  wave: number;
  comet: { r: number; width: number } | null;
}

export const ORB_STAGES: Readonly<Record<OrbLevel | "ring", OrbStage>> = {
  full: { reach: 150, band: [64, 134], mote: 3.4, share: 1, waves: [60, 140], wave: 2.4, comet: { r: 70.5, width: 2.4 } },
  seat: { reach: 124, band: [70, 114], mote: 4.6, share: 0.6, waves: [66, 120], wave: 4, comet: { r: 80, width: 4.5 } },
  badge: { reach: 112, band: [84, 104], mote: 7, share: 0, waves: [78, 110], wave: 7, comet: { r: 94, width: 6 } },
  ring: { reach: 124, band: [88, 116], mote: 5.5, share: 0.35, waves: [100, 122], wave: 5, comet: null },
};

/**
 * How a frame moves the orb's parts (lib/orb.ts' names), and where its lights are drawn among them:
 * - The outer ring and its notches turn with the frame's `ring`, the ticks and their marks with its `ticks`, and the
 *   segments and the data ring with its `segments`.
 * - The sphere, its nucleus and the light it sits in swell with its `scale`, and its glows (the halo, the light round the
 *   sphere, the nucleus) brighten with its `glow`. The sphere turns with its `ring`, three times as far
 *   (lib/orb-sphere.ts' SPHERE_TURN).
 * - The waves are drawn after the halo, under every ring. The light and the motes are drawn after the rings, just before
 *   the sphere's light, which they pass behind.
 */
export const ORB_MOVES = {
  ring: ["ring", "notches"],
  ticks: ["ticks", "marks"],
  segments: ["segments", "data"],
  swell: ["glow", "nucleus", "sphere"],
  glow: ["halo", "glow", "nucleus"],
  lightsBefore: "glow",
} as const;

/**
 * How many frames a second an orb is drawn at: as few as look smooth, since every frame costs a phone its battery and a
 * page its other animations' work (a knight's eyes are redrawn with every frame the page draws). At work, or arriving
 * at a mood (a burst, a fade), the light runs fast: 30. A slow breath and drifting motes look the same at 15. His
 * welcome's orb, the largest, at twice these.
 */
export function orbFps(mood: OrbMood, level: OrbLevel | "ring", since: number | null): number {
  const lively = mood === "working" || (since !== null && since < ORB_BURST);
  return (lively ? 30 : 15) * (level === "full" ? 2 : 1);
}

/** Which of a frame's motes a stage shows: its share of the mood's own and of the last mood's while they fade, and every
 * spark; none on a stage too small for motes. */
export function shownMotes(frame: OrbFrame, stage: OrbStage): OrbMote[] {
  if (stage.share === 0) return [];
  const share = (motes: OrbMote[]) => motes.slice(0, Math.round(motes.length * stage.share));
  return [...share(frame.motes), ...share(frame.leaving), ...frame.sparks];
}

/** A whole number for a name, for its seed: FNV-1a over its UTF-16 code units, as an unsigned 32-bit number. */
export function orbSeed(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return hash >>> 0;
}

/** The `k`th random number of mote `i` of an orb seeded `seed`, from 0 up to 1: the same for the same three in every
 * app (a 32-bit integer hash, lowbias32, so no platform's floating point can tell them apart). */
export function orbRand(seed: number, i: number, k: number): number {
  let n = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d) >>> 0;
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function fract(x: number): number {
  return x - Math.floor(x);
}
/** An angle as 0 up to 360 degrees. */
function turned(degrees: number): number {
  const r = degrees % 360;
  return r < 0 ? r + 360 : r;
}
