import { describe, expect, test } from "bun:test";
import type { NodeCapacity } from "@galahad/core";
import os from "node:os";
import { CapacityError, Governor, KEPT_WORK_MS } from "../src/compute/governor.ts";
import { liveHost, macFreeShare } from "../src/compute/service.ts";

/*
 * The governor: a node's slots. Work that fits is admitted; work that doesn't waits
 * its turn, first come first served, and is never run on top of the ceiling.
 */

const capacity = (over: Partial<NodeCapacity> = {}): NodeCapacity => ({ cores: 8, memoryGb: 16, sandboxes: 2, modelCalls: 2, strength: 8, speed: 1, measured: true, reasons: [], ...over });
const slot = { cpus: 4, memoryGb: 8 };
const idle = { load: 0, cores: 16, freeMemoryGb: 60, totalMemoryGb: 64 };
const settle = () => Bun.sleep(1);

function governor(over: { capacity?: () => NodeCapacity; host?: () => typeof idle | null; maxWaitMs?: number; retryMs?: number; now?: () => number } = {}) {
  let changes = 0;
  const g = new Governor({ capacity: over.capacity ?? (() => capacity()), host: over.host ?? (() => idle), maxWaitMs: over.maxWaitMs, retryMs: over.retryMs ?? 5, now: over.now, onChange: () => changes++ });
  return { g, changes: () => changes };
}

