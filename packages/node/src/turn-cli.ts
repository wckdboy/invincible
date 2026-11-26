import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { type AttachmentRef, type ChatStreamEvent, chatStateWords, pictureType, textOf, plainLine, plainStream, plainText, type ConversationSummary, type ConversationView, holdWords, runInHand, type RunView, type QueuedMessage, type QueueHold, type TurnLimits, type TurnView } from "@invincible/core";
import type { NodeClient } from "./run-cli.ts";

/*
 * Turns, queues and runs in hand, from a terminal. A turn started here runs on the
 * node like any other: `invincible ask` only watches it. Ctrl-C stops it, explicitly (the
 * terminal's Stop); a terminal that simply goes away stops nothing, and --detach leaves
 * it working on purpose. While it works in a chat, --steer tells it now and --queue
 * keeps the message on the node until it's done.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
  tty: boolean;
}

const terminal: Io = { out: (text) => void process.stdout.write(text), err: (text) => void process.stderr.write(text), tty: Boolean(process.stdout.isTTY) };
const dimIn = (io: Io) => (s: string) => (io.tty ? `\x1b[2m${s}\x1b[0m` : s);
const boldIn = (io: Io) => (s: string) => (io.tty ? `\x1b[1m${s}\x1b[0m` : s);

const minutes = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? "under a minute" : `${m} min`;
};
const oneLine = (text: string, max = 100): string => {
  const flat = plainLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const STOPPED: Record<string, string> = { you: "stopped by you", limit: "stopped at the node's limit for one turn", node: "stopped: the node itself was stopping", unwatched: "stopped: a temporary chat's turn, and nobody was watching it any more" };

/** One running turn in a line: which chat, what it's doing, what it has cost so far, who's watching, when it stops by itself. */
export function turnLine(t: TurnView, now: number): string {
  // (A chat's title and the step it is on are a model's words: plain, like everything of its a terminal is shown.)
  const where = t.conversation ? `${plainLine(t.title ?? "a chat")} (${t.conversation})` : "a temporary chat";
  const watching = t.watchers === 0 ? "nobody watching" : t.watchers === 1 ? "1 watching" : `${t.watchers} watching`;
  const parts = [
    t.id,
    where,
    t.role,
    `${minutes(now - t.startedAt)} so far`,
    t.watchable ? plainLine(t.step ?? "starting") : "started on another device: not shown to this one",
    t.tools ? `${t.tools} tool${t.tools === 1 ? "" : "s"}` : null,
    t.steering ? `${t.steering} of your messages waiting to reach it` : null,
    watching,
    `stops by itself in ${minutes(t.deadline - now)}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** A chat's queue, a line a message, and whether it's held. */
export function queueLines(queue: readonly QueuedMessage[], held: QueueHold | null): string[] {
  if (!queue.length) return ["Nothing queued."];
  const head = held ? `${queue.length} queued, held: ${holdWords(held)}. Nothing is sent until you resume (or send one now).` : `${queue.length} queued: each is sent as the next turn when the one before it ends well.`;
  return [head, ...queue.map((q, i) => `  ${i + 1}. ${oneLine(q.text, 140)}${q.by ? `  (from ${q.by})` : ""}`)];
}

const GATE = (exitCode: number | null): string => (exitCode === null ? "not run yet" : exitCode === 0 ? "passed" : `failed (exit ${exitCode})`);
const RUN_STATE: Record<RunView["state"], string> = {
  planning: "planning",
  working: "working",
  gating: "running its gates",
  reviewing: "under review",
  done: "done, and an independent review agrees",
  unverified: "finished, but not accepted",
  "gave-up": "gave up",
  stopped: "stopped",
  failed: "couldn't run",
};

/** A run as the node shows it: where it stands, its plan with the step it's on, each gate's last result. */
export function runLines(q: RunView, opts: { plan?: boolean } = {}): string[] {
  const attempt = q.attempt ? ` · attempt ${q.attempt.index} of ${q.attempt.attempts}` : "";
  const lines = [
    `${plainLine(q.goal)}  (${q.run}${attempt} · run by ${plainLine(q.by)})`,
    `  ${RUN_STATE[q.state]}${q.silent ? " (no word from its runner for a while: it may have been closed)" : ""} · command ${q.step} of ${q.maxSteps}${q.revisions ? ` · sent back ${q.revisions} time${q.revisions === 1 ? "" : "s"}` : ""}`,
  ];
  if (q.doing && runInHand(q.state)) lines.push(`  now: ${plainLine(q.doing)}`);
  if (opts.plan !== false && q.plan) lines.push(...plainText(q.plan).split("\n").map((l) => `    ${l}`));
  for (const [i, g] of q.gates.entries()) lines.push(`  gate ${i + 1}: ${GATE(g.exitCode)}  $ ${oneLine(g.command, 120)}  (${g.by === "owner" ? "yours" : "proposed by the planner"})`);
  if (q.summary && !runInHand(q.state)) lines.push(`  ${oneLine(q.summary, 300)}`);
  return lines;
}

/**
 * Print a turn's stream: its words on stdout, what it does beside them. Returns how it ended.
 * `onTurn` is told which turn it is as soon as the stream says (to stop it by).
 */
export async function printTurn(events: AsyncGenerator<ChatStreamEvent>, io: Io = terminal, onTurn?: (turn: Extract<ChatStreamEvent, { type: "turn" }>) => void): Promise<{ how: "done" | "error" | "stopped"; error?: string }> {
  const dim = dimIn(io);
  const plain = plainStream();
  let how: "done" | "error" | "stopped" = "done";
  let error: string | undefined;
  for await (const event of events) {
    if (event.type === "turn") {
      onTurn?.(event);
      io.err(dim(`[turn ${event.id}${event.replay ? " · from its start" : ""} · it goes on working if this terminal goes away; Ctrl-C stops it]\n`));
    } else if (event.type === "conversation") io.err(dim(`[chat ${event.id}${event.project ? ` · project ${event.project}` : ""}]\n`));
    else if (event.type === "text") io.out(plain(event.text));
    else if (event.type === "model") io.err(dim(`[${event.ref}]\n`));
    else if (event.type === "archive") io.err(dim(`[${event.entries.length && event.entries.every((e) => e.kind === "skill") ? "skills at hand" : "from the archive"}: ${event.entries.map((e) => `${e.id} ${plainLine(e.title)}${e.trust === "untrusted" ? " (untrusted)" : ""}`).join(" · ")}]\n`));
    else if (event.type === "tool") io.err(dim(`→ ${plainLine(event.title)}${event.input ? ` ${plainLine(event.input)}` : ""}\n`));
    else if (event.type === "tool_result") io.err(dim(`  ${event.ok ? "✓" : "✗"} ${plainLine(event.summary)}\n`));
    else if (event.type === "fallback") io.err(dim(`[skipped ${plainLine(event.from)}: ${plainLine(event.error)}]\n`));
    else if (event.type === "steer") io.err(`\n${dim("↳ your message reached it:")} ${plainText(event.text)}\n`);
    else if (event.type === "stopped") {
      how = "stopped";
      io.err(dim(`\n[${STOPPED[event.reason] ?? "stopped"}]\n`));
    } else if (event.type === "undelivered") {
      io.err(dim(`[${event.texts.length} of your messages didn't reach it before the turn ended${event.queued ? ": queued, first in line, held until you resume (invincible queue <chat> resume)" : ""}]\n`));
    } else if (event.type === "error") {
      how = "error";
      error = event.error;
    }
  }
  io.out("\n");
  return { how, ...(error ? { error } : {}) };
}

