import { describe, expect, test } from "bun:test";
import { LIVE_TOPICS, type LiveTopic, routes, SCOPES } from "@invincible/core";
import { LiveChanges, LedgerCounts, mindTopics, type Stamps, timedStamp } from "../src/live.ts";

/*
 * What changed on a node, for the live stream (live.ts): each topic's stamp read again soon after a write, as a deadline
 * it names comes, and every LOOK_MS while anyone listens, and only the topics whose stamps moved told; nothing read while
 * nobody listens.
 */

/** Stamps held in hand: `set` one, and count how often each was read. */
function stamps() {
  const values = Object.fromEntries(LIVE_TOPICS.map((t) => [t, "0"])) as Record<LiveTopic, string>;
  const reads = { n: 0 };
  const table = Object.fromEntries(
    LIVE_TOPICS.map((t) => [
      t,
      () => {
        reads.n += 1;
        return values[t];
      },
    ]),
  ) as Stamps;
  return { table, reads, set: (topic: LiveTopic, value: string) => (values[topic] = value) };
}

describe("the topics", () => {
  test("each names a route a device reads: a GET under one of the scopes", () => {
    for (const topic of LIVE_TOPICS) {
      const route = routes[topic];
      expect([topic, route.method, SCOPES.includes(route.scope as (typeof SCOPES)[number])]).toEqual([topic, "GET", true]);
    }
  });

  test("the stream itself is a GET a device reads under mind:read, with nothing to send", () => {
    expect(routes.live).toEqual({ method: "GET", path: "/api/live", scope: "mind:read", input: null });
  });
});

describe("what changed", () => {
  test("a poke is read soon, and only the topics whose stamps moved are told, together", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 5 });
    const told: LiveTopic[][] = [];
    const stop = live.subscribe((topics) => told.push(topics));
    s.set("actions", "1");
    s.set("notices", "1");
    live.poke();
    live.poke();
    await Bun.sleep(30);
    expect(told).toEqual([["actions", "notices"]]);
    // Read again with nothing moved: nothing told.
    live.poke();
    await Bun.sleep(30);
    expect(told).toHaveLength(1);
    stop();
  });

  test("what no write pokes for (an agent's work, a turn's end) is told within a look", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 20 });
    const told: LiveTopic[][] = [];
    const stop = live.subscribe((topics) => told.push(topics));
    s.set("team", "7.0");
    await Bun.sleep(80);
    expect(told).toEqual([["team"]]);
    stop();
  });

  test("nothing is read while nobody listens, and a poke then does nothing", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 10, soonMs: 1 });
    live.poke();
    await Bun.sleep(40);
    expect(s.reads.n).toBe(0);
    const stop = live.subscribe(() => {});
    expect(live.listening).toBe(1);
    await Bun.sleep(40);
    expect(s.reads.n).toBeGreaterThan(0);
    stop();
    expect(live.listening).toBe(0);
    const after = s.reads.n;
    await Bun.sleep(40);
    expect(s.reads.n).toBe(after);
  });

  test("a stamp that fails is read as unchanged and said once; the others are still told", async () => {
    const s = stamps();
    let broken = false;
    const lines: string[] = [];
    const live = new LiveChanges(
      {
        ...s.table,
        runs: () => {
          if (broken) throw new Error("the board is gone");
          return "q";
        },
      },
      { everyMs: 60_000, soonMs: 1, log: (line) => lines.push(line) },
    );
    const told: LiveTopic[][] = [];
    const stop = live.subscribe((topics) => told.push(topics));
    broken = true;
    s.set("fleet", "2");
    live.poke();
    await Bun.sleep(15);
    live.poke();
    await Bun.sleep(15);
    expect(told).toEqual([["fleet"]]);
    expect(lines).toEqual(["live: runs's stamp failed: the board is gone"]);
    stop();
  });

  test("a listener that throws keeps no other from being told", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 1 });
    const told: LiveTopic[][] = [];
    const stopBad = live.subscribe(() => {
      throw new Error("its own trouble");
    });
    const stop = live.subscribe((topics) => told.push(topics));
    s.set("turns", "x");
    live.poke();
    await Bun.sleep(15);
    expect(told).toEqual([["turns"]]);
    stopBad();
    stop();
  });
});

