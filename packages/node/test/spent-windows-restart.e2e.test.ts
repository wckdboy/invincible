import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes, type RouteName, type UsageMeter } from "@galahad/core";
import { windowsOf } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A plan's spent allowance is kept through a restart: on 21 November 2026 a deploy restarted Ultra's node, which forgot
 * that OpenCode Go was spent until the next day, and the usage meter stopped saying so until a call was refused again.
 * Now the node keeps each window in its own database: started again, it still passes the plan over and says until when.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "spent-windows-test",
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

const root = mkdtempSync(join(tmpdir(), "galahad-spent-windows-"));
const home = new Home(join(root, "node"));
const port = freePort();
const start = (): Promise<Daemon> =>
  startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: fakeDocker().runner, measure: false, slotWaitMs: 4_000 });

async function meter(): Promise<UsageMeter> {
  const route = routes.usageMeter as { method: string; path: string };
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}` } });
  if (!response.ok) throw new Error(`${"usageMeter" satisfies RouteName} → ${response.status}`);
  return (await response.json()) as UsageMeter;
}

let daemon: Daemon | undefined;
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a spent plan is still passed over, and still said in the meter, after the node starts again", async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });

  daemon = await start();
  const told = windowsOf(daemon.store).note("opencode-go", "opencode-go → 429 Go usage limit reached (5-hour, resets in 34h 56m). Upgrade or wait.");
  expect(told).not.toBeNull();
  expect((await meter()).windows?.map((w) => w.provider)).toEqual(["opencode-go"]);
  await daemon.stop();

  // Started again: a new process would have a new record in memory; what the node kept gives it back.
  daemon = await start();
  expect(windowsOf(daemon.store).spent("opencode-go")).toMatchObject({ provider: "opencode-go", until: told!.until });
  expect((await meter()).windows).toEqual([{ provider: "opencode-go", until: told!.until, said: told!.said }]);
});
