import { Steering } from "@galahad/brain";
import {
  type AttachmentRef,
  type ChatMessage,
  type ChatStreamEvent,
  DEFAULT_TURN_LIMITS,
  endsWithQuestion,
  holdAfter,
  mayDrain,
  type QueueHold,
  randomId,
  redact,
  type StopReason,
  type StoredStep,
  type TurnLimits,
  type TurnState,
  type TurnView,
} from "@galahad/core";
import type { ChatStore, Queued, QueuedBy } from "./chats.ts";
import { TOOLS } from "./tools.ts";

/*
 * Turns the node owns. A chat turn of the owner's runs here to its end whether or
 * not any page is listening: this hub starts it, keeps what happened (so a page that
 * attaches sees it from its start), writes it into the kept chat as it goes, and is
 * the only thing that stops it: when the owner says so, when it runs into the node's
 * limit for one turn, or when the node itself stops. A dropped connection stops nothing.
 *
 * It also owns what the owner says while he works: a steer is offered to the running
 * turn (chat() takes it at a safe point), a queued message waits in the chat store and
 * becomes the next turn when the one before it ends well. A turn that was stopped or
 * failed, and a node that restarted, hold the queue until the owner resumes it:
 * nothing of the owner's goes on unattended that the owner didn't leave running. His
 * own looks (looks.ts) are his, on the owner's word of 24 November 2026: each comes
 * back as a turn of his once, its message kept as his.
 *
 * Bounded: so many turns at once, so long each, so many messages queued; each queued
 * message is sent once, and nothing is ever tried again by itself.
 *
 * What a turn may do is decided where it's prepared (the server: who asked, their
 * scopes, the tools, the bank's rules); the hub only runs what it's handed.
 */

/** A turn's answer as it's kept: its words, the model, each step, how it went. */
export interface AnswerRecord {
  content: string;
  model: string | null;
  steps: StoredStep[];
  error: string | null;
  bank: boolean;
}

/** What an answer did, as it's kept with it: its words, the model, fallbacks, each tool and how it went. */
export function keepStep(answer: AnswerRecord, event: ChatStreamEvent): void {
  switch (event.type) {
    case "text":
      answer.content += event.text;
      return;
    case "model":
      answer.model = event.ref;
      answer.steps.push({ kind: "model", ref: event.ref });
      return;
    case "fallback":
      answer.steps.push({ kind: "fallback", from: event.from, error: event.error });
      return;
    case "tool":
      answer.steps.push({ kind: "tool", id: event.id, name: event.name, title: event.title, input: event.input, ok: null, summary: null });
      return;
    case "tool_result": {
      const step = answer.steps.find((s) => s.kind === "tool" && s.id === event.id);
      if (step?.kind === "tool") Object.assign(step, { ok: event.ok, summary: event.summary });
      // Galahad read the bank in it: from now on the conversation is for devices that may.
      if (event.ok && TOOLS.find((t) => t.name === event.name)?.flow === "private") answer.bank = true;
      return;
    }
    case "archive":
      answer.steps.push({ kind: "archive", entries: event.entries });
      return;
    case "done":
      answer.model = event.ref;
      return;
    case "error":
      answer.error = event.error;
      return;
  }
}

export class TurnError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Why a queue is held when this is what kept its next message from being sent. */
    readonly hold?: QueueHold,
  ) {
    super(message);
  }
}

