import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FABRIC, HANDED_AT_ONCE, type HandArgs, newNodeIdentity, randomId } from "@invincible/core";
import type { Device, LedgerStore } from "@invincible/ledger";
import { handedBy, Handoffs, type HandTeam } from "../src/fabric/handoff.ts";
import type { Fabric } from "../src/fabric/service.ts";
import type { Invocation } from "../src/fabric/socket.ts";
import { TeamService } from "../src/team.ts";
import { TeamStore } from "../src/team-store.ts";
import { until } from "./fabric-pair.ts";

/*
 * A handed task never outlives the call that follows it (the fabric's second re-review, N6). A pause (of its agent, its
 * room or the task, or the agent turned off) made a running handed task "interrupted": the runner answered its giver
 * and let it go, and from then on nothing that ends handed work reached it. Revoking its node or your grant left it
 * be, and a broad resume ran it again, unfollowed, and past the 8 at once. Now the runner ends what its call no longer
 * follows, a broad resume passes over another node's tasks, and a revocation ends the store's tasks of that node,
 * followed or not. The server's binding of HandTeam is mirrored (server.ts), the team's changes waking the followers.
 *
 * Nor does it outlive what the runner allows it (N7): its call's deadline, or the longest a hand-off may last
 * (HAND_CALL_MS), whichever comes first. Its giver's deadline alone bounded it, so a giver that set none kept it going.
 */

setDefaultTimeout(30_000);
const fixtures: { service: TeamService; h: Handoffs }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.h.close();
    await f.service.stop();
  }
});

const node = (name: string, c: string): Device => ({ id: "n_" + c.repeat(43), kind: "node", role: "full", name, scopes: [], enrolledHlc: "0", revokedHlc: null }) as unknown as Device;

/** A runner with `agents` agents, and a ledger whose devices and grants the test revokes. `log` is the server's. */
function runner(agents = 1, clock: { now?: () => number; handCallMs?: number } = {}, log: (message: string) => void = () => {}) {
  const store = new TeamStore(":memory:");
  const names = ["ada", ...Array.from({ length: agents - 1 }, (_, i) => `ada${i + 1}`)];
  for (const name of names) store.saveAgent({ id: name, name });
  const runs: string[] = [];
  const wake = { poke: () => {} };
  // (As the server binds them: a resume by id of another node's task asks the hand-offs, which follow it from then.)
  const late: { h?: Handoffs } = {};
  const service = new TeamService({
    store,
    respond: async () => "",
    onChange: () => wake.poke(),
    mayResumeHanded: (task) => late.h!.resumable(task),
    resumedHanded: (task) => late.h!.resumed(task),
    shutdownGraceMs: 1,
    tickMs: 5,
    concurrency: agents,
    executeTask: async (_agent, task, context) => {
      runs.push(task.id);
      return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ verified: false, output: "Cut off." }), { once: true }));
    },
  });
  service.start();
  const self = newNodeIdentity();
  const alpha = node("alpha", "A");
  const ledger = { active: new Set([alpha.id]), granted: new Set([alpha.id]), listeners: [] as ((events: { kind: string; body: unknown }[]) => void)[] };
  const held = {
    onApplied: (fn: (typeof ledger.listeners)[number]) => {
      ledger.listeners.push(fn);
      return () => {};
    },
    handoffGrant: (from: string, to: string) => (ledger.granted.has(from) && to === self.id ? { from, to, terms: { tools: [], budgetUsdPerDay: 100 }, hlc: "1", via: null, by: from } : null),
    activeDevice: (id: string) => (id === alpha.id && ledger.active.has(id) ? alpha : null),
    device: (id: string) => (id === alpha.id ? alpha : null),
  } as unknown as LedgerStore;
  const h = new Handoffs({ db: new Database(":memory:"), store: held, identity: self, fabric: { sidecar: { client: null, did: null } } as unknown as Fabric, log, ...clock });
  fixtures.push({ service, h });
  late.h = h;
  wake.poke = () => h.poke();
  const team: HandTeam = {
    give: async (args, _signal, how) => {
      const agent = args.agent ?? "ada";
      const room = service.direct(agent);
      const input = { room: room.id, assignee: agent, title: args.title, goal: args.goal, gates: args.gates, ...("budgetUsd" in how ? { budgetUsd: how.budgetUsd } : {}) };
      const task = "propose" in how ? service.proposeTask(input, how.by) : service.createTask(input, how.by);
      return { task, agent: { id: agent, name: agent } };
    },
    task: (id) => service.task(id),
    trail: (id, n) => store.trail(id, n),
    // As server.ts binds it: a stop that throws is logged, never thrown on.
    stop: (id, why) => {
      try {
        if (why) service.stopTask(id, why);
        else service.control({ task: id, action: "stop" });
      } catch (error) {
        log(`fabric: ${id} wasn't stopped: ${(error as Error).message}`);
      }
    },
    runningIn: () => null,
    handed: (by, since) => store.handed(by, since),
    handedOpen: () => store.handedOpen(),
  };
  h.attachTeam(team);
  /** The ledger applied these events: each listener hears them, as LedgerStore.onApplied tells them. */
  const applied = (events: { kind: string; body: unknown }[]) => {
    for (const fn of ledger.listeners) fn(events);
  };
  return { store, service, h, self, alpha, names, runs, ledger, applied };
}

