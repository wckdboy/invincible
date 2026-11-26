import { describe, expect, test } from "bun:test";
import { b64u, MAC_VM_OVERHEAD, type NodeCapacity, newNodeIdentity, SELF_ACTION_QUEST, VM_OVERHEAD } from "@galahad/core";
import { foundFleet, MindStore, Vault } from "@galahad/mind";
import type { CreateInput, LedgerEntryInput, SpawnTerminal } from "@galahad/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { GovernedSandboxHost } from "../src/compute/governed-host.ts";
import { Governor, KEPT_WORK_MS } from "../src/compute/governor.ts";
import { modelSpeed, sandboxStart } from "../src/compute/measure.ts";
import { fakeDocker } from "./fake-docker.ts";
// (The sandbox package's stand-in for Apple's container: a Mac's host, behind the same governor.)
import { fakeContainer } from "../../sandbox/test/fake-container.ts";
import { ContainerVolumes, KEEPERS } from "@galahad/sandbox";

/*
 * The governed sandbox host: the real host's own logic above a stand-in Docker, behind
 * the governor. Every sandbox takes a slot first; what Docker says (or can't say) is
 * read carefully; and the two measurements a calibration takes of this node go
 * through the same door and never call out.
 */

const capacity = (over: Partial<NodeCapacity> = {}): NodeCapacity => ({ cores: 8, memoryGb: 16, sandboxes: 2, modelCalls: 2, strength: 8, speed: 1, measured: true, reasons: [], ...over });
const request = (over: Partial<CreateInput> = {}): CreateInput => ({ network: "isolated", cpus: 4, memoryGb: 8, ttlMinutes: 60, persistent: false, ...over });

function host(over: { capacity?: () => NodeCapacity; microVMs?: boolean; maxWaitMs?: number; now?: () => number; spawnTerminal?: SpawnTerminal } = {}) {
  const docker = fakeDocker();
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
      runner: docker.runner,
      microVMs: over.microVMs ?? false,
      ...(over.spawnTerminal ? { spawnTerminal: over.spawnTerminal } : {}),
    },
    { governor, capacity: cap },
  );
  return { sandbox, governor, docker, ledger };
}

