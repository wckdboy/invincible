import { describe, expect, test } from "bun:test";
import { KNIGHT_TINTS, knightColors } from "@galahad/core/avatar";
import { AURUM, fieldPoints, project } from "./field.ts";
import {
  FIELD_EASE, FIELD_EMBERS, FIELD_MOTION, fieldClock, fieldColours, fieldFps, fieldFrame, fieldInk, fieldInks, fieldLook, fieldMotion, fieldSettled, fieldStep, fieldStill, fieldTone,
  GALAHAD_FIELD, GALAHAD_RING, knightField, RIM_ANGLE, RIM_DIM, ringWidth, type FieldClock, type FieldMotion,
} from "./field-orb.ts";
import { ORB_LONGEST_STEP, ORB_MOODS } from "./orb-motion.ts";

/*
 * The orbs as fields (26 November 2026): Galahad's in gold in his ring, each knight's in its own colours; calm, still
 * where they are many, moving only where they are looked at (the owner's words: "almost like nipples", "i dont want them
 * to be too visually distractin", "slow and calming movement").
 */

const HANDLES = ["ada", "gareth", "percival", "kay", "lin", "bors", "", "Will’s “iPad” \\ 🛡️", ...Array.from({ length: 200 }, (_, i) => `h${i}`)];

/** How light a colour looks (relative luminance, 0 to 1). */
function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
const hexRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
/** A clock run `seconds` in a motion, a frame (1/60 s) at a time. */
function run(clock: FieldClock, motion: FieldMotion, seconds: number): FieldClock {
  for (let t = 0; t < seconds; t += 1 / 60) clock = fieldStep(clock, motion, 1 / 60);
  return clock;
}

describe("whose field an orb is", () => {
  test("his is the icon's own, in gold", () => {
    expect(GALAHAD_FIELD).toEqual({ seed: 11, tilt: [0.42, 0.3, -0.18], lines: 46, colours: AURUM });
  });

  test("a knight's colours are core's: its key its tint lit and its tint, its rim its second; the one you chose, or its handle's", () => {
    for (const handle of HANDLES.slice(0, 8)) {
      const colours = knightColors(handle);
      expect(knightField(handle).colours).toEqual({ key: [colours.light, colours.tint], rim: colours.second });
    }
    expect(knightField("ada", { v: 2, color: "#3ABEFF" }).colours.key[1]).toBe("#3abeff");
    // Anything else colours nothing: its handle's.
    expect(knightField("ada", { v: 2, color: "url(https://invalid.example/x)" }).colours).toEqual(knightField("ada").colours);
    expect(KNIGHT_TINTS).toContain(knightField("ada").colours.key[1] as never);
  });

  test("its handle gives its own lines, longitudes and lean, the same every time; never seen end on or flat", () => {
    const seen = new Set<string>();
    for (const handle of HANDLES) {
      const field = knightField(handle);
      expect(field).toEqual(knightField(handle));
      expect(field.lines).toBeGreaterThanOrEqual(12);
      expect(field.lines).toBeLessThanOrEqual(20);
      expect(Number.isInteger(field.seed) && field.seed >= 1 && field.seed <= 2147483646).toBe(true);
      // Its axis (y, leant by the tilt as lib/field.ts leans it) leans towards you by a quarter to a half.
      const [ax, ay, az] = field.tilt;
      const towards = Math.cos(az) * Math.sin(ax) + Math.sin(az) * Math.sin(ay) * Math.cos(ax);
      expect(towards).toBeGreaterThan(0.25 - 1e-9);
      expect(towards).toBeLessThan(0.5 + 1e-9);
      seen.add(`${field.seed}/${field.tilt.join(",")}`);
    }
    expect(seen.size).toBe(HANDLES.length);
  });
});

