import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, MAC_VM_OVERHEAD, type NodeCapacity, newNodeIdentity, SELF_ACTION_RUN, VM_OVERHEAD } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import type { CreateInput, LedgerEntryInput, SpawnFrames, SpawnTerminal } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { GovernedSandboxHost } from "../src/compute/governed-host.ts";
import { Governor, KEPT_WORK_MS } from "../src/compute/governor.ts";
import { modelSpeed, sandboxStart } from "../src/compute/measure.ts";
import { fakeDocker } from "./fake-docker.ts";
// (The sandbox package's stand-in for Apple's container: a Mac's host, behind the same governor.)
import { fakeContainer } from "../../sandbox/test/fake-container.ts";
import { ContainerVolumes, KEEPERS, LABEL } from "@invincible/sandbox";

/*
 * The governed sandbox host: the real host's own logic above a stand-in Docker, behind
 * the governor. Every sandbox takes a slot first; what Docker says (or can't say) is
 * read carefully; and the two measurements a calibration takes of this node go
 * through the same door and never call out.
 */

const capacity = (over: Partial<NodeCapacity> = {}): NodeCapacity => ({ cores: 8, memoryGb: 16, sandboxes: 2, modelCalls: 2, strength: 8, speed: 1, measured: true, reasons: [], ...over });
const request = (over: Partial<CreateInput> = {}): CreateInput => ({ network: "isolated", cpus: 4, memoryGb: 8, ttlMinutes: 60, persistent: false, ...over });

function host(over: { capacity?: () => NodeCapacity; microVMs?: boolean; maxWaitMs?: number; now?: () => number; spawnTerminal?: SpawnTerminal; spawnFrames?: SpawnFrames; layout2?: boolean; gateUsers?: string } = {}) {
  const docker = fakeDocker(over.layout2 ? { engine: "27.3.1" } : {});
  /** Every call the host made of Docker, as it made it. */
  const calls: string[][] = [];
  const ledger: LedgerEntryInput[] = [];
  const cap = over.capacity ?? (() => capacity());
  const governor = new Governor({ capacity: cap, host: () => null, retryMs: 5, maxWaitMs: over.maxWaitMs ?? 2_000, ...(over.now ? { now: over.now } : {}) });
  let minted = 0;
  const sandbox = new GovernedSandboxHost(
    {
      node: "n_test",
      tokens: { mint: () => ({ token: `gw_${++minted}`, info: { hash: `h${minted}` } }), revoke: () => true },
      ledger: (entry) => void ledger.push(entry),
      maxCpus: 64,
      maxMemoryGb: 512,
      runner: (args, timeoutMs) => {
        calls.push(args);
        return docker.runner(args, timeoutMs);
      },
      microVMs: over.microVMs ?? false,
      ...(over.gateUsers ? { gateUsers: over.gateUsers } : {}),
      ...(over.layout2 ? { layout2: true } : {}),
      ...(over.spawnTerminal ? { spawnTerminal: over.spawnTerminal } : {}),
      ...(over.spawnFrames ? { spawnFrames: over.spawnFrames } : {}),
    },
    { governor, capacity: cap },
  );
  return { sandbox, governor, docker, ledger, calls };
}

describe("another node's task's VM, waiting for room (the fourth fabric review's I-2)", () => {
  test("a task that ends while its VM waits for room leaves the queue: none is made for it, even once room comes", async () => {
    const { sandbox, governor, docker } = host({ layout2: true });
    // The agent's VM (in layout 2), and another sandbox in the node's second slot: no room for one more.
    const agent = await sandbox.create(request({ network: "gateway", persistent: true, run: "arm.team.abcdef0123.ada" }));
    const other = await sandbox.create(request({ run: "q-other" }));
    const ended = new AbortController();
    const waiting = sandbox.createTaskVm({ task: "task-abcdefghijkl", beside: agent.id, run: "handed.task-abcdefghijkl", providers: [], models: [], ttlMinutes: 60 }, ended.signal);
    const outcome = waiting.then(() => "made", (error: Error) => `not made: ${error.message}`);
    await Bun.sleep(20);
    expect(governor.queue()).toMatchObject([{ run: "handed.task-abcdefghijkl" }]);
    ended.abort();
    await Bun.sleep(10);
    // It left the queue as its task ended, so when room comes at once (well within the governor's longest wait),
    // nothing was waiting for it, and no task's VM is made.
    expect(governor.queue()).toEqual([]);
    await sandbox.destroy(other.id, { run: "q-other" });
    expect(await outcome).toBe("not made: the caller gave up waiting for a slot");
    expect(await sandbox.taskVms()).toEqual([]);
    expect(docker.running()).toBe(1);
  });
});

