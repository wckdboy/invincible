import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/*
 * The service worker, loaded against stand-in caches and network: what a navigation
 * leaves in the cache the app opens from when it's offline.
 */

const ORIGIN = "https://node.test";
const stored = new Map<string, Response>();
const cache = {
  match: async (key: string) => stored.get(key)?.clone(),
  put: async (key: string, response: Response) => void stored.set(key, response),
  addAll: async () => {},
};
const pages: Record<string, () => Response> = {
  "/": () => new Response("<!doctype html><title>Galahad</title>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  "/index.html": () => new Response("<!doctype html><title>Galahad</title>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  "/bank/callback": () => new Response("<!doctype html><title>Galahad</title>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  "/sw.js": () => new Response("self.addEventListener('fetch', () => {})", { headers: { "content-type": "text/javascript; charset=utf-8" } }),
  "/manifest.webmanifest": () => new Response("{}", { headers: { "content-type": "application/manifest+json" } }),
};

const saved = { addEventListener: globalThis.addEventListener, location: (globalThis as any).location, caches: (globalThis as any).caches, fetch: globalThis.fetch, registration: (globalThis as any).registration, clients: (globalThis as any).clients };
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
/** The numbers the worker put on the app's icon (0: cleared). */
const badges: number[] = [];
let onFetch: (event: unknown) => void = () => {};
/** Every listener the worker registered, by event. */
const listeners = new Map<string, (event: any) => void>();

/** What the worker showed, and the pages and windows it reached, for the notification tests. */
const shown: { title: string; options: Record<string, any> }[] = [];
interface Page {
  url: string;
  visibilityState: string;
  messages: unknown[];
  focused: number;
  focus: () => Promise<void>;
  postMessage(message: unknown): void;
}
let windows: Page[] = [];
const opened: string[] = [];
const windowAt = (url: string, visibilityState = "visible"): Page => {
  const p: Page = { url, visibilityState, messages: [], focused: 0, postMessage: (message) => void p.messages.push(message), focus: async () => void (p.focused += 1) };
  return p;
};

beforeAll(async () => {
  (globalThis as any).addEventListener = (type: string, listener: (event: unknown) => void) => {
    if (type === "fetch") onFetch = listener;
    listeners.set(type, listener);
  };
  (globalThis as any).registration = { showNotification: async (title: string, options: Record<string, any>) => void shown.push({ title, options }) };
  (globalThis as any).clients = { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => void opened.push(url) };
  (globalThis as any).location = new URL(`${ORIGIN}/`);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { setAppBadge: async (n: number) => void badges.push(n), clearAppBadge: async () => void badges.push(0) } });
  (globalThis as any).caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  (globalThis as any).fetch = async (request: { url: string }) => (pages[new URL(request.url).pathname] ?? (() => new Response("no", { status: 404 })))();
  // A worker script, not a module: loaded for its listeners.
  const worker = "./sw.ts";
  await import(worker);
});

afterAll(() => {
  Object.assign(globalThis, { addEventListener: saved.addEventListener, location: saved.location, caches: saved.caches, fetch: saved.fetch, registration: saved.registration, clients: saved.clients });
  if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
});

/** Opens a URL in a tab: the page the worker answers with, once everything it started is done. */
async function navigate(path: string): Promise<Response> {
  let answer: Promise<Response> | null = null;
  const pending: Promise<unknown>[] = [];
  onFetch({ request: { method: "GET", mode: "navigate", url: `${ORIGIN}${path}` }, respondWith: (r: Promise<Response>) => (answer = r), waitUntil: (p: Promise<unknown>) => pending.push(p) });
  if (!answer) throw new Error(`the worker didn't answer ${path}`);
  const response = await answer;
  await Promise.all(pending);
  return response;
}

describe("opening the app offline", () => {
  test("the app's own page is what's kept, and only it", async () => {
    expect((await navigate("/")).status).toBe(200);
    expect(await stored.get("/")!.clone().text()).toContain("<title>Galahad</title>");
    // A script, the manifest or the bank's return opened in a tab is shown, never kept as the app.
    for (const path of ["/sw.js", "/manifest.webmanifest", "/bank/callback?code=fake-code&state=fake-state"]) {
      stored.set("/", pages["/"]!());
      expect((await navigate(path)).status).toBe(200);
      const kept = stored.get("/")!;
      expect(await kept.clone().text()).toContain("<title>Galahad</title>");
      expect(kept.url).not.toContain("fake-code");
    }
    stored.delete("/");
    await navigate("/index.html");
    expect(stored.get("/")).toBeDefined();
  });
});

