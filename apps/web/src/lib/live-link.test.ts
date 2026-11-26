import { describe, expect, test } from "bun:test";
import type { LiveEvent, LiveTopic } from "@galahad/core/live";
import { type FirstRead, Followers, GAP_MS, HELLO_WAIT_MS, type LinkHandlers, liveLink, RETRY_FIRST_MS, RETRY_MAX_MS, SILENT_MS, STEADY_MS } from "./live-link.ts";

/*
 * The node's live stream as the app keeps it (live-link.ts): open while the app is shown, opened again when it ends
 * (at once after a long one, backing off after failures, never on a timer once the node refused it), taken for dead
 * when it says nothing; and what the app reads, run once when it comes up, then only for what changed, polled only
 * while it is down.
 */

/** A clock in hand: `advance` runs what comes due, in order. */
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
  return { after, now: () => now, advance, flush, pending: () => timers.filter((t) => !t.off).map((t) => t.at - now) };
}

/** Streams the test opens and feeds: each `open` is one, with its events pushed and its end or failure said. */
function streams() {
  const opened: { push(event: LiveEvent): void; beat(): void; end(): void; fail(error: unknown): void; signal: AbortSignal }[] = [];
  let refuseWith: unknown = null;
  const open = (signal: AbortSignal, alive: () => void): AsyncIterable<LiveEvent> => {
    const queue: (LiveEvent | { end: true } | { fail: unknown })[] = [];
    let wake: (() => void) | null = null;
    const put = (item: (typeof queue)[number]) => {
      queue.push(item);
      wake?.();
    };
    signal.addEventListener("abort", () => put({ fail: new DOMException("aborted", "AbortError") }));
    const refusal = refuseWith;
    opened.push({ push: (event) => (alive(), put(event)), beat: () => alive(), end: () => put({ end: true }), fail: (error) => put({ fail: error }), signal });
    return {
      async *[Symbol.asyncIterator]() {
        if (refusal) throw refusal;
        for (;;) {
          while (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
          const item = queue.shift()!;
          if ("end" in item) return;
          if ("fail" in item) throw item.fail;
          yield item;
        }
      },
    };
  };
  return { open, opened, refuse: (error: unknown) => (refuseWith = error), last: () => opened.at(-1)! };
}

class Refused extends Error {}

function link() {
  const c = clock();
  const s = streams();
  const told: string[] = [];
  const handlers: LinkHandlers = {
    up: (topics) => told.push(`up ${topics.join(",")}`),
    changed: (topics) => told.push(`changed ${topics.join(",")}`),
    down: () => told.push("down"),
  };
  const l = liveLink({ open: s.open, refused: (error) => error instanceof Refused, after: c.after, now: c.now });
  l.attach(handlers);
  return { c, s, told, l };
}

const hello = (...topics: LiveTopic[]): LiveEvent => ({ type: "hello", topics });
const changed = (...topics: LiveTopic[]): LiveEvent => ({ type: "changed", topics });

describe("the stream, kept open", () => {
  test("its hello says what it tells of, and each change after is passed on", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().push(hello("actions", "team"));
    s.last().push(changed("actions"));
    await c.flush();
    expect(told).toEqual(["up actions,team", "changed actions"]);
    expect(l.up).toBe(true);
  });

  test("one that can't be opened is down at once, and tried again a second later, then twice as long each time, up to half a minute", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().fail(new TypeError("fetch failed"));
    await c.flush();
    expect(told).toEqual(["down"]);
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      gaps.push(Math.min(...c.pending()));
      const before = s.opened.length;
      await c.advance(gaps.at(-1)!);
      expect(s.opened.length).toBe(before + 1);
      s.last().fail(new TypeError("fetch failed"));
      await c.flush();
    }
    expect(gaps).toEqual([RETRY_FIRST_MS, 2_000, 4_000, 8_000, 16_000, RETRY_MAX_MS, RETRY_MAX_MS]);
    // Down was said once, not at every failure.
    expect(told).toEqual(["down"]);
  });

  test("one that was open a while is opened again at once when it ends (the node restarting), and isn't down if it's back soon", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().push(hello("fleet"));
    await c.advance(STEADY_MS);
    s.last().push({ type: "bye", reason: "stopping" });
    // (At once: on the next tick.)
    await c.advance(0);
    expect(s.opened.length).toBe(2);
    await c.advance(HELLO_WAIT_MS - 1);
    s.last().push(hello("fleet"));
    await c.flush();
    expect(told).toEqual(["up fleet", "up fleet"]);
  });

  test("one that ends soon after it opened waits a second before it's opened again, and is down if it isn't back in time", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().push(hello("fleet"));
    await c.flush();
    s.last().end();
    await c.flush();
    expect(s.opened.length).toBe(1);
    await c.advance(RETRY_FIRST_MS);
    expect(s.opened.length).toBe(2);
    await c.advance(HELLO_WAIT_MS);
    expect(told).toEqual(["up fleet", "down"]);
  });

  test("one the node refuses (no stream on an older node, a device that may not) is down, and not tried again on a timer", async () => {
    const { c, s, told, l } = link();
    s.refuse(new Refused("404"));
    l.start();
    await c.flush();
    expect(told).toEqual(["down"]);
    expect(c.pending()).toEqual([]);
    await c.advance(10 * 60_000);
    expect(s.opened.length).toBe(1);
    // The network back, or the app shown again: tried again then.
    s.refuse(null);
    l.retry();
    s.last().push(hello("notices"));
    await c.flush();
    expect(told).toEqual(["down", "up notices"]);
  });

  test("one that says nothing at all for a while is taken for dead and opened again; its beats keep it alive", async () => {
    const { c, s, l } = link();
    l.start();
    s.last().push(hello("fleet"));
    for (let i = 0; i < 5; i++) {
      await c.advance(SILENT_MS - 1);
      s.last().beat();
    }
    expect(s.opened.length).toBe(1);
    await c.advance(SILENT_MS);
    expect(s.opened[0]!.signal.aborted).toBe(true);
    await c.advance(RETRY_FIRST_MS);
    expect(s.opened.length).toBe(2);
  });

  test("one that is open but says no hello (a proxy holding it back) is down after a while, and stays open meanwhile", async () => {
    const { c, s, told, l } = link();
    l.start();
    await c.advance(HELLO_WAIT_MS);
    expect(told).toEqual(["down"]);
    expect(s.last().signal.aborted).toBe(false);
    s.last().push(hello("turns"));
    await c.flush();
    expect(told).toEqual(["down", "up turns"]);
  });

  test("stopped (the app hidden), it is closed and opened no more until started", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().push(hello("fleet"));
    await c.flush();
    l.stop();
    await c.advance(10 * 60_000);
    expect(s.opened.length).toBe(1);
    expect(s.opened[0]!.signal.aborted).toBe(true);
    expect(told).toEqual(["up fleet"]);
    l.start();
    expect(s.opened.length).toBe(2);
  });

  test("who attaches later is told at once where it stands", async () => {
    const { c, s, l } = link();
    l.start();
    s.last().push(hello("pairings"));
    await c.flush();
    const late: string[] = [];
    l.attach({ up: (topics) => late.push(`up ${topics.join(",")}`), changed: () => {}, down: () => late.push("down") });
    expect(late).toEqual(["up pairings"]);
  });
});

