import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, clientIdFromKey, type DoctorCheck, type DoctorReport, type FindingView, KERNEL, type LedgerEntry, type NoticeView, REFERENCE_SINGLE, type RouteName, routes, type Scope, signRequest, utf8 } from "@galahad/core";
import { requestPairing, waitForApproval } from "@galahad/link";
import { windowsOf } from "@galahad/brain";
import { foundFleet, MindStore } from "@galahad/mind";
import type { DockerRunner } from "@galahad/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { doctorCommand, reportLines, stoppedReport } from "../src/doctor-cli.ts";
import type { DoctorSystem } from "../src/doctor-facts.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * The doctor, end to end: a real daemon over real HTTP, with stand-ins for Docker, the
 * models, a connector's service and the machine itself (file modes, systemd, Tailscale,
 * the disk). A healthy node answers ok on every line; each fault the owner's server has
 * actually had gives its own line and advice; and the doctor changes nothing: a quick
 * look writes no event, a full one only the ledger lines every sandbox leaves.
 */

// (A machine with no KVM, said whole: its sandbox host makes no microVMs, whatever the machine running this test can.)
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "doctor-test", cores: 16, cpu: "test", memoryGb: 64, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: false } };

const root = mkdtempSync(join(tmpdir(), "galahad-doctor-"));
const home = new Home(join(root, "node"));
const port = freePort();
const proxyPort = freePort();
let daemon: Daemon;

/* ---------- stand-ins ---------- */

/** Docker: the fake, with an image that can go missing, and every command kept. */
const docker = fakeDocker();
const dockerCommands: string[] = [];
let imageGone = false;
const runner: DockerRunner = async (args, timeoutMs) => {
  dockerCommands.push(args[0]!);
  if (imageGone && args[0] === "image") return { code: 1, stdout: "", stderr: "No such image" };
  return docker.runner(args, timeoutMs);
};

/** The models: answer a word, or end the way a provider sometimes does. */
let modelMode: "ok" | "filter" | "refuse" = "ok";
const asked: string[] = [];
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { model: string };
    asked.push(body.model);
    if (modelMode === "refuse") return Response.json({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }, { status: 401 });
    const chunk = modelMode === "filter" ? { choices: [{ delta: {}, finish_reason: "content_filter" }] } : { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

/** A connector's service: what reached it. */
const reached: { path: string; auth: string | null; cookie: string | null }[] = [];
const service = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    reached.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), cookie: req.headers.get("cookie") });
    return new Response("not here", { status: 404 });
  },
});

/** The machine, as the doctor asks about it. */
const machine = {
  keyMode: 0o600 as number,
  timeSynced: "yes",
  firewall: "active",
  serve: () => JSON.stringify({ Web: { "ultra.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${proxyPort}` } } } } }),
  restarts: "0",
  backupAge: 6 * 60 * 60_000,
  disk: { freeGb: 400, totalGb: 1800 },
};
const ran: string[] = [];
const system: DoctorSystem = {
  file: (path) => ({ exists: true, mode: path.endsWith("keys.json") ? machine.keyMode : path.endsWith("admin.token") ? 0o600 : 0o700 }),
  run: async (cmd) => {
    ran.push(cmd.join(" "));
    if (cmd[0] === "timedatectl") return { code: 0, stdout: machine.timeSynced };
    if (cmd[0] === "systemctl" && cmd[1] === "is-active") return { code: machine.firewall === "active" ? 0 : 3, stdout: machine.firewall };
    if (cmd[0] === "systemctl" && cmd[1] === "cat") return { code: 0, stdout: "[Unit]" };
    if (cmd[0] === "systemctl" && cmd[1] === "show") return { code: 0, stdout: machine.restarts };
    if (cmd[0] === "tailscale") return { code: 0, stdout: machine.serve() };
    return null;
  },
  platform: "linux",
  underSystemd: true,
  disk: () => machine.disk,
  backups: (dir) => (dir.endsWith(join("node", "backups")) ? { exists: true, newestAt: Date.now() - machine.backupAge, files: 9 } : { exists: false, newestAt: null, files: 0 }),
  peerClock: async () => null,
  macFirewallFiles: () => null,
};

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 900, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL } };
};

