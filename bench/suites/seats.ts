import { chooseSeat, newNodeIdentity, type SeatView } from "../../packages/core/src/index.ts";
import { foundFleet, LedgerStore } from "../../packages/ledger/src/index.ts";
import { SeatRuns } from "../../packages/node/src/seat-runs.ts";
import { recordSeatStatus, yourWord } from "../../packages/node/src/seats.ts";
import { quantile, type Suite } from "../lib.ts";
import { type Policy, runSeatsSim, type SeatsSimResult } from "../seats/sim.ts";

/*
 * Your seats at work (I15 step 9): which seat a coding agent's run takes, over a seeded week in virtual time
 * (bench/seats/sim.ts) with the real choice (core's chooseSeat) and the rule (never another account of a vendor's for
 * work that began on one). Two weeks of tasks: one that asks about what the seats hold ("even"), and a backlog of three
 * times that ("backlog"). Measured: tasks proven a day, each window's share used by its reset (what expires unused),
 * runs cut off by a spent window, and time a seat sat idle while work waited that it could take (target 0); the rule's
 * own counts, which are never anything but 0; and the same week run with two other ways to choose, the first free seat
 * and the one whose remaining share expires soonest, so the choice made is measured against them. Then what one choice
 * costs, and how soon a run waiting for a busy seat has it once it is let go (seat-runs.ts, its real code).
 */

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

