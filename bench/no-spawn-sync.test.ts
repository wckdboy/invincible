import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * No synchronous spawn in the repository's code, its tests, its benches or its scripts (28 November 2026). A
 * synchronous spawn holds its process's thread until it sees its child end, and on the Mac mini Bun.spawnSync lost
 * children's ends and held test workers for good, past every test's own limit: the evals, then held-git, layout and
 * project-git, the same frames each time (bun+0x994fe4 → +0xdc9364, a child left defunct). The node asks with
 * processes.ts, and tests, benches and scripts with bench/spawned.ts: an async spawn, with a time limit. What may still
 * name one is below, each with why; a new one needs its own line here, and a reason a reviewer accepts.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// (A call, as code writes one: prose that names one, "Bun.spawnSync (bun 1.4.2)", is no call.)
const CALL = /\b(?:spawnSync|execSync|execFileSync)\(/;

/** Files that may call one, by path: why each may. */
const EXCEPTIONS: Record<string, string> = {
  "apps/site/src/lib/facts.ts": "the site's build (astro, under Node) reads the commit it is built from, once; it is never run by a test, a bench or the node, and Bun's lost child is Bun's",
};

test("nothing calls a synchronous spawn but the exceptions named here, each with why", async () => {
  const listed = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const files = (await new Response(listed.stdout).text()).split("\0").filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path));
  expect(await listed.exited).toBe(0);
  expect(files.length).toBeGreaterThan(500);
  const found: string[] = [];
  for (const path of files) {
    if (path in EXCEPTIONS) continue;
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    if (!CALL.test(text)) continue;
    text.split("\n").forEach((line, i) => {
      if (CALL.test(line)) found.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  expect(found).toEqual([]);
});

test("each exception is still there and still needs to be", () => {
  for (const path of Object.keys(EXCEPTIONS)) expect(CALL.test(readFileSync(join(root, path), "utf8"))).toBe(true);
});
