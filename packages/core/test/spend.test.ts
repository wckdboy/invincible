import { describe, expect, test } from "bun:test";
import {
  addUsage,
  compareIntervals,
  costed,
  costIndex,
  costOf,
  describeVariant,
  galahadIndex,
  mergeSpend,
  moneyPrices,
  parseVariant,
  priceFor,
  PricedModel,
  PriceSchema,
  ratioIndex,
  routes,
  spendLabel,
  spendTotal,
  tokensLabel,
  TrialRunSettings,
  TrialSpent,
  type UsageLine,
  usdLabel,
  VARIANTS,
} from "../src/index.ts";

/*
 * What model calls cost: tokens as the providers reported them, tallied by role and
 * model; money only where a price is stated; and the Index beside what it cost. A call
 * whose provider said nothing is unknown, and every total that rests on it says so.
 */

const line = (over: Partial<UsageLine> = {}): UsageLine => ({ role: "engineer", model: "p/m", calls: 1, unknown: 0, input: 1000, output: 100, cached: 0, reasoning: 0, ...over });

describe("a tally", () => {
  test("counts each call on its role's and model's line; cached and reasoning never exceed what they're part of", () => {
    const lines: UsageLine[] = [];
    addUsage(lines, "engineer", "p/m", { input: 1000, output: 200, cached: 400, reasoning: 50 });
    addUsage(lines, "engineer", "p/m", { input: 500, output: 100 });
    addUsage(lines, "reviewer", "q/r", { input: 300, output: 30, cached: 9999, reasoning: 9999 });
    expect(lines).toEqual([
      { role: "engineer", model: "p/m", calls: 2, unknown: 0, input: 1500, output: 300, cached: 400, reasoning: 50 },
      { role: "reviewer", model: "q/r", calls: 1, unknown: 0, input: 300, output: 30, cached: 300, reasoning: 30 },
    ]);
    expect(spendTotal(lines)).toMatchObject({ calls: 3, unknown: 0, input: 1800, output: 330, tokens: 2130, complete: true });
  });

  test("a call whose provider said nothing is a call with unknown usage: never a guess", () => {
    const lines: UsageLine[] = [];
    addUsage(lines, "engineer", "local/small", null);
    addUsage(lines, "engineer", "local/small", { input: 10, output: 5 });
    expect(lines[0]).toMatchObject({ calls: 2, unknown: 1, input: 10, output: 5 });
    expect(spendTotal(lines).complete).toBe(false);
    expect(spendLabel(lines)).toMatch(/^at least 10 tokens in, 5 out · 2 calls, 1 unreported$/);
    const silent: UsageLine[] = [];
    addUsage(silent, "planner", "local/small", null);
    expect(spendLabel(silent)).toBe("tokens unknown (1 call, none reported by its provider)");
    expect(spendLabel([])).toBe("no model calls");
  });

  test("tallies add up line by line", () => {
    const merged = mergeSpend([line(), line({ role: "planner", input: 5 })], null, [line({ calls: 2, unknown: 1, input: 7 })]);
    expect(merged).toEqual([line({ calls: 3, unknown: 1, input: 1007, output: 200 }), line({ role: "planner", input: 5 })]);
  });
});

describe("money as it goes: a coding plan's calls are paid for already", () => {
  test("a model of a plan costs nothing more, priced or not; every other price stays yours", () => {
    const prices = { "opencode-go/glm-5.3": { input: 1.4, output: 4.4 }, "deepseek/*": { input: 0.5, output: 2 }, "zai-coding/glm-5.3": { input: 9, output: 9 } };
    const money = moneyPrices(prices, ["opencode-go", "zai-coding", "mimo-token"]);
    expect(priceFor(money, "opencode-go/glm-5.3")).toEqual({ input: 0, output: 0, cached: 0 });
    expect(priceFor(money, "opencode-go/kimi-k3")).toEqual({ input: 0, output: 0, cached: 0 });
    expect(priceFor(money, "mimo-token/mimo-v2.6-pro")).toEqual({ input: 0, output: 0, cached: 0 });
    expect(priceFor(money, "zai-coding/glm-5.3")).toEqual({ input: 0, output: 0, cached: 0 });
    expect(priceFor(money, "deepseek/deepseek-v4-pro")).toEqual({ input: 0.5, output: 2 });
    // A provider that isn't a plan, though its name begins like one, keeps its price.
    expect(priceFor(moneyPrices({ "opencode/x": { input: 1, output: 1 } }, ["opencode-go"]), "opencode/x")).toEqual({ input: 1, output: 1 });
    const line = { role: "engineer", calls: 1, unknown: 0, input: 1_000_000, output: 1_000_000, cached: 0, reasoning: 0 };
    expect(costOf([{ ...line, model: "mimo-token/mimo-v2.6-pro" }, { ...line, model: "deepseek/deepseek-v4-pro" }], money)).toEqual({ usd: 2.5, unpriced: [], complete: true });
  });
});

