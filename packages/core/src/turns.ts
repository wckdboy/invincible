/*
 * Turns the node owns.
 *
 * A chat turn of yours runs on the node to its end whether or not any page is
 * listening: the page that started it, another device, or the same page after a
 * reload attaches to it and sees it from its start. Stopping is explicit, never a
 * side effect of a dropped connection. While he works, a new message of yours either
 * steers (he's told at the next safe point) or queues (kept on the node, sent as the
 * next turn when this one ends). Both are your message, and go through everything an
 * ordinary one does.
 *
 * Types and pure rules only (no schema library): the app imports this directly.
 */

export const TURN_ID = /^tn_[A-Za-z0-9_-]{22}$/;

export type TurnState = "running" | "done" | "error" | "stopped";

/**
 * Why a turn was stopped: you said so; it ran into the node's limit for one turn; the node itself stopped; or
 * it was a temporary chat's turn that nobody was watching any more (kept nowhere, so nobody could ever read it).
 */
export type StopReason = "you" | "limit" | "node" | "unwatched";

/** A turn the node is running, as each of your devices sees it. */
export interface TurnView {
  id: string;
  /** The kept chat it belongs to (null: a temporary chat, known only to the device that started it). */
  conversation: string | null;
  title: string | null;
  role: string;
  state: TurnState;
  startedAt: number;
  endedAt: number | null;
  /** It is stopped at this time if it's still going (the node's limit for one turn). */
  deadline: number;
  model: string | null;
  /** What he's doing now, in a line (null for a device that may not watch it). */
  step: string | null;
  /** Tools he has used so far. */
  tools: number;
  /** Your devices watching it right now (0: nobody's watching; it still spends model tokens). */
  watchers: number;
  /** Messages of yours waiting for a safe point to reach him. */
  steering: number;
  /** False: this device may not watch or steer it (it may read the bank, and this device may not). */
  watchable: boolean;
}

/** The node's limits on turns, as it tells every device. */
export interface TurnLimits {
  /** Turns running at once on this node. */
  maxTurns: number;
  /** How long one turn may run, in minutes. */
  maxMinutes: number;
  /** Messages queued behind one chat. */
  maxQueued: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = { maxTurns: 4, maxMinutes: 30, maxQueued: 20 };

/** A message of yours, kept on the node until its turn comes. */
export interface QueuedMessage {
  id: number;
  text: string;
  /** The role it'll be asked as (null: the chat's own). */
  role: string | null;
  at: number;
  /** The device you queued it from, by name. */
  by: string | null;
}

/**
 * Why a chat's queue is held (nothing is sent until you resume or discard): you stopped him;
 * the turn before it failed; the node restarted; the device that queued the next message is
 * no longer paired, may no longer chat, or may not see this chat (it read the bank since).
 */
export type QueueHold = "stopped" | "error" | "restart" | "device";

export const holdWords = (held: QueueHold): string =>
  held === "stopped"
    ? "you stopped him"
    : held === "error"
      ? "the turn before them failed"
      : held === "restart"
        ? "the node restarted"
        : "the device that queued the next one is no longer paired, or may not see this chat";

/** What a chat is waiting on you for. */
export interface ChatNeeds {
  /** Approvals he filed in it that you haven't answered. */
  approvals: number;
  /** Keys he asked for in it that you haven't given. */
  keys: number;
  /** His last answer ended by asking you something. */
  question: boolean;
}

/** A chat's state at a glance. */
export type ChatState = "working" | "waiting" | "queued" | "stopped" | "failed" | "done";

/** How a kept answer ended ("steered": you sent a message while he was answering, and the turn went on with it). */
export type AnswerStatus = "done" | "error" | "stopped" | "steered" | "streaming";

/**
 * A chat's state from what's known: a turn running in it comes first, then what needs you,
 * then what's queued, then how its last answer ended.
 */
export function chatState(input: { running: boolean; needs: ChatNeeds | null; queued: number; last: AnswerStatus | null }): ChatState {
  if (input.running) return "working";
  if (input.needs && (input.needs.approvals > 0 || input.needs.keys > 0 || input.needs.question)) return "waiting";
  if (input.queued > 0) return "queued";
  if (input.last === "error") return "failed";
  // An answer the node was writing when it went down can't finish any more.
  if (input.last === "stopped" || input.last === "streaming") return "stopped";
  return "done";
}

const count = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`);

/** What a chat needs from you, in a few words ("an approval", "2 approvals and a key", "an answer"). */
export function needsWords(needs: ChatNeeds): string {
  const parts = [needs.approvals ? count(needs.approvals, "an approval", "approvals") : "", needs.keys ? count(needs.keys, "a key", "keys") : "", needs.question && !needs.approvals && !needs.keys ? "an answer" : ""].filter(Boolean);
  return parts.join(" and ");
}

/** A chat's state in words, for a list ("" when there's nothing to say: it's done). */
export function chatStateWords(c: { state: ChatState; queued: number; held: QueueHold | null; needs: ChatNeeds | null }): string {
  const queued = c.queued ? `${c.queued} queued${c.held ? `, held (${holdWords(c.held)})` : ""}` : "";
  switch (c.state) {
    case "working":
      return queued ? `Working · ${queued}` : "Working";
    case "waiting":
      return `Needs you: ${c.needs ? needsWords(c.needs) : "a look"}${queued ? ` · ${queued}` : ""}`;
    case "queued":
      return queued[0]!.toUpperCase() + queued.slice(1);
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "done":
      return "";
  }
}

/** After a turn ends: whether the messages queued behind it are held, and why. A turn that ended well holds nothing. */
export function holdAfter(state: TurnState, queued: number): QueueHold | null {
  if (queued <= 0 || state === "done" || state === "running") return null;
  return state === "stopped" ? "stopped" : "error";
}

/** Whether a chat's next queued message may be sent now: nothing running in it, nothing holding it, and room on the node. */
export function mayDrain(chat: { running: boolean; held: QueueHold | null; queued: number }, node: { running: number; maxTurns: number }): boolean {
  return !chat.running && !chat.held && chat.queued > 0 && node.running < node.maxTurns;
}

/** Whether his answer ends by asking you something: its last line ends with a question mark. */
export function endsWithQuestion(answer: string): boolean {
  const last = answer
    .trim()
    .split(/\r?\n/)
    .at(-1)
    ?.replace(/[*_`)\]"'”’\s]+$/u, "");
  return Boolean(last && /[?？]$/.test(last));
}
