import type { TeamSnapshot } from "@invincible/core/team";
import type { Ctx } from "../context.ts";
import { isWaiting } from "../live.ts";
import { PRIMARY, seating } from "../lib/arrange.ts";
import { primaryState, type AgentState } from "../lib/agent-state.ts";
import { primaryNow, type Now } from "../lib/now.ts";
import { homeRows, primaryNeeds, rosterRows, type RosterRow, type Said } from "../lib/roster.ts";
import { teamHash } from "../lib/team.ts";
import { seat } from "../ui/avatar.ts";
import type { Signal } from "../ui/signal.ts";
import { answerStep, chatActivity, primaryWork, nodeTurns, runsInHand, unreadChats } from "./chat.ts";
import { openDirect } from "./team-forms.ts";

/*
 * The agents' seats: the primary first, then every agent, then each room; each with one line of latest activity and its state in a word
 * (lib/roster.ts, lib/now.ts, lib/agent-state.ts). The agents' own page draws them (views/board.ts: its cards, its
 * list), and an agent's page its own (views/team.ts). It asks the node nothing of its own: it reads the
 * team, the Inbox and its work as the app has them. (It was a wide screen's sidebar and a phone's first screen until 26
 * November 2026: the work by attention is, now, under the primary.)
 */

/** The last thing said in each conversation the app has read (it reads one only when it is opened). */
const said = new Map<string, Said>();
export const noteSaid = (room: string, message: Said | undefined): void => {
  if (message) said.set(room, message);
};

/** Everyone at the table, as any list of them draws them: the primary's row is its line, an agent's its own. */
export interface Seat {
  id: string;
  name: string;
  line: string;
  state: AgentState;
  needs: boolean;
  /** Where its row goes: its chat, an agent's own conversation (null until there is one), a room. */
  href: string;
  room: string | null;
  row: RosterRow | null;
  now: Now | null;
}

/** The table as the app knows it now: the team, every seat in order, the rooms, its line. */
export interface Table {
  snapshot: TeamSnapshot | null;
  problem: unknown;
  seats: Seat[];
  rooms: RosterRow[];
  answering: boolean;
}

/** What any list of the agents is drawn from: watched, it is drawn again whenever one of these changes. */
export const tableSources = (ctx: Ctx): Signal<unknown>[] =>
  [ctx.live.team, ctx.live.teamProblem, ctx.live.actions, ctx.live.inboxCount, ctx.live.inboxLoaded, nodeTurns, runsInHand, unreadChats, answerStep, chatActivity] as Signal<unknown>[];

/** When each row last did something (lib/roster.ts homeRows' `at`, by its key: "person:<id>", "room:<id>"), the latest
 * first: a phone's list orders its rows by it and says it at each row's end. */
export function homeTimes(ctx: Ctx): Map<string, number> {
  const snapshot = ctx.live.team.value;
  if (!snapshot) return new Map();
  const now = Date.now();
  const asks = ctx.live.actions.value.filter((action) => isWaiting(action, now));
  return new Map(homeRows({ snapshot, said, asks, now }).map((row) => [row.key, row.at]));
}

export function tableOf(ctx: Ctx): Table {
  const snapshot = ctx.live.team.value;
  const now = Date.now();
  const asks = ctx.live.actions.value.filter((action) => isWaiting(action, now));
  const rows = snapshot ? rosterRows({ snapshot, said, asks, now }) : [];
  const agents = rows.filter((row) => row.kind === "agent");
  const primary = primaryNow({ ...primaryWork(), needs: ctx.live.inboxLoaded.value ? primaryNeeds(ctx.live.inboxCount.value, asks, snapshot?.agents.map((person) => person.id) ?? []) : null });
  const seats = seating(agents.map((row) => row.id)).map((id): Seat => {
    if (id === PRIMARY) return { id, name: "Your agent", line: primary.text, state: primaryState(primary), needs: primary.tone === "warn", href: "#/chat", room: null, row: null, now: primary };
    const row = agents.find((agent) => agent.id === id)!;
    return { id, name: row.name, line: row.line, state: row.state ?? "resting", needs: row.needs, href: row.room ? teamHash({ room: row.room }) : "#/team", room: row.room, row, now: null };
  });
  return { snapshot, problem: snapshot ? null : ctx.live.teamProblem.value, seats, rooms: rows.filter((row) => row.kind === "room"), answering: chatActivity.value.streaming };
}

/** A seat's face: the primary's with its expression, an agent's with its own drawing and work. */
export const seatFace = (seated: Seat, size: number): HTMLElement =>
  seat({ id: seated.id, name: seated.name, profile: seated.row?.avatar, expression: seated.now?.expression ?? seated.row?.expression, state: seated.state, size });

/** An agent you have not written to yet: its conversation is made on the way in. */
export const openSeat = (ctx: Ctx, seated: Seat) => (seated.id !== PRIMARY && !seated.room ? (event: Event) => (event.preventDefault(), void openDirect(ctx, { id: seated.id })) : undefined);
