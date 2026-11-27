import { describe, expect, test } from "bun:test";
import { SandboxRequest } from "@invincible/core";
import { buildCommand, chooseIsolation, COLLECT_SCRIPT, collectArgs, DEFAULT_IMAGE, DESKTOP_IMAGE, execArgs, gatewayEnv, HARDWARE_IMAGE, KATA_RUNTIME, LAB_IMAGE, madeFrom, microVMsAvailable, NETWORKS, networkCreateArgs, remadeImage, remakeAsk, runArgs, SandboxError, type SandboxSpec, sandboxScopes, vmResolvConf } from "../src/index.ts";

const base: SandboxSpec = {
  id: "0123456789",
  run: "q1",
  node: "n_test",
  image: "invincible/sandbox:1",
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
    const limited = runArgs({ ...base, workspace: "/var/lib/invincible-workspaces/0123456789", diskGb: 20 });
    const mounts = limited.filter((_, i) => limited[i - 1] === "--mount" || limited[i - 1] === "--volume" || limited[i - 1] === "-v");
    expect(mounts).toEqual(["type=bind,src=/var/lib/invincible-workspaces/0123456789,dst=/work"]);
    expect(limited).toContain("dev.invincible.disk=20");
    // Without one, /work is a Docker volume, and the label says it has no limit.
    expect(args.filter((_, i) => args[i - 1] === "--mount")).toEqual(["type=volume,src=invincible-sbx-0123456789-work,dst=/work"]);
    expect(args).toContain("dev.invincible.disk=none");
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
    const vm = runArgs({ ...base, isolation: "vm", network: "online", resolvConf: "/var/lib/invincible/.invincible/sandbox-resolv.conf" });
    expect(pair(vm, "--runtime")).toBe(KATA_RUNTIME);
    for (const flag of ["--read-only", "--init"]) expect(vm).toContain(flag);
    expect(pair(vm, "--cap-drop")).toBe("ALL");
    expect(pair(vm, "--user")).toBe("1000:1000");
    expect(vm).toContain("dev.invincible.isolation=vm");
    // Docker's DNS lives on the host side; an online VM gets the host's resolvers, read-only.
    expect(vm).toContain("type=bind,src=/var/lib/invincible/.invincible/sandbox-resolv.conf,dst=/etc/resolv.conf,readonly");
    expect(runArgs({ ...base, isolation: "vm", network: "gateway", resolvConf: "/x" }).join(" ")).not.toContain("resolv.conf");
    expect(args).not.toContain("--runtime");
    expect(args).toContain("dev.invincible.isolation=container");
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

  test("is labelled for ownership, run, expiry and ephemerality", () => {
    const labels = args.filter((_, i) => args[i - 1] === "--label");
    expect(labels).toContain("dev.invincible=1");
    expect(labels).toContain("dev.invincible.run=q1");
    expect(labels).toContain("dev.invincible.ephemeral=true");
    expect(labels).toContain(`dev.invincible.expires=${1_000 + 120 * 60_000}`);
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
    expect(env.OPENAI_BASE_URL).toBe(`http://${NETWORKS.gateway.gateway}:7402/gw/deepseek`);
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://${NETWORKS.gateway.gateway}:7402/gw/anthropic`);
    expect(Object.values(env).every((v) => !v.startsWith("sk-"))).toBe(true);
    // A lease with keys of yours on it says where the key gateway is; one without says nothing of it.
    expect(env.INVINCIBLE_KEYS).toBeUndefined();
    expect(gatewayEnv("gw_scoped", ["deepseek"], true).INVINCIBLE_KEYS).toBe(`http://${NETWORKS.gateway.gateway}:7402/key`);
  });

  test("commands run under an in-container deadline", () => {
    expect(execArgs("0123456789", ["bun", "test"], 30)).toEqual([
      "exec",
      "--interactive",
      "--workdir",
      "/work",
      "invincible-sbx-0123456789",
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

  test("a request names model providers only: search and repositories are the node's to give", () => {
    expect(SandboxRequest.parse({ providers: ["deepseek", "cloudflare-ai"] }).providers).toEqual(["deepseek", "cloudflare-ai"]);
    for (const name of ["search", "git:github:someone:private-repo", "git:x"]) {
      expect(SandboxRequest.safeParse({ providers: [name] }).success).toBe(false);
    }
  });

  test("the token's scopes: the providers asked for and search by its own flag, and nothing else", () => {
    expect(sandboxScopes({ network: "gateway", providers: ["deepseek"] })).toEqual(["deepseek"]);
    expect(sandboxScopes({ network: "online", search: true })).toEqual(["search"]);
    expect(sandboxScopes({ network: "gateway" })).toEqual([]);
    expect(sandboxScopes({ network: "isolated", providers: ["deepseek"], search: true })).toEqual([]);
    // Whatever reached the host by another way, it never mints an internal scope by name.
    for (const name of ["search", "git:github:someone:private-repo"]) {
      expect(() => sandboxScopes({ network: "gateway", providers: [name] })).toThrow(SandboxError);
    }
  });
});

describe("a folder kept as an artifact", () => {
  test("is copied out by the walk in the VM (COLLECT_SCRIPT), under a deadline: never docker cp, which follows the links on its path", () => {
    expect(collectArgs("0123456789", "/work/out")).toEqual(execArgs("0123456789", ["python3", "-I", "-c", COLLECT_SCRIPT, "/work/out"], 900));
    expect(collectArgs("0123456789", "/work/out")[0]).toBe("exec");
    expect(collectArgs("0123456789", "/work/out")).not.toContain("cp");
  });
});

describe("the hardware image (C1 step 11): the desktop with KiCad and FreeCAD, a choice per agent", () => {
  test("its name says desktop, as whatever asks whether a VM has one reads it, and it is made from the desktop's, which is made from the workshop's", () => {
    expect(HARDWARE_IMAGE.includes("desktop")).toBe(true);
    expect(madeFrom(HARDWARE_IMAGE)).toEqual([DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE]);
    expect(madeFrom(DESKTOP_IMAGE)).toEqual([DEFAULT_IMAGE, DESKTOP_IMAGE]);
    expect(madeFrom(DEFAULT_IMAGE)).toEqual([DEFAULT_IMAGE]);
    // (An image that isn't one of its own is made by nothing of its own.)
    expect(madeFrom("debian:trixie-slim")).toEqual([]);
  });

  test("each of its own images says how it is built when a node hasn't it", () => {
    expect([DEFAULT_IMAGE, LAB_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE].map(buildCommand)).toEqual([
      "invincible sandbox build",
      "invincible sandbox build --lab",
      "invincible sandbox build --desktop",
      "invincible sandbox build --hardware",
    ]);
  });

  test("made again, a VM is given the hardware tools or has them taken away, and they come and go with its desktop", () => {
    const remade = (current: string, ask: { desktop?: boolean; hardware?: boolean }) => remadeImage(current, ask);
    // Given them, from any image: a desktop comes with them, even with one taken away in the same breath.
    for (const current of [DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE]) {
      expect(remade(current, { hardware: true })).toBe(HARDWARE_IMAGE);
      expect(remade(current, { hardware: true, desktop: false })).toBe(HARDWARE_IMAGE);
    }
    // Taken away, its desktop stays; its desktop taken away, they go with it.
    expect(remade(HARDWARE_IMAGE, { hardware: false })).toBe(DESKTOP_IMAGE);
    expect(remade(HARDWARE_IMAGE, { desktop: false })).toBe(DEFAULT_IMAGE);
    expect(remade(HARDWARE_IMAGE, { desktop: false, hardware: false })).toBe(DEFAULT_IMAGE);
    // A desktop asked of one that has them keeps them; of one that hasn't, the desktop's.
    expect(remade(HARDWARE_IMAGE, { desktop: true })).toBe(HARDWARE_IMAGE);
    expect(remade(DEFAULT_IMAGE, { desktop: true })).toBe(DESKTOP_IMAGE);
    expect(remade(DEFAULT_IMAGE, { desktop: true, hardware: false })).toBe(DESKTOP_IMAGE);
    // Taking away what it hasn't changes nothing; and unasked, every VM keeps the image it has.
    expect(remade(DESKTOP_IMAGE, { hardware: false })).toBe(DESKTOP_IMAGE);
    expect(remade(DEFAULT_IMAGE, { hardware: false })).toBe(DEFAULT_IMAGE);
    for (const current of [DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE, LAB_IMAGE]) expect(remade(current, {})).toBe(current);
  });

  test("a remake's host is told the hardware tools are taken away only from a VM that has them: leaving it out changes nothing", () => {
    expect(remakeAsk(DESKTOP_IMAGE, { desktop: true, hardware: false })).toEqual({ desktop: true });
    expect(remakeAsk(DEFAULT_IMAGE, { hardware: false })).toEqual({});
    expect(remakeAsk(HARDWARE_IMAGE, { hardware: false })).toEqual({ hardware: false });
    expect(remakeAsk(DEFAULT_IMAGE, { hardware: true })).toEqual({ hardware: true });
    const asks = [undefined, true, false].flatMap((desktop) => [undefined, true, false].map((hardware) => ({ ...(desktop === undefined ? {} : { desktop }), ...(hardware === undefined ? {} : { hardware }) })));
    for (const current of [DEFAULT_IMAGE, DESKTOP_IMAGE, HARDWARE_IMAGE, LAB_IMAGE]) for (const ask of asks) expect(remadeImage(current, remakeAsk(current, ask))).toBe(remadeImage(current, ask));
  });

  test("a sandbox, an agent's VM and its making again can each ask for it", () => {
    expect(SandboxRequest.parse({ network: "gateway", hardware: true })).toMatchObject({ hardware: true });
  });
});
