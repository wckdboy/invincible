import type { Database } from "bun:sqlite";
import {
  DEFAULT_WAKE_COOLDOWN_MS,
  dueRun,
  LoopTask,
  LoopWake,
  type LoopRunView,
  type NodeIdentity,
  nextRun,
  parseSchedule,
  redact,
  RETIRED_LOOP_TASKS,
  type Schedule,
  ScheduleError,
} from "@galahad/core";
import type { MindStore } from "@galahad/mind";

/*
 * Loops: work Galahad does on a schedule, or when something happens. A loop lives
 * in the mind (so every device sees it and its history) and names exactly one node
 * that runs it, so it never runs twice. That node's runner wakes every few seconds,
 * finds loops that are due, and runs each one at most once per slot:
 *
 *   - a run is marked in local storage before it starts and recorded in the mind
 *     (`loop.ran`) when it ends; a crash in between is recorded as interrupted on
 *     the next start, never rerun;
 *   - a node that was away runs a missed loop once, not once per missed slot;
 *   - a run that outlives its deadline is stopped.
 *
 * What else wakes a loop (PLAN #13: a webhook, new mail, a GitHub event) comes in
 * through wake(): kept in local storage until a run takes it, so a restart loses
 * none; the first wakes the loop at once, and the rest of a burst wait out the
 * loop's cooldown and go to one run together. A run takes them as outside data.
 */

export interface LoopRecord {
  name: string;
  scheduleText: string;
  schedule: Schedule | null;
  tz: string;
  on: string;
  enabled: boolean;
  task: LoopTask | null;
  problem: string | null;
  label: string | null;
  updatedHlc: string;
  updatedAt: number;
  /** What else wakes it (PLAN #13), as this node reads them, and how long a burst waits to be one run. */
  wakes: LoopWake[];
  cooldownMs: number;
}

/** One thing that happened which wakes a loop: someone else's words, so a run takes it as data. */
export interface WakeEvent {
  /** Unique per loop: the same event never wakes it twice. */
  id: string;
  source: LoopWake["kind"];
  at: number;
  /** One line: what happened. */
  text: string;
  /** What came with it, bounded (a webhook's body, a mail's first lines). */
  detail?: string;
}

export const hlcMs = (hlc: string): number => Number(hlc.split(".")[0]);

interface StoredLoop {
  name: string;
  schedule: string;
  tz?: string;
  on: string;
  enabled: boolean;
  task: unknown;
  label?: string;
}

interface StoredWakes {
  wakes: unknown[];
  cooldownMs: number;
}

export function loopRecords(store: MindStore): LoopRecord[] {
  const woken = new Map(store.lwwPrefix<StoredWakes>("loopwake:").map((entry) => [entry.key.slice("loopwake:".length), entry.value!]));
  return store.lwwPrefix<StoredLoop>("loop:").map((entry) => {
    const stored = entry.value!;
    const problems: string[] = [];
    // A wake a newer node wrote, which this one can't read, is left out and said; the rest still wake it.
    const wakes: LoopWake[] = [];
    for (const raw of woken.get(stored.name)?.wakes ?? []) {
      const wake = LoopWake.safeParse(raw);
      if (wake.success) wakes.push(wake.data);
      else problems.push("one of what wakes it isn't understood here (written by a newer version?)");
    }
    let schedule: Schedule | null = null;
    try {
      schedule = parseSchedule(stored.schedule);
    } catch (error) {
      problems.push(`schedule: ${(error as Error).message}`);
    }
    const task = LoopTask.safeParse(stored.task);
    if (!task.success) {
      // A task this version no longer has says so; any other is taken for a newer version's.
      const kind = (stored.task as { kind?: unknown } | null)?.kind;
      const retired = typeof kind === "string" && Object.hasOwn(RETIRED_LOOP_TASKS, kind) ? RETIRED_LOOP_TASKS[kind]! : null;
      problems.push(retired ? `its task no longer exists (${retired}), so it never runs. Remove it: galahad loop rm ${stored.name}` : "this node doesn't understand the task (written by a newer version?)");
    }
    return {
      name: stored.name,
      scheduleText: stored.schedule,
      schedule,
      tz: stored.tz ?? "UTC",
      on: stored.on,
      enabled: stored.enabled,
      task: task.success ? task.data : null,
      problem: problems.length ? problems.join("; ") : null,
      label: stored.label ?? null,
      updatedHlc: entry.hlc,
      updatedAt: hlcMs(entry.hlc),
      wakes,
      cooldownMs: woken.get(stored.name)?.cooldownMs || DEFAULT_WAKE_COOLDOWN_MS,
    };
  });
}

