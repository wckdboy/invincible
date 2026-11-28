/*
 * What model calls cost: tokens as the provider reported them, tallied by role and
 * model, and money only where the owner has stated a price. No dependencies (no zod):
 * the PWA imports this directly (@invincible/core/spend), so the CLI, the PWA and every
 * node compute the same totals from the same counts.
 *
 * Nothing here is an estimate. A call whose provider said nothing is counted as a
 * call with unknown usage, and every total built on it is a lower bound that says so.
 * A handed task's call whose provider said nothing in time is counted at its most
 * (Usage.atMost), and every total built on it is an upper bound that says so.
 */

/** One model call's tokens, as its provider reported them. */
export interface Usage {
  /** Every input token, cached ones included. */
  input: number;
  /** Every output token, reasoning included. */
  output: number;
  /** The part of the input read from the provider's cache (billed less), where it says. */
  cached?: number;
  /** The part of the output that was reasoning, where it says. */
  reasoning?: number;
  /**
   * Counted at its most, not as its provider said it: a handed task's call through the gateway whose provider said
   * nothing of its usage in time (gateway.ts heldUsage, cutUsage), every byte a token or the most it allowed itself.
   * An upper bound, never an estimate.
   */
  atMost?: true;
}

/** The calls one model made in one role. */
export interface UsageLine {
  role: string;
  model: string;
  calls: number;
  /** Calls whose provider reported no usage: the counts below don't include them. */
  unknown: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  /** Of `calls`, those counted at their most (Usage.atMost): the counts include them, as upper bounds. Absent: none. */
  atMost?: number;
}

export interface SpendTotal {
  calls: number;
  unknown: number;
  /** Calls counted at their most: the counts are upper bounds where any are. */
  atMost: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  /** input + output. */
  tokens: number;
  /** No call reported nothing: the counts are the whole of it. */
  complete: boolean;
}

/** The owner's price for a model, in US dollars per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** Cached input, where the provider bills it apart (left out: the input price). */
  cached?: number;
}

export type Prices = Readonly<Record<string, Price>>;

const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

/** Count one call on its role's and model's line. `usage` null: the provider said nothing. */
export function addUsage(lines: UsageLine[], role: string, model: string, usage: Usage | null): void {
  let line = lines.find((l) => l.role === role && l.model === model);
  if (!line) {
    line = { role, model, calls: 0, unknown: 0, input: 0, output: 0, cached: 0, reasoning: 0 };
    lines.push(line);
  }
  line.calls += 1;
  if (!usage) {
    line.unknown += 1;
    return;
  }
  line.input += count(usage.input);
  line.output += count(usage.output);
  line.cached += Math.min(count(usage.cached), count(usage.input));
  line.reasoning += Math.min(count(usage.reasoning), count(usage.output));
  if (usage.atMost === true) line.atMost = (line.atMost ?? 0) + 1;
}

/** Lines added together, line by line (role and model). */
export function mergeSpend(...sets: readonly (readonly UsageLine[] | null | undefined)[]): UsageLine[] {
  const out: UsageLine[] = [];
  for (const set of sets) {
    for (const l of set ?? []) {
      const line = out.find((o) => o.role === l.role && o.model === l.model);
      if (!line) out.push({ ...l });
      else {
        line.calls += l.calls;
        line.unknown += l.unknown;
        line.input += l.input;
        line.output += l.output;
        line.cached += l.cached;
        line.reasoning += l.reasoning;
        if (l.atMost) line.atMost = (line.atMost ?? 0) + l.atMost;
      }
    }
  }
  return out;
}

export function spendTotal(lines: readonly UsageLine[]): SpendTotal {
  const t = { calls: 0, unknown: 0, atMost: 0, input: 0, output: 0, cached: 0, reasoning: 0 };
  for (const l of lines) {
    t.calls += l.calls;
    t.unknown += l.unknown;
    t.atMost += l.atMost ?? 0;
    t.input += l.input;
    t.output += l.output;
    t.cached += l.cached;
    t.reasoning += l.reasoning;
  }
  return { ...t, tokens: t.input + t.output, complete: t.unknown === 0 };
}

/** The price that applies to a model: its own, else its provider's (`<provider>/*`), else none. */
export function priceFor(prices: Prices, model: string): Price | null {
  const own = prices[model];
  if (own) return own;
  const slash = model.indexOf("/");
  return slash > 0 ? (prices[`${model.slice(0, slash)}/*`] ?? null) : null;
}

/**
 * The name a coding tool's calls on its own sign-in are counted under, before the model it said it ran on
 * (`own sign-in/<model>`): a plan's (a seat of yours, or its VM's own sign-in), paid for already. No provider's id has
 * a space, so no price of yours is ever one for it.
 */
export const OWN_SIGN_IN_TALLY = "own sign-in";

/**
 * Your prices as money goes (your word, 23 November 2026: a budget of yours is outside the coding plans): a coding
 * plan's calls are paid for already, so every model of one of `plans` (their provider ids) costs nothing more, priced
 * by you or not, and so does every call a coding tool made on its own sign-in (OWN_SIGN_IN_TALLY: a plan's). What each
 * would cost at your prices stays yours to see (`invincible price`, the evals; a task's plan, its notional cost).
 * Budgets, the usage meter and what a task or an outcome spent are counted this way.
 */
