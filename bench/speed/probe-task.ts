/*
 * A scratch node's background work, timed (speed baseline, 28 November 2026). Run as root on a sandbox host (Ultra), from
 * this checkout, beside a live node:
 *
 *   docker build -t <prefix>/sandbox:1 sandbox     # the bench's own workshop image, from this checkout
 *   bun bench/speed/probe-task.ts --prefix speed --isolation vm|container [--tasks 5] [--execs 30] [--idle 120]
 *       [--repo <git bundle>] [--extra <sandboxes>] [--grow <events>] [--dir <homes>] [--port 47640] [--out x.json]
 *
 * - Its sandboxes are the bench's (bench/desktop/scratch.ts): `<prefix>-sbx-*`, from `<prefix>/sandbox:1`, labelled
 *   `dev.<prefix>`, isolated (no network), never a live node's; whatever of them is left as it stops is removed. Its
 *   home is its own (under --dir, a temporary directory by default) and it listens on loopback alone, on ports of its
 *   own; no sidecar, no sandbox gateway, no networks.
 * - What it measures: a VM's making and first command; a command's round trip, bare, through the node's route, and in
 *   the form every agent command takes; git in a repository (--repo: a bundle cloned into the VM): a task's start, each
 *   step's checkpoint, its evidence and its changes; a task given to done, its first model call, its edit and how soon a
 *   client's live stream tells its end; a ledger event to that stream; and, with --idle, what the node costs at rest
 *   with no client and with one. The before and after of 28 November 2026's speed work were measured with it.
 * - Its models are stand-ins on loopback that answer at once (engineer: one bash call that writes a file, then DONE;
 *   reviewer: PASS), so what is timed is everything but a model.
 * - Every docker command the node runs is timed (start, duration, what), so a task's time is broken down by what it waited on.
 * - Linux only (/proc) for the idle samples.
 */
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { changesCommand, checkpointCommand, REPO_TASK_START, repositoryEvidence, withGateway } from "../../packages/agents/src/team-runtime.ts";
import { foundFleet, LedgerStore } from "../../packages/ledger/src/index.ts";
import { type Daemon, startDaemon } from "../../packages/node/src/daemon.ts";
import { Home } from "../../packages/node/src/home.ts";
import { checkPrefix, scratchArgs, scratchRunner, type Spawn, spawnDocker } from "../desktop/scratch.ts";
import { spawnSession } from "../../packages/sandbox/src/index.ts";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const PREFIX = checkPrefix(flag("prefix") ?? "speed");
const ISOLATION = (flag("isolation") ?? "vm") as "vm" | "container";
const TASKS = Number(flag("tasks") ?? 5);
const EXECS = Number(flag("execs") ?? 30);
const IDLE_S = Number(flag("idle") ?? 0);
const REPO = flag("repo");
const GROW = Number(flag("grow") ?? 0);
/** Plain runc sandboxes of the node's own made beside the agent's VM, as a busy node has others. */
const EXTRA = Number(flag("extra") ?? 0);
/** Commands each task's engineer runs before it says it is done (each a few lines of the task's trail). */
const STEPS = Math.max(1, Number(flag("steps") ?? 1));
/** Seconds the node stays up once measured, for what another process asks of it (--hold-info: where it says how to reach it). */
const HOLD_S = Number(flag("hold") ?? 0);
const HOLD_INFO = flag("hold-info");
const PORT = Number(flag("port") ?? 47640);
const DIR = flag("dir") ?? join(tmpdir(), "speed-probe");
const OUT = flag("out");
process.env.INVINCIBLE_KEYSTORE = "file";

const T0 = performance.now();
const now = () => performance.now() - T0;
const log = (line: string) => console.error(`[${(now() / 1000).toFixed(3)}] ${line}`);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---- every docker command, timed ----
type Call = { at: number; ms: number; what: string; code: number };
const calls: Call[] = [];
const summarize = (args: readonly string[]): string => {
  const [command] = args;
  if (command === "exec") {
    const i = args.findIndex((a, n) => n > 0 && !a.startsWith("-") && !["--workdir", "-w", "--env", "-e", "--user", "-u"].includes(args[n - 1]!));
    const rest = args.slice(i + 1).join(" ");
    const tag = /hello-[a-z0-9]+\.txt/.exec(rest)?.[0];
    const flags = args.slice(1, i).filter((a) => a.startsWith("-")).join(" ");
    // (The engineer's edit is the command that writes the file; the gate only tests it.)
    const kind = tag ? (rest.includes("printf hi >") ? `EDIT(${tag}) ` : `GATE(${tag}) `) : "";
    return `exec [${flags}] ${kind}${rest.replace(/\s+/g, " ").slice(0, 160)}`;
  }
  return args.slice(0, 4).join(" ").slice(0, 120);
};
const timedSpawn: Spawn = async (args, timeoutMs) => {
  const at = now();
  const ran = await spawnDocker(args, timeoutMs);
  calls.push({ at, ms: now() - at, what: summarize(args), code: ran.code });
  return ran;
};
const kindOf = (what: string) => (what.startsWith("exec") ? "exec" : what.split(" ").slice(0, 1).join(" "));

