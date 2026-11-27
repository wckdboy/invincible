import { accountSeat, chooseSeat, mayCarryOn, SEAT_HARNESS, type SeatKind, seatHeadroom, seatOpensAt, seatServes, type SeatView, seatVendor, type TaskAccount } from "../../packages/core/src/index.ts";
import { intBelow, rng, subSeed } from "../lib.ts";

/*
 * A week of your seats at work, in virtual time (I15 step 9): the real choice of seat (core's chooseSeat, with the rule
 * mayCarryOn and the headroom it reads from each seat's windows), stepped every five seconds over a seeded week of
 * coding agents' tasks. Each seat is a plan of yours with two windows as its tool says them: five hours that start at
 * its first use after the last one ended, and a week that resets at a fixed time. A run uses both as it works; a window
 * used whole is refused, its seat rests until that window resets, and its task rests with it and goes on on that seat
 * alone (the rule: never another account of the vendor's). A task waiting for a seat takes one the moment it is let go
 * (seat-runs.ts wakes it); one resting is taken up again at the team controller's next look (every 15 seconds), as
 * TeamStore.resumeRestarted does.
 *
 * Nothing here is a vendor's real allowance: a plan's windows are in units a run uses one of a minute, sized so a week
 * of the owner's backlog asks more of them than they hold. The measures are what the choice does with them: tasks
 * proven, each window's share used by its reset (what expires unused), and time a seat sat idle while work waited that
 * it could take (target 0). The same week is run with two other ways to choose (the first seat free, by id; and the one
 * whose remaining share would expire soonest, per minute left), so the choice made is measured against them.
 *
 * Every seat here serves the one agent whose week it is (a seat serves the agent you chose for it, and the agents you
 * share it with are one trust domain: either way, the choice among the seats that serve it is the one measured).
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Monday 23 November 2026, 00:00 UTC. */
export const SIM_START = Date.UTC(2026, 10, 23);
/** The agent whose week it is, as its node's team made it: every seat here serves it. */
export const SIM_AGENT = { id: "sim", made: SIM_START };
/** The step, and how often the team controller looks for work whose rest is over. */
export const STEP_MS = 5 * SECOND;
export const TICK_MS = 15 * SECOND;

export type Policy = "headroom" | "first-free" | "expiring";

export interface SeatPlan {
  id: string;
  kind: SeatKind;
  label: string;
  /** Units its five-hour window holds (a run uses one a minute). */
  fiveHour: number;
  /** Units its week holds, and when in the week (hours from the start) it resets. */
  week: number;
  weekResetsAtHour: number;
}

/** The owner's seats, as H1 says them: two Claude plans of different sizes, and a ChatGPT plan for Codex. */
export const SEATS: readonly SeatPlan[] = [
  { id: `st_${"a".repeat(22)}`, kind: "claude-subscription", label: "Ultra", fiveHour: 300, week: 4000, weekResetsAtHour: 2 * 24 + 9 },
  { id: `st_${"b".repeat(22)}`, kind: "claude-subscription", label: "Max", fiveHour: 150, week: 2000, weekResetsAtHour: 4 * 24 + 15 },
  { id: `st_${"c".repeat(22)}`, kind: "chatgpt-codex", label: "Plus", fiveHour: 120, week: 1200, weekResetsAtHour: 5 * 24 + 6 },
];

export interface SeatsSimOptions {
  seed: number;
  policy?: Policy;
  days?: number;
  /** Tasks an hour in the owner's working hours (08:00 to 22:00): the default asks more of the week than it holds. */
  rate?: number;
}

export interface SeatsSimResult {
  tasks: number;
  /** Tasks whose work was done within the week (each proven by its gates and review: the sim counts the work). */
  proven: number;
  /** Times a run was cut off by a window used whole, its task resting for its seat. */
  rests: number;
  /** The share of each window used by its reset, in percent, by window. */
  fiveHourShare: number[];
  weekShare: number[];
  /** Seat-minutes a seat could take work that waited, and didn't. */
  idleWhileWaiting: number;
  /** Minutes from a window's reset to its seat in use again, when work waited for it. */
  resetToUse: number[];
  /** Minutes from a task's arrival to its work done. */
  doneIn: number[];
  /** Never, by the rule: work resumed on another subscription seat of the vendor's than it began on. */
  switches: number;
  /** Never: a seat with more runs than it takes, or a resting seat chosen. */
  overConcurrency: number;
  restingTaken: number;
  /** Every choice made, in order: the same seats at the same moment give the same choice. */
  choices: string[];
}