/** A turn, prepared: who asked, what it may come to hold, and how to run it. */
export interface TurnSpec {
  by: QueuedBy;
  /** Its asker may read the bank, so it may come to hold bank data: only a device that may read the bank watches or steers it. */
  bank: boolean;
  /** Its asker may command the team, so it has the tools to the knights: only a device that may command the team steers it. */
  team?: boolean;
  role: string;
  /** The kept chat it belongs to (null: a temporary chat, kept nowhere). */
  conversation: { id: string; title: string; project: string | null } | null;
  /** The owner's message that starts it (or, for a look of his coming back, his note as the model is given it). */
  question: string;
  /** A look of his coming back (looks.ts): when he set it, and his note. Its message is kept as his, not the owner's. */
  look?: { set: number; note: string };
  /** The files it carries, kept on the node (uploads.ts). */
  attachments?: AttachmentRef[];
  /** What the model is given: what was said before, then the question (a side question is answered from the same). */
  messages: ChatMessage[];
  /** What it leaves waiting on the owner, noted as its tools run: approvals it filed, keys it asked for. */
  waits: { actions: string[]; secrets: string[] };
  /** The answer itself: chat()'s events (its slot, its tools and the archive inside). */
  run(steering: Steering, signal: AbortSignal): AsyncGenerator<ChatStreamEvent>;
}

export interface HubLimits extends TurnLimits {
  /** Messages of the owner's that may be handed to one turn while it runs. */
  maxSteers: number;
  /** How long a turn that ended can still be attached to (a page coming back sees how it went), in ms. */
  keepMs: number;
  /**
   * How long a temporary chat's turn may go on with nobody watching, in ms. It's kept nowhere, so once its page
   * is gone nobody can read it: past this it is stopped rather than left spending. (A kept chat's turn has no
   * such bound: its answer is in the chat whoever watches.)
   */
  unwatchedMs: number;
  /**
   * How long a turn that was told to stop may take to wind down (a tool that's running finishes first), in ms.
   * Past it the turn is recorded as it stands and its place given up, whatever is still hanging: a tool that
   * never returns can't keep a stopped turn, or a stopping node, waiting forever.
   */
  windDownMs: number;
}

export const HUB_LIMITS: HubLimits = { ...DEFAULT_TURN_LIMITS, maxSteers: 20, keepMs: 10 * 60_000, unwatchedMs: 2 * 60_000, windDownMs: 30_000 };

/** A turn the hub is running, or one that just ended. */
export interface LiveTurn {
  readonly id: string;
  readonly spec: TurnSpec;
  state: TurnState;
  readonly startedAt: number;
  endedAt: number | null;
  readonly deadline: number;
  /** The kept message its first answer is (null: a temporary chat). */
  readonly firstAnswer: number | null;
  /** Ends when the turn has ended and everything about it is written. */
  readonly ended: Promise<void>;
}

interface Live extends LiveTurn {
  controller: AbortController;
  steering: Steering;
  /** Who offered each message that's been handed to `steering`, in order (what never reaches him goes back as theirs). */
  offered: { text: string; by: QueuedBy }[];
  steers: number;
  /** Everything that happened, for whoever attaches (text runs joined). */
  buffer: ChatStreamEvent[];
  listeners: Set<(event: ChatStreamEvent | null) => void>;
  /** The answer being written now (a steer ends one and begins the next), and its kept message. */
  answer: AnswerRecord;
  answerId: number | null;
  stop: StopReason | null;
  completed: boolean;
  model: string | null;
  step: string | null;
  tools: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A temporary chat's turn, while nobody watches it: when it's stopped unless someone attaches. */
  unwatched: ReturnType<typeof setTimeout> | null;
  /** After a stop: when it's given up on if it still hasn't wound down. */
  windDown: ReturnType<typeof setTimeout> | null;
  /** Says the turn has ended and everything about it is written. */
  settle: () => void;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a running turn has said and done since its question. */
export interface TurnSoFar {
  /** Answers cut by a steer, and the steers, in order. */
  exchange: ChatMessage[];
  /** What he's said since the last of them. */
  said: string;
  /** Each step he's taken since, in a line: the tool, what it was asked, how it went. */
  steps: string[];
}

/**
 * What a side question is answered from: what the chat holds (and, with a turn under way, what that turn
 * has said and done so far), then the aside, marked as one. It asks for an answer, not a change of course,
 * and it is sent without tools: answering it can do nothing.
 */
export function asideMessages(held: readonly ChatMessage[], working: TurnSoFar | null, question: string): ChatMessage[] {
  const messages: ChatMessage[] = [...held, ...(working?.exchange ?? [])];
  if (working) messages.push({ role: "assistant", content: working.said.trim() ? working.said : "(Still working on it: nothing said yet.)" });
  const steps = working?.steps.length ? `\n\nWhat you have done so far in this turn:\n${working.steps.map((s) => `- ${s}`).join("\n")}` : "";
  messages.push({
    role: "user",
    content: `An aside from your liege${working ? ", while the work above goes on" : ", about the conversation above"}. Answer it briefly and directly from what is here. It is a question, not an instruction to change course, and you have no tools for it: say so if answering would need one.${steps}\n\nThe aside: ${question}`,
  });
  // Every provider wants the two voices in turn: neighbours of one voice are joined.
  const turned: ChatMessage[] = [];
  for (const m of messages) {
    const last = turned.at(-1);
    if (last && last.role === m.role) turned[turned.length - 1] = { role: m.role, content: `${last.content}\n\n${m.content}` };
    else turned.push({ role: m.role, content: m.content });
  }
  if (turned[0]?.role === "assistant") turned.unshift({ role: "user", content: "(The conversation so far.)" });
  return turned;
}

/** A side question and its answer, as you'd bring them back into the work. */
export const broughtBack = (question: string, answer: string): string =>
  `While you worked I asked you something on the side, and you answered. Take it into account from here.\n\nMy aside: ${question}\n\nYour answer: ${answer}`;

export class TurnHub {
  private readonly turns = new Map<string, Live>();
  private readonly limit: HubLimits;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private prepare: ((conversation: string, queued: Queued) => TurnSpec) | null = null;
  private closed = false;

