import type { TrialAnswer, TrialRunSettings, TrialView, UsageRow } from "@galahad/core";
import { costed, costIndex, type Interval } from "@galahad/core/galahad-index";
import { costOf, type Price, priceFor, type Prices, spendTotal, tokensLabel, type UsageLine, usdLabel } from "@galahad/core/spend";

/*
 * What trials and model calls cost, as people read it. Pure functions (no DOM),
 * unit-tested. The arithmetic is core's (spend.ts, galahad-index.ts), so the app, the
 * CLI and every node say the same thing: tokens as the providers reported them, money
 * only where a price is stated, and "unknown" where neither is known.
 */

const figure = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(2));
const ratio = (i: Interval | null, unit: string): string | null => (i ? `${figure(i.mean)} ${unit} (${figure(i.low)}–${figure(i.high)})` : null);

/** A hidden test or a reviewer's verdict: a check that passed or didn't, not a number against an exact one. */
export const isCheck = (a: Pick<TrialAnswer, "units">): boolean => a.units === "pass";
export const checkLabel = (a: Pick<TrialAnswer, "got" | "ok">): "passed" | "failed" | "not run" => (a.got === null ? "not run" : a.ok ? "passed" : "failed");

/** What one trial spent, in a line; null when its calls weren't counted (it was recorded before they were). */
export function spentLine(t: Pick<TrialView, "spent">, prices: Prices): string | null {
  const lines = t.spent?.lines;
  if (!lines?.length) return null;
  const total = spendTotal(lines);
  if (total.unknown === total.calls) return `tokens unknown (${total.calls} calls, none reported by its provider)`;
  const cost = costOf(lines, prices);
  const money = cost.complete ? usdLabel(cost.usd) : cost.unpriced.length ? `no price for ${cost.unpriced.join(", ")}` : `at least ${usdLabel(cost.usd)}`;
  return `${total.complete ? "" : "at least "}${tokensLabel(total.input)} tokens in, ${tokensLabel(total.output)} out · ${total.calls} calls · ${money}`;
}

export interface RunCost {
  /** "2.40M tokens", or that they aren't known. */
  tokens: string;
  /** "$3.10", or null when a price is missing or a call went unreported. */
  money: string | null;
  /** What the quality cost: points per million tokens, per hour and per dollar, each with its interval. */
  buys: string[];
  /** How many of the scored trials had their calls counted. */
  counted: number;
  of: number;
}

/** What a set of trials cost and what that bought; null when none of them had its calls counted. */
export function runCost(trials: readonly TrialView[], prices: Prices): RunCost | null {
  const scored = trials.filter((t) => t.status === "scored");
  const counted = scored.filter((t) => t.spent?.lines.length).length;
  if (!counted) return null;
  const index = costIndex(scored.map((t) => costed(t, prices)));
  return {
    tokens: index.tokens !== null ? `${tokensLabel(index.tokens)} tokens` : "tokens unknown",
    money: index.usd !== null && index.perUsd && index.perUsd.n === scored.length ? usdLabel(index.usd) : null,
    buys: [ratio(index.perMTok, "points per million tokens"), ratio(index.perHour, "per hour"), ratio(index.perUsd, "per dollar")].filter((x): x is string => x !== null),
    counted,
    of: scored.length,
  };
}

/** What set a run apart, as badges: its effort, its variant, the roles it held to one model. */
export function heldLabels(settings: TrialRunSettings | undefined): string[] {
  if (!settings) return [];
  return [
    settings.variant && settings.variant.name !== "baseline" ? settings.variant.name : settings.effort > 1 ? `effort ${settings.effort}` : "",
    ...Object.entries(settings.pins ?? {}).map(([role, model]) => `${role} = ${model}`),
  ].filter(Boolean);
}

export interface PriceRow {
  model: string;
  /** The roles that hire it, in the roster's order. */
  roles: string[];
  price: Price | null;
  /** Its price is its provider's (`<provider>/*`), not its own. */
  inherited: boolean;
  /** This node's calls to it in the days shown: tokens, and money when priced. */
  calls: number;
  tokens: number;
  unknown: number;
  usd: number | null;
}

/** Every model the roster hires, every model with a price, and every model this node called: with its price and what it came to. */
export function priceRows(roster: Readonly<Record<string, { models: string[] }>>, prices: Prices, usage: readonly UsageRow[]): PriceRow[] {
  const models = new Set<string>([...Object.values(roster).flatMap((r) => r.models), ...Object.keys(prices), ...usage.map((u) => u.model)]);
  return [...models]
    .map((model): PriceRow => {
      const lines: UsageLine[] = usage.filter((u) => u.model === model).map(({ day: _day, who: _who, ...line }) => line);
      const total = spendTotal(lines);
      const price = model.endsWith("/*") ? (prices[model] ?? null) : priceFor(prices, model);
      const cost = costOf(lines, prices);
      return {
        model,
        roles: Object.entries(roster).filter(([, r]) => r.models.includes(model)).map(([role]) => role),
        price,
        inherited: !!price && !prices[model],
        calls: total.calls,
        tokens: total.tokens,
        unknown: total.unknown,
        usd: price && total.calls > total.unknown ? cost.usd : null,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || Number(b.roles.length > 0) - Number(a.roles.length > 0) || a.model.localeCompare(b.model));
}

/** A price as it is written: dollars per million tokens in and out. */
export const priceLabel = (price: Price): string => `$${price.input} in · $${price.output} out${price.cached !== undefined ? ` · $${price.cached} cached` : ""}`;
