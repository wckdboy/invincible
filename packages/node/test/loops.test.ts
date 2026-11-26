import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { b64u, newNodeIdentity, type NodeIdentity } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore } from "@galahad/mind";
import { checkSchedule, LoopError, loopRecords, LoopRunner, type RunContext, type RunnableLoop, type RunResult, selfActionOn } from "../src/loops.ts";

/*
 * The loop runner on a fake clock: due slots run once, missed slots once, a crash
 * mid-run is recorded and never rerun, and only the named node ever runs a loop.
 */

const T0 = Date.parse("2026-11-09T10:00:00Z");
const MIN = 60_000;

function world() {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const store = new MindStore(":memory:");
  foundFleet(store, a, { fleetName: "camelot", nodeName: "ultra" });
  enrollDevice(store, a, { device: b.id, name: "laptop", kind: "node", box: b64u(b.boxPublic) });
  let now = T0;
  const clock = { now: () => now, set: (t: number) => void (now = t) };
  const calls: { loop: string; slot: number | null }[] = [];
  let behaviour: (loop: RunnableLoop, ctx: RunContext) => Promise<RunResult> = async () => ({ status: "ok", summary: "fine" });
  const local = new Database(":memory:");
  const runner = (identity: NodeIdentity = a, db = local) =>
    new LoopRunner({
      store,
      identity,
      local: db,
      log: () => {},
      now: clock.now,
      execute: (loop, ctx) => {
        calls.push({ loop: loop.name, slot: ctx.slot });
        return behaviour(loop, ctx);
      },
    });
  const define = (name: string, on: string, schedule = "every 30m", extra: Record<string, unknown> = {}) =>
    store.emit(a, "loop.set", { name, schedule, tz: "UTC", on, enabled: true, task: { kind: "heartbeat" }, ...extra });
  const execute = (loop: RunnableLoop, ctx: RunContext) => {
    calls.push({ loop: loop.name, slot: ctx.slot });
    return behaviour(loop, ctx);
  };
  return { a, b, store, clock, calls, local, runner, define, execute, setBehaviour: (f: typeof behaviour) => void (behaviour = f) };
}

