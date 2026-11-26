import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * The node backs itself up: once a day each of its databases is copied whole, as it stands at one moment, into the
 * backups folder the doctor looks in. The mind is a living copy on every full node too, but the Roundtable (team.db:
 * the knights' conversations, tasks and steps), the chats and the archive's index live on their node alone.
 *
 * A copy is SQLite's own (VACUUM INTO, from a connection that only reads), owner-only, named `<db>-nightly-<day>.db`.
 * Seven days are kept, and a Sunday's for four weeks; nothing else in the folder is ever touched (a copy you made by
 * hand stays yours). The archive's files, the uploads and the node's own keys are not copied: the first two are kept
 * whole on disk already, and a key belongs in one place. GALAHAD_BACKUPS=off turns it off.
 */

/** The databases a node keeps in its home. */
export const BACKED_UP = ["mind", "team", "chats", "local", "push", "archive"] as const;
const NIGHTLY = /^(mind|team|chats|local|push|archive)-nightly-(\d{8})\.db$/;
/** How many of the newest days are kept, and how many Sundays besides. */
export const KEEP = { days: 7, sundays: 4 } as const;

/** Where the node keeps its backups: where you said, else beside its home where one is kept already, else in it. */
export function backupDirFor(home: string, said?: string): string {
  if (said) return said;
  const beside = join(dirname(home), "backups");
  return existsSync(beside) ? beside : join(home, "backups");
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");

export interface BackupResult {
  /** The day it is for (YYYYMMDD, UTC). */
  day: string;
  /** What was copied now (none: today's were there already). */
  made: string[];
  /** Old copies of the node's own taken away. */
  removed: string[];
  /** Why one wasn't made (it is left for the next look). */
  skipped: { db: string; why: string }[];
}

/** Today's copies, made where they aren't yet; then the node's own old ones taken away past what is kept. */
export function backupOnce(home: string, dir: string, now: number = Date.now()): BackupResult {
  const day = dayOf(now);
  const result: BackupResult = { day, made: [], removed: [], skipped: [] };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const present = BACKED_UP.filter((db) => existsSync(join(home, `${db}.db`)));
  // (Room for every copy, twice over, and a gigabyte to spare: a full disk would stop the mind's writes.)
  const need = present.reduce((sum, db) => sum + statSync(join(home, `${db}.db`)).size, 0) * 2 + 2 ** 30;
  const free = (() => {
    try {
      const s = statfsSync(dir);
      return s.bavail * s.bsize;
    } catch {
      return Infinity;
    }
  })();
  for (const db of present) {
    const target = join(dir, `${db}-nightly-${day}.db`);
    if (existsSync(target)) continue;
    if (free < need) {
      result.skipped.push({ db, why: `the disk holding ${dir} has too little room` });
      continue;
    }
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    try {
      const source = new Database(join(home, `${db}.db`), { readonly: true });
      try {
        source.query("VACUUM INTO ?").run(partial);
      } finally {
        source.close();
      }
      chmodSync(partial, 0o600);
      renameSync(partial, target);
      result.made.push(target);
    } catch (error) {
      rmSync(partial, { force: true });
      result.skipped.push({ db, why: String((error as Error).message ?? error).slice(0, 200) });
    }
  }
  // Of the node's own copies, the newest days and some Sundays stay; the rest go. Nothing else here is touched.
  const days = new Set<string>();
  const own: { name: string; day: string }[] = [];
  for (const name of readdirSync(dir)) {
    const match = name.match(NIGHTLY);
    if (match) {
      own.push({ name, day: match[2]! });
      days.add(match[2]!);
    }
  }
  const newest = [...days].sort().reverse();
  const kept = new Set(newest.slice(0, KEEP.days));
  const sundays = newest.filter((d) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`).getUTCDay() === 0);
  for (const d of sundays.slice(0, KEEP.sundays)) kept.add(d);
  for (const { name, day: d } of own) {
    if (kept.has(d)) continue;
    rmSync(join(dir, name), { force: true });
    result.removed.push(join(dir, name));
  }
  return result;
}

/** Looks every hour whether today's copies are made, and makes them: a node restarted often still backs up daily. */
export class BackupRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: { home: string; dir: string; log: (line: string) => void; now?: () => number }) {}

  start(everyMs = 3_600_000, firstMs = 600_000): void {
    const look = () => {
      try {
        const done = backupOnce(this.o.home, this.o.dir, this.o.now?.() ?? Date.now());
        if (done.made.length) this.o.log(`backups: ${done.made.length} kept in ${this.o.dir} for ${done.day}${done.removed.length ? `, ${done.removed.length} old ones taken away` : ""}`);
        for (const s of done.skipped) this.o.log(`backups: ${s.db} not kept today: ${s.why}`);
      } catch (error) {
        this.o.log(`backups: ${String((error as Error).message ?? error).slice(0, 200)}`);
      }
    };
    // (They never keep a process alive on their own: the node's server does.)
    this.first = setTimeout(look, firstMs);
    this.timer = setInterval(look, everyMs);
    this.first.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }
}
