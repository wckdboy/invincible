#!/usr/bin/env bun
/*
 * The Android app held to its performance budgets (apps/android/perf/Budgets.json), on an emulator against a dev node
 * with a busy fleet (apps/apple/scripts/dev-node.ts --heavy --auto-approve), its front reached with adb reverse:
 *   - cold start: am start -W's TotalTime, the median of five (one that gives no time is said, and counted out);
 *   - requests at rest: what the app asks the dev node's counting front in a minute with its first screen in front (the
 *     primary's conversation, since 27 November 2026) and nothing changing;
 *   - screens at rest: an agent's page, a task's at work, failed and ended, and a kept chat, each opened by its link from
 *     a cold start, as a notification opens it, and given a minute with nothing done, every request counted by its path.
 *     A screen reads what it shows only as the live stream says its topic moved, as the web's pages do: its room no
 *     oftener than the app reads the team it is part of, the chat's under way no oftener than it reads the team and the
 *     chats (each one more: a move just before the minute began). A task's trail is said, not held to this, until the
 *     trail is a live topic of its own;
 *   - words shown: yours written in an agent's room on the node, as from another device (/__dev/say), until that agent's
 *     page in front shows them, by its own mark in the log (PerfProbe), three times: an event's time from the node to the
 *     screen, as a room carries it;
 *   - a change shown: a device asking to join (/__dev/poke) until the app's count of what needs you says it, by its own
 *     mark in the log (PerfProbe: debuggable builds only), three times;
 *   - a dead link: the front a black hole (/__dev/blackhole) until the app says it can't reach its node, then back, three
 *     times, each after the link has been up half a minute (one cut sooner backs off, by the shared rule);
 *   - the work scrolled: dumpsys gfxinfo's janky frames over eight swipes down and up on Work (opened from the roster's
 *     foot, as a person does: the app opens on the primary's conversation, whose fresh chat is too short to scroll).
 * A number over its limit fails the run (exit 1); a target missed is said in every run. The Mac's load is said beside
 * the numbers: timing on a shared Mac is only as good as its quiet. What was measured is written as each part ends.
 *
 *   bun apps/android/scripts/perf.ts --front http://127.0.0.1:<port> [--serial emulator-5554] [--out results.json]
 *     [--only start,rest,screens,said,change,deadlink,scroll]   these parts alone (all of them without it)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback?: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const front = arg("front");
if (!front) throw new Error("--front: the dev node's front, as the app reaches it (http://127.0.0.1:<port>)");
const serial = arg("serial", "emulator-5554")!;
const out = arg("out");
const PARTS = ["start", "rest", "screens", "said", "change", "deadlink", "scroll"] as const;
const only = arg("only")?.split(",").map((part) => part.trim());
for (const part of only ?? []) if (!(PARTS as readonly string[]).includes(part)) throw new Error(`--only: no part ${part} (${PARTS.join(", ")})`);
const doing = (part: (typeof PARTS)[number]) => !only || only.includes(part);
const PKG = "sh.invincible.bot.debug";
const ACTIVITY = `${PKG}/sh.invincible.bot.MainActivity`;
const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const budgets = JSON.parse(readFileSync(join(import.meta.dir, "../perf/Budgets.json"), "utf8")) as Record<string, number | string>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const adb = async (...args: string[]) => (await Bun.$`${ADB} -s ${serial} ${args}`.quiet().nothrow()).stdout.toString();
const load = async () => (await Bun.$`sysctl -n vm.loadavg`.text()).trim();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const post = (path: string) => fetch(`${front}${path}`, { method: "POST" });
/** The app's requests to the node since then, as the dev node's front counted them. */
const requestsSince = async (since: number) => ((await (await fetch(`${front}/__dev/requests?since=${since}`)).json()) as { requests: { path: string }[] }).requests;

/** The app's marks (PerfProbe) from now on, as they come: each with the device's own time of it, in ms. */
async function marks(): Promise<{ next: (pattern: RegExp, within: number) => Promise<{ at: number; line: string } | null>; skip: () => void; stop: () => void }> {
  await adb("logcat", "-c");
  const proc = Bun.spawn([ADB, "-s", serial, "logcat", "-v", "epoch", "-s", "InvinciblePerf:I"], { stdout: "pipe" });
  const seen: { at: number; line: string }[] = [];
  (async () => {
    const reader = proc.stdout.getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      rest += new TextDecoder().decode(value);
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const at = Number(/^\s*(\d+\.\d+)/.exec(line)?.[1]);
        if (Number.isFinite(at)) seen.push({ at: at * 1000, line });
      }
    }
  })();
  let read = 0;
  return {
    next: async (pattern, within) => {
      for (const end = Date.now() + within; Date.now() < end; await sleep(25)) {
        while (read < seen.length) {
          const m = seen[read++]!;
          if (pattern.test(m.line)) return m;
        }
      }
      return null;
    },
    /** What came so far is passed over: the next mark looked for is one from now on. */
    skip: () => {
      read = seen.length;
    },
    stop: () => proc.kill(),
  };
}

