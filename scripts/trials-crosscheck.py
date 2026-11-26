#!/usr/bin/env python3
"""Check the trial suite's exact answers by independent methods, in the Lab.

    bun scripts/trials-cases.ts 25 > cases.json
    docker run --rm -i -v "$PWD/scripts:/s:ro" galahad/lab:1 python3 /s/trials-crosscheck.py < cases.json

Each problem is re-solved a different way from packages/brain/src/trial-suite.ts:
beam finite elements, generalized eigenproblems, ODE integration, a PDE solve by
the method of lines, double Fourier series, Lambert W, and a CAD kernel. The lid-driven
cavity is checked separately (it needs a CFD study, not a formula). Exit 1 if any
answer differs by more than a tenth of its trial tolerance (or 1e-4 relative).
"""
import json
import math
import sys

import numpy as np
from scipy import linalg, optimize, special
from scipy.integrate import solve_ivp

G0 = 9.80665
DEG = math.pi / 180


# ---------- Euler–Bernoulli beam finite elements (Hermite cubics) ----------

def beam_matrices(n, length, EI, rhoA=0.0, P=0.0):
    le = length / n
    k = EI / le**3 * np.array([[12, 6 * le, -12, 6 * le], [6 * le, 4 * le**2, -6 * le, 2 * le**2], [-12, -6 * le, 12, -6 * le], [6 * le, 2 * le**2, -6 * le, 4 * le**2]])
    m = rhoA * le / 420 * np.array([[156, 22 * le, 54, -13 * le], [22 * le, 4 * le**2, 13 * le, -3 * le**2], [54, 13 * le, 156, -22 * le], [-13 * le, -3 * le**2, -22 * le, 4 * le**2]])
    g = P / (30 * le) * np.array([[36, 3 * le, -36, 3 * le], [3 * le, 4 * le**2, -3 * le, -le**2], [-36, -3 * le, 36, -3 * le], [3 * le, -le**2, -3 * le, 4 * le**2]])
    size = 2 * (n + 1)
    K, M, Kg = (np.zeros((size, size)) for _ in range(3))
    for e in range(n):
        idx = np.arange(2 * e, 2 * e + 4)
        K[np.ix_(idx, idx)] += k
        M[np.ix_(idx, idx)] += m
        Kg[np.ix_(idx, idx)] += g
    return K, M, Kg, le


def cantilever(p):
    b, h, L, P = p["b"] * 1e-3, p["h"] * 1e-3, p["L"], p["P"]
    E, I = 200e9, b * h**3 / 12
    n = 60
    K, M, _, _ = beam_matrices(n, L, E * I, rhoA=7850 * b * h)
    free = np.arange(2, 2 * (n + 1))  # clamped at node 0
    f = np.zeros(2 * (n + 1))
    f[-2] = P
    u = np.zeros_like(f)
    u[free] = linalg.solve(K[np.ix_(free, free)], f[free])
    w2 = linalg.eigh(K[np.ix_(free, free)], M[np.ix_(free, free)], eigvals_only=True, subset_by_index=[0, 0])[0]
    return {"tip_deflection_mm": u[-2] * 1e3, "max_bending_stress_mpa": P * L * h / 2 / I / 1e6, "f1_hz": math.sqrt(w2) / (2 * math.pi)}


def column(p):
    D = p["D"] * 1e-3
    d = D - 2 * p["t"] * 1e-3
    EI = p["E"] * 1e9 * math.pi / 64 * (D**4 - d**4)
    L, n = p["L"], 400
    K, _, Kg, le = beam_matrices(n, L, EI, P=1.0)
    fixed = {0, 1, 2 * n}  # base clamped (w, θ), top pinned (w)
    free = np.array([i for i in range(2 * (n + 1)) if i not in fixed])
    vals, vecs = linalg.eigh(K[np.ix_(free, free)], Kg[np.ix_(free, free)], subset_by_index=[0, 0])
    pcr = vals[0]
    u = np.zeros(2 * (n + 1))
    u[free] = vecs[:, 0]
    # Largest |w| along the Hermite interpolant.
    best, xbest = 0.0, 0.0
    s = np.linspace(0, 1, 201)
    N = np.stack([1 - 3 * s**2 + 2 * s**3, le * (s - 2 * s**2 + s**3), 3 * s**2 - 2 * s**3, le * (-(s**2) + s**3)])
    for e in range(n):
        w = N.T @ u[2 * e : 2 * e + 4]
        i = int(np.argmax(np.abs(w)))
        if abs(w[i]) > best:
            best, xbest = abs(w[i]), (e + s[i]) * le
    return {"p_cr_kn": pcr / 1e3, "k_eff": math.pi * math.sqrt(EI / pcr) / L, "x_max_m": xbest}


