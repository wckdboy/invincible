import { CLOCK, isConversationId, NOTIFY_OPENS, NOTIFY_PER_DAY, type NotifyLostView, type NotifyOpen, type NotifyPrefs, type NotifyView } from "@galahad/core/notify";

/*
 * Notifications on this device, as the page reasons about them (pure: the browser's
 * own calls are in views/notifications.ts). Which state this device is in, what to say
 * about it, and the checks the Settings fields make before anything is sent.
 */

/**
 * unsupported: this browser can't be pushed to · home-screen: an iPhone or iPad whose Galahad isn't on the
 * Home Screen yet (the only place iOS delivers to) · blocked: you, or the browser, said no for this site ·
 * off · on.
 */
export type PushState = "unsupported" | "home-screen" | "blocked" | "off" | "on";

export interface PushEnv {
  /** A secure page with a service worker, a push manager and notifications. */
  capable: boolean;
  ios: boolean;
  /** Opened from the Home Screen (or installed), not in a browser tab. */
  standalone: boolean;
  permission: "default" | "granted" | "denied";
  /** This browser holds a subscription, and the node keeps one for this device. */
  subscribed: boolean;
}

export function pushState(env: PushEnv): PushState {
  // iOS has push only for an app on the Home Screen; in a Safari tab there's no push manager at all.
  if (env.ios && !env.standalone) return "home-screen";
  if (!env.capable) return "unsupported";
  if (env.permission === "denied") return "blocked";
  return env.subscribed && env.permission === "granted" ? "on" : "off";
}

/** An iPhone or iPad, including an iPad that says it's a Mac. */
export const isIos = (nav: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean =>
  /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);

/**
 * What the welcome screen says before pairing. An iPhone in Safari: put Galahad on the Home Screen first and pair it
 * there (the app there keeps its own key, apart from Safari's, and only it can be notified), or it's paired twice. An
 * installed app: it pairs on its own, by a pasted invite (links open in the browser). Anything else pairs where it is.
 */
export function pairingNote(env: { ios: boolean; standalone: boolean }): "home-screen-first" | "pair-this-app" | null {
  if (env.standalone) return "pair-this-app";
  return env.ios ? "home-screen-first" : null;
}

export const WHAT_IS_SENT = "A short title and one line, with where it opens: a finding that needs you, an approval that's waiting, that he has finished or has a question. Fixed words only, never your own (a chat's title, a name you gave) or a model's: the app shows those once you open it. It's encrypted to this browser, so the push service that carries it can't read it. What needs you sounds; news comes quietly.";

export const PUSH_STATE_TEXT: Record<PushState, string> = {
  unsupported: "This browser can't receive notifications from a web app.",
  "home-screen": "On iPhone and iPad, notifications work once Galahad is on your Home Screen: in Safari, tap Share (in the ⋯ menu on iOS 26), then Add to Home Screen, and open Galahad from there.",
  blocked: "Notifications are blocked for this site in your browser's settings. Allow them there, then turn this on.",
  off: "Off. Your browser asks you once, when you turn this on.",
  on: "On: he can reach this device when the app is closed.",
};

/* ---------- when he can't reach this device ---------- */

/** How long the card stays away once you put it away (Not now): a week, on this device. */
export const REACH_DISMISS_MS = 7 * 24 * 3600_000;

export interface ReachCard {
  /** off: not on here · lost: on until its push service stopped taking them · blocked: the browser said no · home-screen: an iPhone's Safari tab. */
  why: "off" | "lost" | "blocked" | "home-screen";
  title: string;
  /** What to know first: when they were lost and by which service, how to allow them, or the Home Screen note. */
  detail: string | null;
  /** Turn them on from your tap (the browser asks); none where a tap here can't. */
  action: "turn-on" | null;
}

/** "They were on until 18 Nov: Apple's push service stopped taking them." */
export function lostLine(lost: NotifyLostView): string {
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(lost.at);
  const service = lost.service === "a push service you allowed" ? "the push service you allowed" : `${lost.service}'s push service`;
  return `They were on until ${day}: ${service} stopped taking them.`;
}

/**
 * The card at the top of "Galahad asks you" and the Inbox, saying he can't reach this device when Galahad is closed,
 * and the one thing to do. Only while it matters: this device's subscription was lost (it was on, and you didn't turn
 * it off), or no device of yours can be reached at all. A device you turned off while another reaches you isn't
 * nagged; a browser that can't be pushed to at all is offered nothing (the Inbox's notice says where else).
 */