export interface AskOptions {
  role?: string;
  model?: string;
  chat?: string;
  project?: string;
  temp?: boolean;
  /** It's working in --chat: tell it now. */
  steer?: boolean;
  /** It's working in --chat: keep it on the node, to send when it's done. */
  queue?: boolean;
  /** A side question about --chat: answered apart, added to nothing (unless --bring). */
  aside?: boolean;
  bring?: boolean;
  /** Start it and leave: it works on, and the answer is in the chat. */
  detach?: boolean;
  /** Files to go with your message: pictures, and text (a log, code), each sent up to the node first. */
  attach?: string[];
}

/** Your files, sent up to the node (uploadAttachment): each a picture or a text by its bytes, as the node will check it. */
async function attachments(node: NodeClient, paths: readonly string[]): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const path of paths) {
    const bytes = new Uint8Array(readFileSync(path));
    const type = pictureType(bytes) ?? (textOf(bytes) !== null ? "text/plain" : null);
    if (!type) throw new Error(`${path} is neither a picture (PNG, JPEG, WebP, GIF) nor text: only those go with a message`);
    const { attachment } = await node.call<{ attachment: AttachmentRef }>("uploadAttachment", { name: basename(path), type, data: Buffer.from(bytes).toString("base64") });
    refs.push(attachment);
  }
  return refs;
}