  constructor(private readonly opts: { chats: ChatStore; limits?: Partial<HubLimits>; now?: () => number; log?: (message: string) => void }) {
    this.limit = { ...HUB_LIMITS, ...opts.limits };
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** How a queued message becomes a turn: every check an ordinary message gets, as whoever queued it stands now. */
  setPrepare(prepare: (conversation: string, queued: Queued) => TurnSpec): void {
    this.prepare = prepare;
  }

  limits(): TurnLimits {
    return { maxTurns: this.limit.maxTurns, maxMinutes: this.limit.maxMinutes, maxQueued: this.limit.maxQueued };
  }

  /** The turns running now, the one started first first. */
  running(): LiveTurn[] {
    return [...this.turns.values()].filter((t) => t.state === "running");
  }

  /** The turn running in a kept chat, if one is. */
  runningIn(conversation: string): LiveTurn | null {
    return this.running().find((t) => t.spec.conversation?.id === conversation) ?? null;
  }

  /** A turn by its id: running, or ended a little while ago. */
  get(id: string): LiveTurn | null {
    return this.turns.get(id) ?? null;
  }

  view(turn: LiveTurn, watchable: boolean): TurnView {
    const t = turn as Live;
    return {
      id: t.id,
      conversation: t.spec.conversation?.id ?? null,
      title: t.spec.conversation?.title ?? null,
      role: t.spec.role,
      state: t.state,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      deadline: t.deadline,
      model: watchable ? t.model : null,
      step: watchable ? t.step : null,
      tools: t.tools,
      watchers: t.listeners.size,
      steering: t.steering.waiting,
      watchable,
    };
  }

  /**
   * Whether a turn may start now: the node has room, and nothing is running in that chat.
   * Asked before anything is written, so a refusal leaves no trace.
   */
  admit(conversation: string | null): void {
    if (this.closed) throw new TurnError(503, "This node is stopping: it takes no new turns.");
    if (conversation && this.runningIn(conversation)) {
      throw new TurnError(409, "He's still working in this chat. Steer him (your message reaches him now), queue it (it's sent when he finishes), or stop him first.");
    }
    const running = this.running().length;
    if (running >= this.limit.maxTurns) {
      throw new TurnError(429, `This node is already working on ${plural(running, "turn", "turns")}, its limit. Wait for one to end or stop one; a message queued behind a chat is sent when there's room.`);
    }
  }

  /** Start a turn. It runs to its end here, whoever is or isn't listening. */
  start(spec: TurnSpec): LiveTurn {
    this.admit(spec.conversation?.id ?? null);
    const { chats } = this.opts;
    const c = spec.conversation;
    let answerId: number | null = null;
    if (c) {
      chats.addUser(c.id, spec.question, spec.attachments, spec.look);
      answerId = chats.startAnswer(c.id);
    }
    const startedAt = this.now();
    let finished: () => void = () => {};
    const turn: Live = {
      id: `tn_${randomId(16)}`,
      spec,
      state: "running",
      startedAt,
      endedAt: null,
      deadline: startedAt + this.limit.maxMinutes * 60_000,
      firstAnswer: answerId,
      ended: new Promise<void>((resolve) => (finished = resolve)),
      controller: new AbortController(),
      steering: new Steering(),
      offered: [],
      steers: 0,
      buffer: [],
      listeners: new Set(),
      answer: { content: "", model: null, steps: [], error: null, bank: false },
      answerId,
      stop: null,
      completed: false,
      model: null,
      step: null,
      tools: 0,
      timer: null,
      unwatched: null,
      windDown: null,
      settle: () => finished(),
    };
    this.turns.set(turn.id, turn);
    if (c) this.emit(turn, { type: "conversation", id: c.id, title: c.title, project: c.project });
    // The node's limit for one turn: past it, the turn is stopped and says so. Nothing is retried.
    turn.timer = setTimeout(() => this.halt(turn, "limit"), Math.max(0, turn.deadline - startedAt));
    (turn.timer as { unref?: () => void }).unref?.();
    this.watched(turn);
    void this.run(turn);
    return turn;
  }

  /**
   * Watch a turn: first what it is, then everything that happened so far, then what happens, and
   * `null` when it has ended. Returns how to stop watching (which stops nothing else).
   */
  subscribe(live: LiveTurn, listener: (event: ChatStreamEvent | null) => void, opts: { starting?: boolean } = {}): () => void {
    const turn = live as Live;
    // `replay`: this watcher came to a turn already under way (it rebuilds the turn from what follows).
    listener({ type: "turn", id: turn.id, conversation: turn.spec.conversation?.id ?? null, answer: turn.firstAnswer, role: turn.spec.role, startedAt: turn.startedAt, deadline: turn.deadline, replay: !opts.starting });
    for (const event of [...turn.buffer]) listener(event);
    if (turn.state !== "running") {
      listener(null);
      return () => {};
    }
    turn.listeners.add(listener);
    this.watched(turn);
    return () => {
      turn.listeners.delete(listener);
      this.watched(turn);
    };
  }

  /**
   * What a turn has said and done since its question, for a side question about it: the exchange so far
   * (an answer cut by a steer, the steer), then what he's said and each step he's taken since.
   */
  sofar(live: LiveTurn): TurnSoFar {
    const exchange: ChatMessage[] = [];
    let said = "";
    let steps: string[] = [];
    for (const event of (live as Live).buffer) {
      if (event.type === "text") said += event.text;
      else if (event.type === "tool") steps.push(`${event.title}${event.input ? ` ${event.input}` : ""}`);
      else if (event.type === "tool_result" && steps.length) steps[steps.length - 1] += ` → ${event.summary}`;
      else if (event.type === "steer") {
        if (said.trim()) exchange.push({ role: "assistant", content: said });
        exchange.push({ role: "user", content: event.text });
        said = "";
        steps = [];
      }
    }
    return { exchange, said, steps };
  }

  /** Stop a turn. True if it was running. */
  stop(id: string, reason: StopReason = "you"): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.state !== "running" || turn.completed) return false;
    this.halt(turn, reason);
    return true;
  }

