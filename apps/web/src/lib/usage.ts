import type { UsageMeter } from "@invincible/core";
import { tokensLabel } from "@invincible/core/spend";

/*
 * Money as the apps say it, and what a phone's Settings says of what this device may do, in every app's words (held by
 * the vectors): money always in two decimals, and the usage meter against its budget, over budget said so (the lead's
 * word, 28 November 2026: "$36.6" was missing its cent, and "· spent" past the budget read wrong). Core's usdLabel, which
 * the CLI and the records say, is left as it is.
 */

/**
 * Money as the apps say it: always two decimals ("$36.60"); a cent's fraction in four ("$0.0042"). Rounded on the
 * number's exact value, a true half up (toFixed's rule, and every app's): 1.005 is a little under, so $1.00.
 */
export const moneyWords = (usd: number): string => (usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

type Meter = Pick<UsageMeter, "spentUsd" | "complete" | "budgetUsd" | "tokens">;

/** The meter's figure: what this period came to, "At least" where some calls had no price (never of $0). */
export const spentWords = (m: Pick<Meter, "spentUsd" | "complete">): string => `${m.complete || m.spentUsd === 0 ? "" : "At least "}${moneyWords(m.spentUsd)}`;

/** Under the figure: of what budget, then what is left, all of it spent, or over budget; with no budget, its tokens. */
export const budgetWords = (m: Pick<Meter, "spentUsd" | "budgetUsd" | "tokens">): string => {
  if (m.budgetUsd === null) return `${tokensLabel(m.tokens)} tokens · no budget`;
  const of = `of ${moneyWords(m.budgetUsd)}`;
  if (m.spentUsd > m.budgetUsd) return `${of} · over budget`;
  if (m.spentUsd === m.budgetUsd) return `${of} · all spent`;
  return `${of} · ${moneyWords(m.budgetUsd - m.spentUsd)} left`;
};

/** The usage meter (GET /api/usage/meter) in one line, as Settings' Providers says it in every app: the two together. */
export const meterLine = (m: Meter): string => `${spentWords(m)}${m.budgetUsd === null ? " · " : " "}${budgetWords(m)}`;

/** Settings' own words in every app: what this device may do ("Can do": "May" read as the month), and what a read-only
 * page says of itself in its one line. */
export const SETTINGS_WORDS = {
  scopes: "Can do",
  readOnly: "Read-only for now: adding and changing come next.",
} as const;