describe("where a stream stood: the cursor it is opened again from", () => {
  test("a stream opened while another listens has in its hello what was written before it opened, whatever the look waits on", () => {
    const s = stamps();
    // Its poke's look a minute off: as on a starved machine, where the next slice of CPU may be a second away.
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 60_000 });
    const first: LiveTopic[][] = [];
    const stopFirst = live.subscribe((topics) => first.push(topics));
    const before = live.at();
    s.set("turns", "1");
    live.poke();
    // (And one that nothing poked for: another process's write, say.)
    s.set("team", "1");
    const second: LiveTopic[][] = [];
    const stopSecond = live.subscribe((topics) => second.push(topics));
    // Its hello: where things stand now, and what moved since a cursor from before the writes.
    expect(live.since(before)).toEqual(["team", "turns"]);
    expect(live.at()).not.toBe(before);
    // The one already listening is told at once; the new one has it in its hello, and is told nothing more of it.
    expect(first).toEqual([["team", "turns"]]);
    expect(second).toEqual([]);
    stopFirst();
    stopSecond();
  });

  test("each change comes with where things stand after it; resumed from there with nothing changed since, nothing changed", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 1 });
    const told: [LiveTopic[], string][] = [];
    const stop = live.subscribe((topics, at) => told.push([topics, at]));
    const opened = live.at();
    expect(live.since(opened)).toEqual([]);
    s.set("actions", "1");
    live.poke();
    await Bun.sleep(15);
    expect(told.map(([topics]) => topics)).toEqual([["actions"]]);
    const after = told[0]![1];
    expect(after).toBe(live.at());
    expect(after).not.toBe(opened);
    expect(live.since(opened)).toEqual(["actions"]);
    // Read again with nothing moved: it stands where it stood.
    live.poke();
    await Bun.sleep(15);
    expect(live.at()).toBe(after);
    expect(live.since(after)).toEqual([]);
    stop();
  });

  test("resumed from further back, it is told what moved since then, each once, and only that", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 1 });
    const stop = live.subscribe(() => {});
    const before = live.at();
    s.set("actions", "1");
    live.poke();
    await Bun.sleep(15);
    const between = live.at();
    s.set("notices", "1");
    s.set("actions", "2");
    live.poke();
    await Bun.sleep(15);
    expect(live.since(before)).toEqual(["actions", "notices"]);
    expect(live.since(between)).toEqual(["actions", "notices"]);
    s.set("team", "9");
    live.poke();
    await Bun.sleep(15);
    expect(live.since(between)).toEqual(["actions", "notices", "team"]);
    expect(live.since(live.at())).toEqual([]);
    stop();
  });

  test("what moved while nobody listened (nothing read then) counts once someone listens again", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 10, soonMs: 1 });
    const stop = live.subscribe(() => {});
    const left = live.at();
    stop();
    const reads = s.reads.n;
    s.set("team", "7");
    s.set("fleet", "2");
    // Something moved back as it was: no change at all.
    s.set("notices", "1");
    s.set("notices", "0");
    await Bun.sleep(40);
    expect(s.reads.n).toBe(reads);
    const again = live.subscribe(() => {});
    expect(live.since(left)).toEqual(["fleet", "team"]);
    expect(live.since(live.at())).toEqual([]);
    again();
    // And with nothing moved while nobody listened, nothing more moves.
    const quiet = live.at();
    live.subscribe(() => {})();
    expect(live.at()).toBe(quiet);
  });

  test("a reader's cursor moves only with what it may read and says nothing of the rest, nor does one past it", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 1 });
    const narrow: LiveTopic[] = ["actions", "notices"];
    const told: string[] = [];
    const stop = live.subscribe((_, at) => told.push(at));
    const left = live.at(narrow);
    s.set("secretRequests", "1");
    live.poke();
    await Bun.sleep(15);
    s.set("pairings", "1");
    live.poke();
    await Bun.sleep(15);
    // Two moves of what it may not read: it stands where it stood, and nothing it reads changed.
    expect(live.at(narrow)).toBe(left);
    expect(live.since(left, narrow)).toEqual([]);
    // A reader of everything's cursor stands past it: no cursor to it, so asking from one tells it nothing.
    expect(live.since(live.at(), narrow)).toBeNull();
    expect(live.since(live.at())).toEqual([]);
    expect(live.since(left)).toEqual(["pairings", "secretRequests"]);
    s.set("notices", "1");
    live.poke();
    await Bun.sleep(15);
    const now = live.at(narrow);
    expect(now).not.toBe(left);
    expect(told.at(-1)).toBe(now);
    expect(live.since(left, narrow)).toEqual(["notices"]);
    // What it is given says neither where things stand nor how far they moved: a sealed block, one length for any count.
    expect([left, now, live.at()].every((cursor) => /^[A-Za-z0-9_-]{22}$/.test(cursor))).toBe(true);
    stop();
  });

  test("a cursor it can't answer for is no cursor: another boot's, one altered, or one that isn't one", async () => {
    const s = stamps();
    const live = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 1 });
    const other = new LiveChanges(s.table, { everyMs: 60_000, soonMs: 1 });
    const stop = live.subscribe(() => {});
    const first = live.at();
    s.set("runs", "1");
    live.poke();
    await Bun.sleep(15);
    expect(live.since(first)).toEqual(["runs"]);
    // Another boot's (the node started again): each tracker seals under its own key.
    expect(other.at()).not.toBe(first);
    expect(other.since(first)).toBeNull();
    expect(live.since(other.at())).toBeNull();
    // Altered by a character, spelled another way, or not one at all.
    const altered = `${first.slice(0, 5)}${first[5] === "A" ? "B" : "A"}${first.slice(6)}`;
    for (const cursor of [null, undefined, "", "b00t.0", altered, `${first}A`, first.slice(1), "A".repeat(22), `${first.slice(0, 21)}${first[21] === "A" ? "B" : "A"}`]) expect([cursor, live.since(cursor)]).toEqual([cursor, null]);
    stop();
  });
});

