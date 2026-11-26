import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, utf8 } from "./bytes.ts";
import { isTimeZone, zonedParts } from "./schedule.ts";
import { findSecrets } from "./secret-scan.ts";
import { isConversationId, isNotifyTag, NOTIFY_BODY_MAX, NOTIFY_KINDS, NOTIFY_TITLE_MAX, notifyClean, type NotifyKind, type NotifyOpen, type NotifyPayload } from "./notify-payload.ts";

export * from "./notify-payload.ts";

/*
 * He comes to you: notifications to your own paired devices (Web Push; webpush.ts).
 *
 * This file is the contract and the rules, all pure: the kinds and their switches, quiet
 * hours and the day's limits, what a notification may say (a short title, one line, where
 * it opens: fixed words only, never a secret, never your own words or a model's, which a
 * push service could read), how loudly (three tiers, chosen by rules, never by a model),
 * reminders before an ask lapses, the daily digest, the small payload the service worker
 * turns into a notification, and which push services a node may call.
 *
 * No zod here: the PWA and its service worker read from this file. What the node takes
 * from a device is checked in notify-input.ts.
 */

/* ---------- kinds, and the owner's switches ---------- */

export const NOTIFY_KIND_INFO: Record<NotifyKind, { label: string; hint: string; on: boolean }> = {
  "needs-you": { label: "Something needs you", hint: "A warning or an alert from his heartbeat: once per finding, not again while it stands.", on: true },
  approval: { label: "An approval is waiting", hint: "Something he or an agent wants to send or delete, filed for your answer.", on: true },
  finished: { label: "He has finished", hint: "A chat turn nobody was watching, or a quest you started: done, unverified, gave up or failed. News is told quietly, together, to the device you used last.", on: true },
  question: { label: "He has a question", hint: "An answer that ends by asking you, or a key or connector he needs.", on: true },
  told: { label: "Your rules tell you", hint: "A command a rule of yours matches has run (galahad rule add … --tell): once for each rule and task.", on: true },
};

export interface QuietHours {
  on: boolean;
  /** HH:MM, in `tz`. From the one to the other, across midnight when `to` is the earlier. */
  from: string;
  to: string;
  tz: string;
}

export interface NotifyPrefs {
  kinds: Record<NotifyKind, boolean>;
  /** Everything but an alert waits until they end, then one message says what waited. */
  quiet: QuietHours;
  /** At most this many notifications a day; when it's reached, one last message says so. */
  perDay: number;
  /** One quiet message a day of what happened that he didn't tell you of, at `at` in your own time (your word, 25 November 2026: 08:00). */
  digest: { on: boolean; at: string };
}

export const NOTIFY_PER_DAY = { min: 1, max: 50, default: 12 } as const;
/** Quiet hours are read in the node's own time zone until you set one (readNotifyPrefs' `zone`); UTC where it has none. */
export const NOTIFY_DEFAULTS: NotifyPrefs = {
  kinds: { "needs-you": true, approval: true, finished: true, question: true, told: true },
  quiet: { on: true, from: "22:00", to: "07:00", tz: "UTC" },
  perDay: NOTIFY_PER_DAY.default,
  digest: { on: true, at: "08:00" },
};

export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Stored preferences, read leniently: whatever doesn't read as a setting is the default. `zone`: the node's own time zone,
 * which quiet hours are read in until you set one. */
export function readNotifyPrefs(raw: unknown, zone: string = NOTIFY_DEFAULTS.quiet.tz): NotifyPrefs {
  const ownZone = isTimeZone(zone) ? zone : NOTIFY_DEFAULTS.quiet.tz;
  const r = (raw && typeof raw === "object" ? raw : {}) as { kinds?: Record<string, unknown>; quiet?: Record<string, unknown>; perDay?: unknown; digest?: Record<string, unknown> };
  const kinds = { ...NOTIFY_DEFAULTS.kinds };
  for (const kind of NOTIFY_KINDS) if (typeof r.kinds?.[kind] === "boolean") kinds[kind] = r.kinds[kind] as boolean;
  const q = r.quiet ?? {};
  const clock = (value: unknown, fallback: string) => (typeof value === "string" && CLOCK.test(value) ? value : fallback);
  return {
    kinds,
    quiet: {
      on: typeof q.on === "boolean" ? q.on : NOTIFY_DEFAULTS.quiet.on,
      from: clock(q.from, NOTIFY_DEFAULTS.quiet.from),
      to: clock(q.to, NOTIFY_DEFAULTS.quiet.to),
      tz: typeof q.tz === "string" && isTimeZone(q.tz) ? q.tz : ownZone,
    },
    perDay: typeof r.perDay === "number" && Number.isInteger(r.perDay) && r.perDay >= NOTIFY_PER_DAY.min && r.perDay <= NOTIFY_PER_DAY.max ? r.perDay : NOTIFY_DEFAULTS.perDay,
    digest: { on: typeof r.digest?.on === "boolean" ? r.digest.on : NOTIFY_DEFAULTS.digest.on, at: clock(r.digest?.at, NOTIFY_DEFAULTS.digest.at) },
  };
}

