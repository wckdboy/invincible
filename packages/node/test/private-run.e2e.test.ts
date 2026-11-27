// A run that your mail woke is itself private (the re-review of 27 November, B1; its PoC turned around): it is told who
// wrote and what about (wakes.ts wokenData), and every command it runs was a line in the replicated ledger in those
// words. Now its commands' lines say that it ran something and how that ended, never what it ran, and an agent reads
// none of its lines. On gates.e2e.test.ts's harness: a real daemon over real HTTP, stand-ins for Docker and the models,
// on loopback only. The stand-in engineer does what a model asked to triage new mail does: it notes who wrote and what
// about in a file of its sandbox, with one command. Every name and address is made up; the keys are obviously fake.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, type RunView, REFERENCE_SINGLE, routes, type RouteName } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "private-run", cores: 32, cpu: "test", memoryGb: 128, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["git", "docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };
const root = mkdtempSync(join(tmpdir(), "invincible-private-run-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1200, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads }, memoryGbps: 9.5 };
};
const fence = "```";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const first = turns[0]?.content ?? "";
    let text = "1. Note who wrote and what about in /work/out/triage.md.\nDone when: the file is there.";
    if (first.startsWith("You are reviewing")) text = "PASS\nThe triage note is there.";
    else if (first.startsWith("Run:")) {
      // The engineer, given the run's goal with what woke it: it notes the sender and the subject, as asked.
      const from = /From: ([^\n]+)/.exec(first)?.[1] ?? "?";
      const subject = /Subject: ([^\n]+)/.exec(first)?.[1] ?? "?";
      text = turns.filter((m) => m.role === "assistant").length === 0 ? `Noting it.\n${fence}sh\nprintf '%s\\n' '${from}: ${subject}' >> /work/out/triage.md\n${fence}` : "DONE\nNoted.";
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});
async function call<T = any>(name: RouteName, input?: unknown, token = home.adminToken()): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(`${name} → ${response.status} ${body.error ?? ""}`);
  return body as T;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure, slotWaitMs: 4_000 });
  await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
  for (const role of ["planner", "reviewer", "engineer"]) await call("setRoster", { role, models: ["stand-in/m"] });
  docker.onExec = () => ({ code: 0, stdout: "" });
  // A loop that new mail wakes, to note who wrote and what about.
  await call("setLoop", { name: "triage", schedule: "0 9 * * 1", task: { kind: "run", goal: "Note who wrote and what about in /work/out/triage.md", network: "isolated" }, wakes: [{ kind: "mail", connector: "gmail", query: "from:ingrid" }] });
});
afterAll(async () => {
  await daemon?.stop();
  models.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a run that your mail woke writes none of the mail's words into the ledger, and an agent reads none of its lines", async () => {
  // New mail, as the watcher makes it (wakes.ts): its text says only that; who and what are its detail, for the run.
  const mail = { id: "mail:gmail:a1b2c3d4", source: "mail" as const, at: Date.now(), text: "new Gmail mail", detail: "From: Ingrid Vestergaard <ingrid@example.test>\nSubject: Quarterly rent arrears", private: true as const };
  expect(daemon.loops.wake("triage", [mail])).toBe(1);
  await daemon.loops.settled("triage");
  // It ran its command, and the log every node of yours replicates says so, and how it ended, in no word of the mail.
  const lines = daemon.store.ledger(500).filter((e) => e.body.run === "arm.loop.triage");
  expect(lines.some((e) => e.body.resource === "sandbox.exec")).toBe(true);
  for (const line of lines) expect([line.body.resource, /Ingrid|Vestergaard|rent arrears/.test(JSON.stringify(line.body))]).toEqual([line.body.resource, false]);
  expect(lines.find((e) => e.body.resource === "sandbox.exec")!.body.detail).toMatch(/^a command of a run your private data woke → exit \d+$/);
  // An agent reads none of the run's lines, and none of its words anywhere it reads.
  const agent = (await call<{ token: string }>("mintArm", { label: "coder" })).token;
  const theirs = await call<{ entries: { run: string | null }[] }>("ledger", {}, agent);
  expect(theirs.entries.filter((e) => e.run === "arm.loop.triage")).toEqual([]);
  for (const name of ["loopRuns", "runs", "loops"] as RouteName[]) expect([name, /Ingrid|rent arrears/.test(JSON.stringify(await call(name, name === "loopRuns" ? { name: "triage" } : {}, agent)))]).toEqual([name, false]);
}, 60_000);

test("and the mind keeps no word of it: the run writes no memory of itself (no skill from it either), so no agent recalls one", async () => {
  // (The run above ran: its record is there, and says how it went.)
  expect(daemon.store.loopRuns("triage").length).toBeGreaterThan(0);
  const agent = (await call<{ token: string }>("mintArm", { label: "reader" })).token;
  for (const q of ["Ingrid", "rent arrears", "Run"]) {
    const { memories } = await call<{ memories: { text: string }[] }>("recall", { q, limit: 50 }, agent);
    expect([q, memories.filter((m) => /Ingrid|Vestergaard|rent arrears/.test(m.text)).length]).toEqual([q, 0]);
  }
});

test("a command of that run that a rule of yours stops, or tells you of, is written without the mail's words: its line and its notice", async () => {
  // (The sandbox's hook says so for the run's arm, so the run it names is a run of the loop's arm: arm.loop.triage.<id>.)
  await call("setRule", { name: "no-printf", does: "refuse", words: [], contains: "printf" });
  await call("setRule", { name: "notes", does: "tell", words: ["printf"] });
  const command = "printf '%s\\n' 'Ingrid Vestergaard <ingrid@example.test>: Quarterly rent arrears' >> /work/out/triage.md";
  await call("ruleTripped", { run: "arm.loop.triage.t1", rule: "no-printf", command });
  await call("ruleTold", { run: "arm.loop.triage.t1", rule: "notes", command, exitCode: 0 });
  const trip = daemon.store.ledger(50).find((e) => e.body.resource === "rule" && e.body.run === "arm.loop.triage.t1")!;
  expect([trip.body.verdict, /Ingrid|Vestergaard|rent arrears/.test(JSON.stringify(trip.body))]).toEqual(["deny", false]);
  const notice = (await call<{ notices: { source: string; body: string }[] }>("notices")).notices.find((n) => n.source === "rule:notes")!;
  expect([notice.body.startsWith("In one of its runs (arm.loop.triage.t1), and it succeeded"), /Ingrid|Vestergaard|rent arrears/.test(notice.body)]).toEqual([true, false]);
  // A run of no loop of yours that mail wakes is written as it was.
  await call("ruleTripped", { run: "q-plain", rule: "no-printf", command: "printf 'hello' > /tmp/a" });
  expect(daemon.store.ledger(50).find((e) => e.body.resource === "rule" && e.body.run === "q-plain")!.body.detail).toBe("printf 'hello' > /tmp/a");
});
