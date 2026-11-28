import { agentCleanupCommand, FOLLOW_SECONDS, followArgv, HANDED_CHANGES_BYTES, type FollowedRun, type HandedRound, type HandedVm } from "@invincible/agents";
import { redact } from "@invincible/core";
import type { SandboxHost } from "@invincible/sandbox";

/*
 * Other nodes' tasks' VMs on this node (the fabric's R3-1 (a), the owner's decision of 27 November 2026): each task another
 * node hands over runs in a VM of its own beside its agent's (host.createTaskVm), every command of it, and never in the
 * agent's own VM. The VM goes as the task ends, however it ends, and with it whatever the task started there: nothing it
 * starts outlives the task, a gate, your grant or its node's revocation. One an earlier process of this node left (its
 * task's run ended with that process) is removed before the next is made. Its lease ends first, whatever becomes of the
 * VM (the fourth fabric review's R4-7): one that can't be removed spends nothing more of yours, is never renewed with its
 * agent's again, and is tried again on a timer until it is gone, as well as before the next is made.
 *
 * Each round of its gates runs in a VM of the round's own beside it (host.createGateVm, the eleventh fabric review's
 * ruling): no network, no lease, nothing of the task's VM in it, and no process of the task's ever run there. It is given
 * the task's tree through this host as the round begins, and goes when the next round begins, or with the task, as the
 * task's VM does.
 */

/** How long after a removal that failed it is tried again, at first; each one that fails waits twice as long, up to RETRY_MAX_MS. */
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

type Host = Pick<SandboxHost, "createTaskVm" | "createGateVm" | "sweepGates" | "hasInstallCache" | "fillCache" | "exec" | "destroy" | "stream" | "taskVms" | "get" | "endLease" | "pipe" | "makesSandboxes">;

/**
 * A command of the node's in a task's VM: a shell that reads no profile of the task's (the eighth fabric review's R8-3).
 * The VM's HOME and workspace are the task's to write, so a login shell there runs what the task put in its profile before
 * the node's command: a python3 that said each gate passed, in the review's PoC. Its environment is the VM's own, as
 * Docker gives each exec: the task changes none of it. The task's own commands get their login shell inside the gateway's
 * (team-runtime.ts withGateway), under the node's helper, never around it.
 */
const shell = (command: string): string[] => ["bash", "--noprofile", "--norc", "-c", command];

/**
 * The node's install cache filled for a round of a task's gates (sandbox install-cache.ts): the manifests `fill` prints in
 * the task's VM (a gzipped tar, as base64), given as they are to the node's filler, which unpacks and checks them itself.
 * Null when there are none (the tree has no bun.lock).
 */
