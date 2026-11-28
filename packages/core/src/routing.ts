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