/** `invincible ask`. Returns the process's exit code: 0 answered, 1 it failed, 130 stopped. */
export async function askCommand(node: NodeClient, text: string, o: AskOptions, io: Io = terminal, onInterrupt: (stop: () => void) => () => void = interruptWith): Promise<number> {
  const dim = dimIn(io);
  const modes = [o.steer, o.queue, o.aside].filter(Boolean).length;
  if (modes > 1) throw new Error("give one of --steer, --queue or --aside");
  if (modes && !o.chat) throw new Error("--steer, --queue and --aside go with --chat <id>: the chat it's working in (invincible turns lists them)");
  if (o.bring && !o.aside) throw new Error("--bring goes with --aside");
  if (o.attach?.length && modes) throw new Error("--attach goes with a message of yours, not --steer, --queue or --aside");
  // A temporary chat is kept nowhere: a turn of it that nobody watches is stopped by the node, so there's nothing to come back to.
  if (o.detach && o.temp && !o.chat) throw new Error("--detach needs a kept chat (drop --temp): a temporary chat's turn is stopped once nobody is watching it");

  if (o.aside) {
    let aside = "";
    let failed: string | undefined;
    const plain = plainStream();
    for await (const event of node.stream("askAside", { conversation: o.chat, question: text })) {
      if (event.type === "aside") aside = event.id;
      else if (event.type === "model") io.err(dim(`[a side question · ${event.ref} · no tools, added to nothing]\n`));
      else if (event.type === "text") io.out(plain(event.text));
      else if (event.type === "error") failed = event.error;
    }
    io.out("\n");
    if (failed) throw new Error(failed);
    if (o.bring && aside) {
      const { how } = await node.call<{ how: "steered" | "kept" }>("bringBack", { aside });
      io.err(dim(how === "steered" ? "[brought back: it reaches it at its next safe point]\n" : "[brought back: it's in the chat now]\n"));
    }
    return 0;
  }

  if (o.queue) {
    const { queue, held, started } = await node.call<{ queue: QueuedMessage[]; held: QueueHold | null; started: TurnView | null }>("queueMessage", { conversation: o.chat, text, ...(o.role ? { role: o.role } : {}) });
    if (started) io.err(dim(`[nothing was running in that chat, so its turn is now: ${started.id} · invincible turn watch ${started.id}]\n`));
    else for (const line of queueLines(queue, held)) io.err(`${line}\n`);
    return 0;
  }

  let events: AsyncGenerator<ChatStreamEvent>;
  if (o.steer) {
    const { conversation } = await node.call<{ conversation: ConversationView }>("conversation", { id: o.chat });
    if (conversation.turn) {
      await node.call("steerTurn", { turn: conversation.turn.id, text });
      io.err(dim("[told it: it reaches it at its next safe point (a tool that's running finishes first)]\n"));
      events = node.stream("attachTurn", { turn: conversation.turn.id });
    } else {
      io.err(dim("[it isn't working in that chat: sent as a message]\n"));
      events = node.stream("chat", { role: o.role, model: o.model, messages: [{ role: "user", content: text }], conversation: o.chat });
    }
  } else {
    const carried = o.attach?.length ? await attachments(node, o.attach) : [];
    if (carried.length) io.err(dim(`[attached: ${carried.map((a) => `${a.name} (${Math.max(1, Math.round(a.bytes / 1024))} KB)`).join(", ")}]\n`));
    // Kept in your history like the app's chats, unless --temp; --chat goes on with one.
    events = node.stream("chat", {
      role: o.role,
      model: o.model,
      messages: [{ role: "user", content: text, ...(carried.length ? { attachments: carried } : {}) }],
      ...(o.chat ? { conversation: o.chat } : o.temp ? {} : { save: true }),
      ...(o.project && !o.chat ? { project: o.project } : {}),
    });
  }

  if (o.detach) {
    // Long enough to know which turn it is; then it's left to it.
    for await (const event of events) {
      if (event.type === "turn") {
        io.err(`${event.id}${event.conversation ? ` in chat ${event.conversation}` : ""}\n`);
        io.err(dim(`[it's working, and goes on without this terminal · invincible turn watch ${event.id} · invincible turn stop ${event.id}${event.conversation ? ` · the answer will be in: invincible chat ${event.conversation}` : ""}]\n`));
        break;
      }
      if (event.type === "error") throw new Error(event.error);
    }
    return 0;
  }

  // Ctrl-C is this terminal's Stop: said to the node, which stops the turn and keeps the answer so far.
  let turn: string | null = null;
  let asked = false;
  const release = onInterrupt(() => {
    if (!turn || asked) return;
    asked = true;
    io.err(dim("\n[stopping it…]\n"));
    void node.call("stopTurn", { turn }).catch(() => {});
  });
  try {
    const { how, error } = await printTurn(events, io, (t) => (turn = t.id));
    if (how === "error") throw new Error(error ?? "it couldn't answer");
    return how === "stopped" ? 130 : 0;
  } finally {
    release();
  }
}

