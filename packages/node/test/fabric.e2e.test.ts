import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, FABRIC, type FleetView, qampEndpointOf, routes, type RouteName } from "@invincible/core";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "@invincible/link";
import { foundFleet, LedgerStore, revokeDevice } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Sidecar } from "../src/fabric/sidecar.ts";
import { SidecarError } from "../src/fabric/socket.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort, freeUdpPort } from "./ports.ts";

/*
 * The fabric, end to end on one machine (docs/ARCHITECTURE.md §3): two nodes in temporary homes, each with a real Q-AMP
 * sidecar on loopback. Their sync, their pushes and the work one forwards to the other's sandbox go over Q-AMP, one
 * connection between their transport keys; a key no node of the fleet names is refused at the door; while a sidecar is
 * down the link goes over HTTPS with signed requests, and says so; a node revoked is refused from its very next call.
 *
 * It needs Q-AMP's binary (0.2's sidecar): INVINCIBLE_QAMP_TEST_BIN, or INVINCIBLE_QAMP_BIN. Without one it is skipped,
 * and says so.
 */

const QAMP = process.env.INVINCIBLE_QAMP_TEST_BIN ?? process.env.INVINCIBLE_QAMP_BIN ?? null;
const HAVE_QAMP = !!QAMP && existsSync(QAMP);
// Real processes and real waits (a sidecar started again after a second, a peer tried again after five): a minute each.
setDefaultTimeout(60_000);

/** Q5_DEBUG=1: each node's log, as it runs. */
const log = (name: string) => (message: string) => {
  if (process.env.Q5_DEBUG) console.log(`[${name}] ${message}`);
};