interface Window {
  name: "five_hour" | "seven_day";
  capacity: number;
  used: number;
  resetsAt: number | null;
}
interface Seat {
  plan: SeatPlan;
  windows: [Window, Window];
  restUntil: number | null;
  busy: number;
  /** When its rest ended with work waiting for it, until it was in use again. */
  idleSince: number | null;
}
interface Task {
  n: number;
  harness: "claude" | "codex";
  arrives: number;
  work: number;
  from: TaskAccount | null;
  seat: Seat | null;
  restUntil: number | null;
  done: number | null;
}

const share = (w: Window) => Math.min(100, Math.round((w.used / w.capacity) * 100));

/** A seat as the apps and the choice see it: where it stands at `now`, and its windows as its tool last said them. */
function view(seat: Seat, now: number): SeatView {
  const resting = seat.restUntil !== null && seat.restUntil > now;
  return {
    id: seat.plan.id,
    kind: seat.plan.kind,
    vendor: seatVendor(seat.plan),
    label: seat.plan.label,
    node: "n_sim",
    provider: null,
    runs: 1,
    plan: null,
    method: null,
    state: resting ? { is: "resting", until: seat.restUntil!, window: null } : { is: "ready", renewBy: null },
    windows: seat.windows.filter((w) => w.resetsAt !== null).map((w) => ({ window: w.name, status: w.used >= w.capacity ? "rejected" : "allowed", usedPercent: share(w), resetsAt: w.resetsAt, at: now })),
    serves: [SIM_AGENT],
  };
}

/** The seat a policy takes for a task now: the real choice, or one of the two it is measured against. */
function choose(policy: Policy, harness: string, seats: readonly SeatView[], busy: (id: string) => number, now: number, from: TaskAccount | null): SeatView | null {
  const carried = from ? accountSeat(from) : null;
  if (policy === "headroom") return chooseSeat(harness, seats, busy, now, { agent: SIM_AGENT, from: carried });
  const able = seats.filter((s) => seatServes(s, SIM_AGENT) && SEAT_HARNESS[s.kind] === harness && s.state.is === "ready" && busy(s.id) < s.runs && seatHeadroom(s, now).used < 100 && (!carried || mayCarryOn(carried, s)));
  if (policy === "first-free") return [...able].sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
  // What would expire unused soonest, per minute left: the most perishable first (a window not yet begun perishes nothing).
  const perishing = (s: SeatView) => {
    const room = seatHeadroom(s, now);
    return room.resetsAt === null ? 0 : (100 - room.used) / Math.max(1, (room.resetsAt - now) / MINUTE);
  };
  return [...able].sort((a, b) => perishing(b) - perishing(a) || (a.id < b.id ? -1 : 1))[0] ?? null;
}

