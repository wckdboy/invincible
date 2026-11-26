import { admit, admitGrowth, type ComputeUsage, type ComputeUse, type HostLoad, type NodeCapacity, type QueuedWork, VM_OVERHEAD, type VmOverhead } from "@galahad/core";

/*
 * The governor: this node's slots. A sandbox is admitted only when it fits inside
 * the ceiling (the owner's, or the default half) and the machine itself has room
 * (he backs off while other work is using it); otherwise it waits its turn, first
 * come, first served. Nothing here runs anything: it only says when.
 *
 * What's in use is what the node's own sandboxes hold (Docker's list is the truth,
 * `adopt`), plus those being created. Model calls have their own, simpler count.
 */

export class CapacityError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

export interface GovernorOptions {
  /** What this node may carry, derived now (the mind's calibration and ceiling). */
  capacity(): NodeCapacity;
  /** The machine, live (null: not known, so only the ceiling counts). */
  host(): Omit<HostLoad, "oursRecently"> | null;
  now?(): number;
  /** The longest a sandbox waits for a slot before its caller is told why not (default 30 minutes). */
  maxWaitMs?: number;
  /** How often waiting work looks again while only the machine's load is in the way (default 10 s). */
  retryMs?: number;
  onChange?(): void;
}

export interface Ticket {
  id: string;
}

/**
 * How long a knight's VM counts as at work after its last command ended: it thinks between commands, and a sandbox
 * admitted into that pause would find it working again. After this it rests, and its threads are free.
 */
export const KEPT_WORK_MS = 3 * 60_000;

interface Held {
  cpus: number;
  memoryGb: number;
  /**
   * A knight's own VM, kept between its tasks: never a slot; its memory of the ceiling all along, its threads only while
   * it works (a command runs in it, or ran less than KEPT_WORK_MS ago) or is being made. Resting, it uses none.
   */
  kept: boolean;
  /** Not yet a sandbox Docker lists: being created. */
  creating: boolean;
  /** When it became a sandbox (the governor's own count of such moments): a listing taken before that can't speak for it. */
  bound: number;
  /** A kept VM's commands running now. */
  running?: number;
  /** When a kept VM's last command ended. */
  workedAt?: number;
}

interface Waiting {
  need: { cpus: number; memoryGb: number };
  quest: string;
  kept: boolean;
  since: number;
  why: string;
  admit(ticket: Ticket): void;
  refuse(error: Error): void;
  cleanup(): void;
}

interface ModelWaiting {
  go(): void;
  cleanup(): void;
}

/** His own load is remembered this long: the machine's load average takes about as long to forget it. */
const OURS_FOR_MS = 90_000;