/** The device's clock now, in ms (the marks' clock: the emulator's, not the Mac's). */
const deviceNow = async () => Number((await adb("shell", "date", "+%s%3N")).trim());

const results: Record<string, unknown> = { load: await load() };
/** What was measured so far, written as each part ends: a later part failing keeps the earlier numbers. */
const save = () => {
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
};
/** Held to the budgets at the end: [name, what was measured, its target]. */
const checks: [string, number, number | undefined][] = [];

// Cold start. (A start the emulator gives no time for, starved by the Mac's other work, is said and counted out.)
if (doing("start")) {
  const starts: number[] = [];
  for (let i = 0; i < 5; i++) {
    await adb("shell", "am", "force-stop", PKG);
    await sleep(1500);
    starts.push(Number(/TotalTime: (\d+)/.exec(await adb("shell", "am", "start", "-W", "-n", ACTIVITY))?.[1] ?? NaN));
    await sleep(3000);
  }
  const timed = starts.filter(Number.isFinite);
  results.coldStartMs = { each: starts, median: timed.length ? median(timed) : NaN, untimed: starts.length - timed.length };
  save();
  checks.push(["coldStartMs", (results.coldStartMs as { median: number }).median, budgets.coldStartTargetMs as number]);
}

// At rest: its first screen in front (the primary's conversation), a minute, nothing changing.
if (doing("rest")) {
  await adb("shell", "am", "start", "-n", ACTIVITY);
  await sleep(5000);
  const since = Date.now();
  await sleep(60_000);
  const asked = (await requestsSince(since)).length;
  results.requestsAtRestPerMinute = asked;
  save();
  checks.push(["requestsAtRestPerMinute", asked, undefined]);
}

// Screens at rest, each opened by its link from a cold start: what each asks in a minute, by path, and whether it read
// only as its topics moved.
if (doing("screens")) {
  const tasks = (await (await fetch(`${front}/__dev/tasks`)).json()) as { working: string; failed: string; proven: string | null };
  const chats = (await (await fetch(`${front}/__dev/chats`)).json()) as { long: string[]; shown: string | null };
  const screens: [string, string][] = [["agent", "invincible://agent/builder"], ["task-working", `invincible://task/${tasks.working}`], ["task-failed", `invincible://task/${tasks.failed}`]];
  if (tasks.proven) screens.push(["task-ended", `invincible://task/${tasks.proven}`]);
  if (chats.long[0]) screens.push(["chat-kept", `invincible://chat/${chats.long[0]}`]);
  const atRest: Record<string, { total: number; byPath: Record<string, number>; follows: boolean; why?: string }> = {};
  let unfollowed = 0;
  for (const [name, link] of screens) {
    await adb("shell", "am", "force-stop", PKG);
    await sleep(1500);
    await adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", link, "-n", ACTIVITY);
    // (Its first reads, and the app's, done: a cold start reads everything once.)
    await sleep(15_000);
    const since = Date.now();
    await sleep(60_000);
    const byPath: Record<string, number> = {};
    const asked = await requestsSince(since);
    for (const request of asked) {
      const path = request.path.split("?")[0]!;
      byPath[path] = (byPath[path] ?? 0) + 1;
    }
    const n = (path: string) => byPath[path] ?? 0;
    const why: string[] = [];
    if (n("/api/team/room") > n("/api/team") + 1) why.push(`its room read ${n("/api/team/room")} times, the team ${n("/api/team")}`);
    if (n("/api/conversations/underway") > n("/api/team") + n("/api/turns") + 1) why.push(`what is under way read ${n("/api/conversations/underway")} times, the team and the chats ${n("/api/team") + n("/api/turns")}`);
    if (why.length) unfollowed += 1;
    atRest[name] = { total: asked.length, byPath, follows: why.length === 0, ...(why.length ? { why: why.join("; ") } : {}) };
    console.log(`${why.length ? "on a timer" : "follows its topics"}  ${name}: ${asked.length} requests in a minute ${JSON.stringify(byPath)}${why.length ? ` (${why.join("; ")})` : ""}`);
  }
  results.screensAtRest = atRest;
  save();
  checks.push(["screensReadingOnATimer", unfollowed, undefined]);
}

// Words shown: yours, written on the node as from another device, until the agent's page in front shows them.
if (doing("said")) {
  await adb("shell", "am", "force-stop", PKG);
  await sleep(1500);
  await adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", "invincible://agent/builder", "-n", ACTIVITY);
  await sleep(15_000);
  const log = await marks();
  const shown: number[] = [];
  for (let i = 0; i < 3; i++) {
    // (The agent's answer to the last, and anything else meanwhile, passed over.)
    await sleep(8000);
    log.skip();
    const at = await deviceNow();
    await post("/__dev/say?agent=builder");
    const m = await log.next(/said \d+/, 15_000);
    shown.push(m ? Math.round(m.at - at) : NaN);
  }
  log.stop();
  results.saidShownMs = { each: shown, worst: Math.max(...shown) };
  save();
  console.log(`words shown in ${shown.join(", ")} ms (said, not held)`);
}

