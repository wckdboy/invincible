import { pick, type TrialProblem, until } from "./trials.ts";

/*
 * The engineering suite: fourteen problems across structures, civil, mechanical,
 * electrical, aerospace, fluids, thermal, physics and geometry. Each exact solution
 * below is closed-form or computed here to machine precision, and each was checked
 * against an independent solution in the Lab for 25 random draws (scripts/trials-crosscheck.py:
 * beam FEM, eigensolvers, ODE integration, a PDE by the method of lines, double Fourier
 * series, Lambert W, a CAD kernel; worst disagreement 1.5e-5, against tolerances of 1e-3 and up).
 * Tolerances are tight enough that a rule of thumb fails where it should
 * (K = 0.7 for a fixed–pinned column, a small-angle pendulum) and loose enough
 * that a sound numerical method passes.
 */

const { PI, sqrt, sin, cos, tan, atan, exp, abs, cosh, tanh } = Math;
const G0 = 9.80665;
const DEG = PI / 180;

/** Root of an increasing function on [lo, hi], by bisection to the last bit. */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Complete elliptic integral of the first kind, K(k), by the arithmetic–geometric mean. */
export function ellipticK(k: number): number {
  let a = 1;
  let b = sqrt(1 - k * k);
  for (let i = 0; i < 60 && abs(a - b) > 1e-16 * a; i++) [a, b] = [(a + b) / 2, sqrt(a * b)];
  return PI / (2 * a);
}

/* ---------- structures ---------- */

const cantilever: TrialProblem<{ L: number; b: number; h: number; P: number }> = {
  id: "cantilever-beam",
  title: "Cantilever: deflection, stress and first mode",
  domain: "structures",
  params: (rng) =>
    until(
      rng,
      (r) => ({ L: pick(r, 1, 3, 0.1), b: pick(r, 40, 100, 10), h: pick(r, 8, 30, 2), P: pick(r, 20, 200, 5) }),
      (p) => {
        const I = (p.b * 1e-3 * (p.h * 1e-3) ** 3) / 12;
        return (p.P * p.L ** 3) / (3 * 200e9 * I) < 0.04 * p.L; // small deflections
      },
    ),
  statement: (p) =>
    `A steel cantilever of length ${p.L} m is clamped at one end and carries a point load of ${p.P} N at its free end, perpendicular to its axis. ` +
    `Its solid rectangular cross-section is ${p.b} mm wide and ${p.h} mm deep, and the load acts along the depth. E = 200 GPa, density 7850 kg/m³. ` +
    "Model it as a slender Euler–Bernoulli beam with small deflections (no shear deformation or rotary inertia; ignore self-weight in the static case).",
  solve: (p) => {
    const b = p.b * 1e-3;
    const h = p.h * 1e-3;
    const I = (b * h ** 3) / 12;
    const E = 200e9;
    const beta = 1.875104068711961; // first root of 1 + cos x cosh x = 0
    return [
      { key: "tip_deflection_mm", what: "the static tip deflection under the load", units: "mm", value: ((p.P * p.L ** 3) / (3 * E * I)) * 1e3, rel: 0.005 },
      { key: "max_bending_stress_mpa", what: "the largest bending stress under the load", units: "MPa", value: (p.P * p.L * (h / 2)) / I / 1e6, rel: 0.005 },
      {
        key: "f1_hz",
        what: "the first natural frequency of free bending vibration in the plane of the load, with the load removed (the beam's own mass only)",
        units: "Hz",
        value: ((beta ** 2) / (2 * PI)) * sqrt((E * I) / (7850 * b * h * p.L ** 4)),
        rel: 0.005,
      },
    ];
  },
};

