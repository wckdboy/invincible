import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refusedKeysOf } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A provider that refused its key is kept through a restart, as a spent allowance is (spent-windows-restart): the node
 * keeps it in its own database, and started again it still says it, until a call to that provider gets through. On 22
 * November 2026 the owner's MiMo key was refused at a knight's task's start, and nothing said so anywhere they look.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "refused-keys-test",
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

const root = mkdtempSync(join(tmpdir(), "galahad-refused-keys-"));
const home = new Home(join(root, "node"));
const port = freePort();
const start = (): Promise<Daemon> =>
  startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: fakeDocker().runner, measure: false });

let daemon: Daemon | undefined;
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a refused key is still said after the node starts again, and forgotten there too once a call got through", async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });

  daemon = await start();
  const told = refusedKeysOf(daemon.store).note("mimo-token", 'mimo-token → 401 {"error":{"message":"Invalid API Key"}}');
  expect(told).toMatchObject({ provider: "mimo-token", said: "401: Invalid API Key" });
  await daemon.stop();

  // Started again: a new process has a new record in memory; what the node kept gives it back.
  daemon = await start();
  expect(refusedKeysOf(daemon.store).list()).toEqual([told!]);
  // A call that got through forgets it, there and in what the node keeps.
  refusedKeysOf(daemon.store).forget("mimo-token");
  await daemon.stop();
  daemon = await start();
  expect(refusedKeysOf(daemon.store).list()).toEqual([]);
});
