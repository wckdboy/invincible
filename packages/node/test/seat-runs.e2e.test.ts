import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOW } from "@invincible/agents";
import { bodyFingerprint, ceilingThreads, KERNEL, type LedgerEntry, REFERENCE_SINGLE, type RouteName, routes, type TeamSnapshot } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { seatVolumeName, type SandboxStream, type SpawnStream, volumeName } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { recordSeatStatus, yourWord } from "../src/seats.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A coding agent's task on a seat of yours, through a real node (I15 step 9): real HTTP, controller, host and run code,
 * with stand-ins only for Docker, the one long-lived follow, and the models. The node chooses the seat; its VM is made
 * from the pinned tools' image with the seat's home and the agent's own /work; the tool runs and is followed there; the
 * gates run in the agent's own VM; the seat's VM is gone once the run ends; and what the tool said of its plan's window
 * is the seat's, in the log.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "seat-runs-test", cores: 16, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const root = mkdtempSync(join(tmpdir(), "invincible-seat-runs-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
const runs: string[][] = [];
const removed: string[] = [];
let daemon: Daemon;
const SEAT = `st_${"w".repeat(22)}`;
/** When the plan's five hours reset, as its tool says it (an hour on the minute, three hours from now). */
const RESET = Math.ceil((Date.now() + 3 * 3_600_000) / 60_000) * 60_000;

/** The seat's VM's container, once one is made: the latest run that had the seat's label. */
const seatContainer = (): string | undefined => {
  const made = runs.filter((args) => args.includes(`dev.invincible.seat=${SEAT}`)).at(-1);
  return made ? made[made.indexOf("--name") + 1] : undefined;
};
/** While set, a follow in the seat's VM says its run is alive and holds there until it is let go. */
let hold: Promise<void> | null = null;
/** What a follow in the seat's VM says: the tool's session, a window of its plan, its answer, and its end. */
const opened: string[][] = [];
const spawnStream: SpawnStream = (argv): SandboxStream => {
  opened.push(argv);
  const held = hold;
  const said = argv.includes(seatContainer() ?? "\0")
    ? [
        'S{"alive": true, "exit": null, "next": 0}',
        'E10 {"type":"session","id":"00000000-0000-4000-8000-000000000009"}',
        `E20 ${JSON.stringify({ type: "window", name: "five_hour", status: "allowed", usedPercent: 37, resetsAt: RESET })}`,
        'E30 {"type":"text","text":"Built and checked."}',
        'S{"alive": false, "exit": 0, "next": 30}',
      ]
    : ['S{"alive": false, "exit": 1, "next": 0}'];
  async function* lines(): AsyncIterable<string> {
    if (held && said.length > 1) {
      yield said[0]!;
      await held;
      yield* said.slice(1);
      return;
    }
    yield* said;
  }
  return { lines: lines(), write: () => {}, close: () => {}, kill: () => {}, exited: Promise.resolve(0) };
};
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = (await request.json()) as { model: string };
    const text = body.model === "reviewer" ? "PASS\nThe required gate passed and the tool's own account of its work agrees." : "1. Make the change.\n2. Run the required gate.\nDone when: the gate and independent review pass.";
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