describe("another node's task's gates' own user (the eighth fabric review's R8-3)", () => {
  test("a command asked as a gate's user runs as it, from the gates' folder, behind the governor too; and only in a VM made for a round of another node's task's gates", async () => {
    const { sandbox, docker } = host({ layout2: true, capacity: () => capacity({ cores: 32, memoryGb: 64, sandboxes: 4 }) });
    const agent = await sandbox.create(request({ network: "gateway", persistent: true, run: "arm.team.abcdef0123.ada" }));
    const vm = await sandbox.createTaskVm({ task: "task-abcdefghijkl", beside: agent.id, run: "handed.task-abcdefghijkl", providers: [], models: [], ttlMinutes: 60 });
    const round = await sandbox.createGateVm({ task: "task-abcdefghijkl", of: vm.id, beside: agent.id, run: "handed.task-abcdefghijkl", ttlMinutes: 60 });
    // (Made from its task's VM, with no network, and marked as a round's.)
    expect(round).toMatchObject({ task: "task-abcdefghijkl", gate: true, network: "isolated", image: vm.image });
    await sandbox.exec(round.id, ["test", "-f", "x"], 30, undefined, 61001);
    expect(docker.execOptions.at(-1)).toEqual(["--user", "61001:61001", "--workdir", "/gates"]);
    // (A gate's user alone: never another.)
    await expect(sandbox.exec(round.id, ["true"], 30, undefined, 1000)).rejects.toThrow("not a gate's user");
    // (Its other commands, as the VMs' user, from /work, as ever.)
    await sandbox.exec(round.id, ["true"], 30);
    expect(docker.execOptions.at(-1)).toEqual(["--workdir", "/work"]);
    // Neither the task's own VM nor an agent's has the gates' user.
    for (const other of [vm, agent]) await expect(sandbox.exec(other.id, ["true"], 30, undefined, 61002)).rejects.toThrow("only a VM made for a round of another node's task's gates has its gates' own users");
    // A round is made beside its task's own VM alone.
    await expect(sandbox.createGateVm({ task: "task-abcdefghijkl", of: agent.id, beside: agent.id, run: "handed.task-abcdefghijkl", ttlMinutes: 60 })).rejects.toThrow("beside that task's own VM");
  });
});

describe("another node's task's gates' users by name (the twelfth fabric review's R12-1)", () => {
  test("a round's VM names its gates' users, the image's own and then gate1… (61001…), read from its image once and mounted read-only", async () => {
    const users = mkdtempSync(join(tmpdir(), "gate-users-"));
    try {
      const { sandbox, calls } = host({ layout2: true, gateUsers: users, capacity: () => capacity({ cores: 32, memoryGb: 64, sandboxes: 4 }) });
      const agent = await sandbox.create(request({ network: "gateway", persistent: true, run: "arm.team.abcdef0123.ada" }));
      const vm = await sandbox.createTaskVm({ task: "task-abcdefghijkl", beside: agent.id, run: "handed.task-abcdefghijkl", providers: [], models: [], ttlMinutes: 60 });
      const reads = () => calls.filter((args) => args[0] === "run" && args.includes("/bin/cat"));
      await sandbox.createGateVm({ task: "task-abcdefghijkl", of: vm.id, beside: agent.id, run: "handed.task-abcdefghijkl", ttlMinutes: 60 });
      // (Read as no VM's: no network, no capability, read-only, as the VMs' user, by cat alone.)
      expect(reads().map((args) => args.at(-1))).toEqual(["/etc/passwd", "/etc/group"]);
      for (const args of reads()) for (const flag of ["--rm", "--read-only", "no-new-privileges:true"]) expect(args).toContain(flag);
      expect(reads().every((args) => args[args.indexOf("--network") + 1] === "none" && args[args.indexOf("--cap-drop") + 1] === "ALL" && args[args.indexOf("--user") + 1] === "1000:1000")).toBe(true);
      // Mounted read-only over the image's, into the round's VM alone.
      const folder = join(users, "fake");
      const made = calls.filter((args) => args[0] === "run" && !args.includes("--rm"));
      const mounts = (args: string[]) => args.filter((_, i) => args[i - 1] === "--mount");
      const round = made.find((args) => args.includes(`${LABEL}.gate=1`))!;
      expect(mounts(round)).toEqual(expect.arrayContaining([`type=bind,src=${join(folder, "passwd")},dst=/etc/passwd,readonly`, `type=bind,src=${join(folder, "group")},dst=/etc/group,readonly`]));
      for (const other of made.filter((args) => args !== round)) expect(mounts(other).some((m) => m.includes("/etc/passwd"))).toBe(false);
      const passwd = readFileSync(join(folder, "passwd"), "utf8").trimEnd().split("\n");
      expect(passwd.slice(0, 3)).toEqual(["root:x:0:0:root:/root:/bin/bash", "agent:x:1000:1000::/work:/bin/bash", "gate1:x:61001:61001:a gate's user:/nonexistent:/usr/sbin/nologin"]);
      expect(passwd).toHaveLength(2 + 256);
      expect(readFileSync(join(folder, "group"), "utf8").trimEnd().split("\n").at(-1)).toBe("gate256:x:61256:");
      // Another round of the same image reads it no more.
      await sandbox.createGateVm({ task: "task-abcdefghijkl", of: vm.id, beside: agent.id, run: "handed.task-abcdefghijkl", ttlMinutes: 60 });
      expect(reads()).toHaveLength(2);
    } finally {
      rmSync(users, { recursive: true, force: true });
    }
  });
});

