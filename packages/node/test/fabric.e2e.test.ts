import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { FABRIC, type FleetView, qampEndpointOf } from "@invincible/core";
import { revokeDevice } from "@invincible/ledger";
import type { Daemon } from "../src/daemon.ts";
import { Sidecar } from "../src/fabric/sidecar.ts";
import { SidecarError } from "../src/fabric/socket.ts";
import { fakeDocker } from "./fake-docker.ts";
import { fakeCaps, HAVE_QAMP, type Pair, QAMP, startPair, until } from "./fabric-pair.ts";

/*
 * The fabric, end to end on one machine (docs/ARCHITECTURE.md §3): two nodes in temporary homes, each with a real Q-AMP
 * sidecar on loopback (fabric-pair.ts). Their sync, their pushes and the work one forwards to the other's sandbox go over
 * Q-AMP, one connection between their transport keys; a key no node of the fleet names is refused at the door; while a
 * sidecar is down the link goes over HTTPS with signed requests, and says so; a node revoked is refused from its very
 * next call.
 *
 * It needs Q-AMP's binary (0.2's sidecar): INVINCIBLE_QAMP_TEST_BIN, or INVINCIBLE_QAMP_BIN. Without one it is skipped,
 * and says so.
 */

// Real processes and real waits (a sidecar started again after a second, a peer tried again after five): a minute each.
setDefaultTimeout(60_000);

// Said, not passed over in silence: without a binary these are unverified.
if (!HAVE_QAMP) console.log(`${import.meta.file} SKIPPED, unverified: no Q-AMP binary. Run it with INVINCIBLE_QAMP_TEST_BIN=<qamp 0.2's sidecar for this machine>.`);

describe.skipIf(!HAVE_QAMP)(`the fabric between two nodes on one machine${HAVE_QAMP ? "" : " (skipped: no Q-AMP binary; set INVINCIBLE_QAMP_TEST_BIN)"}`, () => {
  const docker = fakeDocker();
  let pair: Pair;
  let a: Daemon;
  let b: Daemon;
  let stranger: Sidecar | null = null;

  beforeAll(async () => {
    pair = await startPair({ b: { capabilities: fakeCaps("beta", { docker: true, tools: ["git", "docker"], sandbox: { image: true, networks: true } }), docker: docker.runner } });
    ({ a, b } = pair);
  });

  afterAll(async () => {
    await stranger?.stop();
    await pair?.stop();
  });

  const peerOf = (d: Daemon, other: Daemon) => d.sync.status().find((p) => p.device === other.identity.id);

  test("each node's sidecar is up under a transport key of its own, and its profile names that key", async () => {
    expect([a.fabric.sidecar.state, b.fabric.sidecar.state]).toEqual(["up", "up"]);
    // Never the device key: a key of the sidecar's own, its address on loopback and its own port.
    expect(a.fabric.sidecar.did).toMatch(/^did:key:z6Mk/);
    expect(a.fabric.sidecar.did).not.toBe(b.fabric.sidecar.did);
    expect(a.fabric.sidecar.address).toMatch(new RegExp(`^qamp://${a.fabric.sidecar.did}@127\\.0\\.0\\.1:\\d+$`));
    await until(() => qampEndpointOf(a.store.device(b.identity.id)?.profile?.caps)?.did === b.fabric.sidecar.did, 15_000, "B's endpoint on A");
    await until(() => qampEndpointOf(b.store.device(a.identity.id)?.profile?.caps)?.did === a.fabric.sidecar.did, 15_000, "A's endpoint on B");
  });

  test("their sync goes over Q-AMP, and a memory written on either reaches the other", async () => {
    await until(() => peerOf(a, b)?.path === "qamp" && peerOf(b, a)?.path === "qamp", 15_000, "both on Q-AMP");
    expect(peerOf(a, b)).toMatchObject({ online: true, path: "qamp", fallback: null });
    await pair.callA("remember", { text: "the fabric carries this memory" });
    await until(async () => (await pair.callB("recall", { q: "fabric" })).memories.length === 1, 10_000, "the memory on B");
    // The fleet's view says the path too (peers, the status line).
    const fleet = await pair.callA<FleetView>("fleet");
    expect(fleet.peers.find((p) => p.device === b.identity.id)?.path).toBe("qamp");
  });

  test("work forwarded to the other node's sandbox goes over Q-AMP, and its answer comes back as this node's", async () => {
    const made = await pair.callA<{ id: string; node?: string }>("createSandbox", { on: "beta", image: "invincible/sandbox:1" }).catch((e) => e as Error);
    // Whatever the route answers (a sandbox, or why not), it came back over the link to B, and the path is Q-AMP.
    const listed = await pair.callA<{ node: string; sandboxes: unknown[] }>("sandboxes", { on: "beta" });
    expect(listed.node).toBe("beta");
    expect(a.fabric.pathOf(b.identity.id)).toMatchObject({ path: "qamp", why: null });
    if (!(made instanceof Error)) expect(listed.sandboxes.length).toBeGreaterThan(0);
  });

  test("a key no node of the fleet names is refused at the door, before anything is read", async () => {
    const strangerHome = join(pair.root, "s");
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
