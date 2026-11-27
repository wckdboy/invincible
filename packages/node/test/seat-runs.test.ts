import { afterEach, describe, expect, test } from "bun:test";
import { newNodeIdentity, seatState, type SeatKind } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "@invincible/ledger";
import { recordSeatStatus, seatUse, yourWord } from "../src/seats.ts";
import { SEAT_REST_MAX_MS, SEAT_VM_MINUTES, SeatRuns } from "../src/seat-runs.ts";

/*
 * Runs on this node's seats (seat-runs.ts): the seat a coding agent's run takes, its VM beside the agent's (sharing its
 * /work), the seat let go as the run ends; waiting for a busy seat, resting for a spent one; never another account of a
 * vendor's for work that began on one; never a seat that doesn't serve its agent, as that agent; and what a run says of
 * the seat's windows, kept in the log.
 */

const stores: LedgerStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const AGENT_VM = "a0a0a0a0a0";
const NOW = Date.UTC(2026, 10, 27, 9, 0);
const HOUR = 3_600_000;
const id = (c: string) => `st_${c.repeat(22)}`;
const A = id("a"), B = id("b"), X = id("x"), ELSEWHERE = id("e");
/** The agents a seat may serve, each as itself: its id, and when its node's team made it. */
const ADA = { id: "ada", made: Date.UTC(2026, 10, 20, 8, 0) };
const BO = { id: "bo", made: Date.UTC(2026, 10, 21, 8, 0) };

function mind() {
  const node = newNodeIdentity();
  const other = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  stores.push(store);
  foundFleet(store, node, { fleetName: "homelab", nodeName: "ultra" });
  enrollDevice(store, node, { device: other.id, name: "mini", kind: "node", box: Buffer.from(other.boxPublic).toString("base64url") });
  let n = 0;
  const add = (seat: string, kind: SeatKind = "claude-subscription", label = seat.slice(3, 4).toUpperCase(), on = node.id, serves: { id: string; made: number }[] = [ADA]) => {
    store.emit(node, "seat.added", { id: seat, kind, label, node: on, runs: 1 }, yourWord(null));
    if (serves.length) store.emit(node, "seat.serves", { id: seat, agents: serves }, yourWord(null));
    if (on === node.id) recordSeatStatus(store, node, store.seats().find((s) => s.id === seat)!, { signedIn: true, method: kind === "chatgpt-codex" ? "chatgpt" : "claude.ai", fingerprint: String.fromCharCode(65 + n++).repeat(22) });
    return seat;
  };
  const window = (seat: string, used: number, resetsIn: number, status: "allowed" | "rejected" = "allowed") => store.emit(node, "seat.window", { id: seat, window: "five_hour", status, usedPercent: used, resetsAt: NOW + resetsIn });
  const events = (kind: string) => store.eventsSince({}, 10_000).events.filter((e) => e.kind === kind).map((e) => e.body);
  return { node, other, store, add, window, events, seat: (seat: string) => store.seats().find((s) => s.id === seat)! };
}

