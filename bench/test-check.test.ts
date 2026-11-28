import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The check's tests can't hang without a word (scripts/test-check.ts, 28 November 2026). A worker whose test holds its
 * thread is named, the run is stopped, and nothing it began is left running. On the Mac mini a Bun.spawnSync that had
 * lost its child held one for 58 minutes: no test timeout can fire in a thread that never comes back.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "invincible-test-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a test that holds its worker's thread is named by its file and its place there, and the run and its workers are stopped", async () => {
  // A test file of its own, outside the suite. Its second test spins, holding its thread past any timeout of bun's.
  const file = join(dir, "spins.test.ts");
  writeFileSync(file, 'import { test } from "bun:test";\ntest("ends", () => {});\ntest("spins", () => {\n  const end = Date.now() + 120_000;\n  while (Date.now() < end) {}\n});\n');
  const began = Date.now();
  const run = Bun.spawn([process.execPath, "scripts/test-check.ts", "--parallel=2", file], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INVINCIBLE_TEST_STUCK_MS: "1500", INVINCIBLE_TEST_WATCH_EVERY_MS: "200" },
  });
  const [, said, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(code).toBe(1);
  expect(said).toContain("spins.test.ts");
  expect(said).toContain("its test 2 began");
  // Stopped long before its spin would have ended by itself.
  expect(Date.now() - began).toBeLessThan(100_000);
  // The worker it named is gone, as is every process the run began.
  const worker = Number(/worker (\d+)/.exec(said)?.[1]);
  expect(worker).toBeGreaterThan(0);
  expect(alive(worker)).toBe(false);
}, 150_000);
