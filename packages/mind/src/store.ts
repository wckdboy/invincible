import { Database } from "bun:sqlite";
import {
  type BodyOf,
  bodyOf,
  canonical,
  compareEvents,
  type ConnectorManifest,
  decodeHlc,
  type DeviceId,
  type EventKind,
  type GEvent,
  HlcClock,
  isKnownKind,
  isNodeId,
  type Json,
  orderCovers,
  type OrderTerms,
  parseEvent,
  type Prov,
  type Scope,
  SetHash,
  sha256B64u,
  signEvent,
  toolDigest,
  trialProblem,
  type NodeIdentity,
} from "@galahad/core";

/*
 * The Mind's local replica.
 *
 *  events      the signed, append-only log (the only source of truth)
 *  v_*         views materialized from the log (always rebuildable)
 *
 * Materialized state is a pure function of the *set* of events: events are
 * applied in (hlc, id) order, and if an event arrives out of order we replay
 * the log. So any two replicas holding the same events hold identical state,
 * regardless of delivery order or duplication.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, hlc TEXT NOT NULL, device TEXT NOT NULL, kind TEXT NOT NULL, raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_order ON events (hlc, id);
CREATE INDEX IF NOT EXISTS events_device_order ON events (device, hlc, id);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, hlc, id);
CREATE INDEX IF NOT EXISTS events_loop ON events (json_extract(raw, '$.body.loop'), hlc, id) WHERE kind = 'loop.ran';
-- Per device: how many events the log holds, the newest one's hlc and the set hash of their ids.
-- Kept with every insert, in the same transaction, so sync never re-reads the log to compare it.
CREATE TABLE IF NOT EXISTS log_devices (device TEXT PRIMARY KEY, n INTEGER NOT NULL, top TEXT NOT NULL, ids BLOB NOT NULL);
-- Signed events whose signer is not (yet) enrolled: capped, never relayed, promoted on enrollment.
CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, device TEXT NOT NULL, hlc TEXT NOT NULL, raw TEXT NOT NULL, received INTEGER NOT NULL);
`;

/**
 * PRAGMA user_version. 0: a replica from before versions (events, views, pending).
 * 1: log_devices, v_slots and the kind, loop and (device, hlc, id) indexes.
 * 2: companion.named and companion.unnamed (kinds since retired, still folded: core's events.ts). The tables
 *    are the same; a replica that held such events before it knew the kinds applies them once, by a replay.
 * 3: skills (skill.written and the rest; v_skills, v_skill_versions, v_skill_uses), applied the same way
 *    by a replica that held such events before it knew them.
 * 4: your rules (rule.set, rule.removed; in v_lww as rule:<name>), applied the same way by a replica that held
 *    them before it knew them.
 * 5: sessions on a Mac's own screen (screen.asked, screen.decided, screen.ended; in v_lww as screen:<id>,
 *    screen-decision:<id>, screen-ended:<id>), applied the same way by a replica that held them before it knew them.
 * 6: key requests you dismissed (secret.request.dismissed; clears v_lww's secret-request:<name>), applied the same
 *    way by a replica that held them before it knew them.
 */
const SCHEMA_VERSION = 6;

const MAX_PENDING = 2000;

/** Why an event's place in its device's chain is refused (prescan, chainReason). */
const CHAIN = {
  unchained: "unchained event in a chained fleet",
  afterAdoption: "unchained event after the fleet adopted chains",
  gap: "its predecessor is missing (chain gap)",
  early: "dated before its own predecessor",
  fork: "the device forked its own chain (equivocation)",
  revoked: "written after the device was revoked",
  afterInvalid: "follows an invalid event",
} as const;

/** Chain verdicts computed over the whole log before a replay (deterministic). */
interface Validity {
  bad: Map<string, string>;
  /** Devices that forked their own chain, and the first conflicting event. */
  forks: Map<string, { hlc: string; id: string }>;
}

function samePins(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  if (a.size !== b.size) return false;
  for (const [device, set] of a) {
    const other = b.get(device);
    if (!other || other.size !== set.size) return false;
    for (const id of set) if (!other.has(id)) return false;
  }
  return true;
}

const VIEWS = `
CREATE TABLE IF NOT EXISTS v_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS v_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, box TEXT,
  scopes TEXT NOT NULL, enrolled_by TEXT NOT NULL, enrolled_hlc TEXT NOT NULL, revoked_hlc TEXT,
  profile TEXT, profile_hlc TEXT
);
CREATE TABLE IF NOT EXISTS v_memories (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL, device TEXT NOT NULL, via TEXT,
  trust TEXT NOT NULL, hlc TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS v_memories_fts USING fts5 (id UNINDEXED, text, tags);
CREATE TABLE IF NOT EXISTS v_lww (k TEXT PRIMARY KEY, hlc TEXT NOT NULL, eid TEXT NOT NULL, device TEXT NOT NULL, v TEXT);
CREATE TABLE IF NOT EXISTS v_grants (kid TEXT NOT NULL, device TEXT NOT NULL, box TEXT NOT NULL, PRIMARY KEY (kid, device));
CREATE TABLE IF NOT EXISTS v_rejected (id TEXT PRIMARY KEY, reason TEXT NOT NULL);
-- The latest scheduled slot each node has recorded for each loop (accepted runs only).
CREATE TABLE IF NOT EXISTS v_slots (loop TEXT NOT NULL, device TEXT NOT NULL, slot INTEGER NOT NULL, PRIMARY KEY (loop, device));
-- Devices with an event refused for its place in their chain (a gap, a fork, a pin): their next
-- events are judged by a replay, never incrementally.
CREATE TABLE IF NOT EXISTS v_chainbad (device TEXT PRIMARY KEY);
-- Skills (core's skills.ts): each skill with its head and its track record, every version ever written
-- (never deleted), and the quests and answers each was given to. Their marks (locked, retired, stale) are
-- in v_lww as skill-mark:<skill>:<mark>.
CREATE TABLE IF NOT EXISTS v_skills (
  id TEXT PRIMARY KEY, head TEXT NOT NULL, created_hlc TEXT NOT NULL, touched_hlc TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  chats INTEGER NOT NULL DEFAULT 0, used_hlc TEXT
);
CREATE TABLE IF NOT EXISTS v_skill_versions (
  id TEXT PRIMARY KEY, skill TEXT NOT NULL, n INTEGER NOT NULL, prev TEXT, doc TEXT NOT NULL, trust TEXT NOT NULL,
  author TEXT NOT NULL, quest TEXT, via TEXT, source TEXT, hlc TEXT NOT NULL, approved_hlc TEXT
);
CREATE INDEX IF NOT EXISTS v_skill_versions_skill ON v_skill_versions (skill, n);
CREATE TABLE IF NOT EXISTS v_skill_uses (
  skill TEXT NOT NULL, quest TEXT NOT NULL, version TEXT NOT NULL, hlc TEXT NOT NULL, status TEXT, PRIMARY KEY (skill, quest)
);
`;

const VIEW_TABLES = ["v_state", "v_devices", "v_memories", "v_memories_fts", "v_lww", "v_grants", "v_rejected", "v_slots", "v_chainbad", "v_skills", "v_skill_versions", "v_skill_uses"];

/** Who wrote a skill's version, as its event says (core's skills.ts). */
const SKILL_OWNER = "owner";
const SKILL_GALAHAD = "galahad";
/** A use that is a chat answer's, not a quest's: it has no review to pass. */
const SKILL_CHAT = "chat:";

/** What one ingest adds to log_devices, written once at its end. */
interface LogDelta {
  n: number;
  top: string;
  ids: SetHash;
}

export interface Device {
  id: DeviceId;
  name: string;
  kind: "node" | "client";
  role: "full" | "limited" | "client";
  box: string | null;
  scopes: Scope[];
  enrolledBy: DeviceId;
  enrolledHlc: string;
  revokedHlc: string | null;
  profile: { endpoint?: string; caps: Record<string, unknown> } | null;
}

export interface Memory {
  id: string;
  text: string;
  tags: string[];
  device: DeviceId;
  via: string | null;
  trust: string;
  hlc: string;
}

export interface DeviceDigest {
  n: number;
  h: string;
}

export interface IngestResult {
  added: number;
  invalid: { id?: string; error: string }[];
  rebuilt: boolean;
}

export interface LwwEntry<T = Json> {
  key: string;
  hlc: string;
  eid: string;
  device: DeviceId;
  value: T | null;
}

export class MindStore {
  readonly db: Database;
  readonly clock: HlcClock;
  private readonly listeners = new Set<(event: GEvent) => void>();
  private readonly appliedListeners = new Set<(events: readonly GEvent[], rebuilt: boolean) => void>();
  /** Set only during a replay: chain verdicts for every event in the log. */
  private validity: Validity | null = null;
  /**
   * digest(), until the views next change: here (apply and replay are the only writers, and
   * clear it) or on another connection (the CLI's `galahad rebuild` beside the daemon, say),
   * which moves the database's data_version.
   */
  private stateDigest: { version: number; digest: string } | null = null;

