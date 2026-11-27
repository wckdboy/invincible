import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A test's git never reaches the repository the tests run in (bench/test-preload.ts, the [test] preload in bunfig.toml).
 * In a linked worktree, `git rebase --exec` and git's hooks export GIT_DIR: on 27 November 2026 a test's `git -C <tmp>
 * init` and `config` then wrote core.bare = true and core.autocrlf into the shared .git/config, its commits landed on the
 * rebase's HEAD and its index replaced the worktree's. Here a stand-in plays the repository the tests run in: a test run
 * with its location exported spawns git in a temp repository of its own, and the stand-in is untouched.
 */

const dir = mkdtempSync(join(tmpdir(), "invincible-git-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env) => Bun.spawnSync(cmd, { cwd, env });
const git = (repo: string, ...a: string[]) => run(["git", "-C", repo, "-c", "user.email=t@example.test", "-c", "user.name=t", ...a], repo);

test("a test run where git's location is exported (a rebase's exec, a hook) leaves that repository as it was: its shared config, its HEADs, its indexes", () => {
  // The repository the tests run in, as a stand-in: one commit, its config and index as git left them.
  const real = join(dir, "real");
  mkdirSync(real);
  git(real, "init", "-q");
  writeFileSync(join(real, "kept.txt"), "kept\n");
  git(real, "add", "-A");
  git(real, "commit", "-qm", "kept");
  // With a linked worktree, as the agents' are: its gitdir is where a rebase's exec there points GIT_DIR.
  const linked = join(dir, "linked");
  git(real, "worktree", "add", "-q", "--detach", linked);
  const read = (...path: string[]) => readFileSync(join(real, ".git", ...path)).toString("base64");
  const state = () => ({ config: readFileSync(join(real, ".git", "config"), "utf8"), head: git(real, "rev-parse", "HEAD").stdout.toString(), index: read("index"), linked: git(linked, "rev-parse", "HEAD").stdout.toString(), linkedIndex: read("worktrees", "linked", "index") });
  const before = state();

  // Its location exported as a rebase's exec does in a linked worktree (GIT_DIR alone, the worktree's gitdir: under it,
  // a test's init made the shared config bare), and as a caller may export all of it.
  const exported: Record<string, Record<string, string>> = {
    "GIT_DIR of a linked worktree": { GIT_DIR: join(real, ".git", "worktrees", "linked") },
    "all of it": { GIT_DIR: join(real, ".git"), GIT_WORK_TREE: real, GIT_INDEX_FILE: join(real, ".git", "index"), GIT_COMMON_DIR: join(real, ".git"), GIT_OBJECT_DIRECTORY: join(real, ".git", "objects") },
  };
  for (const [which, location] of Object.entries(exported)) {
    // A test that does what the shipment script's tests do, in a temp repository of its own: git through Bun's spawn
    // and node's, neither given an environment.
    const own = mkdtempSync(join(dir, "own-"));
    const probe = join(own, "..", `${own.split("/").at(-1)}.test.ts`);
    writeFileSync(
      probe,
      `import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
test("git in a temp repository of its own", () => {
  const repo = ${JSON.stringify(own)};
  // Bun's own spawn, and node's: each passes its environment unless it is given one.
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@example.test", "-c", "user.name=t", ...a]);
  git("init", "-q");
  execFileSync("git", ["-C", repo, "config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "calc.py"), "print(1 + 1)\\n");
  git("add", "-A");
  expect(git("commit", "-qm", "init").exitCode).toBe(0);
});
`,
    );
    // Run as this repository's tests run (its bunfig.toml), with the stand-in's location exported.
    const child = run([process.execPath, "test", probe], join(import.meta.dir, ".."), { ...process.env, ...location });
    // The stand-in is as it was; the test ran, and its commit is in its own repository.
    expect([which, state()]).toEqual([which, before]);
    expect([which, child.exitCode, child.exitCode === 0 ? "" : child.stderr.toString().slice(-2000)]).toEqual([which, 0, ""]);
    expect([which, git(own, "log", "--format=%s").stdout.toString().trim()]).toEqual([which, "init"]);
  }
}, 30_000);
