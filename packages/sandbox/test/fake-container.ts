import type { DockerRunner } from "../src/index.ts";

/*
 * A stand-in for Apple's `container` CLI: it answers the commands the sandbox host runs on a Mac (system version,
 * image and network inspect, network create, volume create/list/delete, run, list, inspect, exec, stop, start,
 * delete, build, stats) from memory, in the shapes container's documentation shows (1.7.1). Nothing is spawned, and
 * nothing it says is more than that documentation promises: what only the Mac mini can confirm is listed in
 * docs/MAC.md.
 */

export interface FakeVm {
  name: string;
  image: string;
  labels: Record<string, string>;
  state: "running" | "stopped";
  cpus: number;
  memoryBytes: number;
  networks: string[];
  volume: string | null;
  /** Every argument it was run with. */
  args: string[];
}

export interface FakeVolume {
  name: string;
  labels: Record<string, string>;
  sizeBytes: number;
  /** Who owns its root: root's as it is made (as on the Mac mini, 17 November 2026), until a one-off container hands it on. */
  owner: string;
}

export interface FakeContainer {
  runner: DockerRunner;
  /** Every command, in order. */
  calls: string[][];
  vms: Map<string, FakeVm>;
  volumes: Map<string, FakeVolume>;
  networks: Set<string>;
  images: Set<string>;
  /** Whether container's service answers (its API server's row in `system version`). */
  service: boolean;
  /** Whether `system start` brings its service up (false: as when it has no kernel and may not install one). */
  startable?: boolean;
  version: string;
  /** Every `container exec`, as the sandbox ran it: who as, and its command after the in-VM deadline. */
  execs: { name: string; user: string | null; cmd: string[] }[];
  onExec?: (name: string, cmd: string[]) => { code: number; stdout: string; stderr?: string };
  /** A `run` that fails: the error container prints, or null to start it. */
  failRun?: (args: string[]) => string | null;
  /** Something that happens as a `run` is asked for, before it is done (awaited). */
  onRun?: (args: string[]) => Promise<void>;
  /** Every one-off `run --rm` (no name: it is gone when it ends), each with all its arguments. */
  oneOffs: string[][];
  /** A `list` that fails, as when its service is busy. */
  failList?: boolean;
}

const after = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);

