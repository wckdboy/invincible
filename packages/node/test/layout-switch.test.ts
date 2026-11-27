import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bodyFingerprint, ceilingThreads, KERNEL, type NoticeView, REFERENCE_SINGLE, routes, type RouteName, type SandboxLayoutView, teamArmLabel, type TeamSnapshot, type TeamTask } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * Layout 2 (the sandbox's layout.ts), the node's own switch (the fourth fabric review, 27 November 2026): off by default,
 * as the fabric is, so that a node that never turns it on keeps every agent's VM as it was made, in layout 1, and no store
 * is moved. On, at once: the next VM made is in layout 2, and one in layout 1 is moved at its next prepare. Off again, no
 * VM is moved from then on. Real HTTP, controller and host, on an engine that would mount its volumes' subpaths (27).
 */

const root = mkdtempSync(join(tmpdir(), "invincible-layout-switch-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "layout-switch-test", cores: 16, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const docker = fakeDocker({ engine: "27.3.1" });
/** Every `docker run` of a VM (not a one-off), in order. */
const runs: string[][] = [];
let daemon: Daemon;

/** The stand-in models: a plan, the engineer's DONE, the reviewer's PASS. */
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = (await request.json()) as { model: string };
    const text = body.model === "engineer" ? "DONE\nNothing needed changing." : body.model === "reviewer" ? "PASS\nThe gate passed." : "1. Look.\nDone when: the gate passes.";
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

async function api<T = unknown>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = (await response.json()) as { error?: string };
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}

/** A task for an agent, run to its end: its VM made or prepared first. */
async function taskFor(agent: string, tag: string): Promise<void> {
  const { task } = await api<{ task: TeamTask }>("createTeamTask", { room: "layouts", assignee: agent, title: tag, goal: `TASK_${tag}: look at the workspace.`, gates: ["true # gate"] });
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const now = (await api<TeamSnapshot>("team")).tasks.find((t) => t.id === task.id);
    if (now && !["queued", "running"].includes(now.status)) return;
    await Bun.sleep(10);
  }
  throw new Error(`${tag} did not end`);
}

/** Whether a `docker run` made an agent's own VM, and the latest that did. */
const isFor = (agent: string, args: string[]) => args.includes(`dev.invincible.run=arm.${teamArmLabel(daemon.identity.id, agent)}`);
const madeFor = (agent: string) => runs.filter((args) => isFor(agent, args)).at(-1) ?? null;
const inLayout2 = (args: string[]) => args.includes("dev.invincible.layout=2");
const workMount = (args: string[]) => args[args.findIndex((a, i) => args[i - 1] === "--mount" && a.includes("dst=/work"))] ?? null;

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "layouts", nodeName: "keep" });
  mind.close();
  // (Its config says nothing of layout 2: as on every node until its owner turns it on.)
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: () => {},
    docker: (args, timeout) => {
      if (args[0] === "run" && !args.includes("--rm")) runs.push(args);
      return docker.runner(args, timeout);
    },
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 100,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
  });
  await api("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer"]) await api("setRoster", { role, models: [`stand-in/${role}`] });
  for (const id of ["ada", "lin"]) await api("saveAgent", { id, name: id.toUpperCase(), role: "engineer" });
  await api("saveTeamRoom", { id: "layouts", name: "Layouts", members: ["ada", "lin"] });
}, 30_000);
afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("layout 2, the node's own switch", () => {
  test("off by default: an agent's VM is made in layout 1, its store its /work, and stays there at its next prepare", async () => {
    await taskFor("ada", "FIRST");
    const ada = madeFor("ada")!;
    expect(ada).not.toBeNull();
    expect(inLayout2(ada)).toBe(false);
    expect(workMount(ada)).not.toContain("volume-subpath");
    await taskFor("ada", "SECOND");
    // (Prepared again, as it was: made once, never moved.)
    expect(runs.filter((args) => args.includes(workMount(ada)!))).toHaveLength(1);
    expect(await api<SandboxLayoutView>("sandboxLayout", {})).toEqual({ on: false, idle: null });
    expect(home.readConfig().layout2).toBeUndefined();
  }, 40_000);

  test("on, at once: kept in its config, and the agent's VM is moved at its next prepare; you're told once", async () => {
    expect(await api<SandboxLayoutView>("sandboxLayout", { on: true })).toEqual({ on: true, idle: null });
    expect(JSON.parse(readFileSync(home.configPath, "utf8")).layout2).toBe(true);
    const before = runs.length;
    await taskFor("ada", "THIRD");
    const moved = runs.slice(before).at(-1)!;
    expect(inLayout2(moved)).toBe(true);
    expect(workMount(moved)).toContain("volume-subpath=work");
    const { notices } = await api<{ notices: NoticeView[] }>("notices");
    expect(notices.filter((n) => n.key === "layout:ada")).toHaveLength(1);
  }, 40_000);

  test("off again: no VM is moved from then on, a new one is made in layout 1, and one moved stays as it is", async () => {
    expect(await api<SandboxLayoutView>("sandboxLayout", { on: false })).toEqual({ on: false, idle: null });
    expect(JSON.parse(readFileSync(home.configPath, "utf8")).layout2).toBe(false);
    const before = runs.length;
    await taskFor("lin", "FOURTH");
    await taskFor("ada", "FIFTH");
    const made = runs.slice(before);
    // Lin's VM, made now, in layout 1; Ada's, prepared, not made again.
    expect(made).toHaveLength(1);
    expect(isFor("lin", made[0]!)).toBe(true);
    expect(inLayout2(made[0]!)).toBe(false);
  }, 40_000);
});

describe("invincible sandbox layout, with no node running", () => {
  const offline = new Home(join(root, "offline"));
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "sandbox", "layout", ...args, "--home", offline.dir], { stdout: "pipe", stderr: "pipe", env: { ...process.env, INVINCIBLE_KEYSTORE: "file" } });
    const out = await new Response(proc.stdout).text();
    return { out, code: await proc.exited };
  };

  test("keeps the choice in the node's config for its next start, and says so; status says what it is", async () => {
    offline.writeConfig({ v: 1, name: "mini", fleet: null, port: 1, keystore: "file", advertise: null });
    expect((await cli("status")).out).toContain("layout 2: off · the node isn't running");
    const on = await cli("on");
    expect(on.code).toBe(0);
    expect(on.out).toContain("it applies this when it next starts");
    expect(JSON.parse(readFileSync(offline.configPath, "utf8")).layout2).toBe(true);
    expect((await cli("status")).out).toContain("layout 2: on · the node isn't running");
    expect((await cli("off")).code).toBe(0);
    expect(JSON.parse(readFileSync(offline.configPath, "utf8")).layout2).toBe(false);
    expect((await cli("sideways")).code).not.toBe(0);
  }, 30_000);
});
