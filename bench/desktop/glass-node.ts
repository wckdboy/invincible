/*
 * The glass-to-glass harness's node (C1 step 9.3): a scratch node, run on the machine its agent's VM is on (Ultra),
 * that a browser elsewhere on the tailnet watches through (glass.ts). Run as root there, from this checkout:
 *
 *   bun bench/desktop/glass-node.ts --advertise <its tailnet address> [--port 47911] [--time-port 47913] [--build]
 *
 * - Its sandboxes are the bench's (scratch.ts): `<prefix>-sbx-*`, the `<prefix>/…` images (--build makes them from this
 *   checkout first), labelled `dev.<prefix>`, never a live node's. It makes no network, keeps no image and listens on no
 *   sandbox gateway (sandboxNetworks: false): those are the live node's. Its home and its sandboxes are its own, under
 *   --dir (default /root/c1/glass).
 * - It listens on the tailnet address it is given, plain HTTP, on its own ports: --port, the next one up on loopback
 *   (the node's proxied listener), and --time-port. The browser treats that origin as secure by its own flag (glass.ts).
 * - It makes one agent, "glass", with an isolated desktop VM, opens the glass clock's page on its screen (glass-page.ts)
 *   and gives the desktop back.
 * - The clocks: the VM's against this machine's, by a held exec's exchanges (sub-millisecond), and this machine's for
 *   the browser's, on its own port (--time-port): `{ now }`, nothing else.
 * - It prints, as one line of JSON, what glass.ts needs: where to pair (an invite, approved as it comes, for ten
 *   minutes), the agent's room, the time's address, and the VM's offset. It runs until it is stopped (Ctrl-C, SIGTERM),
 *   then removes its VM.
 * --stand-in runs it here on stand-ins for Docker, deskd and the encoder, replaying --frames <file> (a recording of the
 * glass page, the stream's own format): to try glass.ts against, nothing measured.
 */

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { foundFleet, LedgerStore } from "../../packages/ledger/src/index.ts";
import { type Daemon, startDaemon } from "../../packages/node/src/daemon.ts";
import { Home } from "../../packages/node/src/home.ts";
import { spawnFrames, spawnSession } from "../../packages/sandbox/src/index.ts";
import { glassPage } from "./glass-page.ts";
import { buildImages } from "./images.ts";
import { checkPrefix, scratchArgs, scratchRunner } from "./scratch.ts";
import { bench } from "./vm.ts";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const STAND_IN = process.argv.includes("--stand-in");
const PREFIX = checkPrefix(flag("prefix") ?? "c1");
const ADVERTISE = flag("advertise") ?? (STAND_IN ? "127.0.0.1" : undefined);
if (!ADVERTISE) throw new Error("--advertise <this machine's tailnet address> is needed: the browser reaches the node there");
const PORT = Number(flag("port") ?? 47911);
// (The port after PORT is the node's own proxied listener, on loopback.)
const TIME_PORT = Number(flag("time-port") ?? PORT + 2);
const DIR = flag("dir") ?? (STAND_IN ? join(process.env.TMPDIR ?? "/tmp", "glass") : "/root/c1/glass");
const log = (line: string) => console.error(`glass-node: ${line}`);
process.env.INVINCIBLE_KEYSTORE = "file";

/** The node's own measure: none (a scratch node never runs the real benchmark on a shared machine). */
const measure = async (reason: string, body: unknown, limit: unknown) => {
  const threads = core.ceilingThreads(body as never, limit as never);
  return { at: Date.now(), tookMs: 1, reason, body: core.bodyFingerprint(body as never, limit as never), cpu: { single: core.REFERENCE_SINGLE, multi: core.REFERENCE_SINGLE * threads, threads, kernel: core.KERNEL }, memoryGbps: 9.5 };
};

if (process.argv.includes("--build") && !STAND_IN) {
  const built = await buildImages(bench(PREFIX, log));
  log(`images built in ${Math.round(built.ms / 1000)} s`);
}

mkdirSync(DIR, { recursive: true });
const home = new Home(mkdtempSync(join(DIR, "node-")));
const { identity, keystore } = await home.createIdentity("file");
const mind = new LedgerStore(home.ledgerPath);
const fleet = foundFleet(mind, identity, { fleetName: `${PREFIX}-glass`, nodeName: `${PREFIX}-glass` });
mind.close();
home.writeConfig({ v: 1, name: `${PREFIX}-glass`, fleet, port: PORT, keystore, advertise: ADVERTISE });

