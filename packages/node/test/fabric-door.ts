import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, FABRIC, type NodeIdentity } from "@invincible/core";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "@invincible/link";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import type { Invocation } from "../src/fabric/socket.ts";
import { Home, type TransportKey } from "../src/home.ts";
import { admin, type Admin, fakeCaps, until } from "./fabric-pair.ts";
import { freePort } from "./ports.ts";

/*
 * Two real daemons in temporary homes, paired, with no sidecar binary. alpha's transport key comes from its own
 * keystore and is named in its profile with its proof, as its sidecar would once up, so beta's real door (Fabric.door)
 * maps it to alpha. `knock` hands beta's door what its sidecar would deliver once the handshake proved that key. Test
 * keys only; loopback addresses only. (From the fabric re-review's PoCs.)
 */

export interface DoorPair {
  root: string;
  a: Daemon;
  b: Daemon;
  homeA: Home;
  homeB: Home;
  callA: Admin;
  callB: Admin;
  alphaKey: TransportKey;
  stop(): Promise<void>;
}

/** Publishes `who`'s profile naming this transport key (as its sidecar would once up), on `store`. */
export function claim(store: LedgerStore, who: NodeIdentity, key: TransportKey, pop = key.pop): void {
  const current = store.device(who.id)?.profile;
  store.emit(who, "node.profile", { ...(current?.endpoint ? { endpoint: current.endpoint } : {}), caps: { ...(current?.caps ?? {}), qamp: { did: key.did, address: `qamp://${key.did}@127.0.0.1:7410`, pop } } });
}

export async function doorPair(prefix: string, agents: string[] = ["ada"]): Promise<DoorPair> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const homeA = new Home(join(root, "a"));
  const homeB = new Home(join(root, "b"));
  const portA = freePort();
  const portB = freePort();
  const { identity, keystore } = await homeA.createIdentity("file");
  const store = new LedgerStore(homeA.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "pair", nodeName: "alpha" });
  store.close();
  homeA.writeConfig({ v: 1, name: "alpha", fleet, port: portA, keystore, advertise: "127.0.0.1" });
  const a = await startDaemon(homeA, { capabilities: fakeCaps("alpha"), syncIntervalMs: 200, proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false });
  const callA = admin(homeA, portA);
  const invite = await callA<{ invite: string }>("createInvite", { kind: "node" });
  const joining = await homeB.createIdentity("file");
  const asked = await requestPairing(invite.invite, { device: joining.identity.id, name: "beta", kind: "node", box: b64u(joining.identity.boxPublic), endpoint: `http://127.0.0.1:${portB}` });
  const { pairings } = await callA("pairings");
  await callA("approvePairing", { invite: pairings[0].invite, device: pairings[0].device });
  const approved = await waitForApproval(asked, { intervalMs: 50 });
  const storeB = new LedgerStore(homeB.ledgerPath);
  storeB.expectFleet(approved.fleet);
  storeB.ingest((await signedPost<SyncPage>(joining.identity, a.endpoint, "/link/sync", { have: {} })).events);
  storeB.close();
  homeB.writeConfig({ v: 1, name: "beta", fleet: approved.fleet, port: portB, keystore: joining.keystore, advertise: "127.0.0.1" });
  const b = await startDaemon(homeB, { capabilities: fakeCaps("beta"), syncIntervalMs: 200, proxyPort: freePort(), log: () => {}, sidecar: false, defaultHeartbeat: false, archiveIntervalMs: false });
  const callB = admin(homeB, portB);
  await until(() => b.store.activeDevice(a.identity.id)?.role === "full", 15_000, "alpha known to beta as a full node");
  for (const id of agents) await callB("saveAgent", { id, name: id[0]!.toUpperCase() + id.slice(1), role: "engineer" });
  const alphaKey = await homeA.transportKey("file", a.identity.id);
  claim(a.store, a.identity, alphaKey);
  await until(() => b.fabric.nodeOfKey(alphaKey.did)?.id === a.identity.id, 15_000, "alpha's key known to beta as alpha's");
  return {
    root,
    a,
    b,
    homeA,
    homeB,
    callA,
    callB,
    alphaKey,
    async stop() {
      await b.stop();
      await a.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type Said = { kind: string; [k: string]: unknown };

/** An invocation as beta's sidecar delivers it, from this transport key, with these arguments: through beta's real door. */
export function knock(d: Daemon, tool: string, args: unknown, caller: string) {
  let failed: { code: number; message: string } | null = null;
  let completed: unknown = null;
  const said: Said[] = [];
  const abort = new AbortController();
  const inv: Invocation = {
    task: 1,
    tool,
    args,
    caller,
    authorization: { kind: "public" },
    chain: [],
    meta: null,
    deadlineMs: null,
    input: tool === FABRIC.hand,
    signal: abort.signal,
    inputs: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    emit: (chunk) => void said.push((chunk as { value: Said }).value),
    progress() {},
    complete: (result) => void (completed = result),
    fail: (code, message) => void (failed = { code, message }),
  };
  d.fabric.door(inv);
  return { inv, failed: () => failed, completed: () => completed, said, end: () => abort.abort() };
}

export type Knock = ReturnType<typeof knock>;

/** Whether a hand call has had its answer: refused, or taken or proposed. */
export const settled = (k: Knock) => k.failed() !== null || k.completed() !== null || k.said.some((s) => s.kind === "accepted" || s.kind === "proposed");
