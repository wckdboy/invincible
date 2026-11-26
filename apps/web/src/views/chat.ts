import type { AttachmentRef, AwayView, ChatMessage, ChatStreamEvent, ConversationSummary, ConversationView, ProjectView, QuestView, UnreadChat } from "@galahad/core";
import { findSecrets } from "@galahad/core/secret-scan";
import type { QueuedMessage, QueueHold, TurnView } from "@galahad/core/turns";
import { type Api, ApiError, isAbort } from "../api.ts";
import { errorMessage, type Live, type View } from "../context.ts";
import { isWaiting } from "../live.ts";
import { type ChatAction, chatActions, CHATS_MENU, filterConversations, groupConversations, mostRecent } from "../lib/chats.ts";
import { galahadNow, type NowInput } from "../lib/now.ts";
import { questInHand } from "../lib/quests.ts";
import { galahadNeeds } from "../lib/roster.ts";
import { plural } from "../lib/text.ts";
import { duration, relativeTime } from "../lib/time.ts";
import { lookedWords } from "../lib/underway.ts";
import { applyEvent, asideOf, beginTurn, composerAction, composerHint, connectorsAskedIn, endTurn, failTurn, keysAskedIn, shownAgain, stateBadge, type Step, type Thread, type Turn, turnOf } from "../lib/turns.ts";
import { awaySince, chatEnter, lastRole, markAwaySeen, openChatId, rememberOpenChat, rememberRole } from "../prefs.ts";
import type { RoleSpec } from "../types.ts";
import { badge, button, callout, copyText, dot, empty, skeletonRows, spinner } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { debounce, h, replace } from "../ui/dom.ts";
import { orb } from "../ui/orb.ts";
import { galahadState } from "../lib/knight-state.ts";
import { orbMoodOfState } from "../lib/orb-motion.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { selector, type SelectorGroup } from "../ui/selector.ts";
import { signal } from "../ui/signal.ts";
import { toast } from "../ui/toast.ts";
import { attachedView, attachTray, type Waiting } from "./attach-tray.ts";
import { openAside } from "./chat-aside.ts";
import { openComputer } from "./computer.ts";
import { underway } from "./underway.ts";
import { queuePanel } from "./chat-queue.ts";
import { openInHand } from "./in-hand.ts";
import { openAddKey, secretRequestCard } from "./vault.ts";
import { connectorRequestCard } from "./connectors.ts";
import { galahadAsks } from "./galahad-asks.ts";

/*
 * Chat. A turn runs on the node, not in this page: the page starts it and watches
 * it, and if the page goes away (a locked phone, a reload, another tab) the turn goes
 * on, and whoever opens the chat next attaches to it and sees it from its start. Stop
 * is always one click (or Esc) away, here or in the top bar, and it is said to the
 * node: it is the only thing that stops him. While he works, a new message steers him
 * (he's told at his next safe point) or is queued on the node (sent when he's done).
 * The conversation is kept by the node; nothing of it is written to this device.
 */

/** Which icon a tool's step shows. */
function toolIcon(name: string): IconName {
  if (name.startsWith("bank_")) return "bank";
  if (name.startsWith("sandbox_")) return "sandbox";
  if (name.startsWith("connector")) return "plug";
  if (name.startsWith("artifact")) return "archive";
  if (name.startsWith("archive_")) return "library";
  const icons: Record<string, IconName> = { recall: "memory", remember: "memory", web_search: "globe", fleet: "fleet", place: "fleet", loops: "repeat", loop_draft: "repeat", notices: "inbox", ledger: "activity", decide: "compass", request_secret: "key", connector_request: "plug", note_idea: "lightbulb" };
  return icons[name] ?? "zap";
}
/** A step's icon: a tool's own, or the step's. */
const stepIcon = (s: Step): IconName => (s.toolName ? toolIcon(s.toolName) : (s.icon as IconName));

const DEFAULT_ROLES: Record<string, RoleSpec> = {
  planner: { models: [], configured: false, description: "decomposes quests, makes judgment calls, talks to you" },
  engineer: { models: [], configured: false, description: "writes and changes code" },
  reviewer: { models: [], configured: false, description: "independent check, ideally a different model family" },
  swift: { models: [], configured: false, description: "cheap and fast: routing, classification, summaries" },
};
const ROLE_ICON: Record<string, IconName> = { planner: "compass", engineer: "code", reviewer: "review", swift: "zap", decider: "sparkle" };
const ACTION_ICON: Record<ChatAction["value"], IconName> = { aside: "chat", rename: "edit", pin: "pin", delete: "trash" };
const roleTitle = (name: string): string => name[0]!.toUpperCase() + name.slice(1);
/** A model as people say it: "claude-opus-5-5" for anthropic/claude-opus-5-5, "ollama" for ollama/*. */
const modelName = (ref: string | undefined): string => {
  if (!ref) return "";
  const [provider, ...rest] = ref.split("/");
  const model = rest.join("/");
  return !model || model === "*" ? (provider ?? ref) : model;
};
/** Why a role can't answer a chat, if it can't. */
function roleProblem(name: string): string | null {
  if (name === "decider") return "Answers typed decisions, not chat";
  if (roster && roster[name] && !roster[name]!.models.length) return "No model hired yet";
  return null;
}

// ---- module state: survives navigation; the conversation itself, and the turn, are kept by the node ----
const thread: Thread = { turns: [], nextId: 1, target: null, base: null };
let draft = "";
/** Your next message's files: kept while you look elsewhere, as its words are. */
let waiting: Waiting[] = [];
let role = lastRole() ?? "planner";
let roster: Record<string, RoleSpec> | null = null;
const changed = new Set<(turn: Turn | null) => void>();

/**
 * The turn this page is watching: started here, or attached to. `id` is null for the moment between
 * sending and the node saying which turn it is. Leaving (another chat, another page) ends the
 * watching, never the turn.
 */
interface Watching {
  api: Api;
  id: string | null;
  /** When the node stops it by itself. */
  deadline: number | null;
  watch: AbortController;
  /** Stop was asked before the node had said which turn it is. */
  stopAsked: boolean;
  /** Reconnections tried since the last word from the node. */
  tries: number;
}
let live: Watching | null = null;
/** What you queued behind this chat, and why it's held if it is. */
let queue: QueuedMessage[] = [];
let held: QueueHold | null = null;
/** Messages sent to steer him that haven't reached him yet (he's mid-tool, or mid-thought). */
let steering: string[] = [];
/** A turn is running in this chat that this device may not watch (it may read the bank). */
let unwatchable: TurnView | null = null;
/** The chat turns the node is running, as last asked (his line of what he's doing, in the chat's header and on the roster). */
export const nodeTurns = signal<TurnView[]>([]);
/** The quests in hand, as last asked. */
export const questsInHand = signal<QuestView[]>([]);
/** His chats with an answer you haven't read yet, on any device, as last asked (his ring is green while there are some). */
export const unreadChats = signal<UnreadChat[]>([]);
/** The step he is at in the answer this page watches (null: only just started; undefined: it watches none). */
export const answerStep = signal<string | null | undefined>(undefined);
const syncStep = (): void => answerStep.set(live ? (thread.target?.steps.at(-1)?.text ?? null) : undefined);
/** What he has in hand, for his line wherever it is shown (lib/now.ts). */
export const galahadWork = (): Pick<NowInput, "step" | "turns" | "quests" | "unread"> => ({ ...(answerStep.value === undefined ? {} : { step: answerStep.value }), turns: nodeTurns.value, quests: questsInHand.value, unread: unreadChats.value });
/** A chat is on screen, and asks the node what he is doing itself. */
let chatOnScreen = false;

/** The turns the node runs, kept only when they changed (who is told redraws). */
function noteTurns(turns: TurnView[]): boolean {
  const of = (list: TurnView[]) => list.map((t) => `${t.id}:${t.conversation}:${t.title}`).sort().join(",");
  if (of(turns) === of(nodeTurns.value)) return false;
  nodeTurns.set(turns);
  return true;
}

/** His answers you haven't read, kept only when they changed (a node from before them says none). */
function noteUnread(unread: UnreadChat[] | undefined): void {
  const of = (list: UnreadChat[]) => list.map((c) => `${c.id}:${c.answeredAt}:${c.title}`).join(",");
  if (of(unread ?? []) !== of(unreadChats.value)) unreadChats.set(unread ?? []);
}

/** The chat on screen, read: what he answered in it so far is no longer new, on any device. */
function read(api: Api, conversation: Pick<ConversationView, "id" | "unread">): void {
  if (!conversation.unread || document.hidden) return;
  unreadChats.set(unreadChats.value.filter((c) => c.id !== conversation.id));
  void api.post("/api/conversations/seen", { id: conversation.id }).catch(() => {});
}