/** Whether every heartbeat loop lets him fix what's safe himself (on unless one says `selfAction: false`). */
export function selfActionOn(store: MindStore): { on: boolean; heartbeats: string[] } {
  const beats = loopRecords(store).filter((l) => l.task?.kind === "heartbeat");
  return { on: beats.every((l) => l.task?.kind !== "heartbeat" || l.task.selfAction !== false), heartbeats: beats.map((l) => l.name) };
}

export function runView(event: {
  device: string;
  body: { loop: string; run: string; slot: number | null; status: LoopRunView["status"]; started: number; finished: number; summary: string };
}): LoopRunView {
  const { loop, run, slot, status, started, finished, summary } = event.body;
  return { loop, run, slot, status, started, finished, summary, node: event.device };
}

export interface RunContext {
  run: string;
  slot: number | null;
  signal: AbortSignal;
  /** What woke this run (empty when its schedule or you did). */
  woken: WakeEvent[];
}

export interface RunResult {
  status: "ok" | "attention" | "failed";
  summary: string;
  /**
   * What woke this run that it couldn't do, by its events' ids, to be tried again: each waits for the next run, once the
   * loop's cooldown has passed, WAKE_RETRIES times at most. Only a task whose runs are safe to repeat gives any back (a
   * bilag's mail: what was copied is never copied twice), and only when that is all that went wrong.
   */
  giveBack?: string[];
}

/** What woke a run and it gave back is tried again this many times at most. */
export const WAKE_RETRIES = 3;

export type RunnableLoop = LoopRecord & { task: LoopTask; schedule: Schedule };

export interface LoopRunnerOptions {
  store: MindStore;
  identity: NodeIdentity;
  local: Database;
  log: (message: string) => void;
  execute: (loop: RunnableLoop, ctx: RunContext) => Promise<RunResult>;
  now?: () => number;
  /** Runs at once on this node; a due loop waits for a free place. */
  maxConcurrent?: number;
  /** No run lasts longer than this. */
  deadlineMs?: number;
  /** After each run is recorded (e.g. to tell you when a loop needs a look); `again`: all it gave back is tried again. */
  onFinished?: (loop: RunnableLoop, result: RunResult, run: string, after: { again: boolean }) => void;
}

export class LoopError extends Error {}

/** Waiting events kept per loop at most (the oldest go first), and how long a taken one is kept so it never wakes it twice. */
const MAX_WAITING = 50;
const KEEP_TAKEN_MS = 7 * 24 * 3600_000;

