import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bodyFingerprint, ceilingThreads, clientIdentity, type DeviceId, FABRIC, type HandedView, KERNEL, LINK_PATHS, newClientSecret, REFERENCE_SINGLE, routes, type RouteName, signRequest, utf8 } from "../../packages/core/src/index.ts";
import { provenNode, requestPairing, signedPost, type SyncPage, waitForApproval } from "../../packages/link/src/index.ts";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "../../packages/ledger/src/index.ts";
import type { Capabilities } from "../../packages/node/src/capabilities.ts";
import { type Daemon, type DaemonOptions, startDaemon } from "../../packages/node/src/daemon.ts";
import { Sidecar } from "../../packages/node/src/fabric/sidecar.ts";
import { Home, transportKeyOf } from "../../packages/node/src/home.ts";
import { fakeDocker } from "../../packages/node/test/fake-docker.ts";

/*
 * The fabric's numbers across a real network (docs/FABRIC.md, the runbook): two throwaway test nodes of their own fleet,
 * one on each machine, each with its own Q-AMP sidecar on its tailnet address. Never the owner's nodes, homes or ports.
 *
 *   on one machine:   bun bench/fabric/remote.ts serve   --qamp <bin> --advertise <its tailnet ip> --root <empty dir>
 *                     (prints an invite, approves the one node that joins with it, answers until stopped)
 *   on the other:     bun bench/fabric/remote.ts measure --qamp <bin> --advertise <its tailnet ip> --root <empty dir>
 *                     --invite <the invite> [--samples 30] [--out results.json]
 *
 * Both take --port 7470 (HTTP) and --qamp-port 7471 (UDP) unless told others. The measuring node times every round trip
 * on its own clock: an event it writes comes back as the serving node's echo (two pushes), a device it revokes comes
 * back as the serving node's word that it refuses it. The two coordinate through their own ledger ("q5ctl" memories).
 */

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { qamp: { type: "string" }, advertise: { type: "string" }, root: { type: "string" }, port: { type: "string" }, "qamp-port": { type: "string" }, invite: { type: "string" }, samples: { type: "string" }, out: { type: "string" } },
});
const role = positionals[0];
const QAMP = values.qamp;
const ADVERTISE = values.advertise;
const ROOT = values.root;
if ((role !== "serve" && role !== "measure") || !QAMP || !ADVERTISE || !ROOT) throw new Error("usage: bun bench/fabric/remote.ts serve|measure --qamp <bin> --advertise <tailnet ip> --root <empty dir> [--invite …] [--port 7470] [--qamp-port 7471] [--samples 30] [--out results.json]");
const PORT = Number(values.port ?? 7470);
const QPORT = Number(values["qamp-port"] ?? 7471);
const N = Number(values.samples ?? 30);
mkdirSync(ROOT, { recursive: true, mode: 0o700 });

