import { describe, expect, test } from "bun:test";
import { LIVE_TOPICS, type LiveTopic, routes, SCOPES } from "@galahad/core";
import { LiveChanges, MindCounts, mindTopics, type Stamps, timedStamp } from "../src/live.ts";

/*
 * What changed on a node, for the live stream (live.ts): each topic's stamp read again soon after a write and four times
 * a second while anyone listens, and only the topics whose stamps moved told; nothing read while nobody listens.
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

  test("what no write pokes for (a knight's work, a turn's end) is told within a look", async () => {
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
        quests: () => {
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
    expect(lines).toEqual(["live: quests's stamp failed: the board is gone"]);
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
    const counts = new MindCounts();
    expect(counts.take([{ kind: "ledger.recorded" }], false)).toBe(false);
    expect(counts.take([{ kind: "action.requested" }, { kind: "action.decided" }, { kind: "notice.raised" }], false)).toBe(true);
    expect([counts.of("actions"), counts.of("notices"), counts.of("team")]).toEqual([2, 1, 0]);
    expect(counts.take([], true)).toBe(true);
    expect(LIVE_TOPICS.every((topic) => counts.of(topic) >= 1)).toBe(true);
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
