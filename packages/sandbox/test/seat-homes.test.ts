import { describe, expect, test } from "bun:test";
import { containerRunArgs, HARNESS_IMAGE, LABEL, runArgs, type SandboxSpec, seatEnv, seatHome, seatVolumeName, volumeName } from "../src/index.ts";

/*
 * Seats' homes (core's seats.ts): a volume of its own for each seat, mounted at /seats/<id> in a VM made for a run on it
 * or for its sign-in, with its tool told where by the variable its vendor documents. A VM made for an agent's run uses
 * that agent's own /work and has no disk of its own. Everything else about the VM is as hardened as any other's.
 */

const SEAT = `st_${"a".repeat(22)}`;
const base: SandboxSpec = {
  id: "0123456789",
  run: "arm.team.ada",
  node: "n_test",
  image: HARNESS_IMAGE,
  network: "online",
  cpus: 2,
  memoryGb: 4,
  pidsLimit: 1024,
  ttlMinutes: 120,
  ephemeral: true,
  providers: [],
  createdAt: 1_000,
  env: { HOME: "/work" },
  isolation: "vm",
};

const mounts = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "--mount" ? [arg] : []));
const envs = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "--env" ? [arg] : []));
const labelsOf = (args: string[]) => Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg.split("=") as [string, string]] : [])));
/** What isn't a mount, an environment variable or a label: the hardening, the limits, the network, the image. */
const rest = (args: string[]) => args.filter((arg, i) => !["--mount", "--env", "--label"].includes(arg) && !["--mount", "--env", "--label"].includes(args[i - 1]!));

describe("a seat's home", () => {
  test("its own volume, mounted at /seats/<id>, and its tool told where to keep its sign-in there", () => {
    expect(seatVolumeName(SEAT)).toBe(`invincible-seat-${SEAT}`);
    expect(seatHome(SEAT)).toBe(`/seats/${SEAT}`);
    const claude = runArgs({ ...base, seat: { id: SEAT, kind: "claude-subscription" } });
    expect(mounts(claude)).toEqual([`type=volume,src=${volumeName(base.id)},dst=/work`, `type=volume,src=invincible-seat-${SEAT},dst=/seats/${SEAT}`]);
    expect(envs(claude)).toContain(`CLAUDE_CONFIG_DIR=/seats/${SEAT}/claude`);
    expect(labelsOf(claude)[`${LABEL}.seat`]).toBe(SEAT);
    const codex = runArgs({ ...base, seat: { id: SEAT, kind: "chatgpt-codex" } });
    expect(envs(codex)).toContain(`CODEX_HOME=/seats/${SEAT}/codex`);
    expect(envs(codex).some((e) => e.startsWith("CLAUDE_CONFIG_DIR="))).toBe(false);
  });

  test("only a seat whose sign-in a tool keeps in its home has one: Sign in with ChatGPT's is the node's, a key's is the vault's", () => {
    for (const kind of ["chatgpt-siwc", "plan", "api"] as const) expect(seatEnv(SEAT, kind)).toEqual({});
  });

  test("a VM for an agent's run uses that agent's own /work, as its volume or its workspace on this host, and has no disk of its own", () => {
    const volume = runArgs({ ...base, shares: { sandbox: "ada0000001", volume: volumeName("ada0000001") } });
    expect(mounts(volume)).toEqual([`type=volume,src=${volumeName("ada0000001")},dst=/work`]);
    const workspace = runArgs({ ...base, shares: { sandbox: "ada0000001", workspace: "/var/lib/invincible/workspaces/ada0000001" } });
    expect(mounts(workspace)).toEqual(["type=bind,src=/var/lib/invincible/workspaces/ada0000001,dst=/work"]);
    for (const args of [volume, workspace]) {
      expect(labelsOf(args)[`${LABEL}.shares`]).toBe("ada0000001");
      // (Removing it removes no disk: it has none of its own.)
      expect(labelsOf(args)[`${LABEL}.disk`]).toBe("none");
      expect(mounts(args).some((m) => m.includes(volumeName(base.id)))).toBe(false);
    }
  });

  test("everything else is as any VM's: the same user, capabilities, read-only image, limits, network and image", () => {
    const plain = runArgs(base);
    const both = runArgs({ ...base, seat: { id: SEAT, kind: "claude-subscription" }, shares: { sandbox: "ada0000001", volume: volumeName("ada0000001") } });
    expect(rest(both)).toEqual(rest(plain));
    expect(envs(both)).toEqual([...envs(plain), `CLAUDE_CONFIG_DIR=/seats/${SEAT}/claude`]);
  });

  test("a Mac's VMs never share a workspace or a seat's home: each is a disk image only one VM may mount", () => {
    const mac: SandboxSpec = { ...base, network: "online", isolation: "container" };
    expect(() => containerRunArgs({ ...mac, seat: { id: SEAT, kind: "claude-subscription" } })).toThrow("made on a Linux host with Docker");
    expect(() => containerRunArgs({ ...mac, shares: { sandbox: "ada0000001", volume: volumeName("ada0000001") } })).toThrow("made on a Linux host with Docker");
  });
});
