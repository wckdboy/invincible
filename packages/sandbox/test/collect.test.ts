import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCommand, COLLECT_MISSING, COLLECT_REFUSED, extractTar } from "../src/index.ts";

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

/** A folder collected as the VM collects it, with its HOME as given, into the extractor: its exit, and what was kept. */
async function collect(path: string, work: string, home: string) {
  const proc = Bun.spawn(collectCommand(path, work), { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const dest = folder();
  const [result, code] = await Promise.all([extractTar(proc.stdout, dest, { maxBytes: 1 << 20, maxFiles: 100 }, 1).catch(() => null), proc.exited]);
  const files = (result?.files ?? []).map((f) => f.path).sort();
  const read = files.map((f) => readFileSync(join(dest, f), "utf8")).join("\n");
  return { code, files, read, skipped: result?.skipped ?? [] };
}

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
