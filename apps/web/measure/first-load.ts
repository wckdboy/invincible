#!/usr/bin/env bun
/*
 * What does opening the PWA cost? One measurement, the same for any checkout, so a change to the
 * app is shown with its number before and after.
 *
 *   bun apps/web/measure/first-load.ts                     this checkout
 *   bun apps/web/measure/first-load.ts --repo <checkout>   another one, measured the same way
 *     --runs 9      loads per page, profile and kind (the median is reported, with the fastest and slowest);
 *                   0 measures nothing and only takes the screenshots
 *     --json <file> everything measured, as JSON
 *     --moves 5     also times moving between places in the app already open, as a person does (a look at the page,
 *                   a press, the tap; each place twice, so a revisit shows), this many times over on each profile;
 *                   with --runs 0, only that
 *     --shots <dir> also screenshots, 390 and 1280 px, light and dark: the Roundtable (as a board, as a list, its
 *                   knights being arranged, and led by a knight), Galahad's timeline (and a message of yours that
 *                   carried files, and the message box with two waiting to go), a knight's
 *                   with a task running, one whose task kept its changes, one whose task failed, a room's work, a
 *                   knight's Workspace with its desktop, a task's own thread (at work, verified, failed), a task
 *                   given to the Roundtable (where the app can), every
 *                   place the app has (its lib/nav.ts), each as far down as it goes too ("-full"), the sheets and
 *                   forms its places open, and the gallery of its components (apps/web/design/gallery.ts, where the
 *                   checkout has one). The same addresses on any checkout, so an older app is shown at the same places
 *                   (a mode it doesn't have is said, and not shot).
 *     --widths 390,1280,1600  the screenshots' widths instead (under 640 is a phone held upright)
 *     --gallery <dir> only the gallery's screenshots: no node is started
 *     --shifts      also what moves on screen once it is there: each place (and Galahad's, a knight's and a room's
 *                   timeline) opened as a returning visit opens it, on both profiles, watched from its first frame
 *                   until 3 s after it is usable; every layout shift is summed (the place's
 *                   cumulative layout shift), with what moved. --shift-runs n opens each that many times (default 3).
 *     --places a,b  only these places (their names as the report gives them: overview, knight, sheet-add-key…), for
 *                   --shots and --shifts
 *     --rest        only what Chat and the Roundtable cost at rest, and what they ask the node for (below): no page
 *                   loads are measured
 *
 * It starts a throwaway node on loopback (a temp home, the file keystore, a stand-in Docker and
 * stand-in models: nothing leaves this machine, and ~/.galahad is never touched), fills it with a
 * few knights (one with a desktop in its VM), a room, tasks (running, waiting, verified with kept
 * changes, failed) and trials, a kept chat, a quest in hand and one thing that needs you, pairs a
 * headless Chrome with it through the real pairing page, and then opens pages the way a browser does:
 *
 *   cold   nothing cached and no service worker: the first visit after pairing
 *   warm   the service worker holds the shell: every visit after that
 *
 * on two profiles: "laptop" (1280×800, this machine as it is) and "phone" (390×844, the processor
 * slowed 4×, 9 Mbit/s down, 1.5 up and 60 ms a request: an emulation, not a phone).
 *
 * What it reports, per page:
 *   paint    first contentful paint (the browser's own mark; the boot emblem, before any script)
 *   shell    the app's shell is in the page (the device key is read and the node has answered)
 *   usable   the page's own content has replaced every loading placeholder, and a frame was drawn
 *   blocked  time the main thread was held past 50 ms at a stretch, up to "usable"
 *   nodes    elements in the page at "usable"
 * and for the first visit: every request, with its bytes on the wire, each of the app's files as
 * the node sends it (raw, gzip, brotli), and where the main thread's time went (script, style,
 * layout, paint, parsing), from Chrome's own trace. For Chat and the Roundtable it also says what the page
 * costs while nothing changes, over ten seconds: the page's main thread's time a second, and the processor time a
 * second of the page's whole renderer (its main thread, compositor, raster and workers) and of every process of the
 * browser (its GPU process drawing the frames among them); and, over a minute, every request each asks the node
 * for meanwhile, by path.
 *
 * Timings move with the machine's load: compare two checkouts measured one after the other, and
 * trust a difference only when the ranges don't overlap. Bytes, requests and nodes don't move.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../../../packages/node/test/ports.ts";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const REPO = resolve(flag("repo") ?? join(dirname(fileURLToPath(import.meta.url)), "../../.."));
const RUNS = Math.max(0, Number(flag("runs") ?? 9));
const JSON_OUT = flag("json");
const SHOTS = flag("shots");
/** The widths the screenshots are taken at: a phone's (under 640, upright) and any wider screen's. */
const WIDTHS = (flag("widths") ?? "390,1280").split(",").map((width) => Math.round(Number(width))).filter((width) => width >= 320 && width <= 3840);
const GALLERY = flag("gallery");
const SHIFTS = process.argv.includes("--shifts");
const SHIFT_RUNS = Math.max(1, Number(flag("shift-runs") ?? 3));
const ONLY = flag("places")?.split(",").map((name) => name.trim());
/** Whether a place named so is to be shot or watched (--places). */
const wanted = (name: string): boolean => !ONLY || ONLY.includes(name);
const MOVES = Math.max(0, Number(flag("moves") ?? 0));
/** Only the cost at rest (--rest): no loads. */
const REST = process.argv.includes("--rest");
/** Chrome, wherever this machine keeps it (CHROME names another). */
const CHROME =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) => Bun.which(name) ?? "")].find((path) => path && existsSync(path)) ??
  "";
if (!existsSync(CHROME)) throw new Error(`No Chrome found. Set CHROME to a Chrome or Chromium binary.`);

// The node's key goes to a file in the temp home, never to the OS keychain.
process.env.GALAHAD_KEYSTORE = "file";
// Nor does it read the MCP library's index from mcp.galahad.sh unless told to (GALAHAD_MCP_INDEX): the reviewed list stays.
process.env.GALAHAD_MCP_INDEX ??= "off";
const tmp = mkdtempSync(join(tmpdir(), "galahad-web-measure-"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ---------- the browser, over the DevTools protocol (one connection, a session per target) ----------
interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}
class Chrome {
  private next = 0;
  private readonly waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private constructor(
    private readonly ws: WebSocket,
    private readonly proc: ReturnType<typeof Bun.spawn>,
  ) {
    ws.addEventListener("message", (message) => {
      const m = JSON.parse(String(message.data));
      if (m.id === undefined) {
        for (const listener of this.listeners) listener(m);
        return;
      }
      const asked = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error) asked?.reject(new Error(m.error.message));
      else asked?.resolve(m.result);
    });
  }
  static async launch(profile: string): Promise<Chrome> {
    const proc = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        // Never the macOS keychain: Chrome's own storage key comes from a mock one.
        "--use-mock-keychain",
        "--password-store=basic",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        // No name but this machine's resolves: the browser can reach nothing else.
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost",
        // Inside a container that can't make Chrome's sandbox (sovware.io's CI runner), on its word alone: it loads
        // nothing but this machine's own app (the line above).
        ...(process.env.GALAHAD_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    // What it says is kept only while it runs (its last few thousand characters), and read all along, so a full pipe
    // never stalls it: if it doesn't start, its last lines say why.
    let said = "";
    void (async () => {
      const text = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) said = (said + text.decode(chunk, { stream: true })).slice(-4000);
    })().catch(() => {});
    const ended = { code: null as number | null };
    void proc.exited.then((code) => (ended.code = code));
    // A cold machine's first start can be slow (a CI runner builds Chrome's font cache then): it is waited for while it
    // runs, up to a minute. One that exits fails at once, with what it said.
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 600 && !existsSync(portFile) && ended.code === null; i++) await sleep(100);
    if (!existsSync(portFile)) {
      proc.kill();
      const last = said.trim().split("\n").slice(-6).join("\n");
      throw new Error(`${ended.code === null ? "Chrome never wrote down its DevTools port in a minute" : `Chrome exited (${ended.code}) before it wrote down its DevTools port`}${last ? `:\n${last}` : ""}`);
    }
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((done, fail) => {
      ws.addEventListener("open", () => done(), { once: true });
      ws.addEventListener("error", () => fail(new Error("no DevTools connection")), { once: true });
    });
    return new Chrome(ws, proc);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(listener: (event: CdpEvent) => void): void {
    this.listeners.add(listener);
  }
  off(listener: (event: CdpEvent) => void): void {
    this.listeners.delete(listener);
  }
  /** Asked to close; ended by its own pid if it hasn't gone. */
  async close(): Promise<void> {
    await Promise.race([this.send("Browser.close").catch(() => {}), sleep(3000)]);
    if (!(await Promise.race([this.proc.exited.then(() => true), sleep(5000).then(() => false)]))) this.proc.kill();
  }
}

