import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { HANDED_AT_ONCE, type HandedView, type TeamSnapshot } from "@invincible/core";
import { HAVE_QAMP, type Pair, startPair, until } from "./fabric-pair.ts";

/*
 * A burst of hand-offs keeps your grant's limits end to end (the fabric re-review, N1): two nodes with real Q-AMP
 * sidecars on loopback, alpha handing 16 tasks to beta at once through its own hand route, naming no agent, as a
 * script of yours would. Beta holds your grant for alpha → beta at $3 a day. Before the fix, 2 were taken under it
 * ($6) and 16 were open on beta at once. Nothing runs (these agents have no VM): what is counted is what was taken.
 */

setDefaultTimeout(180_000);

if (!HAVE_QAMP) console.log(`${import.meta.file} SKIPPED, unverified: no Q-AMP binary (INVINCIBLE_QAMP_TEST_BIN).`);

describe.skipIf(!HAVE_QAMP)("a burst of hand-offs over a real Q-AMP connection", () => {
  let pair: Pair;

  beforeAll(async () => {
    pair = await startPair();
    await pair.callB("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
    await pair.callB("saveAgent", { id: "noa", name: "Noa", role: "engineer" });
  });

  afterAll(async () => {
    await pair?.stop();
  });

  test("16 hand-offs at once, no agent named, under a $3-a-day grant: $3 taken, 8 open at once, the rest refused", async () => {
    await pair.callB("grantHandoffs", { from: "alpha", to: "beta", budgetUsdPerDay: 3 });
    await until(() => pair.a.store.handoffGrant(pair.a.identity.id, pair.b.identity.id) !== null, 15_000, "the grant known to alpha too");
    const N = 16;
    const views = await Promise.all(Array.from({ length: N }, (_, i) => pair.callA<HandedView>("handTask", { node: "beta", goal: `Burst ${i}: write burst-${i}.txt`, budgetUsd: 3 })));
    const now = () => Promise.all(views.map((v) => pair.callA<HandedView>("handedTask", { id: v.id, after: 0 })));
    await until(async () => (await now()).every((v) => v.task !== null || v.phase === "ended"), 60_000, "every hand-off taken, proposed or ended");
    const after = await now();
    const team = await pair.callB<TeamSnapshot>("team");
    const byAlpha = team.tasks.filter((t) => t.givenBy === `node:${pair.a.identity.id}`);
    const taken = byAlpha.filter((t) => !t.proposedBy);
    const proposed = byAlpha.filter((t) => t.proposedBy);
    const refused = after.filter((v) => v.phase === "ended" && v.task === null);
    expect(taken.length).toBe(1);
    expect(taken.reduce((sum, t) => sum + (t.budgetUsd ?? 0), 0)).toBe(3);
    // Open at once, as the runner counts them (waiting for you, queued or running), never past 8. The burst arrives over
    // a few socket reads, and the one taken fails at once here (no VM), freeing its place while the rest still come; the
    // proposals wait for you and never end by themselves, so those open now are the most there ever were.
    const open = byAlpha.filter((t) => t.status === "proposed" || t.status === "queued" || t.status === "running");
    expect(open.length).toBeLessThanOrEqual(HANDED_AT_ONCE);
    expect(proposed.length).toBeLessThanOrEqual(HANDED_AT_ONCE);
    expect(taken.length + proposed.length + refused.length).toBe(N);
    for (const v of views) await pair.callA("stopHanded", { id: v.id }).catch(() => {});
  });
});
