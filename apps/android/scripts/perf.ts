#!/usr/bin/env bun
/*
 * The Android app held to its performance budgets (apps/android/perf/Budgets.json), on an emulator against a dev node
 * with a busy fleet (apps/apple/scripts/dev-node.ts --heavy --auto-approve), its front reached with adb reverse:
 *   - cold start: am start -W's TotalTime, the median of five;
 *   - requests at rest: what the app asks the dev node's counting front in a minute with its first screen in front (the
 *     primary's conversation, since 27 November 2026) and nothing changing;
 *   - a change shown: a device asking to join (/__dev/poke) until the app's count of what needs you says it, by its own
 *     mark in the log (PerfProbe: debuggable builds only), three times;
 *   - a dead link: the front a black hole (/__dev/blackhole) until the app says it can't reach its node, then back, three
 *     times, each after the link has been up half a minute (one cut sooner backs off, by the shared rule);
 *   - the work scrolled: dumpsys gfxinfo's janky frames over eight swipes down and up on Work (opened from the roster's
 *     foot, as a person does: the app opens on the primary's conversation, whose fresh chat is too short to scroll).
 * A number over its limit fails the run (exit 1); a target missed is said in every run. The Mac's load is said beside
 * the numbers: timing on a shared Mac is only as good as its quiet.
 *
 *   bun apps/android/scripts/perf.ts --front http://127.0.0.1:<port> [--serial emulator-5554] [--out results.json]
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
const PKG = "sh.invincible.bot.debug";
const ACTIVITY = `${PKG}/sh.invincible.bot.MainActivity`;
const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const budgets = JSON.parse(readFileSync(join(import.meta.dir, "../perf/Budgets.json"), "utf8")) as Record<string, number | string>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const adb = async (...args: string[]) => (await Bun.$`${ADB} -s ${serial} ${args}`.quiet().nothrow()).stdout.toString();
const load = async () => (await Bun.$`sysctl -n vm.loadavg`.text()).trim();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const post = (path: string) => fetch(`${front}${path}`, { method: "POST" });

/** The app's marks (PerfProbe) from now on, as they come: each with the device's own time of it, in ms. */
async function marks(): Promise<{ next: (pattern: RegExp, within: number) => Promise<{ at: number; line: string } | null>; stop: () => void }> {
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
    stop: () => proc.kill(),
  };
}

/** The device's clock now, in ms (the marks' clock: the emulator's, not the Mac's). */
const deviceNow = async () => Number((await adb("shell", "date", "+%s%3N")).trim());

const results: Record<string, unknown> = { load: await load() };

// Cold start.
const starts: number[] = [];
for (let i = 0; i < 5; i++) {
  await adb("shell", "am", "force-stop", PKG);
  await sleep(1500);
  starts.push(Number(/TotalTime: (\d+)/.exec(await adb("shell", "am", "start", "-W", "-n", ACTIVITY))?.[1] ?? NaN));
  await sleep(3000);
}
results.coldStartMs = { each: starts, median: median(starts) };

// At rest: its first screen in front (the primary's conversation), a minute, nothing changing.
await sleep(5000);
const since = Date.now();
await sleep(60_000);
const asked = ((await (await fetch(`${front}/__dev/requests?since=${since}`)).json()) as { requests: unknown[] }).requests.length;
results.requestsAtRestPerMinute = asked;

// A change shown, and a dead link said and back.
const log = await marks();
const shown: number[] = [];
for (let i = 0; i < 3; i++) {
  const at = await deviceNow();
  await post("/__dev/poke");
  const m = await log.next(/needs \d+/, 10_000);
  shown.push(m ? Math.round(m.at - at) : NaN);
  await sleep(2000);
}
results.changeShownMs = { each: shown, worst: Math.max(...shown) };
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
log.stop();
results.deadLinkNoticedMs = { each: noticed, worst: Math.max(...noticed) };
results.deadLinkBackMs = { each: back, worst: Math.max(...back) };

// The work scrolled: Work opened from the roster's foot (the roster's button, then its row), each found by its words in
// the screen's accessibility tree, as a person finds them.
await adb("shell", "am", "start", "-n", ACTIVITY);
await sleep(3000);
// (The tree is read again a few times while the screen settles; one other reader of it, such as a device panel's helper,
// holds it from this one.)
for (const label of ["Your agents", "Work"]) {
  let bounds: RegExpExecArray | null = null;
  for (let tries = 0; !bounds && tries < 5; tries++) {
    if (tries) await sleep(1000);
    const tree = await adb("exec-out", "uiautomator", "dump", "/dev/tty");
    const node = [...tree.matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((n) => n.includes(`content-desc="${label}"`) || n.includes(`text="${label}"`));
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
results.loadAfter = await load();

// Held to the budgets: a limit over fails; a target missed is said.
const checks: [string, number, number | undefined][] = [
  ["coldStartMs", (results.coldStartMs as { median: number }).median, budgets.coldStartTargetMs as number],
  ["requestsAtRestPerMinute", asked, undefined],
  ["changeShownMs", (results.changeShownMs as { worst: number }).worst, undefined],
  ["deadLinkNoticedMs", (results.deadLinkNoticedMs as { worst: number }).worst, undefined],
  ["deadLinkBackMs", (results.deadLinkBackMs as { worst: number }).worst, undefined],
  ["scrollJankyPercent", janky, budgets.scrollJankyTargetPercent as number],
];
let failed = false;
for (const [name, got, target] of checks) {
  const limit = budgets[name] as number;
  const over = !Number.isFinite(got) || got > limit;
  if (over) failed = true;
  const missed = target !== undefined && Number.isFinite(got) && got > target;
  console.log(`${over ? "OVER " : missed ? "below its limit, target missed" : "met  "}  ${name}: ${got} (limit ${limit}${target !== undefined ? `, target ${target}` : ""})`);
}
console.log(`the Mac's load: ${results.load} before, ${results.loadAfter} after`);
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
