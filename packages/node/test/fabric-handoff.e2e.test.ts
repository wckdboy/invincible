import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { bodyFingerprint, ceilingThreads, type HandedView, KERNEL, newNodeIdentity, REFERENCE_SINGLE, type TeamSnapshot } from "@invincible/core";
import { fakeDocker } from "./fake-docker.ts";
import { HAVE_QAMP, type Pair, sandboxCaps, startPair, until } from "./fabric-pair.ts";

/*
 * Agents working together across nodes (docs/ARCHITECTURE.md §3), end to end on one machine: two nodes with real Q-AMP
 * sidecars on loopback; beta's agent works in a VM (a stand-in Docker) on stand-in models.
 *
 *  - A task given on alpha runs on beta, streams back, and comes back with its proof checked: Proven, from beta's own
 *    signature, its gate failing before the work and passing after, its reviewer another model.
 *  - It can be stopped from alpha, and the work on beta stops.
 *  - The run on beta calls alpha's tools with its own key and a chain bound to it and to its task; one it wasn't given
 *    is refused; revoking it cuts it off on its next call; when its task ends, its grant ends with it.
 *  - A node that lies about the proof (another key's signature) doesn't make it look proven.
 */

setDefaultTimeout(90_000);

const fence = "```";
/** Which tasks have written their file (their gate passes after, and fails before), and the command that is held. */
const written = new Set<string>();
let hold: { tag: string; entered: boolean; release: () => void; done: Promise<void> } | null = null;

const docker = fakeDocker();
docker.onExec = async (_container, command) => {
  const text = command.join("\n");
  const gate = /gate-([a-z]+)/.exec(text)?.[1];
  if (gate) return written.has(gate) ? { code: 0, stdout: "the file is there" } : { code: 1, stdout: "", stderr: "no such file" };
  const write = /write-([a-z]+)/.exec(text)?.[1];
  if (write) {
    if (hold?.tag === write) {
      hold.entered = true;
      await hold.done;
    }
    written.add(write);
    return { code: 0, stdout: "written" };
  }
  return { code: 0, stdout: "command completed" };
};

/** What each model was asked, by the task's tag. */
const prompts: { tag: string; model: string; text: string }[] = [];

