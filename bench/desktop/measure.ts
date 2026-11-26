import { createHash } from "node:crypto";
import { type Bench, BenchVm, IN_VM, type Ran, window } from "./vm.ts";

/*
 * C0's measurements (c0/bench: boot.sh, core.sh, agentcmd.ts, host-desktop.ts, typefix.sh, frag.sh, res.sh,
 * watchonly.sh), each a function that returns what it measured as numbers. The suite (bench/suites/desktop.ts) records
 * them. Pages are served from the VM's own loopback (kit/server.py).
 */

export const PAGE = (name: string): string => `http://127.0.0.1:8000/${name}`;
/** The test string: Danish capitals, a dash, a degree sign, a check mark, the euro, an umlaut, Japanese and an emoji. 40 characters. */
export const TEST_STRING = "Søren Ærø – blåbærgrød 25 °C ✓ € ü 日本語 🙂";

const json = (r: Ran): Record<string, any> => {
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {
    return {};
  }
};
const must = (r: Ran, what: string): Ran => {
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return r;
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Timed samples, and when they were taken. */
export interface Samples {
  samples: number[];
  span: [number, number];
}
const timed = async (n: number, f: (i: number) => Promise<number>): Promise<Samples> => {
  const t0 = performance.now();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) samples.push(await f(i));
  return { samples, span: [t0, performance.now()] };
};

/* ---------- 2.1 boot to a usable desktop ---------- */

export interface Boot {
  toUsable: Samples;
  vm: Samples;
  start: Samples;
  firstOpen: Samples;
  firstShot: Samples;
  usable: number;
}

/** Fresh VMs, one after another: made as an agent's is, then the desktop started, a page opened, and a picture taken. */
export async function boot(b: Bench, n: number, seed: number): Promise<Boot> {
  const rows: { vm: number; start: number; open: number; shot: number; ok: boolean }[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const { vm, ms } = await BenchVm.make(b, { desktop: true, seed: seed + i });
    try {
      await vm.ready(seed);
      const start = must(await vm.raw(["desktop", "start"]), "desktop start").ms;
      const open = must(await vm.raw(["desktop", "open", PAGE("form.html")]), "desktop open").ms;
      const shot = must(await vm.raw(["desktop", "shot", "/tmp/boot.png"]), "desktop shot").ms;
      const ok = (await vm.raw(["desktop", "text"])).stdout.includes("Full name");
      rows.push({ vm: ms, start, open, shot, ok });
      b.log(`boot ${i + 1}/${n}: ${Math.round(ms + start + open + shot)} ms`);
    } finally {
      await vm.remove();
    }
    await Bun.sleep(1000);
  }
  const span: [number, number] = [t0, performance.now()];
  const of = (f: (r: (typeof rows)[number]) => number): Samples => ({ samples: rows.map(f), span });
  return { toUsable: of((r) => r.vm + r.start + r.open + r.shot), vm: of((r) => r.vm), start: of((r) => r.start), firstOpen: of((r) => r.open), firstShot: of((r) => r.shot), usable: rows.filter((r) => r.ok).length };
}

/* ---------- 2.2, 2.3 inside the VM ---------- */

export interface Core {
  execTrue: Samples;
  shotPng: Samples;
  shotJpg: Samples;
  clickPixels: Samples;
  clickReturns: Samples;
  clickDead: Samples;
  keyPixels: Samples;
  keyReturns: Samples;
  /** Of the actions timed, how many changed no pixel before the command returned. */
  staleAfterReturn: number;
}

/** Each command timed in the VM by a few lines of Python there: the command's own cost, with no exec around it. */
async function inVm(vm: BenchVm, argv: string[], n: number): Promise<number[]> {
  const script = `import json,subprocess,sys,time
argv=json.loads(sys.argv[1]); t=[]
for _ in range(int(sys.argv[2])):
    s=time.monotonic(); subprocess.run(argv,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); t.append((time.monotonic()-s)*1000)
print(json.dumps(t))`;
  const r = must(await vm.raw(["python3", "-c", script, JSON.stringify(argv), String(n)], { env: { DISPLAY: ":1" } }), `timing ${argv.join(" ")} in the VM`);
  return JSON.parse(r.stdout.trim()) as number[];
}

