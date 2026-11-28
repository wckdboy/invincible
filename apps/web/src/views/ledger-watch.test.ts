import { expect, test } from "bun:test";
import type { Api } from "../api.ts";
import { Followers, GAP_MS } from "../lib/live-link.ts";
import { watchLedger } from "./activity.ts";

/*
 * The ledger kept in step with the node by its live stream (speed, 28 November 2026): the pages that show it (Activity,
 * the Overview) read it as a line is recorded, never at rest. Before, the Overview read it every 15 s and the fleet every
 * 10 s, for the mind's count (ten reads a minute with nothing changed), and Activity read it every 10 s.
 */

/** A clock in hand: timers run only as it is advanced. */
function clock() {
  let now = 0;
  const timers: { at: number; run: () => void; off: boolean }[] = [];
  const after = (ms: number, run: () => void) => {
    const timer = { at: now + ms, run, off: false };
    timers.push(timer);
    return () => void (timer.off = true);
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = timers.filter((t) => !t.off && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.off = true;
      now = due.at;
      due.run();
    }
    now = end;
    await flush();
  };
  return { after, now: () => now, advance };
}

/** A node in hand that counts what is asked of it, holding the mind's count of events. */
function ledgerNode() {
  const reads: string[] = [];
  let events = 12;
  const api = { get: async (path: string) => (reads.push(path), { entries: [], events }) } as unknown as Api;
  return { api, reads, recorded: () => void (events += 1) };
}

test("at rest it reads the ledger once, as its page opens, and not again in a minute; a line recorded is read once, with the mind's count", async () => {
  const c = clock();
  const f = new Followers(c.after, c.now);
  const node = ledgerNode();
  const counts: number[] = [];
  const shown = new AbortController();
  f.up(c.now());
  watchLedger(node.api, shown.signal, (topics, run, everyMs, gapMs) => f.follow(topics, run, everyMs, gapMs), { seen: (view) => void counts.push(view.events ?? -1), failed: () => {}, downMs: 15_000 });
  await c.advance(60_000);
  // Its page's own read, and nothing at rest: before, ten in this minute.
  expect(node.reads).toEqual(["/api/ledger"]);
  // A line recorded: the stream says `ledger` moved, and it is read once, the mind's count with it.
  node.recorded();
  f.changed(["ledger"]);
  await c.advance(GAP_MS);
  expect(node.reads).toHaveLength(2);
  expect(counts).toEqual([12, 13]);
  // What else moves isn't its to read: nothing more for another minute.
  f.changed(["fleet", "team", "turns", "notify"]);
  await c.advance(60_000);
  expect(node.reads).toHaveLength(2);
  shown.abort();
});

test("while the stream is down it reads at its own pace; up again, it stops; its page gone, nothing more", async () => {
  const c = clock();
  const f = new Followers(c.after, c.now);
  const node = ledgerNode();
  const shown = new AbortController();
  watchLedger(node.api, shown.signal, (topics, run, everyMs, gapMs) => f.follow(topics, run, everyMs, gapMs), { seen: () => {}, failed: () => {}, downMs: 15_000 });
  f.down();
  await c.advance(60_000);
  const whileDown = node.reads.length;
  // (Its own read, then at once and every 15 s while down: no fewer than four in the minute.)
  expect(whileDown).toBeGreaterThanOrEqual(4);
  f.up(c.now());
  await c.advance(GAP_MS);
  const upAgain = node.reads.length;
  await c.advance(60_000);
  expect(node.reads).toHaveLength(upAgain);
  f.down();
  shown.abort();
  await c.advance(60_000);
  expect(node.reads).toHaveLength(upAgain);
});