/* ---------- callers ---------- */

type Caller = (name: RouteName, input?: unknown) => Promise<Response>;
const withToken =
  (token: () => string): Caller =>
  (name, input) => {
    const route = routes[name];
    return fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  };
const admin = withToken(() => home.adminToken());
const json = async <T = any>(response: Promise<Response> | Response): Promise<T> => {
  const r = await response;
  const body = (await r.json().catch(() => ({}))) as T & { error?: string; status?: number };
  if (!r.ok) throw new Error(`${r.status} ${body.error ?? ""}`);
  if (typeof body.error === "string" && typeof body.status === "number") throw new Error(`${body.status} ${body.error}`);
  return body;
};
const doctor = (input: { quick?: boolean; offline?: boolean } = {}) => json<DoctorReport>(admin("doctor", input));
const check = (report: DoctorReport, id: string): DoctorCheck => {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}; there are: ${report.checks.map((c) => c.id).join(", ")}`);
  return found;
};
/**
 * What isn't ok, but for two lines this test's machine can't help: no workspace helper (so no disk limit), and the
 * sandbox gateway's listener, which has no Docker bridge to bind (the node's log says so, and the doctor reads it).
 */
const HERE = new Set(["sandbox.disk", "service.log"]);
const notOk = (report: DoctorReport) => report.checks.filter((c) => (c.state === "needs-you" || c.state === "broken") && !HERE.has(c.id)).map((c) => `${c.id}: ${c.line}`);

async function pairDevice(name: string, scopes: Scope[]): Promise<Caller> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = await json<{ invite: string }>(admin("createInvite", { kind: "client", scopes }));
  const joining = await requestPairing(invite, { device: id, name, kind: "client" });
  const { pairings } = await json<{ pairings: { invite: string; device: string }[] }>(admin("pairings"));
  const mine = pairings.find((p) => p.device === id)!;
  await json(admin("approvePairing", { invite: mine.invite, device: mine.device }));
  await waitForApproval(joining, { intervalMs: 20 });
  return async (route, input) => {
    const r = routes[route];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(id, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    return fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined });
  };
}

async function until(done: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met in time");
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort, log: () => {}, loopIntervalMs: 60_000, docker: runner, measure, system, archiveIntervalMs: false });
  await json(admin("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` }));
  for (const role of ["planner", "engineer", "swift"]) await json(admin("setRoster", { role, models: ["stand-in/worker"] }));
  await json(admin("setRoster", { role: "reviewer", models: ["stand-in/judge"] }));
  await json(admin("setConnector", { id: "forge", manifest: { id: "forge", label: "Forge", origin: `http://127.0.0.1:${service.port}`, tools: { me: { description: "Who am I.", method: "GET", path: "/user", class: "read" } } } }));
  // A key in the vault, so there's a secret the doctor must never print.
  await json(admin("setSecret", { name: "stand-in-key", value: FAKE_KEY, provider: "other", baseUrl: "https://example.invalid/v1" }));
  await until(() => daemon.store.lww(`calibration:${daemon.identity.id}`) !== null);
});

