import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, routes, type RouteName } from "@invincible/core";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "@invincible/link";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, type DaemonOptions, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort, freeUdpPort } from "./ports.ts";

/*
 * Two nodes of one fleet on this machine, each in a temporary home with a real Q-AMP sidecar on loopback: what the
 * fabric's end-to-end tests stand on. The binary is Q-AMP 0.2's (INVINCIBLE_QAMP_TEST_BIN, or INVINCIBLE_QAMP_BIN).
 */

export const QAMP = process.env.INVINCIBLE_QAMP_TEST_BIN ?? process.env.INVINCIBLE_QAMP_BIN ?? null;
export const HAVE_QAMP = !!QAMP && existsSync(QAMP);

export const fakeCaps = (hostname: string, extra: Partial<Capabilities> = {}): Capabilities => ({
  os: "linux",
  arch: "x64",
  hostname,
  cores: 8,
  cpu: "test",
  memoryGb: 16,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: ["git"],
  localModels: [],
  tailscale: null,
  ...extra,
});

/** A node that hosts agents' VMs, through a stand-in Docker. */
export const sandboxCaps = (hostname: string): Capabilities => fakeCaps(hostname, { docker: true, tools: ["git", "docker"], vm: { kvm: true, tools: ["kata"] }, sandbox: { image: true, networks: true, vm: true } });

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`${what}: not met in ${timeoutMs} ms`);
}

export type Admin = <T = any>(name: RouteName, input?: unknown) => Promise<T>;

export function admin(home: Home, port: number): Admin {
  const token = home.adminToken();
  return async <T = any>(name: RouteName, input?: unknown): Promise<T> => {
    const route = routes[name];
    const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      method: route.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });
    if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
}

/** Q5_DEBUG=1: each node's log, as it runs. */
export const logOf = (name: string) => (message: string) => {
  if (process.env.Q5_DEBUG) console.log(`[${name}] ${message}`);
};

export interface Pair {
  root: string;
  a: Daemon;
  b: Daemon;
  homeA: Home;
  homeB: Home;
  callA: Admin;
  callB: Admin;
  stop(): Promise<void>;
}

/** Node alpha founds a fleet, beta joins it with an invite you approve; each starts with its own sidecar. */
export async function startPair(opts: { a?: Partial<DaemonOptions>; b?: Partial<DaemonOptions> } = {}): Promise<Pair> {
  const root = mkdtempSync(join(tmpdir(), "q5-"));
  const homeA = new Home(join(root, "a"));
  const homeB = new Home(join(root, "b"));
  const portA = freePort();
  const portB = freePort();
  const { identity, keystore } = await homeA.createIdentity("file");
  const store = new LedgerStore(homeA.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "pair", nodeName: "alpha" });
  store.close();
  homeA.writeConfig({ v: 1, name: "alpha", fleet, port: portA, keystore, advertise: "127.0.0.1", fabric: true });
  const a = await startDaemon(homeA, { capabilities: fakeCaps("alpha"), syncIntervalMs: 200, proxyPort: freePort(), log: logOf("alpha"), sidecar: { binary: QAMP, port: await freeUdpPort() }, defaultHeartbeat: false, archiveIntervalMs: false, ...opts.a });
  const callA = admin(homeA, portA);

  const invite = await callA<{ invite: string }>("createInvite", { kind: "node" });
  const joining = await homeB.createIdentity("file");
  const join_ = await requestPairing(invite.invite, { device: joining.identity.id, name: "beta", kind: "node", box: b64u(joining.identity.boxPublic), endpoint: `http://127.0.0.1:${portB}` });
  const { pairings } = await callA("pairings");
  await callA("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });
  const approved = await waitForApproval(join_, { intervalMs: 50 });
  const storeB = new LedgerStore(homeB.ledgerPath);
  storeB.expectFleet(approved.fleet);
  storeB.ingest((await signedPost<SyncPage>(joining.identity, a.endpoint, "/link/sync", { have: {} })).events);
  storeB.close();
  homeB.writeConfig({ v: 1, name: "beta", fleet: approved.fleet, port: portB, keystore: joining.keystore, advertise: "127.0.0.1", fabric: true });
  const b = await startDaemon(homeB, { capabilities: fakeCaps("beta"), syncIntervalMs: 200, proxyPort: freePort(), log: logOf("beta"), sidecar: { binary: QAMP, port: await freeUdpPort() }, defaultHeartbeat: false, archiveIntervalMs: false, ...opts.b });
  const callB = admin(homeB, portB);
  // Each knows the other's transport key from the other's signed profile, and their link is on Q-AMP.
  const peer = (d: Daemon, other: Daemon) => d.sync.status().find((p) => p.device === other.identity.id);
  await until(
    () => {
      if (process.env.Q5_DEBUG) console.log(JSON.stringify({ aToB: peer(a, b)?.path, bToA: peer(b, a)?.path, why: [peer(a, b)?.fallback, peer(b, a)?.fallback] }));
      return peer(a, b)?.path === "qamp" && peer(b, a)?.path === "qamp";
    },
    20_000,
    "both on Q-AMP",
  );
  return {
    root,
    a,
    b,
    homeA,
    homeB,
    callA,
    callB,
    async stop() {
      await b.stop();
      await a.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
