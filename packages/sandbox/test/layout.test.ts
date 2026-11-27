import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_FILE, NOTES_DIR, WORKSPACE_OWN } from "@invincible/core";
import { MOVE_PY } from "../src/layout.ts";

/*
 * Moving an agent's store from layout 1 (its /work its HOME too) to layout 2 (three trees, work/, home/ and notes/, each
 * mounted on its own: layout.ts), as the one-off container runs MOVE_PY on it, here on a store made in a temporary
 * folder. Renames alone, inside the store; back by the reverse renames; and a list that says what it would do by names
 * and sizes, never a byte of any file.
 */

const stores: string[] = [];
afterEach(() => {
  for (const dir of stores.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  stores.push(dir);
  return dir;
};

/** A store as an agent's /work in layout 1 leaves it: its work, the runtime's own, its tools' own, a toolchain, a lease. */
function store(opts: { notes?: boolean } = {}): string {
  const root = temp("layout-");
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
  // What tools keep for themselves: a config, a secret in it, the agent's notes beside another tool's, and a toolchain
  // whose bin links to its own files.
  file(".config/tool/config.json", '{"token":"not-a-real-secret-sentinel"}');
  if (opts.notes !== false) file(`${NOTES_DIR}/notes.db`, "the agent's notes");
  file(".memory/other/kept.txt", "another tool's own");
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

/** The move's word, as the node gives it (its own database keeps it), and the names it makes in the store with it. */
const NONCE = "0123456789abcdef0123456789abcdef";
const MANIFEST = `.invincible-layout-${NONCE}.json`;
const staging = (tree: string) => `.invincible-layout-${NONCE}-${tree}`;
const run = (mode: string, root: string, nonce: string | null = NONCE) =>
  spawnSync("python3", ["-I", "-c", MOVE_PY, mode, root, JSON.stringify(WORKSPACE_OWN), LEASE_FILE, NOTES_DIR, ...(nonce === null ? [] : [nonce])], { encoding: "utf8", timeout: 20_000 });
const ls = (path: string) => readdirSync(path).sort();
const WORK = [".agent", ".eval", ".evidence", ".tmp", "home", "out", "repo", "tasks", "work"];

describe("moving a store to layout 2", () => {
  test("its notes go to a tree of their own, its tools' own entries to its HOME, the rest stays its workspace, the lease is dropped, and lost+found stays", () => {
    const root = store();
    const moved = run("move", root);
    expect(moved.status).toBe(0);
    expect(ls(root)).toEqual([MANIFEST, "home", "lost+found", "notes", "work"]);
    expect(ls(join(root, "work"))).toEqual(WORK);
    expect(ls(join(root, "home"))).toEqual([".config", ".local", ".memory"]);
    // Its notes by one rename: the tree is the folder they were in. Where it is mounted in HOME, an empty folder of the
    // VMs' user's, so the VM's runtime makes nothing of root's there.
    expect(ls(join(root, "notes"))).toEqual(["notes.db"]);
    expect(readFileSync(join(root, "notes/notes.db"), "utf8")).toBe("the agent's notes");
    expect(ls(join(root, "home/.memory"))).toEqual(["engram", "other"]);
    expect(ls(join(root, "home", NOTES_DIR))).toEqual([]);
    expect(readFileSync(join(root, "home/.memory/other/kept.txt"), "utf8")).toBe("another tool's own");
    // Moved by renames: what it held is as it was.
    expect(readFileSync(join(root, "work/repo/README.md"), "utf8")).toBe("the agent's repository");
    expect(readFileSync(join(root, "work/home/plan.md"), "utf8")).toBe("a folder of the agent's named home");
    expect(statSync(join(root, "home")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "notes")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "work")).mode & 0o777).toBe(0o755);
    // Again: nothing more.
    expect(run("move", root).status).toBe(0);
    expect(ls(join(root, "home"))).toEqual([".config", ".local", ".memory"]);
    expect(ls(join(root, "notes"))).toEqual(["notes.db"]);
  });

  test("a toolchain it moved still runs from its HOME's PATH", () => {
    const root = store();
    expect(run("move", root).status).toBe(0);
    expect(lstatSync(join(root, "home/.local/bin/tool")).isSymbolicLink()).toBe(true);
    const ran = spawnSync("sh", ["-c", "tool"], { encoding: "utf8", env: { PATH: `${join(root, "home/.local/bin")}:/usr/bin:/bin` } });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe("moved-tool-ran");
  });

  test("back undoes it: every entry where it was, its notes in their place, but the lease, which every prepare writes anew", () => {
    const root = store();
    const before = ls(root);
    expect(run("move", root).status).toBe(0);
    expect(run("back", root).status).toBe(0);
    expect(ls(root)).toEqual(before.filter((name) => !name.startsWith(".invincible-gateway")));
    expect(readFileSync(join(root, "work"), "utf8")).toBe("a file of the agent's named work");
    expect(readFileSync(join(root, NOTES_DIR, "notes.db"), "utf8")).toBe("the agent's notes");
    expect(ls(join(root, ".memory"))).toEqual(["engram", "other"]);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
  });

  test("a store with no notes yet gets an empty tree for them, which back takes away", () => {
    const root = store({ notes: false });
    expect(run("move", root).status).toBe(0);
    expect(ls(join(root, "notes"))).toEqual([]);
    expect(ls(join(root, "home/.memory"))).toEqual(["engram", "other"]);
    expect(run("back", root).status).toBe(0);
    expect(existsSync(join(root, "notes"))).toBe(false);
    expect(ls(join(root, ".memory"))).toEqual(["other"]);
    expect(ls(root).filter((name) => name.startsWith(".invincible-layout"))).toEqual([]);
  });

  test("back takes away what the move made for its notes' mountpoint, and nothing of the agent's", () => {
    // An empty .memory of the agent's own: back leaves it where it was, empty.
    const empty = store({ notes: false });
    rmSync(join(empty, ".memory"), { recursive: true });
    mkdirSync(join(empty, ".memory"));
    expect(run("move", empty).status).toBe(0);
    expect(ls(join(empty, "home/.memory"))).toEqual(["engram"]);
    expect(run("back", empty).status).toBe(0);
    expect(ls(join(empty, ".memory"))).toEqual([]);
    // None at all: the move made one for the mountpoint, and back takes it away.
    const none = store({ notes: false });
    rmSync(join(none, ".memory"), { recursive: true });
    expect(run("move", none).status).toBe(0);
    expect(ls(join(none, "home"))).toEqual([".config", ".local", ".memory"]);
    expect(run("back", none).status).toBe(0);
    expect(existsSync(join(none, ".memory"))).toBe(false);
    expect(ls(none).filter((name) => name.startsWith(".invincible-layout"))).toEqual([]);
  });

  test("a link where its notes would be is never followed: its notes' tree is made empty, and the link moves as it is", () => {
    // Its .memory a link to a folder outside the store, with notes in it.
    const elsewhere = temp("elsewhere-");
    mkdirSync(join(elsewhere, "engram"));
    writeFileSync(join(elsewhere, "engram/notes.db"), "not the store's");
    const linked = store({ notes: false });
    rmSync(join(linked, ".memory"), { recursive: true });
    symlinkSync(elsewhere, join(linked, ".memory"));
    expect(run("move", linked).status).toBe(0);
    expect(ls(join(linked, "notes"))).toEqual([]);
    expect(lstatSync(join(linked, "home/.memory")).isSymbolicLink()).toBe(true);
    expect(ls(elsewhere)).toEqual(["engram"]);
    expect(ls(join(elsewhere, "engram"))).toEqual(["notes.db"]);
    // Its notes' folder itself a link: it stays in .memory as it is.
    const inner = store({ notes: false });
    symlinkSync(join(elsewhere, "engram"), join(inner, NOTES_DIR));
    expect(run("move", inner).status).toBe(0);
    expect(ls(join(inner, "notes"))).toEqual([]);
    expect(lstatSync(join(inner, "home", NOTES_DIR)).isSymbolicLink()).toBe(true);
    expect(ls(join(elsewhere, "engram"))).toEqual(["notes.db"]);
  });

  test("a move cut off in the middle is moved on from where it was", () => {
    const root = store();
    // As a cut leaves it: its notes and two entries staged and written down, the rest not yet.
    mkdirSync(join(root, staging("work")));
    mkdirSync(join(root, staging("home")));
    spawnSync("mv", [join(root, NOTES_DIR), join(root, staging("notes"))]);
    spawnSync("mv", [join(root, "repo"), join(root, staging("work"), "repo")]);
    spawnSync("mv", [join(root, ".config"), join(root, staging("home"), ".config")]);
    writeFileSync(join(root, MANIFEST), JSON.stringify({ layout: 2, state: "moving", moved: [{ name: NOTES_DIR, to: "notes" }, { name: "repo", to: "work" }, { name: ".config", to: "home" }], nonce: NONCE }));
    expect(run("move", root).status).toBe(0);
    expect(ls(join(root, "work"))).toEqual(WORK);
    expect(ls(join(root, "home"))).toEqual([".config", ".local", ".memory"]);
    expect(ls(join(root, "notes"))).toEqual(["notes.db"]);
    // One cut just after its notes were renamed, before that was written down: moved on, and back puts them in place.
    const renamed = store();
    writeFileSync(join(renamed, MANIFEST), JSON.stringify({ layout: 2, state: "moving", moved: [], nonce: NONCE }));
    spawnSync("mv", [join(renamed, NOTES_DIR), join(renamed, staging("notes"))]);
    expect(run("move", renamed).status).toBe(0);
    expect(ls(join(renamed, "notes"))).toEqual(["notes.db"]);
    expect(run("back", renamed).status).toBe(0);
    expect(readFileSync(join(renamed, NOTES_DIR, "notes.db"), "utf8")).toBe("the agent's notes");
    // And one cut as the trees took their names: the workspace's tree named, its HOME's and its notes' not yet.
    const other = store();
    expect(run("move", other).status).toBe(0);
    spawnSync("mv", [join(other, "home"), join(other, staging("home"))]);
    spawnSync("mv", [join(other, "notes"), join(other, staging("notes"))]);
    writeFileSync(join(other, MANIFEST), JSON.stringify({ ...JSON.parse(readFileSync(join(other, MANIFEST), "utf8")), state: "naming" }));
    expect(run("move", other).status).toBe(0);
    expect(ls(other)).toEqual([MANIFEST, "home", "lost+found", "notes", "work"]);
    expect(ls(join(other, "work"))).toContain("work");
    expect(ls(join(other, "notes"))).toEqual(["notes.db"]);
  });

  test("a store made new has its three trees, and where its notes are mounted in its HOME", () => {
    const root = temp("made-");
    expect(run("make", root).status).toBe(0);
    expect(ls(root)).toEqual([MANIFEST, "home", "notes", "work"]);
    expect(ls(join(root, "home", NOTES_DIR))).toEqual([]);
    expect(statSync(join(root, "notes")).mode & 0o777).toBe(0o700);
    // Made again: nothing changes.
    expect(run("make", root).status).toBe(0);
    expect(ls(root)).toEqual([MANIFEST, "home", "notes", "work"]);
  });
});

describe("what was at a store's root before its move (the fourth fabric review's R4-1 and R4-2)", () => {
  /*
   * In layout 1 a store's root is the agent's /work, so whatever runs in its VM can leave anything there before a move:
   * a manifest that says the move is done, links named as the trees (work -> ., home -> a folder of its own, notes -> a
   * place out of the store), and a link named as a staging folder (.invincible-layout-home -> work). None is the move's:
   * each is an entry of the agent's like any other, moved by the rule, links as links, and the trees are folders the
   * move made, which check finds so.
   */
  function planted(): { root: string; elsewhere: string } {
    const elsewhere = temp("elsewhere-");
    writeFileSync(join(elsewhere, "secret.txt"), "not-a-real-host-secret-sentinel");
    const root = store();
    writeFileSync(join(root, ".invincible-layout.json"), JSON.stringify({ layout: 2, state: "moved", moved: [] }));
    rmSync(join(root, "work"));
    rmSync(join(root, "home"), { recursive: true });
    symlinkSync(".", join(root, "work"));
    mkdirSync(join(root, "hometree"));
    symlinkSync("hometree", join(root, "home"));
    symlinkSync(elsewhere, join(root, "notes"));
    symlinkSync("work", join(root, ".invincible-layout-home"));
    symlinkSync("work", join(root, ".invincible-layout-work"));
    return { root, elsewhere };
  }

  test("a planted manifest, tree-named links and staging-named links are the agent's entries: moved by the rule, links as links", () => {
    const { root, elsewhere } = planted();
    const moved = run("move", root);
    expect(moved.status).toBe(0);
    // Its root: the move's manifest, the trees it made, and the image's lost+found. Nothing else.
    expect(ls(root)).toEqual([MANIFEST, "home", "lost+found", "notes", "work"]);
    for (const tree of ["work", "home", "notes"]) {
      expect(lstatSync(join(root, tree)).isDirectory()).toBe(true);
      expect(realpathSync(join(root, tree))).toBe(join(realpathSync(root), tree));
    }
    // The links named as trees went into the workspace's tree as they were: links, never followed.
    for (const name of ["work", "home", "notes"]) expect(lstatSync(join(root, "work", name)).isSymbolicLink()).toBe(true);
    expect(ls(join(root, "work"))).toEqual([".agent", ".eval", ".evidence", ".tmp", "home", "hometree", "notes", "out", "repo", "tasks", "work"]);
    // The planted manifest and staging links are dot-entries of its: in its HOME now, as links and a file of the agent's.
    expect(ls(join(root, "home"))).toEqual([".config", ".invincible-layout-home", ".invincible-layout-work", ".invincible-layout.json", ".local", ".memory"]);
    expect(lstatSync(join(root, "home/.invincible-layout-home")).isSymbolicLink()).toBe(true);
    // Its notes are its own, moved; nothing of the place out of the store was touched, nor reached.
    expect(ls(join(root, "notes"))).toEqual(["notes.db"]);
    expect(ls(elsewhere)).toEqual(["secret.txt"]);
    // What it moved went where the rule says: its tools' entries really are in its HOME.
    expect(readFileSync(join(root, "home/.config/tool/config.json"), "utf8")).toContain("not-a-real-secret-sentinel");
    expect(run("check", root, null).status).toBe(0);
    // And back puts each where it was, the links among them.
    expect(run("back", root).status).toBe(0);
    expect(lstatSync(join(root, "notes")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, ".invincible-layout-home")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, ".invincible-layout.json"), "utf8")).toContain('"moved"');
    expect(ls(root).filter((name) => name.startsWith(".invincible-layout-0"))).toEqual([]);
  });

  test("a manifest under the move's name that doesn't hold its word is refused: nothing is moved, nothing put back", () => {
    const root = store();
    writeFileSync(join(root, MANIFEST), JSON.stringify({ layout: 2, state: "moved", moved: [], nonce: "another" }));
    const before = ls(root);
    for (const mode of ["move", "back", "make"]) {
      const ran = run(mode, root);
      expect(ran.status).toBe(3);
      expect(ran.stderr).toContain("isn't this move's");
    }
    expect(ls(root)).toEqual(before);
  });

  test("a store holding another move's manifest (its node lost its word for it) is neither moved again nor touched (R4-6)", () => {
    const root = store();
    expect(run("move", root).status).toBe(0);
    // A move begun by a node that has no word for the one before: it would take the trees for the agent's entries.
    const again = run("move", root, "f".repeat(32));
    expect(again.status).toBe(3);
    expect(again.stderr).toContain(`the store holds another move's manifest (${MANIFEST})`);
    expect(ls(root)).toEqual([MANIFEST, "home", "lost+found", "notes", "work"]);
    expect(ls(join(root, "work"))).toEqual(WORK);
    expect(ls(join(root, "home"))).toEqual([".config", ".local", ".memory"]);
  });

  test("a move, its putting back and a store made new each need the node's word: without one nothing is done", () => {
    const root = store();
    const before = ls(root);
    for (const mode of ["move", "back", "make"]) expect(run(mode, root, null).status).toBe(3);
    expect(ls(root)).toEqual(before);
  });

  test("check: each tree a folder at the store's root, the VMs' user's; a link, a file, a missing one refused, saying which", () => {
    const made = temp("made-");
    expect(run("make", made).status).toBe(0);
    expect(run("check", made, null).status).toBe(0);
    const elsewhere = temp("elsewhere-");
    const linked = temp("linked-");
    expect(run("make", linked).status).toBe(0);
    rmSync(join(linked, "notes"), { recursive: true });
    symlinkSync(elsewhere, join(linked, "notes"));
    rmSync(join(linked, "home"), { recursive: true });
    symlinkSync("work", join(linked, "home"));
    rmSync(join(linked, "work"), { recursive: true });
    writeFileSync(join(linked, "work"), "a file");
    const refused = run("check", linked, null);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("work isn't a folder");
    expect(refused.stderr).toContain("home is a link");
    expect(refused.stderr).toContain("notes is a link");
    const missing = temp("missing-");
    expect(run("check", missing, null).stderr).toContain("work is missing; home is missing; notes is missing");
    // A store in layout 1, never moved: no tree of the move's, so nothing of it is mounted as one.
    expect(run("check", store(), null).status).toBe(3);
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
    expect(listed.stdout).not.toContain("the agent's notes");
    const entries = listed.stdout.trim().split("\n").map((line) => JSON.parse(line) as { name: string; to: string; kind: string; bytes: number });
    expect(entries.map((e) => [e.name, e.to])).toEqual([
      [".agent", "work"], [".config", "home"], [".eval", "work"], [".evidence", "work"], [".invincible-gateway-k3j2.json", "drop"], [LEASE_FILE, "drop"],
      [".local", "home"], [".memory", "home"], [NOTES_DIR, "notes"], [".tmp", "work"], ["home", "work"], ["out", "work"], ["repo", "work"], ["tasks", "work"], ["work", "work"],
    ]);
    expect(entries.find((e) => e.name === ".config")).toMatchObject({ kind: "dir" });
    expect(entries.find((e) => e.name === "work")).toMatchObject({ kind: "file", bytes: "a file of the agent's named work".length });
    expect(entries.every((e) => Number.isInteger(e.bytes) && e.bytes >= 0)).toBe(true);
    // Its notes counted once: in their own entry, not again in the folder they are in.
    const notes = entries.find((e) => e.name === NOTES_DIR)!;
    expect(notes).toMatchObject({ kind: "dir" });
    expect(notes.bytes).toBeGreaterThanOrEqual("the agent's notes".length);
    const memory = entries.find((e) => e.name === ".memory")!.bytes;
    const whole = spawnSync("python3", ["-I", "-c", "import os,sys\nt=os.lstat(sys.argv[1]).st_size\nfor d,ds,fs in os.walk(sys.argv[1]):\n  t+=sum(os.lstat(os.path.join(d,n)).st_size for n in ds+fs)\nprint(t)", join(root, ".memory")], { encoding: "utf8" });
    expect(memory + notes.bytes).toBe(Number(whole.stdout.trim()));
    // And it changed nothing.
    expect(readdirSync(root)).toContain(LEASE_FILE);
    expect(existsSync(join(root, "work"))).toBe(true);
    expect(statSync(join(root, "work")).isFile()).toBe(true);
    expect(existsSync(join(root, NOTES_DIR, "notes.db"))).toBe(true);
  });
});
