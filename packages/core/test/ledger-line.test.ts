// A ledger line within the log's limits (ledger.recorded, events.ts): its words clipped where they would be too long, so
// no line is refused for its length and left unrecorded (the re-review of 27 November, A4).
import { expect, test } from "bun:test";
import { Bodies, fitLedger, LEDGER_LIMITS } from "../src/index.ts";

test("a line's words past the log's limits are clipped, never refused: its target, its reason, its detail", () => {
  const line = { class: "read" as const, resource: "connector.github", target: `GET /repos/o/r/git/ref/heads/${"b".repeat(400)}`, verdict: "allow" as const, reason: "r".repeat(900), run: "arm.coder", detail: "d".repeat(5000) };
  expect(Bodies["ledger.recorded"].safeParse(line).success).toBe(false);
  const fitted = fitLedger(line);
  expect(Bodies["ledger.recorded"].safeParse(fitted).success).toBe(true);
  expect([fitted.target.length, fitted.reason.length, fitted.detail.length]).toEqual([LEDGER_LIMITS.target, LEDGER_LIMITS.reason, LEDGER_LIMITS.detail]);
  expect([fitted.target.endsWith("…"), fitted.resource, fitted.run, fitted.verdict]).toEqual([true, "connector.github", "arm.coder", "allow"]);
  // A cut never leaves half a character.
  const emoji = fitLedger({ ...line, detail: `${"x".repeat(LEDGER_LIMITS.detail - 2)}😀😀` }).detail;
  expect([emoji.endsWith("x…"), emoji.length]).toEqual([true, LEDGER_LIMITS.detail - 1]);
  // A line within them is as it was.
  const short = { class: "read" as const, resource: "x", target: "t", verdict: "allow" as const, detail: "d" };
  expect(fitLedger(short)).toEqual(short);
});