describe("every sandbox takes a slot first", () => {
  test("within the ceiling it starts; past it, it waits, and starts when one ends", async () => {
    const { sandbox, governor, docker } = host();
    const a = await sandbox.create(request({ run: "q-a" }));
    const b = await sandbox.create(request({ run: "q-b" }));
    let third: string | null = null;
    const waiting = sandbox.create(request({ run: "q-c" })).then((s) => (third = s.id));
    await Bun.sleep(20);
    expect(third).toBeNull();
    expect(docker.running()).toBe(2);
    expect(governor.queue()).toMatchObject([{ run: "q-c" }]);
    // Its own cleanup (the policy lets a run remove its ephemeral sandbox) frees the slot.
    expect((await sandbox.destroy(a.id, { run: "q-a" })).verdict).toBe("allow");
    await waiting;
    expect(third).not.toBeNull();
    expect(docker.peak()).toBe(2);
    // A destroy the policy doesn't allow frees nothing.
    expect((await sandbox.destroy(b.id, { run: "someone-else" })).verdict).toBe("ask");
    expect(governor.usage().sandboxes).toBe(2);
  });

  test("a persistent sandbox (an agent's own VM) takes no slot, and is held by its size (its threads while it works); Docker's list says so again after a restart", async () => {
    const { sandbox, governor } = host({ capacity: () => capacity({ cores: 32, memoryGb: 64 }) });
    for (const agent of ["ada", "lin", "sam"]) await sandbox.create(request({ run: `arm.team.abcdef0123.${agent}`, persistent: true, cpus: 1, memoryGb: 2 }));
    expect(governor.usage()).toMatchObject({ sandboxes: 0, kept: 3, cores: 0, memoryGb: 6 });
    // Both slots are still there for work that comes and goes.
    await sandbox.create(request({ run: "q-a" }));
    await sandbox.create(request({ run: "q-b" }));
    expect(governor.usage()).toMatchObject({ sandboxes: 2, kept: 3 });
    await sandbox.reconcile();
    expect(governor.usage()).toMatchObject({ sandboxes: 2, kept: 3, cores: 8, memoryGb: 22 });
  });

  test("a command in an agent's VM holds its threads of the ceiling while it runs, and a while after; one in a run's sandbox changes nothing", async () => {
    const { sandbox, governor, docker } = host({ capacity: () => capacity({ cores: 32, memoryGb: 64 }) });
    const vm = await sandbox.create(request({ run: "arm.team.abcdef0123.ada", persistent: true, cpus: 2, memoryGb: 2 }));
    const run = await sandbox.create(request({ run: "q-a" }));
    expect(governor.usage()).toMatchObject({ kept: 1, sandboxes: 1, cores: 4, memoryGb: 10 });
    let during = -1;
    docker.onExec = () => {
      during = governor.usage().cores;
      return { code: 0, stdout: "" };
    };
    await sandbox.exec(vm.id, ["true"], 30);
    expect(during).toBe(6);
    expect(governor.usage().cores).toBe(6);
    await sandbox.exec(run.id, ["true"], 30);
    expect(governor.usage().cores).toBe(6);
  });

  test("a terminal into an agent's VM holds its threads while it is open, and a while after; what is done on its desktop does too", async () => {
    let clock = 1_000_000;
    let hangUp!: (code: number) => void;
    const shell = { write() {}, resize() {}, kill: () => hangUp(0), exited: new Promise<number>((resolve) => (hangUp = resolve)) };
    const { sandbox, governor, docker } = host({ microVMs: true, capacity: () => capacity({ cores: 32, memoryGb: 64 }), now: () => clock, spawnTerminal: () => shell });
    const run = "arm.team.abcdef0123.ada";
    const vm = await sandbox.create(request({ run, persistent: true, cpus: 2, memoryGb: 2, isolation: "vm" }));
    const threads = 2 + VM_OVERHEAD.cpus;
    expect(governor.usage().cores).toBe(0);

    const opened = await sandbox.terminal(vm.id, { cols: 80, rows: 24 }, () => {});
    expect(governor.usage().cores).toBe(threads);
    // Open an hour with nothing else run in it: what you run there is work all the while.
    clock += 60 * 60_000;
    expect(governor.usage().cores).toBe(threads);
    opened.process.kill();
    await opened.process.exited;
    expect(governor.usage().cores).toBe(threads);
    clock += KEPT_WORK_MS;
    expect(governor.usage().cores).toBe(0);

    let during = -1;
    docker.onExec = () => ((during = governor.usage().cores), { code: 0, stdout: "c2hvdA==" });
    await sandbox.desktop(vm.id, run, { do: "click", x: 10, y: 20 });
    expect(during).toBe(threads);
    expect(governor.usage().cores).toBe(threads);
    clock += KEPT_WORK_MS;
    expect(governor.usage().cores).toBe(0);
  });

  test("watching an agent's desktop holds its VM's threads while its encoder runs, and a while after, as a terminal does", async () => {
    let clock = 1_000_000;
    let ended!: (code: number) => void;
    // The encoder's stand-in: a keyframe, then nothing until its stdin is closed.
    const keyframe = new Uint8Array([0, 0, 0, 10, 1, 0, 0, 1, 0x9a, 0x7e, 0x4c, 0x40, 0, 7]);
    const exited = new Promise<number>((resolve) => (ended = resolve));
    const spawnFrames: SpawnFrames = () => ({
      chunks: (async function* () { yield keyframe; await exited; })(),
      write() {},
      close: () => ended(0),
      kill: () => ended(137),
      exited,
    });
    const { sandbox, governor } = host({ microVMs: true, capacity: () => capacity({ cores: 32, memoryGb: 64 }), now: () => clock, spawnFrames });
    const run = "arm.team.abcdef0123.ada";
    const vm = await sandbox.create(request({ run, persistent: true, cpus: 2, memoryGb: 2, isolation: "vm", desktop: true }));
    const threads = 2 + VM_OVERHEAD.cpus;
    expect(governor.usage().cores).toBe(0);
    const watching = await sandbox.desktopWatch(vm.id, run);
    expect(governor.usage().cores).toBe(threads);
    clock += 60 * 60_000;
    expect(governor.usage().cores).toBe(threads);
    await watching.cancel();
    await exited;
    expect(governor.usage().cores).toBe(threads);
    clock += KEPT_WORK_MS;
    expect(governor.usage().cores).toBe(0);
  });

  test("an agent's desktop's first use grows its VM within the ceiling; with no room left it runs with what it has, never made again, and the ledger says why", async () => {
    const run = "arm.team.abcdef0123.ada";
    const look = async (memoryGb: number) => {
      const { sandbox, governor, docker, ledger } = host({ microVMs: true, capacity: () => capacity({ cores: 32, memoryGb }) });
      docker.onExec = (_container, command) => (command.join(" ").includes("base64 -w0") ? { code: 0, stdout: "/9j/4AAQ" } : { code: 0, stdout: "" });
      const vm = await sandbox.create(request({ run, persistent: true, cpus: 1, memoryGb: 2, isolation: "vm", desktop: true }));
      expect(governor.usage().memoryGb).toBe(2 + VM_OVERHEAD.memoryGb);
      const made = docker.running();
      expect(await sandbox.desktop(vm.id, run, { do: "look" })).toMatchObject({ width: 1280, height: 800 });
      expect(docker.running()).toBe(made);
      return { governor, ledger, now: (await sandbox.get(vm.id))! };
    };
    // Room: grown to 4 GB as it runs, and held of the ceiling.
    const roomy = await look(16);
    expect(roomy.now.memoryGb).toBe(4);
    expect(roomy.governor.usage().memoryGb).toBe(4 + VM_OVERHEAD.memoryGb);
    // None: it stays at 2 GB, nothing more is held of the ceiling for it, and the ledger says why.
    const full = await look(5);
    expect(full.now.memoryGb).toBe(2);
    expect(full.governor.usage().memoryGb).toBe(2 + VM_OVERHEAD.memoryGb);
    expect(full.ledger.find((e) => e.resource === "docker.container" && e.verdict === "deny")).toMatchObject({ reason: expect.stringContaining("its desktop starts with 2 GB, not grown to 4"), detail: expect.stringContaining("its work as it was") });
  });

  test("more than the ceiling gets the ceiling; a microVM's overhead comes out of it", async () => {
    const plain = host();
    expect(await plain.sandbox.create(request({ cpus: 64, memoryGb: 512 }))).toMatchObject({ cpus: 8, memoryGb: 16 });
    expect(plain.governor.usage()).toMatchObject({ cores: 8, memoryGb: 16 });
    const vms = host({ microVMs: true });
    expect(await vms.sandbox.create(request({ cpus: 64, memoryGb: 512, isolation: "vm" }))).toMatchObject({ cpus: 7, memoryGb: 14, isolation: "vm" });
    expect(vms.governor.usage()).toMatchObject({ cores: 8, memoryGb: 16 });
  });

  test("a ceiling too small for a microVM's own overhead carries none, and says so", async () => {
    const tiny = host({ microVMs: true, capacity: () => capacity({ cores: 1, memoryGb: 2, sandboxes: 1 }) });
    await expect(tiny.sandbox.create(request({ isolation: "vm" }))).rejects.toThrow(/too small for a microVM/);
    expect(tiny.docker.running()).toBe(0);
    expect(tiny.governor.usage().sandboxes).toBe(0);
    // A container fits there.
    expect(await tiny.sandbox.create(request())).toMatchObject({ cpus: 1, memoryGb: 2 });
  });

  test("a sandbox that fails to start gives its slot back", async () => {
    const { sandbox, governor, docker } = host();
    const run = docker.runner;
    const failing = host();
    void run;
    const broken = new GovernedSandboxHost(
      {
        node: "n_test",
        tokens: { mint: () => ({ token: "gw", info: { hash: "h" } }), revoke: () => true },
        ledger: () => {},
        maxCpus: 64,
        maxMemoryGb: 512,
        runner: async (args, ms) => (args[0] === "run" ? { code: 125, stdout: "", stderr: "no space left on device" } : failing.docker.runner(args, ms)),
      },
      { governor: failing.governor, capacity: () => capacity() },
    );
    await expect(broken.create(request())).rejects.toThrow(/could not start sandbox/);
    expect(failing.governor.usage().sandboxes).toBe(0);
    expect(governor.usage().sandboxes).toBe(0);
    void sandbox;
  });
});

