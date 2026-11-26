import { accountSeat, chooseSeat, mayCarryOn, type NodeIdentity, redact, SEAT_HARNESS, SEAT_LIMITS, seatOpensAt, type SeatView, type TaskAccount } from "@invincible/core";
import { agentCleanupCommand, FOLLOW_SECONDS, followArgv, type FollowedRun, type SeatAnswer, type SeatRun } from "@invincible/agents";
import type { LedgerStore } from "@invincible/ledger";
import type { SandboxHost } from "@invincible/sandbox";
import { recordSeatStatus, seatViews } from "./seats.ts";

/*
 * Runs on seats on this node (I15 step 9, core's seats.ts): which seat a coding agent's run takes (chooseSeat: Invincible
 * chooses, and nothing asks you), the VM made for it from the pinned tools' image with the seat's home and the agent's
 * own /work (host.createSeatVm), and the seat let go once the run ends. A seat takes no more runs at once than it may
 * (D4). A run with no other way to go on waits for a seat that is busy, or rests until a spent one resets. Work that
 * began on a seat goes on on that seat alone among its vendor's (mayCarryOn: the rule).
 *
 * Seats live on a node: a run takes one of this node's, for an agent whose VM is on this node (its VM shares that /work).
 */

type Host = Pick<SandboxHost, "createSeatVm" | "exec" | "destroy" | "stream" | "seatVms" | "get">;

/** How long a seat's VM may live: longer than any run on it, which lets it go as it ends (its label can't be renewed). */
export const SEAT_VM_MINUTES = 7 * 24 * 60;

/** How far a window's used share moves before it is said again (a tool says it after every reply). */
export const WINDOW_STEP = 5;

export interface SeatRunsOptions {
  store: LedgerStore;
  node: NodeIdentity;
  host(): Host | null;
  now?(): number;
  /** How often a run that waits for a seat looks again besides when one is let go here (a sign-in's VM frees one unseen). */
  pollMs?: number;
  log?(line: string): void;
}

/** What a run asks for: its agent, the agent's VM on this node (and its size), its harness, the account its work began on. */
export interface SeatAsk {
  agent: string;
  vm: string;
  harness: string;
  from: TaskAccount | null;
  wait: boolean;
}

export class SeatRuns {
  /** Runs on each seat now, opened here. */
  private readonly busy = new Map<string, number>();
  /** Runs waiting for a seat to be let go. */
  private readonly waiting = new Set<() => void>();
  /** Seats' VMs that couldn't be removed as their runs ended: removed before any seat is taken again. */
  private readonly lingering = new Map<string, string>();
  /** Every seat's VM left on this node by an earlier process of it: removed before the first run takes a seat. */
  private swept: Promise<void> | null = null;