def two_span(p):
    L1, L2, w = p["L1"], p["L2"], p["w"]
    n1, n2 = 200, 200
    L = L1 + L2
    # Nodes at a uniform spacing per span; assemble by hand (spans differ in length).
    xs = np.concatenate([np.linspace(0, L1, n1 + 1), np.linspace(L1, L, n2 + 1)[1:]])
    size = 2 * len(xs)
    K = np.zeros((size, size))
    f = np.zeros(size)
    for e in range(len(xs) - 1):
        le = xs[e + 1] - xs[e]
        k = 1.0 / le**3 * np.array([[12, 6 * le, -12, 6 * le], [6 * le, 4 * le**2, -6 * le, 2 * le**2], [-12, -6 * le, 12, -6 * le], [6 * le, 2 * le**2, -6 * le, 4 * le**2]])
        fe = -w * np.array([le / 2, le**2 / 12, le / 2, -(le**2) / 12])
        idx = np.arange(2 * e, 2 * e + 4)
        K[np.ix_(idx, idx)] += k
        f[idx] += fe
    supports = [0, 2 * n1, 2 * (len(xs) - 1)]
    free = np.array([i for i in range(size) if i not in supports])
    u = np.zeros(size)
    u[free] = linalg.solve(K[np.ix_(free, free)], f[free])
    R = K @ u - f
    RA, RB = R[supports[0]], R[supports[1]]
    x = np.linspace(0, L1, 200001)
    M = RA * x - w * x**2 / 2
    MB = abs(RA * L1 - w * L1**2 / 2)
    return {"r_a_kn": RA, "r_b_kn": RB, "m_b_knm": MB, "m_span_ab_knm": M.max()}


def torsion(p):
    # Prandtl stress function, −∇²φ = 2 on [0,b]×[0,h], by its double sine series
    # (Timoshenko & Goodier's single series is what the suite uses).
    b, h, T, Lbar = p["b"] * 1e-3, p["h"] * 1e-3, p["T"], p["Lbar"]
    m = np.arange(1, 400, 2)[:, None].astype(float)
    nn = np.arange(1, 100001, 2)[None, :].astype(float)
    lam = math.pi**2 * (m**2 / b**2 + nn**2 / h**2)
    J = float(np.sum(256 * b * h / (math.pi**4 * m**2 * nn**2 * lam)))
    # ∂φ/∂y at (b/2, 0), the midpoint of a long side; the n-tail ~ Σ 1/n² is added analytically.
    terms = 32 * np.sin(m * math.pi / 2) / (math.pi * h * m * lam)
    N = nn[0, -1]
    tail = (32 * h / (math.pi**3 * m[:, 0])) * np.sin(m[:, 0] * math.pi / 2) * (1 / (2 * (N + 1)))
    dphi = float(np.sum(terms) + np.sum(tail))
    G = 79.3e9
    theta_prime = T / (G * J)
    return {"j_mm4": J * 1e12, "tau_max_mpa": G * theta_prime * dphi / 1e6, "twist_deg": theta_prime * Lbar / DEG}


def two_mass(p):
    k1, k2, k3 = p["k1"] * 1e3, p["k2"] * 1e3, p["k3"] * 1e3
    K = np.array([[k1 + k2, -k2], [-k2, k2 + k3]])
    M = np.diag([p["m1"], p["m2"]])
    vals, vecs = linalg.eigh(K, M)
    return {
        "f1_hz": math.sqrt(vals[0]) / (2 * math.pi),
        "f2_hz": math.sqrt(vals[1]) / (2 * math.pi),
        "ratio_1": vecs[1, 0] / vecs[0, 0],
        "ratio_2": vecs[1, 1] / vecs[0, 1],
    }


def rlc(p):
    R, L, C, V = p["R"], p["L"] * 1e-3, p["C"] * 1e-6, p["V"]
    # States: capacitor voltage and current. L di/dt = V − Ri − vc; C dvc/dt = i.
    def f(t, y):
        vc, i = y
        return [i / C, (V - R * i - vc) / L]

    t1 = p["t1"] * 1e-6
    peak = lambda t, y: y[1]  # the current changes sign at the voltage's peak
    peak.direction = -1
    sol = solve_ivp(f, (0, max(t1, 0.05)), [0.0, 0.0], method="DOP853", rtol=1e-12, atol=1e-14, events=peak, dense_output=True)
    tp = sol.t_events[0][0]
    return {"zeta": R / 2 * math.sqrt(C / L), "t_peak_us": tp * 1e6, "v_peak_v": sol.sol(tp)[0], "v_c_at_t1_v": sol.sol(t1)[0]}


