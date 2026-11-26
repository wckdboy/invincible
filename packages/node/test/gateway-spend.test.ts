import { expect, test } from "bun:test";
import { GatewaySpend } from "../src/gateway-spend.ts";

/* What tools' calls through the gateway cost lately, by caller: lines a task's budget adds to its own. */

test("by caller and model, from a moment on; a call that said nothing is a call of unknown cost; two days are kept", () => {
  let now = 1_000_000;
  const spend = new GatewaySpend(() => now);
  spend.add("sandbox:0123456789", "plan/coder", { input: 100, output: 10, cached: 50 });
  now += 1000;
  spend.add("sandbox:0123456789", "plan/coder", null);
  spend.add("sandbox:9876543210", "plan/coder", { input: 1, output: 1 });
  expect(spend.since("sandbox:0123456789", 0)).toEqual([{ role: "tool", model: "plan/coder", calls: 2, unknown: 1, input: 100, output: 10, cached: 50, reasoning: 0 }]);
  // From a moment on: what came before it isn't the task's.
  expect(spend.since("sandbox:0123456789", now)).toEqual([{ role: "tool", model: "plan/coder", calls: 1, unknown: 1, input: 0, output: 0, cached: 0, reasoning: 0 }]);
  expect(spend.since("sandbox:nobody", 0)).toEqual([]);
  // Two days on, what is older is let go as the caller's next call is kept.
  now += 49 * 60 * 60_000;
  spend.add("sandbox:0123456789", "plan/coder", { input: 5, output: 5 });
  expect(spend.since("sandbox:0123456789", 0)).toEqual([{ role: "tool", model: "plan/coder", calls: 1, unknown: 0, input: 5, output: 5, cached: 0, reasoning: 0 }]);
});