export function runSeatsSim(options: SeatsSimOptions): SeatsSimResult {
  const policy = options.policy ?? "headroom";
  const days = options.days ?? 7;
  const rate = options.rate ?? 3;
  const random = rng(subSeed(options.seed, "seats"));
  const seats: Seat[] = SEATS.map((plan) => ({
    plan,
    windows: [
      { name: "five_hour", capacity: plan.fiveHour, used: 0, resetsAt: null },
      { name: "seven_day", capacity: plan.week, used: 0, resetsAt: SIM_START + plan.weekResetsAtHour * HOUR },
    ],
    restUntil: null,
    busy: 0,
    idleSince: null,
  }));
  // The week's tasks: arriving in the owner's working hours, seven in ten for Claude Code, the rest for Codex, each 10 to 150 minutes of work.
  const tasks: Task[] = [];
  for (let day = 0; day < days; day++) {
    for (let hour = 8; hour < 22; hour++) {
      const arrivals = Math.floor(rate) + (random() < rate - Math.floor(rate) ? 1 : 0);
      for (let k = 0; k < arrivals; k++) {
        tasks.push({ n: tasks.length, harness: random() < 0.7 ? "claude" : "codex", arrives: SIM_START + day * DAY + hour * HOUR + intBelow(random, 3600) * SECOND, work: (10 + intBelow(random, 141)) * MINUTE, from: null, seat: null, restUntil: null, done: null });
      }
    }
  }
  tasks.sort((a, b) => a.arrives - b.arrives || a.n - b.n);
  const result: SeatsSimResult = { tasks: tasks.length, proven: 0, rests: 0, fiveHourShare: [], weekShare: [], idleWhileWaiting: 0, resetToUse: [], doneIn: [], switches: 0, overConcurrency: 0, restingTaken: 0, choices: [] };
  const end = SIM_START + days * DAY;
  let arrived = 0;
  /** Work waiting for a seat, in the order it came (TeamStore takes up resting work in its own order). */
  const waiting: Task[] = [];
  const resting: Task[] = [];
  const running: Task[] = [];
  for (let now = SIM_START; now < end; now += STEP_MS) {
    while (arrived < tasks.length && tasks[arrived]!.arrives <= now) waiting.push(tasks[arrived++]!);
    /** Whether work waits that `seat` could take (its harness's, and its own if it began on one of its vendor's). */
    const wanted = (seat: Seat, v: SeatView) => [...waiting, ...resting].some((t) => SEAT_HARNESS[seat.plan.kind] === t.harness && (!t.from || mayCarryOn(accountSeat(t.from), v)));
    // Windows that reset now; a seat's rest that is over (and when work waited for it, the time till it is used again).
    for (const seat of seats) {
      for (const w of seat.windows) {
        if (w.resetsAt === null || w.resetsAt > now) continue;
        (w.name === "five_hour" ? result.fiveHourShare : result.weekShare).push(share(w));
        w.used = 0;
        w.resetsAt = w.name === "five_hour" ? null : w.resetsAt + 7 * DAY;
      }
      if (seat.restUntil !== null && seat.restUntil <= now) {
        seat.restUntil = null;
        if (seat.busy === 0 && wanted(seat, view(seat, now))) seat.idleSince = now;
      }
    }
    // The controller's look: work whose rest is over is taken up again, where it stood in line.
    if ((now - SIM_START) % TICK_MS === 0) {
      for (const task of [...resting]) {
        if (task.restUntil !== null && task.restUntil <= now) {
          resting.splice(resting.indexOf(task), 1);
          task.restUntil = null;
          waiting.push(task);
        }
      }
      waiting.sort((a, b) => a.arrives - b.arrives || a.n - b.n);
    }
    // Each waiting task, in order, takes the seat its policy chooses, if one can take it (looked at only while one is free).
    const free = (seat: Seat) => {
      const v = view(seat, now);
      return seat.busy < 1 && v.state.is === "ready" && seatHeadroom(v, now).used < 100;
    };
    for (const task of seats.some(free) ? [...waiting] : []) {
      if (!seats.some(free)) break;
      const views = seats.map((s) => view(s, now));
      const chosen = choose(policy, task.harness, views, (id) => seats.find((s) => s.plan.id === id)!.busy, now, task.from);
      if (!chosen) continue;
      const seat = seats.find((s) => s.plan.id === chosen.id)!;
      if (chosen.state.is !== "ready") result.restingTaken++;
      if (task.from?.seat && task.from.seat !== seat.plan.id && seatVendor({ kind: task.from.kind }) === seatVendor(seat.plan)) result.switches++;
      result.choices.push(`${now - SIM_START}:${task.n}:${seat.plan.label}`);
      waiting.splice(waiting.indexOf(task), 1);
      seat.busy++;
      if (seat.busy > 1) result.overConcurrency++;
      if (seat.idleSince !== null) {
        result.resetToUse.push((now - seat.idleSince) / MINUTE);
        seat.idleSince = null;
      }
      task.seat = seat;
      task.from = { seat: seat.plan.id, kind: seat.plan.kind };
      // (A five-hour window begins at its first use after the last one ended.)
      if (seat.windows[0].resetsAt === null) seat.windows[0].resetsAt = now + 5 * HOUR;
      running.push(task);
    }
    // Seats free while work waited that they could take (waiting, or resting with its rest over): the choice's own idle time.
    for (const seat of seats) {
      if (!free(seat)) continue;
      const v = view(seat, now);
      const could = (t: Task) => SEAT_HARNESS[seat.plan.kind] === t.harness && (!t.from || mayCarryOn(accountSeat(t.from), v));
      if (waiting.some(could) || resting.some((t) => t.restUntil !== null && t.restUntil <= now && could(t))) result.idleWhileWaiting += STEP_MS / MINUTE;
    }
    // The work goes on: each run uses its seat's windows; one used whole cuts it off, and its seat and its task rest.
    for (const task of [...running]) {
      const seat = task.seat!;
      const used = STEP_MS / MINUTE;
      for (const w of seat.windows) w.used = Math.min(w.capacity, w.used + used);
      task.work -= STEP_MS;
      const spent = seat.windows.some((w) => w.used >= w.capacity);
      if (task.work <= 0) {
        task.done = now + STEP_MS;
        result.proven++;
        result.doneIn.push((task.done - task.arrives) / MINUTE);
      }
      if (spent && task.work > 0) {
        result.rests++;
        seat.restUntil = seatOpensAt(view(seat, now), now);
        task.restUntil = seat.restUntil;
        resting.push(task);
      }
      if (task.work <= 0 || spent) {
        running.splice(running.indexOf(task), 1);
        task.seat = null;
        seat.busy--;
      }
    }
  }
  return result;
}
