import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPath } from "@invincible/core";
import { CHANGES_SCRIPT, changesView, fileView, filesView, LIST_LIMIT, LIST_SCRIPT, LookError, READ_LIMIT, READ_SCRIPT } from "../src/workspace-look.ts";
import { spawned } from "../../../bench/spawned.ts";

/*
 * The scripts run here as they run in an agent's VM (Python 3, the path as an argument), on a folder made for each test
 * that stands for its /work: given as the script's second argument, where the VM's is /work itself.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "invincible-look-")); dirs.push(dir); return dir; };
const run = async (script: string, ...args: string[]) => {
  const ran = await spawned(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe" });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString();
};
const git = async (dir: string, ...args: string[]) => {
  const ran = await spawned(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString().trim();
};
// A PNG's first bytes, then a little more: enough to be one by its signature.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const FAKE_KEY = `sk-ant-api03-${"A".repeat(93)}AA`;

describe("an agent's workspace, looked into", () => {
  test("a folder: folders first, each entry with its kind and size; one that isn't there, or isn't a folder, says so", async () => {
    const dir = folder();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "README.md"), "# Hi\n");
    writeFileSync(join(dir, "b.ts"), "export {};\n");
    symlinkSync("README.md", join(dir, "link"));
    const view = filesView(await run(LIST_SCRIPT, dir, dir), "ada", "/work");
    expect(view.entries.map((e) => [e.name, e.kind])).toEqual([["src", "dir"], ["b.ts", "file"], ["link", "link"], ["README.md", "file"]]);
    expect(view.entries.find((e) => e.name === "README.md")).toMatchObject({ size: 5, modified: expect.any(Number) });
    expect(view.more).toBe(false);
    await expect((async () => filesView(await run(LIST_SCRIPT, join(dir, "nothing"), dir), "ada", "/work/nothing"))()).rejects.toThrow(new LookError("nothing is there", 404));
    await expect((async () => filesView(await run(LIST_SCRIPT, join(dir, "b.ts"), dir), "ada", "/work/b.ts"))()).rejects.toThrow(new LookError("that is a file, not a folder", 409));
  });

  test("a big folder says there is more than its first entries", async () => {
    const dir = folder();
    for (let n = 0; n < LIST_LIMIT + 3; n++) writeFileSync(join(dir, `f${n}`), "");
    const view = filesView(await run(LIST_SCRIPT, dir, dir), "ada", "/work");
    expect(view.entries).toHaveLength(LIST_LIMIT);
    expect(view.more).toBe(true);
  });

  test("a file: text with anything like a key redacted, a picture as itself, or what it is", async () => {
    const dir = folder();
    writeFileSync(join(dir, "app.ts"), `const key = "${FAKE_KEY}";\nexport const ok = true;\n`);
    writeFileSync(join(dir, "shot.png"), PNG);
    writeFileSync(join(dir, "a.out"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    const text = fileView(await run(READ_SCRIPT, join(dir, "app.ts"), dir), "ada", "/work/app.ts");
    expect(text).toMatchObject({ kind: "text", redacted: true, size: expect.any(Number) });
    expect(text.text).not.toContain(FAKE_KEY);
    expect(text.text).toContain("export const ok = true;");
    expect(fileView(await run(READ_SCRIPT, join(dir, "shot.png"), dir), "ada", "/work/shot.png")).toMatchObject({ kind: "image", type: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(fileView(await run(READ_SCRIPT, join(dir, "a.out"), dir), "ada", "/work/a.out")).toMatchObject({ kind: "binary", size: 7 });
    await expect((async () => fileView(await run(READ_SCRIPT, dir, dir), "ada", "/work"))()).rejects.toThrow(new LookError("that isn't a file", 409));
  });

  test("a long text comes as its beginning, cut where a character ends", async () => {
    const dir = folder();
    // Three-byte characters, so the read's limit falls inside one.
    writeFileSync(join(dir, "long.txt"), "€".repeat(READ_LIMIT));
    const view = fileView(await run(READ_SCRIPT, join(dir, "long.txt"), dir), "ada", "/work/long.txt");
    expect(view).toMatchObject({ kind: "text", cut: true, size: READ_LIMIT * 3 });
    expect(view.text!.length).toBe(Math.floor(READ_LIMIT / 3));
    expect(view.text).not.toContain("�");
  });

  test("what a task changed: from the commit it started at, its files with their lines, the diff redacted, and new files", async () => {
    // (Its /work, with the repository and the record of where its task started in it.)
    const work = realpathSync(folder());
    const repo = join(work, "repo");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "sync.ts"), "export const retries = 1;\n");
    writeFileSync(join(repo, "old.ts"), "gone\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "start");
    const base = await git(repo, "rev-parse", "HEAD");
    const kept = join(work, ".agent", "base");
    mkdirSync(join(work, ".agent"));
    writeFileSync(kept, `${base} fetched`);
    writeFileSync(join(repo, "sync.ts"), `export const retries = 3;\nexport const token = "${FAKE_KEY}";\n`);
    rmSync(join(repo, "old.ts"));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "work");
    writeFileSync(join(repo, "notes.md"), "untracked\n");
    const view = changesView(await run(CHANGES_SCRIPT, repo, kept, work), "ada", "task-abcdefghijkl", "/work/tasks/task-abcdefghijkl");
    expect(view).toMatchObject({ base, head: expect.stringMatching(/^[0-9a-f]{40}$/), untracked: ["notes.md"], cut: false, redacted: true });
    expect(view.files).toEqual([
      { path: "old.ts", status: "D", added: 0, removed: 1 },
      { path: "sync.ts", status: "M", added: 2, removed: 1 },
    ]);
    expect(view.diff).toContain("+export const retries = 3;");
    expect(view.diff).not.toContain(FAKE_KEY);
    // With no starting commit written down, what isn't committed yet; a folder that isn't a repository says so.
    writeFileSync(join(repo, "sync.ts"), "export const retries = 4;\n");
    expect(changesView(await run(CHANGES_SCRIPT, repo, "", work), "ada", null, "/work/repo")).toMatchObject({ base: null, files: [{ path: "sync.ts", status: "M", added: 1, removed: 2 }] });
    mkdirSync(join(work, "plain"));
    await expect((async () => changesView(await run(CHANGES_SCRIPT, join(work, "plain"), "", work), "ada", null, "/work/plain"))()).rejects.toThrow(new LookError("that isn't a git repository", 404));
  });

  test("an answer that isn't the script's is refused, never shown", () => {
    expect(() => filesView("Traceback (most recent call last):", "ada", "/work")).toThrow(new LookError("the workspace didn't answer as it should (is Python 3 there?)", 502));
    expect(filesView(JSON.stringify({ entries: [{ name: "", kind: "file", size: 1, modified: 1 }, { name: "ok", kind: "weird", size: 1, modified: 1 }, { name: "x", kind: "file", size: 1, modified: 2 }] }), "ada", "/work").entries.map((e) => e.name)).toEqual(["x"]);
  });

  test("a path is under /work, with no . or .. in it", () => {
    for (const ok of ["/work", "/work/", "/work/src/app.ts", "/work/.agent/sessions"]) expect(WorkPath.safeParse(ok).success).toBe(true);
    for (const bad of ["/etc/passwd", "/work/../etc", "/work/./x", "work/x", "/workshop", "/work//x", "/work/x\u0000y"]) expect(WorkPath.safeParse(bad).success).toBe(false);
  });
});

/*
 * A link in an agent's workspace, looked through (27 November 2026): a link the agent leaves in /work could make the node
 * read and show a file outside it, a tool's sign-in among them, and the node never reads one. A look now goes to what a
 * path names only within /work: each folder on the way and the file itself, opened from the one before it and never
 * through a link out, so nothing swapped in as it reads takes it outside either. A link inside /work works as ever.
 */
