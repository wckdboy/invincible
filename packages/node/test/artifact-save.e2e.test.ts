import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RouteName, routes, type SandboxView } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { ExtractResult } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { TOOLS } from "../src/tools.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * A folder kept, and what it left out said to whoever kept it (27 November 2026, the lead's word on F1): the walk names
 * what it couldn't read, the extractor what it refused, and saveArtifact's answer carries them, as many named as the
 * ledger's line names and how many, to the CLI's `sandbox save` and an agent's sandbox_save. The stand-in Docker has no
 * files to copy out, so the node's store collects from a stand-in here; the walk and the extractor are tested on their own
 * (collect.test.ts, tar.test.ts) and on real Docker (docker.integration.test.ts).
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "artifact-save-test", cores: 8, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["git", "docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };
const root = mkdtempSync(join(tmpdir(), "invincible-artifact-save-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon | undefined;
let sandbox: string;

const LEFT = [
  { path: "out/closed", reason: "it can't be read here (PermissionError)" },
  { path: "out/peek", reason: "link" },
];
/** What the folder holds, as the store's collect gives it: its files, and what was left out. */
let holds: { files: Record<string, string>; skipped: ExtractResult["skipped"] } = { files: {}, skipped: [] };

const send = async <T,>(name: RouteName, input?: unknown): Promise<{ status: number; body: T }> => {
  const response = await fetch(`http://127.0.0.1:${port}${routes[name].path}`, {
    method: routes[name].method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  return { status: response.status, body: (await response.json()) as T };
};
async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args, "--home", home.dir], { env: { ...process.env, INVINCIBLE_KEYSTORE: "file" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  return { out, err, code };
}
/** An agent's sandbox_save, through the node's API. */
const keep = (id: string) => TOOLS.find((t) => t.name === "sandbox_save")!.run({ call: async (name: RouteName, input: unknown) => (await send(name, input)).body } as never, { id } as never);

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: fakeDocker().runner, measure: false });
  const made = await send<{ sandbox: SandboxView }>("createSandbox", { network: "isolated" });
  expect(made.status).toBe(200);
  sandbox = made.body.sandbox.id;
  // The node's own store, collecting from the stand-in.
  const store_ = daemon.artifacts;
  const save = store_.save.bind(store_);
  store_.save = ((_collect, input) =>
    save(async (_sandbox, _from, dest) => {
      const files = Object.entries(holds.files);
      for (const [path, text] of files) writeFileSync(join(dest, path), text);
      return { files: files.map(([path, text]) => ({ path, size: text.length, sha256: createHash("sha256").update(text).digest("hex") })), bytes: files.reduce((n, [, text]) => n + text.length, 0), skipped: holds.skipped };
    }, input)) as typeof store_.save;
});
afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a folder kept, and what it left out, said to whoever kept it", () => {
  test("saveArtifact's answer names them, each with why, beside the artifact; the CLI and an agent's tool say them", async () => {
    holds = { files: { "report.md": "# r\n" }, skipped: LEFT };
    const saved = await send<{ artifact: { count: number } | null; skipped?: unknown }>("saveArtifact", { sandbox });
    expect(saved.status).toBe(200);
    expect(saved.body.artifact?.count).toBe(1);
    expect(saved.body.skipped).toEqual({ count: 2, named: LEFT });
    const said = "Left out 2: out/closed (it can't be read here (PermissionError)); out/peek (link)";
    const typed = await cli("sandbox", "save", sandbox);
    expect([typed.code, typed.err]).toEqual([0, ""]);
    expect(typed.out).toContain("Kept 1 file(s)");
    expect(typed.out).toContain(said);
    expect(await keep(sandbox)).toContain(said);
  });

  test("nothing kept but what was left out: still said", async () => {
    holds = { files: {}, skipped: LEFT };
    expect((await send("saveArtifact", { sandbox })).body).toEqual({ artifact: null, skipped: { count: 2, named: LEFT } });
    const typed = await cli("sandbox", "save", sandbox);
    expect(typed.out).toBe("Nothing to keep in /work/out.\nLeft out 2: out/closed (it can't be read here (PermissionError)); out/peek (link)\n");
    expect(await keep(sandbox)).toBe("Nothing to keep in /work/out.\nLeft out 2: out/closed (it can't be read here (PermissionError)); out/peek (link)");
  });

  test("many: as many named as the ledger's line names, and how many more; nothing left out, nothing said", async () => {
    holds = { files: { "report.md": "# r\n" }, skipped: Array.from({ length: 5000 }, (_, i) => ({ path: `out/n${i}`, reason: "link" })) };
    const { body } = await send<{ artifact: { id: string }; skipped: { count: number; named: { path: string }[] } }>("saveArtifact", { sandbox });
    expect(body.skipped.count).toBe(5000);
    expect(body.skipped.named.length).toBeGreaterThan(0);
    expect(body.skipped.named.length).toBeLessThan(100);
    // The same ones the ledger's line names.
    const { entries } = (await send<{ entries: { resource: string; target: string; detail?: string }[] }>("ledger")).body;
    const line = entries.find((e) => e.resource === "artifact" && e.target === body.artifact.id)!.detail!;
    expect(line).toContain(`left out 5000: ${body.skipped.named.map((s) => `${s.path} (link)`).join("; ")}; … and ${5000 - body.skipped.named.length} more`);
    expect((await cli("sandbox", "save", sandbox)).out).toContain(`; … and ${5000 - body.skipped.named.length} more`);
    holds = { files: { "report.md": "# r\n" }, skipped: [] };
    const plain = await send<Record<string, unknown>>("saveArtifact", { sandbox });
    expect(Object.keys(plain.body)).toEqual(["artifact"]);
    expect((await cli("sandbox", "save", sandbox)).out).not.toContain("Left out");
  });
});