const column: TrialProblem<{ L: number; D: number; t: number; E: number }> = {
  id: "fixed-pinned-column",
  title: "Euler buckling of a fixed–pinned tube",
  domain: "structures",
  params: (rng) =>
    until(
      rng,
      (r) => ({ L: pick(r, 2, 6, 0.25), D: pick(r, 40, 120, 5), t: pick(r, 2, 6, 0.5), E: pick(r, 195, 210, 5) }),
      (p) => p.t <= p.D / 8,
    ),
  statement: (p) =>
    `A straight steel column ${p.L} m long is a hollow circular tube, ${p.D} mm outside diameter with a ${p.t} mm wall, E = ${p.E} GPa. ` +
    "Its base is fully fixed (clamped); its top is pinned: free to rotate but held against sideways movement. It carries a centric axial compressive load at the top. " +
    "Treat it as a perfectly straight, linear-elastic Euler column (no imperfections, yielding or shear deformation).",
  solve: (p) => {
    const kL = 4.493409457909064; // first positive root of tan x = x
    const D = p.D * 1e-3;
    const d = D - 2 * p.t * 1e-3;
    const I = (PI / 64) * (D ** 4 - d ** 4);
    return [
      { key: "p_cr_kn", what: "the elastic critical (buckling) load", units: "kN", value: (kL ** 2 * p.E * 1e9 * I) / p.L ** 2 / 1e3, rel: 0.001 },
      { key: "k_eff", what: "the exact effective length factor K, with P_cr = π²EI/(KL)²", units: "1", value: PI / kL, abs: 0.0005 },
      {
        key: "x_max_m",
        what: "the distance from the fixed base to the point of largest sideways deflection in the first buckled shape",
        units: "m",
        value: ((2 * atan(kL)) / kL) * p.L,
        rel: 0.001,
      },
    ];
  },
};

/* ---------- civil ---------- */

const continuousBeam: TrialProblem<{ L1: number; L2: number; w: number }> = {
  id: "two-span-beam",
  title: "Two-span continuous beam under uniform load",
  domain: "civil",
  params: (rng) =>
    until(
      rng,
      (r) => ({ L1: pick(r, 3, 8, 0.5), L2: pick(r, 3, 8, 0.5), w: pick(r, 5, 40, 1) }),
      (p) => p.L1 !== p.L2 && p.L2 / p.L1 >= 0.6 && p.L2 / p.L1 <= 1.6,
    ),
  statement: (p) =>
    `A continuous beam ABC has a pinned support at A and roller supports at B and C; span AB is ${p.L1} m and span BC is ${p.L2} m. ` +
    `It carries a uniformly distributed load of ${p.w} kN/m over its whole length (self-weight included). ` +
    "EI is constant, the supports don't settle; linear-elastic, small-deflection beam theory.",
  solve: (p) => {
    // Three-moment equation with M_A = M_C = 0.
    const MB = (p.w * (p.L1 ** 3 + p.L2 ** 3)) / (8 * (p.L1 + p.L2));
    const RA = (p.w * p.L1) / 2 - MB / p.L1;
    const RC = (p.w * p.L2) / 2 - MB / p.L2;
    const RB = p.w * (p.L1 + p.L2) - RA - RC;
    return [
      { key: "r_a_kn", what: "the vertical reaction at A", units: "kN", value: RA, rel: 0.003 },
      { key: "r_b_kn", what: "the vertical reaction at B", units: "kN", value: RB, rel: 0.003 },
      { key: "m_b_knm", what: "the magnitude of the bending moment over support B", units: "kN·m", value: MB, rel: 0.003 },
      { key: "m_span_ab_knm", what: "the largest sagging bending moment in span AB", units: "kN·m", value: RA ** 2 / (2 * p.w), rel: 0.003 },
    ];
  },
};

/* ---------- mechanical ---------- */

