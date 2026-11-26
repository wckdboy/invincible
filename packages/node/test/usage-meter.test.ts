import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { moneyPrices } from "@galahad/core";
import { PLAN_PROVIDERS } from "@galahad/brain";
import { meterLine } from "../src/trial-commands.ts";
import { UsageStore } from "../src/usage.ts";

/* A meter's numbers: this period's calls at your prices, against your budget (a line to watch, never a stop). */

const at = (iso: string) => () => Date.parse(iso);
const PRICES = { "opencode-go/glm-5.3": { input: 1, output: 4, cached: 0.1 }, "deepseek/*": { input: 0.5, output: 2 } };

function store(now: () => number) {
  const usage = new UsageStore(new Database(":memory:"), now);
  return usage;
}

describe("the usage meter", () => {
  // Your word, 23 November 2026: a daily budget of a couple of dollars, outside the coding plans.
  test("a coding plan's calls are paid for already: never money, never against your budget, priced by you or not", () => {
    const usage = store(at("2026-11-23T09:00:00Z"));
    usage.note("galahad", "engineer", "opencode-go/glm-5.3", { input: 2_000_000, output: 200_000, cached: 0, reasoning: 0 });
    usage.note("galahad", "engineer", "mimo-token/mimo-v2.6-pro", { input: 3_000_000, output: 100_000, cached: 0, reasoning: 0 });
    usage.note("galahad", "planner", "deepseek/deepseek-v4-pro", { input: 1_000_000, output: 250_000, cached: 0, reasoning: 0 });
    usage.setBudget({ usd: 2, per: "day" });
    const meter = usage.meter("ultra", moneyPrices(PRICES, PLAN_PROVIDERS));
    // DeepSeek's $1.00 is money; GLM on OpenCode Go (priced by you at $2.80) and MiMo's plan (no price) are not.
    expect(meter).toMatchObject({ budgetUsd: 2, complete: true, unpriced: [], calls: 3 });
    expect(meter.spentUsd).toBeCloseTo(1, 9);
    expect(meter.leftUsd).toBeCloseTo(1, 9);
    expect(meterLine(meter)).toBe("Today: $1.00 of $2.00, $1.00 left · 6.55M tokens in 3 calls");
    // At your prices as you stated them, the plan's calls would have spent the day's budget.
    expect(usage.meter("ultra", PRICES).leftUsd).toBe(0);
  });

  test("a month's calls at your prices against a month's budget, what is left, and what cost most", () => {
    let now = Date.parse("2026-11-01T09:00:00Z");
    const usage = store(() => now);
    usage.note("you", "planner", "opencode-go/glm-5.3", { input: 1_000_000, output: 100_000, cached: 0, reasoning: 0 });
    now = Date.parse("2026-11-18T10:00:00Z");
    usage.note("you", "engineer", "deepseek/deepseek-v4-pro", { input: 2_000_000, output: 500_000, cached: 0, reasoning: 0 });
    usage.note("you", "engineer", "local/qwen", { input: 10_000, output: 1_000, cached: 0, reasoning: 0 });
    // Last month's never counts.
    expect(usage.meter("ultra", PRICES)).toMatchObject({ per: "month", since: "2026-11-01", budgetUsd: null, leftUsd: null });
    usage.setBudget({ usd: 10, per: "month" });
    const month = usage.meter("ultra", PRICES);
    // $1.40 for GLM and $2.00 for DeepSeek; the local model has no price, so the total is a lower bound.
    expect(month).toMatchObject({ node: "ultra", per: "month", since: "2026-11-01", budgetUsd: 10, complete: false, unpriced: ["local/qwen"], calls: 3 });
    expect(month.spentUsd).toBeCloseTo(3.4, 6);
    expect(month.leftUsd).toBeCloseTo(6.6, 6);
    expect(month.top.map((t) => [t.model, t.usd === null ? null : Math.round(t.usd * 100) / 100])).toEqual([["deepseek/deepseek-v4-pro", 2], ["opencode-go/glm-5.3", 1.4], ["local/qwen", null]]);
  });

  test("a day's budget counts today alone, and nothing is left once it is spent", () => {
    let now = Date.parse("2026-11-17T23:00:00Z");
    const usage = store(() => now);
    usage.note("you", "planner", "opencode-go/glm-5.3", { input: 3_000_000, output: 0, cached: 0, reasoning: 0 });
    now = Date.parse("2026-11-18T08:00:00Z");
    usage.note("you", "planner", "opencode-go/glm-5.3", { input: 2_000_000, output: 250_000, cached: 1_000_000, reasoning: 0 });
    expect(usage.setBudget({ usd: 1.5, per: "day" })).toEqual({ usd: 1.5, per: "day" });
    const day = usage.meter("ultra", PRICES);
    // Today: 1M fresh at $1, 1M cached at $0.1, 250k out at $4 = $2.10, past the $1.50.
    expect(day).toMatchObject({ per: "day", since: "2026-11-18", complete: true, leftUsd: 0 });
    expect(day.spentUsd).toBeCloseTo(2.1, 6);
    // None: no budget, and it stays a month's count.
    expect(usage.setBudget({ usd: null, per: "month" })).toEqual({ usd: null, per: "month" });
    expect(usage.meter("ultra", PRICES)).toMatchObject({ budgetUsd: null, leftUsd: null, since: "2026-11-01" });
  });
});

describe("the meter in a line", () => {
  test("says what the period came to, against the budget and what is left, or how to set one", () => {
    const meter = { node: "ultra", per: "month" as const, since: "2026-11-01", budgetUsd: 10, spentUsd: 3.4, complete: false, unpriced: ["local/qwen"], tokens: 3_611_000, calls: 3, leftUsd: 6.6, top: [] };
    expect(meterLine(meter)).toBe("This month: at least $3.40 of $10.0, $6.60 left · 3.61M tokens in 3 calls · no price for local/qwen");
    expect(meterLine({ ...meter, per: "day", complete: true, unpriced: [], budgetUsd: 2, spentUsd: 2.1, leftUsd: 0, calls: 1 })).toBe("Today: $2.10 of $2.00, spent · 3.61M tokens in 1 call");
    expect(meterLine({ ...meter, budgetUsd: null, leftUsd: null, complete: true, unpriced: [] })).toBe("This month: $3.40 no budget (galahad usage budget <usd> sets one) · 3.61M tokens in 3 calls");
  });
});

test("nothing priced yet is $0, never at least $0", () => {
  const meter = { node: "ultra", per: "month" as const, since: "2026-11-01", budgetUsd: null, spentUsd: 0, complete: false, unpriced: [], tokens: 0, calls: 14, leftUsd: null, top: [] };
  expect(meterLine(meter)).toBe("This month: $0 no budget (galahad usage budget <usd> sets one) · 0 tokens in 14 calls");
});
