import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDED_LISTS_COMMAND, handedNonce, handedSweep } from "@invincible/agents";
import { bodyFingerprint, ceilingThreads, KERNEL, REFERENCE_SINGLE, type RouteName, routes } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { containerName } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { handedBy } from "../src/fabric/handoff.ts";
import { Home } from "../src/home.ts";
import { TeamStore } from "../src/team-store.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * What tasks other nodes handed over left running in an agent's VM is ended as the node comes back (fabric/handoff.ts
 * attachTeam, server.ts sweepHanded; the third re-review's R3-5), through a real node with a stand-in for Docker alone:
 * its first start makes an agent's VM, and its next start sweeps that VM. The sweep went out before the server's routes
 * existed, so it never reached a VM: each agent's said "Cannot access 'handlers' before initialization" (found on
 * Ultra's node, 27 November 2026), and fabric-hand-restart.test.ts, which attaches the hand-offs with a sweep of its own,
 * couldn't see it.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "handed-sweep-test", cores: 16, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
const root = mkdtempSync(join(tmpdir(), "invincible-handed-sweep-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
/** What the node said, from its every start. */
const said: string[] = [];
let daemon: Daemon | null = null;

const start = () =>
  startDaemon(home, {
    capabilities: caps,
    proxyPort: freePort(),
    log: (message) => void said.push(message),
    docker: docker.runner,
    measure: async (reason, body, limit) => {
      const threads = ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
    },
    shutdownGraceMs: 100,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
  });

async function api<T = unknown>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await response.json()) as { error?: string };
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}
async function until(condition: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  return false;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "sweep", nodeName: "box" });
  mind.close();
  home.writeConfig({ v: 1, name: "box", fleet, port, keystore, advertise: "127.0.0.1" });
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("as the node comes back, each agent's VM is asked what handed tasks left running there: the sweep reaches it", async () => {
  daemon = await start();
  expect(await until(() => daemon!.store.lww(`calibration:${daemon!.identity.id}`) !== null)).toBe(true);
  await api("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  const { workspace } = await api<{ workspace: { id: string } }>("provisionAgent", { id: "ada" });
  await daemon.stop();
  daemon = null;
  docker.execs.length = 0;
  said.length = 0;

  // The node comes back: its sweep asks Ada's VM for the lists of what handed tasks left running there.
  daemon = await start();
  const asked = () => docker.execs.some((e) => e.container === containerName(workspace.id) && e.cmd.join(" ").includes(HANDED_LISTS_COMMAND));
  const reached = await until(asked);
  expect(said.filter((line) => line.includes("before initialization"))).toEqual([]);
  expect(said.filter((line) => line.includes("couldn't be asked what handed tasks left running"))).toEqual([]);
  expect(reached).toBe(true);
}, 60_000);

/*
 * And what runs of those tasks cut off left on an agent's side, in its repository (the seventh fabric review's I-d): a
 * receive's patch of up to 512 MiB, an apply's, a give's or a tree's index, a give's ref. Each task's start sweeps its own
 * (handed-repo.ts handedSweep), so one that never ran again kept them for as long as its agent's VM lasted. As the node
 * comes back they are swept for every task it can't be running: one that has ended, or one it doesn't know. Here Noa's
 * VM's /work is a temporary folder, with real git: a held-git script of the node's whose /work paths are its arguments
 * alone runs on it, those arguments mapped there. Anything else the node runs in her VM answers as Docker's stand-in does.
 */
test("as the node comes back, what runs of handed tasks cut off left on an agent's side is swept: never a task it may still run", async () => {
  daemon ??= await start();
  expect(await until(() => daemon!.store.lww(`calibration:${daemon!.identity.id}`) !== null)).toBe(true);
  await api("saveAgent", { id: "noa", name: "Noa", role: "engineer", repository: "https://github.com/you/project" });
  const { workspace } = await api<{ workspace: { id: string } }>("provisionAgent", { id: "noa" });
  await daemon.stop();
  daemon = null;

  // Her tasks as the node knows them: one another node handed over, which its deadline ended, and one of yours, proposed,
  // which may still run. And one it doesn't know: its id sorts after every id the node makes, so by the time its sweep is
  // sent, every other task listed there has been swept or passed over.
  const team = new TeamStore(join(home.dir, "team.db"));
  team.saveRoom({ id: "noa-work", name: "Noa's work", members: ["noa"] });
  const ended = team.createTask({ room: "noa-work", assignee: "noa", title: "Handed over", goal: "Handed over" }, { givenBy: handedBy(`n_${"B".repeat(43)}`) }).id;
  team.finish(ended, "failed", "Its time ran out.");
  const open = team.createTask({ room: "noa-work", assignee: "noa", title: "Yours", goal: "Yours" }, { propose: true }).id;
  team.close();
  const unknown = `task-${"z".repeat(13)}`;

  // What their runs left in her VM, as a deadline's SIGKILL leaves it: receives' patches, indexes and gives' refs.
  const vm = join(root, "noa-vm");
  const repo = join(vm, "repo");
  const keep = join(vm, ".agent/handed");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { env, encoding: "utf8" });
  mkdirSync(keep, { recursive: true });
  spawnSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "Noa's repository\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const nonce = handedNonce();
  const leftBy = (task: string) => [`${task}.${nonce}.patch`, `${task}.${nonce}.apply-index`, `${task}.give-index`, `${task}.tree-index`, `${task}.patch`];
  // (Beside them, the list endLeftovers reads, and a name that is no task's: neither is the sweep's.)
  const others = [`${ended}.jsonl`, "not a task.patch"];
  for (const name of [...leftBy(ended), `${unknown}.${nonce}.patch`, ...leftBy(open), ...others]) writeFileSync(join(keep, name), "left\n");
  for (const task of [ended, unknown, open]) git("update-ref", `refs/invincible/give/${task}`, "HEAD");

  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const here = (command: string): string | null => {
    if (!command.startsWith("python3 -I -c '")) return null;
    const mapped = command.replace(/ '\/work\/repo'(?= |$)/g, ` ${q(repo)}`).replace(/ '\/work\/\.agent\/handed'(?= |$)/g, ` ${q(keep)}`);
    return mapped.includes("/work/") ? null : mapped;
  };
  docker.onExec = (container, cmd) => {
    const command = container === containerName(workspace.id) && cmd[0] === "bash" && cmd[1] === "-lc" ? here(cmd[2] ?? "") : null;
    if (command === null) return { code: 0, stdout: "" };
    const ran = spawnSync("bash", ["-c", command], { env: { PATH: env.PATH, HOME: "/nonexistent" }, encoding: "utf8" });
    return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
  };
  docker.execs.length = 0;
  said.length = 0;

  // The node comes back.
  daemon = await start();
  const sent = (command: string) => docker.execs.some((e) => e.container === containerName(workspace.id) && e.cmd[2] === command);
  await until(() => sent(handedSweep("/work/repo", unknown)));
  // What the task that ended left, and the one the node doesn't know, is gone; the one that may still run keeps its own.
  const left = { files: readdirSync(keep).sort(), refs: git("for-each-ref", "--format=%(refname)", "refs/invincible").stdout.trim().split("\n") };
  expect(left).toEqual({ files: [...leftBy(open), ...others].sort(), refs: [`refs/invincible/give/${open}`] });
  expect([sent(handedSweep("/work/repo", ended)), sent(handedSweep("/work/repo", open))]).toEqual([true, false]);
  expect(said.filter((line) => line.startsWith("fabric:") && line.includes("Noa"))).toEqual([]);
}, 60_000);