export function moneyPrices(prices: Prices, plans: readonly string[]): Prices {
  const free: Price = { input: 0, output: 0, cached: 0 };
  const out: Record<string, Price> = {};
  for (const [ref, price] of Object.entries(prices)) {
    const slash = ref.indexOf("/");
    out[ref] = slash > 0 && plans.includes(ref.slice(0, slash)) ? free : price;
  }
  for (const plan of plans) out[`${plan}/*`] = free;
  out[`${OWN_SIGN_IN_TALLY}/*`] = free;
  return out;
}

export interface Cost {
  /** US dollars for the calls that are counted and priced. */
  usd: number;
  /** Models that made counted calls and have no price: their tokens aren't in `usd`. */
  unpriced: string[];
  /** Every call was counted and priced: `usd` is the whole of it, not a lower bound. */
  complete: boolean;
  /** Some call was counted at its most (Usage.atMost): `usd` is an upper bound for those calls. */
  atMost: boolean;
}

/** What these calls cost at the owner's prices. Money only where a price is known. */
export function costOf(lines: readonly UsageLine[], prices: Prices): Cost {
  let usd = 0;
  let unknown = 0;
  const unpriced = new Set<string>();
  for (const l of lines) {
    unknown += l.unknown;
    if (l.calls === l.unknown) continue;
    const price = priceFor(prices, l.model);
    if (!price) {
      unpriced.add(l.model);
      continue;
    }
    usd += ((l.input - l.cached) * price.input + l.cached * (price.cached ?? price.input) + l.output * price.output) / 1e6;
  }
  return { usd, unpriced: [...unpriced].sort(), complete: unknown === 0 && unpriced.size === 0, atMost: lines.some((l) => (l.atMost ?? 0) > 0) };
}

/* ---------- how it reads ---------- */

/** 1234 → "1,234"; 48210 → "48.2k"; 2340000 → "2.34M". */
export function tokensLabel(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/**
 * Money in its short form: "$0", "$0.0042", "$0.61", "$12.3", "$240". Where words that say money are kept (a loop's run,
 * an outcome's notes and its end, a fix refused in a work's trail) and in what an agent is told; what the terminal, the
 * eval reports, the scorecard and the apps show is moneyLabel's.
 */
export function usdLabel(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(usd < 100 ? 1 : 0)}`;
}

/**
 * Money as it is shown (the lead's word, 28 November 2026: the terminal, the eval reports, the scorecard and every app):
 * always two decimals ("$12.30", "$240.00"), a cent's fraction in four ("$0.0042"). Rounded on the number's exact
 * value, as toFixed does it (1.005 is a little under, so $1.00).
 */
export function moneyLabel(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * What a figure is, in the word before it: exact (""), a lower bound ("at least ": some call reported nothing, or has
 * no price), an upper bound ("at most ": some call was counted at its most, Usage.atMost), or neither ("about ": both).
 * One rule for every surface: the CLI, the PWA and the apps (their ports are held to it by the vectors).
 */
export function boundWord(lower: boolean, upper: boolean): "" | "at least " | "at most " | "about " {
  return upper ? (lower ? "about " : "at most ") : lower ? "at least " : "";
}

/** A tally in a line: tokens always, "at least" when some call reported nothing, "at most" when some was counted at its
 * most, money only where every price is known. [money]: how it says money (usdLabel where the line is kept; moneyLabel
 * where it is shown). */
export function spendLabel(lines: readonly UsageLine[], prices?: Prices, money: (usd: number) => string = usdLabel): string {
  const t = spendTotal(lines);
  if (!t.calls) return "no model calls";
  if (t.unknown === t.calls) return `tokens unknown (${t.calls} call${t.calls === 1 ? "" : "s"}, none reported by its provider)`;
  const parts = [`${boundWord(!t.complete, t.atMost > 0)}${tokensLabel(t.input)} tokens in${t.cached ? ` (${tokensLabel(t.cached)} cached)` : ""}, ${tokensLabel(t.output)} out${t.reasoning ? ` (${tokensLabel(t.reasoning)} reasoning)` : ""}`];
  parts.push(`${t.calls} call${t.calls === 1 ? "" : "s"}${t.unknown ? `, ${t.unknown} unreported` : ""}${t.atMost ? `, ${t.atMost} counted at ${t.atMost === 1 ? "its" : "their"} most` : ""}`);
  if (prices) {
    const cost = costOf(lines, prices);
    if (cost.complete) parts.push(`${boundWord(false, cost.atMost)}${money(cost.usd)}`);
    else if (cost.unpriced.length) parts.push(`${cost.usd > 0 ? `${money(cost.usd)} + ` : ""}no price for ${cost.unpriced.join(", ")}`);
    else parts.push(`${boundWord(true, cost.atMost)}${money(cost.usd)}`);
  }
  return parts.join(" · ");
}

/**
 * One line of a record's spend, as `invincible agents spent` and `inv cost --task` say it: its role and model, then
 * spendLabel's tokens, calls and money (moneyLabel's, as it is shown).
 */
export function spendLineLabel(line: UsageLine, prices: Prices): string {
  return `${line.role} · ${line.model} · ${spendLabel([line], prices, moneyLabel)}`;
}

/** Why a figure is at most, in a sentence beneath it (`inv cost`, `invincible agents spent`). */
export const AT_MOST_NOTE = "At most: a handed task's call was counted at its most, its provider silent in time: every byte a token, or the most it allowed itself.";
