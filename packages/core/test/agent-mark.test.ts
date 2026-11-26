import { describe, expect, test } from "bun:test";
import { handleSeed } from "../src/avatar.ts";
import {
  assignMark,
  isMarkProfile,
  joinOrder,
  MARK_ANGLES,
  MARK_FORMS,
  MARK_PALETTE,
  MARK_PAUSED,
  MARK_QUEUED,
  MARK_STATES,
  markColors,
  markCos,
  markForm,
  markGeometry,
  markOf,
  markProfile,
  markState,
  markSin,
  readMarkProfile,
  snapColor,
  type AgentMark,
} from "../src/agent-mark.ts";

/*
 * The Grille (O2, the owner's choice on 26 November 2026), held to O1's design: its palette, its forms, the sheet's own
 * assignment of the dev fleet, and its geometry, number for number with what O1's marks.ts drew for the sheet.
 */

/** The dev node's agents in the order they join, and the mark the sheet the owner chose from gives each. */
const FLEET = ["builder", "writer", "researcher", "coder", "reviewer", "operator", "designer", "tester", "ops", "docs"];
const SHEET: Record<string, AgentMark> = {
  builder: { color: 0, form: 1 },
  writer: { color: 2, form: 5 },
  researcher: { color: 3, form: 2 },
  coder: { color: 4, form: 10 },
  reviewer: { color: 5, form: 3 },
  operator: { color: 6, form: 4 },
  designer: { color: 7, form: 6 },
  tester: { color: 1, form: 8 },
  ops: { color: 3, form: 7 },
  docs: { color: 2, form: 0 },
};

