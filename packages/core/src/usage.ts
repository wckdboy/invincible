import { z } from "zod";
import type { Price, UsageLine } from "./spend.ts";

/*
 * The contracts for what model calls cost (spend.ts has the arithmetic): a call's
 * usage as its provider reported it, a tally by role and model, and the owner's
 * prices. Counts only: never a prompt, never an answer.
 */

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A model's ref as a tally keeps it: `<provider>/<model>`, or what a coding agent calls its own. */
const TallyModel = z.string().min(1).max(200);

export const UsageLineSchema = z.strictObject({
  role: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  model: TallyModel,
  calls: Count,
  unknown: Count,
  input: Count,
  output: Count,
  cached: Count,
  reasoning: Count,
}) satisfies z.ZodType<UsageLine>;

/** The most lines one record carries (roles × models that answered, fallbacks included). */
export const MAX_SPEND_LINES = 24;
export const SpendLines = z.array(UsageLineSchema).max(MAX_SPEND_LINES);

/**
 * What a trial spent: its model calls by role and model. Recorded beside the trial (`trial.spent`), open in
 * the log, read leniently: the Index per token, per second and per dollar is computed from it on every replica.
 */
export const TrialSpent = z.object({ lines: SpendLines });
export type TrialSpent = z.infer<typeof TrialSpent>;

/** A model a price is for: `<provider>/<model>`, or `<provider>/*` for everything that provider serves. */
export const PricedModel = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+\/\S+$/, "a price is for <provider>/<model>, or <provider>/* for all of a provider's models");

const Dollars = z.number().min(0).max(100_000);
/** US dollars per million tokens. Read leniently from the log (`price.set`). */
export const PriceSchema = z.object({ input: Dollars, output: Dollars, cached: Dollars.optional() }) satisfies z.ZodType<Price>;

/** Your prices as the mind holds them: the latest for each model, read leniently (one a newer node wrote in a shape this one can't read is left out). */
export function pricesOf(store: { lwwPrefix<T>(prefix: string): readonly { key: string; value: T | null }[] }): Record<string, Price> {
  const prices: Record<string, Price> = {};
  for (const entry of store.lwwPrefix<unknown>("price:")) {
    if (entry.value === null || entry.value === undefined) continue;
    const price = PriceSchema.safeParse(entry.value);
    if (price.success) prices[entry.key.slice("price:".length)] = price.data;
  }
  return prices;
}

/** A row of this node's own count of its model calls: a day, who asked, the role, the model. */
export interface UsageRow extends UsageLine {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** you · arm:<label> (a loop's quest is arm:loop.<name>) · galahad (his own upkeep: the heartbeat's words, skills, the archive). */
  who: string;
}

/** A budget for this node's model calls, in US dollars at your prices: a day's, or a month's (none: `usd` null). A line to
 * watch, never a stop: work goes on past it (a task's own budget is what stops a task). */
export const UsageBudgetInput = z.strictObject({ usd: z.number().positive().max(100_000).nullable(), per: z.enum(["day", "month"]).default("month") });
export type UsageBudgetInput = z.infer<typeof UsageBudgetInput>;

/** A provider whose allowance is spent now: until when (ms), and what it said (cut short, as the node keeps it). */
export interface UsageWindow {
  provider: string;
  /** When it resets (ms). */
  until: number;
  /** What its provider said, as it said it (cut short). */
  said: string;
}

/** What a meter shows: this period's model calls on this node at your prices, against the budget (`GET /api/usage/meter`). */
export interface UsageMeter {
  node: string;
  per: "day" | "month";
  /** The period's first day, YYYY-MM-DD (UTC). */
  since: string;
  budgetUsd: number | null;
  spentUsd: number;
  /** Every call in it was counted and priced: `spentUsd` is the whole of it, not a lower bound. */
  complete: boolean;
  /** Models that answered in it with no price of yours: their tokens aren't in `spentUsd`. */
  unpriced: string[];
  tokens: number;
  calls: number;
  /** What is left of the budget, never below zero (null with none). */
  leftUsd: number | null;
  /** What cost most in it, most first (tokens for one with no price): at most five. */
  top: { model: string; usd: number | null; tokens: number }[];
  /** Providers whose allowance is spent now, until when and as their provider said it. Absent when there are none. */
  windows?: UsageWindow[];
}

/** What `GET /api/usage` answers: this node's calls (never another node's), and the owner's prices. */
export interface UsageView {
  node: string;
  /** The first day counted, YYYY-MM-DD (UTC). */
  since: string;
  rows: UsageRow[];
  prices: Record<string, Price>;
  /** The coding plans' providers: their calls are paid for already, never money (moneyPrices). Absent from an older node. */
  plans?: readonly string[];
}
