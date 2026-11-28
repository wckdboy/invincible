import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { handedApply, handedDrop, handedGive, handedNonce, handedReceive, handedSend, handedSweep, handedTake, handedTree } from "../src/handed-repo.ts";
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  test("R7-2 C: parts whose content would come from the store are refused, however many of them name it", () => {
    const pre = Buffer.concat(Array.from({ length: 2048 }, () => createHash("sha256").update("r7c").digest()));
    const s = setUp(committed("pre.bin", pre));
    const patch = Array.from({ length: 64 }, (_, i) => fromStore(`copies/${i}.bin`, blobId(pre))).join("");
    const applied = s.apply(patch, 1 << 20);
    expect([applied.status, applied.stderr.trim()]).toEqual([1, CARRIED]);
    expect(existsSync(join(s.root, "copies"))).toBe(false);
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
});