describe("the mind's part", () => {
  test("each event kind touches what shows it, and the ledger nothing", () => {
    expect(mindTopics("action.requested")).toEqual(["actions"]);
    expect(mindTopics("order.revoked")).toEqual(["actions"]);
    expect(mindTopics("notice.dismissed")).toEqual(["notices"]);
    expect(mindTopics("secret.request.dismissed")).toEqual(["secretRequests"]);
    expect(mindTopics("secret.set")).toEqual(["secretRequests"]);
    expect(mindTopics("memory.forgotten")).toEqual(["aboutYou"]);
    expect(mindTopics("screen.decided")).toEqual(["screenSessions"]);
    expect(mindTopics("device.revoked")).toEqual(["fleet", "screenSessions"]);
    expect(mindTopics("node.profile")).toEqual(["fleet", "screenSessions"]);
    expect(mindTopics("connector.set")).toEqual(["connectorRequests"]);
    expect(mindTopics("ledger.recorded")).toEqual([]);
    expect(mindTopics("loop.ran")).toEqual([]);
  });

  test("counted by topic; a replay counts as every topic moving", () => {
    const counts = new LedgerCounts();
    expect(counts.take([{ kind: "ledger.recorded" }], false)).toBe(false);
    expect(counts.take([{ kind: "action.requested" }, { kind: "action.decided" }, { kind: "notice.raised" }], false)).toBe(true);
    expect([counts.of("actions"), counts.of("notices"), counts.of("team")]).toEqual([2, 1, 0]);
    expect(counts.take([], true)).toBe(true);
    expect(LIVE_TOPICS.every((topic) => counts.of(topic) >= 1)).toBe(true);
  });
});

describe("a deadline a stamp names", () => {
  test("wakes the stream as it comes: told then, with no poke, long before the look", async () => {
    const s = stamps();
    const due = Date.now() + 60;
    const table: Stamps = { ...s.table, actions: timedStamp(() => 0, () => [{ due }], (item) => item.due) };
    const live = new LiveChanges(table, { everyMs: 60_000, soonMs: 1 });
    const start = Date.now();
    const told: { topics: LiveTopic[]; after: number }[] = [];
    const stop = live.subscribe((topics) => told.push({ topics, after: Date.now() - start }));
    await Bun.sleep(250);
    stop();
    expect(told.map((t) => t.topics)).toEqual([["actions"]]);
    // Not before its time, and soon after it.
    expect(told[0]!.after).toBeGreaterThanOrEqual(due - start);
    expect(told[0]!.after).toBeLessThan(due - start + 100);
  });

  test("leaves nothing waiting once nobody listens: its time comes and nothing is read", async () => {
    const s = stamps();
    const due = Date.now() + 40;
    let reads = 0;
    const table: Stamps = { ...s.table, actions: timedStamp(() => 0, () => (reads++, [{ due }]), (item) => item.due) };
    const live = new LiveChanges(table, { everyMs: 60_000, soonMs: 1 });
    live.subscribe(() => {})();
    const after = reads;
    await Bun.sleep(120);
    expect(reads).toBe(after);
  });
});

describe("a list whose states move with the clock", () => {
  test("its deadline passing moves the stamp, as a write does, and it is read again only then", () => {
    let now = 1_000;
    let version = 0;
    let reads = 0;
    const items = [{ due: 5_000 }, { due: 9_000 }, { due: null as number | null }];
    const stamp = timedStamp(
      () => version,
      () => {
        reads += 1;
        return items;
      },
      (item) => item.due,
      () => now,
    );
    const first = stamp();
    expect(stamp()).toBe(first);
    now = 4_999;
    expect(stamp()).toBe(first);
    expect(reads).toBe(1);
    // The first deadline comes: the answer is another now.
    now = 5_000;
    const second = stamp();
    expect(second).not.toBe(first);
    expect(reads).toBe(2);
    expect(stamp()).toBe(second);
    // A write moves it too, and reads the list again.
    version = 1;
    const third = stamp();
    expect(third).not.toBe(second);
    expect(reads).toBe(3);
    now = 9_000;
    expect(stamp()).not.toBe(third);
    // No deadline left: it stays as it is.
    const last = stamp();
    now = 1e12;
    expect(stamp()).toBe(last);
  });
});
