import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelCheck, routes, type RouteName } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Checking a model through a real node over real HTTP, with a stand-in for the model: what it was seen to do is
 * recorded in the mind for every node, shown with the roster, and the route is yours alone.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "checks-test", cores: 8, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
const root = mkdtempSync(join(tmpdir(), "galahad-checks-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
const card = JSON.parse(readFileSync(new URL("../../brain/assets/check-card/card.json", import.meta.url), "utf8")) as { heading: string; targets: Record<string, { centre: [number, number] }> };
const answer = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
  const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
  const said = JSON.stringify(body.messages);
  if (said.includes('"image_url"')) return answer(said.includes("largest heading") ? card.heading : JSON.stringify(Object.fromEntries(Object.entries(card.targets).map(([id, t]) => [id, t.centre]))));
  return answer(body.messages.filter((m) => m.role === "assistant").length < 1 ? "Look.\n```sh\nls\n```" : "DONE\nIt is there.");
} });

async function call<T = any>(name: RouteName, input?: unknown, token = home.adminToken()): Promise<{ status: number; body: T }> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, measure: false });
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
});
afterAll(async () => { await daemon?.stop(); model.stop(true); rmSync(root, { recursive: true, force: true }); });

test("a model checked through the node: what it did is recorded for every node and shown with the roster; only you may have one checked", async () => {
  const { status, body } = await call<{ model: string; check: ModelCheck }>("checkModel", { model: "stand-in/m" });
  expect(status).toBe(200);
  expect(body.check).toMatchObject({ format: { replies: 4, good: 4 }, reads: { ok: true }, places: { targets: 8, landed: 8, meanErrorPx: 0 } });
  // In the mind, as an event every node replays to the same record.
  expect(daemon.store.lww("modelcheck:stand-in/m")?.value).toMatchObject({ format: { replies: 4, good: 4 }, places: { landed: 8 } });
  const { body: listed } = await call<{ checks: Record<string, ModelCheck> }>("roster");
  expect(Object.keys(listed.checks)).toEqual(["stand-in/m"]);
  // A part at a time, when asked.
  expect((await call<{ check: ModelCheck }>("checkModel", { model: "stand-in/m", parts: ["reads"] })).body.check).toMatchObject({ reads: { ok: true } });
  // An agent may not spend your models' allowance on checking them.
  const { body: minted } = await call<{ token: string }>("mintArm", { label: "prober", scopes: ["chat", "mind:read", "mind:write"] });
  expect((await call("checkModel", { model: "stand-in/m" }, minted.token)).status).toBe(403);
});
