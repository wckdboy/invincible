import {
  actionItem,
  questionItem,
  type ApplePushInput,
  catchUpMessage,
  connectorItem,
  digestDue,
  digestMessage,
  inQuietHours,
  isP256Point,
  isTimeZone,
  itemTier,
  fromB64u,
  limitMessage,
  limitReached,
  noticeItem,
  screenItem,
  notifyDay,
  type NotifyDeviceView,
  type NotifyItem,
  notifyMessage,
  NOTIFY_GAP_MS,
  type NotifyPayload,
  type NotifyPrefs,
  type NotifyPrefsInput,
  type NotifyView,
  planCatchUp,
  planNotifications,
  type PushSubscriptionInput,
  pushService,
  questInHand,
  questItem,
  type QuestView,
  randomId,
  redact,
  reminderDue,
  REMINDERS_PER_DAY,
  remindersMessage,
  secretItem,
  tagOf,
  testMessage,
  turnItem,
} from "@galahad/core";
import type { MindStore } from "@galahad/mind";
import type { LedgerEntryInput } from "@galahad/sandbox";
import type { KeptSummary } from "./chats.ts";
import type { LostRow, NotifyStore, Subscription, ToldRow } from "./notify-store.ts";
import { appleEndpoint, type ApplePushEnvironment, appleTarget } from "./apns-send.ts";
import { COLLECT_SERVICE, collectEndpoint } from "./collect-send.ts";
import type { PushDelivery, PushOutcome, PushTarget } from "./push-send.ts";
import type { LiveTurn } from "./turns.ts";

/** An iPhone's subscription's service, in words: Apple's, or its development service (a build from Xcode). */
const appleService = (environment: ApplePushEnvironment): string => (environment === "production" ? "Apple" : "Apple (a development build)");

/*
 * He comes to you. The node's own events become notifications on the owner's paired
 * devices, through one door: `tick()`. It looks at what stands (findings that need you,
 * approvals waiting, keys he asked for) and at what happened (a turn
 * that ended unwatched, a quest you started), asks the pure rules in
 * core's notify.ts what may be told now and how loudly, and delivers that as one message a
 * device: what needs you now to every device, news quietly to the device you used last, the
 * rest in the day's digest. An ask still unanswered is reminded before it lapses, and what was
 * answered anywhere is taken down everywhere (each app reads `withdrawn`).
 *
 * Nothing else raises one. There is no route, tool or event that carries a title or a
 * line: every word comes from the typed builders in notify.ts, from records this node
 * holds. An agent can't subscribe a device, read a subscription, change what's sent or
 * send anything.
 */

export class NotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface NotifySources {
  notices(): { key: string; severity: string; title: string; source: string; dismissed: boolean }[];
  actions(): { id: string; connector: string; tool: string; state: string; requestedAt: string; expires: number; class?: string }[];
  /** MCP servers' questions waiting for your answer, mid-call (questions.ts). */
  questions?(): { id: string; connector: string; askedAt: number; expires: number }[];
  /** His asks to use a Mac itself, where each stands (core's screen.ts), and by when an answer is due. */
  screenSessions?(): { id: string; nodeName: string; minutes: number; state: string; askedAt: number; answerBy?: number }[];
  /** Knights' tasks that ended since then, verified and not: what the day's digest counts first. */
  tasksEnded?(since: number): { verified: number; unverified: number };
  /** The keys he's waiting for, by name. */
  secretRequests(): string[];
  /** The connectors agents asked for and you haven't added, by request id. */
  connectorRequests(): string[];
  turns: { running(): LiveTurn[]; view(turn: LiveTurn, watchable: boolean): { watchers: number } };
  chats: { summary(id: string): KeptSummary | null };
  quests: { list(): QuestView[]; onChange(fn: () => void): () => void };
}

/** What sends: browsers' push services (push-send.ts) and Apple's, for the iPhone app (apns-send.ts), by the subscription. */
export interface NotifySender {
  /** This node's VAPID key, which browsers subscribe to. */
  publicKey(): Promise<string>;
  send(target: PushTarget, payload: NotifyPayload, delivery: PushDelivery, signal?: AbortSignal): Promise<PushOutcome>;
  close?(): void;
}

export interface NotifyOptions {
  mind: MindStore;
  nodeName: string;
  db: NotifyStore;
  sender: NotifySender;
  /** Push services the owner allowed beyond the known ones. */
  allowed: readonly string[];
  sources: NotifySources;
  ledger: (entry: LedgerEntryInput) => void;
  log: (message: string) => void;
  now?: () => number;
  /** How often he looks (default 15 s); false: only when told to (tests drive it). */
  tickMs?: number | false;
}

