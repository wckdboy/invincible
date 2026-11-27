import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDED_LISTS_COMMAND } from "@invincible/agents";
import { bodyFingerprint, ceilingThreads, KERNEL, REFERENCE_SINGLE, type RouteName, routes } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { containerName } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * What tasks other nodes handed over left running in an agent's VM is ended as the node comes back (fabric/handoff.ts
 * attachTeam, server.ts sweepHanded; the third re-review's R3-5), through a real node with a stand-in for Docker alone:
 * its first start makes an agent's VM, and its next start sweeps that VM. The sweep went out before the server's routes
 * existed, so it never reached a VM: each agent's said "Cannot access 'handlers' before initialization" (found on
 * Ultra's node, 27 November 2026), and fabric-hand-restart.test.ts, which attaches the hand-offs with a sweep of its own,
 * couldn't see it.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "handed-sweep-test", cores: 16, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const root = mkdtempSync(join(tmpdir(), "invincible-handed-sweep-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
/** What the node said, from its every start. */
const said: string[] = [];
let daemon: Daemon | null = null;

const start = () =>
  startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: (message) => void said.push(message),
    docker: docker.runner,
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 100,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
  });

async function api<T = unknown>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await response.json()) as { error?: string };
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}
async function until(condition: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return false;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "sweep", nodeName: "box" });
  mind.close();
  home.writeConfig({ v: 1, name: "box", fleet, port, keystore, advertise: "127.0.0.1" });
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("as the node comes back, each agent's VM is asked what handed tasks left running there: the sweep reaches it", async () => {
  daemon = await start();
  expect(await until(() => daemon!.store.lww(`calibration:${daemon!.identity.id}`) !== null)).toBe(true);
  await api("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  const { workspace } = await api<{ workspace: { id: string } }>("provisionAgent", { id: "ada" });
  await daemon.stop();
  daemon = null;
  docker.execs.length = 0;
  said.length = 0;

  // The node comes back: its sweep asks Ada's VM for the lists of what handed tasks left running there.
  daemon = await start();
  const asked = () => docker.execs.some((e) => e.container === containerName(workspace.id) && e.cmd.join(" ").includes(HANDED_LISTS_COMMAND));
  const reached = await until(asked);
  expect(said.filter((line) => line.includes("before initialization"))).toEqual([]);
  expect(said.filter((line) => line.includes("couldn't be asked what handed tasks left running"))).toEqual([]);
  expect(reached).toBe(true);
}, 60_000);