describe("every sandbox takes a slot first", () => {
  test("within the ceiling it starts; past it, it waits, and starts when one ends", async () => {
    const { sandbox, governor, docker } = host();
    const a = await sandbox.create(request({ quest: "q-a" }));
    const b = await sandbox.create(request({ quest: "q-b" }));
    let third: string | null = null;
    const waiting = sandbox.create(request({ quest: "q-c" })).then((s) => (third = s.id));
    await Bun.sleep(20);
    expect(third).toBeNull();
    expect(docker.running()).toBe(2);
    expect(governor.queue()).toMatchObject([{ quest: "q-c" }]);
    // Its own cleanup (the oath lets a quest remove its ephemeral sandbox) frees the slot.
    expect((await sandbox.destroy(a.id, { quest: "q-a" })).verdict).toBe("allow");
    await waiting;
    expect(third).not.toBeNull();
    expect(docker.peak()).toBe(2);
    // A destroy the oath doesn't allow frees nothing.
    expect((await sandbox.destroy(b.id, { quest: "someone-else" })).verdict).toBe("ask");
    expect(governor.usage().sandboxes).toBe(2);
  });

  test("a persistent sandbox (a knight's own VM) takes no slot, and is held by its size (its threads while it works); Docker's list says so again after a restart", async () => {
    const { sandbox, governor } = host({ capacity: () => capacity({ cores: 32, memoryGb: 64 }) });
    for (const knight of ["ada", "lin", "sam"]) await sandbox.create(request({ quest: `arm.team.abcdef0123.${knight}`, persistent: true, cpus: 1, memoryGb: 2 }));
    expect(governor.usage()).toMatchObject({ sandboxes: 0, kept: 3, cores: 0, memoryGb: 6 });
    // Both slots are still there for work that comes and goes.
    await sandbox.create(request({ quest: "q-a" }));
    await sandbox.create(request({ quest: "q-b" }));
    expect(governor.usage()).toMatchObject({ sandboxes: 2, kept: 3 });
    await sandbox.reconcile();
    expect(governor.usage()).toMatchObject({ sandboxes: 2, kept: 3, cores: 8, memoryGb: 22 });
  });

  test("a command in a knight's VM holds its threads of the ceiling while it runs, and a while after; one in a quest's sandbox changes nothing", async () => {
    const { sandbox, governor, docker } = host({ capacity: () => capacity({ cores: 32, memoryGb: 64 }) });
    const vm = await sandbox.create(request({ quest: "arm.team.abcdef0123.ada", persistent: true, cpus: 2, memoryGb: 2 }));
    const quest = await sandbox.create(request({ quest: "q-a" }));
    expect(governor.usage()).toMatchObject({ kept: 1, sandboxes: 1, cores: 4, memoryGb: 10 });
    let during = -1;
    docker.onExec = () => {
      during = governor.usage().cores;
      return { code: 0, stdout: "" };
    };
    await sandbox.exec(vm.id, ["true"], 30);
    expect(during).toBe(6);
    expect(governor.usage().cores).toBe(6);
    await sandbox.exec(quest.id, ["true"], 30);
    expect(governor.usage().cores).toBe(6);
  });

  test("a terminal into a knight's VM holds its threads while it is open, and a while after; what is done on its desktop does too", async () => {
    let clock = 1_000_000;
    let hangUp!: (code: number) => void;
    const shell = { write() {}, resize() {}, kill: () => hangUp(0), exited: new Promise<number>((resolve) => (hangUp = resolve)) };
    const { sandbox, governor, docker } = host({ microVMs: true, capacity: () => capacity({ cores: 32, memoryGb: 64 }), now: () => clock, spawnTerminal: () => shell });
    const quest = "arm.team.abcdef0123.ada";
    const vm = await sandbox.create(request({ quest, persistent: true, cpus: 2, memoryGb: 2, isolation: "vm" }));
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
    await sandbox.desktop(vm.id, quest, { do: "click", x: 10, y: 20 });
    expect(during).toBe(threads);
    expect(governor.usage().cores).toBe(threads);
    clock += KEPT_WORK_MS;
    expect(governor.usage().cores).toBe(0);
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
    await first.sandbox.create(request({ quest: "q-old" }));
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
    const ticket = await governor.acquire({ cpus: 4, memoryGb: 8 }, { quest: "q" });
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
    // His own, small, and in the ledger under his own quest.
    expect(ledger.filter((e) => e.resource === "docker.container" && e.class === "create").every((e) => e.quest === SELF_ACTION_QUEST && /1 cpu · 1 GB/.test(e.detail ?? ""))).toBe(true);
    expect(ledger.filter((e) => e.class === "delete" && e.verdict === "allow")).toHaveLength(2);
    // Full: he doesn't queue behind real work, nor in front of it.
    await sandbox.create(request());
    await sandbox.create(request());
    expect(await sandboxStart(sandbox, governor, () => capacity())).toEqual([]);
    expect(docker.running()).toBe(2);
  });

  test("a local model's speed: only a runtime on this machine, never one that was repointed elsewhere", async () => {
    const identity = newNodeIdentity();
    const store = new MindStore(":memory:");
    foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
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
    // "ollama" repointed at a service elsewhere, with a key of its own there: measuring himself never calls out.
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
    await sandbox.create(request({ network: "gateway", quest: "q-1" }));
    await sandbox.create(request({ network: "gateway", quest: "q-2" }));
    // Every slot taken: a sandbox Galahad could make would wait; one a Mac can't make is told so now.
    await expect(sandbox.create(request({ network: "isolated", quest: "q-3" }))).rejects.toThrow(/no network at all/);
    expect(governor.queue()).toEqual([]);
    expect(governor.usage().sandboxes).toBe(2);
  });

  test("a calibration measures what a Mac makes: a VM, on the gateway network, the most a Mac cuts one off", async () => {
    const { sandbox, governor, fake, ledger } = mac();
    const starts = await sandboxStart(sandbox, governor, () => capacity({ cores: 12, memoryGb: 24, sandboxes: 2 }));
    expect(starts.map((s) => s.kind)).toEqual(["vm"]);
    expect(ledger.filter((e) => e.class === "create" && e.resource === "docker.container" && e.target.startsWith("galahad-sbx-")).map((e) => e.detail)).toEqual(["microVM · gateway · 1 cpu · 1 GB · 20 GB disk · galahad/sandbox:1"]);
    // Nothing of it is left: only the networks' keepers, which are no sandboxes.
    expect([...fake.vms.keys()]).toEqual([KEEPERS.gateway, KEEPERS.online]);
    expect(fake.volumes.size).toBe(0);
  });
});
