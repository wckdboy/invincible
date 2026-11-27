import { describe, expect, test } from "bun:test";
import { handleSeed, isOrbProfile } from "../src/avatar.ts";
import { MARK_PALETTE, readMarkProfile, snapColor } from "../src/agent-mark.ts";
import {
  assignGlass,
  backfillGlass,
  GLASS_FAMILIES,
  GLASS_PEARL,
  GLASS_RAMP_OKLCH,
  GLASS_RAMPS,
  GLASS_SHAPES,
  type Glass,
  glassOf,
  glassProfile,
  glassState,
  isGlassProfile,
  readGlassProfile,
} from "../src/glass.ts";

/*
 * The glass avatars (glass.ts): 22 shapes of our own, eight ramps on the palette's eight hues, and the node's rule for who
 * wears what. The designer's sheet (shadcn-3/avatars.html) is the specification.
 */

const FLEET = ["coder", "tester", "researcher", "builder", "scout", "writer", "ops", "reviewer", "designer", "analyst", "editor", "planner"];

/** Each agent of a fleet given its glass in the order it joined, as the node does. */
function given(ids: readonly string[]): Glass[] {
  const out: Glass[] = [];
  for (const id of ids) out.push(assignGlass(id, out));
  return out;
}

describe("the shapes", () => {
  test("22 of our own: Sprout and Zigzag, which read as V and W, are gone", () => {
    expect(GLASS_SHAPES).toHaveLength(22);
    const ids = GLASS_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(22);
    expect(ids).not.toContain("sprout");
    expect(ids).not.toContain("zigzag");
  });

  test("each is a tube or a fill, in one of six families, and its path is lines and curves alone (no arcs to draw)", () => {
    const families = new Set(Object.values(GLASS_FAMILIES));
    expect([...families].sort()).toEqual(["blob", "disc", "line", "lobes", "point", "ring"]);
    for (const s of GLASS_SHAPES) {
      expect(families.has(s.family)).toBe(true);
      expect(GLASS_FAMILIES[s.id]).toBe(s.family);
      expect(s.d).toMatch(/^M[-0-9. MLCQZ]+$/);
      expect(s.d).not.toMatch(/A/);
      if (s.kind === "tube") expect(s.width).toBeGreaterThan(0);
      else expect(s.width).toBeGreaterThanOrEqual(0);
      // The small form, for 16 px: thicker tubes, softer corners.
      expect(s.smallWidth).toBe(s.kind === "tube" ? +(s.width * 1.28).toFixed(1) : s.width + 3);
    }
  });

  test("an arc written as curves keeps to its circle: the Ring's centre line is within a twentieth of a unit of radius 28", () => {
    const ring = GLASS_SHAPES.find((s) => s.id === "ring")!;
    const n = ring.d.match(/-?[0-9.]+/g)!.map(Number);
    // M x y, then cubic segments of six numbers each.
    let [x0, y0] = [n[0]!, n[1]!];
    let worst = 0;
    for (let i = 2; i + 5 < n.length; i += 6) {
      const [c1x, c1y, c2x, c2y, x, y] = n.slice(i, i + 6) as [number, number, number, number, number, number];
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        const px = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x;
        const py = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y;
        worst = Math.max(worst, Math.abs(Math.hypot(px - 50, py - 50) - 28));
      }
      [x0, y0] = [x, y];
    }
    expect(worst).toBeLessThan(0.05);
  });
});

describe("the ramps", () => {
  test("eight, one for each of the palette's hues, so a colour you chose keeps its meaning", () => {
    expect(GLASS_RAMPS).toHaveLength(MARK_PALETTE.length);
    expect(GLASS_RAMPS.map((r) => r.id)).toEqual(["ember", "citrus", "meadow", "lagoon", "glacier", "aurora", "dusk", "orchid"]);
  });

  test("each stop is the designer's OKLCH in sRGB, brought into gamut as CSS Color 4 does; the Guardian's pearl too", () => {
    for (const ramp of [...GLASS_RAMPS, GLASS_PEARL]) {
      const source = GLASS_RAMP_OKLCH[ramp.id]!;
      for (const theme of ["light", "dark"] as const) {
        const stops = ramp[theme];
        expect([stops.highlight, stops.a, stops.b, stops.accent, stops.deep]).toEqual(source[theme].map(inSrgb));
      }
    }
  });
});

