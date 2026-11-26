import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

/** Why a home can't be read, or written: said as it is, and never with a value in it. */
export class ImportError extends Error {}

/**
 * A database of another home, opened so that nothing in that home is written: no file made beside it, no byte of one
 * that is there changed. SQLite writes beside a database it only reads in two ways: a write-ahead database's log and
 * index (`-wal`, `-shm`), which a reader makes when they aren't there and sets its read marks in when they are; and a
 * rollback journal it would roll back. So how it is opened depends on what is there (measured, 26 November 2026):
 *  - write-ahead, its log holding pages (its node running, or stopped without a checkpoint): read with the index read
 *    only (`readonly_shm`), which SQLite rebuilds in memory where no writer vouches for it: the latest pages are read;
 *  - write-ahead, its log empty or gone: the database file is all there is, read as it stands (`immutable`);
 *  - a rollback journal: read under SQLite's shared lock, which writes nothing.
 * A log with pages and no index can't be read without making the index: that is refused, never made.
 */
export function openReadOnly(path: string): Database {
  if (!existsSync(path)) throw new ImportError(`${basename(path)} isn't there`);
  const header = Buffer.alloc(100);
  const fd = openSync(path, "r");
  let read: number;
  try {
    read = readSync(fd, header, 0, 100, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 100 || header.toString("latin1", 0, 16) !== "SQLite format 3\u0000") throw new ImportError(`${basename(path)} isn't a database`);
  // Bytes 18 and 19 of the header: the versions that write and read it, 2 for a write-ahead log.
  const writeAhead = header[18] === 2 || header[19] === 2;
  const logged = writeAhead && existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0;
  if (logged && !existsSync(`${path}-shm`)) {
    throw new ImportError(`${basename(path)} has pages in its write-ahead log but no index beside it, and making one would write in that home: start and stop its node once, then import again`);
  }
  const mode = !writeAhead ? "mode=ro" : logged ? "mode=ro&readonly_shm=1" : "immutable=1";
  const uri = `file:${encodeURI(path).replaceAll("?", "%3F").replaceAll("#", "%23")}?${mode}`;
  try {
    const db = new Database(uri, { readonly: true });
    // A writer of its own mid-write holds the file a moment: it is waited for, never broken into.
    if (!writeAhead) db.exec("PRAGMA busy_timeout = 5000");
    // SQLite reads the file at the first query: a damaged one says so here, and is closed.
    try {
      db.query("SELECT count(*) FROM sqlite_master").get();
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  } catch (error) {
    throw new ImportError(`${basename(path)} can't be read: ${(error as Error).message}`);
  }
}

/** The tables a database has, by name. */
export const tablesOf = (db: Database): Set<string> =>
  new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
