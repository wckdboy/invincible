import { describe, expect, test } from "bun:test";
import { LIVE_BEAT_MS, type LiveEvent, type LiveTopic } from "@invincible/core/live";
import { type FirstRead, Followers, GAP_MS, HELLO_WAIT_MS, type LinkHandlers, liveLink, RETRY_FIRST_MS, RETRY_MAX_MS, SILENT_MS, STEADY_MS } from "./live-link.ts";

/*
 * The node's live stream as the app keeps it (live-link.ts): open while the app is shown, opened again when it ends
 * (at once after a long one, backing off after failures, never on a timer once the node refused it), taken for dead
 * when it says nothing, and opened again from where it left off; and what the app reads, run once when it comes up
 * (resumed: only what changed since, never read, or owed), then only for what changed, polled only while it is down.
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
  const opened: { push(event: LiveEvent): void; beat(): void; end(): void; fail(error: unknown): void; signal: AbortSignal; since: string | null }[] = [];
  let refuseWith: unknown = null;
  const open = (signal: AbortSignal, alive: () => void, since: string | null): AsyncIterable<LiveEvent> => {
    const queue: (LiveEvent | { end: true } | { fail: unknown })[] = [];
    let wake: (() => void) | null = null;
    const put = (item: (typeof queue)[number]) => {
      queue.push(item);
      wake?.();
    };
    signal.addEventListener("abort", () => put({ fail: new DOMException("aborted", "AbortError") }));
    const refusal = refuseWith;
    opened.push({ push: (event) => (alive(), put(event)), beat: () => alive(), end: () => put({ end: true }), fail: (error) => put({ fail: error }), signal, since });
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
    up: (topics, _at, changed) => told.push(`up ${topics.join(",")}${changed ? ` changed:${changed.join(",")}` : ""}`),
    changed: (topics) => told.push(`changed ${topics.join(",")}`),
    down: () => told.push("down"),
  };
  const l = liveLink({ open: s.open, refused: (error) => error instanceof Refused, after: c.after, now: c.now });
  l.attach(handlers);
  return { c, s, told, l };
}

const hello = (...topics: LiveTopic[]): LiveEvent => ({ type: "hello", topics });
const changed = (...topics: LiveTopic[]): LiveEvent => ({ type: "changed", topics });
/** A node's of today: where things stand with each, and with a hello opened from a cursor, what changed since. */
const helloAt = (at: string, topics: LiveTopic[], since?: LiveTopic[]): LiveEvent => ({ type: "hello", topics, at, ...(since ? { changed: since } : {}) });
const changedAt = (at: string, ...topics: LiveTopic[]): LiveEvent => ({ type: "changed", topics, at });

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
    // Open a while, beating as a node does (three silent beats and it would be gone).
    for (let at = 0; at < STEADY_MS; at += LIVE_BEAT_MS) {
      await c.advance(LIVE_BEAT_MS);
      s.last().beat();
    }
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

