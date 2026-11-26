import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_RESOURCE,
  bodyFingerprint,
  type Calibration,
  ceilingThreads,
  type ComputeView,
  type EffortGrant,
  KERNEL,
  type LedgerEntry,
  type NoticeView,
  REFERENCE_SINGLE,
  routes,
  type RouteName,
  type SandboxView,
} from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { LocalClient } from "../src/loop-tasks.ts";
import { runNodeQuest } from "../src/quest-cli.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * Compute, end to end, over real HTTP on a real node: stand-ins only for Docker (the
 * sandbox host's own logic runs above it) and for the models (an OpenAI-compatible
 * server that plays planner, engineer and reviewer). The node calibrates itself when
 * it starts, carries no more sandboxes than its ceiling, queues the rest where you
 * can see them, and a quest at effort 3 runs three attempts in parallel and takes
 * the reviewer's pick.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "ultra-test",
  cores: 32,
  cpu: "test",
  memoryGb: 128,
  hasBattery: false,
  gpu: [],
  docker: true,
  vm: { kvm: false, tools: [] },
  tools: ["git", "docker"],
  localModels: [],
  tailscale: null,
  sandbox: { image: true, networks: true },
};

const root = mkdtempSync(join(tmpdir(), "galahad-compute-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;
let measured = 0;

/** The node "measures" itself: its ceiling's threads deliver three quarters of that many cores' worth. */
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  measured += 1;
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1200, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL }, memoryGbps: 9.5 };
};

/** The stand-in models: who was asked (by role and model), and how many engineers were thinking at once. */
const asked: { role: string; model: string; attempt: number }[] = [];
let thinking = 0;
let peakThinking = 0;
const fence = "```";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const first = turns[0]?.content ?? "";
    const attempt = Number(/You are attempt (\d) of/.exec(first)?.[1] ?? 1);
    let role = "planner";
    let text = "1. Write the file.\n2. Check it.\nDone when: the file is there and says hi.";
    if (first.startsWith("You are choosing between")) {
      role = "pick";
      text = "PICK B\nB's evidence shows the check ran; the others only say so.";
    } else if (first.startsWith("You are reviewing")) {
      role = "reviewer";
      text = "PASS\nThe file is there.";
    } else if (first.startsWith("Quest:")) {
      role = "engineer";
      thinking += 1;
      peakThinking = Math.max(peakThinking, thinking);
      await Bun.sleep(40);
      thinking -= 1;
      const done = turns.filter((m) => m.role === "assistant").length;
      text = done === 0 ? `Writing it.\n${fence}sh\necho hi > /work/out/hi.txt && cat /work/out/hi.txt\n${fence}` : `DONE\nDone by attempt ${attempt}.`;
    }
    asked.push({ role, model: body.model, attempt });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

async function call<T = any>(name: RouteName, input?: unknown, token = home.adminToken()): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; status?: number };
  if (!response.ok) throw new Error(`${name} → ${response.status} ${body.error ?? ""}`);
  // Work that outlasted the first moment answers late, with its failure in the body.
  if (typeof body.error === "string" && typeof body.status === "number") throw new Error(`${name} → ${body.status} ${body.error}`);
  return body as T;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met in time");
}

const census = () => call<ComputeView>("compute");
const self = async () => (await census()).nodes.find((n) => n.self)!;
const client = () => new LocalClient(`http://127.0.0.1:${port}`, home.adminToken());

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  docker.onExec = () => ({ code: 0, stdout: "hi\n" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure, slotWaitMs: 4_000 });
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const role of ["planner", "reviewer"]) await call("setRoster", { role, models: ["stand-in/judge"] });
  // Three models may play the engineer: each parallel attempt starts at another one.
  await call("setRoster", { role: "engineer", models: ["stand-in/e1", "stand-in/e2", "stand-in/e3"] });
});

