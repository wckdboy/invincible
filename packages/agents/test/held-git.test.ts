import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE } from "@invincible/core";
import { SHIPMENT_SCRIPT } from "../src/ship.ts";
import { checkpointCommand, REPO_TASK_START } from "../src/team-runtime.ts";

/*
 * The node's own git in an agent's repository, with the repository's own configuration held off (held-git.ts: the
 * fourth fabric review's R4-4, its PoC turned around). In layout 2 another node's task shares the agent's work/ tree, the
 * repository's .git among it. What it writes there (a hook, an fsmonitor, a filter, a URL rewrite) must never run as the
 * agent, in its own VM, with its HOME's lease beside it, when the node itself runs git there: a task's setup, a step's
 * checkpoint, and what is kept to ship. Here the agent's /work is a temporary folder (its paths written into the scripts
 * as the PoC did), its HOME another, and the gateway a stand-in on loopback.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** What reached the gateway's stand-in (and another host's, for a rewrite to take the fetch to), with any token. */
const reached: { host: string; auth: string | null }[] = [];
const serve = (host: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (reached.push({ host, auth: req.headers.get("authorization") }), new Response("no", { status: 404 })) });
const gateway = serve("gateway");
const elsewhere = serve("elsewhere");
afterAll(async () => {
  await gateway.stop(true);
  await elsewhere.stop(true);
});

const TOKEN = "gw_not_a_real_token_with_your_keys";