/** alpha's call handing a task to `agent`, as the fabric's socket delivers it (with no deadline, unless given one). */
function hand(h: Handoffs, giver: Device, agent: string, deadlineMs: number | null = null) {
  const said: { kind: string; task?: string }[] = [];
  let failed: { code: number; message: string } | null = null;
  let completed: { task?: { status?: string; error?: string | null } } | null = null;
  const args: HandArgs = { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: "alpha's work", title: "alpha's work", gates: [], tools: [], budgetUsd: 1, agent };
  const inv = {
    task: 1,
    tool: FABRIC.hand,
    args,
    caller: `did:key:${giver.name}`,
    authorization: { kind: "public" },
    chain: [],
    meta: null,
    deadlineMs,
    input: true,
    signal: new AbortController().signal,
    inputs: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    emit: (chunk: { value: { kind: string; task?: string } }) => void said.push(chunk.value),
    progress() {},
    complete: (result: unknown) => void (completed = result as typeof completed),
    fail: (code: number, message: string) => void (failed = { code, message }),
  } as unknown as Invocation;
  h.invoked(inv, giver);
  return {
    task: () => said.find((s) => s.kind === "accepted")?.task ?? null,
    proposed: () => said.find((s) => s.kind === "proposed")?.task ?? null,
    taken: () => said.some((s) => s.kind === "accepted"),
    failed: () => failed,
    completed: () => completed,
  };
}

describe("a handed task you pause", () => {
  for (const [how, pause] of [
    ["its agent paused", (r: ReturnType<typeof runner>) => r.service.control({ agent: "ada", action: "pause" })],
    ["the task paused", (r: ReturnType<typeof runner>, id: string) => r.service.control({ task: id, action: "pause" })],
    ["its agent turned off", (r: ReturnType<typeof runner>) => r.service.saveAgent({ id: "ada", name: "ada", enabled: false })],
  ] as const) {
    test(`ends there (${how}): its giver is told it stopped, and resuming runs none of it`, async () => {
      const r = runner();
      const k = hand(r.h, r.alpha, "ada");
      await until(() => k.taken(), 5_000, "taken");
      const id = k.task()!;
      await until(() => r.store.task(id)?.status === "running" && r.h.running().length === 1, 5_000, "running, and followed");
      pause(r, id);
      await until(() => k.completed() !== null, 5_000, "its giver answered");
      expect(k.completed()!.task?.status).toBe("stopped");
      expect(r.store.task(id)?.status).toBe("stopped");
      expect(r.store.task(id)?.error).toContain("handed over by another node");
      expect(r.h.running()).toHaveLength(0);
      // Resumed broadly, as you would after a look at the VM: nothing of alpha's is taken up again.
      if (how === "its agent turned off") r.service.saveAgent({ id: "ada", name: "ada", enabled: true });
      r.service.control({ agent: "ada", action: "resume" });
      r.service.control({ room: r.store.task(id)!.room, action: "resume" });
      expect(r.store.task(id)?.status).toBe("stopped");
      await Bun.sleep(50);
      expect(r.runs).toEqual([id]);
    });
  }

  test("a pause and a resume don't put one node past the 8 at once", async () => {
    const r = runner(HANDED_AT_ONCE);
    const by = handedBy(r.alpha.id);
    const first = r.names.map((name) => hand(r.h, r.alpha, name));
    await until(() => first.every((k) => k.taken()) && r.store.handed(by, 0).atOnce === HANDED_AT_ONCE, 5_000, "8 open");
    for (const name of r.names) r.service.control({ agent: name, action: "pause" });
    await until(() => first.every((k) => k.completed() !== null) && r.h.running().length === 0, 5_000, "the first 8 answered");
    const more = r.names.map((name) => hand(r.h, r.alpha, name));
    await until(() => more.every((k) => k.taken() || k.failed() !== null), 5_000, "8 more answered");
    for (const name of r.names) r.service.control({ agent: name, action: "resume" });
    expect(r.store.handed(by, 0).atOnce).toBeLessThanOrEqual(HANDED_AT_ONCE);
    for (const k of first) expect(r.store.task(k.task()!)?.status).toBe("stopped");
  });
});