describe("who wears what (the node's rule)", () => {
  test("twelve agents wear twelve shapes from all six families, and all eight colours, never one of the two before", () => {
    const glass = given(FLEET);
    expect(new Set(glass.map((g) => g.shape)).size).toBe(12);
    expect(new Set(glass.map((g) => GLASS_SHAPES[g.shape]!.family)).size).toBe(6);
    const colours = glass.map((g) => g.color);
    expect(new Set(colours).size).toBe(8);
    const counts = MARK_PALETTE.map((_, c) => colours.filter((x) => x === c).length).sort();
    expect(counts).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    colours.forEach((c, i) => {
      if (i > 0) expect(c).not.toBe(colours[i - 1]!);
      if (i > 1) expect(c).not.toBe(colours[i - 2]!);
    });
  });

  test("the first agent wears its handle's own: its seed's shape and colour", () => {
    const seed = handleSeed("coder");
    expect(assignGlass("coder", [])).toEqual({ shape: seed % 22, color: (seed >>> 7) % 8 });
  });

  test("a colour you chose is kept, snapped to the eight; the shape still follows the rule", () => {
    const before = given(FLEET.slice(0, 3));
    const glass = assignGlass("writer", before, "#ff0000");
    expect(glass.color).toBe(snapColor("#ff0000"));
    expect(before.map((g) => g.shape)).not.toContain(glass.shape);
  });

  test("past 22 agents shapes are worn again, the least-worn first, and every agent still gets one", () => {
    const ids = Array.from({ length: 30 }, (_, n) => `agent-${n}`);
    const glass = given(ids);
    expect(new Set(glass.slice(0, 22).map((g) => g.shape)).size).toBe(22);
    const wear = new Map<number, number>();
    for (const g of glass) wear.set(g.shape, (wear.get(g.shape) ?? 0) + 1);
    expect(Math.max(...wear.values())).toBe(2);
    for (const g of glass) {
      expect(g.shape).toBeGreaterThanOrEqual(0);
      expect(g.shape).toBeLessThan(22);
    }
  });
});

describe("its profile, read strictly", () => {
  const amber = MARK_PALETTE[0]!.light;

  test("v 4: exactly its colour (one of the eight) and its shape (0 to 21)", () => {
    expect(isGlassProfile({ v: 4, color: amber, shape: 21 })).toBe(true);
    expect(glassProfile({ color: 0, shape: 21 })).toEqual({ v: 4, color: amber, shape: 21 });
    for (const not of [
      { v: 4, color: amber, shape: 22 },
      { v: 4, color: amber, shape: 1.5 },
      { v: 4, color: "#123456", shape: 1 },
      { v: 4, color: amber, shape: 1, extra: true },
      { v: 3, color: amber, form: 1 },
      { v: 5, color: amber, shape: 1 },
      null,
      "glass",
      [4, amber, 1],
    ]) expect(isGlassProfile(not)).toBe(false);
  });

  test("an agent's glass from what it has: its own (v 4); v 3's colour or v 2's, snapped, with its handle's shape; else its handle's", () => {
    const seed = handleSeed("scout");
    const handle = { shape: seed % 22, color: (seed >>> 7) % 8 };
    expect(glassOf("scout", { v: 4, color: MARK_PALETTE[5]!.light, shape: 7 })).toEqual({ color: 5, shape: 7 });
    expect(glassOf("scout", { v: 3, color: MARK_PALETTE[2]!.light, form: 9 })).toEqual({ color: 2, shape: handle.shape });
    expect(glassOf("scout", { v: 2, color: "#ff0000" })).toEqual({ color: snapColor("#ff0000"), shape: handle.shape });
    for (const other of [undefined, null, { v: 5, color: MARK_PALETTE[1]!.light, shape: 3 }, { v: 4, color: "nope", shape: 1 }, 42]) {
      expect(glassOf("scout", other)).toEqual(handle);
    }
    expect(readGlassProfile({ v: 4, color: MARK_PALETTE[7]!.light, shape: 0 })).toEqual({ color: 7, shape: 0 });
  });

  test("forward-compatible: an app already out reads a v 4 as no mark of its own, and draws its handle's", () => {
    const v4 = glassProfile({ color: 3, shape: 4 });
    // Today's apps: exactly v 3 (core's readMarkProfile and its ports).
    expect(readMarkProfile(v4)).toBeNull();
    // The TestFlight app (main 4f64e46): exactly { v: 2, color } (AgentOrb.chosenColor), as core's isOrbProfile.
    expect(isOrbProfile(v4)).toBe(false);
    // And it keeps the colour where an older reader would look for one.
    expect(v4.color).toBe(MARK_PALETTE[3]!.light);
  });
});

