import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, FABRIC, HANDED_AT_ONCE, type HandArgs, randomId, type TeamSnapshot, type TeamTask } from "@invincible/core";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "@invincible/link";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import type { Invocation } from "../src/fabric/socket.ts";
import { Home } from "../src/home.ts";
import { admin, type Admin, fakeCaps, until } from "./fabric-pair.ts";
import { freePort } from "./ports.ts";

/*
 * Who may give a node's agents work over the fabric (the security review's H1). Over HTTPS a node, even a full one, may
 * not: giving agents work is yours alone. A hand-off is taken at once only under your grant for that pair of nodes
 * (handoff.granted, given once), within its agents, tools and budget for the day; anything else waits on the node that
 * would run it as a proposal, for your approval there. Either way the task is the giving node's, never yours.
 *
 * No Q-AMP binary is needed: the invocation the sidecar would deliver (after its handshake proved alpha's transport
 * key) is handed to beta's door directly, with alpha as its caller.
 */

setDefaultTimeout(60_000);

let root: string;
let a: Daemon;
let b: Daemon;
let callA: Admin;
let callB: Admin;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "q5g-"));
  const homeA = new Home(join(root, "a"));
  const homeB = new Home(join(root, "b"));
  const portA = freePort();
  const portB = freePort();
  const { identity, keystore } = await homeA.createIdentity("file");
  const store = new LedgerStore(homeA.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "pair", nodeName: "alpha" });
  store.close();
  homeA.writeConfig({ v: 1, name: "alpha", fleet, port: portA, keystore, advertise: "127.0.0.1" });
  a = await startDaemon(homeA, { capabilities: fakeCaps("alpha"), syncIntervalMs: 200, proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false });
  callA = admin(homeA, portA);
  const invite = await callA<{ invite: string }>("createInvite", { kind: "node" });
  const joining = await homeB.createIdentity("file");
  const join_ = await requestPairing(invite.invite, { device: joining.identity.id, name: "beta", kind: "node", box: b64u(joining.identity.boxPublic), endpoint: `http://127.0.0.1:${portB}` });
  const { pairings } = await callA("pairings");
  await callA("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });
  const approved = await waitForApproval(join_, { intervalMs: 50 });
  const storeB = new LedgerStore(homeB.ledgerPath);
  storeB.expectFleet(approved.fleet);
  storeB.ingest((await signedPost<SyncPage>(joining.identity, { id: a.identity.id, endpoint: a.endpoint }, "/link/sync", { have: {} })).events);
  storeB.close();
  homeB.writeConfig({ v: 1, name: "beta", fleet: approved.fleet, port: portB, keystore: joining.keystore, advertise: "127.0.0.1" });
  b = await startDaemon(homeB, { capabilities: fakeCaps("beta"), syncIntervalMs: 200, proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false });
  callB = admin(homeB, portB);
  await until(() => b.store.activeDevice(a.identity.id)?.role === "full", 15_000, "alpha known to beta as a full node");
  await callB("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  await callB("saveAgent", { id: "noa", name: "Noa", role: "engineer" });
});

afterAll(async () => {
  await b?.stop();
  await a?.stop();
  rmSync(root, { recursive: true, force: true });
});

type Said = { kind: string; [k: string]: unknown };

/** alpha's hand call as beta's door gets it: what it says back, and how it ended. */
function hand(args: Partial<HandArgs> = {}) {
  const said: Said[] = [];
  let failed: { code: number; message: string } | null = null;
  let completed: unknown = null;
  const abort = new AbortController();
  const full: HandArgs = { handoff: `h_${randomId(16)}`, nonce: randomId(16), goal: "Write hello.txt", title: "hello", gates: ["test -f hello.txt"], tools: [], agent: "ada", ...args };
  const inv: Invocation = {
    task: 1,
    tool: FABRIC.hand,
    args: full,
    caller: "did:key:z6MkTRANSPORTKEYOFALPHAFORTESTSONLY",
    authorization: { kind: "public" },
    chain: [],
    meta: null,
    deadlineMs: null,
    input: true,
    signal: abort.signal,
    inputs: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    emit: (chunk) => void said.push((chunk as { value: Said }).value),
    progress() {},
    complete: (result) => void (completed = result),
    fail: (code, message) => void (failed = { code, message }),
  };
  b.handoffs.invoked(inv, b.store.activeDevice(a.identity.id));
  return { said, failed: () => failed, completed: () => completed, end: () => abort.abort(), args: full };
}

const taskOf = async (id: string): Promise<TeamTask> => (await callB<TeamSnapshot>("team")).tasks.find((t) => t.id === id)!;
const first = (said: Said[], kind: string) => said.find((c) => c.kind === kind);
const byAlpha = () => `node:${a.identity.id}`;

