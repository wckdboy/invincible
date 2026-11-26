/*
 * Sessions on a Mac's own screen (docs/MAC.md, M4): Galahad asks to use a Mac itself (its screen, its apps, a shell as
 * its user) for some minutes, and it is his only once you allow it, for those minutes counted from your answer, until
 * you or he ends it. An ask you don't answer in SCREEN_ANSWER_MINUTES lapses: no answer is no. Where a session stands
 * is worked out here, the same on every node and in every app, from what the log holds (the mind's screen sessions).
 */

/** How long an ask waits for your answer: his turn has long moved on after that. */
export const SCREEN_ANSWER_MINUTES = 15;

/** A session as the log holds it (the mind's ScreenSessionRecord). */
export interface ScreenSessionFacts {
  id: string;
  node: string;
  why: string;
  minutes: number;
  askedAt: number;
  decision: { verdict: "allowed" | "denied"; at: number; via: string | null } | null;
  endedAt: number | null;
}

export type ScreenSessionState = "waiting" | "lapsed" | "denied" | "allowed" | "over" | "ended";

/** A session, and where it stands now. */
export interface ScreenSessionView {
  id: string;
  /** The Mac it is on, and its name. */
  node: string;
  nodeName: string;
  why: string;
  minutes: number;
  askedAt: number;
  state: ScreenSessionState;
  /** While it waits: until when you can answer. */
  answerBy: number;
  /** Allowed: until when it is his (or was, once over or ended). */
  until: number | null;
  /** The device you answered on, where it was one. */
  decidedVia: string | null;
}

/** Where a session stands at `now`. */
export function screenSessionState(s: ScreenSessionFacts, now: number): { state: ScreenSessionState; answerBy: number; until: number | null } {
  const answerBy = s.askedAt + SCREEN_ANSWER_MINUTES * 60_000;
  if (!s.decision) {
    if (s.endedAt !== null) return { state: "ended", answerBy, until: null };
    return { state: now < answerBy ? "waiting" : "lapsed", answerBy, until: null };
  }
  if (s.decision.verdict === "denied") return { state: "denied", answerBy, until: null };
  const until = s.decision.at + s.minutes * 60_000;
  if (s.endedAt !== null) return { state: "ended", answerBy, until: Math.min(until, s.endedAt) };
  return { state: now < until ? "allowed" : "over", answerBy, until };
}

export function screenSessionView(s: ScreenSessionFacts, now: number, nodeName: (id: string) => string): ScreenSessionView {
  return { id: s.id, node: s.node, nodeName: nodeName(s.node), why: s.why, minutes: s.minutes, askedAt: s.askedAt, ...screenSessionState(s, now), decidedVia: s.decision?.via ?? null };
}

/** The session that lets him use `node`'s screen now, if one does (the newest, should two overlap). */
export function activeScreenSession<T extends ScreenSessionFacts>(sessions: readonly T[], node: string, now: number): T | null {
  return sessions.filter((s) => s.node === node && screenSessionState(s, now).state === "allowed").sort((x, y) => y.decision!.at - x.decision!.at)[0] ?? null;
}
