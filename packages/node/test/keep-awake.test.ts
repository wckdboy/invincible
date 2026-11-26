import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { macHasBattery } from "../src/capabilities.ts";
import { Home } from "../src/home.ts";
import { keepAwake } from "../src/keep-awake.ts";

/*
 * A Mac set to stay on (a Mac mini serving the fleet): kept from sleeping while its node runs, by caffeinate, tied to
 * the node's process; its battery read from the Mac itself; and `galahad awake` to turn it on and off.
 */

test("a Mac is kept awake by caffeinate, on mains power, for as long as the node's process lives; let go when asked", () => {
  const spawned: string[][] = [];
  let killed = 0;
  const held = keepAwake({ platform: "darwin", which: () => "/usr/bin/caffeinate", pid: 4242, spawn: (argv) => (spawned.push(argv), { kill: () => void (killed += 1) }) });
  expect(spawned).toEqual([["caffeinate", "-s", "-w", "4242"]]);
  held!.stop();
  expect(killed).toBe(1);
});

test("nothing is held where there is nothing to hold: not a Mac, or a Mac without caffeinate", () => {
  const spawn = () => {
    throw new Error("nothing should be started");
  };
  expect(keepAwake({ platform: "linux", which: () => "/usr/bin/caffeinate", spawn })).toBeNull();
  expect(keepAwake({ platform: "darwin", which: () => null, spawn })).toBeNull();
});

test("a Mac's battery is its own word, pmset's: a laptop has an internal battery, a Mac mini none", () => {
  expect(macHasBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t85%; charging; 1:02 remaining present: true\n")).toBe(true);
  expect(macHasBattery("Now drawing from 'AC Power'\n")).toBe(false);
  // Couldn't be asked: none is assumed (a battery would have said so).
  expect(macHasBattery(null)).toBe(false);
});

const root = mkdtempSync(join(tmpdir(), "galahad-awake-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("galahad awake on and off keep the choice in the node's config; status says it, and that no node is running", async () => {
  const home = new Home(join(root, "node"));
  home.writeConfig({ v: 1, name: "mini", fleet: null, port: 1, keystore: "file", advertise: null });
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args, "--home", home.dir], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GALAHAD_KEYSTORE: "file" } });
    const out = await new Response(proc.stdout).text();
    return { out, code: await proc.exited };
  };
  expect((await cli("awake", "on")).code).toBe(0);
  expect(JSON.parse(readFileSync(home.configPath, "utf8")).keepAwake).toBe(true);
  const status = await cli("awake", "status");
  expect(status.out).toContain("keep-awake: on (the node isn't running, or didn't say)");
  expect((await cli("awake", "off")).code).toBe(0);
  expect(JSON.parse(readFileSync(home.configPath, "utf8")).keepAwake).toBe(false);
  expect((await cli("awake", "sideways")).code).not.toBe(0);
});
