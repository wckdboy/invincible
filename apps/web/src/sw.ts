import { GENERIC_NOTIFICATION, isConversationId, isQuietKind, NOTIFY_OPENS, type NotifyOpen, type NotifyPayload, notifyUrl, readNotifyPayload } from "@galahad/core/notify-payload";
import { afterPush, badgeCount, type BadgeState, type Badging, NO_BADGE, readBadgeMessage, readBadgeState, showBadge } from "./lib/badge.ts";

/*
 * Service worker: keeps the app shell available offline, and shows what Galahad
 * pushes to this device (below the caching: "He comes to you").
 * The page itself comes from the network first (it carries all the CSS), the
 * cached copy only when the network is slow or gone. Other shell assets are served
 * from cache and refreshed in the background (stale-while-revalidate).
 * Anything under /api, /link or /gw is never cached: those are signed,
 * live requests and always go to the network. The pairing bundle (/pair.js)
 * is not cached either: pairing needs the network anyway. (The knights are orbs,
 * drawn by the app itself: there are no pictures of them to keep.)
 */

const VERSION = "galahad-shell-v10";
// (Not the SVG icons: the app never shows them, a browser fetches its favicon itself, and the installer its icons.)
const SHELL = ["/", "/app.js", "/boot.js", "/manifest.webmanifest", "/icon-192.png", "/apple-touch-icon.png", "/knights/galahad-helm.webp", "/fonts/geist.woff2"];
const NEVER_CACHE = ["/api/", "/link/", "/gw/"];

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

/** A push as it arrives: its data, if the push service carried any (decrypted by the browser). */
interface PushEventLike extends ExtendableEventLike {
  data: { json(): unknown } | null;
}

/** A message from an open page of the app. */
interface MessageEventLike extends ExtendableEventLike {
  data: unknown;
}

interface NotificationEventLike extends ExtendableEventLike {
  notification: { close(): void; data: unknown };
}

/** A page of the app that's open, as the worker sees it. */
interface WindowClientLike {
  url?: string;
  visibilityState?: string;
  focus?(): Promise<unknown>;
  postMessage(message: unknown): void;
}

interface ServiceWorkerScope {
  location: Location;
  addEventListener(type: "install" | "activate" | "pushsubscriptionchange", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  skipWaiting(): Promise<void>;
  navigator: Badging;
  registration: { showNotification(title: string, options: Record<string, unknown>): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<WindowClientLike[]>; openWindow(url: string): Promise<unknown> };
}

const sw = self as unknown as ServiceWorkerScope;

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

/** Tell open pages that a newer app has been fetched, so they can offer a reload. */
async function announceUpdate(): Promise<void> {
  for (const client of await sw.clients.matchAll({ type: "window" })) client.postMessage({ type: "galahad:updated" });
}

async function fromShell(event: FetchEventLike, key: string): Promise<Response> {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(key);
  const before = key === "/app.js" ? cached?.clone() : undefined;
  const refresh = fetch(event.request)
    .then(async (response) => {
      if (response.ok) {
        if (before && (await before.text()) !== (await response.clone().text())) await announceUpdate();
        await cache.put(key, response.clone());
      }
      return response;
    })
    .catch(() => null);
  event.waitUntil(refresh);
  if (cached) return cached;
  const fresh = await refresh;
  return fresh ?? new Response("Galahad is offline and this page is not cached yet.", { status: 503 });
}

/** How long opening the app waits for the network before falling back to the cached page. */
const PAGE_TIMEOUT_MS = 3500;
/** The navigations that are the app opening: only their page is kept, as "/". */
const APP_PAGES = ["/", "/index.html"];

/**
 * Opening the app: the page from the network first (it holds all the CSS, so a cached
 * copy meant the first launch after an update still showed the old look, unannounced),
 * the cached page when the network is slow or gone.
 */
async function page(event: FetchEventLike): Promise<Response> {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(event.request, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (response.ok) {
      // Anything else opened in a tab (a script, the manifest, the bank's return with its code) is shown, never kept as the app.
      const app = APP_PAGES.includes(new URL(event.request.url).pathname) && (response.headers.get("content-type") ?? "").startsWith("text/html");
      if (app) event.waitUntil(cache.put("/", response.clone()));
      return response;
    }
  } catch {
    /* slow or offline: the cached page */
  }
  return (await cache.match("/")) ?? new Response("Galahad is offline and this page is not cached yet.", { status: 503 });
}

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") {
    event.respondWith(page(event));
    return;
  }
  if (SHELL.includes(url.pathname)) event.respondWith(fromShell(event, url.pathname));
});

