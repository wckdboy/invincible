import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { loopRecords } from "../src/loops.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * `galahad loop add` as it is typed at a terminal, through the CLI's own reading of its flags (cli.ts parseArgs).
 * A loop once (--at, --in) was first tested only from loopCommand, past that reading: the CLI, which reads a flag it
 * wasn't told of as a switch, took `--in 2m` for `--in` alone and refused the loop on Ultra (24 November 2026).
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "loop-cli-test", cores: 2, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: true, vm: { kvm: false, tools: [] }, tools: ["git"], localModels: [], tailscale: null, sandbox: { image: true, networks: true } };

const root = mkdtempSync(join(tmpdir(), "galahad-loop-cli-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon | undefined;

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args, "--home", home.dir], { env: { ...process.env, GALAHAD_KEYSTORE: "file" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  return { out, err, code };
}

test("a loop once, typed at a terminal: --at a time in a zone, or --in a while from now", async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, loopIntervalMs: 60_000, docker: fakeDocker().runner, measure: false });

  const at = await cli("loop", "add", "call-mum", "--at", "2030-01-02 17:30", "--tz", "Europe/Copenhagen", "--say", "Call mum");
  expect(at.err).toBe("");
  expect(at.code).toBe(0);
  const later = await cli("loop", "add", "look-again", "--in", "2h", "--tz", "UTC", "--tell");
  expect(later.err).toBe("");
  expect(later.code).toBe(0);

  const loops = new Map(loopRecords(daemon.store).map((loop) => [loop.name, loop]));
  expect(loops.get("call-mum")).toMatchObject({ scheduleText: "at 2030-01-02 17:30", tz: "Europe/Copenhagen", task: { kind: "tell", text: "Call mum" } });
  const look = loops.get("look-again")!;
  expect(look.tz).toBe("UTC");
  expect(look.scheduleText).toMatch(/^at \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // Two hours on, to the minute after.
  const when = Date.parse(`${look.scheduleText.slice(3).replace(" ", "T")}:00Z`);
  expect(when - Date.now()).toBeGreaterThan(2 * 3600_000 - 60_000);
  expect(when - Date.now()).toBeLessThan(2 * 3600_000 + 120_000);
}, 60_000);
