import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { LIVE_TOPICS, type LiveTopic } from "@invincible/core";

/*
 * What changed on this node, for the live stream (core's live.ts). Each topic has a stamp: a short string that changes
 * whenever its route would answer otherwise, cheap to read. The stamps are read again soon after anything is written
 * (`poke`: the mind took events, a request was answered, an agent's work moved, a turn began or ended, a run reported,
 * the node wrote a chat, a notification's state, a draft, a request or a question of its own, a peer came or went), and
 * as the next deadline a stamp names comes (`due`: an ask that lapses). Every LOOK_MS while anyone listens they are read
 * anyway: the net under the pokes, for what nothing tells (another process's write). Whoever listens is told the topics
 * whose stamps moved, together, and nothing more. While nobody listens nothing is read. Each stream opens on the stamps
 * read as it opens, so its hello holds every write made before it.
 *
 * Where things stand is a count of the times anything moved since this began, each topic keeping the count at which it
 * last moved. A reader's cursor is the latest count among the topics it may read, sealed (Seal): it moves only with
 * what the reader is told, and says neither the count nor how far it moved, so it tells nothing of the rest (a key asked
 * for, to a device that may not read the vault). A stream opened again from a cursor is told which of its topics moved
 * since (`since`). What moved while nobody listened is counted too: the stamps as last read are kept when the last
 * listener goes, and compared with what is read when the next one comes. A cursor of another boot (the node started
 * again: another key), one past where its reader stands, or one that isn't ours is one it can't answer for.
 */

/**
 * While anyone listens, the stamps are read this often whatever pokes them: the net for what nothing tells. What moves
 * on this node pokes, and a deadline wakes it, so this is not how soon anything is told.
 */
export const LOOK_MS = 2_000;
/** A poke is read this soon after it, so a burst of writes (a decision and its ledger line) is told once. */
export const SOON_MS = 15;
/** The longest a timer waits (setTimeout's own bound); a deadline further off is looked at again then. */
const LONGEST_WAIT_MS = 2 ** 31 - 1;

/** A topic's stamp, and, for one that also moves with the clock, how many ms until it next does (Infinity: never). */
export type Stamp = (() => string) & { due?: () => number };
/** Each topic's stamp, as this node reads it. */
export type Stamps = Record<LiveTopic, Stamp>;

/**
 * A count, sealed: one AES block holding it beside eight zero bytes, under a key made for this tracker alone. Opaque to
 * whoever holds it (neither the count nor how far it moved since the last), not to be made up (a block that isn't one
 * of ours opens to something else, its zeros gone, all but once in 2^64), and another boot's, under another key, never
 * opens. 22 characters of base64url, one spelling each: what core's LiveCursor takes.
 */
class Seal {
  private readonly key = randomBytes(16);

  close(count: number): string {
    const block = Buffer.alloc(16);
    block.writeBigUInt64BE(BigInt(count), 8);
    const cipher = createCipheriv("aes-128-ecb", this.key, null).setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]).toString("base64url");
  }

  open(cursor: string): number | null {
    if (!/^[A-Za-z0-9_-]{22}$/.test(cursor)) return null;
    const sealed = Buffer.from(cursor, "base64url");
    if (sealed.length !== 16 || sealed.toString("base64url") !== cursor) return null;
    const decipher = createDecipheriv("aes-128-ecb", this.key, null).setAutoPadding(false);
    const block = Buffer.concat([decipher.update(sealed), decipher.final()]);
    if (block.readBigUInt64BE(0) !== 0n) return null;
    const count = block.readBigUInt64BE(8);
    return count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null;
  }
}

export class LiveChanges {
  private readonly listeners = new Set<(topics: LiveTopic[], at: string) => void>();
  /** The stamps as last read; null while nobody listens. */
  private last: Record<LiveTopic, string> | null = null;
  /** The stamps as last read before nobody listened: compared with what is read when someone listens again. */
  private kept: Record<LiveTopic, string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  /** The look at the next deadline a stamp named, while anyone listens. */
  private wake: ReturnType<typeof setTimeout> | null = null;
  /** Topics whose stamp failed, said once each until it reads again. */
  private readonly failing = new Set<LiveTopic>();
  /** How each cursor it gives is sealed: one of another tracker (the node started again) never opens. */
  private readonly seal = new Seal();
  /** How many times anything moved since it began, and the count at which each topic last moved (0: not since). */
  private seq = 0;
  private readonly movedAt = Object.fromEntries(LIVE_TOPICS.map((topic) => [topic, 0])) as Record<LiveTopic, number>;

