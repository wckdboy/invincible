import { describe, expect, test } from "bun:test";
import {
  CONTAINER_CANNOT,
  containerBuildArgs,
  containerCannot,
  containerCollectArgs,
  containerDeleteArgs,
  containerExecArgs,
  containerInspectArgs,
  containerKeeperArgs,
  containerListArgs,
  containerNetworkCreateArgs,
  containerRunArgs,
  containerStartArgs,
  containerStatsArgs,
  containerStopArgs,
  containerTerminalArgs,
  containerVolumeCreateArgs,
  containerVolumeOwnArgs,
  DOCKER_ON_A_MAC,
  helperRestartArgs,
  NETWORKS,
  networkCreateArgs,
  parseContainers,
  parseContainerStats,
  parseContainerVersion,
  parseContainerVolumes,
  runArgs,
  type SandboxSpec,
} from "../src/index.ts";

/*
 * Apple's `container` (1.x): every flag below is from its documentation at the 1.7.1 tag
 * (docs/command-reference.md and the guides beside it). The samples of what it prints are the
 * documentation's own, quoted where they are used.
 */

const base: SandboxSpec = {
  id: "0123456789",
  quest: "q1",
  node: "n_test",
  image: "galahad/sandbox:1",
  network: "gateway",
  cpus: 4,
  memoryGb: 8,
  pidsLimit: 1024,
  ttlMinutes: 120,
  ephemeral: true,
  providers: [],
  createdAt: 1_000,
  env: {},
  isolation: "vm",
  workspace: "galahad-sbx-0123456789-work",
  diskGb: 20,
};

const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const all = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);

describe("a sandbox on a Mac: the hardening flags", () => {
  const args = containerRunArgs(base);

  test("it runs unprivileged, every capability dropped, its root read-only, under an init", () => {
    expect(args.slice(0, 2)).toEqual(["run", "--detach"]);
    expect(pair(args, "--name")).toBe("galahad-sbx-0123456789");
    expect(pair(args, "--user")).toBe("1000:1000");
    expect(pair(args, "--cap-drop")).toBe("ALL");
    expect(args).not.toContain("--cap-add");
    for (const flag of ["--read-only", "--init"]) expect(args).toContain(flag);
    expect(pair(args, "--tmpfs")).toBe("/tmp:size=2G,mode=1777");
    expect(pair(args, "--workdir")).toBe("/work");
    expect(all(args, "--env")).toContain("HOME=/work");
  });

  test("it is held to what it was given: CPUs, memory, open files and processes", () => {
    expect(pair(args, "--cpus")).toBe("4");
    expect(pair(args, "--memory")).toBe("8192M");
    expect(all(args, "--ulimit")).toEqual(["nofile=8192:8192", "nproc=1024:1024"]);
    // A VM's CPUs are whole: a part of one is a whole one, never none (the governor counts what it gets).
    expect(pair(containerRunArgs({ ...base, cpus: 0.5 }), "--cpus")).toBe("1");
    expect(pair(containerRunArgs({ ...base, cpus: 2.25 }), "--cpus")).toBe("3");
  });

  test("its /work is its own volume of a fixed size, the one thing of the host's it is given", () => {
    expect(all(args, "--mount")).toEqual(["type=volume,source=galahad-sbx-0123456789-work,target=/work"]);
    for (const flag of ["--volume", "-v", "--ssh", "--virtualization", "--rosetta", "--publish", "-p", "--publish-socket", "--kernel", "--init-image"]) expect(args).not.toContain(flag);
    expect(args.join(" ")).not.toMatch(/type=bind|docker\.sock/);
    expect(all(args, "--label")).toContain("dev.galahad.disk=20");
  });

  test("it is labelled as Docker's are, and with its image, which a VM made again is made from", () => {
    const labels = all(args, "--label");
    for (const label of ["dev.galahad=1", "dev.galahad.id=0123456789", "dev.galahad.quest=q1", "dev.galahad.node=n_test", "dev.galahad.ephemeral=true", "dev.galahad.isolation=vm", "dev.galahad.image=galahad/sandbox:1", `dev.galahad.expires=${1_000 + 120 * 60_000}`]) {
      expect(labels).toContain(label);
    }
    expect(args.slice(-3)).toEqual(["galahad/sandbox:1", "sleep", "infinity"]);
  });

  test("a gateway token goes in as the environment, as on Docker, and never as a label", () => {
    const withToken = containerRunArgs({ ...base, env: { GALAHAD_TOKEN: "test-only-token" }, tokenHash: "test-only-hash" });
    expect(all(withToken, "--env")).toContain("GALAHAD_TOKEN=test-only-token");
    expect(all(withToken, "--label").join(" ")).not.toMatch(/test-only/);
  });

  test("every flag Docker's run and network commands set is accounted for on a Mac: used, replaced, or why its promise holds without it", () => {
    const docker = [...runArgs({ ...base, isolation: "vm", network: "online", resolvConf: "/x/resolv.conf", workspace: "/var/lib/w/0123456789", env: { GALAHAD_TOKEN: "t" } }), ...networkCreateArgs("gateway")];
    const flags = new Set(docker.filter((a) => /^-/.test(a)));
    for (const flag of flags) expect(Object.keys(DOCKER_ON_A_MAC)).toContain(flag);
    // Each says what it becomes, and in a sentence whether its promise holds.
    for (const [flag, mapped] of Object.entries(DOCKER_ON_A_MAC)) {
      expect(["same", "replaced", "vm", "moot", "refused", "weaker"]).toContain(mapped.holds);
      expect(mapped.why.length, flag).toBeGreaterThan(20);
    }
    // Where container has the flag, it is used.
    for (const flag of ["--detach", "--name", "--init", "--user", "--cap-drop", "--read-only", "--workdir", "--cpus", "--memory", "--ulimit", "--label", "--env", "--internal", "--subnet"]) {
      expect(DOCKER_ON_A_MAC[flag]!.holds).toBe("same");
    }
    expect(DOCKER_ON_A_MAC["--security-opt"]!.container).toBeNull();
    expect(DOCKER_ON_A_MAC["--memory-swap"]!.container).toBeNull();
  });
});

