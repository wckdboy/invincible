import { z } from "zod";

/*
 * Decisions: typed answers about a state, from a decision model (TypeSafe's System
 * One, e.g. Jev) rather than generated text. Each question is a yes/no ("noul"), a
 * choice among named options, or a score on an ordered rubric; each answer carries
 * calibrated probabilities. Galahad hires decision models by role ("decider").
 */

const Text = z.string().min(1).max(4000);
const Name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "letters, digits, _ and - (a name you choose)");

export const DecisionQuestion = z.discriminatedUnion("type", [
  /** Yes or no: the answer is the probability of yes. */
  z.strictObject({ type: z.literal("noul"), instructions: Text.optional(), criteria: z.strictObject({ true: Text, false: Text }).optional() }),
  /** One of named options (a description each, or null for the name alone). */
  z.strictObject({ type: z.literal("choice"), instructions: Text.optional(), criteria: z.record(z.string().min(1).max(100), Text.nullable()).refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 255, "1 to 255 options") }),
  /** A level on an ordered rubric, lowest first (2 to 10 levels). */
  z.strictObject({ type: z.literal("score"), instructions: Text.optional(), criteria: z.array(Text).min(2).max(10) }),
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;

export const DecisionRequest = z.strictObject({
  /** What the questions are about: text, or JSON. */
  state: z.union([z.string().min(1).max(100_000), z.record(z.string(), z.unknown())]),
  questions: z.record(Name, DecisionQuestion).refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 32, "1 to 32 questions"),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number>; legend?: Record<string, string> };

export interface DecisionView {
  /** The roster ref that answered, e.g. cloudflare-ai/typesafe/jev-latest. */
  ref: string;
  /** The model the service says answered (may differ from an alias). */
  model: string;
  answers: Record<string, DecisionAnswer>;
}
