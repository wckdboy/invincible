import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ed25519OfDidKey, fromB64u, type QampGrantView, routes, signingPublicKey } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Galahad's tools for an agent on another machine, end to end with Q-AMP's real, pinned binary and a real node in a
 * temporary home, on loopback: a grant made from the CLI; the agent lists and calls the granted tool through the bridge;
 * a tool not granted, a stranger's key, an expired chain and a chain from another key are each refused where Q-AMP
 * refuses them; and after a revoke the agent's very next call is refused.
 *
 * It needs the binary: GALAHAD_QAMP_BIN names it (deploy's test run on a node with Q-AMP sets it). Without it every test
 * here is skipped, and says so: skipped is unverified, never passed.
 */

const repo = resolve(import.meta.dir, "../../..");
const cli = join(repo, "packages/node/src/cli.ts");
const bin = process.env.GALAHAD_QAMP_BIN;
const pinName = `${process.platform}-${process.arch}` === "linux-x64" ? "QAMP_SHA256_LINUX_X86_64" : `${process.platform}-${process.arch}` === "darwin-arm64" ? "QAMP_SHA256_DARWIN_ARM64" : null;
const pin = pinName ? new RegExp(`^${pinName}=([0-9a-f]{64})$`, "m").exec(readFileSync(join(repo, "scripts/qamp-pin.sh"), "utf8"))?.[1] ?? null : null;
const missing = !bin ? "GALAHAD_QAMP_BIN names no Q-AMP binary" : !existsSync(bin) ? `GALAHAD_QAMP_BIN names ${bin}, which isn't there` : !pin ? `Q-AMP has no pinned binary for ${process.platform}-${process.arch}` : null;
if (missing) console.warn(`qamp.e2e.test.ts SKIPPED, unverified: ${missing}. Run it with GALAHAD_QAMP_BIN=<qamp ${"0.1.0"} for this machine, checked against scripts/qamp-pin.sh>.`);

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "qamp-e2e",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [],
  tailscale: null,
};

let root: string;
let home: Home;
let daemon: Daemon;
const port = freePort();
const bridges = freePort();
let agentKey: string;
let agent: string;
let strangerKey: string;
let made: { id: string; url: string; proof: string };

/** A `qamp` command to its end, or killed after `limitMs`: its exit code and what it printed. */
async function qamp(args: string[], limitMs = 15_000): Promise<{ code: number | null; out: string; err: string }> {
  const proc = Bun.spawn([bin!, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), limitMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  return { code: proc.exitCode, out, err };
}

async function galahad(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, cli, ...args, "--home", home.dir], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GALAHAD_KEYSTORE: "file" } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode, out, err };
}

const admin = async <T,>(name: keyof typeof routes, input?: unknown): Promise<T> => {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  return (await response.json()) as T;
};

