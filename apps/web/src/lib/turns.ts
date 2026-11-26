import type { AttachmentRef, ChatStreamEvent, StoredMessage } from "@galahad/core";
import { type ChatNeeds, type ChatState, chatStateWords, type QueueHold } from "@galahad/core/turns";
import { archiveStep, stepsOf } from "./chats.ts";

/*
 * Turns the node owns, as the app shows them. Pure functions (no DOM), unit-tested:
 * what sending does while he works (steer or queue), a chat's state as a badge, and
 * how a turn's stream becomes the thread on screen, from its start or (after a reload,
 * a dropped connection, on another device) rebuilt from what the node replays.
 */

/* ---------- the composer: steer or queue ---------- */

/** What Enter does while he's working, on this device. */
export type EnterPref = "steer" | "queue";

/**
 * What sending does. With nothing running, it sends. While he works, Enter does what this device
 * chose and the modifier (Ctrl or ⌘ with Enter) does the other; where a message can't be queued
 * (a temporary chat is kept nowhere, so there's nowhere to keep it), both steer.
 */
export function composerAction(input: { busy: boolean; enter: EnterPref; modifier: boolean; canQueue: boolean }): "send" | "steer" | "queue" {
  if (!input.busy) return "send";
  if (!input.canQueue) return "steer";
  const other: EnterPref = input.enter === "steer" ? "queue" : "steer";
  return input.modifier ? other : input.enter;
}

/** The line under the composer: what the keys do now. */
export function composerHint(input: { busy: boolean; enter: EnterPref; canQueue: boolean; coarse: boolean; mac: boolean }): string {
  // On a phone the controls say it themselves (Queue, Steer, Stop): there's no room for a line, and no keys to name.
  if (input.coarse) return "";
  if (!input.busy) return "Enter to send · Shift+Enter for a new line";
  const mod = input.mac ? "⌘" : "Ctrl";
  if (!input.canQueue) return "Enter steers him now · Esc stops him";
  return input.enter === "steer" ? `Enter steers him now · ${mod}+Enter queues it · Esc stops him` : `Enter queues it · ${mod}+Enter steers him now · Esc stops him`;
}

/** A side question typed into the composer: "/btw how long will this take?" (null: it isn't one). */
export function asideOf(text: string): string | null {
  const m = /^\s*\/(?:btw|aside)(?:\s+([\s\S]*))?$/i.exec(text);
  return m ? (m[1] ?? "").trim() : null;
}

/* ---------- a chat's state at a glance ---------- */

export interface StateBadge {
  text: string;
  tone: "accent" | "warn" | "danger" | "info" | "neutral";
  /** He's working in it right now. */
  live: boolean;
}

/** A chat's state as a badge (null: it's done, and a badge would only be noise). */
export function stateBadge(c: { state: ChatState; queued: number; held: QueueHold | null; needs: ChatNeeds | null }): StateBadge | null {
  const text = chatStateWords(c);
  if (!text) return null;
  const tone = c.state === "working" ? "accent" : c.state === "waiting" ? "warn" : c.state === "failed" ? "danger" : c.state === "queued" ? (c.held ? "warn" : "info") : "neutral";
  return { text, tone, live: c.state === "working" };
}

/* ---------- the thread: a turn's stream, as turns on screen ---------- */

export type StepState = "active" | "done" | "warn" | "error";
export interface Step {
  /** An icon's name (the view maps a tool to its own). */
  icon: string;
  text: string;
  detail?: string;
  state: StepState;
  /** A tool call's id (tool steps only), and the tool's name. */
  tool?: string;
  toolName?: string;
}