describe("money, only where a price is stated", () => {
  const prices = { "p/m": { input: 3, output: 15, cached: 0.3 }, "local/*": { input: 0, output: 0 } };

  test("a model's own price, else its provider's, else none", () => {
    expect(priceFor(prices, "p/m")).toEqual({ input: 3, output: 15, cached: 0.3 });
    expect(priceFor(prices, "local/qwen:4b")).toEqual({ input: 0, output: 0 });
    expect(priceFor(prices, "p/other")).toBeNull();
    expect(priceFor(prices, "nameless")).toBeNull();
  });

  test("cached input is billed at its own price; everything else per million", () => {
    const cost = costOf([line({ input: 1_000_000, cached: 400_000, output: 100_000 })], prices);
    expect(cost.usd).toBeCloseTo(0.6 * 3 + 0.4 * 0.3 + 0.1 * 15, 12);
    expect(cost).toMatchObject({ unpriced: [], complete: true });
    // No cached price stated: cached input costs what input does.
    expect(costOf([line({ input: 1_000_000, cached: 400_000, output: 0 })], { "p/m": { input: 3, output: 15 } }).usd).toBeCloseTo(3, 12);
  });

  test("a model without a price has tokens and no money, and the total says which", () => {
    const cost = costOf([line(), line({ model: "x/unpriced" })], prices);
    expect(cost.unpriced).toEqual(["x/unpriced"]);
    expect(cost.complete).toBe(false);
    expect(spendLabel([line(), line({ model: "x/unpriced" })], prices)).toMatch(/no price for x\/unpriced$/);
    // A call nobody counted makes the money a lower bound too.
    const partial = costOf([line({ calls: 2, unknown: 1 })], prices);
    expect(partial.complete).toBe(false);
    expect(spendLabel([line({ calls: 2, unknown: 1 })], prices)).toMatch(/at least \$/);
    // A line whose every call went unreported needs no price: there's nothing to price.
    expect(costOf([line({ model: "x/unpriced", calls: 1, unknown: 1, input: 0, output: 0 })], prices).unpriced).toEqual([]);
  });

  test("how it reads", () => {
    expect([tokensLabel(1234), tokensLabel(48_210), tokensLabel(480_000), tokensLabel(2_340_000)]).toEqual(["1,234", "48.2k", "480k", "2.34M"]);
    expect([usdLabel(0), usdLabel(0.0042), usdLabel(0.61), usdLabel(12.3), usdLabel(240)]).toEqual(["$0", "$0.0042", "$0.61", "$12.3", "$240"]);
    expect(spendLabel([line({ input: 48_210, cached: 12_000, output: 3_912, reasoning: 900 })], prices)).toBe("48.2k tokens in (12.0k cached), 3,912 out (900 reasoning) · 1 call · $0.17");
  });

  test("the contracts: a price is for provider/model or provider/*; what a trial spent is read leniently", () => {
    expect(PricedModel.safeParse("deepseek/deepseek-v4-pro").success).toBe(true);
    expect(PricedModel.safeParse("ollama/*").success).toBe(true);
    expect(PricedModel.safeParse("no-provider").success).toBe(false);
    expect(PriceSchema.parse({ input: 1, output: 2, currency: "USD" })).toEqual({ input: 1, output: 2 });
    expect(PriceSchema.safeParse({ input: -1, output: 2 }).success).toBe(false);
    expect(TrialSpent.parse({ lines: [line()], more: "from a newer node" })).toEqual({ lines: [line()] });
    expect(TrialSpent.safeParse({ lines: [{ ...line(), prompt: "never" }] }).success).toBe(false);
  });
});