describe("a broad resume", () => {
  test("passes over another node's task, which is resumed only when you name it by its id", () => {
    const store = new TeamStore(":memory:");
    store.saveAgent({ id: "ada", name: "Ada" });
    store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"], turnBudget: 8 });
    const handed = store.createTask({ room: "workshop", assignee: "ada", title: "Handed by alpha", goal: "Handed by alpha", budgetUsd: 1 }, { givenBy: handedBy("n_" + "A".repeat(43)) });
    const yours = store.createTask({ room: "workshop", assignee: "ada", title: "Yours", goal: "Yours" });
    store.finish(handed.id, "interrupted", "Paused by you.");
    store.finish(yours.id, "interrupted", "Paused by you.");
    for (const select of [{ agent: "ada" }, { room: "workshop" }, {}]) {
      store.resume(select);
      expect(store.task(handed.id)?.status).toBe("interrupted");
    }
    expect(store.task(yours.id)?.status).toBe("queued");
    store.resume({ task: handed.id });
    expect(store.task(handed.id)?.status).toBe("queued");
  });
});

describe("a revocation, for what no call follows", () => {
  /** Two of alpha's tasks the store holds that no call follows (one you resumed by its id runs so): one taken under
   * your grant, one beyond it that you approved. */
  async function unfollowed(r: ReturnType<typeof runner>) {
    const by = handedBy(r.alpha.id);
    const underGrant = r.service.createTask({ room: r.service.direct("ada").id, assignee: "ada", title: "Under your grant", goal: "Under your grant", budgetUsd: 1 }, by);
    const approved = r.service.proposeTask({ room: r.service.direct("ada1").id, assignee: "ada1", title: "Approved by you", goal: "Approved by you", budgetUsd: 1 }, by);
    r.service.control({ task: approved.id, action: "approve" });
    await until(() => r.store.task(underGrant.id)?.status === "running" && r.store.task(approved.id)?.status === "running", 5_000, "both running");
    expect(r.h.running()).toHaveLength(0);
    return { underGrant: underGrant.id, approved: approved.id };
  }

  test("your grant revoked ends what was taken under it; what you approved goes on, until its node is revoked", async () => {
    const r = runner(2);
    const t = await unfollowed(r);
    r.ledger.granted.delete(r.alpha.id);
    r.applied([{ kind: "handoff.revoked", body: { from: r.alpha.id, to: r.self.id } }]);
    expect(r.store.task(t.underGrant)?.status).toBe("stopped");
    expect(r.store.task(t.approved)?.status).toBe("running");
    r.ledger.active.delete(r.alpha.id);
    r.h.revoked(r.alpha.id);
    expect(r.store.task(t.approved)?.status).toBe("stopped");
    expect(r.store.task(t.approved)?.error).toContain("revoked");
  });

  test("a grant that ended with the node that recorded it ends what was taken under it", async () => {
    const r = runner(2);
    const t = await unfollowed(r);
    // The node that recorded your grant for alpha is revoked, and the grant ends with it (I-f).
    r.ledger.granted.delete(r.alpha.id);
    r.applied([{ kind: "device.revoked", body: { device: "n_" + "R".repeat(43) } }]);
    expect(r.store.task(t.underGrant)?.status).toBe("stopped");
    expect(r.store.task(t.approved)?.status).toBe("running");
  });
});