describe("Docker's list is the truth, read carefully", () => {
  test("sandboxes from before a restart hold their slots; when Docker can't say, nothing is freed", async () => {
    const first = host();
    await first.sandbox.create(request({ run: "q-old" }));
    // A new node process over the same Docker: it knows nothing until it asks.
    const governor = new Governor({ capacity: () => capacity(), host: () => null });
    let down = false;
    const again = new GovernedSandboxHost(
      {
        node: "n_test",
        tokens: { mint: () => ({ token: "gw", info: { hash: "h" } }), revoke: () => true },
        ledger: () => {},
        maxCpus: 64,
        maxMemoryGb: 512,
        runner: async (args, ms) => (down ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } : first.docker.runner(args, ms)),
      },
      { governor, capacity: () => capacity() },
    );
    expect(governor.usage().sandboxes).toBe(0);
    await again.reconcile();
    expect(governor.usage()).toMatchObject({ sandboxes: 1, cores: 4, memoryGb: 8 });
    // Docker stops answering: a failed list isn't "no sandboxes".
    down = true;
    await again.reconcile();
    expect(governor.usage().sandboxes).toBe(1);
  });

  test("a list asked for before a sandbox came to be never frees its slot", async () => {
    const { governor } = host();
    const asked = governor.mark();
    const ticket = await governor.acquire({ cpus: 4, memoryGb: 8 }, { run: "q" });
    governor.bind(ticket, "cccccccccc");
    // Docker's answer arrives now, from before it existed.
    governor.adopt([], asked);
    expect(governor.usage().sandboxes).toBe(1);
    // A list asked for after it existed that doesn't have it: it really is gone.
    governor.adopt([], governor.mark());
    expect(governor.usage().sandboxes).toBe(0);
  });
});

