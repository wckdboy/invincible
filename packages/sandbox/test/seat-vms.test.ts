import { describe, expect, test } from "bun:test";
import { containerName, type DockerRunner, HARNESS_IMAGE, LABEL, SandboxHost, seatVolumeName, volumeName } from "../src/index.ts";

/*
 * A seat's VM (core's seats.ts; SandboxHost.createSeatVm): from the pinned tools' image, with the seat's home mounted,
 * for its sign-in or a run on it. Its home is made once and given to the VMs' user; it is in no more VMs at once than the
 * seat takes, however many ask at the same moment; a VM that shares an agent's /work leaves that disk, and the seat's
 * home, as they were when it goes; and a seat's home is removed only when no VM has it. Docker is a stand-in here that
 * keeps containers, their mounts and volumes in memory: the host's own logic runs unchanged above it.
 */

const SEAT = { id: `st_${"a".repeat(22)}`, kind: "claude-subscription" as const, runs: 1 };

function fake() {
  const containers = new Map<string, { labels: Record<string, string>; mounts: { Type: string; Name?: string; Source?: string; Destination: string }[]; status: string; image: string }>();
  const volumes = new Set<string>();
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr = "No such object") => ({ code: 1, stdout: "", stderr });
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    const [command, ...rest] = args;
    switch (command) {
      case "info":
        return ok("27.0.0-fake");
      case "image":
        return rest[0] === "inspect" ? ok("sha256:fake") : no();
      case "network":
        return ok("net");
      case "container":
        return no();
      case "create":
        return ok("keeper");
      case "volume": {
        const name = rest.at(-1)!;
        if (rest[0] === "inspect") return volumes.has(name) ? ok("[{}]") : no();
        if (rest[0] === "create") return volumes.add(name), ok(name);
        if (rest[0] === "rm") return volumes.delete(name), ok(name);
        return ok();
      }
      case "run": {
        // A one-off (the hand-over of a new home) leaves nothing behind.
        if (rest.includes("--rm")) return ok();
        const name = rest[rest.indexOf("--name") + 1]!;
        const labels: Record<string, string> = {};
        const mounts: { Type: string; Name?: string; Source?: string; Destination: string }[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--label") {
            const [key, ...value] = rest[i + 1]!.split("=");
            labels[key!] = value.join("=");
          }
          if (rest[i] === "--mount") {
            const parts = Object.fromEntries(rest[i + 1]!.split(",").map((kv) => kv.split("=") as [string, string]));
            mounts.push({ Type: parts.type!, ...(parts.type === "volume" ? { Name: parts.src } : { Source: parts.src }), Destination: parts.dst! });
            if (parts.type === "volume") volumes.add(parts.src!);
          }
        }
        containers.set(name, { labels, mounts, status: "running", image: rest[rest.length - 3]! });
        return ok(name);
      }
      case "ps": {
        const wanted = rest.filter((_, i) => rest[i - 1] === "--filter").map((f) => f.replace(/^label=/, ""));
        const matching = [...containers.entries()].filter(([, c]) => wanted.every((w) => { const [k, ...v] = w.split("="); return c.labels[k!] === v.join("="); }));
        // (Asked for a label, the label; otherwise Docker's names for them, which are not a sandbox's id.)
        const format = rest.includes("--format") ? rest[rest.indexOf("--format") + 1] : undefined;
        const label = /^\{\{\.Label "([^"]+)"\}\}$/.exec(format ?? "")?.[1];
        return ok(matching.map(([name, c]) => (label ? (c.labels[label] ?? "") : name)).join("\n"));
      }
      case "inspect": {
        if (rest[0] === "--format") {
          const c = containers.get(rest[2]!);
          // (One of its labels as Docker says it, or where its /work comes from.)
          const label = /^\{\{index \.Config\.Labels "([^"]+)"\}\}$/.exec(rest[1]!)?.[1];
          return c ? ok(label ? (c.labels[label] ?? "") : JSON.stringify(c.mounts)) : no();
        }
        const found = rest.map((name) => containers.get(name)).filter((c) => !!c);
        if (!found.length) return no();
        return ok(JSON.stringify(found.map((c) => ({ Config: { Labels: c!.labels, Image: c!.image }, State: { Status: c!.status }, HostConfig: { NanoCpus: 1e9, Memory: 2 ** 30 } }))));
      }
      case "rm": {
        containers.delete(rest.at(-1)!);
        return ok();
      }
      default:
        return ok();
    }
  };
  const ledger: { class: string; resource: string; target: string; detail?: string }[] = [];
  const host = new SandboxHost({
    node: "test", maxCpus: 8, maxMemoryGb: 16, runner, ledger: (e) => void ledger.push(e),
    tokens: { mint: () => ({ token: "test-only-token", info: { hash: "test-only-hash" } }), revoke: () => true },
  });
  return { host, calls, containers, volumes, ledger, runs: () => calls.filter((a) => a[0] === "run" && !a.includes("--rm")) };
}

const ask = { network: "online" as const, cpus: 1, memoryGb: 2, ttlMinutes: 30, run: "arm.team.ada" };