describe("a handed task's life on the runner", () => {
  const MINUTE = 60_000;

  test("ends at the longest a hand-off may last, though its giver set no deadline", async () => {
    const clock = { now: 1_000_000 };
    const r = runner(1, { now: () => clock.now, handCallMs: 60 * MINUTE });
    const k = hand(r.h, r.alpha, "ada");
    await until(() => k.taken() && r.store.task(k.task()!)?.status === "running", 5_000, "running");
    clock.now += 59 * MINUTE;
    r.h.poke();
    await Bun.sleep(50);
    expect(r.store.task(k.task()!)?.status).toBe("running");
    clock.now += MINUTE;
    r.h.poke();
    await until(() => k.completed() !== null, 5_000, "its giver answered");
    expect(k.completed()!.task?.status).toBe("stopped");
    expect(r.store.task(k.task()!)?.status).toBe("stopped");
    expect(r.store.task(k.task()!)?.error).toContain("the longest a hand-off may last here");
  });

  test("ends at its call's deadline when that comes first", async () => {
    const clock = { now: 1_000_000 };
    const r = runner(1, { now: () => clock.now, handCallMs: 60 * MINUTE });
    const k = hand(r.h, r.alpha, "ada", 10 * MINUTE);
    await until(() => k.taken() && r.store.task(k.task()!)?.status === "running", 5_000, "running");
    clock.now += 10 * MINUTE;
    r.h.poke();
    await until(() => k.completed() !== null, 5_000, "its giver answered");
    expect(k.completed()!.task?.status).toBe("stopped");
    expect(r.store.task(k.task()!)?.error).toContain("deadline");
  });
});

/*
 * Nor does a stop that doesn't take keep it going (the third re-review's R3-2). The life bound asked for a stop and went
 * round again at once: when the stop didn't take, the runner's loop never yielded again, so no timer, no I/O and no
 * step of the node's shutdown ran. A stop doesn't take while the node stops (its team controller stopped first, its
 * hand-offs much later) or when the stop can't be written. Now the hand-off ends there all the same, answered as failed.
 * (The log here ends a spin after a thousand failed stops, as nothing in the node would, so that the test ends.)
 */
describe("a handed task whose life ends and whose stop doesn't take", () => {
  const MINUTE = 60_000;
  /** The server's log: it counts the stops that didn't take, and ends a spin at a thousand of them. */
  const stops = () => {
    const seen = { failed: 0 };
    const log = (message: string) => {
      if (!message.includes("wasn't stopped")) return;
      if (++seen.failed >= 1_000) throw new Error("a spin, ended by the test");
    };
    return { seen, log };
  };

  test("as the node stops: its giver is told it failed, and the node goes on", async () => {
    const clock = { now: 1_000_000 };
    const s = stops();
    const r = runner(1, { now: () => clock.now, handCallMs: 60 * MINUTE }, s.log);
    // No grant: it waits for your approval as a proposal.
    r.ledger.granted.delete(r.alpha.id);
    const k = hand(r.h, r.alpha, "ada");
    await until(() => k.proposed() !== null, 5_000, "proposed");
    // The node stops as daemon.ts stops it: its team controller first, its hand-offs much later.
    void r.service.stop();
    clock.now += 60 * MINUTE;
    r.h.poke();
    await until(() => k.completed() !== null || k.failed() !== null, 5_000, "its giver answered");
    expect(s.seen.failed).toBe(1);
    expect(k.failed()).toBeNull();
    expect(k.completed()!.task?.status).toBe("failed");
    expect(k.completed()!.task?.error).toContain("couldn't be stopped here");
  });

  test("when its stop can't be written: its giver is told it failed, and the node goes on", async () => {
    const clock = { now: 1_000_000 };
    const s = stops();
    const r = runner(1, { now: () => clock.now, handCallMs: 60 * MINUTE }, s.log);
    r.ledger.granted.delete(r.alpha.id);
    const k = hand(r.h, r.alpha, "ada");
    await until(() => k.proposed() !== null, 5_000, "proposed");
    // A write that fails while reads work: a trigger standing in for a full disk.
    const db = (r.store as unknown as { db: Database }).db;
    db.exec("CREATE TRIGGER full_disk BEFORE UPDATE ON team_jobs BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;");
    try {
      clock.now += 60 * MINUTE;
      r.h.poke();
      await until(() => k.completed() !== null || k.failed() !== null, 5_000, "its giver answered");
    } finally {
      db.exec("DROP TRIGGER full_disk");
    }
    expect(s.seen.failed).toBe(1);
    expect(k.failed()).toBeNull();
    expect(k.completed()!.task?.status).toBe("failed");
    expect(k.completed()!.task?.error).toContain("couldn't be stopped here");
  });
});

