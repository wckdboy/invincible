import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes, type RouteName, type UsageMeter, type UsageWindow } from "@galahad/core";
import { spentWindowLine } from "../src/trial-commands.ts";
import { windowsOf } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A plan's allowance spent, in the usage meter: once the node is told of a provider's
 * refusal (a 429 with "resets in …"), GET /api/usage/meter carries the window; once its
 * time has passed, it says nothing of it. And the terminal's `galahad usage` line.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "usage-windows-test",
  cores: 2,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: true,
  vm: { kvm: false, tools: [] },
  tools: ["git"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true },
};

const root = mkdtempSync(join(tmpdir(), "galahad-usage-windows-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

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
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: fakeDocker().runner, measure: false, slotWaitMs: 4_000 });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a plan's spent allowance in the usage meter", () => {
  test("the meter carries the window the node was told of, and nothing once its time has passed", async () => {
    const windows = windowsOf(daemon.store);
    const now = Date.parse("2026-11-14T12:29:00Z");
    windows.now = () => now;
    try {
      expect(windows.note("stand-in", "429 allowance exhausted: resets in 2h")).not.toBeNull();

      const meter = await call<UsageMeter>("usageMeter");
      expect(meter.windows).toEqual([{ provider: "stand-in", until: now + 2 * 3_600_000, said: "429 allowance exhausted: resets in 2h" }]);

      // Once its time has passed, the meter says nothing of it.
      windows.now = () => now + 2 * 3_600_000 + 1;
      expect((await call<UsageMeter>("usageMeter")).windows).toBeUndefined();
    } finally {
      windows.now = Date.now;
    }
  });

  test("no window, no windows key: a client from before reads the meter as it did", async () => {
    const meter = await call<UsageMeter>("usageMeter");
    expect("windows" in meter).toBe(false);
  });
});

describe("the terminal's line for a spent allowance", () => {
  test("says the provider, until when in UTC, and how long from now", () => {
    const window: UsageWindow = { provider: "opencode-go", until: Date.parse("2026-11-15T23:25:00Z"), said: "allowance spent; resets in 5h" };
    expect(spentWindowLine(window, Date.parse("2026-11-14T12:29:00Z"))).toBe(
      "opencode-go: its allowance is spent until 23:25 UTC (34h 56m from now), as its provider said",
    );
  });
});
