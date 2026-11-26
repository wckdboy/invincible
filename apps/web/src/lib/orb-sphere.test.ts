import { describe, expect, test } from "bun:test";
import { DATA_GLYPHS, dataGlyph, GLYPH_LADDER, KNIGHT_SPHERE, knightArcs, orbSphere, paperShades, SPHERE_FLASH, SPHERE_TURN, sphereFrame, sphereGlyph, spherePoints, sphereShades } from "./orb-sphere.ts";
import { ORB_MOODS, orbSeed } from "./orb-motion.ts";

// Your words, 25 November 2026: "custom/procedurally generated colored particle orbs", "use glyph and randomness on the
// orbs, like Jarvis/Ultron in the movies, and my other project Phren", "slow and calming movement".
describe("an orb's sphere of glyphs", () => {
  test("each handle makes its own sphere, the same every time, within its bounds", () => {
    const gareth = orbSphere("gareth");
    expect(orbSphere("gareth")).toEqual(gareth);
    expect(gareth.seed).toBe(orbSeed("gareth"));
    const many = Array.from({ length: 300 }, (_, n) => orbSphere(`knight-${n}`));
    for (const sphere of many) {
      expect(sphere.tilt).toBeGreaterThanOrEqual(12);
      expect(sphere.tilt).toBeLessThan(32);
      expect([1, -1]).toContain(sphere.spin);
      expect(sphere.phase).toBeGreaterThanOrEqual(0);
      expect(sphere.phase).toBeLessThan(360);
      expect(sphere.share).toBeGreaterThanOrEqual(0.18);
      expect(sphere.share).toBeLessThan(0.34);
    }
    expect(new Set(many.map((sphere) => sphere.spin)).size).toBe(2);
  });

  test("its points are spread over the whole sphere, top to bottom, some of them its second colour; finer the larger", () => {
    const sphere = orbSphere("ada");
    for (const level of ["badge", "seat", "full"] as const) {
      const points = spherePoints(sphere, KNIGHT_SPHERE[level].count);
      expect(points).toHaveLength(KNIGHT_SPHERE[level].count);
      for (const p of points) {
        expect(Math.abs(Math.hypot(p.x, p.y, p.z) - 1)).toBeLessThan(1e-12);
        expect(p.size).toBeGreaterThanOrEqual(0.7);
        expect(p.size).toBeLessThan(1);
      }
      const ys = points.map((p) => p.y);
      expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    }
    expect(KNIGHT_SPHERE.badge.count < KNIGHT_SPHERE.seat.count && KNIGHT_SPHERE.seat.count < KNIGHT_SPHERE.full.count).toBe(true);
    expect(KNIGHT_SPHERE.badge.glyph > KNIGHT_SPHERE.seat.glyph && KNIGHT_SPHERE.seat.glyph > KNIGHT_SPHERE.full.glyph).toBe(true);
    // A face's sphere stays inside its square, and inside its arcs where it has them (a card's size and larger).
    for (const look of Object.values(KNIGHT_SPHERE)) expect(look.r + (1.15 * look.glyph) / 2).toBeLessThanOrEqual(100);
    for (const level of ["seat", "full"] as const) expect(KNIGHT_SPHERE[level].r + (1.15 * KNIGHT_SPHERE[level].glyph) / 2).toBeLessThan(89);
  });

  test("its glyphs are the ladder's, by how near: the faint at the back, the dense at the front; now and then data", () => {
    expect(GLYPH_LADDER).toHaveLength(6);
    for (const level of GLYPH_LADDER) expect(level).toHaveLength(3);
    expect(DATA_GLYPHS).toBe("0123456789ABCDEF");
    const seed = orbSeed("gareth");
    for (let level = 0; level < 6; level++) {
      const seen = new Set<string>();
      for (let t = 0; t < 400; t += 0.7) {
        const glyph = sphereGlyph(seed, 7, level, t, 0);
        expect(glyph.data).toBe(false);
        expect(GLYPH_LADDER[level]).toContain(glyph.char);
        seen.add(glyph.char);
        expect(glyph.fade).toBeGreaterThanOrEqual(0.7 - 1e-12);
        expect(glyph.fade).toBeLessThanOrEqual(1 + 1e-12);
      }
      // It changes, among its level's three.
      expect(seen.size).toBeGreaterThan(1);
    }
    // At work a few are data; never while paused or failed; a calm idle shows hardly any.
    const share = (flash: number) => {
      let data = 0;
      let all = 0;
      for (let i = 0; i < 60; i++) for (let t = 0; t < 600; t += 1.9) (all++, sphereGlyph(seed, i, 3, t, flash).data && data++);
      return data / all;
    };
    expect(share(SPHERE_FLASH.working)).toBeGreaterThan(share(SPHERE_FLASH.idle));
    expect(share(SPHERE_FLASH.working)).toBeLessThan(0.06);
    expect(SPHERE_FLASH.paused).toBe(0);
    expect(SPHERE_FLASH.failed).toBe(0);
    for (const mood of ORB_MOODS) expect(SPHERE_FLASH[mood]).toBeLessThanOrEqual(SPHERE_FLASH.working);
  });

  test("slowly: a glyph keeps its character for seconds, never changing faster than every two", () => {
    const seed = orbSeed("ada");
    for (let i = 0; i < 40; i++) {
      let last = sphereGlyph(seed, i, 4, 0, 0).char;
      let changedAt = 0;
      for (let t = 0.05; t < 60; t += 0.05) {
        const now = sphereGlyph(seed, i, 4, t, 0).char;
        if (now !== last) {
          // (A beat can pick the same glyph again, so two changes are at least a beat apart.)
          if (changedAt > 0) expect(t - changedAt).toBeGreaterThanOrEqual(2 - 0.06);
          changedAt = t;
          last = now;
        }
      }
    }
  });

  test("seen at a moment: back to front, the nearer larger and more opaque, inside its radius; on paper, opaque further back", () => {
    const sphere = orbSphere("gareth");
    const points = spherePoints(sphere, 72);
    const options = { angle: 123.4, radius: 72, scale: 1.02, glyph: 24, t: 31.5, mood: "idle" as const };
    const shown = sphereFrame(sphere, points, options);
    expect(shown).toHaveLength(72);
    const near = shown.map((p) => p.near);
    expect([...near].sort((a, b) => a - b)).toEqual(near);
    for (const p of shown) {
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(72 * 1.02 + 1e-9);
      expect(p.shade).toBe(Math.min(5, Math.floor(p.near * 6)));
      expect(p.size).toBeLessThanOrEqual(24 * 1.15 + 1e-9);
      expect(p.alpha).toBeLessThanOrEqual(1 + 1e-12);
      expect(GLYPH_LADDER[p.shade]!.includes(p.char as never) || DATA_GLYPHS.includes(p.char)).toBe(true);
    }
    const onPaper = sphereFrame(sphere, points, { ...options, paper: true });
    expect(onPaper[0]!.alpha).toBeGreaterThan(shown[0]!.alpha);
    // A whole turn of its ring is three whole turns of the sphere: the same picture, so its turning never jumps.
    const at = (angle: number) => sphereFrame(sphere, points, { ...options, angle });
    const once = at(10);
    const again = at(10 + 360);
    once.forEach((p, i) => {
      expect(again[i]!.x).toBeCloseTo(p.x, 9);
      expect(again[i]!.y).toBeCloseTo(p.y, 9);
    });
    expect(SPHERE_TURN).toBe(3);
    // Failed, its lower glyphs sag.
    const failed = sphereFrame(sphere, points, { ...options, mood: "failed" });
    const lowest = (frame: typeof shown) => Math.max(...frame.map((p) => p.y));
    expect(lowest(failed)).toBeGreaterThan(lowest(shown));
  });

  test("six shades of a colour for a dark page and for a light one", () => {
    const dark = sphereShades("#3abeff", "#9cdfff", "#1c5b7a");
    expect([dark[0], dark[3]]).toEqual(["#1c5b7a", "#3abeff"]);
    const light = paperShades("#3abeff", "#1c5b7a");
    expect(light[3]).toBe("#3abeff");
    // On paper the far side is the palest and the near side the deepest.
    const lum = (hex: string) => [1, 3, 5].reduce((sum, at) => sum + parseInt(hex.slice(at, at + 2), 16), 0);
    expect(lum(light[0]!)).toBeGreaterThan(lum(light[5]!));
    expect(lum(dark[0]!)).toBeLessThan(lum(dark[5]!));
  });

  test("a knight's own arcs: one or two at a card's size and larger, none on a small face, each its handle's", () => {
    const sphere = orbSphere("gareth");
    expect(knightArcs(sphere, "badge")).toEqual([]);
    const arcs = knightArcs(sphere, "seat");
    expect(arcs.length).toBeGreaterThanOrEqual(1);
    expect(arcs.length).toBeLessThanOrEqual(2);
    expect(knightArcs(sphere, "full")).toEqual(arcs);
    for (const arc of arcs) {
      expect(arc.length).toBeGreaterThanOrEqual(50);
      expect(arc.length).toBeLessThan(180);
      // A whole number of its ring's turns (1 or 2, either way), so where the ring comes round to 0 the arc goes on
      // smoothly (the Apple port found a fraction made it jump, 25 November 2026).
      expect([1, 2]).toContain(Math.abs(arc.speed));
      expect(arc.r + arc.width / 2).toBeLessThanOrEqual(100);
    }
    const counts = new Set(Array.from({ length: 50 }, (_, n) => knightArcs(orbSphere(`k${n}`), "seat").length));
    expect(counts).toEqual(new Set([1, 2]));
  });

  test("a knight's arcs never jump: where its ring comes round to 0, each arc is where it would have been", () => {
    const at = (arc: { from: number; speed: number }, ring: number) => (((arc.from + arc.speed * ring) % 360) + 360) % 360;
    for (let n = 0; n < 200; n++) {
      for (const arc of knightArcs(orbSphere(`knight-${n}`), "seat")) {
        // The ring at 359.9 degrees, then a tenth of a degree on (0 again): the arc moves by its speed's tenth, no more.
        const moved = Math.abs(at(arc, 0) - at(arc, 359.9));
        expect(Math.min(moved, 360 - moved)).toBeLessThanOrEqual(Math.abs(arc.speed) * 0.1 + 1e-9);
      }
    }
  });

  test("Galahad's data ring: about the share of its places lit, each a hex digit changing on a slow beat", () => {
    const seed = orbSeed("galahad");
    const lit = Array.from({ length: 480 }, (_, k) => dataGlyph(seed, k, 0, 0.62)).filter(Boolean).length / 480;
    expect(lit).toBeGreaterThan(0.5);
    expect(lit).toBeLessThan(0.74);
    for (let k = 0; k < 48; k++) {
      const shown = dataGlyph(seed, k, 12.3, 0.62);
      if (!shown) continue;
      expect(DATA_GLYPHS).toContain(shown.char);
      expect(shown.alpha).toBeGreaterThanOrEqual(0.45);
      expect(shown.alpha).toBeLessThan(0.85);
      // A place lit stays lit, whatever the time.
      expect(dataGlyph(seed, k, 999, 0.62)).not.toBeNull();
    }
  });
});
