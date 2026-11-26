import { describe, expect, test } from "bun:test";
import { ContainerVolumes, type LedgerEntryInput, type MacFirewallState, NETWORKS, SandboxHost, type TokenMinter } from "../src/index.ts";
import { fakeContainer } from "./fake-container.ts";

/*
 * A knight's VM on a Mac (a stand-in for Apple's container: fake-container.ts). It is resumed as on Linux. It can't
 * grow while it runs, and container can't rename one: so to grow it, or to make it again, it is stopped, deleted
 * (its /work is a volume of its own, which stays) and made again under the same name on the same volume, and the
 * answer says it paused. One that won't start is cleared away and the old one put back as it was.
 */

const GIB = 2 ** 30;
const QUEST = "arm.team.abcdef0123.builder";

async function knightOnAMac() {
  const fake = fakeContainer();
  const ledger: LedgerEntryInput[] = [];
  const minted: Parameters<TokenMinter["mint"]>[0][] = [];
  const revoked: string[] = [];
  const stored = new Map<string, string>();
  const firewall: { state: MacFirewallState } = { state: { on: true } };
  let now = 1_000_000;
  const host = new SandboxHost({
    node: "n_mac",
    engine: "container",
    runner: fake.runner,
    launchctl: async () => ({ code: 0, stdout: "", stderr: "" }),
    firewall: async () => firewall.state,
    workspaces: new ContainerVolumes(fake.runner, () => ({ totalBytes: 1000 * GIB, freeBytes: 900 * GIB })),
    tokenStore: {
      put: (id, hash) => void stored.set(id, hash),
      take: (id) => {
        const hash = stored.get(id) ?? null;
        stored.delete(id);
        return hash;
      },
    },
    tokens: {
      mint: (scope) => {
        minted.push(scope);
        return { token: `test-only-token-${minted.length}`, info: { hash: `test-only-hash-${minted.length}` } };
      },
      revoke: (hash) => {
        revoked.push(hash);
        return true;
      },
    },
    ledger: (entry) => void ledger.push(entry),
    maxCpus: 8,
    maxMemoryGb: 16,
    microVMs: true,
    now: () => now,
  });
  const vm = await host.create({ network: "online", cpus: 1, memoryGb: 2, ttlMinutes: 120, persistent: true, quest: QUEST, isolation: "vm", providers: ["deepseek"], diskGb: 20 });
  const name = `galahad-sbx-${vm.id}`;
  fake.calls.length = 0;
  ledger.length = 0;
  return { fake, host, vm, name, ledger, minted, revoked, stored, firewall, later: (ms: number) => void (now += ms) };
}