// ---- the stand-in models ----
type ModelCall = { at: number; model: string; tools: number; turns: number };
const modelCalls: ModelCall[] = [];
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: unknown }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    modelCalls.push({ at: now(), model: body.model, tools: body.tools?.length ?? 0, turns: turns.length });
    const tag = /TASK_([A-Z0-9]+)/.exec(JSON.stringify(turns))?.[1]?.toLowerCase() ?? "x";
    const sse = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    if (body.model === "reviewer") return sse({ content: "PASS\nThe gate passed after the work." });
    if (body.model === "planner") return sse({ content: "1. Write the file.\nDone when: the gate passes." });
    const worked = turns.some((m) => m.role === "assistant" || m.role === "tool");
    // (With --steps, the edit first, then commands that print a little each, as work does, then DONE.)
    const ran = turns.filter((m) => m.role === "tool").length;
    const command = ran === 0 ? `printf hi > hello-${tag}.txt` : `seq 1 ${(ran % 7) + 3} && echo step ${ran} of ${STEPS}`;
    if (body.tools?.length && ran < STEPS) return sse({ tool_calls: [{ index: 0, id: `c${ran + 1}`, function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
    return sse({ content: worked ? "DONE\nWritten: the gate passes." : "```sh\n" + command + "\n```" });
  },
});

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p90: r(at(0.9)), min: r(s[0]!), max: r(s.at(-1)!) };
}
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const results: Record<string, unknown> = { isolation: ISOLATION, prefix: PREFIX, at: new Date().toISOString(), loadAtStart: loadavg() };
const record = (name: string, samples: number[]) => {
  if (!samples.length) {
    results[name] = { n: 0 };
    console.log(`${name.padEnd(64)} no samples`);
    return;
  }
  const s = stats(samples);
  results[name] = s;
  console.log(`${name.padEnd(64)} p50 ${String(s.p50).padStart(9)} ms  p90 ${String(s.p90).padStart(9)} ms  (n ${s.n}, ${s.min}–${s.max})`);
};

// ---- this process's own cost, from /proc (Linux) ----
const TICK = 100; // USER_HZ
function self() {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  let voluntary = 0;
  let involuntary = 0;
  let threads = 0;
  for (const t of readdirSync("/proc/self/task")) {
    try {
      const st = readFileSync(`/proc/self/task/${t}/status`, "utf8");
      voluntary += Number(/^voluntary_ctxt_switches:\s+(\d+)/m.exec(st)?.[1] ?? 0);
      involuntary += Number(/^nonvoluntary_ctxt_switches:\s+(\d+)/m.exec(st)?.[1] ?? 0);
      threads++;
    } catch {
      /* a thread that ended */
    }
  }
  // (Fields after the command: state is f[0], so field n of proc(5) is f[n - 3].)
  return { cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / TICK, childMs: ((Number(f[13]) + Number(f[14])) * 1000) / TICK, rssMb: process.memoryUsage().rss / 2 ** 20, voluntary, involuntary, threads, at: now() };
}
async function idleWindow(name: string, seconds: number) {
  const before = self();
  const callsBefore = calls.length;
  await Bun.sleep(seconds * 1000);
  const after = self();
  const span = (after.at - before.at) / 1000;
  const mine = calls.slice(callsBefore);
  const byKind: Record<string, number> = {};
  for (const c of mine) byKind[kindOf(c.what)] = (byKind[kindOf(c.what)] ?? 0) + 1;
  const out = {
    seconds: Math.round(span),
    cpuPctOfCore: Math.round(((after.cpuMs - before.cpuMs) / (span * 1000)) * 10000) / 100,
    childCpuPctOfCore: Math.round(((after.childMs - before.childMs) / (span * 1000)) * 10000) / 100,
    ctxSwitchesPerSec: Math.round(((after.voluntary + after.involuntary - before.voluntary - before.involuntary) / span) * 10) / 10,
    rssMb: Math.round(after.rssMb),
    threads: after.threads,
    dockerCallsPerMin: Math.round((mine.length / span) * 60 * 10) / 10,
    dockerByKind: byKind,
    load: loadavg(),
  };
  results[name] = out;
  console.log(`${name}: ${JSON.stringify(out)}`);
  return out;
}

