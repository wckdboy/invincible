import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPath } from "@invincible/core";
import { CHANGES_SCRIPT, changesView, fileView, filesView, LIST_LIMIT, LIST_SCRIPT, LookError, READ_LIMIT, READ_SCRIPT } from "../src/workspace-look.ts";

/*
 * The scripts run here as they run in an agent's VM (Python 3, the path as an argument), on a folder made for each test
 * that stands for its /work: given as the script's second argument, where the VM's is /work itself.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "invincible-look-")); dirs.push(dir); return dir; };
const run = (script: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe" });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString();
};
const git = (dir: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(ran.exitCode).toBe(0);
  return ran.stdout.toString().trim();
};
// A PNG's first bytes, then a little more: enough to be one by its signature.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const FAKE_KEY = `sk-ant-api03-${"A".repeat(93)}AA`;

describe("an agent's workspace, looked into", () => {
  test("a folder: folders first, each entry with its kind and size; one that isn't there, or isn't a folder, says so", () => {
    const dir = folder();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "README.md"), "# Hi\n");
    writeFileSync(join(dir, "b.ts"), "export {};\n");
    symlinkSync("README.md", join(dir, "link"));
    const view = filesView(run(LIST_SCRIPT, dir, dir), "ada", "/work");
    expect(view.entries.map((e) => [e.name, e.kind])).toEqual([["src", "dir"], ["b.ts", "file"], ["link", "link"], ["README.md", "file"]]);
    expect(view.entries.find((e) => e.name === "README.md")).toMatchObject({ size: 5, modified: expect.any(Number) });
    expect(view.more).toBe(false);
    expect(() => filesView(run(LIST_SCRIPT, join(dir, "nothing"), dir), "ada", "/work/nothing")).toThrow(new LookError("nothing is there", 404));
    expect(() => filesView(run(LIST_SCRIPT, join(dir, "b.ts"), dir), "ada", "/work/b.ts")).toThrow(new LookError("that is a file, not a folder", 409));
  });

  test("a big folder says there is more than its first entries", () => {
    const dir = folder();
    for (let n = 0; n < LIST_LIMIT + 3; n++) writeFileSync(join(dir, `f${n}`), "");
    const view = filesView(run(LIST_SCRIPT, dir, dir), "ada", "/work");
    expect(view.entries).toHaveLength(LIST_LIMIT);
    expect(view.more).toBe(true);
  });

  test("a file: text with anything like a key redacted, a picture as itself, or what it is", () => {
    const dir = folder();
    writeFileSync(join(dir, "app.ts"), `const key = "${FAKE_KEY}";\nexport const ok = true;\n`);
    writeFileSync(join(dir, "shot.png"), PNG);
    writeFileSync(join(dir, "a.out"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    const text = fileView(run(READ_SCRIPT, join(dir, "app.ts"), dir), "ada", "/work/app.ts");
    expect(text).toMatchObject({ kind: "text", redacted: true, size: expect.any(Number) });
    expect(text.text).not.toContain(FAKE_KEY);
    expect(text.text).toContain("export const ok = true;");
    expect(fileView(run(READ_SCRIPT, join(dir, "shot.png"), dir), "ada", "/work/shot.png")).toMatchObject({ kind: "image", type: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(fileView(run(READ_SCRIPT, join(dir, "a.out"), dir), "ada", "/work/a.out")).toMatchObject({ kind: "binary", size: 7 });
    expect(() => fileView(run(READ_SCRIPT, dir, dir), "ada", "/work")).toThrow(new LookError("that isn't a file", 409));
  });

  test("a long text comes as its beginning, cut where a character ends", () => {
    const dir = folder();
    // Three-byte characters, so the read's limit falls inside one.
    writeFileSync(join(dir, "long.txt"), "€".repeat(READ_LIMIT));
    const view = fileView(run(READ_SCRIPT, join(dir, "long.txt"), dir), "ada", "/work/long.txt");
    expect(view).toMatchObject({ kind: "text", cut: true, size: READ_LIMIT * 3 });
    expect(view.text!.length).toBe(Math.floor(READ_LIMIT / 3));
    expect(view.text).not.toContain("�");
  });

  test("what a task changed: from the commit it started at, its files with their lines, the diff redacted, and new files", () => {
    const repo = folder();
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "sync.ts"), "export const retries = 1;\n");
    writeFileSync(join(repo, "old.ts"), "gone\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "start");
    const base = git(repo, "rev-parse", "HEAD");
    const kept = join(folder(), "base");
    writeFileSync(kept, `${base} fetched`);
    writeFileSync(join(repo, "sync.ts"), `export const retries = 3;\nexport const token = "${FAKE_KEY}";\n`);
    rmSync(join(repo, "old.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "work");
    writeFileSync(join(repo, "notes.md"), "untracked\n");
    const view = changesView(run(CHANGES_SCRIPT, repo, kept), "ada", "task-abcdefghijkl", "/work/tasks/task-abcdefghijkl");
    expect(view).toMatchObject({ base, head: expect.stringMatching(/^[0-9a-f]{40}$/), untracked: ["notes.md"], cut: false, redacted: true });
    expect(view.files).toEqual([
      { path: "old.ts", status: "D", added: 0, removed: 1 },
      { path: "sync.ts", status: "M", added: 2, removed: 1 },
    ]);
    expect(view.diff).toContain("+export const retries = 3;");
    expect(view.diff).not.toContain(FAKE_KEY);
    // With no starting commit written down, what isn't committed yet; a folder that isn't a repository says so.
    writeFileSync(join(repo, "sync.ts"), "export const retries = 4;\n");
    expect(changesView(run(CHANGES_SCRIPT, repo, ""), "ada", null, "/work/repo")).toMatchObject({ base: null, files: [{ path: "sync.ts", status: "M", added: 1, removed: 2 }] });
    expect(() => changesView(run(CHANGES_SCRIPT, folder(), ""), "ada", null, "/work/repo")).toThrow(new LookError("that isn't a git repository", 404));
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

  test("a link to a file outside /work is refused, by an absolute path or a relative one; a link inside works", () => {
    const { work, outside } = workspace();
    symlinkSync(join(outside, "secret"), join(work, "out"));
    symlinkSync(join("..", outside.split("/").at(-1)!, "secret"), join(work, "up"));
    symlinkSync(join(work, "README.md"), join(work, "in"));
    symlinkSync("src/app.ts", join(work, "app"));
    for (const name of ["out", "up"]) expect(() => fileView(run(READ_SCRIPT, join(work, name), work), "ada", `/work/${name}`)).toThrow(refused);
    expect(fileView(run(READ_SCRIPT, join(work, "in"), work), "ada", "/work/in")).toMatchObject({ kind: "text", text: "# Hi\n" });
    expect(fileView(run(READ_SCRIPT, join(work, "app"), work), "ada", "/work/app")).toMatchObject({ kind: "text", text: "export const ok = true;\n" });
  });

  test("a link to a folder outside is refused, for every folder on the way and for its listing; the listing shows a link as a link", () => {
    const { work, outside } = workspace();
    symlinkSync(outside, join(work, "away"));
    symlinkSync("..", join(work, "parent"));
    symlinkSync("src", join(work, "code"));
    expect(() => fileView(run(READ_SCRIPT, join(work, "away", "secret"), work), "ada", "/work/away/secret")).toThrow(refused);
    expect(() => fileView(run(READ_SCRIPT, join(work, "parent", outside.split("/").at(-1)!, "secret"), work), "ada", "/work/parent/x/secret")).toThrow(refused);
    expect(() => filesView(run(LIST_SCRIPT, join(work, "away"), work), "ada", "/work/away")).toThrow(refused);
    expect(() => filesView(run(LIST_SCRIPT, join(work, "parent"), work), "ada", "/work/parent")).toThrow(refused);
    // The listing of /work names each link as one, and reads none of them through.
    const listed = run(LIST_SCRIPT, work, work);
    expect(filesView(listed, "ada", "/work").entries.filter((e) => e.kind === "link").map((e) => e.name).sort()).toEqual(["away", "code", "parent"]);
    expect(listed).not.toContain("secret");
    // A folder inside, through a link: listed and read as ever.
    expect(filesView(run(LIST_SCRIPT, join(work, "code"), work), "ada", "/work/code").entries.map((e) => e.name)).toEqual(["app.ts"]);
    expect(fileView(run(READ_SCRIPT, join(work, "code", "app.ts"), work), "ada", "/work/code/app.ts")).toMatchObject({ kind: "text" });
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
      const reads = Bun.spawnSync(["python3", "-I", "-c", AGAIN, READ_SCRIPT, "300", work, join(work, "flip", "secret"), join(work, "file")], { stdout: "pipe", stderr: "pipe" });
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

  test("the VM's lease is kept from view whatever leads to it: a link to it, or the same file under another name", () => {
    const { work } = workspace();
    writeFileSync(join(work, ".invincible-gateway.json"), '{"INVINCIBLE_TOKEN":"gw_not-a-real-token"}');
    symlinkSync(".invincible-gateway.json", join(work, "lease"));
    linkSync(join(work, ".invincible-gateway.json"), join(work, "same"));
    const kept = new LookError("kept from view: it holds this VM's gateway token", 403);
    for (const name of [".invincible-gateway.json", "lease", "same"]) expect(() => fileView(run(READ_SCRIPT, join(work, name), work), "ada", `/work/${name}`)).toThrow(kept);
  });

  test("links that lead to each other end, refused", () => {
    const { work } = workspace();
    symlinkSync("b", join(work, "a"));
    symlinkSync("a", join(work, "b"));
    expect(() => fileView(run(READ_SCRIPT, join(work, "a"), work), "ada", "/work/a")).toThrow(new LookError("too many links on the way to it", 422));
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
  const look = (home: string, script: string, ...args: string[]) => {
    // (As the node runs a look, -I: Apple's own python3 otherwise writes its caches in the HOME it is given, this /work.)
    const ran = Bun.spawnSync(["python3", "-I", "-c", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home } });
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

  test("a top-level dot-entry that isn't the workspace's own is refused, read or listed, however it's reached", () => {
    const work = workspace();
    symlinkSync(".config/tool/config.json", join(work, "settings"));
    symlinkSync(".config", join(work, "conf"));
    for (const path of [".config/tool/config.json", ".memory/engram/notes.db", "settings", "conf/tool/config.json"]) {
      expect(() => fileView(look(work, READ_SCRIPT, join(work, path), work), "ada", `/work/${path}`)).toThrow(kept);
    }
    for (const path of [".config", ".config/tool", "conf", ".memory"]) {
      expect(() => filesView(look(work, LIST_SCRIPT, join(work, path), work), "ada", `/work/${path}`)).toThrow(kept);
    }
  });

  test("the workspace's own dot-entries, and every dot-entry below the top, are read and listed as ever", () => {
    const work = workspace();
    expect(fileView(look(work, READ_SCRIPT, join(work, ".agent/sessions/task-a.claude"), work), "ada", "/work/.agent/sessions/task-a.claude")).toMatchObject({ kind: "text", text: "a session's id" });
    expect(fileView(look(work, READ_SCRIPT, join(work, "repo/.git/config"), work), "ada", "/work/repo/.git/config")).toMatchObject({ kind: "text" });
    expect(filesView(look(work, LIST_SCRIPT, join(work, ".evidence"), work), "ada", "/work/.evidence").entries.map((e) => e.name)).toEqual(["desktop"]);
    expect(filesView(look(work, LIST_SCRIPT, join(work, "repo"), work), "ada", "/work/repo").entries.map((e) => e.name)).toEqual([".git", "README.md"]);
  });

  test("a listing of /work names each of them, and reads nothing in them", () => {
    const work = workspace();
    const listed = look(work, LIST_SCRIPT, work, work);
    expect(filesView(listed, "ada", "/work").entries.map((e) => [e.name, e.kind])).toEqual([[".agent", "dir"], [".config", "dir"], [".evidence", "dir"], [".memory", "dir"], ["repo", "dir"]]);
    expect(listed).not.toContain("tool");
    expect(listed).not.toContain("engram");
  });

  test("in a VM whose HOME is its own, all of /work is its workspace: its dot-entries are read as any", () => {
    const work = workspace();
    const home = folder();
    expect(fileView(look(home, READ_SCRIPT, join(work, ".config/tool/config.json"), work), "ada", "/work/.config/tool/config.json")).toMatchObject({ kind: "text" });
    expect(filesView(look(home, LIST_SCRIPT, join(work, ".memory"), work), "ada", "/work/.memory").entries.map((e) => e.name)).toEqual(["engram"]);
  });
});
