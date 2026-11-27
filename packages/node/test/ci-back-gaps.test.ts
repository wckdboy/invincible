import { afterEach, describe, expect, test } from "bun:test";
import { newNodeIdentity, TEAM_PRIMARY } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { CI_FIXES, giveBack, reviewBack } from "../src/ci-back.ts";
import type { CiFailure, ShippedPull } from "../src/ci-watch.ts";
import { OutcomeRunner } from "../src/outcomes.ts";
import { TeamStore } from "../src/team-store.ts";
import { TeamService } from "../src/team.ts";

/*
 * The review of 27 November's tests for slice 6a, taken as they are (its poc6-gaps.test.ts, 6a's half): what the code
 * held already, which no other test held it to. Each kills a mutant that survived the rest (G-C3, G-C5 and G-C13).
 */

const ART = "art_AAAAAAAAAAAAAAAAAAAAAA";
const head = (n: number) => String(n).repeat(40);
const pull: ShippedPull = { action: "a_ship1", connector: "github", owner: "amiriteorg", repo: "shipyard", branch: "invincible/units", artifact: ART, pr: 12, at: 0 };
const failure = (n = 1): CiFailure => ({ head: head(n), failing: ["test"], lines: [] });
const fixtures: { store: TeamStore; service: TeamService; runner: OutcomeRunner }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runner.stop(); await f.service.stop(); f.store.close(); } });

function world() {
  const identity = newNodeIdentity();
  const mind = new LedgerStore(":memory:");
  foundFleet(mind, identity, { fleetName: "homelab", nodeName: "ultra" });
  const store = new TeamStore(":memory:", () => Date.UTC(2026, 10, 18, 9, 0));
  store.saveAgent({ id: "noa", name: "Noa", repository: "https://github.com/amiriteorg/shipyard" });
  const service = new TeamService({ store, respond: async () => "", executeTask: async () => ({ verified: false, output: "" }) });
  const runner = new OutcomeRunner({ store, service: () => service, mind, identity, brain: () => ({ store: mind, vault: undefined as never }), prices: () => ({}), log: () => {} });
  fixtures.push({ store, service, runner });
  const shipped = (budgetUsd?: number) => {
    const task = store.createTask({ room: store.direct("noa").id, assignee: "noa", title: "Parse SI units", goal: "Parse them.", gates: ["bun test"], ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    store.finish(task.id, "done", null, { verified: true, output: "Done.", changes: { artifact: ART, files: 2, base: "0".repeat(40) } });
    return store.task(task.id)!;
  };
  return { store, service, deps: { store, service: () => service, outcomes: () => runner, declined: () => false }, shipped, fixes: () => store.fixesOf("amiriteorg", "shipyard", "invincible/units") };
}

describe("6a: what a fix on its own word carries", () => {
  test("G-C3: work you gave $1 gets a fix of $1, not $3", () => {
    const w = world();
    w.shipped(1);
    giveBack(w.deps, pull, failure());
    expect(w.fixes()).toEqual([expect.objectContaining({ budgetUsd: 1, givenBy: TEAM_PRIMARY })]);
  });

  test("G-C5: work that named no budget gets a fix of $3", () => {
    const w = world();
    w.shipped();
    expect(giveBack(w.deps, pull, failure())).toMatchObject({ fixing: true });
    expect(w.fixes()).toEqual([expect.objectContaining({ budgetUsd: 3, givenBy: TEAM_PRIMARY })]);
  });

  test("G-C13: a fourth review on one pull request is yours: three fixes at most, reviews counted", () => {
    const w = world();
    w.service.setOwnDaily(100);
    w.shipped(1);
    for (let id = 1; id <= CI_FIXES + 1; id++) reviewBack(w.deps, pull, { id, by: "lin", head: head(1), body: "Change it.", lines: [] });
    expect(w.fixes()).toHaveLength(CI_FIXES);
  });
});
