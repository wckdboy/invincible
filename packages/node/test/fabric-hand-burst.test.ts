import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FABRIC, HANDED_AT_ONCE, type HandArgs, LINK_PATHS, randomId, type TeamSnapshot } from "@invincible/core";
import { doorPair, type DoorPair, type Knock, knock, settled } from "./fabric-door.ts";
import { until } from "./fabric-pair.ts";

/*
 * A burst of hand-offs from one node keeps your grant's limits (the fabric re-review, N1). The runner reads what the
 * giver has open and what its grant has given today, then awaits the give; with no agent named, the give awaits the
 * agents' VM listing before it writes the task. So every call of a burst read "nothing open, nothing given" and was
 * taken at once: 12 past the 8 at once, and $36 against a $3 day. The calls in flight now count, with their budgets,
 * from before that await. Every call here goes through beta's real door, signed by alpha's device key, and the
 * sidecar delivers one socket read's invokes in one synchronous loop, as these are knocked.
 */

setDefaultTimeout(120_000);

let p: DoorPair;

beforeAll(async () => {
  p = await doorPair("q5b-", ["ada", "noa"]);
});

afterAll(async () => {
  await p?.stop();
});

const N = 12;

async function burst(agent: string | undefined, budgetUsd: number) {
  const sealed = [];
  for (let i = 0; i < N; i++) {
    const args: HandArgs = { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: `Burst ${i}: write burst-${i}.txt`, title: `burst ${i}`, gates: [], tools: [], budgetUsd, ...(agent ? { agent } : {}) };
    sealed.push(await p.a.fabric.seal(LINK_PATHS.hand, args));
  }
  const ks = sealed.map((s) => knock(p.b, FABRIC.hand, s, p.alphaKey.did));
  await until(() => ks.every(settled), 30_000, "every hand call answered");
  const taskOf = (k: Knock, kind: string) => k.said.find((s) => s.kind === kind)?.task as string | undefined;
  const accepted = ks.filter((k) => taskOf(k, "accepted"));
  const proposed = ks.filter((k) => taskOf(k, "proposed"));
  const refused = ks.filter((k) => k.failed() !== null);
  const ids = new Set(accepted.map((k) => taskOf(k, "accepted")!));
  const team = await p.callB<TeamSnapshot>("team");
  const budget = team.tasks.filter((t) => ids.has(t.id)).reduce((sum, t) => sum + (t.budgetUsd ?? 0), 0);
  return { ks, accepted: accepted.length, proposed: proposed.length, refused, budget };
}

/** Each task of a burst stopped, and each call ended, so the next burst starts with nothing open. */
async function stopAll(ks: Knock[]) {
  for (const k of ks) {
    const task = k.said.find((s) => s.kind === "accepted" || s.kind === "proposed")?.task as string | undefined;
    if (task) await p.callB("controlTeam", { task, action: "stop" }).catch(() => {});
    k.end();
  }
}

describe("a burst of hand calls from one node, under your grant", () => {
  test("naming no agent: the grant's day and the 8 at once hold, as calls in flight count", async () => {
    await p.callB("grantHandoffs", { from: "alpha", to: "beta", budgetUsdPerDay: 3 });
    const r = await burst(undefined, 1);
    expect(r.budget).toBe(3);
    expect(r.accepted).toBe(3);
    expect(r.accepted + r.proposed).toBe(HANDED_AT_ONCE);
    expect(r.refused.length).toBe(N - HANDED_AT_ONCE);
    for (const k of r.refused) expect(k.failed()!.code).toBe(6);
    await stopAll(r.ks);
  });

  test("naming an agent, as before: the same limits", async () => {
    // A new day's budget of $5, of which the burst above has taken $3 (stopped work counts).
    await p.callB("grantHandoffs", { from: "alpha", to: "beta", budgetUsdPerDay: 5 });
    const r = await burst("ada", 1);
    expect(r.budget).toBe(2);
    expect(r.accepted).toBe(2);
    expect(r.accepted + r.proposed).toBe(HANDED_AT_ONCE);
    expect(r.refused.length).toBe(N - HANDED_AT_ONCE);
    await stopAll(r.ks);
  });
});