async function lookQuests(api: Api, signal?: AbortSignal): Promise<void> {
  if (document.hidden) return;
  try {
    const going = (await api.get<{ quests: QuestView[] }>("/api/quests", signal)).quests.filter((q) => questInHand(q.state));
    if (going.map((q) => q.quest + q.goal).join() !== questsInHand.value.map((q) => q.quest + q.goal).join()) questsInHand.set(going);
  } catch {
    /* out of reach just now: the next look tries again */
  }
}

/** For the roster, while no chat is on screen to ask: the turns the node runs and the quests in hand, so his row says what he is doing. */
export async function lookAtWork(api: Api, can: { chat: boolean; read: boolean }): Promise<void> {
  if (chatOnScreen || document.hidden) return;
  if (can.chat) await api.get<{ turns: TurnView[]; unread?: UnreadChat[] }>("/api/turns").then((view) => { noteTurns(view.turns); noteUnread(view.unread); }, () => {});
  if (can.read) await lookQuests(api);
}

/** The kept conversation on screen (null: a new one, kept from its first answer, unless temporary). */
interface Current {
  id: string;
  title: string;
  project: string | null;
  bank: boolean;
  pinned: boolean;
}
let current: Current | null = null;
/** Not kept anywhere: gone when you start another chat or close the tab. */
let temporary = false;
/** The project a new conversation starts in. */
let startIn: string | null = null;
/** Your chats and projects, as last fetched. */
let kept: ConversationSummary[] | null = null;
let projects: ProjectView[] | null = null;
const keptChanged = new Set<() => void>();

/** (One asking at a time: whoever asks meanwhile waits for the same answer.) */
let keptAsking: Promise<void> | null = null;
function refreshKept(api: Api): Promise<void> {
  // What they were this session, at once (api.peek: asked for ahead of a tap, or earlier), while they're asked again.
  if (kept === null) {
    const last = api.peek<{ conversations: ConversationSummary[] }>("/api/conversations");
    if (last) {
      kept = last.conversations;
      for (const fn of keptChanged) fn();
    }
  }
  keptAsking ??= (async () => {
    try {
      kept = (await api.get<{ conversations: ConversationSummary[] }>("/api/conversations")).conversations;
      const mine = current && kept.find((c) => c.id === current!.id);
      if (mine) current = { id: mine.id, title: mine.title, project: mine.project, bank: mine.bank, pinned: mine.pinned };
      for (const fn of keptChanged) fn();
    } catch {
      // A node without chat history yet (or out of reach): chats still work; no recent ones to show.
      if (kept === null) {
        kept = [];
        for (const fn of keptChanged) fn();
      }
    }
  })().finally(() => (keptAsking = null));
  return keptAsking;
}

async function refreshProjects(api: Api): Promise<void> {
  try {
    projects = (await api.get<{ projects: ProjectView[] }>("/api/projects")).projects;
    for (const fn of keptChanged) fn();
  } catch {
    /* projects need mind:read */
  }
}

/** For the command palette: your kept chats and projects, fetched once when nothing is known yet. */
export function chatsForPalette(api: Api, can: { chat: boolean; read: boolean }): { chats: ConversationSummary[]; projects: ProjectView[] } {
  if (can.chat && kept === null) void refreshKept(api);
  if (can.read && projects === null) void refreshProjects(api);
  return { chats: kept ?? [], projects: projects ?? [] };
}

/** For the shell: whether Galahad is answering right now, and with which model. */
export const chatActivity = signal<{ streaming: boolean; model: string | null }>({ streaming: false, model: null });

const emit = (turn: Turn | null) => {
  syncStep();
  for (const fn of changed) fn(turn);
};

/* ---------- watching a turn the node runs ---------- */

/** Stop watching (the turn itself goes on). A temporary chat's turn has nobody else to watch it: that one is stopped. */
function leave(): void {
  const was = live;
  if (!was) return;
  live = null;
  if (!current && was.id) void was.api.post("/api/turns/stop", { turn: was.id }).catch(() => {});
  was.watch.abort();
  if (thread.target) endTurn(thread, Date.now());
  steering = [];
  chatActivity.set({ streaming: false, model: null });
  syncStep();
}

/** Stop him: said to the node, which stops the turn and keeps what he'd said. */
export function stopChat(): void {
  const w = live;
  if (!w) return;
  if (!w.id) {
    // The node hasn't said which turn it is yet: it's stopped the moment it does.
    w.stopAsked = true;
    return;
  }
  void w.api.post("/api/turns/stop", { turn: w.id }).catch((error: unknown) => toast("Couldn't stop him", { tone: "error", description: errorMessage(error) }));
}

function handle(w: Watching, event: ChatStreamEvent): void {
  w.tries = 0;
  if (event.type === "turn") {
    w.id = event.id;
    w.deadline = event.deadline;
    if (w.stopAsked) {
      w.stopAsked = false;
      stopChat();
    }
  } else if (event.type === "conversation") {
    current = { id: event.id, title: event.title, project: event.project, bank: current?.bank ?? false, pinned: current?.pinned ?? false };
    startIn = null;
    rememberOpenChat(event.id);
    for (const fn of keptChanged) fn();
    return;
  } else if (event.type === "steer") {
    const at = steering.indexOf(event.text);
    if (at >= 0) steering.splice(at, 1);
  } else if (event.type === "undelivered") {
    steering = [];
    if (event.queued) toast(`${plural(event.texts.length, "message")} didn't reach him before the turn ended`, { description: "Queued, first in line, and held until you resume." });
    else {
      // A temporary chat keeps nothing on the node: the words come back to the box.
      draft = [draft, ...event.texts].filter(Boolean).join("\n\n");
      toast("Your message didn't reach him before the turn ended", { description: "It's back in the message box." });
    }
    emit(null);
    return;
  }
  const what = applyEvent(thread, event, Date.now());
  if (event.type === "model" || event.type === "done") chatActivity.set({ streaming: true, model: event.ref });
  if (what === "all") emit(null);
  else if (what) emit(what);
}

/** Read a turn's stream into the thread, to its end; find the turn again if the connection drops while he works. */
async function follow(w: Watching, open: (signal: AbortSignal) => AsyncGenerator<ChatStreamEvent>): Promise<void> {
  let ended = false;
  let failure: unknown = null;
  try {
    for await (const event of open(w.watch.signal)) {
      if (live !== w) return;
      handle(w, event);
      if (event.type === "done" || event.type === "error" || event.type === "stopped") ended = true;
    }
  } catch (error) {
    if (live !== w || isAbort(error)) return;
    failure = error;
  }
  if (live !== w) return;
  if (ended) return finish(w);
  // The node never said which turn it is: the message wasn't taken (a secret in it, he's busy in this chat, the node is full).
  if (!w.id) {
    const error = failure;
    const text =
      error instanceof ApiError && (error.status === 422 || error.status === 409 || error.status === 429)
        ? error.message
        : error instanceof TypeError
          ? `Couldn't reach ${location.host}. Retry asks again.`
          : error
            ? errorMessage(error)
            : "The node didn't answer.";
    return finish(w, text);
  }
  // He is (or was) working on the node; only the watching was cut. A turn that is gone has ended: its chat has how.
  if (failure instanceof ApiError && (failure.status === 404 || failure.status === 403)) {
    if (current) {
      const id = current.id;
      live = null;
      thread.target = null;
      chatActivity.set({ streaming: false, model: null });
      void openConversation(w.api, id).catch(() => {});
      return;
    }
    return finish(w, failure.status === 403 ? failure.message : "The node restarted while he was answering, and a temporary chat's turn isn't kept anywhere.");
  }
  if (w.tries >= 8) return finish(w, `Lost the connection to ${location.host}. He may still be working there: open this chat again to see.`);
  w.tries += 1;
  const turn = thread.target;
  if (turn) {
    const last = turn.steps.at(-1);
    if (last?.text !== RECONNECTING) turn.steps.push({ icon: "refresh", text: RECONNECTING, detail: "He's still working on the node; only this page's connection dropped.", state: "active" });
    emit(turn);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (w.tries - 1), 8000)));
  if (live !== w) return;
  return follow(w, (signal) => w.api.events("/api/turns/attach", { turn: w.id }, signal));
}
const RECONNECTING = "Reconnecting to the node";

function finish(w: Watching, failure?: string): void {
  const turn = failure ? failTurn(thread, failure, Date.now()) : endTurn(thread, Date.now());
  live = null;
  // (It has ended: the header's line doesn't wait for the node's list to say so.)
  nodeTurns.set(nodeTurns.value.filter((t) => t.id !== w.id));
  steering = [];
  chatActivity.set({ streaming: false, model: null });
  emit(turn);
  // What you queued may be next, and the list's states have changed.
  if (current) void sync(w.api);
}