export async function core(vm: BenchVm): Promise<Core> {
  const execTrue = await timed(20, async () => (await vm.raw(["true"])).ms);
  must(await vm.raw(["desktop", "open", PAGE("long.html")]), "open long.html");
  let t0 = performance.now();
  const png = await inVm(vm, ["desktop", "shot", "/tmp/s.png"], 20);
  const shotPng = { samples: png, span: [t0, performance.now()] as [number, number] };
  t0 = performance.now();
  const jpg = await inVm(vm, ["desktop", "shot", "/tmp/s.jpg"], 20);
  const shotJpg = { samples: jpg, span: [t0, performance.now()] as [number, number] };
  must(await vm.raw(["desktop", "open", PAGE("color.html")]), "open color.html");
  const a2p = async (argv: string[]) => {
    const rows: Record<string, any>[] = [];
    const t = performance.now();
    for (let i = 0; i < 15; i++) {
      rows.push(json(await vm.raw(["python3", `${IN_VM}/probe.py`, "a2p", "640", "450", "10", "--", ...argv], { env: { DISPLAY: ":1" } })));
      await Bun.sleep(300);
    }
    return { rows, span: [t, performance.now()] as [number, number] };
  };
  const clicks = await a2p(["desktop", "click", "640", "450"]);
  const keys = await a2p(["desktop", "key", "space"]);
  const changed = (rows: Record<string, any>[]) => rows.filter((r) => typeof r.pixels_ms === "number");
  const stale = [...clicks.rows, ...keys.rows].filter((r) => r.stale_after_exit).length;
  if (changed(clicks.rows).length < 10 || changed(keys.rows).length < 10) throw new Error(`the screen didn't change after the actions: ${JSON.stringify(clicks.rows.slice(0, 2))}`);
  return {
    execTrue,
    shotPng,
    shotJpg,
    clickPixels: { samples: changed(clicks.rows).map((r) => r.pixels_ms), span: clicks.span },
    clickReturns: { samples: clicks.rows.map((r) => r.command_ms), span: clicks.span },
    clickDead: { samples: changed(clicks.rows).map((r) => Math.max(0, r.command_ms - r.pixels_ms)), span: clicks.span },
    keyPixels: { samples: changed(keys.rows).map((r) => r.pixels_ms), span: keys.span },
    keyReturns: { samples: keys.rows.map((r) => r.command_ms), span: keys.span },
    staleAfterReturn: stale,
  };
}

/* ---------- through the node's paths ---------- */

export interface Paths {
  agentTrue: Samples;
  agentClick: Samples;
  agentKey: Samples;
  agentShot: Samples;
  ownerLook: Samples;
  ownerClick: Samples;
  ownerKey: Samples;
  /** The owner's look of a text page, base64 bytes. */
  lookBytes: number;
}

export async function paths(vm: BenchVm): Promise<Paths> {
  const agent = (command: string) => timed(10, async () => must(await vm.agent(command), command).ms);
  must(await vm.raw(["desktop", "open", PAGE("long.html")]), "open long.html");
  const agentTrue = await agent("true");
  const agentClick = await agent("desktop click 640 450");
  const agentKey = await agent("desktop key space");
  // (C0's 136 ms is a JPEG's: 111 ms of path and the 25 ms a JPEG takes in the VM.)
  const agentShot = await agent("desktop shot /tmp/agent.jpg");
  must(await vm.raw(["desktop", "open", PAGE("long.html")]), "open long.html");
  let lookBytes = 0;
  const ownerLook = await timed(20, async () => {
    const { view, ms } = await vm.owner({ do: "look" });
    lookBytes = view.shot.data.length;
    return ms;
  });
  must(await vm.raw(["desktop", "open", PAGE("color.html")]), "open color.html");
  const ownerClick = await timed(10, async () => (await vm.owner({ do: "click", x: 640, y: 450 })).ms);
  const ownerKey = await timed(10, async () => (await vm.owner({ do: "key", keys: ["space"] })).ms);
  return { agentTrue, agentClick, agentKey, agentShot, ownerLook, ownerClick, ownerKey, lookBytes };
}

