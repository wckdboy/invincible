import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { b64u, bodyFingerprint, ceilingThreads, clientIdentity, FABRIC, type HandedView, KERNEL, newClientSecret, REFERENCE_SINGLE, routes, type RouteName, signRequest, type TeamSnapshot, utf8 } from "../../packages/core/src/index.ts";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "../../packages/link/src/index.ts";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "../../packages/ledger/src/index.ts";
import type { Capabilities } from "../../packages/node/src/capabilities.ts";
import { type Daemon, type DaemonOptions, startDaemon } from "../../packages/node/src/daemon.ts";
import { Sidecar } from "../../packages/node/src/fabric/sidecar.ts";
import { Home } from "../../packages/node/src/home.ts";
import { fakeDocker } from "../../packages/node/test/fake-docker.ts";
import { freePort, freeUdpPort } from "../../packages/node/test/ports.ts";

/*
 * The fabric's numbers before and after (PLAN Phase 2's exit), on this machine: nodes in temporary homes with real Q-AMP
 * sidecars on loopback, the same links measured over HTTP with signed requests (the fallback, and all there was before)
 * and over Q-AMP. Loopback shows what each path costs beyond the network; across real machines the network's round
 * trips add to both (docs/FABRIC.md, the runbook for Ultra and the Mac mini).
 *
 *   bun bench/fabric/measure.ts --qamp <qamp 0.2 binary> [--samples 30] [--out results.json]
 *
 * Nothing here touches a real node: every home is a temporary one, removed at the end.
 */

const { values } = parseArgs({ options: { qamp: { type: "string" }, samples: { type: "string" }, out: { type: "string" }, only: { type: "string" } } });
/** `--only handoff`: that part alone (its parts: link, lag, forward, handoff, revoke). */
const only = new Set((values.only ?? "link,lag,forward,handoff,revoke").split(","));
const QAMP = values.qamp ?? process.env.INVINCIBLE_QAMP_TEST_BIN ?? null;
if (!QAMP) throw new Error("usage: bun bench/fabric/measure.ts --qamp <qamp 0.2 binary> [--samples 30] [--out results.json]");
const N = Number(values.samples ?? 30);

const caps = (hostname: string, extra: Partial<Capabilities> = {}): Capabilities => ({ os: process.platform, arch: process.arch, hostname, cores: 8, cpu: "bench", memoryGb: 16, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: ["git"], localModels: [], tailscale: null, ...extra });
const sandboxCaps = (hostname: string) => caps(hostname, { cores: 32, memoryGb: 128, docker: true, tools: ["git", "docker"], vm: { kvm: true, tools: ["kata"] }, sandbox: { image: true, networks: true, vm: true } });

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(2);
  }
  throw new Error(`${what}: not met in ${timeoutMs} ms`);
}

function stats(samples: number[]): { n: number; p50: number; p90: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (x: number) => Math.round(x * 100) / 100;
  return { n: sorted.length, p50: round(at(0.5)), p90: round(at(0.9)), min: round(sorted[0]!), max: round(sorted.at(-1)!) };
}

const results: Record<string, ReturnType<typeof stats> | { note: string }> = {};
function record(name: string, samples: number[]): void {
  results[name] = stats(samples);
  const s = results[name] as ReturnType<typeof stats>;
  console.log(`${name.padEnd(58)} p50 ${String(s.p50).padStart(8)} ms   p90 ${String(s.p90).padStart(8)} ms   (n ${s.n}, ${s.min}–${s.max})`);
}

