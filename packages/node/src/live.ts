import { LIVE_TOPICS, type LiveTopic } from "@galahad/core";

/*
 * What changed on this node, for the live stream (core's live.ts). Each topic has a stamp: a short string that changes
 * whenever its route would answer otherwise, cheap enough to read four times a second. The stamps are read again soon
 * after anything is written (`poke`: the mind took events, a request was answered) and every LOOK_MS while anyone
 * listens, for what changes by itself (a knight's work, a turn's end, a deadline passing). Whoever listens is told the
 * topics whose stamps moved, together, and nothing more. While nobody listens nothing is read.
 */

/** While anyone listens, the stamps are read this often: what no write pokes for (a knight's work, a deadline). */
export const LOOK_MS = 250;
/** A poke is read this soon after it, so a burst of writes (a decision and its ledger line) is told once. */
export const SOON_MS = 15;

/** Each topic's stamp, as this node reads it. */
export type Stamps = Record<LiveTopic, () => string>;

export class LiveChanges {
  private readonly listeners = new Set<(topics: LiveTopic[]) => void>();
  /** The stamps as last read; null while nobody listens. */
  private last: Record<LiveTopic, string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  /** Topics whose stamp failed, said once each until it reads again. */
  private readonly failing = new Set<LiveTopic>();

  constructor(
    private readonly stamps: Stamps,
    private readonly o: { everyMs?: number; soonMs?: number; log?: (line: string) => void } = {},
  ) {}

  /** Tells `listener` the topics whose answers changed, as they change, until what this returns is called. */
  subscribe(listener: (topics: LiveTopic[]) => void): () => void {
    if (!this.listeners.size) {
      this.last = this.read();
      this.timer = setInterval(() => this.look(), this.o.everyMs ?? LOOK_MS);
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
    for (const listener of [...this.listeners]) {
      try {
        listener(moved);
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

  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null;
    this.soon = null;
    this.last = null;
  }

  private read(): Record<LiveTopic, string> {
    const out = {} as Record<LiveTopic, string>;
    for (const topic of LIVE_TOPICS) {
      try {
        out[topic] = this.stamps[topic]();
        this.failing.delete(topic);
      } catch (error) {
        // Read as unchanged: whatever it would have told, its route still answers.
        out[topic] = this.last?.[topic] ?? "";
        if (!this.failing.has(topic)) this.o.log?.(`live: ${topic}'s stamp failed: ${(error as Error).message ?? error}`);
        this.failing.add(topic);
      }
    }
    return out;
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
export class MindCounts {
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
 * was read), so a deadline passing is told as a write is.
 */
export function timedStamp<T>(version: () => number, read: (now: number) => readonly T[], due: (item: T) => number | null, now: () => number = Date.now): () => string {
  let seen: number | null = null;
  let next = Infinity;
  let passed = 0;
  return () => {
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
}