const caps = (hostname: string, extra: Partial<Capabilities> = {}): Capabilities => ({ os: process.platform, arch: process.arch, hostname, cores: 32, cpu: "bench", memoryGb: 128, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: ["git"], localModels: [], tailscale: null, ...extra });
const measure: NonNullable<DaemonOptions["measure"]> = async (reason, body, limit) => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
};
const admin = (home: Home, port: number) => async <T = any>(name: RouteName, input?: unknown): Promise<T> => {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  if (!response.ok) throw new Error(`${name} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 60_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(2);
  }
  throw new Error(`${what}: not met in ${timeoutMs} ms`);
}
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: sorted.length, p50: r(at(0.5)), p90: r(at(0.9)), min: r(sorted[0]!), max: r(sorted.at(-1)!) };
};

const home = new Home(join(ROOT, "node"));
// The serving node's VM, through a stand-in Docker: a command tagged write-hold… waits until it is told to go on (a run
// under way, to stop or to revoke), every other command answers at once.
const docker = fakeDocker();
let release: () => void = () => {};
let held = new Promise<void>((resolve) => (release = resolve));
const written = new Set<string>();
docker.onExec = async (_container, command) => {
  const text = command.join("\n");
  const gate = /gate-([a-z0-9]+)/.exec(text)?.[1];
  if (gate) return written.has(gate) ? { code: 0, stdout: "there" } : { code: 1, stdout: "", stderr: "missing" };
  const write = /write-([a-z0-9]+)/.exec(text)?.[1];
  if (write?.startsWith("hold")) await held;
  if (write) written.add(write);
  return { code: 0, stdout: "ok" };
};
// The serving node alone hosts VMs: its agent's VM is then its own, as a handed run's must be for it to reach its giver's
// tools (a VM on another node calls that node's gateway, which holds no run of this one: docs/FABRIC.md).
const base = (name: string): DaemonOptions => ({
  capabilities: name === "server" ? caps(name, { docker: true, tools: ["git", "docker"], vm: { kvm: true, tools: ["kata"] }, sandbox: { image: true, networks: true, vm: true } }) : caps(name),
  docker: docker.runner,
  measure,
  // Pulls every 2 s: a push takes only what extends a device's chain as the receiver holds it, so the two converge fast
  // and every push after that is taken as it comes (what is measured; a pull would come seconds later).
  syncIntervalMs: 2_000,
  proxyPort: PORT + 5,
  log: (m) => process.env.Q5_DEBUG && console.error(`[${name}] ${m}`),
  sidecar: { binary: QAMP, port: QPORT },
  defaultHeartbeat: false,
  archiveIntervalMs: false,
  shutdownGraceMs: 500,
});

let node: Daemon | null = null;
const stopAll = async () => {
  await node?.stop().catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
};

if (role === "serve") {
  // ---- the serving node: founds the fleet, hosts an agent's VM, echoes, and does what the measuring node says ----
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "q5-bench", nodeName: "server" });
  store.close();
  home.writeConfig({ v: 1, name: "server", fleet, port: PORT, keystore, advertise: ADVERTISE, fabric: true });
  node = await startDaemon(home, base("server"));
  const call = admin(home, PORT);
  // Stand-in models for its agent's work: the engineer writes a file, the reviewer passes it.
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
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const r of ["planner", "engineer", "reviewer"]) await call("setRoster", { role: r, models: [`stand-in/${r}`] });
  // Priced above nothing: another node's task runs only on a model its budget counts at more than $0 (N7).
  for (const r of ["planner", "engineer", "reviewer"]) await call("setPrice", { model: `stand-in/${r}`, input: 1, output: 2 });
  await call("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  // Your word, once, that the measuring node may hand this one's Ada work (its default of $3 a task, every sample).
  const grantClient = async () => {
    const client = node!.store.devices().find((d) => d.kind === "node" && d.id !== node!.identity.id && !d.revokedHlc);
    if (client && !node!.store.handoffGrant(client.id, node!.identity.id)) await call("grantHandoffs", { from: client.id, to: node!.identity.id, agents: ["ada"], tools: ["fleet"], budgetUsdPerDay: 1000 });
  };
  // Echoes, and what it is told (its sidecar off or on), through the fleet's own ledger. Written after the listener
  // returns, never inside it (the ledger swallows what its listeners throw).
  const self = node.identity.id;
  const say = (text: string) =>
    setTimeout(() => {
      try {
        node!.store.remember(node!.identity, text);
      } catch (error) {
        console.error(`serve: couldn't say ${text}: ${(error as Error).message}`);
      }
    }, 0);
  node.store.onApplied((events) => {
    for (const e of events) {
      if (e.device === self) continue;
      if (e.kind === "memory.added") {
        const text = (e.body as { text?: string }).text ?? "";
        if (text.startsWith("q5echo? ")) say(`q5echo! ${text.slice(8)}`);
        else if (text === "q5ctl sidecar off") void node!.fabric.sidecar.stop().then(() => say("q5ctl sidecar is off"));
        else if (text === "q5ctl sidecar on") void node!.fabric.sidecar.start().then(() => say(`q5ctl sidecar is ${node!.fabric.sidecar.state}`));
        else if (text === "q5ctl release") {
          release();
          held = new Promise<void>((resolve) => (release = resolve));
        } else if (text.startsWith("q5ctl callgiver ")) {
          // The run of that hand-off calls a tool of its giver's, as its VM would through this node's gateway.
          const handoff = text.slice("q5ctl callgiver ".length);
          void (async () => {
            const team = await call<{ agents: { id: string; workspace: { id: string } | null }[] }>("team");
            const vm = team.agents.find((a) => a.id === "ada")?.workspace?.id ?? "";
            const answer = await node!.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal);
            say(`q5echo! callgiver ${handoff} ${answer.status}`);
          })();
        }
      } else if (e.kind === "device.revoked") {
        const device = (e.body as { device?: string }).device ?? "";
        if (!node!.store.activeDevice(device)) say(`q5echo! revoked ${device}`);
      }
    }
  });
  // It approves the one node that joins with its invite.
  const invite = await call<{ invite: string }>("createInvite", { kind: "node" });
  console.log(JSON.stringify({ invite: invite.invite, endpoint: node.endpoint, did: node.fabric.sidecar.did, address: node.fabric.sidecar.address }));
  const approver = setInterval(async () => {
    const { pairings } = await call<{ pairings: { invite: string; device: string }[] }>("pairings").catch(() => ({ pairings: [] }));
    for (const p of pairings) await call("approvePairing", { invite: p.invite, device: p.device }).catch(() => {});
    await grantClient().catch(() => {});
  }, 200);
  const done = new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
  await done;
  clearInterval(approver);
  models.stop(true);
  await stopAll();
  process.exit(0);
}