export function fakeContainer(): FakeContainer {
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const shape = (vm: FakeVm) => ({
    configuration: { id: vm.name, labels: vm.labels, image: { reference: vm.image }, resources: { cpus: vm.cpus, memoryInBytes: vm.memoryBytes }, mounts: vm.volume ? [{ source: vm.volume, destination: "/work" }] : [] },
    status: { state: vm.state, networks: vm.state === "running" ? vm.networks.map((network) => ({ network, ipv4Address: "192.168.64.3/24", ipv4Gateway: "192.168.64.1" })) : [] },
  });
  const fake: FakeContainer = {
    calls: [],
    oneOffs: [],
    vms: new Map(),
    volumes: new Map(),
    networks: new Set(["default"]),
    images: new Set(["galahad/sandbox:1"]),
    service: true,
    version: "1.7.1",
    execs: [],
    runner: async (args) => {
      fake.calls.push(args);
      const [command, ...rest] = args;
      switch (command) {
        case "system":
          if (rest[0] === "start") {
            if (fake.startable === false) return no("Error: no default kernel is installed, and installing one was disabled");
            fake.service = true;
            return ok("Launching container-apiserver...");
          }
          if (rest[0] !== "version") return no(`fake container doesn't know system ${rest[0]}`);
          return ok(JSON.stringify([{ appName: "container", buildType: "release", commit: "abcdef1", version: fake.version }, ...(fake.service ? [{ appName: "container-apiserver", buildType: "release", commit: "1234abcdef", version: `container-apiserver version ${fake.version} (build: release, commit: 1234abc)` }] : [])]));
        case "image":
          if (rest[0] !== "inspect") return no(`fake container doesn't know image ${rest[0]}`);
          return fake.images.has(rest[1]!) ? ok(JSON.stringify([{ configuration: { name: rest[1] } }])) : no(`image not found: ${rest[1]}`);
        case "network": {
          const name = rest.at(-1)!;
          if (rest[0] === "inspect") return fake.networks.has(name) ? ok(JSON.stringify([{ id: name }])) : no(`network not found: ${name}`);
          if (rest[0] === "create") {
            if (fake.networks.has(name)) return no(`network ${name} already exists`);
            fake.networks.add(name);
            return ok(name);
          }
          return no(`fake container doesn't know network ${rest[0]}`);
        }
        case "volume": {
          if (rest[0] === "list") {
            return ok(JSON.stringify([...fake.volumes.values()].map((v) => ({ id: v.name, configuration: { name: v.name, labels: v.labels, sizeInBytes: v.sizeBytes, creationDate: "2026-11-16T12:00:00Z", source: `/nowhere/volumes/${v.name}/volume.img`, driver: "local", format: "ext4" } }))));
          }
          const name = rest.at(-1)!;
          if (rest[0] === "create") {
            if (fake.volumes.has(name)) return no(`volume ${name} already exists`);
            const size = rest[rest.indexOf("-s") + 1]!;
            const labels = Object.fromEntries(after(rest, "--label").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
            fake.volumes.set(name, { name, labels, sizeBytes: Number.parseInt(size, 10) * 2 ** 30, owner: "0:0" });
            return ok(name);
          }
          if (rest[0] === "delete") {
            if (!fake.volumes.has(name)) return no(`volume not found: ${name}`);
            if ([...fake.vms.values()].some((vm) => vm.volume === name)) return no(`volume ${name} is in use by a container`);
            fake.volumes.delete(name);
            return ok(name);
          }
          return no(`fake container doesn't know volume ${rest[0]}`);
        }
        case "run": {
          await fake.onRun?.(args);
          if (rest.includes("--rm") && !rest.includes("--name")) {
            // A one-off: what it does to a volume is all that is kept of it (a chown as root, of the volume at /work).
            const failedOnce = fake.failRun?.(args) ?? null;
            if (failedOnce) return { code: 1, stdout: "", stderr: failedOnce };
            fake.oneOffs.push(args);
            const mounted = after(rest, "--mount").map((m) => /type=volume,source=([^,]+),target=\/work/.exec(m)?.[1]).find(Boolean);
            const chown = after(rest, "--entrypoint")[0] === "chown" && after(rest, "--user")[0] === "0:0";
            if (mounted && chown && fake.volumes.has(mounted)) fake.volumes.get(mounted)!.owner = rest[rest.length - 2]!;
            return ok();
          }
          const name = rest[rest.indexOf("--name") + 1]!;
          if (fake.vms.has(name)) return no(`container ${name} already exists`);
          const failed = fake.failRun?.(args) ?? null;
          if (failed) return { code: 1, stdout: "", stderr: failed };
          const labels = Object.fromEntries(after(rest, "--label").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
          const volume = after(rest, "--mount").map((m) => /type=volume,source=([^,]+)/.exec(m)?.[1]).find(Boolean) ?? null;
          if (volume && !fake.volumes.has(volume)) fake.volumes.set(volume, { name: volume, labels: {}, sizeBytes: 512 * 2 ** 30, owner: "0:0" });
          fake.vms.set(name, {
            name,
            image: rest[rest.length - 3]!,
            labels,
            state: "running",
            cpus: Number(rest[rest.indexOf("--cpus") + 1]),
            memoryBytes: Number.parseInt(rest[rest.indexOf("--memory") + 1]!, 10) * 2 ** 20,
            networks: after(rest, "--network"),
            volume,
            args: [...args],
          });
          return ok(name);
        }
        case "list":
          if (fake.failList) return no("XPC connection error: Connection interrupted");
          return ok(JSON.stringify([...fake.vms.values()].filter((vm) => rest.includes("--all") || vm.state === "running").map(shape)));
        case "inspect": {
          const found = rest.map((name) => fake.vms.get(name)).filter((vm): vm is FakeVm => !!vm);
          return found.length ? ok(JSON.stringify(found.map(shape))) : no("container not found");
        }
        case "exec": {
          const at = rest.findIndex((a) => a.startsWith("galahad-sbx-"));
          const vm = fake.vms.get(rest[at]!);
          if (!vm) return no(`container not found: ${rest[at]}`);
          if (vm.state !== "running") return no(`container ${vm.name} is not running`);
          const user = rest.includes("--user") ? rest[rest.indexOf("--user") + 1]! : null;
          // After the container: timeout --signal=KILL <n>s <cmd…> (a terminal's shell comes without one).
          const cmd = rest[at + 1] === "timeout" ? rest.slice(at + 4) : rest.slice(at + 1);
          fake.execs.push({ name: vm.name, user, cmd });
          const answer = fake.onExec?.(vm.name, cmd) ?? { code: 0, stdout: "" };
          return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" };
        }
        case "stop":
        case "start": {
          const vm = fake.vms.get(rest.at(-1)!);
          if (!vm) return no(`container not found: ${rest.at(-1)}`);
          vm.state = command === "stop" ? "stopped" : "running";
          return ok(vm.name);
        }
        case "delete": {
          const name = rest.at(-1)!;
          if (!fake.vms.has(name)) return no(`container not found: ${name}`);
          if (fake.vms.get(name)!.state === "running" && !rest.includes("--force")) return no(`container ${name} is running`);
          fake.vms.delete(name);
          return ok(name);
        }
        case "build":
          fake.images.add(rest[rest.indexOf("--tag") + 1]!);
          return ok("built");
        case "builder":
          return rest[0] === "stop" ? ok("") : no(`fake container doesn't know "builder ${rest[0]}"`);
        case "stats":
          return ok(JSON.stringify(rest.filter((n) => fake.vms.has(n)).map((id) => ({ id, memoryUsageBytes: 2 ** 28, memoryLimitBytes: fake.vms.get(id)!.memoryBytes, cpuUsageUsec: 1, networkRxBytes: 0, networkTxBytes: 0, blockReadBytes: 0, blockWriteBytes: 0, numProcesses: 3, cpuUtilization: 0.25 }))));
        default:
          return no(`fake container doesn't know "${command}"`);
      }
    },
  };
  return fake;
}