describe("how a field is drawn at a size", () => {
  test("in his ring, fewer of his lines where he is small; a knight keeps its own; the more points along a line the larger", () => {
    expect([16, 29, 30, 55, 56, 320].map((size) => fieldLook(GALAHAD_FIELD, size, true).lines)).toEqual([26, 26, 34, 34, 46, 46]);
    const ada = knightField("ada");
    for (const size of [14, 34, 160]) expect(fieldLook(ada, size, false).lines).toBe(ada.lines);
    const steps = [14, 18, 34, 50, 96, 160, 320].map((size) => fieldLook(ada, size, false).steps);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect([steps[0], steps.at(-1)]).toEqual([20, 96]);
    // Bolder where small.
    expect([18, 34, 160].map((size) => fieldLook(ada, size, false).weight)).toEqual([1.5, 1.25, 1]);
  });

  test("his field stays clear inside his ring, and a knight's inside its square, at every size and turn", () => {
    const reach = (identity: typeof GALAHAD_FIELD, size: number, ringed: boolean, turn: number) => {
      const look = fieldLook(identity, size, ringed);
      const points = fieldPoints({ lines: look.lines, steps: look.steps, tilt: identity.tilt, seed: identity.seed, colours: identity.colours, weight: look.weight, turn });
      return Math.max(...points.map((p) => {
        const q = project(p, 1, { zoom: look.zoom });
        return Math.hypot(q.x - 0.5, q.y - 0.5);
      }));
    };
    for (const size of [16, 34, 50, 160]) for (const turn of [0, 1, 2.5, 4, 5.5]) expect(reach(GALAHAD_FIELD, size, true, turn)).toBeLessThan(GALAHAD_RING.r - 0.04);
    for (const handle of HANDLES.slice(0, 60)) for (const turn of [0, 2, 4]) expect(reach(knightField(handle), 34, false, turn)).toBeLessThan(0.46);
  });

  test("his ring: five arcs of ink with gaps, his seat alone at the top, never thinner than a pixel", () => {
    expect(GALAHAD_RING.arcs).toHaveLength(5);
    const arcs = [[GALAHAD_RING.seat.from + 360, GALAHAD_RING.seat.to + 360], ...GALAHAD_RING.arcs.map(([from, to]) => [from + 360, to + 360])].sort((a, b) => a[0]! - b[0]!);
    for (let i = 1; i < arcs.length; i++) expect(arcs[i]![0]! - arcs[i - 1]![1]!).toBeGreaterThan(10);
    expect(GALAHAD_RING.seat.from + GALAHAD_RING.seat.to).toBe(0);
    expect([ringWidth(16), ringWidth(64), ringWidth(160)]).toEqual([1, 1, 2.5]);
  });
});

