import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, REFERENCE_SINGLE, routes, type RouteName } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A command through the node's exec route, as every command an agent runs goes (speed, 28 November 2026): its sandbox is
 * looked up once, by its container's name, on the look the command itself takes, and held to whose it is there. The
 * route's own look before it was a second listing of every sandbox in every command (41–46 ms on Ultra, more with the
 * workspace helper's sizes).
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "exec-route-test",
  cores: 16,
  cpu: "test",
  memoryGb: 64,
  hasBattery: false,
  gpu: [],
  docker: true,
  vm: { kvm: false, tools: [] },
  tools: ["git", "docker"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true },
};

const root = mkdtempSync(join(tmpdir(), "invincible-exec-route-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
/** What the node asked Docker, in order. */
const asked: string[] = [];
let daemon: Daemon;

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads }, memoryGbps: 9.5 };
};

async function call<T = any>(name: RouteName, input?: unknown, token = home.adminToken()): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(`${name} → ${response.status} ${body.error ?? ""}`);
  return body as T;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  const runner = docker.runner;
  daemon = await startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: () => {},
    loopIntervalMs: 60_000,
    archiveIntervalMs: false,
    defaultHeartbeat: false,
    backups: false,
    measure,
    docker: async (args, timeoutMs) => {
      asked.push(args[0]!);
      return runner(args, timeoutMs);
    },
  });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** What the node asks Docker while `f` runs. */
async function asking(f: () => Promise<unknown>): Promise<string[]> {
  const from = asked.length;
  await f();
  return asked.slice(from);
}

describe("a command through the exec route", () => {
  test("looks its sandbox up once (one docker inspect, by its name), and runs", async () => {
    const { token } = await call<{ token: string }>("mintArm", { label: "ada" });
    const { sandbox } = await call<{ sandbox: { id: string } }>("createSandbox", { network: "isolated" }, token);
    const said = await asking(() => call("execSandbox", { id: sandbox.id, cmd: ["true"] }, token));
    expect(said).toEqual(["inspect", "exec"]);
  });

  test("another run's is refused there, and nothing runs in it", async () => {
    const { token } = await call<{ token: string }>("mintArm", { label: "bea" });
    const { sandbox } = await call<{ sandbox: { id: string } }>("createSandbox", { network: "isolated" }, token);
    const { token: nosy } = await call<{ token: string }>("mintArm", { label: "nosy" });
    const execs = docker.execs.length;
    await expect(call("execSandbox", { id: sandbox.id, cmd: ["cat", "/work/secret"] }, nosy)).rejects.toThrow(/403 that sandbox belongs to another run/);
    expect(docker.execs.length).toBe(execs);
    // (Yours, the owner's, as before: whoever's run it is.)
    expect((await call<{ exitCode: number }>("execSandbox", { id: sandbox.id, cmd: ["true"] })).exitCode).toBe(0);
  });

  test("one that isn't there is no sandbox of this node's, for an agent as for you", async () => {
    const { token } = await call<{ token: string }>("mintArm", { label: "cid" });
    await expect(call("execSandbox", { id: "0000000099", cmd: ["true"] }, token)).rejects.toThrow(/404 no such sandbox on this node/);
    await expect(call("execSandbox", { id: "0000000099", cmd: ["true"] })).rejects.toThrow(/404 no such sandbox on this node/);
  });
});