export const suite: Suite = {
  name: "seats",
  about: "a seeded week of coding agents' tasks on your seats: tasks proven a day, each window used by its reset, runs cut off, and seats idle while work waited",
  headline: [
    "seats.even.proven-per-day",
    "seats.even.week-share",
    "seats.even.rests",
    "seats.even.idle-while-waiting",
    "seats.backlog.proven-per-day",
    "seats.backlog.week-share",
    "seats.rule.switches",
    "seats.rule.over-concurrency",
    "seats.rule.resting-taken",
    "seats.replay.differs",
    "seats.wake",
  ],
  async run(ctx) {
    const week = (policy: Policy, rate: number): SeatsSimResult => runSeatsSim({ seed: ctx.seed, policy, rate });
    let switches = 0;
    let over = 0;
    let restingTaken = 0;
    for (const [name, rate] of [["even", 1], ["backlog", 3]] as const) {
      const r = week("headroom", rate);
      ctx.pulse();
      switches += r.switches;
      over += r.overConcurrency;
      restingTaken += r.restingTaken;
      const done = sorted(r.doneIn);
      ctx.quality(`seats.${name}.proven-per-day`, r.proven / 7, "tasks", "higher", { note: `of ${r.tasks} tasks in the week, those whose work was done, a day` });
      ctx.quality(`seats.${name}.five-hour-share`, mean(r.fiveHourShare), "%", "higher", { note: `the share of each five-hour window used by its reset, the mean of ${r.fiveHourShare.length}` });
      ctx.quality(`seats.${name}.week-share`, mean(r.weekShare), "%", "higher", { note: `the share of each week's window used by its reset, the mean of ${r.weekShare.length}` });
      ctx.quality(`seats.${name}.rests`, r.rests, "runs", "lower", { note: "runs cut off by a window used whole, their tasks resting for their own seat" });
      ctx.quality(`seats.${name}.idle-while-waiting`, r.idleWhileWaiting, "seat-min", "lower", { note: "minutes a seat could take work that waited, and didn't (target 0: what is left is the controller's 15-second look for resting work)" });
      ctx.quality(`seats.${name}.done-p50`, done.length ? quantile(done, 0.5) : 0, "min", "lower", { note: "from a task's arrival to its work done, the median, virtual minutes" });
      ctx.quality(`seats.${name}.done-p90`, done.length ? quantile(done, 0.9) : 0, "min", "lower", { note: "from a task's arrival to its work done, the 90th percentile, virtual minutes" });
      for (const other of ["first-free", "expiring"] as const) {
        const o = week(other, rate);
        ctx.pulse();
        ctx.quality(`seats.${name}.${other}.proven-per-day`, o.proven / 7, "tasks", "higher", { note: `the same week, choosing ${other === "first-free" ? "the first seat free, by id" : "the seat whose remaining share expires soonest, per minute left"}` });
        ctx.quality(`seats.${name}.${other}.week-share`, mean(o.weekShare), "%", "higher", { note: "the same week, the other choice: each week's window used by its reset" });
        ctx.quality(`seats.${name}.${other}.rests`, o.rests, "runs", "lower", { note: "the same week, the other choice: runs cut off by a window used whole" });
      }
      ctx.log(`${name}: ${r.proven} of ${r.tasks} tasks proven, ${r.rests} runs cut off, each week's window ${mean(r.weekShare).toFixed(1)} % used by its reset, ${r.idleWhileWaiting.toFixed(2)} seat-minutes idle while work waited`);
    }
    ctx.quality("seats.rule.switches", switches, "", "lower", { note: "work taken up again on another subscription seat of its vendor's than it began on (the rule: never)" });
    ctx.quality("seats.rule.over-concurrency", over, "", "lower", { note: "a seat with more runs at once than it takes (D4: never)" });
    ctx.quality("seats.rule.resting-taken", restingTaken, "", "lower", { note: "a resting seat chosen (never)" });
    // The same seats at the same moments give the same choices: the week run again, choice by choice.
    const once = week("headroom", 1).choices;
    const again = week("headroom", 1).choices;
    ctx.quality("seats.replay.differs", once.length === again.length ? once.filter((c, i) => c !== again[i]).length : Math.max(once.length, again.length), "choices", "lower", { note: `of ${once.length} choices in the week, those made differently when it was run again` });

    // What one choice costs: of 32 seats with 8 windows each (the most a node keeps), as every run's start pays it.
    const NOW = Date.UTC(2026, 10, 27, 9, 0);
    // (Every one serving the agent that asks: each is weighed, as a seat you share with it would be.)
    const AGENT = { id: "ada", made: NOW - 86_400_000 };
    const seats: SeatView[] = Array.from({ length: 32 }, (_, n) => ({
      id: `st_${String(n).padStart(22, "0")}`, kind: n % 3 ? "claude-subscription" : "chatgpt-codex", vendor: n % 3 ? "anthropic" : "openai", label: `seat ${n}`, node: "n_bench", provider: null, runs: 1, plan: null, method: null,
      state: n % 7 ? { is: "ready", renewBy: null } : { is: "resting", until: NOW + 3_600_000, window: null },
      windows: Array.from({ length: 8 }, (_, w) => ({ window: `w${w}`, status: "allowed" as const, usedPercent: (n * 13 + w * 7) % 100, resetsAt: NOW + (w + 1) * 3_600_000, at: NOW })),
      serves: [AGENT],
    }));
    ctx.time("seats.choose", () => chooseSeat("claude", seats, () => 0, NOW, { agent: AGENT }), { n: 25, warm: 5, batch: 200, note: "one choice of seat for a run, of 32 seats with 8 windows each" });

    // How soon a run waiting for a busy seat has it once its run lets it go (the real SeatRuns, a host that answers at once).
    const node = newNodeIdentity();
    const store = new LedgerStore(":memory:");
    foundFleet(store, node, { fleetName: "bench", nodeName: "bench" });
    const SEAT = `st_${"q".repeat(22)}`;
    store.emit(node, "seat.added", { id: SEAT, kind: "claude-subscription", label: "Max", node: node.id, runs: 1 }, yourWord(null));
    // (It serves the agent whose runs wait for it, as that agent.)
    const ADA_MADE = Date.UTC(2026, 10, 20, 8, 0);
    store.emit(node, "seat.serves", { id: SEAT, agents: [{ id: "ada", made: ADA_MADE }] }, yourWord(null));
    recordSeatStatus(store, node, store.seats()[0]!, { signedIn: true, method: "claude.ai", fingerprint: "F".repeat(22) });
    const vms = new Set<string>();
    let made = 0;
    const host = {
      get: async (id: string) => (id === "agent-vm" ? ({ id, cpus: 2, memoryGb: 4 } as never) : vms.has(id) ? ({ id } as never) : null),
      createSeatVm: async () => {
        if (vms.size) throw Object.assign(new Error("in use"), { status: 409 });
        const id = `vm-${++made}`;
        vms.add(id);
        return { id } as never;
      },
      seatVms: async () => [...vms],
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0, truncated: false }),
      destroy: async (id: string) => (vms.delete(id), { verdict: "allow" as const, reason: "its own run" }),
      stream: async () => ({ lines: (async function* () {})(), write() {}, close() {}, kill() {}, exited: Promise.resolve(0) }),
    };
    const runs = new SeatRuns({ store, node, host: () => host, pollMs: 60_000 });
    const ask = { agent: "ada", made: ADA_MADE, vm: "agent-vm", harness: "claude", from: null, wait: true };
    const live = new AbortController().signal;
    const samples: number[] = [];
    const from = performance.now();
    for (let n = 0; n < 15; n++) {
      const holding = await runs.take(ask, live);
      if (!("run" in holding)) throw new Error("the seat wasn't taken");
      const waiting = runs.take(ask, live);
      await Bun.sleep(2);
      const freed = performance.now();
      await holding.run.release();
      const got = await waiting;
      samples.push(performance.now() - freed);
      if (!("run" in got)) throw new Error("the waiting run didn't get the seat");
      await got.run.release();
    }
    ctx.speed("seats.wake", samples, "ms", "lower", [from, performance.now()], "from a seat let go to the run that waited for it having it (its VM made again, by a host that answers at once)");
    store.close();
  },
};