describe("sandbox slots", () => {
  test("what fits runs; the next waits, and takes the slot when one is freed", async () => {
    const { g } = governor();
    const a = await g.acquire(slot, { quest: "q-a" });
    const b = await g.acquire(slot, { quest: "q-b" });
    let third = "waiting";
    const c = g.acquire(slot, { quest: "q-c" }).then((ticket) => {
      third = "running";
      return ticket;
    });
    await settle();
    expect(third).toBe("waiting");
    expect(g.usage()).toMatchObject({ sandboxes: 2, cores: 8, memoryGb: 16, queued: 1 });
    expect(g.queue()).toMatchObject([{ quest: "q-c", cpus: 4, memoryGb: 8 }]);
    expect(g.queue()[0]!.why).toMatch(/every slot is in use/);
    g.release(a);
    await c;
    expect(third).toBe("running");
    expect(g.usage()).toMatchObject({ sandboxes: 2, queued: 0 });
    g.release(b);
    g.release(await c);
    expect(g.usage()).toMatchObject({ sandboxes: 0, cores: 0, memoryGb: 0 });
  });

  test("first come, first served: a small request doesn't jump one that's waiting", async () => {
    const { g } = governor({ capacity: () => capacity({ sandboxes: 4 }) });
    const big = await g.acquire({ cpus: 6, memoryGb: 8 }, { quest: "big" });
    const order: string[] = [];
    const second = g.acquire({ cpus: 4, memoryGb: 4 }, { quest: "second" }).then((t) => (order.push("second"), t));
    const small = g.acquire({ cpus: 1, memoryGb: 1 }, { quest: "small" }).then((t) => (order.push("small"), t));
    await settle();
    expect(order).toEqual([]); // 1 CPU would fit, but it's behind "second"
    g.release(big);
    await Promise.all([second, small]);
    expect(order).toEqual(["second", "small"]);
  });

  test("a sandbox it holds grows within the ceiling, at once or not at all, and what it gives back is given back", async () => {
    const { g, changes } = governor({ capacity: () => capacity({ sandboxes: 2 }) });
    const a = await g.acquire({ cpus: 2, memoryGb: 4 }, { quest: "knight" });
    g.bind(a, "0123456789");
    const before = changes();
    expect(g.grow("0123456789", { cpus: 2, memoryGb: 4 })).toBeNull();
    expect(g.usage()).toMatchObject({ sandboxes: 1, cores: 4, memoryGb: 8 });
    expect(changes()).toBeGreaterThan(before);
    // Past the ceiling (8 threads): refused with the reason, and nothing held for it.
    expect(g.grow("0123456789", { cpus: 6, memoryGb: 0 })).toMatch(/threads he may use/);
    expect(g.usage()).toMatchObject({ cores: 4, memoryGb: 8 });
    // Every slot taken doesn't stop a sandbox that is already one of them from growing.
    const b = await g.acquire({ cpus: 1, memoryGb: 1 }, { quest: "other" });
    expect(g.grow("0123456789", { cpus: 2, memoryGb: 2 })).toBeNull();
    expect(g.grow("ffffffffff", { cpus: 1, memoryGb: 1 })).toMatch(/no such sandbox/);
    g.shrink("0123456789", { cpus: 2, memoryGb: 2 });
    expect(g.usage()).toMatchObject({ sandboxes: 2, cores: 5, memoryGb: 9 });
    g.release(b);
    g.release("0123456789");
    expect(g.usage()).toMatchObject({ sandboxes: 0, cores: 0, memoryGb: 0 });
  });

  test("a knight's VM at rest grows only within the ceiling: the threads it holds at work count, though it holds none now", async () => {
    const { g } = governor({ capacity: () => capacity({ cores: 8, memoryGb: 16, sandboxes: 2 }) });
    g.bind(await g.acquire({ cpus: 2, memoryGb: 4 }, { quest: "arm.team.abcdef0123.ada", kept: true }), "ada");
    expect(g.usage()).toMatchObject({ kept: 1, cores: 0, memoryGb: 4 });
    // Its 2 threads and 7 more would be 9 once it works: past the ceiling of 8, as a new VM that size would be.
    expect(g.grow("ada", { cpus: 7, memoryGb: 0 })).toMatch(/threads he may use/);
    // Up to the ceiling it grows, and still holds no threads while it rests.
    expect(g.grow("ada", { cpus: 6, memoryGb: 0 })).toBeNull();
    expect(g.usage()).toMatchObject({ kept: 1, cores: 0, memoryGb: 4 });
    g.work("ada");
    expect(g.usage().cores).toBe(8);
  });

  test("a knight's own VM takes no slot, and holds its memory of the ceiling; its threads only while it works, and a while after", async () => {
    let t = 1_000_000;
    const { g } = governor({ capacity: () => capacity({ cores: 12, memoryGb: 32, sandboxes: 2 }), now: () => t });
    for (const knight of ["ada", "lin", "sam"]) g.bind(await g.acquire({ cpus: 2, memoryGb: 4 }, { quest: `arm.team.abcdef0123.${knight}`, kept: true }), knight);
    // Resting: its memory is held, its threads are not (it isn't using them).
    expect(g.usage()).toMatchObject({ sandboxes: 0, kept: 3, cores: 0, memoryGb: 12 });
    // At work: its threads count while a command runs in it, and for a while after the last one ends (it thinks between them).
    const done = g.work("ada");
    expect(g.usage()).toMatchObject({ sandboxes: 0, kept: 3, cores: 2, memoryGb: 12 });
    done();
    done();
    t += KEPT_WORK_MS - 1;
    expect(g.usage().cores).toBe(2);
    t += 2;
    expect(g.usage().cores).toBe(0);
    // Every slot is still there for work, and the ceiling bounds it: what runs in a slot holds its threads all along.
    const a = await g.acquire({ cpus: 2, memoryGb: 4 }, { quest: "q-a" });
    await g.acquire({ cpus: 2, memoryGb: 4 }, { quest: "q-b" });
    expect(g.usage()).toMatchObject({ sandboxes: 2, kept: 3, cores: 4, memoryGb: 20 });
    // Work in a sandbox that isn't a kept VM, or in one it doesn't hold, changes nothing.
    g.work(a.id)();
    g.work("nobody")();
    expect(g.usage().cores).toBe(4);
  });

  test("resting knights never keep work waiting; working ones hold their threads, and what doesn't fit beside them waits until they rest", async () => {
    let t = 1_000_000;
    // The owner's server on 16 November 2026: a ceiling of 16 threads, four knights' VMs of 2 threads and Galahad's
    // of 1, each with a microVM's own thread and 2 GB. Every thread but 2 was held, so no sandbox could start.
    const { g } = governor({ capacity: () => capacity({ cores: 16, memoryGb: 91, sandboxes: 4 }), now: () => t, retryMs: 5 });
    g.adopt([
      ...["k1", "k2", "k3", "k4"].map((id) => ({ id, cpus: 2, memoryGb: 4, isolation: "vm" as const, kept: true })),
      { id: "galahad", cpus: 1, memoryGb: 4, isolation: "vm" as const, kept: true },
    ]);
    expect(g.usage()).toMatchObject({ sandboxes: 0, kept: 5, cores: 0, memoryGb: 30 });
    // They rest: a quest's sandbox is admitted at once.
    g.release(await g.acquire(slot, { quest: "q-a" }));
    // Three at work hold 9 threads: one sandbox fits beside them, and the next would pass 16, so it waits.
    const ends = ["k1", "k2", "k3"].map((id) => g.work(id));
    await g.acquire(slot, { quest: "q-b" });
    let admitted = false;
    const next = g.acquire(slot, { quest: "q-c" }).then(() => void (admitted = true));
    await settle();
    expect(admitted).toBe(false);
    expect(g.queue()[0]!.why).toMatch(/threads he may use/);
    // They finish and rest: once the while has passed, the governor looks again by itself and admits it.
    for (const end of ends) end();
    t += KEPT_WORK_MS + 1;
    await next;
    expect(g.usage()).toMatchObject({ sandboxes: 2, kept: 5, cores: 8 });
  });

  test("a persistent sandbox in Docker's list is a kept VM again after a restart, resting until it works", () => {
    const { g } = governor({ capacity: () => capacity({ cores: 12, memoryGb: 32, sandboxes: 2 }) });
    g.adopt([{ id: "0123456789", cpus: 1, memoryGb: 2, isolation: "vm", kept: true }, { id: "9876543210", cpus: 2, memoryGb: 4, isolation: "container" }]);
    expect(g.usage()).toMatchObject({ sandboxes: 1, kept: 1, cores: 2, memoryGb: 8 });
    g.work("0123456789");
    expect(g.usage()).toMatchObject({ sandboxes: 1, kept: 1, cores: 4, memoryGb: 8 });
  });

  test("a sandbox is known by its id once it exists, and released by it", async () => {
    const { g } = governor();
    const ticket = await g.acquire(slot, { quest: "q" });
    g.bind(ticket, "0123456789");
    expect(g.usage().sandboxes).toBe(1);
    g.release("0123456789");
    expect(g.usage().sandboxes).toBe(0);
    g.release("0123456789"); // twice is nothing
    expect(g.usage().sandboxes).toBe(0);
  });

  test("Docker's own list is the truth: sandboxes from before a restart are counted, vanished ones freed", async () => {
    const { g } = governor();
    g.adopt([
      { id: "aaaaaaaaaa", cpus: 4, memoryGb: 8, isolation: "container" },
      { id: "bbbbbbbbbb", cpus: 2, memoryGb: 4, isolation: "vm" },
    ]);
    // A microVM's overhead is counted on top of its limits.
    expect(g.usage()).toMatchObject({ sandboxes: 2, cores: 7, memoryGb: 14 });
    let admitted = false;
    const waiting = g.acquire(slot, { quest: "q" }).then((t) => ((admitted = true), t));
    await settle();
    expect(admitted).toBe(false);
    // One being created isn't in Docker's list yet: an adoption never drops it.
    g.adopt([{ id: "aaaaaaaaaa", cpus: 4, memoryGb: 8, isolation: "container" }]);
    await waiting;
    expect(g.usage()).toMatchObject({ sandboxes: 2, cores: 8 });
    g.adopt([{ id: "aaaaaaaaaa", cpus: 4, memoryGb: 8, isolation: "container" }]);
    expect(g.usage().sandboxes).toBe(2);
  });

  test("he waits while the machine is busy, and goes on when it eases", async () => {
    let load = 15;
    const { g } = governor({ host: () => ({ ...idle, load }) });
    let admitted = false;
    const waiting = g.acquire(slot, { quest: "q" }).then((t) => ((admitted = true), t));
    await Bun.sleep(20);
    expect(admitted).toBe(false);
    expect(g.queue()[0]!.why).toMatch(/busy with other work/);
    load = 1;
    await waiting;
    expect(admitted).toBe(true);
  });

  test("load that is his own doesn't hold him back: what his sandboxes held a moment ago is remembered", async () => {
    let now = 1_000_000;
    let load = 0;
    const { g } = governor({ host: () => ({ ...idle, cores: 8, load }), capacity: () => capacity({ cores: 4, sandboxes: 1 }), now: () => now });
    const first = await g.acquire(slot, { quest: "one" });
    load = 4; // his own sandbox, flat out
    g.release(first);
    now += 5_000; // the load average hasn't decayed yet
    const next = await g.acquire(slot, { quest: "two" });
    g.release(next);
    // Two minutes later that load would be someone else's.
    now += 120_000;
    let admitted = false;
    void g.acquire(slot, { quest: "three" }).then(() => (admitted = true));
    await Bun.sleep(15);
    expect(admitted).toBe(false);
  });

  test("a wait has an end: the caller hears why", async () => {
    const { g } = governor({ maxWaitMs: 20 });
    await g.acquire(slot, { quest: "a" });
    await g.acquire(slot, { quest: "b" });
    const waited = g.acquire(slot, { quest: "c" });
    await expect(waited).rejects.toBeInstanceOf(CapacityError);
    await expect(waited).rejects.toThrow(/every slot is in use/);
    expect(g.usage().queued).toBe(0);
  });

  test("a caller that goes away leaves the queue", async () => {
    const { g } = governor();
    await g.acquire(slot, { quest: "a" });
    await g.acquire(slot, { quest: "b" });
    const gone = new AbortController();
    const waited = g.acquire(slot, { quest: "c" }, gone.signal);
    await settle();
    gone.abort();
    await expect(waited).rejects.toThrow(/gave up waiting/);
    expect(g.usage().queued).toBe(0);
    const already = new AbortController();
    already.abort();
    await expect(g.acquire(slot, { quest: "d" }, already.signal)).rejects.toThrow(/gave up waiting/);
  });

  test("a node that takes no sandboxes refuses at once instead of queueing forever", async () => {
    const { g } = governor({ capacity: () => capacity({ sandboxes: 0 }) });
    await expect(g.acquire(slot, { quest: "q" })).rejects.toThrow(/takes no sandboxes/);
  });

  test("a ceiling lowered while work runs admits nothing new until it fits again", async () => {
    let sandboxes = 2;
    const { g } = governor({ capacity: () => capacity({ sandboxes }) });
    const a = await g.acquire(slot, { quest: "a" });
    sandboxes = 1;
    let admitted = false;
    const waiting = g.acquire(slot, { quest: "b" }).then((t) => ((admitted = true), t));
    await settle();
    expect(admitted).toBe(false);
    g.release(a);
    await waiting;
    expect(admitted).toBe(true);
  });

  test("watchers hear of every change", async () => {
    const { g, changes } = governor();
    const ticket = await g.acquire(slot, { quest: "q" });
    g.release(ticket);
    expect(changes()).toBeGreaterThanOrEqual(2);
  });
});