function watching(api: Api, id: string | null = null): Watching {
  const w: Watching = { api, id, deadline: null, watch: new AbortController(), stopAsked: false, tries: 0 };
  live = w;
  unwatchable = null;
  chatActivity.set({ streaming: true, model: null });
  syncStep();
  return w;
}

/** A kept chat as the node has it now: its queue, and the turn running in it (attached to, if this device may watch it). */
async function sync(api: Api): Promise<void> {
  const id = current?.id;
  if (!id) return;
  void refreshKept(api);
  let conversation: ConversationView;
  try {
    ({ conversation } = await api.post<{ conversation: ConversationView }>("/api/conversations/get", { id }));
  } catch {
    return;
  }
  if (current?.id !== id) return;
  queue = conversation.queue;
  held = conversation.held;
  adopt(api, conversation);
  read(api, conversation);
  emit(null);
}

/** What a kept chat holds, to show: with no turn running in it, an answer still marked as being written can't finish any more. */
const keptMessages = (conversation: ConversationView) => conversation.messages.map((m) => (m.status === "streaming" && !conversation.turn ? { ...m, status: "stopped" as const } : m));

/** Show a kept chat as the node has it, and attach to the turn running in it. */
function adopt(api: Api, conversation: ConversationView): void {
  const running = conversation.turn;
  unwatchable = running && !running.watchable ? running : null;
  if (live) return;
  if (!running || !running.watchable) {
    // Nothing to watch: what's shown is what the node keeps (another device may have asked and been answered since).
    const again = shownAgain(thread.turns, keptMessages(conversation), (m) => turnOf(m, conversation.role, thread.nextId++));
    if (again) {
      thread.turns = again;
      thread.target = null;
      thread.base = null;
    }
    return;
  }
  // Rebuilt from what the node keeps; the turn's own answers then come from its replay.
  thread.turns = conversation.messages.map((m) => turnOf(m, conversation.role, thread.nextId++));
  thread.target = null;
  thread.base = null;
  const w = watching(api, running.id);
  w.deadline = running.deadline;
  void follow(w, (signal) => api.events("/api/turns/attach", { turn: running.id }, signal));
}

/** How many kept chats are being opened: while one is, its title's place under the header is held. */
let opening = 0;

/** A kept conversation, back on screen with its answers' steps; if he's working in it, live from where he is. */
export async function openConversation(api: Api, id: string): Promise<void> {
  opening++;
  let conversation: ConversationView;
  try {
    ({ conversation } = await api.post<{ conversation: ConversationView }>("/api/conversations/get", { id }));
  } catch (error) {
    opening--;
    for (const fn of keptChanged) fn();
    throw error;
  }
  opening--;
  leave();
  thread.turns = keptMessages(conversation).map((m) => turnOf(m, conversation.role, thread.nextId++));
  thread.target = null;
  thread.base = null;
  current = { id: conversation.id, title: conversation.title, project: conversation.project, bank: conversation.bank, pinned: conversation.pinned };
  temporary = false;
  startIn = null;
  rememberOpenChat(conversation.id);
  queue = conversation.queue;
  held = conversation.held;
  steering = [];
  adopt(api, conversation);
  read(api, conversation);
  emit(null);
  for (const fn of keptChanged) fn();
}

/** A new conversation (in the same project, unless told otherwise); returns a function that brings the last one back (for Undo). */
export function newConversation(project: string | null = current?.project ?? startIn): () => void {
  // He goes on working in a kept chat (it's in your chats, marked as working); a temporary one ends here.
  leave();
  const saved = { turns: thread.turns, current, startIn, temporary, queue, held };
  thread.turns = [];
  thread.target = null;
  thread.base = null;
  current = null;
  startIn = project;
  queue = [];
  held = null;
  unwatchable = null;
  rememberOpenChat(null);
  emit(null);
  for (const fn of keptChanged) fn();
  return () => {
    if (thread.turns.length) return;
    ({ current, startIn, temporary, queue, held } = saved);
    rememberOpenChat(current?.id ?? null);
    thread.turns = saved.turns;
    emit(null);
    for (const fn of keptChanged) fn();
  };
}

/**
 * After a reload (the page's memory is gone, the node's isn't): back to the kept chat you had open, attached
 * to the turn he's working on in it. With none remembered (a new device, or a new chat was the last thing
 * here), his most recent conversation, continued: his row opens the one timeline, and a new chat is yours to
 * start. Once per page load. A temporary chat is gone with the page; the node stops its turn once nobody has
 * watched it for a while (it's kept nowhere, so nobody could read it).
 */
let restored = false;
export function restoreOpenChat(api: Api): void {
  if (restored) return;
  restored = true;
  const fresh = (): boolean => !current && !thread.turns.length && !live;
  if (!fresh()) return;
  const id = openChatId();
  if (id) return void openConversation(api, id).catch(() => rememberOpenChat(null));
  // (Likely to open one: the title's place is held until it's known.)
  opening++;
  void refreshKept(api)
    .then(() => {
      const latest = mostRecent(kept ?? []);
      if (latest && fresh() && !draft) void openConversation(api, latest.id).catch(() => {});
    })
    .finally(() => {
      opening--;
      for (const fn of keptChanged) fn();
    });
}

/** Something shared from another app (lib/share.ts), before the chat is first shown: a new chat, with it in the message
 * box and unsent, rather than the chat that was open last. */
export function handShared(text: string): void {
  restored = true;
  draft = text;
}

/** "New chat" from anywhere. A kept chat stays in your history; a temporary one can be brought back once. */
export function startNewChat(): void {
  // Asked for before any chat was shown: the one open last isn't brought back when the chat first is.
  restored = true;
  if (!thread.turns.length) return;
  const wasTemporary = temporary && !current;
  const restore = newConversation();
  if (wasTemporary) toast("Temporary chat cleared", { action: { label: "Undo", run: restore } });
}

const toolCount = (turn: Turn): number => turn.steps.filter((s) => s.tool).length;

function send(api: Api, text: string, again = false, attachments: AttachmentRef[] = []): void {
  if (live) return;
  const history: ChatMessage[] = thread.turns
    .filter((t) => (t.content || t.attachments?.length) && t.status !== "error")
    .map((t) => ({ role: t.role, content: t.content, ...(t.attachments ? { attachments: t.attachments } : {}) }));
  const asked: ChatMessage = { role: "user", content: text, ...(attachments.length ? { attachments } : {}) };
  beginTurn(thread, text, role, Date.now(), attachments);
  // A kept conversation: the node holds what was said, so only the question goes. A new one is kept from now (unless temporary).
  const body = current
    ? { role, conversation: current.id, messages: [asked], ...(again ? { retry: true } : {}) }
    : temporary
      ? { role, messages: [...history, asked] }
      : { role, save: true, messages: [...history, asked], ...(startIn ? { project: startIn } : {}) };
  const w = watching(api);
  emit(null);
  void follow(w, (signal) => api.chat(body, signal));
}

function retry(api: Api, turn: Turn): void {
  if (live) return;
  const index = thread.turns.indexOf(turn);
  if (index < 0) return;
  // Asked again: the question before this answer, and everything after it, is replaced by the new exchange.
  let asked = index - 1;
  while (asked >= 0 && thread.turns[asked]!.role !== "user") asked -= 1;
  if (asked < 0) return;
  const { content: text, attachments } = thread.turns[asked]!;
  thread.turns.length = asked;
  send(api, text, true, attachments);
}

/**
 * Your message, from the composer. With nothing running it's sent. While he works, `modifier` says
 * whether the other of steer and queue was asked for (this device's Enter does one, the modifier the other).
 * Resolves to what became of it, or why it wasn't taken.
 */
export async function sendMessage(api: Api, raw: string, opts: { modifier?: boolean; how?: "steer" | "queue"; attachments?: AttachmentRef[] } = {}): Promise<"sent" | "steered" | "queued" | { problem: string }> {
  const text = raw.trim();
  const files = opts.attachments ?? [];
  if (!text && !files.length) return { problem: "Nothing to send." };
  const action = opts.how && live ? (opts.how === "queue" && !current ? "steer" : opts.how) : composerAction({ busy: live !== null, enter: chatEnter(), modifier: Boolean(opts.modifier), canQueue: current !== null });
  if (action === "send") {
    send(api, text, false, files);
    return "sent";
  }
  // Files go with a message he answers from its start: not one handed him as he works, nor one queued.
  if (files.length) return { problem: "Files go with your next message, once he's done: wait for him, or stop him first." };
  try {
    if (action === "queue") {
      const view = await api.post<{ queue: QueuedMessage[]; held: QueueHold | null; started: TurnView | null }>("/api/conversations/queue", { conversation: current!.id, text, role });
      queue = view.queue;
      held = view.held;
      emit(null);
      // He'd finished in the meantime, so its turn came at once.
      if (view.started && !live) void sync(api);
      return "queued";
    }
    const w = live;
    if (!w?.id) return { problem: "He's only just starting: try again in a moment." };
    await api.post("/api/turns/steer", { turn: w.id, text });
    steering.push(text);
    emit(null);
    return "steered";
  } catch (error) {
    // He finished while you typed: it's simply your next message.
    if (error instanceof ApiError && error.status === 409 && action === "steer") {
      await sync(api);
      if (!live) {
        send(api, text);
        return "sent";
      }
    }
    return { problem: errorMessage(error) };
  }
}