const torsion: TrialProblem<{ Lbar: number; b: number; h: number; T: number }> = {
  id: "rectangular-torsion",
  title: "Saint-Venant torsion of a rectangular bar",
  domain: "mechanical",
  params: (rng) =>
    until(
      rng,
      (r) => ({ Lbar: pick(r, 0.5, 2, 0.1), b: pick(r, 20, 120, 5), h: pick(r, 5, 40, 1), T: pick(r, 20, 500, 5) }),
      (p) => p.b >= p.h && p.b / p.h <= 6 && torsionShear(p) < 250e6,
    ),
  statement: (p) =>
    `A straight steel bar ${p.Lbar} m long has a solid rectangular cross-section ${p.b} mm × ${p.h} mm. One end is fixed and a torque of ${p.T} N·m is applied at the other; ` +
    "the ends are free to warp. Shear modulus G = 79.3 GPa; linear elastic.",
  solve: (p) => {
    const J = torsionJ(p.b * 1e-3, p.h * 1e-3);
    return [
      { key: "j_mm4", what: "the torsion constant J (so that T = G·J·θ′)", units: "mm⁴", value: J * 1e12, rel: 0.003 },
      { key: "tau_max_mpa", what: "the maximum shear stress", units: "MPa", value: torsionShear(p) / 1e6, rel: 0.003 },
      { key: "twist_deg", what: "the angle of twist between the ends", units: "degrees", value: ((p.T * p.Lbar) / (79.3e9 * J)) / DEG, rel: 0.003 },
    ];
  },
};

/** Timoshenko & Goodier's series for a b × h rectangle (b ≥ h). */
function torsionJ(b: number, h: number): number {
  let sum = 0;
  for (let n = 1; n < 400; n += 2) sum += tanh((n * PI * b) / (2 * h)) / n ** 5;
  return ((b * h ** 3) / 3) * (1 - (192 / PI ** 5) * (h / b) * sum);
}

function torsionShear(p: { b: number; h: number; T: number }): number {
  const b = p.b * 1e-3;
  const h = p.h * 1e-3;
  let sum = 0;
  for (let n = 1; n < 400; n += 2) sum += 1 / (n ** 2 * cosh((n * PI * b) / (2 * h)));
  const thetaPrimeG = p.T / torsionJ(b, h); // G·θ′
  return thetaPrimeG * h * (1 - (8 / PI ** 2) * sum);
}

const twoMass: TrialProblem<{ m1: number; m2: number; k1: number; k2: number; k3: number }> = {
  id: "two-mass-oscillator",
  title: "Natural frequencies and modes of a two-mass chain",
  domain: "mechanical",
  params: (rng) => ({ m1: pick(rng, 1, 20, 0.5), m2: pick(rng, 1, 20, 0.5), k1: pick(rng, 1, 50, 1), k2: pick(rng, 1, 50, 1), k3: pick(rng, 1, 30, 1) }),
  statement: (p) =>
    `Two masses slide without friction along a horizontal line: m1 = ${p.m1} kg and m2 = ${p.m2} kg. ` +
    `A spring k1 = ${p.k1} kN/m joins a fixed wall to m1, a spring k2 = ${p.k2} kN/m joins m1 to m2, and a spring k3 = ${p.k3} kN/m joins m2 to a second fixed wall. ` +
    "Linear springs, no damping; motion along the line only.",
  solve: (p) => {
    const [k1, k2, k3] = [p.k1 * 1e3, p.k2 * 1e3, p.k3 * 1e3];
    const a = p.m1 * p.m2;
    const b = -(p.m1 * (k2 + k3) + p.m2 * (k1 + k2));
    const c = (k1 + k2) * (k2 + k3) - k2 ** 2;
    const disc = sqrt(b * b - 4 * a * c);
    const w1sq = (2 * c) / (-b + disc); // the smaller root, without cancellation
    const w2sq = (-b + disc) / (2 * a);
    const ratio = (w2: number) => (k1 + k2 - w2 * p.m1) / k2;
    return [
      { key: "f1_hz", what: "the lower natural frequency", units: "Hz", value: sqrt(w1sq) / (2 * PI), rel: 0.002 },
      { key: "f2_hz", what: "the higher natural frequency", units: "Hz", value: sqrt(w2sq) / (2 * PI), rel: 0.002 },
      { key: "ratio_1", what: "the amplitude ratio X2/X1 in the lower mode", units: "1", value: ratio(w1sq), rel: 0.002 },
      { key: "ratio_2", what: "the amplitude ratio X2/X1 in the higher mode (with its sign)", units: "1", value: ratio(w2sq), rel: 0.002 },
    ];
  },
};

/* ---------- electrical ---------- */

