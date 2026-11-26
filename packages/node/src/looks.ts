import { LOOK_LIMITS, zonedInstant, zonedParts } from "@galahad/core";
import type { ChatStore, KeptLook } from "./chats.ts";
import { type TurnHub, TurnError, type TurnSpec } from "./turns.ts";

/*
 * His own looks (your word, 24 November 2026: "add it. In the end I want Galahad to become fully autonomous"): as he
 * answers in a chat of yours, he may set himself a time to look at something again (a deploy, a run, a reply) instead
 * of asking you to come back. The look waits in the chat store; when its time comes it becomes a turn of his in that
 * chat, with his note as the message that starts it (shown as his, never as yours), run as the device whose turn set
 * it as that device stands then (revoked since, or no longer allowed to chat, and it doesn't run). What the answer that
 * set it held of yours (the bank, a private connector's data), its turn starts holding: nothing that can carry data out
 * runs in it. A look whose chat is busy waits for the turn there to end; one that came due while this node was away is
 * taken when it is back, within a week, and said to be late. Each is taken once, and never tried again by itself.
 */

/** Minutes, hours, days (`in`), or a wall-clock time in a zone (`at`), as the instant a look comes: within its limits. */
export function lookAt(when: { in?: string; at?: string }, zone: string, now: number): number {
  let at: number;
  if (when.in !== undefined) {
    const m = /^(\d{1,5}) ?([mhd])$/.exec(when.in.trim());
    if (!m) throw new LookLaterError("in minutes, hours or days: 45m, 2h, 1d");
    at = now + Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  } else if (when.at !== undefined) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(when.at.trim());
    if (!m) throw new LookLaterError("a date and a time: 2026-11-25 09:00");
    const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) throw new LookLaterError(`${when.at} is not a time there is`);
    at = zonedInstant({ year, month, day, hour, minute }, zone);
  } else throw new LookLaterError("say when: in (45m, 2h, 1d) or at (2026-11-25 09:00)");
  if (at - now < LOOK_LIMITS.minMs) throw new LookLaterError(`that is ${at <= now ? "past" : "less than a minute away"}: give a time to come`);
  if (at - now > LOOK_LIMITS.aheadMs) throw new LookLaterError("that is more than 30 days away: a loop is for what's further off (galahad loop add … --at)");
  return at;
}

export class LookLaterError extends Error {}

/** A time as a look says it: "21:07" today in its zone, "Tue 24 Nov, 21:07" on another day. */
export function lookTime(at: number, zone: string, now: number): string {
  const p = zonedParts(at, zone);
  const today = zonedParts(now, zone);
  const clock = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  if (p.year === today.year && p.month === today.month && p.day === today.day) return clock;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(at);
  return `${day}, ${clock}`;
}

/** The message a look comes back as, for the model and kept in the chat as his: when he set it, his note, what to do. */
export function lookMessage(look: { set: number; note: string; at: number; zone: string }, now: number): string {
  const late = now - look.at > 10 * 60_000 ? ` It came due at ${lookTime(look.at, look.zone, now)}, while this node was away: it is late.` : "";
  return `(A look you set yourself at ${lookTime(look.set, look.zone, now)}, not your liege's words: ${look.note})${late} Look now, with your tools, and say what you found and what comes next: your liege reads it here.`;
}

export interface LookRunnerOptions {
  chats: ChatStore;
  turns: TurnHub;
  now?: () => number;
  log?: (message: string) => void;
}

/** Takes his looks when they come: each a turn of his in its chat, once. */
export class LookRunner {
  private readonly now: () => number;
  private prepare: ((look: KeptLook) => TurnSpec) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: LookRunnerOptions) {
    this.now = o.now ?? Date.now;
  }

  /** How a look becomes a turn: the server's, as a queued message's is (who it runs as, its tools, what it holds). */
  setPrepare(prepare: (look: KeptLook) => TurnSpec): void {
    this.prepare = prepare;
  }

  start(intervalMs = 15_000): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Every look whose time has come, taken now: unless its chat is busy, or the node at its limit (then at a later tick). */
  tick(): void {
    if (!this.prepare) return;
    const now = this.now();
    for (const look of this.o.chats.looksDue(now)) {
      if (now - look.at > LOOK_LIMITS.lateMs) {
        this.o.chats.lookEnd(look.id, "failed", `it came due at ${new Date(look.at).toISOString().slice(0, 16)} UTC, more than a week ago, while this node was away`);
        continue;
      }
      if (this.o.turns.runningIn(look.conversation)) continue;
      try {
        const spec = this.prepare(look);
        this.o.turns.start({ ...spec, look: { set: look.set, note: look.note } });
        this.o.chats.lookEnd(look.id, "done", null);
      } catch (error) {
        // Busy (a turn there, the node's limit, a node stopping): it waits for a later tick. Anything else, it's said.
        if (error instanceof TurnError && (error.status === 409 || error.status === 429 || error.status === 503)) continue;
        const why = String((error as Error).message ?? error).slice(0, 300);
        this.o.chats.lookEnd(look.id, "failed", why);
        this.o.log?.(`look ${look.id}: ${why}`);
      }
    }
  }
}