const HOUR = 60 * 60_000;
/** A finding that went away and comes back within this isn't told again: one that flaps tells you once. */
export const NOTICE_COOLDOWN_MS = 6 * HOUR;
/** Something that happened and couldn't be told (quiet hours, the limit) is still news for this long; then the digest counts it. */
export const PENDING_KEEP_MS = 36 * HOUR;
/** News goes to the device you used last, if you used it this recently; otherwise to every device. */
export const LAST_USED_MS = 24 * HOUR;
/** A device's presence is written at most this often (every request says it). */
const PRESENCE_EVERY_MS = 60_000;
const TOLD_KEEP_MS = 48 * HOUR;
/** Your own test, at most this often, and this many a day. */
export const TEST_EVERY_MS = 5_000;
export const TESTS_PER_DAY = 20;
const TURN_POLL_MS = 1_000;
const QUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** A device whose sends have failed this many times running keeps failing: it can't be reached (the doctor says so). */
export const FAILING_AFTER = 2;
/** Whether he can reach a device through its subscription now: its sends aren't failing. */
const reaches = (sub: Subscription): boolean => sub.failures < FAILING_AFTER;
/**
 * The doctor's own findings about reaching you (doctor.ts, its notify.devices line, notices of the heartbeat's): never
 * counted in what waited, since a device turning on is what answers them.
 */
const ABOUT_REACHING_YOU = /^notice:doctor:notify\./;
/**
 * The one that says he can't reach you at all: for your Inbox, never a notification. The node that raises it has no
 * device to tell, and from another node (which can reach you) it would say what isn't so.
 */
const CANT_REACH_YOU = /^doctor:notify\.reach:/;

type Reached = { sub: Subscription; name: string; scopes: string[] };

/**
 * How long a push service keeps a message, and how loudly and how soon it's delivered: an alert a day, an ask at once,
 * a finding as it comes; news quietly (Urgency low: passive on every platform, no sound).
 */
const deliveryFor = (items: readonly NotifyItem[], news: boolean): PushDelivery => {
  if (news) return { ttlSeconds: 12 * 3600, urgency: "low" };
  const alert = items.some((item) => item.alert);
  return { ttlSeconds: alert ? 24 * 3600 : 12 * 3600, urgency: alert || items.some((item) => item.kind === "approval" || item.kind === "question") ? "high" : "normal" };
};

const hlcMs = (hlc: string): number => Number(hlc.split(".")[0]);
/**
 * Whose keys stand for something that can go away and come back: told once while it stands, however long that is. (A
 * connector, a question or a Mac's ask once wasn't, so a connector request standing for days was told again every 49 hours.)
 */
const standsFor = (key: string): boolean => /^(notice|action|secret|connector|question|screen):/.test(key);
/** The asks that are reminded before they lapse. */
const isAsk = (item: NotifyItem): boolean => itemTier(item) === "now" && (item.kind === "approval" || item.kind === "question");

export class NotifyService {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private stopQuests: (() => void) | null = null;
  /** Turns he's watching to their end: how many were watching each at the last look. */
  private readonly turns = new Map<string, { watchers: number }>();
  /** Quests of yours seen in hand, by the quest they belong to. */
  private readonly quests = new Set<string>();
  private keyProblem: string | null = null;
  private tagSalt: string | null = null;
  /** When each device's presence was last written, and from which zone (so every request doesn't write it). */
  private readonly lastSeen = new Map<string, { at: number; zone: string | null }>();
  /** The digest's day it was last said, and since when it counts (push.db settings, read once). */
  private digestState: { saidOn: string | null; since: string | null } | null = null;

