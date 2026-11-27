/*
 * Glass to glass, and click to seeing it (C1 step 9.3): how long what happens on an agent's screen takes to be on yours,
 * and what you click there to come back to you, through the app as you use it, across the tailnet.
 *
 * How it is run:
 *   1. On the machine the VM is on (Ultra), as root, from this checkout:
 *        bun bench/desktop/glass-node.ts --build --advertise <its tailnet address> > /root/c1/glass/setup.json
 *      It runs a scratch node with one agent whose desktop shows the glass clock (glass-node.ts says what it touches).
 *   2. Copy setup.json to the machine the browser runs on (the Mac mini), and there:
 *        bun bench/desktop/glass.ts --setup setup.json --chrome <Chrome for Testing> [--seconds 20] [--clicks 15] [--json out.json]
 *      Its browser pairs once, through the node's one invite, and keeps its profile (--profile, default glass-chrome in
 *      the temp folder) to measure again without pairing.
 *   3. Stop glass-node.ts (Ctrl-C): it removes its VM. Remove the browser's profile then: it is paired with that node.
 * Tried end to end with no VM: glass-node.ts --stand-in --frames <a recording of the glass page>, then this; its numbers
 * then measure nothing (the clock it shows is the recording's), and it says so.
 *
 * What it does, in a headless Chrome (one that decodes H.264: Chrome or Chrome for Testing, not an open Chromium):
 * - pairs through the node's own pairing page, and opens the agent's Workspace, where the app watches its desktop live;
 * - reads the glass clock (glass-clock.ts) out of each frame as the app draws it, by the app's own canvas;
 * - glass to glass: each frame's draw time here, less the time in its pixels, the clocks aligned by the node's time
 *   (an exchange of `{ now }`, the least round trip kept) and the VM's offset from it (glass-node.ts), both said with
 *   their bounds;
 * - click to seeing it: a click on the screen in the app, to the first frame whose clicks count has moved, on this
 *   machine's clock alone;
 * - bytes a second on the stream while the page runs and while it is still (beats alone).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStrip, STRIP } from "./glass-clock.ts";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const setup = JSON.parse(readFileSync(flag("setup") ?? "", "utf8")) as { endpoint: string; invite: string; room: string; agent: string; timeUrl: string; vmOffsetMs: number; vmOffsetBoundMs: number; standIn?: boolean };
const CHROME = flag("chrome") ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}: --chrome <Chrome or Chrome for Testing>`);
const SECONDS = Number(flag("seconds") ?? 20);
const CLICKS = Number(flag("clicks") ?? 15);
const STILL = Number(flag("still") ?? 6);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** This machine's wall clock: what the node's time and the VM's are compared with (a process's own monotonic clock drifts from it). */
const now = () => Date.now();
const say = (line: string) => console.error(`glass: ${line}`);