/** What Gawain's desktop shows: a plain stand-in page in a browser's frame (no real site, nothing fetched). */
const DESKTOP_PAGE = `<!doctype html><html><body style="margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1d1d1f;background:#fff">
<div style="height:44px;background:#dfe1e5;display:flex;align-items:center;gap:10px;padding:0 14px"><span style="width:12px;height:12px;border-radius:50%;background:#bbb"></span><span style="width:12px;height:12px;border-radius:50%;background:#bbb"></span>
<div style="flex:1;background:#fff;border-radius:16px;padding:5px 16px;color:#444">https://dashboard.example/exports</div></div>
<div style="display:flex;height:756px"><aside style="width:220px;background:#f3f4f6;padding:28px 20px;color:#555"><b style="color:#111">Example dashboard</b><p>Overview</p><p>Customers</p><p style="color:#111;font-weight:600">Exports</p><p>Settings</p></aside>
<main style="flex:1;padding:36px 48px"><h1 style="margin:0 0 8px;font-size:28px">Exports</h1><p style="color:#555;margin:0 0 28px">Monthly exports are kept for twelve months.</p>
<table style="border-collapse:collapse;width:100%;font-size:15px"><tr style="text-align:left;color:#666"><th style="padding:10px 0">Month</th><th>Rows</th><th>Size</th><th></th></tr>
<tr style="border-top:1px solid #e5e7eb"><td style="padding:14px 0">November 2026</td><td>18,204</td><td>2.1 MB</td><td><span style="background:#111;color:#fff;border-radius:8px;padding:8px 14px">Download CSV</span></td></tr>
<tr style="border-top:1px solid #e5e7eb"><td style="padding:14px 0">October 2026</td><td>17,880</td><td>2.0 MB</td><td><span style="border:1px solid #ccc;border-radius:8px;padding:8px 14px">Download CSV</span></td></tr>
<tr style="border-top:1px solid #e5e7eb"><td style="padding:14px 0">September 2026</td><td>16,951</td><td>1.9 MB</td><td><span style="border:1px solid #ccc;border-radius:8px;padding:8px 14px">Download CSV</span></td></tr></table></main></div></body></html>`;

// ---------- what is measured ----------
// (The first visit to the first one is the one whose requests and files are listed. A wide screen opens on Chat,
// with the roster beside it; a phone on the roster itself, which is the Roundtable's address. A room is a timeline.)
// (A kept chat, at its own address, is the same page on any checkout; it is added once the node holds one.)
const PAGES: { name: string; hash: string }[] = [
  { name: "Chat", hash: "#/chat" },
  { name: "Roundtable", hash: "#/team" },
  { name: "Room", hash: "#/team?room=forge" },
  { name: "Overview", hash: "#/overview" },
];
/** Two files given to the message box through its own file input, as a person's choice gives them, and words to go with them. */
const ATTACHING = `(async () => {
  const input = document.querySelector(".composer input[type=file]");
  if (!input) throw new Error("this app takes no files with a message");
  const picture = await (await fetch("/icon-192.png")).blob();
  const files = new DataTransfer();
  files.items.add(new File([picture], "icon.png", { type: "image/png" }));
  files.items.add(new File(["FAIL db.test.ts\\n  connect ECONNREFUSED 127.0.0.1:5432\\n"], "test.log", { type: "text/plain" }));
  input.files = files.files;
  input.dispatchEvent(new Event("change"));
  const box = document.querySelector(".composer textarea");
  box.value = "Why does this fail?";
  box.dispatchEvent(new Event("input"));
})()`;
const PROFILES = {
  laptop: { width: 1280, height: 800, scale: 2, mobile: false, cpu: 1, network: null },
  phone: { width: 390, height: 844, scale: 3, mobile: true, cpu: 4, network: { latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 } },
} as const;
type Profile = keyof typeof PROFILES;

/*
 * Runs in every page before its own scripts: when the shell arrives, when the page is usable,
 * and how long the main thread was held on the way. "Usable" is the first frame after the page's
 * own content is there with no loading placeholder left in it.
 */
