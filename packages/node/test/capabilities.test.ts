import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preset } from "@invincible/models";
import { CONTAINER_IMAGES, CONTAINER_UNMADE } from "@invincible/sandbox";
import { type Capabilities, isAlwaysOn, RUNTIME_PROBES, sandboxHostOf, servedOriginFrom } from "../src/capabilities.ts";
import { refreshCapabilities, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";

describe("the local runtimes a node looks for", () => {
  test("are asked what they serve where their presets point, so the two never part ways", () => {
    expect(RUNTIME_PROBES).toEqual([
      ["ollama", `${preset("ollama")!.baseUrl}/models`],
      ["llamacpp", `${preset("llamacpp")!.baseUrl}/models`],
    ]);
    expect(RUNTIME_PROBES.map(([, url]) => url)).toEqual(["http://127.0.0.1:11434/v1/models", "http://127.0.0.1:9931/v1/models"]);
  });
});

/*
 * The node looks at its own body every five minutes, on a timer. Bun ends the process
 * on an unhandled rejection, so a refresh that fails must be a line in the log, never
 * the end of the node (and of every chat, run and loop it was running).
 */
describe("a capability refresh that fails", () => {
  const caps = { os: "linux", hasBattery: false } as Capabilities;

  test("a probe that fails is logged, and the last capabilities stand", async () => {
    const logs: string[] = [];
    const published: Capabilities[] = [];
    const fresh = await refreshCapabilities(
      async () => {
        throw new Error("docker info hung");
      },
      (c) => void published.push(c),
      (message) => void logs.push(message),
    );
    expect(fresh).toBeNull();
    expect(published).toEqual([]);
    expect(logs.join("\n")).toContain("docker info hung");
  });

  test("a profile the mind refuses (this node was revoked, say) is logged, not thrown", async () => {
    const logs: string[] = [];
    const fresh = await refreshCapabilities(
      async () => caps,
      () => {
        throw new Error("emit not authorized: signer is not an active device");
      },
      (message) => void logs.push(message),
    );
    expect(fresh).toBe(caps);
    expect(logs.join("\n")).toContain("signer is not an active device");
  });

  test("a refresh that works publishes what it found", async () => {
    const published: Capabilities[] = [];
    expect(await refreshCapabilities(async () => caps, (c) => void published.push(c), () => {})).toBe(caps);
    expect(published).toEqual([caps]);
  });
});

describe("which bodies are servers", () => {
  test("a Linux machine without a battery is always on", () => {
    expect(isAlwaysOn({ os: "linux", hasBattery: false })).toBe(true);
    expect(isAlwaysOn({ os: "linux", hasBattery: true })).toBe(false);
  });

  test("personal machines come and go, battery or not (a laptop whose battery Windows doesn't report)", () => {
    expect(isAlwaysOn({ os: "win32", hasBattery: false })).toBe(false);
    expect(isAlwaysOn({ os: "darwin", hasBattery: false })).toBe(false);
  });

  test("a Mac with no battery that its node keeps awake is a server too (a Mac mini set to stay on); a laptop never is", () => {
    expect(isAlwaysOn({ os: "darwin", hasBattery: false, awake: true })).toBe(true);
    expect(isAlwaysOn({ os: "darwin", hasBattery: false, awake: false })).toBe(false);
    expect(isAlwaysOn({ os: "darwin", hasBattery: true, awake: true })).toBe(false);
    expect(isAlwaysOn({ os: "win32", hasBattery: false, awake: true })).toBe(false);
  });

  test("unknown capabilities are not a server", () => {
    expect(isAlwaysOn(undefined)).toBe(false);
    expect(isAlwaysOn({})).toBe(false);
  });
});

describe("where the PWA is published on the tailnet", () => {
  // What `tailscale serve status --json` says on a server that keeps 443 for something else.
  const ULTRA = JSON.stringify({
    TCP: { "8443": { HTTPS: true } },
    Web: { "ultra.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7401" } } } },
  });

  test("the port tailscale serves this node's proxy on, not the 443 another service may hold", () => {
    expect(servedOriginFrom(ULTRA, 7401)).toBe("https://ultra.example.ts.net:8443");
  });

  test("443 is left out of the origin; another port's handler, or none, isn't this node's", () => {
    const laptop = JSON.stringify({ Web: { "laptop.example.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:7401/" } } } } });
    expect(servedOriginFrom(laptop, 7401)).toBe("https://laptop.example.ts.net");
    expect(servedOriginFrom(ULTRA, 9999)).toBeNull();
    expect(servedOriginFrom(JSON.stringify({ Web: { "x.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:77781" } } } } }), 7401)).toBeNull();
    expect(servedOriginFrom("{}", 7401)).toBeNull();
    expect(servedOriginFrom("not json", 7401)).toBeNull();
  });
});

describe("which sandbox host a body is", () => {
  const docker = { image: true, networks: true, vm: true };
  const container = (running: boolean) => ({ container: { version: "1.7.1", running }, sandbox: running ? { image: true, networks: true, vm: true as const, engine: "container" as const, cannot: [...CONTAINER_UNMADE], grows: false as const, images: [...CONTAINER_IMAGES] } : null });

  test("a Mac with Apple's container hosts through it, and says it found it", () => {
    expect(sandboxHostOf("darwin", container(true), null)).toEqual({ sandbox: container(true).sandbox, container: { version: "1.7.1", running: true } });
  });

  test("a Mac whose container service isn't running hosts nothing, and says why; never Docker one day and container the next", () => {
    expect(sandboxHostOf("darwin", container(false), docker)).toEqual({ sandbox: null, container: { version: "1.7.1", running: false } });
  });

  test("a Mac without container is as it was: Docker's host where Docker answers, else none", () => {
    expect(sandboxHostOf("darwin", null, docker)).toEqual({ sandbox: docker });
    expect(sandboxHostOf("darwin", null, null)).toEqual({ sandbox: null });
  });

  test("Linux hosts through Docker, whatever else it has", () => {
    expect(sandboxHostOf("linux", container(true), docker)).toEqual({ sandbox: docker });
    expect(sandboxHostOf("linux", null, null)).toEqual({ sandbox: null });
  });
});

/*
 * Capabilities given by hand (the tests, the benches, the dev nodes) are a stand-in's, so a node given them hosts
 * sandboxes only through the engine given with them. Without one it would drive this machine's own Docker (or Apple's
 * container): it would make the real sandbox networks there, and every later test's node would find the gateway's address
 * on the machine (27 November 2026, on GitHub's runners: desktop-watch.e2e's node "keep").
 */
describe("capabilities given by hand", () => {
  test("that host sandboxes, with no engine given, are refused at the start, before anything of this machine's is asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invincible-hand-caps-"));
    const hand: Capabilities = { os: "linux", arch: "x64", hostname: "hand", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null, sandbox: { image: false, networks: false, vm: false } };
    try {
      await expect(startDaemon(new Home(dir), { capabilities: hand, log: () => {} })).rejects.toThrow("capabilities given by hand host sandboxes only through an engine given with them");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