describe("the loop runner", () => {
  test("a due slot runs once; the next slot runs next time", async () => {
    const w = world();
    w.clock.set(T0 - 5 * MIN); // defined at 09:55 (the clock is only used for runs; definitions carry their own hlc)
    w.define("beat", w.a.id);
    const r = w.runner();
    w.clock.set(Date.now() + 31 * MIN); // past the first slot after the definition
    r.tick();
    await r.settled();
    r.tick();
    await r.settled();
    expect(w.calls).toHaveLength(1);
    const first = w.calls[0]!.slot!;
    expect(first % (30 * MIN)).toBe(0);
    expect(w.store.loopRuns("beat").map((x) => x.body.status)).toEqual(["ok"]);
    w.clock.set(first + 30 * MIN + 1);
    r.tick();
    await r.settled();
    expect(w.calls.map((c) => c.slot)).toEqual([first, first + 30 * MIN]);
  });

  test("a node away for hours runs a missed loop once, not once per slot", async () => {
    const w = world();
    w.define("beat", w.a.id);
    const r = w.runner();
    w.clock.set(Date.now() + 5 * 60 * MIN);
    r.tick();
    await r.settled();
    r.tick();
    await r.settled();
    expect(w.calls).toHaveLength(1);
  });

  test("only the node a loop names runs it; paused loops wait", async () => {
    const w = world();
    w.define("elsewhere", w.b.id);
    w.define("paused", w.a.id, "every 30m", { enabled: false });
    const r = w.runner();
    w.clock.set(Date.now() + 61 * MIN);
    r.tick();
    await r.settled();
    expect(w.calls).toEqual([]);
    expect(r.mine().map((l) => l.name)).toEqual(["paused"]);
  });

  test("a run that throws is recorded as failed, with why", async () => {
    const w = world();
    w.define("bad", w.a.id);
    w.setBehaviour(async () => {
      throw new Error("no sandbox host is online");
    });
    const r = w.runner();
    w.clock.set(Date.now() + 31 * MIN);
    r.tick();
    await r.settled();
    expect(w.store.loopRuns("bad")[0]!.body).toMatchObject({ status: "failed", summary: "no sandbox host is online" });
  });

  test("a crash mid-run is recorded as interrupted on the next start, and that slot never reruns", async () => {
    const w = world();
    w.define("long", w.a.id);
    let release!: () => void;
    w.setBehaviour(() => new Promise<RunResult>((resolve) => (release = () => resolve({ status: "ok", summary: "late" }))));
    const crashed = w.runner();
    w.clock.set(Date.now() + 31 * MIN);
    crashed.tick();
    expect(w.calls).toHaveLength(1);
    // The process dies here: no loop.ran was written. A new runner starts on the same local storage.
    w.setBehaviour(async () => ({ status: "ok", summary: "fine" }));
    const restarted = w.runner();
    restarted.start(60 * 60_000);
    await restarted.settled();
    expect(w.store.loopRuns("long").map((x) => x.body.status)).toEqual(["interrupted"]);
    expect(w.calls).toHaveLength(1); // not rerun
    await restarted.stop();
    release();
    await crashed.settled();
  });

  test("once: it runs at its time and never again; a time gone by is refused, but one that has run may still be paused", async () => {
    const w = world();
    // (Definitions carry the real clock: a time to come is one after it.)
    const at = Math.ceil((Date.now() + 2 * 60 * MIN) / MIN) * MIN;
    const wall = new Date(at).toISOString().slice(0, 16).replace("T", " ");
    w.define("remind", w.a.id, `at ${wall}`);
    const r = w.runner();
    w.clock.set(at - MIN);
    r.tick();
    await r.settled();
    expect(w.calls).toEqual([]);
    for (const later of [at, at + MIN, at + 60 * MIN, at + 3 * 24 * 60 * MIN]) {
      w.clock.set(later);
      r.tick();
      await r.settled();
    }
    expect(w.calls).toEqual([{ loop: "remind", slot: at }]);
    expect(checkSchedule(`at ${wall}`, "UTC", at - MIN)).toBe(at);
    expect(() => checkSchedule(`at ${wall}`, "UTC", at)).toThrow(`${wall} in UTC has passed: give a time to come`);
    expect(checkSchedule(`at ${wall}`, "UTC", at, false, true)).toBeNull();
  });

  test("by hand: runs now, doesn't count as the scheduled run, and never twice at once", async () => {
    const w = world();
    w.define("beat", w.a.id);
    let release!: () => void;
    w.setBehaviour(() => new Promise<RunResult>((resolve) => (release = () => resolve({ status: "attention", summary: "1 finding" }))));
    const r = w.runner();
    const { run } = r.runNow("beat");
    expect(run.startsWith("m")).toBe(true);
    expect(() => r.runNow("beat")).toThrow(/already running/);
    expect(r.isRunning("beat")).toBe(true);
    release();
    await r.settled();
    expect(w.store.loopRuns("beat")[0]!.body).toMatchObject({ slot: null, status: "attention" });
    expect(w.store.lastSlot("beat", w.a.id)).toBeNull();
    expect(() => r.runNow("nope")).toThrow(/doesn't run on this node/);
  });

  test("a run past its deadline is stopped", async () => {
    const w = world();
    w.define("slow", w.a.id);
    w.setBehaviour((_loop, ctx) => new Promise<RunResult>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const r = new LoopRunner({
      store: w.store,
      identity: w.a,
      local: w.local,
      log: () => {},
      now: w.clock.now,
      deadlineMs: 30,
      execute: (loop, ctx) => {
        w.calls.push({ loop: loop.name, slot: ctx.slot });
        return new Promise<RunResult>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    });
    r.runNow("slow");
    await r.settled();
    expect(w.store.loopRuns("slow")[0]!.body).toMatchObject({ status: "failed", summary: "Stopped at its deadline." });
  });

  test("at most a few runs at once; the rest wait their turn", async () => {
    const w = world();
    for (const name of ["one", "two", "three"]) w.define(name, w.a.id);
    const releases: (() => void)[] = [];
    w.setBehaviour(() => new Promise<RunResult>((resolve) => releases.push(() => resolve({ status: "ok", summary: "ok" }))));
    const r = w.runner();
    w.clock.set(Date.now() + 31 * MIN);
    r.tick();
    expect(w.calls).toHaveLength(2);
    for (const release of releases.splice(0)) release();
    await r.settled();
    r.tick();
    expect(w.calls).toHaveLength(3);
    for (const release of releases.splice(0)) release();
    await r.settled();
  });
});

describe("what wakes a loop (a webhook, new mail, a GitHub event)", () => {
  const event = (id: string, at = T0) => ({ id, source: "webhook" as const, at, text: `a webhook ${id}`, detail: `{"n":"${id}"}` });
  function woken() {
    const w = world();
    w.define("hook", w.a.id, "never");
    w.store.emit(w.a, "loop.wakes", { name: "hook", wakes: [{ kind: "webhook" }], cooldownMs: 10 * MIN });
    const seen: string[][] = [];
    w.setBehaviour(async (_loop, ctx) => {
      seen.push(ctx.woken.map((e) => e.id));
      return { status: "ok", summary: "fine" };
    });
    return { ...w, seen };
  }

  test("the first event runs it at once, with what woke it; the same event never wakes it again", async () => {
    const w = woken();
    const r = w.runner();
    expect(loopRecords(w.store)[0]).toMatchObject({ scheduleText: "never", wakes: [{ kind: "webhook" }], cooldownMs: 10 * MIN });
    expect(r.wake("hook", [event("d1")])).toBe(1);
    await r.settled();
    expect(w.seen).toEqual([["d1"]]);
    const [run] = w.store.loopRuns("hook");
    expect(run!.body).toMatchObject({ slot: null, status: "ok", summary: "Woken by a webhook d1. fine" });
    expect(run!.body.run).toMatch(/^w/);
    // Delivered twice (a retry), or read again later: once.
    w.clock.set(T0 + 60 * MIN);
    expect(r.wake("hook", [event("d1")])).toBe(0);
    r.tick();
    await r.settled();
    expect(w.seen).toHaveLength(1);
  });

  test("a burst within the cooldown is one run, with all of it, once the cooldown has passed", async () => {
    const w = woken();
    const r = w.runner();
    r.wake("hook", [event("d1")]);
    await r.settled();
    w.clock.set(T0 + MIN);
    r.wake("hook", [event("d2", T0 + MIN), event("d3", T0 + MIN)]);
    w.clock.set(T0 + 2 * MIN);
    r.wake("hook", [event("d4", T0 + 2 * MIN)]);
    await r.settled();
    expect(w.seen).toEqual([["d1"]]);
    expect(r.waiting("hook").map((e) => e.id)).toEqual(["d2", "d3", "d4"]);
    w.clock.set(T0 + 10 * MIN);
    r.tick();
    await r.settled();
    expect(w.seen).toEqual([["d1"], ["d2", "d3", "d4"]]);
    expect(w.store.loopRuns("hook")[0]!.body.summary).toBe("Woken by a webhook d2 (and 2 more). fine");
    expect(r.waiting("hook")).toEqual([]);
  });

  test("a paused loop, or one another node runs, isn't woken; a schedule runs as before and takes what waits", async () => {
    const w = woken();
    const r = w.runner();
    w.store.emit(w.a, "loop.set", { name: "hook", schedule: "never", tz: "UTC", on: w.a.id, enabled: false, task: { kind: "heartbeat" } });
    expect(r.wake("hook", [event("d1")])).toBe(0);
    w.define("theirs", w.b.id, "never");
    w.store.emit(w.a, "loop.wakes", { name: "theirs", wakes: [{ kind: "webhook" }], cooldownMs: 10 * MIN });
    expect(r.wake("theirs", [event("d1")])).toBe(0);
    // A loop with a schedule and a wake: woken in its cooldown, its next slot takes what waits.
    w.clock.set(T0 - 5 * MIN);
    w.define("both", w.a.id, "every 30m");
    w.store.emit(w.a, "loop.wakes", { name: "both", wakes: [{ kind: "webhook" }], cooldownMs: 60 * MIN });
    w.clock.set(Date.now());
    r.wake("both", [event("x1")]);
    await r.settled();
    r.wake("both", [event("x2")]);
    w.clock.set(Date.now() + 31 * MIN);
    r.tick();
    await r.settled();
    expect(w.seen).toEqual([["x1"], ["x2"]]);
    expect(w.calls.at(-1)!.slot).not.toBeNull();
    expect(w.store.loopRuns("both")[0]!.body.summary).toBe("With a webhook x2. fine");
  });

  test("what a run couldn't do and gives back waits for the next, after the cooldown: tried again three times at most, said each time", async () => {
    const w = woken();
    // d1 is done at once; d2 fails every time, and its run says it may be tried again (as a bilag's mail does).
    w.setBehaviour(async (_loop, ctx) => {
      w.seen.push(ctx.woken.map((e) => e.id));
      const left = ctx.woken.filter((e) => e.id === "d2").map((e) => e.id);
      return left.length ? { status: "attention", summary: "d2 failed.", giveBack: left } : { status: "ok", summary: "fine" };
    });
    const told: boolean[] = [];
    const r = new LoopRunner({ store: w.store, identity: w.a, local: w.local, log: () => {}, now: w.clock.now, execute: (loop, ctx) => w.execute(loop, ctx), onFinished: (_l, _r, _run, after) => void told.push(after.again) });
    r.wake("hook", [event("d1"), event("d2")]);
    await r.settled();
    expect(r.waiting("hook").map((e) => e.id)).toEqual(["d2"]);
    expect(w.store.loopRuns("hook")[0]!.body).toMatchObject({ status: "attention", summary: "Woken by a webhook d1 (and 1 more). d2 failed. Tried again in 10 min (1 of 3)." });
    // Not before the cooldown has passed, and not by a wake of its own: then once a cooldown, with what's left alone.
    w.clock.set(T0 + 5 * MIN);
    r.tick();
    await r.settled();
    expect(w.seen).toEqual([["d1", "d2"]]);
    for (const at of [10, 20, 30]) {
      w.clock.set(T0 + at * MIN);
      r.tick();
      await r.settled();
    }
    expect(w.seen).toEqual([["d1", "d2"], ["d2"], ["d2"], ["d2"]]);
    // Tried three times more, it isn't given back again: said, and nothing waits.
    expect(w.store.loopRuns("hook").map((x) => x.body.summary)).toEqual([
      "Woken by a webhook d2. d2 failed. Tried 4 times: not again.",
      "Woken by a webhook d2. d2 failed. Tried again in 10 min (3 of 3).",
      "Woken by a webhook d2. d2 failed. Tried again in 10 min (2 of 3).",
      "Woken by a webhook d1 (and 1 more). d2 failed. Tried again in 10 min (1 of 3).",
    ]);
    expect(r.waiting("hook")).toEqual([]);
    w.clock.set(T0 + 60 * MIN);
    r.tick();
    await r.settled();
    expect(w.seen).toHaveLength(4);
    // A run that will be tried again says so to whoever is told of it (the daemon raises no notice for it); the last doesn't.
    expect(told).toEqual([true, true, true, false]);
  });

  test("only what the run took is given back; a run that gives back nothing leaves what it took taken", async () => {
    const w = woken();
    w.setBehaviour(async (_loop, ctx) => {
      w.seen.push(ctx.woken.map((e) => e.id));
      return { status: "failed", summary: "no.", giveBack: ["d9", ...(ctx.woken.some((e) => e.id === "d1") ? [] : ["d2"])] };
    });
    const r = w.runner();
    r.wake("hook", [event("d1")]);
    await r.settled();
    expect(r.waiting("hook")).toEqual([]);
    expect(w.store.loopRuns("hook")[0]!.body.summary).toBe("Woken by a webhook d1. no.");
  });

  test("a node's own database from before tries were counted takes them up as it starts", () => {
    const local = new Database(":memory:");
    local.exec("CREATE TABLE loop_wakes (loop TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, taken TEXT, PRIMARY KEY (loop, id))");
    local.query("INSERT INTO loop_wakes (loop, id, at, event, taken) VALUES ('hook', 'old', 1, '{}', NULL)").run();
    const w = woken();
    w.runner(w.a, local);
    expect(local.query<{ id: string; tries: number }, []>("SELECT id, tries FROM loop_wakes").all()).toEqual([{ id: "old", tries: 0 }]);
  });

  test("what waits is kept through a restart; a flood keeps its newest", async () => {
    const w = woken();
    const first = w.runner();
    first.wake("hook", [event("d1")]);
    await first.settled();
    w.clock.set(T0 + MIN);
    first.wake("hook", Array.from({ length: 70 }, (_, i) => event(`f${String(i).padStart(2, "0")}`, T0 + MIN + i)));
    await first.stop();
    expect(first.waiting("hook")).toHaveLength(50);
    expect(first.waiting("hook")[0]!.id).toBe("f20");
    const second = w.runner();
    w.clock.set(T0 + 11 * MIN);
    second.start(60 * 60_000);
    await second.settled();
    await second.stop();
    expect(w.seen.at(-1)).toHaveLength(50);
    expect(w.seen.at(-1)!.at(-1)).toBe("f69");
  });
});

describe("a loop whose task this version no longer has", () => {
  /** As a fleet's mind holds it from before: his review of the 3D world, removed on 14 November 2026. */
  const retired = (w: ReturnType<typeof world>, name = "look-over") =>
    w.store.emit(w.a, "loop.set", { name, schedule: "every 30m", tz: "UTC", on: w.a.id, enabled: true, task: { kind: "review" }, label: "His review" });

  test("is still listed, with its schedule, and says its task no longer exists and how to remove it", () => {
    const w = world();
    retired(w);
    w.define("beat", w.a.id);
    const [loop] = loopRecords(w.store).filter((l) => l.name === "look-over");
    expect(loop).toMatchObject({ name: "look-over", scheduleText: "every 30m", enabled: true, task: null, label: "His review" });
    expect(loop!.schedule).not.toBeNull();
    expect(loop!.problem).toContain("its task no longer exists");
    expect(loop!.problem).toContain("galahad loop rm look-over");
    // A task nobody has ever known is still taken for a newer version's.
    w.store.emit(w.a, "loop.set", { name: "odd", schedule: "every 30m", tz: "UTC", on: w.a.id, enabled: true, task: { kind: "teleport" } });
    expect(loopRecords(w.store).find((l) => l.name === "odd")!.problem).toBe("this node doesn't understand the task (written by a newer version?)");
    expect(loopRecords(w.store).find((l) => l.name === "beat")!.problem).toBeNull();
  });

  test("never runs, never stops the others running, and says why when run by hand", async () => {
    const w = world();
    w.clock.set(T0 - 5 * MIN);
    retired(w);
    w.define("beat", w.a.id);
    const r = w.runner();
    w.clock.set(Date.now() + 31 * MIN);
    r.tick();
    await r.settled();
    expect(w.calls.map((c) => c.loop)).toEqual(["beat"]);
    expect(w.store.loopRuns("look-over")).toEqual([]);
    expect(() => r.runNow("look-over")).toThrow(LoopError);
    expect(() => r.runNow("look-over")).toThrow("its task no longer exists");
    // Started and stopped with it there: nothing is recorded for it, nothing breaks.
    r.start(60_000);
    await r.stop();
    expect(w.store.loopRuns("look-over")).toEqual([]);
  });
});

describe("the owner's self-action switch, as the loops say it", () => {
  test("on unless a heartbeat loop says it's off", () => {
    const w = world();
    expect(selfActionOn(w.store)).toEqual({ on: true, heartbeats: [] });
    w.define("heartbeat", w.a.id);
    expect(selfActionOn(w.store)).toEqual({ on: true, heartbeats: ["heartbeat"] });
    w.define("heartbeat", w.a.id, "every 30m", { task: { kind: "heartbeat", selfAction: false } });
    expect(selfActionOn(w.store)).toEqual({ on: false, heartbeats: ["heartbeat"] });
  });
});