const rlc: TrialProblem<{ R: number; L: number; C: number; V: number; t1: number }> = {
  id: "rlc-step",
  title: "Step response of a series RLC circuit",
  domain: "electrical",
  params: (rng) =>
    until(
      rng,
      (r) => {
        const p = { R: pick(r, 2, 40, 1), L: pick(r, 1, 20, 0.5), C: pick(r, 1, 50, 1), V: pick(r, 5, 48, 1), t1: 0 };
        const { tp } = rlcShape(p);
        return { ...p, t1: Math.round(2.3 * tp * 1e6) };
      },
      (p) => {
        const zeta = rlcShape(p).zeta;
        return zeta >= 0.05 && zeta <= 0.7;
      },
    ),
  statement: (p) =>
    `A series RLC circuit (R = ${p.R} Ω, L = ${p.L} mH, C = ${p.C} µF), with the capacitor uncharged and no current flowing, ` +
    `is connected to an ideal ${p.V} V DC source at t = 0. Ideal components.`,
  solve: (p) => {
    const { alpha, wd, zeta, tp } = rlcShape(p);
    const vc = (t: number) => p.V * (1 - exp(-alpha * t) * (cos(wd * t) + (alpha / wd) * sin(wd * t)));
    return [
      { key: "zeta", what: "the damping ratio", units: "1", value: zeta, rel: 0.003 },
      { key: "t_peak_us", what: "the time of the first peak of the capacitor voltage", units: "µs", value: tp * 1e6, rel: 0.003 },
      { key: "v_peak_v", what: "the capacitor voltage at that peak", units: "V", value: vc(tp), rel: 0.002 },
      { key: "v_c_at_t1_v", what: `the capacitor voltage at t = ${p.t1} µs`, units: "V", value: vc(p.t1 * 1e-6), abs: 0.002 * p.V },
    ];
  },
};

function rlcShape(p: { R: number; L: number; C: number }) {
  const L = p.L * 1e-3;
  const C = p.C * 1e-6;
  const alpha = p.R / (2 * L);
  const w0 = 1 / sqrt(L * C);
  const wd = sqrt(Math.max(w0 ** 2 - alpha ** 2, 0));
  return { alpha, wd, zeta: alpha / w0, tp: PI / wd };
}

const diode: TrialProblem<{ V: number; R: number; Is: number; n: number; T: number }> = {
  id: "diode-resistor",
  title: "Operating point of a diode and resistor",
  domain: "electrical",
  params: (rng) => ({ V: pick(rng, 1, 12, 0.5), R: pick(rng, 100, 10000, 50), Is: pick(rng, 1, 100, 1), n: pick(rng, 1, 2, 0.05), T: pick(rng, 280, 350, 1) }),
  statement: (p) =>
    `A ${p.V} V DC source drives a ${p.R} Ω resistor in series with a forward-biased silicon diode. ` +
    `The diode follows the Shockley equation I = I_S·(exp(V_D/(n·V_T)) − 1) with I_S = ${p.Is} fA and n = ${p.n}, at ${p.T} K ` +
    "(V_T = kT/q, k = 1.380649e-23 J/K, q = 1.602176634e-19 C). The diode has no series resistance.",
  solve: (p) => {
    const vt = (1.380649e-23 * p.T) / 1.602176634e-19;
    const Is = p.Is * 1e-15;
    const vd = bisect((v) => Is * (exp(v / (p.n * vt)) - 1) - (p.V - v) / p.R, 0, p.V);
    const i = (p.V - vd) / p.R;
    return [
      { key: "i_ma", what: "the current", units: "mA", value: i * 1e3, rel: 0.001 },
      { key: "v_d_v", what: "the voltage across the diode", units: "V", value: vd, rel: 0.001 },
      { key: "p_diode_mw", what: "the power dissipated in the diode", units: "mW", value: vd * i * 1e3, rel: 0.001 },
    ];
  },
};

/* ---------- aerospace ---------- */

const MU = 398600.4418; // km³/s²
const RE = 6378.137; // km

