import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointCommand, quote, REPO_TASK_START } from "../src/team-runtime.ts";

/*
 * A knight's steps, kept as they end, and a task started from one (PLAN #15), with real git in a scratch directory:
 * what the VM would run, its paths under /work pointed here.
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "galahad-steps-"));
  dirs.push(dir);
  // (Git as the VM's is: its knight's name, and nothing of this machine's own configuration.)
  const env = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@roundtable.invalid", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@roundtable.invalid" };
  const sh = (command: string, cwd = dir): string => {
    const ran = Bun.spawnSync(["bash", "-c", command], { cwd, env });
    if (ran.exitCode !== 0) throw new Error(`${command}: ${ran.stderr.toString()}`);
    return ran.stdout.toString().trimEnd();
  };
  const here = (command: string) => command.replaceAll("/work/.agent/checkpoints", join(dir, "checkpoints"));
  return { dir, sh, here };
}

test("a step is kept as a commit under its own ref, its files as they stood (not what is ignored), and the task's own index is never touched", () => {
  const { dir, sh, here } = scratch();
  sh("git init -q repo && cd repo && echo one > a.txt && git add a.txt && git commit -qm base");
  const base = sh("git -C repo rev-parse HEAD");
  sh("git -C repo worktree add -q --detach ../t1 HEAD");
  sh("echo two > a.txt && echo new > b.txt && printf 'out/\\n' > .gitignore && mkdir -p out && echo built > out/x", join(dir, "t1"));
  const [commit, tree, parent] = sh(here(checkpointCommand(join(dir, "t1"), "task-aaaaaaaaaaaa", 1, ""))).split(" ");
  expect(parent).toBe(base);
  expect(sh("git -C repo rev-parse refs/galahad/checkpoints/task-aaaaaaaaaaaa/1")).toBe(commit!);
  expect(sh(`git -C repo show ${commit}:a.txt`)).toBe("two");
  expect(sh(`git -C repo show ${commit}:b.txt`)).toBe("new");
  expect(Bun.spawnSync(["git", "-C", join(dir, "repo"), "cat-file", "-e", `${commit}:out/x`]).exitCode).not.toBe(0);
  expect(sh("git status --porcelain", join(dir, "t1"))).toBe(" M a.txt\n?? .gitignore\n?? b.txt");
  // Nothing changed since: the step before's, and no new commit.
  expect(sh(here(checkpointCommand(join(dir, "t1"), "task-aaaaaaaaaaaa", 2, `${tree} ${parent}`)))).toBe("same");
  expect(Bun.spawnSync(["git", "-C", join(dir, "repo"), "rev-parse", "--verify", "--quiet", "refs/galahad/checkpoints/task-aaaaaaaaaaaa/2"]).exitCode).not.toBe(0);
  // A commit of the knight's own is a change too: kept, its parent the new HEAD.
  sh("git add a.txt && git commit -qm 'its own'", join(dir, "t1"));
  const [, , after] = sh(here(checkpointCommand(join(dir, "t1"), "task-aaaaaaaaaaaa", 3, `${tree} ${parent}`))).split(" ");
  expect(after).toBe(sh("git rev-parse HEAD", join(dir, "t1")));
});

test("a change made in the same tick as the task's index was written is kept: the index is copied with its time, so git still reads what its times can't tell it", async () => {
  // Linux stamps files by a coarse clock, so a same-size change written within one tick of the index looks unchanged by
  // its times; git then checks the file itself because the index is no older than the entry (racy git). A copy of the
  // index made with a new time hid that, and a step was once kept with "one" for "two" (1 run in 60 on Ultra, 19
  // November 2026). Here the clock is made coarse on purpose: whole seconds, no ctime, the times set by hand.
  const { dir, sh, here } = scratch();
  sh("git init -q repo && cd repo && git config core.checkStat minimal && git config core.trustctime false && echo one > a.txt && git add a.txt && git commit -qm base");
  sh("git -C repo worktree add -q --detach ../t1 HEAD");
  const t1 = join(dir, "t1");
  const cached = Number(/mtime: (\d+):/.exec(sh("git ls-files --debug a.txt", t1))![1]);
  writeFileSync(join(t1, "a.txt"), "two\n");
  const named = sh("git rev-parse --git-path index", t1);
  for (const path of [join(t1, "a.txt"), named.startsWith("/") ? named : join(t1, named)]) utimesSync(path, cached, cached);
  // (The step is kept a second later: a copy with a new time is then newer than the entry, and git trusts the times.)
  await Bun.sleep(1100);
  const [commit] = sh(here(checkpointCommand(t1, "task-cccccccccccc", 1, ""))).split(" ");
  expect(sh(`git -C repo show ${commit}:a.txt`)).toBe("two");
}, 30_000);

test("a task started from a step has its files as they stood after it, its HEAD where the step's was, and the first task's base for its changes; the first task's later work stays its own", () => {
  const { dir, sh, here } = scratch();
  sh("git init -q repo && cd repo && echo one > a.txt && git add a.txt && git commit -qm base");
  const base = sh("git -C repo rev-parse HEAD");
  sh("git -C repo worktree add -q --detach ../t1 HEAD");
  mkdirSync(join(dir, "base"));
  writeFileSync(join(dir, "base", "task-aaaaaaaaaaaa"), `${base} fetched`);
  sh("echo two > a.txt && echo new > b.txt", join(dir, "t1"));
  const [commit] = sh(here(checkpointCommand(join(dir, "t1"), "task-aaaaaaaaaaaa", 1, ""))).split(" ");
  // The first task goes on, and commits what came after.
  sh("echo three > a.txt && git add -A && git commit -qm later", join(dir, "t1"));
  const start = REPO_TASK_START.replaceAll("'/work/repo'", quote(join(dir, "repo"))).replaceAll("'/work/.agent/base/'", quote(`${join(dir, "base")}/`));
  const kept = sh(`python3 -c ${quote(start)} ${quote(join(dir, "t2"))} ${quote(join(dir, "base", "task-bbbbbbbbbbbb"))} '' task-aaaaaaaaaaaa ${commit}`);
  expect(kept).toBe(`${base} from`);
  expect(readFileSync(join(dir, "t2", "a.txt"), "utf8").trim()).toBe("two");
  expect(readFileSync(join(dir, "t2", "b.txt"), "utf8").trim()).toBe("new");
  expect(sh("git rev-parse HEAD", join(dir, "t2"))).toBe(base);
  expect(sh("git status --porcelain", join(dir, "t2"))).toBe(" M a.txt\n?? b.txt");
  expect(readFileSync(join(dir, "t1", "a.txt"), "utf8").trim()).toBe("three");
  // Taken up again (a restart, your resume), it is the same worktree, never made anew.
  expect(sh(`python3 -c ${quote(start)} ${quote(join(dir, "t2"))} ${quote(join(dir, "base", "task-bbbbbbbbbbbb"))} '' task-aaaaaaaaaaaa ${commit}`)).toBe(`${base} from`);
  // A step no longer in the repository is said so, and nothing is made.
  const gone = Bun.spawnSync(["bash", "-c", `python3 -c ${quote(start)} ${quote(join(dir, "t3"))} ${quote(join(dir, "base", "t3"))} '' task-aaaaaaaaaaaa ${"0".repeat(40)}`], { cwd: dir });
  expect(gone.exitCode).not.toBe(0);
  expect(gone.stderr.toString()).toContain("the step it starts from is no longer in the repository");
});
