import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, KERNEL, REFERENCE_SINGLE, type RouteName, routes, type SandboxView } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A node whose sandboxes have no networks of their own (sandboxNetworks: false): a scratch node beside a live one on the
 * same host, as the desktop bench's glass harness runs one on a shared machine. The sandbox networks, their image keepers
 * and the sandbox gateway's address are the live node's there: this node makes none of them and listens on no gateway.
 * It still hosts sandboxes, made isolated.
 */

const root = mkdtempSync(join(tmpdir(), "invincible-scratch-node-"));
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "scratch", cores: 8, cpu: "test", memoryGb: 16, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL }, memoryGbps: 9.5 };
};
/**
 * Where each node is told to bind its sandbox gateway: a port this test holds, so the bind fails on any machine, as it
 * does where the gateway's address isn't the machine's (a node's own machine has 172.31.248.1, so that can't be counted on).
 */
const held = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
const started: Daemon[] = [];
afterAll(async () => {
  for (const daemon of started) await daemon.stop();
  held.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** A node on a stand-in Docker: what it asked Docker, what it said, and a way to call it. */
async function node(name: string, networks: boolean) {
  const home = new Home(join(root, name));
  const port = freePort();
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: name, nodeName: name });
  store.close();
  home.writeConfig({ v: 1, name, fleet, port, keystore, advertise: "127.0.0.1" });
  const docker = fakeDocker();
  const asked: string[][] = [];
  const said: string[] = [];
  const daemon = await startDaemon(home, {
    capabilities: caps,
    log: (line: string) => void said.push(line),
    loopIntervalMs: 60_000,
    archiveIntervalMs: false,
    measure,
    docker: (args, timeoutMs) => {
      asked.push(args);
      return docker.runner(args, timeoutMs);
    },
    sandboxGateway: { hostname: "127.0.0.1", port: held.port! },
    ...(networks ? {} : { sandboxNetworks: false }),
  });
  started.push(daemon);
  const api = async <T,>(route: RouteName, input: unknown): Promise<T> => {
    const r = routes[route];
    const response = await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, ...(r.method === "POST" ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  for (let i = 0; i < 500 && daemon.store.lww(`calibration:${daemon.identity.id}`) === null; i++) await Bun.sleep(10);
  return { asked, said, api };
}

test("a node whose sandboxes have no networks makes no network, keeps no image and listens on no gateway, and still hosts an isolated sandbox", async () => {
  // As a node is (the control): its networks are asked for, its images kept, and its gateway bound (here it can't be: its
  // port is the test's own).
  const usual = await node("usual", true);
  expect(usual.asked.some((args) => args[0] === "network")).toBe(true);
  expect(usual.said.some((line) => line.startsWith("sandbox gateway listener unavailable"))).toBe(true);

  const scratch = await node("scratch", false);
  expect(scratch.asked.filter((args) => args[0] === "network" || args[0] === "create")).toEqual([]);
  expect(scratch.said.filter((line) => line.includes("sandbox gateway") || line.includes("sandbox networks"))).toEqual([]);
  const made = await scratch.api<{ sandbox: SandboxView }>("createSandbox", { network: "isolated", run: "scratch-run" });
  expect(made.sandbox).toMatchObject({ network: "isolated", status: "running" });
  expect(scratch.asked.filter((args) => args[0] === "network")).toEqual([]);
});

test("on a node whose sandboxes have no networks, one asked online is made isolated, and so is an agent's VM: none joins the networks the live node has there", async () => {
  // (Asked online or with the gateway, a sandbox here joined invincible-net and invincible-gw, the live node's networks on
  // a shared host, and an agent's VM above all: online is its default. Two nodes, each with room for one VM.)
  const joined = (asked: string[][]) => asked.filter((args) => args[0] === "run").map((args) => args.flatMap((arg, i) => (args[i - 1] === "--network" ? [arg] : [])));
  const scratch = await node("scratch-isolated", false);
  const made = await scratch.api<{ sandbox: SandboxView }>("createSandbox", { network: "online", run: "scratch-online" });
  expect(made.sandbox).toMatchObject({ network: "isolated", isolation: "vm", status: "running" });
  expect(joined(scratch.asked)).toEqual([["none"]]);
  const agents = await node("scratch-agent", false);
  await agents.api("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  const agent = await agents.api<{ workspace: SandboxView }>("provisionAgent", { id: "ada", desktop: false });
  expect(agent.workspace).toMatchObject({ network: "isolated", isolation: "vm" });
  expect(joined(agents.asked)).toEqual([["none"]]);
}, 60_000);