/** Delivers an event to the worker and waits for everything it started. */
async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
  const listener = listeners.get(type);
  if (!listener) throw new Error(`the worker has no ${type} listener`);
  const pending: Promise<unknown>[] = [];
  listener({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}
const push = (data: unknown) => dispatch("push", { data: data === undefined ? null : { json: () => data } });
/** Taps the notification the worker showed last. */
async function tap(): Promise<{ closed: boolean }> {
  const state = { closed: false };
  await dispatch("notificationclick", { notification: { close: () => void (state.closed = true), data: shown.at(-1)!.options.data } });
  return state;
}

const CHAT = "cv_1234567890123456789012";
const finished = { v: 1, kind: "finished", title: "Galahad has finished", body: "A chat you left him working in has his answer.", open: "chat", conversation: CHAT, tag: "t-AbCdEfGhIjKlMnOpQrStUv" };

describe("he comes to you: a push becomes a notification", () => {
  test("a payload of ours is shown as it is: its title, its one line, where it opens", async () => {
    shown.length = 0;
    await push(finished);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Galahad has finished");
    // News is told quietly: no sound, and told again it replaces itself without a word (PLAN #59).
    expect(shown[0]!.options).toMatchObject({ body: "A chat you left him working in has his answer.", tag: "t-AbCdEfGhIjKlMnOpQrStUv", silent: true, renotify: false, icon: "/icon-192.png", data: { open: "chat", conversation: CHAT } });
    // In Android's status bar, the field in white: the system draws a badge from its alpha alone, so the tile would be a white square.
    expect(shown[0]!.options.badge).toBe("/icon-mono-96.png");
    // No picture: its words are the message, and a picture would only decorate it.
    expect(shown[0]!.options.image).toBeUndefined();
    // What needs you lets you know, every time, even replacing its own.
    await push({ v: 1, kind: "needs-you", title: "Galahad: this needs you", body: "Something in your Inbox needs you.", open: "inbox", tag: "t-0123456789abcdefghijkl" });
    expect(shown[1]!.options).toMatchObject({ silent: false, renotify: true, data: { open: "inbox" } });
    for (const kind of ["told", "limit"]) {
      await push({ v: 1, kind, title: "Galahad", body: "x", open: "inbox", tag: "t-0123456789abcdefghijkl" });
      expect(shown.at(-1)!.options).toMatchObject({ silent: true, renotify: false });
    }
    // Anything that isn't one of ours is the plain one, which may need you: it lets you know.
    await push({ kind: "advert" });
    expect(shown.at(-1)!.options).toMatchObject({ silent: false, renotify: true });
  });

  test("anything that isn't one of ours still shows a notification, and only the plain one: never what it says, never nothing", async () => {
    const strange: unknown[] = [
      undefined, // a push with no data
      { v: 1, kind: "advert", title: "Buy now", body: "Click here", open: "inbox", tag: "x" },
      { ...finished, open: "https://evil.example/login" },
      { ...finished, url: "https://evil.example/login" },
      { ...finished, title: "x".repeat(500) },
      { ...finished, body: `hidden${String.fromCharCode(0x202e)}override` },
      { ...finished, conversation: "../../evil" },
      ["an", "array"],
      42,
    ];
    for (const data of strange) {
      shown.length = 0;
      await push(data);
      expect(shown).toHaveLength(1);
      expect(shown[0]!.title).toBe("Galahad");
      expect(shown[0]!.options).toMatchObject({ body: "Something needs you. Open the app to see it.", data: { open: "inbox" } });
    }
    // Data that isn't even JSON (reading it throws): the plain one, still.
    shown.length = 0;
    await dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("not JSON");
        },
      },
    });
    expect(shown.map((s) => s.title)).toEqual(["Galahad"]);
  });
});

