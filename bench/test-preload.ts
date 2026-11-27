// Loaded before every test file (bunfig.toml's [test] preload): bench/test-preload.test.ts holds it to what it says.

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
 * command spawned without an env is given the environment as it stood when the test run began, without these.
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
const spawnSync = Bun.spawnSync as unknown as Spawn;
Bun.spawn = ((...args: unknown[]) => spawn(...withEnv(args))) as unknown as typeof Bun.spawn;
Bun.spawnSync = ((...args: unknown[]) => spawnSync(...withEnv(args))) as unknown as typeof Bun.spawnSync;
