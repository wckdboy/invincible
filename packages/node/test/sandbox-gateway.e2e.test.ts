import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, KERNEL, REFERENCE_SINGLE } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { CONTAINER_UNMADE, type MacFirewallState } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
// (The sandbox package's stand-in for Apple's container, answered from memory.)
import { fakeContainer } from "../../sandbox/test/fake-container.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * What a node says of its sandbox gateway's listener, honestly (the Mac mini's log, 27 November 2026: "sandbox gateway
 * listener unavailable: Failed to start server. Is port 7402 in use?", where nothing held 7402). Bun says that for any
 * listen that fails, an address this machine doesn't have included. So:
 * - a node that makes sandboxes, whose gateway's address isn't this machine's yet, says it waits for it;
 * - a node that makes none (no image; a Mac without its sandbox firewall) says nothing of a gateway, so no trouble;
 * - an address that is this machine's, its port held by another program, is said so.
 * Its gateway is told to listen at 192.0.2.77 (an address of the documentation's, no machine's) where the address
 * isn't this machine's, and at 127.0.0.1 on a port this test holds where it is.
 */

const root = mkdtempSync(join(tmpdir(), "invincible-sandbox-gateway-"));
const linux: Capabilities = { os: "linux", arch: "x64", hostname: "scratch", cores: 8, cpu: "test", memoryGb: 16, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const mac: Capabilities = {
  os: "darwin", arch: "arm64", hostname: "mini", cores: 14, cpu: "Apple M5 Pro", memoryGb: 48, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: ["git"], localModels: [], tailscale: null,
  sandbox: { image: true, networks: true, vm: true, engine: "container", cannot: [...CONTAINER_UNMADE], grows: false }, container: { version: "1.7.1", running: true },
} as Capabilities;
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL }, memoryGbps: 9.5 };
};
/** A port held by this test: where the gateway's address is this machine's, its bind fails as a port in use does. */
const held = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
const started: Daemon[] = [];
afterAll(async () => {
  for (const daemon of started) await daemon.stop();
  held.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** A node started with its gateway where it is told: what it said of it by the time its start returned. */
async function node(name: string, how: { gateway: { hostname: string; port: number }; image?: boolean; mac?: { firewall: MacFirewallState } }): Promise<string[]> {
  const home = new Home(join(root, name));
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: name, nodeName: name });
  store.close();
  home.writeConfig({ v: 1, name, fleet, port: freePort(), keystore, advertise: "127.0.0.1" });
  const said: string[] = [];
  const docker = how.mac ? fakeContainer().runner : fakeDocker().runner;
  const daemon = await startDaemon(home, {
    capabilities: how.mac ? mac : linux,
    proxyPort: freePort(),
    log: (line: string) => void said.push(line),
    loopIntervalMs: 60_000,
    archiveIntervalMs: false,
    measure,
    // (A node with no sandbox image: Docker knows of none.)
    docker: (args, timeoutMs) => (how.image === false && args[0] === "image" && args[1] === "inspect" ? Promise.resolve({ code: 1, stdout: "", stderr: "Error: No such image" }) : docker(args, timeoutMs)),
    sandboxGateway: how.gateway,
    ...(how.mac ? { macFirewall: async () => how.mac!.firewall } : {}),
  });
  started.push(daemon);
  return said;
}
const gatewaySaid = (said: string[]) => said.filter((line) => line.includes("sandbox gateway"));

test("a node that makes sandboxes, its gateway's address not this machine's yet, says it waits for it: never Bun's \"in use\"", async () => {
  const said = await node("waits", { gateway: { hostname: "192.0.2.77", port: freePort() } });
  expect(gatewaySaid(said)).toEqual(["sandbox gateway: waiting for its address, which comes with the sandbox networks (tried every 5 s)"]);
});

test("a node that makes no sandboxes (no image) says nothing of a gateway, so its log has no trouble of one", async () => {
  const said = await node("no-image", { gateway: { hostname: "192.0.2.77", port: freePort() }, image: false });
  expect(gatewaySaid(said)).toEqual([]);
});

test("a Mac whose sandbox firewall isn't on makes no sandboxes, and says nothing of a gateway", async () => {
  const said = await node("mac-no-firewall", { gateway: { hostname: "192.0.2.77", port: freePort() }, mac: { firewall: { on: false, installed: false, soon: false, why: "its helper isn't installed" } } });
  expect(gatewaySaid(said)).toEqual([]);
});

test("its address this machine's, its port held by another program: said so, not guessed", async () => {
  const said = await node("held", { gateway: { hostname: "127.0.0.1", port: held.port! } });
  expect(gatewaySaid(said)).toEqual([`sandbox gateway listener unavailable: 127.0.0.1:${held.port} is held by another program (tried every 5 s)`]);
});
