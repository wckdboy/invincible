import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDirFor, backupOnce, BackupRunner, KEEP } from "../src/backups.ts";

/* The node's own daily backups (backups.ts), in a scratch home: real SQLite files, copied as SQLite copies them. */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), "galahad-backups-"));
  dirs.push(root);
  const dir = join(root, "home");
  mkdirSync(dir);
  for (const name of ["mind", "team"]) {
    const db = new Database(join(dir, `${name}.db`));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('kept');");
    db.close();
  }
  return { root, dir };
}
const at = (iso: string) => Date.parse(`${iso}T03:00:00Z`);

test("once a day each of its databases is copied whole, owner-only, and a copy opens and reads as the database did", () => {
  const h = home();
  const out = join(h.root, "backups");
  const first = backupOnce(h.dir, out, at("2026-11-20"));
  expect(first.made.map((p) => p.split("/").at(-1)).sort()).toEqual(["mind-nightly-20261120.db", "team-nightly-20261120.db"]);
  expect(first.skipped).toEqual([]);
  for (const path of first.made) {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const copy = new Database(path, { readonly: true });
    expect(copy.query("SELECT x FROM t").get()).toEqual({ x: "kept" });
    copy.close();
  }
  // Again the same day: nothing more. (No partial file is ever left where a copy is looked for.)
  expect(backupOnce(h.dir, out, at("2026-11-20") + 3_600_000).made).toEqual([]);
  expect(readdirSync(out).some((name) => name.endsWith(".partial"))).toBe(false);
});

test("seven days are kept and a Sunday's for four weeks; a copy you made by hand is never touched", () => {
  const h = home();
  const out = join(h.root, "backups");
  mkdirSync(out);
  writeFileSync(join(out, "mind-before-compute-20261111-230446.db"), "yours");
  // Forty days of copies, one a day.
  for (let d = 0; d < 40; d++) backupOnce(h.dir, out, at("2026-10-12") + d * 86_400_000);
  const days = [...new Set(readdirSync(out).flatMap((name) => name.match(/-nightly-(\d{8})\.db$/)?.slice(1) ?? []))].sort();
  // The newest seven (14–20 November) and the four newest Sundays (one of them among the seven).
  expect(days.slice(-KEEP.days)).toEqual(["20261114", "20261115", "20261116", "20261117", "20261118", "20261119", "20261120"]);
  const sundays = days.filter((d) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`).getUTCDay() === 0);
  expect(sundays).toEqual(["20261025", "20261101", "20261108", "20261115"]);
  expect(days.length).toBe(KEEP.days + 3);
  expect(existsSync(join(out, "mind-before-compute-20261111-230446.db"))).toBe(true);
});

test("where they are kept: where you said, else beside the home where a backups folder is, else in it", () => {
  const h = home();
  expect(backupDirFor(h.dir, "/srv/galahad-backups")).toBe("/srv/galahad-backups");
  expect(backupDirFor(h.dir)).toBe(join(h.dir, "backups"));
  mkdirSync(join(h.root, "backups"));
  expect(backupDirFor(h.dir)).toBe(join(h.root, "backups"));
});

test("started, it looks a little after the node starts and every hour after, and says what it kept", async () => {
  const h = home();
  const lines: string[] = [];
  const runner = new BackupRunner({ home: h.dir, dir: join(h.root, "backups"), log: (line) => lines.push(line), now: () => at("2026-11-20") });
  runner.start(60_000, 5);
  for (let i = 0; i < 100 && !lines.length; i++) await Bun.sleep(10);
  runner.stop();
  expect(lines).toEqual([`backups: 2 kept in ${join(h.root, "backups")} for 20261120`]);
});
