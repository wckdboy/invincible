import { describe, expect, test } from "bun:test";
import { isMarkProfile, joinOrder, markCubeRoot, MARK_LINEAR, MARK_PALETTE, markState, readMarkProfile, snapColor } from "../src/agent-mark.ts";

/*
 * What the Grille (O2, 26 November 2026) leaves the glass: its palette, the snap of a colour you pick to it, a mark an
 * older app saved read for its colour, the order agents joined in, and the states an agent is shown in.
 */

/** A colour in OKLab (Björn Ottosson's), reckoned the usual way, with pow and cbrt: the tests' own, to hold the snap to. */
function oklab(hex: string): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = [1, 3, 5].map((at) => lin(parseInt(hex.slice(at, at + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** The eight hues' angles, from their light forms. */
const PALETTE_HUES = MARK_PALETTE.map((hue) => { const [, a, b] = oklab(hue.light); return (Math.atan2(b, a) * 180) / Math.PI; });
/** Which hue's form is nearest a grey in lightness (the first on a tie). */
function nearestByLightness(hex: string): number {
  const L = oklab(hex)[0];
  let best = 0, apart = Infinity;
  MARK_PALETTE.forEach((hue, n) => { for (const form of [hue.light, hue.dark]) { const d = Math.abs(oklab(form)[0] - L); if (d < apart) [best, apart] = [n, d]; } });
  return best;
}

describe("the palette", () => {
  test("eight hues, each with its light-page and dark-page form, none red", () => {
    expect(MARK_PALETTE.map((h) => h.name)).toEqual(["Amber", "Lime", "Green", "Teal", "Sky", "Blue", "Violet", "Magenta"]);
    expect(MARK_PALETTE.map((h) => [h.light, h.dark])).toEqual([
      ["#c88200", "#ffbc63"], ["#699700", "#b1ef4a"], ["#007745", "#18c376"], ["#04a19b", "#34eee5"],
      ["#0084ba", "#3bb7f7"], ["#3453d3", "#5b81fe"], ["#9a68da", "#ccabff"], ["#a23493", "#e26ace"],
    ]);
  });
});

describe("a colour you pick, snapped to the eight", () => {
  test("a colour you pick snaps to the nearest hue of the eight (OKLCH), its lightness and chroma only breaking ties: never red, a mint never Violet", () => {
    // A pale mint (176°) is Teal's (190°), not Green's (156°), and never Violet: the old sRGB distance, led by
    // lightness, took it to Violet's pale form.
    expect(snapColor("#b9dfd4")).toBe(3);
    // The old 24 tints' Cornflower (265°) is Blue (268°), where the old distance took it to Violet too.
    expect(snapColor("#8bafff")).toBe(5);
    // Red (29°) is Amber (72°), nearer than Magenta (334°): never red, which isn't among the eight.
    expect(snapColor("#ff0000")).toBe(0);
    expect(snapColor("#3abeff")).toBe(4);
    expect(snapColor("#6eca73")).toBe(2);
    expect(snapColor("#fa86b6")).toBe(7);
    // Mustard (99.7°) is Amber's (72°) by half a degree over Lime's (128°).
    expect(snapColor("#c8b222")).toBe(0);
    expect(snapColor("#C8B222")).toBe(0);
    for (const [n, hue] of MARK_PALETTE.entries()) {
      expect(snapColor(hue.light)).toBe(n);
      expect(snapColor(hue.dark)).toBe(n);
    }
    // A grey has no hue: the nearest lightness among the sixteen forms decides.
    for (const grey of ["#000000", "#808080", "#ffffff", "#f5f5f0", "#202020"]) expect(snapColor(grey)).toBe(nearestByLightness(grey));
  });

  test("the snap is the nearest hue as OKLCH has it, over a sweep of colours: computed with + − × ÷ and √ alone, so every app comes to the same", () => {
    // Held against an independent reckoning with Math's pow, cbrt and atan2 (which differ between platforms in their
    // last bits, and so aren't used to snap), where the nearest hue is clear by more than a hundredth of a degree.
    let compared = 0;
    for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) {
      const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      const lab = oklab(hex);
      if (Math.hypot(lab[1], lab[2]) < 0.02) continue;
      const hue = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
      const apart = PALETTE_HUES.map((h) => Math.abs(((hue - h + 540) % 360) - 180)).map((d, n) => [d, n] as const).sort((x, y) => x[0] - y[0]);
      if (apart[1]![0] - apart[0]![0] < 0.01) continue;
      expect([hex, snapColor(hex)]).toEqual([hex, apart[0]![1]]);
      compared++;
    }
    expect(compared).toBeGreaterThan(4000);
  });
  test("what the snap is reckoned from: sRGB's levels in linear light, written out, and a cube root by Newton's method, each within a part in 10^15", () => {
    MARK_LINEAR.forEach((value, i) => {
      const c = i / 255;
      expect(Math.abs(value - (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))).toBeLessThanOrEqual(1e-15);
    });
    expect(MARK_LINEAR).toHaveLength(256);
    for (let n = 0; n <= 4096; n++) {
      const x = n / 4096;
      expect(Math.abs(markCubeRoot(x) - Math.cbrt(x))).toBeLessThanOrEqual(1e-15);
    }
    expect(Math.abs(markCubeRoot(1e-9) - Math.cbrt(1e-9))).toBeLessThanOrEqual(1e-15);
  });

  test("every one of the 2^24 colours snaps as it did when the snap was made (26 November 2026): its digest and how many go to each hue", () => {
    // FNV-1a over each colour's snap, a byte each, from #000000 to #ffffff: the vectors carry it, for every app.
    let digest = 0x811c9dc5;
    const counts = new Array(8).fill(0);
    for (let n = 0; n < 1 << 24; n++) {
      const k = snapColor(`#${n.toString(16).padStart(6, "0")}`);
      counts[k]++;
      digest = Math.imul(digest ^ k, 0x01000193) >>> 0;
    }
    expect(counts).toEqual([2536993, 2958905, 2378096, 1123922, 966719, 1920373, 1640919, 3251289]);
    expect(digest.toString(16)).toBe("907c090c");
  }, 30_000);
});

describe("the order agents joined in", () => {
  test("the order agents joined in: when each was made, then its handle", () => {
    const agents = [
      { id: "ops", createdAt: 30 },
      { id: "builder", createdAt: 10 },
      { id: "writer", createdAt: 20 },
      { id: "coder", createdAt: 20 },
    ];
    expect(joinOrder(agents).map((a) => a.id)).toEqual(["builder", "coder", "writer", "ops"]);
  });
});

describe("a mark as an app or a node from before the glass saved it", () => {
  test("saved as {v: 3, color, form} by an app or a node from before the glass: its colour its light form, read back strictly", () => {
    const profile = { v: 3, color: "#0084ba", form: 10 };
    expect(isMarkProfile(profile)).toBe(true);
    expect(readMarkProfile(profile)).toEqual({ color: 4, form: 10 });
    for (const bad of [
      { v: 3, color: "#0084ba", form: 12 },
      { v: 3, color: "#0084ba", form: 1.5 },
      { v: 3, color: "#123456", form: 1 },
      { v: 3, color: "#0084BA", form: 1 },
      { v: 3, color: "#0084ba", form: 1, extra: true },
      { v: 2, color: "#0084ba" },
      null,
      "#0084ba",
    ]) {
      expect(isMarkProfile(bad)).toBe(false);
      expect(readMarkProfile(bad)).toBeNull();
    }
  });
});

describe("the states an agent is shown in", () => {
  test("what an agent is seen doing, as its mark shows it", () => {
    expect(markState("idle")).toBe("idle");
    for (const at of ["thinking", "working", "reading", "browsing", "checking"] as const) expect(markState(at)).toBe("working");
    expect(markState("asking")).toBe("needs");
    expect(markState("waiting")).toBe("queued");
    expect(markState("resting")).toBe("paused");
    expect(markState("pleased")).toBe("done");
    expect(markState("concerned")).toBe("failed");
  });
});
