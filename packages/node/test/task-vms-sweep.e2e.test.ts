import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, KERNEL, REFERENCE_SINGLE } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { CONTAINER_UNMADE, type DockerRunner, LABEL, type MacFirewallState } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
// (The sandbox package's stand-in for Apple's container, answered from memory.)
import { fakeContainer } from "../../sandbox/test/fake-container.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * What a node says as it starts of other nodes' tasks' VMs an earlier process of it left (task-vms.ts sweep): the Mac
 * mini's doctor, 28 November 2026, read "fabric: other nodes' tasks' VMs an earlier process left couldn't be listed:
 * docker couldn't say which VMs are other nodes' tasks'" as trouble, and the mini makes no sandboxes (no image, no
 * firewall), so it has no task's VM to list. As the gateway's listener does (sandbox-gateway.e2e.test.ts):
 * - a node that makes none (no image; a Mac without its sandbox firewall) asks its engine for no such list, and says
 *   nothing of one;
 * - nor does a Mac that makes sandboxes: it makes no other node's task's VM (createTaskVm takes them on Linux alone),
 *   and its engine, Apple's container, has no `ps` to ask;
 * - one that does, whose engine can't list them, says so, as before.
 * Every engine here fails that listing. The node that makes sandboxes starts last, and says so only once its engine has
 * been asked whether it makes them and then for the list: by then each before it, asked only the first, has answered.
 */

const root = mkdtempSync(join(tmpdir(), "invincible-task-vms-sweep-"));
const linux: Capabilities = { os: "linux", arch: "x64", hostname: "scratch", cores: 8, cpu: "test", memoryGb: 16, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const mac: Capabilities = {
  os: "darwin", arch: "arm64", hostname: "mini", cores: 14, cpu: "Apple M5 Pro", memoryGb: 48, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: ["git"], localModels: [], tailscale: null,
  sandbox: { image: true, networks: true, vm: true, engine: "container", cannot: [...CONTAINER_UNMADE], grows: false }, container: { version: "1.7.1", running: true },
} as Capabilities;
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL }, memoryGbps: 9.5 };
};
const started: Daemon[] = [];
afterAll(async () => {
  for (const daemon of started) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Its engine's listing of other nodes' tasks' VMs, as SandboxHost.taskVms asks for it. */
const listing = (args: string[]) => args[0] === "ps" && args.includes(`label=${LABEL}.task`);

/** A node started on a stand-in engine that can't list tasks' VMs: what it says, and how often it asked for that list. */
async function node(name: string, how: { image?: boolean; mac?: { firewall: MacFirewallState } }) {
  const home = new Home(join(root, name));
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: name, nodeName: name });
  store.close();
  home.writeConfig({ v: 1, name, fleet, port: freePort(), keystore, advertise: "127.0.0.1" });
  const said: string[] = [];
  let listed = 0;
  const engine: DockerRunner = how.mac ? fakeContainer().runner : fakeDocker().runner;
  const docker: DockerRunner = (args, timeoutMs) => {
    if (listing(args)) {
      listed++;
      return Promise.resolve({ code: 1, stdout: "", stderr: "Cannot connect to the engine" });
    }
    // (A node with no sandbox image: its engine knows of none.)
    if (how.image === false && args[0] === "image" && args[1] === "inspect") return Promise.resolve({ code: 1, stdout: "", stderr: "Error: No such image" });
    return engine(args, timeoutMs);
  };
  const daemon = await startDaemon(home, {
    capabilities: how.mac ? mac : linux,
    proxyPort: freePort(),
    log: (line: string) => void said.push(line),
    loopIntervalMs: 60_000,
    archiveIntervalMs: false,
    defaultHeartbeat: false,
    shutdownGraceMs: 100,
    measure,
    docker,
    // (No gateway: what it says is the gateway's own test's.)
    sandboxGateway: { hostname: "192.0.2.77", port: freePort() },
    ...(how.mac ? { macFirewall: async () => how.mac!.firewall } : {}),
  });
  started.push(daemon);
  return { said, listed: () => listed };
}
const tasksVmsSaid = (said: string[]) => said.filter((line) => line.includes("other nodes' tasks' VMs"));
async function until(condition: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return condition();
}

test("a node that makes no sandboxes asks for no list of other nodes' tasks' VMs and says nothing of one; one that does, and can't list them, says so", async () => {
  const noImage = await node("no-image", { image: false });
  const macNoFirewall = await node("mac-no-firewall", { mac: { firewall: { on: false, installed: false, soon: false, why: "its helper isn't installed" } } });
  const macMakes = await node("mac-makes", { mac: { firewall: { on: true } } });
  const makes = await node("makes", {});
  expect(await until(() => tasksVmsSaid(makes.said).length > 0)).toBe(true);
  expect([tasksVmsSaid(makes.said), makes.listed()]).toEqual([["fabric: other nodes' tasks' VMs an earlier process left couldn't be listed: docker couldn't say which VMs are other nodes' tasks'"], 1]);
  const quiet = { said: [], listed: 0 };
  const of = (n: { said: string[]; listed(): number }) => ({ said: tasksVmsSaid(n.said), listed: n.listed() });
  expect({ noImage: of(noImage), macNoFirewall: of(macNoFirewall), macMakes: of(macMakes) }).toEqual({ noImage: quiet, macNoFirewall: quiet, macMakes: quiet });
});