/** The first Ctrl-C asks for a stop; a second one leaves at once (the stop, if it was asked, still stands). */
function interruptWith(stop: () => void): () => void {
  let presses = 0;
  const handler = (): void => {
    presses += 1;
    if (presses > 1) process.exit(130);
    stop();
  };
  process.on("SIGINT", handler);
  return () => void process.off("SIGINT", handler);
}

/** A turn by its id, or the one running in a chat. */
async function turnOf(node: NodeClient, ref: string): Promise<string> {
  if (!ref.startsWith("cv_")) return ref;
  const { conversation } = await node.call<{ conversation: ConversationView }>("conversation", { id: ref });
  if (!conversation.turn) throw new Error(`it isn't working in ${ref} (invincible chat ${ref} has how its last turn went)`);
  return conversation.turn.id;
}

/** `invincible turns` · `invincible turn watch|stop <turn|chat>`. */
export async function turnsCommand(node: NodeClient, sub: string | undefined, rest: string[], io: Io = terminal): Promise<number> {
  const dim = dimIn(io);
  if (!sub || sub === "ls") {
    const [{ turns, limits }, { conversations }] = await Promise.all([node.call<{ turns: TurnView[]; limits: TurnLimits }>("turns"), node.call<{ conversations: ConversationSummary[] }>("conversations")]);
    const now = Date.now();
    if (!turns.length) io.out("It isn't working on any turn of yours on this node.\n");
    for (const t of turns) io.out(`● ${turnLine(t, now)}\n`);
    for (const c of conversations.filter((c) => c.queued > 0 && !turns.some((t) => t.conversation === c.id))) io.out(`  ${c.title} (${c.id}): ${chatStateWords(c)} ${dim(`· invincible queue ${c.id}`)}\n`);
    io.out(dim(`At most ${limits.maxTurns} turns at once on this node, ${limits.maxMinutes} minutes each, ${limits.maxQueued} messages queued behind a chat. A turn nobody watches still spends model tokens; what needs you (an approval, a key) waits for you, and nothing is approved for you.\n`));
    return 0;
  }
  if ((sub === "watch" || sub === "stop") && rest[0]) {
    const turn = await turnOf(node, rest[0]);
    if (sub === "stop") {
      const { stopped } = await node.call<{ stopped: boolean }>("stopTurn", { turn });
      io.out(stopped ? "Stopped. What it'd said is kept; anything queued behind it is held until you resume.\n" : "It had already ended.\n");
      return 0;
    }
    const { how, error } = await printTurn(node.stream("attachTurn", { turn }), io);
    if (how === "error") throw new Error(error ?? "it couldn't answer");
    return how === "stopped" ? 130 : 0;
  }
  throw new Error("usage: invincible turns | invincible turn watch <turn|chat> | invincible turn stop <turn|chat>");
}