describe("how it moves", () => {
  test("slowly: a turn takes half a minute or more, a breath five seconds, and only work sends off embers", () => {
    expect(Object.keys(FIELD_MOTION).sort()).toEqual([...ORB_MOODS].sort());
    for (const [mood, motion] of Object.entries(FIELD_MOTION)) {
      expect(motion.turn).toBeLessThanOrEqual((2 * Math.PI) / 30);
      expect(motion.turn).toBeGreaterThanOrEqual(0);
      if (motion.breath) expect([motion.breath.period >= 4, motion.breath.depth <= 0.25]).toEqual([true, true]);
      expect(motion.embers).toBe(mood === "working");
    }
    // At work, a little quicker than at rest; done, it settles; paused, it stops; failed, its rim dims.
    expect(FIELD_MOTION.working.turn).toBeGreaterThan(FIELD_MOTION.idle.turn);
    expect(FIELD_MOTION.done.turn).toBeLessThan(FIELD_MOTION.idle.turn);
    expect(FIELD_MOTION.paused.turn).toBe(0);
    expect(FIELD_MOTION.failed.rim).toBe(1);
    expect(FIELD_MOTION.waiting.breath).not.toBeNull();
  });

  test("a knight moves only while it works, and never sends off embers", () => {
    for (const mood of ORB_MOODS) {
      const motion = fieldMotion(mood, true);
      expect(motion.embers).toBe(false);
      expect(motion.turn > 0 || motion.breath !== null).toBe(mood === "working");
      // In that mood's light, still.
      expect([motion.glow, motion.rim]).toEqual([FIELD_MOTION[mood].glow, FIELD_MOTION[mood].rim]);
    }
    expect(fieldMotion("working", false)).toBe(FIELD_MOTION.working);
  });

  test("a change of mood eases over a second or two: no jump in its turning, its light or its tint", () => {
    let clock = run(fieldClock(FIELD_MOTION.idle), FIELD_MOTION.idle, 2);
    let last = clock;
    for (let frame = 0; frame < 240; frame++) {
      clock = fieldStep(clock, FIELD_MOTION.failed, 1 / 60);
      const moved = Math.min(Math.abs(clock.turn - last.turn), 2 * Math.PI - Math.abs(clock.turn - last.turn));
      expect(moved).toBeLessThanOrEqual(Math.max(last.speed, clock.speed) / 60 + 1e-12);
      expect(Math.abs(clock.glow - last.glow)).toBeLessThan(0.01);
      expect(Math.abs(clock.rim - last.rim)).toBeLessThan(0.03);
      expect(clock.turn >= 0 && clock.turn < 2 * Math.PI).toBe(true);
      last = clock;
    }
    // Most of the way there in its ease, settled within four seconds.
    const eased = run(fieldClock(FIELD_MOTION.idle), FIELD_MOTION.failed, FIELD_EASE);
    expect(eased.rim).toBeGreaterThan(0.6);
    expect(fieldSettled(eased, FIELD_MOTION.failed)).toBe(false);
    expect(fieldSettled(run(eased, FIELD_MOTION.failed, 4), FIELD_MOTION.failed)).toBe(true);
    // A tab come back after a minute turns no further than a frame's longest step.
    const back = fieldStep(fieldClock(FIELD_MOTION.working), FIELD_MOTION.working, 60);
    expect(back.turn).toBeCloseTo(FIELD_MOTION.working.turn * ORB_LONGEST_STEP, 12);
  });

  test("as few frames as look smooth: none once a knight has come to rest", () => {
    const resting = fieldMotion("idle", true);
    let clock = run(fieldClock(FIELD_MOTION.working), resting, 0.2);
    expect(fieldFps(clock, resting)).toBe(30);
    clock = run(clock, resting, 8);
    expect(fieldFps(clock, resting)).toBe(0);
    expect(fieldFps(fieldClock(FIELD_MOTION.idle), FIELD_MOTION.idle)).toBe(15);
    expect(fieldFps(fieldClock(FIELD_MOTION.waiting), FIELD_MOTION.waiting)).toBe(20);
    expect(fieldFps(fieldClock(FIELD_MOTION.working), FIELD_MOTION.working)).toBe(30);
  });

  test("waiting on you, a slow breath of brightness; still, none", () => {
    const glows = Array.from({ length: 53 }, (_, i) => fieldFrame({ ...fieldClock(FIELD_MOTION.waiting), breath: i / 52 }, 0).glow);
    expect(Math.max(...glows)).toBeCloseTo(1.2, 6);
    expect(Math.min(...glows)).toBeCloseTo(0.8, 6);
    expect(fieldStill(FIELD_MOTION.waiting)).toEqual({ turn: 0, glow: 1, rim: 0, embers: [] });
    expect(fieldStill(FIELD_MOTION.failed)).toEqual({ turn: 0, glow: FIELD_MOTION.failed.glow, rim: 1, embers: [] });
  });

  test("his embers drift off the burning rim, inside his ring, fading in and out; the same for the same moment", () => {
    const working = fieldClock(FIELD_MOTION.working);
    expect(fieldFrame(working, 3).embers).toEqual([]);
    expect(fieldFrame(fieldClock(FIELD_MOTION.idle), 3, { embers: true }).embers).toEqual([]);
    for (let t = 0; t < 30; t += 0.37) {
      const { embers } = fieldFrame(working, 1000 + t, { seed: 5, embers: true });
      expect(embers).toHaveLength(FIELD_EMBERS.count);
      for (const e of embers) {
        expect(Math.hypot(e.x, e.y)).toBeLessThan(2 * GALAHAD_RING.r - 0.04);
        expect(e.alpha).toBeGreaterThanOrEqual(0);
        expect(e.alpha).toBeLessThanOrEqual(1);
        // Off the rim's side (lower right): never on the far side of the middle from it.
        const angle = (Math.atan2(e.x, -e.y) * 180) / Math.PI;
        expect(Math.abs(((angle - RIM_ANGLE + 540) % 360) - 180)).toBeLessThan(FIELD_EMBERS.spread + 10);
      }
    }
    expect(fieldFrame(working, 12.5, { seed: 5, embers: true })).toEqual(fieldFrame(working, 12.5, { seed: 5, embers: true }));
    expect(fieldFrame(working, 12.5, { seed: 5, embers: true }).embers).not.toEqual(fieldFrame(working, 12.5, { seed: 6, embers: true }).embers);
    // An ember sets out faint and goes out: at the start and the end of its life it is all but gone.
    const life = (seed: number, i: number, t: number) => fieldFrame(working, t, { seed, embers: true }).embers[i]!.alpha;
    const samples = Array.from({ length: 400 }, (_, k) => life(9, 0, 50 + k * 0.011));
    expect(Math.max(...samples)).toBeGreaterThan(0.3);
    expect(Math.min(...samples)).toBeLessThan(0.01);
  });
});

