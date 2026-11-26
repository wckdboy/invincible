/*
 * A child of vanish.test.ts: opens one database of an old home with openReadOnly while a file beside it (its rollback
 * journal, or its write-ahead log) vanishes the moment a look first finds it there, as when the write it holds ends
 * between one look and the next. It mocks node:fs, which is why it runs in a process of its own: a test run keeps a
 * module's mock for every file after it. Prints what came of it, {"ok":true} or {"error":"…"}.
 */
import { mock } from "bun:test";
import * as fs from "node:fs";

const [database, vanishing] = process.argv.slice(2) as [string, string];
const real = { existsSync: fs.existsSync, statSync: fs.statSync, rmSync: fs.rmSync };
let gone = false;
/** What the first look that finds it there says stands; then it is gone, and the next look finds nothing. */
const looked = <T>(path: unknown, result: T): T => {
  if (!gone && path === vanishing && result) {
    gone = true;
    real.rmSync(vanishing);
  }
  return result;
};
mock.module("node:fs", () => ({
  ...fs,
  existsSync: (path: fs.PathLike) => looked(path, real.existsSync(path)),
  statSync: (path: fs.PathLike, options?: fs.StatSyncOptions) => looked(path, real.statSync(path, options as never)),
}));
const { openReadOnly } = await import("../../src/import/sqlite.ts");
try {
  openReadOnly(database).close();
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ error: (error as Error).message }));
}
