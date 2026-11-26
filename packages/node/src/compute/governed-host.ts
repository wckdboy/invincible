import { clampNeed, type Decision, type ExecResult, type NodeCapacity, type SandboxView } from "@galahad/core";
import { type CreateInput, type DesktopAction, type DesktopView, SandboxError, SandboxHost, type SandboxHostOptions } from "@galahad/sandbox";
import { CapacityError, type Governor } from "./governor.ts";

/*
 * This node's sandbox host, behind its governor: every sandbox it creates, whoever
 * asks (a quest, an agent, the owner, a calibration), first takes a
 * slot, and waits for one when the node is full. There is no other door: the node
 * holds only this host. A request for more than the ceiling gets the ceiling (a
 * sandbox's CPUs and memory are limits, not promises), and the ledger says so.
 */

export interface GovernedOptions {
  governor: Governor;
  /** What this node may carry, derived now. */
  capacity(): NodeCapacity;
}

export class GovernedSandboxHost extends SandboxHost {
  constructor(
    options: SandboxHostOptions,
    private readonly governed: GovernedOptions,
  ) {
    super(options);
  }

  /** `wait.signal`: the caller went away while it queued, so it leaves the queue (a sandbox being created is finished). */
  override async create(input: CreateInput, wait: { signal?: AbortSignal } = {}): Promise<SandboxView> {
    // What this host won't make (on a Mac: no network at all, an image not built for it) never waits for a slot first.
    const cannot = this.refusal(input);
    if (cannot) throw new SandboxError(cannot, 424);
    const capacity = this.governed.capacity();
    // (What it runs as is the host's to say: on a Mac every sandbox is a VM, its overhead counted.)
    const vm = this.isolationFor(input.network, input.isolation) === "vm" ? this.vmOverhead : null;
    // A VM's own kernel and VMM take room on top of the sandbox: a ceiling that can't hold both carries none.
    if (vm && (capacity.cores < vm.cpus + 0.25 || capacity.memoryGb < vm.memoryGb + 0.25)) {
      throw new SandboxError(`this node's ceiling (${capacity.cores} threads, ${capacity.memoryGb} GB) is too small for a microVM, which takes ${vm.cpus} thread and ${vm.memoryGb} GB of its own`, 409);
    }
    // What the sandbox itself gets: never more than the ceiling, less a VM's own overhead; whole CPUs where a VM's are.
    const within = Math.max(0.25, Math.min(input.cpus, capacity.cores - (vm?.cpus ?? 0)));
    const cpus = this.wholeCpus ? Math.max(1, Math.ceil(within)) : within;
    const memoryGb = Math.max(0.25, Math.min(input.memoryGb, capacity.memoryGb - (vm?.memoryGb ?? 0)));
    const need = clampNeed(capacity, { cpus, memoryGb }, vm);
    let ticket: Awaited<ReturnType<Governor["acquire"]>>;
    try {
      // A persistent one (a knight's own VM) takes no slot: it holds its memory of the ceiling, and its threads while it works.
      ticket = await this.governed.governor.acquire(need, { quest: input.quest ?? "adhoc", kept: input.persistent }, wait.signal);
    } catch (error) {
      if (error instanceof CapacityError) throw new SandboxError(error.message, error.status);
      throw error;
    }
    try {
      const view = await super.create({ ...input, cpus, memoryGb });
      this.governed.governor.bind(ticket, view.id);
      return view;
    } catch (error) {
      this.governed.governor.release(ticket);
      throw error;
    }
  }

  /** A command in a knight's VM: its threads count against the ceiling while it runs, and a while after (the governor's `work`). */
  override async exec(id: string, cmd: string[], timeoutSec?: number): Promise<ExecResult> {
    const ended = this.governed.governor.work(id);
    try {
      return await super.exec(id, cmd, timeoutSec);
    } finally {
      ended();
    }
  }

  /**
   * A terminal in a knight's VM: what you run there is work as much as its own commands are, so its threads count
   * against the ceiling from the moment it opens until a while after it closes.
   */
  override async terminal(id: string, size: { cols: number; rows: number }, onData: (bytes: Uint8Array) => void): ReturnType<SandboxHost["terminal"]> {
    const opened = await super.terminal(id, size, onData);
    const ended = this.governed.governor.work(id);
    void opened.process.exited.finally(ended);
    return opened;
  }

  /** What is done on a knight's desktop (yours, or Galahad's on his computer) is work in its VM too: a click opens a page, and the page runs. */
  override async desktop(id: string, quest: string, action: DesktopAction): Promise<DesktopView> {
    const ended = this.governed.governor.work(id);
    try {
      return await super.desktop(id, quest, action);
    } finally {
      ended();
    }
  }

  /** A knight's VM grown while it runs: what it adds is held of the ceiling first, and given back if the VM doesn't take it. */
  override async resizeTeam(id: string, quest: string, opts: Parameters<SandboxHost["resizeTeam"]>[2]): Promise<SandboxView> {
    let held: { cpus: number; memoryGb: number } | null = null;
    try {
      return await super.resizeTeam(id, quest, {
        ...opts,
        fits: (more) => {
          const why = this.governed.governor.grow(id, more);
          if (!why) held = more;
          return why;
        },
      });
    } catch (error) {
      if (held) this.governed.governor.shrink(id, held);
      throw error;
    }
  }

  override async destroy(id: string, opts: { approvedBy?: string; quest?: string } = {}): Promise<Decision> {
    const decision = await super.destroy(id, opts);
    if (decision.verdict === "allow") this.governed.governor.release(id);
    return decision;
  }

  override async reap(): Promise<string[]> {
    const reaped = await super.reap();
    await this.reconcile();
    return reaped;
  }

  /** Bring the governor in line with Docker's own list (at start, after reaping, now and then). */
  async reconcile(): Promise<void> {
    // When Docker can't say, nothing changes: a list that failed is never read as "no sandboxes" (which would free every slot).
    // The mark first: a sandbox that comes to be while Docker answers isn't in this list, and keeps its slot.
    const asOf = this.governed.governor.mark();
    const listed = await this.listed();
    if (listed) this.governed.governor.adopt(listed.map((s) => ({ id: s.id, cpus: s.cpus, memoryGb: s.memoryGb, isolation: s.isolation, kept: !s.ephemeral })), asOf, this.vmOverhead);
  }
}