describe("what the app reads", () => {
  function followers() {
    const c = clock();
    const f = new Followers(c.after, c.now);
    const runs: string[] = [];
    const follow = (name: string, topics: LiveTopic[], everyMs: number | null, first: FirstRead = "owner", gapMs?: number) =>
      f.follow(topics, (changed) => void runs.push(`${name}${changed ? ` ${changed.join(",")}` : ""}`), everyMs, gapMs, first);
    return { c, f, runs, follow };
  }

  test("when the stream comes up, what was read before its hello is read once, and what was read since is not; at rest, nothing for a minute", async () => {
    const { c, f, runs, follow } = followers();
    // Nothing of the Inbox read yet; the fleet read by its page at once; the team read after the stream said hello.
    follow("inbox", ["actions", "notices"], 15_000, "later");
    follow("fleet", ["fleet"], 15_000);
    await c.advance(200);
    follow("team", ["team"], 2_000);
    f.up(100);
    // (The fleet no sooner than its gap after its page read it.)
    await c.advance(GAP_MS);
    expect(runs).toEqual(["inbox", "fleet"]);
    await c.advance(60_000);
    expect(runs).toHaveLength(2);
    f.changed(["notices", "team"]);
    await c.advance(GAP_MS);
    expect(runs).toEqual(["inbox", "fleet", "inbox notices", "team team"]);
  });

  test("one its owner just read waits its gap before a change runs it again", async () => {
    const { c, f, runs, follow } = followers();
    f.up(0);
    await c.advance(1_000);
    follow("team", ["team"], 2_000, "owner", 2_000);
    f.changed(["team"]);
    await c.advance(1_999);
    expect(runs).toEqual([]);
    await c.advance(1);
    expect(runs).toEqual(["team team"]);
  });

  test("while the stream is down each runs at once and then at its own pace; up again, the polling stops", async () => {
    const { c, f, runs, follow } = followers();
    follow("fleet", ["fleet"], 15_000);
    follow("room", ["team"], 2_000);
    f.down();
    await c.advance(15_000);
    expect(runs.filter((r) => r === "fleet")).toHaveLength(2);
    expect(runs.filter((r) => r === "room")).toHaveLength(8);
    runs.length = 0;
    await c.advance(500);
    f.up(c.now());
    // Each once, for what changed while it was down (no sooner than its gap after its last run), then nothing.
    await c.advance(60_000);
    expect(runs.sort()).toEqual(["fleet", "room"]);
  });

  test("changes while one runs are merged into one more run after it, no closer than its gap", async () => {
    const c = clock();
    const f = new Followers(c.after, c.now);
    const runs: (readonly LiveTopic[] | null)[] = [];
    let finish: () => void = () => {};
    f.follow(["actions", "notices", "questions"], (changed) => {
      runs.push(changed);
      return new Promise<void>((resolve) => (finish = resolve));
    }, null, 1_000, "later");
    f.up(c.now());
    await c.flush();
    f.changed(["actions"]);
    f.changed(["notices"]);
    f.changed(["actions"]);
    await c.advance(5_000);
    expect(runs).toEqual([null]);
    finish();
    await c.advance(999);
    expect(runs).toEqual([null, ["actions", "notices"]]);
  });

  test("one that keeps its own time while the stream is down runs once then, and isn't polled", async () => {
    const { c, f, runs, follow } = followers();
    follow("underway", ["team", "turns"], null);
    f.down();
    await c.advance(60_000);
    expect(runs).toEqual(["underway"]);
  });

  test("off (the app hidden), nothing runs, whatever changes; one that stopped following is never run", async () => {
    const { c, f, runs, follow } = followers();
    const stop = follow("gone", ["fleet"], 1_000);
    follow("inbox", ["actions"], 1_000);
    stop();
    f.down();
    await c.advance(1_500);
    f.off();
    runs.length = 0;
    f.changed(["actions"]);
    await c.advance(60_000);
    expect(runs).toEqual([]);
  });
});
