import { describe, expect, test } from "bun:test";
import type { TrialView, UsageRow } from "@galahad/core";
import type { UsageLine } from "@galahad/core/spend";
import { checkLabel, heldLabels, isCheck, priceLabel, priceRows, runCost, spentLine } from "./trial-cost.ts";

/* What trials and model calls cost, as the Trials and Models pages say it. */

const line = (over: Partial<UsageLine> = {}): UsageLine => ({ role: "engineer", model: "p/m", calls: 4, unknown: 0, input: 199_000, output: 1000, cached: 0, reasoning: 0, ...over });
const trial = (score: number, lines: UsageLine[] | null, over: Partial<TrialView> = {}): TrialView => ({
  id: "tr_x",
  run: "r-a",
  suite: "agentic",
  problem: "slow-rollup-l2",
  title: "A rollup",
  domain: "performance",
  seed: 1,
  status: "scored",
  score,
  answers: [],
  models: ["p/m"],
  version: "v",
  seconds: 600,
  recordedAt: 0,
  nodeName: "ultra",
  ...(lines ? { spent: { lines } } : {}),
  ...over,
});

describe("a trial's own cost", () => {
  test("tokens always; money only where every model that answered is priced", () => {
    expect(spentLine(trial(1, [line()]), { "p/m": { input: 5, output: 5 } })).toBe("199k tokens in, 1,000 out · 4 calls · $1.00");
    expect(spentLine(trial(1, [line()]), {})).toBe("199k tokens in, 1,000 out · 4 calls · no price for p/m");
    expect(spentLine(trial(1, [line({ unknown: 1 })]), { "p/m": { input: 5, output: 5 } })).toBe("at least 199k tokens in, 1,000 out · 4 calls · at least $1.00");
    expect(spentLine(trial(1, [line({ unknown: 4, input: 0, output: 0 })]), {})).toBe("tokens unknown (4 calls, none reported by its provider)");
    // Recorded before calls were counted: nothing to say, and nothing is made up.
    expect(spentLine(trial(1, null), {})).toBeNull();
  });

  test("a hidden test or a verdict is a check, not a number", () => {
    expect(isCheck({ units: "pass" })).toBe(true);
    expect(isCheck({ units: "Hz" })).toBe(false);
    expect([checkLabel({ got: 1, ok: true }), checkLabel({ got: 0, ok: false }), checkLabel({ got: null, ok: false })]).toEqual(["passed", "failed", "not run"]);
  });
});

describe("a run's cost, and what it bought", () => {
  test("tokens, money, and quality per million tokens, per hour and per dollar, each with its interval", () => {
    const cost = runCost([trial(1, [line()]), trial(0, [line()]), trial(1, [line()]), trial(1, [line()])], { "p/m": { input: 5, output: 5 } })!;
    expect(cost).toMatchObject({ tokens: "800k tokens", money: "$4.00", counted: 4, of: 4 });
    expect(cost.buys).toHaveLength(3);
    expect(cost.buys[0]).toMatch(/^3\.75 points per million tokens \(\d/);
    expect(cost.buys[1]).toMatch(/^4\.50 per hour/);
    expect(cost.buys[2]).toMatch(/^0\.75 per dollar/);
  });

  test("money is left out when it isn't the whole of it; nothing counted, nothing said", () => {
    expect(runCost([trial(1, [line()]), trial(1, [line({ model: "x/unpriced" })])], { "p/m": { input: 5, output: 5 } })).toMatchObject({ tokens: "400k tokens", money: null });
    expect(runCost([trial(1, null), trial(0, null)], {})).toBeNull();
    expect(runCost([trial(1, [line()]), trial(1, null)], {})).toMatchObject({ counted: 1, of: 2 });
    // A crash says nothing about ability, or about what ability costs.
    expect(runCost([trial(0, [line()], { status: "crashed" })], {})).toBeNull();
  });

  test("what set a run apart", () => {
    const options = { gates: false, plannerGates: false, effort: 1 as const, skills: false, archive: true, revisions: 2, engram: false, diff: false, escalate: false, remind: false, keepReads: false, tools: false, contract: false, agent: null, planner: true, review: true };
    expect(heldLabels({ effort: 3 })).toEqual(["effort 3"]);
    expect(heldLabels({ effort: 1, variant: { name: "no-gates", options }, pins: { engineer: "deepseek/v4" } })).toEqual(["no-gates", "engineer = deepseek/v4"]);
    expect(heldLabels({ effort: 1, variant: { name: "baseline", options: { ...options, gates: true } } })).toEqual([]);
    expect(heldLabels(undefined)).toEqual([]);
  });
});

describe("prices, model by model", () => {
  const row = (model: string, input: number, over: Partial<UsageRow> = {}): UsageRow => ({ day: "2026-11-12", who: "you", role: "engineer", model, calls: 2, unknown: 0, input, output: 1000, cached: 0, reasoning: 0, ...over });
  const roster = { planner: { models: ["router/opus", "deepseek/v4"] }, engineer: { models: ["router/opus"] }, swift: { models: ["ollama/qwen3:4b"] } };

  test("every model hired, priced or called: its price (its own, or its provider's), and what this node's calls came to", () => {
    const rows = priceRows(roster, { "router/opus": { input: 15, output: 75, cached: 1.5 }, "ollama/*": { input: 0, output: 0 } }, [row("router/opus", 999_000), row("router/opus", 499_000, { role: "planner" }), row("ollama/qwen3:4b", 9000, { unknown: 1 }), row("old/gone", 500)]);
    expect(rows.map((r) => r.model)).toEqual(["router/opus", "ollama/qwen3:4b", "old/gone", "deepseek/v4", "ollama/*"]);
    expect(rows[0]).toMatchObject({ roles: ["planner", "engineer"], inherited: false, calls: 4, tokens: 1_500_000 });
    expect(rows[0]!.usd).toBeCloseTo((1_498_000 * 15 + 2000 * 75) / 1e6, 9);
    // A local model at its provider's price: free, and said to be the provider's.
    expect(rows[1]).toMatchObject({ roles: ["swift"], inherited: true, usd: 0, unknown: 1 });
    // Called, never priced: tokens and no money. Hired, never called: neither.
    expect(rows[2]).toMatchObject({ roles: [], price: null, tokens: 1500, usd: null });
    expect(rows[3]).toMatchObject({ roles: ["planner"], price: null, calls: 0, usd: null });
    expect(priceLabel(rows[0]!.price!)).toBe("$15 in · $75 out · $1.5 cached");
  });
});
