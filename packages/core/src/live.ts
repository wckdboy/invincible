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
 * A few topics are told more coarsely than their route answers, on purpose; the pages that show the rest ask for it:
 *  - `fleet`: a device joined, left or changed, or a node went on- or offline; not a node's load or round trip, nor
 *    the mind's count of events.
 *  - `turns`: a turn began or ended, or your chats changed; not each step a turn takes.
 *  - `runs`: a run began or ended, changed its state or fell silent; not each step it reports.
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
  "runs",
  "team",
  "turns",
] as const satisfies readonly RouteName[];
export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** Why a stream ended (it is opened again; a device that was revoked is refused then). */
export type LiveBye = "revoked" | "rescoped" | "stopping" | "replaced";

export type LiveEvent =
  /** The topics this stream tells of: read each now. `beat`: how often a comment comes between events (LIVE_BEAT_MS). */
  | { type: "hello"; topics: LiveTopic[]; beat?: number }
  /** These changed: read them again. */
  | { type: "changed"; topics: LiveTopic[] }
  | { type: "bye"; reason: LiveBye };

/**
 * A comment comes on the stream (and on a turn's) this often: one silent for three of them is gone, so a dead link is
 * told within 4.5 s, while a stream still waiting for its hello (HELLO_WAIT, 3 s) is never taken for dead first. Fifteen
 * bytes a beat, only while a device is in front; it was 15 s until 26 November 2026, which left a phone on a half-open
 * connection for 45 s.
 */
export const LIVE_BEAT_MS = 1_500;