describe("a seat's VM", () => {
  test("from the pinned tools' image, with the seat's home: made once, given to the VMs' user with no network and two capabilities", async () => {
    const f = fake();
    const vm = await f.host.createSeatVm({ seat: SEAT, ...ask });
    const [run] = f.runs();
    expect(run).toContain(HARNESS_IMAGE);
    expect(run).toContain(`type=volume,src=${seatVolumeName(SEAT.id)},dst=/seats/${SEAT.id}`);
    expect(run).toContain(`CLAUDE_CONFIG_DIR=/seats/${SEAT.id}/claude`);
    expect(f.volumes.has(seatVolumeName(SEAT.id))).toBe(true);
    const handed = f.calls.filter((a) => a[0] === "run" && a.includes("--rm"));
    expect(handed).toHaveLength(1);
    expect(handed[0]).toEqual(["run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges:true", "--mount", `type=volume,src=${seatVolumeName(SEAT.id)},dst=/home-of-seat`, "invincible/sandbox:1", "sh", "-c", "chown 1000:1000 /home-of-seat && chmod 0700 /home-of-seat"]);
    expect(f.ledger.find((e) => e.class === "create")?.detail).toContain(`seat ${SEAT.id}'s home`);
    // Its home outlives it, and the next VM finds it as it was: it is not made again.
    expect((await f.host.destroy(vm.id, { run: ask.run })).verdict).toBe("allow");
    expect(f.volumes.has(seatVolumeName(SEAT.id))).toBe(true);
    await f.host.createSeatVm({ seat: SEAT, ...ask });
    expect(f.calls.filter((a) => a[0] === "run" && a.includes("--rm"))).toHaveLength(1);
  });

  test("the VMs that have a seat's home are named by their own ids, so each can be removed (a run's, a sign-in's)", async () => {
    const f = fake();
    expect(await f.host.seatVms(SEAT.id)).toEqual([]);
    const vm = await f.host.createSeatVm({ seat: SEAT, ...ask });
    expect(await f.host.seatVms(SEAT.id)).toEqual([vm.id]);
    expect(await f.host.seatVms(`st_${"z".repeat(22)}`)).toEqual([]);
    for (const id of (await f.host.seatVms(SEAT.id))!) expect((await f.host.destroy(id, { run: ask.run })).verdict).toBe("allow");
    expect(await f.host.seatVms(SEAT.id)).toEqual([]);
  });

  test("a seat's home is in no more VMs at once than it takes: one more is refused, even asked at the same moment", async () => {
    const f = fake();
    const [first, second] = await Promise.allSettled([f.host.createSeatVm({ seat: SEAT, ...ask }), f.host.createSeatVm({ seat: SEAT, ...ask })]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(String((second as PromiseRejectedResult).reason)).toContain("this seat's home is in use (1 VM, and it takes 1 at once)");
    expect(f.runs()).toHaveLength(1);
    // Another seat is another home.
    await f.host.createSeatVm({ seat: { ...SEAT, id: `st_${"b".repeat(22)}` }, ...ask });
    // And one that takes two, two.
    const two = { ...SEAT, id: `st_${"c".repeat(22)}`, runs: 2 };
    await f.host.createSeatVm({ seat: two, ...ask });
    await f.host.createSeatVm({ seat: two, ...ask });
    await expect(f.host.createSeatVm({ seat: two, ...ask })).rejects.toThrow("it takes 2 at once");
  });

  test("a run's VM uses the agent's own /work, and going leaves that disk and the seat's home as they were", async () => {
    const f = fake();
    const agent = await f.host.create({ network: "online", cpus: 1, memoryGb: 2, ttlMinutes: 120, persistent: true, run: "arm.team.ada" });
    expect(f.volumes.has(volumeName(agent.id))).toBe(true);
    const vm = await f.host.createSeatVm({ seat: SEAT, shares: agent.id, ...ask });
    const run = f.runs().at(-1)!;
    expect(run).toContain(`type=volume,src=${volumeName(agent.id)},dst=/work`);
    expect(run).not.toContain(`type=volume,src=${volumeName(vm.id)},dst=/work`);
    expect(f.volumes.has(volumeName(vm.id))).toBe(false);
    expect(f.containers.get(containerName(vm.id))!.labels[`${LABEL}.shares`]).toBe(agent.id);
    expect((await f.host.destroy(vm.id, { run: ask.run })).verdict).toBe("allow");
    expect(f.volumes.has(volumeName(agent.id))).toBe(true);
    expect(f.volumes.has(seatVolumeName(SEAT.id))).toBe(true);
    expect(f.calls.filter((a) => a[0] === "volume" && a[1] === "rm").map((a) => a.at(-1))).not.toContain(volumeName(agent.id));
    // Only an agent's own, kept VM on this host is shared.
    const passing = await f.host.create({ network: "online", cpus: 1, memoryGb: 2, ttlMinutes: 30, persistent: false });
    await expect(f.host.createSeatVm({ seat: SEAT, shares: passing.id, ...ask })).rejects.toThrow("that one is not here");
    await expect(f.host.createSeatVm({ seat: SEAT, shares: "nosuch0000", ...ask })).rejects.toThrow("that one is not here");
  });

  test("a seat's home is removed only when no VM has it, and the ledger says so", async () => {
    const f = fake();
    const vm = await f.host.createSeatVm({ seat: SEAT, ...ask });
    await expect(f.host.removeSeatHome(SEAT.id)).rejects.toThrow("a VM has this seat's home");
    expect(f.volumes.has(seatVolumeName(SEAT.id))).toBe(true);
    expect((await f.host.destroy(vm.id, { run: ask.run })).verdict).toBe("allow");
    await f.host.removeSeatHome(SEAT.id);
    expect(f.volumes.has(seatVolumeName(SEAT.id))).toBe(false);
    expect(f.ledger.find((e) => e.resource === "docker.volume")).toMatchObject({ class: "delete", target: seatVolumeName(SEAT.id) });
    // (Gone already: nothing to do.)
    await f.host.removeSeatHome(SEAT.id);
  });
});
