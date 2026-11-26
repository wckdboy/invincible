import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes, type RouteName } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { runNodeQuest } from "../src/quest-cli.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * What a quest's model is sent, turn after turn, over real HTTP on a real node (stand-ins only for Docker and
 * the model): a provider bills a prompt's beginning at its cached price only while that beginning stays the same,
 * and input tokens are the bill. So everything before a quest's conversation (who he is, what he recalls for
 * this quest) is said once and stays as it was; only the conversation grows.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "prefix-test", cores: 8, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };

const root = mkdtempSync(join(tmpdir(), "galahad-prefix-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
// What each command prints is about something else entirely: it is data for the engineer, not a question to his memory.
docker.onExec = () => ({ code: 0, stdout: "zebra crossing ahead, mind the stripes\n" });
let daemon: Daemon;

const fence = "```";
/** Every request the stand-in model was sent, whole. */
const asked: { role: string; content: string }[][] = [];
const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
  const body = await request.json() as { messages: { role: string; content: string }[] };
  asked.push(body.messages);
  const turns = body.messages.filter((m) => m.role !== "system");
  const first = turns[0]?.content ?? "";
  const replies = turns.filter((m) => m.role === "assistant").length;
  let text = "1. Look around.\n2. Make the file.\nDone when: the file is there.";
  if (first.startsWith("You are reviewing")) text = "PASS\nIt is there.";
  else if (first.startsWith("Quest:")) text = replies < 4 ? `Step ${replies + 1}.\n${fence}sh\nls /work # ${replies + 1}\n${fence}` : "DONE\nThe file is there.";
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });

async function api<T>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = await response.json() as { error?: string };
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure: false });
  await api("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer"]) await api("setRoster", { role, models: ["stand-in/m"] });
  // One memory that bears on the quest, and one that bears on what a command happens to print.
  await api("remember", { text: "The harbour ledger is kept in /work/out/ledger.csv, one row a ship." });
  await api("remember", { text: "A zebra's stripes are unlike any other zebra's: a fact about stripes and nothing else." });
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a quest's engineer is sent the same beginning on every turn: what he recalls is chosen once for the quest, not again for each command's output", async () => {
  const { outcome } = await runNodeQuest(new LocalClient(`http://127.0.0.1:${port}`, home.adminToken()), { goal: "Add this week's ships to the harbour ledger.", network: "isolated", remember: false });
  expect(outcome.status).toBe("done");
  const engineer = asked.filter((messages) => messages.find((m) => m.role !== "system")?.content.startsWith("Quest:"));
  // Four commands, then DONE: five calls, each with all that came before.
  expect(engineer).toHaveLength(5);
  const systems = engineer.map((messages) => messages[0]!);
  expect(systems.every((m) => m.role === "system")).toBe(true);
  // What he recalls for this quest is there from the first turn…
  expect(systems[0]!.content).toContain("harbour ledger is kept in");
  // …and the prompt before the conversation is the same text on every turn, so its beginning can be read from a cache.
  expect(new Set(systems.map((m) => m.content)).size).toBe(1);
  // (Recalling for each command's output put the memory about zebras first from the second turn on, under a new
  // fence each time: five prompts for five turns.)
  // And each turn's conversation begins with the turn before's, whole.
  for (let i = 1; i < engineer.length; i++) expect(JSON.stringify(engineer[i]!.slice(0, engineer[i - 1]!.length))).toBe(JSON.stringify(engineer[i - 1]));
});
