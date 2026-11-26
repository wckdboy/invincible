import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { didKeyOfEd25519, signingPublicKey } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { type Daemon, type DaemonOptions, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import type { QampProcess, QampRunner } from "../src/qamp-grants.ts";
import { admin, fakeCaps } from "./fabric-pair.ts";
import { freePort, freeUdpPort } from "./ports.ts";

/*
 * The node and its sidecar, as the daemon decides (no real sidecar: fabric.e2e.test.ts has those). The fabric runs only
 * when the node's own setting says so (`invincible fabric on`; off by default): a binary that has a sidecar switches
 * nothing on by being there, and the grants' bridges, which run the same binary, work either way. INVINCIBLE_QAMP=off
 * is the way back to HTTPS alone, whatever the setting says.
 */

let daemon: Daemon | null = null;
let root: string | null = null;
let home: Home | null = null;
let port = 0;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  delete process.env.INVINCIBLE_QAMP;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  home = null;
});

const OFF = "the fabric is off on this node (invincible fabric on switches it on)";

async function node(env: Record<string, string>, fabric?: boolean, extra: Partial<DaemonOptions> = {}): Promise<Daemon> {
  root = mkdtempSync(join(tmpdir(), "q5d-"));
  home = new Home(join(root, "n"));
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "one", nodeName: "solo" });
  store.close();
  port = freePort();
  home.writeConfig({ v: 1, name: "solo", fleet, port, keystore, advertise: "127.0.0.1", ...(fabric === undefined ? {} : { fabric }) });
  // A binary that has a sidecar, as far as asking it goes (it answers everything with exit 0), and is never started.
  const binary = join(root, "qamp");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  Object.assign(process.env, env);
  return startDaemon(home, { capabilities: fakeCaps("solo"), proxyPort: freePort(), log: () => {}, sidecar: { binary, port: await freeUdpPort(), spawn: () => ({ ready: Promise.resolve(null), exited: new Promise(() => {}), kill() {} }) }, defaultHeartbeat: false, archiveIntervalMs: false, ...extra });
}

/** Q-AMP's binary as the grants run it (qamp-routes.test.ts has the whole of it): a key, a chain, a bridge that listens. */
/** Public keys from obviously fake seeds (5 and 6 repeated), made here rather than written out. */
const BRIDGE = didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(5)));
const AGENT = didKeyOfEd25519(signingPublicKey(new Uint8Array(32).fill(6)));
const grantsQamp: QampRunner = {
  async run(args) {
    if (args[0] === "keygen") writeFileSync(args[2]!, "qamp-sk1.FAKE-KEY-FOR-TESTS\n", { mode: 0o600 });
    return { code: 0, stdout: args[0] === "keygen" || args[0] === "id" ? `${BRIDGE}\n` : "qdt1.FAKE-CHAIN-FOR-TESTS\n", stderr: "" };
  },
  serve(args): QampProcess {
    let end: (how: string) => void = () => {};
    const exited = new Promise<string>((resolve) => (end = resolve));
    return { ready: Promise.resolve(`qamp://${BRIDGE}@${args[args.indexOf("--listen") + 1]}`), exited, kill: (signal) => end(signal) };
  },
};

const ownCaps = (d: Daemon) => d.store.device(d.identity.id)?.profile?.caps ?? {};

describe("the node's sidecar, by its own setting", () => {
  test("a binary that has a sidecar switches nothing on: no sidecar, no transport key, no endpoint in its profile", async () => {
    daemon = await node({});
    expect(daemon.fabric.sidecar.state).toBe("off");
    expect(daemon.fabric.sidecar.why).toBe(OFF);
    expect(existsSync(join(home!.dir, "qamp", "node.qamp-key"))).toBe(false);
    expect(ownCaps(daemon).qamp).toBeUndefined();
    expect((await daemon.doctor({ quick: true })).diagnoses.find((d) => d.id === "node.qamp")).toMatchObject({ state: "ok", line: "the fabric is off on this node, so every link to another node goes over HTTPS with signed requests (invincible fabric on switches it on)" });
  });

  test("on: the node starts the sidecar it was given (here, one that ends at once: down, and why)", async () => {
    daemon = await node({}, true);
    expect(daemon.fabric.sidecar.state).toBe("down");
    expect(daemon.fabric.sidecar.why).toBe("it stopped before it listened");
  });

  test("switched on and off while it runs, through its route: the setting is kept in its config, and off stops the sidecar", async () => {
    daemon = await node({});
    const call = admin(home!, port);
    expect(await call("fabricSetting", {})).toMatchObject({ on: false, state: "off", why: OFF });
    expect(await call("fabricSetting", { on: true })).toMatchObject({ on: true, state: "down", why: "it stopped before it listened" });
    expect(home!.readConfig().fabric).toBe(true);
    expect(await call("fabricSetting", { on: false })).toMatchObject({ on: false, state: "off", why: OFF });
    expect(home!.readConfig().fabric).toBe(false);
    // Off stays off: nothing tries it again by itself.
    await Bun.sleep(1_200);
    expect(daemon.fabric.sidecar.state).toBe("off");
  });

  test("INVINCIBLE_QAMP=off: no sidecar at all, whatever the setting says, and it says so", async () => {
    daemon = await node({ INVINCIBLE_QAMP: "off" }, true);
    expect(daemon.fabric.sidecar.state).toBe("off");
    expect(daemon.fabric.sidecar.why).toBe("this node runs no sidecar");
    expect((await daemon.doctor({ quick: true })).diagnoses.find((d) => d.id === "node.qamp")).toMatchObject({ state: "ok", line: "this node runs no sidecar, so every link to another node goes over HTTPS with signed requests" });
  });

  test("the grants' bridges run the same binary with the fabric off: a grant is made, and its bridge is up", async () => {
    const bridgePort = freePort();
    daemon = await node({}, undefined, { qamp: grantsQamp, qampPorts: { first: bridgePort, last: bridgePort + 1 }, qampSweepMs: 0 });
    const call = admin(home!, port);
    const made = await call<{ grant: { bridge: { state: string } } }>("qampGrant", { agent: AGENT, tools: ["fleet"], ttlSeconds: 600 });
    expect(made.grant.bridge.state).toBe("up");
    expect(daemon.fabric.sidecar.state).toBe("off");
  });
});
