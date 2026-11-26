import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { b64u, FABRIC, type HandArgs, type HandoffGrantView, LINK_PATHS, newNodeIdentity, randomId, type TeamSnapshot } from "@invincible/core";
import { enrollDevice, revokeDevice } from "@invincible/ledger";
import { doorPair, type DoorPair, knock, settled } from "./fabric-door.ts";
import { until } from "./fabric-pair.ts";

/*
 * Whose grant it is (the fabric re-review, I-f). A grant's record said nothing of the node that recorded it, so one a
 * node wrote for itself read exactly like yours, and one it wrote for another pair outlived its revocation. Now each
 * grant names the full node that recorded it, and a grant a node since revoked recorded ends with that node: what was
 * taken under it stops, as under a grant you revoked. Test keys only; loopback addresses only.
 */

setDefaultTimeout(120_000);

let p: DoorPair;

beforeAll(async () => {
  p = await doorPair("q5w-", ["ada"]);
});

afterAll(async () => {
  await p?.stop();
});

describe("a grant another full node recorded", () => {
  test("names that node, and ends with it: the work taken under it stops", async () => {
    const gamma = newNodeIdentity();
    enrollDevice(p.a.store, p.a.identity, { device: gamma.id, name: "gamma", kind: "node", box: b64u(gamma.boxPublic) });
    p.a.store.emit(gamma, "handoff.granted", { from: p.a.identity.id, to: p.b.identity.id, terms: { tools: [], budgetUsdPerDay: 5 } }, { trust: "owner" });
    await until(() => p.b.store.handoffGrant(p.a.identity.id, p.b.identity.id)?.by === gamma.id, 15_000, "gamma's grant known to beta");
    const { grants } = await p.callB<{ grants: HandoffGrantView[] }>("handoffGrants");
    expect(grants.map((g) => g.by.name)).toEqual(["gamma"]);

    const hand = async () => {
      const args: HandArgs = { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: "Write the file", title: "under gamma's grant", gates: [], tools: [], budgetUsd: 1, agent: "ada" };
      const k = knock(p.b, FABRIC.hand, await p.a.fabric.seal(LINK_PATHS.hand, args), p.alphaKey.did);
      await until(() => settled(k), 15_000, "taken");
      return { k, task: k.said.find((s) => s.kind === "accepted")?.task as string | undefined };
    };
    // (These agents have no VM, so a task taken fails at once: one is handed first, and its room paused, so the next
    // waits there, queued, taken under the grant.)
    const before = await hand();
    const room = (await p.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === before.task)!.room;
    await p.callB("controlTeam", { room, action: "pause" });
    const { k, task } = await hand();
    expect(task).toBeDefined();
    expect((await p.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === task)?.status).toBe("queued");

    revokeDevice(p.a.store, p.a.identity, gamma.id, "test: it turned on you");
    await until(() => p.b.store.handoffGrant(p.a.identity.id, p.b.identity.id) === null, 15_000, "gamma's grant ended on beta");
    await until(async () => (await p.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === task)?.status === "stopped", 15_000, "the work stopped");
    const stopped = (await p.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === task)!;
    expect(stopped.error).toContain("the node that recorded it was revoked");
    expect((await p.callB<{ grants: HandoffGrantView[] }>("handoffGrants")).grants).toEqual([]);
    k.end();
    before.k.end();
  });
});
