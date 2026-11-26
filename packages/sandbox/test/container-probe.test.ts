import { describe, expect, test } from "bun:test";
import { CONTAINER_UNMADE, type DockerRunner, probeContainer, startContainerService } from "../src/index.ts";
import { fakeContainer } from "./fake-container.ts";

/*
 * How a Mac finds Apple's container: its binary, then `container system version --format json`, whose API server row
 * is there only when its service answered (the documentation's own sample, command-reference.md at 1.7.1), then
 * whether the sandbox image and the gateway network are there. Nothing is made or changed by looking.
 */

const SAMPLE = `[
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

function answering(over: { version?: string; image?: boolean; network?: boolean } = {}) {
  const asked: string[][] = [];
  const runner: DockerRunner = async (args) => {
    asked.push(args);
    if (args[0] === "system") return { code: 0, stdout: over.version ?? SAMPLE, stderr: "" };
    if (args[0] === "image") return over.image === false ? { code: 1, stdout: "", stderr: "image not found" } : { code: 0, stdout: "[]", stderr: "" };
    if (args[0] === "network") return over.network === false ? { code: 1, stdout: "", stderr: "network not found" } : { code: 0, stdout: "[]", stderr: "" };
    return { code: 1, stdout: "", stderr: "not asked for" };
  };
  return { runner, asked };
}

describe("finding Apple's container on a Mac", () => {
  test("its service answering, at 1.x: a sandbox host whose every sandbox is a VM, that can't grow one live, and says what it won't make and which of his images it makes", async () => {
    const { runner, asked } = answering();
    expect(await probeContainer(runner)).toEqual({
      container: { version: "1.2.3", running: true },
      sandbox: { image: true, networks: true, vm: true, engine: "container", cannot: [...CONTAINER_UNMADE], grows: false, images: ["galahad/sandbox:1"] },
    });
    // Only looked: nothing made, nothing started.
    expect(asked).toEqual([["system", "version", "--format", "json"], ["image", "inspect", "galahad/sandbox:1"], ["network", "inspect", "galahad-gw"], ["network", "inspect", "galahad-net"]]);
  });

  test("its image not built, or its network not made yet: a host that says so (the node makes the network as it starts)", async () => {
    const probed = await probeContainer(answering({ image: false, network: false }).runner);
    expect(probed?.sandbox).toMatchObject({ image: false, networks: false });
  });

  test("its service not running: found, said so, and no sandbox host", async () => {
    const cliAlone = JSON.stringify([{ appName: "container", buildType: "release", commit: "abcdef1", version: "1.7.1" }]);
    expect(await probeContainer(answering({ version: cliAlone }).runner)).toEqual({ container: { version: "1.7.1", running: false }, sandbox: null });
  });

  test("a major release this node doesn't speak, or an answer it can't read: no sandbox host", async () => {
    const two = JSON.stringify([{ appName: "container", version: "2.0.0" }, { appName: "container-apiserver", version: "container-apiserver version 2.0.0" }]);
    expect(await probeContainer(answering({ version: two }).runner)).toEqual({ container: { version: "2.0.0", running: true }, sandbox: null });
    expect(await probeContainer(answering({ version: "garbled" }).runner)).toEqual({ container: { version: null, running: false }, sandbox: null });
  });
});

describe("container's service, as a node on a Mac starts", () => {
  test("stopped (it doesn't start itself at boot): started, never with a kernel installed for it; running: left alone", async () => {
    const fake = fakeContainer();
    fake.service = false;
    expect(await startContainerService(fake.runner)).toBe("started");
    expect(fake.calls.filter((c) => c[0] === "system" && c[1] === "start")).toEqual([["system", "start", "--disable-kernel-install", "--timeout", "60"]]);
    expect(await startContainerService(fake.runner)).toBe("running");
    expect(fake.calls.filter((c) => c[1] === "start")).toHaveLength(1);
  });

  test("one that won't start says so, and nothing more is tried", async () => {
    const fake = fakeContainer();
    fake.service = false;
    fake.startable = false;
    expect(await startContainerService(fake.runner)).toBe("failed");
    expect(fake.service).toBe(false);
  });

  test("no container here: nothing at all", async () => {
    expect(await startContainerService(undefined, "no-such-container-binary-here")).toBeNull();
  });
});