describe("the number on the app's icon", () => {
  test("starts from the count a page last set, and a push about something new that waits for you adds one", async () => {
    badges.length = 0;
    await dispatch("message", { data: { type: "galahad:badge", count: 2 } });
    await push({ v: 1, kind: "approval", title: "Galahad: approve this?", body: "Push to main", open: "inbox", tag: "t-approval0123456789abcd" });
    expect(badges).toEqual([3]);
    // The same thing told again, and news that doesn't wait for you, add nothing.
    await push({ v: 1, kind: "approval", title: "Galahad: approve this?", body: "Push to main", open: "inbox", tag: "t-approval0123456789abcd" });
    await push(finished);
    expect(badges).toEqual([3]);
    // A push that can't be read is still something that needs you.
    await push({ kind: "advert" });
    expect(badges).toEqual([3, 4]);
    // A page that has seen the Inbox sets it again: the next push counts from there.
    await dispatch("message", { data: { type: "galahad:badge", count: 0 } });
    await push({ v: 1, kind: "question", title: "Galahad asks", body: "Which branch?", open: "chat", conversation: CHAT, tag: "t-question0123456789abcd" });
    expect(badges).toEqual([3, 4, 1]);
  });

  test("a message that isn't a page's count changes nothing", async () => {
    await dispatch("message", { data: { type: "galahad:badge", count: 5 } });
    for (const data of [{ type: "galahad:badge", count: -1 }, { type: "galahad:badge", count: "9" }, { type: "something-else", count: 9 }, null]) await dispatch("message", { data });
    badges.length = 0;
    await push({ v: 1, kind: "needs-you", title: "Galahad: this needs you", body: "low on disk", open: "inbox", tag: "t-needsyou0123456789abcd" });
    expect(badges).toEqual([6]);
  });
});

describe("a tap opens the app at the right place", () => {
  test("in the window that's already open: it's told where to go and brought forward, and no second window opens", async () => {
    shown.length = 0;
    opened.length = 0;
    windows = [windowAt(`${ORIGIN}/#/overview`, "hidden"), windowAt(`${ORIGIN}/#/chat`, "visible")];
    await push(finished);
    const { closed } = await tap();
    expect(closed).toBe(true);
    // The page you're looking at, not just the first one.
    expect(windows[1]!.messages).toEqual([{ type: "galahad:open", open: "chat", conversation: CHAT }]);
    expect(windows[1]!.focused).toBe(1);
    expect(windows[0]!.messages).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("with no window open, one opens at that place: the Inbox, the chat, the overview", async () => {
    windows = [];
    for (const [payload, url] of [
      [finished, `/#/chat?c=${CHAT}`],
      [{ v: 1, kind: "needs-you", title: "Galahad: this needs you", body: "x", open: "inbox", tag: "t-0123456789abcdefghijkl" }, "/#/inbox"],
      [{ v: 1, kind: "finished", title: "Quest done", body: "A quest you started has ended.", open: "overview", tag: "t-0123456789abcdefghijkm" }, "/#/overview"],
    ] as const) {
      shown.length = 0;
      opened.length = 0;
      await push(payload);
      await tap();
      expect(opened).toEqual([url]);
    }
  });

  test("a page that can't be brought forward, or another site's, isn't relied on: the place opens in a window of its own", async () => {
    shown.length = 0;
    opened.length = 0;
    windows = [windowAt(`${ORIGIN}/#/overview`, "visible")];
    windows[0]!.focus = async () => {
      throw new Error("not allowed");
    };
    await push(finished);
    await tap();
    expect(opened).toEqual([`/#/chat?c=${CHAT}`]);
    opened.length = 0;
    windows = [windowAt("https://elsewhere.example/#/overview")];
    await tap();
    expect(windows[0]!.messages).toEqual([]);
    expect(opened).toEqual([`/#/chat?c=${CHAT}`]);
  });

  test("what a notification remembers is read again at the tap: it never opens anywhere but the app's own places", async () => {
    windows = [];
    const cases: [unknown, string][] = [
      [{ open: "https://evil.example" }, "/#/inbox"],
      [{ open: "vault" }, "/#/inbox"],
      [null, "/#/inbox"],
      ["text", "/#/inbox"],
      [{ open: "chat", conversation: "../x" }, "/#/chat"],
      [{ open: "overview", conversation: CHAT }, "/#/overview"],
      // A notification from before his journal was removed, still in the tray: the Inbox.
      [{ open: "journal" }, "/#/inbox"],
    ];
    for (const [data, url] of cases) {
      opened.length = 0;
      await dispatch("notificationclick", { notification: { close: () => {}, data } });
      expect(opened).toEqual([url]);
    }
  });

  test("when the browser replaces this device's subscription, open pages are told to hand the node the new one", async () => {
    windows = [windowAt(`${ORIGIN}/#/overview`)];
    await dispatch("pushsubscriptionchange", {});
    expect(windows[0]!.messages).toEqual([{ type: "galahad:push-changed" }]);
  });
});
