import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LiveTopic } from "@galahad/core/live";
import { type Api, ApiError } from "./api.ts";
import type { LinkHandlers, LiveLink } from "./lib/live-link.ts";
import { startLive } from "./live.ts";

/*
 * What the shell shows everywhere, kept by the node's live stream (live.ts): read once when the stream comes up, then
 * only what it says changed, each through its own route; at rest the app asks the node for nothing. Before it, the app
 * asked for ten things every 3 to 15 seconds whether anything had changed or not (about 82 requests a minute). While
 * the stream is down, a slow poll every 15 s keeps it all fresh instead.
 */

const listeners = new Map<string, () => void>();
const page = { hidden: false, addEventListener: (type: string, fn: () => void) => listeners.set(type, fn) };
const saved = { document: Object.getOwnPropertyDescriptor(globalThis, "document"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
beforeAll(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn) } });
});
afterAll(() => {
  for (const name of ["document", "window"] as const) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

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
    for (let i = 0; i < 30; i++) await Promise.resolve();
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
  return { after, now: () => now, advance, flush };
}

const ANSWERS: Record<string, unknown> = {
  "/api/fleet": { fleet: "f", name: "camelot", self: "n_1", devices: [], peers: [], events: 1, digest: "d" },
  "/api/pairings": { pairings: [] },
  "/api/secret-requests": { requests: [] },
  "/api/loops/drafts": { drafts: [] },
  "/api/connectors/requests": { requests: [] },
  "/api/about-you": { kept: [], proposed: [] },
  "/api/actions": { actions: [] },
  "/api/screen/sessions": { sessions: [] },
  "/api/questions": { questions: [] },
  "/api/notices": { notices: [] },
  "/api/team": { teammates: [], rooms: [], tasks: [], deliveries: [] },
};

function app() {
  const c = clock();
  const asked: string[] = [];
  const failing = new Set<string>();
  const api = {
    get: async (path: string) => {
      asked.push(path);
      if (failing.has(path)) {
        failing.delete(path);
        throw new TypeError("fetch failed");
      }
      if (!(path in ANSWERS)) throw new ApiError(404, "no such route");
      return structuredClone(ANSWERS[path]);
    },
  } as unknown as Api;
  let handlers: LinkHandlers | null = null;
  const calls: string[] = [];
  const link: LiveLink = { start: () => void calls.push("start"), stop: () => void calls.push("stop"), retry: () => void calls.push("retry"), attach: (h) => void (handlers = h), up: false };
  const live = startLive(api, () => true, { onNewPairing: () => {}, onNewAction: () => {} }, { link, after: c.after, now: c.now });
  const stream = {
    up: (...topics: LiveTopic[]) => handlers!.up(topics, c.now()),
    changed: (...topics: LiveTopic[]) => handlers!.changed(topics),
    down: () => handlers!.down(),
  };
  return { c, asked, failing, live, stream, calls };
}

const EVERYTHING = ["/api/fleet", "/api/pairings", "/api/secret-requests", "/api/actions", "/api/screen/sessions", "/api/questions", "/api/notices", "/api/loops/drafts", "/api/connectors/requests", "/api/about-you"];

describe("what the shell shows, kept by the node's live stream", () => {
  test("read once when the stream comes up, then nothing at all for a minute while nothing changes", async () => {
    const { c, asked, live, stream } = app();
    stream.up("fleet", "actions", "notices", "team");
    await c.flush();
    expect(asked.sort()).toEqual([...EVERYTHING].sort());
    expect(live.inboxLoaded.value).toBe(true);
    expect(live.streaming.value).toBe(true);
    asked.length = 0;
    await c.advance(60_000);
    expect(asked).toEqual([]);
    live.stop();
  });

  test("one change, one read: the route the stream named, and no other", async () => {
    const { c, asked, live, stream } = app();
    stream.up();
    await c.advance(1_000);
    asked.length = 0;
    stream.changed("actions");
    await c.advance(1_000);
    expect(asked).toEqual(["/api/actions"]);
    asked.length = 0;
    stream.changed("pairings", "notices");
    await c.advance(1_000);
    expect(asked.sort()).toEqual(["/api/notices", "/api/pairings"]);
    live.stop();
  });

  test("the team is read when it changes only while something shows it, and at most every two seconds when it is busy", async () => {
    const { c, asked, live, stream } = app();
    stream.up();
    await c.advance(1_000);
    asked.length = 0;
    stream.changed("team");
    await c.advance(5_000);
    expect(asked).toEqual([]);
    // The Roundtable comes on screen: read at once, then as it changes.
    live.watchTeam(2_000);
    await c.flush();
    expect(asked).toEqual(["/api/team"]);
    for (let i = 0; i < 5; i++) {
      stream.changed("team");
      await c.advance(100);
    }
    await c.advance(2_000);
    expect(asked).toEqual(["/api/team", "/api/team"]);
    asked.length = 0;
    await c.advance(60_000);
    expect(asked).toEqual([]);
    live.stop();
  });

  test("while the stream is down, everything is asked for at once and then every 15 s; when it is up again, the polling stops", async () => {
    const { c, asked, live, stream } = app();
    stream.down();
    await c.flush();
    expect(asked.sort()).toEqual([...EVERYTHING].sort());
    expect(live.streaming.value).toBe(false);
    asked.length = 0;
    await c.advance(60_000);
    expect(asked.filter((path) => path === "/api/actions")).toHaveLength(4);
    expect(asked).toHaveLength(4 * EVERYTHING.length);
    stream.up();
    await c.advance(1_000);
    asked.length = 0;
    await c.advance(60_000);
    expect(asked).toEqual([]);
    live.stop();
  });

  test("a read that fails after the stream said it changed is asked again a little later, and one the node doesn't have isn't", async () => {
    const { c, asked, failing, live, stream } = app();
    stream.up();
    await c.advance(1_000);
    asked.length = 0;
    failing.add("/api/notices");
    stream.changed("notices");
    await c.advance(1_000);
    expect(asked).toEqual(["/api/notices"]);
    await c.advance(5_000);
    expect(asked).toEqual(["/api/notices", "/api/notices"]);
    asked.length = 0;
    await c.advance(60_000);
    expect(asked).toEqual([]);
    live.stop();
  });

  test("hidden, the stream is closed and nothing is asked; shown again, it is opened again", async () => {
    const { c, asked, live, stream, calls } = app();
    stream.up();
    await c.advance(1_000);
    asked.length = 0;
    page.hidden = true;
    listeners.get("visibilitychange")!();
    expect(calls).toContain("stop");
    expect(live.streaming.value).toBe(false);
    stream.changed("actions");
    await c.advance(60_000);
    expect(asked).toEqual([]);
    page.hidden = false;
    listeners.get("visibilitychange")!();
    expect(calls.at(-1)).toBe("start");
    live.stop();
  });
});
