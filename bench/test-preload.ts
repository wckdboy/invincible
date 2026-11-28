// Loaded before every test file (bunfig.toml's [test] preload): bench/test-preload.test.ts holds it to what it says.
import { afterEach, beforeAll, beforeEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * A test's git never reaches the repository the tests run in. In a linked worktree, `git rebase --exec` and git's hooks
 * export GIT_DIR, and a caller may export the rest: every `git -C <tmp>` a test spawns would then act on that
 * repository, not on its own temp one (27 November 2026: core.bare = true and core.autocrlf written into the shared
 * .git/config, commits on a rebase's HEAD, its index replaced). So they are cleared before any test runs; a test that
 * means one sets it on the command it spawns.
 */
export const GIT_LOCATION = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"] as const;
for (const name of GIT_LOCATION) delete process.env[name];

/*
 * node:child_process passes process.env as it stands, so that is enough there. Bun's own spawn passes the environment
 * the process started with unless it is given one (Bun 1.4: a name deleted from process.env still reaches it), so a
 * command spawned without an env is given the environment as it stood when the test run began, without these. (Its
 * synchronous spawn is not wrapped: nothing here may call one, bench/no-spawn-sync.test.ts.)
 */
const started: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
type Spawn = (...args: unknown[]) => unknown;
const withEnv = (args: unknown[]): unknown[] => {
  const [first, second] = args;
  if (Array.isArray(first)) {
    const options = (second ?? {}) as { env?: unknown };
    return [first, { ...options, env: options.env ?? started }, ...args.slice(2)];
  }
  const options = (first ?? {}) as { env?: unknown };
  return [{ ...options, env: options.env ?? started }, ...args.slice(1)];
};
const spawn = Bun.spawn as unknown as Spawn;
Bun.spawn = ((...args: unknown[]) => spawn(...withEnv(args))) as unknown as typeof Bun.spawn;

/*
 * Where each worker of a watched run stands (scripts/test-check.ts runs `bun run check`'s tests): the file it is in, how
 * many of that file's tests have begun, and whether one is running, written as each begins and ends. A test whose thread
 * is held by a synchronous wait can't end or time out, so its worker's record stands still, and the runner names it. On
 * the Mac mini (28 November 2026) a Bun.spawnSync lost its child and held a worker 58 minutes, and the check with it.
 * Only in a watched run, which gives the directory.
 */
const watched = process.env.INVINCIBLE_TEST_WATCH;
if (watched) {
  const record = join(watched, `${process.pid}.json`);
  let begun = 0;
  // (Wall-clock milliseconds from performance, not Date: a test may stub Date.now or set the system time.)
  const now = (): number => Math.round(performance.timeOrigin + performance.now());
  const say = (running: boolean): void => {
    try {
      writeFileSync(record, JSON.stringify({ pid: process.pid, file: Bun.main, test: begun, running, at: now() }));
    } catch {
      /* the runner's directory is gone: nothing to tell */
    }
  };
  beforeAll(() => say(false));
  beforeEach(() => {
    begun += 1;
    say(true);
  });
  afterEach(() => say(false));
}
