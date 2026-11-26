import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, ceilingThreads, KERNEL, REFERENCE_SINGLE, type RouteName, routes, type TeamSnapshot } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../../src/capabilities.ts";
import { type Daemon, startDaemon } from "../../src/daemon.ts";
import { Home } from "../../src/home.ts";
import { fakeDocker } from "../fake-docker.ts";
import { freePort } from "../ports.ts";

/*
 * inv, end to end, against a node of its own (docs/CLI.md): the real command, as a process, paired as a client of a
 * throwaway node in a temporary home, signing every request with its own key. The node is the real daemon with its own
 * stand-ins for Docker and the models, as the team's VM test has them. Its tasks really run: the gate fails before the
 * work and passes after it, and the reviewer passes it. Never ~/.invincible, never a keychain.
 */

const root = mkdtempSync(join(tmpdir(), "inv-e2e-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "inv-e2e", cores: 16, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const docker = fakeDocker();
const written = new Set<string>();
let releaseHold: (() => void) | undefined;
let holdEntered = false;
const hold = new Promise<void>((resolve) => (releaseHold = resolve));
/** The task inv steers: its command runs in its VM until it's let go (`write-steer`). */
let releaseSteer: (() => void) | undefined;
let steerEntered = false;
const steerHold = new Promise<void>((resolve) => (releaseSteer = resolve));
const posts: unknown[] = [];
let daemon: Daemon;

// The models: a plan, one command of the engineer's that writes the task's file, then DONE; the reviewer passes it.
const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
  const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: string }[] };
  const turns = body.messages.filter((message) => message.role !== "system");
  const tag = /TASK_([A-Z]+)/.exec(JSON.stringify(turns[0]?.content ?? ""))?.[1] ?? "UNKNOWN";
  const reply = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  if (body.model === "engineer") {
    const command = `printf '%s' ${tag} > result.txt # write-${tag.toLowerCase()}`;
    if (body.tools?.length && !turns.some((message) => message.role === "assistant")) return reply({ tool_calls: [{ index: 0, id: "call_work", function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
    return reply({ content: turns.some((message) => message.role === "assistant") ? `DONE\nWrote result.txt for ${tag}.` : `\`\`\`sh\n${command}\n\`\`\`` });
  }
  if (body.model === "reviewer") return reply({ content: "PASS\nThe gate failed before the work and passes now." });
  return reply({ content: "1. Write result.txt.\n2. Run the gate.\nDone when: the gate and the review pass." });
} });
// Where an approved outward call goes: a stand-in for a service of yours.
const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
  posts.push(await request.json().catch(() => null));
  return Response.json({ ok: true });
} });