afterAll(async () => {
  await daemon?.stop();
  models.stop(true);
  service.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("a healthy node", () => {
  test("the full check: every line ok, each distinct model asked one word, a sandbox started and removed, the connector probed with nothing", async () => {
    asked.length = 0;
    reached.length = 0;
    const execsBefore = docker.execs.length;
    const report = await doctor();
    expect(notOk(report)).toEqual([]);
    expect(report).toMatchObject({ node: "ultra", quick: false, offline: false });
    expect(report.tally.broken).toBe(0);
    // The line about its own log is the doctor reading a real node's log: only lines that read like trouble.
    const log = check(report, "service.log");
    if (log.state !== "ok") expect(log.line).toContain("sandbox gateway listener unavailable");
    // Four roles, two distinct models: each asked once.
    expect(asked.sort()).toEqual(["judge", "worker"]);
    expect(check(report, "role.planner").line).toBe("planner: stand-in/worker answered");
    expect(check(report, "role.planner").ms).toBeGreaterThanOrEqual(0);
    // The sandbox: started, ran `true`, removed; nothing is left running.
    expect(check(report, "sandbox.start.container")).toMatchObject({ state: "ok" });
    expect(docker.execs.slice(execsBefore).map((e) => e.cmd.join(" "))).toEqual(["true"]);
    expect(docker.running()).toBe(0);
    // The connector's service got one request, carrying nothing.
    expect(reached).toEqual([{ path: "/", auth: null, cookie: null }]);
    expect(check(report, "connector.forge").line).toContain("Forge answers at 127.0.0.1");
    // The machine, as it was asked.
    expect(check(report, "mind.integrity").state).toBe("ok");
    expect(check(report, "mind.clock").line).toContain("synchronised by the system");
    expect(check(report, "mind.backup").line).toContain("backed up 6 hours ago");
    expect(check(report, "app.published").line).toBe("published at https://ultra.tail1234.ts.net:8443");
    expect(check(report, "sandbox.firewall").state).toBe("ok");
    expect(check(report, "service.unit").line).toContain("systemd hasn't had to restart it");
    expect(check(report, "compute.calibration").state).toBe("ok");
    expect(check(report, "loop.heartbeat").state).toBe("ok");
    expect(check(report, "node.keys").line).toContain("only its own user can read");
    // No secret in any of it.
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
  });

  test("it changes nothing: a quick look writes no event; a full one only the ledger lines its sandbox leaves", async () => {
    const before = daemon.store.eventCount();
    const quick = await doctor({ quick: true });
    expect(quick.quick).toBe(true);
    expect(daemon.store.eventCount()).toBe(before);
    expect(check(quick, "mind.integrity").state).toBe("skipped");
    expect(check(quick, "sandbox.start").state).toBe("skipped");
    await doctor();
    const { entries } = await json<{ entries: LedgerEntry[] }>(admin("ledger"));
    const mine = entries.filter((e) => e.quest === "galahad.doctor");
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((e) => e.verdict))).toEqual(new Set(["allow"]));
    // Everything written since is one of those ledger lines.
    const written = daemon.store.eventCount() - before;
    const fresh = entries.filter((e) => e.quest === "galahad.doctor").length;
    expect(written).toBeLessThanOrEqual(fresh);
    expect((await json<{ sandboxes: unknown[] }>(admin("sandboxes", {}))).sandboxes).toEqual([]);
  });

  test("offline asks no model and probes no service, and says so; quick starts nothing", async () => {
    asked.length = 0;
    reached.length = 0;
    const offline = await doctor({ offline: true });
    expect(asked).toEqual([]);
    expect(reached).toEqual([]);
    expect(notOk(offline)).toEqual([]);
    expect(check(offline, "role.planner").line).toContain("not asked: offline");
    expect(check(offline, "connector.forge").line).toContain("not probed: offline");
    // The sandbox test stays: it sends nothing outward.
    expect(check(offline, "sandbox.start.container").state).toBe("ok");
    const runsBefore = dockerCommands.filter((c) => c === "run").length;
    await doctor({ quick: true });
    expect(asked).toEqual([]);
    expect(dockerCommands.filter((c) => c === "run").length).toBe(runsBefore);
  });

  test("the command prints the lines and exits 0; --json is the report", async () => {
    const api = { call: <T,>(name: RouteName, input?: unknown) => json<T>(admin(name, input)) };
    const lines: string[] = [];
    expect(await doctorCommand(api, { offline: true }, () => stoppedReport(home, "x"), (line) => lines.push(line))).toBeLessThan(2);
    expect(lines.some((l) => l.includes("broken"))).toBe(false);
    expect(lines[0]).toContain("Galahad's doctor on ultra · offline");
    expect(lines).toContain("The mind");
    expect(lines.some((l) => l.includes("ok        the mind's database passes SQLite's integrity check"))).toBe(true);
    const out: string[] = [];
    const code = await doctorCommand(api, { quick: true, json: true }, () => stoppedReport(home, "x"), (line) => out.push(line));
    const parsed = JSON.parse(out.join("\n")) as DoctorReport;
    // The exit code is the report's: 0 well, 1 needs you, 2 broken.
    expect(code).toBe(doctorExitOf(parsed));
    expect(parsed.checks.length).toBeGreaterThan(15);
    expect(parsed.tally.ok).toBeGreaterThan(10);
  });
});

