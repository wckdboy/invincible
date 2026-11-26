import { z } from "zod";
import { canonical, type Json } from "./canonical.ts";
import { sha256B64u } from "./crypto.ts";

/*
 * Investigations: the scientific method, recorded. A pre-registration (hypothesis,
 * alternative, falsifiable predictions, method, verification, decision rule) enters
 * the mind before anything runs and never changes; its digest lets every replica
 * check it hasn't. The conclusion is recorded once, by the node that ran it.
 */

export const InvestigationId = z.string().regex(/^inv_[A-Za-z0-9_-]{22}$/);

const Prediction = z.strictObject({
  id: z.string().regex(/^P\d{1,2}$/, "P1, P2, …"),
  statement: z.string().min(1).max(1000),
  /** What is measured or computed, with units. */
  quantity: z.string().min(1).max(300),
  /** The value, range or behaviour expected if the hypothesis holds, with units. */
  expected: z.string().min(1).max(500),
  /** The observation that would refute it. */
  refutedIf: z.string().min(1).max(600),
});

export const Preregistration = z.strictObject({
  question: z.string().min(1).max(2000),
  hypothesis: z.string().min(1).max(2000),
  /** The null hypothesis, or the competing explanation the experiment must rule out. */
  alternative: z.string().min(1).max(2000),
  predictions: z.array(Prediction).min(1).max(8),
  method: z.string().min(1).max(5000),
  /** How the instruments are checked before anyone trusts them: convergence, analytic limits, units, conservation laws, known cases. */
  verification: z.array(z.string().min(1).max(600)).min(1).max(12),
  uncertainty: z.string().min(1).max(1500),
  /** How the verdict follows from the predictions' outcomes. */
  decision: z.string().min(1).max(1500),
});
export type Preregistration = z.infer<typeof Preregistration>;

/** What an experiment leaves in /work/out/results.json (read leniently: it comes from a sandbox). */
export const Results = z.object({
  predictions: z
    .array(
      z.object({
        id: z.string().max(8),
        observed: z.string().max(2000).optional(),
        value: z.number().nullable().optional(),
        uncertainty: z.number().nullable().optional(),
        units: z.string().max(50).optional(),
        verdict: z.enum(["consistent", "refuted", "undetermined"]),
        evidence: z.string().max(2000).optional(),
      }),
    )
    .max(16),
  verification: z.array(z.object({ check: z.string().max(600), passed: z.boolean(), detail: z.string().max(2000).optional() })).max(24),
  deviations: z.array(z.string().max(1000)).max(16).optional(),
});
export type Results = z.infer<typeof Results>;

export const Conclusion = z.enum(["supported", "refuted", "inconclusive"]);
export type Conclusion = z.infer<typeof Conclusion>;

/** How an investigation ended: done (with a conclusion), unverified, gave-up, stopped. */
export const InvestigationStatus = z.enum(["done", "unverified", "gave-up", "stopped"]);

/** Per prediction, what the experiment reported (as the reviewer accepted it, or not). */
export const PredictionOutcome = z.strictObject({
  id: z.string().regex(/^P\d{1,2}$/),
  verdict: z.enum(["consistent", "refuted", "undetermined"]),
  value: z.number().nullable().optional(),
  uncertainty: z.number().nullable().optional(),
  units: z.string().max(50).optional(),
});

/** The registration's fingerprint: what was promised before anything ran. */
export const registrationDigest = (registration: Preregistration): string => sha256B64u(canonical(registration as unknown as Json));
