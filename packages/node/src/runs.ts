import { type RunProgressInput, runInHand, type RunView, redact } from "@invincible/core";

/*
 * The runs in hand, as this node shows them: whoever runs a run (a terminal's
 * `invincible do`, a loop here) reports where it stands, and every device sees the plan,
 * the step it's on and each gate's last result.
 *
 * A view, not a record: in memory, bounded, and gone with the node (the ledger has every
 * command, the mind the outcome). Each reporter has its own runs, so an agent can't
 * write over yours; everything shown is redacted again here.
 */

/** A run in hand not heard from for this long is shown as silent (its runner may be gone). */
export const RUN_SILENT_MS = 20 * 60_000;
/** Ended runs stay on show this long. */
const KEEP_ENDED_MS = 24 * 60 * 60_000;
const MAX_RUNS = 200;
const MAX_PER_REPORTER = 40;

interface Entry {
  by: string;
  progress: RunProgressInput;
  startedAt: number;
  updatedAt: number;
  /** What it says is your private data (a run that mail woke): only your devices see it (server.ts). Once so, always. */
  secret?: true;
}

export class RunBoard {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Called after every report (notify.ts tells you when one of yours has ended). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Where a run stands, as its runner says. `by`: who that is ("you", a loop, an agent). `secret`: its words are your private data. */
  report(by: string, progress: RunProgressInput, secret = false): void {
    const key = `${by}\n${progress.run}`;
    const at = this.now();
    const clean: RunProgressInput = {
      ...progress,
      goal: redact(progress.goal),
      ...(progress.plan !== undefined ? { plan: redact(progress.plan) } : {}),
      ...(progress.doing !== undefined ? { doing: redact(progress.doing) } : {}),
      ...(progress.summary !== undefined ? { summary: redact(progress.summary) } : {}),
      gates: progress.gates.map((g) => ({ ...g, command: redact(g.command), ...(g.excerpt !== undefined ? { excerpt: redact(g.excerpt) } : {}) })),
    };
    const known = this.entries.get(key);
    // An ended run stays ended: a late report from a step that was still in flight doesn't bring it back.
    if (known && !runInHand(known.progress.state) && runInHand(clean.state)) return;
    this.entries.delete(key);
    this.entries.set(key, { by, progress: clean, startedAt: known?.startedAt ?? at, updatedAt: at, ...(secret || known?.secret ? { secret: true as const } : {}) });
    this.trim(by);
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a listener's problem */
      }
    }
  }

  /** Whether what a run says is your private data, as it was when it was reported. */
  secret(by: string, run: string): boolean {
    return this.entries.get(`${by}\n${run}`)?.secret === true;
  }

  /** In hand first (the latest word first), then the ones that ended, most recent first. */
  list(): RunView[] {
    const now = this.now();
    for (const [key, entry] of this.entries) if (!runInHand(entry.progress.state) && now - entry.updatedAt > KEEP_ENDED_MS) this.entries.delete(key);
    return [...this.entries.values()]
      .map((e): RunView => ({ ...e.progress, by: e.by, startedAt: e.startedAt, updatedAt: e.updatedAt, silent: runInHand(e.progress.state) && now - e.updatedAt > RUN_SILENT_MS }))
      .sort((a, b) => Number(runInHand(b.state)) - Number(runInHand(a.state)) || b.updatedAt - a.updatedAt);
  }

  private trim(by: string): void {
    const mine = [...this.entries].filter(([, e]) => e.by === by);
    // The oldest of a reporter's go first, ended ones before any in hand.
    const spare = (list: [string, Entry][], over: number): void => {
      const order = [...list].sort(([, a], [, b]) => Number(runInHand(a.progress.state)) - Number(runInHand(b.progress.state)) || a.updatedAt - b.updatedAt);
      for (const [key] of order.slice(0, Math.max(0, over))) this.entries.delete(key);
    };
    spare(mine, mine.length - MAX_PER_REPORTER);
    spare([...this.entries], this.entries.size - MAX_RUNS);
  }
}