/** A host as seat-runs uses it: VMs made for seats (no more at once than a seat takes), commands, streams, removal. */
function host(options: { refuse?: (seat: string) => number | null; leftover?: string } = {}) {
  const vms = new Map<string, { seat: string; shares?: string; run: string }>();
  const calls: string[] = [];
  let made = 0;
  if (options.leftover) vms.set("vm-left-over", { seat: options.leftover, run: `seat.${options.leftover}` });
  const fake = {
    get: async (vm: string) => (vm === AGENT_VM ? ({ id: vm, cpus: 2, memoryGb: 4 } as never) : vms.has(vm) ? ({ id: vm } as never) : null),
    createSeatVm: async (input: { seat: { id: string; runs: number }; shares?: string; run: string }) => {
      const refused = options.refuse?.(input.seat.id);
      if (refused) throw Object.assign(new Error(`refused (${refused})`), { status: refused });
      if ([...vms.values()].filter((v) => v.seat === input.seat.id).length >= input.seat.runs) throw Object.assign(new Error("in use"), { status: 409 });
      const vm = `vm-${++made}`;
      vms.set(vm, { seat: input.seat.id, ...(input.shares ? { shares: input.shares } : {}), run: input.run });
      calls.push(`made ${vm} ${JSON.stringify(input)}`);
      return { id: vm } as never;
    },
    seatVms: async (seat: string) => [...vms].filter(([, v]) => v.seat === seat).map(([vm]) => vm),
    exec: async (vm: string, cmd: string[]) => {
      calls.push(`exec ${vm} ${cmd[2]!.includes("cleanup(") ? "cleanup" : cmd[2]!.slice(0, 40)}`);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false };
    },
    destroy: async (vm: string, opts: { run?: string }) => {
      calls.push(`destroy ${vm} ${opts.run}`);
      vms.delete(vm);
      return { verdict: "allow" as const, reason: "its own run" };
    },
    stream: async (vm: string, argv: string[]) => {
      calls.push(`stream ${vm} ${argv.slice(0, 2).join(" ")}`);
      return { lines: (async function* () { yield 'S{"alive": false, "exit": 0, "next": 0}'; })(), write() {}, close() {}, kill() {}, exited: Promise.resolve(0) };
    },
  };
  return { fake, vms, calls };
}

const ask = (over: Partial<{ agent: string; made: number; harness: string; from: { seat: string | null; kind: SeatKind } | null; wait: boolean }> = {}) => ({ agent: ADA.id, made: ADA.made, vm: AGENT_VM, harness: "claude", from: null, wait: false, ...over });
const live = () => new AbortController().signal;

describe("a seat's use lately", () => {
  test("the tasks whose coding tool ran on it in the last seven days, the tokens they spent there, and its runs now: this node's seats alone", () => {
    const m = mind();
    m.add(A);
    m.add(B);
    m.add(ELSEWHERE, "claude-subscription", "E", m.other.id);
    const own = (input: number, output: number) => ({ role: "tool", model: "own sign-in/claude-opus-5-5", calls: 1, unknown: 0, input, output, cached: 0, reasoning: 0 });
    const gateway = { role: "tool", model: "anthropic/claude-opus-5-5", calls: 1, unknown: 0, input: 50_000, output: 5_000, cached: 0, reasoning: 0 };
    const record = (seat: string | null, endedHoursAgo: number, spent: object[]) => ({ record: { startedAt: 0, endedAt: NOW - endedHoursAgo * HOUR, ended: "done" as const, commands: 1, revisions: 0, spent: spent as never, plan: { seat, kind: "claude-subscription" as const, windows: [], usd: null } } });
    const tasks = [record(A, 2, [own(1000, 100), gateway]), record(A, 30, [own(2000, 200)]), record(A, 8 * 24, [own(9000, 900)]), record(null, 1, [own(5, 5)]), { record: undefined }, record(B, 1, [])];
    const use = seatUse(m.store.seats().filter((seat) => seat.node === m.node.id), tasks, (id) => (id === B ? 1 : 0), NOW);
    expect(use).toEqual({
      [A]: { since: NOW - 7 * 24 * HOUR, tasks: 2, tokens: 3300, running: 0 },
      [B]: { since: NOW - 7 * 24 * HOUR, tasks: 1, tokens: 0, running: 1 },
    });
  });
});

