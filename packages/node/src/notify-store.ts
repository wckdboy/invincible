import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync } from "node:fs";
import { type DigestTopic, isTimeZone, type NotifyItem, type NotifyPayload, type NotifyPrefs, readNotifyPrefs } from "@galahad/core";

/*
 * What this node keeps for notifications, in its own private database (push.db, mode
 * 600 in the node's 700 home, never replicated, like chat history):
 *
 *   subscriptions  one per paired device: where its push service takes messages for it,
 *                  and the two keys messages are encrypted to. The endpoint is a
 *                  capability, so it lives here and nowhere else: not in the mind, not
 *                  in a log line, not in any answer a route gives.
 *   settings       what he sends and when he stays silent (kinds, quiet hours, the limit), and
 *                  the devices that came back after nobody could be reached, until each is
 *                  told what waited (`catch-up:<device>`).
 *   told           what was already told, so a finding is told once and not again while
 *                  it stands.
 *   pending        things that happened and wait to be told (a turn that ended at night).
 *   sent           what was sent, by kind and device: never a title or a line.
 *   collect        what's kept for a device that collects its notifications (the Android app,
 *                  collect-send.ts), until it takes them or they expire.
 *   lost           a device whose subscription its push service stopped taking (it was on, and
 *                  you didn't turn it off): when, the service by name and why in words, never
 *                  the endpoint. Cleared when the device turns them on again or off, or is revoked.
 *   presence       when each of your devices last asked the node anything, and the time zone it
 *                  said it was in (a hint, outside what's signed): your day is read in the zone
 *                  your devices say, and news goes to the device you used last.
 *   asks           each ask that was told (an approval, a question, a key or connector he needs):
 *                  when, when it lapses, and the reminders it was given.
 *   digest         what went to the day's digest instead of being told on its own (by key and
 *                  topic, never its words), until the digest says it.
 *   withdrawn      tags of notifications whose matter was answered, dismissed, cleared or lapsed,
 *                  for two days, so each app takes them down where it still shows them.
 *
 * `secure_delete` overwrites what a removed subscription held.
 */

export interface Subscription {
  device: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The push service by name (Apple, Google, …), for what's shown. */
  service: string;
  createdAt: number;
  updatedAt: number;
  lastOk: number | null;
  lastError: string | null;
  failures: number;
}

export interface ToldRow {
  alert: boolean;
  at: number;
  /** When what it was about went away (null: it still stands). */
  goneAt: number | null;
}

export interface SentRow {
  at: number;
  /** What was sent: a payload's kind, or the day's digest, or a reminder. */
  kind: NotifyPayload["kind"] | "digest" | "reminder";
  devices: string[];
  ok: boolean;
}

export interface AskRow {
  toldAt: number;
  /** When it lapses (null: it doesn't). */
  expires: number | null;
  reminded: number;
  lastRemindedAt: number | null;
}

export interface LostRow {
  device: string;
  at: number;
  /** The push service by name, as the subscription was shown. */
  service: string;
  /** In the sender's words: the service by name and what it answered, never the endpoint. */
  why: string;
}

interface SubscriptionRecord {
  device: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  service: string;
  created_at: number;
  updated_at: number;
  last_ok: number | null;
  last_error: string | null;
  failures: number;
}

/** Sends that don't count against the day's limit: your own test, the message that says the limit was reached, the day's
 * digest, and reminders (which have a budget of their own). */
const UNCOUNTED = "('test', 'limit', 'digest', 'reminder')";
/** Messages of news alone (PLAN #59): what's told now never carries a news kind. */
const NEWS = "('finished', 'told')";
const WITHDRAWN_KEEP_MS = 48 * 60 * 60_000;
/** A device's zone is your day's for this long after it last asked the node anything. */
const ZONE_KEEP_MS = 30 * 24 * 60 * 60_000;
const KEEP_SENT_MS = 30 * 24 * 60 * 60_000;
/** At most this many notifications are kept for one device that collects (the day's limit is 50 at most). */
const COLLECT_KEPT = 60;