export class Governor {
  private readonly held = new Map<string, Held>();
  private readonly waiting: Waiting[] = [];
  private readonly recent: { at: number; cores: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private next = 0;
  /** Counts sandboxes coming to be: a listing of Docker is only as new as the mark taken before it was asked for. */
  private bindings = 0;
  private modelCalls = 0;
  private modelBackground = 0;
  private readonly modelWaiting: ModelWaiting[] = [];

  constructor(private readonly opts: GovernorOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * What his sandboxes hold now: every one's memory, the threads of all but knights' VMs at rest, and the slots of those
   * that aren't knights' own VMs.
   */
  use(): ComputeUse {
    let cores = 0;
    let memoryGb = 0;
    let slots = 0;
    for (const h of this.held.values()) {
      if (!h.kept || h.creating || this.working(h)) cores += h.cpus;
      memoryGb += h.memoryGb;
      if (!h.kept) slots += 1;
    }
    return { sandboxes: slots, cores, memoryGb };
  }

  private working(h: Held): boolean {
    return (h.running ?? 0) > 0 || (h.workedAt !== undefined && this.now() - h.workedAt < KEPT_WORK_MS);
  }

  /**
   * A command runs in a knight's VM: its threads count against the ceiling from now until KEPT_WORK_MS after it ends.
   * It never waits (the VM is there, and its work is under way); new work sees the less room. Returns how to say it
   * ended (once is enough). Anything that isn't a kept VM it holds is left as it is: its threads are held anyway.
   */
  work(id: string): () => void {
    const held = this.held.get(id);
    if (!held?.kept) return () => {};
    const resting = !this.working(held);
    held.running = (held.running ?? 0) + 1;
    if (resting) {
      this.remember();
      this.changed();
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      held.running = Math.max(0, (held.running ?? 1) - 1);
      held.workedAt = this.now();
    };
  }

  usage(): ComputeUsage {
    const kept = [...this.held.values()].filter((h) => h.kept).length;
    return { ...this.use(), kept, queued: this.waiting.length, modelCalls: this.modelCalls, modelQueued: this.modelWaiting.length };
  }

  /** What waits for a slot, oldest first, and why. */
  queue(): QueuedWork[] {
    return this.waiting.map((w) => ({ quest: w.quest, cpus: w.need.cpus, memoryGb: w.need.memoryGb, since: w.since, why: w.why }));
  }

  /** The machine now, with the threads his own sandboxes held lately (their load isn't the host's). */
  hostNow(): HostLoad | null {
    const host = this.opts.host();
    if (!host) return null;
    const cutoff = this.now() - OURS_FOR_MS;
    while (this.recent.length && this.recent[0]!.at < cutoff) this.recent.shift();
    return { ...host, oursRecently: Math.max(this.use().cores, ...this.recent.map((r) => r.cores)) };
  }

  private remember(): void {
    this.recent.push({ at: this.now(), cores: this.use().cores });
    if (this.recent.length > 256) this.recent.splice(0, this.recent.length - 256);
  }

  private changed(): void {
    try {
      this.opts.onChange?.();
    } catch {
      /* a watcher never stops the governor */
    }
  }

  /**
   * A sandbox it holds made bigger by `more`: held at its new size when that fits the ceiling and the machine now, and
   * the reason it doesn't otherwise (it never waits: you asked for it now). Its slot is the same one.
   */
  grow(id: string, more: { cpus: number; memoryGb: number }): string | null {
    const held = this.held.get(id);
    if (!held) return "this node holds no such sandbox";
    // A knight's VM at rest holds no threads now, but holds them all again once it works: its own count, as at work.
    const used = this.use();
    if (held.kept && !held.creating && !this.working(held)) used.cores += held.cpus;
    const verdict = admitGrowth(this.opts.capacity(), used, more, this.hostNow());
    if (!verdict.ok) return verdict.why;
    held.cpus += more.cpus;
    held.memoryGb += more.memoryGb;
    this.remember();
    this.changed();
    return null;
  }

  /** What `grow` held, given back: the VM didn't take it. */
  shrink(id: string, less: { cpus: number; memoryGb: number }): void {
    const held = this.held.get(id);
    if (!held) return;
    held.cpus = Math.max(0, held.cpus - less.cpus);
    held.memoryGb = Math.max(0, held.memoryGb - less.memoryGb);
    this.changed();
  }

  /**
   * A slot for one sandbox: resolves when it fits (at once, when it does), in turn. Rejects when the wait
   * outlasts `maxWaitMs`, the caller goes away, or this node takes no sandboxes at all.
   */
  acquire(need: { cpus: number; memoryGb: number }, meta: { quest: string; kept?: boolean }, signal?: AbortSignal): Promise<Ticket> {
    if (this.opts.capacity().sandboxes <= 0) return Promise.reject(new CapacityError("this node takes no sandboxes (its ceiling is none)", 409));
    if (signal?.aborted) return Promise.reject(new CapacityError("the caller gave up waiting for a slot", 499));
    return new Promise<Ticket>((resolve, reject) => {
      const since = this.now();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const leave = (): void => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
      };
      const onAbort = (): void => {
        leave();
        entry.cleanup();
        reject(new CapacityError("the caller gave up waiting for a slot", 499));
        this.pump();
        this.changed();
      };
      const entry: Waiting = {
        need,
        quest: meta.quest,
        kept: meta.kept === true,
        since,
        why: "",
        admit: (ticket) => {
          entry.cleanup();
          resolve(ticket);
        },
        refuse: (error) => {
          entry.cleanup();
          reject(error);
        },
        cleanup: () => {
          if (timeout) clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      this.waiting.push(entry);
      this.pump();
      if (!this.waiting.includes(entry)) return;
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        leave();
        entry.refuse(new CapacityError(`no slot came free in ${Math.round((this.opts.maxWaitMs ?? 30 * 60_000) / 60_000) || 1} minute(s): ${entry.why || "the node stayed full"}`));
        this.pump();
        this.changed();
      }, this.opts.maxWaitMs ?? 30 * 60_000);
      timeout.unref?.();
      this.changed();
    });
  }

  /** Admit from the front of the queue for as long as the next one fits. */
  private pump(): void {
    let admitted = false;
    while (this.waiting.length) {
      const head = this.waiting[0]!;
      // A knight's own VM needs room for what it holds, and no slot.
      const verdict = admit(this.opts.capacity(), this.use(), head.need, this.hostNow(), { slot: !head.kept });
      if (!verdict.ok) {
        head.why = verdict.why;
        for (const behind of this.waiting.slice(1)) behind.why ||= "others are ahead of it in the queue";
        break;
      }
      this.waiting.shift();
      this.remember();
      const ticket: Ticket = { id: `t${++this.next}` };
      this.held.set(ticket.id, { ...head.need, kept: head.kept, creating: true, bound: 0 });
      this.remember();
      head.admit(ticket);
      admitted = true;
    }
    // While something waits, look again now and then: the machine's load eases without telling anyone.
    if (this.waiting.length && !this.timer) {
      this.timer = setInterval(() => this.pump(), this.opts.retryMs ?? 10_000);
      this.timer.unref?.();
    } else if (!this.waiting.length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (admitted) this.changed();
  }

  /** The sandbox a ticket was for exists now: it's known by its id from here on. */
  bind(ticket: Ticket, sandbox: string): void {
    const held = this.held.get(ticket.id);
    if (!held) return;
    this.held.delete(ticket.id);
    this.held.set(sandbox, { ...held, creating: false, bound: ++this.bindings });
  }

  /** Take this before asking Docker for its list: `adopt` then knows which sandboxes the list is too old to speak for. */
  mark(): number {
    return this.bindings;
  }

  /** A ticket's sandbox never came to be, or a sandbox is gone: its share is free again. */
  release(what: Ticket | string): void {
    const key = typeof what === "string" ? what : what.id;
    if (!this.held.has(key)) return;
    this.remember();
    this.held.delete(key);
    this.remember();
    this.pump();
    this.changed();
  }

  /**
   * Docker's list of this node's sandboxes is the truth: ones from before a restart are counted, ones that
   * vanished (reaped, removed by hand) are freed. Sandboxes still being created are kept, and so is one
   * that came to be after the list was asked for (`asOf`: the mark taken before asking): a stale list
   * never frees the slot of a sandbox that exists.
   */
  adopt(sandboxes: readonly { id: string; cpus: number; memoryGb: number; isolation: "container" | "vm"; kept?: boolean }[], asOf = this.bindings, vm: VmOverhead = VM_OVERHEAD): void {
    const before = JSON.stringify([...this.held.entries()]);
    this.remember();
    const listed = new Set(sandboxes.map((s) => s.id));
    for (const [key, h] of this.held) if (!h.creating && h.bound <= asOf && !listed.has(key)) this.held.delete(key);
    for (const s of sandboxes) {
      if (this.held.has(s.id)) continue;
      const own = s.isolation === "vm" ? vm : null;
      this.held.set(s.id, { cpus: s.cpus + (own?.cpus ?? 0), memoryGb: s.memoryGb + (own?.memoryGb ?? 0), kept: s.kept === true, creating: false, bound: 0 });
    }
    this.remember();
    this.pump();
    if (JSON.stringify([...this.held.entries()]) !== before) this.changed();
  }

  /**
   * One model call. A background call (a quest's, an agent's) waits while every slot is taken; yours
   * (`wait: false`) never waits and isn't counted against them. Returns how to leave (idempotent).
   */
  enterModel(opts: { wait: boolean }, signal?: AbortSignal): Promise<() => void> {
    const enter = (background: boolean): (() => void) => {
      this.modelCalls += 1;
      if (background) this.modelBackground += 1;
      this.changed();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        this.modelCalls -= 1;
        if (background) this.modelBackground -= 1;
        this.pumpModels();
        this.changed();
      };
    };
    if (!opts.wait) return Promise.resolve(enter(false));
    if (signal?.aborted) return Promise.reject(new CapacityError("the caller gave up waiting for a model call", 499));
    if (!this.modelWaiting.length && this.modelBackground < Math.max(1, this.opts.capacity().modelCalls)) return Promise.resolve(enter(true));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.modelWaiting.indexOf(entry);
        if (i >= 0) this.modelWaiting.splice(i, 1);
        reject(new CapacityError("the caller gave up waiting for a model call", 499));
        this.changed();
      };
      const entry: ModelWaiting = {
        go: () => {
          entry.cleanup();
          resolve(enter(true));
        },
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      this.modelWaiting.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.changed();
    });
  }

  private pumpModels(): void {
    while (this.modelWaiting.length && this.modelBackground < Math.max(1, this.opts.capacity().modelCalls)) this.modelWaiting.shift()!.go();
  }

  /** Stop looking again (the node is stopping); whoever still waits is told. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.waiting.splice(0)) w.refuse(new CapacityError("the node is stopping"));
    for (const m of this.modelWaiting.splice(0)) m.cleanup();
  }
}
