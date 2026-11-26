/*
 * A plan's allowance runs in windows (OpenCode Go: five hours, then a week, then a month). Once its provider has
 * said the window is spent and when it resets, asking it again before then only fails again, slowly, before the
 * next model is tried: on 14 November 2026 every call of a sweep did. So a node remembers each window it is told
 * of, by chat or by a tool's call through the gateway, chat passes that provider's models over without asking until
 * the window ends (and says until when), the gateway refuses a tool's calls to them as spent (gateway.ts), and then
 * each asks again. A node's own, kept in memory and in its own database (node/usage.ts), so a restart remembers it: on
 * 21 November 2026 a deploy forgot OpenCode Go's window, and the usage meter stopped saying it until the next refusal.
 *
 * A coding plan's allowance is the plan's, so its window holds back every model of its. Any other provider's is the
 * model's alone (windowScope): a router (OrcaRouter, OpenRouter, a Cloudflare AI Gateway) serves many vendors' models,
 * and an API limits each model apart, so one model told to wait says nothing of the others.
 */

import { onPlan } from "./providers.ts";

/** One provider's allowance, spent until the time its provider gave. */
export interface SpentWindow {
  /** What it holds back (windowScope): a coding plan's provider, or one model of any other's (`provider/model`). */
  provider: string;
  /** When it resets (ms). */
  until: number;
  /** When it was told. */
  noted: number;
  /** What its provider said, as it said it (cut short). */
  said: string;
}

const UNIT: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
const SPAN = String.raw`(?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*,?\s*(?:and\s+)?)+`;
const RESETS = new RegExp(String.raw`(?:resets?|renews?)\s+in\s+(${SPAN})`, "i");
const AGAIN = new RegExp(String.raw`try again in\s+(${SPAN})`, "i");

/**
 * When a provider's refusal says its allowance is spent and when that resets: the time it resets (ms), else null.
 * Only a refusal about an allowance or a limit, with a span ("resets in 1h 37m", "try again in 20s"), counts; a
 * clock time without a day or a zone ("Try again at 3:45 PM") is not read, and nothing more than a month away.
 */
export function spentUntil(error: string, now: number): number | null {
  if (!/\b429\b|limit|quota|allowance|exhausted/i.test(error)) return null;
  if (!/limit|quota|allowance|exhausted|spent/i.test(error)) return null;
  const span = (RESETS.exec(error) ?? AGAIN.exec(error))?.[1];
  if (!span) return null;
  let ms = 0;
  for (const [, n, unit] of span.matchAll(/(\d+)\s*([a-z]+)/gi)) ms += Number(n) * (UNIT[unit!.slice(0, 1).toLowerCase()] ?? 0);
  return ms > 0 && ms <= 31 * 86_400_000 ? now + ms : null;
}

/** When a refusal's `retry-after` says to try again (seconds, or an HTTP date): that time (ms), else null; nothing more than a month away. */
export function retryAfterAt(value: string | null, now: number): number | null {
  if (!value) return null;
  const ms = /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 && ms <= 31 * 86_400_000 ? now + Math.ceil(ms) : null;
}

/** What a refusal of a model's call holds back: its coding plan, every model of it; otherwise that model alone. */
export function windowScope(ref: string): string {
  const slash = ref.indexOf("/");
  return slash > 0 && onPlan(ref) ? ref.slice(0, slash) : ref;
}

/** HH:MM in UTC, and a span in hours and minutes: how a window is said. */
export const clockUtc = (at: number): string => new Date(at).toISOString().slice(11, 16);
export const spanWords = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

export class SpentWindows {
  /** The clock (tests set their own). */
  now: () => number = Date.now;
  /** Told of each window as it is noted, to keep it through a restart (a node's database; none: memory alone). */
  kept: ((window: SpentWindow) => void) | null = null;
  private readonly windows = new Map<string, SpentWindow>();

  /**
   * Read a provider's refusal: when it says its allowance is spent and when it resets (in its words, else when it said
   * to try again: `retryAt`, from a 429's retry-after), remember that, for what it holds back (`provider`: windowScope).
   */
  note(provider: string, error: string, retryAt: number | null = null): SpentWindow | null {
    const noted = this.now();
    const until = spentUntil(error, noted) ?? retryAt;
    if (until === null) return null;
    const window: SpentWindow = { provider, until, noted, said: error.replace(/\s+/g, " ").slice(0, 300) };
    this.windows.set(provider, window);
    this.kept?.(window);
    return window;
  }

  /** Windows kept from before a restart: each still open is as it was told; one that has ended is left out. */
  restore(windows: readonly SpentWindow[]): void {
    for (const window of windows) if (window.until > this.now()) this.windows.set(window.provider, window);
  }

  /** The window a provider is in now, or null (one that has ended is forgotten). */
  spent(provider: string): SpentWindow | null {
    const window = this.windows.get(provider);
    if (!window) return null;
    if (window.until <= this.now()) {
      this.windows.delete(provider);
      return null;
    }
    return window;
  }

  /** The window that holds a model back now, its plan's or its own, or null. */
  spentFor(ref: string): SpentWindow | null {
    const slash = ref.indexOf("/");
    return (slash > 0 ? this.spent(ref.slice(0, slash)) : null) ?? this.spent(ref);
  }

  /** Every window open now. */
  list(): SpentWindow[] {
    return [...this.windows.keys()].map((provider) => this.spent(provider)).filter((w): w is SpentWindow => w !== null);
  }

  /** Why a provider's models are passed over now, in the words a fallback says. */
  why(window: SpentWindow): string {
    return `its allowance is spent until ${clockUtc(window.until)} UTC (${spanWords(window.until - this.now())} from now), as its provider said: passed over without asking`;
  }
}

const kept = new WeakMap<object, SpentWindows>();

/** A node's own record of spent allowances: one for each mind it keeps (a node keeps one). */
export function windowsOf(store: object): SpentWindows {
  let windows = kept.get(store);
  if (!windows) {
    windows = new SpentWindows();
    kept.set(store, windows);
  }
  return windows;
}