  /** Called after each event this node writes (e.g. to push it to peers). */
  onEmit(listener: (event: GEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Called once events have entered the log and the views, and are committed: this node's own and any a peer sent
   * (what shows them, the live stream, looks again). `rebuilt`: the log was replayed, so any view may have changed.
   * A hint, never a record: an event the views refused is among them, and it changes nothing.
   */
  onApplied(listener: (events: readonly GEvent[], rebuilt: boolean) => void): () => void {
    this.appliedListeners.add(listener);
    return () => this.appliedListeners.delete(listener);
  }

  private announce(events: readonly GEvent[], rebuilt: boolean): void {
    for (const listener of this.appliedListeners) {
      try {
        listener(events, rebuilt);
      } catch {
        /* listeners must not break writes */
      }
    }
  }

  constructor(path: string, clock = new HlcClock()) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(SCHEMA);
    this.db.exec(VIEWS);
    this.migrate();
    this.clock = clock;
    // Only accepted events move the clock (a rejected or junk timestamp must not).
    const latest = this.db
      .query<{ hlc: string }, []>(
        "SELECT e.hlc FROM events e LEFT JOIN v_rejected r ON r.id = e.id WHERE r.id IS NULL ORDER BY e.hlc DESC, e.id DESC LIMIT 1",
      )
      .get();
    if (latest) this.safeObserve(latest.hlc);
  }

  close(): void {
    this.db.close();
  }

  /** The schema version this replica is at (see SCHEMA_VERSION). */
  schemaVersion(): number {
    return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  }

  /**
   * Upgrade a replica in place, in one transaction, on its first start with this code. The log
   * doesn't change. The views are replayed from it, so they are what a rebuild (and a replica
   * that joins today) holds: the older code could leave verdicts a replay gives differently (a
   * revoked node's in-order event refused as "signer is not an active device", see SECURITY.md),
   * and every later in-order event would have kept the difference. All in the transaction that
   * sets the version, so a start cut short leaves the replica as the older code left it, at its
   * old version, and the next start migrates it whole.
   */
  private migrate(): void {
    const from = this.schemaVersion();
    this.db.transaction(() => {
      if (from < 1) {
        // (device, hlc, id) serves every query (device, hlc) did, without a sort.
        this.db.exec("DROP INDEX IF EXISTS events_device");
        this.recountLog();
        this.replay();
      } else if (this.loggedCount() !== this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n) {
        // Opened by an older version in between, which wrote events without keeping these, and
        // applied them its own way.
        this.recountLog();
        this.replay();
      } else if (from < 2 && this.db.query("SELECT 1 FROM events WHERE kind IN ('companion.named', 'companion.unnamed') LIMIT 1").get()) {
        // Kept while this replica didn't know the kinds (a newer node wrote them): applied now, as a rebuild would.
        this.replay();
      } else if (from < 3 && this.db.query("SELECT 1 FROM events WHERE kind LIKE 'skill.%' LIMIT 1").get()) {
        // Skills a newer node wrote while this replica didn't know them: applied now, as a rebuild would.
        this.replay();
      } else if (from < 4 && this.db.query("SELECT 1 FROM events WHERE kind IN ('rule.set', 'rule.removed') LIMIT 1").get()) {
        // Rules a newer node wrote while this replica didn't know them: applied now, as a rebuild would.
        this.replay();
      } else if (from < 5 && this.db.query("SELECT 1 FROM events WHERE kind IN ('screen.asked', 'screen.decided', 'screen.ended') LIMIT 1").get()) {
        // Screen sessions a newer node wrote while this replica didn't know them: applied now, as a rebuild would.
        this.replay();
      } else if (from < 6 && this.db.query("SELECT 1 FROM events WHERE kind = 'secret.request.dismissed' LIMIT 1").get()) {
        // Key requests dismissed on a newer node while this replica didn't know the kind: applied now, as a rebuild would.
        this.replay();
      }
      if (from < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  /** log_devices from the log itself (on migration and rebuild). */
  private recountLog(): void {
    this.db.exec("DELETE FROM log_devices");
    const deltas = new Map<string, LogDelta>();
    for (const row of this.db.query<{ id: string; hlc: string; device: string }, []>("SELECT id, hlc, device FROM events").iterate()) {
      this.count(deltas, row);
    }
    this.writeCounts(deltas);
  }

  private count(deltas: Map<string, LogDelta>, event: { id: string; hlc: string; device: string }): void {
    const delta = deltas.get(event.device);
    if (!delta) deltas.set(event.device, { n: 1, top: event.hlc, ids: SetHash.empty().add(event.id) });
    else {
      delta.n += 1;
      if (event.hlc > delta.top) delta.top = event.hlc;
      delta.ids.add(event.id);
    }
  }

  /** Fold one ingest's (or a recount's) additions into log_devices. */
  private writeCounts(deltas: Map<string, LogDelta>): void {
    const read = this.db.query<{ n: number; top: string; ids: Uint8Array }, [string]>("SELECT n, top, ids FROM log_devices WHERE device = ?");
    const write = this.db.query(
      `INSERT INTO log_devices (device, n, top, ids) VALUES (?, ?, ?, ?)
       ON CONFLICT (device) DO UPDATE SET n = excluded.n, top = excluded.top, ids = excluded.ids`,
    );
    for (const [device, delta] of deltas) {
      const row = read.get(device);
      if (!row) {
        write.run(device, delta.n, delta.top, delta.ids.bytes());
        continue;
      }
      const ids = SetHash.from(row.ids);
      ids.merge(delta.ids);
      write.run(device, row.n + delta.n, delta.top > row.top ? delta.top : row.top, ids.bytes());
    }
  }

  private loggedCount(): number {
    return this.db.query<{ n: number | null }, []>("SELECT SUM(n) AS n FROM log_devices").get()!.n ?? 0;
  }

  // ---- fleet identity ------------------------------------------------------

  /** The fleet this replica belongs to (= genesis event id). Set once. */
  get fleet(): string | null {
    return this.meta("fleet");
  }

  expectFleet(fleet: string): void {
    const current = this.fleet;
    if (current && current !== fleet) throw new Error(`replica already belongs to fleet ${current}`);
    this.setMeta("fleet", fleet);
  }

  meta(key: string): string | null {
    return this.db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?").get(key)?.v ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  // ---- writing -------------------------------------------------------------

  /** Create, sign and apply a new event authored by this node. */
  emit<K extends EventKind>(signer: NodeIdentity, kind: K, body: BodyOf<K>, prov?: Prov): GEvent {
    const fleet = kind === "fleet.genesis" ? "" : this.fleet;
    if (fleet === null) throw new Error("replica has no fleet yet");
    const event = signEvent(
      {
        v: 2,
        fleet,
        hlc: this.clock.tick(),
        device: signer.id,
        prev: this.head(signer.id),
        kind,
        body: body as Json,
        ...(prov ? { prov } : {}),
      },
      signer,
    );
    // Atomic: an event this node is not authorized to write never enters the log.
    let rebuilt = false;
    this.db.transaction(() => {
      if (kind === "fleet.genesis") this.expectFleet(event.id);
      const result = this.ingest([event]);
      if (result.invalid.length) throw new Error(`emit rejected: ${result.invalid[0]!.error}`);
      const rejected = this.rejection(event.id);
      if (rejected) throw new Error(`emit not authorized: ${rejected}`);
      rebuilt = result.rebuilt;
    })();
    // (Its ingest, inside that transaction, left this to be said once it was committed.)
    this.announce([event], rebuilt);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listeners must not break writes */
      }
    }
    return event;
  }

  // ---- ingesting -----------------------------------------------------------

  /**
   * Verify and store events from anywhere (sync, push, local emit). Idempotent:
   * duplicates are ignored, out-of-order arrivals trigger a deterministic replay.
   */
  ingest(raws: unknown[]): IngestResult {
    const fleet = this.fleet;
    const invalid: IngestResult["invalid"] = [];
    const fresh: GEvent[] = [];
    // An id is the hash of its event's content: one we already hold (stored or parked) was
    // verified when it arrived, and a copy is never read, so skip its signature check.
    const held = this.db.query<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM events WHERE id = ? UNION ALL SELECT 1 FROM pending WHERE id = ? LIMIT 1",
    );
    for (const raw of raws) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === "string" && held.get(id, id)) continue;
      let event: GEvent;
      try {
        event = parseEvent(raw);
      } catch (error) {
        invalid.push({ id: (raw as { id?: string })?.id, error: String((error as Error).message ?? error) });
        continue;
      }
      const isGenesis = event.kind === "fleet.genesis";
      if (!fleet) {
        invalid.push({ id: event.id, error: "replica has no fleet; set expectFleet first" });
        continue;
      }
      if (isGenesis ? event.id !== fleet || event.fleet !== "" : event.fleet !== fleet) {
        invalid.push({ id: event.id, error: "event belongs to another fleet" });
        continue;
      }
      if (!this.clock.acceptable(event.hlc)) {
        invalid.push({ id: event.id, error: "timestamp too far in the future" });
        continue;
      }
      fresh.push(event);
    }
    if (!fresh.length) return { added: 0, invalid, rebuilt: false };

    let added = 0;
    let rebuilt = false;
    const applied: GEvent[] = [];
    this.db.transaction(() => {
      // Candidates: what just arrived, plus anything still waiting for its signer to be enrolled.
      const seen = new Set<string>();
      let candidates: GEvent[] = [];
      const consider = (event: GEvent) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        candidates.push(event);
      };
      for (const event of fresh) consider(event);
      for (const row of this.db.query<{ raw: string }, []>("SELECT raw FROM pending").all()) consider(JSON.parse(row.raw) as GEvent);

      const insert = this.db.query("INSERT OR IGNORE INTO events (id, hlc, device, kind, raw) VALUES (?, ?, ?, ?, ?)");
      const unpend = this.db.query("DELETE FROM pending WHERE id = ?");
      const counts = new Map<string, LogDelta>();
      // Enrollments inside a batch make more signers known, so admit in rounds.
      for (let round = 0; round < 64 && candidates.length; round++) {
        const ready = candidates.filter((event) => this.knownSigner(event));
        if (!ready.length) break;
        const readyIds = new Set(ready.map((event) => event.id));
        candidates = candidates.filter((event) => !readyIds.has(event.id));
        const inserted: GEvent[] = [];
        for (const event of ready) {
          unpend.run(event.id);
          if (insert.run(event.id, event.hlc, event.device, event.kind, JSON.stringify(event)).changes) {
            inserted.push(event);
            this.count(counts, event);
          }
        }
        if (!inserted.length) continue;
        added += inserted.length;
        applied.push(...inserted);
        inserted.sort(compareEvents);
        let tail = this.appliedTail();
        for (let i = 0; i < inserted.length; i++) {
          const event = inserted[i]!;
          const how = this.placement(event, tail, inserted, i);
          if (how === "replay") {
            this.replay();
            rebuilt = true;
            break;
          }
          this.apply(event, how === "late");
          if (how === "next") tail = event;
        }
      }
      this.writeCounts(counts);

      // Signed but from nobody we know: park it (capped, never relayed) instead of
      // letting arbitrary keys grow every replica's log forever.
      const freshIds = new Set(fresh.map((event) => event.id));
      const park = this.db.query("INSERT OR IGNORE INTO pending (id, device, hlc, raw, received) VALUES (?, ?, ?, ?, ?)");
      for (const event of candidates) if (freshIds.has(event.id)) park.run(event.id, event.device, event.hlc, JSON.stringify(event), Date.now());
      this.db.exec(`DELETE FROM pending WHERE id IN (SELECT id FROM pending ORDER BY received DESC, id LIMIT -1 OFFSET ${MAX_PENDING})`);
    })();
    // Only events that entered the mind and were accepted may move the clock.
    for (const event of applied) if (!this.rejection(event.id)) this.safeObserve(event.hlc);
    // Said once committed: inside another's transaction (emit's), that one says it when it commits.
    if (applied.length && !this.db.inTransaction) this.announce(applied, rebuilt);
    return { added, invalid, rebuilt };
  }