/** `t` of the way from one colour to another in OKLab (Björn Ottosson's), as O1's color.ts mixes. */
function mixOklab(from: string, to: string, t: number): string {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const gamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const lab = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => lin(parseInt(hex.slice(at, at + 2), 16) / 255)) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const [p, q] = [lab(from), lab(to)];
  const [L, A, B] = [0, 1, 2].map((i) => p[i]! + (q[i]! - p[i]!) * t) as [number, number, number];
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, gamma(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** The fleet given its marks one by one, as a node gives them as each joins. */
function fleet(ids: string[]): AgentMark[] {
  const out: AgentMark[] = [];
  for (const id of ids) out.push(assignMark(id, out));
  return out;
}

describe("the palette and the forms", () => {
  test("eight hues, each with its light-page and dark-page form, none red", () => {
    expect(MARK_PALETTE.map((h) => h.name)).toEqual(["Amber", "Lime", "Green", "Teal", "Sky", "Blue", "Violet", "Magenta"]);
    expect(MARK_PALETTE.map((h) => [h.light, h.dark])).toEqual([
      ["#c88200", "#ffbc63"], ["#699700", "#b1ef4a"], ["#007745", "#18c376"], ["#04a19b", "#34eee5"],
      ["#0084ba", "#3bb7f7"], ["#3453d3", "#5b81fe"], ["#9a68da", "#ccabff"], ["#a23493", "#e26ace"],
    ]);
  });

  test("twelve forms: two or three slots, at one of six angles", () => {
    expect(MARK_FORMS).toBe(12);
    expect(MARK_ANGLES).toEqual([-40, -27, -14, 14, 27, 40]);
    expect(Array.from({ length: 12 }, (_, n) => markForm(n))).toEqual([
      ...[-40, -27, -14, 14, 27, 40].map((angle) => ({ slots: 2 as const, angle })),
      ...[-40, -27, -14, 14, 27, 40].map((angle) => ({ slots: 3 as const, angle })),
    ]);
  });
});

describe("each agent's mark, given once as it joins", () => {
  test("the dev fleet, in the order it joins, gets the sheet's marks: a colour each until all eight are taken", () => {
    const marks = fleet(FLEET);
    expect(Object.fromEntries(FLEET.map((id, i) => [id, marks[i]]))).toEqual(SHEET);
    expect(new Set(marks.slice(0, 8).map((m) => m.color)).size).toBe(8);
  });

  test("a ninth agent repeats a colour but never a form: colour and form both differ while they can", () => {
    const marks = fleet(FLEET);
    const pairs = new Set(marks.map((m) => `${m.color}/${m.form}`));
    expect(pairs.size).toBe(marks.length);
    // Twelve forms in all, each worn once before any repeats.
    const twelve = fleet([...FLEET, "scout", "scribe"]);
    expect(new Set(twelve.map((m) => m.form)).size).toBe(12);
    // A thirteenth wears a form again, but none its own colour's agents wear.
    const more = fleet([...FLEET, "scout", "scribe", "warden", "pilot", "smith"]);
    for (const [i, mark] of more.entries()) {
      const sameColour = more.slice(0, i).filter((m) => m.color === mark.color);
      expect(sameColour.some((m) => m.form === mark.form)).toBe(false);
    }
  });

  test("a colour you pick snaps to the nearest of the eight, never to red", () => {
    expect(snapColor("#ff0000")).toBe(0);
    expect(snapColor("#3abeff")).toBe(4);
    expect(snapColor("#6eca73")).toBe(2);
    for (const [n, hue] of MARK_PALETTE.entries()) {
      expect(snapColor(hue.light)).toBe(n);
      expect(snapColor(hue.dark)).toBe(n);
    }
    // Chosen as it joins, it takes that colour even where another agent has it.
    const writer = assignMark("writer", [{ color: 0, form: 1 }], "#ffbc63");
    expect(writer.color).toBe(0);
    expect(writer.form).not.toBe(1);
  });

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

describe("a mark as saved, and as an older app or profile has it", () => {
  test("saved as {v: 3, color, form}: the colour its light form, read back strictly", () => {
    const profile = markProfile({ color: 4, form: 10 });
    expect(profile).toEqual({ v: 3, color: "#0084ba", form: 10 });
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

  test("drawn from what an agent has: its own mark; a colour chosen before the marks, snapped; else its handle's", () => {
    expect(markOf("coder", { v: 3, color: "#0084ba", form: 10 })).toEqual({ color: 4, form: 10 });
    const seed = handleSeed("coder");
    expect(markOf("coder", { v: 2, color: "#3abeff" })).toEqual({ color: 4, form: (seed >>> 8) % 12 });
    expect(markOf("coder")).toEqual({ color: seed % 8, form: (seed >>> 8) % 12 });
    expect(markOf("coder", { v: 3, color: "#0084ba", form: 99 })).toEqual({ color: seed % 8, form: (seed >>> 8) % 12 });
  });
});

describe("its states, as data", () => {
  test("what an agent is seen doing, as its mark shows it", () => {
    expect(markState("idle")).toBe("idle");
    for (const at of ["thinking", "working", "reading", "browsing", "checking"] as const) expect(markState(at)).toBe("working");
    expect(markState("asking")).toBe("needs");
    expect(markState("waiting")).toBe("queued");
    expect(markState("resting")).toBe("paused");
    expect(markState("pleased")).toBe("done");
    expect(markState("concerned")).toBe("failed");
  });

  test("its colours: its own, pale while queued, grey while paused, its key slat in ink when it asks you and red when it failed", () => {
    // O1's mix in OKLab, worked out once: the apps take these as they are.
    expect(MARK_QUEUED).toEqual([
      { light: "#ebcdaa", dark: "#634721" }, { light: "#c1d6a9", dark: "#425c17" }, { light: "#a5c8b1", dark: "#044a29" }, { light: "#b0d9d6", dark: "#0e5c58" },
      { light: "#aacee5", dark: "#114560" }, { light: "#a7bdf2", dark: "#1e2e63" }, { light: "#d5c3f3", dark: "#4e4063" }, { light: "#deafd4", dark: "#57244e" },
    ]);
    expect(MARK_PAUSED).toEqual({ light: "#8c8c8d", dark: "#484848" });
    // Mixed again here, as O1 mixed them (color.ts: in OKLab, as CSS color-mix(in oklab) does).
    for (const [n, hue] of MARK_PALETTE.entries()) expect(MARK_QUEUED[n]).toEqual({ light: mixOklab(hue.light, "#ffffff", 0.6), dark: mixOklab(hue.dark, "#000000", 0.5) });
    expect(MARK_PAUSED).toEqual({ light: mixOklab("#ffffff", "#0a0a0b", 0.42), dark: mixOklab("#000000", "#ffffff", 0.4) });
    expect(markColors(2, "idle", "light")).toEqual({ body: "#007745", key: "#007745" });
    expect(markColors(2, "working", "dark")).toEqual({ body: "#18c376", key: "#18c376" });
    expect(markColors(2, "needs", "dark")).toEqual({ body: "#18c376", key: "#ffffff" });
    expect(markColors(2, "needs", "light")).toEqual({ body: "#007745", key: "#0a0a0b" });
    expect(markColors(2, "failed", "light")).toEqual({ body: "#007745", key: "#c4141b" });
    expect(markColors(2, "failed", "dark")).toEqual({ body: "#18c376", key: "#ee2c36" });
    expect(markColors(3, "queued", "light")).toEqual({ body: "#b0d9d6", key: "#b0d9d6" });
    expect(markColors(1, "paused", "dark")).toEqual({ body: "#484848", key: "#484848" });
  });
});

describe("its geometry, number for number with O1's sheet", () => {
  const two = (n: number) => Math.round(n * 100) / 100;
  const slats = (id: string, mark: AgentMark, state: Parameters<typeof markGeometry>[0]["state"], size: number, t: number | null, since: number | null) =>
    markGeometry({ mark, seed: handleSeed(id), state, size, t, since });

  test("still: its slats across a disc of radius 44 in a 100-unit box, at its angle; the slots 7.5 units, or 1.35 pt at the least", () => {
    const builder = slats("builder", SHEET.builder!, "idle", 64, null, null);
    expect(builder.angle).toBe(-27);
    expect(builder.radius).toBe(44);
    expect(builder.slats.map((s) => [two(s.from), two(s.to), s.slide, s.fill, s.drop, s.turn])).toEqual([
      [-44, -19.67, 0, "body", 0, 0],
      [-12.17, 12.17, 0, "body", 0, 0],
      [19.67, 44, 0, "body", 0, 0],
    ]);
    // At 16 pt a slot is 1.35 pt, wider than 7.5 units.
    expect(slats("ops", SHEET.ops!, "queued", 16, null, null).slats.map((s) => [two(s.from), two(s.to)])).toEqual([
      [-44, -28.33], [-19.89, -4.22], [4.22, 19.89], [28.33, 44],
    ]);
  });

  test("working: each slat slides along its slot in its own phase, a cycle every 5.5 s", () => {
    const coder = slats("coder", SHEET.coder!, "working", 44, 1, null);
    expect(coder.angle).toBe(27);
    expect(coder.slats.map((s) => [two(s.from), two(s.to), two(s.slide)])).toEqual([
      [-44, -27.62, 4.54], [-20.12, -3.75, 3.92], [3.75, 20.13, -4.54], [27.63, 44, -3.92],
    ]);
    // Still, as rows and reduced motion show it: no slide.
    expect(slats("coder", SHEET.coder!, "working", 44, null, null).slats.every((s) => s.slide === 0)).toBe(true);
  });

  test("asks you: its top slat in ink, out of line, beating every 4.2 s", () => {
    const beating = slats("writer", SHEET.writer!, "needs", 28, 2.1, null);
    expect(beating.slats.map((s) => [s.fill, two(s.slide)])).toEqual([["key", 7], ["body", 0], ["body", 0]]);
    expect(slats("writer", SHEET.writer!, "needs", 28, null, null).slats[0]!.slide).toBe(5);
  });

  test("failed: its bottom slat red, knocked loose about its middle as it arrives, then still", () => {
    const arriving = slats("docs", SHEET.docs!, "failed", 64, 0.3, 0.3);
    const bottom = arriving.slats[2]!;
    expect([bottom.fill, two(bottom.drop), two(bottom.turn), two(bottom.pivot[0]), two(bottom.pivot[1])]).toEqual(["key", 7, 8.75, 70.46, 74.39]);
    const settled = slats("docs", SHEET.docs!, "failed", 64, null, null).slats[2]!;
    expect([settled.drop, settled.turn]).toEqual([8, 10]);
    expect(arriving.slats.slice(0, 2).every((s) => s.fill === "body" && s.drop === 0)).toBe(true);
  });

  test("done: its slots close and open once as it arrives, then still", () => {
    const done = slats("researcher", SHEET.researcher!, "done", 20, 0, 0.7);
    expect(done.slats.map((s) => [two(s.from), two(s.to)])).toEqual([[-44, -15.42], [-14.29, 14.29], [15.42, 44]]);
    const after = slats("researcher", SHEET.researcher!, "done", 20, 0, 2);
    expect(after.slats.map((s) => two(s.from))).toEqual([-44, -12.17, 19.67]);
  });
});

describe("its arithmetic, the same to the last bit on every platform", () => {
  test("a mark is drawn without the platform's sine, cosine or power, in every state and moment", () => {
    // Their last bits are each platform's own: CI's Linux runner read a working slat's slide one bit off the Mac's.
    const real = { sin: Math.sin, cos: Math.cos, pow: Math.pow };
    const refuse = (name: string) => () => {
      throw new Error(`a mark asked the platform for Math.${name}`);
    };
    Object.assign(Math, { sin: refuse("sin"), cos: refuse("cos"), pow: refuse("pow") });
    try {
      for (const state of MARK_STATES)
        for (const [t, since] of [[null, null], [0, 0], [2.1, 0.3], [7.7, 1.1], [86_400.25, 0.59]] as const)
          for (const form of [0, 5, 11]) markGeometry({ mark: { color: 3, form }, seed: 12_345, state, size: 44, t, since });
    } finally {
      Object.assign(Math, real);
    }
  });

  test("markSin and markCos are within 1e-13 of the true values for a mark's angles, and 1e-10 a day into a page's clock", () => {
    const worst = (from: number, to: number, step: number) => {
      let most = 0;
      for (let x = from; x <= to; x += step) most = Math.max(most, Math.abs(markSin(x) - Math.sin(x)), Math.abs(markCos(x) - Math.cos(x)));
      return most;
    };
    expect(worst(-1_000, 1_000, 0.010_000_3)).toBeLessThan(1e-13);
    // (A page open a day: the working slats' phase is 2π·86,400/5.5 there.)
    expect(worst(98_000, 99_000, 0.007_31)).toBeLessThan(1e-10);
  });

  test("their bits, pinned: what every port must say", () => {
    expect([markSin(0), markCos(0), markSin(1), markCos(1), markSin(-2.5), markCos(-2.5), markSin(100), markCos(100)]).toEqual([
      0, 1, 0.8414709848078965, 0.5403023058681399, -0.5984721441039573, -0.8011436155469338, -0.5063656411097555, 0.8623188722876859,
    ]);
  });
});
