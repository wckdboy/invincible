import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, REFERENCE_SINGLE, routes, type RouteName } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { runOnNode } from "../src/run-cli.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * The reviewer's pictures of the desktop (C1 step 8), end to end over real HTTP on a real node (stand-ins only for
 * Docker and the models): a run of yours (`invincible do`) whose work acted on the desktop hands its reviewer the
 * screen before and after it, as files the node keeps by their SHA-256. This stand-in model can't see: it is told so,
 * each picture by its name.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "run-pictures-test",
  cores: 32,
  cpu: "test",
  memoryGb: 128,
  hasBattery: false,
  gpu: [],
  docker: true,
  vm: { kvm: false, tools: [] },
  tools: ["git", "docker"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true },
};

const root = mkdtempSync(join(tmpdir(), "invincible-run-pictures-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1200, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads }, memoryGbps: 9.5 };
};

/** The screen, as the sandbox's desktop command prints it: one pixel, a PNG's own bytes. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SHA = new Bun.CryptoHasher("sha256").update(Buffer.from(PNG, "base64")).digest("hex");
docker.onExec = (_container, cmd) => (cmd.at(-1)?.includes("desktop screenshot --base64 --keep /work/.evidence/desktop") ? { code: 0, stdout: `data:image/png;base64,${PNG}\n` } : { code: 0, stdout: "" });

/** What each model call was told last, by role. */
const asked: { role: string; prompt: string }[] = [];
const fence = "```";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const first = turns[0]?.content ?? "";
    let role = "planner";
    let text = "1. Press the button.\nDone when: it is pressed.";
    if (first.startsWith("You are reviewing")) {
      role = "reviewer";
      text = "PASS\nIt is pressed.";
    } else if (first.startsWith("Run:")) {
      role = "engineer";
      const said = turns.filter((m) => m.role === "assistant").length;
      text = said === 0 ? `Pressing it.\n${fence}sh\ndesktop click 640 450\n${fence}` : "DONE\nPressed.";
    }
    asked.push({ role, prompt: turns.at(-1)?.content ?? "" });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

async function call<T = any>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
  return (route.method === "POST" && name === "attachmentFile" ? response.arrayBuffer() : response.json()) as Promise<T>;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure, slotWaitMs: 4_000 });
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const role of ["planner", "reviewer", "engineer"]) await call("setRoster", { role, models: ["stand-in/m"] });
});

afterAll(async () => {
  await daemon?.stop();
  models.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a run of yours whose work acted on the desktop shows its reviewer the screen before and after, as a file the node keeps by its SHA-256", async () => {
  const { outcome } = await runOnNode(new LocalClient(`http://127.0.0.1:${port}`, home.adminToken()), { goal: "press the button", network: "isolated", gates: ["true"] });
  expect(outcome.status).toBe("done");
  // Pictured before and after the click, each kept in the sandbox by its hash: the screen didn't change, so one picture.
  const commands = docker.execs.map((e) => e.cmd.at(-1)!);
  const click = commands.findIndex((c) => c.includes("desktop click 640 450"));
  expect(commands.slice(click - 1, click + 2).map((c) => c.includes("desktop screenshot --base64 --keep /work/.evidence/desktop"))).toEqual([true, false, true]);
  const review = asked.find((a) => a.role === "reviewer")!;
  expect(review.prompt).toContain(`(the latest 1: before step 1 and after step 1, ${SHA.slice(0, 16)}…)`);
  expect(review.prompt).toContain(`[A picture is attached here (The desktop before step 1, and after step 1 (SHA-256 ${SHA.slice(0, 16)}…).png, attached by the owner), but this model can't see pictures.]`);
  // The node keeps it by its SHA-256, as it keeps your files: the same bytes.
  expect(Buffer.from(await call<ArrayBuffer>("attachmentFile", { id: SHA })).toString("base64")).toBe(PNG);
}, 30_000);