/** `invincible queue <chat> [add "…" | edit <n> "…" | rm <n|all> | send <n> | resume]`. */
export async function queueCommand(node: NodeClient, chat: string | undefined, sub: string | undefined, rest: string[], io: Io = terminal): Promise<number> {
  const usage = 'usage: invincible queue <chat> [add "<message>" | edit <n> "<message>" | rm <n|all> | send <n> | resume]';
  if (!chat) throw new Error(usage);
  const show = (view: { queue: QueuedMessage[]; held: QueueHold | null }): void => {
    for (const line of queueLines(view.queue, view.held)) io.out(`${line}\n`);
  };
  const current = async (): Promise<{ queue: QueuedMessage[]; held: QueueHold | null }> => {
    const { conversation } = await node.call<{ conversation: ConversationView }>("conversation", { id: chat });
    return { queue: conversation.queue, held: conversation.held };
  };
  const nth = async (n: string | undefined): Promise<number> => {
    const { queue } = await current();
    const item = queue[Number(n) - 1];
    if (!n || !/^\d+$/.test(n) || !item) throw new Error(`there is no message ${n ?? ""} in that queue (invincible queue ${chat} lists them)`);
    return item.id;
  };
  if (!sub) show(await current());
  else if (sub === "add" && rest[0]) show(await node.call("queueMessage", { conversation: chat, text: rest.join(" ") }));
  else if (sub === "edit" && rest[1]) show(await node.call("editQueued", { conversation: chat, id: await nth(rest[0]), text: rest.slice(1).join(" ") }));
  else if (sub === "rm" && rest[0]) show(await node.call("removeQueued", rest[0] === "all" ? { conversation: chat } : { conversation: chat, id: await nth(rest[0]) }));
  else if (sub === "send" && rest[0]) {
    const sent = await node.call<{ how: "steered" | "started"; turn: TurnView; queue: QueuedMessage[]; held: QueueHold | null }>("sendQueued", { conversation: chat, id: await nth(rest[0]) });
    io.out(sent.how === "steered" ? "Told it now: it reaches it at its next safe point.\n" : `Started as a turn: ${sent.turn.id} (invincible turn watch ${sent.turn.id}).\n`);
    show(sent);
  } else if (sub === "resume") {
    const resumed = await node.call<{ queue: QueuedMessage[]; held: QueueHold | null; turn: TurnView | null }>("resumeQueue", { conversation: chat });
    io.out(resumed.turn ? `Resumed: it's on the next one (${resumed.turn.id}).\n` : "Resumed.\n");
    show(resumed);
  } else throw new Error(usage);
  return 0;
}

/** `invincible runs [--all]`: the runs in hand on this node, and the ones that just ended. */
export async function runsCommand(node: NodeClient, all: boolean, io: Io = terminal): Promise<number> {
  const bold = boldIn(io);
  const dim = dimIn(io);
  const { runs } = await node.call<{ runs: RunView[] }>("runs");
  const inHand = runs.filter((q) => runInHand(q.state));
  const ended = runs.filter((q) => !runInHand(q.state));
  if (!inHand.length) io.out('No run in hand on this node. `invincible do "<goal>" --gate "<command>"` starts one.\n');
  for (const q of inHand) {
    const [head, ...lines] = runLines(q);
    io.out(`${bold(`◇ ${head}`)}\n${lines.join("\n")}\n\n`);
  }
  const shown = all ? ended : ended.slice(0, 5);
  if (shown.length) io.out(dim(`Ended lately${all || ended.length <= shown.length ? "" : ` (the latest ${shown.length} of ${ended.length}; --all shows every one)`}:\n`));
  for (const q of shown) io.out(`${runLines(q, { plan: all }).join("\n")}\n`);
  return 0;
}
