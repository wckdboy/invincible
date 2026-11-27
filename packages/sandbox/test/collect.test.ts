import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectCommand, collectFrom, collectSkipped, COLLECT_MISSING, COLLECT_REFUSED, COLLECT_SKIPPED_MAX, COLLECT_STDERR_MAX, extractTar } from "../src/index.ts";

/*
 * A folder of a VM's /work kept as an artifact (SandboxHost.collect, 27 November 2026): the VM writes its tar by the walk
 * (walk.ts COLLECT_SCRIPT), as the node's looks read, and the node's extractor takes it in. Here the script runs as it
 * runs in a VM (python3 -I, its HOME as the VM's), on a folder that stands for its /work, into the real extractor. Never
 * through a link out of /work; and in a VM whose HOME is its /work, never what its tools keep for themselves there,
 * here a stand-in dot-name (.tool-home), for no tool's files are named.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "invincible-collect-")));
  dirs.push(dir);
  return dir;
};

const SECRET = "not-a-real-secret-sentinel";

/** Its /work, as an agent leaves it, and beside it (outside) a folder with something of no workspace's. */
function workspace() {
  const work = folder();
  const outside = folder();
  const file = (path: string, text: string) => {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), text);
  };
  file("repo/README.md", "# Hi\n");
  file("out/report.md", "# report\n");
  file(".agent/sessions/task-a", "a session's id");
  file(".evidence/desktop/0f1e.png", "a picture");
  file(".tool-home/settings.json", `{"token":"${SECRET}"}`);
  file(".invincible-gateway.json", `{"INVINCIBLE_TOKEN":"gw_${SECRET}"}`);
  writeFileSync(join(outside, "secret"), SECRET);
  mkdirSync(join(outside, "sub"));
  writeFileSync(join(outside, "sub", "secret"), SECRET);
  return { work, outside };
}

/**
 * A folder collected as the VM collects it, with its HOME as given (and, as a VM's limit may be, `fds` open files at
 * most), into the extractor: its exit, what was kept, and what was skipped, the extractor's and the script's own.
 */
