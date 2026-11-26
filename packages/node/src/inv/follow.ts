import type { ActionView, LiveEvent, LiveTopic, TeamSnapshot, TeamTask, TeamTrailEntry } from "@invincible/core";
import type { NodeClient } from "./client.ts";
import { CliError, EXIT } from "./exit.ts";
import { ended } from "./proof.ts";
import { askingAgent, waiting } from "./view.ts";

/*
 * Following a task to its end (inv watch, inv give --wait, --stream): its trail read as it grows (only what is new,
 * as the apps read it), with its snapshot and the approvals its agent waits on. It is woken by the node's live stream
 * when the work changes, and looks again every so often all the same. It never stops the task, but for one thing:
 * --no-ask, which stops a task that comes to need you, so nothing waits forever for a person. Ctrl-C (the signal)
 * only leaves.
 */

export interface Update {
  task: TeamTask;
  snapshot: TeamSnapshot;
  /** Every line of its trail so far, and the ones new since the last update. */
  entries: readonly TeamTrailEntry[];
  fresh: readonly TeamTrailEntry[];
  actions: readonly ActionView[];
}

export type Left = "timeout" | "needs-you" | "interrupted";

export interface FollowEnd {
  last: Update;
  /** Why inv left before the task ended (absent: it ended). */
  left?: Left;
}

export interface FollowOptions {
  /** Each look: what is new is in `fresh`. */
  onUpdate(update: Update): void | Promise<void>;
  /** --no-ask: a task that comes to need you is stopped, and its agent's waiting approvals declined. */
  noAsk?: boolean;
  /** When --timeout runs out (ms since the epoch). */
  deadline?: number;
  /** Aborted by Ctrl-C: inv leaves, and the task goes on. */
  signal?: AbortSignal;
  /** How long between looks when nothing wakes it (default 5 s; the live stream wakes it sooner). */
  pollMs?: number;
  now?: () => number;
}

/** Whether a task waits on you now: a proposal, work cut short, or its agent asking for your approval as it works. */
export function needsYou(task: Pick<TeamTask, "status" | "assignee">, actions: readonly ActionView[]): boolean {
  if (task.status === "proposed" || task.status === "interrupted") return true;
  return task.status === "running" && waiting(actions).some((action) => askingAgent(action) === task.assignee);
}

/**
 * Woken by the live stream (core's live.ts) when one of `topics` changes, or after `ms` whatever happens. A stream that
 * breaks is opened again a little later; one this device may not open (no scope for it) leaves the timer alone.
 */
export class Waker {
  private pending: (() => void) | null = null;
  private dirty = false;
  private readonly stop = new AbortController();

  constructor(
    private readonly client: NodeClient,
    private readonly topics: readonly LiveTopic[],
    signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", () => this.close(), { once: true });
    void this.listen();
  }

  private wake(): void {
    this.dirty = true;
    this.pending?.();
  }

  private async listen(): Promise<void> {
    for (let pause = 1000; !this.stop.signal.aborted; pause = Math.min(pause * 2, 30_000)) {
      try {
        for await (const data of this.client.events("live", undefined, this.stop.signal)) {
          pause = 1000;
          const event = JSON.parse(data) as LiveEvent;
          if (event.type === "hello" || (event.type === "changed" && event.topics.some((topic) => this.topics.includes(topic)))) this.wake();
        }
      } catch (error) {
        if (this.stop.signal.aborted) return;
        if (error instanceof CliError && error.exit === EXIT.refused) return;
      }
      await Bun.sleep(pause);
    }
  }

  /** Resolves when something changed since the last time, or after `ms`. */
  async next(ms: number): Promise<void> {
    if (this.dirty) {
      this.dirty = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      this.stop.signal.addEventListener("abort", onAbort, { once: true });
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.pending = () => {
        this.stop.signal.removeEventListener("abort", onAbort);
        done();
      };
    });
    this.pending = null;
    this.dirty = false;
  }

  close(): void {
    this.stop.abort();
    this.pending?.();
  }
}

/** A task's trail after line `after`, every page of it. */
async function trailAfter(client: NodeClient, task: string, after: number, signal?: AbortSignal): Promise<TeamTrailEntry[]> {
  const out: TeamTrailEntry[] = [];
  for (let page = 0; page < 1000; page++) {
    const read = await client.call<{ entries: TeamTrailEntry[]; more: boolean }>("teamTrail", { task, after: out.at(-1)?.n ?? after }, signal);
    out.push(...read.entries);
    if (!read.more || !read.entries.length) break;
  }
  return out;
}

/** The task from the snapshot, or a refusal that says there is none. */
export function taskIn(snapshot: TeamSnapshot, id: string): TeamTask {
  const task = snapshot.tasks.find((one) => one.id === id);
  if (!task) throw new CliError(`no task ${id} on this node (inv tasks lists them)`);
  return task;
}

export async function follow(client: NodeClient, id: string, opts: FollowOptions): Promise<FollowEnd> {
  const now = opts.now ?? Date.now;
  const aborted = (): boolean => opts.signal?.aborted === true;
  const waker = new Waker(client, ["team", "actions"], opts.signal);
  const entries: TeamTrailEntry[] = [];
  let last: Update | null = null;
  /** Leaving: with the last look, or (left before the first look came back) said as leaving. */
  const leave = (left: Left): FollowEnd => {
    if (!last) throw new CliError(`left before ${id} could be read: it goes on (inv watch ${id})`, EXIT.stillRunning);
    return { last, left };
  };
  try {
    for (;;) {
      let fresh: TeamTrailEntry[];
      let snapshot: TeamSnapshot;
      let actions: ActionView[];
      try {
        // The snapshot first, then the trail: the runner writes a task's lines before it marks the task ended, so a
        // trail read after a snapshot that says it ended holds all of them (its review among them).
        [snapshot, actions] = await Promise.all([
          client.call<TeamSnapshot>("team", undefined, opts.signal),
          client.call<{ actions: ActionView[] }>("actions", undefined, opts.signal).then(
            (read) => read.actions,
            (error: CliError) => {
              if (error?.exit === EXIT.unreachable || aborted()) throw error;
              return [] as ActionView[];
            },
          ),
        ]);
        fresh = await trailAfter(client, id, entries.at(-1)?.n ?? 0, opts.signal);
      } catch (error) {
        if (aborted()) return leave("interrupted");
        throw error;
      }
      entries.push(...fresh);
      const task = taskIn(snapshot, id);
      last = { task, snapshot, entries, fresh, actions };
      await opts.onUpdate(last);
      if (ended(task.status)) return { last };
      if (opts.noAsk && needsYou(task, actions)) {
        await client.call("controlTeam", { task: id, action: "stop" });
        // Its agent's approvals for this work would wait for nobody: declined, as you would decline them.
        for (const action of waiting(actions).filter((one) => askingAgent(one) === task.assignee)) {
          await client.call("decideAction", { id: action.id, approve: false, note: "Declined by inv --no-ask: nobody waits for a person." }).catch(() => {});
        }
        return leave("needs-you");
      }
      if (aborted()) return leave("interrupted");
      if (opts.deadline !== undefined && now() >= opts.deadline) return leave("timeout");
      const wait = Math.min(opts.pollMs ?? 5000, opts.deadline !== undefined ? Math.max(0, opts.deadline - now()) : Number.POSITIVE_INFINITY);
      await waker.next(wait);
      if (aborted()) return leave("interrupted");
    }
  } finally {
    waker.close();
  }
}