describe("a link in an agent's workspace", () => {
  const SECRET = "not-a-real-secret-sentinel";
  /** Its /work, with a file and a folder in it, and beside it (outside) a folder with something of no workspace's. */
  const workspace = () => {
    const work = folder();
    const outside = folder();
    writeFileSync(join(work, "README.md"), "# Hi\n");
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src", "app.ts"), "export const ok = true;\n");
    writeFileSync(join(outside, "secret"), SECRET);
    return { work, outside };
  };
  const refused = new LookError("that is outside the workspace", 403);

  test("a link to a file outside /work is refused, by an absolute path or a relative one; a link inside works", async () => {
    const { work, outside } = workspace();
    symlinkSync(join(outside, "secret"), join(work, "out"));
    symlinkSync(join("..", outside.split("/").at(-1)!, "secret"), join(work, "up"));
    symlinkSync(join(work, "README.md"), join(work, "in"));
    symlinkSync("src/app.ts", join(work, "app"));
    for (const name of ["out", "up"]) await expect((async () => fileView(await run(READ_SCRIPT, join(work, name), work), "ada", `/work/${name}`))()).rejects.toThrow(refused);
    expect(fileView(await run(READ_SCRIPT, join(work, "in"), work), "ada", "/work/in")).toMatchObject({ kind: "text", text: "# Hi\n" });
    expect(fileView(await run(READ_SCRIPT, join(work, "app"), work), "ada", "/work/app")).toMatchObject({ kind: "text", text: "export const ok = true;\n" });
  });

  test("a link to a folder outside is refused, for every folder on the way and for its listing; the listing shows a link as a link", async () => {
    const { work, outside } = workspace();
    symlinkSync(outside, join(work, "away"));
    symlinkSync("..", join(work, "parent"));
    symlinkSync("src", join(work, "code"));
    await expect((async () => fileView(await run(READ_SCRIPT, join(work, "away", "secret"), work), "ada", "/work/away/secret"))()).rejects.toThrow(refused);
    await expect((async () => fileView(await run(READ_SCRIPT, join(work, "parent", outside.split("/").at(-1)!, "secret"), work), "ada", "/work/parent/x/secret"))()).rejects.toThrow(refused);
    await expect((async () => filesView(await run(LIST_SCRIPT, join(work, "away"), work), "ada", "/work/away"))()).rejects.toThrow(refused);
    await expect((async () => filesView(await run(LIST_SCRIPT, join(work, "parent"), work), "ada", "/work/parent"))()).rejects.toThrow(refused);
    // The listing of /work names each link as one, and reads none of them through.
    const listed = await run(LIST_SCRIPT, work, work);
    expect(filesView(listed, "ada", "/work").entries.filter((e) => e.kind === "link").map((e) => e.name).sort()).toEqual(["away", "code", "parent"]);
    expect(listed).not.toContain("secret");
    // A folder inside, through a link: listed and read as ever.
    expect(filesView(await run(LIST_SCRIPT, join(work, "code"), work), "ada", "/work/code").entries.map((e) => e.name)).toEqual(["app.ts"]);
    expect(fileView(await run(READ_SCRIPT, join(work, "code", "app.ts"), work), "ada", "/work/code/app.ts")).toMatchObject({ kind: "text" });
  });

  test("a link swapped in as it reads takes it outside never: a folder on the way, or the file itself", async () => {
    const { work, outside } = workspace();
    mkdirSync(join(work, "inside"));
    writeFileSync(join(work, "inside", "secret"), "inside");
    // A swapper changes, as fast as it can, a folder on the way (a link now inside, now outside) and the file itself (now
    // a file inside, now a link outside), by atomic renames, while the script reads both again and again.
    const stop = join(folder(), "stop");
    const swapper = Bun.spawn(["python3", "-I", "-c", SWAPPER, join(work, "flip"), "inside", outside, join(work, "file"), join(outside, "secret"), stop], { stdout: "ignore", stderr: "inherit" });
    try {
      await Bun.sleep(50);
      const reads = await spawned(["python3", "-I", "-c", AGAIN, READ_SCRIPT, "300", work, join(work, "flip", "secret"), join(work, "file")], { stdout: "pipe", stderr: "pipe" });
      expect(reads.exitCode).toBe(0);
      const said = reads.stdout.toString().trim().split("\n").map((line) => JSON.parse(line) as { data?: string; error?: string });
      expect(said).toHaveLength(600);
      // Never what is outside; what is inside, or a refusal (a link opened as a folder is ENOTDIR on a Mac).
      const texts = said.filter((s) => s.data !== undefined).map((s) => Buffer.from(s.data!, "base64").toString("utf8"));
      expect(texts.filter((text) => text.includes(SECRET))).toEqual([]);
      expect(texts.some((text) => text === "inside")).toBe(true);
      expect(said.filter((s) => s.data === undefined && !["OutsideWorkspace", "NotADirectoryError", "TooManyLinks"].includes(s.error ?? ""))).toEqual([]);
    } finally {
      writeFileSync(stop, "");
      await swapper.exited;
    }
  });

  test("the VM's lease is kept from view whatever leads to it: a link to it, or the same file under another name", async () => {
    const { work } = workspace();
    writeFileSync(join(work, ".invincible-gateway.json"), '{"INVINCIBLE_TOKEN":"gw_not-a-real-token"}');
    symlinkSync(".invincible-gateway.json", join(work, "lease"));
    linkSync(join(work, ".invincible-gateway.json"), join(work, "same"));
    const kept = new LookError("kept from view: it holds this VM's gateway token", 403);
    for (const name of [".invincible-gateway.json", "lease", "same"]) await expect((async () => fileView(await run(READ_SCRIPT, join(work, name), work), "ada", `/work/${name}`))()).rejects.toThrow(kept);
  });

  test("links that lead to each other end, refused", async () => {
    const { work } = workspace();
    symlinkSync("b", join(work, "a"));
    symlinkSync("a", join(work, "b"));
    await expect((async () => fileView(await run(READ_SCRIPT, join(work, "a"), work), "ada", "/work/a"))()).rejects.toThrow(new LookError("too many links on the way to it", 422));
  });
});