  /** Genesis, the founder's own events, and anything from an enrolled (even since revoked) device. */
  private knownSigner(event: GEvent): boolean {
    if (event.kind === "fleet.genesis") return true;
    const genesis = this.genesis;
    return !!genesis && (genesis.device === event.device || !!this.device(event.device));
  }

  /**
   * How an event that just entered the log is applied. Cheap incremental apply is only
   * sound when nothing can change earlier verdicts: "next" extends the log in order, "late"
   * arrived after newer events but a replay would apply it exactly as we can now (see
   * lateButHarmless), and anything else is replayed.
   */
  private placement(event: GEvent, tail: { hlc: string; id: string } | null, batch: GEvent[], index: number): "next" | "late" | "replay" {
    if (event.kind === "device.revoked" || event.kind === "fleet.chained") return "replay"; // may invalidate history
    if (event.v === 2 && (event.prev ?? null) !== this.head(event.device)) return "replay"; // gap or fork
    // A refused sibling, a waiting gap or a pinned head: only the whole log can tell what this one is.
    if (this.db.query("SELECT 1 FROM v_chainbad WHERE device = ? UNION ALL SELECT 1 FROM v_devices WHERE id = ? AND revoked_hlc IS NOT NULL LIMIT 1").get(event.device, event.device)) {
      return "replay";
    }
    if (!tail || compareEvents(event, tail) > 0) return "next";
    return this.lateButHarmless(event, batch, index) ? "late" : "replay";
  }

  /**
   * Out of order, yet nothing a replay would decide differently. Most late arrivals are a
   * busy node's ledger entries, and replaying the whole log for each is what stalled sync.
   * It holds only when every one of these does:
   *  - a ledger entry or a loop run: no other event's verdict reads them (a loop run only
   *    raises its loop's latest slot, a maximum);
   *  - chained, after its parent (the device's head), and after every event of its device we
   *    hold, apart from this batch's later ones, which are checked in their turn (a fork, gap
   *    or pinned head among them replays everything anyway);
   *  - from a device whose chain has no refused event, so no fork, gap or pin (placement);
   *  - signed by a node enrolled strictly before it and never revoked, so it was allowed to
   *    write at that moment whatever the order.
   */
  private lateButHarmless(event: GEvent, batch: GEvent[], index: number): boolean {
    if (event.v !== 2 || (event.kind !== "ledger.recorded" && event.kind !== "loop.ran")) return false;
    const signer = this.device(event.device);
    if (!signer || signer.kind !== "node" || signer.revokedHlc || !(signer.enrolledHlc < event.hlc)) return false;
    if (event.prev) {
      const parent = this.db.query<{ hlc: string }, [string]>("SELECT hlc FROM events WHERE id = ?").get(event.prev);
      if (!parent || compareEvents(event, { hlc: parent.hlc, id: event.prev }) <= 0) return false;
    }
    const newer = this.db
      // A row value, so the (device, hlc, id) index serves it: an OR here reads the device's whole log.
      .query<{ n: number }, [string, string, string]>("SELECT COUNT(*) AS n FROM events WHERE device = ? AND (hlc, id) > (?, ?)")
      .get(event.device, event.hlc, event.id)!.n;
    let coming = 0;
    for (let i = index + 1; i < batch.length; i++) if (batch[i]!.device === event.device) coming++;
    return newer === coming;
  }

  pendingCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pending").get()!.n;
  }

  /** The newest event of this device's chain (what its next event must point at). */
  head(device: string): string | null {
    return this.state<string>(`head:${device}`);
  }

  /** Drop every view and re-materialize from the log, and recount it. Same events ⇒ same state. */
  rebuild(): void {
    this.db.transaction(() => {
      this.recountLog();
      this.replay();
    })();
  }

  /**
   * Replay to a fixpoint: chain verdicts depend on which revocations are valid, and
   * revocation validity depends on the replayed state. In practice: one pass without
   * revocations, two with.
   */
  private replay(): void {
    this.stateDigest = null;
    const events = this.db
      .query<{ raw: string }, []>("SELECT raw FROM events ORDER BY hlc, id")
      .all()
      .map((row) => JSON.parse(row.raw) as GEvent);
    let pins = new Map<string, Set<string>>();
    for (let pass = 0; pass < 5; pass++) {
      for (const table of VIEW_TABLES) this.db.exec(`DELETE FROM ${table}`);
      this.validity = this.prescan(events, pins);
      // Persist fork verdicts so the incremental path refuses a compromised device too.
      for (const [device, at] of this.validity.forks) this.setState(`fork:${device}`, at);
      try {
        for (const event of events) this.apply(event);
      } finally {
        this.validity = null;
      }
      const next = this.revocationPins(events);
      if (samePins(pins, next)) return;
      pins = next;
    }
  }

  /** Chain verdicts over the whole log: legacy allowlist, gaps, equivocation, revocation pins. */
  private prescan(events: GEvent[], pins: Map<string, Set<string>>): Validity {
    const bad = new Map<string, string>();
    const genesis = events.find((event) => event.kind === "fleet.genesis");
    const chained = genesis?.v === 2;
    let legacy: Set<string> | null = null;
    if (genesis && !chained) {
      const adoption = events.find((event) => event.kind === "fleet.chained" && event.device === genesis.device);
      if (adoption) legacy = new Set((adoption.body as { legacy: string[] }).legacy);
    }
    for (const event of events) {
      if (event.v !== 1) continue;
      if (chained) bad.set(event.id, CHAIN.unchained);
      else if (legacy && !legacy.has(event.id)) bad.set(event.id, CHAIN.afterAdoption);
    }

    const forks = new Map<string, { hlc: string; id: string }>();
    const byDevice = new Map<string, GEvent[]>();
    for (const event of events) {
      if (event.v !== 2) continue;
      const list = byDevice.get(event.device) ?? [];
      list.push(event);
      byDevice.set(event.device, list);
    }
    for (const [device, list] of byDevice) {
      const byId = new Map(list.map((event) => [event.id, event]));
      const ids = new Set(byId.keys());
      const children = new Map<string, GEvent[]>();
      for (const event of list) {
        const key = event.prev ?? "∅";
        children.set(key, [...(children.get(key) ?? []), event]);
      }
      // Equivocation: two events claiming the same predecessor (or two "first" events).
      let forkAt: GEvent | null = null;
      for (const siblings of children.values()) {
        if (siblings.length < 2) continue;
        const first = [...siblings].sort(compareEvents)[0]!;
        if (!forkAt || compareEvents(first, forkAt) < 0) forkAt = first;
      }
      if (forkAt) forks.set(device, { hlc: forkAt.hlc, id: forkAt.id });
      const allowed = pins.get(device);
      for (const event of list) {
        const parent = event.prev ? byId.get(event.prev) : undefined;
        if (event.prev && !ids.has(event.prev)) bad.set(event.id, CHAIN.gap);
        else if (parent && compareEvents(event, parent) <= 0) bad.set(event.id, CHAIN.early);
        else if (forkAt && compareEvents(event, forkAt) >= 0) bad.set(event.id, CHAIN.fork);
        else if (allowed && !allowed.has(event.id)) bad.set(event.id, CHAIN.revoked);
        else if (event.prev && bad.has(event.prev)) bad.set(event.id, CHAIN.afterInvalid);
      }
    }
    return { bad, forks };
  }

  /** From the replayed state: each validly revoked device may keep only the ancestors of its pinned head. */
  private revocationPins(events: GEvent[]): Map<string, Set<string>> {
    const pins = new Map<string, Set<string>>();
    if (!events.some((event) => event.kind === "device.revoked")) return pins;
    const byId = new Map(events.map((event) => [event.id, event]));
    for (const event of events) {
      if (event.kind !== "device.revoked" || this.rejection(event.id)) continue;
      const body = event.body as { device: string; head?: string | null };
      if (body.head === undefined || pins.has(body.device)) continue;
      const allowed = new Set<string>();
      let cursor = body.head ? byId.get(body.head) : undefined;
      while (cursor && cursor.device === body.device && cursor.v === 2 && !allowed.has(cursor.id)) {
        allowed.add(cursor.id);
        cursor = cursor.prev ? byId.get(cursor.prev) : undefined;
      }
      pins.set(body.device, allowed);
    }
    return pins;
  }

  private appliedTail(): { hlc: string; id: string } | null {
    const raw = this.db.query<{ v: string }, []>("SELECT v FROM v_state WHERE k = 'tail'").get()?.v;
    return raw ? (JSON.parse(raw) as { hlc: string; id: string }) : null;
  }

  private setState(key: string, value: Json): void {
    this.db
      .query("INSERT INTO v_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
      .run(key, JSON.stringify(value));
  }

  private state<T>(key: string): T | null {
    const raw = this.db.query<{ v: string }, [string]>("SELECT v FROM v_state WHERE k = ?").get(key)?.v;
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private safeObserve(hlc: string): void {
    try {
      this.clock.observe(hlc);
    } catch {
      /* far-future timestamps were already rejected at ingest */
    }
  }

  // ---- materialization (pure, deterministic) -------------------------------

  /** `late`: applied after newer events (see lateButHarmless), so the tail stays the newest. */
  private apply(event: GEvent, late = false): void {
    this.stateDigest = null;
    if (!late) this.setState("tail", { hlc: event.hlc, id: event.id });
    let reason = this.chainReason(event);
    // Only a v2 event's chain verdict marks its device. A refused unchained (v1) event is in no
    // chain: a v2 event naming it as its predecessor is a gap, so it changes nothing a replay
    // would decide about the device's later events.
    if (reason && event.v === 2) this.db.query("INSERT OR IGNORE INTO v_chainbad (device) VALUES (?)").run(event.device);
    // A chain-valid event advances its device's head even if it is later refused as unauthorized:
    // the chain records what the device *signed*, authorization what it was *allowed* to do.
    if (!reason && event.v === 2) this.setState(`head:${event.device}`, event.id);
    if (!reason) reason = this.applyKind(event);
    if (reason) this.db.query("INSERT OR REPLACE INTO v_rejected (id, reason) VALUES (?, ?)").run(event.id, reason);
  }

  private chainReason(event: GEvent): string | null {
    if (this.validity) return this.validity.bad.get(event.id) ?? null;
    // Incremental path (placement guarantees v2 events extend their device's head).
    if (event.v === 2) {
      const fork = this.state<{ hlc: string; id: string }>(`fork:${event.device}`);
      return fork && compareEvents(event, fork) >= 0 ? CHAIN.fork : null;
    }
    const genesis = this.genesis;
    if (genesis?.v === 2) return CHAIN.unchained;
    const legacy = this.state<string[]>("legacy");
    if (legacy && !legacy.includes(event.id)) return CHAIN.afterAdoption;
    return null;
  }

  /** Returns a rejection reason, or null when applied. */
  private applyKind(event: GEvent): string | null {
    if (!isKnownKind(event.kind)) return null; // stored for forward compatibility; newer nodes understand it
    const signer = this.deviceAt(event.device, event.hlc);
    const genesis = this.state<{ id: string; device: string; name: string; v?: number }>("genesis");

    if (event.kind === "fleet.genesis") {
      if (genesis) return "fleet already has a genesis";
      const body = bodyOf(event, "fleet.genesis");
      this.setState("genesis", { id: event.id, device: event.device, name: body.name, v: event.v });
      return null;
    }
    if (!genesis) return "no genesis yet";

    if (event.kind === "device.enrolled") {
      const body = bodyOf(event, "device.enrolled");
      const bootstrap = event.device === genesis.device && body.device === event.device && !this.anyDevices();
      if (!bootstrap && !isFullNode(signer)) return "only an active full node may enroll devices";
      if (this.device(body.device)) return "device already enrolled";
      if (body.kind === "node" && (!isNodeId(body.device) || !body.box)) return "nodes need an ed25519 id and a box key";
      if (body.kind === "client" && body.role !== "client") return "clients must have the client role";
      this.db
        .query(
          `INSERT INTO v_devices (id, name, kind, role, box, scopes, enrolled_by, enrolled_hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(body.device, body.name, body.kind, body.role, body.box ?? null, JSON.stringify(body.scopes), event.device, event.hlc);
      return null;
    }

    // Everything below requires an enrolled, not-revoked signer.
    if (!signer) return "signer is not an active device";

    switch (event.kind) {
      case "fleet.chained": {
        if (event.device !== genesis.device) return "only the founding node adopts chains";
        if (genesis.v === 2) return "this fleet has been chained since its founding";
        if (this.state("legacy")) return "chains were already adopted";
        this.setState("legacy", bodyOf(event, "fleet.chained").legacy);
        return null;
      }
      case "device.revoked": {
        if (!isFullNode(signer)) return "only full nodes may revoke";
        const body = bodyOf(event, "device.revoked");
        const target = this.device(body.device);
        if (!target || target.revokedHlc) return "unknown or already revoked device";
        const remainingFull = this.devices().filter((d) => isFullNode(d) && d.id !== target.id).length;
        if (isFullNode(target) && remainingFull === 0) return "refusing to revoke the last full node";
        this.db.query("UPDATE v_devices SET revoked_hlc = ? WHERE id = ?").run(event.hlc, body.device);
        return null;
      }
      case "device.scoped": {
        if (!isFullNode(signer)) return "only full nodes may change a device's scopes";
        const body = bodyOf(event, "device.scoped");
        const target = this.device(body.device);
        if (!target || target.revokedHlc) return "unknown or revoked device";
        if (target.kind !== "client") return "nodes are always owner-equivalent";
        this.db.query("UPDATE v_devices SET scopes = ? WHERE id = ?").run(JSON.stringify([...new Set(body.scopes)]), body.device);
        return null;
      }
      case "node.profile": {
        const body = bodyOf(event, "node.profile");
        const previous = this.profileHlc(event.device);
        if (previous && previous >= event.hlc) return null;
        this.db
          .query("UPDATE v_devices SET profile = ?, profile_hlc = ? WHERE id = ?")
          .run(canonical(body), event.hlc, event.device);
        return null;
      }
      case "vault.key": {
        if (!isFullNode(signer)) return "only full nodes may create vault keys";
        const body = bodyOf(event, "vault.key");
        for (const [device, box] of Object.entries(body.grants)) {
          if (isFullNode(this.deviceAt(device, event.hlc))) this.putGrant(body.kid, device, box);
        }
        this.putLww("vault:current", event, { kid: body.kid });
        return null;
      }
      case "vault.grant": {
        if (!isFullNode(signer)) return "only full nodes may grant vault keys";
        const body = bodyOf(event, "vault.grant");
        if (!isFullNode(this.deviceAt(body.device, event.hlc))) return "grants go to active full nodes only";
        this.putGrant(body.kid, body.device, body.box);
        return null;
      }
      case "secret.set": {
        if (!isFullNode(signer)) return "only full nodes may write secrets";
        const body = bodyOf(event, "secret.set");
        this.putLww(`secret:${body.name}`, event, body as Json);
        return null;
      }
      case "secret.deleted": {
        if (!isFullNode(signer)) return "only full nodes may delete secrets";
        this.putLww(`secret:${bodyOf(event, "secret.deleted").name}`, event, null);
        return null;
      }
      case "secret.requested": {
        const body = bodyOf(event, "secret.requested");
        this.putLww(`secret-request:${body.name}`, event, body as Json);
        return null;
      }
      case "secret.request.dismissed": {
        // Yours (its route needs vault:write, which agents never hold). The newer of an ask and a dismissal stands, in
        // any order: asked again after, it's open again.
        this.putLww(`secret-request:${bodyOf(event, "secret.request.dismissed").name}`, event, null);
        return null;
      }
      case "provider.set": {
        if (!isFullNode(signer)) return "only full nodes may configure providers";
        const body = bodyOf(event, "provider.set");
        this.putLww(`provider:${body.id}`, event, body as Json);
        return null;
      }
      case "provider.removed": {
        if (!isFullNode(signer)) return "only full nodes may configure providers";
        this.putLww(`provider:${bodyOf(event, "provider.removed").id}`, event, null);
        return null;
      }
      case "roster.set": {
        if (!isFullNode(signer)) return "only full nodes may change the roster";
        const body = bodyOf(event, "roster.set");
        this.putLww(`roster:${body.role}`, event, body.models);
        return null;
      }
      case "roster.effort": {
        if (!isFullNode(signer)) return "only full nodes may change the roster";
        const body = bodyOf(event, "roster.effort");
        this.putLww(`effort:${body.role}`, event, body.effort);
        return null;
      }
      case "memory.added": {
        const body = bodyOf(event, "memory.added");
        const tags = body.tags ?? [];
        const trust = event.prov?.trust ?? "agent";
        this.db
          .query(
            "INSERT OR IGNORE INTO v_memories (id, text, tags, device, via, trust, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(event.id, body.text, JSON.stringify(tags), event.device, event.prov?.via ?? null, trust, event.hlc);
        this.db.query("INSERT INTO v_memories_fts (id, text, tags) VALUES (?, ?, ?)").run(event.id, body.text, tags.join(" "));
        return null;
      }
      case "memory.forgotten": {
        const { memory } = bodyOf(event, "memory.forgotten");
        this.db.query("UPDATE v_memories SET forgotten = 1 WHERE id = ?").run(memory);
        this.db.query("DELETE FROM v_memories_fts WHERE id = ?").run(memory);
        return null;
      }
      case "loop.set": {
        if (!isFullNode(signer)) return "only full nodes may define loops";
        const body = bodyOf(event, "loop.set");
        if (!isFullNode(this.deviceAt(body.on, event.hlc))) return "a loop runs on an active full node";
        this.putLww(`loop:${body.name}`, event, body as Json);
        return null;
      }
      case "loop.removed": {
        if (!isFullNode(signer)) return "only full nodes may remove loops";
        this.putLww(`loop:${bodyOf(event, "loop.removed").name}`, event, null);
        return null;
      }
      case "loop.wakes": {
        // Its own key, written only by this kind: a mind that never woke a loop keeps the digest it had.
        if (!isFullNode(signer)) return "only full nodes may set what wakes a loop";
        const body = bodyOf(event, "loop.wakes");
        this.putLww(`loopwake:${body.name}`, event, body.wakes.length ? (body as Json) : null);
        return null;
      }
      case "loop.ran": {
        // A record of what that node did, read straight from the log (see loopRuns); only its latest slot is kept here.
        if (signer.kind !== "node") return "only nodes run loops";
        const { loop, slot } = bodyOf(event, "loop.ran");
        if (slot !== null) {
          this.db
            .query("INSERT INTO v_slots (loop, device, slot) VALUES (?, ?, ?) ON CONFLICT (loop, device) DO UPDATE SET slot = MAX(slot, excluded.slot)")
            .run(loop, event.device, slot);
        }
        return null;
      }
      case "notice.raised": {
        const body = bodyOf(event, "notice.raised");
        this.putLww(`notice:${body.key}`, event, { ...body, dismissed: false } as Json);
        return null;
      }
      case "notice.cleared": {
        this.putLww(`notice:${bodyOf(event, "notice.cleared").key}`, event, null);
        return null;
      }
      case "notice.dismissed": {
        const { key } = bodyOf(event, "notice.dismissed");
        const current = this.lww<Record<string, Json>>(`notice:${key}`);
        if (!current?.value) return "no such notice";
        this.putLww(`notice:${key}`, event, { ...current.value, dismissed: true });
        return null;
      }
      case "connector.set": {
        if (!isFullNode(signer)) return "only full nodes may install connectors";
        const body = bodyOf(event, "connector.set");
        this.putLww(`connector:${body.id}`, event, body.manifest as Json);
        return null;
      }
      case "connector.removed": {
        if (!isFullNode(signer)) return "only full nodes may remove connectors";
        this.putLww(`connector:${bodyOf(event, "connector.removed").id}`, event, null);
        return null;
      }
      case "project.set": {
        if (!isFullNode(signer)) return "only full nodes may set projects";
        const body = bodyOf(event, "project.set");
        this.putLww(`project:${body.id}`, event, body as Json);
        return null;
      }
      case "project.removed": {
        if (!isFullNode(signer)) return "only full nodes may remove projects";
        this.putLww(`project:${bodyOf(event, "project.removed").id}`, event, null);
        return null;
      }
      case "action.requested": {
        if (!isFullNode(signer)) return "only full nodes may file actions";
        const body = bodyOf(event, "action.requested");
        if (this.lww(`action:${body.id}`)) return "action already filed";
        this.putLww(`action:${body.id}`, event, body as Json);
        return null;
      }
      case "action.decided": {
        if (!isFullNode(signer)) return "only full nodes may record decisions";
        const body = bodyOf(event, "action.decided");
        if (!this.lww(`action:${body.id}`)) return "no such action";
        // The first decision stands: an approval can't be flipped after the fact, nor a refusal.
        if (this.lww(`action-decision:${body.id}`)) return "action already decided";
        // One recorded as an agent's, not yours, is Galahad's own approval (oath.ts ownApproval): it says so where it shows.
        this.putLww(`action-decision:${body.id}`, event, { ...body, ...(event.prov?.via ? { via: event.prov.via } : {}), ...(event.prov?.trust === "agent" ? { self: true } : {}) } as Json);
        return null;
      }
      case "action.done": {
        const body = bodyOf(event, "action.done");
        const request = this.lww(`action:${body.id}`);
        if (!request) return "no such action";
        if (request.device !== event.device) return "only the node that filed an action completes it";
        if (this.lww<{ verdict: string }>(`action-decision:${body.id}`)?.value?.verdict !== "approved") return "action was not approved";
        if (this.lww(`action-done:${body.id}`)) return "action already done";
        this.putLww(`action-done:${body.id}`, event, body as Json);
        return null;
      }
      case "investigation.registered": {
        if (!isFullNode(signer)) return "only full nodes run investigations";
        const body = bodyOf(event, "investigation.registered");
        if (this.lww(`investigation:${body.id}`)) return "already registered";
        // What was promised before anything ran must be what's stored.
        if (sha256B64u(canonical(body.registration as Json)) !== body.digest) return "the registration doesn't match its digest";
        this.putLww(`investigation:${body.id}`, event, body as Json);
        return null;
      }
      case "investigation.concluded": {
        const body = bodyOf(event, "investigation.concluded");
        const registered = this.lww(`investigation:${body.id}`);
        if (!registered?.value) return "no such investigation";
        if (registered.device !== event.device) return "only the node that ran an investigation concludes it";
        if (this.lww(`investigation-result:${body.id}`)) return "already concluded";
        this.putLww(`investigation-result:${body.id}`, event, body as Json);
        return null;
      }
      case "trial.scored": {
        if (!isFullNode(signer)) return "only full nodes run trials";
        const body = bodyOf(event, "trial.scored");
        if (this.lww(`trial:${body.id}`)) return "trial already recorded";
        // The verdicts and the score must follow from the numbers: nobody inflates a mark.
        const problem = trialProblem(body);
        if (problem) return problem;
        this.putLww(`trial:${body.id}`, event, body as Json);
        return null;
      }
      case "trial.run": {
        if (!isFullNode(signer)) return "only full nodes run trials";
        const body = bodyOf(event, "trial.run");
        if (this.lww(`trial-run:${body.run}`)) return "run already recorded";
        this.putLww(`trial-run:${body.run}`, event, body as Json);
        return null;
      }
      case "trial.spent": {
        // What a trial's model calls came to: once, by the node that recorded the trial (which is in the log before this).
        const body = bodyOf(event, "trial.spent");
        const trial = this.lww(`trial:${body.trial}`);
        if (!trial?.value) return "no such trial";
        if (trial.device !== event.device) return "only the node that ran a trial records what it spent";
        if (this.lww(`trial-spent:${body.trial}`)) return "already recorded";
        this.putLww(`trial-spent:${body.trial}`, event, body.spent as Json);
        return null;
      }
      case "price.set": {
        if (!isFullNode(signer)) return "only full nodes may state prices";
        const body = bodyOf(event, "price.set");
        this.putLww(`price:${body.model}`, event, body.price as Json);
        return null;
      }
      case "price.removed": {
        if (!isFullNode(signer)) return "only full nodes may state prices";
        this.putLww(`price:${bodyOf(event, "price.removed").model}`, event, null);
        return null;
      }
      case "model.checked": {
        // A model is checked by a full node, which holds the keys to ask it; the latest check stands everywhere.
        if (!isFullNode(signer)) return "only full nodes check models";
        const body = bodyOf(event, "model.checked");
        this.putLww(`modelcheck:${body.model}`, event, body.check as Json);
        return null;
      }
      case "compute.calibrated": {
        // A node measures itself: whose calibration it is, is who signed it. Its latest stands.
        if (signer.kind !== "node") return "only nodes calibrate";
        this.putLww(`calibration:${event.device}`, event, bodyOf(event, "compute.calibrated").measured as Json);
        return null;
      }
      case "compute.limit": {
        if (!isFullNode(signer)) return "only full nodes may set a ceiling";
        const body = bodyOf(event, "compute.limit");
        if (this.deviceAt(body.node, event.hlc)?.kind !== "node") return "a ceiling is for an active node";
        this.putLww(`compute-limit:${body.node}`, event, body.limit as Json);
        return null;
      }
      case "compute.policy": {
        if (!isFullNode(signer)) return "only full nodes may set the compute policy";
        this.putLww("compute-policy", event, bodyOf(event, "compute.policy").policy as Json);
        return null;
      }
      case "compute.adapted": {
        if (!isFullNode(signer)) return "only full nodes record a compute plan";
        this.putLww("compute-plan", event, bodyOf(event, "compute.adapted") as Json);
        return null;
      }
      case "artifact.saved": {
        if (!isFullNode(signer)) return "only full nodes keep artifacts";
        const body = bodyOf(event, "artifact.saved");
        if (this.lww(`artifact:${body.id}`)) return "artifact already recorded";
        this.putLww(`artifact:${body.id}`, event, body as Json);
        return null;
      }
      case "artifact.removed": {
        const { id } = bodyOf(event, "artifact.removed");
        const current = this.lww(`artifact:${id}`);
        if (!current?.value) return "no such artifact";
        // The node holding the files says when they're gone; nobody else can declare them gone.
        if (current.device !== event.device) return "only the node holding an artifact removes it";
        this.putLww(`artifact:${id}`, event, null);
        return null;
      }
      case "order.set": {
        if (!isFullNode(signer)) return "only full nodes may record standing orders";
        const body = bodyOf(event, "order.set");
        // Orders never change: what you signed is what applies. Revoke and sign a new one instead.
        if (this.lww(`order:${body.id}`)) return "order already exists";
        this.putLww(`order:${body.id}`, event, { ...body, revoked: false, signedHlc: event.hlc, ...(event.prov?.via ? { via: event.prov.via } : {}) } as Json);
        return null;
      }
      case "order.revoked": {
        if (!isFullNode(signer)) return "only full nodes may revoke standing orders";
        const { id } = bodyOf(event, "order.revoked");
        const current = this.lww<Record<string, Json>>(`order:${id}`);
        if (!current?.value) return "no such order";
        if (current.value.revoked) return "order already revoked";
        this.putLww(`order:${id}`, event, { ...current.value, revoked: true });
        return null;
      }
      case "order.applied": {
        const body = bodyOf(event, "order.applied");
        const request = this.lww<BodyOf<"action.requested">>(`action:${body.action}`);
        if (!request?.value) return "no such action";
        if (request.device !== event.device) return "only the node that filed an action applies an order to it";
        if (this.lww(`action-decision:${body.action}`)) return "action already decided";
        const order = this.lww<OrderTerms & { id: string; revoked: boolean }>(`order:${body.order}`)?.value;
        if (!order) return "no such order";
        if (order.revoked) return "order was revoked";
        // Replayed in log order, the connector view here is the manifest as it stood when the order was applied.
        const manifest = this.lww<Pick<ConnectorManifest, "origin" | "basePath" | "tools">>(`connector:${request.value.connector}`)?.value;
        const digest = manifest && typeof manifest === "object" && manifest.tools ? toolDigest(manifest, request.value.tool) : null;
        const covered = orderCovers(order, { ...request.value, digest }, decodeHlc(event.hlc).ms);
        if (!covered) return "the order doesn't cover this action";
        this.putLww(`action-decision:${body.action}`, event, { id: body.action, verdict: "approved", order: body.order, note: `standing order: ${order.label}` });
        return null;
      }
      // Sessions on a Mac's own screen (docs/MAC.md, M4): asked for him by a full node, allowed or not by you alone (the
      // first answer stands), and ended once, by you or by him; how long one lasts is counted from your answer.
      case "screen.asked": {
        if (!isFullNode(signer)) return "only full nodes may ask for a screen session";
        const body = bodyOf(event, "screen.asked");
        if (this.lww(`screen:${body.id}`)) return "screen session already asked";
        this.putLww(`screen:${body.id}`, event, body as Json);
        return null;
      }
      case "screen.decided": {
        if (!isFullNode(signer)) return "only full nodes may record decisions";
        if (event.prov?.trust !== "owner") return "a screen session is yours alone to allow";
        const body = bodyOf(event, "screen.decided");
        if (!this.lww(`screen:${body.id}`)) return "no such screen session";
        if (this.lww(`screen-decision:${body.id}`)) return "screen session already decided";
        this.putLww(`screen-decision:${body.id}`, event, { ...body, ...(event.prov.via ? { via: event.prov.via } : {}) } as Json);
        return null;
      }
      case "screen.ended": {
        if (!isFullNode(signer)) return "only full nodes may end a screen session";
        const body = bodyOf(event, "screen.ended");
        if (!this.lww(`screen:${body.id}`)) return "no such screen session";
        if (this.lww(`screen-ended:${body.id}`)) return "screen session already ended";
        this.putLww(`screen-ended:${body.id}`, event, body as Json);
        return null;
      }
      case "rule.set":
      case "rule.removed": {
        // Your rules (core's rules.ts) are your word alone: never an agent's, never a stranger's, never unsaid.
        if (!isFullNode(signer)) return "only full nodes may record rules";
        if (event.prov?.trust !== "owner") return "a rule is your word alone";
        if (event.kind === "rule.removed") {
          this.putLww(`rule:${bodyOf(event, "rule.removed").name}`, event, null);
          return null;
        }
        const body = bodyOf(event, "rule.set");
        this.putLww(`rule:${body.name}`, event, { name: body.name, rule: body.rule as Json, ...(event.prov.via ? { via: event.prov.via } : {}) });
        return null;
      }
      // The two retired kinds (core's events.ts): folded as they always were, their refusals worded as they always
      // were (a refusal's reason is part of the digest), so a log that holds them gives every replica the same mind.
      case "companion.named": {
        if (!isFullNode(signer)) return "only full nodes may name his dog";
        this.putLww("companion", event, { name: bodyOf(event, "companion.named").name });
        return null;
      }
      case "companion.unnamed": {
        if (!isFullNode(signer)) return "only full nodes may name his dog";
        this.putLww("companion", event, null);
        return null;
      }
      case "skill.written": {
        if (!isFullNode(signer)) return "only full nodes write skills";
        const body = bodyOf(event, "skill.written");
        // Without a word on its trust, it's a stranger's.
        const trust = event.prov?.trust ?? "untrusted";
        if ((trust === "owner") !== (body.by === SKILL_OWNER)) return "only your own words are yours";
        if (trust === "agent" && body.by !== SKILL_GALAHAD) return "only his own reviewed work is trusted as his";
        const skill = this.db.query<{ head: string }, [string]>("SELECT head FROM v_skills WHERE id = ?").get(body.skill);
        const insert = this.db.query("INSERT INTO v_skill_versions (id, skill, n, prev, doc, trust, author, quest, via, source, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        if (!skill) {
          insert.run(event.id, body.skill, 1, null, canonical(body.doc as Json), trust, body.by, body.quest ?? null, event.prov?.via ?? null, event.prov?.source ?? null, event.hlc);
          this.db.query("INSERT INTO v_skills (id, head, created_hlc, touched_hlc) VALUES (?, ?, ?, ?)").run(body.skill, event.id, event.hlc, event.hlc);
          return null;
        }
        if (trust !== "owner") {
          // You change any skill. He changes only what he wrote, and nothing you locked; another agent proposes, never revises.
          if (body.by !== SKILL_GALAHAD) return "only you and Galahad revise a skill";
          if (this.skillMarked(body.skill, "locked")) return "the skill is locked";
          const head = this.db.query<{ author: string }, [string]>("SELECT author FROM v_skill_versions WHERE id = ?").get(skill.head);
          if (head?.author !== SKILL_GALAHAD) return "he revises only skills he wrote";
        }
        const n = this.db.query<{ n: number }, [string]>("SELECT MAX(n) AS n FROM v_skill_versions WHERE skill = ?").get(body.skill)!.n + 1;
        insert.run(event.id, body.skill, n, skill.head, canonical(body.doc as Json), trust, body.by, body.quest ?? null, event.prov?.via ?? null, event.prov?.source ?? null, event.hlc);
        this.db.query("UPDATE v_skills SET head = ?, touched_hlc = ? WHERE id = ?").run(event.id, event.hlc, body.skill);
        return null;
      }
      case "skill.approved": {
        if (!isFullNode(signer)) return "only full nodes record your approval";
        const body = bodyOf(event, "skill.approved");
        const version = this.db.query<{ skill: string; approved_hlc: string | null }, [string]>("SELECT skill, approved_hlc FROM v_skill_versions WHERE id = ?").get(body.version);
        if (!version || version.skill !== body.skill) return "no such version of that skill";
        // The first approval stands: it names what you read then.
        if (version.approved_hlc) return "already approved";
        this.db.query("UPDATE v_skill_versions SET approved_hlc = ? WHERE id = ?").run(event.hlc, body.version);
        this.db.query("UPDATE v_skills SET touched_hlc = ? WHERE id = ?").run(event.hlc, body.skill);
        return null;
      }
      case "skill.marked": {
        if (!isFullNode(signer)) return "only full nodes mark skills";
        const body = bodyOf(event, "skill.marked");
        if (!this.db.query("SELECT 1 FROM v_skills WHERE id = ?").get(body.skill)) return "no such skill";
        this.putLww(`skill-mark:${body.skill}:${body.mark}`, event, { on: body.on });
        return null;
      }
      case "skill.reverted": {
        if (!isFullNode(signer)) return "only full nodes roll a skill back";
        const body = bodyOf(event, "skill.reverted");
        const skill = this.db.query<{ head: string }, [string]>("SELECT head FROM v_skills WHERE id = ?").get(body.skill);
        if (!skill) return "no such skill";
        // One step, from the version you saw: a version that arrived meanwhile isn't undone unseen.
        if (skill.head !== body.from) return "the skill changed since";
        const prev = this.db.query<{ prev: string | null }, [string]>("SELECT prev FROM v_skill_versions WHERE id = ?").get(skill.head)?.prev;
        if (!prev) return "nothing to go back to";
        this.db.query("UPDATE v_skills SET head = ?, touched_hlc = ? WHERE id = ?").run(prev, event.hlc, body.skill);
        return null;
      }
      case "skill.used": {
        // A full node: the one that gave it to a model (a limited node holds no keys, and asks no model).
        if (!isFullNode(signer)) return "only full nodes record a skill's use";
        const body = bodyOf(event, "skill.used");
        const version = this.db.query<{ skill: string; trust: string; approved_hlc: string | null }, [string]>("SELECT skill, trust, approved_hlc FROM v_skill_versions WHERE id = ?").get(body.version);
        if (!version || version.skill !== body.skill) return "no such version of that skill";
        // What was given to a model must have been his to be given: every replica checks it again.
        if (version.trust === "untrusted" && !version.approved_hlc) return "that version was not approved";
        if (this.skillMarked(body.skill, "retired")) return "the skill is retired";
        if (this.db.query("SELECT 1 FROM v_skill_uses WHERE skill = ? AND quest = ?").get(body.skill, body.quest)) return "already counted";
        this.db.query("INSERT INTO v_skill_uses (skill, quest, version, hlc) VALUES (?, ?, ?, ?)").run(body.skill, body.quest, body.version, event.hlc);
        const chat = body.quest.startsWith(SKILL_CHAT);
        this.db.query(`UPDATE v_skills SET ${chat ? "chats = chats + 1" : "uses = uses + 1"}, used_hlc = ?, touched_hlc = ? WHERE id = ?`).run(event.hlc, event.hlc, body.skill);
        return null;
      }
      case "skill.outcome": {
        if (!isFullNode(signer)) return "only full nodes record a quest's outcome";
        const body = bodyOf(event, "skill.outcome");
        if (body.quest.startsWith(SKILL_CHAT)) return "a chat answer has no review";
        const use = this.db.query<{ status: string | null }, [string, string]>("SELECT status FROM v_skill_uses WHERE skill = ? AND quest = ?").get(body.skill, body.quest);
        if (!use) return "that quest didn't use the skill";
        if (use.status) return "already recorded";
        this.db.query("UPDATE v_skill_uses SET status = ? WHERE skill = ? AND quest = ?").run(body.status, body.skill, body.quest);
        // Its review passed, or it didn't. A quest you stopped (or an ending this node doesn't know) says nothing about the skill.
        const counted = body.status === "done" ? "passed" : body.status === "unverified" || body.status === "gave-up" ? "failed" : null;
        if (counted) this.db.query(`UPDATE v_skills SET ${counted} = ${counted} + 1 WHERE id = ?`).run(body.skill);
        return null;
      }
      default:
        return null;
    }
  }

  /** A skill's mark as it stands (at this point of a replay): locked, retired. */
  private skillMarked(skill: string, mark: string): boolean {
    return this.lww<{ on?: unknown }>(`skill-mark:${skill}:${mark}`)?.value?.on === true;
  }

  private putGrant(kid: string, device: string, box: Json): void {
    this.db.query("INSERT OR REPLACE INTO v_grants (kid, device, box) VALUES (?, ?, ?)").run(kid, device, canonical(box));
  }

  /** Last-writer-wins by (hlc, id). Order-independent by construction. */
  private putLww(key: string, event: GEvent, value: Json): void {
    const current = this.db.query<{ hlc: string; eid: string }, [string]>("SELECT hlc, eid FROM v_lww WHERE k = ?").get(key);
    if (current && compareEvents({ hlc: current.hlc, id: current.eid }, event) >= 0) return;
    this.db
      .query(
        `INSERT INTO v_lww (k, hlc, eid, device, v) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (k) DO UPDATE SET hlc = excluded.hlc, eid = excluded.eid, device = excluded.device, v = excluded.v`,
      )
      .run(key, event.hlc, event.id, event.device, value === null ? null : canonical(value));
  }

  private profileHlc(device: string): string | null {
    return this.db.query<{ profile_hlc: string | null }, [string]>("SELECT profile_hlc FROM v_devices WHERE id = ?").get(device)
      ?.profile_hlc ?? null;
  }

  private anyDevices(): boolean {
    return !!this.db.query("SELECT 1 FROM v_devices LIMIT 1").get();
  }

  // ---- reading -------------------------------------------------------------

  get genesis(): { id: string; device: string; name: string; v?: number } | null {
    return this.state("genesis");
  }

  device(id: string): Device | null {
    const row = this.db.query<DeviceRow, [string]>("SELECT * FROM v_devices WHERE id = ?").get(id);
    return row ? toDevice(row) : null;
  }

  /** The device as it stood at `hlc` (enrolled before, not yet revoked). */
  deviceAt(id: string, hlc: string): Device | null {
    const device = this.device(id);
    if (!device || device.enrolledHlc > hlc) return null;
    if (device.revokedHlc && device.revokedHlc <= hlc) return null;
    return device;
  }

  /** Currently active (non-revoked) device. */
  activeDevice(id: string): Device | null {
    const device = this.device(id);
    return device && !device.revokedHlc ? device : null;
  }

  devices(includeRevoked = false): Device[] {
    const rows = this.db.query<DeviceRow, []>("SELECT * FROM v_devices ORDER BY enrolled_hlc").all();
    return rows.map(toDevice).filter((d) => includeRevoked || !d.revokedHlc);
  }

  lww<T = Json>(key: string): LwwEntry<T> | null {
    const row = this.db.query<LwwRow, [string]>("SELECT * FROM v_lww WHERE k = ?").get(key);
    return row ? toLww<T>(row) : null;
  }

  lwwPrefix<T = Json>(prefix: string): LwwEntry<T>[] {
    return this.db
      .query<LwwRow, [string]>("SELECT * FROM v_lww WHERE k LIKE ? ORDER BY k")
      .all(`${prefix.replace(/[%_]/g, "")}%`)
      .map((row) => toLww<T>(row))
      .filter((entry) => entry.value !== null);
  }

  grant(kid: string, device: string): string | null {
    return this.db.query<{ box: string }, [string, string]>("SELECT box FROM v_grants WHERE kid = ? AND device = ?").get(kid, device)
      ?.box ?? null;
  }

  rejection(id: string): string | null {
    return this.db.query<{ reason: string }, [string]>("SELECT reason FROM v_rejected WHERE id = ?").get(id)?.reason ?? null;
  }

  remember(signer: NodeIdentity, text: string, opts: { tags?: string[]; prov?: Prov } = {}): GEvent {
    return this.emit(signer, "memory.added", { text, ...(opts.tags?.length ? { tags: opts.tags } : {}) }, opts.prov ?? { trust: "owner" });
  }

  /**
   * The most recent memories carrying one tag (a project's, say), newest first. `owner`: only yours (true) or only
   * others' (false), chosen before the limit, so many of one kind never crowd out the other.
   */
  memoriesTagged(tag: string, limit = 10, owner?: boolean): Memory[] {
    const whose = owner === undefined ? "" : owner ? " AND m.trust = 'owner'" : " AND m.trust != 'owner'";
    return this.db
      .query<MemoryRow, [string, number]>(`SELECT m.* FROM v_memories m, json_each(m.tags) t WHERE t.value = ? AND m.forgotten = 0${whose} ORDER BY m.hlc DESC LIMIT ?`)
      .all(tag, limit)
      .map((row) => ({ ...row, tags: JSON.parse(row.tags) as string[] }));
  }

  /** Full-text recall (BM25). An empty query returns the most recent memories. */
  recall(query: string | undefined, limit = 20): Memory[] {
    const terms = (query ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
    const rows = terms.length
      ? this.db
          .query<MemoryRow, [string, number]>(
            `SELECT m.* FROM v_memories_fts f JOIN v_memories m ON m.id = f.id
             WHERE v_memories_fts MATCH ? AND m.forgotten = 0 ORDER BY bm25(v_memories_fts) LIMIT ?`,
          )
          .all(terms.map((t) => `"${t}"*`).join(" OR "), limit)
      : this.db
          .query<MemoryRow, [number]>("SELECT * FROM v_memories WHERE forgotten = 0 ORDER BY hlc DESC LIMIT ?")
          .all(limit);
    return rows.map((row) => ({ ...row, tags: JSON.parse(row.tags) as string[] }));
  }

  // ---- rules -----------------------------------------------------------------

  /** Your rules in force, by name, each as it was written (open in the log: core's readRule reads it). */
  rules(): RuleRecord[] {
    return this.lwwPrefix<{ name: string; rule: Json; via?: string }>("rule:").map((entry) => ({ name: entry.value!.name, rule: entry.value!.rule, hlc: entry.hlc, via: entry.value!.via ?? null }));
  }

  // ---- screen sessions ---------------------------------------------------------

  /** Every session on a Mac's own screen Galahad asked for, the newest first, with your answer and its end. */
  screenSessions(): ScreenSessionRecord[] {
    return this.lwwPrefix<{ id: string; node: string; why: string; minutes: number }>("screen:")
      .map((entry) => {
        const asked = entry.value!;
        const decision = this.lww<{ verdict: "allowed" | "denied"; via?: string }>(`screen-decision:${asked.id}`);
        const ended = this.lww(`screen-ended:${asked.id}`);
        return {
          id: asked.id,
          node: asked.node,
          why: asked.why,
          minutes: asked.minutes,
          askedAt: decodeHlc(entry.hlc).ms,
          askedBy: entry.device,
          decision: decision?.value ? { verdict: decision.value.verdict, at: decodeHlc(decision.hlc).ms, via: decision.value.via ?? null } : null,
          endedAt: ended ? decodeHlc(ended.hlc).ms : null,
        };
      })
      .sort((x, y) => y.askedAt - x.askedAt || (x.id < y.id ? -1 : 1));
  }

  // ---- skills ----------------------------------------------------------------

  /** Every skill, with every version kept, oldest skill first. Where each stands is the reader's to say (core's skillStanding). */
  skills(): SkillRecord[] {
    const versions = new Map<string, SkillVersionRecord[]>();
    for (const row of this.db.query<SkillVersionRow, []>("SELECT * FROM v_skill_versions ORDER BY skill, n").all()) {
      const list = versions.get(row.skill) ?? [];
      list.push(toSkillVersion(row));
      versions.set(row.skill, list);
    }
    return this.db
      .query<SkillRow, []>("SELECT * FROM v_skills ORDER BY created_hlc, id")
      .all()
      .map((row) => this.toSkill(row, versions.get(row.id) ?? []));
  }

  skill(id: string): SkillRecord | null {
    const row = this.db.query<SkillRow, [string]>("SELECT * FROM v_skills WHERE id = ?").get(id);
    if (!row) return null;
    return this.toSkill(row, this.db.query<SkillVersionRow, [string]>("SELECT * FROM v_skill_versions WHERE skill = ? ORDER BY n").all(id).map(toSkillVersion));
  }

  private toSkill(row: SkillRow, versions: SkillVersionRecord[]): SkillRecord {
    const stale = this.lww<{ on?: unknown }>(`skill-mark:${row.id}:stale`);
    return {
      id: row.id,
      head: row.head,
      createdHlc: row.created_hlc,
      touchedHlc: row.touched_hlc,
      uses: row.uses,
      passed: row.passed,
      failed: row.failed,
      chats: row.chats,
      usedHlc: row.used_hlc,
      locked: this.skillMarked(row.id, "locked"),
      retired: this.skillMarked(row.id, "retired"),
      staleHlc: stale?.value?.on === true ? stale.hlc : null,
      versions,
    };
  }

  /** The quests and answers a skill was given to, newest first. */
  skillUses(skill: string, limit = 50): SkillUseRecord[] {
    return this.db.query<SkillUseRecord, [string, number]>("SELECT skill, quest, version, hlc, status FROM v_skill_uses WHERE skill = ? ORDER BY hlc DESC, quest LIMIT ?").all(skill, limit);
  }

  /** The skills one quest was given. */
  skillsUsedBy(quest: string): SkillUseRecord[] {
    return this.db.query<SkillUseRecord, [string]>("SELECT skill, quest, version, hlc, status FROM v_skill_uses WHERE quest = ? ORDER BY hlc, skill").all(quest);
  }

  /** The latest uses of any skill, newest first. */
  recentSkillUses(limit = 20): SkillUseRecord[] {
    return this.db.query<SkillUseRecord, [number]>("SELECT skill, quest, version, hlc, status FROM v_skill_uses ORDER BY hlc DESC, skill, quest LIMIT ?").all(limit);
  }

  /** Accepted ledger entries of one resource since `sinceMs` (by their own clocks), newest first: a day's spend is summed from these. */
  ledgerOf(resource: string, sinceMs: number, limit = 1000): (GEvent & { body: BodyOf<"ledger.recorded"> })[] {
    const since = `${String(Math.max(0, Math.floor(sinceMs))).padStart(15, "0")}.000000`;
    return this.db
      .query<{ raw: string }, [string, string, number]>(
        `SELECT e.raw FROM events e LEFT JOIN v_rejected r ON r.id = e.id
         WHERE e.kind = 'ledger.recorded' AND e.hlc >= ? AND json_extract(e.raw, '$.body.resource') = ? AND r.id IS NULL
         ORDER BY e.hlc DESC, e.id DESC LIMIT ?`,
      )
      .all(since, resource, limit)
      .map((row) => JSON.parse(row.raw) as GEvent & { body: BodyOf<"ledger.recorded"> });
  }

  // ---- sync ----------------------------------------------------------------

  /** Highest hlc held per device. Each device's events form a prefix, so this fully describes what we have. */
  frontier(): Record<string, string> {
    const rows = this.db.query<{ device: string; top: string }, []>("SELECT device, top FROM log_devices").all();
    return Object.fromEntries(rows.map((r) => [r.device, r.top]));
  }

  /**
   * Per device: how many events we hold and the set hash of their ids (SetHash), which shows
   * holes a frontier can't see. Kept as events arrive, so this costs the same at any log size.
   */
  deviceDigests(): Record<string, DeviceDigest> {
    const out: Record<string, DeviceDigest> = {};
    for (const row of this.db.query<{ device: string; n: number; ids: Uint8Array }, []>("SELECT device, n, ids FROM log_devices").all()) {
      out[row.device] = { n: row.n, h: SetHash.from(row.ids).digest() };
    }
    return out;
  }

  /**
   * Events the peer described by `have` is missing, oldest first, at most `limit`.
   *
   * With the peer's `digests` (deviceDigests on its side), it also checks each device's log
   * *below* the peer's frontier: when the peer holds a different set there (an event dated in
   * the past, a partial delivery) and we hold at least as many, that device is named in
   * `repair`. A frontier alone could never surface such a hole, and replicas would silently
   * fork; the peer then walks that device's log page by page (SyncEngine), so no answer is
   * ever larger than one page. When the peer is more than a page behind on a device the check
   * waits until it has caught up: it costs one set-hash step per event above its frontier.
   *
   * `after` (a walk's place, per device): the id of the event at `have[device]` the peer has
   * reached, so the answer goes on after that event in (hlc, id) order. By hlc alone, an event
   * dated the same instant as the last of a page could never come. That device is being walked,
   * so it isn't checked for a hole.
   */
  eventsSince(
    have: Record<string, string>,
    limit = 500,
    digests?: Record<string, DeviceDigest>,
    after?: Record<string, string>,
  ): { events: GEvent[]; more: boolean; repair?: string[] } {
    const devices = this.db.query<{ device: string; n: number; ids: Uint8Array }, []>("SELECT device, n, ids FROM log_devices").all();
    const batch: GEvent[] = [];
    const repair: string[] = [];
    const sinceHlc = this.db.query<{ id: string; raw: string }, [string, string, number]>(
      "SELECT id, raw FROM events WHERE device = ? AND hlc > ? ORDER BY hlc, id LIMIT ?",
    );
    // A row value, so the (device, hlc, id) index serves it (as in lateButHarmless).
    const sinceEvent = this.db.query<{ id: string; raw: string }, [string, string, string, number]>(
      "SELECT id, raw FROM events WHERE device = ? AND (hlc, id) > (?, ?) ORDER BY hlc, id LIMIT ?",
    );
    for (const { device, n, ids } of devices) {
      const since = have[device];
      const place = since ? after?.[device] : undefined;
      const above = place ? sinceEvent.all(device, since!, place, limit + 1) : sinceHlc.all(device, since ?? "", limit + 1);
      const theirs = place ? undefined : digests?.[device];
      if (theirs && since && above.length <= limit) {
        // What we hold up to their frontier: everything, less what's above it.
        const ours = SetHash.from(ids);
        for (const row of above) ours.remove(row.id);
        // Only when we hold at least as much below their frontier can we fill their hole;
        // otherwise they are ahead of us and our own pull will catch up.
        if (ours.digest() !== theirs.h && n - above.length >= theirs.n) repair.push(device);
      }
      for (const row of above) batch.push(JSON.parse(row.raw) as GEvent);
    }
    batch.sort(compareEvents);
    return { events: batch.slice(0, limit), more: batch.length > limit, ...(repair.length ? { repair } : {}) };
  }

  /** Most recent ledger entries, newest first (only from devices that were active when they wrote). */
  ledger(limit = 100): (GEvent & { body: BodyOf<"ledger.recorded"> })[] {
    return this.db
      .query<{ raw: string }, [number]>("SELECT raw FROM events WHERE kind = 'ledger.recorded' ORDER BY hlc DESC, id DESC LIMIT ?")
      .all(limit * 2)
      .map((row) => JSON.parse(row.raw) as GEvent & { body: BodyOf<"ledger.recorded"> })
      .filter((event) => !this.rejection(event.id))
      .slice(0, limit);
  }

  /** Recent runs of one loop (or of all), newest first, from devices that were active when they wrote. */
  loopRuns(loop?: string, limit = 20): (GEvent & { body: BodyOf<"loop.ran"> })[] {
    const rows = loop
      ? this.db
          .query<{ raw: string }, [string, number]>(
            "SELECT raw FROM events WHERE kind = 'loop.ran' AND json_extract(raw, '$.body.loop') = ? ORDER BY hlc DESC, id DESC LIMIT ?",
          )
          .all(loop, limit * 2)
      : this.db
          .query<{ raw: string }, [number]>("SELECT raw FROM events WHERE kind = 'loop.ran' ORDER BY hlc DESC, id DESC LIMIT ?")
          .all(limit * 2);
    return rows
      .map((row) => JSON.parse(row.raw) as GEvent & { body: BodyOf<"loop.ran"> })
      .filter((event) => !this.rejection(event.id))
      .slice(0, limit);
  }

  /** The latest scheduled slot a device has recorded for a loop (null: it never ran on schedule). */
  lastSlot(loop: string, device: string): number | null {
    return this.db.query<{ slot: number }, [string, string]>("SELECT slot FROM v_slots WHERE loop = ? AND device = ?").get(loop, device)?.slot ?? null;
  }

  /**
   * How many accepted ledger entries of one resource were recorded since `sinceMs` (by their own clocks):
   * an exact count, whatever else fills the ledger (the day's budget of extra attempts is counted this way).
   * With `detail`, only those whose detail is that (a key's uses by one VM: `sandbox:<id>`).
   */
  ledgerCount(resource: string, sinceMs: number, detail?: string): number {
    const since = `${String(Math.max(0, Math.floor(sinceMs))).padStart(15, "0")}.000000`;
    const sql = `SELECT COUNT(*) AS n FROM events e LEFT JOIN v_rejected r ON r.id = e.id
         WHERE e.kind = 'ledger.recorded' AND e.hlc >= ? AND json_extract(e.raw, '$.body.resource') = ? AND r.id IS NULL`;
    if (detail === undefined) return this.db.query<{ n: number }, [string, string]>(sql).get(since, resource)!.n;
    return this.db.query<{ n: number }, [string, string, string]>(`${sql} AND json_extract(e.raw, '$.body.detail') = ?`).get(since, resource, detail)!.n;
  }

  /** Devices caught signing two different histories (a stolen key, or worse). */
  forks(): string[] {
    return this.db
      .query<{ k: string }, []>("SELECT k FROM v_state WHERE k LIKE 'fork:%' ORDER BY k")
      .all()
      .map((row) => row.k.slice("fork:".length));
  }

  event(id: string): GEvent | null {
    const raw = this.db.query<{ raw: string }, [string]>("SELECT raw FROM events WHERE id = ?").get(id)?.raw;
    return raw ? (JSON.parse(raw) as GEvent) : null;
  }

  eventCount(): number {
    return this.loggedCount();
  }

  /** Hash of the materialized state. Equal digests ⇒ equal minds. */
  digest(): string {
    // Changes only when another connection commits (this one's writes clear the cache instead).
    const version = this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version;
    if (this.stateDigest?.version === version) return this.stateDigest.digest;
    const dump = {
      state: this.db.query("SELECT k, v FROM v_state WHERE k != 'tail' ORDER BY k").all(),
      devices: this.db.query("SELECT * FROM v_devices ORDER BY id").all(),
      memories: this.db.query("SELECT * FROM v_memories ORDER BY id").all(),
      lww: this.db.query("SELECT * FROM v_lww ORDER BY k").all(),
      grants: this.db.query("SELECT * FROM v_grants ORDER BY kid, device").all(),
      rejected: this.db.query("SELECT * FROM v_rejected ORDER BY id").all(),
      // Only once there's a skill: a mind without one keeps the digest it always had (and an older node's).
      ...(this.db.query("SELECT 1 FROM v_skills LIMIT 1").get()
        ? {
            skills: this.db.query("SELECT * FROM v_skills ORDER BY id").all(),
            skillVersions: this.db.query("SELECT * FROM v_skill_versions ORDER BY id").all(),
            skillUses: this.db.query("SELECT * FROM v_skill_uses ORDER BY skill, quest").all(),
          }
        : {}),
    };
    this.stateDigest = { version, digest: sha256B64u(canonical(dump as unknown as Json)) };
    return this.stateDigest.digest;
  }
}

/** One of your rules as the mind holds it: as written, when it was set and from which device of yours. */
export interface RuleRecord {
  name: string;
  rule: Json;
  hlc: string;
  via: string | null;
}

/** A session on a Mac's own screen, as the log holds it (store.screenSessions; core's screenSession says where it stands). */
export interface ScreenSessionRecord {
  id: string;
  /** The Mac it is on. */
  node: string;
  why: string;
  minutes: number;
  askedAt: number;
  /** The node that asked for him. */
  askedBy: string;
  decision: { verdict: "allowed" | "denied"; at: number; via: string | null } | null;
  endedAt: number | null;
}

/** One version of a skill, as the log's event wrote it. Its words (`doc`) are as written: the reader checks them. */
export interface SkillVersionRecord {
  id: string;
  skill: string;
  n: number;
  /** The head it replaced. */
  prev: string | null;
  doc: Json;
  trust: string;
  by: string;
  quest: string | null;
  via: string | null;
  /** Where it came from, as its event says (the quest and why it's untrusted, the agent that proposed it). */
  source: string | null;
  hlc: string;
  approvedHlc: string | null;
}

/** A skill as the mind holds it: its head, its marks, its track record, every version. */
export interface SkillRecord {
  id: string;
  head: string;
  createdHlc: string;
  /** When it was last written, approved, rolled back or used. */
  touchedHlc: string;
  uses: number;
  passed: number;
  failed: number;
  chats: number;
  usedHlc: string | null;
  locked: boolean;
  retired: boolean;
  /** When it was last marked stale (it is stale while that's after touchedHlc). */
  staleHlc: string | null;
  versions: SkillVersionRecord[];
}

export interface SkillUseRecord {
  skill: string;
  quest: string;
  version: string;
  hlc: string;
  status: string | null;
}

interface SkillRow {
  id: string;
  head: string;
  created_hlc: string;
  touched_hlc: string;
  uses: number;
  passed: number;
  failed: number;
  chats: number;
  used_hlc: string | null;
}

interface SkillVersionRow {
  id: string;
  skill: string;
  n: number;
  prev: string | null;
  doc: string;
  trust: string;
  author: string;
  quest: string | null;
  via: string | null;
  source: string | null;
  hlc: string;
  approved_hlc: string | null;
}

const toSkillVersion = (row: SkillVersionRow): SkillVersionRecord => ({
  id: row.id,
  skill: row.skill,
  n: row.n,
  prev: row.prev,
  doc: JSON.parse(row.doc) as Json,
  trust: row.trust,
  by: row.author,
  quest: row.quest,
  via: row.via,
  source: row.source,
  hlc: row.hlc,
  approvedHlc: row.approved_hlc,
});

export const isFullNode = (device: Device | null): device is Device =>
  !!device && device.kind === "node" && device.role === "full" && !device.revokedHlc;

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  role: string;
  box: string | null;
  scopes: string;
  enrolled_by: string;
  enrolled_hlc: string;
  revoked_hlc: string | null;
  profile: string | null;
  profile_hlc: string | null;
}

const toDevice = (row: DeviceRow): Device => ({
  id: row.id,
  name: row.name,
  kind: row.kind as Device["kind"],
  role: row.role as Device["role"],
  box: row.box,
  scopes: JSON.parse(row.scopes) as Scope[],
  enrolledBy: row.enrolled_by,
  enrolledHlc: row.enrolled_hlc,
  revokedHlc: row.revoked_hlc,
  profile: row.profile ? (JSON.parse(row.profile) as Device["profile"]) : null,
});

interface MemoryRow {
  id: string;
  text: string;
  tags: string;
  device: string;
  via: string | null;
  trust: string;
  hlc: string;
}

interface LwwRow {
  k: string;
  hlc: string;
  eid: string;
  device: string;
  v: string | null;
}

const toLww = <T>(row: LwwRow): LwwEntry<T> => ({
  key: row.k,
  hlc: row.hlc,
  eid: row.eid,
  device: row.device,
  value: row.v === null ? null : (JSON.parse(row.v) as T),
});
