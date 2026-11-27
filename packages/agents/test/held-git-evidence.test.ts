import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE } from "@invincible/core";
import { repositoryEvidence } from "../src/team-runtime.ts";

/*
 * A task's evidence in a repository (team-runtime.ts repositoryEvidence; the fourth fabric review's R4-4): what `git
 * status` and `git diff` say where it works, run with the repository's own configuration held off, so that no fsmonitor,
 * external diff or textconv another node's task wrote in the shared repository runs as the agent. The reviewer is shown
 * them by the words they were shown by before.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a task's evidence runs no fsmonitor, external diff or textconv of the repository's, and says what changed", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "held-evidence-")));
  dirs.push(work);
  const home = join(work, "home");
  mkdirSync(home);
  writeFileSync(join(home, LEASE_FILE), JSON.stringify({ INVINCIBLE_TOKEN: "gw_not_a_real_token_with_your_keys" }));
  const repo = join(work, "repo");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { env, encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "the agent's repository\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const base = git("rev-parse", "HEAD").stdout.trim();
  // What another node's task can write in the repository it shares: an fsmonitor, an external diff, and a textconv
  // that the repository's attributes call.
  const marker = join(work, "what-it-read");
  const planted = join(work, "planted");
  writeFileSync(planted, `#!/bin/sh\n{ echo "ran as HOME=$HOME"; cat "$HOME/${LEASE_FILE}"; } >> "${marker}"\n`);
  chmodSync(planted, 0o755);
  git("config", "core.fsmonitor", planted);
  git("config", "diff.external", planted);
  git("config", "diff.evil.textconv", planted);
  writeFileSync(join(repo, ".gitattributes"), "*.md diff=evil\n");
  writeFileSync(join(repo, "README.md"), "the agent's repository, changed\n");
  writeFileSync(join(repo, "new.txt"), "a new file\n");
  const evidence = repositoryEvidence(base);
  // Shown by the words it was shown by before.
  expect(evidence.map((e) => e.shown)).toEqual(["git status --short", `git add -A -N . 2>/dev/null; git diff --no-ext-diff --no-textconv ${base} | head -c 24000`]);
  const said: string[] = [];
  for (const { run } of evidence) {
    const proc = Bun.spawn(["bash", "-c", run], { cwd: repo, env: { PATH: env.PATH, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    said.push(out);
  }
  expect(said[0]).toContain(" M README.md");
  expect(said[0]).toContain("?? new.txt");
  expect(said[1]).toContain("+the agent's repository, changed");
  expect(said[1]).toContain("+a new file");
  expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
});