/** Swaps a link's target between a folder inside (relative) and one outside, and a name between a file and a link out. */
const SWAPPER = `import os,sys
flip,inside,outside,file,secret,stop=sys.argv[1:7]
i=0
while not os.path.exists(stop):
    i+=1
    os.symlink(inside if i%2 else outside,flip+'.new')
    os.replace(flip+'.new',flip)
    if i%2:
        with open(file+'.new','w') as f:
            f.write('inside')
    else:
        os.symlink(secret,file+'.new')
    os.replace(file+'.new',file)`;

/** Runs a look's script again and again in one process (argv: the script, how many times, its /work, its paths), a line each. */
const AGAIN = `import contextlib,io,sys
script,times,root,paths=sys.argv[1],int(sys.argv[2]),sys.argv[3],sys.argv[4:]
code=compile(script,'look','exec')
for _ in range(times):
    for path in paths:
        out=io.StringIO()
        sys.argv=['look',path,root]
        with contextlib.redirect_stdout(out):
            try:
                exec(code,{'__name__':'__main__'})
            except SystemExit:
                pass
        sys.stdout.write(out.getvalue().strip()+'\\n')`;

/*
 * A VM whose HOME is its /work (layout 1, every agent's VM before one has a HOME of its own): what its tools keep for
 * themselves, their sign-ins among them, is there too, as /work's top-level dot-entries (27 November 2026: the node
 * never reads a sign-in). A look refuses every one of those that isn't the workspace's own (WORKSPACE_OWN, the rule a
 * move to layout 2 goes by, which names no tool's files), however it is reached; a listing of /work names each, and
 * reads nothing in it. In a VM whose HOME is its own, all of /work is its workspace.
 */