const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Whether an instant falls in the quiet hours (from inclusive, to exclusive; across midnight when `to` is earlier). */
export function inQuietHours(quiet: QuietHours, now: number): boolean {
  if (!quiet.on || !CLOCK.test(quiet.from) || !CLOCK.test(quiet.to) || quiet.from === quiet.to || !isTimeZone(quiet.tz)) return false;
  const parts = zonedParts(now, quiet.tz);
  const at = parts.hour * 60 + parts.minute;
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** The calendar day an instant falls on in a zone, YYYY-MM-DD: the day the limit counts. */
export function notifyDay(now: number, tz: string): string {
  const zone = isTimeZone(tz) ? tz : NOTIFY_DEFAULTS.quiet.tz;
  let format = dayFormats.get(zone);
  if (!format) dayFormats.set(zone, (format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })));
  const p: Record<string, string> = {};
  for (const part of format.formatToParts(now)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/* ---------- what he may say: one item per thing worth telling ---------- */

/**
 * How loudly a thing is told (PLAN #59): now, at once, to every device, with a budget of its own (an ask that lapses or
 * blocks, an alert, a fault only you can fix); soon, quietly, with what else is new, to the device you used last (news of
 * work you asked for); or only in the day's digest (everything else). Chosen by rules from what the node itself wrote,
 * never by a model: see `tierOf`.
 */
export type NotifyTier = "now" | "soon" | "digest";
export const NOTIFY_TIERS: readonly NotifyTier[] = ["now", "soon", "digest"];

/** What a digest counts each thing as (`digestMessage`). */
export type DigestTopic = "look" | "chat" | "quest" | "tell" | "report" | "ci" | "backlog" | "note" | "asked" | "lapsed";

export interface NotifyItem {
  /** Told once: "notice:<key>", "action:<id>", "secret:<name>", "turn:<id>", "quest:<id>". */
  key: string;
  kind: NotifyKind;
  /** An alert isn't held by quiet hours. */
  alert: boolean;
  title: string;
  body: string;
  open: NotifyOpen;
  conversation?: string;
  /** Scopes a device must hold to be told (what it could see in the app anyway). */
  needs: string[];
  /** An approval's action, answered from the notification itself (Decline alone when it can't be approved there). */
  action?: { id: string; approvable: boolean };
  /** How loudly (`tierOf`; an item kept from before tiers is read by its kind: `itemTier`). */
  tier?: NotifyTier;
  /** Raised by his own judgment (a turn that ends asking you, an outcome's question): a small budget of its own a day. */
  model?: boolean;
  /** What the digest counts it as, when it goes there. */
  topic?: DigestTopic;
  /** When an ask lapses, no answer being no: its last reminder comes before (`reminderDue`). */
  expires?: number;
}

/** A line that may be shown: cleaned and cut; null when it looks like it holds a secret (the caller says something general instead). */
export function notifyLine(text: string, max = NOTIFY_BODY_MAX): string | null {
  const line = notifyClean(text, max);
  if (!line || findSecrets(line).length) return null;
  return line;
}

/*
 * Fixed words only (your word, 25 November 2026): a notification never carries a chat's title, a quest's goal, a
 * name you gave (a node, a loop, a rule, a device) or anything a model wrote, whichever service carries it. Apple
 * reads what it carries to an iPhone; Web Push and UnifiedPush are sealed to the device, and carry the same fixed
 * words. The app shows the real words once it has fetched them over its own signed connection.
 */

/** Where a thing comes from, as far as how loudly it's told: what the node itself wrote, never a model's words. */
export type NotifyOrigin =
  | { from: "notice"; key: string; severity: string; source: string }
  | { from: "action" | "screen" | "question" | "secret" | "connector" | "quest" }
  | { from: "turn"; look: boolean; question: boolean; waiting: boolean };

/** Sources whose findings are the node's own, about what only you can fix (its heartbeat and doctor, the archive, compute, CI that's yours). */
const NODE_SOURCES = new Set(["heartbeat", "archive", "compute", "ci"]);
const RULE_SOURCE = /^rule:([a-z0-9][a-z0-9._-]{0,39})$/;
const TELL_SOURCE = /^tell:([a-z0-9][a-z0-9._-]{0,39})$/;
const OUTCOME_SOURCE = /^outcome:out-[a-z0-9_-]{12}$/;
const LOOP_SOURCE = /^loop:[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * How loudly, by rules (PLAN #59). Now: every ask (an approval, his ask to use a Mac, a service's question, a key or a
 * connector he needs), every alert, and a warning the node raised that only you can fix. Soon: news of work you asked
 * for (a chat you left him in, a quest you ran, your rules' and loops' tells, a loop that failed, an outcome's end), and
 * what his own judgment raises (a turn that ends asking you or waiting on your answer, an outcome's question), which is
 * `model` and has a small budget of its own. The digest: his own looks that ended without needing you, a CI failure
 * a knight is already fixing, an outcome's daily report, backlog proposals, and every other note.
 */
export function tierOf(origin: NotifyOrigin): { tier: NotifyTier; model: boolean; topic: DigestTopic } {
  switch (origin.from) {
    case "action":
    case "screen":
    case "question":
    case "secret":
    case "connector":
      return { tier: "now", model: false, topic: "note" };
    case "quest":
      return { tier: "soon", model: false, topic: "quest" };
    case "turn": {
      const asks = origin.question || origin.waiting;
      if (origin.look && !asks) return { tier: "digest", model: false, topic: "look" };
      return { tier: "soon", model: asks, topic: asks ? "asked" : origin.look ? "look" : "chat" };
    }
    case "notice": {
      const { severity, source, key } = origin;
      if (severity === "alert") return { tier: "now", model: false, topic: "note" };
      if (severity === "warn") {
        if (source === "heartbeat" && key.startsWith("loop-failing:")) return { tier: "soon", model: false, topic: "tell" };
        if (NODE_SOURCES.has(source)) return { tier: "now", model: false, topic: source === "ci" ? "ci" : "note" };
        if (LOOP_SOURCE.test(source)) return { tier: "soon", model: false, topic: "tell" };
        // An outcome's question, and any warning from a source whose words are a model's: his judgment, never Now.
        return { tier: "soon", model: true, topic: "asked" };
      }
      if (TELL_SOURCE.test(source) || RULE_SOURCE.test(source)) return { tier: "soon", model: false, topic: "tell" };
      if (OUTCOME_SOURCE.test(source)) return key.endsWith(":report") ? { tier: "digest", model: false, topic: "report" } : { tier: "soon", model: false, topic: "tell" };
      if (source === "backlog") return { tier: "digest", model: false, topic: "backlog" };
      if (source === "ci") return { tier: "digest", model: false, topic: "ci" };
      return { tier: "digest", model: false, topic: "note" };
    }
  }
}

/** An item's tier: its own, or for one kept from before tiers, its kind's (an ask or a finding now, news soon). */
export const itemTier = (item: Pick<NotifyItem, "tier" | "kind">): NotifyTier => item.tier ?? (item.kind === "finished" || item.kind === "told" ? "soon" : "now");

const placed = (origin: NotifyOrigin): Pick<NotifyItem, "tier" | "model" | "topic"> => {
  const t = tierOf(origin);
  return { tier: t.tier, topic: t.topic, ...(t.model ? { model: true } : {}) };
};

/**
 * A notice that is told, or counted in the digest: a finding of warn or alert, a tell of a loop or a rule of yours, an
 * outcome's news, or a note. Nothing dismissed. Fixed words only: its own title is the node's words around names you
 * gave (and a model's, from some sources), and the Inbox has it.
 */
export function noticeItem(n: { key: string; severity: string; title: string; source: string; dismissed: boolean }): NotifyItem | null {
  if (n.dismissed || (n.severity !== "warn" && n.severity !== "alert" && n.severity !== "info")) return null;
  const key = `notice:${n.key}`;
  const where = placed({ from: "notice", key: n.key, severity: n.severity, source: n.source });
  if (n.severity !== "info") {
    const alert = n.severity === "alert";
    return { key, kind: "needs-you", alert, title: alert ? "Galahad: alert" : "Galahad: this needs you", body: "Something in your Inbox needs you.", open: "inbox", needs: ["mind:read"], ...where };
  }
  // A loop that tells you, a command a rule of yours matches (once for each rule and task), an outcome's news, his
  // proposal from your backlog: what woke it and what was said (often others' words, or a model's) stay in the Inbox.
  const told = (title: string, body: string): NotifyItem => ({ key, kind: "told", alert: false, title, body, open: "inbox", needs: ["mind:read"], ...where });
  if (TELL_SOURCE.test(n.source)) return told("Galahad: a loop of yours", "What you asked to be told about has happened. The Inbox says what.");
  if (RULE_SOURCE.test(n.source)) return told("Galahad: a rule of yours", "A command it matches has run. The Inbox says which, where and how it ended.");
  if (OUTCOME_SOURCE.test(n.source)) return told("Galahad: an outcome of yours", "There's news of it: his words are in its room and your Inbox.");
  if (n.source === "backlog") return told("Galahad: work for a knight", "He proposes a task from your backlog that may spend more than is left of your budget. It starts when you approve it.");
  return told("Galahad: a note", "There's a note in your Inbox.");
}

/** How long an action must have waited before it's told: one that a standing order answers at once never is. */
export const ACTION_SETTLE_MS = 5_000;

/** An approval waiting for your answer: never which tool, its arguments or the reason given (the app shows them). */
export function actionItem(a: { id: string; connector: string; tool: string; state: string; requestedMs: number; expires: number; class?: string }, now: number): NotifyItem | null {
  if (a.state !== "waiting" || a.expires <= now || now - a.requestedMs < ACTION_SETTLE_MS) return null;
  return {
    key: `action:${a.id}`,
    kind: "approval",
    alert: false,
    title: "Galahad asks your approval",
    body: a.class === "delete" ? "A delete is waiting for your answer in the Inbox." : "An action is waiting for your answer in the Inbox.",
    open: "inbox",
    needs: ["mind:read"],
    expires: a.expires,
    ...placed({ from: "action" }),
    // Answered from the notification too: a yes only in the app, with the request in front of you (your word, 25
    // November 2026); a no where it's told. A delete is approved only where its name is typed.
    ...(/^a_[A-Za-z0-9_-]{22}$/.test(a.id) ? { action: { id: a.id, approvable: a.class !== undefined && a.class !== "delete" } } : {}),
  };
}

/**
 * An MCP server's question to you, mid-call (questions.ts): never which service or what it asks. Like an approval, it
 * settles a moment first: one you answered at once isn't told.
 */
export function questionItem(q: { id: string; connector: string; askedAt: number; expires: number }, now: number): NotifyItem | null {
  if (q.expires <= now || now - q.askedAt < ACTION_SETTLE_MS) return null;
  return {
    key: `question:${q.id}`,
    kind: "question",
    alert: false,
    // Every notification is his (your word, 23 November 2026: he is the one you hear from), a service's question too.
    title: "Galahad: a service asks you",
    body: "A service asks you something in the Inbox; its call waits for your answer.",
    open: "inbox",
    needs: ["mind:read"],
    expires: q.expires,
    ...placed({ from: "question" }),
  };
}

/**
 * Galahad asks to use a Mac itself (docs/MAC.md, M4): for how long, never which Mac (its name is yours) or what for (his
 * words). Like an approval, it settles a moment first: one you answered at once isn't told.
 */
export function screenItem(s: { id: string; nodeName: string; minutes: number; state: string; askedAt: number; answerBy?: number }, now: number): NotifyItem | null {
  if (s.state !== "waiting" || now - s.askedAt < ACTION_SETTLE_MS) return null;
  const minutes = Number.isInteger(s.minutes) && s.minutes > 0 && s.minutes < 10_000 ? s.minutes : null;
  return {
    key: `screen:${s.id}`,
    kind: "approval",
    alert: false,
    title: "Galahad asks your approval",
    body: minutes ? `To use a Mac itself for ${minutes} minutes: your answer is in the Inbox.` : "To use a Mac itself: your answer is in the Inbox.",
    open: "inbox",
    needs: ["mind:read"],
    ...(s.answerBy ? { expires: s.answerBy } : {}),
    ...placed({ from: "screen" }),
  };
}

/**
 * A key he asked for. Neither its name nor what it's for is shown: whoever asked (an agent may) chose both, and a
 * name is words enough to say something ("call-this-number-now"). The Inbox says which.
 */
export function secretItem(name: string): NotifyItem | null {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(name)) return null;
  return { key: `secret:${name}`, kind: "question", alert: false, title: "Galahad asks for a key", body: "He needs a key to go on. The Inbox says which; he learns only that it's there.", open: "inbox", needs: ["vault:read"], ...placed({ from: "secret" }) };
}

/**
 * A connector an agent asked for (requestConnector). Like a key's request it says neither which nor why: an agent chose
 * both, and a connector's name is words enough to say something. The Inbox says which.
 */
export function connectorItem(id: string): NotifyItem | null {
  if (!/^cr_[A-Za-z0-9_-]{22}$/.test(id)) return null;
  return { key: `connector:${id}`, kind: "question", alert: false, title: "Galahad asks for a connector", body: "He needs a connector to go on. The Inbox says which.", open: "inbox", needs: ["brain:write"], ...placed({ from: "connector" }) };
}

/**
 * A chat turn that ended with nobody watching: finished, couldn't finish, or ended by asking you. Never the chat's title
 * (your first message, or the name you gave it): the app opens the chat. A chat where he read the bank is told only to
 * devices that may read the bank. One of his own looks that ended without needing you goes to the digest.
 */
export function turnItem(t: { id: string; conversation: string; bank: boolean; state: "done" | "error"; question: boolean; waiting: boolean; look?: boolean }): NotifyItem | null {
  if (!isConversationId(t.conversation)) return null;
  const asks = t.state === "done" && t.question;
  const where = t.look ? "A chat he looked in again" : "A chat you left him working in";
  return {
    key: `turn:${t.id}`,
    kind: asks ? "question" : "finished",
    alert: false,
    title: t.state === "error" ? "Galahad couldn't finish" : asks ? "Galahad has a question for you" : "Galahad has finished",
    body: notifyClean(t.state === "error" ? `${where} ended with an error. Nothing is retried.` : t.waiting ? `${where}: it waits on your answer in the Inbox.` : asks ? `${where} ends by asking you something.` : `${where} has his answer.`, NOTIFY_BODY_MAX),
    open: "chat",
    conversation: t.conversation,
    needs: t.bank ? ["chat", "bank:read"] : ["chat"],
    ...placed({ from: "turn", look: !!t.look, question: asks, waiting: t.waiting }),
  };
}

const QUEST_ENDS: Record<string, string> = { done: "Quest done", unverified: "Quest ended unverified", "gave-up": "Quest gave up", failed: "Quest failed" };

/** A quest you started that has ended, said as it ended. One you stopped yourself isn't news. Never its goal (your words). */
export function questItem(q: { quest: string; goal: string; state: string }): NotifyItem | null {
  const title = QUEST_ENDS[q.state];
  if (!title || !/^[A-Za-z0-9._:-]{1,64}$/.test(q.quest)) return null;
  return { key: `quest:${q.quest}`, kind: "finished", alert: false, title, body: "A quest you started has ended.", open: "overview", needs: ["mind:read"], ...placed({ from: "quest" }) };
}

/* ---------- when he speaks, and when he stays silent ---------- */

/** Between two messages that aren't alerts: what comes in meanwhile is told together. */
export const NOTIFY_GAP_MS = 60_000;
/** News (the soon tier) is told at most this often, unless it rides along with something told now. */
export const NEWS_GAP_MS = 30 * 60_000;
/** What his own judgment raises (a turn that ends asking you, an outcome's question) is told at most this often a day; past it, the digest says how often he asked. */
export const MODEL_PER_DAY = 3;

export interface NotifyPlan {
  /** What to tell now, as one message (empty: stay silent). */
  send: NotifyItem[];
  /** Why the rest waits: quiet hours, the day's limit, or too soon after the last message. */
  waiting: "quiet" | "limit" | "gap" | null;
  /** The message is news alone: told quietly, to the device you used last. */
  news: boolean;
  /** What goes to the day's digest instead, now (never told on its own): its tier, or a budget it's past. */
  digest: NotifyItem[];
}

/**
 * How much of the day's limit is kept back for alerts. Without it, whatever can file an approval or ask for a
 * key (an agent can) could spend the whole day's limit on noise, and the alert that mattered would never be told.
 */
export const alertReserve = (perDay: number): number => (perDay >= 6 ? 2 : perDay >= 3 ? 1 : 0);

/**
 * How many of the day's messages may be news (the soon tier) alone: half of what isn't kept for alerts, so news can
 * never spend what an ask needs (12 a day: 5 for news, at least 5 more for asks and findings, 2 for alerts). News past
 * it goes to the digest. News that rides along with something told now spends nothing of it.
 */
export const newsBudget = (perDay: number): number => Math.floor((perDay - alertReserve(perDay)) / 2);

/**
 * Whether what's told now (asks and findings) has reached the day's limit. When it has, one message says so
 * (`limitMessage`): once that day, and not during quiet hours (it isn't an alert); after it only an alert is told, and few.
 */
export const limitReached = (prefs: NotifyPrefs, sentToday: number): boolean => sentToday >= prefs.perDay - alertReserve(prefs.perDay);

/**
 * What to tell at this moment. Never anything for "all quiet": with nothing new there is nothing to send. By tier:
 *
 *  - now: everything new goes as one message (a burst is one buzz), a minute after the last unless it's an alert, to
 *    every device; quiet hours hold all but alerts. The day's limit holds everything, alerts too; its last one or two
 *    (`alertReserve`) are for alerts alone.
 *  - soon (news): quietly, with what else is new, at most every half hour, or along with something told now; held
 *    by quiet hours; at most `newsBudget` messages of news alone a day, the rest to the digest. What his own
 *    judgment raised (`model`) has `MODEL_PER_DAY`; past it, to the digest.
 *  - digest: never told on its own; it's counted in the day's digest (`digest`).
 *
 * `told`: the items already told (an alert is told again when it was told only as a warning). `prefs.quiet.tz`: the zone
 * your day is read in (the node's caller resolves it: the zone your devices say, else the setting).
 */
export function planNotifications(input: {
  now: number;
  prefs: NotifyPrefs;
  items: readonly NotifyItem[];
  told: ReadonlyMap<string, { alert: boolean }>;
  sentToday: number;
  lastSentAt: number | null;
  /** Messages of news alone sent today, and when the last one went. */
  newsToday?: number;
  lastNewsAt?: number | null;
  /** What his own judgment raised that was told today. */
  modelToday?: number;
}): NotifyPlan {
  const untold = input.items.filter((item) => {
    const before = input.told.get(item.key);
    return !before || (item.alert && !before.alert);
  });
  // The digest's own, whatever the switches say: it counts what happened; the switches are about what buzzes.
  const digest = untold.filter((item) => itemTier(item) === "digest");
  const fresh = untold.filter((item) => itemTier(item) !== "digest" && input.prefs.kinds[item.kind]);
  // His own judgment, past its budget: the digest says how often he asked.
  let modelLeft = MODEL_PER_DAY - (input.modelToday ?? 0);
  const asked: NotifyItem[] = [];
  const candidates = fresh.filter((item) => {
    if (!item.model) return true;
    if (modelLeft > 0) {
      modelLeft -= 1;
      return true;
    }
    asked.push(item);
    return false;
  });
  const silent = (waiting: NotifyPlan["waiting"], toDigest: NotifyItem[] = []): NotifyPlan => ({ send: [], waiting, news: false, digest: [...digest, ...asked, ...toDigest] });
  if (!candidates.length) return silent(null);
  if (input.sentToday >= input.prefs.perDay) return silent("limit");

  const quiet = inQuietHours(input.prefs.quiet, input.now);
  const now = candidates.filter((item) => itemTier(item) === "now");
  const news = candidates.filter((item) => itemTier(item) === "soon");
  // Past the limit for what's told now, only an alert is.
  const nowAllowed = limitReached(input.prefs, input.sentToday) ? now.filter((item) => item.alert) : now;
  const nowDue = quiet ? nowAllowed.filter((item) => item.alert) : nowAllowed;
  const newsDue = quiet ? [] : news;
  const urgent = nowDue.some((item) => item.alert);
  const gapped = !urgent && input.lastSentAt !== null && input.now - input.lastSentAt < NOTIFY_GAP_MS;
  const reason = (): NotifyPlan["waiting"] => (quiet && (nowDue.length < now.length || news.length) ? "quiet" : nowAllowed.length < now.length ? "limit" : null);
  if (nowDue.length) {
    if (gapped) return silent("gap");
    // News rides along with what's told now: one buzz, and nothing of news' own budget spent.
    return { send: [...nowDue, ...newsDue], waiting: reason(), news: false, digest: [...digest, ...asked] };
  }
  if (!newsDue.length) return silent(quiet ? "quiet" : nowAllowed.length < now.length ? "limit" : null);
  // News alone: within its own budget (past it, to the digest), half an hour after the last news, a minute after anything.
  if ((input.newsToday ?? 0) >= newsBudget(input.prefs.perDay) || limitReached(input.prefs, input.sentToday)) return silent("limit", newsDue);
  if (gapped || (input.lastNewsAt != null && input.now - input.lastNewsAt < NEWS_GAP_MS)) return silent("gap");
  return { send: newsDue, waiting: reason(), news: true, digest: [...digest, ...asked] };
}

const counted = (n: number, one: string, many: string): string => (n === 1 ? one : many.replace("%", String(n)));

/**
 * One message for what's told now: the item itself when it's one, otherwise how many of each kind, without their words.
 * A message of news alone carries a news kind (finished, or told), so every device tells it quietly; a summary has a
 * tag of its own for its tier and what it began with, so a newer summary never replaces one that told of an ask.
 * `salt`: this node's own secret for tags (see `tagOf`).
 */
export function notifyMessage(items: readonly NotifyItem[], salt = ""): NotifyPayload | null {
  if (!items.length) return null;
  const news = items.every((item) => itemTier(item) !== "now");
  const quietKind = (): NotifyPayload["kind"] => (items.every((item) => item.kind === "finished") ? "finished" : "told");
  if (items.length === 1) {
    const item = items[0]!;
    return {
      v: 1,
      kind: news ? quietKind() : item.kind,
      title: notifyClean(item.title, NOTIFY_TITLE_MAX),
      body: notifyClean(item.body, NOTIFY_BODY_MAX),
      open: item.open,
      ...(item.conversation ? { conversation: item.conversation } : {}),
      tag: tagOf(item.key, salt),
      ...(item.action && item.kind === "approval" && !news ? { action: item.action.id, approvable: item.action.approvable } : {}),
    };
  }
  const count = (kind: NotifyKind) => items.filter((item) => item.kind === kind).length;
  const parts = [
    count("needs-you") ? counted(count("needs-you"), "1 thing needs you", "% things need you") : null,
    count("approval") ? counted(count("approval"), "1 approval is waiting", "% approvals are waiting") : null,
    count("question") ? counted(count("question"), "he has a question", "he has % questions") : null,
    count("finished") ? counted(count("finished"), "he finished 1 piece of work", "he finished % pieces of work") : null,
    count("told") ? counted(count("told"), "he has news you asked for", "he has % pieces of news you asked for") : null,
  ].filter((part): part is string => part !== null);
  const body = parts.join(", ");
  // One place when they all open the same one; otherwise the Inbox, where what needs you is.
  const opens = new Set(items.map((item) => item.open));
  const open = opens.size === 1 ? items[0]!.open : "inbox";
  return {
    v: 1,
    kind: news ? quietKind() : "summary",
    title: items.some((item) => item.alert) ? "Galahad: alert" : `Galahad: ${items.length} things`,
    body: notifyClean(`${body.charAt(0).toUpperCase()}${body.slice(1)}.`, NOTIFY_BODY_MAX),
    open: open === "chat" ? "overview" : open,
    tag: tagOf(`summary:${news ? "news" : "now"}:${items[0]!.key}`, salt),
  };
}

/**
 * A notification's tag from an item's key: the same finding told again replaces its old notification.
 * A digest, never the key itself: a key names what it's about ("bank-consent:…"), and a payload doesn't.
 * Keyed with the node's own salt, because a digest of the tag also travels in the clear as the message's
 * topic: without the salt a push service could try likely keys ("notice:loop:ci") against it.
 */
export function tagOf(key: string, salt = ""): string {
  const tag = `t-${b64u(sha256(utf8(`${salt}\n${key}`))).slice(0, 22)}`;
  return isNotifyTag(tag) ? tag : "galahad";
}

/* ---------- reminders, before an ask lapses ---------- */

/** An ask still unanswered this long after it was told is told again, once, in your waking hours. */
export const REMIND_AFTER_MS = 4 * 3_600_000;
/** The last reminder comes this long before an ask lapses (before your night, when it lapses in it). */
export const REMIND_BEFORE_LAPSE_MS = 3_600_000;
/** Never two reminders closer than this. */
export const REMIND_SPACING_MS = 2 * 3_600_000;
/** At most this many reminders for one ask. */
export const REMINDERS_MAX = 2;
/**
 * At most this many reminder messages a day, a budget of their own: reminders never spend what a new ask needs (they
 * once did, and an approval asked at 21:00 waited for the morning), and a flood of asks can't become a flood of reminders.
 */
export const REMINDERS_PER_DAY = 6;

const quietSpan = (quiet: QuietHours): number => {
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  return ((to - from + 1440) % 1440) * 60_000;
};

/**
 * Whether an ask still waiting is told again now (PLAN #59): never in quiet hours, never past its lapse, at most twice,
 * two hours apart at least. The first when it has waited four hours since it was told; the last an hour before it
 * lapses, or, when it lapses in the night, in the hour before the night begins. An ask that doesn't lapse (a key or a
 * connector he needs) has the first alone.
 */
export function reminderDue(ask: { toldAt: number; expires: number | null; reminded: number; lastRemindedAt: number | null }, now: number, quiet: QuietHours): boolean {
  if (ask.reminded >= REMINDERS_MAX) return false;
  if (ask.expires !== null && now >= ask.expires) return false;
  if (ask.lastRemindedAt !== null && now - ask.lastRemindedAt < REMIND_SPACING_MS) return false;
  // (What's cheap first: a clock in a zone is read only when a reminder would otherwise be due.)
  const last = ask.expires !== null && now >= ask.expires - REMIND_BEFORE_LAPSE_MS;
  const first = ask.reminded === 0 && now - ask.toldAt >= REMIND_AFTER_MS;
  // It lapses in the night: the last word before the night begins (within the hour before it, and the night lasts until then).
  const beforeNight = ask.expires !== null && !last && ask.expires - now <= REMIND_BEFORE_LAPSE_MS + quietSpan(quiet) && inQuietHours(quiet, now + REMIND_BEFORE_LAPSE_MS) && inQuietHours(quiet, ask.expires);
  return (last || first || beforeNight) && !inQuietHours(quiet, now);
}

const WAITS: Record<string, string> = {
  action: "An approval still waits for your answer.",
  screen: "His ask to use a Mac still waits for your answer.",
  question: "A service's question still waits for your answer.",
  secret: "He still needs a key to go on. The Inbox says which.",
  connector: "He still needs a connector to go on. The Inbox says which.",
};

/** A time of day as a reminder says it: "14:05" today in your zone, "Thu 09:05" on another day. */
export function lapseTime(at: number, now: number, tz: string): string {
  const zone = isTimeZone(tz) ? tz : "UTC";
  const a = zonedParts(at, zone);
  const n = zonedParts(now, zone);
  const clock = `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`;
  if (a.year === n.year && a.month === n.month && a.day === n.day) return clock;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][a.dow] ?? ""} ${clock}`.trim();
}

/**
 * A reminder: fixed words, when it lapses (no answer is no), and the ask's own tag, so it replaces the notification that
 * told of it. No buttons: a reminder opens the Inbox.
 */
export function reminderMessage(item: Pick<NotifyItem, "key" | "kind" | "expires">, now: number, tz: string, salt = ""): NotifyPayload {
  const what = WAITS[item.key.slice(0, item.key.indexOf(":"))] ?? "Something still waits for your answer.";
  const lapse = item.expires && item.expires > now ? ` No answer by ${lapseTime(item.expires, now, tz)} means no.` : "";
  return { v: 1, kind: item.kind, title: "Galahad: still waiting", body: notifyClean(`${what}${lapse}`, NOTIFY_BODY_MAX), open: "inbox", tag: tagOf(item.key, salt) };
}

/**
 * What's reminded at one look, as one message: the reminder itself when it's one; otherwise how many asks still wait and
 * when the first of them lapses, with a tag of its own. Never buttons.
 */
export function remindersMessage(items: readonly Pick<NotifyItem, "key" | "kind" | "expires">[], now: number, tz: string, salt = ""): NotifyPayload | null {
  if (!items.length) return null;
  if (items.length === 1) return reminderMessage(items[0]!, now, tz, salt);
  const lapses = items.map((item) => item.expires).filter((at): at is number => typeof at === "number" && at > now);
  const first = lapses.length ? ` The first lapses at ${lapseTime(Math.min(...lapses), now, tz)}; no answer is no.` : " The Inbox has them.";
  return { v: 1, kind: "summary", title: "Galahad: still waiting", body: notifyClean(`${items.length} asks still wait for your answer.${first}`, NOTIFY_BODY_MAX), open: "inbox", tag: tagOf(`reminders:${items[0]!.key}`, salt) };
}

/* ---------- the day's digest ---------- */

/** What the digest counts, since the last one. Knights' tasks are read from the node at send time; the rest is what went to the digest instead of buzzing. */
export interface DigestCounts {
  topics: Partial<Record<DigestTopic, number>>;
  /** Knights' tasks that ended: verified, and not. */
  verified: number;
  unverified: number;
  /** Asks that stand now. */
  open: number;
}

/** Whether the day's digest is due: it's on, it's past its time in your zone today, it wasn't said today, and it isn't quiet hours. */
export function digestDue(prefs: NotifyPrefs, now: number, saidOn: string | null): boolean {
  if (!prefs.digest.on || !CLOCK.test(prefs.digest.at)) return false;
  if (saidOn === notifyDay(now, prefs.quiet.tz)) return false;
  const p = zonedParts(now, isTimeZone(prefs.quiet.tz) ? prefs.quiet.tz : "UTC");
  return p.hour * 60 + p.minute >= minutes(prefs.digest.at) && !inQuietHours(prefs.quiet, now);
}

/**
 * The digest: one quiet message a day of what happened that he didn't buzz you for, in counts and fixed words, most
 * telling first, and what still waits. Nothing happened, nothing is said (null). It opens the Overview, and replaces
 * yesterday's.
 */
export function digestMessage(c: DigestCounts, salt = ""): NotifyPayload | null {
  const t = c.topics;
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n) parts.push(counted(n, one, many));
  };
  add(t.lapsed, "1 ask lapsed unanswered", "% asks lapsed unanswered");
  add(c.verified, "1 task verified", "% tasks verified");
  add(c.unverified, "1 task didn't pass", "% tasks didn't pass");
  add(t.asked, "1 more question of his", "% more questions of his");
  add((t.chat ?? 0) + (t.quest ?? 0) + (t.tell ?? 0), "1 more piece of news", "% more pieces of news");
  add(t.look, "1 look of his", "% looks of his");
  add(t.report, "1 outcome report", "% outcome reports");
  add(t.ci, "1 CI fix under way", "% CI fixes under way");
  add(t.backlog, "1 backlog proposal", "% backlog proposals");
  add(t.note, "1 note", "% notes");
  if (!parts.length) return null;
  const waits = c.open ? ` ${counted(c.open, "1 ask still waits for you.", "% asks still wait for you.")}` : "";
  let list = "";
  for (const part of parts) {
    const next = list ? `${list}, ${part}` : part;
    if (`${next}.${waits}`.length > NOTIFY_BODY_MAX) break;
    list = next;
  }
  if (!list) list = parts[0]!;
  return { v: 1, kind: "finished", title: "Galahad: while you were away", body: notifyClean(`${list.charAt(0).toUpperCase()}${list.slice(1)}.${waits}`, NOTIFY_BODY_MAX), open: "overview", tag: tagOf("digest", salt) };
}

/* ---------- what waited while nobody could be reached ---------- */

/**
 * What a catch-up counts: what stands and needs you now (approvals, questions, keys and connectors he needs, warnings
 * only you can fix, and alerts). News (a turn that ended, a quest, a rule's tell, a loop that failed) isn't caught up:
 * it was news then.
 */
const CATCH_UP_KINDS: ReadonlySet<NotifyKind> = new Set(["needs-you", "approval", "question"]);

/**
 * When the device that comes back after nobody could be reached is told what waited (`items`: what stands that needs
 * you and was told already, to nobody or to a device that couldn't be reached): as any message is, the kinds you
 * turned off left out, within quiet hours, the day's limit and a minute after the last message, unless an alert is in
 * it. What was never told isn't its business: that is told as anything new is.
 */
export function planCatchUp(input: { now: number; prefs: NotifyPrefs; items: readonly NotifyItem[]; sentToday: number; lastSentAt: number | null }): Pick<NotifyPlan, "send" | "waiting"> {
  const due = input.items.filter((item) => CATCH_UP_KINDS.has(item.kind) && itemTier(item) === "now" && input.prefs.kinds[item.kind]);
  if (!due.length) return { send: [], waiting: null };
  const urgent = due.some((item) => item.alert);
  if (input.sentToday >= input.prefs.perDay || (!urgent && limitReached(input.prefs, input.sentToday))) return { send: [], waiting: "limit" };
  if (!urgent && inQuietHours(input.prefs.quiet, input.now)) return { send: [], waiting: "quiet" };
  if (!urgent && input.lastSentAt !== null && input.now - input.lastSentAt < NOTIFY_GAP_MS) return { send: [], waiting: "gap" };
  return { send: due, waiting: null };
}

/**
 * The catch-up: how many of each wait, never their words, opening the Inbox. No buttons (it only counts), and a tag of
 * its own, so a summary of news that comes after doesn't replace it.
 */
export function catchUpMessage(items: readonly NotifyItem[], salt = ""): NotifyPayload | null {
  const counts: [number, string, string][] = [
    [items.filter((item) => item.kind === "needs-you" && item.alert).length, "1 alert", "% alerts"],
    [items.filter((item) => item.kind === "approval").length, "1 approval", "% approvals"],
    [items.filter((item) => item.kind === "question").length, "1 question", "% questions"],
    [items.filter((item) => item.kind === "needs-you" && !item.alert).length, "1 warning", "% warnings"],
  ];
  const parts = counts.filter(([n]) => n > 0).map(([n, one, many]) => counted(n, one, many));
  const n = counts.reduce((sum, [count]) => sum + count, 0);
  if (!n) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
  return {
    v: 1,
    kind: "summary",
    title: notifyClean(`Galahad: ${counted(n, "1 thing waits", "% things wait")} for you`, NOTIFY_TITLE_MAX),
    body: notifyClean(`While he couldn't reach you: ${list}. The Inbox has ${n === 1 ? "it" : "them"}.`, NOTIFY_BODY_MAX),
    open: "inbox",
    tag: tagOf("catch-up", salt),
  };
}