describe("what a calibration measures of this node, through the same door", () => {
  test("a sandbox's start-up, per kind, with its own sandboxes gone afterwards; never when the node is full", async () => {
    const { sandbox, governor, docker, ledger } = host({ microVMs: true });
    docker.startMs = 15;
    const starts = await sandboxStart(sandbox, governor, () => capacity());
    expect(starts.map((s) => s.kind)).toEqual(["container", "vm"]);
    expect(starts.every((s) => s.startMs >= 10)).toBe(true);
    expect(docker.running()).toBe(0);
    expect(governor.usage().sandboxes).toBe(0);
    // Its own, small, and in the ledger under its own run.
    expect(ledger.filter((e) => e.resource === "docker.container" && e.class === "create").every((e) => e.run === SELF_ACTION_RUN && /1 cpu · 1 GB/.test(e.detail ?? ""))).toBe(true);
    expect(ledger.filter((e) => e.class === "delete" && e.verdict === "allow")).toHaveLength(2);
    // Full: it doesn't queue behind real work, nor in front of it.
    await sandbox.create(request());
    await sandbox.create(request());
    expect(await sandboxStart(sandbox, governor, () => capacity())).toEqual([]);
    expect(docker.running()).toBe(2);
  });

  test("a local model's speed: only a runtime on this machine, never one that was repointed elsewhere", async () => {
    const identity = newNodeIdentity();
    const store = new LedgerStore(":memory:");
    foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
    void b64u;
    const vault = new Vault(store, identity);
    const asked: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const encoder = new TextEncoder();
      const numbers = Array.from({ length: 60 }, (_, i) => `${i + 1}\n`);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 6; i++) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: numbers.slice(i * 10, i * 10 + 10).join("") } }] })}\n\n`));
            await Bun.sleep(60);
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const caps = { localModels: [{ runtime: "ollama", models: ["qwen3-embedding:0.6b", "qwen3:8b"] }] } as Capabilities;
    const governor = new Governor({ capacity: () => capacity(), host: () => null });
    const enter: Governor["enterModel"] = (o, s) => governor.enterModel(o, s);

    // A runtime nobody added as a provider can't be called, so it isn't measured.
    expect(await modelSpeed({ store, vault, fetch: fetchStub }, caps, enter)).toEqual([]);
    expect(asked).toEqual([]);
    store.emit(identity, "provider.set", { id: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1" });
    const speeds = await modelSpeed({ store, vault, fetch: fetchStub }, caps, enter);
    expect(speeds).toHaveLength(1);
    // The chat model, not the embedder; on loopback.
    expect(speeds[0]).toMatchObject({ runtime: "ollama", model: "qwen3:8b" });
    expect(speeds[0]!.tps).toBeGreaterThan(1);
    expect(asked.every((url) => url.startsWith("http://127.0.0.1:11434/"))).toBe(true);
    expect(governor.usage().modelCalls).toBe(0);

    // Only an embedding model: nothing to measure, nothing asked.
    asked.length = 0;
    expect(await modelSpeed({ store, vault, fetch: fetchStub }, { localModels: [{ runtime: "ollama", models: ["qwen3-embedding:0.6b"] }] } as Capabilities, enter)).toEqual([]);
    // "ollama" repointed at a service elsewhere, with a key of its own there: measuring itself never calls out.
    vault.set("ollama", "sk-fake-not-a-real-key-0000000000", { provider: "ollama", origin: "https://models.example.com" });
    store.emit(identity, "provider.set", { id: "ollama", kind: "openai", baseUrl: "https://models.example.com/v1", secret: "ollama" });
    expect(await modelSpeed({ store, vault, fetch: fetchStub }, caps, enter)).toEqual([]);
    expect(asked).toEqual([]);
    store.close();
  }, 20_000);
});

describe("on a Mac (Apple's container), behind the same governor", () => {
  function mac(cap = () => capacity({ cores: 12, memoryGb: 24, sandboxes: 2 }), fake = fakeContainer()) {
    const ledger: LedgerEntryInput[] = [];
    const governor = new Governor({ capacity: cap, host: () => null, retryMs: 5, maxWaitMs: 2_000 });
    const sandbox = new GovernedSandboxHost(
      {
        node: "n_mac",
        engine: "container",
        tokens: { mint: () => ({ token: "gw_mac", info: { hash: "h_mac" } }), revoke: () => true },
        ledger: (entry) => void ledger.push(entry),
        maxCpus: 64,
        maxMemoryGb: 512,
        runner: fake.runner,
        launchctl: async () => ({ code: 0, stdout: "", stderr: "" }),
        firewall: async () => ({ on: true }),
        workspaces: new ContainerVolumes(fake.runner, () => ({ totalBytes: 1000 * 2 ** 30, freeBytes: 900 * 2 ** 30 })),
        microVMs: true,
      },
      { governor, capacity: cap },
    );
    return { sandbox, governor, fake, ledger };
  }

  test("every sandbox is a VM, so each one's own overhead counts against the ceiling, whatever its network: the Mac's, not Kata's", async () => {
    const { sandbox, governor, fake } = mac();
    const made = await sandbox.create(request({ network: "gateway", cpus: 2, memoryGb: 4 }));
    expect(made.isolation).toBe("vm");
    expect(governor.usage()).toMatchObject({ sandboxes: 1, cores: 2 + MAC_VM_OVERHEAD.cpus, memoryGb: 4 + MAC_VM_OVERHEAD.memoryGb });
    expect(MAC_VM_OVERHEAD).toEqual({ cpus: 1, memoryGb: 0.5 });
    // A VM from before the node's restart is counted the same way when the node finds it.
    const again = mac(undefined, fake);
    await again.sandbox.reconcile();
    expect(again.governor.usage()).toMatchObject({ sandboxes: 1, cores: 2 + MAC_VM_OVERHEAD.cpus, memoryGb: 4 + MAC_VM_OVERHEAD.memoryGb });
  });

  test("a VM's CPUs are whole: a part of one is given as one, and the governor counts what it gets", async () => {
    const { sandbox, governor, fake } = mac();
    const made = await sandbox.create(request({ network: "gateway", cpus: 0.5, memoryGb: 1 }));
    expect(made.cpus).toBe(1);
    expect(fake.vms.get(made.name)!.cpus).toBe(1);
    expect(governor.usage().cores).toBe(1 + MAC_VM_OVERHEAD.cpus);
  });

  test("an isolated sandbox is refused there at once, never after waiting for a slot", async () => {
    const { sandbox, governor } = mac();
    await sandbox.create(request({ network: "gateway", run: "q-1" }));
    await sandbox.create(request({ network: "gateway", run: "q-2" }));
    // Every slot taken: a sandbox the primary could make would wait; one a Mac can't make is told so now.
    await expect(sandbox.create(request({ network: "isolated", run: "q-3" }))).rejects.toThrow(/no network at all/);
    expect(governor.queue()).toEqual([]);
    expect(governor.usage().sandboxes).toBe(2);
  });

  test("a calibration measures what a Mac makes: a VM, on the gateway network, the most a Mac cuts one off", async () => {
    const { sandbox, governor, fake, ledger } = mac();
    const starts = await sandboxStart(sandbox, governor, () => capacity({ cores: 12, memoryGb: 24, sandboxes: 2 }));
    expect(starts.map((s) => s.kind)).toEqual(["vm"]);
    expect(ledger.filter((e) => e.class === "create" && e.resource === "docker.container" && e.target.startsWith("invincible-sbx-")).map((e) => e.detail)).toEqual(["microVM · gateway · 1 cpu · 1 GB · 20 GB disk · invincible/sandbox:1"]);
    // Nothing of it is left: only the networks' keepers, which are no sandboxes.
    expect([...fake.vms.keys()]).toEqual([KEEPERS.gateway, KEEPERS.online]);
    expect(fake.volumes.size).toBe(0);
  });
});