/** One argument of a tool's steps in these turns, each value that fits `shape` once, in the order he asked. */
function askedIn(turns: Turn[], toolName: string, argument: string, shape: RegExp): string[] {
  const values: string[] = [];
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.toolName !== toolName || !step.detail) continue;
      // The step's detail is the tool's arguments as JSON, then " → " and what it answered.
      const end = step.detail.indexOf("} → ");
      let value: unknown;
      try {
        value = (JSON.parse(end >= 0 ? step.detail.slice(0, end + 1) : step.detail) as Record<string, unknown>)[argument];
      } catch {
        continue;
      }
      if (typeof value === "string" && shape.test(value) && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

/** The keys he asked for in these turns (his request_secret steps, by the name each named), once each, in the order he asked. */
export function keysAskedIn(turns: Turn[]): string[] {
  return askedIn(turns, "request_secret", "name", /^[A-Za-z0-9._:-]{1,128}$/);
}

/** The connectors he asked for in these turns (his connector_request steps, by the connector each named), once each, in order. */
export function connectorsAskedIn(turns: Turn[]): string[] {
  return askedIn(turns, "connector_request", "connector", /^[a-z][a-z0-9-]{0,39}$/);
}

export interface Turn {
  id: number;
  /** The kept message this is, once the node has said (kept chats). */
  sid?: number;
  role: "user" | "assistant";
  content: string;
  /** Your files with it (your turns), as the node keeps them. */
  attachments?: AttachmentRef[];
  /** A look of his come back (a "user" turn that isn't yours): when he set it, and his note. */
  look?: { set: number; note: string };
  /** The roster role that answered (assistant turns). */
  as?: string;
  model?: string;
  steps: Step[];
  /** "steered": you sent a message while he was answering; the turn went on in the next answer. */
  status: "streaming" | "done" | "error" | "stopped" | "steered";
  error?: string;
  fallbacks: number;
  startedAt: number;
  endedAt?: number;
}

export interface Thread {
  turns: Turn[];
  nextId: number;
  /** The answer the stream is writing now. */
  target: Turn | null;
  /** Where the running turn's own answers begin in `turns` (what a replay rebuilds from); null: not known here. */
  base: number | null;
}

const STEP_ICON: Record<string, string> = { asked: "arrow-up", model: "models", fallback: "alert", archive: "library", answer: "chat", error: "x-circle", stopped: "stop", steered: "arrow-up", tool: "zap" };

/** A kept message as a turn on screen, with its answer's steps. */
/**
 * Whether a kept chat holds what isn't on screen: a message more or fewer, another in a place, or one that ended or
 * changed since (another device asked in it, retried, or stopped him). By the node's own ids, states and words; a turn
 * of this device's not yet told its kept id is matched by its words and state (redrawing it would only move the screen).
 */
export function keptDiffers(shown: readonly Pick<Turn, "sid" | "status" | "content">[], kept: readonly Pick<StoredMessage, "id" | "status" | "content">[]): boolean {
  if (shown.length !== kept.length) return true;
  return kept.some((m, i) => {
    const t = shown[i]!;
    return (t.sid !== undefined && t.sid !== m.id) || t.status !== m.status || t.content !== m.content;
  });
}

/**
 * A kept chat read again with no turn in it to watch: the turns to show, or null when what's on screen is what the node
 * keeps (keptDiffers), so nothing is redrawn. A message of this device's that the node never took (it refused it, or
 * never heard it: the answer failed before the node said which it is) is kept nowhere else: it stays at the end, with
 * why and Retry, unless the node turns out to hold that question after all.
 */
export function shownAgain(shown: readonly Turn[], kept: readonly StoredMessage[], turn: (m: StoredMessage) => Turn): Turn[] | null {
  const answer = shown.at(-1);
  const asked = shown.at(-2);
  const lastAsked = kept.filter((m) => m.role === "user").at(-1);
  const untaken =
    answer?.role === "assistant" && answer.status === "error" && answer.sid === undefined && asked?.role === "user" && asked.sid === undefined && lastAsked?.content !== asked.content ? [asked, answer] : [];
  const rest = shown.slice(0, shown.length - untaken.length);
  return keptDiffers(rest, kept) ? [...kept.map(turn), ...untaken] : null;
}

export function turnOf(m: StoredMessage, role: string, id: number): Turn {
  const steps: Step[] =
    m.role === "assistant"
      ? stepsOf(m, role).map((s) => ({ icon: STEP_ICON[s.kind] ?? "check", text: s.text, ...(s.detail ? { detail: s.detail } : {}), state: s.state, ...(s.tool ? { tool: s.tool.id, toolName: s.tool.name } : {}) }))
      : [];
  return {
    id,
    sid: m.id,
    role: m.role,
    content: m.content,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.look ? { look: m.look } : {}),
    as: role,
    ...(m.model ? { model: m.model } : {}),
    steps,
    // An answer the node is still writing is shown as it stands; attaching to its turn brings the rest.
    status: m.status,
    ...(m.error ? { error: m.error } : {}),
    fallbacks: m.steps.filter((s) => s.kind === "fallback").length,
    startedAt: m.createdAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  };
}

function step(turn: Turn, next: Step): void {
  const last = turn.steps.at(-1);
  if (last?.state === "active") last.state = "done";
  turn.steps.push(next);
}

const blank = (thread: Thread, as: string, now: number, model?: string): Turn => {
  const turn: Turn = { id: thread.nextId++, role: "assistant", content: "", as, ...(model ? { model } : {}), steps: [], status: "streaming", fallbacks: 0, startedAt: now };
  thread.turns.push(turn);
  thread.target = turn;
  return turn;
};

/** You send a message: it and the answer to come join the thread (the answer is what the stream then writes). */
export function beginTurn(thread: Thread, question: string, as: string, now: number, attachments: AttachmentRef[] = []): Turn {
  thread.turns.push({ id: thread.nextId++, role: "user", content: question, ...(attachments.length ? { attachments } : {}), steps: [], status: "done", fallbacks: 0, startedAt: now });
  thread.base = thread.turns.length;
  const answer = blank(thread, as, now);
  step(answer, { icon: "arrow-up", text: `Asked as ${as}`, state: "done" });
  return answer;
}

const STOPPED: Record<string, string> = { you: "Stopped by you", limit: "Stopped at the node's limit for one turn", node: "Stopped: the node itself was stopping", unwatched: "Stopped: nobody was watching this temporary chat any more" };

/**
 * One event of a turn's stream, applied to the thread. Returns the one turn that changed,
 * "all" when the thread's shape did (turns added or removed), or null when nothing on screen did.
 */