// ---------- the browser, over the DevTools protocol ----------
// (Kept between runs: paired with the node once, through its one invite. A port file from an earlier run is not this one's.)
const profile = flag("profile") ?? join(tmpdir(), "glass-chrome");
mkdirSync(profile, { recursive: true });
rmSync(join(profile, "DevToolsActivePort"), { force: true });
const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(setup.endpoint);
const chrome = Bun.spawn([CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1280,1000",
  // (The node is plain HTTP on the tailnet: this origin alone is a secure one to this browser, which WebCodecs needs.)
  ...(local ? [] : [`--unsafely-treat-insecure-origin-as-secure=${setup.endpoint}`]),
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "ignore" });
const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 300 && !existsSync(portFile); i++) await sleep(100);
const [devPort, devPath] = readFileSync(portFile, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${devPort}${devPath}`);
await new Promise<void>((done, fail) => {
  ws.addEventListener("open", () => done(), { once: true });
  ws.addEventListener("error", () => fail(new Error("no DevTools connection")), { once: true });
});
let nextId = 0;
const waiting = new Map<number, (m: any) => void>();
const listeners: ((m: any) => void)[] = [];
ws.addEventListener("message", (message) => {
  const m = JSON.parse(String(message.data));
  if (m.id !== undefined) waiting.get(m.id)?.(m);
  else for (const listener of listeners) listener(m);
});
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const { targetInfos } = await send("Target.getTargets");
const { sessionId: page } = await send("Target.attachToTarget", { targetId: targetInfos.find((t: { type: string }) => t.type === "page").targetId, flatten: true });
await send("Page.enable", {}, page);
await send("Runtime.enable", {}, page);
await send("Network.enable", {}, page);
const evaluate = async <T = any,>(expression: string): Promise<T> => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as T;
};
const until = async (what: string, ready: () => Promise<boolean>, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await ready().catch(() => false))) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await sleep(100);
  }
};

// The stream's bytes as they come, by when (this machine's clock).
const streamed: { at: number; bytes: number }[] = [];
let streamId = "";
listeners.push((m) => {
  if (m.method === "Network.requestWillBeSent" && String(m.params.request.url).endsWith("/api/team/desktop/stream")) streamId = m.params.requestId;
  if (m.method === "Network.dataReceived" && m.params.requestId === streamId) streamed.push({ at: now(), bytes: m.params.encodedDataLength || m.params.dataLength });
});

try {
  // ---------- paired, as you pair a browser (once: its profile keeps it) ----------
  await send("Page.navigate", { url: `${setup.endpoint}/` }, page);
  const paired = await until("the app", () => evaluate(`Boolean(document.querySelector(".shell"))`), 8000).then(() => true, () => false);
  if (!paired) {
    // (A load of its own: the app opens its pairing page only when it starts at a #pair= address.)
    await send("Page.navigate", { url: "about:blank" }, page);
    await send("Page.navigate", { url: setup.invite }, page);
    await until("the pairing page", () => evaluate(`Boolean(document.querySelector("form.card button[type=submit]"))`));
    await evaluate(`document.querySelector("form.card button[type=submit]").click()`);
    await until("the app, once the node approved this browser", () => evaluate(`Boolean(document.querySelector(".shell"))`), 60_000);
  }
  say(paired ? "paired already" : "paired");

  // ---------- the clocks: the node's against this one, the least round trip kept ----------
  let clock = { rtt: Infinity, ms: 0 };
  for (let i = 0; i < 30; i++) {
    const t0 = now();
    const { now: theirs } = (await (await fetch(setup.timeUrl)).json()) as { now: number };
    const t1 = now();
    if (t1 - t0 < clock.rtt) clock = { rtt: t1 - t0, ms: theirs - (t0 + t1) / 2 };
  }
  // (How far the VM's clock is ahead of this one: its own offset from its machine, and that machine's from this.)
  const ahead = setup.vmOffsetMs + clock.ms;
  const bound = setup.vmOffsetBoundMs + clock.rtt / 2 + 1;
  say(`the node's clock is ${clock.ms.toFixed(1)} ms ahead of this one (±${(clock.rtt / 2).toFixed(1)}); the VM's ${ahead.toFixed(1)} (±${bound.toFixed(1)})`);

  // ---------- the agent's desktop, live, and the clock read out of each frame the app draws ----------
  await send("Page.navigate", { url: `${setup.endpoint}/#/team?room=${setup.room}&tab=workspace` }, page);
  await until("the desktop live", () => evaluate(`Boolean(document.querySelector(".desktop-shot canvas[data-shown]"))`), 60_000);
  await evaluate(`(() => {
    const STRIP = ${JSON.stringify(STRIP)};
    const readStrip = ${readStrip.toString()};
    const glass = (window.__glass = { frames: [], clicks: [], unread: 0, row: -1 });
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      draw.apply(this, args);
      if (!this.canvas.closest || !this.canvas.closest(".desktop-shot")) return;
      const at = Date.now();
      const width = this.canvas.width;
      const pixels = this.getImageData(0, 0, width, Math.min(this.canvas.height, 260)).data;
      const level = (x, y) => { const p = (Math.round(y) * width + Math.round(x)) * 4; return 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2]; };
      const read = readStrip(level, STRIP, 200, glass.row);
      if (!read) { glass.unread++; return; }
      glass.row = read.row;
      glass.frames.push({ at, vm: read.time, clicks: read.clicks });
    };
    document.addEventListener("pointerdown", (event) => { if (event.target.closest && event.target.closest(".desktop-shot")) glass.clicks.push(Date.now()); }, true);
  })()`);
  const frames = () => evaluate<{ at: number; vm: number; clicks: number }[]>("window.__glass.frames");
  /**
   * One of the app's own keys beside the screen (Return, Escape), pressed as a person presses it. (Not typed text: deskd
   * types only into what takes text, and the glass page has nothing that does, so a typed g was refused and never seen.)
   */
  const pressed = (label: string) => evaluate(`(() => { const key = [...document.querySelectorAll(".desktop button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!key) throw new Error("the app has no ${label} key"); key.click(); })()`);
  /** A click on the middle of the agent's screen in the app (its panel on the glass page), as a mouse does. */
  const click = async (): Promise<void> => {
    const box = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(".desktop-shot canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, page);
  };
  await until("the clock read from the stream", async () => (await frames()).length > 0, 30_000);
  // The page has the keyboard once it is clicked (the first click takes the desktop over too).
  await click();
  await sleep(1000);

  // ---------- running: glass to glass ----------
  await pressed("Return");
  await sleep(1000);
  const ranFrom = now();
  await sleep(SECONDS * 1000);
  const ranTo = now();
  const ran = (await frames()).filter((f) => f.at >= ranFrom && f.at < ranTo);
  const glass = ran.map((f) => f.at - (f.vm - ahead));

  // ---------- clicks: click to seeing it ----------
  const seeing: number[] = [];
  let unseen = 0;
  for (let i = 0; i < CLICKS; i++) {
    const before = (await frames()).at(-1)?.clicks ?? -1;
    const sent = (await evaluate<number[]>("window.__glass.clicks")).length;
    await click();
    const t0 = (await evaluate<number[]>("window.__glass.clicks"))[sent];
    let seen: number | null = null;
    const end = Date.now() + 5000;
    while (seen === null && Date.now() < end) {
      const moved = (await frames()).find((f) => t0 !== undefined && f.at > t0 && f.clicks !== before);
      if (moved && t0 !== undefined) seen = moved.at - t0;
      else await sleep(20);
    }
    if (seen === null) unseen++;
    else seeing.push(seen);
    await sleep(1000);
  }

  // ---------- still: the stream's beats alone ----------
  await pressed("Escape");
  await sleep(1500);
  const stillFrom = now();
  await sleep(STILL * 1000);
  const stillTo = now();
  const kbit = (from: number, to: number) => (streamed.filter((s) => s.at >= from && s.at < to).reduce((n, s) => n + s.bytes, 0) * 8) / 1000 / ((to - from) / 1000);
  await evaluate(`[...document.querySelectorAll(".desktop-hold button")].find((b) => !b.hidden && b.textContent.trim() === "Give back")?.click()`);

  // ---------- what it measured ----------
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const at = (xs: number[], q: number) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : NaN);
  const report = {
    standIn: Boolean(setup.standIn),
    glassToGlass: { n: glass.length, medianMs: at(glass, 0.5), p95Ms: at(glass, 0.95), minMs: at(glass, 0), maxMs: at(glass, 1) },
    clickToSeeing: { n: seeing.length, unseen, medianMs: at(seeing, 0.5), p95Ms: at(seeing, 0.95), minMs: at(seeing, 0), maxMs: at(seeing, 1) },
    drawnFps: ran.length / SECONDS,
    unread: await evaluate<number>("window.__glass.unread"),
    kbitPerSecond: { running: kbit(ranFrom, ranTo), still: kbit(stillFrom, stillTo) },
    clocks: { nodeAheadMs: clock.ms, nodeBoundMs: clock.rtt / 2, vmAheadMs: ahead, vmBoundMs: bound },
    load: (await Bun.$`sysctl -n vm.loadavg`.nothrow().quiet()).stdout.toString().trim(),
  };
  if (report.standIn) say("a stand-in's run: the clock it showed is a recording's and a click changes nothing on it, so these numbers measure nothing");
  console.log(JSON.stringify(report, null, 2));
  const out = flag("json");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
}
