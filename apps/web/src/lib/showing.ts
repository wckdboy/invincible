import type { NotifyOpen } from "@invincible/core/notify-payload";

/*
 * Quiet while you're looking at that very thing (X2; the iPhone's Push.presentation): a notification about what the page
 * in front shows says nothing over it, since the page already shows it, live. A task's end while its own thread is in
 * front; an ask (it opens the Inbox) while the Inbox is; a chat only while that very chat is named in the address (a
 * turn someone is watching is never told at all: the node knows). A test always shows. Pure and small: the service
 * worker reads it.
 */

/** Where a notification opens, as the service worker keeps it for its tap. */
export interface NotifyTarget {
  open: NotifyOpen;
  conversation?: string;
  task?: string;
}

/** Whether the page at `pageUrl` shows the very thing a notification opens. */
export function showsThatVeryThing(target: NotifyTarget, pageUrl: string | undefined): boolean {
  if (!pageUrl) return false;
  let hash: string;
  try {
    hash = new URL(pageUrl).hash;
  } catch {
    return false;
  }
  if (target.open === "task") return target.task !== undefined && hash === `#/task/${target.task}`;
  if (target.open === "chat") return target.conversation !== undefined && hash === `#/chat?c=${target.conversation}`;
  if (target.open === "inbox") return hash === "#/inbox" || hash.startsWith("#/inbox?");
  return false;
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
