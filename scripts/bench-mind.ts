// What the mind's periodic work costs as the log grows.
//
//   bun scripts/bench-mind.ts                 5k, 40k and 400k events (400k takes a few minutes to sign)
//   bun scripts/bench-mind.ts 5000 40000      just these sizes
//
// Each size gets its own temp home with a log shaped like a real one (bench/mind/log.ts), every event really
// signed and chained. Then each operation the daemon does on a timer is timed (median of several runs). Nothing
// here touches ~/.galahad. `bun run bench mind` times the same operations at sizes that fit a few seconds, with a
// baseline to read them against (docs/BENCHMARKS.md).
import { Database } from "bun:sqlite";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildLog, lateEvent } from "../bench/mind/log.ts";
import { MindStore, PullState } from "../packages/mind/src/index.ts";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = sizes.length ? sizes : [5_000, 40_000, 400_000];
const RUNS = 7;

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function time(fn: () => unknown, runs = RUNS): number {
  fn(); // warm the statement cache
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

type Row = Record<string, string>;

function bench(n: number): Row {
  const started = performance.now();
  const fleet = buildLog(n);
  const built = performance.now() - started;
  const row: Row = { events: n.toLocaleString("en-US") };
  const opened: MindStore[] = [];
  try {
    let openMs = 0;
    {
      const t = performance.now();
      new MindStore(fleet.path).close();
      openMs = performance.now() - t;
    }
    const store = new MindStore(fleet.path);
    opened.push(store);
    const self = { have: store.frontier(), digests: store.deviceDigests() };
    // A peer missing one of b's older events (a partial delivery).
    const holePath = join(fleet.dir, "hole.db");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(fleet.path, holePath);
    const hole = new MindStore(holePath);
    hole.db.query("DELETE FROM events WHERE id = ?").run(fleet.oldB[0]!);
    hole.rebuild();
    const holed = { have: hole.frontier(), digests: hole.deviceDigests() };
    hole.close();
    // A peer ten events behind on the sandbox host.
    const recent = store.db
      .query<{ hlc: string }, [string]>("SELECT hlc FROM events WHERE device = ? ORDER BY hlc DESC LIMIT 1 OFFSET 10")
      .get(fleet.b.id)!.hlc;
    const behind = { have: { ...self.have, [fleet.b.id]: recent }, digests: self.digests };

    row["open"] = openMs.toFixed(1);
    // First start on a replica from before schema versions: the same log, the old schema.
    {
      const old = join(fleet.dir, "old.db");
      copyFileSync(holePath, old);
      const raw = new Database(old);
      raw.exec(`DROP TABLE IF EXISTS log_devices; DROP TABLE IF EXISTS v_slots; DROP TABLE IF EXISTS v_chainbad;
        DROP INDEX IF EXISTS events_kind; DROP INDEX IF EXISTS events_loop; DROP INDEX IF EXISTS events_device_order;
        CREATE INDEX IF NOT EXISTS events_device ON events (device, hlc); PRAGMA user_version = 0;`);
      raw.close();
      const t = performance.now();
      new MindStore(old).close();
      row["first start, migrating"] = (performance.now() - t).toFixed(0);
    }
    row["frontier"] = time(() => store.frontier()).toFixed(1);
    row["deviceDigests"] = time(() => store.deviceDigests()).toFixed(1);
    row["eventsSince in sync"] = time(() => store.eventsSince(self.have, 500, self.digests)).toFixed(1);
    row["eventsSince 10 behind"] = time(() => store.eventsSince(behind.have, 500, behind.digests)).toFixed(1);
    let holeEvents = 0;
    row["eventsSince hole"] = time(() => (holeEvents = store.eventsSince(holed.have, 500, holed.digests).events.length), 3).toFixed(1);
    row["hole page size"] = String(holeEvents);
    row["lastSlot"] = time(() => store.lastSlot("heartbeat", fleet.b.id)).toFixed(2);
    row["loopRuns(1)"] = time(() => store.loopRuns("heartbeat", 1)).toFixed(2);
    row["loopRuns never ran"] = time(() => store.loopRuns("never-ran", 1)).toFixed(2);
    row["ledger(200)"] = time(() => store.ledger(200)).toFixed(1);
    row["eventCount"] = time(() => store.eventCount()).toFixed(1);
    row["state digest"] = time(() => store.digest()).toFixed(1);
    row["emit (append)"] = time(() => store.remember(fleet.a, "one more thing", { prov: { trust: "agent" } })).toFixed(2);
    // Each late arrival is a fresh event; time only its ingest. A late ledger entry is the
    // common case (a busy node's sandbox execs reaching the others); a late memory still replays.
    for (const kind of ["ledger.recorded", "memory.added"] as const) {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const event = lateEvent(store, fleet.c, kind);
        const t = performance.now();
        const result = store.ingest([event]);
        if (result.added !== 1) throw new Error(`a late arrival should be added: ${JSON.stringify(result)}`);
        samples.push(performance.now() - t);
      }
      row[kind === "memory.added" ? "late memory" : "late ledger entry"] = median(samples).toFixed(1);
    }
    // The holed peer pulls until it's whole: every page, both sides, end to end.
    {
      const holedStore = new MindStore(holePath);
      opened.push(holedStore);
      const pull = new PullState(holedStore);
      pull.begin();
      let pages = 0;
      let slowest = 0;
      const t = performance.now();
      for (;;) {
        const page = performance.now();
        const { have, sets, after } = pull.request(true);
        const more = pull.receive(store.eventsSince(have, 500, sets, after)).more;
        slowest = Math.max(slowest, performance.now() - page);
        pages++;
        if (!more) break;
      }
      row["hole repair, end to end"] = (performance.now() - t).toFixed(0);
      row["hole repair, pages"] = String(pages);
      row["hole repair, slowest page"] = slowest.toFixed(1);
      if (holedStore.event(fleet.oldB[0]!) === null) throw new Error("the hole wasn't repaired");
    }
    const duplicates = store.eventsSince({}, 500).events;
    row["ingest 500 duplicates"] = time(() => store.ingest(duplicates), 3).toFixed(0);
    row["full rebuild"] = time(() => store.rebuild(), 3).toFixed(0);
  } finally {
    for (const s of opened) s.close();
    try {
      rmSync(fleet.dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`  (left ${fleet.dir}: ${(error as Error).message})`);
    }
  }
  console.error(`  ${n} events: built in ${(built / 1000).toFixed(1)} s`);
  return row;
}

const rows: Row[] = [];
for (const n of SIZES) {
  console.error(`building ${n} events…`);
  rows.push(bench(n));
}
const keys = Object.keys(rows[0]!);
console.log(`| Operation (ms, median) | ${rows.map((r) => r.events).join(" | ")} |`);
console.log(`|---|${rows.map(() => "---:").join("|")}|`);
for (const key of keys.slice(1)) console.log(`| ${key} | ${rows.map((r) => r[key]).join(" | ")} |`);
