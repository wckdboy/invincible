import { describe, expect, test } from "bun:test";
import { drawQuests, MACHINES, runComputeSim } from "./sim.ts";

/*
 * The fleet's compute in virtual time, at a small size: the real census,
 * placement, slot admission and model-call rationing, with stand-in work.
 * `bun run bench compute` runs the same thing over whole trial runs and long
 * queues and reports what a machine buys.
 */

describe("a queue of quests on a fleet (deterministic simulation)", () => {
  test("no host is ever over its ceiling, a node told to take none gets none, nothing is lost or starved, and each host serves in turn", async () => {
    for (const effort of [1, 2, 3] as const) {
      const r = await runComputeSim({ seed: 7, nodes: 8, quests: 20, effort, parallel: "slots" });
      expect(r.overCeiling).toBe(0);
      expect(r.onClosedNode).toBe(0);
      expect(r.ran.annex).toBe(0);
      expect(r.lost).toBe(0);
      expect(r.unfinished).toBe(0);
      expect(r.queueJumps).toBe(0);
      // Every attempt ran somewhere, and the owner's ceiling of one sandbox was one at a time (checked at every instant, above).
      expect(Object.values(r.ran).reduce((a, b) => a + b, 0)).toBe(20 * effort);
      expect(r.ran.vault).toBeGreaterThan(0);
      // No schedule beats the bound; this one is within reach of it.
      expect(r.makespanS).toBeGreaterThanOrEqual(r.lowerBoundS);
    }
  });

  test("the same seed gives the same run; the fleet doesn't change the quests", async () => {
    const a = await runComputeSim({ seed: 3, nodes: 4, quests: 16, effort: 2, parallel: "slots" });
    const b = await runComputeSim({ seed: 3, nodes: 4, quests: 16, effort: 2, parallel: "slots" });
    expect({ ...b, placeMs: [], placeSpan: [0, 0] }).toEqual({ ...a, placeMs: [], placeSpan: [0, 0] });
    expect(drawQuests(3, 16, 2)).toEqual(drawQuests(3, 16, 2));
    expect(drawQuests(4, 16, 2)).not.toEqual(drawQuests(3, 16, 2));
    // Every attempt at a quest is the same size of work.
    for (const quest of drawQuests(3, 16, 3)) expect(new Set(quest.attempts.map((x) => JSON.stringify(x))).size).toBe(1);
  });

  test("more machines finish a queue sooner, and slots decide how many trials run at once", async () => {
    const times: number[] = [];
    for (const nodes of [1, 2, 8]) {
      const r = await runComputeSim({ seed: 5, nodes, quests: 24, effort: 1, parallel: "slots" });
      expect(r.parallel).toBe(Math.min(24, r.slots));
      times.push(r.makespanS);
    }
    expect(times[1]!).toBeLessThan(times[0]! * 0.6);
    expect(times[2]!).toBeLessThan(times[1]!);
    // The slots the fleet's machines carry at their default ceilings (half of each), and the owner's two ceilings.
    const eight = await runComputeSim({ seed: 5, nodes: 8, quests: 8, effort: 1, parallel: "slots" });
    expect(eight.slots).toBe(3 + 6 + 1 + 1 + 5 + 2 + 1 + 0);
    expect(MACHINES).toHaveLength(8);
    // --parallel auto runs at most eight trials at once, whatever the slots.
    expect((await runComputeSim({ seed: 5, nodes: 8, quests: 24, effort: 1, parallel: "auto" })).parallel).toBe(8);
  });

  test("placement counts what the asking node itself sent since a host reported: without it, a burst queues on one host while others stand idle", async () => {
    const run = (extra: object) => runComputeSim({ seed: 11, nodes: 8, quests: 30, effort: 3, parallel: "slots", ...extra });
    const now = await run({});
    const live = await run({ knowledge: "live" });
    const before = await run({ forgetSent: true });
    // As good as knowing every host's slots this instant: nothing waits while a slot is free.
    expect(now.idleWhileWaiting).toBe(0);
    expect(now.maxWaitS).toBe(0);
    expect(now.makespanS).toBe(live.makespanS);
    // As nodes did before: sandboxes waited many minutes on the best host with slots free elsewhere, and the run took longer.
    expect(before.idleWhileWaiting).toBeGreaterThan(0.1);
    expect(before.maxWaitS).toBeGreaterThan(600);
    expect(before.makespanS).toBeGreaterThan(now.makespanS * 1.05);
    for (const r of [now, live, before]) expect(r.overCeiling + r.lost + r.unfinished).toBe(0);
  });

  test("past the asked node's model calls, another machine buys little until that ceiling is raised", async () => {
    const nine = [...MACHINES, { ...MACHINES[1]!, name: "rack-two" }];
    const perHour = async (nodes: number, modelCalls?: number) => {
      const r = await runComputeSim({ seed: 2, nodes, machines: nine, quests: 200, effort: 1, parallel: "slots", ...(modelCalls ? { modelCalls } : {}) });
      return 200 / (r.makespanS / 3600);
    };
    const [eight, ninth, eightRaised, ninthRaised] = [await perHour(8), await perHour(9), await perHour(8, 32), await perHour(9, 32)];
    expect(ninth / eight).toBeLessThan(1.1);
    expect(ninthRaised / eightRaised).toBeGreaterThan(1.2);
    expect(eightRaised).toBeGreaterThan(eight * 1.1);
  });
});