export class LoopRunner {
  private readonly now: () => number;
  private readonly active = new Map<string, { run: string; controller: AbortController; done: Promise<void> }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: LoopRunnerOptions) {
    this.now = o.now ?? Date.now;
    o.local.exec("CREATE TABLE IF NOT EXISTS loop_runs (loop TEXT NOT NULL, run TEXT NOT NULL, slot INTEGER, started INTEGER NOT NULL, PRIMARY KEY (loop, run))");
    // What woke a loop and waits for a run (taken: the run that took it; tries: how often a run gave it back), and when
    // each loop was last woken.
    o.local.exec("CREATE TABLE IF NOT EXISTS loop_wakes (loop TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, taken TEXT, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (loop, id))");
    if (!o.local.query<{ name: string }, []>("PRAGMA table_info(loop_wakes)").all().some((column) => column.name === "tries")) {
      o.local.exec("ALTER TABLE loop_wakes ADD COLUMN tries INTEGER NOT NULL DEFAULT 0");
    }
    o.local.exec("CREATE TABLE IF NOT EXISTS loop_woke (loop TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  /** Record runs a previous process left unfinished, then wake every `intervalMs`. */
  start(intervalMs = 15_000): void {
    const leftovers = this.o.local
      .query<{ loop: string; run: string; slot: number | null; started: number }, []>("SELECT loop, run, slot, started FROM loop_runs")
      .all();
    for (const row of leftovers) {
      this.record(row.loop, row.run, row.slot, row.started, { status: "interrupted", summary: "The node stopped during this run; it was not rerun." });
    }
    this.o.local.query("DELETE FROM loop_wakes WHERE at < ?").run(this.now() - KEEP_TAKEN_MS);
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** Loops this node runs. */
  mine(): LoopRecord[] {
    return loopRecords(this.o.store).filter((loop) => loop.on === this.o.identity.id);
  }

  isRunning(name: string): boolean {
    return this.active.has(name);
  }

  /** The slot a loop would run for now, if any. */
  due(loop: LoopRecord, now = this.now()): number | null {
    if (!loop.enabled || !loop.schedule || !loop.task) return null;
    const last = this.o.store.lastSlot(loop.name, this.o.identity.id);
    // A loop never catches up on slots from before it was (re)defined.
    const since = Math.max(last ?? Number.NEGATIVE_INFINITY, loop.updatedAt);
    return dueRun(loop.schedule, since, now, loop.tz);
  }

  tick(): void {
    const now = this.now();
    for (const loop of this.mine()) {
      if (this.active.has(loop.name)) continue;
      if (this.active.size >= (this.o.maxConcurrent ?? 2)) return;
      const slot = this.due(loop, now);
      // A scheduled run takes whatever waits; the cooldown holds back only the runs waking adds.
      const woken = slot !== null ? this.waiting(loop.name) : this.wokenNow(loop, now);
      if (slot !== null || woken.length) this.launch(loop as RunnableLoop, slot, woken);
    }
  }

  /**
   * Something happened that wakes a loop of this node's (a webhook, new mail, a GitHub event): kept until a run takes
   * it, the same event once. A paused loop, or one that runs elsewhere, isn't woken. Returns how many were new.
   */
  wake(name: string, events: readonly WakeEvent[]): number {
    const loop = this.mine().find((l) => l.name === name);
    if (!loop || !loop.enabled || !loop.task || !loop.schedule) return 0;
    let added = 0;
    for (const event of events.slice(-MAX_WAITING)) {
      added += this.o.local.query("INSERT OR IGNORE INTO loop_wakes (loop, id, at, event, taken) VALUES (?, ?, ?, ?, NULL)").run(name, event.id, event.at, JSON.stringify(event)).changes;
    }
    // A flood keeps its newest: the oldest waiting go first.
    this.o.local
      .query("DELETE FROM loop_wakes WHERE loop = ? AND taken IS NULL AND id NOT IN (SELECT id FROM loop_wakes WHERE loop = ? AND taken IS NULL ORDER BY at DESC, id DESC LIMIT ?)")
      .run(name, name, MAX_WAITING);
    if (added) this.tick();
    return added;
  }

  /** What waits to wake a loop, oldest first. */
  waiting(name: string): WakeEvent[] {
    return this.o.local
      .query<{ event: string }, [string]>("SELECT event FROM loop_wakes WHERE loop = ? AND taken IS NULL ORDER BY at, id")
      .all(name)
      .map((row) => JSON.parse(row.event) as WakeEvent);
  }

  /** What a run would take now: everything waiting, once the loop's cooldown since it was last woken has passed. */
  private wokenNow(loop: LoopRecord, now: number): WakeEvent[] {
    if (!loop.enabled || !loop.task || !loop.schedule) return [];
    const last = this.o.local.query<{ at: number }, [string]>("SELECT at FROM loop_woke WHERE loop = ?").get(loop.name)?.at;
    if (last !== undefined && now - last < loop.cooldownMs) return [];
    return this.waiting(loop.name);
  }

  /** Run a loop now, by hand (it doesn't count as its scheduled run). */
  runNow(name: string): { run: string } {
    const loop = this.mine().find((l) => l.name === name);
    if (!loop) throw new LoopError(`loop ${name} doesn't run on this node`);
    if (!loop.task || !loop.schedule) throw new LoopError(`loop ${name} can't run here: ${loop.problem}`);
    if (this.active.has(name)) throw new LoopError(`loop ${name} is already running`);
    return { run: this.launch(loop as RunnableLoop, null, []) };
  }

  /** Resolves when a loop's current run (if any) has finished: for tests and graceful stops. */
  async settled(name?: string): Promise<void> {
    const runs = name ? [this.active.get(name)].filter((a) => a !== undefined) : [...this.active.values()];
    await Promise.all(runs.map((a) => a.done));
  }

  private launch(loop: RunnableLoop, slot: number | null, woken: readonly WakeEvent[]): string {
    const started = this.now();
    const run = slot !== null ? `s${slot.toString(36)}` : woken.length ? `w${started.toString(36)}` : `m${started.toString(36)}`;
    this.o.local.query("INSERT OR IGNORE INTO loop_runs (loop, run, slot, started) VALUES (?, ?, ?, ?)").run(loop.name, run, slot, started);
    if (woken.length) {
      // Taken by this run (kept a week, so the same event never wakes it twice); a crash in it doesn't rerun them.
      const take = this.o.local.query("UPDATE loop_wakes SET taken = ? WHERE loop = ? AND id = ?");
      for (const event of woken) take.run(run, loop.name, event.id);
      this.o.local.query("INSERT INTO loop_woke (loop, at) VALUES (?, ?) ON CONFLICT (loop) DO UPDATE SET at = excluded.at").run(loop.name, started);
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.o.deadlineMs ?? 2 * 60 * 60_000);
    const done = (async () => {
      let result: RunResult;
      try {
        result = await this.o.execute(loop, { run, slot, signal: controller.signal, woken: [...woken] });
        if (controller.signal.aborted && result.status === "ok") result = { status: "attention", summary: `Stopped: ${result.summary}` };
      } catch (error) {
        result = { status: "failed", summary: controller.signal.aborted ? "Stopped at its deadline." : String((error as Error).message ?? error) };
      } finally {
        clearTimeout(deadline);
      }
      const back = this.giveBack(loop, run, woken, result.giveBack ?? []);
      if (woken.length) result = { ...result, summary: `${wokenBy(woken, slot !== null)} ${result.summary}${back.said}` };
      this.record(loop.name, run, slot, started, result);
      this.active.delete(loop.name);
      try {
        this.o.onFinished?.(loop, result, run, { again: back.again });
      } catch (error) {
        this.o.log(`loop ${loop.name}: ${(error as Error).message}`);
      }
    })();
    this.active.set(loop.name, { run, controller, done });
    return run;
  }

  /**
   * What a run took and gave back waits again for the next run (after the cooldown, as a wake's run does), unless it has
   * been tried WAKE_RETRIES times more already. Returns what to say of it, and whether all of it is tried again.
   */
  private giveBack(loop: RunnableLoop, run: string, woken: readonly WakeEvent[], ids: readonly string[]): { said: string; again: boolean } {
    const took = new Set(woken.map((event) => event.id));
    const back = [...new Set(ids)].filter((id) => took.has(id));
    if (!back.length) return { said: "", again: false };
    const tries = this.o.local.query<{ tries: number }, [string, string, string]>("SELECT tries FROM loop_wakes WHERE loop = ? AND id = ? AND taken = ?");
    const give = this.o.local.query("UPDATE loop_wakes SET taken = NULL, tries = tries + 1 WHERE loop = ? AND id = ? AND taken = ?");
    let given = 0;
    let spent = 0;
    let most = 0;
    for (const id of back) {
      const before = tries.get(loop.name, id, run)?.tries;
      if (before === undefined) continue;
      if (before >= WAKE_RETRIES) spent += 1;
      else if (give.run(loop.name, id, run).changes) {
        given += 1;
        most = Math.max(most, before + 1);
      }
    }
    const later = `again in ${inWords(loop.cooldownMs)} (${most} of ${WAKE_RETRIES})`;
    const done = `tried ${WAKE_RETRIES + 1} times: not again`;
    const said = given && spent ? ` Some tried ${later}; the rest ${done}.` : given ? ` Tried ${later}.` : spent ? ` ${done[0]!.toUpperCase()}${done.slice(1)}.` : "";
    return { said, again: given > 0 && spent === 0 };
  }

  private record(loop: string, run: string, slot: number | null, started: number, result: { status: RunResult["status"] | "interrupted"; summary: string }): void {
    try {
      this.o.store.emit(this.o.identity, "loop.ran", {
        loop,
        run,
        slot,
        status: result.status,
        started,
        finished: Math.max(started, this.now()),
        summary: redact(result.summary).slice(0, 2000),
      });
    } catch (error) {
      this.o.log(`loop ${loop}: run not recorded: ${(error as Error).message}`);
    }
    this.o.local.query("DELETE FROM loop_runs WHERE loop = ? AND run = ?").run(loop, run);
  }
}

/** A wait, as a run's summary says it: "10 min", "2 h". */
function inWords(ms: number): string {
  return ms < 120 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${Math.round(ms / 3_600_000)} h`;
}

/** One line naming what woke a run (or what a scheduled run took with it): the first event, and how many came with it. */
export function wokenBy(woken: readonly WakeEvent[], scheduled = false): string {
  const first = woken[0]!.text.split("\n")[0]!.slice(0, 160);
  return `${scheduled ? "With" : "Woken by"} ${first}${woken.length > 1 ? ` (and ${woken.length - 1} more)` : ""}.`;
}

/**
 * Check a schedule and zone the way a runner will read them; returns the next run (null for "never", which only a
 * loop with something else to wake it may have, and for a time once that has come: only a loop kept as it was may).
 */
export function checkSchedule(text: string, tz: string, now: number, woken = false, kept = false): number | null {
  let schedule: Schedule;
  try {
    schedule = parseSchedule(text);
  } catch (error) {
    throw new LoopError(error instanceof ScheduleError ? error.message : "bad schedule");
  }
  if (schedule.kind === "never") {
    if (!woken) throw new LoopError('"never" is for a loop that something else wakes: give it a webhook, mail or GitHub to wake on');
    return null;
  }
  const next = nextRun(schedule, now, tz);
  if (next === null && schedule.kind === "once") {
    // One that has run (or whose time went by) may still be paused, resumed or named again, as it is.
    if (kept) return null;
    throw new LoopError(`${schedule.text.slice(3)} in ${tz} has passed: give a time to come`);
  }
  if (next === null) throw new LoopError("that schedule never runs");
  return next;
}