export class NotifyStore {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
    /** The node's own time zone: quiet hours are read in it until you set one. */
    private readonly zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ) {
    if (path !== ":memory:" && !existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    this.db = new Database(path);
    this.db.exec("PRAGMA secure_delete = ON;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
        device TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, service TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_ok INTEGER, last_error TEXT, failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS told (key TEXT PRIMARY KEY, alert INTEGER NOT NULL, at INTEGER NOT NULL, gone_at INTEGER);
      CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY, item TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, devices TEXT NOT NULL, ok INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sent_by_day ON sent (day, id);
      CREATE TABLE IF NOT EXISTS collect (device TEXT NOT NULL, tag TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (device, tag));
      CREATE TABLE IF NOT EXISTS lost (device TEXT PRIMARY KEY, at INTEGER NOT NULL, service TEXT NOT NULL, why TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presence (device TEXT PRIMARY KEY, at INTEGER NOT NULL, zone TEXT);
      CREATE TABLE IF NOT EXISTS asks (key TEXT PRIMARY KEY, told_at INTEGER NOT NULL, expires INTEGER, reminded INTEGER NOT NULL DEFAULT 0, reminded_at INTEGER);
      CREATE TABLE IF NOT EXISTS digest (key TEXT PRIMARY KEY, topic TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS withdrawn (tag TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  }

  close(): void {
    this.db.close();
  }

  /* ---------- subscriptions ---------- */

  private static view(r: SubscriptionRecord): Subscription {
    return { device: r.device, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, service: r.service, createdAt: r.created_at, updatedAt: r.updated_at, lastOk: r.last_ok, lastError: r.last_error, failures: r.failures };
  }

  subscriptions(): Subscription[] {
    return this.db.query<SubscriptionRecord, []>("SELECT * FROM subscriptions ORDER BY rowid").all().map(NotifyStore.view);
  }

  subscription(device: string): Subscription | null {
    const row = this.db.query<SubscriptionRecord, [string]>("SELECT * FROM subscriptions WHERE device = ?").get(device);
    return row ? NotifyStore.view(row) : null;
  }

  /** The device an endpoint is kept for, if any. */
  ownerOf(endpoint: string): string | null {
    return this.db.query<{ device: string }, [string]>("SELECT device FROM subscriptions WHERE endpoint = ?").get(endpoint)?.device ?? null;
  }

  /** This device's subscription, new or replacing its last one (it keeps the day it was first turned on). A device that
   * was lost is on again. */
  put(device: string, sub: { endpoint: string; p256dh: string; auth: string; service: string }): Subscription {
    const at = this.now();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO subscriptions (device, endpoint, p256dh, auth, service, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (device) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, service = excluded.service,
             updated_at = excluded.updated_at, last_error = NULL, failures = 0`,
        )
        .run(device, sub.endpoint, sub.p256dh, sub.auth, sub.service, at, at);
      this.db.query("DELETE FROM lost WHERE device = ?").run(device);
    })();
    return this.subscription(device)!;
  }

  /** This device's subscription answered at another endpoint than kept (an iPhone's token on Apple's other service): kept
   * there from now on. */
  move(device: string, endpoint: string, service: string): void {
    this.db.query("UPDATE subscriptions SET endpoint = ?, service = ?, updated_at = ? WHERE device = ?").run(endpoint, service, this.now(), device);
  }

  /** This device's subscription goes, and with it what was kept for it, what waited to be caught up, and any record that
   * it was lost (turned off, or revoked, it isn't lost). Whether it had a subscription. */
  remove(device: string): boolean {
    this.db.query("DELETE FROM collect WHERE device = ?").run(device);
    this.forgetLost(device);
    this.caughtUp(device);
    return this.db.query("DELETE FROM subscriptions WHERE device = ?").run(device).changes > 0;
  }

  /* ---------- where you are, and which device you used last ---------- */

  /** This device asked the node something now, from this zone (null: it said none). */
  see(device: string, zone: string | null): void {
    this.db
      .query("INSERT INTO presence (device, at, zone) VALUES (?, ?, ?) ON CONFLICT (device) DO UPDATE SET at = excluded.at, zone = COALESCE(excluded.zone, presence.zone)")
      .run(device, this.now(), zone && isTimeZone(zone) ? zone.slice(0, 64) : null);
  }

  /** When each device last asked the node anything, the most recent first. */
  presence(): { device: string; at: number; zone: string | null }[] {
    return this.db.query<{ device: string; at: number; zone: string | null }, []>("SELECT device, at, zone FROM presence ORDER BY at DESC, device").all();
  }

  /** The zone the device you used last said it was in (within a month), or null. */
  latestZone(): string | null {
    return this.db.query<{ zone: string }, [number]>("SELECT zone FROM presence WHERE zone IS NOT NULL AND at > ? ORDER BY at DESC, device LIMIT 1").get(this.now() - ZONE_KEEP_MS)?.zone ?? null;
  }

  forgetPresence(device: string): void {
    this.db.query("DELETE FROM presence WHERE device = ?").run(device);
  }

  /* ---------- asks that were told, and their reminders ---------- */

  /** These asks were told now (to anyone, or nobody): remembered with when each lapses, once. */
  asked(items: readonly Pick<NotifyItem, "key" | "expires">[]): void {
    const put = this.db.query("INSERT OR IGNORE INTO asks (key, told_at, expires) VALUES (?, ?, ?)");
    const at = this.now();
    this.db.transaction(() => {
      for (const item of items) put.run(item.key, at, item.expires ?? null);
    })();
  }

  ask(key: string): AskRow | null {
    return this.asks().get(key) ?? null;
  }

  /** Every ask that was told and still has a record, by key: read once a look. */
  asks(): Map<string, AskRow> {
    const rows = this.db.query<{ key: string; told_at: number; expires: number | null; reminded: number; reminded_at: number | null }, []>("SELECT key, told_at, expires, reminded, reminded_at FROM asks").all();
    return new Map(rows.map((r) => [r.key, { toldAt: r.told_at, expires: r.expires, reminded: r.reminded, lastRemindedAt: r.reminded_at }]));
  }

  reminded(keys: readonly string[]): void {
    const mark = this.db.query("UPDATE asks SET reminded = reminded + 1, reminded_at = ? WHERE key = ?");
    const at = this.now();
    this.db.transaction(() => {
      for (const key of keys) mark.run(at, key);
    })();
  }

  forgetAsk(key: string): void {
    this.db.query("DELETE FROM asks WHERE key = ?").run(key);
  }

  /* ---------- the day's digest ---------- */

  /** These go to the day's digest (each once, by key and topic: never its words). */
  toDigest(rows: readonly { key: string; topic: DigestTopic }[]): void {
    const put = this.db.query("INSERT OR IGNORE INTO digest (key, topic, at) VALUES (?, ?, ?)");
    const at = this.now();
    this.db.transaction(() => {
      for (const row of rows) put.run(row.key, row.topic, at);
    })();
  }

  /** What waits for the next digest, counted by topic. */
  digestTopics(): Partial<Record<DigestTopic, number>> {
    const out: Partial<Record<DigestTopic, number>> = {};
    for (const row of this.db.query<{ topic: string; n: number }, []>("SELECT topic, COUNT(*) AS n FROM digest GROUP BY topic").all()) out[row.topic as DigestTopic] = row.n;
    return out;
  }

  /** The digest said what waited until now. */
  clearDigest(): void {
    this.db.query("DELETE FROM digest WHERE at <= ?").run(this.now());
  }

  /* ---------- notifications to take down ---------- */

  withdraw(tag: string): void {
    this.db.query("INSERT INTO withdrawn (tag, at) VALUES (?, ?) ON CONFLICT (tag) DO UPDATE SET at = excluded.at").run(tag, this.now());
    this.db.query("DELETE FROM withdrawn WHERE at < ?").run(this.now() - WITHDRAWN_KEEP_MS);
  }

  /** The tags withdrawn in the last two days, the most recent first. */
  withdrawn(): string[] {
    return this.db.query<{ tag: string }, [number]>("SELECT tag FROM withdrawn WHERE at >= ? ORDER BY at DESC, tag LIMIT 200").all(this.now() - WITHDRAWN_KEEP_MS).map((r) => r.tag);
  }

  /** A notification told again (a reminder, a finding come back) is up again: not withdrawn. */
  unwithdraw(tag: string): void {
    this.db.query("DELETE FROM withdrawn WHERE tag = ?").run(tag);
  }

  /* ---------- devices that came back after nobody could be reached ---------- */

  /** This device is to be told what waited, once (a setting, `catch-up:<device>`, holding when it came back). */
  catchUp(device: string): void {
    this.setSetting(`catch-up:${device}`, String(this.now()));
  }

  /** The devices still to be told what waited. */
  catchUps(): string[] {
    return this.db.query<{ k: string }, []>("SELECT k FROM settings WHERE k LIKE 'catch-up:%' ORDER BY k").all().map((r) => r.k.slice("catch-up:".length));
  }

  caughtUp(device: string): void {
    this.db.query("DELETE FROM settings WHERE k = ?").run(`catch-up:${device}`);
  }

  /* ---------- subscriptions their push service dropped ---------- */

  /** This device's subscription was dropped by its push service: remembered as lost, not as turned off. */
  lose(device: string, lost: { service: string; why: string }): void {
    this.db
      .query("INSERT INTO lost (device, at, service, why) VALUES (?, ?, ?, ?) ON CONFLICT (device) DO UPDATE SET at = excluded.at, service = excluded.service, why = excluded.why")
      .run(device, this.now(), lost.service.slice(0, 80), lost.why.slice(0, 200));
  }

  /** The devices whose subscriptions were lost, the most recent first. */
  lost(): LostRow[] {
    return this.db.query<LostRow, []>("SELECT device, at, service, why FROM lost ORDER BY at DESC, device").all();
  }

  forgetLost(device: string): void {
    this.db.query("DELETE FROM lost WHERE device = ?").run(device);
  }

  /** How a send to a device went. */
  mark(device: string, outcome: { ok: true } | { ok: false; error: string }): void {
    if (outcome.ok) this.db.query("UPDATE subscriptions SET last_ok = ?, last_error = NULL, failures = 0 WHERE device = ?").run(this.now(), device);
    else this.db.query("UPDATE subscriptions SET last_error = ?, failures = failures + 1 WHERE device = ?").run(outcome.error.slice(0, 200), device);
  }

  /* ---------- kept for a device that collects ---------- */

  /** Kept for that device until it collects it or `expires`; a newer one about the same thing (its tag) replaces it. At
   * most COLLECT_KEPT a device: the oldest go first. What expired, anyone's, goes now. */
  keepFor(device: string, payload: NotifyPayload, expires: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM collect WHERE expires <= ?").run(this.now());
      this.db
        .query("INSERT INTO collect (device, tag, payload, at, expires) VALUES (?, ?, ?, ?, ?) ON CONFLICT (device, tag) DO UPDATE SET payload = excluded.payload, at = excluded.at, expires = excluded.expires")
        .run(device, payload.tag, JSON.stringify(payload), this.now(), expires);
      this.db.query("DELETE FROM collect WHERE device = ? AND rowid NOT IN (SELECT rowid FROM collect WHERE device = ? ORDER BY at DESC, rowid DESC LIMIT ?)").run(device, device, COLLECT_KEPT);
    })();
  }

  /** What's kept for that device and hasn't expired, the oldest first: handed over once, and forgotten. */
  collect(device: string): NotifyPayload[] {
    return this.db.transaction(() => {
      const rows = this.db.query<{ payload: string }, [string, number]>("SELECT payload FROM collect WHERE device = ? AND expires > ? ORDER BY at, rowid").all(device, this.now());
      this.db.query("DELETE FROM collect WHERE device = ?").run(device);
      return rows.flatMap((r) => {
        try {
          return [JSON.parse(r.payload) as NotifyPayload];
        } catch {
          return [];
        }
      });
    })();
  }

  /* ---------- settings ---------- */

  prefs(): NotifyPrefs {
    const row = this.db.query<{ v: string }, []>("SELECT v FROM settings WHERE k = 'prefs'").get();
    if (!row) return readNotifyPrefs(null, this.zone);
    try {
      return readNotifyPrefs(JSON.parse(row.v), this.zone);
    } catch {
      return readNotifyPrefs(null, this.zone);
    }
  }

  setPrefs(prefs: NotifyPrefs): void {
    this.db.query("INSERT INTO settings (k, v) VALUES ('prefs', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(JSON.stringify(prefs));
  }

  /** A setting of the node's own, by name (null: never set). */
  setting(key: string): string | null {
    return this.db.query<{ v: string }, [string]>("SELECT v FROM settings WHERE k = ?").get(key)?.v ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.query("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  /* ---------- what was told ---------- */

  told(): Map<string, ToldRow> {
    const rows = this.db.query<{ key: string; alert: number; at: number; gone_at: number | null }, []>("SELECT key, alert, at, gone_at FROM told").all();
    return new Map(rows.map((r) => [r.key, { alert: r.alert === 1, at: r.at, goneAt: r.gone_at }]));
  }

  tell(items: readonly Pick<NotifyItem, "key" | "alert">[]): void {
    const at = this.now();
    const put = this.db.query("INSERT INTO told (key, alert, at, gone_at) VALUES (?, ?, ?, NULL) ON CONFLICT (key) DO UPDATE SET alert = MAX(alert, excluded.alert), at = excluded.at, gone_at = NULL");
    this.db.transaction(() => {
      for (const item of items) put.run(item.key, item.alert ? 1 : 0, at);
    })();
  }

  /** What a told key was about has gone away (or is back): its record is kept a while, so a finding that flaps isn't told each time. */
  setGone(key: string, goneAt: number | null): void {
    this.db.query("UPDATE told SET gone_at = ? WHERE key = ?").run(goneAt, key);
  }

  forget(key: string): void {
    this.db.query("DELETE FROM told WHERE key = ?").run(key);
  }

  /* ---------- what waits to be told ---------- */

  pending(): { item: NotifyItem; at: number }[] {
    const out: { item: NotifyItem; at: number }[] = [];
    for (const row of this.db.query<{ item: string; at: number }, []>("SELECT item, at FROM pending ORDER BY at, key").all()) {
      try {
        out.push({ item: JSON.parse(row.item) as NotifyItem, at: row.at });
      } catch {
        /* not an item: left out */
      }
    }
    return out;
  }

  addPending(item: NotifyItem): void {
    this.db.query("INSERT OR REPLACE INTO pending (key, item, at) VALUES (?, ?, ?)").run(item.key, JSON.stringify(item), this.now());
  }

  dropPending(keys: readonly string[]): void {
    const drop = this.db.query("DELETE FROM pending WHERE key = ?");
    this.db.transaction(() => {
      for (const key of keys) drop.run(key);
    })();
  }

  /* ---------- what was sent ---------- */

  logSent(day: string, kind: SentRow["kind"], devices: string[], ok: boolean): void {
    const at = this.now();
    this.db.query("INSERT INTO sent (at, day, kind, devices, ok) VALUES (?, ?, ?, ?, ?)").run(at, day, kind, JSON.stringify(devices), ok ? 1 : 0);
    this.db.query("DELETE FROM sent WHERE at < ?").run(at - KEEP_SENT_MS);
  }

  sentOn(day: string): SentRow[] {
    return this.db
      .query<{ at: number; kind: string; devices: string; ok: number }, [string]>("SELECT at, kind, devices, ok FROM sent WHERE day = ? ORDER BY id")
      .all(day)
      .map((r) => ({ at: r.at, kind: r.kind as SentRow["kind"], devices: JSON.parse(r.devices) as string[], ok: r.ok === 1 }));
  }

  /** How many notifications count against a day's limit so far. */
  countOn(day: string): number {
    return this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sent WHERE day = ? AND kind NOT IN ${UNCOUNTED}`).get(day)!.n;
  }

  /** When the last notification that counts was sent. */
  lastSentAt(): number | null {
    return this.db.query<{ at: number | null }, []>(`SELECT MAX(at) AS at FROM sent WHERE kind NOT IN ${UNCOUNTED}`).get()?.at ?? null;
  }

  /** How many reminder messages were sent on a day. */
  remindersOn(day: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sent WHERE day = ? AND kind = 'reminder'").get(day)!.n;
  }

  /** How many messages of news alone were sent on a day, and when the last went. */
  newsOn(day: string): number {
    return this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sent WHERE day = ? AND kind IN ${NEWS}`).get(day)!.n;
  }

  lastNewsAt(): number | null {
    return this.db.query<{ at: number | null }, []>(`SELECT MAX(at) AS at FROM sent WHERE kind IN ${NEWS}`).get()?.at ?? null;
  }

  /** How many things his own judgment raised were told on a day. */
  modelOn(day: string): number {
    return Number(this.setting(`model-told:${day}`) ?? 0) || 0;
  }

  addModel(day: string, n: number): void {
    if (n <= 0) return;
    const total = this.modelOn(day) + n;
    this.db.query("DELETE FROM settings WHERE k LIKE 'model-told:%' AND k != ?").run(`model-told:${day}`);
    this.setSetting(`model-told:${day}`, String(total));
  }

  /** How many tests were sent on a day. */
  testsOn(day: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sent WHERE day = ? AND kind = 'test'").get(day)!.n;
  }

  /** When the last test was sent to anyone (tests are yours to send, a few seconds apart). */
  lastTestAt(): number | null {
    return this.db.query<{ at: number | null }, []>("SELECT MAX(at) AS at FROM sent WHERE kind = 'test'").get()?.at ?? null;
  }
}
