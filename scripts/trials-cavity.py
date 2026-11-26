#!/usr/bin/env python3
"""The lid-driven cavity trial's reference values, computed in the Lab.

    docker run --rm -v "$PWD/scripts:/s:ro" galahad/lab:1 python3 /s/trials-cavity.py

Steady Navier–Stokes at Re = 100 with Taylor–Hood (P2/P1) elements on crossed
meshes of increasing size, Newton with Reynolds continuation and a direct solver;
the stream function from −∇²ψ = ω (P3, ψ = 0 on the walls). Prints each mesh's
values and their Richardson extrapolation, which is what the suite records.
"""
import numpy as np
import ufl
from basix.ufl import element, mixed_element
from dolfinx import fem, geometry, mesh
from dolfinx.fem.petsc import LinearProblem, NonlinearProblem
from dolfinx.nls.petsc import NewtonSolver
from mpi4py import MPI
from petsc4py import PETSc
from scipy import optimize


def solve(n):
    msh = mesh.create_unit_square(MPI.COMM_WORLD, n, n, mesh.CellType.triangle, diagonal=mesh.DiagonalType.crossed)
    W = fem.functionspace(msh, mixed_element([element("Lagrange", msh.basix_cell(), 2, shape=(2,)), element("Lagrange", msh.basix_cell(), 1)]))
    V, _ = W.sub(0).collapse()
    Q, _ = W.sub(1).collapse()
    lid, zero, p0 = fem.Function(V), fem.Function(V), fem.Function(Q)
    lid.interpolate(lambda x: np.vstack((np.ones(x.shape[1]), np.zeros(x.shape[1]))))
    walls = lambda x: np.isclose(x[0], 0) | np.isclose(x[0], 1) | np.isclose(x[1], 0)
    top = lambda x: np.isclose(x[1], 1) & (x[0] > 1e-12) & (x[0] < 1 - 1e-12)
    bcs = [
        fem.dirichletbc(zero, fem.locate_dofs_geometrical((W.sub(0), V), walls), W.sub(0)),
        fem.dirichletbc(lid, fem.locate_dofs_geometrical((W.sub(0), V), top), W.sub(0)),
        fem.dirichletbc(p0, fem.locate_dofs_geometrical((W.sub(1), Q), lambda x: np.isclose(x[0], 0) & np.isclose(x[1], 0)), W.sub(1)),
    ]
    w = fem.Function(W)
    u, p = ufl.split(w)
    v, q = ufl.TestFunctions(W)
    nu = fem.Constant(msh, PETSc.ScalarType(1.0))
    F = (nu * ufl.inner(ufl.grad(u), ufl.grad(v)) + ufl.inner(ufl.grad(u) * u, v) - p * ufl.div(v) + q * ufl.div(u)) * ufl.dx
    problem = NonlinearProblem(F, w, bcs=bcs)
    solver = NewtonSolver(MPI.COMM_WORLD, problem)
    solver.rtol, solver.atol, solver.max_it = 1e-12, 1e-13, 50
    ksp = solver.krylov_solver
    opts = PETSc.Options()
    prefix = ksp.getOptionsPrefix()
    opts[f"{prefix}ksp_type"] = "preonly"
    opts[f"{prefix}pc_type"] = "lu"
    opts[f"{prefix}pc_factor_mat_solver_type"] = "mumps"
    ksp.setFromOptions()
    for Re in (10, 40, 100):
        nu.value = 1.0 / Re
        solver.solve(w)
    uh = w.sub(0).collapse()

    # Stream function: ∫∇ψ·∇φ = ∫(u ∂φ/∂y − v ∂φ/∂x), ψ = 0 on the boundary.
    S = fem.functionspace(msh, ("Lagrange", 3))
    psi, phi = ufl.TrialFunction(S), ufl.TestFunction(S)
    msh.topology.create_connectivity(1, 2)
    bdofs = fem.locate_dofs_topological(S, 1, mesh.exterior_facet_indices(msh.topology))
    a = ufl.inner(ufl.grad(psi), ufl.grad(phi)) * ufl.dx
    L = (uh[0] * phi.dx(1) - uh[1] * phi.dx(0)) * ufl.dx
    psih = LinearProblem(a, L, bcs=[fem.dirichletbc(PETSc.ScalarType(0), bdofs, S)], petsc_options={"ksp_type": "preonly", "pc_type": "lu", "pc_factor_mat_solver_type": "mumps"}).solve()

    tree = geometry.bb_tree(msh, msh.topology.dim)

    def at(f, pts):
        pts = np.atleast_2d(pts)
        pts = np.hstack([pts, np.zeros((len(pts), 1))])
        coll = geometry.compute_colliding_cells(msh, geometry.compute_collisions_points(tree, pts), pts)
        cells = np.array([coll.links(i)[0] for i in range(len(pts))], dtype=np.int32)
        return np.reshape(f.eval(pts, cells), (len(pts), -1))

    def extremum(fun, lo, hi, sign):
        xs = np.linspace(lo, hi, 2001)
        vals = sign * fun(xs)
        i = int(np.argmin(vals))
        r = optimize.minimize_scalar(lambda s: sign * fun(np.array([s]))[0], bounds=(xs[max(i - 2, 0)], xs[min(i + 2, len(xs) - 1)]), method="bounded", options={"xatol": 1e-10})
        return r.x, sign * r.fun

    u_on = lambda ys: at(uh, np.column_stack([np.full_like(ys, 0.5), ys]))[:, 0]
    v_on = lambda xs: at(uh, np.column_stack([xs, np.full_like(xs, 0.5)]))[:, 1]
    y_umin, u_min = extremum(u_on, 0.2, 0.8, 1)
    _, v_max = extremum(v_on, 0.05, 0.5, -1)
    _, v_min = extremum(v_on, 0.5, 0.95, 1)
    gx, gy = np.meshgrid(np.linspace(0.5, 0.75, 101), np.linspace(0.6, 0.85, 101))
    grid = at(psih, np.column_stack([gx.ravel(), gy.ravel()]))[:, 0]
    start = np.array([gx.ravel()[np.argmin(grid)], gy.ravel()[np.argmin(grid)]])
    r = optimize.minimize(lambda z: at(psih, z)[0, 0], start, method="Nelder-Mead", options={"xatol": 1e-9, "fatol": 1e-13})
    return {"u_min": u_min, "y_u_min": y_umin, "v_max": v_max, "v_min": v_min, "psi_min_abs": -r.fun, "x_vortex": r.x[0], "y_vortex": r.x[1]}


results = {}
for n in (32, 64, 128):
    results[n] = solve(n)
    print(n, {k: round(float(v), 7) for k, v in results[n].items()}, flush=True)
# Richardson with the observed order from the three meshes (fallback: order 2).
for key in results[32]:
    a, b, c = (float(results[n][key]) for n in (32, 64, 128))
    ratio = (b - a) / (c - b) if c != b else 0.0
    order = np.log2(ratio) if ratio > 1 else 2.0
    print(f"{key:12s} 128: {c:.7f}  extrapolated: {c + (c - b) / (2**order - 1):.7f}  observed order {order:.2f}")