function watchPage(): void {
  if (!location.protocol.startsWith("http")) return;
  const m = { shell: null as number | null, usable: null as number | null, blocked: 0, shifts: [] as { at: number; value: number; moved: string[] }[] };
  (window as unknown as { __measure: typeof m }).__measure = m;
  try {
    new PerformanceObserver((list) => {
      if (m.usable === null) for (const entry of list.getEntries()) m.blocked += Math.max(0, entry.duration - 50);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* no long-task timing here: blocked stays 0 */
  }
  // What moved on screen while nobody touched it: each layout shift, with what moved (a short path to it) and how.
  type Rect = { x: number; y: number; width: number; height: number };
  type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node: Node | null; previousRect: Rect; currentRect: Rect }[] };
  const describe = (node: Node | null, from: Rect, to: Rect): string => {
    const path: string[] = [];
    for (let el = node instanceof Element ? node : (node?.parentElement ?? null); el && el !== document.body && path.length < 3; el = el.parentElement) {
      path.unshift(`${el.tagName.toLowerCase()}${[...el.classList].slice(0, 2).map((name) => `.${name}`).join("")}`);
    }
    const move = (a: number, b: number) => (Math.round(a) === Math.round(b) ? "" : ` ${Math.round(a)}→${Math.round(b)}`);
    return `${path.join(" > ") || "#text"}${move(from.y, to.y) ? ` y${move(from.y, to.y)}` : ""}${move(from.x, to.x) ? ` x${move(from.x, to.x)}` : ""}${move(from.height, to.height) ? ` h${move(from.height, to.height)}` : ""}`;
  };
  try {
    // Every shift counts, whatever hadRecentInput says: nothing touches the page while it is watched, and Chrome marks
    // every shift as following input when it emulates a phone (mobile: true), so heeding it would see none there.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Shift[]) {
        m.shifts.push({ at: Math.round(entry.startTime), value: entry.value, moved: (entry.sources ?? []).map((source) => describe(source.node, source.previousRect, source.currentRect)) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* no layout-shift timing here: none is seen */
  }
  const there = (): boolean => {
    const main = document.querySelector(".shell main");
    if (!main || main.querySelector(".skeleton")) return false;
    // (A new chat holds a place for your recent chats until the node has said which they are.)
    // (A kept chat, once its answer is drawn.)
    if (location.hash.startsWith("#/chat")) return Boolean(main.querySelector(".chat .composer")) && (!location.hash.includes("c=") || Boolean(main.querySelector(".turn.assistant")));
    if (!location.hash.startsWith("#/team")) return Boolean(main.querySelector(".page-head h1"));
    // (A knight's Workspace: the panel, or on an older app its tab.)
    if (location.hash.includes("tab=workspace")) return Boolean(main.querySelector(".team-panel"));
    if (location.hash.includes("room=")) return Boolean(main.querySelector(".team-message, .team-task"));
    // (The knights' rows: in the page's own list, in the roster that was the sidebar and a phone's first screen, or, since
    // 26 November 2026, on the Roundtable's own page, its cards or its list.)
    return Boolean(document.querySelector(".team-nav-row[data-key], .roster-row[data-key^='person:'], main [data-key^='person:']"));
  };
  // (For timing a move in the app already open: whether the page now on screen is there.)
  (window as unknown as { __there: () => boolean }).__there = there;
  let seen = false;
  const watch = new MutationObserver(() => {
    if (m.shell === null && document.querySelector(".shell")) m.shell = performance.now();
    if (seen || !there()) return;
    seen = true;
    watch.disconnect();
    requestAnimationFrame(() => setTimeout(() => (m.usable = performance.now())));
  });
  watch.observe(document, { childList: true, subtree: true, attributes: true });
}

/**
 * The gallery of the app's components (apps/web/design/gallery.ts), served on loopback as the app is: its stylesheet
 * (the head of index.html), its font and its pictures, with the gallery's own script in place of the app's. Null when
 * the checkout has none.
 */
async function serveGallery(repo: string): Promise<{ url: string; stop(): void } | null> {
  const entry = join(repo, "apps/web/design/gallery.ts");
  if (!existsSync(entry)) return null;
  const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const script = await built.outputs[0]!.text();
  const index = readFileSync(join(repo, "apps/web/src/index.html"), "utf8");
  const page = `${index.slice(0, index.indexOf("<body>"))}<body><div id="gallery"></div><script type="module" src="/gallery.js"></script></body></html>`;
  const src = join(repo, "apps/web/src");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/gallery.js") return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (/^\/(fonts\/[a-z-]+\.woff2|knights\/[a-z-]+(@2x)?\.webp)$/.test(path) && existsSync(join(src, path))) return new Response(Bun.file(join(src, path)));
      return new Response("", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

/** Shots of the gallery, top to bottom, at each size in each theme: `gallery-<width>-<theme>.png`. */
async function shootGallery(browser: Chrome, page: string, dir: string, repo: string): Promise<string[]> {
  const gallery = await serveGallery(repo);
  if (!gallery) {
    console.error("this checkout has no gallery (apps/web/design/gallery.ts): no screenshots of it");
    return [];
  }
  const files: string[] = [];
  try {
    for (const theme of ["light", "dark"]) {
      for (const [width, height, mobile] of [[390, 844, true], [1280, 800, false]] as const) {
        await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] }, page);
        await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile }, page);
        await browser.send("Emulation.setTouchEmulationEnabled", { enabled: mobile }, page);
        await browser.send("Page.navigate", { url: gallery.url }, page);
        for (let i = 0; i < 100; i++) {
          const { result } = await browser.send("Runtime.evaluate", { expression: `Boolean(document.querySelector("#gallery [data-ready]"))`, returnByValue: true }, page);
          if (result.value) break;
          await sleep(100);
        }
        await sleep(600);
        const { cssContentSize } = await browser.send("Page.getLayoutMetrics", {}, page);
        const { data } = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(cssContentSize.height), scale: 1 } }, page);
        const file = join(dir, `gallery-${width}-${theme}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        files.push(file);
      }
    }
  } finally {
    gallery.stop();
  }
  return files;
}

interface Wire {
  path: string;
  status: number;
  bytes: number;
  encoding: string;
  by: "page" | "service worker";
  from: "network" | "service worker" | "cache";
  /** An answer that stays open (server-sent events): it is never waited for to end. */
  stream?: boolean;
}
interface Load {
  paint: number;
  shell: number;
  usable: number;
  blocked: number;
  nodes: number;
  wire: Wire[];
}
interface Spread {
  median: number;
  min: number;
  max: number;
}
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};
const spread = (values: number[]): Spread => ({ median: Math.round(median(values)), min: Math.round(Math.min(...values)), max: Math.round(Math.max(...values)) });
/** A page's loads in one line: its times as median and range; what doesn't move from load to load, from the first. */
const summary = (loads: Load[]) => ({
  paint: spread(loads.map((l) => l.paint)),
  shell: spread(loads.map((l) => l.shell)),
  usable: spread(loads.map((l) => l.usable)),
  blocked: spread(loads.map((l) => l.blocked)),
  nodes: loads[0]!.nodes,
  requests: loads[0]!.wire.length,
  bytes: loads[0]!.wire.reduce((sum, w) => sum + w.bytes, 0),
});
type Summary = ReturnType<typeof summary>;

let chrome: Chrome | null = null;
let daemon: { stop(): Promise<void> } | null = null;
let model: ReturnType<typeof Bun.serve> | null = null;
const held: (() => void)[] = [];
async function tidy(): Promise<void> {
  for (const release of held.splice(0)) release();
  await chrome?.close().catch(() => {});
  await daemon?.stop().catch(() => {});
  model?.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void tidy().finally(() => process.exit(130)));

// Only the gallery: a browser and the gallery's page, no node.
if (GALLERY) {
  try {
    mkdirSync(GALLERY, { recursive: true });
    chrome = await Chrome.launch(join(tmp, "chrome"));
    const { targetInfos } = await chrome.send("Target.getTargets");
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId: targetInfos.find((t: { type: string }) => t.type === "page").targetId, flatten: true });
    await chrome.send("Page.enable", {}, sessionId);
    const files = await shootGallery(chrome, sessionId, GALLERY, REPO);
    console.log(`${files.length} screenshots of the gallery in ${resolve(GALLERY)}`);
  } finally {
    await tidy();
  }
  process.exit(0);
}

try {
  const from = (path: string): Promise<any> => import(join(REPO, path));
  const core = await from("packages/core/src/index.ts");
  const { foundFleet, MindStore } = await from("packages/mind/src/index.ts");
  const { startDaemon } = await from("packages/node/src/daemon.ts");
  const { Home } = await from("packages/node/src/home.ts");
  const { buildAssets } = await from("packages/node/src/assets.ts");
  const { fakeDocker } = await from("packages/node/test/fake-docker.ts");
  // The app's places, by its own list: every one is shot and watched for shifts.
  const places = (await from("apps/web/src/lib/nav.ts")).PLACES as readonly { id: string; label: string }[];
  const routes = core.routes as Record<string, { method: string; path: string }>;
  const revision = new TextDecoder().decode(Bun.spawnSync(["git", "-C", REPO, "rev-parse", "--short", "HEAD"]).stdout).trim() || "not a git checkout";
  const dirty = new TextDecoder().decode(Bun.spawnSync(["git", "-C", REPO, "status", "--porcelain", "--", "apps/web/src", "packages"]).stdout).trim() ? " + uncommitted changes" : "";

  // ---------- a throwaway node ----------
  const home = new Home(join(tmp, "home"));
  const port = freePort();
  const { identity, keystore } = await home.createIdentity("file");
  if (keystore !== "file") throw new Error(`the node's key went to the ${keystore} keystore, not a file`);
  const mind = new MindStore(home.mindPath);
  const fleet = foundFleet(mind, identity, { fleetName: "measure", nodeName: "keep" });
  mind.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  const caps = { os: "linux", arch: "x64", hostname: "keep", cores: 16, cpu: "stand-in", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
  // Ada's task stays at its first command until the run ends, so one knight is always working; so does a task given to
  // the Roundtable here. Gareth's gate can't run in its VM. Gawain's VM has a desktop, whose picture is drawn below.
  const docker = fakeDocker();
  let adaAtWork = false;
  let desktopShot = "";
  const hold = new Promise<void>((release) => held.push(release));
  docker.onExec = async (_container: string, command: string[]) => {
    const text = command.join("\n");
    if (text.includes("write-sync")) {
      adaAtWork = true;
      await hold;
    }
    if (text.includes("write-give")) await hold;
    if (text.includes("desktop shot")) return { code: 0, stdout: desktopShot };
    if (text.includes("gate-fail")) return { code: 1, stdout: "", stderr: "error: connect ECONNREFUSED 127.0.0.1:5432" };
    return { code: 0, stdout: text.includes("gate-") ? "required gate passed" : "command completed" };
  };
  // The browser comes in as a phone does behind `tailscale serve`: through the proxied port.
  const proxyPort = freePort();
  const started = await startDaemon(home, {
    capabilities: caps,
    proxyPort,
    log: () => {},
    docker: docker.runner,
    measure: async (reason: string, body: unknown, limit: unknown) => {
      const threads = core.ceilingThreads(body, limit);
      return { at: Date.now(), tookMs: 1, reason, body: core.bodyFingerprint(body, limit), cpu: { single: core.REFERENCE_SINGLE, multi: core.REFERENCE_SINGLE * threads, threads, kernel: core.KERNEL } };
    },
    loopIntervalMs: 3_600_000,
    defaultHeartbeat: false,
    archiveIntervalMs: false,
    shutdownGraceMs: 100,
  });
  daemon = started;
  const origin = `http://127.0.0.1:${proxyPort}`;
  const admin = async (name: string, input?: unknown): Promise<any> => {
    const route = routes[name];
    if (!route) throw new Error(`this checkout has no route named ${name}`);
    const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      method: route.method,
      headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
      body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  const until = async (what: string, probe: () => unknown | Promise<unknown>, timeoutMs = 20_000): Promise<void> => {
    const end = Date.now() + timeoutMs;
    let trouble = "";
    while (Date.now() < end) {
      try {
        if (await probe()) return;
      } catch (error) {
        // A page between two documents can't be asked: asked again.
        trouble = `: ${(error as Error).message}`;
      }
      await sleep(50);
    }
    throw new Error(`waited ${timeoutMs / 1000} s for ${what}${trouble}`);
  };

  // ---------- stand-in models, and what the pages show ----------
  // Percival's answer never comes while the run lasts, so one knight is always thinking.
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch: async (request) => {
      const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: unknown }[] };
      const turns = body.messages.filter((message) => message.role !== "system");
      if (JSON.stringify(turns).includes("Take your time")) await hold;
      let text = "Understood. I will take the part that is mine and say when it is done.";
      const goal = JSON.stringify(turns[0] ?? "");
      if (goal.includes("TASK_")) {
        text = "1. Make the change.\n2. Run the required gate.\nDone when: the gate and independent review pass.";
        const write = goal.includes("TASK_KEEP") ? "write-keep" : goal.includes("TASK_GIVE") ? "write-give" : "write-sync";
        if (body.model === "engineer") {
          if (goal.includes("TASK_FAIL")) text = "GIVE UP\nThe gate needs a Postgres this VM does not have: `bun test db/` exits 1 before any work, with ECONNREFUSED on 127.0.0.1:5432. Nothing in the workspace can start one; a task that brings the database up first would.";
          else if (goal.includes("TASK_KEEP") && turns.some((message) => message.role === "assistant")) text = "DONE\nThe importer reads ISO 8601 dates and the old day-first form; four new tests cover both, and the gate passes.";
          else if (turns.some((message) => message.role === "assistant")) text = "DONE\nVerified.";
          // Offered its own tools (a knight on the roster's models: quest.ts tools), it calls bash, as a real one does.
          else if (body.tools?.length) {
            const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stand_in", function: { name: "bash", arguments: JSON.stringify({ command: `printf done > result.txt # ${write}` }) } }] } }] };
            return new Response(`data: ${JSON.stringify(call)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
          } else text = `\`\`\`sh\nprintf done > result.txt # ${write}\n\`\`\``;
        } else if (body.model === "reviewer") text = "PASS\nThe required gate passed and execution evidence supports the result.";
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  await until("the node's calibration", () => started.store.lww(`calibration:${started.identity.id}`) !== null);
  await admin("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  for (const role of ["planner", "engineer", "reviewer", "swift"]) await admin("setRoster", { role, models: [`stand-in/${role}`] });
  const knights = [
    { id: "ada", name: "Ada", role: "engineer", instructions: "Builds the sync engine and keeps its tests green." },
    { id: "lin", name: "Lin", role: "engineer", instructions: "Owns the PWA: fast, plain and legible." },
    { id: "kay", name: "Kay", role: "planner", instructions: "Breaks large work into tasks that can be checked." },
    { id: "bors", name: "Bors", role: "reviewer", instructions: "Reviews what the others ship, independently.", enabled: false },
    { id: "percival", name: "Percival", role: "planner", instructions: "Researches the questions the others park." },
    { id: "gareth", name: "Gareth", role: "engineer", instructions: "Keeps the database layer and its migrations honest." },
    { id: "gawain", name: "Gawain", role: "engineer", instructions: "Works the web through a browser: signs in, downloads, checks pages." },
  ];
  for (const knight of knights) await admin("saveTeammate", knight);
  // Room for every knight's VM at once: by default the stand-in machine's ceiling (half of it) allows two sandboxes.
  await admin("setComputeLimit", { node: started.identity.id, cores: 16, memoryGb: 32, sandboxes: 6 });
  const idle = async () => !(await admin("team")).deliveries.some((d: { status: string; teammate: string }) => !["percival", "ada"].includes(d.teammate) && (d.status === "queued" || d.status === "running"));
  const ended = (id: string) => async () => !["queued", "running"].includes((await admin("team")).tasks.find((t: { id: string }) => t.id === id)?.status ?? "queued");
  await admin("saveTeamRoom", { id: "forge", name: "Forge", members: ["ada", "lin", "kay"], turnBudget: 3 });
  await admin("postTeamMessage", { room: "forge", text: "Plan the release together: who takes the sync engine, who takes the app, and what proves each is done?" });
  await until("the room's conversation", idle);
  const first = (await admin("createTeamTask", { room: "forge", assignee: "ada", title: "Sync survives a dropped connection", goal: "TASK_SYNC: make sync resume after a dropped connection, with a test that drops it.", dependsOn: [], gates: ["test -f result.txt # gate-sync"] })).task;
  await until("Ada's task to start", () => adaAtWork);
  await admin("createTeamTask", { room: "forge", assignee: "lin", title: "The app says when sync resumed", goal: "TASK_APP: show a quiet line when sync resumes.", dependsOn: [first.id], gates: ["test -f result.txt # gate-app"] });
  const { room: direct } = await admin("directTeammate", { id: "percival" });
  await admin("postTeamMessage", { room: direct.id, text: "Take your time: what do other agents do about context rot?" });
  await until("Percival to start thinking", async () => (await admin("team")).deliveries.some((d: { status: string; teammate: string }) => d.teammate === "percival" && d.status === "running"));
  // Each knight's own conversation with you, and in it: Ada asked while she works (her task is in the Forge), Kay's task
  // verified with its changes kept, Gareth's given up, Gawain's VM made with a desktop.
  const own: Record<string, string> = {};
  for (const id of ["ada", "kay", "gareth", "gawain"]) own[id] = (await admin("directTeammate", { id })).room.id;
  await admin("postTeamMessage", { room: own.ada, text: "How is the sync fix going? Say what the gate prints when you have it." });
  await admin("postTeamMessage", { room: own.gawain, text: "Once your VM has its desktop, can you fetch this month's export from the dashboard?" });
  await until("Gawain's reply", idle);
  const kept = (await admin("createTeamTask", { room: own.kay, assignee: "kay", title: "The importer reads ISO dates", goal: "TASK_KEEP: make the importer read ISO 8601 dates as well as the day-first form, with tests.", dependsOn: [], gates: ["bun test importer # gate-keep"] })).task;
  await until("Kay's task to end", ended(kept.id), 45_000);
  const failing = (await admin("createTeamTask", { room: own.gareth, assignee: "gareth", title: "Migrations run on a fresh database", goal: "TASK_FAIL: make every migration run on a fresh database, with a test.", dependsOn: [], gates: ["bun test db/ # gate-fail"] })).task;
  await until("Gareth's task to end", ended(failing.id), 45_000);
  await admin("provisionTeammate", { id: "gawain", desktop: true });
  // Kay's task kept what it changed: a real artifact on this node (its patch), named on the task as the runner names it
  // when a repository's changes are kept. (The stand-in Docker has no repository to diff.)
  const patch = "diff --git a/src/importer.ts b/src/importer.ts\n--- a/src/importer.ts\n+++ b/src/importer.ts\n@@ -12,3 +12,6 @@\n-  const [d, m, y] = text.split(\"/\");\n+  if (/^\\d{4}-\\d{2}-\\d{2}/.test(text)) return new Date(text);\n+  const [d, m, y] = text.split(\"/\");\n";
  const artifact = await started.artifacts.save(async (_sandbox: string, _from: string, dest: string) => {
    writeFileSync(join(dest, "changes.patch"), patch);
    return { files: [{ path: "changes.patch", size: patch.length, sha256: new Bun.CryptoHasher("sha256").update(patch).digest("hex") }], bytes: patch.length, skipped: [] };
  }, { sandbox: (await admin("team")).teammates.find((knight: { id: string }) => knight.id === "kay").workspace.id, path: `/work/out/tasks/${kept.id}`, label: `${kept.title} · kay · verified` });
  const { Database } = await import("bun:sqlite");
  const teamDb = new Database(join(home.dir, "team.db"));
  teamDb.query("UPDATE team_jobs SET data = json_set(data, '$.changes', json(?)) WHERE id = ?").run(JSON.stringify({ artifact: artifact.id, files: 3, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" }), kept.id);
  teamDb.close();
  const problems = [
    { problem: "rlc-step", title: "Step response of a series RLC circuit", domain: "electrical" },
    { problem: "beam-deflection", title: "Deflection of a loaded cantilever", domain: "mechanical" },
    { problem: "orbit-transfer", title: "Delta-v of a Hohmann transfer", domain: "orbital" },
    { problem: "heat-fin", title: "Heat lost by a straight fin", domain: "thermal" },
  ];
  for (const [n, run] of ["r-one", "r-two"].entries()) {
    await admin("startTrialRun", { run, suite: "engineering", effort: 1 });
    for (const [i, problem] of problems.entries()) {
      const ok = i <= n + 1;
      await admin("recordTrial", {
        run,
        suite: "engineering",
        ...problem,
        seed: 7 + i,
        status: "scored",
        score: ok ? 1 : 0.5,
        answers: [
          { key: "first", units: "1", expected: 0.25, got: 0.2501, tolerance: 0.00075, ok: true },
          { key: "second", units: "s", expected: 560.9, got: ok ? 560.8 : 600, tolerance: 1.68, ok },
        ],
        quest: { status: "done", steps: 4 + i, revisions: ok ? 0 : 1 },
        models: ["stand-in/engineer"],
        version: "abc1234",
        seconds: 90 + 20 * i,
      });
    }
  }
  // A kept chat (asked through the real chat route, answered by the stand-in), a quest in hand and a key he asked for.
  const asked = await fetch(`http://127.0.0.1:${port}${routes.chat!.path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "planner", save: true, tools: false, messages: [{ role: "user", content: "What is left before the release, in order?" }] }),
  });
  const conversation = /"(cv_[A-Za-z0-9_-]{22})"/.exec(await asked.text())?.[1];
  if (!asked.ok || !conversation) throw new Error(`the kept chat wasn't made: ${asked.status}`);
  await until("the kept chat's turn to end", async () => (await admin("turns")).turns.length === 0);
  PAGES.push({ name: "Kept chat", hash: `#/chat?c=${conversation}` });
  // A kept chat whose message carried a picture and a text (where the node takes files with a message): the app's icon,
  // and notes on it.
  let attachedChat: string | null = null;
  if (routes.uploadAttachment) {
    const up = async (name: string, type: string, bytes: Uint8Array) => (await admin("uploadAttachment", { name, type, data: Buffer.from(bytes).toString("base64") })).attachment;
    const drawing = await up("icon.png", "image/png", new Uint8Array(readFileSync(join(REPO, "apps/web/src/icon-192.png"))));
    const notes = await up("icon-notes.md", "text/plain", new TextEncoder().encode("# The icon\n\nGalahad's helm, as the home screen shows it: 192 pixels square.\n"));
    const sent = await fetch(`http://127.0.0.1:${port}${routes.chat!.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "planner", save: true, tools: false, messages: [{ role: "user", content: "Is this how the icon should look on a phone?", attachments: [drawing, notes] }] }),
    });
    attachedChat = /"(cv_[A-Za-z0-9_-]{22})"/.exec(await sent.text())?.[1] ?? null;
    if (!sent.ok || !attachedChat) throw new Error(`the kept chat with files wasn't made: ${sent.status}`);
    await until("the kept chat with files to be answered", async () => (await admin("turns")).turns.length === 0);
  }
  await admin("questProgress", { quest: "measure-1", goal: "Make sync resume after a dropped connection", state: "working", plan: "1. Reproduce the drop.\n2. Resume from the last acknowledged entry.\n3. Run the gate.", step: 3, maxSteps: 30, doing: "bun test packages/link", revisions: 0, gates: [{ command: "bun test packages/link", by: "owner", exitCode: null }] });
  await admin("requestSecret", { name: "github-token", purpose: "To open the pull request for the sync fix." });
  // What he knows of you (with routes any checkout has): a fact you kept, and one he noticed, waiting for you.
  await admin("remember", { text: "Short answers, the command first.", tags: ["about-you"] });
  const { token: noticer } = await admin("mintArm", { label: "measure-noticer" });
  await fetch(`http://127.0.0.1:${port}${routes.remember!.path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${noticer}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "Writes in British English.", tags: ["about-you"] }),
  });
  // Your tripwires, where the checkout has them (an older one's Loops page has none to show).
  if (routes.setRule) {
    await admin("setRule", { name: "no-lockfiles", does: "refuse", words: ["*.lock", "package-lock.json"] });
    await admin("setRule", { name: "no-env-files", does: "halt", words: [".env*"] });
  }
  // A hosted MCP server from the library, added and waiting for your sign-in, where the checkout has the library (nothing
  // is asked of it over the network until you sign in).
  if (core.MCP_LIBRARY) await admin("setConnector", { id: "linear" });
  const team = await admin("team");
  const faces = Object.fromEntries(team.teammates.map((member: { id: string }) => [member.id, core.avatarExpression(member, team, Date.now())]));

  // ---------- the app's files as the node sends them ----------
  const assets = await buildAssets();
  const sizeOf = async (path: string) => {
    const size = async (accept: string | null) => (await assets.serve(path, new Request(`${origin}${path}`, { headers: accept ? { "accept-encoding": accept } : {} })).arrayBuffer()).byteLength;
    return { path, raw: await size(null), gzip: await size("gzip"), brotli: await size("br") };
  };

  // ---------- a paired browser ----------
  chrome = await Chrome.launch(join(tmp, "chrome"));
  const browser = chrome;
  const { targetInfos } = await browser.send("Target.getTargets");
  const { sessionId: page } = await browser.send("Target.attachToTarget", { targetId: targetInfos.find((t: { type: string }) => t.type === "page").targetId, flatten: true });
  const wire = new Map<string, Wire & { done: boolean }>();
  const workers = new Set<string>();
  let profile: Profile = "laptop";
  let lastTraffic = Date.now();
  const line = (name: Profile) => ({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...(PROFILES[name].network ?? {}) });
  browser.on(({ method, params, sessionId }) => {
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "service_worker") {
      // A service worker waits for us at its start, so none of its requests are missed, and it is on the same line as the page.
      workers.add(params.sessionId);
      void browser
        .send("Network.enable", {}, params.sessionId)
        .then(() => browser.send("Network.emulateNetworkConditions", line(profile), params.sessionId))
        .then(() => browser.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId))
        .catch(() => {});
      return;
    }
    if (method === "Target.detachedFromTarget") workers.delete(params.sessionId);
    if (!method.startsWith("Network.") || (sessionId !== page && !workers.has(sessionId ?? ""))) return;
    const key = `${sessionId}:${params.requestId}`;
    // (What comes on a stream the page keeps open is not the page loading.)
    if (!(method === "Network.dataReceived" && wire.get(key)?.stream)) lastTraffic = Date.now();
    if (method === "Network.requestWillBeSent" && params.request.url.startsWith(origin)) {
      wire.set(key, { path: new URL(params.request.url).pathname, status: 0, bytes: 0, encoding: "", by: sessionId === page ? "page" : "service worker", from: "network", done: false });
    } else if (method === "Network.responseReceived" && wire.has(key)) {
      const entry = wire.get(key)!;
      entry.status = params.response.status;
      entry.encoding = params.response.headers["content-encoding"] ?? params.response.headers["Content-Encoding"] ?? "";
      entry.from = params.response.fromServiceWorker ? "service worker" : params.response.fromDiskCache || params.response.fromPrefetchCache ? "cache" : "network";
      if (params.response.mimeType === "text/event-stream") entry.stream = true;
    } else if ((method === "Network.loadingFinished" || method === "Network.loadingFailed") && wire.has(key)) {
      Object.assign(wire.get(key)!, { bytes: params.encodedDataLength ?? 0, done: true });
    }
  });
  await browser.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "service_worker" }] });
  for (const domain of ["Page", "Runtime", "Network", "Performance"]) await browser.send(`${domain}.enable`, {}, page);
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${watchPage.toString()})()` }, page);
  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await browser.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, page);
    if (exceptionDetails) throw new Error(`in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value as T;
  };
  const navigate = async (url: string): Promise<void> => {
    await browser.send("Page.navigate", { url }, page);
  };
  // (A stream the page keeps open, the node's live stream among them, is quiet when nothing comes on it.)
  const quiet = (ms: number) => until("the network to go quiet", () => Date.now() - lastTraffic > ms && [...wire.values()].every((entry) => entry.done || entry.stream), 30_000);

  // Gawain's desktop shows a stand-in page, drawn here once at the desktop's own size (1280×800) as the JPEG its VM sends.
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page);
  await navigate(`data:text/html;charset=utf-8,${encodeURIComponent(DESKTOP_PAGE)}`);
  await sleep(400);
  desktopShot = (await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 72 }, page)).data;

  // The real pairing page: the code it shows is compared with the node's before anything is approved.
  const invite = await admin("createInvite", { kind: "client", origin, scopes: core.CLIENT_DEFAULT_SCOPES });
  await navigate(invite.url);
  await until("the pairing page", () => evaluate(`Boolean(document.querySelector("form.card button[type=submit]"))`));
  await evaluate(`document.querySelector("form.card button[type=submit]").click()`);
  await until("the page's code", () => evaluate(`Boolean(document.querySelector(".sas"))`));
  const pageCode = await evaluate<string>(`[...document.querySelectorAll(".sas span")].map((s) => s.textContent).join("")`);
  await until("the node's pending pairing", async () => (await admin("pairings")).pairings.length === 1);
  const [pending] = (await admin("pairings")).pairings;
  if (String(pending.sas).replace(/\s+/g, "") !== pageCode) throw new Error("the page's code and the node's differ: nothing approved");
  await admin("approvePairing", { invite: pending.invite, device: pending.device });
  await until("the app after pairing", () => evaluate(`Boolean(document.querySelector(".shell"))`));

  // ---------- loading a page ----------
  const setProfile = async (name: Profile): Promise<void> => {
    profile = name;
    const p = PROFILES[name];
    await browser.send("Emulation.setDeviceMetricsOverride", { width: p.width, height: p.height, deviceScaleFactor: p.scale, mobile: p.mobile }, page);
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: p.mobile }, page);
    await browser.send("Emulation.setCPUThrottlingRate", { rate: p.cpu }, page);
    for (const session of [page, ...workers]) await browser.send("Network.emulateNetworkConditions", line(name), session).catch(() => {});
  };
  const forget = async (): Promise<void> => {
    await navigate("about:blank");
    await sleep(100);
    await browser.send("Network.clearBrowserCache", {}, page);
    // The device key (IndexedDB) stays: this is a paired browser that has never opened the app.
    await browser.send("Storage.clearDataForOrigin", { origin, storageTypes: "service_workers,cache_storage" }, page);
    await sleep(200);
  };
  const usable = (hash: string) => until(`${hash} to be usable`, () => evaluate(`window.__measure?.usable != null && performance.getEntriesByName("first-contentful-paint").length > 0`), 45_000);
  const open = async (hash: string, settle: boolean): Promise<Load> => {
    await navigate("about:blank");
    await sleep(100);
    wire.clear();
    await navigate(`${origin}/${hash}`);
    await usable(hash);
    const marks = await evaluate<Omit<Load, "wire">>(`({ ...window.__measure, paint: performance.getEntriesByName("first-contentful-paint")[0].startTime, nodes: document.querySelectorAll("*").length })`);
    // A first visit goes on after the page is usable: the service worker installs and fetches the shell again.
    if (settle) {
      await until("the service worker", () => evaluate(`navigator.serviceWorker.getRegistration().then((r) => r?.active?.state === "activated")`), 30_000);
      await quiet(700);
    }
    return { ...marks, wire: [...wire.values()].map(({ done: _done, ...entry }) => entry) };
  };

  /*
   * Where the main thread's time goes on a first visit, up to "usable": one load with Chrome's own
   * trace on, each stretch of work counted once under what it was (its own time, without what it called).
   */
  const WORK: [string, RegExp][] = [
    ["script", /^(v8\.|V8\.|EvaluateScript|FunctionCall|RunMicrotasks|TimerFire|EventDispatch|XHR|FireAnimationFrame|MinorGC|MajorGC)/],
    ["style", /^(UpdateLayoutTree|ScheduleStyleRecalculation)/],
    ["layout", /^Layout$/],
    ["paint", /^(Paint|PrePaint|Layerize|Commit|UpdateLayer|CompositeLayers|RasterTask|Decode)/],
    ["parsing", /^(ParseHTML|ParseAuthorStyleSheet|DecodedDataDocumentParser)/],
  ];
  const traced = async (hash: string): Promise<Record<string, number>> => {
    await forget();
    const events: any[] = [];
    let complete = () => {};
    const done = new Promise<void>((resolve) => (complete = resolve));
    const listen = ({ method, params }: CdpEvent) => {
      if (method === "Tracing.dataCollected") events.push(...params.value);
      else if (method === "Tracing.tracingComplete") complete();
    };
    browser.on(listen);
    await browser.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "v8", "blink.user_timing", "loading"] } });
    await navigate(`${origin}/${hash}`);
    await usable(hash);
    const at = await evaluate<number>(`window.__measure.usable`);
    await browser.send("Tracing.end");
    await done;
    browser.off(listen);
    // The page's own main thread: the one its navigation started on.
    const start = events.findLast((e) => e.name === "navigationStart" && String(e.args?.data?.documentLoaderURL ?? "").startsWith(origin));
    if (!start) throw new Error("the trace has no navigation start for the page");
    const main = events.filter((e) => e.ph === "X" && e.pid === start.pid && e.tid === start.tid && e.ts >= start.ts && e.ts <= start.ts + at * 1000).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const own = new Map<any, number>(main.map((e) => [e, e.dur]));
    const open: any[] = [];
    for (const e of main) {
      while (open.length && open.at(-1).ts + open.at(-1).dur <= e.ts) open.pop();
      if (open.length) own.set(open.at(-1), own.get(open.at(-1))! - e.dur);
      open.push(e);
    }
    const spent: Record<string, number> = Object.fromEntries([...WORK.map(([kind]) => [kind, 0]), ["other", 0]]);
    for (const [e, micros] of own) spent[WORK.find(([, names]) => names.test(e.name))?.[0] ?? "other"]! += Math.max(0, micros) / 1000;
    return spent;
  };

  const results: Record<string, { cold: Summary; warm: Summary; work: Record<string, number> }> = {};
  let firstVisit: Wire[] = [];
  for (const name of Object.keys(PROFILES) as Profile[]) {
    await setProfile(name);
    for (const target of PAGES) {
      const cold: Load[] = [];
      const warm: Load[] = [];
      if (!RUNS || REST) continue;
      for (let run = 0; run < RUNS; run++) {
        await forget();
        cold.push(await open(target.hash, true));
        warm.push(await open(target.hash, false));
      }
      if (name === "laptop" && target === PAGES[0]) firstVisit = cold[0]!.wire;
      const traces = [await traced(target.hash), await traced(target.hash), await traced(target.hash)];
      const work = Object.fromEntries(Object.keys(traces[0]!).map((kind) => [kind, Math.round(median(traces.map((t) => t[kind]!)) * 10) / 10]));
      results[`${target.name} · ${name}`] = { cold: summary(cold), warm: summary(warm), work };
      console.error(`measured ${target.name} on the ${name} profile`);
    }
  }

  // ---------- what Chat and the Roundtable cost while nothing changes ----------
  // (On this machine as it is: a slowed processor drops frames, and so hides the work an animation asks for.)
  await setProfile("laptop");
  const work = async (): Promise<Record<string, number>> => Object.fromEntries((await browser.send("Performance.getMetrics", {}, page)).metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
  /** Processor seconds so far: of the renderers (the page's, and any other open) and of every process. */
  const processors = async (): Promise<{ renderer: number; all: number }> => {
    const { processInfo } = (await browser.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; cpuTime: number }[] };
    const sum = (list: { cpuTime: number }[]) => list.reduce((total, process) => total + process.cpuTime, 0);
    return { renderer: sum(processInfo.filter((process) => process.type === "renderer")), all: sum(processInfo) };
  };
  const rest = async (hash: string) => {
    await open(hash, false);
    await sleep(1500);
    const before = await work();
    const cpuBefore = await processors();
    await sleep(10_000);
    const after = await work();
    const cpuAfter = await processors();
    const perSecond = (metric: string) => Math.round((after[metric]! - before[metric]!) * 1000) / 10;
    return {
      animations: await evaluate<number>(`document.getAnimations().filter((a) => a.playState === "running").length`),
      mainThread: perSecond("TaskDuration"),
      script: perSecond("ScriptDuration"),
      style: perSecond("RecalcStyleDuration"),
      layout: perSecond("LayoutDuration"),
      // (Processor seconds over ten seconds, as ms a second.)
      renderer: Math.round((cpuAfter.renderer - cpuBefore.renderer) * 1000) / 10,
      browser: Math.round((cpuAfter.all - cpuBefore.all) * 1000) / 10,
    };
  };
  const chatAtRest = RUNS || REST ? await rest("#/chat") : null;
  const atRest = RUNS || REST
    ? {
        ...(await rest("#/team")),
        avatars: await evaluate<number>(`document.querySelectorAll(".worker-avatar").length`),
        avatarElements: await evaluate<number>(`document.querySelectorAll(".worker-avatar, .worker-avatar *").length`),
      }
    : null;
  /**
   * What a page asks the node for while it stays open and nobody touches it: every request in a minute (the page's and
   * its service worker's), by path, from a second and a half after it is usable. A stream it keeps open counts once,
   * when it is opened (or opened again) within that minute.
   */
  const askedAtRest = async (hash: string) => {
    await open(hash, false);
    await sleep(1500);
    wire.clear();
    await sleep(60_000);
    const paths = new Map<string, number>();
    for (const entry of wire.values()) paths.set(entry.path, (paths.get(entry.path) ?? 0) + 1);
    return { requests: wire.size, paths: Object.fromEntries([...paths].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) };
  };
  const chatAsked = RUNS || REST ? await askedAtRest("#/chat") : null;
  const roundtableAsked = RUNS || REST ? await askedAtRest("#/team") : null;

  // ---------- what moves on screen once it is there ----------
  // Each place, and Galahad's, a knight's and a room's timeline, opened as a returning visit opens it (the service worker
  // holds the shell), on each profile, SHIFT_RUNS times; watched from its first frame until SETTLE_MS after it is usable.
  // A place's score is the sum of every layout shift (its cumulative layout shift; nothing touches it meanwhile); what moved is said
  // with it, the most first. Before the screenshots, which give a knight work: every checkout is seen in the same state.
  const SETTLE_MS = 3000;
  const shiftPlaces = [
    ...places.map((place) => ({ name: place.id, hash: `#/${place.id}` })),
    { name: "galahad", hash: `#/chat?c=${conversation}` },
    { name: "knight", hash: `#/team?room=${own.ada}` },
    { name: "room", hash: "#/team?room=forge" },
  ].filter((place) => wanted(place.name));
  interface Shifted {
    /** The place's score on each load. */
    scores: number[];
    median: number;
    max: number;
    /** What moved, with its share of the score summed over the loads, the most first. */
    moved: { what: string; score: number }[];
  }
  const shifted: Record<string, Partial<Record<Profile, Shifted>>> = {};
  for (const name of SHIFTS ? (Object.keys(PROFILES) as Profile[]) : []) {
    await setProfile(name);
    await open("#/team", false);
    for (const place of shiftPlaces) {
      const scores: number[] = [];
      const moved = new Map<string, number>();
      for (let run = 0; run < SHIFT_RUNS; run++) {
        // (A new chat at #/chat, not the kept one a load before left open.)
        await evaluate(`try { localStorage.removeItem("galahad:open-chat") } catch {}`);
        await open(place.hash, false);
        await sleep(SETTLE_MS);
        const seen = await evaluate<{ value: number; moved: string[] }[]>(`window.__measure.shifts`);
        scores.push(seen.reduce((sum, shift) => sum + shift.value, 0));
        for (const shift of seen) for (const what of shift.moved) moved.set(what, (moved.get(what) ?? 0) + shift.value / shift.moved.length);
      }
      const round = (n: number) => Math.round(n * 10_000) / 10_000;
      (shifted[place.name] ??= {})[name] = {
        scores: scores.map(round),
        median: round(median(scores)),
        max: round(Math.max(...scores)),
        moved: [...moved].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([what, score]) => ({ what, score: round(score) })),
      };
    }
    console.error(`watched every place for shifts on the ${name} profile`);
  }
  if (SHIFTS) {
    const rows = [["place", ...Object.keys(PROFILES).map((name) => `${name} (median, max)`), "what moved most"]];
    for (const [place, profiles] of Object.entries(shifted)) {
      const most = Object.values(profiles).flatMap((p) => p!.moved).sort((a, b) => b.score - a.score)[0];
      rows.push([place, ...Object.keys(PROFILES).map((name) => { const p = profiles[name as Profile]!; return `${p.median.toFixed(4)}  ${p.max.toFixed(4)}`; }), most ? `${most.what} (${most.score})` : ""]);
    }
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    console.log(`\nLayout shift per place, ${SHIFT_RUNS} returning visits each, watched until ${SETTLE_MS / 1000} s after usable (the sum of every shift):`);
    console.log(rows.map((row) => row.map((cell, column) => (column && column < row.length - 1 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join("  ")).join("\n"));
  }

  // ---------- screenshots ----------
  // (The same addresses on any checkout: an older app is shown at the same places. Each waits for what it is there to show.)
  const shots: string[] = [];
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await setProfile("laptop");
    // The sheets and forms the places open, and the modes a place has: what opens each (a button's words, or a script).
    const press = (...labels: string[]) =>
      `(() => { const all = [...document.querySelectorAll("button, a.btn, [role=option]")].filter((el) => el.getClientRects().length); const el = ${JSON.stringify(labels)}.map((label) => all.find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label)).find(Boolean); if (!el) throw new Error("nothing to press: " + ${JSON.stringify(labels.join(" / "))}); el.click(); })()`;
    const key = (k: string, meta = false) => `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, metaKey: ${meta}, ctrlKey: ${meta}, bubbles: true }))`;
    /** A view: where, what it waits for, this device's choices it is shot with (localStorage, cleared after), what is
     * pressed once it is there, and what the node is told before it and after (a route an older node lacks skips it). */
    interface View {
      name: string;
      hash: string;
      wait?: string;
      prefs?: Record<string, string>;
      steps?: string[];
      around?: { route: string; before: unknown; after: unknown };
    }
    const views: View[] = [
      { name: "roundtable", hash: "#/team" },
      // The Roundtable as a list (this device's choice), the knights being arranged, and a knight leading it.
      { name: "roundtable-list", hash: "#/team", prefs: { "galahad:roundtable-view": "list" } },
      { name: "roundtable-arrange", hash: "#/team", steps: [press("Arrange")], wait: "[data-arranging]" },
      { name: "roundtable-lin-leads", hash: "#/team", around: { route: "arrangeTeam", before: { primary: "lin" }, after: { primary: "galahad" } } },
      { name: "galahad", hash: `#/chat?c=${conversation}`, wait: ".turn.assistant" },
      // A new chat with him: his orb, large, and what he asks you under it (where the checkout has it).
      { name: "galahad-welcome", hash: "#/chat", steps: [press("Chat options"), press("New chat")], wait: ".chat-hero" },
      // Files with a message: a kept one that carried a picture and a text, and the message box with two waiting to go.
      ...(attachedChat ? [{ name: "galahad-attached", hash: `#/chat?c=${attachedChat}`, wait: ".attached-picture img[src]" }] : []),
      { name: "chat-attaching", hash: "#/chat", steps: [ATTACHING], wait: ".composer-file.up ~ .composer-file.up" },
      { name: "ada-running-task", hash: `#/team?room=${own.ada}` },
      { name: "kay-kept-changes", hash: `#/team?room=${own.kay}&tab=work`, wait: ".team-task" },
      { name: "gareth-failed-task", hash: `#/team?room=${own.gareth}&tab=work`, wait: ".team-task" },
      { name: "forge-work", hash: "#/team?room=forge&tab=work", wait: ".team-task" },
      { name: "gawain-workspace-desktop", hash: `#/team?room=${own.gawain}&tab=workspace`, wait: ".team-panel .card, .desktop-shot img[data-shown]" },
      // A task as a thread of its own (since 26 November 2026): at work, verified with its changes kept, and given up.
      { name: "task-running", hash: `#/task/${first.id}`, wait: ".thread-page .thread-steps" },
      { name: "task-verified", hash: `#/task/${kept.id}`, wait: ".thread-page .proof" },
      { name: "task-failed", hash: `#/task/${failing.id}`, wait: ".thread-page .proof" },
      { name: "inbox", hash: "#/inbox" },
      { name: "memory", hash: "#/memory", wait: "#memory-results .item" },
      { name: "more", hash: "#/more" },
      // Every other place the app has, by its own list, each as far down as it goes too.
      ...places.filter((place) => !["team", "inbox", "memory", "more"].includes(place.id)).map((place) => ({ name: place.id, hash: `#/${place.id}` })),
    ];
    const sheets: { name: string; hash: string; open: string[]; wait?: string }[] = [
      { name: "sheet-palette", hash: "#/overview", open: [key("k", true)], wait: "dialog.palette[open]" },
      // Everything else, under "…" (since 26 November 2026, where the rail and the phone's tab bar were).
      { name: "sheet-places", hash: "#/home", open: [press("Everything else")] },
      { name: "sheet-shortcuts", hash: "#/overview", open: [key("?")] },
      { name: "sheet-chat-menu", hash: "#/chat", open: [press("Chat options")], wait: "dialog.selector-pop[open], dialog.selector-sheet[open]" },
      { name: "sheet-all-chats", hash: "#/chat", open: [press("Chat options"), press("All chats…", "All chats")] },
      { name: "sheet-new-knight", hash: "#/team", open: [press("New knight", "Add a knight")] },
      { name: "sheet-new-project", hash: "#/projects", open: [press("New project")] },
      { name: "sheet-add-loop", hash: "#/loops", open: [press("Add loop", "Add a loop")] },
      { name: "sheet-add-tripwire", hash: "#/loops", open: [press("Add rule")] },
      { name: "sheet-remember", hash: "#/memory", open: [press("Remember something", "Remember")] },
      { name: "sheet-write-skill", hash: "#/skills", open: [press("Write a skill")] },
      { name: "sheet-new-idea", hash: "#/archive", open: [press("New idea")] },
      { name: "sheet-pair-device", hash: "#/fleet", open: [press("Pair a device")] },
      { name: "sheet-create-sandbox", hash: "#/sandboxes", open: [press("Create sandbox")] },
      { name: "sheet-add-key", hash: "#/vault", open: [press("Add a key", "Add key")] },
      { name: "sheet-add-provider", hash: "#/models", open: [press("Add provider")] },
      { name: "sheet-add-mcp", hash: "#/connectors", open: [press("Add an MCP server")] },
    ];
    // A phone held upright, and screens as wide as asked (--widths), each as tall as a laptop's is for its width.
    const sizes = WIDTHS.map((width) => (width < 640 ? ([width, 844, true] as const) : ([width, Math.round(width * 0.625), false] as const)));
    const shoot = async (name: string, width: number, theme: string, whole = false): Promise<void> => {
      // As far down as it goes: the page's whole height, at one pixel a point (it can be long).
      const { cssContentSize } = whole ? await browser.send("Page.getLayoutMetrics", {}, page) : { cssContentSize: null };
      const { data } = await browser.send("Page.captureScreenshot", cssContentSize ? { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(Math.ceil(cssContentSize.height), 12_000), scale: 0.5 } } : { format: "png" }, page);
      const file = join(SHOTS, `${name}-${width}-${theme}${whole ? "-full" : ""}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      shots.push(file);
    };
    const look = async (theme: string, width: number, height: number, mobile: boolean): Promise<void> => {
      // (Motion reduced, so a sheet is shot where it rests, not on its way there.)
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] }, page);
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile }, page);
      await browser.send("Emulation.setTouchEmulationEnabled", { enabled: mobile }, page);
    };
    for (const theme of ["light", "dark"]) {
      for (const [width, height, mobile] of sizes) {
        await look(theme, width, height, mobile);
        for (const view of views.filter((v) => wanted(v.name))) {
          if (view.around && !routes[view.around.route]) {
            console.error(`${view.name}: this node has no route named ${view.around.route}: no screenshot of it`);
            continue;
          }
          // A new chat, not the kept one the last round left open (the app comes back to that one).
          await evaluate(`try { localStorage.removeItem("galahad:open-chat"); ${Object.entries(view.prefs ?? {}).map(([name, value]) => `localStorage.setItem(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join(" ")} } catch {}`);
          try {
            if (view.around) await admin(view.around.route, view.around.before);
            await open(view.hash, false).catch((error) => console.error(`${view.name}: ${(error as Error).message}`));
            if (view.steps) {
              await sleep(500);
              for (const step of view.steps) {
                await evaluate(step);
                await sleep(350);
              }
            }
            if (view.wait) await until(`${view.name} to show`, () => evaluate(`Boolean(document.querySelector(${JSON.stringify(view.wait)}))`), 20_000).catch((error) => console.error(`${view.name}: ${(error as Error).message}`));
            // (A running task's lines, and a desktop's picture, arrive a moment after the page.)
            await sleep(view.name.includes("running") || view.name.includes("desktop") ? 2500 : 500);
            await shoot(view.name, width, theme);
            if (await evaluate<boolean>(`document.documentElement.scrollHeight > innerHeight + 8`)) await shoot(view.name, width, theme, true);
          } catch (error) {
            // (A mode this app doesn't have, such as a button it has no such word for: said, and not shot.)
            console.error(`${view.name}: ${(error as Error).message}`);
          } finally {
            if (view.around) await admin(view.around.route, view.around.after).catch(() => {});
            if (view.prefs) await evaluate(`try { ${Object.keys(view.prefs).map((name) => `localStorage.removeItem(${JSON.stringify(name)});`).join(" ")} } catch {}`).catch(() => {});
          }
        }
        for (const sheet of sheets.filter((v) => wanted(v.name))) {
          await evaluate(`try { localStorage.removeItem("galahad:open-chat") } catch {}`);
          try {
            await open(sheet.hash, false);
            await sleep(300);
            for (const step of sheet.open) {
              await evaluate(step);
              await sleep(350);
            }
            await until(`${sheet.name} to open`, () => evaluate(`Boolean(document.querySelector(${JSON.stringify(sheet.wait ?? "dialog.sheet[open]")}))`), 8_000);
            await sleep(400);
            await shoot(sheet.name, width, theme);
          } catch (error) {
            console.error(`${sheet.name}: ${(error as Error).message}`);
          }
        }
      }
    }
    if (wanted("gallery")) shots.push(...(await shootGallery(browser, page, SHOTS, REPO)));
    // A task given to the Roundtable, through the page's own form, where the app has one: who took it and why. Last, as it
    // gives Gawain work; stopped again after each, so each is given to the same Roundtable.
    giving: for (const theme of wanted("give-to-the-roundtable") ? ["light", "dark"] : []) {
      for (const [width, height, mobile] of sizes) {
        await look(theme, width, height, mobile);
        await open("#/team", false);
        if (!(await evaluate<boolean>(`Boolean(document.querySelector("[data-give]"))`))) {
          console.error("this app has no way to give a task to the Roundtable: no screenshot of it");
          break giving;
        }
        await evaluate(`document.querySelector("[data-give]").click()`);
        await until("the give sheet", () => evaluate(`Boolean(document.querySelector("dialog[open] textarea[name=goal]"))`));
        await evaluate(`(() => {
          const sheet = document.querySelector("dialog[open]");
          const set = (field, value) => { field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); };
          set(sheet.querySelector("textarea[name=goal]"), "TASK_GIVE: open the dashboard and download this month's export as CSV, then say how many rows it has.");
          set(sheet.querySelector("input[name=title]"), "This month's export");
          set(sheet.querySelector("textarea[name=gates]"), "test -s export.csv");
          const desktop = sheet.querySelector("input[name=desktop]");
          if (desktop && !desktop.checked) desktop.click();
          sheet.querySelector("button[type=submit]").click();
        })()`);
        await until("who took it", () => evaluate(`Boolean(document.querySelector("dialog[open] .give-result"))`));
        await sleep(400);
        await shoot("give-to-the-roundtable", width, theme);
        await evaluate(`document.querySelector("dialog[open]")?.close()`);
        for (const given of (await admin("team")).tasks.filter((task: { givenBy?: string; status: string }) => task.givenBy && (task.status === "queued" || task.status === "running"))) {
          await admin("controlTeam", { task: given.id, action: "stop" }).catch(() => {});
        }
      }
    }
  }

  // ---------- moving between places, as a tap does ----------
  // In the app already open, as a person moves: a look at the page first (DWELL_MS), then a press on a link to the next
  // place and the tap a finger's moment later (PRESS_MS; an app may start reading on the press). Timed from the tap to
  // the place's own content drawn (the page that was there gone, every loading placeholder replaced, a frame drawn).
  // Each place twice, so what a revisit costs shows.
  const PATH = ["#/chat", "#/inbox", "#/loops", "#/overview", "#/inbox", "#/team", "#/team?room=forge", "#/team"];
  const DWELL_MS = 800;
  const PRESS_MS = 100;
  const move = async (hash: string) => {
    await sleep(DWELL_MS);
    return evaluate<number>(`new Promise((done) => {
      const link = document.createElement("a");
      link.setAttribute("href", ${JSON.stringify(hash)});
      link.hidden = true;
      document.body.append(link);
      link.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      link.remove();
      setTimeout(() => {
        const main = document.querySelector(".shell main");
        const was = main && main.firstElementChild;
        const start = performance.now();
        location.hash = ${JSON.stringify(hash)};
        const look = () => ((!was || !was.isConnected) && window.__there() ? requestAnimationFrame(() => setTimeout(() => done(performance.now() - start))) : requestAnimationFrame(look));
        requestAnimationFrame(look);
      }, ${PRESS_MS});
    })`);
  };
  const moves: Record<string, Spread[]> = {};
  for (const name of MOVES ? (Object.keys(PROFILES) as Profile[]) : []) {
    await setProfile(name);
    const times: number[][] = PATH.map(() => []);
    for (let round = 0; round < MOVES; round++) {
      await open("#/team", false);
      for (const [i, hash] of PATH.entries()) times[i]!.push(await move(hash));
    }
    moves[name] = times.map(spread);
    console.error(`measured moving between places on the ${name} profile`);
  }
  if (MOVES) {
    const from = ["#/team", ...PATH];
    const rows = [["move", ...Object.keys(moves)]];
    for (const [i, hash] of PATH.entries()) rows.push([`${from[i]} → ${hash}${PATH.indexOf(hash) < i ? " (again)" : ""}`, ...Object.values(moves).map((spreads) => `${spreads[i]!.median} ms (${spreads[i]!.min}–${spreads[i]!.max})`)]);
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    console.log(`\nMoving between places in the app already open, ${MOVES} times over (median, fastest–slowest):`);
    console.log(rows.map((row) => row.map((cell, column) => (column ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join("  ")).join("\n"));
  }
  // (With nothing loaded, what was measured instead: the moves, the shifts.)
  if (JSON_OUT && !RUNS && (MOVES || SHIFTS)) {
    const movesJson = Object.fromEntries(Object.entries(moves).map(([name, spreads]) => [name, Object.fromEntries(PATH.map((hash, i) => [`${i} ${hash}`, spreads[i]]))]));
    writeFileSync(JSON_OUT, `${JSON.stringify({ revision: `${revision}${dirty}`, ...(MOVES ? { moves: movesJson } : {}), ...(SHIFTS ? { shifts: shifted } : {}) }, null, 2)}\n`);
  }

  // ---------- the report ----------
  const restLines = () => [
    `The Roundtable at rest (laptop, ten seconds): ${atRest!.avatars} avatars of ${atRest!.avatarElements} elements, ${atRest!.animations} animations running;`,
    `the main thread works ${atRest!.mainThread} ms a second (script ${atRest!.script}, style ${atRest!.style}, layout ${atRest!.layout}); the page's renderer ${atRest!.renderer} ms, the whole browser ${atRest!.browser} ms of processor a second.`,
    `Chat at rest: ${chatAtRest!.animations} animations running; the main thread works ${chatAtRest!.mainThread} ms a second (script ${chatAtRest!.script}, style ${chatAtRest!.style}, layout ${chatAtRest!.layout}); the page's renderer ${chatAtRest!.renderer} ms, the whole browser ${chatAtRest!.browser} ms of processor a second.`,
    ...(
      [
        ["Chat", chatAsked!],
        ["The Roundtable", roundtableAsked!],
      ] as const
    ).map(([name, asked]) => `${name} asks the node ${asked.requests} times a minute at rest${asked.requests ? `: ${Object.entries(asked.paths).map(([path, n]) => `${path} ${n}`).join(", ")}` : ""}.`),
  ];
  if (REST) {
    console.log(`\nThe PWA at ${revision}${dirty} (${REPO}), in ${(await browser.send("Browser.getVersion")).product}.`);
    console.log(restLines().join("\n"));
    if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ revision: `${revision}${dirty}`, chatAtRest, roundtableAtRest: atRest, chatAsked, roundtableAsked }, null, 2)}\n`);
  } else if (!RUNS) console.log(`${shots.length} screenshots in ${resolve(SHOTS ?? ".")}, nothing measured${MOVES || SHIFTS ? ` but ${[MOVES ? "the moves" : "", SHIFTS ? "the shifts" : ""].filter(Boolean).join(" and ")}` : ""} (--runs 0).`);
  else {
  // (The browser fetches /sw.js itself, outside what the protocol shows of the page and the worker: it is counted here.)
  const files = await Promise.all([...new Set([...firstVisit.filter((w) => !w.path.startsWith("/api/") && !w.path.startsWith("/link/")).map((w) => w.path), "/sw.js"])].map(sizeOf));
  const total = (key: "raw" | "gzip" | "brotli") => files.reduce((sum, file) => sum + file[key], 0);
  const report = {
    revision: `${revision}${dirty}`,
    repo: REPO,
    chrome: (await browser.send("Browser.getVersion")).product,
    runs: RUNS,
    faces,
    firstVisit: { requests: firstVisit.length, api: firstVisit.filter((w) => w.path.startsWith("/api/")).length, bytesOnTheWire: firstVisit.reduce((sum, w) => sum + w.bytes, 0), wire: firstVisit },
    files: [...files, { path: "all of them", raw: total("raw"), gzip: total("gzip"), brotli: total("brotli") }],
    pages: results,
    chatAtRest,
    roundtableAtRest: atRest,
    chatAsked,
    roundtableAsked,
    ...(MOVES ? { moves } : {}),
    ...(SHIFTS ? { shifts: shifted } : {}),
    shots,
  };
  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);

  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
  const ms = (s: Spread) => `${s.median} ms (${s.min}–${s.max})`;
  const table = (rows: string[][]) => {
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    return rows.map((row) => row.map((cell, column) => (column ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join("  ")).join("\n");
  };
  console.log(`\nThe PWA at ${report.revision} (${REPO}), in ${report.chrome}, ${RUNS} loads each.`);
  console.log(`The knights' faces while it was measured: ${Object.entries(faces).map(([id, face]) => `${id} ${face}`).join(", ")}.\n`);
  console.log("The app's files on a first visit, as the node sends them:");
  console.log(table([["file", "raw", "gzip", "brotli"], ...report.files.map((f) => [f.path, kb(f.raw), kb(f.gzip), kb(f.brotli)])]));
  console.log(`\nA first visit to ${PAGES[0]!.name}: ${report.firstVisit.requests} requests seen, and /sw.js (${firstVisit.filter((w) => w.by === "page").length} by the page, ${firstVisit.filter((w) => w.by === "service worker").length} by the service worker; ${report.firstVisit.api} of them to the API),`);
  console.log(`${kb(report.firstVisit.bytesOnTheWire)} on the wire with their headers (this Chrome was sent: ${[...new Set(firstVisit.filter((w) => w.encoding).map((w) => w.encoding))].join(", ") || "nothing compressed"}).\n`);
  const rows = [["page · profile · visit", "paint", "shell", "usable", "blocked", "elements", "requests", "on the wire"]];
  for (const [name, kinds] of Object.entries(results)) {
    for (const kind of ["cold", "warm"] as const) {
      const s = kinds[kind];
      rows.push([`${name} · ${kind}`, ms(s.paint), ms(s.shell), ms(s.usable), ms(s.blocked), String(s.nodes), String(s.requests), kb(s.bytes)]);
    }
  }
  console.log(table(rows));
  console.log("\nThe main thread's work on a first visit, up to usable (ms, the median of three traced loads):");
  console.log(table([["page · profile", ...Object.keys(Object.values(results)[0]!.work)], ...Object.entries(results).map(([name, r]) => [name, ...Object.values(r.work).map((n) => n.toFixed(1))])]));
  console.log(`\n${restLines().join("\n")}`);
  if (shots.length) console.log(`\n${shots.length} screenshots in ${resolve(SHOTS!)}`);
  if (JSON_OUT) console.log(`Everything measured: ${resolve(JSON_OUT)}`);
  }
} finally {
  await tidy();
}