/*
 * Your resume by its id (the third re-review's R3-6): it took up a handed task that nobody followed, past a revocation
 * of its node or your grant that had come before, with no life bound and not counted against the 8 at once. Now it is
 * refused once its node or the grant it was taken under is revoked, or with its node at the 8 already; otherwise it runs
 * followed by this node's hand-offs, held to the longest a hand-off may last from when you took it up again.
 */
describe("a handed task you take up again by its id", () => {
  const MINUTE = 60_000;
  /** One of alpha's tasks, taken under your grant by `agent`, and stopped: what a resume by its id takes up. */
  async function stopped(r: ReturnType<typeof runner>, agent = "ada") {
    const k = hand(r.h, r.alpha, agent);
    await until(() => k.taken() && r.store.task(k.task()!)?.status === "running", 5_000, "running");
    r.service.control({ task: k.task()!, action: "stop" });
    await until(() => k.completed() !== null, 5_000, "its giver answered");
    return k.task()!;
  }

  test("is refused once its node is revoked", async () => {
    const r = runner();
    const id = await stopped(r);
    r.ledger.active.delete(r.alpha.id);
    r.h.revoked(r.alpha.id);
    expect(() => r.service.control({ task: id, action: "resume" })).toThrow("revoked");
    expect(r.store.task(id)?.status).toBe("stopped");
  });

  test("is refused once the grant it was taken under is revoked", async () => {
    const r = runner();
    const id = await stopped(r);
    r.ledger.granted.delete(r.alpha.id);
    r.applied([{ kind: "handoff.revoked", body: { from: r.alpha.id, to: r.self.id } }]);
    expect(() => r.service.control({ task: id, action: "resume" })).toThrow("grant");
    expect(r.store.task(id)?.status).toBe("stopped");
  });

  test("is refused while its node has the 8 at once open here", async () => {
    const r = runner(HANDED_AT_ONCE + 1);
    const id = await stopped(r);
    const open = r.names.slice(1).map((agent) => hand(r.h, r.alpha, agent));
    await until(() => open.every((k) => k.taken()), 5_000, "the others taken");
    expect(r.store.handed(handedBy(r.alpha.id), 0).atOnce).toBe(HANDED_AT_ONCE);
    expect(() => r.service.control({ task: id, action: "resume" })).toThrow(`${HANDED_AT_ONCE} tasks`);
    expect(r.store.task(id)?.status).toBe("stopped");
  });

  test("runs followed, and ends at the longest a hand-off may last from when you took it up again", async () => {
    const clock = { now: 1_000_000 };
    const r = runner(1, { now: () => clock.now, handCallMs: 60 * MINUTE });
    const id = await stopped(r);
    clock.now += 30 * MINUTE;
    r.service.control({ task: id, action: "resume" });
    await until(() => r.store.task(id)?.status === "running", 5_000, "running again");
    clock.now += 59 * MINUTE;
    r.h.poke();
    await Bun.sleep(50);
    expect(r.store.task(id)?.status).toBe("running");
    clock.now += MINUTE;
    r.h.poke();
    await until(() => r.store.task(id)?.status === "stopped", 5_000, "stopped at the end of its life");
    expect(r.store.task(id)?.error).toContain("the longest a hand-off may last");
  });
});
