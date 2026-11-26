import { describe, expect, test } from "bun:test";
import { galahadIndex, seededRandom, trialProblem } from "@galahad/core";
import { ENGINEERING_SUITE, ellipticK, grade, pose, readAnswers, tolerance, type TrialProblem } from "../src/index.ts";

/*
 * The trial suite: problems posed from a seed, exact answers, and a grader that
 * only counts numbers. The exact answers are checked here against textbook values
 * and limiting cases; scripts/trials-crosscheck.py checks them for many random
 * draws against independent solutions in the Lab.
 */

const problem = (id: string): TrialProblem => ENGINEERING_SUITE.find((p) => p.id === id)!;
const answer = (id: string, params: unknown, key: string): number => problem(id).solve(params).find((e) => e.key === key)!.value;
const near = (got: number, want: number, rel: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(rel * Math.abs(want));

describe("posing a problem", () => {
  test("fourteen problems, across every engineering domain", () => {
    expect(ENGINEERING_SUITE).toHaveLength(14);
    expect(new Set(ENGINEERING_SUITE.map((p) => p.domain))).toEqual(
      new Set(["structures", "civil", "mechanical", "electrical", "aerospace", "fluids", "thermal", "physics", "geometry"]),
    );
    expect(new Set(ENGINEERING_SUITE.map((p) => p.id)).size).toBe(14);
  });

  test("the same seed poses the same problem; another seed, another problem", () => {
    for (const p of ENGINEERING_SUITE) {
      expect(pose(p, 7).goal).toBe(pose(p, 7).goal);
      if (p.id !== "lid-driven-cavity") expect(pose(p, 7).goal).not.toBe(pose(p, 8).goal);
    }
  });

  test("every goal asks for every key, and gives none of the answers away", () => {
    for (const p of ENGINEERING_SUITE) {
      for (let seed = 0; seed < 20; seed++) {
        const posed = pose(p, seed);
        expect(new Set(posed.expected.map((e) => e.key)).size).toBe(posed.expected.length);
        for (const e of posed.expected) {
          expect(e.key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
          expect(Number.isFinite(e.value)).toBe(true);
          expect(tolerance(e)).toBeGreaterThan(0);
          expect(posed.goal).toContain(`"${e.key}"`);
          expect(posed.goal).not.toContain(e.value.toPrecision(5));
        }
      }
    }
  });

  test("the generator is mulberry32: the same everywhere", () => {
    const r = seededRandom(1);
    expect([r(), r(), r()].map((x) => x.toFixed(8))).toEqual(["0.62707394", "0.00273572", "0.52744704"]);
  });
});

describe("the exact answers agree with the textbooks", () => {
  test("a fixed–pinned column: K = 0.6992, largest deflection at 0.6017 L (not 0.7 and 0.6: those fail)", () => {
    const params = { L: 4, D: 60, t: 4, E: 200 };
    near(answer("fixed-pinned-column", params, "k_eff"), 0.69916, 1e-5);
    near(answer("fixed-pinned-column", params, "x_max_m") / 4, 0.60170, 1e-4);
    const kTol = tolerance(problem("fixed-pinned-column").solve(params).find((e) => e.key === "k_eff")!);
    expect(Math.abs(0.7 - answer("fixed-pinned-column", params, "k_eff"))).toBeGreaterThan(kTol);
  });

  test("two equal spans: R_B = 1.25 wL and M_B = wL²/8", () => {
    const p = { L1: 6, L2: 6, w: 10 };
    near(answer("two-span-beam", p, "r_b_kn"), 1.25 * 10 * 6, 1e-12);
    near(answer("two-span-beam", p, "m_b_knm"), (10 * 36) / 8, 1e-12);
    near(answer("two-span-beam", p, "r_a_kn"), (3 / 8) * 10 * 6, 1e-12);
  });

  test("Saint-Venant torsion: β and α of Timoshenko's table", () => {
    // b/h = 1: J = 0.1406 b h³, τ = T / (0.208 b h²); b/h = 2: 0.229 and 0.246; b/h = 4: 0.281 and 0.282.
    for (const [ratio, beta, alpha] of [
      [1, 0.1406, 0.208],
      [2, 0.229, 0.246],
      [4, 0.281, 0.282],
    ] as const) {
      const p = { Lbar: 1, b: 10 * ratio, h: 10, T: 100 };
      near(answer("rectangular-torsion", p, "j_mm4") / (10 * ratio * 1000), beta, 2e-3);
      near(100 / (answer("rectangular-torsion", p, "tau_max_mpa") * 1e6 * (ratio * 0.01) * 0.01 ** 2), alpha, 3e-3);
    }
  });

  test("a symmetric two-mass chain: in-phase at √(k/m), ratios ±1", () => {
    const p = { m1: 2, m2: 2, k1: 8, k2: 5, k3: 8 };
    near(answer("two-mass-oscillator", p, "f1_hz"), Math.sqrt(8000 / 2) / (2 * Math.PI), 1e-12);
    near(answer("two-mass-oscillator", p, "ratio_1"), 1, 1e-12);
    near(answer("two-mass-oscillator", p, "ratio_2"), -1, 1e-12);
  });

  test("a series RLC: ζ = (R/2)√(C/L)", () => {
    near(answer("rlc-step", { R: 10, L: 10, C: 10, V: 12, t1: 1000 }, "zeta"), 5 * Math.sqrt(1e-5 / 1e-2), 1e-12);
  });

  test("a diode: Kirchhoff's voltage law and Shockley both hold", () => {
    const p = { V: 5, R: 1000, Is: 10, n: 1.5, T: 300 };
    const i = answer("diode-resistor", p, "i_ma") / 1e3;
    const vd = answer("diode-resistor", p, "v_d_v");
    near(i * 1000 + vd, 5, 1e-12);
    near(10e-15 * (Math.exp(vd / (1.5 * ((1.380649e-23 * 300) / 1.602176634e-19))) - 1), i, 1e-9);
  });

  test("LEO to GEO without a plane change: 2.426 + 1.467 km/s, 316.5 minutes", () => {
    const p = { h1: 300, h2: 35786, di: 0 };
    near(answer("hohmann-plane-change", p, "dv1_ms"), 2426, 1e-3);
    near(answer("hohmann-plane-change", p, "dv2_ms"), 1467, 1e-3);
    near(answer("hohmann-plane-change", p, "tof_min"), 316.5, 1e-3);
  });

  test("an ideal Brayton cycle without a regenerator: η = 1 − r^(−(γ−1)/γ)", () => {
    near(answer("regenerative-brayton", { T1: 300, rp: 10, T3: 1400, etaC: 1, etaT: 1, eps: 0 }, "eta_th"), 1 - 10 ** (-0.4 / 1.4), 1e-12);
  });

  test("a thin plate cools like a lumped mass: θ ≈ exp(−Bi·Fo)", () => {
    // Bi = 0.005, Fo = 20: θ = exp(−0.1) to within the small internal gradient.
    const p = { L: 10, k: 50, c: 500, h: 25, Ti: 500, Tinf: 20, t: Math.round((20 * 0.01 ** 2 * 7800 * 500) / 50) };
    const theta = (answer("plate-quench", p, "t_center_c") - 20) / 480;
    near(theta, Math.exp(-0.1), 3e-3);
  });

  test("a pendulum: K(0) = π/2; released at 90° it's 18.03 % slower than small swings", () => {
    near(ellipticK(0), Math.PI / 2, 1e-15);
    near(ellipticK(Math.SQRT1_2), 1.8540746773013719, 1e-14);
    const T = answer("large-amplitude-pendulum", { m: 1, l: 1, theta0: 90 }, "period_s");
    near(T / (2 * Math.PI * Math.sqrt(1 / 9.80665)), 1.18034, 1e-5);
  });

  test("a projectile without drag flies the vacuum parabola", () => {
    const p = { m: 1, d: 1e-6, cd: 1e-9, v0: 30, angle: 40 };
    const s = (40 * Math.PI) / 180;
    near(answer("drag-projectile", p, "range_m"), (900 * Math.sin(2 * s)) / 9.80665, 1e-9);
    near(answer("drag-projectile", p, "h_max_m"), (900 * Math.sin(s) ** 2) / (2 * 9.80665), 1e-9);
    near(answer("drag-projectile", p, "time_s"), (60 * Math.sin(s)) / 9.80665, 1e-9);
  });

  test("a straight hole through a plate removes πr²t", () => {
    const p = { W: 100, D: 80, t: 10, d: 20, theta: 0 };
    near(answer("oblique-hole-plate", p, "volume_cm3"), (100 * 80 * 10 - Math.PI * 100 * 10) / 1e3, 1e-12);
    near(answer("oblique-hole-plate", p, "area_cm2"), (2 * (8000 - Math.PI * 100) + 2 * 180 * 10 + 2 * Math.PI * 10 * 10) / 100, 1e-12);
  });

  test("the cavity: the Ghia, Ghia & Shin (1982) table passes; a coarse guess doesn't", () => {
    const expected = problem("lid-driven-cavity").solve({});
    const ghia = { u_min: -0.2109, y_u_min: 0.4531, v_max: 0.17527, v_min: -0.24533, psi_min_abs: 0.103423, x_vortex: 0.6172, y_vortex: 0.7344 };
    expect(grade(expected, JSON.stringify(ghia)).score).toBe(1);
    expect(grade(expected, JSON.stringify({ ...ghia, u_min: -0.2, v_min: -0.23 })).score).toBeLessThan(1);
  });
});

describe("grading", () => {
  const posed = pose(problem("cantilever-beam"), 3);
  const exact = Object.fromEntries(posed.expected.map((e) => [e.key, e.value]));

  test("the exact answers score 1; inside the tolerance passes, outside fails", () => {
    expect(grade(posed.expected, JSON.stringify(exact)).score).toBe(1);
    const e = posed.expected[0]!;
    const within = grade(posed.expected, JSON.stringify({ ...exact, [e.key]: e.value + 0.9 * tolerance(e) }));
    expect(within.score).toBe(1);
    const outside = grade(posed.expected, JSON.stringify({ ...exact, [e.key]: e.value + 1.1 * tolerance(e) }));
    expect(outside.score).toBeCloseTo(2 / 3, 12);
    expect(outside.answers.find((a) => a.key === e.key)).toMatchObject({ ok: false, got: e.value + 1.1 * tolerance(e) });
  });

  test("only plain numbers count: strings, missing keys and wrong shapes score nothing, and say why", () => {
    const strings = grade(posed.expected, JSON.stringify(Object.fromEntries(Object.entries(exact).map(([k, v]) => [k, String(v)]))));
    expect(strings.score).toBe(0);
    expect(strings.note).toMatch(/missing or not a number/);
    const partial = grade(posed.expected, JSON.stringify({ [posed.expected[0]!.key]: posed.expected[0]!.value }));
    expect(partial.score).toBeCloseTo(1 / 3, 12);
    expect(grade(posed.expected, "[1, 2, 3]").note).toBe("answer.json isn't a JSON object");
    expect(grade(posed.expected, "not json").score).toBe(0);
    expect(grade(posed.expected, null).note).toBe("no /work/out/answer.json");
  });

  test("answers nested under \"answers\" are read too", () => {
    expect(readAnswers(JSON.stringify({ answers: { a: 1 }, notes: "x" }))).toEqual({ a: 1 });
    expect(grade(posed.expected, JSON.stringify({ answers: exact })).score).toBe(1);
  });

  test("what the grader records is what every replica accepts", () => {
    for (const text of [JSON.stringify(exact), "{}", null]) {
      const g = grade(posed.expected, text);
      expect(trialProblem({ status: "scored", score: g.score, answers: g.answers })).toBeNull();
    }
  });
});

describe("the Galahad Index", () => {
  test("the mean, with a bootstrap interval that's the same every time", () => {
    const scores = [1, 1, 0.75, 1, 0, 0.5, 1, 1, 0.667, 1, 1, 0.25, 1, 1];
    const index = galahadIndex(scores);
    expect(index.mean).toBeCloseTo(scores.reduce((a, b) => a + b) / scores.length, 12);
    expect(index.low).toBeLessThan(index.mean);
    expect(index.high).toBeGreaterThan(index.mean);
    expect(galahadIndex(scores)).toEqual(index);
    expect(galahadIndex([1, 1, 1])).toEqual({ mean: 1, low: 1, high: 1, n: 3 });
    expect(galahadIndex([0.5])).toEqual({ mean: 0.5, low: 0.5, high: 0.5, n: 1 });
    expect(galahadIndex([]).n).toBe(0);
  });
});
