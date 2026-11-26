import { describe, expect, test } from "bun:test";
import type { ChatMessage, ExecResult, Preregistration } from "@galahad/core";
import { EVIDENCE_COMMANDS, investigate, methodReview, parsePreregistration, readResults, renderPreregistration } from "../src/investigation.ts";
import type { QuestRole } from "../src/quest.ts";

/*
 * Investigations: the scientific method as a quest. What matters most is the order:
 * the predictions are registered before anything runs, and the reviewer judges the
 * method against that registration, from evidence read out of the sandbox.
 */

const REGISTRATION: Preregistration = {
  question: "Does a 2 m steel cantilever (50×10 mm, weak axis) have its first bending mode near 2.0 Hz?",
  hypothesis: "Euler–Bernoulli theory gives f1 = (1.875²/2π)·√(EI/ρAL⁴) ≈ 2.03 Hz.",
  alternative: "Shear deformation or rotary inertia shift f1 by more than 1 % (Timoshenko effects).",
  predictions: [
    { id: "P1", statement: "FEM f1 agrees with Euler–Bernoulli", quantity: "f1 in Hz", expected: "2.03 Hz ± 1 %", refutedIf: "FEM and theory differ by more than 1 % on a converged mesh" },
    { id: "P2", statement: "The FEM converges at its theoretical order", quantity: "observed convergence order of f1", expected: "≈ 4 for Hermite elements", refutedIf: "order below 3 over the last three refinements" },
  ],
  method: "Hermite beam elements in scikit-fem, 4→64 elements; compare with the analytic roots.",
  verification: ["mesh convergence over 5 refinements", "units: SI throughout, checked with Pint", "analytic limit: a single-element static deflection equals PL³/3EI"],
  uncertainty: "Discretization error from Richardson extrapolation.",
  decision: "Supported if P1 and P2 hold; refuted if either fails as registered; inconclusive if not converged.",
};

const fenced = (value: unknown) => `Here it is.\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const sh = (command: string) => `Next.\n\`\`\`sh\n${command}\n\`\`\``;

function harness(script: { planner: string[]; engineer: string[]; reviewer: string[] }) {
  const queues: Record<QuestRole, string[]> = { planner: [...script.planner], engineer: [...script.engineer], reviewer: [...script.reviewer] };
  const order: string[] = [];
  const seen: { role: QuestRole; messages: ChatMessage[] }[] = [];
  const registered: Preregistration[] = [];
  const run = investigate(
    { question: "Does the cantilever's first mode sit near 2 Hz?", environment: "the Lab", maxSteps: 10 },
    {
      ask: async (role, messages) => {
        seen.push({ role, messages });
        order.push(`ask:${role}`);
        const text = queues[role].shift();
        if (text === undefined) throw new Error(`the ${role} ran out of script`);
        return { text, model: `test/${role}` };
      },
      exec: async (command): Promise<ExecResult> => {
        order.push(`exec:${command.split(" ")[0]}`);
        const stdout = command.startsWith("cat /work/out/results.json")
          ? JSON.stringify({ predictions: [{ id: "P1", value: 2.031, uncertainty: 0.001, units: "Hz", verdict: "consistent" }, { id: "P2", value: 3.98, verdict: "consistent" }], verification: [{ check: "convergence", passed: true }] })
          : "ok";
        return { exitCode: 0, stdout, stderr: "", durationMs: 3, truncated: false };
      },
      register: async (registration) => {
        order.push("register");
        registered.push(registration);
        return "inv_test";
      },
    },
  );
  return { run, order, seen, registered };
}

describe("formulating", () => {
  test("a pre-registration must be complete and falsifiable; a bad one is sent back with why", () => {
    expect(parsePreregistration(fenced(REGISTRATION))).toEqual({ ok: true, value: REGISTRATION });
    const noRefutation = { ...REGISTRATION, predictions: [{ ...REGISTRATION.predictions[0]!, refutedIf: "" }] };
    expect(parsePreregistration(fenced(noRefutation))).toMatchObject({ ok: false, problem: expect.stringMatching(/predictions\.0\.refutedIf/) });
    expect(parsePreregistration(fenced({ ...REGISTRATION, verification: [] }))).toMatchObject({ ok: false });
    const twice = { ...REGISTRATION, predictions: [REGISTRATION.predictions[0]!, REGISTRATION.predictions[0]!] };
    expect(parsePreregistration(fenced(twice))).toEqual({ ok: false, problem: "prediction ids must be unique" });
    expect(parsePreregistration("no json here")).toMatchObject({ ok: false });
  });

  test("rendered for the engineer and reviewer: every prediction with what would refute it", () => {
    const text = renderPreregistration(REGISTRATION);
    expect(text).toContain("P1. FEM f1 agrees with Euler–Bernoulli");
    expect(text).toContain("refuted if: FEM and theory differ by more than 1 % on a converged mesh");
    expect(text).toContain("Decision rule: Supported if P1 and P2 hold");
  });
});