describe("a sandbox on a Mac: its networks", () => {
  test("online is Galahad's own NAT network, as on Docker, and the gateway network beside it, egress first", () => {
    expect(all(containerRunArgs({ ...base, network: "online" }), "--network")).toEqual([NETWORKS.online.name, NETWORKS.gateway.name]);
    expect(containerRunArgs({ ...base, network: "online" })).not.toContain("--no-dns");
  });

  test("every VM boots without IPv6, which would reach the host and the sandboxes beside it past rules written for IPv4", () => {
    for (const network of ["online", "gateway"] as const) expect(all(containerRunArgs({ ...base, network }), "--kernel-arg")).toEqual(["ipv6.disable=1"]);
    expect(all(containerKeeperArgs("galahad/sandbox:1", "online"), "--kernel-arg")).toEqual(["ipv6.disable=1"]);
    expect(all(containerVolumeOwnArgs("0123456789", "galahad/sandbox:1"), "--kernel-arg")).toEqual(["ipv6.disable=1"]);
  });

  test("gateway is the internal network alone, with no resolver: it reaches the gateway by its address", () => {
    const args = containerRunArgs(base);
    expect(all(args, "--network")).toEqual([NETWORKS.gateway.name]);
    expect(args).toContain("--no-dns");
  });

  test("isolated is never made here: there is no network like Docker's none, and nothing is made with less", () => {
    expect(() => containerRunArgs({ ...base, network: "isolated" })).toThrow(/no network at all/);
    expect(containerCannot({ network: "isolated" })).toBe(CONTAINER_CANNOT.isolated);
  });

  test("the networks are made on Docker's subnets, so the gateways' addresses are the same: the gateway's host-only (--internal), online's with vmnet's NAT", () => {
    expect(containerNetworkCreateArgs("gateway")).toEqual(["network", "create", "--internal", "--subnet", NETWORKS.gateway.subnet, "--label", "dev.galahad=1", NETWORKS.gateway.name]);
    expect(containerNetworkCreateArgs("online")).toEqual(["network", "create", "--subnet", NETWORKS.online.subnet, "--label", "dev.galahad=1", NETWORKS.online.name]);
  });

  test("a network's helper is restarted by its launchd label, in the domain given (apple/container#2051)", () => {
    expect(helperRestartArgs("gui/501", NETWORKS.online.name)).toEqual(["kickstart", "-k", "gui/501/com.apple.container.container-network-vmnet.galahad-net"]);
  });
});