/** 2.4: a look, a click and a look, through the agent's path, with the stand-in eyes answering at once. */
export async function lookActLook(vm: BenchVm): Promise<Samples> {
  must(await vm.raw(["desktop", "open", PAGE("long.html")]), "open long.html");
  return timed(5, async () => {
    const a = must(await vm.agent('desktop look "Where is the heading?"'), "desktop look");
    const [x, y] = a.stdout.trim().split(",").map(Number);
    const c = must(await vm.agent(`desktop click ${x} ${y}`), "desktop click");
    const d = must(await vm.agent('desktop look "Did anything change?"'), "desktop look");
    return a.ms + c.ms + d.ms;
  });
}

/* ---------- 2.8 typing ---------- */

export interface Typing {
  /** Exact, of tries, in each app. */
  exact: Record<"chromium" | "xterm" | "mousepad", { exact: number; of: number; note?: string }>;
  ms: Samples;
  got: string[];
}

export async function typing(vm: BenchVm, n: number): Promise<Typing> {
  const got: string[] = [];
  const ms: number[] = [];
  const t0 = performance.now();
  let exact = 0;
  for (let i = 0; i < n; i++) {
    must(await vm.raw(["desktop", "open", PAGE("type.html")]), "open type.html");
    await vm.raw(["desktop", "click", "640", "300"]);
    // As C0 typed it (typefix.sh): the VM's own command, in a UTF-8 locale.
    const typed = await vm.raw(["desktop", "type", TEST_STRING], { env: { LC_ALL: "C.UTF-8" } });
    ms.push(typed.ms);
    await Bun.sleep(300);
    const value = String(json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "eval", "document.getElementById('t').value"])).value ?? "");
    got.push(value);
    if (value === TEST_STRING) exact++;
  }
  const has = async (app: string) => (await vm.raw(["sh", "-c", `command -v ${app}`])).code === 0;
  const absent = (app: string) => ({ exact: 0, of: 0, note: `no ${app} in the image` });
  return {
    exact: { chromium: { exact, of: n }, xterm: (await has("xterm")) ? absent("way to read back what xterm took yet") : absent("xterm"), mousepad: (await has("mousepad")) ? absent("way to read back what mousepad took yet") : absent("mousepad") },
    ms: { samples: ms, span: [t0, performance.now()] },
    got,
  };
}

/* ---------- §3 what breaks: the F tests ---------- */

export interface Fragile {
  /** F1: text typed with nothing that takes it focused is an error (1), or lost with exit 0 (0). */
  blindTypeRefused: number;
  /** F4: how long `desktop text` takes while a JavaScript alert is up, and whether it said so (within a second). */
  alertMs: number;
  alertReported: number;
  /** F5: of two cases (the new tab in front; the first tab brought back to the front), how many `desktop text` read right. */
  frontTabRead: number;
  /** F6: of the owner's pictures right after a click that navigates, how many still show the old page. */
  staleAfterNavigation: number;
  navigations: number;
  /** F7: of five double clicks, how many the page counted. */
  doubleClicks: number;
  /** F9: a killed browser, back for the next command: its time, and whether that command worked. */
  browserBackMs: number;
  browserBack: number;
  /** F10: the last tab closed, and the next `desktop text`: whether it read a page. */
  afterLastTab: number;
}

const kitEval = async (vm: BenchVm, js: string): Promise<unknown> => json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "eval", js])).value;
const centre = async (vm: BenchVm, css: string): Promise<{ x: number; y: number }> => {
  const p = json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "dom", css]));
  if (typeof p.x !== "number") throw new Error(`no ${css} on the page: ${JSON.stringify(p)}`);
  return { x: p.x, y: p.y };
};
const digest = (base64: string): string => createHash("sha256").update(base64).digest("hex");

