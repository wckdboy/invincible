import { agentCleanupCommand, FOLLOW_SECONDS, followArgv, type FollowedRun, type HandedVm } from "@invincible/agents";
import { redact } from "@invincible/core";
import type { SandboxHost } from "@invincible/sandbox";

/*
 * Other nodes' tasks' VMs on this node (the fabric's R3-1 (a), the owner's decision of 27 November 2026): each task another
 * node hands over runs in a VM of its own beside its agent's (host.createTaskVm), every command of it, and never in the
 * agent's own VM. The VM goes as the task ends, however it ends, and with it whatever the task started there: nothing it
 * starts outlives the task, a gate, your grant or its node's revocation. One an earlier process of this node left (its
 * task's run ended with that process) is removed before the next is made.
 */

type Host = Pick<SandboxHost, "createTaskVm" | "exec" | "destroy" | "stream" | "taskVms" | "get">;

/** How long a task's VM may live: longer than any task, which removes it as it ends (a backstop, never its end). */
export const TASK_VM_MINUTES = 2 * 24 * 60;

/** What a task's VM is asked for: the agent's VM on this node, the task, and its lease (its models, and their providers). */
export interface TaskVmAsk {
  vm: string;
  task: string;
  providers: readonly string[];
  models: readonly string[];
}

export class TaskVms {
  /** Tasks' VMs that couldn't be removed as their tasks ended: removed before the next is made. */
  private readonly lingering = new Map<string, string>();
  /** Every task's VM an earlier process of this node left: removed before the first is made. */
  private swept: Promise<void> | null = null;
  /** When this process began: a task's VM made before it was an earlier process's. */
  private readonly started: number;

  constructor(private readonly opts: { host(): Host | null; now?(): number; log?(line: string): void }) {
    this.started = opts.now?.() ?? Date.now();
  }

  /** Every task's VM an earlier process of this node left, removed: its task's run ended with that process. Asked once. */
  sweep(): Promise<void> {
    this.swept ??= (async () => {
      const host = this.opts.host();
      if (!host) return;
      const vms = await host.taskVms();
      if (vms === null) throw new Error("docker couldn't say which VMs are other nodes' tasks'");
      for (const id of vms) {
        const view = await host.get(id).catch(() => null);
        if (view && view.createdAt < this.started) await this.remove(host, id, view.run);
      }
    })().catch((error: Error) => {
      // (Asked again by the next task: a listing that failed is no sweep.)
      this.swept = null;
      throw error;
    });
    return this.swept;
  }

  /** A VM of its own for another node's task, beside its agent's: its commands, its coding tool's follow and stop, and its end. */
  async open(ask: TaskVmAsk, signal: AbortSignal): Promise<HandedVm> {
    if (signal.aborted) throw new Error("its work has stopped");
    const host = this.opts.host();
    if (!host) throw new Error("this node has no VMs for another node's task");
    await this.sweep().catch((error: Error) => this.opts.log?.(`tasks' VMs: ${redact(String(error?.message ?? error)).slice(0, 200)}`));
    for (const [id, run] of [...this.lingering]) await this.remove(host, id, run);
    const run = `handed.${ask.task}`;
    const vm = (await host.createTaskVm({ task: ask.task, shares: ask.vm, run, providers: ask.providers, models: ask.models, ttlMinutes: TASK_VM_MINUTES })).id;
    let released = false;
    const stopped = async () => {
      const ended = await host.exec(vm, ["bash", "-lc", agentCleanupCommand()], 15);
      if (ended.exitCode !== 0) throw new Error("the task's run could not be safely stopped");
    };
    return {
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
      release: async () => {
        if (released) return;
        released = true;
        // (Its VM goes, and with it everything the task started there: its stop first, so its coding tool ends as it would.)
        await stopped().catch(() => {});
        await this.remove(host, vm, run);
      },
    };
  }

  private async remove(host: Host, vm: string, run: string): Promise<void> {
    try {
      if (await host.get(vm)) await host.destroy(vm, { run });
      this.lingering.delete(vm);
    } catch (error) {
      this.lingering.set(vm, run);
      this.opts.log?.(`tasks' VMs: a task's VM couldn't be removed (${redact(String((error as Error)?.message ?? error)).slice(0, 200)}): tried again before the next is made`);
    }
  }
}