def diode(p):
    vt = 1.380649e-23 * p["T"] / 1.602176634e-19
    Is, n, R, V = p["Is"] * 1e-15, p["n"], p["R"], p["V"]
    a = n * vt
    # Closed form by Lambert W, in log space: w + ln w = ln(Is·R/a) + (V + Is·R)/a.
    z = math.log(Is * R / a) + (V + Is * R) / a
    w = float(np.real(special.lambertw(math.exp(z)))) if z < 700 else optimize.brentq(lambda w: w + math.log(w) - z, 1e-300, z)
    i = a / R * w - Is
    vd = V - i * R
    return {"i_ma": i * 1e3, "v_d_v": vd, "p_diode_mw": vd * i * 1e3}


def hohmann(p):
    mu, re = 398600.4418, 6378.137
    r1, r2 = re + p["h1"], re + p["h2"]
    # Fly the transfer ellipse numerically from periapsis to apoapsis.
    vp = math.sqrt(mu * (2 / r1 - 2 / (r1 + r2)))
    def f(t, y):
        r = math.hypot(y[0], y[1])
        return [y[2], y[3], -mu * y[0] / r**3, -mu * y[1] / r**3]
    apo = lambda t, y: y[0] * y[2] + y[1] * y[3]  # r·v = 0
    apo.direction = -1
    sol = solve_ivp(f, (0, 1e7), [r1, 0, 0, vp], method="DOP853", rtol=1e-12, atol=1e-9, events=apo)
    t_apo, ya = sol.t_events[0][0], sol.y_events[0][0]
    v_apo = np.array([ya[2], ya[3], 0.0])
    r_hat = -np.array([ya[0], ya[1], 0.0]) / math.hypot(ya[0], ya[1])
    along = v_apo / np.linalg.norm(v_apo)
    normal = np.cross(r_hat, along)
    vc = math.sqrt(mu / r2)
    target = vc * (math.cos(p["di"] * DEG) * along + math.sin(p["di"] * DEG) * normal)
    dv1 = vp - math.sqrt(mu / r1)
    dv2 = float(np.linalg.norm(target - v_apo))
    return {"dv1_ms": dv1 * 1e3, "dv2_ms": dv2 * 1e3, "dv_total_ms": (dv1 + dv2) * 1e3, "tof_min": t_apo / 60}


def brayton(p):
    cp, gamma = 1.005, 1.4
    Rgas = cp * (gamma - 1) / gamma
    T1, rp, T3 = p["T1"], p["rp"], p["T3"]
    # Isentropic states from the entropy balance, solved numerically.
    T2s = optimize.brentq(lambda T: cp * math.log(T / T1) - Rgas * math.log(rp), T1, 10 * T1)
    T4s = optimize.brentq(lambda T: cp * math.log(T / T3) + Rgas * math.log(rp), 1, T3)
    h2 = cp * T1 + cp * (T2s - T1) / p["etaC"]
    h4 = cp * T3 - p["etaT"] * cp * (T3 - T4s)
    T2, T4 = h2 / cp, h4 / cp
    q_regen = p["eps"] * cp * (T4 - T2)
    wc, wt = h2 - cp * T1, cp * T3 - h4
    qin = cp * T3 - (h2 + q_regen)
    return {"w_net_kj_kg": wt - wc, "eta_th": (wt - wc) / qin, "back_work_ratio": wc / wt, "t_exhaust_k": (h4 - q_regen) / cp}


