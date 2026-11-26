import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopView, type RouteName, routes, type SelfActionView } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { loopRecords } from "../src/loops.ts";
import { freePort } from "./ports.ts";

/*
 * His heartbeat and self-action, against a real daemon in a temp home with a stand-in
 * model and a stand-in service: the founding node's default loop, the owner's switch
 * (and that agents can't touch it), a fix he makes himself, and a fleet that still
 * holds the loop of a task this version no longer has (his journal's).
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "life-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  // The stand-in model on loopback counts as a local runtime this node serves.
  localModels: [{ runtime: "stand-in", models: ["m"] }],
  tailscale: null,
};

const root = mkdtempSync(join(tmpdir(), "galahad-life-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

/** The stand-in model: what it was asked, and its answer. */
const asked: string[] = [];
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { messages: { content: string }[] };
    asked.push(body.messages.map((m) => m.content).join("\n"));
    const text = "It was a quiet day.\n\nThe site went down once and came back.\nLearned: the site wobbles now and then.\nNext:\n- Ask the owner whether to watch the site hourly";
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

/** A stand-in service whose status page is down the first time it's asked, then fine. */
let hits = 0;
const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (++hits === 1 ? new Response("down", { status: 503 }) : Response.json({ status: "up" })) });

async function call(name: RouteName, input: unknown, token = home.adminToken()) {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
}
const json = async <T,>(response: Response): Promise<T> => {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};
const arm = async (label: string) => (await json<{ token: string }>(await call("mintArm", { label }))).token;

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "life-node" });
  store.close();
  home.writeConfig({ v: 1, name: "life-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000 });
  expect((await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` })).status).toBe(200);
  for (const role of ["swift", "planner"]) expect((await call("setRoster", { role, models: ["stand-in/m"] })).status).toBe(200);
  // His compute plan is already on record (his first heartbeat would record it, as one more thing he did himself).
  daemon.compute.adapt();
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  service.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("the founding node's default loop", () => {
  test("a heartbeat every 30 minutes, and nothing else", () => {
    const loops = loopRecords(daemon.store);
    expect(loops.map((l) => l.name)).toEqual(["heartbeat"]);
    expect(loops[0]).toMatchObject({ scheduleText: "every 30m", tz: "UTC", on: daemon.identity.id, enabled: true, task: { kind: "heartbeat" }, problem: null });
  });
});

describe("the owner's self-action switch", () => {
  test("on by default; only you turn it off (brain:write), never an agent; changing the heartbeat keeps it", async () => {
    expect((await json<SelfActionView>(await call("selfAction", undefined))).on).toBe(true);
    const agent = await arm("busybody");
    // An agent can read it (mind:read) but never set it.
    expect((await call("selfAction", undefined, agent)).status).toBe(200);
    expect((await call("setSelfAction", { on: false }, agent)).status).toBe(403);
    expect(routes.setSelfAction.scope).toBe("brain:write");

    const off = await json<SelfActionView>(await call("setSelfAction", { on: false }));
    expect(off).toMatchObject({ on: false, heartbeats: ["heartbeat"] });
    expect(off.allowlist.map((a) => a.kind).sort()).toEqual(["adapt-compute", "calibrate", "reap-sandbox", "retry-loop"]);
    expect(loopRecords(daemon.store).find((l) => l.name === "heartbeat")!.task).toEqual({ kind: "heartbeat", selfAction: false });
    // Giving the heartbeat a checklist doesn't quietly turn it back on.
    await json(await call("setLoop", { name: "heartbeat", task: { kind: "heartbeat", checklist: "Is the backup there?" } }));
    expect(loopRecords(daemon.store).find((l) => l.name === "heartbeat")!.task).toEqual({ kind: "heartbeat", checklist: "Is the backup there?", selfAction: false });

    const on = await json<SelfActionView>(await call("setSelfAction", { on: true }));
    expect(on.on).toBe(true);
    // On is the default: the field is gone again, so the task reads as it always did.
    expect(loopRecords(daemon.store).find((l) => l.name === "heartbeat")!.task).toEqual({ kind: "heartbeat", checklist: "Is the backup there?" });
    await json(await call("setLoop", { name: "heartbeat", task: { kind: "heartbeat" } }));
  });
});

describe("after a heartbeat", () => {
  test("a read-only loop that went wrong once is checked again by Galahad himself, and that's in the ledger as his own", async () => {
    const manifest = {
      id: "site",
      label: "Site",
      origin: `http://127.0.0.1:${service.port}`,
      tools: { status: { description: "Is it up?", method: "GET", path: "/status", params: {}, class: "read" } },
    };
    await json(await call("setConnector", { id: "site", manifest }));
    await json(await call("setLoop", { name: "site", schedule: "every 6h", task: { kind: "call", connector: "site", tool: "status" } }));
    await json(await call("runLoop", { name: "site" }));
    await daemon.loops.settled("site");
    expect(daemon.store.loopRuns("site", 1)[0]!.body.status).toBe("attention");

    await json(await call("runLoop", { name: "heartbeat" }));
    await daemon.loops.settled("heartbeat");
    await daemon.loops.settled("site");
    // He ran it again, and this time it was fine.
    expect(hits).toBe(2);
    expect(daemon.store.loopRuns("site", 1)[0]!.body.status).toBe("ok");
    const beat = daemon.store.loopRuns("heartbeat", 1)[0]!.body;
    expect(beat.summary).toContain("Fixed himself: Ran loop site again after one bad run");
    const view = await json<SelfActionView>(await call("selfAction", undefined));
    expect(view.recent[0]).toMatchObject({ class: "read", resource: "self-action", quest: "galahad.self", detail: "Ran loop site again after one bad run" });
    expect(view.recent[0]!.target).toMatch(/^retry-loop:site:/);

    // A second heartbeat leaves it alone: one retry for one bad run.
    await json(await call("runLoop", { name: "heartbeat" }));
    await daemon.loops.settled("heartbeat");
    expect(hits).toBe(2);
  });

  test("with self-action off he only reports", async () => {
    await json(await call("setSelfAction", { on: false }));
    hits = 0;
    await json(await call("runLoop", { name: "site" }));
    await daemon.loops.settled("site");
    expect(daemon.store.loopRuns("site", 1)[0]!.body.status).toBe("attention");
    await json(await call("runLoop", { name: "heartbeat" }));
    await daemon.loops.settled("heartbeat");
    await daemon.loops.settled("site");
    expect(hits).toBe(1);
    expect(daemon.store.loopRuns("heartbeat", 1)[0]!.body.summary).not.toContain("Fixed himself");
    await json(await call("setSelfAction", { on: true }));
  });
});