describe("the agent a seat serves", () => {
  test("another agent can't take a seat you didn't share with it: its run takes none, and waits or rests only for its own", async () => {
    const m = mind();
    m.add(A);
    m.add(B, "claude-subscription", "B", m.node.id, [BO]);
    m.window(B, 100, HOUR, "rejected");
    const h = host();
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW });
    // Ada's seat is free, with all its plan left: Bo's run never takes it, and rests until Bo's own resets.
    expect(await runs.take(ask({ agent: BO.id, made: BO.made }), live())).toEqual({ none: true });
    expect(await runs.take(ask({ agent: BO.id, made: BO.made, wait: true }), live())).toEqual({ rest: { until: NOW + HOUR, why: "Every seat of yours that could take it is spent (B)" } });
    // An agent given Ada's id after Ada was removed was made later: another agent, with no seat to take or wait for.
    expect(await runs.take(ask({ made: ADA.made + 1, wait: true }), live())).toEqual({ none: true });
    expect(h.calls.filter((call) => call.startsWith("made"))).toEqual([]);
    // Ada's run takes hers.
    const taken = await runs.take(ask(), live());
    expect("run" in taken && taken.run.seat.id).toBe(A);
  });

  test("a seat that serves no agent is taken by no run; a seat you share serves each agent it names, as many at once as it takes", async () => {
    const m = mind();
    m.add(A, "claude-subscription", "A", m.node.id, []);
    const h = host();
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW });
    expect(await runs.take(ask({ wait: true }), live())).toEqual({ none: true });
    m.store.emit(m.node, "seat.serves", { id: A, agents: [ADA, BO] }, yourWord(null));
    const bo = await runs.take(ask({ agent: BO.id, made: BO.made }), live());
    expect("run" in bo && bo.run.seat.id).toBe(A);
    // One run at once (D4): Ada's run finds it busy, and takes it once Bo's has let it go.
    expect(await runs.take(ask(), live())).toEqual({ none: true });
    if ("run" in bo) await bo.run.release();
    const ada = await runs.take(ask(), live());
    expect("run" in ada && ada.run.seat.id).toBe(A);
  });
});