// The bench's names for everything the node runs: its runner's commands, and its held execs' too.
const standIn = STAND_IN ? await import("./glass-stand-in.ts") : null;
const caps = { os: "linux", arch: "x64", hostname: `${PREFIX}-glass`, cores: 8, cpu: "scratch", memoryGb: 16, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: false, vm: true } };
const daemon: Daemon = await startDaemon(home, {
  capabilities: caps as never,
  log: (line: string) => log(line),
  loopIntervalMs: 3_600_000,
  archiveIntervalMs: false,
  defaultHeartbeat: false,
  measure: measure as never,
  sandboxNetworks: false,
  docker: standIn ? standIn.docker() : scratchRunner(PREFIX),
  spawnSession: standIn ? standIn.spawnSession : (args) => spawnSession("docker")(scratchArgs(args, PREFIX)),
  spawnFrames: standIn ? standIn.spawnFrames(readFileSync(flag("frames") ?? "")) : (args) => spawnFrames("docker")(scratchArgs(args, PREFIX)),
});
const admin = async <T = any,>(route: string, input?: unknown): Promise<T> => {
  const r = (core.routes as Record<string, { method: string; path: string }>)[route]!;
  const response = await fetch(`http://127.0.0.1:${PORT}${r.path}`, { method: r.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, ...(r.method === "POST" ? { body: JSON.stringify(input ?? {}) } : {}) });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${route}: ${response.status} ${body.error ?? ""}`);
  return body;
};

let vm: { id: string } | null = null;
let timeServer: ReturnType<typeof Bun.serve> | null = null;
let stopping = false;
async function stop(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    if (vm) await admin("destroySandbox", { id: vm.id }).catch((error) => log(`its VM wasn't removed: ${(error as Error).message}`));
    timeServer?.stop(true);
    await daemon.stop();
  }
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  for (let i = 0; i < 500 && daemon.store.lww(`calibration:${daemon.identity.id}`) === null; i++) await Bun.sleep(20);
  // The agent and its VM: made isolated (no network, which the live node's would be), under the run its binding
  // takes it by, then bound as provisioning binds a VM it finds already made.
  await admin("saveAgent", { id: "glass", name: "Glass", role: "engineer" });
  const run = `arm.${core.teamArmLabel(daemon.identity.id, "glass")}`;
  vm = (await admin<{ sandbox: { id: string } }>("createSandbox", { network: "isolated", isolation: "vm", desktop: true, persistent: true, cpus: 1, memoryGb: 4, ttlMinutes: 240, run })).sandbox;
  await admin("provisionAgent", { id: "glass" });
  log(`its VM: ${vm.id}`);
  // The page on its screen, from its own disk; then the desktop given back, so watching starts with no hold.
  const page = Buffer.from(glassPage()).toString("base64");
  await admin("execSandbox", { id: vm.id, cmd: ["python3", "-I", "-c", "import base64,sys; open('/work/glass.html','wb').write(base64.b64decode(sys.argv[1]))", page] });
  await admin("teamDesktop", { id: "glass", action: { do: "open", address: "file:///work/glass.html" }, picture: false });
  await admin("teamDesktopRelease", { id: "glass" });

  // The VM's clock against this machine's: a held exec answers each line with its time (ns), the least round trip kept.
  const offset = standIn ? { ms: 0, boundMs: 0 } : await vmOffset(vm.id);
  log(`the VM's clock is ${offset.ms.toFixed(2)} ms ahead of this machine's (±${offset.boundMs.toFixed(2)})`);
  timeServer = Bun.serve({ hostname: ADVERTISE, port: TIME_PORT, fetch: () => Response.json({ now: Date.now() }) });

  // Where the browser pairs, approved as it comes for ten minutes (the first one: it is the harness's own browser).
  const endpoint = `http://${ADVERTISE}:${PORT}`;
  const invite = await admin<{ url: string; id: string }>("createInvite", { kind: "client", origin: endpoint, scopes: core.CLIENT_DEFAULT_SCOPES });
  const room = (await admin<{ room: { id: string } }>("directAgent", { id: "glass" })).room.id;
  console.log(JSON.stringify({ endpoint, invite: invite.url, room, agent: "glass", timeUrl: `http://${ADVERTISE}:${TIME_PORT}/`, vmOffsetMs: offset.ms, vmOffsetBoundMs: offset.boundMs, standIn: STAND_IN }));
  // (Only a pairing made from this invite, whose secret only the harness holds: no one else can begin one.)
  const until = Date.now() + 10 * 60_000;
  let approved = false;
  while (!approved && Date.now() < until) {
    const { pairings } = await admin<{ pairings: { invite: string; device: string }[] }>("pairings");
    const first = pairings.find((pairing) => pairing.invite === invite.id);
    if (first) {
      await admin("approvePairing", { invite: first.invite, device: first.device });
      log(`approved the harness's browser (${first.device.slice(0, 12)}…)`);
      approved = true;
    } else await Bun.sleep(200);
  }
  log("serving until stopped (Ctrl-C)");
  await new Promise(() => {});
} catch (error) {
  log((error as Error).message);
  await stop(1);
}

/** The VM's clock less this machine's, in ms: a held exec in it answers each line with its time; the least round trip's. */
async function vmOffset(id: string): Promise<{ ms: number; boundMs: number }> {
  const proc = Bun.spawn(["docker", ...scratchArgs(["exec", "--interactive", `invincible-sbx-${id}`, "python3", "-u", "-c", "import sys,time\nfor _ in sys.stdin: print(time.time_ns(), flush=True)"], PREFIX)], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let held = "";
  const line = async (): Promise<string> => {
    for (;;) {
      const at = held.indexOf("\n");
      if (at >= 0) {
        const out = held.slice(0, at);
        held = held.slice(at + 1);
        return out;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("the VM's clock didn't answer");
      held += decoder.decode(value, { stream: true });
    }
  };
  let best = { rtt: Infinity, ms: 0 };
  for (let i = 0; i < 40; i++) {
    // (The wall clock, as the VM's is: a process's own monotonic clock drifts from it.)
    const t0 = Date.now();
    proc.stdin.write("?\n");
    void proc.stdin.flush();
    const vmNs = BigInt(await line());
    const t1 = Date.now();
    if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, ms: Number(vmNs / 1000n) / 1000 - (t0 + t1) / 2 };
  }
  proc.kill();
  return { ms: best.ms, boundMs: best.rtt / 2 };
}
