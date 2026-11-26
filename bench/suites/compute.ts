import { type ComputeSimResult, MACHINES, runComputeSim } from "../compute/sim.ts";
import type { Suite } from "../lib.ts";

/*
 * Compute: does more of it make the work go faster? Queues of independent quests
 * (the Trials' shape) at effort 1, 2 and 3, on fleets of 1, 2, 4 and 8 machines
 * of different measured strengths, in virtual time (bench/compute/sim.ts): the
 * real census, placement, slot admission and model-call rationing decide; only
 * the work is a stand-in.
 *
 * Everything but the cost of a decision is exact: the simulation is deterministic,
 * so a makespan is a count of virtual seconds, not a timing.
 */

/** A trial run: the engineering suite's fourteen problems, three times over. */
const TRIAL_RUN = 42;
/** A queue long enough that its end doesn't matter: what the fleet carries in the long run. */
const LONG = 480;
const FLEETS = [1, 2, 4, 8];
/** One more machine like the strongest. */
const NINE = [...MACHINES, { ...MACHINES[1]!, name: "rack-two" }];

const perHour = (quests: number, r: ComputeSimResult): number => quests / (r.makespanS / 3600);

export const suite: Suite = {
  name: "compute",
  about: "queues of quests on fleets of 1 to 8 machines, in virtual time: are ceilings kept, and what does a machine buy?",
  headline: [
    "compute.over-ceiling",
    "compute.lost",
    "compute.queue-jumps",
    "compute.e1.speedup-8",
    "compute.e3.speedup-8",
    "compute.e3.n8.efficiency",
    "compute.e3.n8.max-wait",
    "compute.e3.n8.idle-while-waiting",
    "compute.long.n1.quests-per-hour",
    "compute.long.n8.quests-per-hour",
    "compute.long.scaling-efficiency",
    "compute.long.one-more-node",
    "compute.long.one-more-node-32-calls",
    "compute.auto.e1.n8.utilisation",
    "compute.place-decision",
  ],
  async run(ctx) {
    const all: ComputeSimResult[] = [];
    const sim = async (options: Parameters<typeof runComputeSim>[0]): Promise<ComputeSimResult> => {
      const r = await runComputeSim(options);
      all.push(r);
      ctx.pulse();
      return r;
    };

    // A trial run at each effort on each fleet, as many trials at once as the slots carry.
    for (const effort of [1, 2, 3] as const) {
      const by = new Map<number, ComputeSimResult>();
      for (const nodes of FLEETS) {
        const r = await sim({ seed: ctx.seed, nodes, quests: TRIAL_RUN, effort, parallel: "slots" });
        by.set(nodes, r);
        const id = `compute.e${effort}.n${nodes}`;
        const note = `${r.slots} slots, ${r.parallel} trials at once, ${r.modelCalls} model calls at once`;
        ctx.quality(`${id}.makespan`, r.makespanS, "s", "lower", { note });
        ctx.quality(`${id}.efficiency`, r.lowerBoundS / r.makespanS, "", "higher", { note: "the least time any schedule could take, over the time taken" });
        ctx.quality(`${id}.max-wait`, r.maxWaitS, "s", "lower", { note: "the longest a sandbox waited for a slot" });
        ctx.quality(`${id}.idle-while-waiting`, r.idleWhileWaiting, "", "lower", { note: "slot-time spent waiting on one host while a slot stood free on another, as a share of slot-time used" });
      }
      const one = by.get(1)!;
      const eight = by.get(8)!;
      ctx.quality(`compute.e${effort}.speedup-8`, one.makespanS / eight.makespanS, "×", "higher", { note: `8 machines against 1, with ${(eight.slots / one.slots).toFixed(1)}× the slots` });
      ctx.log(`effort ${effort}: ${FLEETS.map((n) => `${n} → ${Math.round(by.get(n)!.makespanS)} s`).join(", ")}`);
    }

    // The default: `galahad trial run` with --parallel auto.
    const auto = await sim({ seed: ctx.seed, nodes: 8, quests: TRIAL_RUN, effort: 1, parallel: "auto" });
    ctx.quality("compute.auto.e1.n8.makespan", auto.makespanS, "s", "lower", { note: `--parallel auto: ${auto.parallel} trials at once on ${auto.slots} slots` });
    ctx.quality("compute.auto.e1.n8.utilisation", auto.utilisation, "", "higher", { note: "the share of the fleet's slot-time in use" });

    // The long run: what each fleet carries, and what one more machine buys.
    const long = new Map<number, ComputeSimResult>();
    for (const nodes of FLEETS) {
      const r = await sim({ seed: ctx.seed, nodes, quests: LONG, effort: 1, parallel: "slots" });
      long.set(nodes, r);
      ctx.quality(`compute.long.n${nodes}.quests-per-hour`, perHour(LONG, r), "/h", "higher", { note: `${r.slots} slots, ${r.modelCalls} model calls at once` });
    }
    const one = long.get(1)!;
    const eight = long.get(8)!;
    ctx.quality("compute.long.scaling-efficiency", perHour(LONG, eight) / perHour(LONG, one) / (eight.slots / one.slots), "", "higher", { note: "the speed-up from 1 to 8 machines, over the growth in slots: 1 is linear" });
    const nine = await sim({ seed: ctx.seed, nodes: 9, machines: NINE, quests: LONG, effort: 1, parallel: "slots" });
    ctx.quality("compute.long.one-more-node", perHour(LONG, nine) / perHour(LONG, eight), "×", "higher", { note: `a ninth machine like the strongest: ${nine.slots} slots for ${eight.slots} (${(nine.slots / eight.slots).toFixed(2)}×), still ${nine.modelCalls} model calls at once` });
    const eightCalls = await sim({ seed: ctx.seed, nodes: 8, quests: LONG, effort: 1, parallel: "slots", modelCalls: 32 });
    const nineCalls = await sim({ seed: ctx.seed, nodes: 9, machines: NINE, quests: LONG, effort: 1, parallel: "slots", modelCalls: 32 });
    ctx.quality("compute.long.n8.quests-per-hour-32-calls", perHour(LONG, eightCalls), "/h", "higher", { note: "the same fleet with the asked node's ceiling raised to 32 model calls at once" });
    ctx.quality("compute.long.one-more-node-32-calls", perHour(LONG, nineCalls) / perHour(LONG, eightCalls), "×", "higher", { note: "what the ninth machine buys once model calls aren't the limit" });
    ctx.log(`the long run: ${FLEETS.map((n) => `${n} → ${perHour(LONG, long.get(n)!).toFixed(1)}/h`).join(", ")}; a ninth ${(perHour(LONG, nine) / perHour(LONG, eight)).toFixed(2)}× (${(perHour(LONG, nineCalls) / perHour(LONG, eightCalls)).toFixed(2)}× with 32 model calls)`);

    // What must hold at every instant of every run above.
    const sum = (pick: (r: ComputeSimResult) => number): number => all.reduce((total, r) => total + pick(r), 0);
    ctx.quality("compute.over-ceiling", sum((r) => r.overCeiling), "instants", "lower", { note: `a host holding more sandboxes, threads or memory than it may, over ${all.length} runs` });
    ctx.quality("compute.on-closed-node", sum((r) => r.onClosedNode), "instants", "lower", { note: "a sandbox on the node whose ceiling takes none" });
    ctx.quality("compute.lost", sum((r) => r.lost + r.unfinished), "", "lower", { note: "attempts lost waiting past the limit for a slot, and quests that never finished" });
    ctx.quality("compute.queue-jumps", sum((r) => r.queueJumps), "", "lower", { note: "a sandbox given a slot before one that asked that host earlier" });

    // What a decision costs on the biggest fleet: the census read from the mind, nine candidates, ranked.
    ctx.speed("compute.place-decision", nineCalls.placeMs, "ms", "lower", nineCalls.placeSpan, "where should this sandbox go? once, on nine machines");
  },
};