describe("a fleet that still holds his journal's loop, and what he wrote", () => {
  test("the loop is listed and says its task no longer exists; it never runs, the heartbeat goes on, and it's yours to remove", async () => {
    // As the founding node of an older version left it in the mind.
    daemon.store.emit(daemon.identity, "loop.set", { name: "reflect", schedule: "30 21 * * *", tz: "Europe/Copenhagen", on: daemon.identity.id, enabled: true, task: { kind: "reflect", budget: 6000 }, label: "Galahad's journal" });
    const { loops } = await json<{ loops: LoopView[] }>(await call("loops", undefined));
    const old = loops.find((l) => l.name === "reflect")!;
    expect(old).toMatchObject({ name: "reflect", schedule: "30 21 * * *", enabled: true, task: null, label: "Galahad's journal", last: null, running: false });
    expect(old.problem).toContain("its task no longer exists (his journal");
    expect(old.problem).toContain("galahad loop rm reflect");
    // By hand it's refused, in the same words; nothing was run or recorded.
    const refused = await call("runLoop", { name: "reflect" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("its task no longer exists");
    daemon.loops.tick();
    await daemon.loops.settled();
    expect(daemon.store.loopRuns("reflect")).toEqual([]);
    // The heartbeat beats with it there.
    await json(await call("runLoop", { name: "heartbeat" }));
    await daemon.loops.settled("heartbeat");
    expect(daemon.store.loopRuns("heartbeat", 1)[0]!.body.status).not.toBe("failed");
    // An agent may not pick the task up again, nor may you: it isn't a task any more.
    expect((await call("setLoop", { name: "diary", schedule: "30 21 * * *", task: { kind: "reflect" } })).status).toBe(400);
    await json(await call("removeLoop", { name: "reflect" }));
    expect(loopRecords(daemon.store).some((l) => l.name === "reflect")).toBe(false);
  });

  test("what his journal kept is still his memory: recalled like any other, and nothing lists it as a journal", async () => {
    daemon.store.remember(daemon.identity, "Journal, 2026-11-11:\nThe site went down once and came back.\nLearned: the site wobbles now and then.", { tags: ["journal", "reflection", "day:2026-11-11"], prov: { trust: "agent", source: "reflection" } });
    const { memories } = await json<{ memories: { text: string; tags: string[]; trust: string }[] }>(await call("recall", { q: "site wobbles" }));
    expect(memories[0]).toMatchObject({ trust: "agent", tags: ["journal", "reflection", "day:2026-11-11"] });
    expect(memories[0]!.text).toStartWith("Journal, 2026-11-11:");
    expect(Object.keys(routes)).not.toContain("journal");
  });
});