/** The stand-in models: the engineer calls bash once to write its file, then says DONE; the reviewer passes. */
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const tag = /TASK_([A-Z]+)/.exec(JSON.stringify(turns))?.[1]?.toLowerCase() ?? "unknown";
    prompts.push({ tag, model: body.model, text: JSON.stringify(body.messages) });
    const sse = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    if (body.model === "reviewer") return sse({ content: "PASS\nThe gate passed after the work, and its evidence shows the file written." });
    if (body.model === "engineer") {
      const command = `printf '%s' ${tag} > result-${tag}.txt # write-${tag}`;
      const worked = turns.some((m) => m.role === "assistant" || m.role === "tool");
      if (body.tools?.length && !worked) return sse({ tool_calls: [{ index: 0, id: "call_work", function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
      return sse({ content: worked ? "DONE\nThe file is written." : `${fence}sh\n${command}\n${fence}` });
    }
    return sse({ content: "1. Write the file.\n2. Check it.\nDone when: the gate passes." });
  },
});

// Said, not passed over in silence: without a binary these are unverified.
if (!HAVE_QAMP) console.log(`${import.meta.file} SKIPPED, unverified: no Q-AMP binary. Run it with INVINCIBLE_QAMP_TEST_BIN=<qamp 0.2's sidecar for this machine>.`);

describe.skipIf(!HAVE_QAMP)(`a task handed from one node to another's agents${HAVE_QAMP ? "" : " (skipped: no Q-AMP binary; set INVINCIBLE_QAMP_TEST_BIN)"}`, () => {
  let pair: Pair;

  beforeAll(async () => {
    pair = await startPair({
      // Alpha's grants to runs last 4 s here (300 s otherwise), so every run below lives across their renewals.
      a: { fabricGrantTtlSecs: 4 },
      b: {
        capabilities: sandboxCaps("beta"),
        docker: docker.runner,
        measure: async (reason, body, limit) => {
          const threads = ceilingThreads(body, limit);
          return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
        },
        shutdownGraceMs: 200,
      },
    });
    const { b, callB } = pair;
    await until(() => b.store.lww(`calibration:${b.identity.id}`) !== null, 15_000, "beta's calibration");
    await callB("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
    for (const role of ["planner", "engineer", "reviewer"]) await callB("setRoster", { role, models: [`stand-in/${role}`] });
    await callB("saveAgent", { id: "ada", name: "Ada", role: "engineer" });
  });

  afterAll(async () => {
    hold?.release();
    await pair?.stop();
    models.stop(true);
  });

  const handed = (id: string, after = 0) => pair.callA<HandedView>("handedTask", { id, after });
  const ended = (id: string) => until(async () => (await handed(id)).phase === "ended", 60_000, `${id} ended`);

  test("a task given on alpha runs on beta, streams back, and comes back Proven, by beta's own signature", async () => {
    const view = await pair.callA<HandedView>("handTask", { node: "beta", goal: "TASK_PROOF: write the file and prove it", gates: ["test -f result-proof.txt # gate-proof"], agent: "ada" });
    expect(view).toMatchObject({ node: { name: "beta" }, phase: "handing", path: "qamp", proof: { state: "none" } });
    await ended(view.id);
    const done = await handed(view.id);
    expect(done).toMatchObject({ phase: "ended", status: "done", agent: { id: "ada", name: "Ada" }, error: null });
    // Its trail came back as the work went: its gates, its command, the gate's run after, the review.
    const lines = done.trail.map((t) => t.text.split("\n")[0]!);
    expect(lines.some((l) => l.startsWith("Gates · "))).toBe(true);
    expect(lines.some((l) => l.includes("write-proof"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Review · pass"))).toBe(true);
    // Its proof, checked here against beta's device key: the gate failed before the work and passes after, another model reviewed.
    expect(done.proof).toEqual({ state: "checked", verified: true, ended: "done", proof: { before: [1], after: [0], review: "pass", sameModel: false } });
    expect(done.firstOutputAt).toBeGreaterThanOrEqual(done.createdAt);
    // It is beta's task too, done there, by Ada.
    const there = (await pair.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === done.task);
    expect(there).toMatchObject({ status: "done", verified: true, assignee: "ada" });
  });

  test("stopped from alpha, the work on beta stops, and alpha hears how it ended", async () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    hold = { tag: "hold", entered: false, release, done };
    const view = await pair.callA<HandedView>("handTask", { node: "beta", goal: "TASK_HOLD: write the file, slowly", gates: ["test -f result-hold.txt # gate-hold"], agent: "ada" });
    await until(() => hold!.entered, 30_000, "the held command running on beta");
    const stopped = await pair.callA<HandedView>("stopHanded", { id: view.id });
    expect(stopped.phase).not.toBe("ended");
    await ended(view.id);
    const after = await handed(view.id);
    expect(after.status).toBe("stopped");
    // Its proof still checks (it is beta's account of a run that was stopped): not verified.
    expect(after.proof).toMatchObject({ state: "checked", verified: false });
    const there = (await pair.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === after.task);
    expect(there?.status).toBe("stopped");
    release();
    hold = null;
  });

  test("the run on beta calls alpha's tools with its own key's chain; one it wasn't given is refused; revoked, it is cut off; ended, so is its grant", async () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    hold = { tag: "tools", entered: false, release, done };
    const view = await pair.callA<HandedView>("handTask", { node: "beta", goal: "TASK_TOOLS: look at the fleet from where the task came", gates: ["test -f result-tools.txt # gate-tools"], agent: "ada", tools: ["fleet"] });
    await until(() => hold!.entered, 30_000, "the run under way on beta");
    const vm = (await pair.callB<TeamSnapshot>("team")).agents.find((m) => m.id === "ada")!.workspace!.id;
    await until(() => pair.b.handoffs.running().some((r) => r.handoff === view.id && r.chained), 10_000, "the run's chain on beta");
    // The run's key is in the chain, and the chain is alpha's grant to it, held to this task.
    const run = pair.b.handoffs.running().find((r) => r.handoff === view.id)!;
    expect(run.run).toMatch(/^did:key:z6Mk/);
    expect((await handed(view.id)).task).toBe(run.task);
    // The run was told which tools of alpha's it may use, and how its commands call them through beta's gateway.
    const told = prompts.filter((p) => p.tag === "tools" && p.model === "engineer").map((p) => p.text).join("\n");
    expect(told).toContain("/fabric/tool/<tool>");
    expect(told).toContain("Tools of alpha, which gave this task: fleet");
    const fleet = await pair.b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal);
    expect(fleet.status).toBe(200);
    expect(JSON.stringify(fleet.body)).toContain("alpha");
    const compute = await pair.b.handoffs.callGiver(vm, "compute", {}, new AbortController().signal);
    expect(compute.status).toBe(403);
    // Revoked: the very next call is refused, at alpha's sidecar.
    const revokedAt = performance.now();
    await pair.a.handoffs.revokeRun(view.id);
    const refused = await pair.b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal);
    const ms = performance.now() - revokedAt;
    expect(refused.status).toBe(403);
    expect(ms).toBeLessThan(1_000);
    release();
    hold = null;
    await ended(view.id);
    // Its task over, nothing of it answers: no run here, and alpha's grant for it is gone with it.
    expect((await pair.b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal)).status).toBe(404);
  });

  test("a run's grant renews itself while its task lives, and never outlives it", async () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    hold = { tag: "renew", entered: false, release, done };
    const view = await pair.callA<HandedView>("handTask", { node: "beta", goal: "TASK_RENEW: look at the fleet, for a while", gates: ["test -f result-renew.txt # gate-renew"], agent: "ada", tools: ["fleet"] });
    await until(() => hold!.entered, 30_000, "the run under way on beta");
    await until(() => pair.b.handoffs.running().some((r) => r.handoff === view.id && r.chained), 10_000, "the run's chain on beta");
    const first = pair.b.handoffs.chainOf(view.id)!;
    const vm = (await pair.callB<TeamSnapshot>("team")).agents.find((m) => m.id === "ada")!.workspace!.id;
    // Past the first token's 4 s: the run's calls still go through, under a chain alpha renewed and sent in.
    await Bun.sleep(6_000);
    expect(pair.b.handoffs.chainOf(view.id)).not.toBe(first);
    expect((await pair.b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal)).status).toBe(200);
    release();
    hold = null;
    await ended(view.id);
    // Ended with the task: revoked at alpha's sidecar (its renewals with it), and nothing of the run answers on beta.
    const grants = (await pair.a.fabric.sidecar.client!.grants()) as { aud: string; revoked: boolean }[];
    const run = (await handed(view.id)).task;
    expect(run).not.toBeNull();
    expect(grants.filter((g) => g.revoked).length).toBeGreaterThan(0);
    expect(grants.some((g) => !g.revoked && g.aud.startsWith("did:key:"))).toBe(false);
    expect((await pair.b.handoffs.callGiver(vm, "fleet", {}, new AbortController().signal)).status).toBe(404);
  });

  test("a node that lies about the proof (another key's signature) doesn't make it look proven", async () => {
    const runner = (pair.b.handoffs as unknown as { deps: { identity: unknown } }).deps;
    const honest = runner.identity;
    const liar = newNodeIdentity();
    // Beta signs this one with a key that isn't its own, as a node pretending another had run it would.
    runner.identity = { ...liar, id: (honest as { id: string }).id };
    try {
      const view = await pair.callA<HandedView>("handTask", { node: "beta", goal: "TASK_LIES: write the file", gates: ["test -f result-lies.txt # gate-lies"], agent: "ada" });
      await ended(view.id);
      const after = await handed(view.id);
      expect(after.proof).toEqual({ state: "refused", why: "its signature doesn't check" });
      expect(after.error).toBe("its proof didn't check: its signature doesn't check");
    } finally {
      runner.identity = honest;
    }
  });
});