const fakeCaps = (hostname: string, extra: Partial<Capabilities> = {}): Capabilities => ({
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

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error(`${what}: not met in ${timeoutMs} ms`);
}

function admin(home: Home, port: number) {
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

describe.skipIf(!HAVE_QAMP)(`the fabric between two nodes on one machine${HAVE_QAMP ? "" : " (skipped: no Q-AMP binary; set INVINCIBLE_QAMP_TEST_BIN)"}`, () => {
  const root = mkdtempSync(join(tmpdir(), "q5-"));
  const homeA = new Home(join(root, "a"));
  const homeB = new Home(join(root, "b"));
  const portA = freePort();
  const portB = freePort();
  let qampA = 0;
  let qampB = 0;
  let a: Daemon;
  let b: Daemon;
  const docker = fakeDocker();
  let stranger: Sidecar | null = null;

  beforeAll(async () => {
    qampA = await freeUdpPort();
    qampB = await freeUdpPort();
    const { identity, keystore } = await homeA.createIdentity("file");
    const store = new LedgerStore(homeA.ledgerPath);
    const fleet = foundFleet(store, identity, { fleetName: "pair", nodeName: "alpha" });
    store.close();
    homeA.writeConfig({ v: 1, name: "alpha", fleet, port: portA, keystore, advertise: "127.0.0.1" });
    a = await startDaemon(homeA, { capabilities: fakeCaps("alpha"), syncIntervalMs: 200, proxyPort: freePort(), log: log("alpha"), sidecar: { binary: QAMP, port: qampA } });

    const invite = await admin(homeA, portA)<{ invite: string }>("createInvite", { kind: "node" });
    const joining = await homeB.createIdentity("file");
    const join = await requestPairing(invite.invite, { device: joining.identity.id, name: "beta", kind: "node", box: b64u(joining.identity.boxPublic), endpoint: `http://127.0.0.1:${portB}` });
    const { pairings } = await admin(homeA, portA)("pairings");
    await admin(homeA, portA)("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });
    const approved = await waitForApproval(join, { intervalMs: 50 });
    const storeB = new LedgerStore(homeB.ledgerPath);
    storeB.expectFleet(approved.fleet);
    storeB.ingest((await signedPost<SyncPage>(joining.identity, a.endpoint, "/link/sync", { have: {} })).events);
    storeB.close();
    homeB.writeConfig({ v: 1, name: "beta", fleet: approved.fleet, port: portB, keystore: joining.keystore, advertise: "127.0.0.1" });
    b = await startDaemon(homeB, {
      capabilities: fakeCaps("beta", { docker: true, tools: ["git", "docker"], sandbox: { image: true, networks: true } }),
      syncIntervalMs: 200,
      proxyPort: freePort(),
      log: log("beta"),
      docker: docker.runner,
      sidecar: { binary: QAMP, port: qampB },
    });
  });

  afterAll(async () => {
    await stranger?.stop();
    await b?.stop();
    await a?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const peerOf = (d: Daemon, other: Daemon) => d.sync.status().find((p) => p.device === other.identity.id);

  test("each node's sidecar is up under a transport key of its own, and its profile names that key", async () => {
    expect([a.fabric.sidecar.state, b.fabric.sidecar.state]).toEqual(["up", "up"]);
    // Never the device key: a key of the sidecar's own, its address on loopback and its own port.
    expect(a.fabric.sidecar.did).toMatch(/^did:key:z6Mk/);
    expect(a.fabric.sidecar.did).not.toBe(b.fabric.sidecar.did);
    expect(a.fabric.sidecar.address).toBe(`qamp://${a.fabric.sidecar.did}@127.0.0.1:${qampA}`);
    await until(() => qampEndpointOf(a.store.device(b.identity.id)?.profile?.caps)?.did === b.fabric.sidecar.did, 15_000, "B's endpoint on A");
    await until(() => qampEndpointOf(b.store.device(a.identity.id)?.profile?.caps)?.did === a.fabric.sidecar.did, 15_000, "A's endpoint on B");
  });

  test("their sync goes over Q-AMP, and a memory written on either reaches the other", async () => {
    await until(() => peerOf(a, b)?.path === "qamp" && peerOf(b, a)?.path === "qamp", 15_000, "both on Q-AMP");
    expect(peerOf(a, b)).toMatchObject({ online: true, path: "qamp", fallback: null });
    await admin(homeA, portA)("remember", { text: "the fabric carries this memory" });
    await until(async () => (await admin(homeB, portB)("recall", { q: "fabric" })).memories.length === 1, 10_000, "the memory on B");
    // The fleet's view says the path too (peers, the status line).
    const fleet = await admin(homeA, portA)<FleetView>("fleet");
    expect(fleet.peers.find((p) => p.device === b.identity.id)?.path).toBe("qamp");
  });

  test("work forwarded to the other node's sandbox goes over Q-AMP, and its answer comes back as this node's", async () => {
    const made = await admin(homeA, portA)<{ id: string; node?: string }>("createSandbox", { on: "beta", image: "invincible/sandbox:1" }).catch((e) => e as Error);
    // Whatever the route answers (a sandbox, or why not), it came back over the link to B, and the path is Q-AMP.
    const listed = await admin(homeA, portA)<{ node: string; sandboxes: unknown[] }>("sandboxes", { on: "beta" });
    expect(listed.node).toBe("beta");
    expect(a.fabric.pathOf(b.identity.id)).toMatchObject({ path: "qamp", why: null });
    if (!(made instanceof Error)) expect(listed.sandboxes.length).toBeGreaterThan(0);
  });

  test("a key no node of the fleet names is refused at the door, before anything is read", async () => {
    const strangerHome = join(root, "s");
    stranger = new Sidecar({ home: strangerHome, binary: () => QAMP, listen: () => null, name: "stranger", log: () => {} });
    await stranger.start();
    expect(stranger.state).toBe("up");
    const call = stranger.client!.call(a.fabric.sidecar.address!, FABRIC.sync, { have: {} });
    const error = await call.result.catch((e) => e as SidecarError);
    expect(error).toBeInstanceOf(SidecarError);
    expect((error as SidecarError).code).toBe(3);
    expect((error as SidecarError).message).toMatch(/active nodes of its fleet alone/);
  });

  test("while a node's sidecar is down the link goes over HTTPS and says why; once it is back, over Q-AMP again", async () => {
    const pid = b.fabric.sidecar.pid!;
    expect(pid).toBeGreaterThan(1);
    process.kill(pid, "SIGKILL");
    await until(() => peerOf(a, b)?.path === "https", 15_000, "A on HTTPS to B");
    expect(peerOf(a, b)?.online).toBe(true);
    expect(peerOf(a, b)?.fallback).toMatch(/Q-AMP to beta failed/);
    // B started its sidecar again by itself, and A goes back to Q-AMP once its wait is over.
    await until(() => b.fabric.sidecar.state === "up" && b.fabric.sidecar.pid !== pid, 15_000, "B's sidecar again");
    await until(() => peerOf(a, b)?.path === "qamp", 30_000, "A on Q-AMP to B again");
  });

  test("a node revoked is refused from its very next call over Q-AMP", async () => {
    // B calls A directly through its sidecar, as its sync does: taken now.
    const address = a.fabric.sidecar.address!;
    const before = await b.fabric.sidecar.client!.call(address, FABRIC.sync, { have: {} }).result;
    expect(before).toMatchObject({ more: expect.any(Boolean) });
    const revokedAt = performance.now();
    revokeDevice(a.store, a.identity, b.identity.id, "test: revoked");
    const after = await b.fabric.sidecar.client!.call(address, FABRIC.sync, { have: {} }).result.catch((e) => e as SidecarError);
    const ms = performance.now() - revokedAt;
    expect(after).toBeInstanceOf(SidecarError);
    expect((after as SidecarError).code).toBe(3);
    // One round trip: the refusal is the answer to the first call after the revocation.
    expect(ms).toBeLessThan(1_000);
  });
});
