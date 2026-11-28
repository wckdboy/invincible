import { describe, expect, test } from "bun:test";
import type { ExecResult, SandboxView } from "@invincible/core";
import { HANDED_CHANGES_BYTES } from "@invincible/agents";
import { TASK_VM_MINUTES, TaskVms } from "../src/task-vms.ts";

/*
 * Other nodes' tasks' VMs on this node (task-vms.ts; the fabric's R3-1 (a)): one for each task, beside its agent's,
 * every command of the task run there, and gone as the task ends; one an earlier process of this node left is removed
 * before the next is made, and one that couldn't be removed is tried again then.
 */

const STARTED = Date.UTC(2026, 10, 27, 11, 0);
const done = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, truncated: false });

/** A host as TaskVms uses it: VMs made for tasks, their commands, their streams, their removal. */
function host(options: { left?: string[]; failRemove?: string; failTimes?: number; stays?: string; refused?: string; slow?: number; makes?: boolean; unlisted?: boolean; cache?: "fills" | "fails"; manifests?: string } = {}) {
  const vms = new Map<string, { createdAt: number; run: string }>();
  /** How often its engine was asked which VMs are other nodes' tasks'. */
  let listed = 0;
  for (const id of options.left ?? []) vms.set(id, { createdAt: STARTED - 60_000, run: `handed.task-${id}` });
  const asked: unknown[] = [], ran: { vm: string; cmd: string[]; as?: number }[] = [], removed: string[] = [];
  /** Each round's VM as it was asked for, each sweep of one, and each fill of the install cache. */
  const rounds: unknown[] = [], swept: { vm: string; uid: number }[] = [], counted: { vm: string; uid: number }[] = [], filled: { vm: string; manifests: string }[] = [];
  /** Each pipe between two VMs, as the host was asked for it: from which VM's command to which. */
  const piped: { from: { id: string; cmd: string[] }; to: { id: string; cmd: string[] }; maxBytes: number }[] = [];
  /** Each step of a removal, in order: a lease ended, a VM removed. */
  const steps: string[] = [];
  /** The signal each VM was asked for with: its task's work's. */
  const signals: (AbortSignal | undefined)[] = [];
  let made = 0;
  const fake = {
    get: async (id: string) => (vms.has(id) ? ({ id, createdAt: vms.get(id)!.createdAt, run: vms.get(id)!.run } as unknown as SandboxView) : null),
    // (Whether it makes sandboxes, as SandboxHost.makesSandboxes says: by default it does. `unlisted`: its engine can't say.)
    makesSandboxes: async () => options.makes ?? true,
    taskVms: async () => {
      listed++;
      return options.unlisted ? null : [...vms.keys()];
    },
    createTaskVm: async (input: unknown, signal?: AbortSignal) => {
      asked.push(input);
      signals.push(signal);
      const id = `vm-${++made}`;
      vms.set(id, { createdAt: STARTED + made, run: (input as { run: string }).run });
      return { id } as SandboxView;
    },
    createGateVm: async (input: unknown, signal?: AbortSignal) => {
      rounds.push(input);
      signals.push(signal);
      const id = `gate-${++made}`;
      vms.set(id, { createdAt: STARTED + made, run: (input as { run: string }).run });
      return { id } as SandboxView;
    },
    sweepGates: async (vm: string, uid: number) => {
      swept.push({ vm, uid });
      return done();
    },
    gateLeft: async (vm: string, uid: number) => {
      counted.push({ vm, uid });
      return done("0\n");
    },
    hasInstallCache: () => !!options.cache,
    fillCache: async (vm: string, manifests: Uint8Array) => {
      filled.push({ vm, manifests: Buffer.from(manifests).toString() });
      return options.cache === "fails" ? { ...done(), exitCode: 1, stderr: "its bun.lock names x@github:y/z, which isn't the default registry's, so nothing is filled" } : done();
    },
    // (A command that takes `slow` ms, as one in flight does: it returns then, whatever became of its VM meanwhile.)
    exec: async (vm: string, cmd: string[], _timeoutSec?: number, _check?: unknown, as?: number) => {
      ran.push({ vm, cmd, ...(as !== undefined ? { as } : {}) });
      if (options.slow) await Bun.sleep(options.slow);
      // (The manifests' read, in the task's VM: what it prints, base64.)
      if (cmd.at(-1) === "read-the-manifests") return done(options.manifests ?? "");
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
    pipe: async (from: { id: string; cmd: string[] }, to: { id: string; cmd: string[] }, opts: { timeoutSec: number; maxBytes: number }) => {
      piped.push({ from, to, maxBytes: opts.maxBytes });
      return { from: done(), to: done(), bytes: 0, cut: false };
    },
  };
  return { fake, vms, asked, rounds, swept, counted, filled, ran, removed, steps, signals, piped, listed: () => listed };
}

const ask = { vm: "agent-vm", task: "task-abcdefghijkl", providers: ["anthropic"], models: ["anthropic/claude-paid"] };

describe("another node's task's VM, on this node", () => {
  test("made for it beside its agent's, its lease its models alone; its commands there; gone as it ends, its run stopped first", async () => {
    const h = host();
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    const work = new AbortController();
    const vm = await vms.open(ask, work.signal);
    expect(h.asked).toEqual([{ task: ask.task, beside: "agent-vm", run: `handed.${ask.task}`, providers: ["anthropic"], models: ["anthropic/claude-paid"], ttlMinutes: TASK_VM_MINUTES }]);
    // (Asked for with its work's own signal: one that ends while it waits for room has none made. I-2.)
    expect(h.signals).toEqual([work.signal]);
    await vm.exec("echo one", 30, new AbortController().signal);
    // (A shell that reads no profile of the task's: its HOME is the task's to write. R8-3.)
    expect(h.ran).toEqual([{ vm: "vm-1", cmd: ["bash", "--noprofile", "--norc", "-c", "echo one"] }]);
    await vm.release();
    // Its run stopped (the same cleanup as a seat's), then its VM removed; released again, nothing more.
    expect(h.ran.at(-1)!.cmd.slice(0, 4)).toEqual(["bash", "--noprofile", "--norc", "-c"]);
    expect(h.removed).toEqual(["vm-1"]);
    await vm.release();
    expect(h.removed).toEqual(["vm-1"]);
  });

  test("each round of its gates in a VM of the round's own beside it: given its tree through this host, its gates there as their own user, swept there, and gone with the next round and with the task (R11-1)", async () => {
    const h = host();
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    const work = new AbortController();
    const vm = await vms.open(ask, work.signal);
    const live = new AbortController().signal;
    const first = await vm.round("take-the-tree", "keep-the-tree", "", 900, live);
    // (Made for its task, from its VM, beside its agent's: with its work's own signal, as its VM was.)
    expect(h.rounds).toEqual([{ task: ask.task, of: "vm-1", beside: "agent-vm", run: `handed.${ask.task}`, ttlMinutes: TASK_VM_MINUTES }]);
    expect(h.signals.at(-1)).toBe(live);
    // Its tree from the task's VM to the round's, through this host, by no profile on either side.
    expect(h.piped).toEqual([{ from: { id: "vm-1", cmd: ["bash", "--noprofile", "--norc", "-c", "take-the-tree"] }, to: { id: "gate-2", cmd: ["bash", "--noprofile", "--norc", "-c", "keep-the-tree"] }, maxBytes: Number.POSITIVE_INFINITY }]);
    expect(first.taken.from.exitCode).toBe(0);
    // Its gates and the node's checks there, as their own user, in their own folder; its sweep there; none in the task's VM.
    await first.gates("test -f x", 30, live, 61001);
    expect(h.ran.at(-1)).toEqual({ vm: "gate-2", cmd: ["bash", "--noprofile", "--norc", "-c", "test -f x"], as: 61001 });
    await first.sweep(live, 61001);
    expect(h.swept).toEqual([{ vm: "gate-2", uid: 61001 }]);
    // And what of that user is still alive, counted there by this host (gateLeft: as the VM's own user).
    expect((await first.left(live, 61001)).stdout).toBe("0\n");
    expect(h.counted).toEqual([{ vm: "gate-2", uid: 61001 }]);
    expect(h.ran.filter((r) => r.as !== undefined && r.vm === "vm-1")).toEqual([]);
    // The next round's VM takes its place: the first is gone, and what is asked of it is refused.
    const second = await vm.round("take-the-tree", "keep-the-tree", "", 900, live);
    expect(h.removed).toEqual(["gate-2"]);
    await expect(first.gates("test -f x", 30, live, 61002)).rejects.toThrow("its work has stopped");
    await expect(first.sweep(live, 61002)).rejects.toThrow("its work has stopped");
    await expect(first.left(live, 61002)).rejects.toThrow("its work has stopped");
    await second.sweep(live, 61001);
    expect(h.swept).toEqual([{ vm: "gate-2", uid: 61001 }, { vm: "gate-3", uid: 61001 }]);
    // The task's end takes the round's VM with it.
    await vm.release();
    expect(h.removed).toEqual(["gate-2", "gate-3", "vm-1"]);
  });

  test("its install cache is filled before each round's VM is made, from the manifests its task's VM prints, given to the node's filler as they are; none is asked where the tree has none, nor where the node has no cache; one that fails says why", async () => {
    const live = new AbortController().signal;
    const gz = Buffer.from("gzipped manifests").toString("base64");
    // Filled: the manifests read in the task's VM, then given to the filler for that VM, then the round's VM made.
    const h = host({ cache: "fills", manifests: gz });
    const vm = await new TaskVms({ host: () => h.fake as never, now: () => STARTED }).open(ask, new AbortController().signal);
    const round = await vm.round("take", "keep", "read-the-manifests", 900, live);
    expect(h.ran.at(-1)).toEqual({ vm: "vm-1", cmd: ["bash", "--noprofile", "--norc", "-c", "read-the-manifests"] });
    expect(h.filled).toEqual([{ vm: "vm-1", manifests: "gzipped manifests" }]);
    expect(round.cache).toMatchObject({ filled: true, said: "" });
    expect(h.rounds).toHaveLength(1);
    // No bun.lock in the tree: it prints nothing, and nothing is filled.
    const none = host({ cache: "fills", manifests: "" });
    const bare = await new TaskVms({ host: () => none.fake as never, now: () => STARTED }).open(ask, new AbortController().signal);
    expect((await bare.round("take", "keep", "read-the-manifests", 900, live)).cache).toBeNull();
    expect(none.filled).toEqual([]);
    // A node with no install cache reads nothing.
    const off = host({ manifests: gz });
    const plain = await new TaskVms({ host: () => off.fake as never, now: () => STARTED }).open(ask, new AbortController().signal);
    expect((await plain.round("take", "keep", "read-the-manifests", 900, live)).cache).toBeNull();
    expect(off.ran.some((r) => r.cmd.at(-1) === "read-the-manifests")).toBe(false);
    // A fill that fails says why, and the round goes on: its gates fail offline where they need it, saying so.
    const fails = host({ cache: "fails", manifests: gz });
    const failing = await new TaskVms({ host: () => fails.fake as never, now: () => STARTED }).open(ask, new AbortController().signal);
    expect((await failing.round("take", "keep", "read-the-manifests", 900, live)).cache).toMatchObject({ filled: false, said: "its bun.lock names x@github:y/z, which isn't the default registry's, so nothing is filled" });
    expect(fails.rounds).toHaveLength(1);
    // What isn't base64 is no manifests.
    const odd = host({ cache: "fills", manifests: "not base64!" });
    const oddly = await new TaskVms({ host: () => odd.fake as never, now: () => STARTED }).open(ask, new AbortController().signal);
    expect((await oddly.round("take", "keep", "read-the-manifests", 900, live)).cache).toMatchObject({ filled: false, said: "its manifests couldn't be read" });
    expect(odd.filled).toEqual([]);
  });

  test("its brake takes its gates' round's VM at once, with its own", async () => {
    const h = host();
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    const work = new AbortController();
    const vm = await vms.open(ask, work.signal);
    await vm.round("take", "keep", "", 900, new AbortController().signal);
    work.abort();
    await Bun.sleep(10);
    expect(h.removed.sort()).toEqual(["gate-2", "vm-1"]);
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

  test("a node that makes no sandboxes asks its engine for no task's VM, so its sweep fails for nothing; one that does, and can't list them, says so", async () => {
    // (The Mac mini, 28 November 2026: no sandbox image and no firewall, and its doctor read the listing it couldn't
    // make as trouble. The gateway's listener holds to the same: daemon.ts.)
    const none = host({ makes: false, unlisted: true });
    await new TaskVms({ host: () => none.fake as never, now: () => STARTED }).sweep();
    expect(none.listed()).toBe(0);
    const makes = host({ unlisted: true });
    await expect(new TaskVms({ host: () => makes.fake as never, now: () => STARTED }).sweep()).rejects.toThrow("docker couldn't say which VMs are other nodes' tasks'");
    expect(makes.listed()).toBe(1);
    // Asked again by the next task: once the node makes sandboxes, what an earlier process left goes before its first.
    const later = { makes: false, left: ["old-1"] };
    const h = host(later);
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    await vms.sweep();
    expect([h.listed(), h.removed]).toEqual([0, []]);
    later.makes = true;
    await vms.open(ask, new AbortController().signal);
    expect([h.listed(), h.removed]).toEqual([1, ["old-1"]]);
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

  test("its clone comes from its agent's VM and its changes go back to it, each through the host alone, its changes alone held to a cap, and none once its work has stopped (R5-3)", async () => {
    const h = host();
    const vms = new TaskVms({ host: () => h.fake as never, now: () => STARTED });
    const work = new AbortController();
    const vm = await vms.open(ask, work.signal);
    await vm.receive("give", "take", 900, work.signal);
    await vm.send("send", "receive", 900, work.signal);
    // (Each side's command in a shell that reads no profile, the task's VM's or its agent's: R8-3.)
    const sh = (command: string) => ["bash", "--noprofile", "--norc", "-c", command];
    expect(h.piped).toEqual([
      { from: { id: "agent-vm", cmd: sh("give") }, to: { id: "vm-1", cmd: sh("take") }, maxBytes: Number.POSITIVE_INFINITY },
      { from: { id: "vm-1", cmd: sh("send") }, to: { id: "agent-vm", cmd: sh("receive") }, maxBytes: HANDED_CHANGES_BYTES },
    ]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(vm.send("send", "receive", 900, stopped.signal)).rejects.toThrow("its work has stopped");
    expect(h.piped).toHaveLength(2);
    await vm.release();
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