/*
 * What the governor reads of the machine before it admits a sandbox: whether it has the memory. On Linux that is
 * MemAvailable; on a Mac, what its memory pressure calls free. What the OS calls free counts only pages no cache
 * holds, which macOS keeps few of, so a VM waited there for memory that was there.
 */
describe("the machine, as it is now", () => {
  test("what macOS's memory pressure calls free is read as a share, and nothing else is", () => {
    expect(macFreeShare(() => "48\n")).toBe(0.48);
    expect(macFreeShare(() => "0")).toBe(0);
    expect(macFreeShare(() => "100")).toBe(1);
    for (const said of [null, "", "101", "-3", "48%", "abc", "4.5"]) expect(macFreeShare(() => said)).toBeNull();
  });

  test.skipIf(process.platform !== "darwin")("on a Mac, memory free is what its memory pressure says, not only the pages no cache holds", () => {
    const share = macFreeShare();
    expect(share).not.toBeNull();
    // (Read a moment apart, so within a couple of gigabytes.)
    expect(Math.abs(liveHost().freeMemoryGb - (share! * os.totalmem()) / 2 ** 30)).toBeLessThan(2);
  });
});

describe("model calls", () => {
  test("background calls wait for a slot; yours never waits, but is counted", async () => {
    const { g } = governor();
    const one = await g.enterModel({ wait: true });
    const two = await g.enterModel({ wait: true });
    let third = false;
    const waiting = g.enterModel({ wait: true }).then((leave) => ((third = true), leave));
    await settle();
    expect(third).toBe(false);
    expect(g.usage()).toMatchObject({ modelCalls: 2, modelQueued: 1 });
    const yours = await g.enterModel({ wait: false });
    expect(g.usage().modelCalls).toBe(3);
    yours();
    await settle();
    expect(third).toBe(false); // still two background calls running
    one();
    (await waiting)();
    two();
    one(); // leaving twice is nothing
    expect(g.usage()).toMatchObject({ modelCalls: 0, modelQueued: 0 });
  });

  test("a caller that goes away while it waits leaves the queue", async () => {
    const { g } = governor({ capacity: () => capacity({ modelCalls: 1 }) });
    const held = await g.enterModel({ wait: true });
    const gone = new AbortController();
    const waiting = g.enterModel({ wait: true }, gone.signal);
    gone.abort();
    await expect(waiting).rejects.toThrow(/gave up waiting/);
    held();
    expect(g.usage()).toMatchObject({ modelCalls: 0, modelQueued: 0 });
  });
});
