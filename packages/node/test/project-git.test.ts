import { spawned } from "../../../bench/spawned.ts";
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchName } from "@invincible/core";
import { actionDone, BRANCH_SCRIPT, CLONE_SCRIPT, COMMIT_SCRIPT, GIT_SCRIPT, gitView } from "../src/project-git.ts";
import { LookError } from "../src/workspace-look.ts";

// Each script here runs as its computer runs it, Python 3 and git as processes of their own, so its time is the
// machine's to give: the slowest, "a filter, Git LFS's, its own or one it includes", took 1.8 s on the Mac mini at a
// load of 25 on 18 cores and 68.5 s with 2 % of a core (what each of about 585 runnable tasks gets of 12); the first
// clone and the held-off settings ran past bun's 5 s on main at load (28 November 2026). The limit is how long a busy
// machine may take, never what a test checks.
setDefaultTimeout(180_000);

/*
 * The Build view's git scripts, run here as they run in its computer (Python 3, the checkout and what's asked as
 * arguments), on repositories made for each test, with none of this machine's own git settings: as a fresh VM has it.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "invincible-git-")); dirs.push(dir); return dir; };
// The scripts' home, for the whole file: made when its tests begin and removed when they end. (Made as the file loaded,
// among each test's folders, it was removed after the first test, and left behind when none of them ran.)
let home = "";
let env: Record<string, string | undefined> = {};
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "invincible-git-"));
  env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
});
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});
const run = async (script: string, ...args: string[]) => {
  const ran = await spawned(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe", env });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString();
};
const git = async (dir: string, ...args: string[]) => {
  const ran = await spawned(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { stdout: "pipe", stderr: "pipe", env });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString().trim();
};
/** A repository on main with two commits and a branch beside it. */
async function repository(): Promise<string> {
  const dir = folder();
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Hi\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "First words");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "A in a.ts");
  await git(dir, "branch", "feature");
  return dir;
}
const FAKE_KEY = `sk-ant-api03-${"A".repeat(93)}AA`;

