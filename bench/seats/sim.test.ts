import { describe, expect, test } from "bun:test";
import { runSeatsSim, STEP_MS, TICK_MS } from "./sim.ts";

/*
 * The seats' week (bench/seats/sim.ts) holds to what the choice of seat promises, whatever the week: never another
 * account of a vendor's for work that began on one, never more runs on a seat than it takes, never a resting seat; the
 * same week gives the same choices; and a seat sits idle while work waits only until the controller's next look.
 */

describe("a week of your seats at work", () => {
  test("for any days and any way of choosing: the rule, the seat's runs and its rest are held to; shares are shares; replay makes the same choices", () => {
    // (Two days each, which the rule holds over as it does a week: the suite runs the whole week.)
    for (const seed of [1, 7, 20_261_112]) {
      for (const rate of [0.5, 1, 3]) {
        for (const policy of ["headroom", "first-free", "expiring"] as const) {
          const r = runSeatsSim({ seed, policy, rate, days: 2 });
          expect([r.switches, r.overConcurrency, r.restingTaken]).toEqual([0, 0, 0]);
          expect(r.proven).toBeLessThanOrEqual(r.tasks);
          expect([...r.fiveHourShare, ...r.weekShare].every((s) => s >= 0 && s <= 100)).toBe(true);
          // A seat idles while work it could take waits only until the controller looks again (resting work it takes up).
          expect(r.idleWhileWaiting).toBeLessThanOrEqual((r.rests * (TICK_MS - STEP_MS)) / 60_000 + 1e-9);
          if (policy === "headroom" && rate === 1) expect(runSeatsSim({ seed, policy, rate, days: 2 }).choices).toEqual(r.choices);
        }
      }
    }
  }, 30_000);

  test("a week that asks more than the seats hold uses nearly all of each window, and one that asks little leaves no task undone", () => {
    const backlog = runSeatsSim({ seed: 20_261_112, rate: 3 });
    expect(backlog.proven).toBeLessThan(backlog.tasks);
    expect(backlog.fiveHourShare.reduce((a, b) => a + b, 0) / backlog.fiveHourShare.length).toBeGreaterThan(95);
    const light = runSeatsSim({ seed: 20_261_112, rate: 0.5 });
    expect(light.proven).toBe(light.tasks);
  }, 30_000);
});
