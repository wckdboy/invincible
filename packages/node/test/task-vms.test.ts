import { describe, expect, test } from "bun:test";
import type { ExecResult, SandboxView } from "@invincible/core";
import { TASK_VM_MINUTES, TaskVms } from "../src/task-vms.ts";

/*
 * Other nodes' tasks' VMs on this node (task-vms.ts; the fabric's R3-1 (a)): one for each task, beside its agent's,
 * every command of the task run there, and gone as the task ends; one an earlier process of this node left is removed
 * before the next is made, and one that couldn't be removed is tried again then.
 */

const STARTED = Date.UTC(2026, 10, 27, 11, 0);
const done = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });

/** A host as TaskVms uses it: VMs made for tasks, their commands, their streams, their removal. */
function host(options: { left?: string[]; failRemove?: string; failTimes?: number; stays?: string; refused?: string; slow?: number } = {}) {
  const vms = new Map<string, { createdAt: number; run: string }>();
  for (const id of options.left ?? []) vms.set(id, { createdAt: STARTED - 60_000, run: `handed.task-${id}` });
  const asked: unknown[] = [], ran: { vm: string; cmd: string[] }[] = [], removed: string[] = [];
  /** Each step of a removal, in order: a lease ended, a VM removed. */
  const steps: string[] = [];
  /** The signal each VM was asked for with: its task's work's. */
  const signals: (AbortSignal | undefined)[] = [];
  let made = 0;
  const fake = {
    get: async (id: string) => (vms.has(id) ? ({ id, createdAt: vms.get(id)!.createdAt, run: vms.get(id)!.run } as unknown as SandboxView) : null),
    taskVms: async () => [...vms.keys()],
    createTaskVm: async (input: unknown, signal?: AbortSignal) => {
      asked.push(input);
      signals.push(signal);
      const id = `vm-${++made}`;
      vms.set(id, { createdAt: STARTED + made, run: (input as { run: string }).run });
      return { id } as SandboxView;
    },
    // (A command that takes `slow` ms, as one in flight does: it returns then, whatever became of its VM meanwhile.)
    exec: async (vm: string, cmd: string[]) => {
      ran.push({ vm, cmd });
      if (options.slow) await Bun.sleep(options.slow);
      return done();
    },
    stream: async () => ({ lines: (async function* () {})(), write: () => {}, close: () => {}, kill: () => {}, exited: Promise.resolve(0) }),
    destroy: async (vm: string) => {
      if (options.failRemove === vm) {
        if (!options.failTimes || --options.failTimes <= 0) options.failRemove = undefined;
        throw new Error("docker couldn't remove it");
      }
      if (options.refused === vm) {
        options.refused = undefined;
        return { verdict: "deny", reason: "not its run's" } as never;
      }
      // (Docker said nothing, and the VM is still there.)
      if (options.stays === vm) {
        options.stays = undefined;
        return { verdict: "allow" } as never;
      }
      steps.push(`removed ${vm}`);
      removed.push(vm);
      vms.delete(vm);
      return { verdict: "allow" } as never;
    },
    endLease: (vm: string) => void steps.push(`lease ended ${vm}`),
  };
  return { fake, vms, asked, ran, removed, steps, signals };
}

const ask = { vm: "agent-vm", task: "task-abcdefghijkl", providers: ["anthropic"], models: ["anthropic/claude-paid"] };

