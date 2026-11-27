import type { SeatKind } from "./seats.ts";

/*
 * Which agents a seat serves, and which of their tools runs on it (seats.ts says the rest): plain rules, free of the
 * schemas, so that the PWA, which says whom each seat serves and lets you choose them, carries no schema library for it.
 */

/** The kinds whose sign-in a vendor's tool keeps in the seat's home, on its node (chatgpt-siwc's is the node's own). */
export const HOMED_KINDS: readonly SeatKind[] = ["claude-subscription", "chatgpt-codex", "mistral-vibe"];

/** The harness a seat's own plan runs: its vendor's tool. (A keyed seat runs any harness that speaks its API, through the gateway.) */
export const SEAT_HARNESS: Readonly<Partial<Record<SeatKind, string>>> = { "claude-subscription": "claude", "chatgpt-codex": "codex" };

/** An agent a seat serves, as that agent: its handle, and when its node's team made it (a later agent given the handle is another). */
export interface SeatAgent {
  id: string;
  made: number;
}

/** Whether a seat serves this agent: one it names as this agent, its handle and when it was made. */
export function seatServes(seat: { serves: readonly SeatAgent[] }, agent: SeatAgent): boolean {
  return seat.serves.some((one) => one.id === agent.id && one.made === agent.made);
}

/**
 * The agents a seat serves now, in the order it names them: each one it names that is on `roster` as itself (the same
 * handle, made when it says). One you removed isn't on a roster of your agents, and a later agent given its handle was
 * made later: neither is served. `roster`: the agents of the node that holds the seat, as its team lists them.
 */
export function servedBy<A extends { id: string; createdAt: number }>(seat: { serves: readonly SeatAgent[] }, roster: readonly A[]): A[] {
  const served: A[] = [];
  for (const one of seat.serves) {
    const agent = roster.find((candidate) => candidate.id === one.id && candidate.createdAt === one.made);
    if (agent && !served.includes(agent)) served.push(agent);
  }
  return served;
}