describe.skipIf(missing !== null)("an agent on another machine, over Q-AMP's real binary", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "galahad-qamp-e2e-"));
    home = new Home(join(root, "node"));
    const { identity, keystore } = await home.createIdentity("file");
    const store = new MindStore(home.mindPath);
    const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
    store.close();
    home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
    // The node runs the binary GALAHAD_QAMP_BIN names, as a node does; its bridges on loopback, on ports of the tests' own.
    daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, qampPorts: { first: bridges, last: bridges + 3 }, backups: false, shutdownGraceMs: 500 });
    agentKey = join(root, "agent.qamp-key");
    strangerKey = join(root, "stranger.qamp-key");
    agent = (await qamp(["keygen", "--out", agentKey])).out.trim();
    await qamp(["keygen", "--out", strangerKey]);
  }, 30_000);

  afterAll(async () => {
    await daemon?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the binary is the pinned one, and its did:key names the public key its key file holds", async () => {
    expect(createHash("sha256").update(readFileSync(bin!)).digest("hex")).toBe(pin!);
    expect((await qamp(["--version"])).out.trim()).toBe("qamp 0.1.0");
    // Q-AMP's encoding against Galahad's reading of it: the key file is qamp-sk1.<the seed, base64url>.
    const seed = fromB64u(readFileSync(agentKey, "utf8").trim().slice("qamp-sk1.".length));
    expect(ed25519OfDidKey(agent)).toEqual(signingPublicKey(seed));
  });

  test("granted from the CLI: the agent lists the granted tool alone, and calls it through the bridge", async () => {
    const granted = await galahad(["qamp", "grant", agent, "--tools", "fleet", "--ttl", "10m"]);
    expect(granted.err).toBe("");
    expect(granted.code).toBe(0);
    const line = /qamp mcp (qamp:\/\/\S+) --key <the agent's key file> --proof (qdt1\.[A-Za-z0-9_-]+)/.exec(granted.out);
    expect(line).not.toBeNull();
    made = { id: /grant {3}([0-9a-f]{10})/.exec(granted.out)![1]!, url: line![1]!, proof: line![2]! };
    expect(made.url).toStartWith("qamp://did:key:z6Mk");
    expect(made.url).toEndWith(`@127.0.0.1:${bridges}`);

    const manifest = JSON.parse((await qamp(["tools", made.url, "--key", agentKey])).out) as { tools: { name: string }[] };
    expect(manifest.tools.map((t) => t.name)).toEqual(["galahad/fleet"]);
    const called = await qamp(["call", made.url, "galahad/fleet", "--key", agentKey, "--proof", made.proof]);
    expect(called.code).toBe(0);
    expect(called.out).toStartWith('Fleet "camelot"');
    expect(called.out).toContain("- ultra (node, this node)");
  }, 30_000);

  test("a tool that wasn't granted is no tool at all, even one its arm's scope would reach", async () => {
    for (const tool of ["galahad/compute", "galahad/recall", "galahad/archive_search", "galahad/remember"]) {
      const refused = await qamp(["call", made.url, tool, "--key", agentKey, "--proof", made.proof]);
      expect([tool, refused.code, refused.err.trim()]).toEqual([tool, 1, `Error: remote error UNKNOWN_TOOL: unknown tool "${tool}"`]);
    }
  }, 30_000);

  test("a stranger's key is refused at the handshake, the agent's own chain in hand or not", async () => {
    for (const args of [["--proof", made.proof], []]) {
      const refused = await qamp(["call", made.url, "galahad/fleet", "--key", strangerKey, ...args]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("the cryptographic handshake failed");
      expect(refused.out).toBe("");
    }
  }, 30_000);

  test("an expired chain, a chain from a key that isn't the bridge's, and none at all are refused: UNAUTHORIZED", async () => {
    const bridgeKey = join(home.dir, "qamp", "bridge.qamp-key");
    const short = (await qamp(["delegate", "--key", bridgeKey, "--to", agent, "--cmd", "/tool/galahad", "--ttl", "1"])).out.trim();
    await Bun.sleep(2_100);
    expect((await qamp(["call", made.url, "galahad/fleet", "--key", agentKey, "--proof", short])).err.trim()).toBe("Error: remote error UNAUTHORIZED: token 0 has expired");
    const rogueKey = join(root, "rogue.qamp-key");
    await qamp(["keygen", "--out", rogueKey]);
    const rogue = (await qamp(["delegate", "--key", rogueKey, "--to", agent, "--cmd", "/tool/galahad", "--ttl", "60"])).out.trim();
    expect((await qamp(["call", made.url, "galahad/fleet", "--key", agentKey, "--proof", rogue])).err.trim()).toBe("Error: remote error UNAUTHORIZED: the chain does not start at a trusted root");
    expect((await qamp(["call", made.url, "galahad/fleet", "--key", agentKey])).err.trim()).toBe("Error: remote error UNAUTHORIZED: no proof: the invoker is not a trusted root and the tool is not public");
  }, 30_000);

  test("through qamp mcp, as an agent's MCP client holds it: after a revoke its very next call is refused, and so is a fresh one", async () => {
    const client = new Client({ name: "agent-on-another-machine", version: "1" });
    await client.connect(new StdioClientTransport({ command: bin!, args: ["mcp", made.url, "--key", agentKey, "--proof", made.proof], stderr: "ignore" }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["galahad.fleet"]);
      const before = await client.callTool({ name: "galahad.fleet", arguments: {} });
      expect(before.isError).toBeFalsy();
      expect((before.content as { text: string }[])[0]!.text).toStartWith('Fleet "camelot"');

      expect(await admin<{ revoked: number }>("qampRevoke", { id: made.id })).toEqual({ revoked: 1 });
      const after = await client.callTool({ name: "galahad.fleet", arguments: {} });
      expect(after.isError).toBe(true);
      expect(JSON.stringify(after.content)).not.toContain("Fleet");
    } finally {
      await client.close();
    }
    const fresh = await qamp(["call", made.url, "galahad/fleet", "--key", agentKey, "--proof", made.proof]);
    expect(fresh.code).toBe(1);
    expect(fresh.out).toBe("");
    expect(await admin<{ grants: QampGrantView[] }>("qampGrants")).toEqual({ grants: [] });
    // Its bridge and its MCP server are gone, not left running.
    const ps = Bun.spawnSync(["ps", "-ax", "-o", "command"], { stdout: "pipe" }).stdout.toString();
    expect(ps).not.toContain(`--arm qamp.${made.id}`);
    const ended = daemon.store.ledger(50).map((e) => e.body).filter((b) => b.target === `qamp.${made.id}` && b.class === "delete");
    expect(ended.map((b) => b.reason)).toEqual(["the grant ended (you revoked it): its bridge stopped", "the grant ended (you revoked it): its arm is deleted, so the agent's next call is refused"]);
  }, 60_000);
});
