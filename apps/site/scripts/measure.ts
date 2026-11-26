#!/usr/bin/env bun
/*
 * What invincible.sh costs to open, and how it looks: against the site served locally (`bun run preview`, wrangler dev),
 * in headless Chrome, never the real site.
 *
 *   bun scripts/measure.ts [--url http://127.0.0.1:8787] [--runs 5] [--shots <dir>]
 *
 * - First load, cold (nothing cached), as a laptop (1440×900, the machine as it is) and as a phone (390×844, the
 *   processor slowed 4× on a line of 9 Mbit/s down and 60 ms a request: an emulation, not a phone): when the first
 *   words and the largest thing are painted, when it has loaded, and how much moved (cumulative layout shift). The
 *   median of the runs, with the fastest and the slowest.
 * - Its weight: each file a first visit fetches, for each theme, as built (dist/) and as brotli (what a browser that
 *   asks for it is sent).
 * - With --shots, the whole page at 390 and 1440 px, light and dark, as PNGs, and each a screen at a time (-1 is what
 *   opens: 390×844, 1440×900).
 *
 * Chrome resolves no name but this machine's, so nothing it loads can come from anywhere else.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const arg = (name: string, fallback: string): string => {
  const at = Bun.argv.indexOf(`--${name}`);
  return at > 0 && Bun.argv[at + 1] ? Bun.argv[at + 1]! : fallback;
};
const URL_ = arg("url", "http://127.0.0.1:8787").replace(/\/$/, "");
const RUNS = Number(arg("runs", "5"));
const SHOTS = arg("shots", "");
const DIST = resolve(import.meta.dir, "../dist");
const CHROME = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ...["google-chrome", "google-chrome-stable", "chromium"].map((n) => Bun.which(n) ?? "")].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("no Chrome here: set CHROME to one");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) throw new Error("measure only the site served on this machine (--url http://127.0.0.1:<port>)");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A headless Chrome of its own (a fresh profile, thrown away after), spoken to over the DevTools protocol. */
class Chrome {
  private next = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: any) => void>();
  constructor(private ws: WebSocket, private proc: ReturnType<typeof Bun.spawn>, private profile: string) {
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(String(event.data));
      if (m.id === undefined) return void this.listeners.forEach((l) => l(m));
      const asked = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error) asked?.reject(new Error(m.error.message));
      else asked?.resolve(m.result);
    });
  }
  static async launch(): Promise<Chrome> {
    const profile = mkdtempSync(join(tmpdir(), "site-measure-"));
    const proc = Bun.spawn([CHROME!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars", "--mute-audio", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 300 && !existsSync(portFile); i++) await sleep(100);
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((done, fail) => {
      ws.addEventListener("open", () => done(), { once: true });
      ws.addEventListener("error", () => fail(new Error("no DevTools connection")), { once: true });
    });
    return new Chrome(ws, proc, profile);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(listener: (m: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    await Promise.race([this.send("Browser.close").catch(() => {}), sleep(3000)]);
    this.proc.kill();
    await this.proc.exited;
    rmSync(this.profile, { recursive: true, force: true });
  }
}

const PROFILES = {
  laptop: { width: 1440, height: 900, scale: 2, mobile: false, cpu: 1, network: null },
  phone: { width: 390, height: 844, scale: 3, mobile: true, cpu: 4, network: { offline: false, latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 } },
} as const;
type Profile = keyof typeof PROFILES;

/** A fresh tab, as a profile sees it, in a theme. */
async function tab(chrome: Chrome, profile: Profile, theme: "light" | "dark") {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const p = PROFILES[profile];
  const s = (method: string, params: object = {}) => chrome.send(method, params, sessionId);
  await s("Page.enable");
  await s("Network.enable");
  await s("Network.setCacheDisabled", { cacheDisabled: true });
  await s("Emulation.setDeviceMetricsOverride", { width: p.width, height: p.height, deviceScaleFactor: p.scale, mobile: p.mobile });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  if (p.cpu > 1) await s("Emulation.setCPUThrottlingRate", { rate: p.cpu });
  if (p.network) await s("Network.emulateNetworkConditions", p.network);
  // What the page itself reports: its largest paint and every layout shift, from its first frame.
  await s("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const m = window.__m = { lcp: 0, cls: 0 };
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) m.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {} })();`,
  });
  return { s, targetId, sessionId };
}

/** Opens the page cold and waits for its load event and a moment after (for late shifts). */
async function open(chrome: Chrome, profile: Profile, theme: "light" | "dark") {
  const t = await tab(chrome, profile, theme);
  const fetched: string[] = [];
  const off = chrome.on((m) => {
    if (m.sessionId === t.sessionId && m.method === "Network.requestWillBeSent") fetched.push(m.params.request.url);
  });
  const loaded = new Promise<void>((done) => {
    const stop = chrome.on((m) => {
      if (m.sessionId === t.sessionId && m.method === "Page.loadEventFired") (stop(), done());
    });
  });
  await t.s("Page.navigate", { url: `${URL_}/` });
  await loaded;
  await sleep(1500);
  const { result } = await t.s("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => { const n = performance.getEntriesByType("navigation")[0]; const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      return { fcp: fcp ? fcp.startTime : 0, lcp: window.__m.lcp, load: n.loadEventEnd, cls: window.__m.cls, elements: document.getElementsByTagName("*").length }; })()`,
  });
  off();
  return { t, fetched, timing: result.value as { fcp: number; lcp: number; load: number; cls: number; elements: number } };
}

