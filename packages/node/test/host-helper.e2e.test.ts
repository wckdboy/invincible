import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes, type RouteName, type SandboxView } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * The workspace helper is root on its host: it makes, mounts and deletes disk images
 * for real Docker. A node on a stand-in for Docker (every test that starts one) has no
 * real container to mount them for, so it must never speak to the helper: on a server
 * that has one installed, the test suite a deploy runs would otherwise have root make
 * and delete real images there, and fail whenever the installed helper is older than
 * the code under test.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "helper-test", cores: 8, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };

const root = mkdtempSync(join(tmpdir(), "galahad-helper-"));
const home = new Home(join(root, "node"));
const port = freePort();
const docker = fakeDocker();
/** A helper as a server has one: it answers everything, so a node that asked would go on to use it. */
const heard: string[] = [];
const socketPath = join(root, "helper.sock");
const helper = Bun.listen({ unix: socketPath, socket: {
  data(socket, chunk) {
    const line = new TextDecoder().decode(chunk).trim();
    heard.push(line);
    socket.end(line.startsWith("stats") ? `ok ${2 ** 40} ${2 ** 40}\n` : line.startsWith("create") ? `ok ${join(root, "mounted")}\n` : "ok\n");
  },
} });
let daemon: Daemon;

async function api<T>(name: RouteName, input?: unknown): Promise<T> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = await response.json() as { error?: string };
  if (!response.ok || body.error) throw new Error(`${name}: ${response.status} ${body.error ?? "request failed"}`);
  return body as T;
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  // The node reads where the helper is when it starts: here, the one above, as a server's would be at its usual place.
  const before = process.env.GALAHAD_WORKSPACE_SOCKET;
  process.env.GALAHAD_WORKSPACE_SOCKET = socketPath;
  try {
    daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: docker.runner, measure: false });
  } finally {
    if (before === undefined) delete process.env.GALAHAD_WORKSPACE_SOCKET;
    else process.env.GALAHAD_WORKSPACE_SOCKET = before;
  }
});

afterAll(async () => {
  await daemon?.stop();
  helper.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a node on a stand-in for Docker never speaks to the host's workspace helper: a sandbox made and destroyed there asks root for nothing", async () => {
  const { sandbox } = await api<{ sandbox: SandboxView }>("createSandbox", { network: "isolated" });
  // No helper, so no size limit: the workspace is the stand-in Docker's volume.
  expect(sandbox.disk).toBeNull();
  await api("sandboxes", {});
  await api("destroySandbox", { id: sandbox.id });
  expect(heard).toEqual([]);
});
