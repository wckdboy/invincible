#!/usr/bin/env bun
/*
 * Web Push, end to end, in Google Chrome through Google's own push service, against a dev node of its own
 * (apps/apple/scripts/dev-node.ts --heavy --auto-approve, in a temp folder, deleted after):
 *
 *   1. the browser pairs through the real pairing page, and Settings' own switch turns notifications on;
 *   2. what waited while nobody could be reached arrives, once (the catch-up);
 *   3. Settings' "Send a test" arrives;
 *   4. an agent's task ends while Home is in front: its notification names that task, and a tap opens it;
 *   5. an agent asks your approval while Home is in front: told with its sound, and a tap opens the Inbox;
 *   6. another asks while the Inbox is in front: the node sends it, and nothing is shown over the page.
 *
 * Each step is checked, with its times (from the act, and from the node's send being taken by Google's service); the
 * run exits 1 when one doesn't hold. A tap: DevTools can't click a notification, so the worker is given the
 * notificationclick event with the very notification Chrome holds, inside the worker itself; what it does then is the
 * worker's own code and the page's (Chrome's own click, and the focus() a real click allows, aren't exercised).
 *
 *   bun apps/web/measure/push.ts [--shots <dir>] [--json <file>]
 *
 * Needs Google Chrome (CHROME names another: a Chromium without Google's keys has no push service) and the internet.
 * Chrome runs headless with a profile of its own and its own notification centre, never macOS's: nothing shows on
 * the screen, and macOS asks nothing. Nothing else is reached but this machine and Google's push service.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routes } from "../../../packages/core/src/index.ts";

const REPO = join(import.meta.dir, "../../..");
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const SHOTS = flag("shots");
const JSON_OUT = flag("json");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) throw new Error("No Google Chrome found. Set CHROME to a Google Chrome binary.");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (line: string) => console.log(`[push] ${line}`);

async function until<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 45_000, everyMs = 100): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`waited ${timeoutMs / 1000} s for ${what}${last ? ` (last: ${(last as Error).message ?? String(last)})` : ""}`);
}

// ---------- the dev node, driven from outside: its front (what the browser opens), its port and its admin token ----------
const tmp = mkdtempSync(join(tmpdir(), "invincible-push-"));
const nodeDir = join(tmp, "dev");
mkdirSync(nodeDir);
const dev = Bun.spawn(["bun", join(REPO, "apps/apple/scripts/dev-node.ts"), "--dir", nodeDir, "--heavy", "--auto-approve"], { cwd: REPO, stdout: "ignore", stderr: "inherit" });
let chrome: { proc: ReturnType<typeof Bun.spawn>; ws: WebSocket } | null = null;
async function tidy(): Promise<void> {
  if (chrome) {
    chrome.proc.kill();
    await chrome.proc.exited;
  }
  dev.kill("SIGINT");
  await Promise.race([dev.exited, sleep(10_000)]);
  rmSync(tmp, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void tidy().finally(() => process.exit(130)));

const result: Record<string, unknown> = {};
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  say(`${ok ? "ok  " : "FAIL"} ${what}`);
};

try {
  await until("the dev node", () => existsSync(join(nodeDir, "front.txt")), 600_000, 500);
  const front = readFileSync(join(nodeDir, "front.txt"), "utf8").trim();
  const home = join(nodeDir, readdirSync(nodeDir).find((name) => name.startsWith("invincible-apple-node-"))!, "home");
  const port = (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { port: number }).port;
  const token = readFileSync(join(home, "admin.token"), "utf8").trim();
  const call = async (bearer: string, name: keyof typeof routes, input?: unknown): Promise<any> => {
    const route = routes[name] as { method: string; path: string };
    const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
    const answer = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(answer)}`);
    return answer;
  };
  const admin = (name: keyof typeof routes, input?: unknown) => call(token, name, input);
  const sentSince = async (since: number) => ((await admin("notify")).today.sent as { at: number; kind: string; ok: boolean }[]).filter((s) => s.at >= since);
  /** An agent's outward call, held for your approval: something that needs you, as a real one is made. */
  const askApproval = async (text: string) => {
    const arm = await admin("mintArm", { label: `push-measure-${Date.now()}`, scopes: ["connect"] });
    const asked = await call(arm.token, "callConnector", { connector: "forge", tool: "post", args: { text }, why: "Tell people what shipped." });
    if (asked.status !== "asked") throw new Error(`the agent's call wasn't held for you: ${JSON.stringify(asked)}`);
  };
  // Quiet hours would hold what's told now: off, for this node.
  await admin("setNotify", { quiet: { on: false }, perDay: 50 });

  // ---------- Chrome, over the DevTools protocol ----------
  const profile = join(tmp, "chrome");
  const proc = Bun.spawn(
    [CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--use-mock-keychain", "--password-store=basic", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=NativeNotifications,SystemNotifications", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  await until("Chrome's DevTools port", () => existsSync(join(profile, "DevToolsActivePort")), 60_000);
  const [devtoolsPort, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${devtoolsPort}${path}`);
  chrome = { proc, ws };
  await new Promise<void>((done, fail) => {
    ws.addEventListener("open", () => done(), { once: true });
    ws.addEventListener("error", () => fail(new Error("no DevTools connection")), { once: true });
  });
  let next = 0;
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  ws.addEventListener("message", (message) => {
    const m = JSON.parse(String(message.data));
    const asked = m.id === undefined ? undefined : waiting.get(m.id);
    if (!asked) return;
    waiting.delete(m.id);
    if (m.error) asked.reject(new Error(m.error.message));
    else asked.resolve(m.result);
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  result.chrome = (await send("Browser.getVersion")).product;
  const { targetInfos } = await send("Target.getTargets");
  const { sessionId: page } = await send("Target.attachToTarget", { targetId: targetInfos.find((t: { type: string }) => t.type === "page").targetId, flatten: true });
  for (const domain of ["Page", "Runtime"]) await send(`${domain}.enable`, {}, page);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page);
  // Headless, the page is in front and focused as a window on a screen is.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
  const evaluate = async <T = any>(expression: string, session = page): Promise<T> => {
    const { result: value, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return value.value as T;
  };
  const navigate = (url: string) => send("Page.navigate", { url }, page);
  const hash = () => evaluate<string>("location.hash");
  const click = async (js: string, what: string) => {
    const box = await until(what, () => evaluate<{ x: number; y: number } | null>(`(() => { const el = ${js}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`));
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, page);
  };
  type Shown = { title: string; body: string; tag: string; data: any; silent: boolean | null };
  const shown = () => evaluate<Shown[]>(`navigator.serviceWorker.getRegistration().then((r) => r ? r.getNotifications() : []).then((ns) => ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data, silent: n.silent })))`);
  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `push-${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" }, page)).data, "base64"));
  };

  // ---------- 1. pair, and turn notifications on from Settings ----------
  await navigate(await (await fetch(`${front}/__dev/invite`)).text());
  await click(`document.querySelector("form.card button[type=submit]")`, "the pairing page's Ask to join");
  await until("the app after pairing", () => evaluate(`Boolean(document.querySelector(".shell"))`), 60_000);
  // The browser's leave, as a person gives it when Chrome asks.
  await send("Browser.grantPermissions", { origin: front, permissions: ["notifications"] });
  await navigate(`${front}/#/settings`);
  await until("the service worker", () => evaluate(`navigator.serviceWorker.getRegistration().then((r) => r?.active?.state === "activated")`), 30_000);
  const toggle = `[...document.querySelectorAll("label.switch")].find((l) => l.textContent.includes("Notifications on this device") && !l.querySelector("input").disabled)`;
  const subscribeAt = Date.now();
  await click(toggle, "Settings' notifications switch");
  const device = await until("the node's subscription for this browser", async () => (await admin("notify")).devices.find((d: { service: string }) => d.service === "Google"), 90_000, 250);
  result.subscribed = { service: device.service, ms: Date.now() - subscribeAt };
  check(device.service === "Google", `on, through Google's push service, in ${Date.now() - subscribeAt} ms`);
  await shot("settings-on");

  // ---------- 2. what waited ----------
  const catchUp = await until("the catch-up", async () => (await shown()).find((n) => n.data?.open === "inbox"), 90_000, 25);
  result.catchUp = { title: catchUp.title, body: catchUp.body };
  check(/things? waits? for you/.test(catchUp.title), `what waited: "${catchUp.title}"`);

  // ---------- 3. a test ----------
  await sleep(5_500);
  const testAt = Date.now();
  await click(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Send a test")`, "Send a test");
  const test = await until("the test", async () => (await shown()).find((n) => n.tag === "test"), 60_000, 25);
  const testSeen = Date.now();
  const testSent = (await sentSince(testAt)).find((s) => s.kind === "test");
  result.test = { pressedToShownMs: testSeen - testAt, sentToShownMs: testSent ? testSeen - testSent.at : null };
  check(test.title === "Invincible", `a test: pressed → shown ${testSeen - testAt} ms (taken by Google → shown ${testSent ? testSeen - testSent.at : "?"} ms)`);

  // A tap, as Chrome's click delivers it: notificationclick in the worker, with the notification Chrome holds.
  const worker = (await send("Target.getTargets")).targetInfos.find((t: { type: string }) => t.type === "service_worker");
  const { sessionId: sw } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const tap = (tag: string) => evaluate<boolean>(`self.registration.getNotifications({ tag: ${JSON.stringify(tag)} }).then((ns) => { if (!ns[0]) return false; try { self.dispatchEvent(new NotificationEvent("notificationclick", { notification: ns[0] })); } catch {} return true; })`, sw);

  // ---------- 4. a task ends while Home is in front ----------
  await navigate(`${front}/#/home`);
  await sleep(1_000);
  const room = (await admin("directAgent", { id: "writer" })).room.id;
  const key = `m${Date.now().toString(36)}`;
  const taskAt = Date.now();
  const task = (await admin("createTeamTask", { room, assignee: "writer", title: "Measure: a task that ends", goal: `TASK_PROVE_${key}: make the measured check handle its case, with that test.`, dependsOn: [], gates: [`bun test measured # gate-prove-${key}`] })).task.id as string;
  const told = await until("the task's notification", async () => (await shown()).find((n) => n.data?.task === task), 180_000, 25);
  const taskSeen = Date.now();
  const taskSent = (await sentSince(taskAt)).find((s) => s.kind === "finished");
  await shot("home-task-told");
  await tap(told.tag);
  const landed = await until("the task's own thread", async () => ((await hash()) === `#/task/${task}` ? "yes" : null), 10_000).catch(() => null);
  await sleep(1_200);
  await shot("task-after-tap");
  result.task = { title: told.title, body: told.body, data: told.data, givenToShownMs: taskSeen - taskAt, sentToShownMs: taskSent ? taskSeen - taskSent.at : null, landedOn: await hash() };
  check(told.data?.open === "task" && told.data?.task === task, `a task's end: "${told.title}", given → shown ${taskSeen - taskAt} ms (taken by Google → shown ${taskSent ? taskSeen - taskSent.at : "?"} ms), naming the task`);
  check(landed !== null, `tapped, it opens that very task (${await hash()})`);

  // ---------- 5. an approval while Home is in front ----------
  await navigate(`${front}/#/home`);
  await sleep(1_000);
  const before = new Set((await shown()).map((n) => n.tag));
  const askAt = Date.now();
  await askApproval("Measured: the release notes are ready.");
  const approval = await until("the approval's notification", async () => (await shown()).find((n) => !before.has(n.tag) && n.data?.open === "inbox"), 180_000, 25);
  const approvalSeen = Date.now();
  const approvalSent = (await sentSince(askAt)).find((s) => s.kind === "approval");
  await tap(approval.tag);
  const inInbox = await until("the Inbox", async () => ((await hash()) === "#/inbox" ? "yes" : null), 10_000).catch(() => null);
  await shot("inbox-after-tap");
  result.approval = { title: approval.title, body: approval.body, silent: approval.silent, askedToShownMs: approvalSeen - askAt, sentToShownMs: approvalSent ? approvalSeen - approvalSent.at : null, landedOn: await hash() };
  check(approval.silent === false, `an approval: asked → shown ${approvalSeen - askAt} ms (taken by Google → shown ${approvalSent ? approvalSeen - approvalSent.at : "?"} ms), with its sound`);
  check(inInbox !== null, `tapped, it opens the Inbox (${await hash()})`);

  // ---------- 6. quiet while the Inbox is in front ----------
  await sleep(1_000);
  const seen = new Set((await shown()).map((n) => n.tag));
  const quietAt = Date.now();
  await askApproval("Measured: one more post for your answer.");
  const quietSent = await until("the node's send of the second approval", async () => (await sentSince(quietAt)).find((s) => s.kind === "approval"), 180_000, 250);
  await sleep(6_000);
  const over = (await shown()).filter((n) => !seen.has(n.tag));
  result.quiet = { sent: quietSent.ok, shownOverTheInbox: over.length };
  check(quietSent.ok && over.length === 0, `quiet while the Inbox is in front: the node sent it (${quietSent.ok ? "taken" : "refused"}), and ${over.length} shown over the page`);
} catch (error) {
  failures.push((error as Error).message);
  say(`FAIL ${(error as Error).message}`);
} finally {
  await tidy();
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ ...result, failures }, null, 2));
console.log(JSON.stringify({ ...result, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