  /** The owner's message for a running turn: it reaches him at the next safe point. */
  steer(id: string, text: string, by: QueuedBy): void {
    const turn = this.turns.get(id);
    if (!turn || turn.state !== "running" || turn.stop) throw new TurnError(409, "He has finished that turn. Send it as a new message.");
    if (turn.steers >= this.limit.maxSteers) throw new TurnError(429, `This turn has already been steered ${turn.steers} times, its limit. Queue the message, or stop him and ask again.`);
    if (!turn.steering.offer(text)) throw new TurnError(409, "He has finished that turn. Send it as a new message.");
    turn.steers += 1;
    turn.offered.push({ text, by });
  }

  /* ---------- the queue ---------- */

  /** Queue a message behind a kept chat. With nothing running in it and nothing holding it, its turn is now. */
  enqueue(conversation: string, message: { text: string; role: string | null; by: QueuedBy }): { queued: Queued; started: LiveTurn | null } {
    const { chats } = this.opts;
    if (chats.queue(conversation).length >= this.limit.maxQueued) {
      throw new TurnError(429, `${this.limit.maxQueued} messages are already queued behind this chat, the limit. Remove one, or wait for him to get to them.`);
    }
    const queued = chats.queueAdd(conversation, message);
    this.pump();
    // No longer in the queue: its turn came at once, and it's the one running in the chat now.
    const waiting = chats.queue(conversation).some((q) => q.id === queued.id);
    return { queued, started: waiting ? null : this.runningIn(conversation) };
  }