describe("who may give beta's agents work", () => {
  test("over HTTPS, alpha (a full node) is refused: giving agents work is yours alone", async () => {
    const give = await signedPost(a.identity, { id: b.identity.id, endpoint: b.endpoint }, "/api/team/give", { goal: "given by a node" }).then(
      () => "accepted",
      (e: Error) => e.message,
    );
    expect(give).toContain("403");
  });

  test("over Q-AMP, without your grant: it waits on beta as a proposal, alpha's and not yours; you approve it and it is taken", async () => {
    const h = hand({ budgetUsd: 1 });
    await until(() => h.failed() !== null || !!first(h.said, "proposed"), 15_000, "beta took it");
    expect(h.failed()).toBeNull();
    const proposed = first(h.said, "proposed")!;
    expect(proposed).toMatchObject({ agent: { id: "ada", name: "Ada" }, why: "you haven't granted that node hand-offs here" });
    expect(first(h.said, "accepted")).toBeUndefined();
    const task = await taskOf(proposed.task as string);
    expect(task).toMatchObject({ status: "proposed", assignee: "ada", givenBy: byAlpha(), proposedBy: byAlpha() });
    // You approve it on beta: it is taken, and the hand-off goes on.
    await callB("controlTeam", { task: task.id, action: "approve" });
    await until(() => !!first(h.said, "accepted"), 15_000, "accepted once approved");
    expect(first(h.said, "accepted")).toMatchObject({ task: task.id, agent: { id: "ada", name: "Ada" } });
    h.end();
  });

  test("you decline it: the hand-off ends stopped, and nothing ran", async () => {
    const h = hand();
    await until(() => !!first(h.said, "proposed"), 15_000, "proposed");
    const id = first(h.said, "proposed")!.task as string;
    await callB("controlTeam", { task: id, action: "stop" });
    await until(() => h.completed() !== null, 15_000, "its end");
    expect((h.completed() as { task: { status: string } }).task.status).toBe("stopped");
    expect(first(h.said, "accepted")).toBeUndefined();
  });

  test("with your grant for alpha → beta (Ada, $5 a day): taken at once, queued, alpha's, with a budget that fits the day", async () => {
    const granted = await callB<{ grant: { from: { name: string }; to: { name: string }; terms: unknown } }>("grantHandoffs", { from: "alpha", to: "beta", agents: ["ada"], budgetUsdPerDay: 5 });
    expect(granted.grant).toMatchObject({ from: { name: "alpha" }, to: { name: "beta" }, terms: { agents: ["ada"], tools: [], budgetUsdPerDay: 5 } });
    const h = hand({ budgetUsd: 2 });
    await until(() => h.failed() !== null || !!first(h.said, "accepted"), 15_000, "accepted at once");
    expect(first(h.said, "proposed")).toBeUndefined();
    const task = await taskOf(first(h.said, "accepted")!.task as string);
    expect(task).toMatchObject({ assignee: "ada", givenBy: byAlpha(), budgetUsd: 2 });
    expect(task.proposedBy).toBeUndefined();
    expect(["queued", "running", "done", "failed", "interrupted"]).toContain(task.status);
    // None named: what your agent may give on its own yes ($3), here all that is left of the day.
    const rest = hand({ budgetUsd: undefined });
    await until(() => !!first(rest.said, "accepted") || !!first(rest.said, "proposed"), 15_000, "the next");
    expect(first(rest.said, "proposed")).toBeUndefined();
    expect((await taskOf(first(rest.said, "accepted")!.task as string)).budgetUsd).toBe(3);
    h.end();
    rest.end();
  });

  test("beyond your grant, each way, it waits for your approval with why: past the day's budget, another agent, a tool it doesn't give", async () => {
    const cases: [Partial<HandArgs>, string][] = [
      [{ budgetUsd: 1 }, "it would pass your grant's $5 a day ($5.00 given in the last 24 hours)"],
      [{ agent: "noa", budgetUsd: 1 }, "your grant names ada, not noa"],
      [{ tools: ["fleet"] }, "your grant gives its runs none of its tools, not fleet"],
    ];
    for (const [args, why] of cases) {
      const h = hand(args);
      await until(() => !!first(h.said, "proposed") || !!first(h.said, "accepted"), 15_000, why);
      expect(first(h.said, "proposed")?.why).toBe(why);
      expect((await taskOf(first(h.said, "proposed")!.task as string)).givenBy).toBe(byAlpha());
      await callB("controlTeam", { task: first(h.said, "proposed")!.task, action: "stop" });
      h.end();
    }
  });

  test(`at most ${HANDED_AT_ONCE} from one node at once, grant or not: the next is refused as busy`, async () => {
    const open: ReturnType<typeof hand>[] = [];
    // What earlier tests left open counts too: fill up to the limit with proposals (another agent: beyond the grant).
    for (let i = 0; i < HANDED_AT_ONCE + 1; i++) {
      const h = hand({ agent: "noa", budgetUsd: 1 });
      await until(() => !!first(h.said, "proposed") || h.failed() !== null, 15_000, `hand-off ${i}`);
      open.push(h);
      if (h.failed()) break;
    }
    const refused = open.find((h) => h.failed() !== null);
    expect(refused?.failed()).toMatchObject({ code: 6 });
    expect(refused!.failed()!.message).toContain(`alpha has ${HANDED_AT_ONCE} tasks handed here at once`);
    for (const h of open) {
      const task = first(h.said, "proposed")?.task;
      if (task) await callB("controlTeam", { task, action: "stop" });
      h.end();
    }
  });

  test("your grant revoked: what alpha handed under it stops there, and its next hand-off waits for you again", async () => {
    await callB("revokeHandoffs", { from: "alpha", to: "beta" });
    expect((await callB<{ grants: unknown[] }>("handoffGrants")).grants).toEqual([]);
    const h = hand({ budgetUsd: 1 });
    await until(() => !!first(h.said, "proposed"), 15_000, "a proposal again");
    expect(first(h.said, "proposed")?.why).toBe("you haven't granted that node hand-offs here");
    await callB("controlTeam", { task: first(h.said, "proposed")!.task, action: "stop" });
    h.end();
  });

  test("a grant is yours alone, from one active full node to another: a node's own is refused, and so is one for itself", async () => {
    await expect(signedPost(a.identity, { id: b.identity.id, endpoint: b.endpoint }, "/api/fabric/grants", { from: "alpha", to: "beta", budgetUsdPerDay: 5 })).rejects.toThrow("403");
    await expect(callB("grantHandoffs", { from: "beta", to: "beta", budgetUsdPerDay: 5 })).rejects.toThrow("400");
  });
});
