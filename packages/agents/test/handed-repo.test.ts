import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { handedApply, handedCopy, handedDrop, handedGive, handedManifests, handedNonce, handedReceive, handedRoundStore, handedRoundTake, handedSend, handedSweep, handedTake, handedTree } from "../src/handed-repo.ts";
import { changesCommand } from "../src/team-runtime.ts";

// Every test here makes repositories and runs git on them, as processes of their own, so its time is the machine's to
// give: "its changes come back to the agent's worktree" took 1.1 s on the Mac mini at a load of 25 on 18 cores, the
// clone's tests ran past bun's 5 s on main at load (28 November 2026), and the slowest took 39.5 s with 2 % of a core
// (what each of about 585 runnable tasks gets of 12). The limit is how long a busy machine may take, never what a test
// checks.
setDefaultTimeout(120_000);

/*
 * Another node's task's clone of its own, and its changes back (handed-repo.ts; the fifth fabric review's R5-3, by the
 * reviewer's first option). Here the agent's /work and the task VM's are temporary folders, and the node's pipe between
 * them a shell's: what the agent's side gives is cloned on the task's side, and what the task's side sends back is
 * applied to the agent's worktree with the node's held git. What the task's side sends is the task's own to make, so the
 * agent's side is also given patches made to harm it: none reaches outside the worktree, into a .git, or through a link.
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
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const sh = (command: string, input?: string) => spawnSync("bash", ["-o", "pipefail", "-c", command], { env: { PATH: env.PATH, HOME: "/nonexistent" }, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { env, encoding: "utf8" });
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * An agent's repository with a task's worktree in it at its base, and a task VM's /work beside it. `prepare` adds to the
 * repository, with commits of its own, before the base is taken.
 */
function setUp(prepare?: (repo: string) => void) {
  const agent = temp("handed-agent-");
  const task = temp("handed-task-");
  const repo = join(agent, "repo");
  spawnSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "the agent's repository\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(join(repo, "app.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "second");
  prepare?.(repo);
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const root = join(agent, "tasks", "task-x");
  git(repo, "worktree", "add", "-q", "--detach", root, base);
  const keep = { agent: join(agent, ".agent/handed"), task: join(task, ".agent/handed") };
  const theirs = join(task, "tasks", "task-x");
  /** The task's clone, from what the agent's side gives, through a pipe. */
  const give = () => sh(`${handedGive(root, "task-x", keep.agent)} | ${handedTake(theirs, base, "Ada", "ada@agents.invalid", keep.task)}`);
  /** What the agent's side received (by `nonce`), applied as the node applies it: as many bytes as it says it kept. */
  const applyReceived = (received: ReturnType<typeof sh>, nonce: string, limit: number) => (received.status !== 0 ? received : sh(handedApply(root, base, "task-x", nonce, Number(received.stdout.trim()), limit, keep.agent)));
  /** Its changes since the base, back to the agent's side through a pipe, then applied to its worktree. */
  const bring = (limit = 64 << 20) => {
    const nonce = handedNonce();
    return applyReceived(sh(`${handedSend(theirs, base, keep.task)} | ${handedReceive("task-x", nonce, limit, keep.agent)}`), nonce, limit);
  };
  /** A patch of the task's own making, received and applied on the agent's side. */
  const apply = (patch: string, limit = 64 << 20) => {
    const nonce = handedNonce();
    return applyReceived(sh(handedReceive("task-x", nonce, limit, keep.agent), patch), nonce, limit);
  };
  /** The agent's side's scratch files left in its keep (none, once each script has ended). */
  const left = () => (existsSync(keep.agent) ? readdirSync(keep.agent) : []);
  /** The patch its clone sends back, as git diff writes it there (handedSend), on stdout. */
  const send = () => sh(handedSend(theirs, base, keep.task));
  return { agent, task, repo, root, theirs, base, git, give, bring, apply, send, keep, left };
}

