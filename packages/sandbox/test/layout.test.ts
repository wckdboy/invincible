import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE, WORKSPACE_OWN } from "@invincible/core";
import { MOVE_PY } from "../src/layout.ts";

/*
 * Moving an agent's store from layout 1 (its /work its HOME too) to layout 2 (two trees, work/ and home/, mounted on
 * their own: layout.ts), as the one-off container runs MOVE_PY on it, here on a store made in a temporary folder. Renames
 * alone, inside the store; back by the reverse renames; and a list that says what it would do by names and sizes, never
 * a byte of any file.
 */

const stores: string[] = [];
afterEach(() => {
  for (const dir of stores.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store as an agent's /work in layout 1 leaves it: its work, the runtime's own, its tools' own, a toolchain, a lease. */
function store(): string {
  const root = mkdtempSync(join(tmpdir(), "layout-"));
  stores.push(root);
  const file = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  file("repo/README.md", "the agent's repository");
  file("tasks/task-a/notes.txt", "a task's work");
  file("out/report.md", "what it made");
  // Entries of the workspace's own that begin with a dot (the desktop's pictures among them), and two named like the trees.
  file(".agent/sessions/task-a.claude", "a session's id");
  file(".tmp/task-a/x", "a temporary file");
  file(".eval/run.json", "{}");
  file(".evidence/desktop/0f1e2d.png", "a picture of the desktop, kept by its SHA-256");
  file("work", "a file of the agent's named work");
  file("home/plan.md", "a folder of the agent's named home");
  // What tools keep for themselves: a config, a secret in it, notes, and a toolchain whose bin links to its own files.
  file(".config/tool/config.json", '{"token":"not-a-real-secret-sentinel"}');
  file(".memory/engram/notes.db", "notes");
  file(".local/lib/tool/run.sh", "#!/bin/sh\necho moved-tool-ran\n");
  chmodSync(join(root, ".local/lib/tool/run.sh"), 0o755);
  mkdirSync(join(root, ".local/bin"), { recursive: true });
  symlinkSync("../lib/tool/run.sh", join(root, ".local/bin/tool"));
  // The lease, and one a write left behind.
  file(LEASE_FILE, '{"INVINCIBLE_TOKEN":"gw_test"}');
  file(".invincible-gateway-k3j2.json", "half a lease");
  // An image's lost+found, which is the image's.
  mkdirSync(join(root, "lost+found"));
  return root;
}

const run = (mode: string, root: string) =>
  spawnSync("python3", ["-I", "-c", MOVE_PY, mode, root, JSON.stringify(WORKSPACE_OWN), LEASE_FILE], { encoding: "utf8", timeout: 20_000 });

describe("moving a store to layout 2", () => {
  test("its tools' own entries go to its HOME, the rest stays its workspace, the lease is dropped, and lost+found stays", () => {
    const root = store();
    const moved = run("move", root);
    expect(moved.status).toBe(0);
    expect(readdirSync(root).sort()).toEqual([".invincible-layout.json", "home", "lost+found", "work"]);
    expect(readdirSync(join(root, "work")).sort()).toEqual([".agent", ".eval", ".evidence", ".tmp", "home", "out", "repo", "tasks", "work"]);
    expect(readdirSync(join(root, "home")).sort()).toEqual([".config", ".local", ".memory"]);
    // Moved by renames: what it held is as it was.
    expect(readFileSync(join(root, "work/repo/README.md"), "utf8")).toBe("the agent's repository");
    expect(readFileSync(join(root, "work/home/plan.md"), "utf8")).toBe("a folder of the agent's named home");
    expect(statSync(join(root, "home")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "work")).mode & 0o777).toBe(0o755);
    // Again: nothing more.
    expect(run("move", root).status).toBe(0);
    expect(readdirSync(join(root, "home")).sort()).toEqual([".config", ".local", ".memory"]);
  });

  test("a toolchain it moved still runs from its HOME's PATH", () => {
    const root = store();
    expect(run("move", root).status).toBe(0);
    expect(lstatSync(join(root, "home/.local/bin/tool")).isSymbolicLink()).toBe(true);
    const ran = spawnSync("sh", ["-c", "tool"], { encoding: "utf8", env: { PATH: `${join(root, "home/.local/bin")}:/usr/bin:/bin` } });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("moved-tool-ran");
  });

  test("back undoes it: every entry where it was, but the lease, which every prepare writes anew", () => {
    const root = store();
    const before = readdirSync(root).sort();
    expect(run("move", root).status).toBe(0);
    expect(run("back", root).status).toBe(0);
    expect(readdirSync(root).sort()).toEqual(before.filter((name) => !name.startsWith(".invincible-gateway")));
    expect(readFileSync(join(root, "work"), "utf8")).toBe("a file of the agent's named work");
    expect(existsSync(join(root, ".invincible-layout.json"))).toBe(false);
  });

  test("a move cut off in the middle is moved on from where it was", () => {
    const root = store();
    // As a cut leaves it: two entries staged and written down, the rest not yet.
    mkdirSync(join(root, ".invincible-layout-work"));
    mkdirSync(join(root, ".invincible-layout-home"));
    spawnSync("mv", [join(root, "repo"), join(root, ".invincible-layout-work/repo")]);
    spawnSync("mv", [join(root, ".config"), join(root, ".invincible-layout-home/.config")]);
    writeFileSync(join(root, ".invincible-layout.json"), JSON.stringify({ layout: 2, state: "moving", moved: [{ name: "repo", to: "work" }, { name: ".config", to: "home" }] }));
    expect(run("move", root).status).toBe(0);
    expect(readdirSync(join(root, "work")).sort()).toEqual([".agent", ".eval", ".evidence", ".tmp", "home", "out", "repo", "tasks", "work"]);
    expect(readdirSync(join(root, "home")).sort()).toEqual([".config", ".local", ".memory"]);
    // And one cut as the trees took their names: the workspace's tree named, its HOME's not yet.
    const other = store();
    expect(run("move", other).status).toBe(0);
    spawnSync("mv", [join(other, "home"), join(other, ".invincible-layout-home")]);
    writeFileSync(join(other, ".invincible-layout.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(other, ".invincible-layout.json"), "utf8")), state: "naming" }));
    expect(run("move", other).status).toBe(0);
    expect(readdirSync(other).sort()).toEqual([".invincible-layout.json", "home", "lost+found", "work"]);
    expect(readdirSync(join(other, "work")).sort()).toContain("work");
  });
});

describe("what the code keeps in a workspace", () => {
  /*
   * A move puts every top-level dot-entry that isn't the workspace's own in HOME. So an entry the code writes in /work
   * for itself (the desktop's pictures came that way, after layout 2 was written) must be named in WORKSPACE_OWN, or a
   * store moved would lose it from its workspace: every /work/.name in every package's source is checked here.
   */
  test("every top-level dot-entry of /work the code names is the workspace's own, or the lease a move drops", () => {
    const named = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) for (const [, name] of readFileSync(path, "utf8").matchAll(/\/work\/(\.[A-Za-z0-9_-][A-Za-z0-9_.-]*)/g)) named.set(name!, path);
      }
    };
    const packages = join(import.meta.dir, "../..");
    for (const name of readdirSync(packages)) if (existsSync(join(packages, name, "src"))) walk(join(packages, name, "src"));
    const kept: readonly string[] = [...WORKSPACE_OWN, LEASE_FILE];
    expect([...named].filter(([name]) => !kept.includes(name))).toEqual([]);
    // (It finds them: the runtime's own state is named.)
    expect([...named.keys()]).toContain(".agent");
  });
});

describe("what a move would do, listed", () => {
  test("by name, where it goes, its kind and its size: never a byte of a file, nor a link followed, nor a pipe opened", () => {
    const root = store();
    // A pipe nobody writes to: a list that opened it would wait for ever.
    spawnSync("mkfifo", [join(root, ".config/tool/pipe")]);
    const listed = run("list", root);
    expect(listed.status).toBe(0);
    expect(listed.stdout).not.toContain("not-a-real-secret-sentinel");
    expect(listed.stdout).not.toContain("moved-tool-ran");
    const entries = listed.stdout.trim().split("\n").map((line) => JSON.parse(line) as { name: string; to: string; kind: string; bytes: number });
    expect(entries.map((e) => [e.name, e.to])).toEqual([
      [".agent", "work"], [".config", "home"], [".eval", "work"], [".evidence", "work"], [".invincible-gateway-k3j2.json", "drop"], [LEASE_FILE, "drop"],
      [".local", "home"], [".memory", "home"], [".tmp", "work"], ["home", "work"], ["out", "work"], ["repo", "work"], ["tasks", "work"], ["work", "work"],
    ]);
    expect(entries.find((e) => e.name === ".config")).toMatchObject({ kind: "dir" });
    expect(entries.find((e) => e.name === "work")).toMatchObject({ kind: "file", bytes: "a file of the agent's named work".length });
    expect(entries.every((e) => Number.isInteger(e.bytes) && e.bytes >= 0)).toBe(true);
    // And it changed nothing.
    expect(readdirSync(root)).toContain(LEASE_FILE);
    expect(existsSync(join(root, "work"))).toBe(true);
    expect(statSync(join(root, "work")).isFile()).toBe(true);
  });
});