describe("what a Mac doesn't make yet", () => {
  test("the desktop, the Lab and Gazebo go to a Linux host, each with its reason; the workshop is made here", () => {
    expect(containerCannot({ network: "online", desktop: true })).toBe(CONTAINER_CANNOT.desktop);
    expect(containerCannot({ network: "gateway", lab: true })).toBe(CONTAINER_CANNOT.lab);
    expect(containerCannot({ network: "gateway", gazebo: true })).toBe(CONTAINER_CANNOT.gazebo);
    expect(containerCannot({ network: "gateway" })).toBeNull();
    expect(containerCannot({ network: "online" })).toBeNull();
    for (const why of Object.values(CONTAINER_CANNOT)) expect(why).toMatch(/Linux/);
  });
});

describe("the other commands", () => {
  test("a command runs as uid 1000 in /work, under a deadline inside the VM", () => {
    expect(containerExecArgs("0123456789", ["bun", "test"], 30)).toEqual(["exec", "--interactive", "--user", "1000:1000", "--workdir", "/work", "galahad-sbx-0123456789", "timeout", "--signal=KILL", "30s", "bun", "test"]);
  });

  test("a terminal is a login shell as uid 1000 on a TTY, tagged so its hang-up finds what it started", () => {
    expect(containerTerminalArgs("0123456789", "abcd")).toEqual([
      "exec", "--interactive", "--tty", "--user", "1000:1000", "--workdir", "/work", "--env", "TERM=xterm-256color", "--env", "GALAHAD_TERMINAL=abcd",
      "galahad-sbx-0123456789", "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l",
    ]);
  });

  test("list, inspect, stop, start, delete and stats", () => {
    expect(containerListArgs()).toEqual(["list", "--all", "--format", "json"]);
    expect(containerInspectArgs(["galahad-sbx-0123456789"])).toEqual(["inspect", "galahad-sbx-0123456789"]);
    expect(containerStopArgs("galahad-sbx-0123456789")).toEqual(["stop", "--time", "10", "galahad-sbx-0123456789"]);
    expect(containerStartArgs("galahad-sbx-0123456789")).toEqual(["start", "galahad-sbx-0123456789"]);
    expect(containerDeleteArgs("galahad-sbx-0123456789")).toEqual(["delete", "--force", "galahad-sbx-0123456789"]);
    expect(containerStatsArgs(["galahad-sbx-0123456789"])).toEqual(["stats", "--format", "json", "--no-stream", "galahad-sbx-0123456789"]);
  });

  test("an image is built for linux/arm64, its base pulled afresh", () => {
    expect(containerBuildArgs("galahad/sandbox:1", "/opt/galahad/sandbox")).toEqual(["build", "--pull", "--platform", "linux/arm64", "--tag", "galahad/sandbox:1", "/opt/galahad/sandbox"]);
  });

  test("a workspace is a volume of a fixed size, labelled as its sandbox's; a knight's is marked to be kept", () => {
    expect(containerVolumeCreateArgs("0123456789", 20, false)).toEqual(["volume", "create", "-s", "20G", "--label", "dev.galahad=1", "--label", "dev.galahad.id=0123456789", "galahad-sbx-0123456789-work"]);
    expect(containerVolumeCreateArgs("0123456789", 40, true)).toContain("dev.galahad.retained=1");
  });

  test("what is kept is copied out as a tar from inside the VM, as uid 1000, under a deadline", () => {
    expect(containerCollectArgs("0123456789", "/work/out")).toEqual(["exec", "--user", "1000:1000", "galahad-sbx-0123456789", "timeout", "--signal=KILL", "900s", "tar", "-C", "/work", "-cf", "-", "out"]);
    expect(containerCollectArgs("0123456789", "/work")).toEqual(["exec", "--user", "1000:1000", "galahad-sbx-0123456789", "timeout", "--signal=KILL", "900s", "tar", "-C", "/", "-cf", "-", "work"]);
  });
});