const hohmann: TrialProblem<{ h1: number; h2: number; di: number }> = {
  id: "hohmann-plane-change",
  title: "Hohmann transfer with a plane change",
  domain: "aerospace",
  params: (rng) => ({ h1: pick(rng, 200, 800, 10), h2: pick(rng, 2000, 40000, 500), di: pick(rng, 0, 28.5, 0.5) }),
  statement: (p) =>
    `A spacecraft in a circular orbit at ${p.h1} km altitude transfers to a circular orbit at ${p.h2} km altitude whose plane is inclined ${p.di}° to the first. ` +
    "It uses a Hohmann transfer: one impulsive prograde burn to enter the transfer ellipse, then one impulsive burn at its apoapsis that both circularizes and makes the whole plane change. " +
    "Two-body problem; μ = 398600.4418 km³/s²; Earth's radius 6378.137 km (altitudes are above it).",
  solve: (p) => {
    const r1 = RE + p.h1;
    const r2 = RE + p.h2;
    const a = (r1 + r2) / 2;
    const dv1 = sqrt(MU * (2 / r1 - 1 / a)) - sqrt(MU / r1);
    const va = sqrt(MU * (2 / r2 - 1 / a));
    const vc = sqrt(MU / r2);
    const dv2 = sqrt(va ** 2 + vc ** 2 - 2 * va * vc * cos(p.di * DEG));
    return [
      { key: "dv1_ms", what: "the first burn's Δv", units: "m/s", value: dv1 * 1e3, rel: 0.001 },
      { key: "dv2_ms", what: "the second (combined) burn's Δv", units: "m/s", value: dv2 * 1e3, rel: 0.001 },
      { key: "dv_total_ms", what: "the total Δv", units: "m/s", value: (dv1 + dv2) * 1e3, rel: 0.001 },
      { key: "tof_min", what: "the transfer time", units: "minutes", value: (PI * sqrt(a ** 3 / MU)) / 60, rel: 0.001 },
    ];
  },
};

const brayton: TrialProblem<{ T1: number; rp: number; T3: number; etaC: number; etaT: number; eps: number }> = {
  id: "regenerative-brayton",
  title: "Gas turbine cycle with a regenerator",
  domain: "aerospace",
  params: (rng) =>
    until(
      rng,
      (r) => ({ T1: pick(r, 280, 310, 1), rp: pick(r, 4, 12, 0.5), T3: pick(r, 1100, 1500, 10), etaC: pick(r, 0.8, 0.9, 0.01), etaT: pick(r, 0.84, 0.93, 0.01), eps: pick(r, 0.6, 0.9, 0.05) }),
      (p) => {
        const { T2, T4 } = braytonStates(p);
        return T4 > T2 + 20;
      },
    ),
  statement: (p) =>
    `An air-standard gas turbine (Brayton) cycle has a regenerator that heats the compressed air with the turbine exhaust. ` +
    `Compressor inlet ${p.T1} K and 100 kPa; pressure ratio ${p.rp}; turbine inlet ${p.T3} K; isentropic efficiencies ${p.etaC} (compressor) and ${p.etaT} (turbine); ` +
    `regenerator effectiveness ${p.eps}. Air is an ideal gas with constant cp = 1.005 kJ/kg·K and γ = 1.4; no pressure losses.`,
  solve: (p) => {
    const cp = 1.005;
    const { T2, T4 } = braytonStates(p);
    const Tx = T2 + p.eps * (T4 - T2);
    const wc = cp * (T2 - p.T1);
    const wt = cp * (p.T3 - T4);
    return [
      { key: "w_net_kj_kg", what: "the net specific work", units: "kJ/kg", value: wt - wc, rel: 0.003 },
      { key: "eta_th", what: "the thermal efficiency (a fraction, 0 to 1)", units: "1", value: (wt - wc) / (cp * (p.T3 - Tx)), rel: 0.003 },
      { key: "back_work_ratio", what: "compressor work divided by turbine work", units: "1", value: wc / wt, rel: 0.003 },
      { key: "t_exhaust_k", what: "the exhaust temperature after the regenerator", units: "K", value: T4 - (Tx - T2), rel: 0.003 },
    ];
  },
};

