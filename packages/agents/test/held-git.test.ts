import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE } from "@invincible/core";
import { SHIPMENT_SCRIPT } from "../src/ship.ts";
import { changesCommand, checkpointCommand, REPO_TASK_START, repositoryEvidence } from "../src/team-runtime.ts";

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
/** A gateway's stand-in that asks for credentials, so that git would prompt for them. */
const asking = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (reached.push({ host: "asking", auth: req.headers.get("authorization") }), new Response("who?", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } })) });
afterAll(async () => {
  await gateway.stop(true);
  await elsewhere.stop(true);
  await asking.stop(true);
});

const TOKEN = "gw_not_a_real_token_with_your_keys";

/** An agent's VM, as far as git goes: its /work with its repository, its HOME with its lease, and the scripts' paths in it. */
function vm() {
  const work = temp("held-work-");
  const home = temp("held-home-");
  // (A folder first on its PATH, where a test puts a stand-in for a program a repository's configuration names.)
  const bin = temp("held-bin-");
  const env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
  const repo = join(work, "repo");
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { env, encoding: "utf8" });
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "the agent's repository\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@agents.invalid");
  // (A clone, as every agent's repository is: what is kept to ship says where it came from.)
  git("remote", "add", "origin", "https://example.test/ada/repo.git");
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
  /** A stand-in for a program on its PATH, which says that it ran (and passes what it is given through, as a filter would). */
  const standIn = (name: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $* ran as HOME=$HOME" >> "${marker}"\ncat\n`);
    chmodSync(join(bin, name), 0o755);
  };
  /** Its lease, pointing its repository at `url`. */
  const lease = (url: string) => writeFileSync(join(home, LEASE_FILE), JSON.stringify({ INVINCIBLE_TOKEN: TOKEN, INVINCIBLE_REPO_URL: url, INVINCIBLE_KEYS: "http://127.0.0.1:9/key" }));
  return { work, home, bin, repo, git, marker, planted, at, start, shell, ran, standIn, lease };
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

  test("is started in a repository that uses husky's hooks path, and runs none of its hooks: its setup, checkpoints, evidence and changes", async () => {
    const v = vm();
    // What husky's install leaves (its prepare script, at every npm install): core.hooksPath at .husky/_, and a hook there
    // for each of git's, in each worktree it is installed in.
    const husky = (root: string) => {
      mkdirSync(join(root, ".husky/_"), { recursive: true });
      writeFileSync(join(root, ".husky/_/.gitignore"), "*\n");
      for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "pre-commit", "post-commit"]) {
        writeFileSync(join(root, ".husky/_", hook), v.planted);
        chmodSync(join(root, ".husky/_", hook), 0o755);
      }
    };
    v.git("config", "core.hooksPath", ".husky/_");
    husky(v.repo);
    const ran = await v.start("task-h");
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    const root = join(v.work, "tasks/task-h");
    expect(existsSync(join(root, "README.md"))).toBe(true);
    husky(root);
    writeFileSync(join(root, "made.txt"), "a step's work\n");
    const kept = await v.shell(v.at(checkpointCommand(root, "task-h", 1, "")), root);
    expect(kept.status).toBe(0);
    expect(v.git("show", "--stat", "--format=%s", "refs/invincible/checkpoints/task-h/1").stdout).toContain("made.txt");
    for (const { run } of repositoryEvidence("HEAD")) expect((await v.shell(run, root)).status).toBe(0);
    const changes = await v.shell(changesCommand(join(v.work, "out/task-h"), "HEAD"), root);
    expect([changes.status, changes.stdout.trim()]).toEqual([0, "1"]);
    expect(v.ran()).toBe("");
  });

  test("is started in a repository with Git LFS installed in it, and runs none of LFS: its pointers are checked out, and its files kept, as they are", async () => {
    const v = vm();
    // A pointer as LFS stores one, committed (through LFS's clean filter, in the agent's own git).
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
    writeFileSync(join(v.repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(v.repo, "model.bin"), pointer);
    v.git("add", ".");
    v.git("commit", "-q", "-m", "a model, in LFS");
    // What `git lfs install --local` writes (git-lfs 3): its filter, required, and its four hooks; git-lfs itself a
    // stand-in that says when it runs.
    v.git("config", "filter.lfs.clean", "git-lfs clean -- %f");
    v.git("config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    v.git("config", "filter.lfs.process", "git-lfs filter-process");
    v.git("config", "filter.lfs.required", "true");
    v.git("config", "lfs.repositoryformatversion", "0");
    for (const hook of ["post-checkout", "post-commit", "post-merge", "pre-push"]) {
      writeFileSync(join(v.repo, ".git/hooks", hook), `#!/bin/sh\ngit lfs ${hook} "$@"\n`);
      chmodSync(join(v.repo, ".git/hooks", hook), 0o755);
    }
    v.standIn("git-lfs");
    const ran = await v.start("task-l");
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    const root = join(v.work, "tasks/task-l");
    expect(readFileSync(join(root, "model.bin"), "utf8")).toBe(pointer);
    // The agent's work: the model itself where its pointer was, and a new one.
    writeFileSync(join(root, "model.bin"), "the model's own bytes\n");
    writeFileSync(join(root, "new.bin"), "another model\n");
    const kept = await v.shell(v.at(checkpointCommand(root, "task-l", 1, "")), root);
    expect(kept.status).toBe(0);
    expect(v.git("show", "refs/invincible/checkpoints/task-l/1:model.bin").stdout).toBe("the model's own bytes\n");
    const changes = await v.shell(changesCommand(join(v.work, "out/task-l"), "HEAD"), root);
    expect([changes.status, changes.stdout.trim()]).toEqual([0, "2"]);
    expect(readFileSync(join(v.work, "out/task-l/ship/files/model.bin"), "utf8")).toBe("the model's own bytes\n");
    expect(v.ran()).toBe("");
  });

  test("isn't started in a repository whose configuration names another worktree, which nothing the node sets holds off", async () => {
    const v = vm();
    v.git("config", "core.worktree", v.home);
    const ran = await v.start("task-x");
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("this repository isn't used here: its configuration names core.worktree");
    expect(existsSync(join(v.work, "tasks/task-x"))).toBe(false);
  });

  test("doesn't fetch, with the lease, through a repository whose configuration would take the fetch elsewhere", async () => {
    const to = `http://127.0.0.1:${elsewhere.port}`;
    const from = `http://127.0.0.1:${gateway.port}`;
    // Each would take a fetch of the gateway's address, and the token it carries, to another host or program: a URL
    // rewrite, its own or one it includes; an HTTP proxy, for every address or for the gateway's; an address of its own
    // for the gateway's host (which re-points even an address like the gateway's); a credential helper, a program of
    // its; and a remote named by the gateway's own address, whose URL or proxy git takes a fetch by that address to.
    const include = join(temp("held-include-"), "more.cfg");
    writeFileSync(include, `[url "${to}/"]\n\tinsteadOf = ${from}/\n`);
    for (const [key, value, named = key.toLowerCase()] of [
      [`url.${to}/.insteadOf`, `${from}/`],
      ["include.path", include, `url.${to}/.insteadof`],
      ["http.proxy", to],
      [`http.${from}/.proxy`, to],
      ["http.curloptResolve", `127.0.0.1:${gateway.port}:127.0.0.1`],
      ["credential.helper", "!sh -c 'cat \"$HOME/x\"'"],
      [`credential.${from}.helper`, "store"],
      [`remote.${from}/git/repo.url`, `${to}/stolen`],
      [`remote.${from}/git/repo.proxy`, to],
    ] as const) {
      const v = vm();
      v.git("config", key, value);
      reached.length = 0;
      const ran = await v.start("task-y");
      // The token went nowhere: neither where that key would take it, nor to the gateway.
      expect([key, reached]).toEqual([key, []]);
      expect([key, ran.status]).toEqual([key, 0]);
      expect(ran.stdout.trim()).toMatch(/^[0-9a-f]{40} stale$/);
      expect(ran.stderr).toContain(`not fetched: its configuration names ${named}`);
    }
  });

  test("fetches with the lease through a repository whose own HTTP, credential and transport settings are ordinary ones", async () => {
    const v = vm();
    for (const [key, value] of [["http.postBuffer", "524288000"], ["http.version", "HTTP/1.1"], ["credential.useHttpPath", "true"], ["credential.https://github.com.username", "ada"], ["core.sshCommand", "ssh -i ~/.ssh/work"], ["core.askPass", join(v.work, "askpass")]] as const) v.git("config", key, value);
    reached.length = 0;
    const ran = await v.start("task-o");
    expect(ran.status).toBe(0);
    expect(ran.stderr).not.toContain("not fetched");
    // (The gateway's stand-in has no repository, so the task starts on the clone as it was, having asked.)
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((r) => r.host === "gateway" && r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("runs no askpass program of the repository's when the gateway asks for credentials", async () => {
    const v = vm();
    writeFileSync(join(v.work, "askpass"), `${v.planted}echo x\n`);
    chmodSync(join(v.work, "askpass"), 0o755);
    v.git("config", "core.askPass", join(v.work, "askpass"));
    v.lease(`http://127.0.0.1:${asking.port}/git/repo`);
    reached.length = 0;
    const ran = await v.start("task-a");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toMatch(/^[0-9a-f]{40} stale$/);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((r) => r.host === "asking")).toBe(true);
    expect(v.ran()).toBe("");
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

  test("a checkpoint, the evidence and the shipment run no filter of the repository's, its own or one it includes, and keep each file as it is", async () => {
    const v = vm();
    expect((await v.start("task-f")).status).toBe(0);
    const root = join(v.work, "tasks/task-f");
    // What a handed task can write: clean filters in the repository's configuration (one whose name holds '=', which a
    // -c would cut short), one in a file it includes, and the attributes that call them.
    writeFileSync(join(v.work, "clean"), `${v.planted}cat\n`);
    chmodSync(join(v.work, "clean"), 0o755);
    v.git("config", "filter.evil.clean", join(v.work, "clean"));
    v.git("config", "filter.evil.required", "true");
    v.git("config", "filter.a=b.clean", join(v.work, "clean"));
    const include = join(temp("held-include-"), "more.cfg");
    writeFileSync(include, `[filter "Kept"]\n\tclean = ${join(v.work, "clean")}\n\tprocess = ${join(v.work, "clean")}\n`);
    v.git("config", "include.path", include);
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n*.md filter=Kept\n*.csv filter=a=b\n");
    for (const name of ["made.txt", "notes.md", "data.csv"]) writeFileSync(join(root, name), `${name}: a step's work\n`);
    const kept = await v.shell(v.at(checkpointCommand(root, "task-f", 1, "")), root);
    expect([kept.status, kept.stderr]).toEqual([0, ""]);
    for (const name of ["made.txt", "notes.md", "data.csv"]) expect(v.git("show", `refs/invincible/checkpoints/task-f/1:${name}`).stdout).toBe(`${name}: a step's work\n`);
    for (const { run } of repositoryEvidence("HEAD")) expect((await v.shell(run, root)).status).toBe(0);
    const shipped = await v.shell(`python3 -I -c '${SHIPMENT_SCRIPT.replaceAll("'", `'\\''`)}' . ${join(v.work, "out/ship")}`, root);
    expect([shipped.status, shipped.stdout.trim()]).toEqual([0, "4"]);
    expect(v.ran()).toBe("");
  });
});