/** What you can do with your queue. Each resolves to a problem in words, or null. */
export const queueActions = (api: Api) => {
  const run = async (path: string, body: object): Promise<string | null> => {
    if (!current) return "This chat isn't kept, so nothing is queued behind it.";
    try {
      const view = await api.post<{ queue: QueuedMessage[]; held: QueueHold | null }>(path, { conversation: current.id, ...body });
      queue = view.queue;
      held = view.held;
      emit(null);
      // Send now and Resume may have started a turn (or steered the one under way).
      if (!live) void sync(api);
      return null;
    } catch (error) {
      void sync(api);
      return errorMessage(error);
    }
  };
  return {
    edit: (id: number, text: string) => run("/api/conversations/queue/edit", { id, text }),
    remove: (id: number) => run("/api/conversations/queue/remove", { id }),
    discard: () => run("/api/conversations/queue/remove", {}),
    sendNow: (id: number) => run("/api/conversations/queue/send", { id }),
    resume: () => run("/api/conversations/queue/resume", {}),
  };
};

/**
 * While a chat is on screen: notice a turn that started in it elsewhere (another device, the queue going
 * on) and attach to it; keep the list's states fresh; and when anything kept changed (the node's `chats`:
 * a chat begun, answered or renamed on another device, maybe while this one was hidden), read the list and
 * the chat on screen again. Asks the node only while the app is visible: when its live stream says the turns
 * or the chats changed, or every four seconds while that stream is down (`follow`, the app's live.ts).
 */
/** Which writing of the chats the last look saw ("": none yet), kept while the chat is off screen, so what changed then is read on return. */
let seen = "";
export function watchTurns(api: Api, signal: AbortSignal, follow: Live["follow"]): void {
  let known = "";
  const look = async (): Promise<void> => {
    if (document.hidden) return;
    try {
      const view = await api.get<{ turns: TurnView[]; chats?: string; unread?: UnreadChat[] }>("/api/turns", signal);
      const now = view.turns.map((t) => `${t.id}:${t.conversation}`).sort().join(",");
      const mine = current && view.turns.find((t) => t.conversation === current!.id);
      noteTurns(view.turns);
      noteUnread(view.unread);
      const changed = Boolean(view.chats && seen && view.chats !== seen);
      if (view.chats) seen = view.chats;
      if (now !== known || changed) {
        known = now;
        void refreshKept(api);
      }
      if (mine && !live && (!unwatchable || unwatchable.id !== mine.id)) void sync(api);
      else if (!mine && unwatchable) void sync(api);
      else if (changed && current && !live) void sync(api);
    } catch {
      /* out of reach just now: the next look tries again */
    }
  };
  signal.addEventListener("abort", follow(["turns"], () => look(), 4000));
  void look();
}

/** A chat's state as its badge in a list (a live dot while he's working in it, sending out its waves). */
export function chatStateBadge(c: Pick<ConversationSummary, "state" | "queued" | "held" | "needs">): HTMLElement | null {
  const b = stateBadge(c);
  if (!b) return null;
  const el = badge(b.text, b.tone);
  el.classList.add("chat-state");
  if (b.live) el.prepend(dot(b.tone, { live: true }));
  return el;
}

/** What a side question would be about: this kept chat, or the temporary chat's turn under way (null: nothing yet). */
function asideTarget(): { conversation: string } | { turn: string } | null {
  if (current) return { conversation: current.id };
  return live?.id ? { turn: live.id } : null;
}

/** Ask on the side: answered apart, and part of nothing unless brought back. */
export function openChatAside(api: Api, question = ""): void {
  const about = asideTarget();
  if (!about) return void toast("Nothing to ask on the side yet", { description: "A side question is about a chat: ask something first.", tone: "warn" });
  openAside(api, about, { question, working: live !== null, onBroughtBack: () => void sync(api) });
}

// ---- view ----

