import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { type AttachmentRef, type ChatStreamEvent, chatStateWords, pictureType, textOf, plainLine, plainStream, plainText, type ConversationSummary, type ConversationView, holdWords, questInHand, type QuestView, type QueuedMessage, type QueueHold, type TurnLimits, type TurnView } from "@galahad/core";
import type { NodeClient } from "./quest-cli.ts";

/*
 * Turns, queues and quests in hand, from a terminal. A turn started here runs on the
 * node like any other: `galahad ask` only watches it. Ctrl-C stops it, explicitly (the
 * terminal's Stop); a terminal that simply goes away stops nothing, and --detach leaves
 * him working on purpose. While he works in a chat, --steer tells him now and --queue
 * keeps the message on the node until he's done.
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

/** One running turn in a line: which chat, what he's doing, what it has cost so far, who's watching, when it stops by itself. */
export function turnLine(t: TurnView, now: number): string {
  // (A chat's title and the step he is on are a model's words: plain, like everything of his a terminal is shown.)
  const where = t.conversation ? `${plainLine(t.title ?? "a chat")} (${t.conversation})` : "a temporary chat";
  const watching = t.watchers === 0 ? "nobody watching" : t.watchers === 1 ? "1 watching" : `${t.watchers} watching`;
  const parts = [
    t.id,
    where,
    t.role,
    `${minutes(now - t.startedAt)} so far`,
    t.watchable ? plainLine(t.step ?? "starting") : "may read the bank: not shown to this device",
    t.tools ? `${t.tools} tool${t.tools === 1 ? "" : "s"}` : null,
    t.steering ? `${t.steering} of your messages waiting to reach him` : null,
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
const QUEST_STATE: Record<QuestView["state"], string> = {
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

/** A quest as the node shows it: where it stands, its plan with the step he's on, each gate's last result. */
export function questLines(q: QuestView, opts: { plan?: boolean } = {}): string[] {
  const attempt = q.attempt ? ` · attempt ${q.attempt.index} of ${q.attempt.attempts}` : "";
  const lines = [
    `${plainLine(q.goal)}  (${q.quest}${attempt} · run by ${plainLine(q.by)})`,
    `  ${QUEST_STATE[q.state]}${q.silent ? " (no word from its runner for a while: it may have been closed)" : ""} · command ${q.step} of ${q.maxSteps}${q.revisions ? ` · sent back ${q.revisions} time${q.revisions === 1 ? "" : "s"}` : ""}`,
  ];
  if (q.doing && questInHand(q.state)) lines.push(`  now: ${plainLine(q.doing)}`);
  if (opts.plan !== false && q.plan) lines.push(...plainText(q.plan).split("\n").map((l) => `    ${l}`));
  for (const [i, g] of q.gates.entries()) lines.push(`  gate ${i + 1}: ${GATE(g.exitCode)}  $ ${oneLine(g.command, 120)}  (${g.by === "owner" ? "yours" : "proposed by the planner"})`);
  if (q.summary && !questInHand(q.state)) lines.push(`  ${oneLine(q.summary, 300)}`);
  return lines;
}

/**
 * Print a turn's stream: his words on stdout, what he does beside them. Returns how it ended.
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
      io.err(dim(`[turn ${event.id}${event.replay ? " · from its start" : ""} · he goes on working if this terminal goes away; Ctrl-C stops him]\n`));
    } else if (event.type === "conversation") io.err(dim(`[chat ${event.id}${event.project ? ` · project ${event.project}` : ""}]\n`));
    else if (event.type === "text") io.out(plain(event.text));
    else if (event.type === "model") io.err(dim(`[${event.ref}]\n`));
    else if (event.type === "archive") io.err(dim(`[${event.entries.length && event.entries.every((e) => e.kind === "skill") ? "skills at hand" : "from the archive"}: ${event.entries.map((e) => `${e.id} ${plainLine(e.title)}${e.trust === "untrusted" ? " (untrusted)" : ""}`).join(" · ")}]\n`));
    else if (event.type === "tool") io.err(dim(`→ ${plainLine(event.title)}${event.input ? ` ${plainLine(event.input)}` : ""}\n`));
    else if (event.type === "tool_result") io.err(dim(`  ${event.ok ? "✓" : "✗"} ${plainLine(event.summary)}\n`));
    else if (event.type === "fallback") io.err(dim(`[skipped ${plainLine(event.from)}: ${plainLine(event.error)}]\n`));
    else if (event.type === "steer") io.err(`\n${dim("↳ your message reached him:")} ${plainText(event.text)}\n`);
    else if (event.type === "stopped") {
      how = "stopped";
      io.err(dim(`\n[${STOPPED[event.reason] ?? "stopped"}]\n`));
    } else if (event.type === "undelivered") {
      io.err(dim(`[${event.texts.length} of your messages didn't reach him before the turn ended${event.queued ? ": queued, first in line, held until you resume (galahad queue <chat> resume)" : ""}]\n`));
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
  /** He's working in --chat: tell him now. */
  steer?: boolean;
  /** He's working in --chat: keep it on the node, to send when he's done. */
  queue?: boolean;
  /** A side question about --chat: answered apart, added to nothing (unless --bring). */
  aside?: boolean;
  bring?: boolean;
  /** Start it and leave: he works on, and the answer is in the chat. */
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

/** `galahad ask`. Returns the process's exit code: 0 answered, 1 it failed, 130 stopped. */
export async function askCommand(node: NodeClient, text: string, o: AskOptions, io: Io = terminal, onInterrupt: (stop: () => void) => () => void = interruptWith): Promise<number> {
  const dim = dimIn(io);
  const modes = [o.steer, o.queue, o.aside].filter(Boolean).length;
  if (modes > 1) throw new Error("give one of --steer, --queue or --aside");
  if (modes && !o.chat) throw new Error("--steer, --queue and --aside go with --chat <id>: the chat he's working in (galahad turns lists them)");
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
      io.err(dim(how === "steered" ? "[brought back: it reaches him at his next safe point]\n" : "[brought back: it's in the chat now]\n"));
    }
    return 0;
  }

  if (o.queue) {
    const { queue, held, started } = await node.call<{ queue: QueuedMessage[]; held: QueueHold | null; started: TurnView | null }>("queueMessage", { conversation: o.chat, text, ...(o.role ? { role: o.role } : {}) });
    if (started) io.err(dim(`[nothing was running in that chat, so its turn is now: ${started.id} · galahad turn watch ${started.id}]\n`));
    else for (const line of queueLines(queue, held)) io.err(`${line}\n`);
    return 0;
  }

  let events: AsyncGenerator<ChatStreamEvent>;
  if (o.steer) {
    const { conversation } = await node.call<{ conversation: ConversationView }>("conversation", { id: o.chat });
    if (conversation.turn) {
      await node.call("steerTurn", { turn: conversation.turn.id, text });
      io.err(dim("[told him: it reaches him at his next safe point (a tool that's running finishes first)]\n"));
      events = node.stream("attachTurn", { turn: conversation.turn.id });
    } else {
      io.err(dim("[he isn't working in that chat: sent as a message]\n"));
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
    // Long enough to know which turn it is; then he's left to it.
    for await (const event of events) {
      if (event.type === "turn") {
        io.err(`${event.id}${event.conversation ? ` in chat ${event.conversation}` : ""}\n`);
        io.err(dim(`[he's working, and goes on without this terminal · galahad turn watch ${event.id} · galahad turn stop ${event.id}${event.conversation ? ` · the answer will be in: galahad chat ${event.conversation}` : ""}]\n`));
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
    io.err(dim("\n[stopping him…]\n"));
    void node.call("stopTurn", { turn }).catch(() => {});
  });
  try {
    const { how, error } = await printTurn(events, io, (t) => (turn = t.id));
    if (how === "error") throw new Error(error ?? "he couldn't answer");
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
  if (!conversation.turn) throw new Error(`he isn't working in ${ref} (galahad chat ${ref} has how its last turn went)`);
  return conversation.turn.id;
}

/** `galahad turns` · `galahad turn watch|stop <turn|chat>`. */
export async function turnsCommand(node: NodeClient, sub: string | undefined, rest: string[], io: Io = terminal): Promise<number> {
  const dim = dimIn(io);
  if (!sub || sub === "ls") {
    const [{ turns, limits }, { conversations }] = await Promise.all([node.call<{ turns: TurnView[]; limits: TurnLimits }>("turns"), node.call<{ conversations: ConversationSummary[] }>("conversations")]);
    const now = Date.now();
    if (!turns.length) io.out("He isn't working on any turn of yours on this node.\n");
    for (const t of turns) io.out(`● ${turnLine(t, now)}\n`);
    for (const c of conversations.filter((c) => c.queued > 0 && !turns.some((t) => t.conversation === c.id))) io.out(`  ${c.title} (${c.id}): ${chatStateWords(c)} ${dim(`· galahad queue ${c.id}`)}\n`);
    io.out(dim(`At most ${limits.maxTurns} turns at once on this node, ${limits.maxMinutes} minutes each, ${limits.maxQueued} messages queued behind a chat. A turn nobody watches still spends model tokens; what needs you (an approval, a key) waits for you, and nothing is approved for you.\n`));
    return 0;
  }
  if ((sub === "watch" || sub === "stop") && rest[0]) {
    const turn = await turnOf(node, rest[0]);
    if (sub === "stop") {
      const { stopped } = await node.call<{ stopped: boolean }>("stopTurn", { turn });
      io.out(stopped ? "Stopped. What he'd said is kept; anything queued behind it is held until you resume.\n" : "It had already ended.\n");
      return 0;
    }
    const { how, error } = await printTurn(node.stream("attachTurn", { turn }), io);
    if (how === "error") throw new Error(error ?? "he couldn't answer");
    return how === "stopped" ? 130 : 0;
  }
  throw new Error("usage: galahad turns | galahad turn watch <turn|chat> | galahad turn stop <turn|chat>");
}

/** `galahad queue <chat> [add "…" | edit <n> "…" | rm <n|all> | send <n> | resume]`. */
export async function queueCommand(node: NodeClient, chat: string | undefined, sub: string | undefined, rest: string[], io: Io = terminal): Promise<number> {
  const usage = 'usage: galahad queue <chat> [add "<message>" | edit <n> "<message>" | rm <n|all> | send <n> | resume]';
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
    if (!n || !/^\d+$/.test(n) || !item) throw new Error(`there is no message ${n ?? ""} in that queue (galahad queue ${chat} lists them)`);
    return item.id;
  };
  if (!sub) show(await current());
  else if (sub === "add" && rest[0]) show(await node.call("queueMessage", { conversation: chat, text: rest.join(" ") }));
  else if (sub === "edit" && rest[1]) show(await node.call("editQueued", { conversation: chat, id: await nth(rest[0]), text: rest.slice(1).join(" ") }));
  else if (sub === "rm" && rest[0]) show(await node.call("removeQueued", rest[0] === "all" ? { conversation: chat } : { conversation: chat, id: await nth(rest[0]) }));
  else if (sub === "send" && rest[0]) {
    const sent = await node.call<{ how: "steered" | "started"; turn: TurnView; queue: QueuedMessage[]; held: QueueHold | null }>("sendQueued", { conversation: chat, id: await nth(rest[0]) });
    io.out(sent.how === "steered" ? "Told him now: it reaches him at his next safe point.\n" : `Started as a turn: ${sent.turn.id} (galahad turn watch ${sent.turn.id}).\n`);
    show(sent);
  } else if (sub === "resume") {
    const resumed = await node.call<{ queue: QueuedMessage[]; held: QueueHold | null; turn: TurnView | null }>("resumeQueue", { conversation: chat });
    io.out(resumed.turn ? `Resumed: he's on the next one (${resumed.turn.id}).\n` : "Resumed.\n");
    show(resumed);
  } else throw new Error(usage);
  return 0;
}

/** `galahad quests [--all]`: the quests in hand on this node, and the ones that just ended. */
export async function questsCommand(node: NodeClient, all: boolean, io: Io = terminal): Promise<number> {
  const bold = boldIn(io);
  const dim = dimIn(io);
  const { quests } = await node.call<{ quests: QuestView[] }>("quests");
  const inHand = quests.filter((q) => questInHand(q.state));
  const ended = quests.filter((q) => !questInHand(q.state));
  if (!inHand.length) io.out('No quest in hand on this node. `galahad do "<goal>" --gate "<command>"` starts one.\n');
  for (const q of inHand) {
    const [head, ...lines] = questLines(q);
    io.out(`${bold(`◇ ${head}`)}\n${lines.join("\n")}\n\n`);
  }
  const shown = all ? ended : ended.slice(0, 5);
  if (shown.length) io.out(dim(`Ended lately${all || ended.length <= shown.length ? "" : ` (the latest ${shown.length} of ${ended.length}; --all shows every one)`}:\n`));
  for (const q of shown) io.out(`${questLines(q, { plan: all }).join("\n")}\n`);
  return 0;
}