afterAll(async () => {
  await daemon?.stop();
  models.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("knowing the compute", () => {
  test("a node measures itself when it joins, as a signed event, and its slots follow from what it measured", async () => {
    await until(() => daemon.store.lww(`calibration:${daemon.identity.id}`) !== null);
    const recorded = daemon.store.lww<Calibration>(`calibration:${daemon.identity.id}`)!;
    expect(recorded.device).toBe(daemon.identity.id);
    expect(daemon.store.event(recorded.eid)!.kind).toBe("compute.calibrated");
    const node = await self();
    expect(node.calibration).toMatchObject({ reason: "joined", cpu: { threads: 16 } });
    expect(node.due).toBeNull();
    // 16 threads (half of 32) delivered 12 cores' worth: three sandboxes of four; half of 128 GB.
    expect(node.capacity).toMatchObject({ cores: 12, memoryGb: 64, sandboxes: 3, modelCalls: 8, measured: true, strength: 12 });
    expect(node.capacity!.reasons.join("\n")).toMatch(/half; the rest stays with whatever else this machine runs/);
    expect(node.use).toMatchObject({ sandboxes: 0, queued: 0 });
    expect(node.free).toBe(3);
    // It's in the ledger as his own, and he says what he counts.
    const { entries } = await call<{ entries: LedgerEntry[] }>("ledger");
    const entry = entries.find((e) => e.resource === "self-action" && e.target === "calibrate:joined")!;
    expect(entry).toMatchObject({ quest: "galahad.self", class: "create", verdict: "allow" });
    expect(entries.find((e) => e.resource === "compute" && e.target === "calibration:ultra")!.detail).toMatch(/he counts 12 threads, 64 GB, 3 sandbox slot/);
  });

  test("on demand: you ask, it measures again; an agent can't", async () => {
    const before = measured;
    const done = await call<{ node: string; calibration: Calibration }>("calibrateCompute", {});
    expect(done).toMatchObject({ node: "ultra", calibration: { reason: "asked" } });
    expect(measured).toBe(before + 1);
    const { token } = await call<{ token: string }>("mintArm", { label: "claude-code" });
    await expect(call("calibrateCompute", {}, token)).rejects.toThrow(/403.*brain:write/);
    // The census is readable by an agent; nothing in it is a secret.
    expect((await call<ComputeView>("compute", undefined, token)).nodes).toHaveLength(1);
  });

  test("placement names what was measured and what's free", async () => {
    const placed = await call<{ ranked: { name: string; reasons: string[] }[] }>("place", { docker: true, untrusted: true });
    expect(placed.ranked[0]!.name).toBe("ultra");
    expect(placed.ranked[0]!.reasons).toContain("measured 12.0 reference cores' worth");
    expect(placed.ranked[0]!.reasons).toContain("3 of 3 slots free");
  });
});

describe("capacity, with a ceiling the owner sets", () => {
  test("work past the ceiling waits its turn, where you can see it, and never runs on top of it", async () => {
    await call("setComputeLimit", { node: "ultra", sandboxes: 1 });
    expect((await self()).capacity!.sandboxes).toBe(1);
    const peak = docker.peak();
    const first = (await call<{ sandbox: SandboxView }>("createSandbox", { network: "isolated", quest: "q-first" })).sandbox;
    let second: SandboxView | null = null;
    const waiting = call<{ sandbox: SandboxView }>("createSandbox", { network: "isolated", quest: "q-second" }).then((r) => (second = r.sandbox));
    await until(async () => (await self()).use!.queued === 1);
    const node = await self();
    expect(node.use).toMatchObject({ sandboxes: 1, queued: 1 });
    expect(node.free).toBe(0);
    expect(node.queue).toMatchObject([{ quest: "q-second", cpus: 4, memoryGb: 8 }]);
    expect(node.queue[0]!.why).toMatch(/every slot is in use \(1 of 1 sandboxes\)/);
    expect(second).toBeNull();
    expect(docker.running()).toBe(1);
    // Placement says the node is full, and why work would wait.
    const placed = await call<{ ranked: { reasons: string[] }[] }>("place", { docker: true });
    expect(placed.ranked[0]!.reasons).toContain("full: work waits for a slot (1 ahead)");
    // The first one ends: the second takes its slot.
    await call("destroySandbox", { id: first.id });
    await waiting;
    expect(second).not.toBeNull();
    expect(docker.running()).toBe(1);
    expect(Math.max(peak, docker.peak())).toBe(Math.max(peak, 1));
    await call("destroySandbox", { id: second!.id });
    expect((await self()).use).toMatchObject({ sandboxes: 0, queued: 0 });
  });

  test("a wait has an end, and the caller hears why", async () => {
    const held = (await call<{ sandbox: SandboxView }>("createSandbox", { network: "isolated" })).sandbox;
    await expect(call("createSandbox", { network: "isolated" })).rejects.toThrow(/503.*every slot is in use/);
    await call("destroySandbox", { id: held.id });
  }, 15_000);

  test("a sandbox asking for more than the ceiling gets the ceiling", async () => {
    await call("setComputeLimit", { node: "ultra", reset: true, cores: 8, memoryGb: 16 });
    const { sandbox } = await call<{ sandbox: SandboxView }>("createSandbox", { network: "isolated", cpus: 64, memoryGb: 512 });
    expect(sandbox).toMatchObject({ cpus: 6, memoryGb: 16 });
    await call("destroySandbox", { id: sandbox.id });
  });

  test("only you set a ceiling or the policy: never an agent, and the limit is a signed event", async () => {
    const { token } = await call<{ token: string }>("mintArm", { label: "opencode" });
    await expect(call("setComputeLimit", { node: "ultra", cores: 32 }, token)).rejects.toThrow(/403.*fleet:admin/);
    await expect(call("setComputePolicy", { attemptsPerDay: 500 }, token)).rejects.toThrow(/403.*brain:write/);
    expect(daemon.store.lww(`compute-limit:${daemon.identity.id}`)?.value).toEqual({ cores: 8, memoryGb: 16 });
    // Back to the defaults; its ceiling's threads changed twice, so it measured itself again.
    const reset = await call<{ limit: unknown }>("setComputeLimit", { node: "ultra", reset: true });
    expect(reset.limit).toEqual({});
    await until(async () => (await self()).due === null && (await self()).capacity!.sandboxes === 3);
    expect((await self()).limit).toBeNull();
  });
});

describe("effort that scales", () => {
  test("effort 1: one engineer in one sandbox, as ever", async () => {
    asked.length = 0;
    const before = docker.peak();
    const { outcome, effort } = await runNodeQuest(client(), { goal: "write hi to a file", network: "isolated", effort: 1 });
    expect(outcome).toMatchObject({ status: "done", summary: "Done by attempt 1." });
    expect(effort).toBeUndefined();
    expect(asked.filter((a) => a.role === "pick")).toHaveLength(0);
    expect(asked.filter((a) => a.role === "engineer").every((a) => a.model === "e1")).toBe(true);
    expect(Math.max(0, docker.peak() - before)).toBe(0);
    expect(docker.running()).toBe(0);
    expect((await census()).budget.usedToday).toBe(0);
  });

  test("effort 3: three attempts in parallel sandboxes within the ceiling, each reviewed, and the reviewer's pick is the outcome", async () => {
    asked.length = 0;
    peakThinking = 0;
    const seen: ComputeView[] = [];
    const grants: EffortGrant[] = [];
    const started: number[] = [];
    let running = 0;
    const { outcome, effort, quest } = await runNodeQuest(
      client(),
      { goal: "write hi to a file", network: "isolated", effort: 3 },
      {
        effort: (event) => void (event.type === "granted" && grants.push(event.grant)),
        started: ({ attempt }) => void started.push(attempt!),
        emit: (event) => {
          if (event.type !== "command") return;
          // What the census shows while they work.
          seen.push(daemon.compute.view());
          running = Math.max(running, docker.running());
        },
      },
    );
    // The node granted three: three slots were free, and the day's budget had room.
    expect(grants[0]).toMatchObject({ attempts: 3, asked: 3, host: "ultra" });
    expect(started.sort()).toEqual([1, 2, 3]);
    // Three sandboxes at once, never more than the ceiling's three slots; three engineers thinking at once.
    expect(running).toBe(3);
    expect(docker.peak()).toBe(3);
    expect(peakThinking).toBe(3);
    // Each attempt started at another of the engineer's models.
    expect([...new Set(asked.filter((a) => a.role === "engineer").map((a) => `${a.attempt}:${a.model}`))].sort()).toEqual(["1:e1", "2:e2", "3:e3"]);
    // Each was reviewed on its own; then the reviewer picked among the three that passed, and its pick was taken.
    expect(asked.filter((a) => a.role === "reviewer")).toHaveLength(3);
    expect(asked.filter((a) => a.role === "pick")).toHaveLength(1);
    expect(effort!.pick).toMatchObject({ index: 2, by: "reviewer", model: "stand-in/judge" });
    expect(effort!.attempts).toEqual([1, 2, 3].map((index) => ({ index, status: "done" })));
    expect(outcome).toMatchObject({ status: "done", summary: "Done by attempt 2." });
    // The census showed the quest's three attempts at work, each where its work was, on the node.
    const work = seen.flatMap((s) => s.work);
    expect(work.every((q) => q.effort === 3 && q.label === "write hi to a file")).toBe(true);
    const attempts = work.flatMap((q) => q.attempts);
    expect(new Set(attempts.map((a) => a.index))).toEqual(new Set([1, 2, 3]));
    expect(attempts.every((a) => ["council", "forge", "observatory"].includes(a.station))).toBe(true);
    expect(seen.some((s) => s.nodes[0]!.name === "ultra" && s.nodes[0]!.use?.sandboxes === 3 && s.nodes[0]!.capacity?.sandboxes === 3)).toBe(true);
    // Afterwards: every sandbox gone, every slot free, no helpers; the two extra attempts are in the ledger and the budget.
    expect(docker.running()).toBe(0);
    expect((await self()).use).toMatchObject({ sandboxes: 0, queued: 0 });
    expect(daemon.compute.work()).toEqual([]);
    const { entries } = await call<{ entries: LedgerEntry[] }>("ledger");
    expect(entries.filter((e) => e.resource === ATTEMPT_RESOURCE).map((e) => e.target).sort()).toEqual([`${quest}#2`, `${quest}#3`]);
    expect((await census()).budget).toEqual({ perDay: 12, usedToday: 2 });
    // The quest is remembered with what its effort was.
    const { memories } = await call<{ memories: { text: string }[] }>("recall", { q: "Effort" });
    expect(memories[0]!.text).toMatch(/Effort 3: attempt 1 done, attempt 2 done, attempt 3 done\. Taken: attempt 2/);
  });

  test("auto: what's free and what the budget leaves, never more; your own level stands, and waits rather than oversubscribes", async () => {
    // Two extra attempts were spent. A budget of three leaves one: auto runs two.
    await call("setComputePolicy", { attemptsPerDay: 3 });
    const grants: EffortGrant[] = [];
    const two = await runNodeQuest(client(), { goal: "write hi again", network: "isolated", effort: "auto" }, { effort: (e) => void (e.type === "granted" && grants.push(e.grant)) });
    expect(grants[0]).toMatchObject({ attempts: 2, asked: "auto" });
    expect(grants[0]!.reasons.join(" ")).toMatch(/budget leaves 1 extra attempt/);
    expect(two.effort!.attempts).toHaveLength(2);
    // Spent: auto is one attempt now, and says why. An agent asking for three gets one, too.
    const spent = await call<EffortGrant>("effort", { quest: "q-spent", effort: "auto" });
    expect(spent).toMatchObject({ attempts: 1, budget: { perDay: 3, usedToday: 3 } });
    expect(spent.reasons.join(" ")).toMatch(/budget of 3 extra attempts is spent/);
    const { token } = await call<{ token: string }>("mintArm", { label: "hermes" });
    expect(await call<EffortGrant>("effort", { quest: "q-agent", effort: 3 }, token)).toMatchObject({ attempts: 1, quest: "arm.hermes.q-agent" });
    // Asked twice for the same quest: the same answer, and nothing more is spent.
    expect(await call<EffortGrant>("effort", { quest: "q-spent", effort: "auto" })).toEqual(spent);

    // You name three with one slot as the ceiling: three attempts, one sandbox at a time.
    await call("setComputeLimit", { node: "ultra", sandboxes: 1 });
    const one = await call<EffortGrant>("effort", { quest: "q-one-slot", effort: 3 });
    expect(one).toMatchObject({ attempts: 1 });
    expect(one.reasons.join(" ")).toMatch(/ultra carries 1 sandbox at all/);
    await call("setComputeLimit", { node: "ultra", reset: true, sandboxes: 2 });
    const peak = docker.peak();
    let most = 0;
    const yours = await runNodeQuest(
      client(),
      { goal: "write hi a third time", network: "isolated", effort: 2 },
      { emit: (event) => void (event.type === "command" && (most = Math.max(most, docker.running()))) },
    );
    expect(yours.effort!.grant.reasons.join(" ")).toMatch(/past today's budget/);
    expect(yours.effort!.attempts).toHaveLength(2);
    expect(most).toBeLessThanOrEqual(2);
    expect(docker.peak()).toBe(peak);
    await call("setComputeLimit", { node: "ultra", reset: true });
    await call("setComputePolicy", { attemptsPerDay: 12 });
  }, 30_000);
});

describe("adapting when the compute changes", () => {
  test("after a heartbeat he records his defaults and tells you in a line what changed; then again when a ceiling changes", async () => {
    await until(async () => (await self()).due === null);
    await call("runLoop", { name: "heartbeat" });
    await daemon.loops.settled("heartbeat");
    const first = (await call<{ notices: NoticeView[] }>("notices")).notices.find((n) => n.key === "compute-adapted")!;
    expect(first).toMatchObject({ severity: "info", source: "compute", title: "Galahad took stock of his compute" });
    expect(first.body).toContain("ultra carries 3 sandbox slots, 8 model calls at once (measured 12.0 reference cores' worth).");
    expect(first.body).toContain("Default effort 3");
    expect((await census()).adapted!.changes[0]).toContain("ultra carries 3 sandbox slots");
    const beat = daemon.store.loopRuns("heartbeat", 1)[0]!.body;
    expect(beat.summary).toContain("Fixed himself: Re-derived his compute defaults: ultra carries 3 sandbox slots");

    // Nothing changed: the next heartbeat writes nothing about it.
    const events = daemon.store.eventCount();
    await call("runLoop", { name: "heartbeat" });
    await daemon.loops.settled("heartbeat");
    expect(daemon.store.lwwPrefix("compute-plan")).toHaveLength(1);
    expect(daemon.store.loopRuns("heartbeat", 1)[0]!.body.summary).not.toContain("compute");
    expect(daemon.store.eventCount()).toBeLessThan(events + 4);

    // You give him more of the machine: it measures again, and the next heartbeat says what that changed.
    await call("setComputeLimit", { node: "ultra", cores: 24 });
    await until(async () => (await self()).capacity!.sandboxes === 4);
    await call("runLoop", { name: "heartbeat" });
    await daemon.loops.settled("heartbeat");
    const second = (await call<{ notices: NoticeView[] }>("notices")).notices.find((n) => n.key === "compute-adapted")!;
    expect(second.title).toBe("Galahad adapted to a change in his compute");
    expect(second.body).toContain("ultra: 3 → 4 sandbox slots.");
    expect(second.dismissed).toBe(false);
    await call("setComputeLimit", { node: "ultra", reset: true });
  }, 20_000);

  test("what more compute would buy is said, with the command", async () => {
    await until(async () => (await self()).capacity!.sandboxes === 3);
    const { more } = await census();
    expect(more.some((line) => line.includes("galahad compute limit ultra --cores 24"))).toBe(true);
    expect(more.some((line) => /Another machine like ultra would carry 6 slots instead of 3/.test(line))).toBe(true);
  });
});
