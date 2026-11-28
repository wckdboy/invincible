import type { RouteName } from "./api.ts";

/*
 * The live stream (`routes.live`, GET /api/live): one signed answer from your node that stays open and says what
 * changed, never what it holds. Each topic is the name of a route whose answer changed, and a device reads that route
 * again, signed as every request is: each route's scope and its own filters stay the only door to what it holds. A
 * device is told only of the topics whose route's scope it holds, and the stream is for your own devices alone.
 *
 * It opens with `hello`, the topics it will tell of: read each now, for what changed while nothing was listening. Then
 * `changed` as things change, each topic named once however often it changed meanwhile, and `bye` when what it was
 * opened under is gone: the device revoked or its scopes changed, the node stopping, or too many open from that device
 * (the oldest goes). A comment comes every LIVE_BEAT_MS between them, so a device can tell a quiet stream from a dead
 * one, and the hello says that beat (`beat`, absent from a node older than it), so a device of any age holds a stream
 * to its own node's: silent for three beats, it is gone. A phone tells a dead link (a half-open connection, a node gone
 * from the network) within seconds that way, and a turn's stream beats as often. Server-sent events, as a turn's stream
 * is: `data: <json>` and a blank line.
 *
 * It resumes. The hello and each change say where things stand (`at`, a cursor: opaque to a device, and short, in
 * characters a URL carries as they are, LIVE_CURSOR), and a device opens it again from the last it was given
 * (livePath: GET /api/live?since=<cursor>). The hello then says which of its topics changed since (`changed`), and the
 * device reads those alone, not everything: a stream renewed with nothing changed (a stall on a busy node or network,
 * three beats long) costs the one request that opens it, where it cost a read of every route. A device's cursor moves
 * only with what it may read, and the node seals it, so it tells nothing of the rest: not where things stand, not how
 * far they moved, and none can be made up. `changed` comes only when the node can answer for that cursor; one it can't
 * (another boot's, one past any it gave that device, or a since that isn't a cursor at all) is no cursor, and the hello
 * is a fresh one: read everything. A since that isn't a cursor is never refused (400), because a fresh hello is always
 * a right answer and a refusal would leave a device that kept a bad one without its stream until its code dropped it.
 * An older node ignores the query and says no `at`, and an older device sends none: each reads everything on a hello,
 * as before. The signature covers the query as sent, as it covers every path, which is why a cursor holds nothing a URL
 * would escape. A device trusts `changed` only from a stream it opened from a cursor that tells of the same topics as
 * the stream before it (otherwise its scopes changed: read everything).
 *
 * A few topics are told more coarsely than their route answers, on purpose; the pages that show the rest ask for it:
 *  - `fleet`: a device joined, left or changed, or a node went on- or offline; not a node's load or round trip, nor
 *    the mind's count of events.
 *  - `turns`: a turn began or ended, or your chats changed; not each step a turn takes.
 *  - `runs`: a run began or ended, changed its state or fell silent; not each step it reports.
 *  - `ledger`: a line was recorded, told at most every LIVE_LEDGER_MS. While agents work a line comes with each command
 *    they run, so it is told once in that time, not once a command. Its route answers the latest lines, and the mind's
 *    count of events as it is read. The count isn't told apart: it moves with what a device may not read (a key asked
 *    for), and this stream tells such a device nothing of that. A line a device isn't shown (a private connector's, to
 *    one without fleet:admin) moves it too: it says the ledger moved, not what moved.
 *
 * And one is told a little more widely than its route answers: `notify` moves when what your notifications' settings show
 * moves (who is told and how sends to them went, what was sent, lost or withdrawn), and when a notification is kept for a
 * device that collects its own, which collects it then (the Mac app). A keeping is a sending, which the day's sent list
 * shows too; a device's own collecting moves nothing.
 */

/** What the stream tells of: each the name of a route a device reads, a GET under one scope. */
export const LIVE_TOPICS = [
  "fleet",
  "pairings",
  "secretRequests",
  "loopDrafts",
  "connectorRequests",
  "aboutYou",
  "actions",
  "screenSessions",
  "questions",
  "notices",
  "notify",
  "runs",
  "team",
  "turns",
  "ledger",
] as const satisfies readonly RouteName[];
export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** Why a stream ended (it is opened again; a device that was revoked is refused then). */
export type LiveBye = "revoked" | "rescoped" | "stopping" | "replaced";

export type LiveEvent =
  /**
   * The topics this stream tells of: read each now, or, with `changed`, only those of them that changed since the
   * cursor it was opened from. `beat`: how often a comment comes between events (LIVE_BEAT_MS). `at`: where things
   * stand, to open it again from (absent from a node older than it).
   */
  | { type: "hello"; topics: LiveTopic[]; beat?: number; at?: string; changed?: LiveTopic[] }
  /** These changed: read them again. `at`: where things stand after them (absent from a node older than it). */
  | { type: "changed"; topics: LiveTopic[]; at?: string }
  | { type: "bye"; reason: LiveBye };

/**
 * What a cursor of the stream is (`at`, and `since` opening it again): short, and only characters a URL carries as
 * they are, so the path a device signs is byte for byte the path its node reads back. A device keeps one only when it
 * is one; the node takes `since` only when it is one (core's LiveCursor, api.ts).
 */
export const LIVE_CURSOR = /^[A-Za-z0-9_.-]{1,64}$/;

/** The stream's path, opened again from where the last left off (`since`, a cursor its node gave) when there is one. */
export function livePath(since?: string | null): string {
  return since && LIVE_CURSOR.test(since) ? `/api/live?since=${since}` : "/api/live";
}

/**
 * A comment comes on the stream (and on a turn's) this often: one silent for three of them is gone, so a dead link is
 * told within 4.5 s, while a stream still waiting for its hello (HELLO_WAIT, 3 s) is never taken for dead first. Fifteen
 * bytes a beat, only while a device is in front; it was 15 s until 26 November 2026, which left a phone on a half-open
 * connection for 45 s.
 */
export const LIVE_BEAT_MS = 1_500;

/** `ledger` is told at most this often: the first line after a quiet spell at once, the rest of a busy one together. */
export const LIVE_LEDGER_MS = 5_000;
