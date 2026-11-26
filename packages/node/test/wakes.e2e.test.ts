import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopRunView, type LoopView, type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { loopRecords } from "../src/loops.ts";
import { freePort } from "./ports.ts";

/*
 * A loop woken by its webhook, against a real daemon in a temp home: the secret is made with its first webhook and
 * shown once, only a body signed with it wakes the loop (every refusal reads the same), the same delivery wakes it
 * once, a new secret retires the old, and removing the loop takes its webhook and secret with it.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "wakes-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [],
  tailscale: null,
};

const root = mkdtempSync(join(tmpdir(), "galahad-wakes-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

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
const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const hook = (loop: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/hooks/${loop}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

const secretNames = async () => (await json<{ secrets: { name: string }[] }>(await call("secrets", undefined))).secrets.map((s) => s.name);

async function runsOf(loop: string, count: number): Promise<LoopRunView[]> {
  for (let i = 0; i < 100; i++) {
    const { runs } = await json<{ runs: LoopRunView[] }>(await call("loopRuns", { name: loop, limit: 10 }));
    if (runs.length >= count) return runs;
    await Bun.sleep(50);
  }
  throw new Error(`loop ${loop} never ran ${count} times`);
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "wakes-node" });
  store.close();
  home.writeConfig({ v: 1, name: "wakes-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, wakeWatchMs: false, ciWatchMs: false, defaultHeartbeat: false });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a loop woken by its webhook", () => {
  let secret = "";

  test("its first webhook makes its secret, shown this once; it runs only when woken", async () => {
    const set = await json<{ loop: LoopView; hookSecret?: string }>(await call("setLoop", { name: "deploys", schedule: "never", task: { kind: "heartbeat" }, wakes: [{ kind: "webhook" }], cooldownMs: 60_000 }));
    expect(set.loop).toMatchObject({ schedule: "never", wakes: [{ kind: "webhook" }], cooldownMs: 60_000, hook: "/hooks/deploys", next: null });
    expect(set.hookSecret).toMatch(/^[0-9a-f]{64}$/);
    secret = set.hookSecret!;
    // Sealed in the vault, under the loop's name, never shown again.
    expect(await secretNames()).toContain("loop-hook:deploys");
    const again = await json<{ hookSecret?: string }>(await call("setLoop", { name: "deploys", wakes: [{ kind: "webhook" }] }));
    expect(again.hookSecret).toBeUndefined();
    // "never" is only for a loop that something else wakes.
    expect((await call("setLoop", { name: "idle", schedule: "never", task: { kind: "heartbeat" } })).status).toBe(400);
  });

  test("only a body signed with its secret wakes it, and every refusal reads the same", async () => {
    const body = JSON.stringify({ status: "failed", service: "api" });
    const refusals = [
      await hook("deploys", body),
      await hook("deploys", body, { "x-hub-signature-256": sign(body, "not its secret") }),
      await hook("nobody", body, { "x-hub-signature-256": sign(body, secret) }),
      await hook("..%2Fapi", body, { "x-hub-signature-256": sign(body, secret) }),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "not a signed webhook of a loop here" });
    }
    const signed = await hook("deploys", body, { "x-hub-signature-256": sign(body, secret), "x-github-delivery": "delivery-1" });
    expect(signed.status).toBe(202);
    expect(await signed.json()).toEqual({ ok: true, woken: true });
    const [run] = await runsOf("deploys", 1);
    expect(run!.summary.startsWith("Woken by a webhook.")).toBe(true);
    expect(run!.run).toMatch(/^w/);
    // The same delivery again (a sender's retry): accepted, and it wakes nothing.
    const retried = await hook("deploys", body, { "x-galahad-signature": sign(body, secret), "x-github-delivery": "delivery-1" });
    expect(await retried.json()).toEqual({ ok: true, woken: false });
    // A body past the limit is refused before it's read.
    expect((await hook("deploys", "x".repeat(70 * 1024), { "x-hub-signature-256": sign("x", secret) })).status).toBe(413);
  });

  test("a new secret retires the old one; an agent may do neither", async () => {
    const fresh = await json<{ path: string; secret: string }>(await call("loopHook", { name: "deploys" }));
    expect(fresh.path).toBe("/hooks/deploys");
    expect(fresh.secret).not.toBe(secret);
    const body = '{"n":2}';
    expect((await hook("deploys", body, { "x-hub-signature-256": sign(body, secret) })).status).toBe(401);
    expect((await hook("deploys", body, { "x-hub-signature-256": sign(body, fresh.secret) })).status).toBe(202);
    const agent = (await json<{ token: string }>(await call("mintArm", { label: "busybody" }))).token;
    expect((await call("loopHook", { name: "deploys" }, agent)).status).toBe(403);
    expect((await call("setLoop", { name: "deploys", wakes: [] }, agent)).status).toBe(403);
    expect((await call("loopHook", { name: "nothing" })).status).toBe(404);
  });

  test("a loop that copies bilag to Drive: taken as any loop is; run with no mail to wake it, it says what it copies and how to copy older mail's", async () => {
    const set = await call("setLoop", { name: "books", schedule: "every 1d", task: { kind: "bilag", folder: "Regnskab" } });
    expect(set.status).toBe(200);
    expect((await call("setLoop", { name: "bad", schedule: "every 1d", task: { kind: "bilag", folder: "a/b" } })).status).toBe(400);
    daemon.loops.runNow("books");
    const [run] = await runsOf("books", 1);
    expect(run).toMatchObject({ status: "ok", summary: "Nothing to copy: it copies the bilag in the mail that wakes it (to copy older mail's: galahad bilag copy)." });
    // What has been copied, yours alone to read.
    expect(await json(await call("bilag", undefined))).toEqual({ copied: 0, latest: [] });
    await call("removeLoop", { name: "books" });
  });

  test("a loop that tells you: each run a notice of its own with what woke it, the oldest beyond five gone", async () => {
    const set = await json<{ hookSecret: string }>(await call("setLoop", { name: "doorbell", schedule: "never", task: { kind: "tell", text: "Someone rang" }, wakes: [{ kind: "webhook" }], cooldownMs: 60_000 }));
    const body = JSON.stringify({ ring: 1 });
    expect((await hook("doorbell", body, { "x-hub-signature-256": sign(body, set.hookSecret), "x-galahad-delivery": "ring-1" })).status).toBe(202);
    await runsOf("doorbell", 1);
    type Notice = { key: string; title: string; body: string; source: string };
    const tells = async () => (await json<{ notices: Notice[] }>(await call("notices", undefined))).notices.filter((n) => n.source === "tell:doorbell");
    expect(await tells()).toEqual([expect.objectContaining({ title: "Loop doorbell", body: "Woken by a webhook. Someone rang" })]);
    // Six more runs (by hand: the cooldown holds the next webhook back a minute): a notice each, five kept.
    for (let n = 0; n < 6; n++) {
      daemon.loops.runNow("doorbell");
      await daemon.loops.settled("doorbell");
    }
    const kept = await tells();
    expect(kept).toHaveLength(5);
    expect(kept.every((n) => n.key.startsWith("tell:doorbell:"))).toBe(true);
    expect(new Set(kept.map((n) => n.key)).size).toBe(5);
    expect((await call("removeLoop", { name: "doorbell" })).status).toBe(200);
  });

  test("removed, its webhook and secret go with it, and a loop of its name made later wakes on nothing", async () => {
    expect((await call("removeLoop", { name: "deploys" })).status).toBe(200);
    expect(await secretNames()).not.toContain("loop-hook:deploys");
    await json(await call("setLoop", { name: "deploys", schedule: "every 6h", task: { kind: "heartbeat" } }));
    expect(loopRecords(daemon.store).find((l) => l.name === "deploys")?.wakes).toEqual([]);
    const body = '{"n":3}';
    expect((await hook("deploys", body, { "x-hub-signature-256": sign(body, "anything") })).status).toBe(401);
    // Its wakes cleared: setting none on a loop that never had any adds nothing to the log.
    const events = daemon.store.eventsSince({}, 10_000).events.filter((e) => e.kind === "loop.wakes");
    await json(await call("setLoop", { name: "plain", schedule: "every 1h", task: { kind: "heartbeat" }, wakes: [] }));
    expect(daemon.store.eventsSince({}, 10_000).events.filter((e) => e.kind === "loop.wakes")).toHaveLength(events.length);
  });
});
