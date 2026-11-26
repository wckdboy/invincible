import { describe, expect, test } from "bun:test";
import { runNotifySim } from "./sim.ts";

/*
 * The notify suite's week (bench/notify/sim.ts), at two days: the real rules and the real notifier in virtual time,
 * with a stand-in owner who answers only what reached them. `bun run bench notify` runs the whole week.
 */

describe("a week of notifications (deterministic simulation)", () => {
  test("every ask is answered, missed or still standing; nothing is answered that never reached the owner", async () => {
    const r = await runNotifySim({ seed: 3, days: 2 });
    expect(r.problems).toEqual([]);
    expect(r.asks).toBeGreaterThan(3);
    expect(r.answered + r.missed).toBeLessThanOrEqual(r.asks);
    expect(r.answerMinutes).toHaveLength(r.answered);
    expect(r.buzzes).toBeLessThanOrEqual(r.delivered);
    expect(r.completed).toBeGreaterThan(0);
  }, 30_000);

  test("the same seed gives the same week, to the minute; another seed another", async () => {
    const a = await runNotifySim({ seed: 11, days: 2 });
    const b = await runNotifySim({ seed: 11, days: 2 });
    expect(b).toEqual(a);
    const c = await runNotifySim({ seed: 12, days: 2 });
    expect(c).not.toEqual(a);
  }, 30_000);
});