describe("the Index beside what it cost", () => {
  const trial = (score: number, tokens: number | null, seconds = 600, usd: number | null = null) => ({ status: "scored", score, seconds, tokens, usd });

  test("quality per million tokens, per hour and per dollar, each with an interval that's the same every time", () => {
    const trials = [trial(1, 400_000, 600, 0.8), trial(0, 500_000, 900, 1.1), trial(1, 300_000, 500, 0.5), trial(0.5, 450_000, 700, 0.9), trial(1, 350_000, 650, 0.7)];
    const index = costIndex(trials);
    expect(index.quality).toEqual(galahadIndex([1, 0, 1, 0.5, 1]));
    expect(index.perMTok!.mean).toBeCloseTo(3.5 / 2.0, 12);
    expect(index.perHour!.mean).toBeCloseTo(3.5 / (3350 / 3600), 12);
    expect(index.perUsd!.mean).toBeCloseTo(3.5 / 4.0, 12);
    for (const i of [index.perMTok!, index.perHour!, index.perUsd!]) {
      expect(i.low).toBeLessThanOrEqual(i.mean);
      expect(i.high).toBeGreaterThanOrEqual(i.mean);
      expect(i.n).toBe(5);
    }
    expect(index.tokens).toBe(2_000_000);
    expect(index.usd).toBeCloseTo(4, 12);
    expect(costIndex(trials)).toEqual(index);
  });

  test("a trial whose cost isn't known is left out of that figure, and the figure says how many it rests on; nothing known: null", () => {
    const index = costIndex([trial(1, 400_000), trial(0, null), trial(1, 300_000)]);
    expect(index.perMTok!.n).toBe(2);
    expect(index.perMTok!.mean).toBeCloseTo(2 / 0.7, 12);
    expect(index.perUsd).toBeNull();
    expect(index.usd).toBeNull();
    expect(costIndex([trial(1, null), trial(0, null)]).perMTok).toBeNull();
    expect(ratioIndex([])).toBeNull();
    // Crashed trials say nothing about ability or its cost.
    expect(costIndex([{ status: "crashed", score: 0, seconds: 5, tokens: 10, usd: 1 }]).quality.n).toBe(0);
  });

  test("a trial's tokens count only when every call reported them; its money only when every one is priced too", () => {
    const prices = { "p/m": { input: 1, output: 1 } };
    const t = (lines: UsageLine[]) => costed({ status: "scored", score: 1, seconds: 60, spent: { lines } }, prices);
    expect(t([line()])).toMatchObject({ tokens: 1100, usd: 0.0011 });
    expect(t([line({ calls: 2, unknown: 1 })])).toMatchObject({ tokens: null, usd: null });
    expect(t([line(), line({ model: "x/unpriced" })])).toMatchObject({ tokens: 2200, usd: null });
    expect(costed({ status: "scored", score: 1, seconds: 60 }, prices)).toMatchObject({ tokens: null, usd: null });
  });

  test("the rule: one wins only if its interval clears the other's", () => {
    const i = (low: number, high: number, n = 14) => ({ low, high, n });
    expect(compareIntervals(i(0.3, 0.5), i(0.6, 0.8))).toBe("helps");
    expect(compareIntervals(i(0.6, 0.8), i(0.3, 0.5))).toBe("hurts");
    expect(compareIntervals(i(0.3, 0.6), i(0.5, 0.8))).toBe("none");
    expect(compareIntervals(i(0.3, 0.5, 1), i(0.6, 0.8))).toBe("unmeasured");
  });
});

