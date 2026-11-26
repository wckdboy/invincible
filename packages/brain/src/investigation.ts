import { type ChatMessage, type Conclusion, Preregistration, redact, Results } from "@galahad/core";
import { type QuestDeps, type QuestOutcome, type QuestReview, runQuest } from "./quest.ts";

/*
 * An investigation: the scientific method as a quest.
 *
 *   1. formulate   the planner turns a question into a pre-registration: a hypothesis,
 *                  an alternative, falsifiable predictions (each with what would refute
 *                  it), the method, and how the instruments themselves are verified
 *   2. register    it's recorded in the mind before anything runs, and never changes:
 *                  predictions can't drift to fit the results
 *   3. experiment  the engineer carries out exactly that method in the sandbox, verifies
 *                  the solvers (convergence, analytic limits, units, conservation), and
 *                  writes results.json, report.md and plots to /work/out
 *   4. review      an independent reviewer judges the method against the registration
 *                  and the evidence read straight from the sandbox: SUPPORTED, REFUTED,
 *                  INCONCLUSIVE, or REVISE when the method falls short
 *
 * Pure orchestration, like runQuest: models, the sandbox and the registry are injected.
 */

const JSON_FENCE = /```(?:json)?\s*\n([\s\S]*?)```/;

export function formulatePrompt(question: string, environment: string): string {
  return `You are designing a scientific investigation that an engineer will carry out alone, in: ${environment}

Question: ${question}

Write a pre-registration: it is recorded before anything runs and can never be changed, so the predictions must be specific and falsifiable, and the method must be able to refute the hypothesis.

Reply with one JSON object in a \`\`\`json block, exactly these fields:
{
  "question": "the question, sharpened if needed",
  "hypothesis": "what we expect, and why (theory, first principles)",
  "alternative": "the null hypothesis or the competing explanation the experiment must rule out",
  "predictions": [
    { "id": "P1", "statement": "…", "quantity": "what is measured or computed, with units", "expected": "value or range with units (or the behaviour)", "refutedIf": "the observation that would refute it" }
  ],
  "method": "the experiment or simulation, step by step: models, parameters, meshes or step sizes, what is varied",
  "verification": ["how each instrument is checked before it's trusted: convergence studies, analytic or limiting cases, units, conservation laws, a known benchmark"],
  "uncertainty": "how numerical, model and parameter uncertainty will be estimated",
  "decision": "how the verdict (supported, refuted, inconclusive) follows from the predictions' outcomes"
}
1 to 8 predictions. Prefer quantities that can be computed and compared with tolerances. No preamble.`;
}

/** The pre-registration from the planner's reply, or what's wrong with it. */
export function parsePreregistration(reply: string): { ok: true; value: Preregistration } | { ok: false; problem: string } {
  const block = reply.match(JSON_FENCE)?.[1] ?? reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return { ok: false, problem: "The reply had no valid JSON object in a ```json block." };
  }
  const parsed = Preregistration.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  const ids = parsed.data.predictions.map((p) => p.id);
  if (new Set(ids).size !== ids.length) return { ok: false, problem: "prediction ids must be unique" };
  return { ok: true, value: parsed.data };
}

/** The registration as the engineer and the reviewer read it. */
export function renderPreregistration(p: Preregistration): string {
  return [
    `Question: ${p.question}`,
    `Hypothesis: ${p.hypothesis}`,
    `Alternative to rule out: ${p.alternative}`,
    "Predictions:",
    ...p.predictions.map((x) => `  ${x.id}. ${x.statement}\n      quantity: ${x.quantity}\n      expected: ${x.expected}\n      refuted if: ${x.refutedIf}`),
    `Method: ${p.method}`,
    "Verification (before trusting any instrument):",
    ...p.verification.map((v) => `  - ${v}`),
    `Uncertainty: ${p.uncertainty}`,
    `Decision rule: ${p.decision}`,
  ].join("\n");
}

export const EXPERIMENT_INSTRUCTIONS = `This is a pre-registered investigation. The plan above was recorded before you started and can't change: test exactly those predictions with that method. If you must deviate (a solver fails, a parameter is impossible), do the closest valid thing and record the deviation and why; never adjust a prediction to fit a result.

Verify every instrument before you trust it (the verification list above): convergence, analytic or limiting cases, units, conservation. A result from an unverified solver is not evidence.

Leave in /work/out:
- results.json, exactly this shape:
  {"predictions": [{"id": "P1", "observed": "what you found, in words", "value": 1.23, "uncertainty": 0.01, "units": "Hz", "verdict": "consistent" | "refuted" | "undetermined", "evidence": "which files, commands or figures show it"}],
   "verification": [{"check": "…", "passed": true, "detail": "numbers"}],
   "deviations": ["…"]}
  (value and uncertainty are numbers or null; one entry per registered prediction, by id)
- report.md: question, method as carried out, results with uncertainties, verification, deviations, and what the evidence says about each prediction
- plots as PNG files, and the scripts that made every number, so it can all be re-run`;