describe("the backfill (a node's agents from before the glass)", () => {
  test("v 4 kept; v 3 keeps its colour and gets a shape; v 2 keeps its colour, snapped; nothing gets both, all by the rule", () => {
    const red = "#ff0000";
    const agents = [
      { id: "coder", avatar: { v: 3, color: MARK_PALETTE[4]!.light, form: 2 } },
      { id: "tester", avatar: { v: 4, color: MARK_PALETTE[1]!.light, shape: 11 } },
      { id: "researcher", avatar: { v: 2, color: red } },
      { id: "builder", avatar: undefined },
      { id: "scout", avatar: { v: 9, what: "a profile from later" } },
    ];
    const glass = backfillGlass(agents);
    expect(glass[0]!.color).toBe(4);
    expect(glass[1]).toEqual({ color: 1, shape: 11 });
    expect(glass[2]!.color).toBe(snapColor(red));
    // Each one's shape by the rule, after the ones before it: none repeats while shapes are free.
    expect(new Set(glass.map((g) => g.shape)).size).toBe(5);
    expect(glass[3]).toEqual(assignGlass("builder", glass.slice(0, 3)));
    expect(glass[4]).toEqual(assignGlass("scout", glass.slice(0, 4)));
  });

  test("the states it shows: a dot and the word, working, needs, failed, and idle for the rest", () => {
    expect(glassState("working")).toBe("working");
    expect(glassState("needs")).toBe("needs");
    expect(glassState("failed")).toBe("failed");
    for (const rest of ["idle", "queued", "paused", "done"] as const) expect(glassState(rest)).toBe("idle");
  });
});

/* ---------- CSS Color 4's gamut mapping, to check the ramps' sRGB against the designer's OKLCH ---------- */

type Vec = [number, number, number];
function oklchToLinear([l, c, h]: Vec): Vec {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3, M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3, S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
}
function linearToOklab(rgb: Vec): Vec {
  const l = Math.cbrt(0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]);
  const m = Math.cbrt(0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]);
  const s = Math.cbrt(0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const inGamut = (rgb: Vec) => rgb.every((v) => v >= -1e-9 && v <= 1 + 1e-9);
const clip = (rgb: Vec): Vec => rgb.map((v) => Math.min(1, Math.max(0, v))) as Vec;
const deltaEOK = (x: Vec, y: Vec) => {
  const p = linearToOklab(x), q = linearToOklab(y);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
/** CSS Color 4 §13.2's binary search on chroma, with its JND of 0.02 and epsilon of 0.0001. */
function gamutMapped(lch: Vec): Vec {
  if (lch[0] >= 1) return [1, 1, 1];
  if (lch[0] <= 0) return [0, 0, 0];
  const origin = oklchToLinear(lch);
  if (inGamut(origin)) return clip(origin);
  const JND = 0.02, epsilon = 0.0001;
  let clipped = clip(origin);
  if (deltaEOK(clipped, origin) < JND) return clipped;
  let min = 0, max = lch[1], minInGamut = true;
  while (max - min > epsilon) {
    const chroma = (min + max) / 2, current = oklchToLinear([lch[0], chroma, lch[2]]);
    if (minInGamut && inGamut(current)) {
      min = chroma;
      continue;
    }
    clipped = clip(current);
    const E = deltaEOK(clipped, current);
    if (E < JND) {
      if (JND - E < epsilon) return clipped;
      minInGamut = false;
      min = chroma;
    } else max = chroma;
  }
  return clipped;
}
function inSrgb(lch: readonly number[]): string {
  const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  return `#${gamutMapped(lch as unknown as Vec).map((v) => Math.round(Math.min(1, Math.max(0, encode(v))) * 255).toString(16).padStart(2, "0")).join("")}`;
}