/*
 * He comes to you. The node pushes a small JSON payload, encrypted to this browser (the push
 * service can't read it): a short title, one line, and where it opens. It's read strictly
 * (notify-payload.ts): anything that isn't one of ours is shown as a plain "something needs
 * you", never as whatever it says, and never as nothing (a browser requires a push to show).
 * A tap opens the app at that place: in the window that's already open if there is one.
 */

/** What a notification remembers for its tap: one of the app's places, and a kept chat for the chat page. */
interface OpenTarget {
  open: NotifyOpen;
  conversation?: string;
}

function readTarget(data: unknown): OpenTarget {
  const d = (data && typeof data === "object" ? data : {}) as { open?: unknown; conversation?: unknown };
  const open = typeof d.open === "string" && (NOTIFY_OPENS as readonly string[]).includes(d.open) ? (d.open as NotifyOpen) : "inbox";
  const conversation = open === "chat" && typeof d.conversation === "string" && isConversationId(d.conversation) ? d.conversation : undefined;
  return { open, ...(conversation ? { conversation } : {}) };
}

async function showPush(event: PushEventLike): Promise<void> {
  let payload: NotifyPayload | null = null;
  try {
    payload = event.data ? readNotifyPayload(event.data.json()) : null;
  } catch {
    payload = null;
  }
  const shown = payload ?? GENERIC_NOTIFICATION;
  // News (a news kind) is told quietly: no sound or vibration, and the same thing told again replaces it without a
  // word. What needs you lets you know, every time, even when it replaces its own notification.
  const quiet = isQuietKind(shown.kind);
  await sw.registration.showNotification(shown.title, {
    body: shown.body,
    tag: shown.tag,
    silent: quiet,
    renotify: !quiet,
    icon: "/icon-192.png",
    // Android's status bar draws a badge from its alpha alone: the field in white on nothing, not the tile (a white
    // square). No picture (`image`): its words are the message, and a picture would only decorate it.
    badge: "/icon-mono-96.png",
    data: { open: shown.open, ...(shown.conversation ? { conversation: shown.conversation } : {}) },
  });
  await countOnIcon(shown);
}

/*
 * The number on the app's icon (lib/badge.ts): an open page sets it, and tells the worker its count; a push
 * about something new that waits for you adds one. Kept with the shell, so it lasts from one push to the next.
 */
const BADGE_KEY = "/badge.json";

async function badgeState(): Promise<BadgeState> {
  try {
    return readBadgeState(await (await (await caches.open(VERSION)).match(BADGE_KEY))?.json());
  } catch {
    return NO_BADGE;
  }
}

const keepBadge = async (state: BadgeState): Promise<void> =>
  (await caches.open(VERSION)).put(BADGE_KEY, new Response(JSON.stringify(state), { headers: { "content-type": "application/json" } }));

async function countOnIcon(shown: NotifyPayload): Promise<void> {
  try {
    const before = await badgeState();
    const after = afterPush(before, shown);
    if (after === before) return;
    await keepBadge(after);
    await showBadge(sw.navigator, badgeCount(after));
  } catch {
    /* the count is a nicety: the notification is already shown */
  }
}

sw.addEventListener("message", (event) => {
  const count = readBadgeMessage(event.data);
  if (count !== null) event.waitUntil(keepBadge({ base: count, tags: [] }).catch(() => {}));
});

async function openFromNotification(data: unknown): Promise<void> {
  const target = readTarget(data);
  const pages = (await sw.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((page) => {
    try {
      return !page.url || new URL(page.url).origin === sw.location.origin;
    } catch {
      return false;
    }
  });
  // The page you're looking at, else any that's open.
  const page = pages.find((p) => p.visibilityState === "visible") ?? pages[0];
  if (page) {
    page.postMessage({ type: "galahad:open", open: target.open, conversation: target.conversation ?? null });
    try {
      await page.focus?.();
      return;
    } catch {
      /* it couldn't be brought forward: open the place in a window of its own */
    }
  }
  await sw.clients.openWindow(notifyUrl(target));
}

sw.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openFromNotification(event.notification.data));
});

/** The browser replaced this device's subscription: an open page hands the new one to the node (the worker holds no key to sign with). */
sw.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(sw.clients.matchAll({ type: "window" }).then((pages) => pages.forEach((page) => page.postMessage({ type: "galahad:push-changed" }))));
});
