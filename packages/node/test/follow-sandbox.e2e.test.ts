import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOW, FOLLOW_SECONDS } from "@invincible/agents";
import { bodyFingerprint, type Calibration, ceilingThreads, KERNEL, type LedgerEntry, REFERENCE_SINGLE, type RouteName, routes, type SandboxView } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { SandboxStream, SpawnStream } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A coding agent's run followed as it goes (followSandbox; I15 step 5): a real daemon over real HTTP, with stand-ins for
 * Docker and for the one long-lived command in the sandbox. The route runs only the agents' FOLLOW, from where it is
 * asked to start, never a command of the caller's; its answer is that command's lines as they come; the ledger says it
 * ran and where; and the answer's end is the command's.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "follow-test", cores: 8, cpu: "test", memoryGb: 16, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: false } };
const root = mkdtempSync(join(tmpdir(), "invincible-follow-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
let daemon: Daemon;
/** The node "measures" itself at once (the real benchmark takes seconds): its slots follow from what it says. */
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL }, memoryGbps: 9.5 };
};

/** Each command started to run while it's wanted: what it was, the lines a test gives it, and whether it was ended. */
const opened: { argv: string[]; push(...lines: string[]): void; end(): void; killed: boolean }[] = [];
const spawnStream: SpawnStream = (argv): SandboxStream => {
  const held: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const entry = {
    argv,
    killed: false,
    push: (...lines: string[]) => { held.push(...lines); wake?.(); },
    end: () => { ended = true; wake?.(); },
  };
  opened.push(entry);
  // (As FOLLOW does at once: how the run stands, before anything of it is said.)
  held.push('S{"alive": true, "exit": null, "next": 0}');
  async function* lines(): AsyncIterable<string> {
    for (;;) {
      if (held.length) yield held.shift()!;
      else if (ended) {
        exit(entry.killed ? 137 : 0);
        return;
      } else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return { lines: lines(), write: () => {}, close: () => {}, kill: () => { entry.killed = true; entry.end(); }, exited };
};

async function call(name: RouteName, input: unknown, init: { signal?: AbortSignal } = {}): Promise<Response> {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, ...(route.method === "POST" ? { body: JSON.stringify(input) } : {}), ...init });
}
/** The one sandbox every follow here is of (a node gives each run of its slots one at a time). */
let sandbox: SandboxView;
async function until(ready: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error("never got there");
    await Bun.sleep(5);
  }
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "follow", nodeName: "host" });
  store.close();
  home.writeConfig({ v: 1, name: "host", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, spawnStream, measure, archiveIntervalMs: false });
  await until(() => daemon.store.lww(`calibration:${daemon.identity.id}`) !== null);
  sandbox = ((await (await call("createSandbox", { network: "isolated", run: "follow-run" })).json()) as { sandbox: SandboxView }).sandbox;
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a run followed in its sandbox", () => {
  test("only the follow, from where it was asked, its lines answered as they come, and its end the answer's end", async () => {
    const answer = await call("followSandbox", { id: sandbox.id, offset: 7 });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/x-ndjson");
    await until(() => opened.length === 1);
    const [followed] = opened;
    // The command in the sandbox: the agents' own script and its two numbers, and nothing the caller chose.
    expect(followed!.argv.slice(-6)).toEqual(["python3", "-I", "-c", FOLLOW, "7", String(FOLLOW_SECONDS)]);
    expect(followed!.argv).toContain(`invincible-sbx-${sandbox.id}`);
    const reader = answer.body!.getReader();
    const decoder = new TextDecoder();
    let said = "";
    followed!.push('E20 {"type":"text","text":"one"}');
    while (said.split("\n").length < 3) said += decoder.decode((await reader.read()).value, { stream: true });
    expect(said).toBe('S{"alive": true, "exit": null, "next": 0}\nE20 {"type":"text","text":"one"}\n');
    followed!.push('S{"alive": false, "exit": 0, "next": 20}');
    followed!.end();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      said += decoder.decode(value, { stream: true });
    }
    expect(said.trim().split("\n")).toEqual(['S{"alive": true, "exit": null, "next": 0}', 'E20 {"type":"text","text":"one"}', 'S{"alive": false, "exit": 0, "next": 20}']);
    // The ledger says it ran and where, never what it ran.
    const ledger = (await (await call("ledger", {})).json()) as { entries: LedgerEntry[] };
    const streamed = ledger.entries.filter((entry) => entry.resource === "sandbox.stream");
    expect(streamed).toHaveLength(1);
    expect(JSON.stringify(streamed)).not.toContain("AGENT_PROCESS");
    expect(JSON.stringify(streamed)).not.toContain("def state");
  });

  test("its caller gone, the command ends with it", async () => {
    const caller = new AbortController();
    const answer = await call("followSandbox", { id: sandbox.id, offset: 0 }, { signal: caller.signal });
    expect(answer.status).toBe(200);
    await until(() => opened.length === 2);
    caller.abort();
    await until(() => opened[1]!.killed);
  });

  test("a sandbox that isn't there is refused, and so is an offset that isn't one: nothing is started", async () => {
    const before = opened.length;
    expect((await call("followSandbox", { id: "0123456789", offset: 0 })).status).toBe(404);
    expect((await call("followSandbox", { id: "0123456789", offset: -1 })).status).toBe(400);
    expect((await call("followSandbox", { id: "0123456789", offset: 0, cmd: ["sh"] })).status).toBe(400);
    expect(opened.length).toBe(before);
  });
});
