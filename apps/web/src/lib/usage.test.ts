import { describe, expect, test } from "bun:test";
import { budgetWords, meterLine, moneyWords, SETTINGS_WORDS, spentWords } from "./usage.ts";

describe("money, as a phone's Settings says it", () => {
  test("always two decimals; a cent's fraction in four", () => {
    expect([moneyWords(0), moneyWords(0.0042), moneyWords(0.61), moneyWords(12.3), moneyWords(36.6), moneyWords(240)]).toEqual(["$0.00", "$0.0042", "$0.61", "$12.30", "$36.60", "$240.00"]);
  });
  test("rounded on the number's exact value, a true half up, as every app rounds it", () => {
    // 1.005 is a little under 1.005 as a double; 0.125 is exactly half way.
    expect([moneyWords(1.005), moneyWords(0.125), moneyWords(2.675)]).toEqual(["$1.00", "$0.13", "$2.67"]);
  });
});

describe("the usage meter in one line", () => {
  const meter = (spentUsd: number, budgetUsd: number | null, complete = true) => ({ spentUsd, budgetUsd, complete, tokens: 1_204_000 });
  test("what the period came to against the budget, and what is left", () => {
    expect(meterLine(meter(0.4, 1))).toBe("$0.40 of $1.00 · $0.60 left");
    expect(meterLine(meter(1, 1))).toBe("$1.00 of $1.00 · all spent");
  });
  test("over the budget reads as over budget, \"at least\" first where some calls had no price", () => {
    expect(meterLine(meter(36.6, 1, false))).toBe("At least $36.60 of $1.00 · over budget");
    expect(meterLine(meter(36.6, 1))).toBe("$36.60 of $1.00 · over budget");
  });
  test("with no budget, what it came to and its tokens", () => {
    expect(meterLine(meter(36.6, null))).toBe("$36.60 · 1.20M tokens · no budget");
    expect(meterLine(meter(0, null, false))).toBe("$0.00 · 1.20M tokens · no budget");
  });
});

describe("the meter split, its figure and the line under it", () => {
  const meter = (spentUsd: number, budgetUsd: number | null, complete = true) => ({ spentUsd, budgetUsd, complete, tokens: 1_204_000 });
  test("the figure: what it came to, \"At least\" where some calls had no price, never of $0", () => {
    expect(spentWords(meter(36.6, 1, false))).toBe("At least $36.60");
    expect(spentWords(meter(0, null, false))).toBe("$0.00");
  });
  test("the figure where a handed task's call was counted at its most (its provider silent in time): \"At most\", \"About\" beside one unreported, never of $0", () => {
    expect(spentWords({ ...meter(0.3, 2), atMost: true })).toBe("At most $0.30");
    expect(spentWords({ ...meter(0.3, 2, false), atMost: true })).toBe("About $0.30");
    expect(spentWords({ ...meter(0, 2), atMost: true })).toBe("$0.00");
    expect(meterLine({ ...meter(0.3, 2), atMost: true })).toBe("At most $0.30 of $2.00 · $1.70 left");
  });
  test("under it: of what budget and what is left, all spent, or over budget; with none, its tokens", () => {
    expect(budgetWords(meter(0.4, 1))).toBe("of $1.00 · $0.60 left");
    expect(budgetWords(meter(1, 1))).toBe("of $1.00 · all spent");
    expect(budgetWords(meter(36.6, 1))).toBe("of $1.00 · over budget");
    expect(budgetWords(meter(36.6, null))).toBe("1.20M tokens · no budget");
  });
});

describe("Settings' words, every app's", () => {
  test("what a device may do is \"Can do\", never a month's \"May\"; a read-only page says so in one line", () => {
    expect(SETTINGS_WORDS.scopes).toBe("Can do");
    expect(SETTINGS_WORDS.readOnly).toBe("Read-only for now: adding and changing come next.");
  });
});
