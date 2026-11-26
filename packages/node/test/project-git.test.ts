import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchName } from "@galahad/core";
import { actionDone, BRANCH_SCRIPT, CLONE_SCRIPT, COMMIT_SCRIPT, GIT_SCRIPT, gitView } from "../src/project-git.ts";
import { LookError } from "../src/workspace-look.ts";

/*
 * The Build view's git scripts, run here as they run in his computer (Python 3, the checkout and what's asked as
 * arguments), on repositories made for each test, with none of this machine's own git settings: as a fresh VM has it.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "galahad-git-")); dirs.push(dir); return dir; };
const home = folder();
const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const run = (script: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["python3", "-c", script, ...args], { stdout: "pipe", stderr: "pipe", env });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString();
};
const git = (dir: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { stdout: "pipe", stderr: "pipe", env });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString().trim();
};
/** A repository on main with two commits and a branch beside it. */
function repository(): string {
  const dir = folder();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "First words");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "A in a.ts");
  git(dir, "branch", "feature");
  return dir;
}
const FAKE_KEY = `sk-ant-api03-${"A".repeat(93)}AA`;

describe("a project's checkout, as git has it", () => {
  test("missing, a folder git doesn't know, or ready with its branch, branches, what isn't committed and its commits", () => {
    const dir = folder();
    expect(gitView(run(GIT_SCRIPT, join(dir, "nothing")), "/work/projects/site")).toMatchObject({ state: "missing", branch: null, changed: 0, log: [] });
    expect(gitView(run(GIT_SCRIPT, dir), "/work/projects/site").state).toBe("not-a-repository");

    const repo = repository();
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "new.ts"), "export {};\n");
    git(repo, "remote", "add", "origin", "https://someone:hunter2hunter2@example.com/site.git");
    const view = gitView(run(GIT_SCRIPT, repo), "/work/projects/site");
    expect(view).toMatchObject({ checkout: "/work/projects/site", state: "ready", branch: "main", changed: 2, upstream: null, ahead: null, behind: null });
    expect(view.branches.sort()).toEqual(["feature", "main"]);
    expect(view.head).toMatch(/^[0-9a-f]{7,}$/);
    // Its address, with the credentials in it taken out.
    expect(view.remote).toBe("https://example.com/site.git");
    expect(view.log.map((c) => c.subject)).toEqual(["A in a.ts", "First words"]);
    expect(view.log[0]!.at).toBeGreaterThan(Date.now() - 600_000);
  });

  test("a branch started where it stands, switched to and back; a name git won't take, or one that isn't there, is refused in git's words", () => {
    const repo = repository();
    actionDone(run(BRANCH_SCRIPT, repo, "fix/one", "1"));
    expect(gitView(run(GIT_SCRIPT, repo), "/work/projects/site").branch).toBe("fix/one");
    actionDone(run(BRANCH_SCRIPT, repo, "main", "0"));
    expect(gitView(run(GIT_SCRIPT, repo), "/work/projects/site").branch).toBe("main");
    expect(() => actionDone(run(BRANCH_SCRIPT, repo, "a..b", "1"))).toThrow(new LookError("git doesn't take that as a branch's name", 409));
    expect(() => actionDone(run(BRANCH_SCRIPT, repo, "nowhere", "0"))).toThrow(LookError);
  });

  test("a commit takes everything changed and new, as Galahad where no author is set; with nothing to commit it says so", () => {
    const repo = repository();
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    actionDone(run(COMMIT_SCRIPT, repo, "Three, and b"));
    const view = gitView(run(GIT_SCRIPT, repo), "/work/projects/site");
    expect(view.changed).toBe(0);
    expect(view.log[0]!.subject).toBe("Three, and b");
    expect(git(repo, "log", "-1", "--format=%an <%ae>")).toBe("Galahad <galahad@localhost>");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["a.ts", "b.ts"]);
    expect(() => actionDone(run(COMMIT_SCRIPT, repo, "Again"))).toThrow(LookError);
  });

  test("the first clone, into a folder not there yet; never over one that is", () => {
    const origin = repository();
    const dest = join(folder(), "projects", "site");
    actionDone(run(CLONE_SCRIPT, dest, origin));
    expect(gitView(run(GIT_SCRIPT, dest), "/work/projects/site")).toMatchObject({ state: "ready", branch: "main" });
    expect(() => actionDone(run(CLONE_SCRIPT, dest, origin))).toThrow(new LookError("the checkout is there already", 409));
  });

  test("what comes back is checked: an answer that isn't the script's is the VM's failing, and a key in a subject is redacted", () => {
    expect(() => gitView("not json", "/work/projects/site")).toThrow(new LookError("the checkout couldn't be read", 502));
    expect(() => gitView(JSON.stringify({ state: "elsewhere" }), "/work/projects/site")).toThrow(LookError);
    const view = gitView(JSON.stringify({ state: "ready", branch: "main", head: "abc1234", branches: ["main"], changed: 0, log: [{ sha: "abc1234", subject: `Add ${FAKE_KEY}`, at: 1 }] }), "/work/projects/site");
    expect(view.log[0]!.subject).not.toContain(FAKE_KEY);
  });

  test("a branch's name is held to what git takes before it reaches the VM", () => {
    for (const name of ["main", "fix/one", "release-0.4", "a_b.c"]) expect(BranchName.safeParse(name).success).toBe(true);
    for (const name of ["-x", "/x", ".x", "a..b", "x/", "x.", "x.lock", "a b", "a;rm -rf", ""]) expect(BranchName.safeParse(name).success).toBe(false);
  });
});