async function api<T = any>(name: RouteName, input?: unknown, token = home.adminToken()): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${name}: ${response.status} ${body.error}`);
  return body;
}
async function until(condition: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error("not in time");
}

/** inv itself, as a process: its own home, the key in a file, and nothing of this machine's own homes. */
const cli = (name: string) => ({ INVINCIBLE_CLI_HOME: join(root, name), INVINCIBLE_HOME: join(root, "no-node-here"), INVINCIBLE_KEYSTORE: "file", HOME: root, NO_COLOR: "1", PATH: process.env.PATH ?? "" });
const MAIN = join(import.meta.dir, "../../src/inv/main.ts");
function inv(env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const done = (async () => ({ code: await proc.exited, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() }))();
  return { proc, done };
}
const run = async (env: Record<string, string>, ...args: string[]) => inv(env, ...args).done;
const json = (out: string) => JSON.parse(out.trim().split("\n").at(-1)!);
const me = cli("laptop");

/** Pairs a CLI home with the node, as the owner would: an invite, the code compared, approved (or refused). */
async function pair(env: Record<string, string>, approve: boolean) {
  const { invite } = await api<{ invite: string }>("createInvite", { kind: "client" });
  const pairing = inv(env, "pair", invite, "--name", "e2e laptop", "--json");
  let pending: { invite: string; device: string; sas: string } | undefined;
  await until(async () => (pending = (await api<{ pairings: { invite: string; device: string; sas: string; name: string }[] }>("pairings")).pairings.find((p) => p.name === "e2e laptop")) !== undefined);
  await api(approve ? "approvePairing" : "rejectPairing", { invite: pending!.invite, device: pending!.device });
  return { ...(await pairing.done), pending: pending! };
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "inv-e2e", nodeName: "keep" });
  mind.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  docker.onExec = async (_container, command) => {
    const text = command.join("\n");
    const wrote = /# write-([a-z]+)/.exec(text)?.[1];
    if (wrote === "hold") {
      holdEntered = true;
      await hold;
    }
    if (wrote === "steer") {
      steerEntered = true;
      await steerHold;
    }
    if (wrote) written.add(wrote);
    const gate = /# gate-([a-z]+)/.exec(text)?.[1];
    if (gate) return written.has(gate) ? { code: 0, stdout: "required gate passed" } : { code: 1, stdout: "result.txt is missing" };
    return { code: 0, stdout: "command completed" };
  };
  daemon = await startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: () => {},
    docker: docker.runner,
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 100,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
    backups: false,
  });
  await until(() => daemon.store.lww(`calibration:${daemon.identity.id}`) !== null);
  await api("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer"]) await api("setRoster", { role, models: [`stand-in/${role}`] });
  await api("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  await api("setConnector", { id: "forge", manifest: { id: "forge", label: "Forge", origin: `http://127.0.0.1:${service.port}`, auth: { secret: "forge", scheme: "bearer" }, tools: { post: { description: "Post publicly.", method: "POST", path: "/posts", params: { text: { type: "string", required: true } }, class: "outward" } } } });
  await api("setSecret", { name: "forge", value: "fake-forge-token-for-inv-tests", connector: "forge" });
}, 30_000);