describe("a project's checkout, as git has it", () => {
  test("missing, a folder git doesn't know, or ready with its branch, branches, what isn't committed and its commits", async () => {
    const dir = folder();
    expect(gitView(await run(GIT_SCRIPT, join(dir, "nothing")), "/work/projects/site")).toMatchObject({ state: "missing", branch: null, changed: 0, log: [] });
    expect(gitView(await run(GIT_SCRIPT, dir), "/work/projects/site").state).toBe("not-a-repository");

    const repo = await repository();
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "new.ts"), "export {};\n");
    await git(repo, "remote", "add", "origin", "https://someone:hunter2hunter2@example.com/site.git");
    const view = gitView(await run(GIT_SCRIPT, repo), "/work/projects/site");
    expect(view).toMatchObject({ checkout: "/work/projects/site", state: "ready", branch: "main", changed: 2, upstream: null, ahead: null, behind: null });
    expect(view.branches.sort()).toEqual(["feature", "main"]);
    expect(view.head).toMatch(/^[0-9a-f]{7,}$/);
    // Its address, with the credentials in it taken out.
    expect(view.remote).toBe("https://example.com/site.git");
    expect(view.log.map((c) => c.subject)).toEqual(["A in a.ts", "First words"]);
    expect(view.log[0]!.at).toBeGreaterThan(Date.now() - 600_000);
  });

  test("a branch started where it stands, switched to and back; a name git won't take, or one that isn't there, is refused in git's words", async () => {
    const repo = await repository();
    actionDone(await run(BRANCH_SCRIPT, repo, "fix/one", "1"));
    expect(gitView(await run(GIT_SCRIPT, repo), "/work/projects/site").branch).toBe("fix/one");
    actionDone(await run(BRANCH_SCRIPT, repo, "main", "0"));
    expect(gitView(await run(GIT_SCRIPT, repo), "/work/projects/site").branch).toBe("main");
    expect(actionDone.bind(null, await run(BRANCH_SCRIPT, repo, "a..b", "1"))).toThrow(new LookError("git doesn't take that as a branch's name", 409));
    expect(actionDone.bind(null, await run(BRANCH_SCRIPT, repo, "nowhere", "0"))).toThrow(LookError);
  });

  test("a commit takes everything changed and new, as Invincible where no author is set; with nothing to commit it says so", async () => {
    const repo = await repository();
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    actionDone(await run(COMMIT_SCRIPT, repo, "Three, and b"));
    const view = gitView(await run(GIT_SCRIPT, repo), "/work/projects/site");
    expect(view.changed).toBe(0);
    expect(view.log[0]!.subject).toBe("Three, and b");
    expect(await git(repo, "log", "-1", "--format=%an <%ae>")).toBe("Invincible <invincible@localhost>");
    expect((await git(repo, "show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual(["a.ts", "b.ts"]);
    expect(actionDone.bind(null, await run(COMMIT_SCRIPT, repo, "Again"))).toThrow(LookError);
  });

  test("the first clone, into a folder not there yet; never over one that is", async () => {
    const origin = await repository();
    const dest = join(folder(), "projects", "site");
    actionDone(await run(CLONE_SCRIPT, dest, origin));
    expect(gitView(await run(GIT_SCRIPT, dest), "/work/projects/site")).toMatchObject({ state: "ready", branch: "main" });
    expect(actionDone.bind(null, await run(CLONE_SCRIPT, dest, origin))).toThrow(new LookError("the checkout is there already", 409));
  });

  test("what comes back is checked: an answer that isn't the script's is the VM's failing, and a key in a subject is redacted", async () => {
    expect(() => gitView("not json", "/work/projects/site")).toThrow(new LookError("the checkout couldn't be read", 502));
    expect(() => gitView(JSON.stringify({ state: "elsewhere" }), "/work/projects/site")).toThrow(LookError);
    const view = gitView(JSON.stringify({ state: "ready", branch: "main", head: "abc1234", branches: ["main"], changed: 0, log: [{ sha: "abc1234", subject: `Add ${FAKE_KEY}`, at: 1 }] }), "/work/projects/site");
    expect(view.log[0]!.subject).not.toContain(FAKE_KEY);
  });

  test("a branch's name is held to what git takes before it reaches the VM", async () => {
    for (const name of ["main", "fix/one", "release-0.4", "a_b.c"]) expect(BranchName.safeParse(name).success).toBe(true);
    for (const name of ["-x", "/x", ".x", "a..b", "x/", "x.", "x.lock", "a b", "a;rm -rf", ""]) expect(BranchName.safeParse(name).success).toBe(false);
  });
});

/*
 * A checkout's own git settings, held off (as a task's changes are, workspace-look.ts CHANGES_SCRIPT; the apps thread's
 * finding, 27 November 2026). These are run as the VM runs them, with nothing holding git's settings off but the scripts
 * themselves: a HOME as the VM's is, where a global configuration would be the agent's own to write (in layout 1 its
 * HOME is its /work). Each plants a program that says it ran, where git would run one: a hook, a filter, an fsmonitor,
 * a gpg, a template's hook. None may run.
 */
describe("a checkout's own git settings, held off", () => {
  /** The VM's HOME, as the test makes it: empty, or with a global configuration in it. */
  const vmHome = (gitconfig = "") => {
    const dir = folder();
    if (gitconfig) writeFileSync(join(dir, ".gitconfig"), gitconfig);
    return dir;
  };
  /** A script as the VM runs it: python3 -I, its HOME the VM's, and nothing else holding git's settings off. */
  const inVm = async (home_: string, script: string, ...args: string[]) => {
    const ran = await spawned(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: home_ } });
    expect(ran.exitCode).toBe(0);
    return ran.stdout.toString();
  };
  /** A program that says it ran (a line in `said`), passing what it is given through: a filter's, a hook's, a gpg's. */
  const program = (said: string) => {
    const path = join(folder(), "ran.sh");
    writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> '${said}'\ncat\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const ran = (said: string) => (existsSync(said) ? readFileSync(said, "utf8") : "");

  test("a commit runs none of its hooks, and no program of its signs it", async () => {
    const repo = await repository();
    const said = join(folder(), "said");
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> '${said}'\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    await git(repo, "config", "commit.gpgSign", "true");
    await git(repo, "config", "gpg.program", program(said));
    writeFileSync(join(repo, "a.ts"), "export const a = 4;\n");
    actionDone(await inVm(vmHome(), COMMIT_SCRIPT, repo, "Four"));
    expect(ran(said)).toBe("");
    expect(await git(repo, "log", "-1", "--format=%s")).toBe("Four");
  });

  test("status and a switch run no fsmonitor or hook of its, and nothing of a global configuration in the VM's HOME", async () => {
    const repo = await repository();
    const said = join(folder(), "said");
    await git(repo, "config", "core.fsmonitor", program(said));
    writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho post-checkout >> '${said}'\n`);
    chmodSync(join(repo, ".git", "hooks", "post-checkout"), 0o755);
    const home_ = vmHome(`[core]\n\tfsmonitor = ${program(said)}\n[status]\n\tshowUntrackedFiles = no\n`);
    writeFileSync(join(repo, "new.ts"), "export {};\n");
    // (Untracked files are counted: the global configuration that would hide them wasn't read.)
    expect(gitView(await inVm(home_, GIT_SCRIPT, repo), "/work/projects/site")).toMatchObject({ state: "ready", changed: 1 });
    actionDone(await inVm(home_, BRANCH_SCRIPT, repo, "feature", "0"));
    expect(ran(said)).toBe("");
  });

  test("a husky checkout (its hooks path): status, a switch and a commit work, and no hook of its runs", async () => {
    const repo = await repository();
    const said = join(folder(), "said");
    // What husky's install leaves at every npm install: core.hooksPath at .husky/_, and a hook there for each of git's.
    await git(repo, "config", "core.hooksPath", ".husky/_");
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", ".gitignore"), "*\n");
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-checkout", "reference-transaction"]) {
      writeFileSync(join(repo, ".husky", "_", hook), `#!/bin/sh\necho ${hook} >> '${said}'\n`);
      chmodSync(join(repo, ".husky", "_", hook), 0o755);
    }
    writeFileSync(join(repo, "a.ts"), "export const a = 6;\n");
    expect(gitView(await inVm(vmHome(), GIT_SCRIPT, repo), "/work/projects/site")).toMatchObject({ state: "ready", branch: "main", changed: 1 });
    actionDone(await inVm(vmHome(), COMMIT_SCRIPT, repo, "Six"));
    expect(await git(repo, "log", "-1", "--format=%s")).toBe("Six");
    actionDone(await inVm(vmHome(), BRANCH_SCRIPT, repo, "feature", "0"));
    expect(await git(repo, "branch", "--show-current")).toBe("feature");
    expect(ran(said)).toBe("");
  });

  test("a filter, Git LFS's, its own or one it includes: status runs none and counts what changed; a switch or a commit is refused, naming it", async () => {
    const said = join(folder(), "said");
    // (git-lfs a stand-in on the VM's PATH, which says when it runs.)
    const bin = folder();
    writeFileSync(join(bin, "git-lfs"), `#!/bin/sh\necho "git-lfs $*" >> '${said}'\ncat\n`);
    chmodSync(join(bin, "git-lfs"), 0o755);
    const lfs = async (repo: string) => {
      // What `git lfs install --local` writes (git-lfs 3).
      for (const [key, value] of [["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"], ["filter.lfs.process", "git-lfs filter-process"], ["filter.lfs.required", "true"]] as const) await git(repo, "config", key, value);
      writeFileSync(join(repo, ".gitattributes"), "*.ts filter=lfs diff=lfs merge=lfs -text\n");
      return "lfs";
    };
    const own = async (repo: string) => (await git(repo, "config", "filter.x.clean", program(said)), writeFileSync(join(repo, ".gitattributes"), "* filter=x\n"), "x");
    const included = async (repo: string) => {
      const cfg = join(folder(), "more.config");
      writeFileSync(cfg, `[filter "Kept"]\n\tclean = ${program(said)}\n\tprocess = ${program(said)}\n`);
      await git(repo, "config", "include.path", cfg);
      writeFileSync(join(repo, ".gitattributes"), "* filter=Kept\n");
      return "Kept";
    };
    for (const configure of [lfs, own, included]) {
      const repo = await repository();
      const name = await configure(repo);
      writeFileSync(join(repo, "a.ts"), "export const a = 7;\n");
      const home_ = vmHome();
      const vm = async (script: string, ...args: string[]) => {
        const out = await spawned(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: `${bin}:${process.env.PATH}`, HOME: home_ } });
        expect(out.exitCode).toBe(0);
        return out.stdout.toString();
      };
      // (.gitattributes is new, and a.ts changed.)
      expect([name, gitView(await vm(GIT_SCRIPT, repo), "/work/projects/site")]).toMatchObject([name, { state: "ready", changed: 2 }]);
      const why = `this checkout's configuration names a filter (${name}), and what you ask here runs none: a switch would check its files out, and a commit keep them, without it`;
      expect(actionDone.bind(null, await vm(COMMIT_SCRIPT, repo, "Seven")), name).toThrow(why);
      expect(actionDone.bind(null, await vm(BRANCH_SCRIPT, repo, "feature", "0")), name).toThrow(why);
      expect(await git(repo, "log", "-1", "--format=%s")).toBe("A in a.ts");
    }
    expect(ran(said)).toBe("");
  });

  test("a repository whose configuration names another worktree is refused, saying why", async () => {
    const repo = await repository();
    await git(repo, "config", "core.worktree", folder());
    writeFileSync(join(repo, "a.ts"), "export const a = 5;\n");
    const why = "its configuration names core.worktree";
    expect(gitView.bind(null, await inVm(vmHome(), GIT_SCRIPT, repo), "/work/projects/site")).toThrow(why);
    expect(actionDone.bind(null, await inVm(vmHome(), COMMIT_SCRIPT, repo, "Five"))).toThrow(why);
    expect(actionDone.bind(null, await inVm(vmHome(), BRANCH_SCRIPT, repo, "feature", "0"))).toThrow(why);
  });

  test("a commit is by you: the checkout's own name and address, else its computer's git configuration's, else Invincible, said so; never a guess", async () => {
    // (Each checkout holds user.useConfigOnly, so git takes an address from its configuration or none, as on Linux, whose
    // host name has no domain for git to guess one from.)
    const by = async (repo: string) => await git(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>");
    const commit = async (repo: string, home_: string, message: string) => {
      writeFileSync(join(repo, "a.ts"), `export const a = "${message}";\n`);
      const out = await inVm(home_, COMMIT_SCRIPT, repo, message);
      actionDone(out);
      return (JSON.parse(out) as { said: string }).said;
    };
    const yours = vmHome("[user]\n\tname = Ada Lovelace\n\temail = ada@example.test\n");
    // Its own, where it names one: whatever the computer's says.
    const own = await repository();
    await git(own, "config", "user.useConfigOnly", "true");
    await git(own, "config", "user.name", "Grace Hopper");
    await git(own, "config", "user.email", "grace@example.test");
    expect(await commit(own, yours, "Own")).not.toContain("Committed as");
    expect(await by(own)).toBe("Grace Hopper <grace@example.test>|Grace Hopper <grace@example.test>");
    // None of its own: the computer's, as you set it there (the held git reads no global configuration of itself).
    const computers = await repository();
    await git(computers, "config", "user.useConfigOnly", "true");
    expect(await commit(computers, yours, "Yours")).not.toContain("Committed as");
    expect(await by(computers)).toBe("Ada Lovelace <ada@example.test>|Ada Lovelace <ada@example.test>");
    // Neither: Invincible's, and the answer says so.
    const neither = await repository();
    await git(neither, "config", "user.useConfigOnly", "true");
    expect(await commit(neither, vmHome(), "Nobody's")).toContain("(Committed as Invincible <invincible@localhost>: neither the checkout's git configuration nor its computer's says who you are.");
    expect(await by(neither)).toBe("Invincible <invincible@localhost>|Invincible <invincible@localhost>");
  });

  test("a clone runs no hook of a template a global configuration names", async () => {
    const origin = await repository();
    const said = join(folder(), "said");
    const templates = folder();
    mkdirSync(join(templates, "hooks"));
    writeFileSync(join(templates, "hooks", "post-checkout"), `#!/bin/sh\necho post-checkout >> '${said}'\n`);
    chmodSync(join(templates, "hooks", "post-checkout"), 0o755);
    const dest = join(folder(), "projects", "site");
    actionDone(await inVm(vmHome(`[init]\n\ttemplateDir = ${templates}\n`), CLONE_SCRIPT, dest, origin));
    expect(gitView(await inVm(vmHome(), GIT_SCRIPT, dest), "/work/projects/site")).toMatchObject({ state: "ready", branch: "main" });
    expect(ran(said)).toBe("");
  });
});
