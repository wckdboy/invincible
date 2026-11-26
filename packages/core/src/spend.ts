/*
 * What model calls cost: tokens as the provider reported them, tallied by role and
 * model, and money only where the owner has stated a price. No dependencies (no zod):
 * the PWA imports this directly (@galahad/core/spend), so the CLI, the PWA and every
 * node compute the same totals from the same counts.
 *
 * Nothing here is an estimate. A call whose provider said nothing is counted as a
 * call with unknown usage, and every total built on it is a lower bound that says so.
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
}

export interface SpendTotal {
  calls: number;
  unknown: number;
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
      }
    }
  }
  return out;
}

export function spendTotal(lines: readonly UsageLine[]): SpendTotal {
  const t = { calls: 0, unknown: 0, input: 0, output: 0, cached: 0, reasoning: 0 };
  for (const l of lines) {
    t.calls += l.calls;
    t.unknown += l.unknown;
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
 * Your prices as money goes (your word, 23 November 2026: a budget of yours is outside the coding plans): a coding
 * plan's calls are paid for already, so every model of one of `plans` (their provider ids) costs nothing more, priced
 * by you or not. What each would cost at your prices stays yours to see (`galahad price`, the trials). Budgets, the
 * usage meter and what a task or an outcome spent are counted this way.
 */
export function moneyPrices(prices: Prices, plans: readonly string[]): Prices {
  const free: Price = { input: 0, output: 0, cached: 0 };
  const out: Record<string, Price> = {};
  for (const [ref, price] of Object.entries(prices)) {
    const slash = ref.indexOf("/");
    out[ref] = slash > 0 && plans.includes(ref.slice(0, slash)) ? free : price;
  }
  for (const plan of plans) out[`${plan}/*`] = free;
  return out;
}

export interface Cost {
  /** US dollars for the calls that are counted and priced. */
  usd: number;
  /** Models that made counted calls and have no price: their tokens aren't in `usd`. */
  unpriced: string[];
  /** Every call was counted and priced: `usd` is the whole of it, not a lower bound. */
  complete: boolean;
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
  return { usd, unpriced: [...unpriced].sort(), complete: unknown === 0 && unpriced.size === 0 };
}

/* ---------- how it reads ---------- */

/** 1234 → "1,234"; 48210 → "48.2k"; 2340000 → "2.34M". */
export function tokensLabel(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function usdLabel(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(usd < 100 ? 1 : 0)}`;
}

/** A tally in a line: tokens always, "at least" when some call reported nothing, money only where every price is known. */
export function spendLabel(lines: readonly UsageLine[], prices?: Prices): string {
  const t = spendTotal(lines);
  if (!t.calls) return "no model calls";
  if (t.unknown === t.calls) return `tokens unknown (${t.calls} call${t.calls === 1 ? "" : "s"}, none reported by its provider)`;
  const parts = [`${t.complete ? "" : "at least "}${tokensLabel(t.input)} tokens in${t.cached ? ` (${tokensLabel(t.cached)} cached)` : ""}, ${tokensLabel(t.output)} out${t.reasoning ? ` (${tokensLabel(t.reasoning)} reasoning)` : ""}`];
  parts.push(`${t.calls} call${t.calls === 1 ? "" : "s"}${t.unknown ? `, ${t.unknown} unreported` : ""}`);
  if (prices) {
    const cost = costOf(lines, prices);
    if (cost.complete) parts.push(usdLabel(cost.usd));
    else if (cost.unpriced.length) parts.push(`${cost.usd > 0 ? `${usdLabel(cost.usd)} + ` : ""}no price for ${cost.unpriced.join(", ")}`);
    else parts.push(`at least ${usdLabel(cost.usd)}`);
  }
  return parts.join(" · ");
}
