import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handedApply, handedDrop, handedGive, handedReceive, handedSend, handedTake } from "../src/handed-repo.ts";

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

/** An agent's repository with a task's worktree in it at its base, and a task VM's /work beside it. */
function setUp() {
  const agent = temp("handed-agent-");
  const task = temp("handed-task-");
  const repo = join(agent, "repo");
  const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { env, encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "README.md"), "the agent's repository\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(join(repo, "app.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "second");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const root = join(agent, "tasks", "task-x");
  git(repo, "worktree", "add", "-q", "--detach", root, base);
  const keep = { agent: join(agent, ".agent/handed"), task: join(task, ".agent/handed") };
  const theirs = join(task, "tasks", "task-x");
  /** The task's clone, from what the agent's side gives, through a pipe. */
  const give = () => sh(`${handedGive(root, "task-x", keep.agent)} | ${handedTake(theirs, base, "Ada", "ada@agents.invalid", keep.task)}`);
  /** What the agent's side received, applied as the node applies it: as many bytes as it says it kept. */
  const applyReceived = (received: ReturnType<typeof sh>, limit: number) => (received.status !== 0 ? received : sh(handedApply(root, base, "task-x", Number(received.stdout.trim()), limit, keep.agent)));
  /** Its changes since the base, back to the agent's side through a pipe, then applied to its worktree. */
  const bring = (limit = 64 << 20) => applyReceived(sh(`${handedSend(theirs, base, keep.task)} | ${handedReceive("task-x", limit, keep.agent)}`), limit);
  /** A patch of the task's own making, received and applied on the agent's side. */
  const apply = (patch: string, limit = 64 << 20) => applyReceived(sh(handedReceive("task-x", limit, keep.agent), patch), limit);
  return { agent, task, repo, root, theirs, base, git, give, bring, apply, keep };
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
    expect(existsSync(join(s.keep.agent, "task-x.patch"))).toBe(false);
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
    const received = sh(handedReceive("task-x", 64 << 20, s.keep.agent), one);
    expect([received.status, received.stdout.trim()]).toEqual([0, String(part)]);
    const applied = sh(handedApply(s.root, s.base, "task-x", whole, 64 << 20, s.keep.agent));
    expect([applied.status, applied.stderr.trim()]).toEqual([1, `its changes came cut short: ${part} of ${whole} bytes`]);
    expect(existsSync(join(s.root, "one.txt"))).toBe(false);
    expect(existsSync(join(s.keep.agent, "task-x.patch"))).toBe(false);
    // (All of it, as the node carried it, is applied.)
    expect(s.apply(one + two).status).toBe(0);
    expect([readFileSync(join(s.root, "one.txt"), "utf8"), readFileSync(join(s.root, "two.txt"), "utf8")]).toEqual(["one\n", "two\n"]);
    // (And one the node saw cut, never applied: dropped.)
    expect(sh(handedReceive("task-x", 64 << 20, s.keep.agent), one).status).toBe(0);
    expect(sh(handedDrop("task-x", s.keep.agent)).status).toBe(0);
    expect(existsSync(join(s.keep.agent, "task-x.patch"))).toBe(false);
  });
});