/** The message that says ordinary news has reached the day's limit (`perDay`: the limit you set). */
export function limitMessage(perDay: number): NotifyPayload {
  const reserve = alertReserve(perDay);
  const sent = perDay - reserve;
  const rest = reserve ? "Until tomorrow only an alert reaches you; the rest waits in your Inbox." : "The rest waits in your Inbox.";
  return { v: 1, kind: "limit", title: "Galahad: quiet until tomorrow", body: `That's ${sent} ${sent === 1 ? "notification" : "notifications"} today. ${rest}`, open: "inbox", tag: "limit" };
}

/** Your test: fixed words (the device's name is yours), to the device that asked or every device. */
export const testMessage = (_device?: string): NotifyPayload => ({ v: 1, kind: "test", title: "Galahad", body: "This is a test. Notifications reach this device.", open: "settings", tag: "test" });

/* ---------- where a notification may be sent: push services, and nothing else ---------- */

/** The push services browsers use. A subscription that names any other host is refused unless the owner allowed it. */
const PUSH_SERVICES: { name: string; hosts: string[]; suffixes: string[] }[] = [
  { name: "Apple", hosts: ["web.push.apple.com"], suffixes: [".push.apple.com"] },
  { name: "Google", hosts: ["fcm.googleapis.com", "jmt17.google.com"], suffixes: [] },
  { name: "Mozilla", hosts: ["updates.push.services.mozilla.com"], suffixes: [".push.services.mozilla.com"] },
  { name: "Microsoft", hosts: [], suffixes: [".notify.windows.com"] },
  // UnifiedPush's public server (the ntfy app's), for the Android app on the owner's word (21 Nov): it carries bytes it
  // can't read, as the others do. A self-hosted one is allowed with GALAHAD_PUSH_HOSTS.
  { name: "ntfy (UnifiedPush)", hosts: ["ntfy.sh"], suffixes: [] },
];