describe("a VM whose HOME is its /work", () => {
  /** A look as such a VM runs it: its HOME its /work (or elsewhere, a HOME of its own). */
  const look = async (home: string, script: string, ...args: string[]) => {
    // (As the node runs a look, -I: Apple's own python3 otherwise writes its caches in the HOME it is given, this /work.)
    const ran = await spawned(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home } });
    expect(ran.exitCode).toBe(0);
    return ran.stdout.toString();
  };
  /** Its /work: a repository with its own dot-entries, the workspace's own, and what tools keep for themselves. */
  const workspace = () => {
    const work = folder();
    for (const [path, text] of [
      ["repo/.git/config", "[core]\n"], ["repo/README.md", "# Hi\n"],
      [".agent/sessions/task-a.claude", "a session's id"], [".evidence/desktop/0f1e.png", "a picture"],
      [".config/tool/config.json", '{"token":"not-a-real-secret-sentinel"}'], [".memory/engram/notes.db", "notes"],
    ] as const) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    return work;
  };
  const kept = new LookError("kept from view: in this VM its HOME is its workspace, and that is what its tools keep for themselves", 403);

  test("a top-level dot-entry that isn't the workspace's own is refused, read or listed, however it's reached", async () => {
    const work = workspace();
    symlinkSync(".config/tool/config.json", join(work, "settings"));
    symlinkSync(".config", join(work, "conf"));
    for (const path of [".config/tool/config.json", ".memory/engram/notes.db", "settings", "conf/tool/config.json"]) {
      await expect((async () => fileView(await look(work, READ_SCRIPT, join(work, path), work), "ada", `/work/${path}`))()).rejects.toThrow(kept);
    }
    for (const path of [".config", ".config/tool", "conf", ".memory"]) {
      await expect((async () => filesView(await look(work, LIST_SCRIPT, join(work, path), work), "ada", `/work/${path}`))()).rejects.toThrow(kept);
    }
  });

  test("the workspace's own dot-entries, and every dot-entry below the top, are read and listed as ever", async () => {
    const work = workspace();
    expect(fileView(await look(work, READ_SCRIPT, join(work, ".agent/sessions/task-a.claude"), work), "ada", "/work/.agent/sessions/task-a.claude")).toMatchObject({ kind: "text", text: "a session's id" });
    expect(fileView(await look(work, READ_SCRIPT, join(work, "repo/.git/config"), work), "ada", "/work/repo/.git/config")).toMatchObject({ kind: "text" });
    expect(filesView(await look(work, LIST_SCRIPT, join(work, ".evidence"), work), "ada", "/work/.evidence").entries.map((e) => e.name)).toEqual(["desktop"]);
    expect(filesView(await look(work, LIST_SCRIPT, join(work, "repo"), work), "ada", "/work/repo").entries.map((e) => e.name)).toEqual([".git", "README.md"]);
  });

  test("a listing of /work names each of them, and reads nothing in them", async () => {
    const work = workspace();
    const listed = await look(work, LIST_SCRIPT, work, work);
    expect(filesView(listed, "ada", "/work").entries.map((e) => [e.name, e.kind])).toEqual([[".agent", "dir"], [".config", "dir"], [".evidence", "dir"], [".memory", "dir"], ["repo", "dir"]]);
    expect(listed).not.toContain("tool");
    expect(listed).not.toContain("engram");
  });

  test("in a VM whose HOME is its own, all of /work is its workspace: its dot-entries are read as any", async () => {
    const work = workspace();
    const home = folder();
    expect(fileView(await look(home, READ_SCRIPT, join(work, ".config/tool/config.json"), work), "ada", "/work/.config/tool/config.json")).toMatchObject({ kind: "text" });
    expect(filesView(await look(home, LIST_SCRIPT, join(work, ".memory"), work), "ada", "/work/.memory").entries.map((e) => e.name)).toEqual(["engram"]);
  });
});