export function applyEvent(thread: Thread, event: ChatStreamEvent, now: number): Turn | "all" | null {
  if (event.type === "turn") {
    if (!event.replay) {
      // This page started it: the answer is already there, and now it knows which kept message it is.
      if (thread.target && event.answer !== null) thread.target.sid = event.answer;
      return null;
    }
    // Attached to a turn already under way: its answers (and your steers between them) are rebuilt from what
    // the node replays. A page that was already showing the turn knows where they begin; one that loaded the
    // kept chat finds the turn's first answer by the kept message it is (or the first one after it, if that
    // answer came to nothing and wasn't kept).
    const known = thread.base ?? (event.answer !== null ? thread.turns.findIndex((t) => t.sid !== undefined && t.sid >= event.answer!) : -1);
    if (known >= 0 && known <= thread.turns.length) thread.turns.length = known;
    thread.base = thread.turns.length;
    const answer = blank(thread, event.role, event.startedAt);
    if (event.answer !== null) answer.sid = event.answer;
    step(answer, { icon: "arrow-up", text: `Asked as ${event.role}`, state: "done" });
    return "all";
  }
  const turn = thread.target;
  if (!turn) return null;
  switch (event.type) {
    case "model":
      turn.model = event.ref;
      step(turn, { icon: "models", text: `Thinking with ${event.ref}`, state: "active" });
      return turn;
    case "fallback": {
      turn.fallbacks++;
      const last = turn.steps.at(-1);
      if (last?.state === "active") Object.assign(last, { state: "warn", text: `${event.from} didn't answer`, detail: event.error });
      else step(turn, { icon: "alert", text: `${event.from} didn't answer`, detail: event.error, state: "warn" });
      return turn;
    }
    case "archive":
      // What the archive gave this answer, shown like a tool's step: which entries, by id and title.
      step(turn, { icon: "library", ...archiveStep(event.entries), state: "done" });
      return turn;
    case "tool":
      step(turn, { icon: "zap", text: event.title, ...(event.input ? { detail: event.input } : {}), state: "active", tool: event.id, toolName: event.name });
      return turn;
    case "tool_result": {
      const s = turn.steps.find((x) => x.tool === event.id);
      if (s) {
        s.state = event.ok ? "done" : "warn";
        s.detail = [s.detail, event.summary].filter(Boolean).join(" → ");
      }
      return turn;
    }
    case "text": {
      const last = turn.steps.at(-1);
      if (!(last?.text === "Answering" && last.state === "active")) step(turn, { icon: "chat", text: "Answering", state: "active" });
      turn.content += event.text;
      return turn;
    }
    case "steer": {
      // Your message reached him: the answer so far stands as it is, your message follows, a new answer begins.
      const empty = !turn.content.trim() && !turn.steps.some((s) => s.tool);
      if (empty) thread.turns.splice(thread.turns.indexOf(turn), 1);
      else {
        turn.status = "steered";
        turn.endedAt = now;
        step(turn, { icon: "arrow-up", text: "Your message reached him here", state: "done" });
      }
      thread.turns.push({ id: thread.nextId++, role: "user", content: event.text, steps: [], status: "done", fallbacks: 0, startedAt: now });
      const next = blank(thread, turn.as ?? "planner", now, turn.model);
      step(next, { icon: "models", text: turn.model ? `Thinking with ${turn.model}` : "Thinking", state: "active" });
      return "all";
    }
    case "done":
      turn.model = event.ref;
      return turn;
    case "error":
      turn.error = event.error;
      return turn;
    case "stopped":
      turn.status = "stopped";
      turn.endedAt = now;
      step(turn, { icon: "stop", text: STOPPED[event.reason] ?? "Stopped", state: "warn" });
      return turn;
    default:
      return null;
  }
}

/** The stream has ended: the answer it was writing is settled (done, or failed with why). Returns it. */
export function endTurn(thread: Thread, now: number): Turn | null {
  const turn = thread.target;
  thread.target = null;
  thread.base = null;
  if (!turn) return null;
  if (turn.status === "streaming") {
    if (turn.error) {
      turn.status = "error";
      step(turn, { icon: "x-circle", text: "Couldn't answer", detail: turn.error, state: "error" });
    } else {
      turn.status = "done";
      const last = turn.steps.at(-1);
      if (last?.state === "active") last.state = "done";
    }
  }
  turn.endedAt ??= now;
  return turn;
}

/** The watching was cut (not the turn): the answer says so while the page finds the turn again. */
export function failTurn(thread: Thread, message: string, now: number): Turn | null {
  const turn = thread.target;
  thread.target = null;
  thread.base = null;
  if (!turn) return null;
  turn.status = "error";
  turn.error = message;
  turn.endedAt = now;
  step(turn, { icon: "x-circle", text: "Couldn't answer", detail: message, state: "error" });
  return turn;
}

/* ---------- small words ---------- */

/** "stops by itself in 27 min" from a turn's deadline. */
export function stopsIn(deadline: number, now: number): string {
  const minutes = Math.max(0, Math.round((deadline - now) / 60_000));
  return minutes < 1 ? "stops by itself within a minute" : `stops by itself in ${minutes} min`;
}