  constructor(
    private readonly stamps: Stamps,
    private readonly o: { everyMs?: number; soonMs?: number; log?: (line: string) => void } = {},
  ) {}

  /**
   * Where things stand for a reader of these topics (absent: all of them): the cursor its stream is given with its hello,
   * to be opened again from. It moves only when one of them moves.
   */
  at(topics: Iterable<LiveTopic> = LIVE_TOPICS): string {
    return this.seal.close(this.latest(topics));
  }

  /**
   * Which of these topics (absent: all) moved since `cursor`, each once; null when it can't say: no cursor, another
   * boot's, one past where a reader of them stands (never given to it), or one that isn't ours. What moved while nobody
   * listened counts once someone listens (subscribe), so a stream asks this after it subscribed.
   */
  since(cursor: string | null | undefined, topics: Iterable<LiveTopic> = LIVE_TOPICS): LiveTopic[] | null {
    const count = cursor ? this.seal.open(cursor) : null;
    const mine = new Set(topics);
    if (count === null || count > this.latest(mine)) return null;
    return LIVE_TOPICS.filter((topic) => mine.has(topic) && this.movedAt[topic] > count);
  }

  /**
   * Tells `listener` the topics whose answers changed, as they change, with where things stand after them, until what
   * this returns is called.
   */
  subscribe(listener: (topics: LiveTopic[], at: string) => void): () => void {
    if (!this.listeners.size) {
      const now = this.read();
      // What moved while nobody listened: moved now, told to none (a stream opened again from before it is told).
      if (this.kept) this.moved(LIVE_TOPICS.filter((topic) => now[topic] !== this.kept![topic]));
      this.kept = null;
      this.last = now;
      this.timer = setInterval(() => this.look(), this.o.everyMs ?? LOOK_MS);
    } else {
      // Others listen: what was written before this one opened is read now, so its hello has it (where things stand, and
      // what moved since its cursor), rather than its being told a look later. On a starved machine a poke's look waits
      // for the next slice of CPU, a second away. Those already listening are told it now, as that look would have.
      if (this.soon) clearTimeout(this.soon);
      this.soon = null;
      this.look();
    }
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener) && !this.listeners.size) this.idle();
    };
  }

  get listening(): number {
    return this.listeners.size;
  }

  /** Something was written: look soon. */
  poke(): void {
    if (!this.listeners.size || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.look();
    }, this.o.soonMs ?? SOON_MS);
  }

  /** Reads every stamp and tells whoever listens which moved. */
  look(): void {
    const before = this.last;
    if (!before) return;
    const now = this.read();
    this.last = now;
    const moved = LIVE_TOPICS.filter((topic) => now[topic] !== before[topic]);
    if (!moved.length) return;
    this.moved(moved);
    // (Where a reader told of any of these stands: they moved last.)
    const at = this.at(moved);
    for (const listener of [...this.listeners]) {
      try {
        listener(moved, at);
      } catch {
        /* one listener's trouble is its own */
      }
    }
  }

  /** Nobody is told anything more. */
  close(): void {
    this.listeners.clear();
    this.idle();
  }

  /** The count at which the latest of these moved (0: none since this began). */
  private latest(topics: Iterable<LiveTopic>): number {
    let latest = 0;
    for (const topic of topics) latest = Math.max(latest, this.movedAt[topic] ?? 0);
    return latest;
  }

  private moved(topics: readonly LiveTopic[]): void {
    if (!topics.length) return;
    this.seq += 1;
    for (const topic of topics) this.movedAt[topic] = this.seq;
  }

  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    if (this.wake) clearTimeout(this.wake);
    this.timer = null;
    this.soon = null;
    this.wake = null;
    // (Kept, for what moves before anyone listens again: a write's poke now finds nobody, and nothing is read.)
    if (this.last) this.kept = this.last;
    this.last = null;
  }

  private read(): Record<LiveTopic, string> {
    const out = {} as Record<LiveTopic, string>;
    const before = this.last ?? this.kept;
    for (const topic of LIVE_TOPICS) {
      try {
        out[topic] = this.stamps[topic]();
        this.failing.delete(topic);
      } catch (error) {
        // Read as unchanged: whatever it would have told, its route still answers.
        out[topic] = before?.[topic] ?? "";
        if (!this.failing.has(topic)) this.o.log?.(`live: ${topic}'s stamp failed: ${(error as Error).message ?? error}`);
        this.failing.add(topic);
      }
    }
    this.wakeAtNextDeadline();
    return out;
  }

  /** A look when the soonest deadline any stamp names comes (a moment after, so it has passed when read). */
  private wakeAtNextDeadline(): void {
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    let soonest = Infinity;
    for (const topic of LIVE_TOPICS) {
      try {
        soonest = Math.min(soonest, this.stamps[topic].due?.() ?? Infinity);
      } catch {
        /* read as none: the look's net still reads it */
      }
    }
    if (!Number.isFinite(soonest)) return;
    this.wake = setTimeout(
      () => {
        this.wake = null;
        this.look();
      },
      Math.min(Math.max(0, soonest) + 1, LONGEST_WAIT_MS),
    );
  }
}

