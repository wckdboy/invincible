import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MindStore, PullState } from "../../packages/mind/src/index.ts";
import type { Suite, SuiteContext } from "../lib.ts";
import { buildLog, lateEvent } from "../mind/log.ts";

/*
 * The mind: what the replicated log costs as it grows. A log shaped like a real
 * one is built at each size (bench/mind/log.ts: every event signed and chained),
 * and each thing the daemon does with it is timed: what it does every few
 * seconds (a frontier, the set hashes, answering a pull), what it does when
 * something arrives (an append, a late entry, a hole's repair), and what it does
 * rarely (a rebuild).
 *
 * `scripts/bench-mind.ts` times the same at 5k, 40k and 400k events (minutes);
 * these sizes fit a few seconds, four times apart, so a cost that grows with the
 * log shows as about four times the time.
 */

const SIZES = [4_000, 16_000];
const SIZES_FULL = [64_000];

function measure(ctx: SuiteContext, n: number, full: boolean): void {
  const id = `${full ? "full." : ""}mind.n${n}`;
  const started = performance.now();
  const log = buildLog(n);
  ctx.speed(`${id}.sign-and-build`, [(performance.now() - started) / n], "ms", "lower", [started, performance.now()], "an event signed, chained and written, with the views built at the end");
  const opened: MindStore[] = [];
  try {
    ctx.time(`${id}.open`, () => new MindStore(log.path).close(), { n: 5, warm: 1, note: "opening the replica" });
    const store = new MindStore(log.path);
    opened.push(store);
    const self = { have: store.frontier(), digests: store.deviceDigests() };
    // A peer missing one of the sandbox host's older events (a partial delivery).
    const holePath = join(log.dir, "hole.db");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(log.path, holePath);
    const hole = new MindStore(holePath);
    hole.db.query("DELETE FROM events WHERE id = ?").run(log.oldB[0]!);
    hole.rebuild();
    const holed = { have: hole.frontier(), digests: hole.deviceDigests() };
    hole.close();
    // A peer ten events behind on the sandbox host.
    const recent = store.db.query<{ hlc: string }, [string]>("SELECT hlc FROM events WHERE device = ? ORDER BY hlc DESC LIMIT 1 OFFSET 10").get(log.b.id)!.hlc;
    const behind = { have: { ...self.have, [log.b.id]: recent }, digests: self.digests };

    // Every few seconds, for every peer.
    ctx.time(`${id}.frontier`, () => store.frontier(), { batch: 50 });
    ctx.time(`${id}.set-hashes`, () => store.deviceDigests(), { batch: 20, note: "each device's count and set hash (with every pull)" });
    ctx.time(`${id}.answer-pull-in-sync`, () => store.eventsSince(self.have, 500, self.digests), { batch: 20 });
    ctx.time(`${id}.answer-pull-10-behind`, () => store.eventsSince(behind.have, 500, behind.digests), { batch: 10 });
    let page = 0;
    ctx.time(`${id}.answer-pull-with-a-hole`, () => (page = store.eventsSince(holed.have, 500, holed.digests).events.length), { batch: 10, note: "a peer missing one old event: it's told which device to walk, not sent the log" });
    ctx.quality(`${id}.hole-answer-events`, page, "events", "lower", { note: "events in the answer that finds a hole (never the log)" });
    ctx.time(`${id}.last-slot`, () => store.lastSlot("heartbeat", log.b.id), { batch: 200, note: "each loop, every tick" });
    ctx.time(`${id}.ledger-200`, () => store.ledger(200), { batch: 5 });
    ctx.time(`${id}.state-digest`, () => store.digest(), { batch: 50, note: "kept until the views change" });

    // When something arrives.
    ctx.time(`${id}.append`, () => store.remember(log.a, "one more thing", { prov: { trust: "agent" } }), { n: 15, note: "an event this node writes: signed, checked, applied" });
    for (const kind of ["ledger.recorded", "memory.added"] as const) {
      const samples: number[] = [];
      let replays = 0;
      const from = performance.now();
      for (let i = 0; i < 5; i++) {
        const event = lateEvent(store, log.c, kind);
        const t = performance.now();
        const result = store.ingest([event]);
        samples.push(performance.now() - t);
        if (result.added !== 1) throw new Error(`a late arrival should be added: ${JSON.stringify(result)}`);
        if (result.rebuilt) replays++;
      }
      const name = kind === "memory.added" ? "late-memory" : "late-ledger-entry";
      ctx.speed(`${id}.${name}`, samples, "ms", "lower", [from, performance.now()], kind === "memory.added" ? "an event dated before the log's newest that others' verdicts may read: the log replays" : "the common late arrival (a busy node's sandbox execs): applied in place");
      ctx.quality(`${id}.${name}-replays`, replays, "of 5", "lower", { note: kind === "memory.added" ? "by design: only a ledger entry or a loop run is applied in place" : "a late ledger entry must never replay the log" });
    }
    const duplicates = store.eventsSince({}, 500).events;
    ctx.time(`${id}.500-already-held`, () => store.ingest(duplicates), { n: 5, warm: 1, note: "a page of events it holds: skipped before any signature is checked" });

    // The holed peer pulls until it's whole: every page, both sides, end to end.
    const holedStore = new MindStore(holePath);
    opened.push(holedStore);
    const pull = new PullState(holedStore);
    pull.begin();
    let pages = 0;
    let largest = 0;
    const from = performance.now();
    for (;;) {
      const { have, sets, after } = pull.request(true);
      const answer = store.eventsSince(have, 500, sets, after);
      largest = Math.max(largest, answer.events.length);
      pages++;
      if (!pull.receive(answer).more) break;
    }
    ctx.speed(`${id}.hole-repair`, [performance.now() - from], "ms", "lower", [from, performance.now()], `a hole found and filled, end to end, in ${pages} pages`);
    ctx.quality(`${id}.hole-repaired`, holedStore.event(log.oldB[0]!) !== null && holedStore.digest() === store.digest() ? 1 : 0, "", "higher", { note: "the peer holds the missing event and the same state" });
    ctx.quality(`${id}.largest-page`, largest, "events", "lower", { note: "no answer is ever more than a page (500)" });

    // Rarely: everything again from the log.
    const before = store.digest();
    ctx.time(`${id}.rebuild`, () => store.rebuild(), { n: 3, warm: 0, note: "every view from the log again" });
    ctx.quality(`${id}.rebuild-same-state`, store.digest() === before ? 1 : 0, "", "higher", { note: "a rebuild gives the state it had" });
  } finally {
    for (const s of opened) s.close();
    try {
      rmSync(log.dir, { recursive: true, force: true });
    } catch {
      /* a file still held on Windows: the temp directory is the OS's to clear */
    }
  }
}

export const suite: Suite = {
  name: "mind",
  about: "what the replicated log costs at 4,000 and 16,000 events: what stays flat, and what grows with it",
  headline: [
    "mind.n16000.rebuild-same-state",
    "mind.n16000.hole-repaired",
    "mind.n16000.late-ledger-entry-replays",
    "mind.n4000.answer-pull-in-sync",
    "mind.n16000.answer-pull-in-sync",
    "mind.n4000.append",
    "mind.n16000.append",
    "mind.n4000.late-memory",
    "mind.n16000.late-memory",
    "mind.n4000.rebuild",
    "mind.n16000.rebuild",
    "mind.n16000.sign-and-build",
  ],
  run(ctx) {
    for (const n of SIZES) {
      measure(ctx, n, false);
      ctx.log(`${n.toLocaleString("en-US")} events: built and timed`);
    }
    if (ctx.full) for (const n of SIZES_FULL) measure(ctx, n, true);
  },
};