  /**
   * "Send now": with a turn running in the chat, the queued message steers it; otherwise it starts
   * as a turn at once, whatever holds the rest (they stay held).
   */
  sendNow(conversation: string, id: number, by: QueuedBy): { how: "steered" | "started"; turn: LiveTurn } {
    const { chats } = this.opts;
    const queued = chats.queue(conversation).find((q) => q.id === id);
    if (!queued) throw new TurnError(404, "That message is no longer queued.");
    const running = this.runningIn(conversation);
    if (running) {
      this.steer(running.id, queued.text, by);
      chats.queueTake(conversation, id);
      return { how: "steered", turn: running };
    }
    if (!this.prepare) throw new TurnError(503, "This node can't start turns yet.");
    this.admit(conversation);
    // Sent as whoever sends it now (they're here, and asked); every check an ordinary message gets applies.
    const spec = this.prepare(conversation, { ...queued, by });
    chats.queueTake(conversation, id);
    return { how: "started", turn: this.start(spec) };
  }

  /** A held queue goes on: its next message is sent as soon as nothing runs in the chat and the node has room. */
  resume(conversation: string): void {
    this.opts.chats.hold(conversation, null);
    this.pump();
  }

  /**
   * Send what's due: for each chat with messages queued, nothing running, nothing holding them and room on
   * the node, its first message becomes a turn. Called when a turn ends, a message is queued or a queue is
   * resumed; never on a timer, and never for a message twice.
   */
  pump(): void {
    if (this.closed || !this.prepare) return;
    const { chats } = this.opts;
    for (const conversation of chats.queuedConversations()) {
      const queue = chats.queue(conversation);
      const next = queue[0];
      if (!next || !mayDrain({ running: this.runningIn(conversation) !== null, held: chats.held(conversation), queued: queue.length }, { running: this.running().length, maxTurns: this.limit.maxTurns })) continue;
      let spec: TurnSpec;
      try {
        spec = this.prepare(conversation, next);
      } catch (error) {
        // It can't be sent as things stand (its device is gone, say): the queue waits for the owner.
        chats.hold(conversation, error instanceof TurnError && error.hold ? error.hold : "error");
        this.log(`a queued message wasn't sent: ${redact(String((error as Error)?.message ?? error)).slice(0, 200)}`);
        continue;
      }
      chats.queueTake(conversation, next.id);
      try {
        this.start(spec);
      } catch (error) {
        // No room after all: it goes back where it was, to be sent when a turn ends.
        chats.queueAdd(conversation, { text: next.text, role: next.role, by: next.by }, true);
        this.log(`a queued message waits: ${(error as Error).message}`);
      }
    }
  }