async function filled(host: Host, vm: string, fill: string): Promise<HandedRound["cache"]> {
  const began = Date.now();
  const said = (r: { stderr: string; stdout: string }) => redact(r.stderr || r.stdout).trim().split("\n").at(-1)?.slice(0, 300) || "no reason given";
  const read = await host.exec(vm, shell(fill), 120).catch((error: Error) => ({ exitCode: -1, stdout: "", stderr: error.message, durationMs: 0, truncated: false }));
  if (read.exitCode !== 0 || read.truncated) return { filled: false, said: read.truncated ? "its manifests were too big to read" : said(read), ms: Date.now() - began };
  const text = read.stdout.trim();
  if (!text) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return { filled: false, said: "its manifests couldn't be read", ms: Date.now() - began };
  const ran = await host.fillCache(vm, Buffer.from(text, "base64"), 600).catch((error: Error) => ({ exitCode: -1, stdout: "", stderr: error.message, durationMs: 0, truncated: false }));
  return { filled: ran.exitCode === 0, said: ran.exitCode === 0 ? "" : said(ran), ms: Date.now() - began };
}

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
  /** The next try at the lingering ones, while any lingers, and how long it waits. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wait: number;

  constructor(private readonly opts: { host(): Host | null; now?(): number; log?(line: string): void; retryMs?: number }) {
    this.started = opts.now?.() ?? Date.now();
    this.wait = opts.retryMs ?? RETRY_MS;
  }

  /**
   * Every task's VM an earlier process of this node left, removed: its task's run ended with that process. Asked once.
   * A node that makes no sandboxes (no image; a Mac without its sandbox firewall) has none, and its engine is asked for
   * no list, so it says nothing of one (the Mac mini's doctor read the listing it couldn't make as trouble, 28 November
   * 2026); asked again by the next task, which finds them once it makes sandboxes.
   */
  sweep(): Promise<void> {
    this.swept ??= (async () => {
      const host = this.opts.host();
      if (!host) return;
      if (!(await host.makesSandboxes())) {
        this.swept = null;
        return;
      }
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
    // (Its work's own signal: a task that ends while its VM waits for room has none made.)
    const vm = (await host.createTaskVm({ task: ask.task, beside: ask.vm, run, providers: ask.providers, models: ask.models, ttlMinutes: TASK_VM_MINUTES }, signal)).id;
    let released = false;
    /** The VM of its gates' round under way: the next round's, and the task's end, remove it. */
    let gating: string | null = null;
    const endRound = async () => {
      const was = gating;
      gating = null;
      if (was) await this.remove(host, was, run);
    };
    // When its work's signal ends (its hand-off revoked: your brake), its lease ends and its VM goes at once, and the
    // command in flight with it: none keeps model access until it returns. The fifth fabric review's I-1.
    const brake = () => {
      void endRound();
      // (Released already, its stop may still be running before its removal: its lease ends now all the same.)
      if (released) return host.endLease(vm);
      released = true;
      void this.remove(host, vm, run);
    };
    if (signal.aborted) brake();
    else signal.addEventListener("abort", brake, { once: true });
    const stopped = async () => {
      const ended = await host.exec(vm, shell(agentCleanupCommand()), 15);
      if (ended.exitCode !== 0) throw new Error("the task's run could not be safely stopped");
    };
    return {
      exec: async (command, timeoutSec, signal) => {
        if (signal.aborted) throw new Error("its work has stopped");
        return host.exec(vm, shell(command), timeoutSec);
      },
      // A round of its gates, in a VM of its own (the eleventh fabric review's ruling): made new, the round before's gone
      // first, and given the task's tree as `take` prints it here to `store` there (its own user's, through this host,
      // never kept here). Its gates and the node's checks then run there as their own user in their own folder (execArgs,
      // VM_GATES), and every process of theirs is ended there from an exec of its own before each copy (sweepGates).
      round: async (take, store, fill, timeoutSec, signal): Promise<HandedRound> => {
        if (signal.aborted) throw new Error("its work has stopped");
        await endRound();
        // Its install cache filled first, from the tree's manifests alone, as the round's VM mounts it as it is made.
        const cache = fill && host.hasInstallCache() ? await filled(host, vm, fill) : null;
        if (signal.aborted) throw new Error("its work has stopped");
        const gate = (await host.createGateVm({ task: ask.task, of: vm, beside: ask.vm, run, ttlMinutes: TASK_VM_MINUTES }, signal)).id;
        gating = gate;
        // (A task that ended while it was made has it removed now: its end removed the round it knew of.)
        if (signal.aborted || released) {
          await endRound();
          throw new Error("its work has stopped");
        }
        const taken = await host.pipe({ id: vm, cmd: shell(take) }, { id: gate, cmd: shell(store) }, { timeoutSec, maxBytes: Number.POSITIVE_INFINITY });
        return {
          taken,
          cache,
          gates: async (command, timeoutSec, signal) => {
            if (signal.aborted || gating !== gate) throw new Error("its work has stopped");
            return host.exec(gate, shell(command), timeoutSec, undefined, "gates");
          },
          sweep: async (signal) => {
            if (signal.aborted || gating !== gate) throw new Error("its work has stopped");
            return host.sweepGates(gate);
          },
        };
      },
      follow: async (offset, signal): Promise<FollowedRun> => {
        if (signal.aborted) throw new Error("its work has stopped");
        // (Only the fixed script, from where it is asked to start, as the follow route runs it.)
        const stream = await host.stream(vm, followArgv(offset), FOLLOW_SECONDS + 30);
        const end = () => stream.kill();
        signal.addEventListener("abort", end, { once: true });
        return { lines: stream.lines, close: () => { signal.removeEventListener("abort", end); end(); } };
      },
      // Its clone, from its agent's VM, and its changes, back to it (the fifth fabric review's R5-3): what one side's command
      // prints is the other's input, through this host alone, never kept here. Its clone is the node's own making, of its
      // agent's repository, bounded by its time and its VM's disk; its changes are the task's, held to HANDED_CHANGES_BYTES.
      receive: async (fromAgent, intoTask, timeoutSec, signal) => {
        if (signal.aborted) throw new Error("its work has stopped");
        return host.pipe({ id: ask.vm, cmd: shell(fromAgent) }, { id: vm, cmd: shell(intoTask) }, { timeoutSec, maxBytes: Number.POSITIVE_INFINITY });
      },
      send: async (fromTask, intoAgent, timeoutSec, signal) => {
        if (signal.aborted) throw new Error("its work has stopped");
        return host.pipe({ id: vm, cmd: shell(fromTask) }, { id: ask.vm, cmd: shell(intoAgent) }, { timeoutSec, maxBytes: HANDED_CHANGES_BYTES });
      },
      stop: stopped,
      release: async () => {
        signal.removeEventListener("abort", brake);
        // (Its gates' round's VM goes with it.)
        await endRound();
        if (released) return;
        released = true;
        // (Its VM goes, and with it everything the task started there: its stop first, so its coding tool ends as it would.)
        await stopped().catch(() => {});
        await this.remove(host, vm, run);
      },
    };
  }

  private async remove(host: Host, vm: string, run: string): Promise<void> {
    // (Its lease first, whatever becomes of it.)
    host.endLease(vm);
    try {
      if (await host.get(vm)) {
        const decision = await host.destroy(vm, { run });
        if (decision.verdict !== "allow") throw new Error(`its removal was refused: ${decision.reason ?? decision.verdict}`);
        // (Docker may say nothing of a removal that didn't take: it is asked whether the VM is still there.)
        if (await host.get(vm)) throw new Error("it is still there after its removal");
      }
      this.lingering.delete(vm);
    } catch (error) {
      this.lingering.set(vm, run);
      this.opts.log?.(`tasks' VMs: a task's VM couldn't be removed (${redact(String((error as Error)?.message ?? error)).slice(0, 200)}): its lease has ended, and it is tried again`);
    }
    this.retry();
  }

  /** While a task's VM lingers, its removal tried again on a timer that keeps no process alive, waiting longer each time. */
  private retry(): void {
    if (!this.lingering.size) {
      this.wait = this.opts.retryMs ?? RETRY_MS;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wait = Math.min(this.wait * 2, RETRY_MAX_MS);
      const host = this.opts.host();
      if (!host) return this.retry();
      void (async () => {
        for (const [id, run] of [...this.lingering]) await this.remove(host, id, run);
      })();
    }, this.wait);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