def plate_quench(p):
    # Method of lines on the half-thickness: symmetry at x = 0, convection at x = L.
    L, k, c, hc = p["L"] * 1e-3, p["k"], p["c"], p["h"]
    alpha = k / (7800 * c)
    N = 1601
    x = np.linspace(0, L, N)
    dx = x[1] - x[0]
    Bi_dx = hc * dx / k

    def f(t, th):
        g = np.empty(N + 2)
        g[1:-1] = th
        g[0] = th[1]  # symmetry
        g[-1] = th[-2] - 2 * Bi_dx * th[-1]  # −k ∂θ/∂x = h θ, by a ghost node
        return alpha * (g[2:] - 2 * th + g[:-2]) / dx**2

    from scipy.sparse import diags
    jac = diags([np.ones(N - 1), -2 * np.ones(N), np.ones(N - 1)], [-1, 0, 1]).tolil()
    jac[0, 1] = 2
    jac[N - 1, N - 2] = 2
    jac[N - 1, N - 1] = -2 - 2 * Bi_dx
    jac = (alpha / dx**2) * jac.tocsr()
    sol = solve_ivp(f, (0, p["t"]), np.ones(N), method="BDF", jac=jac, rtol=1e-10, atol=1e-12)
    th = sol.y[:, -1]
    span = p["Ti"] - p["Tinf"]
    mean = getattr(np, "trapezoid", getattr(np, "trapz", None))(th, x) / L
    return {"t_center_c": p["Tinf"] + th[0] * span, "t_surface_c": p["Tinf"] + th[-1] * span, "q_fraction": 1 - mean}


def pendulum(p):
    l, th0 = p["l"], p["theta0"] * DEG
    down = lambda t, y: y[0]
    down.direction = -1
    down.terminal = True
    sol = solve_ivp(lambda t, y: [y[1], -G0 / l * math.sin(y[0])], (0, 100), [th0, 0.0], method="DOP853", rtol=1e-13, atol=1e-14, events=down)
    quarter, omega = sol.t_events[0][0], abs(sol.y_events[0][0][1])
    v = omega * l
    return {"period_s": 4 * quarter, "v_max_ms": v, "rod_force_max_n": p["m"] * (G0 + v**2 / l)}


def projectile(p):
    k = 1.225 * p["cd"] * math.pi * (p["d"] / 200) ** 2 / (2 * p["m"])

    def f(t, y):
        v = math.hypot(y[2], y[3])
        return [y[2], y[3], -k * v * y[2], -G0 - k * v * y[3]]

    land = lambda t, y: y[1]
    land.direction = -1
    land.terminal = True
    apex = lambda t, y: y[3]
    apex.direction = -1
    a = p["angle"] * DEG
    sol = solve_ivp(f, (0, 100), [0, 0, p["v0"] * math.cos(a), p["v0"] * math.sin(a)], method="DOP853", rtol=1e-13, atol=1e-12, events=[land, apex])
    end = sol.y_events[0][0]
    return {"range_m": end[0], "time_s": sol.t_events[0][0], "h_max_m": sol.y_events[1][0][1], "v_impact_ms": math.hypot(end[2], end[3])}


def oblique_plate(p):
    from build123d import Axis, Box, Cylinder

    plate = Box(p["W"], p["D"], p["t"])
    drill = Cylinder(p["d"] / 2, 4 * p["t"] + 2 * p["W"]).rotate(Axis.Y, p["theta"])
    part = plate - drill
    return {"volume_cm3": part.volume / 1e3, "mass_kg": part.volume * 1e-9 * 7850, "area_cm2": part.area / 100}


CHECKS = {
    "cantilever-beam": cantilever,
    "fixed-pinned-column": column,
    "two-span-beam": two_span,
    "rectangular-torsion": torsion,
    "two-mass-oscillator": two_mass,
    "rlc-step": rlc,
    "diode-resistor": diode,
    "hohmann-plane-change": hohmann,
    "regenerative-brayton": brayton,
    "plate-quench": plate_quench,
    "large-amplitude-pendulum": pendulum,
    "drag-projectile": projectile,
    "oblique-hole-plate": oblique_plate,
}

# What each independent method can resolve (relative); the trial tolerances are wider.
RESOLUTION = {"x_max_m": 2e-5, "tau_max_mpa": 1e-4, "q_fraction": 1e-4}


def main():
    cases = json.load(sys.stdin)
    worst = {}
    failures = 0
    for case in cases:
        check = CHECKS.get(case["problem"])
        if not check:
            continue
        got = check(case["params"])
        for key, exact in case["expected"].items():
            diff = abs(got[key] - exact) / max(abs(exact), 1e-12)
            allowed = RESOLUTION.get(key, 2e-6)
            name = f'{case["problem"]}.{key}'
            worst[name] = max(worst.get(name, 0.0), diff)
            if diff > allowed:
                failures += 1
                print(f'MISMATCH {name} seed {case["seed"]}: suite {exact!r}, independent {got[key]!r} (rel {diff:.2e})')
    for name, diff in sorted(worst.items()):
        print(f"  {name:48s} worst relative difference {diff:.1e}")
    print(f"{len(cases)} cases, {failures} mismatches")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