describe("the stream, opened again from where it left off", () => {
  test("it is opened again from the last cursor its node gave, a hello's or a change's; that hello says only what changed since", async () => {
    const { c, s, told, l } = link();
    l.start();
    expect(s.last().since).toBeNull();
    s.last().push(helloAt("b00t.4", ["actions", "notices"]));
    s.last().push(changedAt("b00t.5", "actions"));
    await c.flush();
    s.last().end();
    await c.advance(RETRY_FIRST_MS);
    expect(s.last().since).toBe("b00t.5");
    s.last().push(helloAt("b00t.7", ["actions", "notices"], ["notices"]));
    await c.flush();
    // Nothing changed since: nothing to read but the stream.
    s.last().end();
    await c.advance(2 * RETRY_FIRST_MS);
    expect(s.last().since).toBe("b00t.7");
    s.last().push(helloAt("b00t.7", ["actions", "notices"], []));
    await c.flush();
    expect(told).toEqual(["up actions,notices", "changed actions", "up actions,notices changed:notices", "up actions,notices changed:"]);
  });

  test("hidden and shown again, it opens from where it left off; renewed as it went silent, too", async () => {
    const { c, s, l } = link();
    l.start();
    s.last().push(helloAt("b00t.3", ["fleet"]));
    await c.flush();
    l.stop();
    l.start();
    expect(s.last().since).toBe("b00t.3");
    s.last().push(helloAt("b00t.3", ["fleet"], []));
    await c.advance(SILENT_MS);
    await c.advance(RETRY_FIRST_MS);
    expect(s.opened.length).toBe(3);
    expect(s.last().since).toBe("b00t.3");
  });

  test("with no cursor from its node (an older node) or one that isn't one, it opens afresh, and a stream opened afresh is read as fresh", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().push(hello("fleet"));
    await c.flush();
    // Each ends soon after it opened, and is opened again after its wait (a second, then twice as long each time).
    let wait = RETRY_FIRST_MS;
    const again = async () => {
      s.last().end();
      await c.advance(wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    };
    await again();
    expect(s.last().since).toBeNull();
    for (const notOne of ["a b", "", "b00t.1?x=1", "x".repeat(65)]) {
      s.last().push(helloAt(notOne, ["fleet"]));
      await c.flush();
      await again();
      expect([notOne, s.last().since]).toEqual([notOne, null]);
    }
    // (What a hello says changed means nothing from a stream not opened from a cursor.)
    s.last().push(helloAt("b00t.2", ["fleet"], []));
    await c.flush();
    expect(told.at(-1)).toBe("up fleet");
  });

  test("a hello that tells of other topics than the stream before it (the device's scopes changed) is read as a fresh one", async () => {
    const { c, s, told, l } = link();
    l.start();
    s.last().push(helloAt("b00t.1", ["actions", "secretRequests"]));
    await c.flush();
    s.last().end();
    await c.advance(RETRY_FIRST_MS);
    expect(s.last().since).toBe("b00t.1");
    s.last().push(helloAt("b00t.2", ["actions"], []));
    // And what one says changed is held to what it tells of.
    s.last().end();
    await c.advance(2 * RETRY_FIRST_MS);
    s.last().push(helloAt("b00t.3", ["actions"], ["actions", "pairings"]));
    await c.flush();
    expect(told).toEqual(["up actions,secretRequests", "up actions", "up actions changed:actions"]);
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

  test("resumed, only what changed since runs, with what never read; what nothing changed of runs not at all", async () => {
    const { c, f, runs, follow } = followers();
    follow("inbox", ["actions", "notices"], 15_000);
    follow("fleet", ["fleet"], 15_000);
    follow("team", ["team"], 2_000, "later");
    await c.advance(1_000);
    f.up(c.now(), ["notices", "pairings"]);
    await c.advance(GAP_MS);
    expect(runs.sort()).toEqual(["inbox notices", "team"]);
    runs.length = 0;
    f.up(c.now(), []);
    await c.advance(60_000);
    expect(runs).toEqual([]);
  });

  test("what the app's going to the background called off is owed, and runs once the stream is up again, resumed or not", async () => {
    const { c, f, runs, follow } = followers();
    follow("inbox", ["actions"], 15_000, "owner", 2_000);
    follow("fleet", ["fleet"], 15_000, "owner", 2_000);
    f.up(c.now());
    await c.advance(100);
    // Told of a change it waits its gap to read, and the app hidden before it did.
    f.changed(["actions"]);
    f.off();
    await c.advance(10_000);
    expect(runs).toEqual([]);
    f.up(c.now(), []);
    await c.advance(GAP_MS);
    expect(runs).toEqual(["inbox actions"]);
  });

  test("told of a change while the app is hidden (a read asked again), it is owed, and runs once the stream is up again", async () => {
    const { c, f, runs, follow } = followers();
    follow("notices", ["notices"], 15_000);
    f.off();
    f.changed(["notices"]);
    await c.advance(60_000);
    expect(runs).toEqual([]);
    f.up(c.now(), []);
    await c.advance(GAP_MS);
    expect(runs).toEqual(["notices notices"]);
  });

  test("a run that failed is owed: never tried again on its own, run again once the stream is up again, with what changes meanwhile", async () => {
    const c = clock();
    const f = new Followers(c.after, c.now);
    const runs: (readonly LiveTopic[] | null)[] = [];
    let failing = true;
    f.follow(["actions", "notices"], (changed) => {
      runs.push(changed);
      if (failing) return Promise.reject(new Error("the node is away"));
    }, 15_000, GAP_MS, "owner");
    f.up(c.now());
    await c.advance(GAP_MS);
    f.changed(["actions"]);
    await c.advance(60_000);
    expect(runs).toEqual([["actions"]]);
    failing = false;
    f.up(c.now(), []);
    await c.advance(GAP_MS);
    expect(runs).toEqual([["actions"], ["actions"]]);
    // Paid: nothing owed now.
    f.up(c.now(), []);
    await c.advance(60_000);
    expect(runs).toHaveLength(2);
    // Owed and told of another change: both in the one run.
    failing = true;
    f.changed(["actions"]);
    await c.advance(GAP_MS);
    failing = false;
    f.changed(["notices"]);
    await c.advance(GAP_MS);
    expect(runs.at(-1)).toEqual(["notices", "actions"]);
  });

  test("a run under way when the stream comes up again that then fails runs once more at once: nothing else would read it", async () => {
    const c = clock();
    const f = new Followers(c.after, c.now);
    const runs: (readonly LiveTopic[] | null)[] = [];
    let finish: (ok: boolean) => void = () => {};
    f.follow(["actions"], (changed) => {
      runs.push(changed);
      return new Promise<void>((resolve, reject) => (finish = (ok) => (ok ? resolve() : reject(new Error("the network went")))));
    }, 15_000, GAP_MS, "owner");
    f.up(c.now());
    await c.advance(GAP_MS);
    f.changed(["actions"]);
    await c.flush();
    // Its read hangs on the network that went; the stream renewed meanwhile says nothing changed since (it told this).
    await c.advance(1_000);
    f.up(c.now(), []);
    await c.flush();
    expect(runs).toEqual([["actions"]]);
    finish(false);
    await c.advance(GAP_MS);
    expect(runs).toEqual([["actions"], ["actions"]]);
    // Once: one that fails again is owed, as any is.
    finish(false);
    await c.advance(60_000);
    expect(runs).toHaveLength(2);
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
