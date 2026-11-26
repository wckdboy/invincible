import { describe, expect, test } from "bun:test";
import { ORB_FULL_FROM, ORB_SEAT_FROM, ORB_TONES, orbLevel, orbPalette, orbParts, orbTone, orbToneOfState, type OrbPart } from "./orb.ts";

/** How light a colour looks (relative luminance, 0 to 1). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** How far a part reaches from the middle. */
function reach(part: OrbPart): number {
  switch (part.kind) {
    case "disc":
      return part.r;
    case "ring":
      return part.r + part.width / 2;
    case "ticks":
      return part.r + part.length / 2;
    case "glyphs":
      return part.r + part.size / 2;
    case "sphere":
      // Its nearest glyphs are at most 1.15 times its glyph high (lib/orb-sphere.ts), and reach half of that out.
      return part.r + (1.15 * part.glyph) / 2;
  }
}

// Your word, 23 November 2026: Galahad, the one you talk to, as a Jarvis-like orb; every app draws these same parts. On
// 25 November 2026 his sphere became points of light.
describe("Galahad's orb, as data", () => {
  test("each state has its own light, lit and shaded from it, in every theme", () => {
    expect(ORB_TONES.map((tone) => orbPalette(tone).tint)).toEqual(["#8ab8ff", "#58a6ff", "#f0b549", "#4cc38a", "#ff6b6b"]);
    for (const tone of ORB_TONES) {
      const { tint, light, deep } = orbPalette(tone);
      for (const color of [tint, light, deep]) expect(color).toMatch(/^#[0-9a-f]{6}$/);
      expect(luminance(light)).toBeGreaterThan(luminance(tint));
      expect(luminance(deep)).toBeLessThan(luminance(tint));
    }
    // A tone it doesn't know is its rest.
    expect([orbTone("pulse"), orbTone(undefined), orbTone("warn")]).toEqual(["neutral", "neutral", "warn"]);
    // At the Roundtable, the colour his ring would have.
    expect(["working", "needs", "failed", "verified", "unread", "paused", "queued", "resting", undefined].map(orbToneOfState)).toEqual(["accent", "warn", "danger", "ok", "ok", "neutral", "neutral", "neutral", "neutral"]);
    expect(orbPalette("pulse" as never)).toEqual(orbPalette("neutral"));
  });

  test("small beside his words, a seat's rings at the Roundtable, the whole display on his welcome", () => {
    expect([orbLevel(16), orbLevel(ORB_SEAT_FROM - 1), orbLevel(ORB_SEAT_FROM), orbLevel(ORB_FULL_FROM - 1), orbLevel(ORB_FULL_FROM), orbLevel(320)]).toEqual(["badge", "badge", "seat", "seat", "full", "full"]);
    const names = (size: number) => orbParts(size).map((part) => part.name);
    expect(names(28)).toEqual(["ring", "glow", "nucleus", "sphere"]);
    expect(names(64)).toEqual(["halo", "ring", "notches", "segments", "glow", "nucleus", "sphere"]);
    expect(names(168)).toEqual(["halo", "ring", "notches", "ticks", "marks", "data", "segments", "glow", "nucleus", "sphere"]);
  });

  test("every part stays in its square, its arcs go round clockwise, its gradients run from 0 to 1", () => {
    for (const size of [28, 64, 168]) {
      for (const part of orbParts(size)) {
        expect(reach(part)).toBeLessThanOrEqual(100);
        if (part.kind === "ring") for (const [from, to] of part.arcs ?? []) expect(0 <= from && from < to && to <= 360).toBe(true);
        if (part.kind === "disc") {
          const at = part.stops.map((stop) => stop.at);
          expect([at[0], at.at(-1)]).toEqual([0, 1]);
          expect([...at].sort((a, b) => a - b)).toEqual(at);
        }
      }
    }
    // His sphere of glyphs is the last thing drawn, over his nucleus and the light it sits in, inside every ring; finer
    // the larger he is (your word, 25 November 2026: his orb too is glyphs, round a nucleus, with a ring of data).
    const spheres = [28, 64, 168].map((size) => orbParts(size).at(-1)!);
    for (const sphere of spheres) expect(sphere.kind).toBe("sphere");
    const [badge, seat, full] = spheres.map((part) => (part.kind === "sphere" ? part : null)!);
    expect(badge!.count < seat!.count && seat!.count < full!.count).toBe(true);
    expect(badge!.glyph > seat!.glyph && seat!.glyph > full!.glyph).toBe(true);
    for (const size of [64, 168]) {
      const parts = orbParts(size);
      const sphere = parts.at(-1)!;
      for (const ring of parts.filter((part) => part.kind === "ring")) expect(ring.r - (ring.kind === "ring" ? ring.width / 2 : 0)).toBeGreaterThan(reach(sphere));
    }
    // The data ring sits between the ticks and the segments, touching neither.
    const display = orbParts(168);
    const data = display.find((part) => part.name === "data")!;
    const ticks = display.find((part) => part.name === "marks")!;
    const segments = display.find((part) => part.name === "segments")!;
    expect(data.kind === "glyphs" && ticks.kind === "ticks" && segments.kind === "ring").toBe(true);
    if (data.kind === "glyphs" && ticks.kind === "ticks" && segments.kind === "ring") {
      expect(data.r + data.size / 2).toBeLessThan(ticks.r - ticks.length / 2);
      expect(data.r - data.size / 2).toBeGreaterThan(segments.r + segments.width / 2);
    }
  });
});