describe("what container prints, read", () => {
  test("its version: the service answers when the API server's row is there (docs: container system version, JSON output)", () => {
    // The documentation's own sample: the CLI, then the API server, which is there only when it answered a health check.
    const both = `[
  {
    "appName": "container",
    "buildType": "debug",
    "commit": "abcdef1",
    "version": "1.2.3"
  },
  {
    "appName": "container-apiserver",
    "buildType": "release",
    "commit": "1234abcdef",
    "version": "container-apiserver version 1.2.3 (build: release, commit: 1234abc)"
  }
]`;
    expect(parseContainerVersion(both)).toEqual({ version: "1.2.3", major: 1, running: true });
    const cliAlone = JSON.stringify([{ appName: "container", buildType: "release", commit: "abcdef1", version: "1.7.1" }]);
    expect(parseContainerVersion(cliAlone)).toEqual({ version: "1.7.1", major: 1, running: false });
    expect(parseContainerVersion("not json")).toBeNull();
    expect(parseContainerVersion(JSON.stringify([{ appName: "something-else" }]))).toBeNull();
  });

  test("its containers (docs: container-inspection.md), with the labels this driver writes; stopped reads as Docker's exited", () => {
    // The documentation's sample of `container ls --format json --all` / `container inspect`, where it shows its fields;
    // `labels` under configuration is where container keeps the --label values (to be confirmed on the Mac mini).
    const listed = JSON.stringify([
      {
        configuration: {
          mounts: [],
          id: "galahad-sbx-0123456789",
          labels: { "dev.galahad": "1", "dev.galahad.id": "0123456789", "dev.galahad.image": "galahad/sandbox:1" },
          image: { reference: "docker.io/galahad/sandbox:1" },
          resources: { cpus: 4, memoryInBytes: 1073741824 },
        },
        status: { state: "running", networks: [{ ipv4Address: "192.168.64.3/24", ipv4Gateway: "192.168.64.1", hostname: "galahad-sbx-0123456789.test.", network: "default" }] },
      },
      { configuration: { id: "buildkit", resources: { cpus: 2, memoryInBytes: 2147483648 } }, status: { state: "stopped", networks: [] } },
      "not a container",
    ]);
    expect(parseContainers(listed)).toEqual([
      { id: "galahad-sbx-0123456789", labels: { "dev.galahad": "1", "dev.galahad.id": "0123456789", "dev.galahad.image": "galahad/sandbox:1" }, image: "galahad/sandbox:1", status: "running", cpus: 4, memoryBytes: 1073741824, networks: ["default"] },
      { id: "buildkit", labels: {}, image: "", status: "exited", cpus: 2, memoryBytes: 2147483648, networks: [] },
    ]);
    // Without the label, the image is container's own reference to it.
    expect(parseContainers(JSON.stringify([{ configuration: { id: "x", image: { reference: "galahad/sandbox:1" } }, status: { state: "running" } }]))?.[0]?.image).toBe("galahad/sandbox:1");
    // A list that isn't one is not "none".
    expect(parseContainers("{}")).toBeNull();
    expect(parseContainers("")).toBeNull();
  });

  test("its use (docs: resource-usage.md, container stats --format json --no-stream)", () => {
    const sample = `[
  {
    "id": "my-web-server",
    "memoryUsageBytes": 47431680,
    "memoryLimitBytes": 1073741824,
    "cpuUsageUsec": 1234567,
    "networkRxBytes": 1289011,
    "networkTxBytes": 876544,
    "blockReadBytes": 4718592,
    "blockWriteBytes": 2202009,
    "numProcesses": 3,
    "cpuUtilization": 0.0312
  }
]`;
    expect(parseContainerStats(sample)).toEqual([{ id: "my-web-server", memoryUsedBytes: 47431680, memoryLimitBytes: 1073741824, cpus: 0.0312, processes: 3 }]);
    expect(parseContainerStats("nope")).toBeNull();
  });

  test("its volumes (docs: volumes.md, container volume inspect, and list's JSON read by its labels)", () => {
    const sample = `[
  {
    "configuration" : {
      "creationDate" : "2026-08-10T21:39:10Z",
      "driver" : "local",
      "format" : "ext4",
      "labels" : {
        "dev.galahad" : "1",
        "dev.galahad.id" : "0123456789",
        "dev.galahad.retained" : "1"
      },
      "name" : "galahad-sbx-0123456789-work",
      "options" : {

      },
      "sizeInBytes" : 21474836480,
      "source" : "\\/Users\\/fido\\/Library\\/Application Support\\/com.apple.container\\/volumes\\/galahad-sbx-0123456789-work\\/volume.img"
    },
    "id" : "galahad-sbx-0123456789-work"
  }
]`;
    expect(parseContainerVolumes(sample)).toEqual([
      {
        name: "galahad-sbx-0123456789-work",
        labels: { "dev.galahad": "1", "dev.galahad.id": "0123456789", "dev.galahad.retained": "1" },
        sizeBytes: 21474836480,
        source: "/Users/fido/Library/Application Support/com.apple.container/volumes/galahad-sbx-0123456789-work/volume.img",
        createdAt: Date.parse("2026-08-10T21:39:10Z"),
      },
    ]);
    expect(parseContainerVolumes("[]")).toEqual([]);
    expect(parseContainerVolumes("oops")).toBeNull();
  });
});