describe("an investigation", () => {
  test("registered before anything runs; the reviewer judges the method from evidence read out of the sandbox", async () => {
    const h = harness({
      planner: ["Let me think. {not json", fenced(REGISTRATION)],
      engineer: [sh("python3 beam.py"), sh("python3 converge.py"), "DONE\nf1 = 2.031 Hz vs 2.030 theory; order 3.98."],
      reviewer: ["SUPPORTED\nConverged at order ≈ 4; P1 within 0.05 %; verification passed as registered."],
    });
    const result = await h.run;
    expect(result).toMatchObject({ id: "inv_test", conclusion: "supported", outcome: { status: "done" } });
    // The first command runs only after the registration is recorded.
    expect(h.order.indexOf("register")).toBeLessThan(h.order.indexOf("exec:python3"));
    expect(h.registered).toEqual([REGISTRATION]);
    // The planner was told what was wrong with its first try.
    expect(h.seen[1]!.messages.at(-1)!.content).toMatch(/isn't a valid pre-registration/);
    // The engineer gets the fixed plan and the results.json contract; no separate planning turn happens.
    const briefing = h.seen.find((s) => s.role === "engineer")!.messages[0]!.content;
    expect(briefing).toContain("refuted if: FEM and theory differ");
    expect(briefing).toContain("results.json");
    expect(briefing).toContain("never adjust a prediction to fit a result");
    // The reviewer sees the registration and the evidence commands' output, straight from the sandbox.
    const review = h.seen.find((s) => s.role === "reviewer")!.messages[0]!.content;
    expect(review).toContain("may not have changed");
    expect(review).toContain(`$ ${EVIDENCE_COMMANDS[0]}`);
    expect(review).toContain('"value":2.031');
  });

  test("a method that falls short goes back; a refutation is a result, not a failure", async () => {
    const h = harness({
      planner: [fenced(REGISTRATION)],
      engineer: ["DONE\nf1 = 2.03 Hz.", sh("python3 converge.py"), "DONE\nNow converged; FEM differs from theory by 4 %."],
      reviewer: ["REVISE\nNo convergence study was run, though P2 registered one.", "REFUTED\nConverged mesh; P1 fails: 4 % > 1 % as registered."],
    });
    const result = await h.run;
    expect(result.conclusion).toBe("refuted");
    expect(result.outcome).toMatchObject({ status: "done", revisions: 1 });
  });

  test("no valid registration after three tries: nothing runs, nothing is registered", async () => {
    const h = harness({ planner: ["nope", "still no", "{}"], engineer: [], reviewer: [] });
    const result = await h.run;
    expect(result).toMatchObject({ id: null, conclusion: null, outcome: { status: "gave-up" } });
    expect(h.order.filter((o) => o === "register" || o.startsWith("exec"))).toEqual([]);
  });
});

describe("reading the verdicts and the results", () => {
  test("only a clear verdict ends it; anything else goes back", () => {
    const review = methodReview(REGISTRATION);
    expect(review.read("**SUPPORTED**\nfine")).toMatchObject({ verdict: "pass", conclusion: "supported" });
    expect(review.read("Inconclusive: not converged")).toMatchObject({ verdict: "pass", conclusion: "inconclusive" });
    expect(review.read("REVISE\nadd a convergence study")).toEqual({ verdict: "revise", notes: "add a convergence study" });
    expect(review.read("I think it's probably fine")).toMatchObject({ verdict: "revise" });
  });

  test("results.json is read leniently but must have the shape", () => {
    expect(readResults('{"predictions":[{"id":"P1","verdict":"consistent","value":1}],"verification":[]}')?.predictions[0]?.value).toBe(1);
    expect(readResults('{"predictions":[{"id":"P1","verdict":"maybe"}],"verification":[]}')).toBeNull();
    expect(readResults("not json")).toBeNull();
  });
});
