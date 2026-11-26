import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeCaps } from "./fabric-pair.ts";
import { freePort, freeUdpPort } from "./ports.ts";

/*
 * The node and its sidecar, as the daemon decides (no real sidecar: fabric.e2e.test.ts has those). INVINCIBLE_QAMP=off
 * is the way back to HTTPS alone: the node runs no sidecar, whatever binary it has.
 */

let daemon: Daemon | null = null;
let root: string | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  delete process.env.INVINCIBLE_QAMP;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

async function node(env: Record<string, string>): Promise<Daemon> {
  root = mkdtempSync(join(tmpdir(), "q5d-"));
  const home = new Home(join(root, "n"));
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "one", nodeName: "solo" });
  store.close();
  const port = freePort();
  home.writeConfig({ v: 1, name: "solo", fleet, port, keystore, advertise: "127.0.0.1" });
  // A binary that has a sidecar, as far as asking it goes (it answers everything with exit 0), and is never started.
  const binary = join(root, "qamp");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  Object.assign(process.env, env);
  return startDaemon(home, { capabilities: fakeCaps("solo"), proxyPort: freePort(), log: () => {}, sidecar: { binary, port: await freeUdpPort(), spawn: () => ({ ready: Promise.resolve(null), exited: new Promise(() => {}), kill() {} }) }, defaultHeartbeat: false, archiveIntervalMs: false });
}

describe("the node's sidecar, by its environment", () => {
  test("INVINCIBLE_QAMP=off: no sidecar at all, and it says so", async () => {
    daemon = await node({ INVINCIBLE_QAMP: "off" });
    expect(daemon.fabric.sidecar.state).toBe("off");
    expect(daemon.fabric.sidecar.why).toBe("this node runs no sidecar");
    expect((await daemon.doctor({ quick: true })).diagnoses.find((d) => d.id === "node.qamp")).toMatchObject({ state: "ok", line: "this node runs no sidecar, so every link to another node goes over HTTPS with signed requests" });
  });

  test("without it, the node starts the sidecar it was given (here, one that ends at once: down, and why)", async () => {
    daemon = await node({});
    expect(daemon.fabric.sidecar.state).toBe("down");
    expect(daemon.fabric.sidecar.why).toBe("it stopped before it listened");
  });
});
