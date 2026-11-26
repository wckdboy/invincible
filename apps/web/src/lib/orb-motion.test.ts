import { describe, expect, test } from "bun:test";
import { orbToneOfState } from "./orb.ts";
import { STATES, type KnightState } from "./knight-state.ts";
import {
  ORB_ARRIVE, ORB_BURST, ORB_BURST_MOTES, ORB_LONGEST_STEP, ORB_MOODS, ORB_MOTION, ORB_STAGES, ORB_STILL,
  orbBursts, orbClock, orbFps, orbFrame, orbMoodOfExpression, orbMoodOfState, orbRand, orbSeed, orbStep, shownMotes, type OrbClock, type OrbMood,
} from "./orb-motion.ts";

/** A clock run on for `seconds`, a frame at a time (60 a second), in one mood. */
function run(clock: OrbClock, mood: OrbMood, seconds: number): OrbClock {
  for (let i = 0; i < Math.round(seconds * 60); i++) clock = orbStep(clock, mood, 1 / 60);
  return clock;
}
/** How far apart two angles are, the short way round. */
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// Your word, 24 November 2026: "cool orbs/particles, pulsing/moving when doing a task, sitting idle, waiting, done".
describe("how the orb moves", () => {
  test("every state a knight can be in has a mood: at work, sitting idle, waiting, done, and the rest", () => {
    const states = Object.keys(STATES) as KnightState[];
    expect(Object.fromEntries(states.map((state) => [state, orbMoodOfState(state)]))).toEqual({
      working: "working", needs: "waiting", failed: "failed", paused: "paused", queued: "queued", verified: "done", unread: "done", resting: "idle",
    });
    expect([orbMoodOfState(undefined), orbMoodOfState("thinking")]).toEqual(["idle", "idle"]);
    expect(Object.keys(ORB_MOTION).sort()).toEqual([...ORB_MOODS].sort());
  });

  test("at work it moves most: its rings turn fastest, its light runs round, its motes stream in, and it breathes quickest", () => {
    const { idle, working, waiting, paused } = ORB_MOTION;
    expect(Math.abs(working.turn.ring)).toBeGreaterThan(Math.abs(idle.turn.ring) * 5);
    expect(Math.abs(working.turn.segments)).toBeGreaterThan(Math.abs(idle.turn.segments) * 5);
    expect(working.comet!.speed).toBeGreaterThan(ORB_MOTION.done.comet!.speed);
    expect(working.motes.flow).toBe("inward");
    expect(working.breath).toBeLessThan(idle.breath);
    // Waiting on you it beats and calls out in waves; nothing else does.
    expect(ORB_MOODS.filter((mood) => ORB_MOTION[mood].ripple !== null)).toEqual(["waiting"]);
    expect(waiting.swell).toBe(Math.max(...ORB_MOODS.map((mood) => ORB_MOTION[mood].swell)));
    // Paused, it is nearly still: no turning, no light, no motes, the faintest breath.
    expect([paused.turn, paused.comet, paused.motes.count]).toEqual([{ ring: 0, ticks: 0, segments: 0 }, null, 0]);
    expect(paused.swell).toBe(Math.min(...ORB_MOODS.map((mood) => ORB_MOTION[mood].swell)));
  });

  test("a frame is the same for the same moment, mood and seed, and two seeds never move as one", () => {
    const clock = run(orbClock("working", 7), "working", 2);
    expect(orbFrame("working", clock, 12.5, { seed: 7 })).toEqual(orbFrame("working", clock, 12.5, { seed: 7 }));
    const [one, two] = [orbFrame("idle", orbClock("idle", 1), 3, { seed: 1 }), orbFrame("idle", orbClock("idle", 2), 3, { seed: 2 })];
    expect(one.motes.map((m) => m.angle)).not.toEqual(two.motes.map((m) => m.angle));
    expect(orbClock("idle", 1).breath).not.toBe(orbClock("idle", 2).breath);
  });

  test("its motes stay in their band and are never more than opaque, in every mood, whenever", () => {
    for (const mood of ORB_MOODS) {
      let clock = orbClock(mood, 3);
      for (let t = 0; t < 30; t += 0.37) {
        clock = orbStep(clock, mood, 0.37);
        const frame = orbFrame(mood, clock, t, { seed: 3, since: t, from: "idle", burst: orbBursts("idle", mood) });
        for (const mote of [...frame.motes, ...frame.leaving, ...frame.sparks]) {
          expect(mote.u).toBeGreaterThanOrEqual(0);
          expect(mote.u).toBeLessThanOrEqual(1);
          expect(mote.alpha).toBeGreaterThanOrEqual(0);
          expect(mote.alpha).toBeLessThanOrEqual(1);
          expect(mote.angle).toBeGreaterThanOrEqual(0);
          expect(mote.angle).toBeLessThan(360);
          expect(mote.size).toBeGreaterThanOrEqual(0.5);
          expect(mote.size).toBeLessThanOrEqual(1);
        }
        expect(frame.motes).toHaveLength(ORB_MOTION[mood].motes.count);
        for (const wave of frame.ripples) expect(wave >= 0 && wave < 1).toBe(true);
        expect(frame.ripples.length).toBeLessThanOrEqual(2);
      }
    }
  });

  test("a change of mood turns nothing with a jump: each ring and the light speed up or slow down", () => {
    let clock = run(orbClock("idle"), "idle", 5);
    const fastest = Math.max(...ORB_MOODS.flatMap((mood) => [ORB_MOTION[mood].turn.ring, ORB_MOTION[mood].turn.segments, ORB_MOTION[mood].comet?.speed ?? 0].map(Math.abs)));
    for (const mood of ["working", "done", "failed", "waiting", "idle"] as OrbMood[]) {
      for (let i = 0; i < 90; i++) {
        const next = orbStep(clock, mood, 1 / 60);
        for (const part of ["ring", "ticks", "segments", "head"] as const) expect(apart(next[part], clock[part])).toBeLessThanOrEqual(fastest / 60 + 1e-9);
        // The swell eases too: the sphere never changes size at once.
        expect(Math.abs(next.swell - clock.swell)).toBeLessThan(0.002);
        clock = next;
      }
    }
    // Once there, it moves as its mood does.
    clock = run(clock, "working", 3);
    expect(clock.ringSpeed).toBeCloseTo(ORB_MOTION.working.turn.ring, 1);
    expect(clock.headSpeed).toBeCloseTo(ORB_MOTION.working.comet!.speed, 0);
    expect(clock.light).toBeGreaterThan(0.99);
    // A light fading after its mood slows to a stop and goes.
    clock = run(clock, "failed", 3);
    expect(clock.headSpeed).toBeLessThan(1);
    expect(orbFrame("failed", clock, 0).comet).toBeNull();
  });

  test("a tab coming back after a minute turns nothing a long way at once", () => {
    const clock = orbClock("working");
    const late = orbStep(clock, "working", 60);
    expect(apart(late.ring, clock.ring)).toBeCloseTo(ORB_MOTION.working.turn.ring * ORB_LONGEST_STEP, 6);
    expect(orbStep(clock, "working", -5)).toEqual({ ...clock, tail: clock.tail });
  });

  test("done bursts as it arrives: motes fly out and fade, then its own come in; never on first sight", () => {
    expect(orbBursts("working", "done")).toBe(true);
    expect(orbBursts("waiting", "done")).toBe(true);
    // A task's end you watched: work, then at rest.
    expect(orbBursts("working", "idle")).toBe(true);
    expect([orbBursts(null, "done"), orbBursts("done", "done"), orbBursts("idle", "working"), orbBursts("waiting", "idle")]).toEqual([false, false, false, false]);
    const clock = orbClock("done");
    const at = (since: number) => orbFrame("done", clock, 40 + since, { since, from: "working", burst: true });
    expect(at(0.1).sparks).toHaveLength(ORB_BURST_MOTES);
    expect(at(0.8).sparks[0]!.u).toBeGreaterThan(at(0.1).sparks[0]!.u);
    expect(at(0.8).sparks[0]!.alpha).toBeLessThan(at(0.1).sparks[0]!.alpha);
    expect(at(ORB_BURST).sparks).toEqual([]);
    // Its own motes wait for the burst's second half; the work's fade as it arrives.
    expect(Math.max(...at(0.5).motes.map((m) => m.alpha))).toBe(0);
    expect(Math.max(...at(ORB_BURST).motes.map((m) => m.alpha))).toBeGreaterThan(0);
    expect(at(0.1).leaving).toHaveLength(ORB_MOTION.working.motes.count);
    expect(at(ORB_ARRIVE).leaving).toEqual([]);
    // Seen settled, there is no burst and nothing leaving.
    const settled = orbFrame("done", clock, 40);
    expect([settled.sparks, settled.leaving]).toEqual([[], []]);
  });

  test("waiting on you sends out waves, only from when it began to wait", () => {
    const clock = orbClock("waiting");
    const every = ORB_MOTION.waiting.ripple!;
    expect(orbFrame("waiting", clock, 10 * every + 0.5).ripples.length).toBeGreaterThan(0);
    expect(orbFrame("waiting", clock, 10 * every - 0.01, { since: 0.2 }).ripples).toEqual([]);
    expect(orbFrame("waiting", clock, 10 * every + 0.5, { since: 0.6 }).ripples).toEqual([0.5 / (1.5 * every)]);
    expect(orbFrame("idle", orbClock("idle"), 10 * every + 0.5).ripples).toEqual([]);
  });

  test("failed, its motes run down its sides to its foot and fade there", () => {
    const frames = [0, 0.4, 0.8, 1.2, 1.6, 2].map((t) => orbFrame("failed", orbClock("failed"), 100 + t));
    const fromFoot = (angle: number) => apart(angle, 180);
    // Most of them are nearer the foot a moment on, or have faded and started again higher up.
    let down = 0;
    for (let i = 0; i < frames[0]!.motes.length; i++) {
      const [a, b] = [frames[0]!.motes[i]!, frames[1]!.motes[i]!];
      if (fromFoot(b.angle) <= fromFoot(a.angle) || b.alpha > a.alpha) down++;
    }
    expect(down).toBe(frames[0]!.motes.length);
    expect(ORB_MOTION.failed.turn).toEqual({ ring: 0, ticks: 0, segments: 0 });
  });

  test("still, it is the orb as lib/orb.ts draws it", () => {
    expect(ORB_STILL).toEqual({ scale: 1, glow: 1, aura: 0, ring: 0, ticks: 0, segments: 0, comet: null, ripples: [], motes: [], leaving: [], sparks: [] });
  });

  test("each stage draws within its reach, and the smallest shows no motes", () => {
    for (const stage of Object.values(ORB_STAGES)) {
      expect(stage.band[1] + stage.mote).toBeLessThanOrEqual(stage.reach);
      expect(stage.waves[1]).toBeLessThanOrEqual(stage.reach);
      expect(stage.band[0]).toBeLessThan(stage.band[1]);
      expect(stage.reach).toBeLessThanOrEqual(150);
    }
    const frame = orbFrame("working", orbClock("working"), 3, { since: 0.3, from: "idle" });
    expect(shownMotes(frame, ORB_STAGES.badge)).toEqual([]);
    expect(shownMotes(frame, ORB_STAGES.full)).toHaveLength(frame.motes.length + frame.leaving.length);
    expect(shownMotes(frame, ORB_STAGES.seat)).toHaveLength(Math.round(frame.motes.length * 0.6) + Math.round(frame.leaving.length * 0.6));
  });

  test("it is drawn as few times a second as look smooth: fast at work or arriving, slow otherwise, twice as often on his welcome", () => {
    expect([orbFps("working", "ring", null), orbFps("idle", "ring", null), orbFps("waiting", "seat", null), orbFps("done", "badge", 0.4), orbFps("done", "badge", ORB_BURST)]).toEqual([30, 15, 15, 30, 15]);
    expect([orbFps("working", "full", null), orbFps("idle", "full", null), orbFps("failed", "full", 1)]).toEqual([60, 30, 60]);
  });

  test("its random numbers are the same in every app: a 32-bit hash, spread evenly from 0 up to 1", () => {
    // FNV-1a's own published values.
    expect([orbSeed(""), orbSeed("a"), orbSeed("foobar")]).toEqual([0x811c9dc5, 0xe40c292c, 0xbf9cf968]);
    const values = Array.from({ length: 4000 }, (_, i) => orbRand(12345, i, i % 7));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.02);
    expect(orbRand(0, 0, 0)).toBe(orbRand(0, 0, 0));
    expect(orbRand(0, 0, 0)).not.toBe(orbRand(0, 0, 1));
  });
});

test("a word that is no state, expression or tone is at rest, even one every object answers to (constructor, toString, __proto__)", () => {
  for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    expect([word, orbMoodOfExpression(word)]).toEqual([word, "idle"]);
    expect([word, orbMoodOfState(word)]).toEqual([word, "idle"]);
    expect([word, orbToneOfState(word)]).toEqual([word, "neutral"]);
  }
});