/** The browser's main process in the VM, by what /proc says it is: its id, for a kill by id. */
const BROWSER_PID = `for d in /proc/[0-9]*; do p=\${d#/proc/}; [ "$(cat $d/comm 2>/dev/null)" = chromium ] || continue; pp=$(awk '{print $4}' $d/stat); [ "$(cat /proc/$pp/comm 2>/dev/null)" = chromium ] || { echo $p; break; }; done`;

export async function fragile(vm: BenchVm, navigations: number): Promise<Fragile> {
  // F1: a page with nothing focused, and text typed at once.
  must(await vm.raw(["desktop", "open", PAGE("form.html")]), "open form.html");
  const blind = await vm.agent("desktop type 'typed-blind'");
  const blindTypeRefused = blind.code !== 0 ? 1 : 0;

  // F4: a JavaScript alert, and the page read while it is up.
  must(await vm.raw(["desktop", "open", PAGE("alert.html")]), "open alert.html");
  await Bun.sleep(1500);
  const text = await vm.raw(["desktop", "text"], { timeoutMs: 60_000 });
  const alertMs = text.ms;
  const alertReported = alertMs <= 1000 && /alert|dialog|Hello from the page/i.test(text.stdout + text.stderr) ? 1 : 0;
  await vm.raw(["desktop", "key", "Return"]);
  await Bun.sleep(500);

  // F5: a link that opens a second tab: the new one in front, then the first brought back.
  must(await vm.raw(["desktop", "open", PAGE("newtab.html")]), "open newtab.html");
  const link = await centre(vm, "#go");
  await vm.raw(["desktop", "click", String(link.x), String(link.y)]);
  await Bun.sleep(1500);
  let frontTabRead = (await vm.raw(["desktop", "text"])).stdout.startsWith("color 0") ? 1 : 0;
  await vm.raw(["desktop", "key", "ctrl+1"]);
  await Bun.sleep(800);
  frontTabRead += (await vm.raw(["desktop", "text"])).stdout.startsWith("first tab") ? 1 : 0;
  await vm.raw(["desktop", "key", "ctrl+2"]);
  await Bun.sleep(300);
  await vm.raw(["desktop", "key", "ctrl+w"]);
  await Bun.sleep(500);

  // F6: the owner's picture right after a click that navigates to a page that takes 1.5 s.
  let staleAfterNavigation = 0;
  for (let i = 0; i < navigations; i++) {
    must(await vm.raw(["desktop", "open", PAGE("nav.html")]), "open nav.html");
    const go = await centre(vm, "#go");
    const before = (await vm.owner({ do: "move", x: go.x, y: go.y })).view.shot.data;
    const after = (await vm.owner({ do: "click", x: go.x, y: go.y })).view.shot.data;
    await Bun.sleep(2500);
    const arrived = (await vm.owner({ do: "look" })).view.shot.data;
    const stale = digest(after) === digest(before) || (digest(after) !== digest(arrived) && Math.abs(after.length - before.length) < Math.abs(after.length - arrived.length));
    if (stale) staleAfterNavigation++;
  }

  // F7: five double clicks, 0.3 s apart.
  must(await vm.raw(["desktop", "open", PAGE("dbl.html")]), "open dbl.html");
  for (let i = 0; i < 5; i++) {
    await vm.raw(["desktop", "click", "640", "450", "double"]);
    await Bun.sleep(300);
  }
  await Bun.sleep(300);
  const doubleClicks = Number(String(await kitEval(vm, "document.title")).replace(/^dbl /, "")) || 0;

  // F9: the browser killed (by its process id), and the next command.
  await vm.raw(["sh", "-c", `p=$(${BROWSER_PID}); [ -n "$p" ] && kill -KILL "$p"`]);
  await Bun.sleep(1000);
  const back = await vm.raw(["desktop", "open", PAGE("color.html")]);
  const browserBackMs = back.ms;
  const browserBack = back.code === 0 && back.stdout.includes("color") ? 1 : 0;

  // F10: the last tab closed by the agent, then the page read.
  await vm.raw(["desktop", "key", "ctrl+w"]);
  await Bun.sleep(1000);
  const after = await vm.raw(["desktop", "text"]);
  const afterLastTab = after.code === 0 && after.stdout.trim().length > 0 ? 1 : 0;
  return { blindTypeRefused, alertMs, alertReported, frontTabRead, staleAfterNavigation, navigations, doubleClicks, browserBackMs, browserBack, afterLastTab };
}

