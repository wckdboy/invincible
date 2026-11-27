import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { newNodeIdentity } from "@invincible/core";
import type { LedgerStore } from "@invincible/ledger";
import { handedBy, Handoffs, type HandTeam } from "../src/fabric/handoff.ts";
import type { Fabric } from "../src/fabric/service.ts";
import { TeamService } from "../src/team.ts";
import { TeamStore } from "../src/team-store.ts";
import { until } from "./fabric-pair.ts";

/*
 * A node that restarts ends what was handed to it before (the fabric re-review, N2). A planned restart (a deploy, an
 * update) marks running work to be taken up again by itself once its VM command has surely ended, 16 minutes on; the
 * hand-offs, attached as the node comes back, ended only what was waiting, queued or running. So a handed task that
 * was running at a planned restart ran again 16 minutes later: no call, nobody following it, no proof going back.
 * Now a handed task a planned restart cuts off ends there, and one a crash cut off ends as the node comes back. Work
 * you gave is taken up again as before. The server's binding of HandTeam is mirrored (handedOpen from the store, stop
 * through stopTask).
 */

const MINUTE = 60_000;
const fixtures: { service: TeamService; h?: Handoffs }[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.h?.close();
    await f.service.stop();
  }
});

function node(store: TeamStore, runs: string[]) {
  const service = new TeamService({
    store,
    respond: async () => "",
    restartWaitMs: 16 * MINUTE,
    shutdownGraceMs: 1,
    tickMs: 2,
    executeTask: async (_agent, task, context) => {
      runs.push(task.id);
      return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ verified: false, output: "Cut off." }), { once: true }));
    },
  });
  fixtures.push({ service });
  return service;
}

/** The hand-offs attached to the team as the server attaches them when the node comes back. `swept`: what each sweep of
 * the agents' VMs found ended then (the server's sweep ends what those tasks left running there). */
function attach(store: TeamStore, service: TeamService, swept: string[][] = []) {
  const team: HandTeam = {
    give: async () => {
      throw new Error("not used");
    },
    task: (id) => store.task(id),
    trail: (id, n) => store.trail(id, n),
    stop: (id, why) => (why ? service.stopTask(id, why) : service.control({ task: id, action: "stop" })),
    runningIn: () => null,
    handed: (by, since) => store.handed(by, since),
    handedOpen: () => store.handedOpen(),
    sweep: () => void swept.push(store.tasks().filter((t) => t.givenBy?.startsWith("node:") && ["done", "failed", "stopped"].includes(t.status)).map((t) => t.id)),
  };
  const ledger = { onApplied: () => () => {}, handoffGrant: () => null, activeDevice: () => null, device: () => null } as unknown as LedgerStore;
  const h = new Handoffs({ db: new Database(":memory:"), store: ledger, identity: newNodeIdentity(), fabric: { sidecar: { client: null, did: null } } as unknown as Fabric, log: () => {} });
  fixtures.push({ service, h });
  h.attachTeam(team);
}

function setup() {
  const clock = { now: 1_000_000 };
  const store = new TeamStore(":memory:", () => clock.now);
  store.saveAgent({ id: "ada", name: "Ada" });
  store.saveAgent({ id: "noa", name: "Noa" });
  store.saveRoom({ id: "workshop", name: "Workshop", members: ["ada"], turnBudget: 8 });
  store.saveRoom({ id: "studio", name: "Studio", members: ["noa"], turnBudget: 8 });
  return { clock, store, runs: [] as string[] };
}

const alpha = "n_" + "A".repeat(43);

describe("a task another node handed over, when this node restarts", () => {
  test("a planned restart ends it, and it isn't taken up again; work you gave is, after the wait", async () => {
    const { clock, store, runs } = setup();
    const before = node(store, runs);
    const handed = before.createTask({ room: "workshop", assignee: "ada", title: "Handed by alpha", goal: "Handed by alpha", budgetUsd: 3 }, handedBy(alpha));
    const yours = before.createTask({ room: "studio", assignee: "noa", title: "Yours", goal: "Yours" });
    before.start();
    await until(() => store.task(handed.id)?.status === "running" && store.task(yours.id)?.status === "running", 5_000, "both running");
    await before.stop();
    expect(store.task(handed.id)?.status).toBe("stopped");
    expect(store.task(handed.id)?.error).toContain("handed over by another node");
    expect(store.task(yours.id)?.status).toBe("interrupted");

    clock.now += MINUTE;
    const after = node(store, runs);
    after.start();
    attach(store, after);
    clock.now += 16 * MINUTE;
    await until(() => runs.length === 3, 5_000, "your task taken up again");
    expect(runs.filter((id) => id === handed.id)).toHaveLength(1);
    expect(store.task(handed.id)?.status).toBe("stopped");
    expect(store.task(yours.id)?.status).toBe("running");
  });

  test("a crash leaves it interrupted, and it ends as the node comes back rather than wait to be resumed", async () => {
    const { store, runs } = setup();
    const before = node(store, runs);
    const handed = before.createTask({ room: "workshop", assignee: "ada", title: "Handed by alpha", goal: "Handed by alpha" }, handedBy(alpha));
    before.start();
    await until(() => store.task(handed.id)?.status === "running", 5_000, "running");
    // A crash: no shutdown. The next start finds it running and marks it interrupted, waiting for you.
    const after = node(store, runs);
    after.start();
    expect(store.task(handed.id)?.status).toBe("interrupted");
    const swept: string[][] = [];
    attach(store, after, swept);
    expect(store.task(handed.id)?.status).toBe("stopped");
    expect(store.task(handed.id)?.error).toContain("no longer follows it");
    // And what it left running in its agent's VM is ended as the node comes back: nothing ran its end before (the third
    // re-review's R3-5). The sweep comes once it has ended here, so its list is among those ended.
    expect(swept).toEqual([[handed.id]]);
  });
});
