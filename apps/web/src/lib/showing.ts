import type { NotifyOpen } from "@invincible/core/notify-payload";

/*
 * Quiet while you're looking at that very thing (X2; the iPhone's Push.presentation): a notification about what the page
 * in front shows says nothing over it, since the page already shows it, live. A task's end while its own thread is in
 * front; an ask (it opens the Inbox) while the Inbox is; a chat only while that very chat is named in the address (a
 * turn someone is watching is never told at all: the node knows). A test always shows. Pure and small: the service
 * worker reads it.
 *
 * What a page shows is asked of the page itself: a browser's WindowClient.url is the address it was opened at, and
 * doesn't follow the hash this app goes around by (Chrome 156, 26 November 2026: a page opened at #/settings and then
 * on #/inbox was still #/settings to its service worker).
 */

/** Where a notification opens, as the service worker keeps it for its tap. */
export interface NotifyTarget {
  open: NotifyOpen;
  conversation?: string;
  task?: string;
}

/** The address of the very thing a notification is about (null: it opens a place, not a thing, and always shows). */
export function placeOf(target: NotifyTarget): string | null {
  if (target.open === "task") return target.task !== undefined ? `#/task/${target.task}` : null;
  if (target.open === "chat") return target.conversation !== undefined ? `#/chat?c=${target.conversation}` : null;
  if (target.open === "inbox") return "#/inbox";
  return null;
}

/** Whether a page whose address is `hash` (its location.hash, as it said) shows the very thing a notification opens. */
export function showsThatVeryThing(target: NotifyTarget, hash: string | null | undefined): boolean {
  const place = placeOf(target);
  if (!place || !hash) return false;
  return hash === place || (target.open === "inbox" && hash.startsWith(`${place}?`));
}

/** The worker's question to a page in front, on a port of its own: what do you show now? */
export const SHOWING_QUESTION = { type: "invincible:showing?" } as const;
/** How long the worker waits for the answer: a page that says nothing by then is taken for one that isn't looking. */
export const SHOWING_WAIT_MS = 400;

export const isShowingQuestion = (data: unknown): boolean => (data as { type?: unknown } | null)?.type === SHOWING_QUESTION.type;

/** A page's answer: its own address. */
export const showingAnswer = (hash: string) => ({ type: "invincible:showing", hash });

/** A page's answer, read strictly: the app's own kind of address ("" for none yet), or null for anything else. */
export function readShowing(data: unknown): string | null {
  const d = (data && typeof data === "object" ? data : {}) as { type?: unknown; hash?: unknown };
  if (d.type !== "invincible:showing" || typeof d.hash !== "string" || d.hash.length > 256) return null;
  return d.hash === "" || d.hash.startsWith("#/") ? d.hash : null;
}

/**
 * The push services whose browsers let a push show nothing while a page of the app is in front: Chrome's (Google's),
 * Edge's (Microsoft's) and Firefox's (Mozilla's). Safari (Apple's service) takes away a subscription whose pushes show
 * nothing, so there it is shown quietly instead; so is it under any other service, or with no subscription to read.
 */
const MAY_SHOW_NOTHING: { hosts: string[]; suffixes: string[] } = {
  hosts: ["fcm.googleapis.com", "jmt17.google.com", "updates.push.services.mozilla.com"],
  suffixes: [".push.services.mozilla.com", ".notify.windows.com"],
};

/** Whether this browser must show every push it is given, by the push service its subscription names. */
export function showsEveryPush(endpoint: string | undefined | null): boolean {
  if (!endpoint) return true;
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return true;
  }
  return !(MAY_SHOW_NOTHING.hosts.includes(host) || MAY_SHOW_NOTHING.suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length));
}