function braytonStates(p: { T1: number; rp: number; T3: number; etaC: number; etaT: number }) {
  const x = p.rp ** (0.4 / 1.4);
  return { T2: p.T1 * (1 + (x - 1) / p.etaC), T4: p.T3 * (1 - p.etaT * (1 - 1 / x)) };
}

/* ---------- fluids ---------- */

/*
 * Re = 100 has no closed form. These are grid-converged values computed in the Lab
 * (scripts/trials-cavity.py: Taylor–Hood FEM on 32², 64² and 128² crossed meshes, agreeing
 * to 6 digits); the classic Ghia, Ghia & Shin (1982) table lies within the tolerances.
 * Fixed parameters: what's tested here is running a sound CFD study.
 */
const cavity: TrialProblem<Record<string, never>> = {
  id: "lid-driven-cavity",
  title: "Lid-driven cavity at Re = 100",
  domain: "fluids",
  budget: { maxSteps: 40, commandTimeoutSec: 900 },
  params: () => ({}),
  statement: () =>
    "Steady, incompressible, two-dimensional flow of a Newtonian fluid in the unit square cavity 0 ≤ x, y ≤ 1. " +
    "The top wall (y = 1) slides in the +x direction at speed 1; the other three walls are fixed; no slip everywhere. Reynolds number Re = UL/ν = 100 (U = 1, L = 1). " +
    "Find the converged, grid-independent solution.",
  solve: () => [
    { key: "u_min", what: "the minimum horizontal velocity u on the vertical centreline x = 0.5", units: "1 (in units of U)", value: -0.214042, rel: 0.04 },
    { key: "y_u_min", what: "the y at which that minimum occurs", units: "1 (in units of L)", value: 0.4581, abs: 0.02 },
    { key: "v_max", what: "the maximum vertical velocity v on the horizontal centreline y = 0.5", units: "1 (in units of U)", value: 0.179573, rel: 0.04 },
    { key: "v_min", what: "the minimum vertical velocity v on the horizontal centreline y = 0.5", units: "1 (in units of U)", value: -0.253803, rel: 0.04 },
    { key: "psi_min_abs", what: "the magnitude of the stream function at the primary vortex centre (ψ = 0 on the walls)", units: "1 (in units of UL)", value: 0.103521, rel: 0.03 },
    { key: "x_vortex", what: "the x of the primary vortex centre", units: "1 (in units of L)", value: 0.6157, abs: 0.02 },
    { key: "y_vortex", what: "the y of the primary vortex centre", units: "1 (in units of L)", value: 0.7373, abs: 0.02 },
  ],
};

/* ---------- thermal ---------- */

const wall: TrialProblem<{ L: number; k: number; c: number; h: number; Ti: number; Tinf: number; t: number }> = {
  id: "plate-quench",
  title: "Transient cooling of a thick plate",
  domain: "thermal",
  params: (rng) =>
    until(
      rng,
      (r) => {
        const p = { L: pick(r, 10, 60, 5), k: pick(r, 15, 60, 1), c: pick(r, 430, 500, 10), h: pick(r, 100, 2000, 50), Ti: pick(r, 300, 900, 10), Tinf: pick(r, 15, 40, 1), t: 0 };
        const alpha = p.k / (7800 * p.c);
        return { ...p, t: Math.round((pick(r, 0.1, 0.8, 0.01) * (p.L * 1e-3) ** 2) / alpha) };
      },
      (p) => p.t >= 1,
    ),
  statement: (p) =>
    `A large steel plate ${2 * p.L} mm thick (k = ${p.k} W/m·K, ρ = 7800 kg/m³, c = ${p.c} J/kg·K) is uniformly at ${p.Ti} °C when, at t = 0, ` +
    `both faces are suddenly exposed to a fluid at ${p.Tinf} °C with a heat transfer coefficient of ${p.h} W/m²·K. ` +
    "Treat it as one-dimensional transient conduction with constant properties; no radiation.",
  solve: (p) => {
    const L = p.L * 1e-3;
    const Bi = (p.h * L) / p.k;
    const Fo = ((p.k / (7800 * p.c)) * p.t) / L ** 2;
    let center = 0;
    let surface = 0;
    let remaining = 0;
    for (let n = 1; n <= 80; n++) {
      const z = bisect((x) => x * tan(x) - Bi, (n - 1) * PI + 1e-12, (n - 0.5) * PI - 1e-12);
      const Cn = (4 * sin(z)) / (2 * z + sin(2 * z));
      const decay = exp(-z * z * Fo);
      center += Cn * decay;
      surface += Cn * decay * cos(z);
      remaining += Cn * decay * (sin(z) / z);
    }
    const span = p.Ti - p.Tinf;
    return [
      { key: "t_center_c", what: `the mid-plane temperature at t = ${p.t} s`, units: "°C", value: p.Tinf + center * span, abs: 0.003 * span },
      { key: "t_surface_c", what: `the surface temperature at t = ${p.t} s`, units: "°C", value: p.Tinf + surface * span, abs: 0.003 * span },
      { key: "q_fraction", what: "the fraction of its initial energy relative to the fluid (Q/Q0, 0 to 1) the plate has lost by then", units: "1", value: 1 - remaining, abs: 0.003 },
    ];
  },
};