describe("the seat a run takes", () => {
  test("this node's seat of its harness with the most headroom; its VM shares the agent's /work and is as big; let go, it goes and the seat is free", async () => {
    const m = mind();
    m.add(A);
    m.add(B);
    m.add(X, "chatgpt-codex");
    m.add(ELSEWHERE, "claude-subscription", "E", m.other.id);
    m.window(A, 60, 2 * HOUR);
    m.window(B, 10, 4 * HOUR);
    const h = host();
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW });
    const first = await runs.take(ask(), live());
    if (!("run" in first)) throw new Error("no seat");
    expect(first.run.seat).toEqual({ id: B, kind: "claude-subscription", label: "B" });
    expect(h.calls[0]).toBe(`made vm-1 ${JSON.stringify({ seat: { id: B, kind: "claude-subscription", runs: 1 }, shares: AGENT_VM, network: "online", cpus: 2, memoryGb: 4, ttlMinutes: SEAT_VM_MINUTES, run: `seat.${B}` })}`);
    expect(runs.runs(B)).toBe(1);
    // B is busy (one run at once, D4): the next run takes A; then none is free, and one that needn't wait doesn't.
    const second = await runs.take(ask(), live());
    expect("run" in second && second.run.seat.id).toBe(A);
    expect(await runs.take(ask(), live())).toEqual({ none: true });
    // A Codex run takes the Codex seat; a harness no seat runs takes none.
    const codex = await runs.take(ask({ harness: "codex" }), live());
    expect("run" in codex && codex.run.seat.id).toBe(X);
    expect(await runs.take(ask({ harness: "opencode" }), live())).toEqual({ none: true });
    // Its commands, its follow and its stop are in its VM.
    await first.run.exec("echo hi", 30, live());
    await (await first.run.follow!(0, live())).close();
    expect(h.calls.slice(-2)).toEqual(["exec vm-1 echo hi", "stream vm-1 python3 -I"]);
    // Let go: its run stopped there, its VM removed under the seat's own run, and the seat free again.
    await first.run.release();
    expect(h.calls.slice(-2)).toEqual(["exec vm-1 cleanup", `destroy vm-1 seat.${B}`]);
    expect(runs.runs(B)).toBe(0);
    await first.run.release();
    expect(h.calls.filter((c) => c.startsWith("destroy vm-1"))).toHaveLength(1);
    expect(runs.runs(B)).toBe(0);
    const again = await runs.take(ask(), live());
    expect("run" in again && again.run.seat.id).toBe(B);
  });

  test("a seat whose home is in use (a sign-in's VM) is passed over for the next; one whose VM can't be made here is never waited for", async () => {
    const m = mind();
    m.add(A);
    m.add(B);
    m.window(B, 50, HOUR);
    const busyHome = host({ refuse: (seat) => (seat === A ? 409 : null) });
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => busyHome.fake, now: () => NOW });
    const taken = await runs.take(ask(), live());
    expect("run" in taken && taken.run.seat.id).toBe(B);
    const logged: string[] = [];
    const cannot = host({ refuse: () => 424 });
    const none = new SeatRuns({ store: m.store, node: m.node, host: () => cannot.fake, now: () => NOW, log: (line) => void logged.push(line), pollMs: 60_000 });
    expect(await none.take(ask({ wait: true }), live())).toEqual({ none: true });
    expect(logged).toHaveLength(2);
    expect(logged[0]).toStartWith("seats: a VM for ");
    // No host for VMs on this node: no seat.
    expect(await new SeatRuns({ store: m.store, node: m.node, host: () => null }).take(ask({ wait: true }), live())).toEqual({ none: true });
  });

  test("a run with no other way to go on waits for a busy seat and takes it the moment it is let go; one whose work stops stops waiting", async () => {
    const m = mind();
    m.add(A);
    const h = host();
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW, pollMs: 60_000 });
    const holding = await runs.take(ask(), live());
    if (!("run" in holding)) throw new Error("no seat");
    const waiting = runs.take(ask({ wait: true }), live());
    await Bun.sleep(20);
    const freed = performance.now();
    await holding.run.release();
    const got = await waiting;
    // Idle while work waited: the time from its seat being let go to the waiting run having it.
    expect(performance.now() - freed).toBeLessThan(200);
    expect("run" in got && got.run.seat.id).toBe(A);
    const stop = new AbortController();
    const stopped = runs.take(ask({ wait: true }), stop.signal);
    stop.abort();
    await expect(stopped).rejects.toThrow("its work has stopped");
  });

  test("every seat that could take it spent: it rests until the soonest is open again; a seat resting is never taken", async () => {
    const m = mind();
    m.add(A);
    m.add(B);
    m.window(A, 100, 3 * HOUR, "rejected");
    m.store.emit(m.node, "seat.rested", { id: B, until: NOW + 2 * HOUR, window: "five_hour" });
    const h = host();
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW });
    expect(await runs.take(ask(), live())).toEqual({ none: true });
    expect(await runs.take(ask({ wait: true }), live())).toEqual({ rest: { until: NOW + 2 * HOUR, why: "Every seat of yours that could take it is spent (A, B)" } });
    expect(h.calls.filter((c) => c.startsWith("made"))).toEqual([]);
  });

  test("work that began on a seat goes on on it alone: never on another Claude account, its own VM's sign-in no seat of its vendor's", async () => {
    const m = mind();
    m.add(A);
    m.add(B);
    m.add(X, "chatgpt-codex");
    m.window(A, 90, HOUR);
    const h = host();
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW, pollMs: 60_000 });
    const onA = await runs.take(ask({ from: { seat: A, kind: "claude-subscription" } }), live());
    expect("run" in onA && onA.run.seat.id).toBe(A);
    // A busy, B free: a run of work that began on A takes none of B, now or waiting; it waits for A.
    expect(await runs.take(ask({ from: { seat: A, kind: "claude-subscription" } }), live())).toEqual({ none: true });
    const waiting = runs.take(ask({ from: { seat: A, kind: "claude-subscription" }, wait: true }), live());
    await Bun.sleep(10);
    if ("run" in onA) await onA.run.release();
    const back = await waiting;
    expect("run" in back && back.run.seat.id).toBe(A);
    // Work that began on its own VM's sign-in takes no Claude seat; a Codex seat is another vendor's, not this work's to weigh.
    expect(await runs.take(ask({ from: { seat: null, kind: "claude-subscription" } }), live())).toEqual({ none: true });
    expect(await runs.take(ask({ from: { seat: null, kind: "claude-subscription" }, wait: true }), live())).toEqual({ none: true });
    const codex = await runs.take(ask({ harness: "codex", from: { seat: null, kind: "claude-subscription" } }), live());
    expect("run" in codex && codex.run.seat.id).toBe(X);
  });

  test("a run's VM saying its tool isn't signed in signs no seat out: the seat is asked again in a VM of its own, and the log is told what that says", async () => {
    const m = mind();
    m.add(A);
    const h = host();
    const asked: string[] = [];
    let says = true;
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => h.fake, now: () => NOW, confirm: async (seat) => {
      asked.push(seat.id);
      recordSeatStatus(m.store, m.node, seat, says ? { signedIn: true, method: "claude.ai", fingerprint: "A".repeat(22) } : { signedIn: false });
    } });
    const taken = await runs.take(ask(), live());
    if (!("run" in taken)) throw new Error("no seat");
    await taken.run.release(true);
    await Bun.sleep(5);
    expect(asked).toEqual([A]);
    // Signed in after all (the run's VM was slow, or what it printed wasn't its tool's): it stands, and is taken again.
    expect(seatState(m.seat(A), NOW).is).toBe("ready");
    const again = await runs.take(ask(), live());
    if (!("run" in again)) throw new Error("no seat");
    says = false;
    await again.run.release(true);
    await Bun.sleep(5);
    expect(seatState(m.seat(A), NOW)).toEqual({ is: "signed-out", why: "signed-out" });
    expect(await runs.take(ask(), live())).toEqual({ none: true });
    // Let go as any is, it isn't asked.
    m.add(B);
    const plain = await runs.take(ask(), live());
    if (!("run" in plain)) throw new Error("no seat");
    await plain.run.release();
    await Bun.sleep(5);
    expect(asked).toEqual([A, A]);
  });

  test("seats' VMs an earlier process of this node made are removed before the first run takes a seat; one this process made (a sign-in's) is not, and a listing that failed is asked again", async () => {
    const m = mind();
    m.add(A);
    const h = host({ leftover: A });
    let failing = true;
    const made: Record<string, number> = { "vm-left-over": NOW - 60_000 };
    const fake = {
      ...h.fake,
      seatVms: async (seat: string) => (failing ? null : h.fake.seatVms(seat)),
      get: async (vm: string) => {
        const view = (await h.fake.get(vm)) as { id: string } | null;
        return view ? ({ ...view, createdAt: made[vm] ?? NOW + 1 } as never) : null;
      },
    };
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => fake as never, now: () => NOW });
    // (Its listing fails at first: nothing is taken past a VM it couldn't see, and it is asked again.)
    expect(await runs.take(ask(), live())).toEqual({ none: true });
    failing = false;
    h.vms.set("vm-sign-in", { seat: A, run: `seat.${A}` });
    made["vm-sign-in"] = NOW + 5;
    const taken = await runs.take(ask(), live());
    expect(h.calls.filter((c) => c.startsWith("destroy"))).toEqual([`destroy vm-left-over seat.${A}`]);
    // (The sign-in's VM holds the seat's home: no run is made beside it.)
    expect(taken).toEqual({ none: true });
  });

  test("seats' VMs an earlier process of this node left are removed before the first run takes a seat", async () => {
    const m = mind();
    m.add(A);
    const h = host({ leftover: A });
    const fake = {
      ...h.fake,
      get: async (vm: string) => {
        const view = (await h.fake.get(vm)) as unknown as { id: string } | null;
        return view ? ({ ...view, createdAt: vm === "vm-left-over" ? NOW - 60_000 : NOW + 1 } as never) : null;
      },
    };
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => fake as never, now: () => NOW });
    const taken = await runs.take(ask(), live());
    expect("run" in taken && taken.run.seat.id).toBe(A);
    expect(h.calls[0]).toBe(`destroy vm-left-over seat.${A}`);
    expect(h.calls[1]).toStartWith("made vm-1 ");
  });
});

