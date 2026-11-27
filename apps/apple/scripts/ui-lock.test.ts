import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * ui-lock.sh, the one lock for on-screen Apple runs on a Mac, each test with a home of its own (never the Mac's own
 * lock). On macOS only: lockf is the BSDs' (Linux has flock), and the script runs on the Macs alone.
 */
const script = join(import.meta.dir, "ui-lock.sh");
const homes: string[] = [];
const holding: { kill(): void }[] = [];

afterEach(() => {
  for (const held of holding.splice(0)) held.kill();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-lock-"));
  homes.push(dir);
  return dir;
}

/** A run under the lock, in that home: its exit, and what it said. */
function run(home: string, args: string[]) {
  const proc = Bun.spawn(["/bin/bash", script, ...args], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  holding.push(proc);
  return { proc, said: () => new Response(proc.stderr).text() };
}

/** A command that writes `<name> start` to the order file, waits for the release file, then writes `<name> end`. */
const holds = (name: string, order: string, release: string) => ["/bin/sh", "-c", `echo "${name} start" >> "$0"; while [ ! -e "$1" ]; do sleep 0.05; done; echo "${name} end" >> "$0"`, order, release];
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`);
    await Bun.sleep(20);
  }
}

describe.skipIf(process.platform !== "darwin")("ui-lock.sh: one on-screen Apple run at a time", () => {
  test("free, the command runs at once with its own exit, says nothing, and the lock is ~/work/.apple-ui.lock", async () => {
    const dir = home();
    const { proc, said } = run(dir, ["/bin/sh", "-c", "exit 3"]);
    expect(await proc.exited).toBe(3);
    expect(await said()).toBe("");
    // Kept (lockf -k): the runners' jobs and agents' runs share this one path.
    expect(existsSync(join(dir, "work", ".apple-ui.lock"))).toBe(true);
  });

  test("two holders in a row: the second waits until the first has ended, then runs, saying how long it waited", async () => {
    const dir = home();
    const order = join(dir, "order");
    const release = join(dir, "release");
    const first = run(dir, holds("first", order, release));
    await until("the first holds the lock", () => lines(order).includes("first start"));
    const second = run(dir, ["/bin/sh", "-c", 'echo "second start" >> "$0"', order]);
    await Bun.sleep(1200);
    // Still waiting: its command hasn't run.
    expect(lines(order)).toEqual(["first start"]);
    expect(second.proc.exitCode).toBeNull();
    writeFileSync(release, "");
    expect(await first.proc.exited).toBe(0);
    expect(await second.proc.exited).toBe(0);
    expect(lines(order)).toEqual(["first start", "first end", "second start"]);
    expect(await first.said()).toBe("");
    const waited = (await second.said()).match(/^ui-lock: waited (\d+) s for (.+): another on-screen Apple run held it\n$/);
    expect(waited).not.toBeNull();
    expect(Number(waited![1])).toBeGreaterThanOrEqual(1);
    expect(waited![2]).toBe(join(dir, "work", ".apple-ui.lock"));
  });

  test("held past its -t, a run gives up with 75 (EX_TEMPFAIL), and its command never runs", async () => {
    const dir = home();
    const order = join(dir, "order");
    const release = join(dir, "release");
    const first = run(dir, holds("first", order, release));
    await until("the first holds the lock", () => lines(order).includes("first start"));
    const second = run(dir, ["-t", "1", "/bin/sh", "-c", 'echo "second start" >> "$0"', order]);
    expect(await second.proc.exited).toBe(75);
    expect(await second.said()).toBe(`ui-lock: gave up after 1 s: another on-screen Apple run still holds ${join(dir, "work", ".apple-ui.lock")}\n`);
    writeFileSync(release, "");
    expect(await first.proc.exited).toBe(0);
    expect(lines(order)).toEqual(["first start", "first end"]);
  });

  test("a command that exits 75 itself, the lock free, runs once and isn't taken for a held lock", async () => {
    const dir = home();
    const order = join(dir, "order");
    const { proc, said } = run(dir, ["/bin/sh", "-c", 'echo ran >> "$0"; exit 75', order]);
    expect(await proc.exited).toBe(75);
    expect(lines(order)).toEqual(["ran"]);
    expect(await said()).toBe("");
  });

  test("a gate's own `lockf -k ~/work/.apple-ui.lock` and this script hold the one lock", async () => {
    const dir = home();
    const order = join(dir, "order");
    const release = join(dir, "release");
    // (The gate's lockf makes the file, not its folder: on the Mac, ~/work is there.)
    mkdirSync(join(dir, "work"));
    const gate = Bun.spawn(["lockf", "-k", join(dir, "work", ".apple-ui.lock"), ...holds("gate", order, release)], { env: { ...process.env, HOME: dir }, stderr: "pipe" });
    holding.push(gate);
    await until("the gate holds the lock", () => lines(order).includes("gate start"));
    const through = run(dir, ["/bin/sh", "-c", 'echo "script start" >> "$0"', order]);
    await Bun.sleep(300);
    expect(lines(order)).toEqual(["gate start"]);
    writeFileSync(release, "");
    expect(await gate.exited).toBe(0);
    expect(await through.proc.exited).toBe(0);
    expect(lines(order)).toEqual(["gate start", "gate end", "script start"]);
  });

  test("without a command, or with a -t that isn't seconds, it says how it's used and exits 64", async () => {
    const dir = home();
    for (const args of [[], ["-t", "soon", "true"], ["-t"]]) {
      const { proc, said } = run(dir, args);
      expect(await proc.exited).toBe(64);
      expect(await said()).toMatch(/^(usage: ui-lock\.sh|ui-lock\.sh: -t takes)/);
    }
  });
});