const admin = (home: Home, port: number) => async <T = any>(name: RouteName, input?: unknown): Promise<T> => {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

// ---- the stand-ins beta's agent works with: a VM through a stand-in Docker, and stand-in models ----

let held: { release: () => void; done: Promise<void>; entered: boolean } | null = null;
const written = new Set<string>();
const docker = fakeDocker();
docker.onExec = async (_container, command) => {
  const text = command.join("\n");
  const gate = /gate-([a-z0-9]+)/.exec(text)?.[1];
  if (gate) return written.has(gate) ? { code: 0, stdout: "there" } : { code: 1, stdout: "", stderr: "missing" };
  const write = /write-([a-z0-9]+)/.exec(text)?.[1];
  if (write) {
    if (held && write.startsWith("hold")) {
      held.entered = true;
      await held.done;
    }
    written.add(write);
    return { code: 0, stdout: "written" };
  }
  return { code: 0, stdout: "ok" };
};
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const tag = /TASK_([A-Z0-9]+)/.exec(JSON.stringify(turns))?.[1]?.toLowerCase() ?? "x";
    const sse = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    if (body.model === "reviewer") return sse({ content: "PASS\nThe gate passed after the work." });
    const worked = turns.some((m) => m.role === "assistant" || m.role === "tool");
    const command = `printf x > r-${tag}.txt # write-${tag}`;
    if (body.tools?.length && !worked) return sse({ tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
    return sse({ content: worked ? "DONE\nWritten." : "```sh\n" + command + "\n```" });
  },
});

// ---- a fleet of three nodes: alpha founds it, beta (with an agent and its VM) and gamma join ----

const root = mkdtempSync(join(tmpdir(), "q5b-"));
const nodes: Daemon[] = [];
type Node = { d: Daemon; call: ReturnType<typeof admin> };
async function node(name: string, founder: Node | null, extra: Partial<DaemonOptions>): Promise<Node> {
  const home = new Home(join(root, name));
  const port = freePort();
  const base: DaemonOptions = { capabilities: caps(name), syncIntervalMs: 60_000, proxyPort: freePort(), log: () => {}, sidecar: { binary: QAMP, port: await freeUdpPort() }, defaultHeartbeat: false, archiveIntervalMs: false, ...extra };
  if (!founder) {
    const { identity, keystore } = await home.createIdentity("file");
    const store = new LedgerStore(home.ledgerPath);
    const fleet = foundFleet(store, identity, { fleetName: "bench", nodeName: name });
    store.close();
    home.writeConfig({ v: 1, name, fleet, port, keystore, advertise: "127.0.0.1", fabric: true });
  } else {
    const invite = await founder.call<{ invite: string }>("createInvite", { kind: "node" });
    const joining = await home.createIdentity("file");
    const join_ = await requestPairing(invite.invite, { device: joining.identity.id, name, kind: "node", box: b64u(joining.identity.boxPublic), endpoint: `http://127.0.0.1:${port}` });
    const { pairings } = await founder.call("pairings");
    const mine = pairings.find((p: { device: string }) => p.device === joining.identity.id);
    await founder.call("approvePairing", { invite: mine.invite, device: mine.device });
    const approved = await waitForApproval(join_, { intervalMs: 20 });
    const store = new LedgerStore(home.ledgerPath);
    store.expectFleet(approved.fleet);
    store.ingest((await signedPost<SyncPage>(joining.identity, founder.d.endpoint, "/link/sync", { have: {} })).events);
    store.close();
    home.writeConfig({ v: 1, name, fleet: approved.fleet, port, keystore: joining.keystore, advertise: "127.0.0.1", fabric: true });
  }
  const d = await startDaemon(home, base);
  nodes.push(d);
  return { d, call: admin(home, port) };
}

