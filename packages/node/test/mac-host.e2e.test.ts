import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LedgerEntry, routes, type RouteName, type SandboxView } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { CLAUDE_CODE_IMAGE, CONTAINER_CANNOT, CONTAINER_UNMADE, KEEPERS, type MacFirewallState, NETWORKS } from "@galahad/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
// (The sandbox package's stand-in for Apple's container: what a Mac mini will run, answered from memory.)
import { fakeContainer } from "../../sandbox/test/fake-container.ts";
import { freePort } from "./ports.ts";

/*
 * A node on a Mac with Apple's container (its capabilities as the probe finds them there), the real daemon, HTTP
 * routes and host above a stand-in for container: its sandboxes are VMs made through container's command line, and
 * what a Mac can't give is refused with the reason.
 */

const root = mkdtempSync(join(tmpdir(), "galahad-mac-host-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = {
  os: "darwin",
  arch: "arm64",
  hostname: "mini",
  cores: 14,
  cpu: "Apple M5 Pro",
  memoryGb: 48,
  hasBattery: false,
  gpu: [{ name: "Apple Silicon (unified memory)", memoryGb: 48 }],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: ["git"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true, vm: true, engine: "container", cannot: [...CONTAINER_UNMADE], grows: false },
  container: { version: "1.7.1", running: true },
};
const fake = fakeContainer();
/** This Mac's sandbox firewall, as the node is told it is (its stand-in for the helper's status and the bridges). */
let firewall: MacFirewallState = { on: true };
let daemon: Daemon;

async function api<T = any>(name: RouteName, input?: unknown): Promise<T> {
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

/** What the node logged. */
const logged: string[] = [];

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new MindStore(home.mindPath);
  const fleet = foundFleet(mind, identity, { fleetName: "mac-fleet", nodeName: "mini" });
  mind.close();
  home.writeConfig({ v: 1, name: "mini", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: (line) => void logged.push(line), loopIntervalMs: 60_000, docker: fake.runner, measure: false, defaultHeartbeat: false, macFirewall: async () => firewall,
    // (The stand-in's volumes aren't on this machine's disk: their budget is a Mac mini's, its 1 TB nearly free.)
    sandboxDisk: () => ({ totalBytes: 1000 * 2 ** 30, freeBytes: 900 * 2 ** 30 }) });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a node on a Mac with Apple's container", () => {
  test("waits for the gateway's address, which comes with the networks' VMs, and doesn't call that trouble", () => {
    // (No machine running this has 172.31.250.1: here the address never comes, and the wait is all it says in a minute.)
    expect(logged).toContain("sandbox gateway: waiting for its address on this Mac, which comes with the networks' VMs (tried every 5 s)");
    expect(logged.filter((line) => line.includes("gateway listener unavailable"))).toEqual([]);
  });

  test("makes its networks at its start, the gateway's with --internal, and holds both up", () => {
    expect(fake.calls).toContainEqual(["network", "create", "--internal", "--subnet", NETWORKS.gateway.subnet, "--label", "dev.galahad=1", NETWORKS.gateway.name]);
    expect(fake.calls).toContainEqual(["network", "create", "--subnet", NETWORKS.online.subnet, "--label", "dev.galahad=1", NETWORKS.online.name]);
    expect([KEEPERS.gateway, KEEPERS.online].map((k) => fake.vms.get(k)?.state)).toEqual(["running", "running"]);
  });

  test("makes no sandbox while its firewall is off: the API answers 424 with why, and nothing is made", async () => {
    const before = fake.vms.size;
    firewall = { on: false, installed: false, soon: false, why: "this Mac's sandbox firewall isn't installed: run `galahad firewall install` (it asks for your password once)" };
    try {
      await expect(api("createSandbox", { on: "mini", network: "gateway", cpus: 1, memoryGb: 1, quest: "q-no-firewall" })).rejects.toThrow("createSandbox: 424 no sandbox is made on this Mac while its firewall isn't on: this Mac's sandbox firewall isn't installed: run `galahad firewall install`");
      expect(fake.vms.size).toBe(before);
    } finally {
      firewall = { on: true };
    }
  });

  test("makes a sandbox as a VM of its own through container, runs a command in it as uid 1000, and removes it", async () => {
    const { sandbox } = await api<{ sandbox: SandboxView }>("createSandbox", { on: "mini", network: "gateway", cpus: 1, memoryGb: 1, quest: "q-mac-e2e" });
    expect(sandbox).toMatchObject({ isolation: "vm", network: "gateway", status: "running", disk: { limitGb: 20 } });
    const vm = fake.vms.get(sandbox.name)!;
    expect(vm.args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--user", "1000:1000", "--no-dns"]));
    expect(vm.volume).toBe(`${sandbox.name}-work`);
    fake.onExec = () => ({ code: 0, stdout: "made on a Mac\n" });
    const ran = await api<{ exitCode: number; stdout: string }>("execSandbox", { on: "mini", id: sandbox.id, cmd: ["echo", "made on a Mac"] });
    expect(ran).toMatchObject({ exitCode: 0, stdout: "made on a Mac\n" });
    expect(fake.execs.at(-1)).toMatchObject({ user: "1000:1000", cmd: ["echo", "made on a Mac"] });
    const { sandboxes } = await api<{ sandboxes: SandboxView[] }>("sandboxes", { on: "mini" });
    expect(sandboxes.map((s) => s.id)).toContain(sandbox.id);
    await api("destroySandbox", { on: "mini", id: sandbox.id });
    expect(fake.vms.has(sandbox.name)).toBe(false);
    expect(fake.volumes.has(`${sandbox.name}-work`)).toBe(false);
    const { entries } = await api<{ entries: LedgerEntry[] }>("ledger");
    expect(entries.find((e) => e.resource === "docker.container" && e.class === "create" && e.target === sandbox.name)?.detail).toBe("microVM · gateway · 1 cpu · 1 GB · 20 GB disk · galahad/sandbox:1");
  });

  test("placed without being pinned: its sandbox is made on the Mac; one asked to be isolated finds no host here, and says why", async () => {
    const { sandbox } = await api<{ sandbox: SandboxView }>("createSandbox", { network: "online", cpus: 1, memoryGb: 1, quest: "q-placed" });
    expect(sandbox).toMatchObject({ node: daemon.identity.id, network: "online", isolation: "vm" });
    expect(fake.vms.get(sandbox.name)!.networks).toEqual([NETWORKS.online.name, NETWORKS.gateway.name]);
    await api("destroySandbox", { id: sandbox.id });
    await expect(api("createSandbox", { network: "isolated", cpus: 1, memoryGb: 1 })).rejects.toThrow(`createSandbox: 424 no sandbox host in this fleet can make it: mini: ${CONTAINER_CANNOT.isolated}`);
    await expect(api("createSandbox", { network: "online", desktop: true, cpus: 1, memoryGb: 1 })).rejects.toThrow(`createSandbox: 424 no sandbox host in this fleet can make it: mini: ${CONTAINER_CANNOT.desktop}`);
    // Nor an image of his own that a Mac doesn't make: never looked for in a registry.
    await expect(api("createSandbox", { network: "online", image: CLAUDE_CODE_IMAGE, cpus: 1, memoryGb: 1 })).rejects.toThrow(`createSandbox: 424 no sandbox host in this fleet can make it: mini: it doesn't make ${CLAUDE_CODE_IMAGE}`);
  });

  test("a knight's VM is made on the Mac, and grown by pausing: the answer says it paused, and the ledger why", async () => {
    await api("saveTeammate", { id: "ada", name: "ADA", role: "engineer" });
    const { workspace } = await api<{ workspace: SandboxView }>("provisionTeammate", { id: "ada" });
    expect(workspace).toMatchObject({ isolation: "vm", network: "online", ephemeral: false, cpus: 1, memoryGb: 2 });
    expect(fake.volumes.get(`${workspace.name}-work`)!.labels["dev.galahad.retained"]).toBe("1");
    const grown = await api<{ workspace: SandboxView; paused?: boolean }>("resizeTeammate", { id: "ada", memoryGb: 4 });
    expect(grown).toMatchObject({ paused: true, workspace: { id: workspace.id, memoryGb: 4, status: "running" } });
    expect(fake.vms.get(workspace.name)!.volume).toBe(`${workspace.name}-work`);
    const { entries } = await api<{ entries: LedgerEntry[] }>("ledger");
    expect(entries.find((e) => e.class === "modify" && e.target === workspace.name)?.detail).toBe("paused to grow (a Mac's VM can't grow while it runs): 1 cpu · 4 GB · 20 GB disk");
    // Its disk can't grow there: refused, saying why.
    await expect(api("resizeTeammate", { id: "ada", diskGb: 40 })).rejects.toThrow(/409 a VM's disk on a Mac keeps the size it was made with/);
    // Nor is a desktop made there.
    await expect(api("remakeTeammate", { id: "ada", desktop: true })).rejects.toThrow(CONTAINER_CANNOT.desktop);
  });

  test("an isolated sandbox asked of it is refused with the reason, and nothing is made", async () => {
    const before = fake.vms.size;
    await expect(api("createSandbox", { on: "mini", network: "isolated", cpus: 1, memoryGb: 1 })).rejects.toThrow(`createSandbox: 424 ${CONTAINER_CANNOT.isolated}`);
    expect(fake.vms.size).toBe(before);
  });
});