// ---- the node ----
mkdirSync(DIR, { recursive: true });
const home = new Home(mkdtempSync(join(DIR, "node-")));
const { identity, keystore } = await home.createIdentity("file");
const mind = new LedgerStore(home.ledgerPath);
const fleet = foundFleet(mind, identity, { fleetName: `${PREFIX}-probe`, nodeName: `${PREFIX}-probe` });
if (GROW > 0) {
  // A log grown as a working node's grows: every gated command is a ledger line (sandbox.exec), signed and kept.
  const g0 = now();
  for (let i = 0; i < GROW; i++) mind.emit(identity, "ledger.recorded", { class: "modify", resource: "sandbox.exec", target: "speed-sbx-0000000000", verdict: "allow", run: "arm.x", detail: `bash -lc python3 -I -c … printf ${i} > f-${i}.txt → exit 0` });
  results["grow.emit(ms total)"] = Math.round(now() - g0);
  results["grow.events"] = GROW;
}
mind.close();
home.writeConfig({ v: 1, name: `${PREFIX}-probe`, fleet, port: PORT, keystore, advertise: "127.0.0.1" });
const measure = async (reason: string, body: unknown, limit: unknown) => {
  const threads = core.ceilingThreads(body as never, limit as never);
  return { at: Date.now(), tookMs: 1, reason, body: core.bodyFingerprint(body as never, limit as never), cpu: { single: core.REFERENCE_SINGLE, multi: core.REFERENCE_SINGLE * threads, threads, kernel: core.KERNEL }, memoryGbps: 9.5 };
};
const caps = { os: "linux", arch: "x64", hostname: `${PREFIX}-probe`, cores: 32, cpu: "scratch", memoryGb: 64, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker", "git"], localModels: [], tailscale: null, sandbox: { image: true, networks: false, vm: ISOLATION === "vm" } };
const s0 = now();
const daemon: Daemon = await startDaemon(home, {
  capabilities: caps as never,
  log: (line: string) => log(`node: ${line}`),
  loopIntervalMs: 3_600_000,
  archiveIntervalMs: false,
  defaultHeartbeat: false,
  backups: false,
  sidecar: false,
  measure: measure as never,
  sandboxNetworks: false,
  proxyPort: PORT + 1,
  docker: scratchRunner(PREFIX, timedSpawn),
  spawnSession: (args) => spawnSession("docker")(scratchArgs(args, PREFIX)),
});
results["node.start(ms, startDaemon in-process, given caps)"] = Math.round(now() - s0);
log(`node up in ${Math.round(now() - s0)} ms`);

const admin = async <T = any,>(route: string, input?: unknown): Promise<T> => {
  const r = (core.routes as Record<string, { method: string; path: string }>)[route]!;
  const response = await fetch(`http://127.0.0.1:${PORT}${r.path}`, { method: r.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, ...(r.method === "POST" ? { body: JSON.stringify(input ?? {}) } : {}) });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!response.ok) throw new Error(`${route}: ${response.status} ${body.error ?? text.slice(0, 300)}`);
  return body;
};

// ---- a client's live stream, as the apps hold one ----
type LiveMsg = { at: number; type: string; topics: string[] };
const liveMsgs: LiveMsg[] = [];
let liveAbort: AbortController | null = null;
async function openLive(): Promise<void> {
  liveAbort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${PORT}/api/live`, { headers: { authorization: `Bearer ${home.adminToken()}` }, signal: liveAbort.signal });
  if (!response.ok || !response.body) throw new Error(`live: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let held = "";
  let helloed!: () => void;
  const hello = new Promise<void>((resolve) => (helloed = resolve));
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        held += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = held.indexOf("\n\n")) >= 0) {
          const frame = held.slice(0, cut);
          held = held.slice(cut + 2);
          if (!frame.startsWith("data: ")) continue;
          const msg = JSON.parse(frame.slice(6)) as { type: string; topics?: string[]; changed?: string[] };
          liveMsgs.push({ at: now(), type: msg.type, topics: msg.topics ?? msg.changed ?? [] });
          if (msg.type === "hello") helloed();
        }
      }
    } catch {
      /* closed */
    }
  })();
  await hello;
}
const closeLive = () => liveAbort?.abort();
const nextLive = async (topic: string, after: number, timeoutMs = 5000): Promise<number | null> => {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const found = liveMsgs.find((m) => m.type === "changed" && m.at >= after && m.topics.includes(topic));
    if (found) return found.at;
    await Bun.sleep(1);
  }
  return null;
};