export const chatView: View = (root, ctx, { scope, opts }) => {
  chatOnScreen = true;
  scope.add(() => (chatOnScreen = false));
  const threadEl = h("div", { class: "thread", "aria-label": "Conversation" });
  const alerts = h("div", { class: "composer-alerts" });
  const input = h("textarea", {
    rows: 1,
    placeholder: "Ask Galahad…",
    "aria-label": "Message to Galahad",
    autocomplete: "off",
    enterkeyhint: "send",
  });
  input.value = opts.query ?? draft;
  const sendButton = h("button", { class: "btn primary send", type: "submit", "aria-label": "Send" }, icon("arrow-up", { size: 18 }));
  // ---- files with your message: chosen, pasted or dropped; each goes up as it's added, and the message names them ----
  const tray = attachTray(ctx, { files: { get: () => waiting, set: (next) => void (waiting = next) }, enabled: () => canChat, changed: syncComposer, disposed: () => scope.disposed });
  const meta = h("span", { class: "hint ellipsis grow" });
  const jump = button("Latest", { size: "sm", icon: "arrow-down", onClick: () => scrollToEnd(true) });
  jump.hidden = true;
  jump.classList.add("jump");
  const nodes = new Map<number, HTMLElement>();
  // One persistent live region: says when Galahad starts, and reads the answer once it's complete.
  const announcer = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  const announced = new Map<number, Turn["status"]>(thread.turns.map((t) => [t.id, t.status]));
  function announce(turn: Turn | undefined): void {
    if (!turn || turn.role !== "assistant" || announced.get(turn.id) === turn.status) return;
    const before = announced.get(turn.id);
    announced.set(turn.id, turn.status);
    if (turn.status === "streaming" && before === undefined) announcer.textContent = "Galahad is answering.";
    else if (turn.status === "done") announcer.textContent = `Galahad answered: ${turn.content.replace(/[*_`#>|~]/g, "").slice(0, 2000)}`;
    else if (turn.status === "error") announcer.textContent = `Galahad couldn't answer. ${turn.error ?? ""}`;
    else if (turn.status === "stopped") announcer.textContent = "Stopped.";
  }
  let blocked: string | null = null;

  const canChat = ctx.can("chat");
  const coarse = matchMedia("(pointer: coarse)").matches;

  // ---- Galahad himself: his orb, in the colour of what he's doing, and that in a line. A tap shows what he has in hand. ----
  const face = h("span", { class: "chat-face" });
  // The welcome's orb, the same one large (your word, 23 November 2026: the one you talk to, as an orb), moving as he
  // is (24 November 2026: "pulsing/moving when doing a task, sitting idle, waiting, done"). Drawn by renderNow, as the
  // header's is, before the view is shown (one drawn here would be drawn again at once, for nothing).
  const heroOrb = h("div", { class: "hero-galahad" });
  // What he asks you, answered under his orb (made once: the welcome is drawn again, its subscriptions are not), shown
  // once no chat is being opened in its place.
  const asks = canChat ? galahadAsks(ctx, scope, () => opening === 0) : null;
  const nowLine = h("span", { class: "chat-now ellipsis" });
  const answers = h("span", { class: "chat-as ellipsis" });
  const who = h("button", { class: "chat-who", type: "button", onclick: () => openInHand(ctx) }, face, h("span", { class: "chat-who-text" }, h("span", { class: "chat-name" }, "Galahad", answers), nowLine));
  // On a phone his conversation is the whole screen: the way back Home.
  const back = h("a", { class: "btn ghost sm icon-only pane-back", href: "#/home", "aria-label": "Home", title: "Home" }, icon("chevron-left", { size: 16 }));
  // The Inbox, one tap from him, counting what waits for you that is no other knight's (theirs is on their own rows).
  const inboxCount = h("span", { class: "count", hidden: true });
  const inbox = h("a", { class: "btn ghost sm icon-only chat-inbox", href: "#/inbox", "aria-label": "Inbox", title: "Inbox" }, icon("inbox", { size: 16 }), inboxCount);
  // His own computer: watched and taken over from here, and given to him here while he has none.
  const computer = ctx.can("sandbox") ? h("button", { class: "btn ghost sm icon-only chat-computer", type: "button", "aria-label": "His computer", title: "His computer", onclick: () => openComputer(ctx) }, icon("monitor", { size: 16 })) : null;
  let shownTone = "";
  function renderNow(): void {
    const waiting = ctx.live.actions.value.filter((action) => isWaiting(action));
    const needs = ctx.live.inboxLoaded.value ? galahadNeeds(ctx.live.inboxCount.value, waiting, ctx.live.team.value?.teammates.map((person) => person.id) ?? []) : null;
    const now = galahadNow({ ...galahadWork(), needs });
    if (nowLine.textContent !== now.text) {
      nowLine.textContent = now.text;
      nowLine.dataset.tone = now.tone;
      who.setAttribute("aria-label", `Galahad: ${now.text}. See what he has in hand.`);
    }
    inboxCount.hidden = !needs;
    inboxCount.textContent = String(needs ?? "");
    inbox.setAttribute("aria-label", needs ? `Inbox: ${needs} waiting` : "Inbox");
    // His orbs in the colour and the mood of where he stands: at work while he answers or works, waiting while
    // something needs you, done while an answer of his is new to you, idle otherwise. (Both are his one orb: drawn
    // again, each carries on where it was, and a change of mood fades or bursts.)
    const mood = orbMoodOfState(galahadState(now));
    if (`${now.tone}/${mood}` !== shownTone) {
      shownTone = `${now.tone}/${mood}`;
      replace(face, orb({ size: 36, tone: now.tone, mood }));
      replace(heroOrb, orb({ size: 168, tone: now.tone, mood }));
    }
    // Who answers and with what, beside his name: the model, and the role when it isn't the planner (the menu changes both).
    const as = [role === "planner" ? null : role, modelName((roster ?? DEFAULT_ROLES)[role]?.models[0])].filter(Boolean).join(" · ");
    if (answers.textContent !== as) answers.textContent = as;
  }
  // ---- who answers, in which project, kept or not: one control ----
  function renderRoles(): void {
    const names = Object.keys(roster ?? DEFAULT_ROLES);
    if (!names.includes(role) || roleProblem(role)) role = names.find((n) => !roleProblem(n)) ?? names[0] ?? "planner";
    options.refresh();
    renderMeta();
    renderNow();
  }
  function renderMeta(): void {
    meta.textContent = composerHint({ busy: live !== null, enter: chatEnter(), canQueue: current !== null, coarse, mac: /Mac|iPhone|iPad/.test(navigator.platform) });
  }

  // ---- rendering thread.turns ----
  function processView(turn: Turn): HTMLElement {
    const writing = turn.status === "streaming";
    const current = turn.steps.at(-1);
    // An answer that was stopped, or that a message of yours cut, says so on its one line (not only inside).
    const cut = turn.status === "stopped" ? (current?.text ?? "Stopped") : turn.status === "steered" ? "Steered here" : null;
    const summaryText = writing
      ? (current?.text ?? "Starting…")
      : [
          cut,
          turn.as,
          turn.model,
          turn.endedAt ? duration(turn.endedAt - turn.startedAt) : null,
          toolCount(turn) ? `${toolCount(turn)} tool${toolCount(turn) > 1 ? "s" : ""}` : null,
          turn.fallbacks ? `${turn.fallbacks} fallback${turn.fallbacks > 1 ? "s" : ""}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
    const details = h(
      "details",
      { class: "process", open: writing && turn.steps.length > 1 },
      h(
        "summary",
        {},
        writing ? spinner("sm") : icon("chevron-right", { size: 14, class: "chev" }),
        h("span", { class: "ellipsis" }, summaryText),
      ),
      h(
        "ol",
        { class: "steps" },
        ...turn.steps.map((s) =>
          h(
            "li",
            { class: "step", "data-state": s.state },
            h("span", { class: "step-mark" }, s.state === "active" ? spinner("sm") : icon(s.state === "done" ? "check" : stepIcon(s))),
            h("span", { class: "step-text" }, s.text, s.detail ? h("div", { class: "step-detail" }, s.detail) : null),
          ),
        ),
      ),
    );
    return details;
  }

  function turnActions(turn: Turn): HTMLElement {
    const bar = h("div", { class: "turn-actions" });
    if (turn.content) bar.append(button("Copy", { variant: "ghost", size: "sm", iconOnly: true, icon: "copy", onClick: () => void copyText(turn.content, "Message copied") }));
    const isLast = thread.turns.at(-1) === turn;
    if (turn.role === "assistant" && isLast && turn.status !== "streaming" && canChat) {
      bar.append(button("Retry", { variant: "ghost", size: "sm", icon: "retry", onClick: () => retry(ctx.api, turn) }));
    }
    return bar;
  }

  // (An orb of its own: he can be writing here while something waits on you, and his header's orb says the latter.)
  let writing: { id: number; orb: HTMLElement } | null = null;
  const writingOrb = (id: number): HTMLElement => (writing?.id === id ? writing : (writing = { id, orb: orb({ size: 28, mood: "working", key: "galahad:writing" }) })).orb;

  function renderTurn(turn: Turn): HTMLElement {
    // A look of his come back: his own note, never shown as yours.
    if (turn.role === "user" && turn.look) {
      return h("article", { class: "turn look", "aria-label": "He looked again" }, icon("clock", { size: 16, class: "subtle" }), h("span", {}, lookedWords(turn.look, Date.now())));
    }
    if (turn.role === "user") {
      return h(
        "article",
        { class: "turn user", "aria-label": "You said" },
        h("div", { class: "turn-col" }, turn.attachments?.length ? attachedView(ctx, turn.attachments) : null, turn.content ? h("div", { class: "bubble" }, turn.content) : null, turnActions(turn)),
      );
    }
    const content = h("div", { class: "md" });
    // His latest answer, once it's done: a choice he offered is tapped to answer with it, sent as if typed (the same
    // checks). While he's writing, a page he makes waits for the end.
    const answerable = thread.turns.at(-1) === turn && turn.status === "done" && canChat;
    content.append(renderMarkdown(turn.content, { live: turn.status === "streaming", choose: answerable ? (text) => ((input.value = text), void deliver()) : undefined }));
    if (turn.status === "streaming") {
      if (turn.content) {
        const last = content.lastElementChild;
        (last && /^(P|LI|UL|OL)$/.test(last.tagName) ? (last.tagName === "P" ? last : last.lastElementChild ?? last) : content).append(h("span", { class: "caret", "aria-hidden": "true" }));
      }
    }
    const errorBox =
      turn.status === "error" && turn.error
        ? /looks like a/i.test(turn.error)
          ? callout("warn", turn.error, { title: "Not sent to any model", actions: ctx.can("vault:write") ? button("Open the vault", { size: "sm", icon: "vault", onClick: () => ctx.navigate("vault") }) : null })
          : callout("danger", turn.error, { title: "Galahad couldn't answer" })
        : null;
    return h(
      "article",
      { class: `turn assistant${thread.turns.at(-1) === turn ? " last" : ""}`, "aria-label": "Galahad said" },
      // His orb beside each answer of his, still and at rest, but for the one he is writing, which is at work (and kept
      // while he writes, as the answer is drawn again with each word): the colour of his state is his line's, above.
      h("span", { class: "avatar agent orb-avatar", "aria-hidden": "true" }, turn.status === "streaming" ? writingOrb(turn.id) : orb({ size: 28 })),
      h("div", { class: "turn-body" }, processView(turn), turn.content ? content : null, errorBox, turn.status === "streaming" ? null : turnActions(turn)),
    );
  }

  /**
   * While you were away (PLAN #37): what happened since this device last showed you, from the node (no model), under
   * the welcome, where its arrival moves nothing above it. Asked once as the chat opens; "Got it" and it's read.
   */
  let away: AwayView | null = null;
  const awayBox = h("div", { class: "away-host" });
  function showAway(): void {
    if (!away?.lines.length) return replace(awayBox);
    const got = button("Got it", { size: "sm", variant: "ghost", icon: "check" });
    got.addEventListener("click", () => {
      markAwaySeen();
      away = null;
      replace(awayBox);
    });
    replace(
      awayBox,
      h(
        "section",
        { class: "card away", "aria-label": "While you were away" },
        h("div", { class: "row between" }, h("h3", { class: "small strong" }, "While you were away"), h("span", { class: "tiny subtle" }, relativeTime(away.since))),
        h("ul", { class: "plain-list small" }, ...away.lines.map((line) => h("li", { class: "row tight" }, dot(line.tone === "neutral" ? null : line.tone), h("span", {}, line.text)))),
        h("div", { class: "row end" }, got),
      ),
    );
  }
  if (!temporary && canChat) {
    const since = awaySince();
    void ctx.api
      .post<AwayView>("/api/away", { since })
      .then((found) => {
        away = found;
        // Nothing happened: nothing to say, and the next visit counts from now.
        if (!found.lines.length) markAwaySeen();
        showAway();
      })
      .catch(() => {});
  }

  function emptyState(): HTMLElement {
    const suggestions: [string, string][] = [
      ["Catch me up", "What has my fleet been doing today, and does anything need me?"],
      ["Plan", "Plan this week's work on Galahad as a short, ordered list."],
      ["Recall", "What do we remember about how the fleet is deployed?"],
      ["Place", "Which of my machines should run a long build, and why?"],
    ];
    return h(
      "div",
      { class: "chat-hero" },
      // Galahad himself, the orb you talk to, at your service.
      heroOrb,
      h("h2", {}, startIn ? projectName(startIn) : "At your service."),
      h("p", {}, startIn ? "A new chat in this project: its instructions and memories go with every answer." : "Ask anything. Galahad recalls what your fleet remembers, and uses his tools. Keys belong in the vault, never here."),
      canChat
        ? h(
            "div",
            { class: "suggestions" },
            ...suggestions.map(([title, text]) =>
              h(
                "button",
                {
                  class: "suggestion",
                  type: "button",
                  title: text,
                  onclick: () => {
                    input.value = text;
                    grow();
                    input.focus();
                  },
                },
                title,
              ),
            ),
          )
        : null,
      recentChats(),
      awayBox,
      // (Last, as what happened while you were away is: they come once the node has said, and below all else they move nothing.)
      asks?.box,
    );
  }

  function renderAll(): void {
    nodes.clear();
    if (!thread.turns.length) {
      replace(threadEl, emptyState());
      return;
    }
    replace(
      threadEl,
      ...thread.turns.map((t) => {
        const el = renderTurn(t);
        nodes.set(t.id, el);
        return el;
      }),
    );
  }

  let frame = 0;
  const dirty = new Set<Turn>();
  function onChange(turn: Turn | null): void {
    announce(turn ?? thread.turns.at(-1));
    if (!turn) {
      renderAll();
      syncComposer();
      scrollToEnd(true);
      return;
    }
    dirty.add(turn);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stick = nearBottom();
      for (const t of dirty) {
        const old = nodes.get(t.id);
        const next = renderTurn(t);
        nodes.set(t.id, next);
        if (old?.isConnected) old.replaceWith(next);
        else renderAll();
      }
      dirty.clear();
      syncComposer();
      if (stick) scrollToEnd(false);
      else jump.hidden = !live;
    });
  }

  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  function scrollToEnd(force: boolean): void {
    // A new chat reads from the top (its welcome and your recent chats); a conversation from its latest answer.
    if (!thread.turns.length) window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    else if (force || nearBottom()) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior });
    jump.hidden = true;
  }

  // ---- composer ----
  function grow(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  // While he works, a message steers him now or is queued for after: what Enter does is this device's choice
  // (Settings), Ctrl or ⌘ with Enter does the other, and each has its own button (the way on a phone).
  const steerButton = button("Steer", { size: "sm", title: "Tell him now: it reaches him at his next safe point", onClick: () => void deliver({ how: "steer" }) });
  const queueButton = button("Queue", { size: "sm", title: "Keep it on the node and send it when he's done", onClick: () => void deliver({ how: "queue" }) });
  const stopButton = button("Stop", { icon: "stop", iconOnly: true, label: "Stop him", title: "Stop him (Esc)", onClick: () => stopChat() });
  stopButton.classList.add("send");
  const panel = queuePanel(queueActions(ctx.api));
  // What is under way in this chat: his knights' tasks given here (Stop on each), his looks that wait (Cancel).
  const going = underway(ctx);
  scope.add(() => going.stop());
  let wasAnswering = false;
  function syncUnderway(): void {
    const answering = live !== null;
    going.show(current && !temporary ? current.id : null, answering);
    // His answer just ended: what he gave or set in it is asked for now.
    if (wasAnswering && !answering) going.refresh();
    wasAnswering = answering;
  }
  const elsewhere = h("div", { class: "composer-alerts" });
  let shownElsewhere = "";
  // A key he asked for in this chat: its sealed field here, above the message box, as well as in the Inbox. What you
  // seal goes straight to the vault; he learns that it exists, never what it is. Drawn again only when which keys wait
  // changes, so a half-typed value stays.
  const keyAsks = h("div", { class: "composer-alerts key-asks" });
  let shownAsks = "";
  const looked = new Set<string>();
  function syncKeyAsks(): void {
    const names = keysAskedIn(thread.turns);
    const waiting = ctx.live.secretRequests.value.filter((request) => names.includes(request.name));
    // Asked just now: the Inbox is asked at once, not at its next look.
    const fresh = names.filter((name) => !looked.has(name) && !waiting.some((request) => request.name === name));
    if (fresh.length && ctx.can("vault:read")) {
      for (const name of fresh) looked.add(name);
      void ctx.live.refreshInbox();
    }
    const signature = waiting.map((request) => request.name).join(",");
    if (signature === shownAsks) return;
    shownAsks = signature;
    replace(keyAsks, ...waiting.map((request) => secretRequestCard(ctx, request)));
  }

  // A connector he asked for in this chat: its card here, above the message box, as well as in the Inbox. Drawn again
  // only when which requests wait changes.
  const connectorAsks = h("div", { class: "composer-alerts" });
  let shownConnectorAsks = "";
  const lookedConnectors = new Set<string>();
  function syncConnectorAsks(): void {
    const asked = connectorsAskedIn(thread.turns);
    const waiting = ctx.live.connectorRequests.value.filter((request) => asked.includes(request.connector));
    // Asked just now: the Inbox is asked at once, not at its next look.
    const fresh = asked.filter((id) => !lookedConnectors.has(id) && !waiting.some((request) => request.connector === id));
    if (fresh.length && ctx.can("mind:read")) {
      for (const id of fresh) lookedConnectors.add(id);
      void ctx.live.refreshConnectorRequests();
    }
    const signature = waiting.map((request) => request.id).join(",");
    if (signature === shownConnectorAsks) return;
    shownConnectorAsks = signature;
    replace(connectorAsks, ...waiting.map((request) => connectorRequestCard(ctx, request)));
  }

  function syncComposer(): void {
    syncUnderway();
    const busy = live !== null;
    const files = tray.carried().length > 0;
    const has = (Boolean(input.value.trim()) || files) && !blocked && !tray.going();
    const canQueue = current !== null;
    const enter = chatEnter();
    sendButton.hidden = busy;
    sendButton.disabled = !canChat || !has;
    stopButton.hidden = !busy;
    steerButton.hidden = !busy;
    queueButton.hidden = !busy || !canQueue;
    // (Files go with a message he answers from its start, never one he's handed as he works.)
    steerButton.disabled = queueButton.disabled = !canChat || !has || files;
    // The one Enter does is in ink.
    steerButton.classList.toggle("primary", !canQueue || enter === "steer");
    queueButton.classList.toggle("primary", canQueue && enter === "queue");
    input.placeholder = busy ? (canQueue ? "Steer him, or queue what's next…" : "Steer him…") : "Ask Galahad…";
    syncKeyAsks();
    syncConnectorAsks();
    panel.render({ queue, held, steering, busy, deadline: live?.deadline ?? null });
    // He's working in this chat on a turn this device may not watch (it may read the bank): said, with Stop.
    const other = unwatchable && !live ? unwatchable.id : "";
    if (other !== shownElsewhere) {
      shownElsewhere = other;
      replace(
        elsewhere,
        other
          ? callout("info", "That turn may read the bank, and this device may not, so it isn't shown here. It goes on on the node; the answer will be in the chat for devices that may.", {
              title: "He's working in this chat, started from another device",
              actions: button("Stop him", { size: "sm", icon: "stop", onClick: () => void ctx.api.post("/api/turns/stop", { turn: other }).catch((error: unknown) => toast("Couldn't stop him", { tone: "error", description: errorMessage(error) })) }),
            })
          : null,
      );
    }
    renderMeta();
    renderNow();
  }

  function secretWarning(kind: string, secret: string): HTMLElement {
    return callout(
      "warn",
      `That looks like a ${kind}. It won't be sent: the models you talk to would see it.`,
      {
        title: "Secrets never go into chat",
        icon: "shield",
        actions: [
          ctx.can("vault:write")
            ? button("Store it in the vault instead", {
                variant: "primary",
                size: "sm",
                icon: "vault",
                onClick: () => {
                  input.value = "";
                  draft = "";
                  blocked = null;
                  replace(alerts);
                  syncComposer();
                  openAddKey(ctx, { prefill: secret });
                },
              })
            : null,
          button("Remove it from my message", {
            size: "sm",
            onClick: () => {
              input.value = input.value.split(secret).join("").replace(/[ \t]{2,}/g, " ");
              check();
              input.focus();
            },
          }),
        ],
      },
    );
  }

  function check(): void {
    const finding = findSecrets(input.value)[0];
    // The draft outlives this view (in memory only); it never keeps anything secret-shaped.
    draft = finding ? "" : input.value;
    if (finding) {
      const secret = input.value.slice(finding.index, finding.index + finding.length);
      blocked = finding.kind;
      replace(alerts, secretWarning(finding.kind, secret));
    } else if (blocked) {
      blocked = null;
      replace(alerts);
    }
    syncComposer();
  }
  const checkSoon = debounce(check, 200);
  scope.add(() => {
    checkSoon.cancel();
    draft = findSecrets(input.value).length ? "" : input.value;
  });

  /** Your message: sent, or (while he works) steered or queued. Whatever is asked of it, it's checked for secrets first. */
  async function deliver(how: { modifier?: boolean; how?: "steer" | "queue" } = {}): Promise<void> {
    check(); // never trust a debounced result at the moment of sending
    const text = input.value.trim();
    const files = tray.carried();
    if ((!text && !files.length) || blocked || !canChat) return;
    if (tray.going()) return void toast("Your files are still going up", { description: "Send once each is up.", tone: "warn" });
    const clear = (): void => {
      input.value = "";
      draft = "";
      grow();
      syncComposer();
    };
    // A side question typed into the box ("/btw …") is asked apart; it never becomes a message by accident.
    const aside = asideOf(text);
    if (aside !== null) {
      if (!asideTarget()) return void toast("Nothing to ask on the side yet", { description: "A side question is about a chat: ask something first.", tone: "warn" });
      clear();
      openChatAside(ctx.api, aside);
      return;
    }
    clear();
    const result = await sendMessage(ctx.api, text, { ...how, attachments: files });
    // Sent with the message: the composer is clear of them (one not taken stays, to remove).
    if (typeof result !== "object" && files.length) tray.sent();
    if (typeof result === "object") {
      // It wasn't taken: the words go back in the box, and why is said.
      if (!scope.disposed && !input.value) {
        input.value = text;
        grow();
        check();
      } else if (!draft) draft = text;
      toast("Couldn't send it", { tone: "error", description: result.problem });
    }
  }

  input.addEventListener("input", () => {
    grow();
    syncComposer();
    checkSoon();
  });
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      // Enter never stops him: it sends, steers or queues. Only Stop or Esc stops.
      void deliver({ modifier: event.ctrlKey || event.metaKey });
    }
  });
  scope.listen(document, "keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && live && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      stopChat();
    }
  });
  scope.listen(window, "scroll", () => {
    if (nearBottom()) jump.hidden = true;
  }, { passive: true });
  // A turn that started in this chat elsewhere (another device, the queue going on) is noticed and attached to.
  if (canChat) watchTurns(ctx.api, scope.signal, ctx.live.follow);
  // What he has in hand beside this chat: the header's line says so.
  scope.add(nodeTurns.subscribe(renderNow));
  scope.add(questsInHand.subscribe(renderNow));
  scope.add(ctx.live.inboxCount.subscribe(renderNow));
  scope.add(ctx.live.inboxLoaded.subscribe(renderNow));
  if (ctx.can("mind:read")) scope.add(ctx.live.follow(["quests"], () => lookQuests(ctx.api, scope.signal), 15_000));
  // The minute "stops by itself in …" names moves on while he works.
  const ticking = setInterval(() => live && syncComposer(), 30_000);
  scope.add(() => clearInterval(ticking));

  // ---- your history and projects ----
  const subHead = h("div", { class: "chat-sub" });
  const node = ctx.whoami.nodeName ?? "this node";
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;

  /** Your projects, the ones you chatted in most recently first. */
  function projectsByUse(): ProjectView[] {
    const last = new Map<string, number>();
    for (const c of kept ?? []) if (c.project) last.set(c.project, Math.max(last.get(c.project) ?? 0, c.updatedAt));
    return [...(projects ?? [])].sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  }
  const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 90) ?? "";
  function projectChoices(chosen: string | null): SelectorGroup {
    return {
      id: "project",
      label: "Project",
      options: [
        { value: "", label: "No project", icon: "chat", meta: "Galahad as he is", selected: !chosen },
        ...projectsByUse().map((p) => ({ value: p.id, label: p.name, icon: "folder" as const, meta: firstLine(p.instructions) || "No instructions yet", keywords: [p.id], selected: chosen === p.id })),
      ],
    };
  }

  async function changeKept(change: { title?: string; project?: string | null; pinned?: boolean }): Promise<void> {
    if (!current) return;
    try {
      await ctx.api.post("/api/conversations/update", { id: current.id, ...change }, scope.signal);
      Object.assign(current, change);
      renderSub();
      void refreshKept(ctx.api);
    } catch (error) {
      toast("Couldn't change it", { tone: "error", description: errorMessage(error) });
    }
  }

  function rename(): void {
    if (!current) return;
    const field = h("input", { class: "input", type: "text", value: current.title, maxlength: 120, "aria-label": "Title" });
    const sheet = openSheet({
      title: "Rename this chat",
      size: "small",
      body: h("form", { onsubmit: (e: Event) => { e.preventDefault(); const title = field.value.trim(); if (title) void changeKept({ title }); sheet.close(); } }, field),
      footer: [button("Cancel", { onClick: () => sheet.close() }), button("Save", { variant: "primary", onClick: () => { const title = field.value.trim(); if (title) void changeKept({ title }); sheet.close(); } })],
      initialFocus: () => field,
    });
  }

  async function deleteCurrent(): Promise<void> {
    if (!current) return;
    const ok = await confirmAction({
      title: "Delete this chat?",
      body: [h("p", {}, `"${current.title}" is deleted on ${node} for good, with every answer in it. Memories Galahad made from it stay in the mind.`)],
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await ctx.api.post("/api/conversations/delete", { id: current.id }, scope.signal);
      newConversation(null);
      void refreshKept(ctx.api);
      toast("Chat deleted", { tone: "info" });
    } catch (error) {
      toast("Couldn't delete it", { tone: "error", description: errorMessage(error) });
    }
  }

  // The chat's one menu: a new chat and every kept one, what to do with this chat, who answers, in which project, kept or not.
  const options = selector({
    label: "Chat options",
    scope,
    search: "auto",
    placeholder: "Find a role or project…",
    variant: "ghost",
    className: "icon-only",
    current: () => ({ text: "", icon: "more" }),
    groups: () => {
      const specs = roster ?? DEFAULT_ROLES;
      const actions = chatActions({ kept: current !== null, pinned: current?.pinned ?? false, aside: canChat && asideTarget() !== null, node });
      const groups: SelectorGroup[] = [
        ...(canChat ? [{ id: "chats", mode: "action" as const, options: CHATS_MENU.map((action) => ({ ...action, icon: action.value === "new" ? ("plus" as const) : ("clock" as const) })) }] : []),
        ...(actions.length ? [{ id: "do", mode: "action" as const, options: actions.map((action) => ({ ...action, icon: ACTION_ICON[action.value] })) }] : []),
        {
          id: "role",
          label: "Who answers",
          options: Object.entries(specs).map(([name, spec]) => {
            const problem = roleProblem(name);
            const models = spec.models;
            return {
              value: name,
              label: roleTitle(name),
              icon: ROLE_ICON[name] ?? "sparkle",
              meta: models.length ? `${models[0]}${models.length > 1 ? ` · ${plural(models.length - 1, "fallback")}` : ""}` : spec.description,
              keywords: [spec.description, ...models],
              selected: name === role,
              ...(problem ? { disabled: problem } : {}),
            };
          }),
        },
      ];
      // A new chat starts in a project; a kept one moves to another.
      if (projects?.length) groups.push(current ? { ...projectChoices(current.project), label: "Move to a project" } : projectChoices(startIn));
      groups.push({
        id: "keep",
        label: "Keeping",
        mode: "many",
        options: [{ value: "temporary", label: "Temporary chat", icon: "eye", meta: current ? "Starts a new chat that isn't kept" : "Not kept: gone when you start another or close the app", selected: temporary && !current }],
      });
      return groups;
    },
    footer: () => (projects?.length ? "A project's instructions and memories go with every answer." : null),
    onSelect: (group, option) => {
      if (group === "chats") {
        if (option.value === "history") return openHistory();
        startNewChat();
        if (!coarse) input.focus();
        return;
      }
      if (group === "do") {
        if (option.value === "aside") openChatAside(ctx.api);
        else if (option.value === "rename") rename();
        else if (option.value === "pin") void changeKept({ pinned: !current?.pinned });
        else void deleteCurrent();
        return;
      }
      if (group === "project" && current) return void changeKept({ project: option.value || null });
      if (group === "role") {
        role = option.value;
        rememberRole(role);
      } else if (group === "project") {
        const next = option.value || null;
        temporary = false;
        if (thread.turns.length) newConversation(next);
        else startIn = next;
      } else if (group === "keep") {
        if (thread.turns.length) newConversation();
        temporary = !temporary;
      }
      renderSub();
      if (!thread.turns.length) renderAll();
      renderMeta();
      renderNow();
      if (!coarse) input.focus();
    },
  });

  function renderSub(): void {
    options.refresh();
    if (current) {
      replace(
        subHead,
        h("button", { class: "chat-title", type: "button", title: "Rename", onclick: () => rename() }, current.pinned ? icon("pin", { size: 13, class: "subtle", label: "Pinned" }) : null, h("span", { class: "ellipsis" }, current.title)),
        current.project
          ? h("a", { class: "chip", href: "#/projects", onclick: (e: Event) => { e.preventDefault(); ctx.navigate("projects", { project: current!.project! }); } }, icon("folder", { size: 12 }), projectName(current.project))
          : null,
        current.bank ? badge("bank", "neutral", "bank") : null,
      );
    } else if (temporary) {
      replace(subHead, badge("temporary", "warn", "eye"), h("span", { class: "small muted" }, "Not kept: gone when you start another chat or close the app."));
    } else if (opening) {
      // Its title's place, while the chat is opened: the thread under it doesn't drop when it comes.
      replace(subHead, h("span", { class: "skeleton sk-line chat-sub-pending", "aria-hidden": "true" }));
    } else replace(subHead);
  }

  function chatRow(c: ConversationSummary, after: () => void): HTMLElement {
    const meta = [c.project ? projectName(c.project) : null, `${c.count} message${c.count === 1 ? "" : "s"}`, relativeTime(c.updatedAt)].filter(Boolean).join(" · ");
    return h(
      "button",
      {
        class: "item chat-row",
        type: "button",
        "aria-current": current?.id === c.id ? "true" : null,
        onclick: () => {
          after();
          openConversation(ctx.api, c.id).catch((error: unknown) => toast("Couldn't open it", { tone: "error", description: errorMessage(error) }));
        },
      },
      h("span", { class: "avatar" }, icon(c.pinned ? "pin" : c.project ? "folder" : "chat", { size: 14 })),
      // An answer in it you haven't read: a green dot, as an unread email has, until you open it.
      h("div", { class: "grow" }, h("div", { class: "chat-row-title" }, c.unread ? dot("ok", { label: "New answer" }) : null, h("span", { class: "strong small ellipsis" }, c.title)), h("div", { class: "meta" }, meta, c.bank ? h("span", {}, " · bank") : null)),
      // Where it stands, at a glance: working, needs you, queued, stopped or failed (nothing when it's simply done).
      chatStateBadge(c),
    );
  }

  function openHistory(): void {
    const search = h("input", { class: "input", type: "search", placeholder: "Search your chats", "aria-label": "Search your chats", autocomplete: "off" });
    const listHost = h("div", { class: "stack" });
    const sheet = openSheet({ title: "Your chats", description: `Kept privately on ${node}. Temporary chats aren't kept.`, body: [search, listHost], size: "wide" });
    const draw = () => {
      if (!kept) return replace(listHost, skeletonRows(4));
      const shown = filterConversations(kept, search.value, projectName);
      if (!shown.length) return replace(listHost, empty({ icon: "chat", title: search.value ? "No chat matches" : "No chats yet", body: search.value ? undefined : "Ask something: the conversation is kept here.", compact: true }));
      replace(
        listHost,
        ...groupConversations(shown).map((g) => h("div", { class: "stack tight" }, h("div", { class: "tiny subtle" }, g.label), h("div", { class: "card" }, h("div", { class: "rows" }, ...g.items.map((c) => chatRow(c, () => sheet.close())))))),
      );
    };
    search.addEventListener("input", draw);
    keptChanged.add(draw);
    sheet.scope.add(() => keptChanged.delete(draw));
    draw();
    void refreshKept(ctx.api);
  }

  function recentChats(): HTMLElement | null {
    if (temporary) return null;
    // Until your chats arrive, their place is held (the welcome above them doesn't jump).
    if (kept === null && canChat) return h("div", { class: "recent-chats", "aria-hidden": "true" }, h("div", { class: "tiny subtle" }, " "), h("div", { class: "card" }, skeletonRows(4, { avatar: true })));
    if (!kept?.length) return null;
    const recent = (startIn ? kept.filter((c) => c.project === startIn) : kept).slice(0, 4);
    if (!recent.length) return null;
    return h("div", { class: "recent-chats" }, h("div", { class: "tiny subtle" }, startIn ? `Recent in ${projectName(startIn)}` : "Recent"), h("div", { class: "card" }, h("div", { class: "rows" }, ...recent.map((c) => chatRow(c, () => {})))), button("All chats", { variant: "ghost", size: "sm", icon: "clock", onClick: () => openHistory() }));
  }

  const onKept = () => {
    renderSub();
    if (!thread.turns.length) renderAll();
    asks?.render();
  };
  keptChanged.add(onKept);
  scope.add(() => keptChanged.delete(onKept));

  const form = h(
    "form",
    {
      class: "composer",
      onsubmit: (event: Event) => {
        event.preventDefault();
        void deliver();
      },
    },
    tray.row,
    input,
    tray.chooser,
    h("div", { class: "composer-bar" }, tray.button, icon("shield-check", { size: 14, class: "subtle", label: "Checked for secrets before sending" }), meta, queueButton, steerButton, stopButton, sendButton),
  );
  // Pictures pasted alone, and files dropped on the message box, go with the message.
  tray.take(input, form);
  tray.render();

  replace(
    root,
    h(
      "section",
      { class: "chat", "aria-labelledby": "chat-title" },
      h("h1", { id: "chat-title", class: "sr-only" }, "Chat with Galahad"),
      announcer,
      h("div", { class: "chat-head" }, back, who, computer, inbox, options.el),
      subHead,
      threadEl,
      h("div", { class: "composer-wrap" }, h("div", { class: "jump-anchor" }, jump), alerts, elsewhere, keyAsks, connectorAsks, going.el, panel.el, form),
    ),
  );

  changed.add(onChange);
  scope.add(() => changed.delete(onChange));
  scope.add(ctx.live.secretRequests.subscribe(syncKeyAsks));
  scope.add(ctx.live.connectorRequests.subscribe(syncConnectorAsks));
  // Arriving for one chat, or to start one in a project.
  if (opts.conversation && opts.conversation !== current?.id) {
    openConversation(ctx.api, opts.conversation).catch((error: unknown) => toast("Couldn't open that chat", { tone: "error", description: errorMessage(error) }));
  } else if (opts.project && !live && startIn !== opts.project) {
    if (thread.turns.length) newConversation(opts.project);
    else startIn = opts.project;
  } else if (!opts.conversation && !opts.query && canChat) restoreOpenChat(ctx.api);
  // (After the chat you had open is asked for, so a welcome that is only passing through shows none of it.)
  asks?.render();
  renderSub();
  renderAll();
  renderRoles();
  void refreshKept(ctx.api);
  if (ctx.can("mind:read")) void refreshProjects(ctx.api);
  syncComposer();
  grow();
  if (input.value) check();

  if (!canChat) {
    input.disabled = true;
    replace(alerts, callout("warn", "This device wasn't granted the chat scope. Ask from a device that was, or pair this one again with chat allowed."));
  } else if (!matchMedia("(pointer: coarse)").matches) {
    input.focus();
  }
  requestAnimationFrame(() => scrollToEnd(true));

  if (!roster && ctx.can("mind:read")) {
    ctx.api
      .get<{ roster: Record<string, RoleSpec> }>("/api/roster", scope.signal)
      .then(({ roster: loaded }) => {
        roster = loaded;
        if (!scope.disposed) renderRoles();
      })
      .catch(() => {
        /* roster needs mind:read; the default roles still work */
      });
  }
  // Asked last: a browser sends only so many requests at once, and your chats come before his line.
  if (ctx.can("mind:read")) void lookQuests(ctx.api, scope.signal);
};

/** The shell's "answering…" pill: visible from every page while a reply streams. */
export function chatActivityPill(): HTMLElement {
  const pill = h("div", { class: "fleet-pill activity-pill", role: "status", hidden: true });
  chatActivity.watch(({ streaming, model }) => {
    pill.hidden = !streaming;
    if (!streaming) return;
    replace(
      pill,
      dot("work", { live: true }),
      h("a", { class: "plain-link", href: "#/chat" }, model ? `Answering · ${model.split("/").pop()}` : "Answering…"),
      button("Stop", { size: "sm", variant: "ghost", icon: "stop", onClick: stopChat, label: "Stop Galahad answering" }),
    );
  });
  return pill;
}
