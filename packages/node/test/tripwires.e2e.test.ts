import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, type LedgerEntry, REFERENCE_SINGLE, routes, type RouteName } from "@galahad/core";
import type { QuestEvent } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { printQuestEvent, runNodeQuest } from "../src/quest-cli.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * Your tripwires on Galahad's own quests, end to end over real HTTP on a real node (stand-ins only for Docker and the
 * models): a quest from a terminal (`galahad do`) and a loop's quest read your rules from the node before each
 * command, a refused command never reaches the sandbox, a halt ends the quest, and each trip is a line in the ledger
 * under the quest and a line of `galahad do`'s output.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "tripwires-test",
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

const root = mkdtempSync(join(tmpdir(), "galahad-tripwires-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1200, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads }, memoryGbps: 9.5 };
};

/** What the engineer sends, a reply at a time; then DONE. What each model call was told last, by role. */
let script: string[] = [];
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
    let text = "1. Write the file.\nDone when: the file is there.";
    if (first.startsWith("You are reviewing")) {
      role = "reviewer";
      text = "PASS\nThe file is there.";
    } else if (first.startsWith("Quest:")) {
      role = "engineer";
      const said = turns.filter((m) => m.role === "assistant").length;
      const next = script[said];
      text = next === undefined ? "DONE\nThe file is there." : `Next.\n${fence}sh\n${next}\n${fence}`;
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
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(`${name} → ${response.status} ${body.error ?? ""}`);
  return body as T;
}

const client = () => new LocalClient(`http://127.0.0.1:${port}`, home.adminToken());
/** What ran in a sandbox, as the shell saw it. */
const ran = () => docker.execs.map((e) => e.cmd.at(-1)!);
const trips = async () => (await call<{ entries: LedgerEntry[] }>("ledger")).entries.filter((e) => e.resource === "rule");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
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

describe("a quest from a terminal", () => {
  test("a refused command never reaches the sandbox; the engineer is told why; the ledger and the terminal say so", async () => {
    await call("setRule", { name: "no-locks", does: "refuse", words: ["*.lock"] });
    script = ["rm -f bun.lock", "echo hi > /work/out/hi.txt"];
    asked.length = 0;
    docker.execs.length = 0;
    const events: QuestEvent[] = [];
    const { outcome, quest } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated" }, { emit: (event) => void events.push(event) });
    expect(outcome.status).toBe("done");
    expect(ran().some((c) => c.includes("bun.lock"))).toBe(false);
    expect(ran()).toContain("echo hi > /work/out/hi.txt");
    expect(asked.filter((a) => a.role === "engineer")[1]!.prompt).toStartWith('Not run: your liege\'s tripwire "no-locks" refuses this command (the word `bun.lock` matches `*.lock`).');
    expect(await trips()).toMatchObject([{ target: "no-locks", verdict: "deny", class: "forbidden", quest, reason: "your tripwire refused the command: the word `bun.lock` matches `*.lock`", detail: "rm -f bun.lock" }]);
    // What `galahad do` prints of it.
    const trip = events.find((e) => e.type === "tripped")!;
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void printed.push(args.join(" "));
    try {
      printQuestEvent(trip);
    } finally {
      console.log = log;
    }
    expect(printed.join("\n")).toContain('Your tripwire "no-locks" refused it: the word `bun.lock` matches `*.lock`');
    expect(printed.join("\n")).toContain("$ rm -f bun.lock");
    await call("removeRule", { name: "no-locks" });
  }, 20_000);

  test("a halt ends the quest there, saying which rule; it is remembered so, and the ledger says it halted the work", async () => {
    await call("setRule", { name: "no-env", does: "halt", words: [".env*"] });
    script = ["cat .env", "echo never"];
    docker.execs.length = 0;
    const { outcome, quest } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated" });
    expect(outcome.status).toBe("stopped");
    expect(outcome.summary).toBe('Halted by your tripwire "no-env": the word `.env` matches `.env*`.\n$ cat .env');
    expect(ran().some((c) => c.includes(".env") || c.includes("never"))).toBe(false);
    expect((await trips())[0]).toMatchObject({ target: "no-env", quest, reason: "your tripwire halted the work: the word `.env` matches `.env*`" });
    const { memories } = await call<{ memories: { text: string }[] }>("recall", { q: "Halted" });
    expect(memories[0]!.text).toContain('Halted by your tripwire "no-env"');
    await call("removeRule", { name: "no-env" });
  }, 20_000);
});

describe("a loop's quest", () => {
  test("is held to them too, and its trip is in the ledger under the loop's own quest", async () => {
    await call("setRule", { name: "no-push", does: "refuse", words: [], contains: "git push" });
    script = ["git push origin main", "echo hi > /work/out/hi.txt"];
    docker.execs.length = 0;
    await call("setLoop", { name: "hi", schedule: "every 30m", task: { kind: "quest", goal: "write hi to a file", network: "isolated" } });
    await call("runLoop", { name: "hi" });
    await daemon.loops.settled("hi");
    expect(daemon.store.loopRuns("hi", 1)[0]!.body.status).toBe("ok");
    expect(ran().some((c) => c.includes("git push"))).toBe(false);
    expect((await trips())[0]).toMatchObject({ target: "no-push", reason: "your tripwire refused the command: it holds `git push`" });
    expect((await trips())[0]!.quest).toStartWith("arm.loop.hi.q-");
    await call("removeLoop", { name: "hi" });
    await call("removeRule", { name: "no-push" });
  }, 20_000);
});