async function shoot(chrome: Chrome, width: number, theme: "light" | "dark", file: string): Promise<void> {
  const t = await tab(chrome, "laptop", theme);
  await t.s("Network.setCacheDisabled", { cacheDisabled: false });
  await t.s("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: width < 600 });
  const loaded = new Promise<void>((done) => {
    const stop = chrome.on((m) => {
      if (m.sessionId === t.sessionId && m.method === "Page.loadEventFired") (stop(), done());
    });
  });
  await t.s("Page.navigate", { url: `${URL_}/` });
  await loaded;
  await sleep(600);
  const { cssContentSize } = await t.s("Page.getLayoutMetrics");
  const height = Math.ceil(cssContentSize.height);
  await t.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 600 });
  await sleep(300);
  const { data } = await t.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  await Bun.write(file, Buffer.from(data, "base64"));
  // And the page a screen at a time, as it is scrolled through (the first is what opens).
  const screen = width < 600 ? 844 : 900;
  for (let y = 0, n = 1; y < height; y += screen, n++) {
    const slice = await t.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width, height: Math.min(screen, height - y), scale: 1 } });
    await Bun.write(file.replace(/\.png$/, `-${n}.png`), Buffer.from(slice.data, "base64"));
  }
  await chrome.send("Target.closeTarget", { targetId: t.targetId });
  console.log(`  ${file} (${width}×${height}), and a screen at a time beside it`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (x: number) => `${Math.round(x)} ms`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

const chrome = await Chrome.launch();
try {
  // Its weight, for each theme: the files a first visit fetches, as built and as brotli.
  for (const theme of ["light", "dark"] as const) {
    const { t, fetched } = await open(chrome, "laptop", theme);
    await chrome.send("Target.closeTarget", { targetId: t.targetId });
    let raw = 0, br = 0;
    const rows: string[] = [];
    for (const url of fetched) {
      const path = new URL(url).pathname;
      const file = join(DIST, path === "/" ? "index.html" : path);
      if (!existsSync(file)) {
        rows.push(`    ${path}  (not a file in dist/)`);
        continue;
      }
      const bytes = readFileSync(file);
      // (Already compressed: a font and a PNG are sent as they are.)
      const packed = /\.(woff2|png)$/.test(path) ? bytes.length : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
      raw += bytes.length;
      br += packed;
      rows.push(`    ${path.padEnd(52)} ${kb(bytes.length).padStart(9)} ${kb(packed).padStart(9)}`);
    }
    console.log(`\nA first visit, ${theme}: ${fetched.length} requests, ${kb(raw)} as built, ${kb(br)} as brotli`);
    for (const row of rows) console.log(row);
  }

  // First load, cold.
  for (const profile of ["laptop", "phone"] as const) {
    const runs: { fcp: number; lcp: number; load: number; cls: number; elements: number }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { t, timing } = await open(chrome, profile, i % 2 ? "dark" : "light");
      runs.push(timing);
      await chrome.send("Target.closeTarget", { targetId: t.targetId });
    }
    const of = (key: "fcp" | "lcp" | "load") => `${ms(median(runs.map((r) => r[key])))} (${ms(Math.min(...runs.map((r) => r[key])))}–${ms(Math.max(...runs.map((r) => r[key])))})`;
    console.log(`\n${profile}, cold, ${RUNS} runs: first paint ${of("fcp")}, largest paint ${of("lcp")}, loaded ${of("load")}, layout shift ${Math.max(...runs.map((r) => r.cls)).toFixed(4)} at most, ${runs[0]!.elements} elements`);
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    console.log("\nScreenshots:");
    for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) await shoot(chrome, width, theme, join(SHOTS, `home-${width}-${theme}.png`));
  }
} finally {
  await chrome.close();
}