async function api<T = any>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await response.json()) as { error?: string };
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}
/** A route's answer as it comes, refusal and all. */
async function raw(name: RouteName, input: unknown): Promise<Response> {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: JSON.stringify(input) });
}
async function until(condition: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  const state = await api<TeamSnapshot>("team");
  throw new Error(`not reached: ${JSON.stringify(state.tasks.map(({ title, status, error }) => ({ title, status, error })))}`);
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "seats", nodeName: "ultra" });
  mind.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  docker.onExec = (container, command) => {
    const text = command.join("\n");
    // Claude Code is signed in in the seat's home, and in no agent's own VM: a run here is on the seat, or nowhere.
    if (text.includes("--status")) return { code: 0, stdout: JSON.stringify({ type: "status", installed: true, signedIn: container === seatContainer(), ...(container === seatContainer() ? { method: "claude.ai" } : {}) }) };
    return { code: 0, stdout: text.includes("gate-seat") ? "required gate passed" : "command completed" };
  };
  daemon = await startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: () => {},
    docker: (args, timeout) => {
      if (args[0] === "run") runs.push(args);
      if (args[0] === "rm") removed.push(args.at(-1)!);
      return docker.runner(args, timeout);
    },
    spawnStream,
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 100,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
  });
  await until(() => daemon.store.lww(`calibration:${daemon.identity.id}`) !== null);
  await api("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer"]) await api("setRoster", { role, models: [`stand-in/${role}`] });
  await api("saveAgent", { id: "ada", name: "Ada", role: "engineer", harness: "claude" });
  await api("saveTeamRoom", { id: "seat-forge", name: "Seat Forge", members: ["ada"] });
  // A Claude plan of yours, signed in in its home on this node.
  daemon.store.emit(daemon.identity, "seat.added", { id: SEAT, kind: "claude-subscription", label: "Work Max", node: daemon.identity.id, runs: 1 }, yourWord(null));
  recordSeatStatus(daemon.store, daemon.identity, daemon.store.seats().find((seat) => seat.id === SEAT)!, { signedIn: true, method: "claude.ai", plan: "max", fingerprint: "F".repeat(22) });
});
afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a Claude Code task runs on your seat: its VM has the seat's home and the agent's /work, the tool runs and is followed there, the gates in the agent's VM; the seat's VM goes as it ends, and its window is the seat's", async () => {
  const { task } = await api<{ task: { id: string } }>("createTeamTask", { room: "seat-forge", assignee: "ada", title: "On a seat", goal: "Build and verify this bounded change.", gates: ["test -f result.txt # gate-seat"] });
  await until(async () => (await api<TeamSnapshot>("team")).tasks.find((t) => t.id === task.id)?.status === "done");
  const agentVm = (await api<TeamSnapshot>("team")).agents.find((a) => a.id === "ada")!.workspace!.id;
  const seatVm = seatContainer()!;
  expect(seatVm).toBeDefined();
  const made = runs.find((args) => args.includes(`dev.invincible.seat=${SEAT}`))!;
  // From the pinned tools' image, with the seat's home where its tool is told it is, and the agent's own /work.
  expect(made).toContain(`type=volume,src=${seatVolumeName(SEAT)},dst=/seats/${SEAT}`);
  expect(made).toContain(`type=volume,src=${volumeName(agentVm)},dst=/work`);
  expect(made).toContain(`CLAUDE_CONFIG_DIR=/seats/${SEAT}/claude`);
  expect(made).toContain(`dev.invincible.shares=${agentVm}`);
  // Its tool was asked, launched and followed in the seat's VM; the gates ran in the agent's own.
  const ran = (container: string) => docker.execs.filter((e) => e.container === container).map((e) => e.cmd.join(" "));
  expect(ran(seatVm).some((c) => c.includes("--status"))).toBe(true);
  expect(ran(seatVm).some((c) => c.includes("setsid") && c.includes("claude-code.py") && c.includes("--own"))).toBe(true);
  expect(ran(`invincible-sbx-${agentVm}`).some((c) => c.includes("setsid"))).toBe(false);
  expect(ran(`invincible-sbx-${agentVm}`).some((c) => c.includes("gate-seat"))).toBe(true);
  expect(ran(seatVm).some((c) => c.includes("gate-seat"))).toBe(false);
  expect(opened.some((argv) => argv.includes(seatVm) && argv.includes(FOLLOW))).toBe(true);
  // Let go as its run ended: its VM removed, the seat free.
  expect(removed).toContain(seatVm);
  // What the tool said of its plan's window is the seat's, in the log, said by this node.
  const windows = daemon.store.eventsSince({}, 100_000).events.filter((e) => e.kind === "seat.window");
  expect(windows.map((e) => e.body)).toEqual([{ id: SEAT, window: "five_hour", status: "allowed", usedPercent: 37, resetsAt: RESET }]);
  expect(daemon.store.seats().find((s) => s.id === SEAT)!.windows).toEqual([{ window: "five_hour", status: "allowed", usedPercent: 37, resetsAt: RESET, at: expect.any(Number) }]);
  // The ledger says the seat's VM was made, from whose /work, with which seat's home.
  const ledger = (await api<{ entries: LedgerEntry[] }>("ledger", {})).entries;
  const created = ledger.find((entry) => entry.class === "create" && entry.target === seatVm);
  expect(created?.detail).toContain(`the /work of invincible-sbx-${agentVm}`);
  expect(created?.detail).toContain(`seat ${SEAT}'s home`);
}, 30_000);

test("no route reaches into a seat's VM, yours included: not a command, a follow, a terminal or an artifact; it goes as its run ends", async () => {
  let release!: () => void;
  hold = new Promise<void>((resolve) => (release = resolve));
  const before = seatContainer();
  const { task } = await api<{ task: { id: string } }>("createTeamTask", { room: "seat-forge", assignee: "ada", title: "Held on a seat", goal: "Build and verify this bounded change.", gates: ["test -f result.txt # gate-seat"] });
  await until(() => seatContainer() !== before && opened.some((argv) => argv.includes(seatContainer()!)));
  const id = seatContainer()!.slice("invincible-sbx-".length);
  const refused = { error: "that is a seat's VM, the node's own: no route reaches into it" };
  for (const [route, input] of [
    ["execSandbox", { id, cmd: ["cat", `/seats/${SEAT}/claude/.credentials.json`] }],
    ["followSandbox", { id, offset: 0 }],
    ["openTerminal", { sandbox: id, size: { cols: 80, rows: 24 } }],
    ["saveArtifact", { sandbox: id, path: "/work" }],
  ] as const) {
    const answer = await raw(route, input);
    expect([route, answer.status, await answer.json()]).toEqual([route, 403, refused]);
  }
  // (Nothing ran in it for those: only the run's own commands.)
  expect(docker.execs.filter((e) => e.container === seatContainer() && e.cmd.join(" ").includes(".credentials.json"))).toEqual([]);
  hold = null;
  release();
  await until(async () => (await api<TeamSnapshot>("team")).tasks.find((t) => t.id === task.id)?.status === "done");
  expect(removed).toContain(seatContainer()!);
}, 30_000);
