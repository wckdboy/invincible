import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, routes, type RouteName } from "@galahad/core";
import { requestPairing, signedFetch, signedPost, type SyncPage, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * The fleet's local models (local-models.ts), over real HTTP: two nodes of one fleet, the second ("mini") with a model in
 * its Ollama that the first ("ultra") doesn't have. A model call on ultra for it is answered by the mini's runtime,
 * through the mini, its answer streamed back; a node's local runtime is asked by full nodes alone. A stand-in plays the
 * mini's Ollama, on its loopback (its fetch).
 */

const caps = (hostname: string, localModels: Capabilities["localModels"] = []): Capabilities => ({
  os: "linux", arch: "x64", hostname, cores: 8, cpu: "test", memoryGb: 16, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: ["git"], localModels, tailscale: null,
});

const root = mkdtempSync(join(tmpdir(), "galahad-local-models-"));
const homeA = new Home(join(root, "ultra"));
const homeB = new Home(join(root, "mini"));
const portA = freePort();
const portB = freePort();
let ultra: Daemon;
let mini: Daemon;
/** What the mini's Ollama was asked, as it was asked. */
const asked: { url: string; body: Record<string, unknown> }[] = [];

function admin(home: Home, port: number) {
  return (name: RouteName, input?: unknown) =>
    fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: routes[name].method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined });
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition not met in time");
}

beforeAll(async () => {
  const { identity, keystore } = await homeA.createIdentity("file");
  const store = new MindStore(homeA.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  homeA.writeConfig({ v: 1, name: "ultra", fleet, port: portA, keystore, advertise: "127.0.0.1" });
  ultra = await startDaemon(homeA, { capabilities: caps("ultra"), syncIntervalMs: 100, proxyPort: freePort(), log: () => {} });
  // Ollama, as you add it: one provider for the fleet, each node's own runtime on its loopback.
  expect((await admin(homeA, portA)("setProvider", { id: "ollama", preset: "ollama" })).status).toBe(200);

  // The mini joins, and serves mimo in its Ollama.
  const { invite } = (await (await admin(homeA, portA)("createInvite", { kind: "node" })).json()) as { invite: string };
  const joined = await homeB.createIdentity("file");
  const join = await requestPairing(invite, { device: joined.identity.id, name: "mini", kind: "node", box: b64u(joined.identity.boxPublic), endpoint: `http://127.0.0.1:${portB}` });
  const { pairings } = (await (await admin(homeA, portA)("pairings")).json()) as { pairings: { invite: string; device: string }[] };
  await admin(homeA, portA)("approvePairing", { invite: pairings[0]!.invite, device: pairings[0]!.device });
  const { fleet: joinedFleet } = await waitForApproval(join, { intervalMs: 20 });
  const storeB = new MindStore(homeB.mindPath);
  storeB.expectFleet(joinedFleet);
  storeB.ingest((await signedPost<SyncPage>(joined.identity, ultra.endpoint, "/link/sync", { have: {} })).events);
  storeB.close();
  homeB.writeConfig({ v: 1, name: "mini", fleet: joinedFleet, port: portB, keystore: joined.keystore, advertise: "127.0.0.1" });
  mini = await startDaemon(homeB, {
    capabilities: caps("mini", [{ runtime: "ollama", models: ["mimo-v2.6:9b", "qwen3-embedding:0.6b"] }]),
    syncIntervalMs: 100,
    proxyPort: freePort(),
    log: () => {},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("http://127.0.0.1:11434/")) return fetch(input, init);
      asked.push({ url, body: JSON.parse(String(init?.body)) });
      const chunks = ["Answered ", "on the mini."].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  // Ultra knows what the mini serves once the mini's profile has reached it.
  await until(() => JSON.stringify(ultra.store.activeDevice(mini.identity.id)?.profile?.caps ?? {}).includes("mimo-v2.6:9b"));
});

afterAll(async () => {
  await mini?.stop();
  await ultra?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a model call on ultra for a model only the mini's Ollama serves is answered there, its answer streamed back", async () => {
  const reply = await admin(homeA, portA)("chat", { model: "ollama/mimo-v2.6:9b", tools: false, messages: [{ role: "user", content: "Where are you?" }] });
  expect(reply.status).toBe(200);
  const events = (await reply.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { type: string; text?: string; ref?: string });
  expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Answered on the mini.");
  expect(events.at(-1)).toEqual({ type: "done", ref: "ollama/mimo-v2.6:9b" });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ url: "http://127.0.0.1:11434/v1/chat/completions", body: { model: "mimo-v2.6:9b", stream: true } });
  expect(JSON.stringify(asked[0]!.body.messages)).toContain("Where are you?");
});

test("what you may set a knight to work on: the roster's models, then each local one a node serves and where; never an embedder or a wildcard", async () => {
  expect((await admin(homeA, portA)("setRoster", { role: "swift", models: ["ollama/*", "deepseek/deepseek-flash"] })).status).toBe(200);
  // (What can't do a knight's work isn't offered: the archive's embedder, the decider's decision model.)
  expect((await admin(homeA, portA)("setRoster", { role: "embedder", models: ["ollama/qwen3-embedding:0.6b"] })).status).toBe(200);
  expect((await admin(homeA, portA)("setRoster", { role: "decider", models: ["cloudflare-ai/typesafe/jev"] })).status).toBe(200);
  const { models } = (await (await admin(homeA, portA)("teamModels")).json()) as { models: { ref: string; on: string[] }[] };
  expect(models).toContainEqual({ ref: "deepseek/deepseek-flash", on: [] });
  expect(models).toContainEqual({ ref: "ollama/mimo-v2.6:9b", on: ["mini"] });
  expect(models.some((m) => m.ref.includes("*") || m.ref.includes("embedding") || m.ref.includes("jev"))).toBe(false);
});

test("a node's local runtime is asked by full nodes alone, and only for a model it serves", async () => {
  // You (an owner's device) never call it: it is the fleet's way, not a way to a node's runtime from outside it.
  expect((await admin(homeB, portB)("localModelCall", { provider: "ollama", request: { model: "mimo-v2.6:9b", messages: [] } })).status).toBe(403);
  // A full node asking for a model the mini doesn't serve, or of a runtime that isn't local there, is told so.
  const asNode = (input: unknown) => signedFetch(ultra.identity, `http://127.0.0.1:${portB}`, routes.localModelCall.path, input);
  expect((await asNode({ provider: "ollama", request: { model: "gemma4:26b", messages: [] } })).status).toBe(404);
  expect((await asNode({ provider: "deepseek", request: { model: "deepseek-v4-pro", messages: [] } })).status).toBe(404);
  expect(asked).toHaveLength(1);
});
