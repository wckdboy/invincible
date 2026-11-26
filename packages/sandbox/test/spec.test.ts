import { describe, expect, test } from "bun:test";
import { SandboxRequest } from "@galahad/core";
import { chooseIsolation, execArgs, gatewayEnv, KATA_RUNTIME, microVMsAvailable, NETWORKS, networkCreateArgs, runArgs, SandboxError, type SandboxSpec, sandboxScopes, vmResolvConf } from "../src/index.ts";

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
  isolation: "container",
};

const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("sandbox hardening", () => {
  const args = runArgs(base);

  test("runs unprivileged with every capability dropped and no privilege escalation", () => {
    expect(pair(args, "--user")).toBe("1000:1000");
    expect(pair(args, "--cap-drop")).toBe("ALL");
    expect(pair(args, "--security-opt")).toBe("no-new-privileges:true");
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toMatch(/type=bind|--volume|-v /);
  });

  test("a size-limited workspace is the one host path it sees, mounted at /work", () => {
    const limited = runArgs({ ...base, workspace: "/var/lib/galahad-workspaces/0123456789", diskGb: 20 });
    const mounts = limited.filter((_, i) => limited[i - 1] === "--mount" || limited[i - 1] === "--volume" || limited[i - 1] === "-v");
    expect(mounts).toEqual(["type=bind,src=/var/lib/galahad-workspaces/0123456789,dst=/work"]);
    expect(limited).toContain("dev.galahad.disk=20");
    // Without one, /work is a Docker volume, and the label says it has no limit.
    expect(args.filter((_, i) => args[i - 1] === "--mount")).toEqual(["type=volume,src=galahad-sbx-0123456789-work,dst=/work"]);
    expect(args).toContain("dev.galahad.disk=none");
  });

  test("is resource-bounded", () => {
    expect(pair(args, "--cpus")).toBe("4");
    expect(pair(args, "--memory")).toBe("8192m");
    expect(pair(args, "--memory-swap")).toBe("8192m");
    expect(pair(args, "--pids-limit")).toBe("1024");
  });

  test("network modes map to none / internal gateway net / egress net (plus the gateway, from the start)", () => {
    const networks = (spec: SandboxSpec) => runArgs(spec).filter((_, i, all) => all[i - 1] === "--network");
    expect(networks({ ...base, network: "isolated" })).toEqual(["none"]);
    expect(networks({ ...base, network: "gateway" })).toEqual([NETWORKS.gateway.name]);
    // Egress first, so it holds the default route; a microVM can't be given a network after it boots.
    expect(networks({ ...base, network: "online" })).toEqual([NETWORKS.online.name, NETWORKS.gateway.name]);
  });

  test("a microVM is the same hardened container on Kata's runtime, with its own kernel", () => {
    const vm = runArgs({ ...base, isolation: "vm", network: "online", resolvConf: "/var/lib/galahad/.galahad/sandbox-resolv.conf" });
    expect(pair(vm, "--runtime")).toBe(KATA_RUNTIME);
    for (const flag of ["--read-only", "--init"]) expect(vm).toContain(flag);
    expect(pair(vm, "--cap-drop")).toBe("ALL");
    expect(pair(vm, "--user")).toBe("1000:1000");
    expect(vm).toContain("dev.galahad.isolation=vm");
    // Docker's DNS lives on the host side; an online VM gets the host's resolvers, read-only.
    expect(vm).toContain("type=bind,src=/var/lib/galahad/.galahad/sandbox-resolv.conf,dst=/etc/resolv.conf,readonly");
    expect(runArgs({ ...base, isolation: "vm", network: "gateway", resolvConf: "/x" }).join(" ")).not.toContain("resolv.conf");
    expect(args).not.toContain("--runtime");
    expect(args).toContain("dev.galahad.isolation=container");
  });

  test("online code runs in a microVM where the host has them; you can always choose", () => {
    expect(chooseIsolation("online", undefined, true)).toBe("vm");
    expect(chooseIsolation("online", undefined, false)).toBe("container");
    expect(chooseIsolation("gateway", undefined, true)).toBe("container");
    expect(chooseIsolation("gateway", "vm", true)).toBe("vm");
    expect(chooseIsolation("online", "container", true)).toBe("container");
  });

  test("microVMs need /dev/kvm and Kata's shim", () => {
    const linux = process.platform === "linux";
    expect(microVMsAvailable((p) => ["/dev/kvm", "/usr/local/bin/containerd-shim-kata-v2"].includes(p))).toBe(linux);
    expect(microVMsAvailable((p) => p === "/dev/kvm")).toBe(false);
    expect(microVMsAvailable((p) => p === "/usr/local/bin/containerd-shim-kata-v2")).toBe(false);
  });

  test("a VM's resolv.conf: the host's upstream resolvers, never a loopback stub", () => {
    const lines = (...l: string[]) => `${l.join("\n")}\n`;
    const resolved = lines("# systemd-resolved", "nameserver 45.82.93.131", "nameserver 45.82.93.132", "search lan");
    expect(vmResolvConf(null, resolved)).toBe(lines("nameserver 45.82.93.131", "nameserver 45.82.93.132", "options timeout:2 attempts:2"));
    expect(vmResolvConf(lines("nameserver 127.0.0.53", "options edns0"), "nameserver 192.168.1.1")).toBe(
      lines("nameserver 192.168.1.1", "options timeout:2 attempts:2"),
    );
    expect(vmResolvConf("nameserver 127.0.0.53", undefined)).toBe(lines("nameserver 1.1.1.1", "nameserver 9.9.9.9", "options timeout:2 attempts:2"));
    expect(vmResolvConf("nameserver 1.2.3.4; rm -rf /")).toMatch(/^nameserver 1\.1\.1\.1/);
  });

  test("is labelled for ownership, quest, expiry and ephemerality", () => {
    const labels = args.filter((_, i) => args[i - 1] === "--label");
    expect(labels).toContain("dev.galahad=1");
    expect(labels).toContain("dev.galahad.quest=q1");
    expect(labels).toContain("dev.galahad.ephemeral=true");
    expect(labels).toContain(`dev.galahad.expires=${1_000 + 120 * 60_000}`);
  });

  test("the gateway network is internal and sandboxes cannot talk to each other", () => {
    const gw = networkCreateArgs("gateway");
    expect(gw).toContain("--internal");
    expect(gw).toContain("com.docker.network.bridge.enable_icc=false");
    expect(networkCreateArgs("online")).not.toContain("--internal");
    expect(networkCreateArgs("online")).toContain("com.docker.network.bridge.enable_icc=false");
  });

  test("tools get a scoped gateway token, never a provider key", () => {
    const env = gatewayEnv("gw_scoped", ["deepseek", "anthropic"]);
    expect(env.OPENAI_BASE_URL).toBe(`http://${NETWORKS.gateway.gateway}:7779/gw/deepseek`);
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://${NETWORKS.gateway.gateway}:7779/gw/anthropic`);
    expect(Object.values(env).every((v) => !v.startsWith("sk-"))).toBe(true);
    // A lease with keys of yours on it says where the key gateway is; one without says nothing of it.
    expect(env.GALAHAD_KEYS).toBeUndefined();
    expect(gatewayEnv("gw_scoped", ["deepseek"], true).GALAHAD_KEYS).toBe(`http://${NETWORKS.gateway.gateway}:7779/key`);
  });

  test("commands run under an in-container deadline", () => {
    expect(execArgs("0123456789", ["bun", "test"], 30)).toEqual([
      "exec",
      "--interactive",
      "--workdir",
      "/work",
      "galahad-sbx-0123456789",
      "timeout",
      "--signal=KILL",
      "30s",
      "bun",
      "test",
    ]);
  });

  test("requests default to the safe gateway mode, ephemeral, bounded TTL", () => {
    const parsed = SandboxRequest.parse({});
    expect(parsed).toMatchObject({ network: "gateway", persistent: false, ttlMinutes: 120, cpus: 4, memoryGb: 8 });
    expect(() => SandboxRequest.parse({ image: "Evil Image; rm -rf /" })).toThrow();
  });

  test("a request names model providers only: search and repositories are the node's to give, and the retired world scope stays refused", () => {
    expect(SandboxRequest.parse({ providers: ["deepseek", "cloudflare-ai"] }).providers).toEqual(["deepseek", "cloudflare-ai"]);
    for (const name of ["search", "world", "git:github:someone:private-repo", "git:x"]) {
      expect(SandboxRequest.safeParse({ providers: [name] }).success).toBe(false);
    }
  });

  test("the token's scopes: the providers asked for and search by its own flag, and nothing else", () => {
    expect(sandboxScopes({ network: "gateway", providers: ["deepseek"] })).toEqual(["deepseek"]);
    expect(sandboxScopes({ network: "online", search: true })).toEqual(["search"]);
    expect(sandboxScopes({ network: "gateway" })).toEqual([]);
    expect(sandboxScopes({ network: "isolated", providers: ["deepseek"], search: true })).toEqual([]);
    // Whatever reached the host by another way, it never mints an internal scope by name.
    for (const name of ["search", "world", "git:github:someone:private-repo"]) {
      expect(() => sandboxScopes({ network: "gateway", providers: [name] })).toThrow(SandboxError);
    }
  });
});