afterAll(async () => {
  releaseHold?.();
  releaseSteer?.();
  await daemon?.stop();
  model.stop(true);
  service.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("inv against a node of its own", () => {
  test("inv pair: the code it shows is the node's for this device; approved, it is a client that signs with its own key, kept 0600", async () => {
    const paired = await pair(me, true);
    expect([paired.code, paired.err]).toEqual([0, expect.stringContaining(`Code: ${paired.pending.sas}`)]);
    expect(paired.err).toContain(`invincible approve ${paired.pending.invite} ${paired.pending.device}`);
    expect(json(paired.out)).toEqual({ node: `http://127.0.0.1:${port}`, nodeName: "keep", fleet: daemon.store.fleet, device: paired.pending.device, name: "e2e laptop", paired: true });
    expect(statSync(join(me.INVINCIBLE_CLI_HOME, "key.json")).mode & 0o777).toBe(0o600);
    // The pairing holds no secret: the key is apart from it.
    expect(readFileSync(join(me.INVINCIBLE_CLI_HOME, "cli.json"), "utf8")).not.toContain('"d"');
    const device = daemon.store.activeDevice(paired.pending.device);
    expect(device).toMatchObject({ kind: "client", name: "e2e laptop" });
    // Asked again, it says what it is paired with.
    expect(json((await run(me, "pair", "--json")).out)).toMatchObject({ paired: true, nodeName: "keep" });
  }, 30_000);

  /** The shortest end of a task's id, six characters at least, that doesn't begin with "-". */
  const shortId = (id: string): string => {
    for (let n = 6; n < id.length - 5; n++) if (!id.slice(-n).startsWith("-")) return id.slice(-n);
    return id;
  };
  let verifiedTask = "";
  test("inv give --gate --wait: the task runs on the node, its gate fails before the work and passes after it, and it exits 0 with the proof", async () => {
    const given = await run(me, "give", "TASK_ONE: write result.txt", "--agent", "ada", "--gate", "test -f result.txt # gate-one", "--budget", "2", "--wait", "--json");
    expect([given.code, given.err]).toEqual([0, ""]);
    const proof = json(given.out);
    verifiedTask = proof.task;
    expect(proof).toMatchObject({ v: 1, state: "verified", exit: 0, word: "Verified", agent: "ada", node: "keep", budgetUsd: 2, review: { verdict: "pass", sameModel: false } });
    expect(proof.gates).toEqual([expect.objectContaining({ cmd: "test -f result.txt # gate-one", exit: 0, before: 1, failedBefore: true })]);
    // inv proof says the same, and its exit code is the verdict.
    const again = await run(me, "proof", verifiedTask, "--json");
    expect([again.code, json(again.out).state]).toEqual([0, "verified"]);
    // (Its id's end, as you would type it: never one that begins with "-", which any command reads as a flag. Task ids
    // hold "-", so its last six alone began with one in about one run of 38: 26 November 2026, exit 2.)
    const text = await run(me, "proof", shortId(verifiedTask));
    expect(text.code).toBe(0);
    expect(text.out).toContain("Verified · by its gates and a reviewer that didn't do the work");
    expect(text.out).toContain("failed before the work: it shows the work ✓");
  }, 60_000);

  test("the board and the lists, piped and as JSON, in the apps' words", async () => {
    const board = await run(me);
    expect(board.code).toBe(0);
    expect(board.out).toMatch(/^Invincible · /);
    expect(board.out).toContain("Verified  TASK_ONE: write result.txt");
    expect(board.out).not.toContain("\x1b");
    const tasks = json((await run(me, "tasks", "--done", "--json")).out);
    expect(tasks.tasks.find((row: { id: string }) => row.id === verifiedTask)).toMatchObject({ word: "Verified", state: "verified", agent: "ada" });
    const peek = await run(me, "peek", verifiedTask, "--json");
    expect([peek.code, json(peek.out).lines.length > 0]).toEqual([0, true]);
    const cost = await run(me, "cost", "--json");
    expect([cost.code, Object.keys(json(cost.out)).sort()]).toEqual([0, ["calls", "since", "tasks", "today", "total"]]);
    expect(json(cost.out).tasks.map((row: { id: string }) => row.id)).toContain(verifiedTask);
  }, 30_000);

  test("inv give --on: only an agent whose VM is on that node takes it; a node that isn't in the fleet is said", async () => {
    const given = await run(me, "give", "TASK_TWO: write result.txt again", "--on", "keep", "--gate", "test -f result.txt # gate-two", "--wait", "--json");
    expect([given.code, json(given.out)]).toEqual([0, expect.objectContaining({ state: "verified", agent: "ada", node: "keep" })]);
    const nowhere = await run(me, "give", "TASK_THREE: anything", "--on", "nowhere");
    expect([nowhere.code, nowhere.err]).toEqual([1, expect.stringContaining('no node "nowhere" in this fleet')]);
  }, 60_000);

  test("inv stop: a task at work is stopped, and its proof exits 13", async () => {
    const given = await run(me, "give", "TASK_HOLD: wait for it", "--agent", "ada", "--gate", "test -f result.txt # gate-hold", "--json");
    expect(given.code).toBe(0);
    const { task } = json(given.out);
    await until(() => holdEntered);
    const working = await run(me, "proof", task, "--json");
    expect([working.code, json(working.out).state]).toEqual([21, "working"]);
    const stopped = await run(me, "stop", task, "--json");
    expect([stopped.code, json(stopped.out)]).toEqual([0, { task, state: "stopped" }]);
    releaseHold!();
    await until(async () => (await api<TeamSnapshot>("team")).tasks.find((one) => one.id === task)?.status === "stopped");
    const proof = await run(me, "proof", task, "--json");
    expect([proof.code, json(proof.out).state]).toEqual([13, "stopped"]);
  }, 60_000);

  test("inv steer: your words reach the task as its command runs, at its next safe point; its proof says the review judged the work against them", async () => {
    const given = await run(me, "give", "TASK_STEER: wait for it", "--agent", "ada", "--gate", "test -f result.txt # gate-steer", "--json");
    expect(given.code).toBe(0);
    const { task } = json(given.out);
    await until(() => steerEntered);
    const steered = await run(me, "steer", task, "Use the new schema.", "--json");
    expect([steered.code, json(steered.out)]).toEqual([0, { task, waiting: 1 }]);
    releaseSteer!();
    const watched = await run(me, "watch", task, "--json");
    expect(watched.code).toBe(0);
    expect(json(watched.out)).toMatchObject({ state: "verified", exit: 0, steers: [{ by: "owner", text: "Use the new schema.", step: 1 }], review: { verdict: "pass", steers: 1 } });
    const shown = await run(me, "proof", task);
    expect(shown.out).toContain("steered once, yours · the review judged the work against it");
    // Ended, it is refused in the node's words, and exits 1.
    const late = await run(me, "steer", task, "And name it v2.");
    expect([late.code, late.err]).toEqual([1, "inv: It has ended: give it again from a step instead.\n"]);
    const usage = await run(me, "steer", task);
    expect(usage.code).toBe(2);
  }, 60_000);

  test("inv asks shows an operation exactly, a hidden character made visible; inv allow sends it once, inv deny doesn't", async () => {
    const { token } = await api<{ token: string }>("mintArm", { label: "inv-e2e-arm", scopes: ["connect"] });
    const B = String.fromCharCode(92);
    const hidden = JSON.parse(`"Hello${B}u202e world"`) as string;
    const asked = await api<{ status: string; action: string }>("callConnector", { connector: "forge", tool: "post", args: { text: hidden }, why: "announce it" }, token);
    expect(asked.status).toBe("asked");
    const list = await run(me, "asks", "--json");
    const ask = json(list.out).asks.find((one: { id: string }) => one.id === asked.action);
    expect(ask).toMatchObject({ kind: "approval", op: "forge.post", class: "outward", by: "inv-e2e-arm", inputs: { text: hidden }, hidden: 1, why: "announce it" });
    const shown = await run(me, "asks");
    expect(shown.out).toContain("text: Hello⟨U+202E⟩ world");
    expect(shown.out).toContain("1 character you can't see, shown as ⟨U+202E⟩");
    expect(shown.out).not.toContain(hidden);
    const allowed = await run(me, "allow", asked.action, "--json");
    expect([allowed.code, json(allowed.out).id]).toEqual([0, asked.action]);
    await until(() => posts.length === 1);
    expect(posts).toEqual([{ text: hidden }]);
    const second = await api<{ action: string }>("callConnector", { connector: "forge", tool: "post", args: { text: "Not this one" } }, token);
    const denied = await run(me, "deny", second.action, "not today", "--json");
    expect([denied.code, json(denied.out)]).toEqual([0, { id: second.action, state: "denied" }]);
    expect(posts).toHaveLength(1);
  }, 30_000);

  test("a pairing refused on the node exits 30, and leaves no key behind", async () => {
    const refused = cli("refused");
    const result = await pair(refused, false);
    expect([result.code, result.err]).toEqual([30, expect.stringContaining("the pairing was refused on the node")]);
    expect(json(result.out)).toEqual({ error: "the pairing was refused on the node", exit: 30 });
    expect(() => statSync(join(refused.INVINCIBLE_CLI_HOME, "key.json"))).toThrow();
    expect((await run(refused, "tasks")).code).toBe(31);
  }, 30_000);

  test("a node that doesn't answer exits 31; a device the node no longer knows exits 30", async () => {
    // The same pairing, as if the node had gone away: nothing answers where it was.
    const away = cli("away");
    mkdirSync(away.INVINCIBLE_CLI_HOME, { recursive: true });
    copyFileSync(join(me.INVINCIBLE_CLI_HOME, "key.json"), join(away.INVINCIBLE_CLI_HOME, "key.json"));
    const pairing = JSON.parse(readFileSync(join(me.INVINCIBLE_CLI_HOME, "cli.json"), "utf8"));
    writeFileSync(join(away.INVINCIBLE_CLI_HOME, "cli.json"), JSON.stringify({ ...pairing, node: `http://127.0.0.1:${freePort()}` }));
    const unreachable = await run(away, "tasks", "--json");
    expect([unreachable.code, json(unreachable.out).exit]).toEqual([31, 31]);
    // Revoked on the node: refused.
    await api("revokeDevice", { device: pairing.device });
    const revoked = await run(me, "tasks");
    expect([revoked.code, revoked.err]).toEqual([30, expect.stringContaining("doesn't know this device now")]);
  }, 30_000);
});