/* ---------- 2.5 what each state costs the host, and 2.7 what watching costs ---------- */

export interface Cost {
  cpuPct: number;
  pssMb: number;
  qemuRssMb: number;
}

export interface Costs {
  workshopIdle: Cost;
  unstarted: Cost;
  idle: Cost;
  busy: Cost;
  watchedBusy: Cost;
  watched: Cost;
  afterBusy: Cost;
  /** What the owner's watching moves while the screen is still (the app's look every 2 s), kbit/s. */
  stillKbit: number;
}

/** The owner watching as the app does: a look every 2 s until `end`. Its pictures' sizes, base64. */
async function watch(vm: BenchVm, end: number, sizes: number[] = []): Promise<number[]> {
  while (performance.now() < end - 100) {
    const t = performance.now();
    sizes.push((await vm.owner({ do: "look" })).view.shot.data.length);
    await Bun.sleep(Math.max(0, 2000 - (performance.now() - t)));
  }
  return sizes;
}

/**
 * C0's states (res.sh), each a window on a VM of its own making: a workshop VM idle; then a fresh desktop VM, its
 * desktop not started, then up on a form page and idle, busy (a canvas animation), watched while the agent scrolls,
 * watched alone, and idle again. The VM is removed after.
 */
export async function costs(b: Bench, seed: number, seconds: number): Promise<Costs> {
  const { vm: workshop } = await BenchVm.make(b, { desktop: false, seed: seed + 100 });
  let workshopIdle: Cost;
  try {
    await Bun.sleep(5000);
    workshopIdle = await window(await workshop.containerId(), seconds);
  } finally {
    await workshop.remove();
  }
  const { vm } = await BenchVm.make(b, { desktop: true, seed: seed + 200 });
  try {
    const id = await vm.containerId();
    await Bun.sleep(5000);
    const unstarted = await window(id, seconds);
    await vm.ready(seed);
    must(await vm.raw(["desktop", "open", PAGE("form.html")]), "open form.html");
    await Bun.sleep(3000);
    const idle = await window(id, seconds);
    must(await vm.raw(["desktop", "open", PAGE("anim.html")]), "open anim.html");
    await Bun.sleep(2000);
    const busy = await window(id, seconds);
    must(await vm.raw(["desktop", "open", PAGE("long.html")]), "open long.html");
    await vm.raw(["desktop", "move", "640", "450"]);
    const watchedBusy = await window(id, seconds, async (end) => {
      let i = 0;
      await Promise.all([
        watch(vm, end),
        (async () => {
          // (As C0's watch.sh: a scroll and a screenshot, every 2 s.)
          while (performance.now() < end - 200) {
            i++;
            await vm.raw(["desktop", "scroll", i % 3 === 0 ? "up" : "down", i % 3 === 0 ? "5" : "3"]);
            await vm.raw(["desktop", "shot", "/tmp/w.jpg"]);
            await Bun.sleep(2000);
          }
        })(),
      ]);
    });
    must(await vm.raw(["desktop", "open", PAGE("form.html")]), "open form.html");
    await Bun.sleep(2000);
    const sizes: number[] = [];
    const watched = await window(id, seconds, (end) => watch(vm, end, sizes).then(() => {}));
    must(await vm.raw(["desktop", "open", "about:blank"]), "open about:blank");
    await Bun.sleep(2000);
    const afterBusy = await window(id, seconds);
    const stillKbit = sizes.length ? (median(sizes) * 8) / 2 / 1000 : 0;
    return { workshopIdle, unstarted, idle, busy, watchedBusy, watched, afterBusy, stillKbit };
  } finally {
    await vm.remove();
  }
}