/** An agent's VM, as far as git goes: its /work with its repository, its HOME with its lease, and the scripts' paths in it. */
function vm() {
  const work = temp("held-work-");
  const home = temp("held-home-");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
  const repo = join(work, "repo");
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { env, encoding: "utf8" });
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "the agent's repository\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@agents.invalid");
  writeFileSync(join(home, LEASE_FILE), JSON.stringify({ INVINCIBLE_TOKEN: TOKEN, INVINCIBLE_REPO_URL: `http://127.0.0.1:${gateway.port}/git/repo`, INVINCIBLE_KEYS: "http://127.0.0.1:9/key" }));
  /** Whatever a planted command ran, it says here: as whom, and the lease it read. */
  const marker = join(work, "what-it-read");
  const planted = `#!/bin/sh\n{ echo "ran as HOME=$HOME"; cat "$HOME/${LEASE_FILE}"; } >> "${marker}"\n`;
  const at = (script: string) => script.replaceAll("'/work/repo'", JSON.stringify(repo)).replaceAll("'/work/.agent/base/'", JSON.stringify(join(work, ".agent/base") + "/")).replaceAll("/work/.agent/checkpoints", join(work, ".agent/checkpoints"));
  // (Run as a process of its own, never synchronously: the gateway's stand-in answers from this one.)
  const run = async (argv: string[], cwd?: string) => {
    const proc = Bun.spawn(argv, { cwd, env: { PATH: env.PATH, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, status };
  };
  const start = (task: string) => run(["python3", "-I", "-c", at(REPO_TASK_START), join(work, "tasks", task), join(work, ".agent/base", task)]);
  const shell = (command: string, cwd: string) => run(["bash", "-c", command], cwd);
  const ran = () => (existsSync(marker) ? readFileSync(marker, "utf8") : "");
  return { work, home, repo, git, marker, planted, at, start, shell, ran };
}

describe("a task's setup in the agent's repository (REPO_TASK_START)", () => {
  test("runs no hook another node's task wrote in it, nor its fsmonitor: the worktree is made, and nothing of theirs ran", async () => {
    const v = vm();
    writeFileSync(join(v.repo, ".git/hooks/post-checkout"), v.planted);
    chmodSync(join(v.repo, ".git/hooks/post-checkout"), 0o755);
    writeFileSync(join(v.work, "fsmonitor"), v.planted);
    chmodSync(join(v.work, "fsmonitor"), 0o755);
    v.git("config", "core.fsmonitor", join(v.work, "fsmonitor"));
    reached.length = 0;
    const ran = await v.start("task-next");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toMatch(/^[0-9a-f]{40} stale$/);
    expect(existsSync(join(v.work, "tasks/task-next/README.md"))).toBe(true);
    expect(v.ran()).toBe("");
    // (Its fetch went to the gateway, with the lease, and nowhere else.)
    expect(reached.every((r) => r.host === "gateway")).toBe(true);
    expect(reached.some((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("isn't started in a repository whose configuration names a filter, an include, another worktree or a hooks path", async () => {
    for (const [key, value] of [["filter.evil.smudge", "sh -c x"], ["include.path", "/tmp/elsewhere.cfg"], ["core.worktree", "/tmp"], ["core.hooksPath", "/tmp/hooks"]] as const) {
      const v = vm();
      v.git("config", key, value);
      const ran = await v.start("task-x");
      expect([key, ran.status]).toEqual([key, 1]);
      expect(ran.stderr).toContain(`this repository isn't used here: its configuration names ${key.toLowerCase()}`);
      expect(existsSync(join(v.work, "tasks/task-x"))).toBe(false);
    }
  });

  test("doesn't fetch, with the lease, through a repository whose configuration would take the fetch elsewhere", async () => {
    const v = vm();
    v.git("config", `url.http://127.0.0.1:${elsewhere.port}/.insteadOf`, `http://127.0.0.1:${gateway.port}/`);
    reached.length = 0;
    const ran = await v.start("task-y");
    // The token went nowhere: neither to the rewrite's host, nor anywhere else.
    expect(reached).toEqual([]);
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toMatch(/^[0-9a-f]{40} stale$/);
    expect(ran.stderr).toContain(`not fetched: its configuration names url.http://127.0.0.1:${elsewhere.port}/.insteadof`);
  });
});

describe("a step's checkpoint, and what is kept to ship", () => {
  test("a checkpoint runs no hook or fsmonitor of the repository's, and keeps the step as before", async () => {
    const v = vm();
    expect((await v.start("task-c")).status).toBe(0);
    const root = join(v.work, "tasks/task-c");
    for (const hook of ["reference-transaction", "post-index-change"]) {
      writeFileSync(join(v.repo, ".git/hooks", hook), v.planted);
      chmodSync(join(v.repo, ".git/hooks", hook), 0o755);
    }
    writeFileSync(join(v.work, "fsmonitor"), v.planted);
    chmodSync(join(v.work, "fsmonitor"), 0o755);
    v.git("config", "core.fsmonitor", join(v.work, "fsmonitor"));
    writeFileSync(join(root, "made.txt"), "a step's work\n");
    const kept = await v.shell(v.at(checkpointCommand(root, "task-c", 1, "")), root);
    expect(kept.status).toBe(0);
    expect(kept.stdout.trim()).toMatch(/^[0-9a-f]{40} [0-9a-f]{40} [0-9a-f]{40}$/);
    expect(v.git("show", "--stat", "--format=%s", "refs/invincible/checkpoints/task-c/1").stdout).toContain("made.txt");
    expect(v.ran()).toBe("");
    // The same step again: nothing new to keep.
    const [, tree, parent] = kept.stdout.trim().split(" ");
    expect((await v.shell(v.at(checkpointCommand(root, "task-c", 2, `${tree} ${parent}`)), root)).stdout.trim()).toBe("same");
  });

  test("a checkpoint and the shipment run no filter of the repository's: a repository that names one is refused, saying so", async () => {
    const v = vm();
    expect((await v.start("task-f")).status).toBe(0);
    const root = join(v.work, "tasks/task-f");
    // What a handed task can write: a clean filter in the repository's configuration, and the attribute that calls it.
    writeFileSync(join(v.work, "clean"), `${v.planted}cat\n`);
    chmodSync(join(v.work, "clean"), 0o755);
    v.git("config", "filter.evil.clean", join(v.work, "clean"));
    writeFileSync(join(root, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(root, "made.txt"), "a step's work\n");
    const kept = await v.shell(v.at(checkpointCommand(root, "task-f", 1, "")), root);
    expect(kept.status).not.toBe(0);
    expect(kept.stderr).toContain("this repository isn't used here: its configuration names filter.evil.clean");
    const shipped = await v.shell(`python3 -I -c '${SHIPMENT_SCRIPT.replaceAll("'", `'\\''`)}' . ${join(v.work, "out/ship")}`, root);
    expect(shipped.status).not.toBe(0);
    expect(shipped.stderr).toContain("its configuration names filter.evil.clean");
    expect(v.ran()).toBe("");
  });
});