  /**
   * The node is stopping: no more turns start (nothing queued is sent), and the ones under way go on.
   * Resolves when they have all ended by themselves; `close()` stops whatever is left.
   */
  async drain(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.turns.values()].filter((t) => t.state === "running").map((t) => t.ended));
  }

  /** Stopped for good: every turn still going is stopped (its answer kept as stopped, what's queued behind it held). */
  async close(): Promise<void> {
    this.closed = true;
    const running = [...this.turns.values()].filter((t) => t.state === "running");
    for (const turn of running) this.halt(turn, "node");
    await Promise.all(running.map((t) => t.ended));
    for (const turn of this.turns.values()) {
      if (turn.timer) clearTimeout(turn.timer);
      if (turn.windDown) clearTimeout(turn.windDown);
    }
    this.turns.clear();
  }

  /* ---------- inside ---------- */

  /** Someone began or stopped watching: a temporary chat's turn with nobody watching is on borrowed time. */
  private watched(turn: Live): void {
    if (turn.spec.conversation || turn.state !== "running") return;
    if (turn.listeners.size) {
      if (turn.unwatched) clearTimeout(turn.unwatched);
      turn.unwatched = null;
    } else if (!turn.unwatched) {
      turn.unwatched = setTimeout(() => this.halt(turn, "unwatched"), this.limit.unwatchedMs);
      (turn.unwatched as { unref?: () => void }).unref?.();
    }
  }

  private halt(turn: Live, reason: StopReason): void {
    if (turn.state !== "running" || turn.stop || turn.completed) return;
    turn.stop = reason;
    turn.controller.abort();
    // It winds down by itself (the model call ends, a running tool finishes and reports). If something never
    // returns, it's recorded as stopped anyway, with what's known: nothing is left running in its name.
    turn.windDown = setTimeout(() => this.end(turn), this.limit.windDownMs);
    (turn.windDown as { unref?: () => void }).unref?.();
  }

  /** The turn is over: written down once, whoever gets here first (its own end, or a stop that ran out of patience). */
  private end(turn: Live): void {
    if (turn.state !== "running") return;
    try {
      this.finish(turn);
    } catch (error) {
      // Whatever went wrong writing it down, the turn is over and nobody waits on it forever.
      turn.state = "error";
      turn.endedAt = this.now();
      this.log(`a turn's end wasn't recorded: ${(error as Error).message}`);
      for (const listener of [...turn.listeners]) listener(null);
      turn.listeners.clear();
    }
    turn.settle();
  }

  private async run(turn: Live): Promise<void> {
    try {
      for await (const event of turn.spec.run(turn.steering, turn.controller.signal)) {
        // Already written down as stopped (it took too long to wind down): what trickles in after isn't recorded.
        if (turn.state !== "running") continue;
        // Stopped: the abort's own error isn't what happened to it.
        if (turn.stop && event.type === "error") continue;
        this.apply(turn, event);
      }
    } catch (error) {
      if (!turn.stop && turn.state === "running") this.apply(turn, { type: "error", error: redact(String((error as Error)?.message ?? error)).slice(0, 500) });
    } finally {
      this.end(turn);
    }
  }

  private apply(turn: Live, event: ChatStreamEvent): void {
    if (event.type === "steer") this.segment(turn, event.text);
    else keepStep(turn.answer, event);
    if (event.type === "model") {
      turn.model = event.ref;
      turn.step = "Thinking";
    } else if (event.type === "tool") {
      turn.tools += 1;
      turn.step = event.title;
    } else if (event.type === "tool_result") turn.step = "Thinking it over";
    else if (event.type === "text") turn.step = "Answering";
    else if (event.type === "steer") turn.step = "Reading your message";
    else if (event.type === "done") turn.completed = true;
    this.emit(turn, event);
  }

  /** A steer reached him: the answer so far is kept as it stands, the owner's message follows it, and a new answer begins. */
  private segment(turn: Live, text: string): void {
    const c = turn.spec.conversation;
    const before = turn.answer;
    // Nothing said and nothing done yet: there's no answer to keep, only what led up to it.
    const empty = !before.content.trim() && !before.steps.some((s) => s.kind === "tool");
    if (c && turn.answerId !== null) {
      if (empty) this.opts.chats.dropAnswer(c.id, turn.answerId);
      // (Read where it was being watched: you steered it from there.)
      else this.opts.chats.finishAnswer(c.id, turn.answerId, { ...before, status: "steered" }, turn.listeners.size > 0);
      this.opts.chats.addUser(c.id, text);
      turn.answerId = this.opts.chats.startAnswer(c.id);
    }
    const carried: StoredStep[] = empty ? before.steps : before.model ? [{ kind: "model", ref: before.model }] : [];
    turn.answer = { content: "", model: before.model, steps: carried, error: null, bank: before.bank };
  }

  private emit(turn: Live, event: ChatStreamEvent): void {
    const last = turn.buffer.at(-1);
    // A run of text is one event to whoever attaches later.
    if (event.type === "text" && last?.type === "text") turn.buffer[turn.buffer.length - 1] = { type: "text", text: last.text + event.text };
    else turn.buffer.push(event);
    for (const listener of [...turn.listeners]) listener(event);
  }

  private finish(turn: Live): void {
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    if (turn.unwatched) clearTimeout(turn.unwatched);
    turn.unwatched = null;
    if (turn.windDown) clearTimeout(turn.windDown);
    turn.windDown = null;
    const { chats } = this.opts;
    // A chat deleted while he worked in it has nowhere to keep the answer (deleting it is what stopped him).
    const c = turn.spec.conversation && chats.summary(turn.spec.conversation.id) ? turn.spec.conversation : null;
    const stopped = turn.completed ? null : turn.stop;
    if (stopped === "limit") {
      this.apply(turn, {
        type: "error",
        error: `This turn reached this node's limit of ${plural(this.limit.maxMinutes, "minute", "minutes")} for one turn and was stopped. Nothing is retried: ask again to go on from here.`,
      });
    } else if (stopped) this.emit(turn, { type: "stopped", reason: stopped });
    const state: TurnState = stopped && stopped !== "limit" ? "stopped" : turn.answer.error ? "error" : "done";

    // What never reached him isn't lost: in a kept chat it's queued, first in line; otherwise it's handed back.
    const left = turn.steering.close();
    if (left.length) {
      const theirs = turn.offered.slice(-left.length);
      if (c) for (const [i, text] of [...left.entries()].reverse()) chats.queueAdd(c.id, { text, role: null, by: theirs[i]?.by ?? turn.spec.by }, true);
      this.emit(turn, { type: "undelivered", texts: left, queued: Boolean(c) });
    }

    if (c) {
      // An answer a device watched to its end was read there; one nobody watched is new to you until you read it.
      if (turn.answerId !== null) chats.finishAnswer(c.id, turn.answerId, { ...turn.answer, status: state }, turn.listeners.size > 0);
      chats.setWaits(c.id, { actions: [...new Set(turn.spec.waits.actions)], secrets: [...new Set(turn.spec.waits.secrets)], question: state === "done" && endsWithQuestion(turn.answer.content) });
      // A turn that didn't end well holds what's queued behind it until the owner says to go on.
      const queued = chats.queue(c.id).length;
      const hold = stopped === "node" ? (queued ? "restart" : null) : holdAfter(state, queued);
      if (hold) chats.hold(c.id, hold);
    }

    turn.state = state;
    turn.endedAt = this.now();
    for (const listener of [...turn.listeners]) listener(null);
    turn.listeners.clear();
    // A page coming back a little later still sees how it went; then it's only in the kept chat.
    const gone = setTimeout(() => this.turns.delete(turn.id), this.limit.keepMs);
    (gone as { unref?: () => void }).unref?.();
    turn.timer = gone;
    this.pump();
  }
}