/** `href`: the address as it was read here, which is the one to call (never the text it was read from). */
export type PushServiceVerdict = { ok: true; service: string; origin: string; href: string } | { ok: false; why: string };

/**
 * Whether an endpoint is a push service a node may call: https, no credentials in it, the default port,
 * and a host that is one of the known services' (Apple, Google, Mozilla, Microsoft, ntfy) or one the owner
 * allowed (`allowed`: a host name, "*.suffix", or a whole origin, which is how a test names a stand-in
 * on this machine). The answer names the service, never the endpoint.
 */
export function pushService(endpoint: string, allowed: readonly string[] = []): PushServiceVerdict {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, why: "the subscription's endpoint isn't a URL" };
  }
  if (url.username || url.password) return { ok: false, why: "the subscription's endpoint carries credentials" };
  const host = url.hostname.toLowerCase();
  // An origin the owner named whole (scheme, host and port) is taken as it is: a stand-in push service in a test.
  if (allowed.some((entry) => /^https?:\/\//.test(entry) && entry.replace(/\/$/, "") === url.origin)) return { ok: true, service: "a push service you allowed", origin: url.origin, href: url.href };
  if (url.protocol !== "https:") return { ok: false, why: "a push service is reached over https" };
  if (url.port && url.port !== "443") return { ok: false, why: "a push service is reached on the standard https port" };
  for (const service of PUSH_SERVICES) {
    if (service.hosts.includes(host) || service.suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return { ok: true, service: service.name, origin: url.origin, href: url.href };
  }
  for (const entry of allowed) {
    if (/^https?:\/\//.test(entry)) continue;
    const pattern = entry.toLowerCase();
    if (pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1)) return { ok: true, service: "a push service you allowed", origin: url.origin, href: url.href };
  }
  return { ok: false, why: `${host} isn't a push service this node knows (Apple, Google, Mozilla, Microsoft, ntfy); allow another with GALAHAD_PUSH_HOSTS on the node` };
}

/* ---------- what the app and the terminal read ---------- */

export interface NotifyDeviceView {
  /** The paired device's id, and its name. */
  device: string;
  name: string;
  /** The push service it's reached through, by name (never its endpoint). */
  service: string;
  since: number;
  /** When a notification last reached its push service, and the last failure if it failed since. */
  lastOk: number | null;
  lastError: string | null;
}

export interface NotifySentView {
  at: number;
  /** A payload's kind, or the day's digest or a reminder (which don't count against the day's limit: they have their own). */
  kind: NotifyPayload["kind"] | "digest" | "reminder";
  /** The devices it went to, by name. */
  devices: string[];
  ok: boolean;
}

/**
 * A device's notifications that its push service stopped taking (404, 410, a token Apple no longer knows): they were on,
 * and you didn't turn them off. When, through which service (by name), and why, in words: never an endpoint or a token.
 */
export interface NotifyLostView {
  at: number;
  service: string;
  why: string;
}

export interface NotifyView {
  node: string;
  /** The zone your day is read in now (quiet hours, the day's count, the digest's time): the one your devices last said, else the setting's. */
  zone?: string;
  /** Tags of notifications whose matter was answered, dismissed or cleared, or lapsed, in the last two days: each app takes them
   * down where it still shows them (the same thing answered on one device is gone from the others). */
  withdrawn?: string[];
  /** This node's public key for subscribing (a browser's applicationServerKey). Public by nature. */
  key: string;
  prefs: NotifyPrefs;
  devices: NotifyDeviceView[];
  /** Whether the device asking is subscribed (null: asked from a terminal). */
  subscribed: boolean | null;
  /** The device asking, when its subscription was lost rather than turned off (null: it wasn't, or asked from a terminal).
   * Its app may turn it on again by itself: it restores your own choice, which still stands. */
  lost: NotifyLostView | null;
  /** How many devices he can reach now: turned on, and not failing (a device whose last sends failed isn't counted). */
  reachable: number;
  /** Today, in the quiet hours' zone: what was sent, and how much of the day's limit is used. */
  today: { day: string; sent: NotifySentView[]; count: number; limit: number };
  /** It's quiet hours now; how many things wait for them to end. */
  quiet: boolean;
  held: number;
}

/* ---------- a native app's own word: re-subscribe, or say how ---------- */

/**
 * What a native app (iPhone, iPad, Mac, Android) does about its notifications when it opens, from the OS's leave and
 * the node's word (Apple's own advice: register at every launch, since tokens change). renew: hand the node this
 * device's subscription again, asking nothing (it's on, or its push service dropped it: your own choice, which still
 * stands) · turn-on: a card saying he can't reach this device, with Turn on (the OS asks from your tap) · settings: a
 * card saying the OS blocks them, with Open Settings · none. A device you turned off while another reaches you isn't
 * nagged; one turned off elsewhere that still thought itself on (`localOn`) is told so.
 */
export type NotifyReach = "renew" | "turn-on" | "settings" | "none";

export function notifyReach(s: { permission: "granted" | "denied" | "undetermined"; subscribed: boolean; lost: boolean; reachable: number; localOn?: boolean }): NotifyReach {
  if (s.subscribed || s.lost) return s.permission === "granted" ? "renew" : s.permission === "denied" ? "settings" : "turn-on";
  if (s.reachable > 0 && !s.localOn) return "none";
  return s.permission === "denied" ? "settings" : "turn-on";
}

