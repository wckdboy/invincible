import { describe, expect, test } from "bun:test";
import { AURUM, fieldAt, fieldBuffer, fieldLight, fieldModel, fieldPoints, project, shade, shadeLit, type FieldOptions } from "./field.ts";
import { fieldLook, GALAHAD_FIELD, knightField, type FieldIdentity } from "./field-orb.ts";

/*
 * Galahad's field as the orbs draw it (26 November 2026): the owner's words on the glyph spheres were "almost like
 * nipples" and, of a regular lattice of dots on a sphere, "too close to a discoball". So: no light at its middle, and
 * lines of uneven widths at uneven longitudes, not points spread evenly over a sphere.
 */

const HANDLES = ["ada", "gareth", "percival", "kay", "lin", "bors", "gawain", "tristan", "lancelot", "bedivere", "", "Will’s “iPad” \\ 🛡️", ...Array.from({ length: 28 }, (_, i) => `knight-${i}`)];
const TURNS = [0, 0.7, 1.9, 3.1, 4.4, 5.8];
/** A field's points as an orb draws it at a size (lib/field-orb.ts' look). */
const optionsOf = (identity: FieldIdentity, galahad: boolean, size = 160, turn = 0): FieldOptions => {
  const look = fieldLook(identity, size, galahad);
  return { lines: look.lines, steps: look.steps, tilt: identity.tilt, seed: identity.seed, colours: identity.colours, weight: look.weight, turn };
};

describe("the field, made once and turned", () => {
  test("its model turned is its points to the last bit, as the icon takes them", () => {
    const cases: FieldOptions[] = [{}, { lines: 52 }, { ...optionsOf(knightField("ada"), false, 34), turn: 2.5 }, { lines: 20, steps: 41, turn: 100.5, seed: 2147483646, weight: 1.4 }];
    for (const options of cases) {
      const model = fieldModel(options);
      const out = fieldBuffer(model);
      const count = fieldAt(model, options.turn ?? 0, out);
      const points = fieldPoints(options);
      expect(count).toBe(points.length);
      points.forEach((p, i) => {
        expect([out.x[i], out.y[i], out.z[i], out.r[i], out.g[i], out.b[i], out.size[i]]).toEqual([p.x, p.y, p.z, p.rgb[0], p.rgb[1], p.rgb[2], p.size]);
      });
      // Each point's place on its line: one after another along a line, a line after another.
      for (let i = 1; i < count; i++) expect(out.at[i]!).toBeGreaterThan(out.at[i - 1]!);
    }
  });

  test("shade is its colours read once, and the key's and the rim's light apart", () => {
    for (const n of [[0, 0, 1], [0.6, 0.64, 0.48], [-0.55, 0.58, 0.6], [0.8, -0.45, -0.35]] as [number, number, number][]) {
      const length = Math.hypot(...n);
      const unit = n.map((v) => v / length) as [number, number, number];
      const lit = shadeLit(unit, fieldLight(AURUM));
      expect(shade(unit, AURUM)).toEqual({ rgb: lit.rgb, k: lit.k });
      expect(lit.k).toBe(Math.max(lit.lit, lit.rim));
    }
  });

  test("the same field every time, and each seed its own", () => {
    expect(fieldPoints(optionsOf(knightField("ada"), false))).toEqual(fieldPoints(optionsOf(knightField("ada"), false)));
    const a = fieldModel({ seed: 7 }), b = fieldModel({ seed: 8 });
    expect([...a.phi]).not.toEqual([...b.phi]);
  });
});

describe("its middle is dark", () => {
  test("no point comes inside its core, his field or any knight's, at any turn", () => {
    for (const [identity, galahad] of [[GALAHAD_FIELD, true], ...HANDLES.map((handle) => [knightField(handle), false])] as [FieldIdentity, boolean][]) {
      for (const turn of TURNS) for (const p of fieldPoints(optionsOf(identity, galahad, 160, turn))) expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(0.33);
    }
  });

  test("on the picture, its middle holds a fraction of the light its brightest part does, and its brightest is off the middle", () => {
    // The light in each cell of a 32 by 32 grid over its square: its middle four cells against the brightest.
    const N = 32;
    for (const [identity, galahad, most] of [[GALAHAD_FIELD, true, 0.1], ...HANDLES.map((handle) => [knightField(handle), false, 0.25])] as [FieldIdentity, boolean, number][]) {
      const look = fieldLook(identity, 160, galahad);
      for (const turn of TURNS) {
        const grid = new Float64Array(N * N);
        for (const p of fieldPoints(optionsOf(identity, galahad, 160, turn))) {
          const q = project(p, N, { zoom: look.zoom });
          const [x, y] = [Math.floor(q.x), Math.floor(q.y)];
          if (x >= 0 && y >= 0 && x < N && y < N) grid[y * N + x] = grid[y * N + x]! + 0.2126 * p.rgb[0] + 0.7152 * p.rgb[1] + 0.0722 * p.rgb[2];
        }
        const brightest = Math.max(...grid);
        const middle = (grid[15 * N + 15]! + grid[15 * N + 16]! + grid[16 * N + 15]! + grid[16 * N + 16]!) / 4;
        expect(middle / brightest).toBeLessThan(most);
        const at = grid.indexOf(brightest);
        expect(Math.hypot((at % N) + 0.5 - N / 2, Math.floor(at / N) + 0.5 - N / 2) / N).toBeGreaterThan(0.04);
      }
    }
  });
});

describe("lines, not a lattice", () => {
  test("its points lie on loops near the core and far from it, not on a sphere", () => {
    for (const identity of [GALAHAD_FIELD, ...HANDLES.slice(0, 10).map((handle) => knightField(handle))]) {
      const radii = fieldPoints(optionsOf(identity, identity === GALAHAD_FIELD)).map((p) => Math.hypot(p.x, p.y, p.z));
      expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(3);
    }
  });

  test("its lines are of uneven widths at uneven longitudes: no two alike, none evenly spaced", () => {
    for (const identity of [GALAHAD_FIELD, ...HANDLES.map((handle) => knightField(handle))]) {
      const model = fieldModel({ lines: identity.lines, seed: identity.seed });
      const widths = [...model.width];
      expect(new Set(widths.map((w) => w.toFixed(6))).size).toBe(widths.length);
      expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(0.2);
      const gaps = [...model.phi].slice(1).map((phi, i) => phi - model.phi[i]!);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.02);
    }
  });
});