/*
 * What a task changed, as git in the VM says it, held to /work as a file's look is (27 November 2026): git runs in the
 * worktree the walk opened, its gitdir within /work too, and as the node's held git (one held git everywhere): no system
 * or global configuration, no textconv, no filter, no hook, and a repository whose configuration names another worktree
 * or includes one from anywhere is refused. Otherwise a link as the worktree, or the repository's own configuration,
 * could have git read elsewhere in the VM, a tool's sign-in among what it could read, or run something there.
 */
describe("what a task changed, held to /work", () => {
  const SECRET = "not-a-real-secret-sentinel";
  /** Its /work with a repository that has a commit and a change, and beside it (outside) a file of no workspace's. */
  const setup = async () => {
    const work = realpathSync(folder());
    const outside = realpathSync(folder());
    writeFileSync(join(outside, "secret"), SECRET);
    const repo = join(work, "repo");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "notes.txt"), "before\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "start");
    writeFileSync(join(repo, "notes.txt"), "after\n");
    return { work, outside, repo };
  };
  const changes = async (path: string, work: string) => changesView(await run(CHANGES_SCRIPT, path, "", work), "ada", null, "/work/repo");
  const config = new LookError("kept from view: its repository's own configuration would have git look elsewhere or run something", 403);

  test("a link as its worktree, to a repository outside /work, is refused; a link inside works", async () => {
    const { work, outside, repo } = await setup();
    const elsewhere = join(outside, "repo");
    mkdirSync(elsewhere);
    await git(elsewhere, "init", "-q", "-b", "main");
    writeFileSync(join(elsewhere, "secret.txt"), "old\n");
    await git(elsewhere, "add", ".");
    await git(elsewhere, "commit", "-q", "-m", "x");
    writeFileSync(join(elsewhere, "secret.txt"), `${SECRET}\n`);
    symlinkSync(elsewhere, join(work, "away"));
    await expect((async () => await changes(join(work, "away"), work))()).rejects.toThrow(new LookError("that is outside the workspace", 403));
    symlinkSync("repo", join(work, "here"));
    expect((await changes(join(work, "here"), work)).diff).toContain("+after");
    void repo;
  });

  test("a .git that names a git dir outside /work is refused; a task's own worktree of its repository works", async () => {
    const { work, outside, repo } = await setup();
    const elsewhere = join(outside, "other");
    mkdirSync(elsewhere);
    await git(elsewhere, "init", "-q", "-b", "main");
    mkdirSync(join(work, "wt"));
    writeFileSync(join(work, "wt", ".git"), `gitdir: ${join(elsewhere, ".git")}\n`);
    await expect((async () => await changes(join(work, "wt"), work))()).rejects.toThrow(new LookError("that is outside the workspace", 403));
    // As a task's is: a worktree of the agent's repository, in /work/tasks.
    mkdirSync(join(work, "tasks"));
    await git(repo, "worktree", "add", "-q", join(work, "tasks", "t1"));
    writeFileSync(join(work, "tasks", "t1", "notes.txt"), "on its own\n");
    expect((await changes(join(work, "tasks", "t1"), work)).diff).toContain("+on its own");
  });

  test("a core.worktree outside /work is refused, and so is a configuration it includes from anywhere", async () => {
    for (const [key, value] of [["core.worktree", "OUTSIDE"], ["include.path", "OUTSIDE/x.config"], ["includeIf.gitdir:/.path", "OUTSIDE/x.config"]] as const) {
      const { work, outside, repo } = await setup();
      writeFileSync(join(outside, "notes.txt"), `${SECRET}\n`);
      await git(repo, "config", key, value.replace("OUTSIDE", outside));
      let caught: LookError | undefined;
      try {
        await changes(repo, work);
      } catch (error) {
        caught = error as LookError;
      }
      expect([key, caught?.message, caught?.status]).toEqual([key, config.message, 403]);
    }
  });

  test("a hooks path, outside /work or husky's, is held off: what changed is shown, and nothing outside is read or run", async () => {
    for (const where of ["OUTSIDE", ".husky/_"]) {
      const { work, outside, repo } = await setup();
      const said = join(outside, "said");
      const hooks = where === "OUTSIDE" ? join(outside, "hooks") : join(repo, ".husky", "_");
      mkdirSync(hooks, { recursive: true });
      for (const hook of ["post-index-change", "reference-transaction", "post-checkout"]) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${said}'\n`);
        chmodSync(join(hooks, hook), 0o755);
      }
      await git(repo, "config", "core.hooksPath", where === "OUTSIDE" ? hooks : where);
      const shown = await changes(repo, work);
      expect([where, shown.files]).toEqual([where, [{ path: "notes.txt", status: "M", added: 1, removed: 1 }]]);
      expect(shown.diff).toContain("+after");
      expect(existsSync(said)).toBe(false);
    }
  });

  test("a textconv never runs, nor a filter (its own, or Git LFS's): neither can show what is outside, and what changed is shown", async () => {
    const { work, outside, repo } = await setup();
    writeFileSync(join(repo, ".gitattributes"), "*.txt diff=reveal\n");
    // (git hands it the file as its last word: it says what is outside, then the file, so the two sides differ.)
    await git(repo, "config", "diff.reveal.textconv", `cat ${join(outside, "secret")}`);
    const shown = await changes(repo, work);
    expect(shown.diff).not.toContain(SECRET);
    expect(shown.diff).toContain("+after");
    // A clean filter, which git diff would run on the worktree's files: held off, so the file is compared as it is.
    const filtered = await setup();
    writeFileSync(join(filtered.repo, ".gitattributes"), "*.txt filter=reveal\n");
    await git(filtered.repo, "config", "filter.reveal.clean", `cat ${join(filtered.outside, "secret")}`);
    const kept = await changes(filtered.repo, filtered.work);
    expect(kept.diff).not.toContain(SECRET);
    expect(kept.diff).toContain("+after");
    // Git LFS installed in it (as `git lfs install --local` writes it), git-lfs a stand-in that says when it runs: a
    // model's pointer committed, and the task's change of it is shown as a change, its bytes as they are.
    const lfs = await setup();
    const said = join(lfs.outside, "said");
    const bin = folder();
    writeFileSync(join(bin, "git-lfs"), `#!/bin/sh\necho "git-lfs $*" >> '${said}'\ncat\n`);
    chmodSync(join(bin, "git-lfs"), 0o755);
    writeFileSync(join(lfs.repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(lfs.repo, "model.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n");
    await git(lfs.repo, "add", ".");
    await git(lfs.repo, "commit", "-q", "-m", "a model, in LFS");
    for (const [key, value] of [["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"], ["filter.lfs.process", "git-lfs filter-process"], ["filter.lfs.required", "true"]] as const) await git(lfs.repo, "config", key, value);
    writeFileSync(join(lfs.repo, "model.bin"), "the model's own bytes\n");
    const looked = await spawned(["python3", "-I", "-c", CHANGES_SCRIPT, lfs.repo, "", lfs.work], { stdout: "pipe", stderr: "pipe", env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(looked.exitCode).toBe(0);
    const modelShown = changesView(looked.stdout.toString(), "ada", null, "/work/repo");
    // (Compared as they are, with no LFS clean: the pointer's three lines out, the model's one in.)
    expect(modelShown.files).toEqual([{ path: "model.bin", status: "M", added: 1, removed: 3 }]);
    expect(existsSync(said)).toBe(false);
  });
});
