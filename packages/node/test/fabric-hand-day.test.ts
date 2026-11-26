import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FABRIC, HANDOFF_MIN_USD, type HandArgs, LINK_PATHS, randomId, type TeamSnapshot } from "@invincible/core";
import { doorPair, type DoorPair, type Knock, knock, settled } from "./fabric-door.ts";
import { until } from "./fabric-pair.ts";

/*
 * A grant's day counts work as well as dollars (the fabric re-review, N5). It took any budget above $0 that fitted
 * what was left, so $1 of a day took about 10,000 hand-offs at $0.0001, each with its giver's gates. Now each hand-off
 * under a grant counts at least HANDOFF_MIN_USD against the day, whatever smaller budget it asked for (and keeps). Every
 * call goes through beta's real door, signed by alpha's device key.
 */

setDefaultTimeout(120_000);

let p: DoorPair;

beforeAll(async () => {
  p = await doorPair("q5d-", ["ada"]);
});

afterAll(async () => {
  await p?.stop();
});

describe("a grant's day, under hand-offs that ask for almost nothing", () => {
  test(`each counts $${HANDOFF_MIN_USD} against the day: a $0.35 day takes 3 at $0.0001, and the rest wait for you`, async () => {
    await p.callB("grantHandoffs", { from: "alpha", to: "beta", budgetUsdPerDay: 0.35 });
    const ks: Knock[] = [];
    for (let i = 0; i < 6; i++) {
      const args: HandArgs = { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: `Tiny ${i}: write tiny-${i}.txt`, title: `tiny ${i}`, gates: [], tools: [], budgetUsd: 0.0001 };
      ks.push(knock(p.b, FABRIC.hand, await p.a.fabric.seal(LINK_PATHS.hand, args), p.alphaKey.did));
    }
    await until(() => ks.every(settled), 30_000, "every hand call answered");
    const taken = ks.filter((k) => k.said.some((s) => s.kind === "accepted"));
    const proposed = ks.filter((k) => k.said.some((s) => s.kind === "proposed"));
    expect(taken.length).toBe(3);
    expect(proposed.length).toBe(3);
    // Each keeps the budget it asked for: the minimum is what it counts, not what it may spend.
    const ids = new Set(taken.map((k) => k.said.find((s) => s.kind === "accepted")!.task as string));
    const team = await p.callB<TeamSnapshot>("team");
    for (const t of team.tasks.filter((t) => ids.has(t.id))) expect(t.budgetUsd).toBe(0.0001);
    for (const k of ks) k.end();
  });
});
