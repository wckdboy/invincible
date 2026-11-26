import { describe, expect, test } from "bun:test";
import type { LedgerEntry } from "../types.ts";
import { type LedgerFilter, ledgerFilterSummary, ledgerMatches, ledgerSignature } from "./activity.ts";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "e1",
  hlc: "001731300000000.000001",
  device: "dev-ultra",
  class: "outward",
  resource: "connector.forge",
  target: "POST /posts",
  verdict: "ask",
  reason: "outward actions ask first",
  quest: "q-release",
  detail: '{"channel":"general"}',
  ...over,
});
const all = (query = ""): LedgerFilter => ({ classes: new Set(), verdict: "all", query });

describe("the activity timeline's search", () => {
  test("finds a row by anything the row shows: its node, its kind, its verdict, its details", () => {
    const e = entry();
    for (const q of ["forge", "posts", "q-release", "ultra", "outward", "asked you", "general", "ask first"]) expect(ledgerMatches(e, all(q), "ultra")).toBe(true);
    expect(ledgerMatches(e, all("denied"), "ultra")).toBe(false);
  });

  test("every word must match somewhere, in any case and order", () => {
    expect(ledgerMatches(entry(), all("ULTRA forge"), "ultra")).toBe(true);
    expect(ledgerMatches(entry(), all("forge laptop"), "ultra")).toBe(false);
  });

  test("kinds and the verdict narrow it", () => {
    const e = entry();
    expect(ledgerMatches(e, { classes: new Set(["outward", "delete"]), verdict: "all", query: "" }, "ultra")).toBe(true);
    expect(ledgerMatches(e, { classes: new Set(["read"]), verdict: "all", query: "" }, "ultra")).toBe(false);
    expect(ledgerMatches(e, { classes: new Set(), verdict: "deny", query: "" }, "ultra")).toBe(false);
  });

  test("the filter says what it shows in plain words", () => {
    expect(ledgerFilterSummary(all())).toBe("All activity");
    expect(ledgerFilterSummary({ classes: new Set(["outward"]), verdict: "all" })).toBe("Outward");
    expect(ledgerFilterSummary({ classes: new Set(["outward", "delete"]), verdict: "ask" })).toBe("Outward, Delete · asked you");
    expect(ledgerFilterSummary({ classes: new Set(["read", "create", "modify"]), verdict: "all" })).toBe("3 kinds");
    expect(ledgerFilterSummary({ classes: new Set(), verdict: "deny" })).toBe("Denied");
  });

  test("a refresh that brings nothing new is recognised, so the list isn't rebuilt", () => {
    expect(ledgerSignature([entry(), entry({ id: "e2" })])).toBe(ledgerSignature([entry(), entry({ id: "e2" })]));
    expect(ledgerSignature([entry()])).not.toBe(ledgerSignature([entry(), entry({ id: "e2" })]));
  });
});
