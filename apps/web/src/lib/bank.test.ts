import { describe, expect, test } from "bun:test";
import type { BankStatusView } from "@galahad/core";
import { budgetLabel, consentLeft, offReason, readBankCallback } from "./bank.ts";

const status = (over: Partial<BankStatusView> = {}): BankStatusView => ({
  configured: true,
  problem: null,
  aspsp: "Mock ASPSP",
  accounts: [],
  validUntil: null,
  daysRemaining: null,
  reauthorizationRequired: false,
  budget: [],
  message: "",
  ...over,
});

describe("the bank's return", () => {
  test("the code and state, cut to size", () => {
    expect(readBankCallback("?code=abc&state=" + "s".repeat(100))).toEqual({ code: "abc", state: "s".repeat(64), error: null });
  });

  test("a refusal at the bank reads as one sentence, without control characters", () => {
    const back = readBankCallback("?error=access_denied&error_description=" + encodeURIComponent("User\ncancelled"));
    expect(back).toEqual({ code: null, state: null, error: "access_denied: User cancelled" });
  });
});

describe("the consent", () => {
  test("what's left of the 89 days, between 0 and 1", () => {
    expect(consentLeft(status({ daysRemaining: 89 }))).toBe(1);
    expect(consentLeft(status({ daysRemaining: 0 }))).toBe(0);
    expect(consentLeft(status({ daysRemaining: null }))).toBe(0);
    expect(consentLeft(status({ daysRemaining: 200 }))).toBe(1);
  });

  test("an account's fetches, cache age and any pause the bank asked for", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(budgetLabel({ account: "a", remaining: 4, perDay: 4, cacheAgeSeconds: null, coolingDownUntil: null }, now)).toBe("4 of 4 background fetches left today · nothing cached yet");
    expect(budgetLabel({ account: "a", remaining: 2, perDay: 4, cacheAgeSeconds: 600, coolingDownUntil: null }, now)).toBe("2 of 4 background fetches left today · cache 10 min old");
    expect(budgetLabel({ account: "a", remaining: 0, perDay: 4, cacheAgeSeconds: 3 * 3600, coolingDownUntil: "2026-11-10T18:00:00Z" }, now)).toMatch(/cache 3 h old · the bank asked for a pause until/);
    expect(budgetLabel({ account: "a", remaining: 0, perDay: 4, cacheAgeSeconds: 60, coolingDownUntil: "2026-11-10T06:00:00Z" }, now)).not.toMatch(/pause/);
  });
});

describe("bank access that's off", () => {
  test("says the node's reason once, as a sentence, without repeating that it's off", () => {
    expect(offReason("Bank access is off: bank access runs on Linux or macOS nodes only: file permissions can't be enforced here")).toBe("Bank access runs on Linux or macOS nodes only: file permissions can't be enforced here.");
    expect(offReason("the key file is readable by others.")).toBe("The key file is readable by others.");
  });
});