try {
  const alpha = await node("alpha", null, {});
  const beta = await node("beta", alpha, {
    capabilities: sandboxCaps("beta"),
    docker: docker.runner,
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 200,
  });
  const gamma = await node("gamma", alpha, {});
  const a = alpha.d;
  const b = beta.d;
  // Every node knows every other's transport key (their profiles synced), and their links are on Q-AMP.
  for (const x of nodes) for (const y of nodes) if (x !== y) await x.sync.pullFrom(x.store.device(y.identity.id)!);
  for (const x of nodes) for (const y of nodes) if (x !== y) await x.sync.pullFrom(x.store.device(y.identity.id)!);
  const pathOf = (x: Daemon, y: Daemon) => x.sync.status().find((p) => p.device === y.identity.id)?.path;
  await until(async () => {
    for (const x of nodes) for (const y of nodes) if (x !== y) await x.sync.pullFrom(x.store.device(y.identity.id)!);
    return nodes.every((x) => nodes.every((y) => x === y || pathOf(x, y) === "qamp"));
  }, 30_000, "every link on Q-AMP");
  console.log(`three nodes, every link on Q-AMP · qamp ${a.fabric.sidecar.version} · ${process.platform}/${process.arch} · ${N} samples each\n`);

  // ---- 1. The first answer on a fresh connection: beta asks alpha for what it has after its own frontier ----
  if (only.has("link")) {
    const have = b.store.frontier();
    const https: number[] = [];
    for (let i = 0; i < N; i++) {
      const body = utf8(JSON.stringify({ have }));
      const headers = await signRequest(b.identity.id, b.identity.sign, "POST", "/link/sync", body);
      const t0 = performance.now();
      const res = await fetch(`${a.endpoint}/link/sync`, { method: "POST", headers: { ...headers, "content-type": "application/json", connection: "close" }, body, keepalive: false } as RequestInit);
      await res.json();
      https.push(performance.now() - t0);
    }
    record("first answer, fresh connection · HTTP, signed request", https);
    const qamp: number[] = [];
    const cold: number[] = [];
    const failures: string[] = [];
    const keyHome = join(root, "beta");
    const gammaAddress = nodes[2]!.fabric.sidecar.address!;
    for (let i = 0; i < N; i++) {
      // A sidecar of beta's transport key, started for this sample. Its first call ever (to gamma) pays the process's own
      // first use (its crypto library, its runtime) as a long-running sidecar never does again; its first call to alpha
      // after that is what a node pays for a fresh connection to a peer: a Retry, the 1-RTT handshake, the call.
      const fresh = new Sidecar({ home: keyHome, binary: () => QAMP, listen: () => null, name: "bench", log: () => {}, socket: join(root, `f${i % 2}.sock`) });
      // (A sample that fails is counted and said, never dropped in silence; its sidecar is stopped whatever happened.)
      let stage = "start";
      const s0 = performance.now();
      try {
        await fresh.start();
        if (fresh.state !== "up") throw new Error(`a fresh sidecar didn't start: ${fresh.why}`);
        stage = "its first call (gamma)";
        const c0 = performance.now();
        await fresh.client!.call(gammaAddress, FABRIC.sync, { have }).result;
        cold.push(performance.now() - c0);
        stage = "its call to alpha";
        const t0 = performance.now();
        await fresh.client!.call(a.fabric.sidecar.address!, FABRIC.sync, { have }).result;
        qamp.push(performance.now() - t0);
      } catch (error) {
        failures.push(`sample ${i}, ${stage}, after ${Math.round(performance.now() - s0)} ms: ${(error as Error).message}`);
      } finally {
        await fresh.stop();
      }
    }
    record("first answer, fresh connection · Q-AMP (Retry + 1-RTT + call)", qamp);
    record("  the same, the sidecar process's very first call", cold);
    if (failures.length) {
      results["first answer, fresh connection · Q-AMP: failed samples"] = { note: failures.join(" | ") };
      console.log(`  failed samples: ${failures.length} of ${N}: ${failures.join(" | ")}`);
    }
    const warmHttps: number[] = [];
    const warmQamp: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await signedPost(b.identity, a.endpoint, "/link/sync", { have });
      warmHttps.push(performance.now() - t0);
      const t1 = performance.now();
      await b.fabric.sidecar.client!.call(a.fabric.sidecar.address!, FABRIC.sync, { have }).result;
      warmQamp.push(performance.now() - t1);
    }
    record("an answer on a warm connection · HTTP, signed request", warmHttps);
    record("an answer on a warm connection · Q-AMP", warmQamp);
  }

  // ---- 2. Sync's lag: an event written on alpha until it is in beta's ledger (its push; pulls are a minute apart) ----
  const lag = async (label: string) => {
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      let arrived: (() => void) | null = null;
      const seen = new Promise<void>((resolve) => (arrived = resolve));
      let id = "";
      const off = b.store.onApplied((events) => {
        if (events.some((e) => e.id === id)) arrived?.();
      });
      const t0 = performance.now();
      id = a.store.remember(a.identity, `bench ${label} ${i}`).id;
      await Promise.race([seen, Bun.sleep(10_000).then(() => Promise.reject(new Error(`${label}: event ${i} didn't arrive`)))]);
      samples.push(performance.now() - t0);
      off();
      await Bun.sleep(20);
    }
    record(`sync's lag (alpha's push to beta) · ${label}`, samples);
  };
  if (only.has("lag")) {
    await lag("Q-AMP");
    await a.fabric.sidecar.stop();
    await until(() => !a.fabric.sidecar.client, 10_000, "alpha's sidecar stopped");
    await lag("HTTP, signed request");
  }

  // ---- 3. Forwarded work: a command in beta's sandbox, from alpha (as a run's commands go when its VM is elsewhere) ----
  if (only.has("forward")) {
    const { sandbox } = await alpha.call<{ sandbox: { id: string } }>("createSandbox", { on: "beta", image: "invincible/sandbox:1" });
    const exec = async (label: string) => {
      const samples: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        await alpha.call("execSandbox", { on: "beta", id: sandbox.id, cmd: ["true"], timeoutSec: 30 });
        samples.push(performance.now() - t0);
      }
      record(`a forwarded command's answer (sandbox on beta) · ${label}`, samples);
    };
    // Over HTTP: alpha's sidecar down, as when it can't be had.
    if (a.fabric.sidecar.state !== "off") {
      await a.fabric.sidecar.stop();
      await until(() => !a.fabric.sidecar.client, 10_000, "alpha's sidecar stopped");
    }
    await exec("HTTP, signed request");
    await a.fabric.sidecar.start();
    await until(async () => {
      await a.sync.pullFrom(a.store.device(b.identity.id)!);
      return a.fabric.sidecar.state === "up" && a.fabric.pathOf(b.identity.id)?.path === "qamp";
    }, 30_000, "alpha back on Q-AMP");
    await exec("Q-AMP");
    // (Its slot goes back, for the agent's own VM below.)
    await alpha.call("destroySandbox", { on: "beta", id: sandbox.id });
  }
  if (a.fabric.sidecar.state !== "up") {
    await a.fabric.sidecar.start();
    await until(async () => {
      await a.sync.pullFrom(a.store.device(b.identity.id)!);
      return a.fabric.sidecar.state === "up" && a.fabric.pathOf(b.identity.id)?.path === "qamp";
    }, 30_000, "alpha back on Q-AMP");
  }

  // ---- 4. A task handed to beta's agent: its first output back on alpha, a stop's round trip, a run's key revoked ----
  await until(() => b.store.lww(`calibration:${b.identity.id}`) !== null, 30_000, "beta's calibration");
  await beta.call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer"]) await beta.call("setRoster", { role, models: [`stand-in/${role}`] });
  await beta.call("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  const hands = only.has("handoff") ? Math.min(N, 10) : 0;
  const first: number[] = [];
  const whole: number[] = [];
  for (let i = 0; i < hands; i++) {
    const t0 = performance.now();
    const view = await alpha.call<HandedView>("handTask", { node: "beta", goal: `TASK_P${i}: write it`, gates: [`test -f r-p${i}.txt # gate-p${i}`], agent: "ada" });
    await until(async () => (await alpha.call<HandedView>("handedTask", { id: view.id, after: 0 })).phase === "ended", 60_000, "hand-off ended");
    whole.push(performance.now() - t0);
    const t = a.handoffs.timings(view.id);
    if (t.firstOutputMs !== null) first.push(t.firstOutputMs);
    const done = await alpha.call<HandedView>("handedTask", { id: view.id, after: 0 });
    if (done.proof.state !== "checked" || !done.proof.verified) throw new Error(`hand-off ${i} wasn't proven: ${JSON.stringify(done.proof)}`);
  }
  if (hands) {
    record("a handed task's first output back on alpha · Q-AMP", first);
    record("a handed task, given to Proven on alpha (stand-in models) · Q-AMP", whole);
  }
  results["a handed task · HTTP"] = { note: "none: a task is handed to another node's agents over Q-AMP alone; before the fabric there was no such link" };

  const stops: number[] = [];
  const revokes: number[] = [];
  for (let i = 0; i < hands; i++) {
    let release!: () => void;
    held = { release: () => release(), done: new Promise<void>((r) => (release = r)), entered: false };
    const view = await alpha.call<HandedView>("handTask", { node: "beta", goal: `TASK_HOLD${i}: write it, slowly`, gates: [`test -f r-hold${i}.txt # gate-hold${i}`], agent: "ada", tools: ["fleet"] });
    await until(() => held!.entered, 60_000, "held command under way");
    await until(() => b.handoffs.running().some((r) => r.handoff === view.id && r.chained), 10_000, "the run's chain");
    const vm = (await beta.call<TeamSnapshot>("team")).agents.find((m) => m.id === "ada")!.workspace!.id;
    const ok = await b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal);
    if (ok.status !== 200) throw new Error(`the run's call wasn't taken: ${JSON.stringify(ok)}`);
    // Revocation's round trip: revoked at alpha, until the run's very next call is refused.
    const r0 = performance.now();
    await a.handoffs.revokeRun(view.id);
    const refused = await b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal);
    revokes.push(performance.now() - r0);
    if (refused.status !== 403) throw new Error(`a revoked run's call was answered ${refused.status}`);
    const s0 = performance.now();
    await alpha.call("stopHanded", { id: view.id });
    await until(async () => (await alpha.call<HandedView>("handedTask", { id: view.id, after: 0 })).phase === "ended", 30_000, "stopped");
    stops.push(performance.now() - s0);
    held.release();
    held = null;
  }
  if (hands) {
    record("a stop's round trip (alpha's stop, beta's work stopped and said) · Q-AMP", stops);
    results["a stop's round trip · HTTP"] = { note: "none: work forwarded over HTTP could not be stopped from the node that sent it" };
    record("a run's key revoked, until its next call is refused · Q-AMP", revokes);
  }

  // ---- 5. A device revoked on alpha, until beta knows it (beta's door refuses it from then): its push, either path ----
  const revoked = async (label: string) => {
    const samples: number[] = [];
    for (let i = 0; i < Math.min(N, 20); i++) {
      // (A client device: revoking it is the same event a node's revocation is, and rotates no vault key.)
      const device = clientIdentity(newClientSecret());
      enrollDevice(a.store, a.identity, { device: device.id, name: `x${i}`, kind: "client" });
      await until(() => b.store.activeDevice(device.id) !== null, 10_000, "enrolment on beta");
      const t0 = performance.now();
      revokeDevice(a.store, a.identity, device.id, "bench");
      await until(() => b.store.activeDevice(device.id) === null, 10_000, "revocation on beta");
      samples.push(performance.now() - t0);
    }
    record(`a device revoked on alpha, until beta refuses it · ${label}`, samples);
  };
  if (only.has("revoke")) {
    await revoked("Q-AMP");
    await a.fabric.sidecar.stop();
    await until(() => !a.fabric.sidecar.client, 10_000, "alpha's sidecar stopped");
    await revoked("HTTP, signed request");
  }
  void gamma;
} finally {
  held?.release();
  for (const d of nodes.reverse()) await d.stop().catch(() => {});
  models.stop(true);
  rmSync(root, { recursive: true, force: true });
}

if (values.out) await Bun.write(values.out, `${JSON.stringify({ at: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, samples: N, results }, null, 2)}\n`);
