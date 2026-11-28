import { type InterventionKind, interventionCount } from "./interventions.ts";
import { costOf, type Prices, type UsageLine } from "./spend.ts";

/*
 * Smart routing's memory, by kind of task: where an agent's next task of a kind begins, on the engineer's models (the
 * cheap ones) or the planner's (the strongest), from how its tasks of that kind went. One rule for every surface: the
 * node begins a task by it (agents' team-runtime), and the CLI and the PWA say by it where the next of each kind
 * begins. No dependencies (no zod): the PWA imports this directly (@invincible/core/routing).
 *
 * A kind begins on the tier that last verified one of its tasks: the engineer's until one has been, the planner's
 * once one was verified there (it began there, or moved up to it: agents' run.ts escalate). And after PROBE_AFTER in a
 * row begun on the planner's that way, the next tries the engineer's again, so a kind the cheaper models can do now goes
 * back to them; begun there, it still goes up the ladder when it is stuck or goes round. The same tasks give the same
 * tier, whatever other kinds' tasks are among them.
 */

/** The kinds of a task, as its work begins: a fix of a pull request's failing checks, desktop work, code, or a task. */
export const TASK_KINDS = ["fix", "desktop", "code", "task"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** A kind in words: one of it, and several. */
export const KIND_WORDS: Readonly<Record<TaskKind, { one: string; many: string }>> = {
  fix: { one: "fix", many: "fixes" },
  desktop: { one: "desktop task", many: "desktop tasks" },
  code: { one: "code task", many: "code tasks" },
  task: { one: "task", many: "tasks" },
};

/**
 * A task's kind as it begins: a fix of a pull request's checks (its `fix`), else work on a desktop (its VM has one),
 * else code (its agent has a repository), else a task.
 */
export function taskKindOf(at: { fix: boolean; desktop: boolean; repository: boolean }): TaskKind {
  if (at.fix) return "fix";
  if (at.desktop) return "desktop";
  if (at.repository) return "code";
  return "task";
}

/** How many tasks of a kind in a row may begin on the planner's models by this memory before one tries the engineer's again. */
export const PROBE_AFTER = 2;

/** A task's routing as this reads it (team.ts TeamTaskRouting has all of this). */
export interface RoutingRead {
  began: string;
  because?: string;
  moved?: string;
  kind?: string;
  /** It went round on both tiers (run.ts `round`). */
  round?: boolean;
}

/** An agent's task as this reads it: its id, how it stands, and its record's routing (absent: running, or from before). */
export interface RoutedTaskRead {
  id: string;
  status: string;
  verified: boolean;
  record?: { routing?: RoutingRead };
}

/** Where a task begins, why, and the task that says so (null: none of its kind has been verified). */
export interface Begin {
  tier: "engineer" | "planner";
  /** `memory`: begun on the planner's by it; `probe`: a try of the engineer's after PROBE_AFTER begun so; null: as ever. */
  because: "memory" | "probe" | null;
  why: string;
  from: string | null;
}

/** The tier a finished task was verified on: the planner's when its work began there or moved up to it. */
const verifiedOn = (routing: RoutingRead): "engineer" | "planner" => (routing.began === "planner" || routing.moved !== undefined ? "planner" : "engineer");

/**
 * Where the next task of `kind` begins, from an agent's tasks, the latest first (`current`, the task itself, aside): on
 * the tier that last verified one of its kind; a try of the engineer's after PROBE_AFTER in a row begun on the planner's
 * by this memory; the engineer's while none of its kind has been verified.
 */
export function beginFor(tasks: readonly RoutedTaskRead[], kind: TaskKind, current?: string): Begin {
  const words = KIND_WORDS[kind];
  const same = tasks.filter((t) => t.id !== current && t.record?.routing?.kind === kind);
  const last = same.find((t) => t.status === "done" && t.verified);
  if (!last) return { tier: "engineer", because: null, why: `none of its ${words.many} has been verified yet: the engineer's models first`, from: null };
  if (verifiedOn(last.record!.routing!) === "engineer") return { tier: "engineer", because: null, why: `its last ${words.one} was verified on the engineer's models`, from: last.id };
  const run = same.slice(0, PROBE_AFTER);
  if (run.length === PROBE_AFTER && run.every((t) => t.record!.routing!.began === "planner" && t.record!.routing!.because === "memory")) {
    return { tier: "engineer", because: "probe", why: `its last ${PROBE_AFTER} ${words.many} began on the planner's models: this one tries the engineer's again`, from: last.id };
  }
  return { tier: "planner", because: "memory", why: `its last ${words.one} was verified on the planner's models`, from: last.id };
}

/** Where an agent's next task of each kind it has done begins (beginFor), in TASK_KINDS' order: the kinds it has done alone. */
export function beginsByKind(tasks: readonly RoutedTaskRead[]): { kind: TaskKind; begin: Begin }[] {
  return TASK_KINDS.filter((kind) => tasks.some((t) => t.record?.routing?.kind === kind)).map((kind) => ({ kind, begin: beginFor(tasks, kind) }));
}

/*
 * Work going round on both tiers (agents' run.ts `round`): it went round on the engineer's models, moved up, and now goes
 * round on the planner's too. Nothing stops it (your word, 19 November 2026: no audit ends work, no limits on length);
 * the node tells you at once with a notice (events.ts notice.raised), one a task, cleared when the task ends. Said once,
 * and again only once the work has changed something and goes round anew: a raise brings back one you dismissed.
 */

/** The notices' source: the node's own words about its routing, told at once (notify.ts NODE_SOURCES). */
export const ROUND_SOURCE = "routing";

const ROUND_PREFIX = "went-round:";

/** A task's notice: one a task. */
export const roundKey = (task: string): string => `${ROUND_PREFIX}${task}`;

/** The task a notice is about, when it is one of these; else null. */
export function roundTask(key: string): string | null {
  if (!key.startsWith(ROUND_PREFIX)) return null;
  const task = key.slice(ROUND_PREFIX.length);
  return /^task-[a-z0-9_-]{12}$/.test(task) ? task : null;
}

/** At most this many of the files it read are named. */
const ROUND_FILES = 5;

/** What the notice says: whose task, that it went round on both tiers, that it goes on, and how to stop it. */
export function roundNotice(input: { agent: string; task: string; id: string; rereads: number; files: readonly string[] }): { title: string; body: string } {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const files = input.files.slice(0, ROUND_FILES).map((file) => cut(file, 80));
  const more = input.files.length > ROUND_FILES ? `, and ${input.files.length - ROUND_FILES} more` : "";
  return {
    title: cut(`${input.agent}'s task went round on both tiers`, 200),
    body: `“${cut(input.task, 300)}” went round on the engineer's models, moved up, and has now read the same files again ${input.rereads} times on the planner's models with nothing changed${files.length ? ` (${files.join(", ")}${more})` : ""}. It goes on until you stop it or its budget ends it. To stop it: its card's Stop, or invincible agents stop task ${input.id}`,
  };
}

/*
 * The routing report (`invincible agents routing` with no agent, the agents' page at a desk's width): how a node's own
 * finished tasks were routed, from their records alone, read-only. By kind (TASK_KINDS' order), then where each task's
 * work began and why: the engineer's models (as ever, or as a try after the planner's) or the planner's (by the memory,
 * by its plan). For each: how many, how many verified, how many moved up and why, how many went round on both tiers,
 * and what they came to at your prices and in minutes, every task's (verified or not) per verified task. And the tries'
 * own word: how many held, verified on the engineer's without moving up. With each, the mandate's north star: each time
 * you stepped in on those tasks, as it counts them (interventions.ts), on how many, and per verified task. A task with no
 * kind kept (held to models, a coding tool's, from before kinds were kept) is counted apart. Since a moment (`--since`),
 * only the tasks that finished then or after. The same tasks, the same report: its order is fixed. Its JSON (`--json`)
 * is this, `v` 1: a contract, held by fixtures; what came after its first form only adds fields.
 */

/** A task as the report reads it: a TeamTask has all of this. One with no record isn't finished, and isn't read. */
export interface RoutingReportTask {
  id: string;
  status: string;
  verified: boolean;
  record?: { startedAt: number; endedAt: number; spent: readonly UsageLine[]; routing?: RoutingRead };
  /** Each time you stepped in on it, by how (absent: never). */
  interventions?: Partial<Record<InterventionKind, number>>;
}

/** What a set of tasks came to: how many, verified, money at your prices (all of it priced or not) and minutes. */
export interface RoutingTally {
  tasks: number;
  verified: number;
  /** US dollars of what was priced; `priced` false: some call had no price, and this is a lower bound. */
  usd: number;
  priced: boolean;
  /** Some call was counted at its most (a handed task's, its provider silent in time): `usd` is an upper bound for it. */
  atMost: boolean;
  minutes: number;
  /** Per verified task (every task's, verified or not): none when none was verified, or when money isn't all priced. */
  usdPerVerified: number | null;
  minutesPerVerified: number | null;
  /** Each time you stepped in on these tasks, as the north star counts it; on how many of them; and per verified task
   * (none when none was verified). */
  interventions: number;
  neededYou: number;
  interventionsPerVerified: number | null;
}

/** Tasks of a kind whose work began in one place, for one reason (null: as ever). */
export interface RoutingReportGroup extends RoutingTally {
  began: string;
  because: string | null;
  movedUp: { gate: number; review: number; stall: number; rereads: number };
  wentRound: number;
}

export interface RoutingReport {
  v: 1;
  /** The tasks read are those that finished at this moment or after (ISO 8601, UTC); null: every finished task listed. */
  since: string | null;
  /** Finished tasks read (each with its record), and of them those with no kind kept: not in any kind. */
  finished: number;
  unrouted: number;
  kinds: (RoutingTally & { kind: TaskKind; groups: RoutingReportGroup[] })[];
  /** Tries of the engineer's after the planner's (begun there, because "probe"), and those that held: verified there, never moved up. */
  probes: { tried: number; held: number };
}

/** Where a group's work began, in the report's order: the engineer's as ever, its tries, the planner's by memory, by plan. */
const BEGAN_ORDER = ["engineer", "engineer:probe", "planner:memory", "planner:plan", "planner"];
const beganKey = (began: string, because: string | null) => (because ? `${began}:${because}` : began);
const beganRank = (key: string) => {
  const at = BEGAN_ORDER.indexOf(key);
  return at < 0 ? BEGAN_ORDER.length : at;
};

function tally(tasks: readonly RoutingReportTask[], prices: Prices): RoutingTally {
  let usd = 0;
  let priced = true;
  let atMost = false;
  let ms = 0;
  for (const task of tasks) {
    const cost = costOf(task.record!.spent, prices);
    usd += cost.usd;
    priced &&= cost.complete;
    atMost ||= cost.atMost;
    ms += Math.max(0, task.record!.endedAt - task.record!.startedAt);
  }
  const verified = tasks.filter((task) => task.verified).length;
  const minutes = ms / 60_000;
  const interventions = tasks.reduce((sum, task) => sum + interventionCount(task.interventions), 0);
  const neededYou = tasks.filter((task) => interventionCount(task.interventions) > 0).length;
  return { tasks: tasks.length, verified, usd, priced, atMost, minutes, usdPerVerified: verified && priced ? usd / verified : null, minutesPerVerified: verified ? minutes / verified : null, interventions, neededYou, interventionsPerVerified: verified ? interventions / verified : null };
}

/** How a node's finished tasks were routed (above): those that finished at `since` or after, where one is given (ms). */
export function routingReport(tasks: readonly RoutingReportTask[], prices: Prices, since?: number): RoutingReport {
  const finished = tasks.filter((task) => task.record && (since === undefined || task.record.endedAt >= since));
  const routed = finished.filter((task) => task.record!.routing?.kind && task.record!.routing.kind in KIND_WORDS);
  const kinds = TASK_KINDS.flatMap((kind) => {
    const mine = routed.filter((task) => task.record!.routing!.kind === kind);
    if (!mine.length) return [];
    const byBegan = new Map<string, RoutingReportTask[]>();
    for (const task of mine) {
      const r = task.record!.routing!;
      const key = beganKey(r.began, r.because ?? null);
      byBegan.set(key, [...(byBegan.get(key) ?? []), task]);
    }
    const groups = [...byBegan.entries()]
      .sort(([a], [b]) => beganRank(a) - beganRank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .map(([, group]): RoutingReportGroup => {
        const { began, because } = group[0]!.record!.routing!;
        const moved = (why: string) => group.filter((task) => task.record!.routing!.moved === why).length;
        return { began, because: because ?? null, ...tally(group, prices), movedUp: { gate: moved("gate"), review: moved("review"), stall: moved("stall"), rereads: moved("rereads") }, wentRound: group.filter((task) => task.record!.routing!.round === true).length };
      });
    return [{ kind, ...tally(mine, prices), groups }];
  });
  const tries = routed.filter((task) => task.record!.routing!.began === "engineer" && task.record!.routing!.because === "probe");
  return {
    v: 1,
    since: since === undefined ? null : new Date(since).toISOString(),
    finished: finished.length,
    unrouted: finished.length - routed.length,
    kinds,
    probes: { tried: tries.length, held: tries.filter((task) => task.verified && task.record!.routing!.moved === undefined).length },
  };
}