async function collect(path: string, work: string, home: string, opts: { fds?: number; maxFiles?: number } = {}) {
  const command = collectCommand(path, work);
  const argv = opts.fds ? ["sh", "-c", `ulimit -n ${opts.fds} && exec "$@"`, "sh", ...command] : command;
  const proc = Bun.spawn(argv, { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const dest = folder();
  const [result, stderr, code] = await Promise.all([extractTar(proc.stdout, dest, { maxBytes: 1 << 22, maxFiles: opts.maxFiles ?? 1000, maxEntries: 4000 }, 1).catch(() => null), new Response(proc.stderr).text(), proc.exited]);
  const files = (result?.files ?? []).map((f) => f.path).sort();
  const read = files.map((f) => readFileSync(join(dest, f), "utf8")).join("\n");
  const said = collectSkipped(stderr);
  return { code, files, read, skipped: [...(result?.skipped ?? []), ...said.named], more: said.more, stderr };
}

/** `count` FIFOs in `dir`: neither a file, a folder nor a link, so left out, and named, whoever runs the walk (root too). */
const fifos = (dir: string, count: number) =>
  expect(spawnSync("python3", ["-I", "-c", "import os, sys\nfor i in range(int(sys.argv[2])): os.mkfifo(os.path.join(sys.argv[1], 'p%05d' % i))", dir, String(count)]).status).toBe(0);

describe("what a collect left out, said within bounds (F3)", () => {
  test("the walk names a thousand at most, and counts the rest in one closing line: never a line for each", async () => {
    const { work } = workspace();
    fifos(join(work, "out"), COLLECT_SKIPPED_MAX + 100);
    const kept = await collect(join(work, "out"), work, folder());
    expect(kept.code).toBe(0);
    expect(kept.files).toEqual(["report.md"]);
    expect(kept.skipped.length).toBe(COLLECT_SKIPPED_MAX);
    expect(kept.more).toBe(100);
    expect(kept.stderr.split("\n").filter(Boolean).length).toBe(COLLECT_SKIPPED_MAX + 1);
  });

  test("read as the node reads it: the rest counted beside those named; past its cap of the VM's words, cut, and said so", async () => {
    const { work } = workspace();
    fifos(join(work, "out"), COLLECT_SKIPPED_MAX + 100);
    const read = (argv: string[]) => collectFrom(Bun.spawn(argv, { env: { ...process.env, HOME: folder() }, stdout: "pipe", stderr: "pipe" }), "/work/out", folder(), { maxBytes: 1 << 20, maxFiles: 100, maxEntries: 400 });
    const counted = (await read(collectCommand(join(work, "out"), work)))!;
    expect(counted.files.map((f) => f.path)).toEqual(["report.md"]);
    expect([counted.skipped.length, counted.skippedCount, counted.skippedCut]).toEqual([COLLECT_SKIPPED_MAX, COLLECT_SKIPPED_MAX + 100, undefined]);
    // A VM that says more of what it left out than the node reads (its own words, before the walk's): cut, and said to be.
    const words = `import json, sys\nfor i in range(4000): sys.stderr.write(json.dumps({"skipped": "out/" + "w" * 300 + str(i), "reason": "link"}) + "\\n")`;
    const cut = (await read(["sh", "-c", 'python3 -I -c "$0"; exec "$@"', words, ...collectCommand(join(work, "out"), work)]))!;
    expect(4000 * 330).toBeGreaterThan(COLLECT_STDERR_MAX);
    expect(cut.files.map((f) => f.path)).toEqual(["report.md"]);
    expect(cut.skippedCut).toBe(true);
    expect(cut.skipped.length).toBeLessThanOrEqual(COLLECT_SKIPPED_MAX);
    expect(cut.skippedCount).toBeGreaterThanOrEqual(cut.skipped.length);
  });
});

describe("a folder of a VM's workspace, kept as an artifact", () => {
  test("in a VM whose HOME is its /work, /work is kept without what its tools keep for themselves there: the workspace's own and the rest stay", async () => {
    const { work } = workspace();
    const kept = await collect(work, work, work);
    expect(kept.code).toBe(0);
    expect(kept.files).toEqual([".agent/sessions/task-a", ".evidence/desktop/0f1e.png", "out/report.md", "repo/README.md"]);
    expect(kept.read).not.toContain(SECRET);
    // In a VM whose HOME is its own, all of /work is its workspace.
    const elsewhere = await collect(work, work, folder());
    expect(elsewhere.files).toContain(".tool-home/settings.json");
  });

  test("a folder that is such an entry, or lies in one, is refused in a VM whose HOME is its /work", async () => {
    const { work } = workspace();
    mkdirSync(join(work, ".tool-home", "sub"));
    for (const path of [".tool-home", ".tool-home/sub"]) expect([path, (await collect(join(work, path), work, work)).code]).toEqual([path, COLLECT_REFUSED]);
    // One of the workspace's own is kept as any.
    expect((await collect(join(work, ".agent"), work, work)).files).toEqual(["sessions/task-a"]);
  });

  test("a link out is never followed: not on the way to the folder, nor in it; a link inside /work to the folder works", async () => {
    const { work, outside } = workspace();
    symlinkSync(outside, join(work, "away"));
    symlinkSync(join(outside, "secret"), join(work, "out", "peek"));
    symlinkSync(outside, join(work, "out", "escape"));
    // On the way: refused.
    for (const path of ["away", "away/sub"]) expect([path, (await collect(join(work, path), work, folder())).code]).toEqual([path, COLLECT_REFUSED]);
    // In the folder: kept as links, which the extractor leaves out; nothing of what they point at.
    const kept = await collect(join(work, "out"), work, folder());
    expect(kept.code).toBe(0);
    expect(kept.files).toEqual(["report.md"]);
    expect(kept.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([["out/escape", "link"], ["out/peek", "link"]]);
    expect(kept.read).not.toContain(SECRET);
    // Within /work: as ever.
    symlinkSync("out", join(work, "latest"));
    expect((await collect(join(work, "latest"), work, folder())).files).toEqual(["report.md"]);
  });

  test("a folder that isn't there says so", async () => {
    const { work } = workspace();
    expect((await collect(join(work, "nothing-here"), work, work)).code).toBe(COLLECT_MISSING);
  });
});

/*
 * Every entry kept, or named with why it wasn't (27 November 2026, the review of the walk's collecting): it opened every
 * folder of a folder as it listed it, before walking any, so past the VM's limit of open files (often 1024: a /work with
 * a node_modules) a folder it couldn't open was left out, and the collect "succeeded", partly, saying nothing. Now it
 * holds the folders of the one path it walks, no more, and an entry it can't read is named, with why.
 */
describe("a folder kept whole, or said where it isn't", () => {
  test("past the VM's limit of open files, every entry is kept: 200 folders under a limit of 64", async () => {
    const work = folder();
    for (let i = 0; i < 200; i++) {
      mkdirSync(join(work, "many", `d${i}`), { recursive: true });
      writeFileSync(join(work, "many", `d${i}`, "f"), `${i}`);
    }
    const kept = await collect(join(work, "many"), work, folder(), { fds: 64 });
    expect([kept.code, kept.files.length, kept.skipped]).toEqual([0, 200, []]);
  });

  test("an entry it can't read is named, with why: never left out in silence", async () => {
    const work = folder();
    mkdirSync(join(work, "out", "closed"), { recursive: true });
    writeFileSync(join(work, "out", "report.md"), "# report\n");
    writeFileSync(join(work, "out", "secret.md"), "unreadable");
    writeFileSync(join(work, "out", "closed", "x"), "in a folder it can't open");
    chmodSync(join(work, "out", "secret.md"), 0o000);
    chmodSync(join(work, "out", "closed"), 0o000);
    Bun.spawnSync(["mkfifo", join(work, "out", "pipe")]);
    try {
      const kept = await collect(join(work, "out"), work, folder());
      expect(kept.code).toBe(0);
      expect(kept.files).toEqual(["report.md"]);
      expect(kept.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
        ["out/closed", "it can't be read here (PermissionError)"],
        ["out/pipe", "neither a file, a folder nor a link"],
        ["out/secret.md", "it can't be read here (PermissionError)"],
      ]);
    } finally {
      chmodSync(join(work, "out", "secret.md"), 0o644);
      chmodSync(join(work, "out", "closed"), 0o755);
    }
  });
});

