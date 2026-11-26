import type { TeamSnapshot } from "@invincible/core/team";
import type { Ctx } from "../context.ts";
import { isWaiting } from "../live.ts";
import { GALAHAD, seating } from "../lib/arrange.ts";
import { galahadState, type KnightState } from "../lib/knight-state.ts";
import { galahadNow, type Now } from "../lib/now.ts";
import { galahadNeeds, rosterRows, type RosterRow, type Said } from "../lib/roster.ts";
import { teamHash } from "../lib/team.ts";
import { seat } from "../ui/avatar.ts";
import type { Signal } from "../ui/signal.ts";
import { answerStep, chatActivity, galahadWork, nodeTurns, questsInHand, unreadChats } from "./chat.ts";
import { openDirect } from "./team-forms.ts";

/*
 * The Roundtable's seats: Galahad first, then every knight, then each room; each with one line of latest activity and its state in a word
 * (lib/roster.ts, lib/now.ts, lib/knight-state.ts). The Roundtable's own page draws them (views/board.ts: its cards, its
 * list), and a knight's page its own (views/team.ts). It asks the node nothing of its own: it reads the
 * team, the Inbox and his work as the app has them. (It was a wide screen's sidebar and a phone's first screen until 26
 * November 2026: the work by attention is, now, under Galahad.)
 */

/** The last thing said in each conversation the app has read (it reads one only when it is opened). */
const said = new Map<string, Said>();
export const noteSaid = (room: string, message: Said | undefined): void => {
  if (message) said.set(room, message);
};

/** Everyone at the table, as any list of them draws them: Galahad's row is his line, a knight's its own. */
export interface Seat {
  id: string;
  name: string;
  line: string;
  state: KnightState;
  needs: boolean;
  /** Where its row goes: his chat, a knight's own conversation (null until there is one), a room. */
  href: string;
  room: string | null;
  row: RosterRow | null;
  now: Now | null;
}

/** The table as the app knows it now: the team, every seat in order, the rooms, his line. */
export interface Table {
  snapshot: TeamSnapshot | null;
  problem: unknown;
  seats: Seat[];
  rooms: RosterRow[];
  answering: boolean;
}

/** What any list of the knights is drawn from: watched, it is drawn again whenever one of these changes. */
export const tableSources = (ctx: Ctx): Signal<unknown>[] =>
  [ctx.live.team, ctx.live.teamProblem, ctx.live.actions, ctx.live.inboxCount, ctx.live.inboxLoaded, nodeTurns, questsInHand, unreadChats, answerStep, chatActivity] as Signal<unknown>[];

export function tableOf(ctx: Ctx): Table {
  const snapshot = ctx.live.team.value;
  const now = Date.now();
  const asks = ctx.live.actions.value.filter((action) => isWaiting(action, now));
  const rows = snapshot ? rosterRows({ snapshot, said, asks, now }) : [];
  const knights = rows.filter((row) => row.kind === "knight");
  const galahad = galahadNow({ ...galahadWork(), needs: ctx.live.inboxLoaded.value ? galahadNeeds(ctx.live.inboxCount.value, asks, snapshot?.teammates.map((person) => person.id) ?? []) : null });
  const seats = seating(knights.map((row) => row.id)).map((id): Seat => {
    if (id === GALAHAD) return { id, name: "Galahad", line: galahad.text, state: galahadState(galahad), needs: galahad.tone === "warn", href: "#/chat", room: null, row: null, now: galahad };
    const row = knights.find((knight) => knight.id === id)!;
    return { id, name: row.name, line: row.line, state: row.state ?? "resting", needs: row.needs, href: row.room ? teamHash({ room: row.room }) : "#/team", room: row.room, row, now: null };
  });
  return { snapshot, problem: snapshot ? null : ctx.live.teamProblem.value, seats, rooms: rows.filter((row) => row.kind === "room"), answering: chatActivity.value.streaming };
}

/** A seat's face: Galahad's with his expression, a knight's with its own drawing and work. */
export const seatFace = (seated: Seat, size: number): HTMLElement =>
  seat({ id: seated.id, name: seated.name, profile: seated.row?.avatar, expression: seated.now?.expression ?? seated.row?.expression, state: seated.state, size });

/** A knight you have not written to yet: its conversation is made on the way in. */
export const openSeat = (ctx: Ctx, seated: Seat) => (seated.id !== GALAHAD && !seated.room ? (event: Event) => (event.preventDefault(), void openDirect(ctx, { id: seated.id })) : undefined);