// ---- the measuring node ----
const results: Record<string, unknown> = {};
const record = (name: string, samples: number[]) => {
  results[name] = stats(samples);
  const s = results[name] as ReturnType<typeof stats>;
  console.log(`${name.padEnd(60)} p50 ${String(s.p50).padStart(8)} ms   p90 ${String(s.p90).padStart(8)} ms   (n ${s.n}, ${s.min}–${s.max})`);
};
try {
  const joining = await home.createIdentity("file");
  const invite = values.invite;
  if (!invite) throw new Error("--invite: the serving node's");
  const join_ = await requestPairing(invite, { device: joining.identity.id, name: "client", kind: "node", box: Buffer.from(joining.identity.boxPublic).toString("base64url"), endpoint: `http://${ADVERTISE}:${PORT}` });
  const approved = await waitForApproval(join_, { intervalMs: 100 });
  const store = new LedgerStore(home.ledgerPath);
  store.expectFleet(approved.fleet);
  const serverEndpoint = join_.invite.e;
  // (Which node serves, proven: what it signs names it. An invite names only its address.)
  const proven = await provenNode(joining.identity, serverEndpoint);
  const serving = { ...(proven ? { id: proven } : {}), endpoint: serverEndpoint };
  store.ingest((await signedPost<SyncPage>(joining.identity, serving, "/link/sync", { have: {} })).events);
  store.close();
  home.writeConfig({ v: 1, name: "client", fleet: approved.fleet, port: PORT, keystore: joining.keystore, advertise: ADVERTISE, fabric: true });
  node = await startDaemon(home, base("client"));
  const me = node;
  const call = admin(home, PORT);
  const server = () => me.store.devices().find((d) => d.kind === "node" && d.id !== me.identity.id)!;
  const pathToServer = () => me.sync.status().find((p) => p.device === server().id)?.path;
  await until(async () => {
    await me.sync.pullFrom(server());
    return pathToServer() === "qamp";
  }, 60_000, "on Q-AMP to the serving node");
  const serverAddress = (server().profile!.caps as { qamp: { address: string } }).qamp.address;
  console.log(`client ↔ server on Q-AMP · qamp ${me.fabric.sidecar.version} · ${process.platform}/${process.arch} · ${N} samples each\n`);

  /** Writes a memory, and waits for the serving node's own that answers it. */
  const echo = async (tag: string, timeoutMs = 20_000): Promise<number> => {
    let resolve!: () => void;
    const back = new Promise<void>((r) => (resolve = r));
    const off = me.store.onApplied((events) => {
      if (events.some((e) => e.kind === "memory.added" && (e.body as { text?: string }).text === `q5echo! ${tag}`)) resolve();
    });
    const t0 = performance.now();
    me.store.remember(me.identity, `q5echo? ${tag}`);
    try {
      await Promise.race([back, Bun.sleep(timeoutMs).then(() => Promise.reject(new Error(`no echo of ${tag}`)))]);
    } finally {
      off();
    }
    return performance.now() - t0;
  };
  const control = async (what: "off" | "on") => {
    let resolve!: () => void;
    const said = new Promise<void>((r) => (resolve = r));
    const off = me.store.onApplied((events) => {
      if (events.some((e) => e.kind === "memory.added" && ((e.body as { text?: string }).text ?? "").startsWith("q5ctl sidecar is"))) resolve();
    });
    me.store.remember(me.identity, `q5ctl sidecar ${what}`);
    await Promise.race([said, Bun.sleep(30_000)]);
    off();
  };

  // 1. The first answer on a fresh connection, and on a warm one.
  const have = me.store.frontier();
  const freshHttp: number[] = [];
  for (let i = 0; i < N; i++) {
    const body = utf8(JSON.stringify({ have }));
    const headers = await signRequest(me.identity.id, me.identity.sign, "POST", "/link/sync", body, Date.now(), serving.id as DeviceId | undefined);
    const t0 = performance.now();
    const res = await fetch(`${serverEndpoint}/link/sync`, { method: "POST", headers: { ...headers, "content-type": "application/json", connection: "close" }, body, keepalive: false } as RequestInit);
    await res.json();
    freshHttp.push(performance.now() - t0);
  }
  record("first answer, fresh connection · HTTP, signed request", freshHttp);
  // A sidecar of this node's key, warmed on a throwaway one of its own on loopback, then its first call to the server.
  const warmer = new Sidecar({ home: join(ROOT, "warmer"), key: async () => transportKeyOf(randomBytes(32), "n_warmer"), binary: () => QAMP, listen: () => `127.0.0.1:${QPORT + 10}`, name: "warmer", log: () => {}, socket: join(ROOT, "w.sock") });
  await warmer.start();
  const freshQamp: number[] = [];
  const coldQamp: number[] = [];
  for (let i = 0; i < N; i++) {
    // This node's own transport key, from its keystore; each call signed by its device key, before the clock starts.
    const fresh = new Sidecar({ home: join(ROOT, "node"), key: () => home.transportKey("file", me.identity.id), binary: () => QAMP, listen: () => null, name: "fresh", log: () => {}, socket: join(ROOT, `f${i % 2}.sock`) });
    await fresh.start();
    if (fresh.state !== "up") throw new Error(`a fresh sidecar didn't start: ${fresh.why}`);
    const toWarmer = await me.fabric.seal(LINK_PATHS.sync, { have });
    const c0 = performance.now();
    await fresh.client!.call(warmer.address!, FABRIC.sync, toWarmer).result.catch(() => null);
    coldQamp.push(performance.now() - c0);
    const toServer = await me.fabric.seal(LINK_PATHS.sync, { have });
    const t0 = performance.now();
    await fresh.client!.call(serverAddress, FABRIC.sync, toServer).result;
    freshQamp.push(performance.now() - t0);
    await fresh.stop();
  }
  await warmer.stop();
  record("first answer, fresh connection · Q-AMP (Retry + 1-RTT + call)", freshQamp);
  record("  a sidecar process's very first call (loopback, refused)", coldQamp);
  const warmHttp: number[] = [];
  const warmQamp: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await signedPost(me.identity, serving, "/link/sync", { have });
    warmHttp.push(performance.now() - t0);
    // Signed inside the clock, as signedPost signs inside its own: each path's whole call, as a sync makes it.
    const t1 = performance.now();
    await me.fabric.sidecar.client!.call(serverAddress, FABRIC.sync, await me.fabric.seal(LINK_PATHS.sync, { have })).result;
    warmQamp.push(performance.now() - t1);
  }
  record("an answer on a warm connection · HTTP, signed request", warmHttp);
  record("an answer on a warm connection · Q-AMP", warmQamp);

  // 2. Sync's lag: an event there and back (two pushes), halved; and a device revoked here until the server refuses it.
  // (First, one echo with time to spare: until each holds the other's chain whole, a push may wait for a pull.)
  await echo("converged", 60_000);
  const lagQ: number[] = [];
  for (let i = 0; i < N; i++) lagQ.push((await echo(`q${i}`)) / 2);
  record("sync's lag (a push, half an echo's round trip) · Q-AMP", lagQ);
  const revQ: number[] = [];
  const revoked = async (label: string, into: number[]) => {
    for (let i = 0; i < Math.min(N, 20); i++) {
      const device = clientIdentity(newClientSecret());
      enrollDevice(me.store, me.identity, { device: device.id, name: `${label}${i}`, kind: "client" });
      await echo(`enrolled-${label}-${i}`);
      let resolve!: () => void;
      const back = new Promise<void>((r) => (resolve = r));
      const off = me.store.onApplied((events) => {
        if (events.some((e) => e.kind === "memory.added" && (e.body as { text?: string }).text === `q5echo! revoked ${device.id}`)) resolve();
      });
      const t0 = performance.now();
      revokeDevice(me.store, me.identity, device.id, "bench");
      await Promise.race([back, Bun.sleep(20_000).then(() => Promise.reject(new Error("no word of the revocation")))]);
      // (Until the server refuses it: one push there; its word back, another. Halved, as for the lag.)
      into.push((performance.now() - t0) / 2);
      off();
    }
  };
  await revoked("q", revQ);
  record("a device revoked here, until the server refuses it (half a round trip) · Q-AMP", revQ);

  // 3. A task handed to the server's agent: its first output back here, given to Proven, a stop's round trip.
  const first: number[] = [];
  const whole: number[] = [];
  for (let i = 0; i < Math.min(N, 10); i++) {
    const t0 = performance.now();
    const view = await call<HandedView>("handTask", { node: "server", goal: `TASK_P${i}: write it`, gates: [`test -f r-p${i}.txt # gate-p${i}`], agent: "ada" });
    await until(async () => (await call<HandedView>("handedTask", { id: view.id, after: 0 })).phase === "ended", 120_000, "hand-off ended");
    whole.push(performance.now() - t0);
    const t = me.handoffs.timings(view.id);
    if (t.firstOutputMs !== null) first.push(t.firstOutputMs);
  }
  record("a handed task's first output back here · Q-AMP", first);
  record("a handed task, given to its end here (stand-in models) · Q-AMP", whole);

  // A stop's round trip, and a run's key revoked until its next call is refused: on runs held under way on the server.
  const callGiver = async (handoff: string): Promise<string> => {
    let resolve!: (status: string) => void;
    const back = new Promise<string>((r) => (resolve = r));
    const off = me.store.onApplied((events) => {
      for (const e of events) {
        const text = e.kind === "memory.added" ? ((e.body as { text?: string }).text ?? "") : "";
        if (text.startsWith(`q5echo! callgiver ${handoff} `)) resolve(text.slice(`q5echo! callgiver ${handoff} `.length));
      }
    });
    me.store.remember(me.identity, `q5ctl callgiver ${handoff}`);
    try {
      return await Promise.race([back, Bun.sleep(30_000).then(() => "no answer")]);
    } finally {
      off();
    }
  };
  const stops: number[] = [];
  const revokes: number[] = [];
  for (let i = 0; i < Math.min(N, 10); i++) {
    const view = await call<HandedView>("handTask", { node: "server", goal: `TASK_HOLD${i}: write it, slowly`, gates: [`test -f r-hold${i}.txt # gate-hold${i}`], agent: "ada", tools: ["fleet"] });
    await until(async () => (await call<HandedView>("handedTask", { id: view.id, after: 0 })).trail.some((t) => t.text.includes(`write-hold${i}`)), 60_000, "the held command under way").catch(async (error) => {
      const seen = await call<HandedView>("handedTask", { id: view.id, after: 0 });
      throw new Error(`${(error as Error).message}: ${seen.phase} ${seen.status} · ${seen.trail.map((t) => t.text.split("\n")[0]).join(" | ").slice(0, 800)}`);
    });
    const taken = await callGiver(view.id);
    if (taken !== "200") throw new Error(`the run's call to this node wasn't taken: ${taken}`);
    // Revoked here: from then until the server says the run's next call was refused (one call there and its word back).
    const r0 = performance.now();
    await me.handoffs.revokeRun(view.id);
    const refused = await callGiver(view.id);
    revokes.push(performance.now() - r0);
    if (refused !== "403") throw new Error(`a revoked run's call was answered ${refused}`);
    const s0 = performance.now();
    await call("stopHanded", { id: view.id });
    await until(async () => (await call<HandedView>("handedTask", { id: view.id, after: 0 })).phase === "ended", 60_000, "stopped");
    stops.push(performance.now() - s0);
    // Its held command let go there, so its agent is free for the next one.
    me.store.remember(me.identity, "q5ctl release");
  }
  record("a stop's round trip (this node's stop, the work stopped there and said) · Q-AMP", stops);
  record("a run's key revoked here, until the server says its next call was refused · Q-AMP", revokes);

  // 4. A forwarded command in the server's sandbox (as a run's commands go when its VM is elsewhere): Q-AMP, then HTTP.
  const { sandbox } = await call<{ sandbox: { id: string } }>("createSandbox", { on: "server", image: "invincible/sandbox:1" });
  const exec = async (label: string) => {
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await call("execSandbox", { on: "server", id: sandbox.id, cmd: ["true"], timeoutSec: 30 });
      samples.push(performance.now() - t0);
    }
    record(`a forwarded command's answer (sandbox on the server) · ${label}`, samples);
  };
  await exec("Q-AMP");

  // ---- Everything over HTTP: both sidecars off ----
  await control("off");
  await me.fabric.sidecar.stop();
  await echo("converged-http", 60_000);
  await exec("HTTP, signed request");
  const lagH: number[] = [];
  for (let i = 0; i < N; i++) lagH.push((await echo(`h${i}`)) / 2);
  record("sync's lag (a push, half an echo's round trip) · HTTP, signed request", lagH);
  const revH: number[] = [];
  await revoked("h", revH);
  record("a device revoked here, until the server refuses it (half a round trip) · HTTP, signed request", revH);
  await call("destroySandbox", { on: "server", id: sandbox.id }).catch(() => {});
  results["a handed task · HTTP"] = { note: "none: a task is handed to another node's agents over Q-AMP alone" };
} finally {
  await stopAll();
}
if (values.out) await Bun.write(values.out, `${JSON.stringify({ at: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, samples: N, results }, null, 2)}\n`);
process.exit(0);
