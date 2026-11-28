/*
 * A client's polling of a held scratch node (bench/speed/probe-task.ts --hold), timed from outside its process: what each
 * read costs the node, and what one client watching a task costs it (speed, 28 November 2026). Linux (/proc).
 *
 *   bun bench/speed/poll.ts --info <hold-info.json> --route trail|trail-full|team [--every <ms> | --burst <n>] [--seconds 60]
 *
 * - trail: a task's trail from where the reader left off (POST /api/team/trail { task, after: last }), as the web and
 *   Android read it every 1.5 s while a task runs; trail-full: from the start (after: 0), as a page's first read is;
 *   team: the team's snapshot (GET /api/team), as a client reads again when the stream says `team` moved.
 * - --every: at a client's pace for --seconds (the node's CPU over the window, beside its idle before it); --burst: n
 *   reads back to back (each read's cost: the node's CPU over them, divided).
 */
import { readFileSync } from "node:fs";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
const info = JSON.parse(readFileSync(flag("info")!, "utf8")) as { pid: number; port: number; token: string; tasks: string[] };
const route = flag("route") ?? "trail";
const every = flag("every") ? Number(flag("every")) : null;
const burst = flag("burst") ? Number(flag("burst")) : null;
const seconds = Number(flag("seconds") ?? 60);
const TICK = 100;

const cpuMs = (): number => {
  const stat = readFileSync(`/proc/${info.pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) * 1000) / TICK;
};
const loadavg = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const headers = { authorization: `Bearer ${info.token}`, "content-type": "application/json" };
const base = `http://127.0.0.1:${info.port}`;
// (The longest trail of the held tasks: what a page watching it reads.)
const task = info.tasks.at(-1)!;
let after = 0;

async function once(): Promise<{ ms: number; bytes: number }> {
  const t0 = performance.now();
  let text: string;
  if (route === "team") text = await (await fetch(`${base}/api/team`, { headers })).text();
  else {
    const response = await fetch(`${base}/api/team/trail`, { method: "POST", headers, body: JSON.stringify({ task, after: route === "trail-full" ? 0 : after }) });
    text = await response.text();
    if (route === "trail") {
      const page = JSON.parse(text) as { entries: { n: number }[] };
      after = page.entries.at(-1)?.n ?? after;
    }
  }
  return { ms: performance.now() - t0, bytes: text.length };
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// What the node spends doing nothing, first: so a client's share is what comes on top of it.
const idleFrom = cpuMs();
const idleAt = performance.now();
await Bun.sleep(10_000);
const idlePct = ((cpuMs() - idleFrom) / (performance.now() - idleAt)) * 100;

// (A page that reads a trail from where it left off has read it to its end first, page by page.)
if (route === "trail") {
  for (let i = 0; i < 100; i++) {
    const page = (await (await fetch(`${base}/api/team/trail`, { method: "POST", headers, body: JSON.stringify({ task, after }) })).json()) as { entries: { n: number }[]; more: boolean };
    after = page.entries.at(-1)?.n ?? after;
    if (!page.more) break;
  }
}
const samples: { ms: number; bytes: number }[] = [];
const c0 = cpuMs();
const w0 = performance.now();
if (burst) for (let i = 0; i < burst; i++) samples.push(await once());
else {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    samples.push(await once());
    await Bun.sleep(every ?? 1500);
  }
}
const spentMs = cpuMs() - c0;
const wallMs = performance.now() - w0;
const lat = samples.map((s) => s.ms);
console.log(
  JSON.stringify({
    route,
    task,
    mode: burst ? `burst ${burst}` : `every ${every ?? 1500} ms for ${seconds} s`,
    reads: samples.length,
    bytesPerRead: Math.round(samples.reduce((a, s) => a + s.bytes, 0) / samples.length),
    latencyMs: { p50: round(quantile(lat, 0.5)), p90: round(quantile(lat, 0.9)) },
    nodeCpuMsPerRead: round(spentMs / samples.length, 3),
    nodeCpuPctOfCore: round((spentMs / wallMs) * 100, 3),
    nodeIdlePctOfCore: round(idlePct, 3),
    load: loadavg(),
  }),
);