describe("another node's task's VM, on this node", () => {
  test("made for it beside its agent's, its lease its models alone; its commands there; gone as it ends, its run stopped first", async () => {
    const h = host();
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    const work = new AbortController();
    const vm = await vms.open(ask, work.signal);
    expect(h.asked).toEqual([{ task: ask.task, shares: "agent-vm", run: `handed.${ask.task}`, providers: ["anthropic"], models: ["anthropic/claude-paid"], ttlMinutes: TASK_VM_MINUTES }]);
    // (Asked for with its work's own signal: one that ends while it waits for room has none made. I-2.)
    expect(h.signals).toEqual([work.signal]);
    await vm.exec("echo one", 30, new AbortController().signal);
    expect(h.ran).toEqual([{ vm: "vm-1", cmd: ["bash", "-lc", "echo one"] }]);
    await vm.release();
    // Its run stopped (the same cleanup as a seat's), then its VM removed; released again, nothing more.
    expect(h.ran.at(-1)!.cmd.join(" ")).toContain("bash -lc");
    expect(h.removed).toEqual(["vm-1"]);
    await vm.release();
    expect(h.removed).toEqual(["vm-1"]);
  });

  test("one an earlier process left is removed before the first is made; one this process made is not", async () => {
    const h = host({ left: ["old-1", "old-2"] });
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    await vms.open(ask, new AbortController().signal);
    expect(h.removed.sort()).toEqual(["old-1", "old-2"]);
    expect([...h.vms.keys()]).toEqual(["vm-1"]);
    // (Swept once: the next takes none of this process's away.)
    await vms.open({ ...ask, task: "task-mnopqrstuvwx" }, new AbortController().signal);
    expect([...h.vms.keys()].sort()).toEqual(["vm-1", "vm-2"]);
  });

  test("one that couldn't be removed as its task ended is removed before the next is made", async () => {
    const h = host({ failRemove: "vm-1" });
    const logged: string[] = [];
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED, log: (line) => void logged.push(line) });
    await (await vms.open(ask, new AbortController().signal)).release();
    expect(h.removed).toEqual([]);
    expect(logged.some((line) => line.includes("couldn't be removed"))).toBe(true);
    await vms.open({ ...ask, task: "task-mnopqrstuvwx" }, new AbortController().signal);
    expect(h.removed).toEqual(["vm-1"]);
  });

  test("its lease ends as its task does, whatever becomes of it: one that can't be removed spends nothing more, and goes on a timer (R4-7)", async () => {
    const h = host({ failRemove: "vm-1", failTimes: 2 });
    const logged: string[] = [];
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED, log: (line) => void logged.push(line), retryMs: 10 });
    await (await vms.open(ask, new AbortController().signal)).release();
    // Its lease first, before its removal is tried; the removal failed, and nothing more was made.
    expect(h.steps).toEqual(["lease ended vm-1"]);
    expect(h.vms.has("vm-1")).toBe(true);
    expect(logged.at(-1)).toContain("its lease has ended, and it is tried again");
    // Tried again on its own, with no other task to make one: it fails once more, then goes.
    const until = Date.now() + 5_000;
    while (h.vms.has("vm-1") && Date.now() < until) await Bun.sleep(5);
    expect(h.removed).toEqual(["vm-1"]);
    expect(h.steps).toEqual(["lease ended vm-1", "lease ended vm-1", "lease ended vm-1", "removed vm-1"]);
    // And once it is gone, nothing more is tried.
    await Bun.sleep(60);
    expect(h.steps).toHaveLength(4);
  });

  test("a removal that was refused, or that Docker said nothing of while the VM stayed, is no removal: it is tried again", async () => {
    for (const how of ["refused", "stays"] as const) {
      const h = host({ [how]: "vm-1" });
      const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED, retryMs: 10 });
      await (await vms.open(ask, new AbortController().signal)).release();
      expect([how, h.vms.has("vm-1")]).toEqual([how, true]);
      const until = Date.now() + 5_000;
      while (h.vms.has("vm-1") && Date.now() < until) await Bun.sleep(5);
      expect([how, h.removed]).toEqual([how, ["vm-1"]]);
    }
  });

  test("its work's signal ending ends its lease and removes its VM at once, never once the command in flight returns (I-1)", async () => {
    const h = host({ slow: 400 });
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    const work = new AbortController();
    const vm = await vms.open(ask, work.signal);
    const began = Date.now();
    const inFlight = vm.exec("sleep 900", 900, new AbortController().signal);
    await Bun.sleep(20);
    // The owner's brake: its hand-off revoked, its work's signal ends.
    work.abort();
    for (let i = 0; i < 100 && !h.removed.includes("vm-1"); i++) await Bun.sleep(2);
    expect(h.steps).toEqual(["lease ended vm-1", "removed vm-1"]);
    // (Before the command, which takes 400 ms, came back.)
    expect(Date.now() - began).toBeLessThan(300);
    await inFlight;
    // Released after, nothing more is done.
    await vm.release();
    expect(h.removed).toEqual(["vm-1"]);
  });

  test("none is made for work that has stopped, nor where this node has no VMs", async () => {
    const h = host();
    const stopped = new AbortController();
    stopped.abort();
    await expect(new TaskVms({ host: () => h.fake as never }).open(ask, stopped.signal)).rejects.toThrow("its work has stopped");
    await expect(new TaskVms({ host: () => null }).open(ask, new AbortController().signal)).rejects.toThrow("this node has no VMs for another node's task");
    expect(h.asked).toEqual([]);
  });
});
