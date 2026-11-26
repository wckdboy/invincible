import { describe, expect, test } from "bun:test";
import { galahadIndex, type InvestigationView, type TrialView } from "@galahad/core";
import { byProblem, durationLabel, findingState, groupRuns, markOf, numberLabel, offBy, percent, predictionLines } from "./trials.ts";

const trial = (over: Partial<TrialView> = {}): TrialView => ({
  id: "tr_0000000000000000000000",
  run: "r-1",
  suite: "engineering",
  problem: "rlc-step",
  title: "Step response of a series RLC circuit",
  domain: "electrical",
  seed: 1,
  status: "scored",
  score: 1,
  answers: [{ key: "zeta", units: "1", expected: 0.25, got: 0.25, tolerance: 0.00075, ok: true }],
  models: ["anthropic/claude-opus-5-5"],
  version: "abc1234",
  seconds: 120,
  recordedAt: 1_000_000,
  nodeName: "ultra",
  ...over,
});

describe("trial runs", () => {
  test("grouped by run, newest first; the Index counts scored trials only, with core's interval", () => {
    const runs = groupRuns([
      trial({ id: "tr_a", run: "r-old", recordedAt: 10_000, score: 1 }),
      trial({ id: "tr_b", run: "r-new", recordedAt: 900_000, score: 0.5, answers: [] }),
      trial({ id: "tr_c", run: "r-new", recordedAt: 950_000, score: 1, problem: "diode-resistor", models: ["deepseek/v4"] }),
      trial({ id: "tr_d", run: "r-new", recordedAt: 960_000, status: "crashed", score: 0 }),
    ]);
    expect(runs.map((r) => r.run)).toEqual(["r-new", "r-old"]);
    const latest = runs[0]!;
    expect(latest.trials.map((t) => t.id)).toEqual(["tr_b", "tr_c", "tr_d"]);
    expect(latest.index).toEqual(galahadIndex([0.5, 1]));
    expect({ solved: latest.solved, crashed: latest.crashed }).toEqual({ solved: 1, crashed: 1 });
    expect(latest.models).toEqual(["anthropic/claude-opus-5-5", "deepseek/v4"]);
  });

  test("each problem over every run, in the suite's domain order", () => {
    const problems = byProblem([
      trial({ problem: "rlc-step", score: 1, recordedAt: 1 }),
      trial({ problem: "rlc-step", score: 0.5, recordedAt: 2 }),
      trial({ problem: "cantilever-beam", domain: "structures", title: "Cantilever", score: 0 }),
      trial({ problem: "rlc-step", status: "crashed", score: 0, recordedAt: 3 }),
    ]);
    expect(problems.map((p) => p.problem)).toEqual(["cantilever-beam", "rlc-step"]);
    expect(problems[1]).toMatchObject({ tries: 2, solved: 1, mean: 0.75 });
    expect(problems[1]!.latest.recordedAt).toBe(2);
  });

  test("marks, numbers and distances read plainly", () => {
    expect([trial(), trial({ score: 0.5 }), trial({ score: 0 }), trial({ status: "crashed", score: 0 })].map(markOf)).toEqual(["solved", "partial", "missed", "crashed"]);
    expect(numberLabel(0.1 + 0.2)).toBe("0.3");
    expect(numberLabel(null)).toBe("—");
    expect(percent(0.857)).toBe("86%");
    const answer = { key: "x", units: "m", expected: 100, tolerance: 0.1 };
    expect(offBy({ ...answer, got: 100.05, ok: true })).toBe("within 0.050%");
    expect(offBy({ ...answer, got: 112, ok: false })).toBe("off by 12%");
    expect(offBy({ ...answer, got: 101.5, ok: false })).toBe("off by 1.50%");
    expect(offBy({ ...answer, got: null, ok: false })).toBe("no number given");
    expect(offBy({ ...answer, got: 100, ok: true })).toBe("exact");
    expect(offBy({ ...answer, got: 100.0005, ok: true })).toBe("within 0.001%");
    expect([45, 600, 4000].map(durationLabel)).toEqual(["45 s", "10 min", "1 h 7 min"]);
  });
});

describe("findings", () => {
  const investigation = (over: Partial<InvestigationView> = {}): InvestigationView => ({
    id: "inv_0000000000000000000000",
    question: "Does the finite width raise Kt measurably?",
    registration: {
      question: "q",
      hypothesis: "h",
      alternative: "a",
      predictions: [
        { id: "P1", statement: "Kt ≈ 3", quantity: "Kt", expected: "3 ± 3 %", refutedIf: "outside 3 %" },
        { id: "P2", statement: "equilibrium", quantity: "residual", expected: "< 1e-4", refutedIf: "≥ 1e-4" },
      ],
      method: "FEM",
      verification: ["patch test"],
      uncertainty: "Richardson",
      decision: "Supported if all hold.",
    },
    registeredAt: 1,
    nodeName: "ultra",
    status: "done",
    conclusion: "inconclusive",
    summary: "s",
    review: null,
    artifact: null,
    predictions: [{ id: "P1", verdict: "consistent", value: 3.008908, uncertainty: 0.000071, units: "" }],
    concludedAt: 2,
    ...over,
  });

  test("each registered prediction beside what was found", () => {
    expect(predictionLines(investigation())).toEqual([
      { id: "P1", statement: "Kt ≈ 3", expected: "3 ± 3 %", refutedIf: "outside 3 %", verdict: "consistent", value: "3.00891 ± 0.000071" },
      { id: "P2", statement: "equilibrium", expected: "< 1e-4", refutedIf: "≥ 1e-4", verdict: null, value: null },
    ]);
    expect(predictionLines(investigation({ registration: null }))).toEqual([]);
  });

  test("a finding's state in a word", () => {
    expect(findingState(investigation())).toEqual({ label: "Inconclusive", tone: "warn" });
    expect(findingState(investigation({ conclusion: "supported" })).tone).toBe("ok");
    expect(findingState(investigation({ conclusion: "refuted" })).tone).toBe("danger");
    expect(findingState(investigation({ conclusion: null, status: "running" })).label).toBe("Running");
    expect(findingState(investigation({ conclusion: null, status: "gave-up" })).label).toBe("Gave up");
  });
});