  constructor(private readonly opts: SeatRunsOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Runs on a seat now, opened here. */
  runs(seat: string): number {
    return this.busy.get(seat) ?? 0;
  }

  /**
   * Every seat's VM on this node, removed: what a run on one was doing ended with the process that ran it, and its home is
   * free again. Asked once, before the first run takes a seat (a task cut off by the restart is taken up again in its
   * session, on that seat).
   */
  sweep(): Promise<void> {
    this.swept ??= (async () => {
      const host = this.opts.host();
      if (!host) return;
      for (const seat of this.opts.store.seats().filter((s) => s.node === this.opts.node.id)) {
        for (const id of (await host.seatVms(seat.id).catch(() => null)) ?? []) await this.remove(host, id, `seat.${seat.id}`);
      }
    })();
    return this.swept;
  }

  /** A seat for a run (SeatAnswer): this node's, of its harness, chosen by headroom; or none; or, waiting, a rest until one resets. */
  async take(ask: SeatAsk, signal: AbortSignal): Promise<SeatAnswer> {
    await this.sweep();
    for (;;) {
      if (signal.aborted) throw new Error("its work has stopped");
      const host = this.opts.host();
      if (!host) return { none: true };
      for (const [id, run] of [...this.lingering]) await this.remove(host, id, run);
      const now = this.now();
      const seats = seatViews(this.opts.store, now).filter((seat) => seat.node === this.opts.node.id && SEAT_HARNESS[seat.kind] === ask.harness);
      const from = ask.from ? accountSeat(ask.from) : null;
      // The best seat first; one whose home turns out to be in use (a sign-in's VM, say) is passed over for the next, and
      // one whose VM this node can't make (no Docker on Linux here, say) isn't waited for.
      const passed = new Set<string>();
      const broken = new Set<string>();
      for (;;) {
        const chosen = chooseSeat(ask.harness, seats, (id) => (passed.has(id) ? Number.MAX_SAFE_INTEGER : this.runs(id)), now, { from });
        if (!chosen) break;
        const opened = await this.open(host, chosen, ask).catch((error: Error & { status?: number }) => {
          if (error?.status !== 409) {
            broken.add(chosen.id);
            this.opts.log?.(`seats: a VM for ${chosen.label} couldn't be made: ${redact(String(error?.message ?? error)).slice(0, 300)}`);
          }
          return null;
        });
        if (opened) return { run: opened };
        passed.add(chosen.id);
      }
      if (!ask.wait) return { none: true };
      // Those that could take it: signed in (ready, or resting until a reset), and that its work may go on on.
      const could = seats.filter((seat) => (seat.state.is === "ready" || seat.state.is === "resting") && !broken.has(seat.id) && (!from || mayCarryOn(from, seat)));
      if (!could.length) return { none: true };
      // Every one of them spent: it rests until the soonest of them is open again.
      const opens = could.map((seat) => seatOpensAt(seat, now));
      if (opens.every((at): at is number => at !== null)) {
        return { rest: { until: Math.min(...opens), why: `Every seat of yours that could take it is spent (${could.map((seat) => seat.label).join(", ")})` } };
      }
      // Some are busy: it waits for one to be let go.
      await this.wake(signal);
    }
  }

  /** A VM for a run on `seat`, sharing the agent's /work, as big as the agent's own VM: counted as one of the seat's runs. */
  private async open(host: Host, seat: SeatView, ask: SeatAsk): Promise<SeatRun> {
    const own = await host.get(ask.vm);
    if (!own) throw Object.assign(new Error("the agent's VM is not on this node"), { status: 404 });
    const run = `seat.${seat.id}`;
    this.busy.set(seat.id, this.runs(seat.id) + 1);
    let vm: string;
    try {
      vm = (await host.createSeatVm({ seat: { id: seat.id, kind: seat.kind, runs: seat.runs }, shares: ask.vm, network: "online", cpus: own.cpus, memoryGb: own.memoryGb, ttlMinutes: SEAT_VM_MINUTES, run })).id;
    } catch (error) {
      this.free(seat.id);
      throw error;
    }
    let released = false;
    const stopped = async () => {
      const ended = await host.exec(vm, ["bash", "-lc", agentCleanupCommand()], 15);
      if (ended.exitCode !== 0) throw new Error("the run on its seat could not be safely stopped");
    };
    return {
      seat: { id: seat.id, kind: seat.kind, label: seat.label },
      exec: async (command, timeoutSec, signal) => {
        if (signal.aborted) throw new Error("its work has stopped");
        return host.exec(vm, ["bash", "-lc", command], timeoutSec);
      },
      follow: async (offset, signal): Promise<FollowedRun> => {
        if (signal.aborted) throw new Error("its work has stopped");
        // (Only the fixed script, from where it is asked to start, as the follow route runs it.)
        const stream = await host.stream(vm, followArgv(offset), FOLLOW_SECONDS + 30);
        const end = () => stream.kill();
        signal.addEventListener("abort", end, { once: true });
        return { lines: stream.lines, close: () => { signal.removeEventListener("abort", end); end(); } };
      },
      stop: stopped,
      release: async (signedOut) => {
        if (released) return;
        released = true;
        try {
          await stopped().catch(() => {});
          await this.remove(host, vm, run);
        } finally {
          this.free(seat.id);
          if (signedOut) this.signedOut(seat.id);
        }
      },
    };
  }

  private async remove(host: Host, vm: string, run: string): Promise<void> {
    try {
      if (await host.get(vm)) await host.destroy(vm, { run });
      this.lingering.delete(vm);
    } catch (error) {
      this.lingering.set(vm, run);
      this.opts.log?.(`seats: a seat's VM couldn't be removed (${redact(String((error as Error)?.message ?? error)).slice(0, 200)}): tried again before the next run takes a seat`);
    }
  }

  private free(seat: string): void {
    const left = this.runs(seat) - 1;
    if (left > 0) this.busy.set(seat, left);
    else this.busy.delete(seat);
    for (const wake of [...this.waiting]) wake();
  }

  private wake(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        signal.removeEventListener("abort", stopped);
        resolve();
      };
      const stopped = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        reject(new Error("its work has stopped"));
      };
      const timer = setTimeout(done, this.opts.pollMs ?? 15_000);
      this.waiting.add(done);
      signal.addEventListener("abort", stopped, { once: true });
    });
  }

  /** Its tool said, in a run's VM, that it isn't signed in: the log says so (only when it was), and it isn't chosen again until it is. */
  private signedOut(id: string): void {
    const seat = this.opts.store.seats().find((s) => s.id === id);
    if (seat && seat.node === this.opts.node.id) recordSeatStatus(this.opts.store, this.opts.node, seat, { signedIn: false });
  }

  /**
   * A window of a seat's plan that its tool said as a run on it went: kept when it says something new (its state, its
   * reset, or its share by WINDOW_STEP or more), and when it is spent the seat rests until it resets (with none said,
   * SEAT_LIMITS.restMinutes). One that says it isn't spent before a rest it began is over ends the rest (seat.back).
   */
  window(id: string, window: { name: string; status: "allowed" | "warning" | "rejected"; usedPercent?: number; resetsAt?: number }): void {
    const seat = this.opts.store.seats().find((s) => s.id === id);
    if (!seat || seat.node !== this.opts.node.id) return;
    const now = this.now();
    const usedPercent = window.usedPercent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(window.usedPercent)));
    const resetsAt = window.resetsAt === undefined || !(window.resetsAt > 0) ? undefined : Math.round(window.resetsAt);
    const before = seat.windows.find((w) => w.window === window.name);
    const was = before?.usedPercent ?? null;
    const is = usedPercent ?? null;
    const shareMoved = was !== is && (was === null || is === null || Math.abs(was - is) >= WINDOW_STEP || is === 100);
    const fresh = !before || before.status !== window.status || before.resetsAt !== (resetsAt ?? null) || shareMoved || (before.resetsAt ?? before.at + SEAT_LIMITS.restMinutes * 60_000) <= now;
    if (fresh) this.opts.store.emit(this.opts.node, "seat.window", { id, window: window.name, status: window.status, ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) });
    if (window.status === "rejected") {
      const until = resetsAt ?? now + SEAT_LIMITS.restMinutes * 60_000;
      if (until > now && (!seat.rest || seat.rest.until < until)) this.opts.store.emit(this.opts.node, "seat.rested", { id, until, window: window.name });
    } else if (seat.rest && seat.rest.until > now && seat.rest.window === window.name) {
      this.opts.store.emit(this.opts.node, "seat.back", { id });
    }
  }
}