describe("a run's settings, and variants of the harness", () => {
  test("named variants differ from the baseline by one switch; yours are spelled over it", () => {
    expect(parseVariant("no-gates")).toEqual({ name: "no-gates", options: VARIANTS["no-gates"]! });
    expect(describeVariant(VARIANTS["no-gates"]!)).toBe("gates off");
    expect(describeVariant(VARIANTS.baseline!)).toBe("as the baseline");
    const mine = parseVariant("mine:gates=off,skills=on,effort=2,planner-gates=on,revisions=1,archive=no");
    expect(mine).toEqual({ name: "mine", options: { gates: false, plannerGates: true, effort: 2, skills: true, archive: false, revisions: 1, engram: false, diff: false, escalate: false, remind: false, keepReads: false, tools: false, contract: false, agent: null, planner: true, review: true } });
    expect(describeVariant(mine.options)).toBe("gates off, the planner's own gates, effort 2, skills offered, no archive context, 1 revision");
    expect(() => parseVariant("warp")).toThrow(/no variant "warp"/);
    expect(() => parseVariant("mine:warp=on")).toThrow(/no harness switch "warp"/);
    expect(() => parseVariant("mine:gates=maybe")).toThrow(/gates is on or off/);
    expect(() => parseVariant("mine:effort=9")).toThrow();
    expect(() => parseVariant("baseline:gates=off")).toThrow(/comes built in/);
  });

  test("the notes store is a switch of its own: off in the baseline and in every variant but the one named for it, and yours to spell", () => {
    expect(VARIANTS.baseline!.engram).toBe(false);
    expect(parseVariant("engram")).toEqual({ name: "engram", options: { ...VARIANTS.baseline!, engram: true } });
    expect(describeVariant(VARIANTS.engram!)).toBe("the notes store (Engram)");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.engram]).toEqual([name, name === "engram"]);
    expect(parseVariant("mine:engram=on,gates=off").options).toEqual({ ...VARIANTS["no-gates"]!, engram: true });
    expect(parseVariant("mine:engram=off").options).toEqual(VARIANTS.baseline!);
    expect(() => parseVariant("mine:engram=3.7.2")).toThrow(/engram is on or off/);
    expect(() => parseVariant("mine:warp=on")).toThrow(/there is: gates, planner-gates, effort, skills, archive, revisions, engram, diff/);
  });

  test("showing the reviewer the work itself is a switch of its own: off in the baseline, on in the variant named for it", () => {
    expect(VARIANTS.baseline!.diff).toBe(false);
    expect(parseVariant("shown-diff")).toEqual({ name: "shown-diff", options: { ...VARIANTS.baseline!, diff: true } });
    expect(describeVariant(VARIANTS["shown-diff"]!)).toBe("the reviewer is shown the diff");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.diff]).toEqual([name, name === "shown-diff"]);
    expect(parseVariant("mine:diff=on,revisions=0").options).toEqual({ ...VARIANTS["no-revisions"]!, diff: true });
    expect(() => parseVariant("mine:diff=whole")).toThrow(/diff is on or off/);
  });

  test("moving the work to the planner when a gate fails twice in a row is a switch of its own: off in the baseline, on in the variant named for it", () => {
    expect(VARIANTS.baseline!.escalate).toBe(false);
    expect(parseVariant("escalate")).toEqual({ name: "escalate", options: { ...VARIANTS.baseline!, escalate: true } });
    expect(describeVariant(VARIANTS.escalate!)).toBe("a gate failing twice moves the work to the planner");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.escalate]).toEqual([name, name === "escalate"]);
    expect(parseVariant("mine:escalate=on,revisions=3").options).toEqual({ ...VARIANTS.baseline!, escalate: true, revisions: 3 });
    expect(() => parseVariant("mine:escalate=up")).toThrow(/escalate is on or off/);
  });

  test("saying the quest's constraints again every ten commands is a switch of its own: off in the baseline, on in the variant named for it", () => {
    expect(VARIANTS.baseline!.remind).toBe(false);
    expect(parseVariant("remind")).toEqual({ name: "remind", options: { ...VARIANTS.baseline!, remind: true } });
    expect(describeVariant(VARIANTS.remind!)).toBe("the quest's constraints said again every ten commands");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.remind]).toEqual([name, name === "remind"]);
    expect(parseVariant("mine:remind=on,escalate=on").options).toEqual({ ...VARIANTS.baseline!, remind: true, escalate: true });
    expect(() => parseVariant("mine:remind=often")).toThrow(/remind is on or off/);
    expect(() => parseVariant("mine:warp=on")).toThrow(/there is: gates, planner-gates, effort, skills, archive, revisions, engram, diff, escalate, remind, keep-reads/);
  });

  test("keeping current file reads whole is a switch of its own: off in the baseline, on in the variant named for it", () => {
    expect(VARIANTS.baseline!.keepReads).toBe(false);
    expect(parseVariant("keep-reads")).toEqual({ name: "keep-reads", options: { ...VARIANTS.baseline!, keepReads: true } });
    expect(describeVariant(VARIANTS["keep-reads"]!)).toBe("current file reads kept whole");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.keepReads]).toEqual([name, name === "keep-reads"]);
    expect(parseVariant("mine:keep-reads=on,remind=on").options).toEqual({ ...VARIANTS.baseline!, keepReads: true, remind: true });
    expect(() => parseVariant("mine:keep-reads=all")).toThrow(/keep-reads is on or off/);
  });

  test("contract first is a switch of its own: off in the baseline; its variant withholds a task's gates, so it differs from no-gates by it alone", () => {
    expect(VARIANTS.baseline!.contract).toBe(false);
    expect(parseVariant("contract")).toEqual({ name: "contract", options: { ...VARIANTS["no-gates"]!, contract: true } });
    expect(describeVariant(VARIANTS.contract!)).toBe("gates off, where no gate fails before the work, the planner writes a test that does");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.contract]).toEqual([name, name === "contract"]);
    expect(parseVariant("mine:contract=on").options).toEqual({ ...VARIANTS.baseline!, contract: true });
    expect(() => parseVariant("mine:contract=maybe")).toThrow(/contract is on or off/);
    expect(() => parseVariant("mine:warp=on")).toThrow(/keep-reads, tools, contract, agent, planner, review\)/);
  });

  test("the engineer's own tools are a switch of their own: off in the baseline, on in their variant", () => {
    expect(VARIANTS.baseline!.tools).toBe(false);
    expect(parseVariant("tools")).toEqual({ name: "tools", options: { ...VARIANTS.baseline!, tools: true } });
    expect(parseVariant("mine:tools=on,planner=off").options).toEqual({ ...VARIANTS.baseline!, tools: true, planner: false });
    expect(describeVariant(VARIANTS.tools!)).toBe("the engineer's own tools, several calls a turn");
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.tools]).toEqual([name, name === "tools"]);
  });

  test("a coding tool alone is three switches, each its own: who does the work, a plan, a reviewer; the opencode variant turns all of Galahad off", () => {
    expect([VARIANTS.baseline!.agent, VARIANTS.baseline!.planner, VARIANTS.baseline!.review]).toEqual([null, true, true]);
    expect(VARIANTS.opencode).toEqual({ ...VARIANTS.bare!, agent: "opencode", planner: false, review: false });
    expect(describeVariant(VARIANTS.opencode!)).toBe("gates off, no archive context, no revisions, opencode does the work, no plan, no reviewer");
    // No other variant names a tool, or goes without the planner or the reviewer.
    for (const [name, options] of Object.entries(VARIANTS)) expect([name, options.agent, options.planner, options.review]).toEqual(name === "opencode" ? [name, "opencode", false, false] : [name, null, true, true]);
    expect(parseVariant("mine:agent=claude,review=off").options).toEqual({ ...VARIANTS.baseline!, agent: "claude", review: false });
    expect(parseVariant("mine:agent=off,planner=no").options).toEqual({ ...VARIANTS.baseline!, planner: false });
    expect(describeVariant(parseVariant("mine:agent=codex,planner=off").options)).toBe("codex does the work, no plan");
    expect(() => parseVariant("mine:agent=Claude Code")).toThrow(/a coding tool's name/);
    expect(() => parseVariant("mine:review=later")).toThrow(/review is on or off/);
  });

  test("a run recorded before a switch existed still reads as it was run (a new switch off, its planner and reviewer on): nothing recorded is refused or changed by a new one", () => {
    // A run's settings as the log holds them from before 14 November 2026: six switches, no notes store.
    const old = { effort: 1, parallel: 2, variant: { name: "no-gates", options: { gates: false, plannerGates: false, effort: 1 as const, skills: false, archive: true, revisions: 2 } }, seed: 9, group: "g-old1" };
    const read = TrialRunSettings.parse(old);
    expect(read.variant).toEqual({ name: "no-gates", options: { ...old.variant.options, engram: false, diff: false, escalate: false, remind: false, keepReads: false, tools: false, contract: false, agent: null, planner: true, review: true } });
    expect(read.variant!.options).toEqual(VARIANTS["no-gates"]!);
    expect(describeVariant(read.variant!.options)).toBe("gates off");
    // An older terminal's request to start a run names six switches too: taken, with the store off.
    const asked = routes.startTrialRun.input.parse({ run: "r-old1", suite: "agentic", effort: 1, variant: old.variant });
    expect(asked.variant!.options.engram).toBe(false);
    expect(asked.variant!.options.diff).toBe(false);
    expect(asked.variant!.options.escalate).toBe(false);
    // Still strict about what it doesn't know.
    expect(routes.startTrialRun.input.safeParse({ run: "r-old1", suite: "agentic", effort: 1, variant: { name: "x", options: { ...old.variant.options, warp: true } } }).success).toBe(false);
  });

  test("settings are read leniently: what a newer node adds is left out, never refused", () => {
    const read = TrialRunSettings.parse({ effort: 2, parallel: 4, pins: { engineer: "p/m" }, variant: { name: "mine", options: { ...VARIANTS.baseline!, warp: 9 } }, seed: 7, group: "g-abc", budget: { tokens: 1000 }, later: true });
    expect(read).toEqual({ effort: 2, parallel: 4, pins: { engineer: "p/m" }, variant: { name: "mine", options: VARIANTS.baseline! }, seed: 7, group: "g-abc", budget: { tokens: 1000 } });
    expect(TrialRunSettings.parse({ effort: 3 })).toEqual({ effort: 3 });
  });
});
