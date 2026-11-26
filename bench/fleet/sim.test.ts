import { describe, expect, test } from "bun:test";
import { growthExponent } from "../suites/fleet.ts";
import { runFleetSim } from "./sim.ts";

/*
 * The deterministic multi-node simulation (docs/TRIALS.md, L0), at a small size:
 * real replicas, the real sync engine and the real door over a network that
 * delays, reorders, duplicates, drops and partitions, with a node away for a
 * long while, clocks ahead inside and beyond the five minutes, a revoked device
 * that keeps talking and a stranger. Every replica in good standing must end as
 * the same mind, with exactly the right events counting. `bun run bench fleet`
 * runs the same thing at 2 to 16 nodes (32 with --full) and reports what it cost.
 */

/** A run is seconds of signing and verifying, more on a busy machine: never a reason to fail. */
const PATIENT = 180_000;

describe("a fleet under a hostile network (deterministic simulation)", () => {
  for (const [nodes, seed] of [[5, 1], [4, 7]] as const) {
    test(`${nodes} nodes, seed ${seed}: every replica converges, nothing that should count is refused and nothing that shouldn't counts`, async () => {
      const r = await runFleetSim({ seed, nodes, events: 80 });
      expect(r.problems).toEqual([]);
      expect(r.converged).toBe(1);
      expect(r.wronglyRejected).toBe(0);
      expect(r.missing).toBe(0);
      expect(r.wronglyKept).toBe(0);
      expect(r.foreignStored).toBe(0);
      // The hazards really happened: a device was revoked and went on talking, requests were refused at the door.
      expect(r.revoked).toBe(true);
      expect(r.refused).toBeGreaterThan(nodes);
      // A healed partition, a returning node and a clock put right each converge within a few rounds of pulls.
      for (const rounds of [r.healRounds, r.rejoinRounds, r.driftRounds]) {
        expect(rounds).toBeGreaterThanOrEqual(0);
        expect(rounds).toBeLessThanOrEqual(3);
      }
      expect(r.rejoinBacklog).toBeGreaterThan(10);
      // What a clock 20 minutes ahead wrote is refused (the log takes at most 5 minutes ahead) and then accepted: about 15 minutes on.
      expect(r.farClockMuteS).toBeGreaterThanOrEqual(14 * 60);
      expect(r.farClockMuteS).toBeLessThanOrEqual(17 * 60);
    }, PATIENT);
  }

  test("two nodes, and three: the smallest fleets converge too (two have nobody to revoke)", async () => {
    const two = await runFleetSim({ seed: 3, nodes: 2, events: 40 });
    expect(two.problems).toEqual([]);
    expect(two.converged).toBe(1);
    expect(two.revoked).toBe(false);
    const three = await runFleetSim({ seed: 3, nodes: 3, events: 40 });
    expect(three.problems).toEqual([]);
    expect(three.converged).toBe(1);
    expect(three.revoked).toBe(true);
  }, PATIENT);

  test("two at once are refused: a run owns the clock and the random source", async () => {
    const first = runFleetSim({ seed: 9, nodes: 2, events: 20 });
    await expect(runFleetSim({ seed: 9, nodes: 2, events: 20 })).rejects.toThrow(/already running/);
    expect((await first).converged).toBe(1);
  }, PATIENT);

  test("the same seed gives the same run to the last byte, another seed another; the clock and the random source are put back", async () => {
    const now = Date.now;
    const random = crypto.getRandomValues;
    const a = await runFleetSim({ seed: 11, nodes: 3, events: 40 });
    const b = await runFleetSim({ seed: 11, nodes: 3, events: 40 });
    const counts = (r: typeof a) => ({ digest: r.digest, logSize: r.logSize, bytes: r.bytes, requests: r.requests, refused: r.refused, carried: r.eventsCarried, needed: r.eventsNeeded, replays: r.replays, idle: r.idleRoundBytes, phases: r.phases });
    expect(counts(b)).toEqual(counts(a));
    const c = await runFleetSim({ seed: 12, nodes: 3, events: 40 });
    expect(c.digest).not.toBe(a.digest);
    expect(c.converged).toBe(1);
    expect(Date.now).toBe(now);
    expect(crypto.getRandomValues).toBe(random);
    expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(5_000);
  }, PATIENT);

  test("a push that overtook its predecessor waits for the pull: taken as it came (as nodes once did), the same run replays the log several times as often", async () => {
    const now = await runFleetSim({ seed: 5, nodes: 4, events: 100 });
    const before = await runFleetSim({ seed: 5, nodes: 4, events: 100, pushesAsTheyCome: true });
    expect(now.converged).toBe(1);
    expect(before.converged).toBe(1);
    expect(before.replays).toBeGreaterThan(now.replays * 3);
  }, PATIENT);

  test("a growth exponent is the slope on a log-log plot", () => {
    expect(growthExponent([[2, 4], [4, 16], [8, 64]])).toBeCloseTo(2, 12);
    expect(growthExponent([[2, 10], [4, 20], [8, 40], [16, 80]])).toBeCloseTo(1, 12);
    expect(growthExponent([[2, 7], [16, 7]])).toBeCloseTo(0, 12);
  });
});
