import { describe, expect, test } from "bun:test";
import { spentWindowLine, spentWindowLines } from "./usage-windows.ts";

/* A spent allowance in the usage meter's words: what the node was told, until when, and how long from now. */

describe("a spent allowance in the meter's words", () => {
  test("says the provider, until when in UTC, and how long from now", () => {
    const window = { provider: "opencode-go", until: Date.parse("2026-11-15T23:25:00Z"), said: "quota exhausted; resets in 5h" };
    expect(spentWindowLine(window, Date.parse("2026-11-14T12:29:00Z"))).toBe(
      "opencode-go: its allowance is spent until 23:25 UTC (34h 56m from now), as its provider said",
    );
  });

  test("a line for each, none for none", () => {
    const windows = [
      { provider: "opencode-go", until: Date.parse("2026-11-15T23:25:00Z"), said: "…" },
      { provider: "openai", until: Date.parse("2026-11-14T13:00:00Z"), said: "…" },
    ];
    expect(spentWindowLines(windows, Date.parse("2026-11-14T12:00:00Z"))).toEqual([
      "opencode-go: its allowance is spent until 23:25 UTC (35h 25m from now), as its provider said",
      "openai: its allowance is spent until 13:00 UTC (1h from now), as its provider said",
    ]);
    expect(spentWindowLines(undefined, 0)).toEqual([]);
  });
});