describe("another node's task's clone of its own", () => {
  test("is the task's worktree as it stands, its history with it, HEAD where the work began, its commits by its agent's name", () => {
    const s = setUp();
    // (Its changes so far, as a task taken up again has them.)
    writeFileSync(join(s.root, "app.txt"), "one, and some of the work\n");
    writeFileSync(join(s.root, "new.txt"), "a file of the work's\n");
    const given = s.give();
    expect([given.status, given.stderr]).toEqual([0, ""]);
    expect(spawnSync("git", ["-C", s.theirs, "rev-parse", "HEAD"], { env, encoding: "utf8" }).stdout.trim()).toBe(s.base);
    expect(spawnSync("git", ["-C", s.theirs, "log", "--oneline"], { env, encoding: "utf8" }).stdout.trim().split("\n")).toHaveLength(2);
    expect(readFileSync(join(s.theirs, "app.txt"), "utf8")).toBe("one, and some of the work\n");
    expect(readFileSync(join(s.theirs, "new.txt"), "utf8")).toBe("a file of the work's\n");
    expect(spawnSync("git", ["-C", s.theirs, "config", "user.email"], { env, encoding: "utf8" }).stdout.trim()).toBe("ada@agents.invalid");
    // Nothing of the agent's repository is left changed by the giving: no ref of it, no scratch file.
    expect(s.git(s.repo, "for-each-ref", "refs/invincible").stdout).toBe("");
    expect(existsSync(join(s.keep.agent, "task-x.give-index"))).toBe(false);
    expect(existsSync(join(s.keep.task, "given.bundle"))).toBe(false);
  });

  test("its changes come back to the agent's worktree, its files and its index, deletions and binary files among them", () => {
    const s = setUp();
    expect(s.give().status).toBe(0);
    writeFileSync(join(s.theirs, "app.txt"), "two\n");
    rmSync(join(s.theirs, "README.md"));
    mkdirSync(join(s.theirs, "src"));
    writeFileSync(join(s.theirs, "src/new.ts"), "export const x = 1;\n");
    writeFileSync(join(s.theirs, "logo.bin"), Buffer.from([0, 1, 2, 255, 0, 7]));
    // (A commit of its own in its clone: its changes are counted from the base, whatever it committed.)
    spawnSync("git", ["-C", s.theirs, "add", "-A"], { env });
    spawnSync("git", ["-C", s.theirs, "commit", "-q", "-m", "its work"], { env });
    writeFileSync(join(s.theirs, "later.txt"), "after its commit\n");
    const back = s.bring();
    expect([back.status, back.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(s.root, "app.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(s.root, "README.md"))).toBe(false);
    expect(readFileSync(join(s.root, "src/new.ts"), "utf8")).toBe("export const x = 1;\n");
    expect([...readFileSync(join(s.root, "logo.bin"))]).toEqual([0, 1, 2, 255, 0, 7]);
    expect(readFileSync(join(s.root, "later.txt"), "utf8")).toBe("after its commit\n");
    expect(s.git(s.root, "rev-parse", "HEAD").stdout.trim()).toBe(s.base);
    expect(s.git(s.root, "diff", "--cached", "--name-status", s.base).stdout.trim().split("\n").sort()).toEqual(["A\tlater.txt", "A\tlogo.bin", "A\tsrc/new.ts", "D\tREADME.md", "M\tapp.txt"]);
    // Brought back again, as each step is: the worktree is what the clone is now, never the two added up.
    writeFileSync(join(s.theirs, "app.txt"), "three\n");
    rmSync(join(s.theirs, "later.txt"));
    expect(s.bring().status).toBe(0);
    expect(readFileSync(join(s.root, "app.txt"), "utf8")).toBe("three\n");
    expect(existsSync(join(s.root, "later.txt"))).toBe(false);
    expect(s.left()).toEqual([]);
  });

  test("an earlier run's files, untracked in the agent's worktree as its changes' read leaves them, come back as the clone has them: kept, changed or gone", () => {
    const s = setUp();
    // (A task taken up again: its earlier run's files are in its worktree, its index set back to its HEAD by the read of
    // its changes, as changesCommand leaves it. A file git ignores there is none of its changes, and none of its clone's.)
    writeFileSync(join(s.root, "kept.txt"), "kept\n");
    writeFileSync(join(s.root, "changed.txt"), "before\n");
    writeFileSync(join(s.root, "gone.txt"), "to go\n");
    writeFileSync(join(s.repo, ".git/info/exclude"), "*.log\n");
    writeFileSync(join(s.root, "build.log"), "ignored\n");
    expect(s.give().status).toBe(0);
    expect(existsSync(join(s.theirs, "build.log"))).toBe(false);
    writeFileSync(join(s.theirs, "changed.txt"), "after\n");
    rmSync(join(s.theirs, "gone.txt"));
    const back = s.bring();
    expect([back.status, back.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(s.root, "kept.txt"), "utf8")).toBe("kept\n");
    expect(readFileSync(join(s.root, "changed.txt"), "utf8")).toBe("after\n");
    expect(existsSync(join(s.root, "gone.txt"))).toBe(false);
    expect(s.git(s.root, "diff", "--cached", "--name-status", s.base).stdout.trim().split("\n").sort()).toEqual(["A\tchanged.txt", "A\tkept.txt"]);
    // (The worktree is where the work began, then its patch: what the clone never had is gone.)
    expect(existsSync(join(s.root, "build.log"))).toBe(false);
  });

  test("a repository the task makes in its clone comes back as no .git of the agent's: nothing of it is there for the node's git to run", () => {
    const s = setUp();
    expect(s.give().status).toBe(0);
    // A nested repository with a filter of its own (the fifth review's R5-3 B), in the task's clone.
    const nested = join(s.theirs, "vendor/lib");
    mkdirSync(nested, { recursive: true });
    spawnSync("git", ["init", "-q", nested], { env });
    writeFileSync(join(nested, "x.txt"), "x\n");
    spawnSync("git", ["-C", nested, "add", "."], { env });
    spawnSync("git", ["-C", nested, "commit", "-q", "-m", "nested"], { env });
    writeFileSync(join(s.agent, "planted"), "#!/bin/sh\necho ran >> \"$0.ran\"\ncat\n");
    chmodSync(join(s.agent, "planted"), 0o755);
    spawnSync("git", ["-C", nested, "config", "filter.x.clean", join(s.agent, "planted")], { env });
    writeFileSync(join(nested, ".gitattributes"), "* filter=x\n");
    expect(s.bring().status).toBe(0);
    expect(existsSync(join(s.root, "vendor/lib/.git"))).toBe(false);
    // The node's own git in the agent's worktree after it: its status and its changes, as its next step's would be.
    const status = sh(`cd ${JSON.stringify(s.root)} && git status --short --ignore-submodules=dirty && git add -A`);
    expect(status.status).toBe(0);
    expect(existsSync(join(s.agent, "planted.ran"))).toBe(false);
  });
});

describe("what comes back from another node's task", () => {
  test("is refused whole when it reaches outside the worktree, into its .git, or writes through a link it makes", () => {
    const s = setUp();
    const outside = join(s.agent, "outside.txt");
    const patches = {
      "a path up out of the worktree": `diff --git a/../../outside.txt b/../../outside.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../../outside.txt\n@@ -0,0 +1 @@\n+escaped\n`,
      "an absolute path": `diff --git a/${outside} b/${outside}\nnew file mode 100644\n--- /dev/null\n+++ b/${outside}\n@@ -0,0 +1 @@\n+escaped\n`,
      "a .git of its own": `diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/post-checkout\n@@ -0,0 +1 @@\n+#!/bin/sh\n`,
      "a link, then a file written through it": `diff --git a/up b/up\nnew file mode 120000\n--- /dev/null\n+++ b/up\n@@ -0,0 +1 @@\n+${s.agent}\n\\ No newline at end of file\ndiff --git a/up/outside.txt b/up/outside.txt\nnew file mode 100644\n--- /dev/null\n+++ b/up/outside.txt\n@@ -0,0 +1 @@\n+escaped\n`,
    };
    for (const [what, patch] of Object.entries(patches)) {
      const applied = s.apply(patch);
      expect([what, applied.status === 0]).toEqual([what, false]);
      expect([what, existsSync(outside)]).toEqual([what, false]);
    }
    expect(existsSync(join(s.repo, ".git/hooks/post-checkout"))).toBe(false);
    expect(existsSync(join(s.root, "up")) && lstatSync(join(s.root, "up")).isSymbolicLink()).toBe(false);
  });

  test("is applied to the worktree as the work began, nothing an earlier run left in it: no link it hid from git is written through", () => {
    const s = setUp();
    const outside = temp("handed-outside-");
    // (What an earlier run's patch can leave once its changes are read, untracked: a link out of the worktree, with an
    // ignore file of its own that hides both from git.)
    mkdirSync(join(s.root, "sub"));
    writeFileSync(join(s.root, "sub/.gitignore"), "*\n");
    symlinkSync(outside, join(s.root, "sub/out"));
    const through = `diff --git a/sub/out/planted.txt b/sub/out/planted.txt\nnew file mode 100644\n--- /dev/null\n+++ b/sub/out/planted.txt\n@@ -0,0 +1 @@\n+planted\n`;
    const applied = s.apply(through);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    expect(lstatSync(join(s.root, "sub/out")).isDirectory()).toBe(true);
    expect(readFileSync(join(s.root, "sub/out/planted.txt"), "utf8")).toBe("planted\n");
    expect(existsSync(join(s.root, "sub/.gitignore"))).toBe(false);
  });

  test("is refused whole past its limit: in bytes, or as its binary parts say they inflate", () => {
    const s = setUp();
    const big = `diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1 @@\n+${"x".repeat(5000)}\n`;
    const over = s.apply(big, 1024);
    expect([over.status, over.stderr.trim()]).toEqual([1, "its changes come to more than 1024 bytes"]);
    // (A binary part that says it inflates to 2 GiB, in a patch of a few hundred bytes.)
    const bomb = `diff --git a/blob.bin b/blob.bin\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111\nGIT binary patch\nliteral 2147483648\nzcmV?d00001\n\nliteral 0\nHcmV?d00001\n\n`;
    const inflating = s.apply(bomb, 64 << 20);
    expect([inflating.status, inflating.stderr.trim()]).toEqual([1, `its changes inflate to more than ${64 << 20} bytes`]);
    expect(existsSync(join(s.root, "big.txt")) || existsSync(join(s.root, "blob.bin"))).toBe(false);
  });

  test("is applied only as all of what the node carried: one cut short at a file's end is refused whole, and dropped", () => {
    const s = setUp();
    const one = `diff --git a/one.txt b/one.txt\nnew file mode 100644\n--- /dev/null\n+++ b/one.txt\n@@ -0,0 +1 @@\n+one\n`;
    const two = `diff --git a/two.txt b/two.txt\nnew file mode 100644\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1 @@\n+two\n`;
    const [part, whole] = [Buffer.byteLength(one), Buffer.byteLength(one + two)];
    // (Its sender ended by its deadline, or the pipe cut at its cap, after the first file's part: what came reads as a
    // patch of its own, and is kept as it came.)
    const nonce = handedNonce();
    const received = sh(handedReceive("task-x", nonce, 64 << 20, s.keep.agent), one);
    expect([received.status, received.stdout.trim()]).toEqual([0, String(part)]);
    const applied = sh(handedApply(s.root, s.base, "task-x", nonce, whole, 64 << 20, s.keep.agent));
    expect([applied.status, applied.stderr.trim()]).toEqual([1, `its changes came cut short: ${part} of ${whole} bytes`]);
    expect(existsSync(join(s.root, "one.txt"))).toBe(false);
    expect(s.left()).toEqual([]);
    // (All of it, as the node carried it, is applied.)
    expect(s.apply(one + two).status).toBe(0);
    expect([readFileSync(join(s.root, "one.txt"), "utf8"), readFileSync(join(s.root, "two.txt"), "utf8")]).toEqual(["one\n", "two\n"]);
    // (And one the node saw cut, never applied: dropped.)
    const cut = handedNonce();
    expect(sh(handedReceive("task-x", cut, 64 << 20, s.keep.agent), one).status).toBe(0);
    expect(s.left()).toEqual([`task-x.${cut}.patch`]);
    expect(sh(handedDrop("task-x", cut, s.keep.agent)).status).toBe(0);
    expect(s.left()).toEqual([]);
  });

  test("is kept by each receive in a file of its own: an apply reads only what its own pipe carried, by its own name", () => {
    const s = setUp();
    const patch = (name: string) => `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${name}\n`;
    const [a, b] = [handedNonce(), handedNonce()];
    // (Two receives of the one task, as a step's and the last one could be: neither takes the other's file.)
    const one = sh(handedReceive("task-x", a, 64 << 20, s.keep.agent), patch("a.txt"));
    const two = sh(handedReceive("task-x", b, 64 << 20, s.keep.agent), patch("b.txt"));
    expect([one.status, two.status]).toEqual([0, 0]);
    expect(s.left().sort()).toEqual([`task-x.${a}.patch`, `task-x.${b}.patch`].sort());
    const applied = sh(handedApply(s.root, s.base, "task-x", a, Number(one.stdout.trim()), 64 << 20, s.keep.agent));
    expect(applied.status).toBe(0);
    expect([existsSync(join(s.root, "a.txt")), existsSync(join(s.root, "b.txt"))]).toEqual([true, false]);
    expect(s.left()).toEqual([`task-x.${b}.patch`]);
    // A name no receive kept is no patch: refused, nothing applied.
    const none = sh(handedApply(s.root, s.base, "task-x", handedNonce(), Number(two.stdout.trim()), 64 << 20, s.keep.agent));
    expect([none.status, none.stderr.trim()]).toEqual([1, `its changes came cut short: 0 of ${Number(two.stdout.trim())} bytes`]);
    // And a name that isn't one is refused before any file is read or written.
    for (const bad of ["../x", "", "A".repeat(32)]) {
      expect(sh(handedReceive("task-x", bad, 64 << 20, s.keep.agent), patch("c.txt")).stderr.trim()).toBe("no such receive");
      expect(sh(handedApply(s.root, s.base, "task-x", bad, 10, 64 << 20, s.keep.agent)).stderr.trim()).toBe("no such receive");
    }
    expect(s.left()).toEqual([`task-x.${b}.patch`]);
  });

  test("prints the tree it made the worktree, which is the tree the agent's side then reads there, until the worktree changes", () => {
    const s = setUp();
    expect(s.give().status).toBe(0);
    writeFileSync(join(s.theirs, "app.txt"), "two\n");
    writeFileSync(join(s.theirs, "logo.bin"), Buffer.from([0, 1, 2, 255]));
    const back = s.bring();
    expect(back.status).toBe(0);
    const [size, tree] = back.stdout.trim().split(" ");
    expect(Number(size)).toBeGreaterThan(0);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    // (As its index has it, and as its files are read: what the changes' read would ship.)
    expect(s.git(s.root, "write-tree").stdout.trim()).toBe(tree!);
    const read = sh(handedTree(s.root, s.base, "task-x", s.keep.agent));
    expect([read.status, read.stdout.trim()]).toEqual([0, tree!]);
    writeFileSync(join(s.root, "app.txt"), "changed on the agent's side\n");
    expect(sh(handedTree(s.root, s.base, "task-x", s.keep.agent)).stdout.trim()).not.toBe(tree);
    expect(s.left()).toEqual([]);
  });
});

/*
 * The seventh fabric review's R7-3, at the scripts: a step's apply and the last bring-back on the one worktree at once.
 * The review's PoC forced it with a `git` that holds the step's `git apply` (its parse, which takes seconds for a large
 * patch) while the last bring-back's apply made `l` a link to the agent's HOME and the changes' read left that link in
 * the worktree, out of the index: the step's `git apply --index` then wrote `l/.bash_profile` into HOME. The runtime now
 * runs them one at a time (team-runtime.test.ts); here, with the same order forced, the step's apply reads only its own
 * patch, into an index of its own, and the tree it makes replaces the link with a folder, writing nothing through it.
 */
describe("a step's apply beside the last bring-back's (R7-3)", () => {
  test("the link the other left where the step's patch lands is replaced by a folder: nothing is written through it", async () => {
    const s = setUp();
    // (A fetched repository has an origin, which the changes' read records.)
    s.git(s.repo, "remote", "add", "origin", "https://example.test/you/project");
    const home = join(s.agent, "home");
    mkdirSync(home);
    const PROFILE = "echo 'a handed task ran this as the agent' >&2\n";
    const underL = `diff --git a/l/.bash_profile b/l/.bash_profile\nnew file mode 100644\n--- /dev/null\n+++ b/l/.bash_profile\n@@ -0,0 +1 @@\n+${PROFILE}`;
    const linkL = `diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+${home}\n\\ No newline at end of file\n`;
    // A `git` on the step's PATH that holds its `git apply` (as a large patch's parse would) until it is told to go.
    const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const wrap = temp("handed-wrap-");
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    writeFileSync(join(wrap, "git"), `#!/bin/bash\nfor a in "$@"; do if [ "$a" = apply ]; then touch ${q(join(wrap, "started"))}; while [ ! -f ${q(join(wrap, "go"))} ]; do sleep 0.02; done; break; fi; done\nexec ${q(real)} "$@"\n`);
    chmodSync(join(wrap, "git"), 0o755);
    const limit = 64 << 20;
    // 1. The step's patch comes, and its apply begins.
    const stepNonce = handedNonce();
    const step = sh(handedReceive("task-x", stepNonce, limit, s.keep.agent), underL);
    expect(step.status).toBe(0);
    const applyStep = Bun.spawn(["bash", "-c", handedApply(s.root, s.base, "task-x", stepNonce, Number(step.stdout.trim()), limit, s.keep.agent)], { env: { PATH: `${wrap}:${env.PATH}`, HOME: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 500 && !existsSync(join(wrap, "started")); i++) await Bun.sleep(20);
    expect(existsSync(join(wrap, "started"))).toBe(true);
    // 2. Meanwhile the last bring-back: its own receive and apply make `l` a link to the agent's HOME, and the changes'
    //    read leaves it in the worktree, out of the index, just where the step's patch lands.
    const lastNonce = handedNonce();
    const last = sh(handedReceive("task-x", lastNonce, limit, s.keep.agent), linkL);
    expect(sh(handedApply(s.root, s.base, "task-x", lastNonce, Number(last.stdout.trim()), limit, s.keep.agent)).status).toBe(0);
    const read = sh(`cd ${q(s.root)} && ${changesCommand(join(temp("handed-out-"), "out"), s.base)}`);
    expect([read.status, read.stderr]).toEqual([0, ""]);
    expect(lstatSync(join(s.root, "l")).isSymbolicLink()).toBe(true);
    expect(s.git(s.root, "ls-files", "l").stdout).toBe("");
    // 3. The step's apply goes on: harmless. Nothing in HOME; the link is a folder in the worktree, holding the step's file.
    writeFileSync(join(wrap, "go"), "");
    const [code, said] = [await applyStep.exited, await new Response(applyStep.stderr).text()];
    expect([code, said]).toEqual([0, ""]);
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
    expect(lstatSync(join(s.root, "l")).isDirectory()).toBe(true);
    expect(readFileSync(join(s.root, "l/.bash_profile"), "utf8")).toBe(PROFILE);
  });

  test("a link inside an untracked nested repository in the worktree is never written through (I-a)", () => {
    const s = setUp();
    const outside = temp("handed-outside-");
    // (Nothing a task sends can make this: a patch writes no .git. Only what writes in the agent's store already can.)
    const nested = join(s.root, "vendor/lib");
    mkdirSync(nested, { recursive: true });
    spawnSync("git", ["init", "-q", nested], { env });
    symlinkSync(outside, join(nested, "out"));
    const through = `diff --git a/vendor/lib/out/planted.txt b/vendor/lib/out/planted.txt\nnew file mode 100644\n--- /dev/null\n+++ b/vendor/lib/out/planted.txt\n@@ -0,0 +1 @@\n+planted\n`;
    const applied = s.apply(through);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    // (The link is a folder of the worktree's now, holding the patch's file.)
    expect(lstatSync(join(nested, "out")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(nested, "out/planted.txt"), "utf8")).toBe("planted\n");
  });
});

describe("what a run of another node's task cut off leaves on its agent's side (I-d)", () => {
  test("is swept as the task starts again: its own receives' patches, its indexes and its give's ref, never another task's", () => {
    const s = setUp();
    mkdirSync(s.keep.agent, { recursive: true });
    const [a, b] = [handedNonce(), handedNonce()];
    // (What a SIGKILL at a deadline skips the removal of: each script's own end, and the give's finally.)
    const mine = ["task-x.patch", `task-x.${a}.patch`, `task-x.${a}.apply-index`, `task-x.${b}.patch`, "task-x.give-index", "task-x.tree-index"];
    const theirs = [`task-xy.${a}.patch`, "task-xy.give-index", "task-y.patch"];
    for (const name of [...mine, ...theirs]) writeFileSync(join(s.keep.agent, name), "left\n");
    s.git(s.root, "update-ref", "refs/invincible/give/task-x", s.base);
    s.git(s.root, "update-ref", "refs/invincible/give/task-xy", s.base);
    const swept = sh(handedSweep(s.root, "task-x", s.keep.agent));
    expect([swept.status, swept.stderr]).toEqual([0, ""]);
    expect(s.left().sort()).toEqual(theirs.sort());
    expect(s.git(s.repo, "for-each-ref", "--format=%(refname)", "refs/invincible").stdout.trim()).toBe("refs/invincible/give/task-xy");
    // (And again, with nothing left: nothing to do.)
    expect(sh(handedSweep(s.root, "task-x", s.keep.agent)).status).toBe(0);
  });
});

/*
 * A binary part of what comes back (the seventh fabric review's R7-1 and R7-2). git apply takes a binary part's content
 * from the agent's object store by the id its index line names whenever the store holds it (R7-1), and reads its sizes
 * as strtoul does (R7-2). So a part is applied only once its own data makes the id it names, and what it inflates to, its
 * sizes as git writes them, is held to the limit: anything else is refused before git reads the patch, nothing written.
 */

// ---- git's binary patch format, as diff.c writes it (the seventh review's helpers) ----
const B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
/** One line of a binary part's data: its length byte, then `chunk` (at most 52 bytes) in base85. */
const line85 = (chunk: Buffer) => {
  let out = chunk.length <= 26 ? String.fromCharCode(64 + chunk.length) : String.fromCharCode(96 + chunk.length - 26);
  for (let i = 0; i < chunk.length; i += 4) {
    let acc = 0;
    for (let j = 0; j < 4; j++) acc = acc * 256 + (chunk[i + j] ?? 0);
    let five = "";
    for (let k = 0; k < 5; k++) {
      five = B85[acc % 85] + five;
      acc = Math.floor(acc / 85);
    }
    out += five;
  }
  return out;
};
/** `data` deflated, as a binary part's data lines. */
const deflated85 = (data: Buffer) => {
  const z = deflateSync(data, { level: 9 });
  const lines: string[] = [];
  for (let i = 0; i < z.length; i += 52) lines.push(line85(z.subarray(i, i + 52)));
  return lines.join("\n");
};
const blobId = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const Z = "0".repeat(40);
/** A new file as `git diff --binary` writes it: one literal part, `literal <size>`, and its reverse, `literal 0`. */
const literalPatch = (path: string, data: Buffer) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex ${Z}..${blobId(data)}\nGIT binary patch\nliteral ${data.length}\n${deflated85(data)}\n\nliteral 0\nHcmV?d00001\n\n`;
/** A new file whose content is the object `id`, wherever git finds it: a binary part with no data of its own (R7-1). */
const fromStore = (path: string, id: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex ${Z}..${id}\nGIT binary patch\nliteral 0\nHcmV?d00001\n\nliteral 0\nHcmV?d00001\n\n`;
/** A file changed by one delta part, from the blob `from` to `to`. */
const deltaPatch = (path: string, from: string, to: string, delta: Buffer) => `diff --git a/${path} b/${path}\nindex ${from}..${to} 100644\nGIT binary patch\ndelta ${delta.length}\n${deflated85(delta)}\n\n`;
/** `n` bytes that don't compress, the same each run. */
const noise = (n: number, seed: string) => Buffer.concat(Array.from({ length: Math.ceil(n / 32) }, (_, i) => createHash("sha256").update(`${seed} ${i}`).digest())).subarray(0, n);

const SECRET = "PRIVATE: a file of a branch the task is never given (not a real secret)\n";
const SPELLED = "its changes have a binary part not written as git writes one";
const CARRIED = "its changes name content their binary parts don't carry";
const GIVEN = "its changes make a binary part from content the task wasn't given";
const NO_IDS = "its changes have a binary part without full ids";
const COPIED = "its changes copy or rename a file, which its clone's send never does";
const over = (limit: number) => `its changes inflate to more than ${limit} bytes`;

/** `SECRET` on a branch of origin's that the agent's repository holds (REPO_TASK_START fetches them all) and the task is never given; its blob's id. */
function secretBranch(repo: string): string {
  git(repo, "checkout", "-q", "-b", "release");
  writeFileSync(join(repo, "secret.txt"), SECRET);
  git(repo, "add", "secret.txt");
  git(repo, "commit", "-q", "-m", "the release's own file");
  git(repo, "update-ref", "refs/remotes/origin/release", "HEAD");
  git(repo, "checkout", "-q", "-");
  git(repo, "branch", "-q", "-D", "release");
  return git(repo, "rev-parse", "refs/remotes/origin/release:secret.txt").stdout.trim();
}
/** A file of the base, committed (a `prepare` for setUp). */
const committed = (path: string, data: Buffer) => (repo: string) => {
  writeFileSync(join(repo, path), data);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", `add ${path}`);
};

describe("a binary part of what comes back (the seventh review's R7-1 and R7-2)", () => {
  test("R7-1 A: one naming an object of the agent's store, and carrying none of it, is refused whole in each of git's binary forms: nothing is written", () => {
    let secret = "";
    const s = setUp((repo) => {
      secret = secretBranch(repo);
    });
    expect(s.give().status).toBe(0);
    // (The task's clone holds nothing of that branch: all it can do is name the object.)
    expect(git(s.theirs, "cat-file", "-e", secret).status).not.toBe(0);
    const forms = {
      "a part whose data is empty": fromStore("leak.txt", secret),
      "a part with no data, as git diff writes one without --binary": `diff --git a/leak.txt b/leak.txt\nnew file mode 100644\nindex ${Z}..${secret}\nBinary files /dev/null and b/leak.txt differ\n`,
      "the same, as other diffs write it": `diff --git a/leak.txt b/leak.txt\nnew file mode 100644\nindex ${Z}..${secret}\nFiles /dev/null and b/leak.txt differ\n`,
    };
    for (const [what, patch] of Object.entries(forms)) {
      expect(patch).not.toContain("PRIVATE");
      const applied = s.apply(patch);
      expect([what, applied.status, applied.stderr.trim()]).toEqual([what, 1, CARRIED]);
      expect([what, existsSync(join(s.root, "leak.txt"))]).toEqual([what, false]);
    }
    // (Nothing of the worktree is touched, and the patch is dropped.)
    expect(git(s.root, "status", "--porcelain").stdout).toBe("");
    expect(existsSync(join(s.keep.agent, "task-x.patch"))).toBe(false);
  });

  test("R7-1 B: from a commit id its own history names, nothing of the store is walked: not the commit, its tree, or a file of it", () => {
    let fix = "";
    const s = setUp((repo) => {
      // A release branch with a file of its own and a fix on it, the fix taken onto the work's branch as projects do.
      git(repo, "checkout", "-q", "-b", "release");
      writeFileSync(join(repo, "secret.txt"), SECRET);
      git(repo, "add", "secret.txt");
      git(repo, "commit", "-q", "-m", "the release's own file");
      writeFileSync(join(repo, "fix.txt"), "a fix\n");
      git(repo, "add", "fix.txt");
      git(repo, "commit", "-q", "-m", "a fix");
      fix = git(repo, "rev-parse", "HEAD").stdout.trim();
      git(repo, "update-ref", "refs/remotes/origin/release", "HEAD");
      git(repo, "checkout", "-q", "-");
      git(repo, "branch", "-q", "-D", "release");
      expect(git(repo, "cherry-pick", "-x", fix).status).toBe(0);
    });
    expect(s.give().status).toBe(0);
    const named = /cherry picked from commit ([0-9a-f]{40})/.exec(git(s.theirs, "log", "--format=%B").stdout)?.[1];
    expect(named).toBe(fix);
    expect(git(s.theirs, "cat-file", "-e", fix).status).not.toBe(0);
    // Each step of the walk, its id read here from the agent's own repository: none of them comes back.
    const steps = { "the commit": fix, "its tree": git(s.repo, "rev-parse", `${fix}^{tree}`).stdout.trim(), "a file of it": git(s.repo, "rev-parse", `${fix}:secret.txt`).stdout.trim() };
    for (const [what, id] of Object.entries(steps)) {
      expect(id).toMatch(/^[0-9a-f]{40}$/);
      const applied = s.apply(fromStore("r1", id));
      expect([what, applied.status, applied.stderr.trim()]).toEqual([what, 1, CARRIED]);
      expect([what, existsSync(join(s.root, "r1"))]).toEqual([what, false]);
    }
  });

  test("R7-1 C: whether the agent's store holds an object is no longer the task's to learn: it is refused the same either way", () => {
    let secret = "";
    const s = setUp((repo) => {
      secret = secretBranch(repo);
    });
    const absent = "1".repeat(40);
    expect(git(s.repo, "cat-file", "-e", absent).status).not.toBe(0);
    expect(git(s.repo, "cat-file", "-e", secret).status).toBe(0);
    for (const form of [fromStore, (path: string, id: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex ${Z}..${id}\nBinary files /dev/null and b/${path} differ\n`]) {
      const notHeld = s.apply(form("probe", absent));
      const held = s.apply(form("probe", secret));
      expect([held.status, held.stdout, held.stderr]).toEqual([notHeld.status, notHeld.stdout, notHeld.stderr]);
      expect([held.status, held.stderr.trim()]).toEqual([1, CARRIED]);
      expect(existsSync(join(s.root, "probe"))).toBe(false);
    }
  });

  test("R7-2 A: a binary part's size is read only as git writes it: the honest one is held to the limit, and every other spelling is refused", () => {
    const LIMIT = 1 << 20;
    const s = setUp();
    const honest = literalPatch("big.bin", Buffer.alloc(2 << 20));
    expect(honest.length).toBeLessThan(8192);
    const refused = s.apply(honest, LIMIT);
    expect([refused.status, refused.stderr.trim()]).toEqual([1, over(LIMIT)]);
    // (Each of them strtoul reads as 2097152.)
    for (const line of ["literal +2097152", "literal  2097152", "literal 2097152\r", "literal 2097152 bytes"]) {
      const patch = honest.replace("\nliteral 2097152\n", `\n${line}\n`);
      expect(patch).not.toBe(honest);
      const applied = s.apply(patch, LIMIT);
      expect([line, applied.status, applied.stderr.trim()]).toEqual([line, 1, SPELLED]);
      expect([line, existsSync(join(s.root, "big.bin"))]).toEqual([line, false]);
    }
  });

  test("R7-2 B: a delta part is held to what it makes, never to its own size", () => {
    const LIMIT = 1 << 20;
    // (A file of the base, which the task has in its clone: 64 KiB.)
    const pre = Buffer.concat(Array.from({ length: 2048 }, () => createHash("sha256").update("r7").digest()));
    const s = setUp(committed("pre.bin", pre));
    // 256 copies of the whole file, each one byte of delta (copy 0x10000 from offset 0): 16 MiB from a delta of 260 bytes.
    const copies = 256;
    const delta = Buffer.from([...varint(pre.length), ...varint(pre.length * copies), ...Array(copies).fill(0x80)]);
    const made = Buffer.concat(Array.from({ length: copies }, () => pre));
    const patch = deltaPatch("pre.bin", blobId(pre), blobId(made), delta);
    expect(patch.length).toBeLessThan(1024);
    const applied = s.apply(patch, LIMIT);
    expect([applied.status, applied.stderr.trim()]).toEqual([1, over(LIMIT)]);
    expect(blobId(readFileSync(join(s.root, "pre.bin")))).toBe(blobId(pre));
  });

  test("R7-2 C: parts whose content would come from the store are refused, however many of them name it", () => {
    const pre = Buffer.concat(Array.from({ length: 2048 }, () => createHash("sha256").update("r7c").digest()));
    const s = setUp(committed("pre.bin", pre));
    const patch = Array.from({ length: 64 }, (_, i) => fromStore(`copies/${i}.bin`, blobId(pre))).join("");
    const applied = s.apply(patch, 1 << 20);
    expect([applied.status, applied.stderr.trim()]).toEqual([1, CARRIED]);
    expect(existsSync(join(s.root, "copies"))).toBe(false);
  });

  test("R7-2 D: a copy or a rename of a file, which its clone's send never makes, is refused whole: 64 copies of one would write it 64 times", () => {
    const LIMIT = 64 << 10;
    // (A file of the base of half the limit: a copy of it carries none of it, and 64 copies write 32 times the limit.)
    const s = setUp(committed("pre.txt", Buffer.from(`${"x".repeat(31)}\n`.repeat(1024))));
    const copy = (to: string) => `diff --git a/pre.txt b/${to}\nsimilarity index 100%\ncopy from pre.txt\ncopy to ${to}\n`;
    const copies = Array.from({ length: 64 }, (_, i) => copy(`copies/${i}.txt`)).join("");
    expect(copies.length).toBeLessThan(8 << 10);
    const applied = s.apply(copies, LIMIT);
    expect([applied.status, applied.stderr.trim()]).toEqual([1, COPIED]);
    expect(existsSync(join(s.root, "copies"))).toBe(false);
    // A rename, which takes its content from the base too and carries none, is refused the same.
    const renamed = s.apply(`diff --git a/pre.txt b/moved.txt\nsimilarity index 100%\nrename from pre.txt\nrename to moved.txt\n`, LIMIT);
    expect([renamed.status, renamed.stderr.trim()]).toEqual([1, COPIED]);
    expect([existsSync(join(s.root, "moved.txt")), existsSync(join(s.root, "pre.txt"))]).toEqual([false, true]);
  });

  test("R8-1 and R9-1: a copy or a rename spelled otherwise is refused too: git's older rename old/new, two names in a diff --git, a --- or +++ that names another file, a /dev/null that is a file to git", () => {
    // (The eighth fabric review's R8-1: each took the content of a file of the base and carried none of it; 64 of them in
    // 6 KB wrote 5.6 MB at a 1 MiB limit.)
    const LIMIT = 64 << 10;
    const x = "x".repeat(31);
    const s = setUp(committed("pre.txt", Buffer.from(`${x}\n`.repeat(1024))));
    const forms: Record<string, string> = {
      "rename old/new": Array.from({ length: 64 }, (_, i) => `diff --git a/pre.txt b/r${i}.txt\nsimilarity index 100%\nrename old pre.txt\nrename new r${i}.txt\n`).join(""),
      // (git renames by these headers, under a diff --git that names one file, too.)
      "rename old/new, one name in its diff --git": Array.from({ length: 64 }, (_, i) => `diff --git a/pre.txt b/pre.txt\nsimilarity index 100%\nrename old pre.txt\nrename new h${i}.txt\n`).join(""),
      "two names in a diff --git, its --- and +++ too": Array.from({ length: 64 }, (_, i) => `diff --git a/pre.txt b/m${i}.txt\n--- a/pre.txt\n+++ b/m${i}.txt\n@@ -1,2 +1,2 @@\n-${x}\n+copy ${i}\n ${x}\n`).join(""),
      "a +++ that names another file": `diff --git a/pre.txt b/pre.txt\n--- a/pre.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-${x}\n+moved\n ${x}\n`,
      "a --- that names another file": `diff --git a/pre.txt b/pre.txt\n--- a/other.txt\n+++ b/pre.txt\n@@ -1,2 +1,2 @@\n-${x}\n+moved\n ${x}\n`,
      "two names in a diff --git alone": `diff --git a/pre.txt b/e.txt\n`,
      // (The ninth review's R9-1: a /dev/null with no `new file mode` or `deleted file mode` before it is a file to git,
      // dev/null. One section renames the base's file there and each after it copies it: 64 in 6 KB wrote 5.6 MB.)
      "+++ /dev/null with no deleted file mode, then --- /dev/null with no new file mode": `diff --git a/pre.txt b/pre.txt\n--- a/pre.txt\n+++ /dev/null\n@@ -1,2 +1,2 @@\n-${x}\n+first!\n ${x}\n${Array.from({ length: 64 }, (_, i) => `diff --git a/m${i}.txt b/m${i}.txt\n--- /dev/null\n+++ b/m${i}.txt\n@@ -1,2 +1,2 @@\n-first!\n+copy ${i}\n ${x}\n`).join("")}`,
      "the same with modes alone and no hunk": `diff --git a/pre.txt b/pre.txt\nold mode 100644\nnew mode 100755\n--- a/pre.txt\n+++ /dev/null\n${Array.from({ length: 64 }, (_, i) => `diff --git a/m${i}.txt b/m${i}.txt\nold mode 100755\nnew mode 100644\n--- /dev/null\n+++ b/m${i}.txt\n`).join("")}`,
    };
    for (const [what, patch] of Object.entries(forms)) {
      // (Each a few KiB at most: 64 copies of a 32 KiB file of the base would write 2 MiB from it.)
      expect([what, patch.length < 12 << 10]).toEqual([what, true]);
      const applied = s.apply(patch, LIMIT);
      expect([what, applied.status, applied.stderr.trim()]).toEqual([what, 1, COPIED]);
    }
    // Nothing of any of them reached the worktree: no file it named, and the base's own as it was.
    expect(readdirSync(s.root).filter((name) => name !== ".git").sort()).toEqual(["README.md", "app.txt", "pre.txt"]);
    expect(readFileSync(join(s.root, "pre.txt"), "utf8")).toBe(`${x}\n`.repeat(1024));
    // What the clone's send makes still comes back, quoted names and names with spaces among it: one name twice, always.
    expect(s.give().status).toBe(0);
    writeFileSync(join(s.theirs, "with space.txt"), "a name with a space\n");
    writeFileSync(join(s.theirs, "caf\u00e9.txt"), "a name git quotes\n");
    rmSync(join(s.theirs, "app.txt"));
    chmodSync(join(s.theirs, "README.md"), 0o755);
    const sent = s.send();
    expect(sent.stdout).toContain('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"');
    const back = s.bring(LIMIT);
    expect([back.status, back.stderr.trim()]).toEqual([0, ""]);
    expect([readFileSync(join(s.root, "with space.txt"), "utf8"), readFileSync(join(s.root, "caf\u00e9.txt"), "utf8"), existsSync(join(s.root, "app.txt"))]).toEqual(["a name with a space\n", "a name git quotes\n", false]);
  });

  test("what git diff writes still comes back: a new binary file, as a literal part", () => {
    const s = setUp();
    expect(s.give().status).toBe(0);
    const data = noise(3000, "a new file");
    writeFileSync(join(s.theirs, "new.bin"), data);
    const sent = s.send();
    expect([sent.status, sent.stderr]).toEqual([0, ""]);
    expect(sent.stdout).toContain(`\nindex ${Z}..${blobId(data)}\nGIT binary patch\nliteral ${data.length}\n`);
    expect(sent.stdout).not.toMatch(/^delta /m);
    const applied = s.apply(sent.stdout);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(blobId(readFileSync(join(s.root, "new.bin")))).toBe(blobId(data));
  });

  test("what git diff writes still comes back: a binary file changed a little, as a delta part", () => {
    const before = noise(8192, "a binary file");
    const s = setUp(committed("data.bin", before));
    expect(s.give().status).toBe(0);
    const after = Buffer.from(before);
    after.write("a small change", 4000);
    writeFileSync(join(s.theirs, "data.bin"), after);
    const sent = s.send();
    expect([sent.status, sent.stderr]).toEqual([0, ""]);
    expect(sent.stdout).toContain(`\nindex ${blobId(before)}..${blobId(after)} 100644\nGIT binary patch\ndelta `);
    expect(sent.stdout).toMatch(/^delta [1-9][0-9]*$/m);
    const applied = s.apply(sent.stdout);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(blobId(readFileSync(join(s.root, "data.bin")))).toBe(blobId(after));
  });

  test("what git diff writes still comes back: a binary file deleted", () => {
    const gone = noise(5000, "a file to go");
    const s = setUp(committed("old.bin", gone));
    expect(s.give().status).toBe(0);
    rmSync(join(s.theirs, "old.bin"));
    const sent = s.send();
    expect([sent.status, sent.stderr]).toEqual([0, ""]);
    expect(sent.stdout).toContain(`\ndeleted file mode 100644\nindex ${blobId(gone)}..${Z}\nGIT binary patch\nliteral 0\n`);
    const applied = s.apply(sent.stdout);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(existsSync(join(s.root, "old.bin"))).toBe(false);
    expect(s.git(s.root, "diff", "--cached", "--name-status", s.base).stdout.trim()).toBe("D\told.bin");
  });

  test("what git diff writes still comes back: text and binary parts in one patch", () => {
    const changed = noise(8192, "changed");
    const deleted = noise(5000, "deleted");
    const s = setUp((repo) => {
      committed("data.bin", changed)(repo);
      committed("old.bin", deleted)(repo);
    });
    expect(s.give().status).toBe(0);
    const after = Buffer.from(changed);
    after.write("a small change", 100);
    const added = noise(2000, "added");
    // (A line of text longer than any of a binary part's, as a minified file's is: the check reads only its start.)
    const notes = `${"a text file of the work's, all on one line; ".repeat(2500)}\n`;
    writeFileSync(join(s.theirs, "app.txt"), "two\n");
    writeFileSync(join(s.theirs, "notes.txt"), notes);
    writeFileSync(join(s.theirs, "data.bin"), after);
    writeFileSync(join(s.theirs, "new.bin"), added);
    rmSync(join(s.theirs, "old.bin"));
    const sent = s.send();
    expect([sent.status, sent.stderr]).toEqual([0, ""]);
    expect(sent.stdout.match(/^GIT binary patch$/gm)).toHaveLength(3);
    expect(sent.stdout.match(/^@@ /gm)).toHaveLength(2);
    expect(sent.stdout).toMatch(/^delta [1-9][0-9]*$/m);
    expect(Math.max(...sent.stdout.split("\n").map((line) => line.length))).toBeGreaterThan(1 << 16);
    const applied = s.apply(sent.stdout);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(s.root, "app.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(s.root, "notes.txt"), "utf8")).toBe(notes);
    expect(blobId(readFileSync(join(s.root, "data.bin")))).toBe(blobId(after));
    expect(blobId(readFileSync(join(s.root, "new.bin")))).toBe(blobId(added));
    expect(existsSync(join(s.root, "old.bin"))).toBe(false);
  });

  test("a binary part git would find corrupt is refused before git reads it: base85 it can't decode, a length byte its line can't have, data that inflates to more or fewer bytes than it says", () => {
    const s = setUp();
    const data = noise(300, "corrupt");
    const good = literalPatch("edge.bin", data);
    const lines = good.split("\n");
    const at = lines.indexOf("literal 300") + 1;
    const first = lines[at] ?? "";
    expect(first).toMatch(/^z.{65}$/);
    const withLine = (line: string) => [...lines.slice(0, at), line, ...lines.slice(at + 1)].join("\n");
    const cases = {
      "a character outside base85": withLine(`${first.slice(0, 10)}.${first.slice(11)}`),
      "a group past 32 bits": withLine(`${first.slice(0, 1)}~~~~~${first.slice(6)}`),
      "a length byte that is no length": withLine(`0${first.slice(1)}`),
      "a length byte too small for its line": withLine(`A${first.slice(1)}`),
      "a line a character short": withLine(first.slice(0, -1)),
      "data that inflates to more than it says": good.replace("\nliteral 300\n", "\nliteral 299\n"),
      "data that inflates to fewer bytes than it says": good.replace("\nliteral 300\n", "\nliteral 301\n"),
    };
    for (const [what, patch] of Object.entries(cases)) {
      expect([what, patch === good]).toEqual([what, false]);
      const applied = s.apply(patch);
      expect([what, applied.status, applied.stderr.trim()]).toEqual([what, 1, SPELLED]);
      expect([what, existsSync(join(s.root, "edge.bin"))]).toEqual([what, false]);
    }
    const applied = s.apply(good);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(blobId(readFileSync(join(s.root, "edge.bin")))).toBe(blobId(data));
  });

  test("a binary part is refused unless git would read it as it says: a size line outside a part, a part without one or cut short, ids that aren't full", () => {
    const s = setUp();
    const data = Buffer.from("a binary file's bytes\0\n");
    const id = blobId(data);
    const good = literalPatch("x.bin", data);
    const text = "diff --git a/t.txt b/t.txt\nnew file mode 100644\n--- /dev/null\n+++ b/t.txt\n@@ -0,0 +1 @@\n+t\n";
    const cases: [string, string, string][] = [
      ["a size line between parts", `${text}delta 5\n${good}`, SPELLED],
      ["a size line longer than any of a binary part's", `${text}delta 5${" ".repeat(1 << 17)}\n${good}`, SPELLED],
      ["a third hunk after a part's two", `${good}literal 0\nHcmV?d00001\n\n`, SPELLED],
      ["a part with no size line", good.replace(`\nliteral ${data.length}\n`, "\n"), SPELLED],
      ["a part that ends before its blank line", good.slice(0, -1), SPELLED],
      ["an abbreviated id", good.replace(`..${id}`, `..${id.slice(0, 12)}`), NO_IDS],
      ["an id in capitals", good.replace(`..${id}`, `..${id.toUpperCase()}`), NO_IDS],
      ["no index line at all", good.replace(/^index .*\n/m, ""), NO_IDS],
    ];
    for (const [what, patch, why] of cases) {
      expect([what, patch === good]).toEqual([what, false]);
      const applied = s.apply(patch);
      expect([what, applied.status, applied.stderr.trim()]).toEqual([what, 1, why]);
      expect([what, existsSync(join(s.root, "x.bin")) || existsSync(join(s.root, "t.txt"))]).toEqual([what, false]);
    }
    const applied = s.apply(good);
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(blobId(readFileSync(join(s.root, "x.bin")))).toBe(id);
  });

  test("a delta part is refused unless it applies to a file of the base as patch-delta.c applies one, and one from content the task wasn't given is refused unread", () => {
    let secret = "";
    const pre = noise(4096, "a source");
    const s = setUp((repo) => {
      committed("pre.bin", pre)(repo);
      secret = secretBranch(repo);
    });
    const made = Buffer.from("made by a delta\n");
    /** A delta from a source of `source` bytes that inserts `made`, whole. */
    const inserting = (source: number) => Buffer.from([...varint(source), ...varint(made.length), made.length, ...made]);
    const bad = {
      "a source of another size than the file's": inserting(pre.length + 1),
      "a copy past its source's end": Buffer.from([...varint(pre.length), ...varint(16), 0x80 | 0x01 | 0x02 | 0x10, 0xf8, 0x0f, 16]),
      "fewer bytes made than it says": Buffer.from([...varint(pre.length), ...varint(made.length + 1), made.length, ...made]),
      "an insert past its delta's end": Buffer.from([...varint(pre.length), ...varint(made.length + 1), made.length + 1, ...made]),
      "an opcode of 0": Buffer.from([...varint(pre.length), ...varint(made.length), 0, made.length, ...made]),
    };
    for (const [what, delta] of Object.entries(bad)) {
      const applied = s.apply(deltaPatch("pre.bin", blobId(pre), blobId(made), delta));
      expect([what, applied.status, applied.stderr.trim()]).toEqual([what, 1, SPELLED]);
      expect([what, blobId(readFileSync(join(s.root, "pre.bin")))]).toEqual([what, blobId(pre)]);
    }
    // A delta from content the task wasn't given, whether the store holds it or not: refused the same, and never read.
    // (Every git the apply runs is logged here by its arguments.)
    const shim = temp("handed-shim-");
    const log = join(shim, "calls.log");
    writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${q(log)}\nexec ${q(sh("command -v git").stdout.trim())} "$@"\n`);
    chmodSync(join(shim, "git"), 0o755);
    const watched = (patch: string) => {
      const nonce = handedNonce();
      const received = sh(handedReceive("task-x", nonce, 64 << 20, s.keep.agent), patch);
      return sh(`PATH=${q(shim)}:"$PATH" ${handedApply(s.root, s.base, "task-x", nonce, Number(received.stdout.trim()), 64 << 20, s.keep.agent)}`);
    };
    const absent = "1".repeat(40);
    expect(git(s.repo, "cat-file", "-e", absent).status).not.toBe(0);
    const fromSecret = watched(deltaPatch("pre.bin", secret, blobId(made), inserting(SECRET.length)));
    const fromAbsent = watched(deltaPatch("pre.bin", absent, blobId(made), inserting(SECRET.length)));
    expect([fromSecret.status, fromSecret.stderr.trim()]).toEqual([1, GIVEN]);
    expect([fromAbsent.status, fromAbsent.stdout, fromAbsent.stderr]).toEqual([fromSecret.status, fromSecret.stdout, fromSecret.stderr]);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(" ls-tree ");
    expect([calls.includes(secret), calls.includes(absent)]).toEqual([false, false]);
    // (A new file's delta has no file of the base to come from.)
    const fromNothing = s.apply(deltaPatch("new.bin", Z, blobId(made), inserting(0)).replace("\nindex ", "\nnew file mode 100644\nindex ").replace(" 100644\nGIT", "\nGIT"));
    expect([fromNothing.status, fromNothing.stderr.trim()]).toEqual([1, GIVEN]);
    // And the same delta from the file of the base applies.
    const right = s.apply(deltaPatch("pre.bin", blobId(pre), blobId(made), inserting(pre.length)));
    expect([right.status, right.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(s.root, "pre.bin"), "utf8")).toBe(made.toString());
  });

  test("in a repository of sha256 ids, a binary part's ids are 64 hex characters, and its data makes the one it names", () => {
    const agent = temp("handed-agent-");
    const repo = join(agent, "repo");
    expect(spawnSync("git", ["init", "-q", "--object-format=sha256", repo], { env }).status).toBe(0);
    writeFileSync(join(repo, "README.md"), "the agent's repository\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const root = join(agent, "tasks", "task-x");
    git(repo, "worktree", "add", "-q", "--detach", root, base);
    const keep = join(agent, ".agent/handed");
    const apply = (patch: string) => {
      const nonce = handedNonce();
      const received = sh(handedReceive("task-x", nonce, 64 << 20, keep), patch);
      return sh(handedApply(root, base, "task-x", nonce, Number(received.stdout.trim()), 64 << 20, keep));
    };
    const data = noise(500, "sha256");
    const id = createHash("sha256").update(`blob ${data.length}\0`).update(data).digest("hex");
    const patch = (from: string, to: string) => `diff --git a/x.bin b/x.bin\nnew file mode 100644\nindex ${from}..${to}\nGIT binary patch\nliteral ${data.length}\n${deflated85(data)}\n\nliteral 0\nHcmV?d00001\n\n`;
    // (A sha1 repository's ids aren't full here.)
    const short = apply(patch(Z, blobId(data)));
    expect([short.status, short.stderr.trim()]).toEqual([1, NO_IDS]);
    expect(existsSync(join(root, "x.bin"))).toBe(false);
    const applied = apply(patch("0".repeat(64), id));
    expect([applied.status, applied.stderr]).toEqual([0, ""]);
    expect(createHash("sha256").update(`blob ${data.length}\0`).update(readFileSync(join(root, "x.bin"))).digest("hex")).toBe(id);
  });
});

import { sweepLeftovers } from "../src/handed-repo.ts";

/*
 * What runs of other nodes' tasks cut off left on their agents' side, swept as the node starts (the seventh fabric
 * review's I-d): each task's start sweeps its own, so a task that never runs again would keep them. Every task with any
 * there is listed, and each that can't be running is swept by its own sweep. Here the agent's VM is a shell on
 * temporary folders, and the node's store a list.
 */
describe("what runs of other nodes' tasks cut off leaves on their agent's side, as the node starts (I-d)", () => {
  test("is swept for a task that ended and one the node doesn't know, never for one that may still run, nor any other's", async () => {
    const s = setUp();
    mkdirSync(s.keep.agent, { recursive: true });
    const [ended, unknown, running] = ["task-ended", "task-unknown", "task-running"];
    const known = new Map([[ended, "failed"], [running, "running"]]);
    const n = handedNonce();
    // The one that ended: a receive and its apply, a tree's read, the patch of before (its give had ended). The one the
    // node doesn't know: only its give's ref (its give was killed in its bundle). The one that may still run: all of them.
    const endedLeft = [`${ended}.${n}.patch`, `${ended}.${n}.apply-index`, `${ended}.tree-index`, `${ended}.patch`];
    const runningLeft = [`${running}.${n}.patch`, `${running}.${n}.apply-index`, `${running}.give-index`, `${running}.tree-index`, `${running}.patch`];
    // (And what isn't the sweep's: the handed helper's lists, endLeftovers' to read; a task VM's own scratch names; names
    // that are no task's; a ref under the gives' that is no task's; a task's checkpoint.)
    const others = [`${ended}.jsonl`, `${running}.jsonl`, "task-listed.jsonl", "send-index", "given.bundle", "not a task.patch", ".patch", `${"t".repeat(81)}.patch`, "task-ünï.patch"];
    for (const name of [...endedLeft, ...runningLeft, ...others]) writeFileSync(join(s.keep.agent, name), "left\n");
    for (const ref of [`give/${unknown}`, `give/${running}`, "give/not/a-task", "give/not.a-task", `checkpoints/${ended}/1`]) s.git(s.repo, "update-ref", `refs/invincible/${ref}`, s.base);
    const sent: string[] = [];
    const asked: string[] = [];
    const exec = async (command: string) => {
      sent.push(command);
      const r = sh(command);
      return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    };
    const sweepable = (task: string) => {
      asked.push(task);
      return !known.has(task) || known.get(task) === "failed";
    };
    expect(await sweepLeftovers(exec, sweepable, s.repo, s.keep.agent)).toEqual({ swept: [ended, unknown], failed: [] });
    // Only task ids were asked about, each once; and only the two were swept, each by its own sweep.
    expect(asked).toEqual([ended, running, unknown]);
    expect(sent.slice(1)).toEqual([handedSweep(s.repo, ended, s.keep.agent), handedSweep(s.repo, unknown, s.keep.agent)]);
    expect(s.left().sort()).toEqual([...runningLeft, ...others].sort());
    expect(s.git(s.repo, "for-each-ref", "--format=%(refname)", "refs/invincible").stdout.trim().split("\n").sort()).toEqual([`refs/invincible/checkpoints/${ended}/1`, `refs/invincible/give/${running}`, "refs/invincible/give/not.a-task", "refs/invincible/give/not/a-task"].sort());
    // (And again: what may still run is all that is listed, and nothing is swept.)
    expect(await sweepLeftovers(exec, sweepable, s.repo, s.keep.agent)).toEqual({ swept: [], failed: [] });
  });

  test("whatever the agent's VM lists, only a task id is asked about and swept, once; a sweep that fails is said", async () => {
    // (The VM is the agent's: what answers there as python3 may print anything.)
    const listing = ["task-a", "not a task", "../../etc", "a/b", "a.b", "", "t".repeat(81), "task-a", "task-b"].join("\n");
    const sent: string[] = [];
    const asked: string[] = [];
    const exec = async (command: string) => {
      sent.push(command);
      return sent.length === 1 ? { exitCode: 0, stdout: listing } : { exitCode: command === handedSweep("/work/repo", "task-b") ? 1 : 0, stdout: "" };
    };
    const result = await sweepLeftovers(exec, (task) => (asked.push(task), true));
    expect(result).toEqual({ swept: ["task-a"], failed: ["task-b"] });
    expect(asked).toEqual(["task-a", "task-b"]);
    expect(sent.slice(1)).toEqual([handedSweep("/work/repo", "task-a"), handedSweep("/work/repo", "task-b")]);
  });

  test("an agent's side with no repository yet has only its files listed; a repository it can't list refs of is said", async () => {
    const s = setUp();
    mkdirSync(s.keep.agent, { recursive: true });
    writeFileSync(join(s.keep.agent, "task-ended.give-index"), "left\n");
    const exec = async (command: string) => {
      const r = sh(command);
      return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    };
    // (Its repository is cloned at its first task: before that, /work/repo isn't there.)
    expect(await sweepLeftovers(exec, () => true, join(s.agent, "no-repo"), s.keep.agent)).toEqual({ swept: ["task-ended"], failed: [] });
    expect(s.left()).toEqual([]);
    // A repository whose configuration names another worktree is refused, as every script of the node's refuses it.
    s.git(s.repo, "config", "core.worktree", s.agent);
    await expect(sweepLeftovers(exec, () => true, s.repo, s.keep.agent)).rejects.toThrow("its configuration names core.worktree");
  });
});

/*
 * A round of another node's task's gates (the eleventh fabric review's ruling): the task's tree, packed (or with no
 * repository tarred) in its VM, kept in a store of the round's VM's own user, and each gate's copy made from that store by
 * the gates' own user. Here the task's VM's /work, the round's store and the gates' folder are temporary folders, the
 * pipe between the VMs a file, and every user this test's; that the gates' user can't write the store, that no process of
 * the task's reaches the round's VM, and the sweep between gates, are held on real VMs (handed-real.integration.test.ts,
 * gate-sweep.integration.test.ts).
 */
describe("the round of another node's task's gates: its tree, its store, and each gate's copy of its own", () => {
  /** The task's side of the pipe into the store: each side's end, as a file between them. */
  function given(root: string, tree: string) {
    const at = temp("handed-round-");
    const store = join(at, "round");
    const piped = join(at, "piped");
    const take = sh(`${handedRoundTake(root, tree)} > ${q(piped)}`);
    const kept = sh(`${handedRoundStore(tree, store)} < ${q(piped)}`);
    const gates = join(at, "gates");
    mkdirSync(gates);
    return { take, kept, store, gates, copy: (held: string, kind: "repo" | "folder", on = join(gates, handedNonce())) => ({ on, made: sh(handedCopy(held, on, kind, store, gates)) }) };
  }
  /** The task's clone with its work in it, and its tree as the freeze reads it: a change, a new file, and what git ignores. */
  function worked() {
    const s = setUp();
    expect(s.give().status).toBe(0);
    writeFileSync(join(s.theirs, "app.txt"), "two\n");
    writeFileSync(join(s.theirs, "new.txt"), "made by the task\n");
    writeFileSync(join(s.theirs, ".gitignore"), "ignored.txt\nnode_modules/\n");
    writeFileSync(join(s.theirs, "ignored.txt"), "a result the tree doesn't have\n");
    mkdirSync(join(s.theirs, "node_modules", "tool"), { recursive: true });
    writeFileSync(join(s.theirs, "node_modules", "tool", "index.js"), "installed by the task\n");
    const read = sh(handedTree(s.theirs, s.base, "task-x", s.keep.task));
    expect(read.status).toBe(0);
    return { ...s, tree: read.stdout.trim() };
  }

  test("in a repository its copy is that tree alone, from the store: nothing git ignores in the worktree, and HEAD a commit of it with no history", () => {
    const w = worked();
    const r = given(w.theirs, w.tree);
    expect([r.take.status, r.take.stderr, r.kept.status, r.kept.stderr, r.kept.stdout.trim()]).toEqual([0, "", 0, "", w.tree]);
    const { on, made } = r.copy(w.tree, "repo");
    expect([made.status, made.stderr]).toEqual([0, ""]);
    const tree = join(on, "tree");
    expect(readdirSync(tree).sort()).toEqual([".git", ".gitignore", "README.md", "app.txt", "new.txt"]);
    expect(readFileSync(join(tree, "app.txt"), "utf8")).toBe("two\n");
    // (Its .git is the copy's own: its HEAD that tree, as a commit with nothing before it, and the worktree clean.)
    expect(w.git(tree, "rev-parse", "HEAD^{tree}").stdout.trim()).toBe(w.tree);
    expect(w.git(tree, "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
    expect(w.git(tree, "status", "--porcelain").stdout).toBe("");
    // A HOME and a temporary folder of its own beside it, its own user's alone; the store, its readers' to read alone.
    for (const sub of ["home", "tmp", "tree"]) expect((lstatSync(join(on, sub)).mode & 0o777).toString(8)).toBe("700");
    expect((lstatSync(r.store).mode & 0o777).toString(8)).toBe("755");
    expect(made.stdout.trim()).toBe(`4 ${["the agent's repository\n", "two\n", "made by the task\n", "ignored.txt\nnode_modules/\n"].reduce((n, text) => n + text.length, 0)} ${w.tree}`);
    // The next gate's copy takes the place of every earlier one.
    const next = r.copy(w.tree, "repo");
    expect(next.made.status).toBe(0);
    expect(readdirSync(r.gates)).toEqual([next.on.slice(r.gates.length + 1)]);
  });

  test("the store holds that tree, whatever the task's VM does: an object of it changed in the clone isn't taken, and what the clone does after it is taken reaches no copy", () => {
    const w = worked();
    const blob = w.git(w.theirs, "rev-parse", `${w.tree}:new.txt`).stdout.trim();
    const object = join(w.theirs, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    expect(existsSync(object)).toBe(true);
    // Taken first, then the clone's object of it changed (as a process of the task's could): the copy is the tree all the same.
    const r = given(w.theirs, w.tree);
    expect(r.kept.status).toBe(0);
    const other = Buffer.from("not what the tree says\n");
    chmodSync(object, 0o644);
    writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`blob ${other.length}\0`), other])));
    const { on, made } = r.copy(w.tree, "repo");
    expect(made.status).toBe(0);
    expect(readFileSync(join(on, "tree", "new.txt"), "utf8")).toBe("made by the task\n");
    // Changed before it is taken: the store hashes what it is given, and the tree's own object is not there.
    const again = given(w.theirs, w.tree);
    expect(again.kept.status).not.toBe(0);
    expect(again.take.stderr + again.kept.stderr).toMatch(/its tree (could not be packed|could not be taken|is not all there)/);
  });

  test("a store is made once, new: one there already, or a tree that isn't a tree's id, isn't one", () => {
    const w = worked();
    const r = given(w.theirs, w.tree);
    expect(r.kept.status).toBe(0);
    expect(sh(`${handedRoundStore(w.tree, r.store)} < /dev/null`).stderr.trim()).toBe("not a store for its gates");
    expect(() => handedRoundStore("HEAD")).toThrow("not a tree");
    expect(() => handedRoundTake(w.theirs, "HEAD")).toThrow("not a tree");
  });

  test("a link out of the tree is refused: an absolute one, one up past its top, and one that resolves out of it through others; one inside it is kept", () => {
    for (const [name, to, kept] of [["inside", "app.txt", true], ["absolute", "/etc/hostname", false], ["up", "../../outside", false], ["deep/up", "../../x", false], ["deep/through", "here/here/here/here/../../../outside", false]] as const) {
      const w = worked();
      mkdirSync(join(w.theirs, "deep"), { recursive: true });
      symlinkSync(".", join(w.theirs, "deep", "here"));
      symlinkSync(to, join(w.theirs, name));
      const tree = sh(handedTree(w.theirs, w.base, "task-x", w.keep.task)).stdout.trim();
      const { on, made } = given(w.theirs, tree).copy(tree, "repo");
      expect([name, made.status === 0]).toEqual([name, kept]);
      if (kept) expect(lstatSync(join(on, "tree", name)).isSymbolicLink()).toBe(true);
      else expect(made.stderr).toContain(`its tree has a link out of it, ${name} -> ${to}`);
    }
  });

  test("with no repository, its folder is taken as it is: its files, folders and links and nothing else, hashed in the store, and each gate's copy is that", () => {
    const folder = temp("handed-folder-");
    mkdirSync(join(folder, "sub"));
    writeFileSync(join(folder, "report.md"), "the report\n");
    writeFileSync(join(folder, "sub", "run.sh"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
    symlinkSync("report.md", join(folder, "latest.md"));
    expect(spawnSync("mkfifo", [join(folder, "pipe")]).status).toBe(0);
    const r = given(folder, "");
    expect([r.take.status, r.take.stderr, r.kept.status, r.kept.stderr]).toEqual([0, "", 0, ""]);
    const hashed = r.kept.stdout.trim();
    expect(hashed).toMatch(/^[0-9a-f]{40}$/);
    const { on, made } = r.copy(hashed, "folder");
    expect([made.status, made.stderr]).toEqual([0, ""]);
    const tree = join(on, "tree");
    expect(readdirSync(tree).sort()).toEqual(["latest.md", "report.md", "sub"]);
    expect(readFileSync(join(tree, "report.md"), "utf8")).toBe("the report\n");
    expect(lstatSync(join(tree, "latest.md")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(tree, "sub", "run.sh")).mode & 0o111).not.toBe(0);
    expect(made.stdout.trim()).toBe(`2 ${"the report\n".length + "#!/bin/sh\necho ran\n".length} ${hashed}`);
    // What the folder becomes after it was taken reaches no copy of this round's.
    writeFileSync(join(folder, "report.md"), "changed after its gates began\n");
    expect(readFileSync(join(r.copy(hashed, "folder").on, "tree", "report.md"), "utf8")).toBe("the report\n");
    // The same folder taken again is the same tree.
    expect(given(folder, "").kept.stdout.trim()).not.toBe(hashed);
    writeFileSync(join(folder, "report.md"), "the report\n");
    expect(given(folder, "").kept.stdout.trim()).toBe(hashed);
  });

  test("with no repository, a file its VM's user can't read is no part left out: the round's tree, and so its gates, fail and say which (the ninth review's I-2)", () => {
    const folder = temp("handed-folder-");
    writeFileSync(join(folder, "report.md"), "the report\n");
    writeFileSync(join(folder, "secret.txt"), "not for its gates\n", { mode: 0o000 });
    const r = given(folder, "");
    chmodSync(join(folder, "secret.txt"), 0o600);
    // (Its side of the pipe fails, and says which: a round is taken only when that side ended well, as every pipe's is.)
    expect([r.take.status, r.take.stderr.trim()]).toEqual([1, "its folder couldn't be read: secret.txt: Permission denied"]);
  });

  test("with no repository, the store takes files, folders and links inside the folder alone: a name out of it, a link out of it, a hard link, a device or a name twice is refused", () => {
    const build = (body: string) => {
      const at = temp("handed-tar-");
      const tar = join(at, "given.tar");
      const made = spawnSync("python3", ["-I", "-c", `import io, sys, tarfile\nout = tarfile.open(sys.argv[1], "w", format=tarfile.PAX_FORMAT)\ndef add(name, kind=tarfile.REGTYPE, data=b"", link=""):\n    info = tarfile.TarInfo(name)\n    info.type, info.size, info.linkname, info.mode = kind, len(data), link, 0o644\n    out.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)\n${body}\nout.close()`, tar], { encoding: "utf8" });
      expect(made.stderr).toBe("");
      return { tar, store: join(at, "round") };
    };
    const cases: [string, string, RegExp][] = [
      ["a name up out of it", `add("../escaped", data=b"x")`, /is no new name inside it/],
      ["an absolute name", `add("/tmp/escaped", data=b"x")`, /is no new name inside it/],
      ["a link out of it", `add("out", tarfile.SYMTYPE, link="../../outside")`, /its tree has a link out of it, out -> \.\.\/\.\.\/outside/],
      ["a link out of it through others, a later one making an earlier one point out", `add("a", tarfile.SYMTYPE, link="x/y/../..")\nadd("x", tarfile.SYMTYPE, link=".")`, /its tree has a link out of it, a -> x\/y\/\.\.\/\.\./],
      ["a file written through a link", `add("d", tarfile.SYMTYPE, link=".")\nadd("d/f", data=b"x")\nadd("e", tarfile.SYMTYPE, link="/tmp")\nadd("e/f", data=b"x")`, /e\/f is no new name inside it|its tree has a link out of it/],
      ["a hard link", `add("f", data=b"x")\nadd("g", tarfile.LNKTYPE, link="f")`, /g is no file, folder or link/],
      ["a device", `add("dev", tarfile.CHRTYPE)`, /dev is no file, folder or link/],
      ["a name twice", `add("f", data=b"x")\nadd("f", data=b"y")`, /f is no new name inside it/],
    ];
    for (const [what, body, said] of cases) {
      const { tar, store } = build(body);
      const kept = sh(`${handedRoundStore("", store)} < ${q(tar)}`);
      expect([what, kept.status]).toEqual([what, 1]);
      expect([what, kept.stderr.trim()]).toEqual([what, expect.stringMatching(said)]);
      expect(existsSync(join(store, "..", "escaped")) || existsSync("/tmp/escaped")).toBe(false);
    }
  });

  test("the manifests its install cache is filled from are its tree's bun.lock and the package.json of each workspace it names, and nothing else; none where it has no bun.lock", () => {
    const LOCK = `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": { "name": "app" },\n    "packages/lib": { "name": "lib" },\n  },\n  "packages": {},\n}\n`;
    /** What a read printed: the files of its gzipped tar, by name. */
    const listed = (stdout: string) => {
      const at = temp("handed-manifests-");
      writeFileSync(join(at, "m.tgz"), Buffer.from(stdout.trim(), "base64"));
      return sh(`tar -tzf ${q(join(at, "m.tgz"))}`).stdout.trim().split("\n").sort();
    };
    const w = worked();
    // None yet: nothing.
    expect(sh(handedManifests(w.theirs, w.tree))).toMatchObject({ status: 0, stdout: "" });
    writeFileSync(join(w.theirs, "bun.lock"), LOCK);
    writeFileSync(join(w.theirs, "package.json"), `{ "name": "app" }\n`);
    mkdirSync(join(w.theirs, "packages", "lib"), { recursive: true });
    writeFileSync(join(w.theirs, "packages", "lib", "package.json"), `{ "name": "lib" }\n`);
    writeFileSync(join(w.theirs, "bunfig.toml"), `[install]\nregistry = "http://192.0.2.1/"\n`);
    const tree = sh(handedTree(w.theirs, w.base, "task-x", w.keep.task)).stdout.trim();
    // (As its tree holds them: what the worktree has since is no part of it.)
    writeFileSync(join(w.theirs, "bun.lock"), "changed since\n");
    const read = sh(handedManifests(w.theirs, tree));
    expect([read.status, read.stderr]).toEqual([0, ""]);
    expect(listed(read.stdout)).toEqual(["bun.lock", "package.json", "packages/lib/package.json"]);
    // With no repository, its folder's, as it is.
    const folder = temp("handed-folder-");
    writeFileSync(join(folder, "bun.lock"), LOCK.replace(`    "packages/lib": { "name": "lib" },\n`, ""));
    writeFileSync(join(folder, "package.json"), `{ "name": "app" }\n`);
    writeFileSync(join(folder, ".npmrc"), "registry=http://192.0.2.1/\n");
    expect(listed(sh(handedManifests(folder, "")).stdout)).toEqual(["bun.lock", "package.json"]);
    // A workspace whose package.json isn't there, or a lockfile it can't read: nothing is filled, said.
    writeFileSync(join(folder, "bun.lock"), LOCK);
    expect(sh(handedManifests(folder, "")).stderr.trim()).toBe("its bun.lock names a workspace whose package.json isn't there, packages/lib/package.json, so nothing is filled");
    writeFileSync(join(folder, "bun.lock"), "{ not json");
    expect(sh(handedManifests(folder, "")).stderr.trim()).toStartWith("its bun.lock can't be read:");
    expect(() => handedManifests(folder, "HEAD")).toThrow("not a tree");
  });

  test("its copy's folder is one of the gates' folder's, named by a nonce, and its tree a tree's id", () => {
    for (const on of ["/gates/x", "/tmp/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", `/gates/${"0a".repeat(16)}/..`, "/gatesx/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"]) expect(() => handedCopy("1".repeat(40), on, "repo")).toThrow("not a copy for its gates");
    expect(() => handedCopy("HEAD", `/gates/${"0a".repeat(16)}`, "repo")).toThrow("not a copy for its gates");
    expect(() => handedCopy("", `/gates/${"0a".repeat(16)}`, "folder")).toThrow("not a copy for its gates");
    expect(handedCopy("1".repeat(40), `/gates/${"0a".repeat(16)}`, "folder")).toContain(`'/gates/${"0a".repeat(16)}' 'folder'`);
  });
});
