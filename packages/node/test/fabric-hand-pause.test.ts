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

/** A runner with `agents` agents, and a ledger whose devices and grants the test revokes. */
function runner(agents = 1) {
  const store = new TeamStore(":memory:");
  const names = ["ada", ...Array.from({ length: agents - 1 }, (_, i) => `ada${i + 1}`)];
  for (const name of names) store.saveAgent({ id: name, name });
  const runs: string[] = [];
  const wake = { poke: () => {} };
  const service = new TeamService({
    store,
    respond: async () => "",
    onChange: () => wake.poke(),
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
  const h = new Handoffs({ db: new Database(":memory:"), store: held, identity: self, fabric: { sidecar: { client: null, did: null } } as unknown as Fabric, log: () => {} });
  fixtures.push({ service, h });
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
    stop: (id, why) => (why ? service.stopTask(id, why) : service.control({ task: id, action: "stop" })),
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

/** alpha's call handing a task to `agent`, as the fabric's socket delivers it. */
function hand(h: Handoffs, giver: Device, agent: string) {
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
    deadlineMs: null,
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