/** What each kind of the mind's events can change, of what the stream tells (most change none of it: the ledger, a loop's run). */
export function mindTopics(kind: string): readonly LiveTopic[] {
  // (A node's name is shown with its sessions on a Mac's screen.)
  if (kind === "fleet.genesis" || kind === "fleet.chained" || kind === "node.profile" || kind.startsWith("device.")) return ["fleet", "screenSessions"];
  if (kind.startsWith("secret.")) return ["secretRequests"];
  if (kind.startsWith("memory.")) return ["aboutYou"];
  // (A standing order answers actions, and an action shows the order that did.)
  if (kind.startsWith("action.") || kind.startsWith("order.")) return ["actions"];
  if (kind.startsWith("screen.")) return ["screenSessions"];
  if (kind.startsWith("notice.")) return ["notices"];
  // (An agent's request for a connector goes once the connector is added, or it may use it.)
  if (kind.startsWith("connector.")) return ["connectorRequests"];
  return [];
}

/** How many of the mind's events touched each topic: the stamp of what the mind alone holds. */
export class LedgerCounts {
  private readonly counts = new Map<LiveTopic, number>();

  /** Counts what these events touch (a replay touches everything); whether any topic moved. */
  take(events: readonly { kind: string }[], rebuilt: boolean): boolean {
    let moved = false;
    const bump = (topic: LiveTopic) => {
      this.counts.set(topic, (this.counts.get(topic) ?? 0) + 1);
      moved = true;
    };
    if (rebuilt) for (const topic of LIVE_TOPICS) bump(topic);
    else for (const event of events) for (const topic of mindTopics(event.kind)) bump(topic);
    return moved;
  }

  of(topic: LiveTopic): number {
    return this.counts.get(topic) ?? 0;
  }
}

/**
 * The stamp of a list the mind holds whose items' states also move with the clock (an ask that lapses, an approval no
 * longer sent): read again only when the mind changed it (`version`) or the next of its deadlines came (`due`, from what
 * was read), so a deadline passing is told as a write is. It says how long until that next deadline (Stamp's `due`), so
 * the stream looks then.
 */
export function timedStamp<T>(version: () => number, read: (now: number) => readonly T[], due: (item: T) => number | null, now: () => number = Date.now): Stamp {
  let seen: number | null = null;
  let next = Infinity;
  let passed = 0;
  const stamp = () => {
    const v = version();
    const at = now();
    if (v === seen && at < next) return `${v}.${passed}`;
    if (v === seen) passed += 1;
    seen = v;
    next = Infinity;
    for (const item of read(at)) {
      const when = due(item);
      if (when !== null && when > at && when < next) next = when;
    }
    return `${v}.${passed}`;
  };
  return Object.assign(stamp, { due: () => (Number.isFinite(next) ? next - now() : Infinity) });
}