/* ---------- physics ---------- */

const pendulum: TrialProblem<{ m: number; l: number; theta0: number }> = {
  id: "large-amplitude-pendulum",
  title: "A pendulum released far from vertical",
  domain: "physics",
  params: (rng) => ({ m: pick(rng, 0.1, 5, 0.1), l: pick(rng, 0.3, 3, 0.05), theta0: pick(rng, 60, 175, 1) }),
  statement: (p) =>
    `A point mass of ${p.m} kg on a rigid, massless rod ${p.l} m long swings about a frictionless pivot. It is released from rest at ${p.theta0}° from the downward vertical. ` +
    "g = 9.80665 m/s²; no air resistance.",
  solve: (p) => {
    const th = p.theta0 * DEG;
    return [
      { key: "period_s", what: "the period of the oscillation", units: "s", value: 4 * sqrt(p.l / G0) * ellipticK(sin(th / 2)), rel: 0.0005 },
      { key: "v_max_ms", what: "the mass's greatest speed", units: "m/s", value: sqrt(2 * G0 * p.l * (1 - cos(th))), rel: 0.001 },
      { key: "rod_force_max_n", what: "the greatest tension in the rod", units: "N", value: p.m * G0 * (3 - 2 * cos(th)), rel: 0.001 },
    ];
  },
};

type State = [number, number, number, number]; // x, y, vx, vy