export function reachCard(env: PushEnv, view: { subscribed: boolean | null; lost?: NotifyLostView | null; reachable?: number } | null): ReachCard | null {
  if (!view || view.subscribed === null) return null;
  const state = pushState(env);
  if (state === "on" || state === "unsupported") return null;
  const lost = view.lost ?? null;
  if (!lost && view.reachable !== 0) return null;
  const title = "He can't reach this device when Galahad is closed.";
  if (state === "home-screen") return { why: "home-screen", title, detail: PUSH_STATE_TEXT["home-screen"], action: null };
  if (state === "blocked") return { why: "blocked", title, detail: "Notifications are blocked for this site in your browser: allow them in its settings for this site, then turn them on here.", action: null };
  return { why: lost ? "lost" : "off", title, detail: lost ? lostLine(lost) : null, action: "turn-on" };
}

/** Whether you put the card away (`at`) less than a week ago. */
export const reachDismissed = (at: number | null, now: number): boolean => at !== null && at <= now && now - at < REACH_DISMISS_MS;

/**
 * What the app does with this browser's subscription when it opens (the browser's leave already given; never asked
 * here). make: a new one, handed over (lost, so your own choice still stands; or made for a node's new key) · drop:
 * the browser's goes too (turned off, here or elsewhere: both agree) · hand-over: the node's copy kept current.
 */
export function pushSync(s: { subscribed: boolean; lost: boolean; browser: boolean; sameKey: boolean }): "make" | "drop" | "hand-over" | "none" {
  if (!s.subscribed) return s.lost ? "make" : s.browser ? "drop" : "none";
  if (!s.browser) return "none";
  return s.sameKey ? "hand-over" : "make";
}

/**
 * What the service worker tells an open page when a notification is tapped: one of the app's places, and a
 * kept chat for the chat page. Read strictly: anything else is no message of ours.
 */
export function readOpenMessage(data: unknown): { route: NotifyOpen; conversation?: string } | null {
  const d = (data && typeof data === "object" ? data : {}) as { type?: unknown; open?: unknown; conversation?: unknown };
  if (d.type !== "galahad:open" || typeof d.open !== "string" || !(NOTIFY_OPENS as readonly string[]).includes(d.open)) return null;
  const conversation = d.open === "chat" && typeof d.conversation === "string" && isConversationId(d.conversation) ? d.conversation : undefined;
  return { route: d.open as NotifyOpen, ...(conversation ? { conversation } : {}) };
}

/** A VAPID key (base64url) as the bytes `pushManager.subscribe` takes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Whether a browser's subscription was made for this node's key (a node that lost its key has a new one). */
export function sameKey(existing: ArrayBuffer | null | undefined, key: string): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  const b = keyBytes(key);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Why a time of day won't do (null: it will). */
export const clockProblem = (value: string): string | null => (CLOCK.test(value) ? null : "A time of day, like 22:00.");

/** Why a day's limit won't do (null: it will). */
export function perDayProblem(value: string): string | null {
  const n = Number(value);
  return /^\d+$/.test(value.trim()) && n >= NOTIFY_PER_DAY.min && n <= NOTIFY_PER_DAY.max ? null : `A whole number from ${NOTIFY_PER_DAY.min} to ${NOTIFY_PER_DAY.max}.`;
}

/** Quiet hours in a line. `zone`: the one your day is read in now (your devices'), when the node said it. */
export function quietLine(prefs: NotifyPrefs, zone?: string): string {
  if (!prefs.quiet.on) return "No quiet hours: he tells you whenever it happens.";
  return `From ${prefs.quiet.from} to ${prefs.quiet.to}, ${(zone ?? prefs.quiet.tz).replace(/_/g, " ")} time, everything but an alert waits; then one message says what waited.`;
}

/** The day's digest in a line. */
export function digestLine(prefs: NotifyPrefs, zone?: string): string {
  if (!prefs.digest?.on) return "No digest: what he doesn't buzz you for waits in your Inbox.";
  return `At ${prefs.digest.at}, ${(zone ?? prefs.quiet.tz).replace(/_/g, " ")} time, one quiet message says what happened that he didn't buzz you for, and what still waits.`;
}

/**
 * The notifications this browser still shows whose matter was answered, dismissed, cleared or lapsed (on any device):
 * the ones to take down, by tag (the node's `withdrawn`).
 */
export function toTakeDown(shown: readonly { tag: string }[], withdrawn: readonly string[] | undefined): string[] {
  const gone = new Set(withdrawn ?? []);
  return [...new Set(shown.map((n) => n.tag).filter((tag) => gone.has(tag)))];
}

/** Today's count against the limit, and what's held, in a line. */
export function todayLine(view: Pick<NotifyView, "today" | "quiet" | "held">): string {
  const sent = view.today.count === 0 ? "Nothing sent today (a test doesn't count)" : `${view.today.count} of ${view.today.limit} sent today`;
  const held = view.quiet && view.held ? `; ${view.held} ${view.held === 1 ? "thing waits" : "things wait"} for quiet hours to end` : "";
  return `${sent}${held}.`;
}