const made: string[] = [];
let stopping = false;
async function stop(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    closeLive();
    for (const id of made) await admin("destroySandbox", { id }).catch((error) => log(`VM ${id} wasn't removed: ${(error as Error).message}`));
    await daemon.stop().catch(() => {});
    // (A sandbox the node was still making as it stopped, one that waited for a slot this stop freed, is removed too:
    // everything labelled as this node's, by the bench's own names.)
    const left = await spawnDocker(["ps", "-aq", "--filter", `label=dev.${PREFIX}.node=${daemon.identity.id}`], 30_000);
    for (const id of left.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) await spawnDocker(["rm", "-f", "--volumes", id], 60_000);
    models.stop(true);
    rmSync(home.dir, { recursive: true, force: true });
  }
  process.exit(code);
}
process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(143));

const series = async (name: string, f: () => Promise<unknown>, n = EXECS) => {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    await f();
    samples.push(now() - t0);
  }
  record(name, samples);
  return samples;
};

try {
  for (let i = 0; i < 500 && daemon.store.lww(`calibration:${daemon.identity.id}`) === null; i++) await Bun.sleep(20);
  await admin("setProvider", { id: "standin", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer"]) await admin("setRoster", { role, models: [`standin/${role}`] });
  results["node.rss.after-start(MB)"] = Math.round(process.memoryUsage().rss / 2 ** 20);

  // ---- 0. A ledger event to a client's stream (the mind's event pokes the stream; it is read 15 ms after) ----
  await openLive();
  const ledgerToLive: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = now();
    daemon.store.emit(daemon.identity, "notice.raised", { key: `speed:${i}`, severity: "info", title: `probe ${i}`, body: "a probe's notice", source: "sandbox", at: Date.now() });
    const seen = await nextLive("notices", t0);
    if (seen !== null) ledgerToLive.push(seen - t0);
    await Bun.sleep(300 + ((i * 37) % 250));
  }
  record("live.ledger-event→client (notice.raised, poked)", ledgerToLive);

  // ---- 1. A VM's provisioning: made, first command answered, removed ----
  const created: number[] = [];
  const firstExec: number[] = [];
  const destroyed: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = now();
    const { sandbox } = await admin<{ sandbox: { id: string } }>("createSandbox", { network: "isolated", isolation: ISOLATION, ttlMinutes: 30 });
    created.push(now() - t0);
    const t1 = now();
    await admin("execSandbox", { id: sandbox.id, cmd: ["true"], timeoutSec: 60 });
    firstExec.push(now() - t1);
    const t2 = now();
    await admin("destroySandbox", { id: sandbox.id });
    destroyed.push(now() - t2);
  }
  record(`vm.create (${ISOLATION}, isolated, via route)`, created);
  record(`vm.first-exec (${ISOLATION})`, firstExec);
  record(`vm.destroy (${ISOLATION})`, destroyed);

  // ---- 2. The VM the rest runs in: an agent's (Kata), or a plain persistent one (runc: an agent's VM is a microVM) ----
  let vm: { id: string };
  if (ISOLATION === "vm") {
    await admin("saveAgent", { id: "probe", name: "Probe", role: "engineer" });
    const run = `arm.${core.teamArmLabel(daemon.identity.id, "probe")}`;
    const p0 = now();
    vm = (await admin<{ sandbox: { id: string } }>("createSandbox", { network: "isolated", isolation: ISOLATION, persistent: true, ttlMinutes: 240, run })).sandbox;
    made.push(vm.id);
    results["agent.vm.create(ms)"] = Math.round(now() - p0);
    const p1 = now();
    await admin("provisionAgent", { id: "probe" });
    results["agent.provision(ms)"] = Math.round(now() - p1);
  } else {
    vm = (await admin<{ sandbox: { id: string } }>("createSandbox", { network: "isolated", isolation: ISOLATION, persistent: true, ttlMinutes: 240 })).sandbox;
    made.push(vm.id);
  }
  const container = `${PREFIX}-sbx-${vm.id}`;
  log(`VM ${container} ready`);
  for (let i = 0; i < EXTRA; i++) made.push((await admin<{ sandbox: { id: string } }>("createSandbox", { network: "isolated", isolation: "container", cpus: 1, memoryGb: 1, ttlMinutes: 30 })).sandbox.id);
  results["extra sandboxes beside it"] = EXTRA;

  // ---- 3. An exec's round trip: the floor, the route, and the form every agent command takes ----
  await series(`exec.docker-direct true (${ISOLATION})`, () => spawnDocker(["exec", container, "true"], 60_000));
  await series(`exec.docker-direct -i true (${ISOLATION})`, () => spawnDocker(["exec", "-i", container, "true"], 60_000));
  await series("exec.docker info (each exec's listing starts with it)", () => spawnDocker(["info", "--format", "{{.ServerVersion}}"], 60_000));
  await series("exec.docker ps -aq --filter label (the listing's second)", () => spawnDocker(["ps", "-aq", "--filter", `label=dev.${PREFIX}=1`], 60_000));
  const callsBeforeRoute = calls.length;
  await series("exec.route true", () => admin("execSandbox", { id: vm.id, cmd: ["true"], timeoutSec: 60 }));
  results["exec.route true: docker calls per exec"] = Math.round(((calls.length - callsBeforeRoute) / EXECS) * 10) / 10;
  await series("exec.route bash -lc true", () => admin("execSandbox", { id: vm.id, cmd: ["bash", "-lc", "true"], timeoutSec: 60 }));
  await series("exec.route bash -lc withGateway(true) (every agent command)", () => admin("execSandbox", { id: vm.id, cmd: ["bash", "-lc", withGateway("true")], timeoutSec: 60 }));
  // Inside the VM alone: what a login shell and python's start cost there.
  const inside = await spawnDocker(["exec", container, "bash", "-c", "s=$(date +%s%N); for i in 1 2 3 4 5 6 7 8 9 10; do bash -lc true; done; m=$(date +%s%N); for i in 1 2 3 4 5 6 7 8 9 10; do python3 -I -c pass; done; e=$(date +%s%N); for i in 1 2 3 4 5 6 7 8 9 10; do bash -c true; done; f=$(date +%s%N); echo $(( (m-s)/10000000 )) $(( (e-m)/10000000 )) $(( (f-e)/10000000 ))"], 120_000);
  const [loginMs, pythonMs, plainMs] = inside.stdout.trim().split(/\s+/).map(Number);
  results["vm.inside: bash -lc true (ms each)"] = loginMs;
  results["vm.inside: python3 -I -c pass (ms each)"] = pythonMs;
  results["vm.inside: bash -c true (ms each)"] = plainMs;
  console.log(`inside the VM: bash -lc true ${loginMs} ms · python3 -I -c pass ${pythonMs} ms · bash -c true ${plainMs} ms (each, mean of 10)`);

  // ---- 4. Git in a repository the agent was handed: its clone, a task's start, each step's checkpoint, its changes ----
  if (REPO) {
    const cp = await spawnDocker(["cp", REPO, `${container}:/work/repo.bundle`], 120_000);
    if (cp.code !== 0) throw new Error(`docker cp: ${cp.stderr}`);
    const run = (cmd: string) => admin<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>("execSandbox", { id: vm.id, cmd: ["bash", "-lc", cmd], timeoutSec: 600 });
    const timed = async (name: string, cmd: string) => {
      const t0 = now();
      const r = await run(cmd);
      const ms = now() - t0;
      results[name] = { ms: Math.round(ms), exit: r.exitCode, inVmMs: r.durationMs };
      console.log(`${name.padEnd(64)} ${Math.round(ms)} ms (exit ${r.exitCode})${r.exitCode ? ` ${(r.stderr || r.stdout).slice(-200)}` : ""}`);
      return r;
    };
    await timed("git.clone (local, from a bundle in the VM)", "rm -rf /work/repo && git clone -q -b speed-baseline /work/repo.bundle /work/repo && git -C /work/repo ls-files | wc -l");
    const files = (await run("git -C /work/repo ls-files | wc -l; du -sh /work/repo/.git | cut -f1")).stdout.trim().replace(/\n/g, " files, .git ");
    results["git.repo"] = files;
    for (let t = 0; t < 3; t++) {
      const task = `task-speed${t}`;
      const root = `/work/tasks/${task}`;
      const start = await timed(`git.task-start #${t} (REPO_TASK_START: worktree, base kept)`, `python3 -I -c ${quote(REPO_TASK_START)} ${quote(root)} ${quote(`/work/.agent/base/${task}`)}`);
      const [base = ""] = start.stdout.trim().split(/\s+/);
      let last = "";
      for (let step = 1; step <= 3; step++) {
        await run(`cd ${quote(root)} && printf 'step ${step}\\n' >> README.md && printf 'x${step}' > new-${step}.txt`);
        const kept = await timed(`git.checkpoint task ${t} step ${step}`, checkpointCommand(root, task, step, last));
        const line = kept.stdout.trim().split("\n").at(-1) ?? "";
        const m = /^([0-9a-f]{40}) ([0-9a-f]{40} [0-9a-f]{40})$/.exec(line);
        if (m) last = m[2]!;
      }
      await timed(`git.checkpoint task ${t} unchanged ("same")`, checkpointCommand(root, task, 4, last));
      for (const e of repositoryEvidence(base)) await timed(`git.evidence task ${t}: ${e.shown.slice(0, 30)}`, `cd ${quote(root)} && ${e.run}`);
      await timed(`git.changes task ${t} (patch + shipment: the bring-back)`, `cd ${quote(root)} && ${changesCommand(`/work/.agent/out/${task}`, base)}`);
    }
    // The same checkpoint straight through docker exec (no route, no login shell), and its parts, inside the VM: what is
    // git's, what is python's, and what is the node's path to the VM.
    const root = "/work/tasks/task-speed0";
    const inVm = async (name: string, script: string, n = 10) => {
      const r = await spawnDocker(["exec", container, "bash", "-c", `cd ${quote(root)} && s=$(date +%s%N); for i in $(seq 1 ${n}); do ${script} >/dev/null 2>&1; done; e=$(date +%s%N); echo $(( (e-s)/(${n}*1000000) ))`], 300_000);
      const ms = Number(r.stdout.trim());
      results[`git.in-vm: ${name} (ms each)`] = ms;
      console.log(`${`git.in-vm: ${name}`.padEnd(64)} ${ms} ms each (mean of ${n}, inside the VM)`);
    };
    await spawnDocker(["exec", container, "bash", "-c", `cd ${quote(root)} && printf 'more\\n' >> README.md`], 60_000);
    await inVm("the whole checkpoint script (python + held git)", checkpointCommand(root, "task-speed0", 9, ""));
    await inVm("python3 -I -c with HELD_GIT's imports", `python3 -I -c 'import json,os,re,shutil,subprocess,sys'`);
    await inVm("git config --list -z --name-only (before each held git)", "git config --list -z --name-only");
    await inVm("git rev-parse HEAD", "git rev-parse HEAD");
    await inVm("git status --short (a stat of the tree)", "git status --short");
    await inVm("GIT_INDEX_FILE=copy git add -A . (the step's add)", "cp .git/index /tmp/speed.index 2>/dev/null || cp $(git rev-parse --git-path index) /tmp/speed.index; GIT_INDEX_FILE=/tmp/speed.index git add -A .");
    await series("git.route: the checkpoint through the node (bash -lc, as the runtime runs it)", () => run(checkpointCommand(root, "task-speed0", 9, "")), 10);
  }

  // ---- 5. Tasks: give → first model call → the edit in the VM → done; and how soon a client's stream says it ----
  if (ISOLATION === "vm") {
    const timelines: Record<string, unknown>[] = [];
    const toFirstModel: number[] = [];
    const toEdit: number[] = [];
    const toDone: number[] = [];
    const liveLag: number[] = [];
    for (let i = 0; i < TASKS; i++) {
      const tag = `p${i}`;
      const callsBefore = calls.length;
      const modelsBefore = modelCalls.length;
      const t0 = now();
      const given = await admin<{ task: { id: string } }>("giveTeamTask", { goal: `TASK_${tag.toUpperCase()}: write hello-${tag}.txt`, gates: [`test -f hello-${tag}.txt`] });
      const id = given.task.id;
      let status = "";
      let reads = 0;
      let doneSeen = 0;
      for (let n = 0; n < 60_000; n++) {
        const team = await admin<{ tasks: { id: string; status: string }[] }>("team");
        reads++;
        status = team.tasks.find((t) => t.id === id)?.status ?? "";
        if (status === "done" || status === "failed" || status === "stopped") {
          doneSeen = now();
          break;
        }
        await Bun.sleep(5);
      }
      const t1 = doneSeen || now();
      // (The stream's look comes at most LOOK_MS after the change: a task's own progress pokes nothing.)
      const told = await nextLive("team", t1 - 10, 3000);
      if (told !== null) liveLag.push(told - t1);
      const mine = calls.slice(callsBefore);
      const modelsMine = modelCalls.slice(modelsBefore);
      const edit = mine.find((c) => c.what.includes(`EDIT(hello-${tag}.txt)`));
      toDone.push(t1 - t0);
      if (modelsMine[0]) toFirstModel.push(modelsMine[0].at - t0);
      if (edit) toEdit.push(edit.at + edit.ms - t0);
      const execs = mine.filter((c) => c.what.startsWith("exec"));
      const other = mine.filter((c) => !c.what.startsWith("exec"));
      timelines.push({
        task: id,
        status,
        totalMs: Math.round(t1 - t0),
        firstModelMs: modelsMine[0] ? Math.round(modelsMine[0].at - t0) : null,
        editDoneMs: edit ? Math.round(edit.at + edit.ms - t0) : null,
        liveToldMs: told !== null ? Math.round(told - t1) : null,
        modelCalls: modelsMine.map((m) => ({ atMs: Math.round(m.at - t0), model: m.model, tools: m.tools, turns: m.turns })),
        dockerCalls: mine.length,
        execs: execs.length,
        execMs: Math.round(execs.reduce((a, c) => a + c.ms, 0)),
        otherDocker: other.length,
        otherDockerMs: Math.round(other.reduce((a, c) => a + c.ms, 0)),
        reads,
        timeline: mine.map((c) => ({ atMs: Math.round(c.at - t0), ms: Math.round(c.ms), code: c.code, what: c.what })),
      });
      log(`task ${i} (${id}): ${status} in ${Math.round(t1 - t0)} ms · first model call ${modelsMine[0] ? Math.round(modelsMine[0].at - t0) : "-"} ms · edit done ${edit ? Math.round(edit.at + edit.ms - t0) : "-"} ms · told on the stream ${told !== null ? Math.round(told - t1) : "-"} ms after · ${mine.length} docker calls (${execs.length} execs, ${Math.round(execs.reduce((a, c) => a + c.ms, 0))} ms)`);
      await Bun.sleep(200 + ((i * 53) % 250));
    }
    record("task.give→first-model-call", toFirstModel);
    record("task.give→edit-done-in-vm", toEdit);
    record("task.give→done (route polled every 5 ms)", toDone);
    record("live.task-done→client (team, not poked: the 250 ms look)", liveLag);
    results.timelines = timelines;
  }

  // ---- 6. Idle: what the node costs while nothing happens, with no client and with one client's stream ----
  if (IDLE_S > 0) {
    closeLive();
    await Bun.sleep(2000);
    await idleWindow("idle.no-client", IDLE_S);
    await openLive();
    await idleWindow("idle.one-live-client", IDLE_S);
    closeLive();
  }
  results["node.rss.end(MB)"] = Math.round(process.memoryUsage().rss / 2 ** 20);
  results.loadAtEnd = loadavg();
  // ---- 7. Held up for another process to ask (a client's polling, timed from outside: bench/speed/poll.ts) ----
  if (HOLD_S > 0) {
    const tasks = ((await admin<{ tasks: { id: string; status: string }[] }>("team")).tasks ?? []).map((t) => t.id);
    if (HOLD_INFO) await Bun.write(HOLD_INFO, JSON.stringify({ pid: process.pid, port: PORT, token: home.adminToken(), tasks }));
    log(`held for ${HOLD_S} s: pid ${process.pid}, port ${PORT}, ${tasks.length} task(s)`);
    await Bun.sleep(HOLD_S * 1000);
  }
} catch (error) {
  console.error(`probe failed: ${(error as Error).stack ?? error}`);
  results.error = String((error as Error).message ?? error);
} finally {
  results.allDockerCalls = calls.length;
  if (OUT) await Bun.write(OUT, `${JSON.stringify(results, null, 2)}\n`);
  await stop(results.error ? 1 : 0);
}