  constructor(private readonly o: NotifyOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.stopQuests = this.o.sources.quests.onChange(() => this.lookAtQuests());
    this.poll = setInterval(() => this.lookAtTurns(), TURN_POLL_MS);
    if (this.o.tickMs !== false) this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 15_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.poll) clearInterval(this.poll);
    if (this.soon) clearTimeout(this.soon);
    this.stopQuests?.();
    await this.ticking?.catch(() => {});
    this.o.sender.close?.();
  }

  /** Look again shortly: something just happened that may be worth telling. */
  private nudge(): void {
    if (this.stopped || this.o.tickMs === false || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.tick();
    }, 1500);
  }

  /** This node's own secret for notification tags (notify.ts `tagOf`): random, made once, kept in its private database. */
  private salt(): string {
    if (this.tagSalt) return this.tagSalt;
    let salt = this.o.db.setting("tag-salt");
    if (!salt) {
      salt = randomId(16);
      this.o.db.setSetting("tag-salt", salt);
    }
    return (this.tagSalt = salt);
  }

  /* ---------- what happened: turns that end unwatched, quests you started ---------- */

  /** Called every second: follows each running turn to its end, remembering whether anyone was watching. */
  lookAtTurns(): void {
    for (const turn of this.o.sources.turns.running()) {
      const watchers = this.o.sources.turns.view(turn, false).watchers;
      const known = this.turns.get(turn.id);
      if (known) {
        known.watchers = watchers;
        continue;
      }
      const seen = { watchers };
      this.turns.set(turn.id, seen);
      void turn.ended.then(
        () => this.turnEnded(turn, seen.watchers),
        () => void this.turns.delete(turn.id),
      );
    }
  }

  private turnEnded(turn: LiveTurn, watchers: number): void {
    this.turns.delete(turn.id);
    const chat = turn.spec.conversation;
    // Someone was watching, you stopped it yourself, or it's kept nowhere: nothing to tell.
    if (this.stopped || watchers > 0 || !chat || (turn.state !== "done" && turn.state !== "error")) return;
    const kept = this.o.sources.chats.summary(chat.id);
    if (!kept) return;
    const waits = kept.waits;
    const item = turnItem({ id: turn.id, conversation: chat.id, bank: kept.bank, state: turn.state, question: !!waits?.question, waiting: !!waits && waits.actions.length + waits.secrets.length > 0, look: !!turn.spec.look });
    if (!item) return;
    this.o.db.addPending(item);
    this.nudge();
  }

  /** A quest you run (from a terminal) that was in hand and has ended. With effort: once every attempt has. */
  lookAtQuests(): void {
    if (this.stopped) return;
    // "you" is how the node names a quest run from your terminal or device. A node enrolled under that very name
    // would be named the same, and a quest's goal is shown as your words: with such a node, nothing is told.
    if (this.o.mind.devices().some((d) => d.kind === "node" && d.name === "you")) return;
    const mine = this.o.sources.quests.list().filter((q) => q.by === "you");
    const groups = new Map<string, QuestView[]>();
    for (const quest of mine) {
      const id = quest.attempt?.of ?? quest.quest;
      groups.set(id, [...(groups.get(id) ?? []), quest]);
    }
    for (const [id, quests] of groups) {
      if (!QUEST_ID.test(id)) continue;
      if (quests.some((q) => questInHand(q.state))) {
        this.quests.add(id);
        continue;
      }
      if (!this.quests.delete(id)) continue; // never seen in hand here: old news
      // The best any attempt reached, as the quest's own outcome is.
      const order = ["done", "unverified", "gave-up", "failed", "stopped"];
      const best = [...quests].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0]!;
      const item = questItem({ quest: id, goal: best.goal, state: best.state });
      if (!item) continue;
      this.o.db.addPending(item);
      this.nudge();
    }
  }

  /* ---------- the one door ---------- */

  /** What stands now that may be worth telling, from this node's own records. */
  private standing(now: number): NotifyItem[] {
    const out: (NotifyItem | null)[] = [];
    const safely = <T,>(what: string, read: () => T[]): T[] => {
      try {
        return read();
      } catch (error) {
        this.o.log(`notifications: ${what} not read (${redact(String((error as Error).message)).slice(0, 160)})`);
        return [];
      }
    };
    for (const notice of safely("notices", () => this.o.sources.notices())) if (!CANT_REACH_YOU.test(notice.key)) out.push(noticeItem(notice));
    for (const action of safely("approvals", () => this.o.sources.actions())) out.push(actionItem({ id: action.id, connector: action.connector, tool: action.tool, state: action.state, requestedMs: hlcMs(action.requestedAt), expires: action.expires, ...(action.class ? { class: action.class } : {}) }, now));
    for (const session of safely("screen sessions", () => this.o.sources.screenSessions?.() ?? [])) out.push(screenItem(session, now));
    for (const question of safely("questions", () => this.o.sources.questions?.() ?? [])) out.push(questionItem(question, now));
    for (const name of safely("key requests", () => this.o.sources.secretRequests())) out.push(secretItem(name));
    for (const id of safely("connector requests", () => this.o.sources.connectorRequests())) out.push(connectorItem(id));
    return out.filter((item): item is NotifyItem => item !== null);
  }

  /** One look: what may be told now is told, as one message a device. Never overlaps itself. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = this.look()
      .catch((error) => this.o.log(`notifications: ${redact(String((error as Error).message)).slice(0, 200)}`))
      .finally(() => {
        this.ticking = null;
        if (this.again && !this.stopped) {
          this.again = false;
          void this.tick();
        }
      });
    return this.ticking;
  }

  private async look(): Promise<void> {
    const { db } = this.o;
    const now = this.now();
    const prefs = this.prefs();
    const standing = this.standing(now);
    const standingKeys = new Set(standing.map((item) => item.key));
    const told = db.told();

    // What a told key was about has gone away: it's remembered a while (a finding that flaps tells you once), then forgotten.
    for (const [key, row] of told) {
      if (standsFor(key)) {
        if (standingKeys.has(key)) {
          if (row.goneAt !== null) db.setGone(key, null);
        } else if (row.goneAt === null) {
          db.setGone(key, now);
          this.wentAway(key, now);
        } else if (now - row.goneAt > (key.startsWith("notice:") ? NOTICE_COOLDOWN_MS : 0)) {
          db.forget(key);
          told.delete(key);
        }
      } else if (now - row.at > TOLD_KEEP_MS) {
        db.forget(key);
        told.delete(key);
      }
    }

    // News that couldn't be told in time (quiet hours, its budget) isn't dropped: the digest counts it.
    const waiting = db.pending();
    const stale = waiting.filter((p) => now - p.at > PENDING_KEEP_MS).map((p) => p.item);
    if (stale.length) this.toDigest(stale);
    const items = [...standing, ...waiting.filter((p) => now - p.at <= PENDING_KEEP_MS).map((p) => p.item)];

    const devices = this.devices();
    // Nobody to tell: what stands is told to nobody (it isn't told one by one later: the device that comes back is told
    // what still stands and needs you, once, as one message, and an ask is reminded before it lapses), and news goes to
    // the digest.
    if (!devices.length) {
      const fresh = items.filter((item) => !told.has(item.key));
      if (fresh.length) {
        db.tell(fresh);
        db.asked(fresh.filter(isAsk));
        this.toDigest(fresh.filter((item) => itemTier(item) !== "now"));
      }
      db.dropPending(fresh.map((item) => item.key));
      return;
    }

    const day = notifyDay(now, prefs.quiet.tz);
    await this.catchUp(now, prefs, day, standing, told, devices);
    // (Nothing new, nothing to plan: most looks, which then cost no counting.)
    const untold = items.some((item) => {
      const before = told.get(item.key);
      return !before || (item.alert && !before.alert);
    });
    const plan = untold ? planNotifications({ now, prefs, items, told, sentToday: db.countOn(day), lastSentAt: db.lastSentAt(), newsToday: db.newsOn(day), lastNewsAt: db.lastNewsAt(), modelToday: db.modelOn(day) }) : null;
    if (plan?.digest.length) this.toDigest(plan.digest);
    if (plan?.send.length) await this.deliver(plan.send, devices, day, plan.news);
    else await this.remind(now, prefs, day, standing, devices);
    await this.digest(now, prefs, day, standing, devices);
    // What's told now has reached the day's limit: one message says so, once that day, and not in quiet hours.
    if (limitReached(prefs, db.countOn(day)) && db.setting("limit-said") !== day && !inQuietHours(prefs.quiet, now)) {
      db.setSetting("limit-said", day);
      const said = await Promise.all(devices.map((device) => this.send(device, limitMessage(prefs.perDay), { ttlSeconds: 12 * 3600, urgency: "low" })));
      db.logSent(day, "limit", devices.map((d) => d.name), said.some(Boolean));
    }
  }

  /** Told to the digest, never on its own: remembered as told (once), and counted in the next digest by its topic. */
  private toDigest(items: readonly NotifyItem[]): void {
    const { db } = this.o;
    db.tell(items);
    db.dropPending(items.map((item) => item.key));
    db.toDigest(items.map((item) => ({ key: item.key, topic: item.topic ?? (item.model ? "asked" : item.kind === "finished" ? "chat" : "note") })));
  }

  /**
   * What a told key was about went away (answered, dismissed, cleared, or lapsed): every app takes its notification down
   * where it still shows it, and an ask that lapsed unanswered is counted in the digest (no answer was no).
   */
  private wentAway(key: string, now: number): void {
    const { db } = this.o;
    db.withdraw(tagOf(key, this.salt()));
    const ask = db.ask(key);
    if (!ask) return;
    if (ask.expires !== null && ask.expires <= now) db.toDigest([{ key, topic: "lapsed" }]);
    db.forgetAsk(key);
  }

  /**
   * Reminders (PLAN #59): an ask still unanswered is told again four hours on, and an hour before it lapses (before your
   * night when it lapses in it), twice at most, in fixed words with when no answer means no. Several at once go as one
   * message, a minute after the last, to every device that may see them; at most REMINDERS_PER_DAY a day, a budget of
   * their own, so a reminder never spends what a new ask needs.
   */
  private async remind(now: number, prefs: NotifyPrefs, day: string, standing: readonly NotifyItem[], devices: readonly Reached[]): Promise<void> {
    const { db } = this.o;
    const asks = standing.filter((item) => isAsk(item) && prefs.kinds[item.kind]);
    if (!asks.length || db.remindersOn(day) >= REMINDERS_PER_DAY) return;
    const last = db.lastSentAt();
    if (last !== null && now - last < NOTIFY_GAP_MS) return;
    const told = db.asks();
    const due = asks.filter((item) => {
      const ask = told.get(item.key);
      return ask !== undefined && reminderDue(ask, now, prefs.quiet);
    });
    if (!due.length) return;
    db.reminded(due.map((item) => item.key));
    const salt = this.salt();
    for (const item of due) db.unwithdraw(tagOf(item.key, salt));
    const results = await Promise.all(
      devices.map(async (device) => {
        const mine = due.filter((item) => item.needs.every((scope) => device.scopes.includes(scope)));
        const payload = remindersMessage(mine, now, prefs.quiet.tz, salt);
        if (!payload) return null;
        return { name: device.name, ok: await this.send(device, payload, deliveryFor(mine, false)) };
      }),
    );
    const sent = results.filter((r): r is { name: string; ok: boolean } => r !== null);
    if (sent.length) this.logged(day, "reminder", sent.map((s) => s.name), sent.some((s) => s.ok));
  }

  /**
   * The day's digest (your word, 25 November 2026: at 08:00 in your own time): what went to it instead of buzzing, the
   * knights' tasks that ended and the asks that still wait, in counts and fixed words, once a day, quietly, to the device
   * you used last. Nothing to say, nothing said. It doesn't count against the day's limit.
   */
  private async digest(now: number, prefs: NotifyPrefs, day: string, standing: readonly NotifyItem[], devices: readonly Reached[]): Promise<void> {
    const { db } = this.o;
    // (What it last said and since when: read once, then kept here, where alone they're written.)
    this.digestState ??= { saidOn: db.setting("digest-said"), since: db.setting("digest-at") };
    const state = this.digestState;
    if (state.since === null) {
      // The first look that knows the digest: it counts from now, and the first is said at its next time (never at once,
      // with a day's worth from before it began).
      db.setSetting("digest-at", (state.since = String(now)));
      if (digestDue(prefs, now, state.saidOn)) db.setSetting("digest-said", (state.saidOn = day));
      return;
    }
    if (!digestDue(prefs, now, state.saidOn)) return;
    const since = Number(state.since) || now - 24 * HOUR;
    let tasks = { verified: 0, unverified: 0 };
    try {
      tasks = this.o.sources.tasksEnded?.(since) ?? tasks;
    } catch (error) {
      this.o.log(`notifications: knights' tasks not read for the digest (${redact(String((error as Error).message)).slice(0, 160)})`);
    }
    const payload = digestMessage({ topics: db.digestTopics(), ...tasks, open: standing.filter(isAsk).length }, this.salt());
    db.setSetting("digest-said", (state.saidOn = day));
    db.setSetting("digest-at", (state.since = String(now)));
    db.clearDigest();
    if (!payload) return;
    const to = this.lastUsed(devices);
    const said = await Promise.all(to.map(async (device) => ({ name: device.name, ok: await this.send(device, payload, { ttlSeconds: 12 * 3600, urgency: "low" }) })));
    db.logSent(day, "digest", said.map((s) => s.name), said.some((s) => s.ok));
    this.o.ledger({ class: "outward", resource: "notify", target: "digest", verdict: "approved", reason: "you turned notifications on for these devices", quest: "galahad.self", detail: `to ${said.map((s) => s.name).join(", ")}`.slice(0, 500) });
  }

  /** The device you used last, if you used it within a day and he can reach it: news goes there alone. Otherwise every device. */
  private lastUsed(devices: readonly Reached[]): Reached[] {
    const reachable = new Map(devices.filter((d) => reaches(d.sub)).map((d) => [d.sub.device, d]));
    const now = this.now();
    for (const seen of this.o.db.presence()) {
      if (now - seen.at > LAST_USED_MS) break;
      const device = reachable.get(seen.device);
      if (device) return [device];
    }
    return [...devices];
  }

  /** Your preferences, with your day read in your own zone: the one your devices last said, else the setting's. */
  private prefs(): NotifyPrefs {
    const prefs = this.o.db.prefs();
    return { ...prefs, quiet: { ...prefs.quiet, tz: this.ownerZone(prefs) } };
  }

  /** The zone your day is read in: the one the device you used last said (within a month), else quiet hours' own (the node's until you set one). */
  private ownerZone(prefs: NotifyPrefs = this.o.db.prefs()): string {
    for (const seen of this.o.db.presence()) {
      if (!seen.zone) continue;
      if (this.now() - seen.at > 30 * 24 * HOUR) break;
      if (this.o.mind.activeDevice(seen.device)?.kind === "client") return seen.zone;
    }
    return prefs.quiet.tz;
  }

  /**
   * One of your devices asked the node something, from this zone (a hint, outside what's signed, trusted for nothing
   * else): where you are, for your day, and which device you used last, for news. Written at most once a minute a device.
   */
  seen(device: string, zone: string | null): void {
    const now = this.now();
    const said = zone && isTimeZone(zone) ? zone : null;
    const last = this.lastSeen.get(device);
    if (last && now - last.at < PRESENCE_EVERY_MS && (said === null || said === last.zone)) return;
    this.lastSeen.set(device, { at: now, zone: said ?? last?.zone ?? null });
    try {
      this.o.db.see(device, said);
    } catch (error) {
      this.o.log(`notifications: where you are not kept (${redact(String((error as Error).message)).slice(0, 160)})`);
    }
  }

  /**
   * What waited while nobody could be reached, told once to the device that came back (marked when it turned them on):
   * one message counting what stands and needs you that was told already, to nobody or to a device that couldn't be
   * reached. What was never told isn't in it: that's told as anything new is, to every device, this one too.
   */
  private async catchUp(now: number, prefs: NotifyPrefs, day: string, standing: readonly NotifyItem[], told: ReadonlyMap<string, ToldRow>, devices: readonly Reached[]): Promise<void> {
    const { db } = this.o;
    for (const device of db.catchUps()) {
      const to = devices.find((d) => d.sub.device === device);
      if (!to) {
        db.caughtUp(device); // no longer on: there's no one to tell
        continue;
      }
      const waited = standing.filter((item) => {
        const before = told.get(item.key);
        // (An alert told only as a warning is told again as itself, so it isn't here.)
        return before !== undefined && !(item.alert && !before.alert) && !ABOUT_REACHING_YOU.test(item.key) && item.needs.every((scope) => to.scopes.includes(scope));
      });
      const plan = planCatchUp({ now, prefs, items: waited, sentToday: db.countOn(day), lastSentAt: db.lastSentAt() });
      if (plan.waiting) continue; // quiet hours, the day's limit, or a minute since the last message: a later look
      db.caughtUp(device);
      const payload = catchUpMessage(plan.send, this.salt());
      if (!payload) continue; // nothing waited
      const ok = await this.send(to, payload, deliveryFor(plan.send, false));
      this.logged(day, payload.kind, [to.name], ok);
    }
  }

  /** Whether a device turning on now comes back to nobody he could reach: then it's told what waited. */
  private comesBack(): boolean {
    return !this.devices().some((d) => reaches(d.sub));
  }

  /** The subscribed devices that are still yours: one that was revoked loses its subscription here. */
  private devices(): Reached[] {
    const out: Reached[] = [];
    for (const sub of this.o.db.subscriptions()) {
      const device = this.o.mind.activeDevice(sub.device);
      if (!device || device.kind !== "client") {
        this.o.db.remove(sub.device);
        this.o.log("notifications: a revoked device's subscription was removed");
        continue;
      }
      out.push({ sub, name: device.name, scopes: device.scopes });
    }
    return out;
  }

  /** The devices still yours whose subscriptions were lost: a revoked device's record goes here (it isn't lost, it's gone). */
  private lostDevices(): LostRow[] {
    return this.o.db.lost().filter((row) => {
      const device = this.o.mind.activeDevice(row.device);
      if (device?.kind === "client") return true;
      this.o.db.forgetLost(row.device);
      return false;
    });
  }

  private async send(to: { sub: Subscription; name: string }, payload: NotifyPayload, delivery: PushDelivery): Promise<boolean> {
    const outcome = await this.o.sender.send(to.sub, payload, delivery, this.abort.signal);
    if (outcome.gone) {
      // The push service has forgotten it (the browser rotated or dropped it, the app was removed), and so does the node.
      // It's remembered as lost, not as turned off: you didn't turn it off, so its app may turn it on again, and says why.
      this.o.db.remove(to.sub.device);
      this.o.db.lose(to.sub.device, { service: to.sub.service, why: outcome.error ?? `${to.sub.service}'s push service no longer takes them` });
      this.o.log(`notifications: ${to.name}'s subscription is gone at its push service; removed`);
    } else if (outcome.ok) {
      // Taken at another endpoint than kept (an iPhone's token on Apple's other service): kept there from now on.
      const moved = outcome.endpoint && outcome.endpoint !== to.sub.endpoint ? appleTarget(outcome.endpoint) : null;
      if (moved) {
        this.o.db.move(to.sub.device, outcome.endpoint!, appleService(moved.environment));
        this.o.log(`notifications: ${to.name}'s iPhone answers on Apple's ${moved.environment} service; kept there`);
      }
      this.o.db.mark(to.sub.device, { ok: true });
    }
    else this.o.db.mark(to.sub.device, { ok: false, error: outcome.error ?? "the send failed" });
    return outcome.ok;
  }

  /** One message to each device (news alone: to the device you used last), quietly or not as its tier says. */
  private async deliver(items: NotifyItem[], devices: Reached[], day: string, news: boolean): Promise<void> {
    const { db } = this.o;
    const delivery = deliveryFor(items, news);
    // Told from here on, whatever the push service answers: a failing service is never a reason to try the same news
    // again. (An ask is reminded before it lapses, to whichever device can be reached then.)
    db.tell(items);
    db.asked(items.filter(isAsk));
    db.addModel(day, items.filter((item) => item.model).length);
    db.dropPending(items.map((item) => item.key));
    const salt = this.salt();
    for (const item of items) db.unwithdraw(tagOf(item.key, salt));
    const results = await Promise.all(
      (news ? this.lastUsed(devices) : devices).map(async (device) => {
        // Each device is told what it could see in the app anyway.
        const payload = notifyMessage(items.filter((item) => item.needs.every((scope) => device.scopes.includes(scope))), this.salt());
        if (!payload) return null;
        return { name: device.name, ok: await this.send(device, payload, delivery) };
      }),
    );
    const sent = results.filter((r): r is { name: string; ok: boolean } => r !== null);
    if (!sent.length) return;
    this.logged(day, notifyMessage(items, this.salt())!.kind, sent.map((s) => s.name), sent.some((s) => s.ok));
  }

  /** What was sent, counted against the day; and his own act, in the ledger: what kind and to which devices, never what it said. */
  private logged(day: string, kind: NotifyPayload["kind"] | "reminder", names: string[], ok: boolean): void {
    this.o.db.logSent(day, kind, names, ok);
    this.o.ledger({ class: "outward", resource: "notify", target: kind, verdict: "approved", reason: "you turned notifications on for these devices", quest: "galahad.self", detail: `to ${names.join(", ")}`.slice(0, 500) });
  }

  /* ---------- the owner's own acts: this device on and off, the settings, a test ---------- */

  /** A paired device turns notifications on for itself. The endpoint must be a push service; it's kept as that device's. */
  async subscribe(device: string, input: PushSubscriptionInput): Promise<NotifyDeviceView> {
    const paired = this.o.mind.activeDevice(device);
    if (!paired || paired.kind !== "client") throw new NotifyError(403, "only a paired device turns notifications on, for itself");
    const service = pushService(input.endpoint, this.o.allowed);
    if (!service.ok) throw new NotifyError(400, service.why);
    let point = false;
    try {
      point = isP256Point(fromB64u(input.keys.p256dh)) && fromB64u(input.keys.auth).length === 16;
    } catch {
      point = false;
    }
    if (!point) throw new NotifyError(400, "that isn't a browser's push subscription (its keys don't read as one)");
    // An endpoint is one browser's: another paired device can't take it while that device is still yours.
    const owner = this.o.db.ownerOf(input.endpoint);
    if (owner && owner !== device) {
      if (this.o.mind.activeDevice(owner)) throw new NotifyError(409, "that subscription is another paired device's; turn notifications off there first, or revoke that device");
      this.o.db.remove(owner);
    }
    await this.publicKey();
    const back = this.comesBack();
    const kept = this.o.db.put(device, { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, service: service.service });
    if (back) this.o.db.catchUp(device);
    this.nudge();
    return this.deviceView(kept, paired.name);
  }

  /** The iPhone app turns notifications on, for itself: its Apple push token, kept as that device's (one a device). */
  subscribeApple(device: string, input: ApplePushInput): NotifyDeviceView {
    const paired = this.o.mind.activeDevice(device);
    if (!paired || paired.kind !== "client") throw new NotifyError(403, "only a paired device turns notifications on, for itself");
    const endpoint = appleEndpoint(input.environment, input.token);
    // A token is one app install's: another paired device can't take it while that device is still yours.
    const owner = this.o.db.ownerOf(endpoint);
    if (owner && owner !== device) {
      if (this.o.mind.activeDevice(owner)) throw new NotifyError(409, "that iPhone's token is another paired device's; turn notifications off there first, or revoke that device");
      this.o.db.remove(owner);
    }
    const back = this.comesBack();
    const kept = this.o.db.put(device, { endpoint, p256dh: "", auth: "", service: appleService(input.environment) });
    if (back) this.o.db.catchUp(device);
    this.nudge();
    return this.deviceView(kept, paired.name);
  }

  /**
   * The Android app turns notifications on for itself: nothing is sent anywhere for it; the node keeps what it would
   * have sent, and the app collects it (below). Kept under the device's own id, so no other device can claim it.
   */
  subscribeCollect(device: string): NotifyDeviceView {
    const paired = this.o.mind.activeDevice(device);
    if (!paired || paired.kind !== "client") throw new NotifyError(403, "only a paired device turns notifications on, for itself");
    const back = this.comesBack();
    const kept = this.o.db.put(device, { endpoint: collectEndpoint(device), p256dh: "", auth: "", service: COLLECT_SERVICE });
    if (back) this.o.db.catchUp(device);
    this.nudge();
    return this.deviceView(kept, paired.name);
  }

  /**
   * What the node kept for a device that collects its notifications, handed over once and forgotten. `on` false: its
   * notifications are off (turned off here or elsewhere, or never on), and nothing is kept for it. `withdrawn`, whatever
   * else: the tags of notifications whose matter was answered, dismissed, cleared or lapsed, to take down where it shows them.
   */
  collect(device: string): { on: boolean; notifications: NotifyPayload[]; withdrawn: string[] } {
    const paired = this.o.mind.activeDevice(device);
    if (!paired || paired.kind !== "client") throw new NotifyError(403, "only a paired device collects its notifications, its own");
    const on = this.o.db.subscription(device)?.endpoint === collectEndpoint(device);
    return { on, notifications: on ? this.o.db.collect(device) : [], withdrawn: this.o.db.withdrawn() };
  }

  unsubscribe(device: string): boolean {
    return this.o.db.remove(device);
  }

  /** The zone your day is read in: the one your devices last said, else quiet hours' (the node's own until you set one). */
  zone(): string {
    return this.ownerZone();
  }

  setPrefs(input: NotifyPrefsInput): NotifyPrefs {
    const current = this.o.db.prefs();
    const next: NotifyPrefs = {
      kinds: { ...current.kinds, ...Object.fromEntries(Object.entries(input.kinds ?? {}).filter(([, v]) => v !== undefined)) },
      quiet: { ...current.quiet, ...Object.fromEntries(Object.entries(input.quiet ?? {}).filter(([, v]) => v !== undefined)) },
      perDay: input.perDay ?? current.perDay,
      digest: { ...current.digest, ...Object.fromEntries(Object.entries(input.digest ?? {}).filter(([, v]) => v !== undefined)) },
    };
    this.o.db.setPrefs(next);
    this.nudge();
    return this.o.db.prefs();
  }

  /** A fixed test message, to one device or to all of them. Yours to send; it doesn't count against the day's limit. */
  async test(only?: string): Promise<{ sent: { device: string; ok: boolean; error: string | null }[] }> {
    const now = this.now();
    const devices = this.devices().filter((d) => !only || d.sub.device === only);
    if (!devices.length) throw new NotifyError(409, only ? "notifications aren't turned on for that device" : "no device has notifications turned on (Settings, on each device)");
    const zone = this.ownerZone();
    // Yours to send, but not without end: a page stuck in a loop can't buzz the phone with tests.
    const last = this.o.db.lastTestAt();
    if (last !== null && now - last < TEST_EVERY_MS) throw new NotifyError(429, "a test was just sent; give it a few seconds");
    if (this.o.db.testsOn(notifyDay(now, zone)) >= TESTS_PER_DAY) throw new NotifyError(429, `that's ${TESTS_PER_DAY} tests today; more tomorrow`);
    const sent = await Promise.all(
      devices.map(async (device) => {
        const ok = await this.send(device, testMessage(device.name), { ttlSeconds: 600, urgency: "high" });
        return { device: device.name, ok, error: ok ? null : (this.o.db.subscription(device.sub.device)?.lastError ?? "its subscription was gone, and was removed") };
      }),
    );
    this.o.db.logSent(notifyDay(now, zone), "test", sent.map((s) => s.device), sent.some((s) => s.ok));
    this.o.ledger({ class: "outward", resource: "notify", target: "test", verdict: "approved", reason: "you asked for a test", quest: "galahad.self", detail: `to ${sent.map((s) => s.device).join(", ")}`.slice(0, 500) });
    return { sent };
  }

  /* ---------- what's shown ---------- */

  private async publicKey(): Promise<string> {
    try {
      const key = await this.o.sender.publicKey();
      this.keyProblem = null;
      return key;
    } catch (error) {
      this.keyProblem = redact(String((error as Error).message)).slice(0, 200);
      throw new NotifyError(500, "this node's notification key can't be used; `galahad doctor` says more");
    }
  }

  private deviceView(sub: Subscription, name: string): NotifyDeviceView {
    return { device: sub.device, name, service: sub.service, since: sub.createdAt, lastOk: sub.lastOk, lastError: sub.lastError };
  }

  /** Everything the Settings page and `galahad notify` show. Never an endpoint or a key but this node's public one. */
  async view(asking: string | null): Promise<NotifyView> {
    const { db } = this.o;
    const now = this.now();
    const prefs = db.prefs();
    const zone = this.ownerZone(prefs);
    const day = notifyDay(now, zone);
    const devices = this.devices();
    const quiet = inQuietHours({ ...prefs.quiet, tz: zone }, now);
    const told = db.told();
    const held = quiet ? [...this.standing(now), ...db.pending().map((p) => p.item)].filter((item) => prefs.kinds[item.kind] && !item.alert && itemTier(item) !== "digest" && !told.has(item.key)).length : 0;
    const lostRows = this.lostDevices();
    const lost = asking === null ? null : (lostRows.find((row) => row.device === asking) ?? null);
    return {
      node: this.o.nodeName,
      key: await this.publicKey(),
      zone,
      withdrawn: db.withdrawn(),
      prefs,
      devices: devices.map((d) => this.deviceView(d.sub, d.name)),
      subscribed: asking === null ? null : devices.some((d) => d.sub.device === asking),
      lost: lost ? { at: lost.at, service: lost.service, why: lost.why } : null,
      reachable: devices.filter((d) => reaches(d.sub)).length,
      today: { day, sent: db.sentOn(day), count: db.countOn(day), limit: prefs.perDay },
      quiet,
      held,
    };
  }

  /**
   * For the doctor: whether anyone can be reached, a device whose sends keep failing, how many devices' subscriptions
   * were lost, and how many things wait for your answer (approvals, questions, keys and connectors he needs, of the
   * kinds you have on): with nobody to reach, either is worth a word in your Inbox.
   */
  doctorFacts(): { devices: number; failing: { device: string; error: string }[]; keyProblem: string | null; lost: number; asks: number } {
    const devices = this.devices();
    const prefs = this.o.db.prefs();
    return {
      devices: devices.length,
      failing: devices.filter((d) => !reaches(d.sub) && d.sub.lastError).map((d) => ({ device: d.name, error: d.sub.lastError! })),
      keyProblem: this.keyProblem,
      lost: this.lostDevices().length,
      asks: this.standing(this.now()).filter((item) => (item.kind === "approval" || item.kind === "question") && prefs.kinds[item.kind]).length,
    };
  }
}