// A change shown, and a dead link said and back.
if (doing("change") || doing("deadlink")) {
  await adb("shell", "am", "start", "-n", ACTIVITY);
  await sleep(5000);
  const log = await marks();
  if (doing("change")) {
    const shown: number[] = [];
    for (let i = 0; i < 3; i++) {
      const at = await deviceNow();
      await post("/__dev/poke");
      const m = await log.next(/needs \d+/, 10_000);
      shown.push(m ? Math.round(m.at - at) : NaN);
      await sleep(2000);
    }
    results.changeShownMs = { each: shown, worst: Math.max(...shown) };
    save();
    checks.push(["changeShownMs", (results.changeShownMs as { worst: number }).worst, undefined]);
  }
  if (doing("deadlink")) {
    const noticed: number[] = [];
    const back: number[] = [];
    for (let i = 0; i < 3; i++) {
      await sleep(31_000);
      const at = await deviceNow();
      await post("/__dev/blackhole?on=1");
      const lost = await log.next(/link lost/, 20_000);
      noticed.push(lost ? Math.round(lost.at - at) : NaN);
      const off = await deviceNow();
      await post("/__dev/blackhole?on=0");
      const again = await log.next(/link back/, 60_000);
      back.push(again ? Math.round(again.at - off) : NaN);
    }
    results.deadLinkNoticedMs = { each: noticed, worst: Math.max(...noticed) };
    results.deadLinkBackMs = { each: back, worst: Math.max(...back) };
    save();
    checks.push(["deadLinkNoticedMs", (results.deadLinkNoticedMs as { worst: number }).worst, undefined]);
    checks.push(["deadLinkBackMs", (results.deadLinkBackMs as { worst: number }).worst, undefined]);
  }
  log.stop();
}

// The work scrolled: Work opened from the roster's foot (the roster's button, then its row), each found by its words in
// the screen's accessibility tree, as a person finds them.
if (doing("scroll")) {
  await adb("shell", "am", "start", "-n", ACTIVITY);
  await sleep(3000);
  // (The tree is read again a few times while the screen settles; one other reader of it, such as a device panel's helper,
  // holds it from this one.)
  for (const label of ["Your agents", "Work"]) {
    let bounds: RegExpExecArray | null = null;
    for (let tries = 0; !bounds && tries < 5; tries++) {
      if (tries) await sleep(1000);
      const tree = await adb("exec-out", "uiautomator", "dump", "/dev/tty");
      // (A label may go on: "Your agents: 9 need you" while something needs you.)
      const said = new RegExp(`(?:content-desc|text)="${label}(?:"|[:,] )`);
      const node = [...tree.matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((n) => said.test(n));
      bounds = node ? /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node) : null;
    }
    if (!bounds) throw new Error(`nothing to press on the screen: ${label} (is another reader of its accessibility tree open?)`);
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    await adb("shell", "input", "tap", String(Math.round((x1! + x2!) / 2)), String(Math.round((y1! + y2!) / 2)));
    await sleep(1500);
  }
  await adb("shell", "dumpsys", "gfxinfo", PKG, "reset");
  for (let i = 0; i < 8; i++) {
    await adb("shell", "input", "swipe", "540", "1800", "540", "500", "250");
    await sleep(500);
    await adb("shell", "input", "swipe", "540", "500", "540", "1800", "250");
    await sleep(500);
  }
  const info = await adb("shell", "dumpsys", "gfxinfo", PKG);
  const janky = Number(/Janky frames: \d+ \(([\d.]+)%\)/.exec(info)?.[1] ?? NaN);
  results.scrollJankyPercent = { janky, p50: /50th percentile: (\d+)ms/.exec(info)?.[1], p90: /90th percentile: (\d+)ms/.exec(info)?.[1] };
  save();
  checks.push(["scrollJankyPercent", janky, budgets.scrollJankyTargetPercent as number]);
}
results.loadAfter = await load();

// Held to the budgets: a limit over fails; a target missed is said.
let failed = false;
for (const [name, got, target] of checks) {
  const limit = budgets[name] as number;
  const over = !Number.isFinite(got) || got > limit;
  if (over) failed = true;
  const missed = target !== undefined && Number.isFinite(got) && got > target;
  console.log(`${over ? "OVER " : missed ? "below its limit, target missed" : "met  "}  ${name}: ${got} (limit ${limit}${target !== undefined ? `, target ${target}` : ""})`);
}
console.log(`the Mac's load: ${results.load} before, ${results.loadAfter} after`);
save();
process.exit(failed ? 1 : 0);