describe("a knight's VM on a Mac", () => {
  test("its workspace is made to be kept, whatever becomes of its VM", async () => {
    const k = await knightOnAMac();
    expect(k.fake.volumes.get(`${k.name}-work`)!.labels["dev.galahad.retained"]).toBe("1");
  });

  test("is resumed as on Linux: started when it had stopped, a fresh lease written in it as uid 1000", async () => {
    const k = await knightOnAMac();
    k.fake.vms.get(k.name)!.state = "stopped";
    const resumed = await k.host.prepareTeam(k.vm.id, QUEST);
    expect(resumed.status).toBe("running");
    expect(k.fake.calls.filter((c) => c[0] === "start")).toEqual([["start", k.name]]);
    expect(k.fake.execs.at(-1)).toMatchObject({ name: k.name, user: "1000:1000", cmd: expect.arrayContaining(["python3", "-c"]) });
    expect(k.revoked).toEqual(["test-only-hash-1"]);
    expect(k.minted.at(-1)).toMatchObject({ ttlMinutes: 30, maxRequests: 500 });
  });

  test("is resumed only with the Mac's firewall on: it rejoins its networks as it starts, so it stays stopped and the error says why", async () => {
    const k = await knightOnAMac();
    k.fake.vms.get(k.name)!.state = "stopped";
    k.firewall.state = { on: false, installed: true, soon: false, why: "the sandbox firewall's helper last ran 95 s ago: is it loaded? (sudo launchctl print system/sh.galahad.firewall)" };
    await expect(k.host.prepareTeam(k.vm.id, QUEST)).rejects.toThrow(/no sandbox is made on this Mac while its firewall isn't on: the sandbox firewall's helper last ran 95 s ago/);
    expect(k.fake.vms.get(k.name)!.state).toBe("stopped");
    expect(k.fake.calls.filter((c) => c[0] === "start")).toEqual([]);
  });

  test("grows by pausing: stopped, made again with more on the same volume, started; the answer and the ledger say it paused", async () => {
    const k = await knightOnAMac();
    let paused = false;
    const grown = await k.host.resizeTeam(k.vm.id, QUEST, { cpus: 2, memoryGb: 4, approvedBy: "test-owner", paused: () => void (paused = true) });
    expect(paused).toBe(true);
    expect(grown).toMatchObject({ id: k.vm.id, cpus: 2, memoryGb: 4, status: "running", network: "online", disk: { limitGb: 20 } });
    expect(k.fake.calls.filter((c) => ["stop", "delete", "run"].includes(c[0]!)).map((c) => c[0])).toEqual(["stop", "delete", "run"]);
    const vm = k.fake.vms.get(k.name)!;
    expect(vm.volume).toBe(`${k.name}-work`);
    expect(vm.networks).toEqual([NETWORKS.online.name, NETWORKS.gateway.name]);
    expect(vm.labels["dev.galahad.quest"]).toBe(QUEST);
    expect(vm.labels["dev.galahad.ephemeral"]).toBe("false");
    // Its volume was never left to be taken, and it is the one it had.
    expect(k.fake.volumes.has(`${k.name}-work`)).toBe(true);
    // A fresh lease for the providers it had, the old one revoked.
    expect(k.minted.at(-1)).toMatchObject({ providers: ["deepseek"], ttlMinutes: 7 * 24 * 60 });
    expect(k.revoked).toContain("test-only-hash-1");
    expect(k.ledger).toEqual([expect.objectContaining({ class: "modify", resource: "docker.container", target: k.name, verdict: "approved", quest: QUEST, detail: "paused to grow (a Mac's VM can't grow while it runs): 2 cpu · 4 GB · 20 GB disk" })]);
  });

  test("its disk can't grow on a Mac: refused with the reason, and nothing stops", async () => {
    const k = await knightOnAMac();
    await expect(k.host.resizeTeam(k.vm.id, QUEST, { diskGb: 40, approvedBy: "test-owner" })).rejects.toThrow(/keeps the size it was made with/);
    expect(k.fake.calls.filter((c) => ["stop", "delete", "run"].includes(c[0]!))).toEqual([]);
  });

  test("what the ceiling can't hold is refused before anything stops", async () => {
    const k = await knightOnAMac();
    await expect(k.host.resizeTeam(k.vm.id, QUEST, { cpus: 4, approvedBy: "test-owner", fits: () => "the ceiling is full" })).rejects.toThrow("the ceiling is full");
    expect(k.fake.calls.filter((c) => ["stop", "delete", "run"].includes(c[0]!))).toEqual([]);
  });

  test("asked for what it has, nothing pauses", async () => {
    const k = await knightOnAMac();
    let paused = false;
    await k.host.resizeTeam(k.vm.id, QUEST, { cpus: 1, memoryGb: 2, approvedBy: "test-owner", paused: () => void (paused = true) });
    expect(paused).toBe(false);
    expect(k.fake.calls.filter((c) => ["stop", "delete", "run"].includes(c[0]!))).toEqual([]);
  });

  test("is made again from its image as it is now, its /work kept; its network may change with it", async () => {
    const k = await knightOnAMac();
    const remade = await k.host.remakeTeam(k.vm.id, QUEST, { providers: ["deepseek", "anthropic"], network: "gateway", approvedBy: "test-owner" });
    expect(remade).toMatchObject({ id: k.vm.id, network: "gateway", providers: ["deepseek", "anthropic"], status: "running" });
    const vm = k.fake.vms.get(k.name)!;
    expect(vm.volume).toBe(`${k.name}-work`);
    expect(vm.networks).toEqual([NETWORKS.gateway.name]);
    expect(k.ledger.at(-1)).toMatchObject({ class: "modify", verdict: "approved", detail: "made again from galahad/sandbox:1 as it is now · /work kept · gateway · 1 cpu · 2 GB" });
  });

  test("a new VM that won't start is cleared away and the old one put back as it was; the error says so", async () => {
    const k = await knightOnAMac();
    let runs = 0;
    k.fake.failRun = () => (++runs === 1 ? "Error: the new VM wouldn't boot" : null);
    await expect(k.host.resizeTeam(k.vm.id, QUEST, { memoryGb: 4, approvedBy: "test-owner" })).rejects.toThrow(/so it is as it was: Error: the new VM wouldn't boot/);
    const vm = k.fake.vms.get(k.name)!;
    expect(vm).toMatchObject({ state: "running", cpus: 1, memoryBytes: 2 * GIB, volume: `${k.name}-work` });
    expect(vm.networks).toEqual([NETWORKS.online.name, NETWORKS.gateway.name]);
    // The new lease is revoked; the one it runs with now covers what it had.
    expect(k.minted.at(-1)).toMatchObject({ providers: ["deepseek"] });
    expect(k.revoked).toContain("test-only-hash-2");
  });

  test("a VM made on a Mac is never made with a desktop there", async () => {
    const k = await knightOnAMac();
    await expect(k.host.remakeTeam(k.vm.id, QUEST, { providers: [], desktop: true, approvedBy: "test-owner" })).rejects.toThrow(/desktop image/);
    expect(k.fake.calls.filter((c) => ["stop", "delete", "run"].includes(c[0]!))).toEqual([]);
  });

  test("the reaper never takes its volume while it is being made again", async () => {
    const k = await knightOnAMac();
    k.later(60 * 60_000);
    let reapedDuring = null as string[] | null;
    k.fake.onRun = async () => {
      // (Between its deletion and its new start, the heartbeat's reaper runs.)
      expect(k.fake.vms.has(k.name)).toBe(false);
      reapedDuring = await k.host.reap();
    };
    await k.host.resizeTeam(k.vm.id, QUEST, { cpus: 2, approvedBy: "test-owner" });
    expect(reapedDuring).toEqual([]);
    expect(k.fake.volumes.has(`${k.name}-work`)).toBe(true);
    expect(k.fake.vms.get(k.name)!.volume).toBe(`${k.name}-work`);
  });
});