describe("faults the owner's server has had, each with its own line and advice", () => {
  test("a provider on the roster with no key: the first model is skipped on every answer, and the heartbeat says so once", async () => {
    await json(admin("setProvider", { id: "keyless", kind: "openai", baseUrl: "https://example.invalid/v1" }));
    await json(admin("setRoster", { role: "planner", models: ["keyless/big", "unknown/other", "stand-in/worker"] }));
    try {
      const report = await doctor({ offline: true });
      const first = check(report, "role.planner.first");
      expect(first.state).toBe("needs-you");
      expect(first.line).toBe('planner\'s first model, keyless/big, is skipped on every answer (provider "keyless" has no key in the vault); stand-in/worker answers instead');
      expect(first.fix).toContain("galahad roster set planner stand-in/worker");
      expect(check(report, "role.planner").state).toBe("ok");
      expect(report.tally.broken).toBe(0);
      expect(doctorExitOf(report)).toBe(1);
      // The heartbeat's own look includes it (it had no such check), under a key that doesn't change.
      const { findings } = await json<{ findings: FindingView[] }>(admin("heartbeat", {}));
      const key = `doctor:role.planner.first:${daemon.identity.id}`;
      expect(findings.filter((f) => f.key === key).map((f) => f.severity)).toEqual(["info"]);
      // A beat raises it as a notice; the next beat, with nothing changed, writes nothing.
      await json(admin("runLoop", { name: "heartbeat" }));
      await until(async () => (await json<{ notices: NoticeView[] }>(admin("notices"))).notices.some((n) => n.key === key));
      await until(() => !daemon.loops.isRunning("heartbeat"));
      const events = daemon.store.eventCount();
      await json(admin("runLoop", { name: "heartbeat" }));
      await until(() => daemon.store.loopRuns("heartbeat", 5).length >= 2 && !daemon.loops.isRunning("heartbeat"));
      // Only the run's own record was written: no notice raised again.
      const since = daemon.store.eventCount() - events;
      expect(since).toBe(1);
    } finally {
      await json(admin("setRoster", { role: "planner", models: ["stand-in/worker"] }));
    }
    // Mended: the next beat clears it.
    await until(() => !daemon.loops.isRunning("heartbeat"));
    await json(admin("runLoop", { name: "heartbeat" }));
    await until(async () => !(await json<{ notices: NoticeView[] }>(admin("notices"))).notices.some((n) => n.key.startsWith("doctor:role.planner.first")));
  });

  test("a plan whose allowance is spent: its models are skipped until it resets, the doctor says until when, and so does the roster", async () => {
    await json(admin("setProvider", { id: "spentplan", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" }));
    await json(admin("setRoster", { role: "planner", models: ["spentplan/big", "stand-in/worker"] }));
    // What its provider said on the node's last call to it.
    windowsOf(daemon.store).note("spentplan", 'spentplan → 429 {"error":{"type":"GoUsageLimitError","message":"usage limit reached (5-hour, resets in 1h 37m)"}}');
    try {
      const report = await doctor({ offline: true });
      const spent = check(report, "models.spent.spentplan");
      expect(spent.state).toBe("ok");
      expect(spent.line).toMatch(/^spentplan's allowance is spent until \d\d:\d\d UTC \(1h 37m from now\), as its provider said: its models are passed over on every role until then$/);
      expect(report.checks.some((c) => c.id === "role.planner.first")).toBe(false);
      const { spent: windows } = await json<{ spent: { provider: string; until: number }[] }>(admin("roster"));
      expect(windows.map((w) => w.provider)).toEqual(["spentplan"]);
    } finally {
      await json(admin("setRoster", { role: "planner", models: ["stand-in/worker"] }));
    }
  });

  test("a VM's eyes on a coding plan its tools may use are well, not a model he lacks; on one for a tool you run yourself, they can't see", async () => {
    // Two plans with their keys in the vault (fakes, made here), as `galahad key add` leaves them.
    for (const id of ["opencode-go", "kimi-coding"]) {
      await json(admin("setSecret", { name: id, value: `FAKE-${id}-${"0".repeat(24)}`, provider: id }));
      await json(admin("setProvider", { id, secret: id }));
    }
    try {
      await json(admin("setRoster", { role: "eyes", models: ["opencode-go/gpt-6-luna"] }));
      const report = await doctor({ offline: true });
      expect(check(report, "role.eyes")).toMatchObject({ state: "ok", line: "eyes: opencode-go/gpt-6-luna looks at the VMs' screens, asked by their tools through the gateway (a coding plan: it is asked nothing else, so not a word)" });
      // Kimi Code is for interactive use only: a tool you run yourself, which a VM's tools are not.
      await json(admin("setRoster", { role: "eyes", models: ["kimi-coding/k3"] }));
      const blind = check(await doctor({ offline: true }), "role.eyes.plan");
      expect(blind.state).toBe("needs-you");
      expect(blind.fix).toBe("Hire a model a VM's tools may use: galahad roster set eyes <provider/model>.");
    } finally {
      await json(admin("setRoster", { role: "eyes", models: [] }));
      for (const id of ["opencode-go", "kimi-coding"]) {
        await json(admin("removeProvider", { id }));
        await json(admin("deleteSecret", { name: id }));
      }
    }
  });

  test("a reply ended by the provider's content filter, and a key the provider refuses (never printed)", async () => {
    modelMode = "filter";
    try {
      const report = await doctor();
      const reviewer = check(report, "role.reviewer");
      expect(reviewer.state).toBe("broken"); // the only reviewer
      expect(reviewer.line).toContain("stand-in/judge didn't answer");
      expect(reviewer.line).toContain("content filter");
      expect(reviewer.fix).toContain("Filters aren't steady");
      expect(doctorExitOf(report)).toBe(2);
    } finally {
      modelMode = "ok";
    }
    modelMode = "refuse";
    try {
      const report = await doctor();
      const planner = check(report, "role.planner");
      expect(planner.state).toBe("broken");
      expect(planner.line).toContain("401");
      expect(planner.fix).toContain("refused the key");
      expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(report)).not.toContain("FAKEFAKE");
    } finally {
      modelMode = "ok";
    }
  });

  test("the sandbox image pruned by another tool's cleanup: said, and nothing is rebuilt or started", async () => {
    imageGone = true;
    const before = dockerCommands.length;
    try {
      const report = await doctor({ offline: true });
      expect(check(report, "sandbox.image")).toMatchObject({ state: "needs-you" });
      expect(check(report, "sandbox.image").fix).toContain("galahad sandbox build");
      expect(check(report, "sandbox.start").line).toContain("the image is missing");
      const issued = dockerCommands.slice(before);
      expect(issued).not.toContain("build");
      expect(issued).not.toContain("run");
    } finally {
      imageGone = false;
    }
  });

  test("a clock that isn't synchronised, Tailscale not publishing the app, the firewall unit down, backups that stopped, restarts", async () => {
    Object.assign(machine, { timeSynced: "no", firewall: "inactive", serve: () => "{}", restarts: "4", backupAge: 20 * 24 * 60 * 60_000 });
    try {
      const report = await doctor({ quick: true });
      expect(check(report, "mind.clock")).toMatchObject({ state: "needs-you" });
      expect(check(report, "mind.clock").fix).toContain("timedatectl set-ntp true");
      expect(check(report, "app.published")).toMatchObject({ state: "needs-you" });
      expect(check(report, "app.published").fix).toContain("galahad expose");
      expect(check(report, "sandbox.firewall")).toMatchObject({ state: "broken" });
      expect(check(report, "mind.backup").line).toContain("20 days old");
      expect(check(report, "service.unit").line).toContain("restarted it 4 times");
      // The heartbeat's look takes these too, each once, as findings about this node.
      const { findings } = await json<{ findings: FindingView[] }>(admin("heartbeat", {}));
      const mine = findings.filter((f) => f.key.startsWith("doctor:")).map((f) => `${f.key.split(":")[1]} ${f.severity}`);
      expect(mine.sort()).toEqual(["app.published warn", "mind.backup info", "mind.clock warn", "sandbox.firewall warn", "service.unit info"]);
      expect(findings.filter((f) => f.key.startsWith("doctor:")).every((f) => f.node === daemon.identity.id)).toBe(true);
    } finally {
      Object.assign(machine, { timeSynced: "yes", firewall: "active", serve: () => JSON.stringify({ Web: { "ultra.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${proxyPort}` } } } } }), restarts: "0", backupAge: 6 * 60 * 60_000 });
    }
    expect(notOk(await doctor({ quick: true }))).toEqual([]);
  });

  test("a key file other users can read is broken; a full disk is broken", async () => {
    machine.keyMode = 0o644;
    machine.disk = { freeGb: 0.4, totalGb: 1800 };
    try {
      const report = await doctor({ quick: true });
      expect(check(report, "node.keys")).toMatchObject({ state: "broken" });
      expect(check(report, "node.keys").line).toContain("mode 644");
      expect(check(report, "disk.home")).toMatchObject({ state: "broken" });
    } finally {
      machine.keyMode = 0o600;
      machine.disk = { freeGb: 400, totalGb: 1800 };
    }
  });
});

describe("who may ask", () => {
  test("you at a terminal and a paired device that may administer; never an agent, never a device without fleet:admin", async () => {
    const phone = await pairDevice("phone", ["mind:read", "fleet:admin"]);
    const report = await json<DoctorReport>(phone("doctor", { quick: true }));
    expect(report.node).toBe("ultra");
    const tablet = await pairDevice("tablet", ["mind:read", "chat"]);
    expect((await tablet("doctor", { quick: true })).status).toBe(403);
    const { token } = await json<{ token: string }>(admin("mintArm", { label: "claude-code" }));
    const agent = withToken(() => token);
    const refused = await agent("doctor", { quick: true });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("fleet:admin");
    // And an agent can't be given the scope to try.
    expect((await admin("mintArm", { label: "sneaky", scopes: ["fleet:admin"] })).status).toBe(400);
    expect((await admin("doctor", { quick: true, extra: 1 })).status).toBe(400);
  });
});

describe("with no node running", () => {
  test("it says so, looks at what a stopped node leaves on disk, and exits 2", async () => {
    const stoppedHome = new Home(join(root, "stopped"));
    const { identity, keystore } = await stoppedHome.createIdentity("file");
    const store = new MindStore(stoppedHome.mindPath);
    const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "sleeper" });
    store.close();
    stoppedHome.writeConfig({ v: 1, name: "sleeper", fleet, port: freePort(), keystore, advertise: "127.0.0.1" });
    const lines: string[] = [];
    const code = await doctorCommand({ call: () => Promise.reject(new Error("no daemon on http://127.0.0.1:1 — start it with `galahad serve`")) }, {}, () => stoppedReport(stoppedHome, "http://127.0.0.1:1"), (line) => lines.push(line));
    expect(code).toBe(2);
    const text = lines.join("\n");
    expect(text).toContain("the node isn't running: nothing answers on http://127.0.0.1:1");
    expect(text).toContain("galahad serve");
    expect(text).toContain("the mind's database passes SQLite's integrity check");
    // Any other failure is the command's own, not "the node is down".
    await expect(doctorCommand({ call: () => Promise.reject(new Error("requires scope fleet:admin")) }, {}, () => stoppedReport(stoppedHome, "x"))).rejects.toThrow("fleet:admin");
    expect(reportLines(stoppedReport(stoppedHome, "x"), false)[0]).toContain("sleeper");
  });
});

function doctorExitOf(report: DoctorReport): 0 | 1 | 2 {
  return report.tally.broken ? 2 : report.tally.needsYou ? 1 : 0;
}