describe("its colours", () => {
  test("a failed field's rim dims towards red-brown; otherwise its colours are its own", () => {
    expect(fieldColours(AURUM, 0)).toBe(AURUM);
    const dim = fieldColours(AURUM, 1);
    expect(dim.key).toEqual(AURUM.key);
    expect(luminance(hexRgb(dim.rim))).toBeLessThan(luminance(hexRgb(AURUM.rim)));
    expect(luminance(hexRgb(dim.rim))).toBeGreaterThan(luminance(hexRgb(RIM_DIM)));
  });

  test("on a dark page, as the icon shows light: black stays black, the brightest goes to white, copper stays copper", () => {
    expect(fieldTone(0, 0, 0)).toEqual([0, 0, 0]);
    const white = fieldTone(40, 40, 40);
    for (const c of white) expect(c).toBeGreaterThan(0.98);
    const levels = [0.02, 0.1, 0.5, 1, 3].map((v) => fieldTone(v, v, v)[0]);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    const [r, g, b] = fieldTone(1.2, 0.25, 0.05);
    expect(r > g && g > b).toBe(true);
  });

  test("on a light page, ink: darker than its light, readable on the page, as opaque as it is lit", () => {
    for (const handle of HANDLES.slice(0, 40)) {
      const inks = fieldInks(knightField(handle).colours);
      // At least 3 to 1 against the light page's ground (#fafafa) where it is fully lit, as a graphic needs.
      for (const ink of [inks.key, inks.rim]) expect((luminance([250, 250, 250]) + 0.05) / (luminance(ink) + 0.05)).toBeGreaterThan(3);
    }
    const inks = fieldInks(AURUM);
    expect(luminance(inks.key)).toBeLessThan(luminance(hexRgb(AURUM.key[1])));
    expect(fieldInk(inks, 1, 0).rgb).toEqual(inks.key);
    expect(fieldInk(inks, 0, 1).rgb).toEqual(inks.rim);
    expect(fieldInk(inks, 0.9, 0).alpha).toBeGreaterThan(fieldInk(inks, 0.2, 0).alpha);
    expect(fieldInk(inks, 0, 0)).toEqual({ rgb: inks.key, alpha: 0.1 });
  });
});