describe("what a run says of its seat's windows", () => {
  test("kept when it says something new (its state, its reset, five points or more of its share); spent, the seat rests until its reset; said open before then, it is back", () => {
    const m = mind();
    m.add(A);
    let now = NOW;
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => null, now: () => now });
    const reset = NOW + 3 * HOUR;
    runs.window(A, { name: "five_hour", status: "allowed", usedPercent: 10, resetsAt: reset });
    runs.window(A, { name: "five_hour", status: "allowed", usedPercent: 12, resetsAt: reset });
    runs.window(A, { name: "five_hour", status: "allowed", usedPercent: 15, resetsAt: reset });
    runs.window(A, { name: "seven_day", status: "warning", usedPercent: 81, resetsAt: NOW + 50 * HOUR });
    expect(m.events("seat.window")).toEqual([
      { id: A, window: "five_hour", status: "allowed", usedPercent: 10, resetsAt: reset },
      { id: A, window: "five_hour", status: "allowed", usedPercent: 15, resetsAt: reset },
      { id: A, window: "seven_day", status: "warning", usedPercent: 81, resetsAt: NOW + 50 * HOUR },
    ]);
    runs.window(A, { name: "five_hour", status: "rejected", usedPercent: 100, resetsAt: reset });
    expect(m.events("seat.rested")).toEqual([{ id: A, until: reset, window: "five_hour" }]);
    expect(seatState(m.seat(A), now)).toEqual({ is: "resting", until: reset, window: "five_hour" });
    // Said again: no second rest. Said open before its reset: back.
    runs.window(A, { name: "five_hour", status: "rejected", usedPercent: 100, resetsAt: reset });
    expect(m.events("seat.rested")).toHaveLength(1);
    now = NOW + HOUR;
    runs.window(A, { name: "five_hour", status: "allowed", usedPercent: 3, resetsAt: NOW + 6 * HOUR });
    expect(m.events("seat.back")).toEqual([{ id: A }]);
    expect(seatState(m.seat(A), now)).toEqual({ is: "ready", renewBy: null });
    // Refused with no reset said: it rests for the shortest plan window. A share outside 0 to 100 is held to it.
    runs.window(A, { name: "five_hour", status: "rejected" });
    expect(m.events("seat.rested").at(-1)).toEqual({ id: A, until: now + 300 * 60_000, window: "five_hour" });
    runs.window(A, { name: "seven_day", status: "warning", usedPercent: 140, resetsAt: NOW + 50 * HOUR });
    expect(m.events("seat.window").at(-1)).toEqual({ id: A, window: "seven_day", status: "warning", usedPercent: 100, resetsAt: NOW + 50 * HOUR });
  });

  test("a reset or a rest further off than a week and a day is held to a week and a day from now: no window rests a seat for longer", () => {
    const m = mind();
    m.add(A);
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => null, now: () => NOW });
    runs.window(A, { name: "five_hour", status: "rejected", usedPercent: 100, resetsAt: Number.MAX_SAFE_INTEGER });
    const most = NOW + SEAT_REST_MAX_MS;
    expect(m.events("seat.window").at(-1)).toEqual({ id: A, window: "five_hour", status: "rejected", usedPercent: 100, resetsAt: most });
    expect(m.events("seat.rested").at(-1)).toEqual({ id: A, until: most, window: "five_hour" });
    expect(seatState(m.seat(A), NOW)).toEqual({ is: "resting", until: most, window: "five_hour" });
  });

  test("another node's seat is that node's to say: nothing is kept here", () => {
    const m = mind();
    m.add(ELSEWHERE, "claude-subscription", "E", m.other.id);
    const runs = new SeatRuns({ store: m.store, node: m.node, host: () => null, now: () => NOW });
    runs.window(ELSEWHERE, { name: "five_hour", status: "rejected", usedPercent: 100, resetsAt: NOW + HOUR });
    expect(m.events("seat.window")).toEqual([]);
    expect(m.events("seat.rested")).toEqual([]);
  });
});