const projectile: TrialProblem<{ m: number; d: number; cd: number; v0: number; angle: number }> = {
  id: "drag-projectile",
  title: "A ball's flight with quadratic drag",
  domain: "physics",
  params: (rng) => ({ m: pick(rng, 0.05, 0.5, 0.005), d: pick(rng, 4, 12, 0.1), cd: pick(rng, 0.25, 0.5, 0.01), v0: pick(rng, 20, 60, 1), angle: pick(rng, 20, 60, 1) }),
  statement: (p) =>
    `A ball of mass ${p.m} kg and diameter ${p.d} cm is launched from flat ground at ${p.v0} m/s, ${p.angle}° above the horizontal. ` +
    `The air (density 1.225 kg/m³) exerts a drag force ½·ρ·C_d·A·v² opposite to the velocity, with C_d = ${p.cd} constant and A the ball's frontal area; ` +
    "no lift, spin or wind; g = 9.80665 m/s².",
  solve: (p) => {
    const k = (1.225 * p.cd * PI * (p.d / 200) ** 2) / (2 * p.m);
    const f = ([, , vx, vy]: State): State => {
      const v = sqrt(vx * vx + vy * vy);
      return [vx, vy, -k * v * vx, -G0 - k * v * vy];
    };
    const step = (s: State, h: number): State => {
      const add = (a: State, b: State, c: number): State => [a[0] + c * b[0], a[1] + c * b[1], a[2] + c * b[2], a[3] + c * b[3]];
      const k1 = f(s);
      const k2 = f(add(s, k1, h / 2));
      const k3 = f(add(s, k2, h / 2));
      const k4 = f(add(s, k3, h));
      return [0, 1, 2, 3].map((i) => s[i]! + (h / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!)) as State;
    };
    // RK4 at 1e-4 s; the apex and the landing are located inside their step by bisection.
    const dt = 1e-4;
    let s: State = [0, 0, p.v0 * cos(p.angle * DEG), p.v0 * sin(p.angle * DEG)];
    let t = 0;
    let hMax = 0;
    for (;;) {
      const next = step(s, dt);
      if (s[3] > 0 && next[3] <= 0) hMax = step(s, bisect((h) => -step(s, h)[3], 0, dt))[1];
      if (t > 0 && next[1] <= 0) {
        const h = bisect((x) => -step(s, x)[1], 0, dt);
        const end = step(s, h);
        return [
          { key: "range_m", what: "the horizontal distance when it returns to ground level", units: "m", value: end[0], rel: 0.002 },
          { key: "time_s", what: "the time of flight", units: "s", value: t + h, rel: 0.002 },
          { key: "h_max_m", what: "the greatest height", units: "m", value: hMax, rel: 0.002 },
          { key: "v_impact_ms", what: "the speed at landing", units: "m/s", value: sqrt(end[2] ** 2 + end[3] ** 2), rel: 0.002 },
        ];
      }
      s = next;
      t += dt;
    }
  },
};

/* ---------- geometry ---------- */

const drilledPlate: TrialProblem<{ W: number; D: number; t: number; d: number; theta: number }> = {
  id: "oblique-hole-plate",
  title: "A plate with an oblique drilled hole",
  domain: "geometry",
  params: (rng) =>
    until(
      rng,
      (r) => ({ W: pick(r, 80, 200, 5), D: pick(r, 60, 150, 5), t: pick(r, 8, 30, 1), d: pick(r, 10, 40, 1), theta: pick(r, 15, 45, 1) }),
      (p) => {
        const th = p.theta * DEG;
        // The bore's ellipses stay well inside both faces.
        return (p.t / 2) * tan(th) + p.d / 2 / cos(th) < p.W / 2 - 5 && p.d / 2 < p.D / 2 - 5;
      },
    ),
  statement: (p) =>
    `A rectangular steel plate is ${p.W} mm long (x), ${p.D} mm wide (y) and ${p.t} mm thick (z). ` +
    `A straight through-hole ${p.d} mm in diameter is drilled along an axis that passes through the plate's centre and is tilted ${p.theta}° from the z axis toward the x axis. ` +
    "Steel density 7850 kg/m³.",
  solve: (p) => {
    const c = cos(p.theta * DEG);
    const r = p.d / 2;
    const volume = p.W * p.D * p.t - (PI * r * r * p.t) / c; // mm³: each z-slice of the bore is an ellipse of area πr²/cos θ
    const area = 2 * (p.W * p.D - (PI * r * r) / c) + 2 * (p.W + p.D) * p.t + (2 * PI * r * p.t) / c; // every generator of the bore is t/cos θ long
    return [
      { key: "volume_cm3", what: "the part's volume", units: "cm³", value: volume / 1e3, rel: 0.001 },
      { key: "mass_kg", what: "its mass", units: "kg", value: (volume * 1e-9 * 7850), rel: 0.001 },
      { key: "area_cm2", what: "its total surface area, all faces including the bore", units: "cm²", value: area / 100, rel: 0.001 },
    ];
  },
};

export const ENGINEERING_SUITE: readonly TrialProblem[] = [
  cantilever,
  column,
  continuousBeam,
  torsion,
  twoMass,
  rlc,
  diode,
  hohmann,
  brayton,
  cavity,
  wall,
  pendulum,
  projectile,
  drilledPlate,
];

export const SUITES: Record<string, readonly TrialProblem[]> = { engineering: ENGINEERING_SUITE };
