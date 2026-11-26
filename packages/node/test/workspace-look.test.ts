import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPath } from "@galahad/core";
import { CHANGES_SCRIPT, changesView, fileView, filesView, LIST_LIMIT, LIST_SCRIPT, LookError, READ_LIMIT, READ_SCRIPT } from "../src/workspace-look.ts";

/* The scripts run here as they run in a knight's VM (Python 3, the path as an argument), on a folder made for each test. */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "galahad-look-")); dirs.push(dir); return dir; };
const run = (script: string, ...args: string[]) => {
  const ran = Bun.spawnSync(["python3", "-c", script, ...args], { stdout: "pipe", stderr: "pipe" });
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

describe("a knight's workspace, looked into", () => {
  test("a folder: folders first, each entry with its kind and size; one that isn't there, or isn't a folder, says so", () => {
    const dir = folder();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "README.md"), "# Hi\n");
    writeFileSync(join(dir, "b.ts"), "export {};\n");
    symlinkSync("README.md", join(dir, "link"));
    const view = filesView(run(LIST_SCRIPT, dir), "ada", "/work");
    expect(view.entries.map((e) => [e.name, e.kind])).toEqual([["src", "dir"], ["b.ts", "file"], ["link", "link"], ["README.md", "file"]]);
    expect(view.entries.find((e) => e.name === "README.md")).toMatchObject({ size: 5, modified: expect.any(Number) });
    expect(view.more).toBe(false);
    expect(() => filesView(run(LIST_SCRIPT, join(dir, "nothing")), "ada", "/work/nothing")).toThrow(new LookError("nothing is there", 404));
    expect(() => filesView(run(LIST_SCRIPT, join(dir, "b.ts")), "ada", "/work/b.ts")).toThrow(new LookError("that is a file, not a folder", 409));
  });

  test("a big folder says there is more than its first entries", () => {
    const dir = folder();
    for (let n = 0; n < LIST_LIMIT + 3; n++) writeFileSync(join(dir, `f${n}`), "");
    const view = filesView(run(LIST_SCRIPT, dir), "ada", "/work");
    expect(view.entries).toHaveLength(LIST_LIMIT);
    expect(view.more).toBe(true);
  });

  test("a file: text with anything like a key redacted, a picture as itself, or what it is", () => {
    const dir = folder();
    writeFileSync(join(dir, "app.ts"), `const key = "${FAKE_KEY}";\nexport const ok = true;\n`);
    writeFileSync(join(dir, "shot.png"), PNG);
    writeFileSync(join(dir, "a.out"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    const text = fileView(run(READ_SCRIPT, join(dir, "app.ts")), "ada", "/work/app.ts");
    expect(text).toMatchObject({ kind: "text", redacted: true, size: expect.any(Number) });
    expect(text.text).not.toContain(FAKE_KEY);
    expect(text.text).toContain("export const ok = true;");
    expect(fileView(run(READ_SCRIPT, join(dir, "shot.png")), "ada", "/work/shot.png")).toMatchObject({ kind: "image", type: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(fileView(run(READ_SCRIPT, join(dir, "a.out")), "ada", "/work/a.out")).toMatchObject({ kind: "binary", size: 7 });
    expect(() => fileView(run(READ_SCRIPT, dir), "ada", "/work")).toThrow(new LookError("that isn't a file", 409));
  });

  test("a long text comes as its beginning, cut where a character ends", () => {
    const dir = folder();
    // Three-byte characters, so the read's limit falls inside one.
    writeFileSync(join(dir, "long.txt"), "€".repeat(READ_LIMIT));
    const view = fileView(run(READ_SCRIPT, join(dir, "long.txt")), "ada", "/work/long.txt");
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
