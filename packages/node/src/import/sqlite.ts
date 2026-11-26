import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

/** Why a home can't be read, or written: said as it is, and never with a value in it. */
export class ImportError extends Error {}

/**
 * A database of another home, opened so that nothing in that home is written and no lock it holds is taken, whether its
 * node is running or not. SQLite writes beside a database it only reads in two ways: a write-ahead database's log and
 * index (`-wal`, `-shm`), which a reader makes when they aren't there and sets its read marks in when they are; and a
 * rollback journal it would roll back. So how it is opened depends on what it is, and what is beside it (measured, 26
 * November 2026):
 *  - write-ahead (a mind, a ledger): with its index read only (`readonly_shm`) whenever its log and index are there,
 *    SQLite rebuilding the index in memory where no writer vouches for it, so the latest pages are read; as an immutable
 *    file when there is no log to read; refused when its log holds pages and its index is gone (making one would write
 *    there). A reader of a write-ahead log never stands in a writer's way.
 *  - a rollback journal (the agents', the chats'): a reader's shared lock would make a writer without a busy timeout
 *    fail there and then, as both systems' stores of agents and chats are, so it is never locked: its bytes are read
 *    whole until they hold still (no write's journal beside them, the same size and time before and after) and check
 *    whole, and that copy is read, in memory.
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
  try {
    return writeAhead ? logged(path) : copied(path);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(`${basename(path)} can't be read: ${(error as Error).message}`);
  }
}

function logged(path: string): Database {
  const [wal, shm] = [`${path}-wal`, `${path}-shm`];
  if (existsSync(wal) && statSync(wal).size > 0 && !existsSync(shm)) {
    throw new ImportError(`${basename(path)} has pages in its write-ahead log but no index beside it, and making one would write in that home: start and stop its node once, then import again`);
  }
  const mode = existsSync(wal) && existsSync(shm) ? "mode=ro&readonly_shm=1" : "immutable=1";
  const db = new Database(`file:${encodeURI(path).replaceAll("?", "%3F").replaceAll("#", "%23")}?${mode}`, { readonly: true });
  // SQLite reads the file at the first query: a damaged one says so here, and is closed.
  try {
    db.query("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** How long a copy waits for a write under way to end: ten tries, a little longer apart each time (about two seconds). */
const TRIES = 10;
const APART_MS = 50;

function copied(path: string): Database {
  const journal = `${path}-journal`;
  const writing = () => existsSync(journal) && statSync(journal).size > 0;
  let why = "it kept changing while it was read";
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) Bun.sleepSync(APART_MS * attempt);
    if (writing()) {
      why = "a write's journal stays beside it (one a stopped node left is rolled back when that node starts again)";
      continue;
    }
    const before = statSync(path);
    const bytes = readFileSync(path);
    const after = statSync(path);
    if (writing() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      why = "it kept changing while it was read";
      continue;
    }
    const db = Database.deserialize(new Uint8Array(bytes), true);
    const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
    if (check.length === 1 && check[0]!.quick_check === "ok") return db;
    db.close();
    why = "it isn't whole (SQLite's check of it fails)";
  }
  throw new ImportError(`${basename(path)} can't be read: ${why}; import again in a moment`);
}

/** The tables a database has, by name. */
export const tablesOf = (db: Database): Set<string> =>
  new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
