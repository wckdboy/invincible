import { type FleetSimResult, runFleetSim } from "../fleet/sim.ts";
import type { Suite, SuiteContext } from "../lib.ts";

/*
 * The fleet: can the mind grow to more devices? N replicas exchange real signed
 * events through the real sync engine over an in-memory network that reorders,
 * duplicates, drops, partitions and heals, with a node that's away for a long
 * while, clocks that run ahead, a revoked device that keeps talking and a
 * stranger at the door (bench/fleet/sim.ts). Two curves: the same work on fleets
 * of 2 to 16 (32 with --full), and a fleet of four on a log three times the size
 * (up to twenty-four times with --full).
 *
 * Quality is exact: the simulation is deterministic to the last byte, so rounds,
 * events and bytes are counts, not timings, and any change in them is a change
 * in how sync behaves.
 */

/** The shared workload on the fleets of growing size. */
const EVENTS = 160;
const FLEETS = [2, 4, 8, 16];
const FLEETS_FULL = [32];
/** A fleet of four on logs of growing size (the first point is the fleets' own run of 160). */
const LOGS = [480];
const LOGS_FULL = [960, 1920, 3840];

/** The slope of log y against log x, by least squares: 1 is linear, 2 quadratic. */
export function growthExponent(points: readonly [number, number][]): number {
  const xs = points.map(([x]) => Math.log(x));
  const ys = points.map(([, y]) => Math.log(y));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return num / den;
}

function record(ctx: SuiteContext, prefix: string, r: FleetSimResult): void {
  const note = `${r.nodes} nodes, ${r.logSize} events in the log`;
  // Did every replica end as the same mind, with exactly the right events counting?
  ctx.quality(`${prefix}.converged`, r.converged, "", "higher", { note: r.problems.length ? r.problems.slice(0, 3).join("; ").slice(0, 280) : note });
  ctx.quality(`${prefix}.wrongly-rejected`, r.wronglyRejected + r.missing, "events", "lower", { note: "events of nodes in good standing that a replica refuses or lacks" });
  ctx.quality(`${prefix}.wrongly-kept`, r.wronglyKept + r.foreignStored, "events", "lower", { note: `a revoked device's later events that count, or a stranger's that are stored (${r.refusedHeld} of the revoked device's are held, and refused)` });
  // What sync cost.
  ctx.quality(`${prefix}.heal-rounds`, r.healRounds, "rounds", "lower", { note: "pulls after a partition heals until all agree" });
  ctx.quality(`${prefix}.rejoin-rounds`, r.rejoinRounds, "rounds", "lower", { note: `a node back after a long while, ${r.rejoinBacklog} events behind, in ${r.rejoinRequests} requests` });
  ctx.quality(`${prefix}.drift-rounds`, r.driftRounds, "rounds", "lower", { note: "after a clock three minutes ahead is put right" });
  ctx.quality(`${prefix}.far-clock-mute`, r.farClockMuteS, "s", "lower", { note: "after a clock 20 minutes ahead is put right, until what it wrote is accepted (the log refuses more than 5 minutes ahead)" });
  ctx.quality(`${prefix}.redundancy`, r.eventsCarried / r.eventsNeeded, "×", "lower", { note: `events carried (${r.eventsCarried}) for each a perfect sync needs (${r.eventsNeeded})` });
  ctx.quality(`${prefix}.bytes-per-event`, r.bytes / r.eventsNeeded, "B", "lower", { note: "all bytes on the wire, for each event a replica needed" });
  ctx.quality(`${prefix}.replays-per-node`, r.replays / (r.nodes - (r.revoked ? 1 : 0)), "replays", "lower", { note: "full replays of the log a replica made (an arrival that couldn't be applied in place)" });
  ctx.quality(`${prefix}.idle-round-bytes-per-node`, r.idleRoundBytes / r.nodes, "B", "lower", { note: `one quiet round (every 5 s): ${r.idleRoundRequests} requests, ${r.idleRoundBytes} bytes in all` });
  ctx.speed(`${prefix}.idle-round`, r.idleRoundMs, "ms", "lower", r.spans.idle, "one quiet round, the whole fleet in this process");
  ctx.speed(`${prefix}.write-fanout`, r.writeFanoutMs, "ms", "lower", r.spans.fanout, "one event written, pushed to and taken by every replica");
  ctx.speed(`${prefix}.run`, [r.wallMs], "ms", "lower", r.spans.run, "the whole simulation, once");
}

export const suite: Suite = {
  name: "fleet",
  about: "N replicas over the real sync engine and a hostile network: do they converge, and what does a device cost?",
  headline: [
    "fleet.n4.converged",
    "fleet.n16.converged",
    "fleet.n16.wrongly-rejected",
    "fleet.n16.wrongly-kept",
    "fleet.n16.replays-per-node",
    "fleet.n16.redundancy",
    "fleet.n4.idle-round-bytes-per-node",
    "fleet.n16.idle-round-bytes-per-node",
    "fleet.scaling.idle-bytes-per-node-exponent",
    "fleet.scaling.bytes-per-event-exponent",
    "fleet.n16.run",
    "fleet.log480.replays-per-node",
    "fleet.log480.run",
  ],
  async run(ctx) {
    const fleets = [...FLEETS, ...(ctx.full ? FLEETS_FULL : [])];
    const byFleet: FleetSimResult[] = [];
    for (const n of fleets) {
      const r = await runFleetSim({ seed: ctx.seed, nodes: n, events: EVENTS });
      ctx.log(`${n} nodes: ${r.converged ? "converged" : `DID NOT CONVERGE (${r.problems[0]})`}, ${r.replays} replays, ${(r.wallMs / 1000).toFixed(1)} s`);
      record(ctx, `${FLEETS.includes(n) ? "" : "full."}fleet.n${n}`, r);
      byFleet.push(r);
    }
    // The curves, over the default fleets (so a default run and a full one fit the same points).
    const curve = byFleet.filter((r) => FLEETS.includes(r.nodes));
    ctx.quality("fleet.scaling.idle-bytes-per-node-exponent", growthExponent(curve.map((r) => [r.nodes, r.idleRoundBytes / r.nodes])), "", "lower", { note: "how a node's share of a quiet round grows with the fleet: 1 linear, 2 quadratic" });
    ctx.quality("fleet.scaling.bytes-per-event-exponent", growthExponent(curve.map((r) => [r.nodes, r.bytes / r.eventsNeeded])), "", "lower", { note: "how the bytes to deliver one event to one replica grow with the fleet: 0 would be none" });
    ctx.quality("fleet.scaling.replays-per-node-exponent", growthExponent(curve.map((r) => [r.nodes, Math.max(1, r.replays) / (r.nodes - (r.revoked ? 1 : 0))])), "", "lower", { note: "how a replica's full replays grow with the fleet" });

    for (const events of [...LOGS, ...(ctx.full ? LOGS_FULL : [])]) {
      const r = await runFleetSim({ seed: ctx.seed, nodes: 4, events });
      ctx.log(`4 nodes, ${r.logSize} events: ${r.converged ? "converged" : `DID NOT CONVERGE (${r.problems[0]})`}, ${r.replays} replays, ${(r.wallMs / 1000).toFixed(1)} s`);
      record(ctx, `${LOGS.includes(events) ? "" : "full."}fleet.log${events}`, r);
    }
  },
};