export const EVIDENCE_COMMANDS = [
  "cat /work/out/results.json 2>&1 | head -c 12000",
  "head -c 8000 /work/out/report.md 2>&1",
  "ls -la /work/out 2>&1 | head -40",
];

/** The reviewer judges the method against the registration, from the evidence. */
export function methodReview(registration: Preregistration): QuestReview {
  return {
    prompt: ({ plan, steps, summary, evidence }) => `You are an independent reviewer of a pre-registered investigation. Judge the method, then the conclusion, strictly and only from the evidence. Claims without evidence don't count.

The pre-registration (recorded before anything ran; it may not have changed):
${plan}

What the engineer ran (exit code and an excerpt of the output):
${steps.map((s, i) => `${i + 1}. $ ${s.command}\n   exit ${s.exitCode}\n${s.excerpt.replace(/^/gm, "   ")}`).join("\n") || "(nothing)"}

Their summary:
${summary}

The files, read straight from the sandbox now:
${evidence || "(none)"}

Check: Were the registered predictions tested as registered (same quantities, no moved goalposts)? Was each instrument verified as registered, and did it pass? Are uncertainties estimated? Are deviations recorded and justified? Do the per-prediction verdicts follow from the numbers, and the overall conclusion from the decision rule (${registration.decision.slice(0, 300)})?

Reply with exactly one of these on the first line, then your reasons:
SUPPORTED: the method is sound and the predictions hold
REFUTED: the method is sound and at least one prediction failed as registered
INCONCLUSIVE: the method is sound but the evidence can't decide
REVISE: the method falls short (say exactly what to fix)`,
    read: (reply) => {
      const text = reply.trim();
      const first = (text.split(/\r?\n/, 1)[0] ?? "").replace(/^[*#\s]+/, "").trim();
      const notes = text.slice(text.indexOf("\n") + 1).trim();
      const m = first.match(/^(SUPPORTED|REFUTED|INCONCLUSIVE)\b/i);
      if (m) return { verdict: "pass", notes: notes || first, conclusion: m[1]!.toLowerCase() };
      // Anything that isn't a clear verdict goes back for work.
      return { verdict: "revise", notes: /^REVISE\b/i.test(first) ? notes || "(no notes)" : text };
    },
  };
}

export interface InvestigationDeps extends QuestDeps {
  /** Record the pre-registration (immutably) before anything runs; returns its id. */
  register(registration: Preregistration): Promise<string>;
}

export interface InvestigationOptions {
  question: string;
  environment: string;
  maxSteps?: number;
  maxRevisions?: number;
  commandTimeoutSec?: number;
}

export interface InvestigationOutcome {
  id: string | null;
  registration: Preregistration | null;
  outcome: QuestOutcome;
  /** supported · refuted · inconclusive, when the review reached one. */
  conclusion: Conclusion | null;
}

/** Formulate, register, experiment, review. */
export async function investigate(options: InvestigationOptions, deps: InvestigationDeps): Promise<InvestigationOutcome> {
  const messages: ChatMessage[] = [{ role: "user", content: formulatePrompt(options.question, options.environment) }];
  let registration: Preregistration | null = null;
  for (let attempt = 0; attempt < 3 && !registration; attempt++) {
    if (deps.signal?.aborted) break;
    const reply = await deps.ask("planner", messages.map((m) => ({ role: m.role, content: redact(m.content) })));
    const parsed = parsePreregistration(reply.text);
    if (parsed.ok) registration = parsed.value;
    else {
      messages.push({ role: "assistant", content: reply.text }, { role: "user", content: `That isn't a valid pre-registration: ${parsed.problem}. Reply with the corrected JSON only.` });
    }
  }
  if (!registration) {
    const outcome: QuestOutcome = { status: "gave-up", summary: "The planner couldn't write a valid pre-registration.", steps: 0, revisions: 0, plan: "" };
    return { id: null, registration: null, outcome, conclusion: null };
  }
  const id = await deps.register(registration);
  const plan = renderPreregistration(registration);
  deps.emit?.({ type: "plan", text: `Registered as ${id} before anything ran:\n${plan}`, model: "pre-registration" });
  const outcome = await runQuest(
    {
      goal: `Carry out the pre-registered investigation: ${registration.question}`,
      environment: options.environment,
      plan,
      instructions: EXPERIMENT_INSTRUCTIONS,
      evidence: EVIDENCE_COMMANDS,
      review: methodReview(registration),
      ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
      ...(options.maxRevisions !== undefined ? { maxRevisions: options.maxRevisions } : {}),
      ...(options.commandTimeoutSec ? { commandTimeoutSec: options.commandTimeoutSec } : {}),
    },
    deps,
  );
  const conclusion = (outcome.conclusion as Conclusion | undefined) ?? null;
  return { id, registration, outcome, conclusion };
}

/** Read /work/out/results.json as the sandbox left it (or null). */
export function readResults(text: string): Results | null {
  try {
    const parsed = Results.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
