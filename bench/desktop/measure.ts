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
  /** The other way an action could go from the host: an exec of the VM's command each, with no lookup or shell. */
  execClick: Samples;
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
  const execClick = await timed(10, async () => must(await vm.raw(["desktop", "click", "640", "450"]), "desktop click").ms);
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
  return { execClick, agentTrue, agentClick, agentKey, agentShot, ownerLook, ownerClick, ownerKey, lookBytes };
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

/** The id of the window whose name matches, once it has the keyboard's focus (by the oracle), or after a click on it. */
async function focusWindow(vm: BenchVm, name: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const w = json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "window", name]));
    if (typeof w.x === "number") {
      if (!new RegExp(name).test(String(json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "focus"])).name ?? ""))) await vm.raw(["desktop", "click", String(w.x), String(w.y)]);
      for (let j = 0; j < 20; j++) {
        if (new RegExp(name).test(String(json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "focus"])).name ?? ""))) return true;
        await Bun.sleep(100);
      }
    }
    await Bun.sleep(150);
  }
  return false;
}

/** An app of the bench's, started in the VM apart from the command, its process id kept to end it by. */
const startApp = (vm: BenchVm, argv: string) => vm.raw(["sh", "-c", `DISPLAY=:1 setsid ${argv} >/dev/null 2>&1 & echo $! > ${IN_VM}/out/app.pid`]);
const endApp = async (vm: BenchVm) => {
  await vm.raw(["sh", "-c", `p=$(cat ${IN_VM}/out/app.pid 2>/dev/null) && kill -TERM "$p" 2>/dev/null; rm -f ${IN_VM}/out/app.pid; true`]);
  await Bun.sleep(300);
};

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
  // A terminal: what is typed into a line that cat writes to a file, read back.
  const xterm = async () => {
    let right = 0;
    let wrong: string | undefined;
    for (let i = 0; i < n; i++) {
      const file = `${IN_VM}/out/xterm-${i}.txt`;
      // (Its title set: given a command, xterm names its window after it, and the focus it waits for would never come.)
      await startApp(vm, `xterm -T xterm -geometry 100x20+100+100 -e sh -c 'cat > ${file}'`);
      if (await focusWindow(vm, "^xterm$")) {
        const typed = await vm.raw(["desktop", "type", TEST_STRING], { env: { LC_ALL: "C.UTF-8" } });
        await vm.raw(["desktop", "key", "Return"]);
        await Bun.sleep(400);
        const got = (await vm.raw(["cat", file])).stdout;
        if (got === `${TEST_STRING}\n`) right++;
        else wrong ??= `one wrong: the file held ${JSON.stringify(got)}${typed.code ? `, and type said ${JSON.stringify(typed.stderr.trim())}` : ""}`;
      } else wrong ??= "the terminal never took the focus";
      await endApp(vm);
    }
    return { exact: right, of: n, ...(wrong ? { note: wrong.slice(0, 200) } : {}) };
  };
  // An editor: what is typed into a new file of its own, saved where it was named, read back.
  const mousepad = async () => {
    let right = 0;
    let wrong: string | undefined;
    for (let i = 0; i < n; i++) {
      const file = `${IN_VM}/out/mousepad-${i}.txt`;
      await startApp(vm, `mousepad ${file}`);
      if (await focusWindow(vm, "Mousepad$")) {
        await vm.raw(["desktop", "type", TEST_STRING], { env: { LC_ALL: "C.UTF-8" } });
        await vm.raw(["desktop", "key", "ctrl+s"]);
        for (let j = 0; j < 20 && (await vm.raw(["cat", file])).code !== 0; j++) await Bun.sleep(150);
        const got = (await vm.raw(["cat", file])).stdout.replace(/\n$/, "");
        if (got === TEST_STRING) right++;
        else wrong ??= `one wrong: the file held ${JSON.stringify(got)}`.slice(0, 200);
        await vm.raw(["desktop", "key", "ctrl+q"]);
        await Bun.sleep(300);
      }
      await endApp(vm);
    }
    return { exact: right, of: n, ...(wrong ? { note: wrong } : {}) };
  };
  const answer = {
    exact: { chromium: { exact, of: n }, xterm: (await has("xterm")) ? await xterm() : absent("xterm"), mousepad: (await has("mousepad")) ? await mousepad() : absent("mousepad") },
    ms: { samples: ms, span: [t0, performance.now()] as [number, number] },
    got,
  };
  // The desktop as the next measure finds it: the browser with the focus, the pointer over its page.
  await vm.raw(["desktop", "click", "900", "15"]);
  await vm.raw(["desktop", "move", "640", "450"]);
  return answer;
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

/* ---------- the accessibility tree beside the pixels (BRIEF-C1 step 6) ---------- */

/** The form's controls as the tree names them, and the element the DOM has for each (C0 compared these five). */
const FORM_CONTROLS: [role: string, name: string, selector: string][] = [
  ["entry", "Full name", "#name"],
  ["entry", "Email", "#email"],
  ["combo box", "Plan", "#plan"],
  ["check box", "I accept the terms", "#terms"],
  ["push button", "Send", "#send"],
];

export interface A11y {
  /** Of the form's controls, those whose centre by the tree (desktop find) is the DOM's within 2 px. */
  formMatch: number;
  formOf: number;
  /** Each that didn't, and how. */
  misses: string[];
  /** desktop find, through the agent's path. */
  findMs: Samples;
  /** desktop find in the VM, a process each (C0's 74 ms was a process with pyatspi in it). */
  findInVm: Samples;
  /** desktop tree of the typical page, through the agent's path. */
  treeMs: Samples;
  /** The tree of a typical front page, and of the browser's own settings: its size in tokens (characters / 4) and lines. */
  typical: { tokens: number; lines: number };
  settings: { tokens: number; lines: number };
}

const tokens = (text: string): { tokens: number; lines: number } => ({ tokens: Math.ceil(text.length / 4), lines: text.trim().split("\n").length });

export async function a11y(vm: BenchVm, n: number): Promise<A11y> {
  must(await vm.raw(["desktop", "open", PAGE("form.html")]), "open form.html");
  let formMatch = 0;
  const misses: string[] = [];
  for (const [role, name, selector] of FORM_CONTROLS) {
    const found = await vm.agent(`desktop find '${role}' '${name}'`);
    const at = /^(\d+),(\d+)/.exec(found.stdout.trim());
    const dom = json(await vm.raw(["python3", `${IN_VM}/oracle.py`, "dom", selector]));
    if (!at || typeof dom.x !== "number") {
      misses.push(`${role} "${name}": the tree said ${JSON.stringify((found.stdout + found.stderr).trim().slice(0, 120))}, the DOM ${JSON.stringify(dom)}`);
      continue;
    }
    const dx = Math.abs(Number(at[1]) - dom.x), dy = Math.abs(Number(at[2]) - dom.y);
    if (dx <= 2 && dy <= 2) formMatch++;
    else misses.push(`${role} "${name}": the tree's ${at[1]},${at[2]}, the DOM's ${dom.x},${dom.y}`);
  }
  const findMs = await timed(n, async () => must(await vm.agent("desktop find button Send"), "desktop find").ms);
  const inVmFrom = performance.now();
  const findInVm: Samples = { samples: await inVm(vm, ["desktop", "find", "button", "Send"], n), span: [inVmFrom, 0] };
  findInVm.span[1] = performance.now();
  must(await vm.raw(["desktop", "open", PAGE("typical.html")]), "open typical.html");
  const treeMs = await timed(n, async () => must(await vm.agent("desktop tree"), "desktop tree").ms);
  const typical = tokens((await vm.agent("desktop tree")).stdout);
  // The browser's own settings, as an agent reaches them: its address bar.
  await vm.raw(["desktop", "key", "ctrl+l"]);
  await vm.raw(["desktop", "type", "chrome://settings/appearance"]);
  await vm.raw(["desktop", "key", "Return"]);
  await Bun.sleep(1500);
  await vm.raw(["desktop", "settle"]);
  const settings = tokens((await vm.agent("desktop tree")).stdout);
  return { formMatch, formOf: FORM_CONTROLS.length, misses, findMs, findInVm, treeMs, typical, settings };
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

/** What the stream you watch costs on one scene (C1 step 9), read as the node reads it. */
export interface LiveCost {
  /** Frames a second while it keeps moving: the cadence from the window's first frame to its last (0 when it sent none). */
  fps: number;
  /** What the window's frames made, kbit/s, their framing included. */
  kbit: number;
  /** The encoder's own CPU, and deskd's beside it, % of a core (in the VM, from /proc). */
  encoderPct: number;
  deskdPct: number;
  /** From the exec's start to its first frame (a keyframe), ms. */
  firstFrameMs: number;
  /** From each frame's capture (the VM's clock, a Kata guest's being the host's) to its arrival here: the median, ms. */
  lagMs: number;
}

/** C0's scrolling page (§2.7): the kit's long page, scrolled by C0's own script. */
const SCROLLING = "<script>let d=6;setInterval(()=>{scrollBy(0,d);if(innerHeight+scrollY>=document.body.scrollHeight-2||scrollY<=0)d=-d},33)</script>";

const pidOf = async (vm: BenchVm, args: string[]): Promise<string> => (await vm.raw(["pgrep", ...args])).stdout.trim().split("\n")[0] ?? "";

/** A process's CPU ticks in the VM (utime and stime), by its PID. */
async function ticks(vm: BenchVm, pid: string): Promise<number> {
  const stat = (await vm.raw(["cat", `/proc/${pid}/stat`])).stdout;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

/**
 * The stream on the screen as it is: `desktop stream` in a held exec of its own, as the node runs it (its frames: a
 * 4-byte length, a kind, an 8-byte capture time, then Annex B), read here for `seconds`, then ended by closing its stdin.
 */
async function liveFor(vm: BenchVm, deskd: string, hz: number, seconds: number): Promise<LiveCost> {
  const proc = Bun.spawn(["docker", "exec", "-i", vm.container, "desktop", "stream"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const t0 = performance.now();
  const frames: { at: number; bytes: number; lagMs: number }[] = [];
  let buffer = new Uint8Array(0);
  const reading = (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (buffer.length < 4 + length) break;
        const captured = Number(new DataView(buffer.buffer, buffer.byteOffset + 5, 8).getBigUint64(0));
        frames.push({ at: performance.now() - t0, bytes: 4 + length, lagMs: Date.now() - captured });
        buffer = buffer.slice(4 + length);
      }
    }
  })();
  await Bun.sleep(1500);
  const encoder = await pidOf(vm, ["-n", "-x", "desktop-stream"]);
  const [e0, d0, w0] = [await ticks(vm, encoder), await ticks(vm, deskd), performance.now() - t0];
  await Bun.sleep(Math.max(1, seconds - 3) * 1000);
  const [e1, d1, w1] = [await ticks(vm, encoder), await ticks(vm, deskd), performance.now() - t0];
  proc.stdin.end();
  const code = await proc.exited;
  await reading;
  if (code !== 0 || !frames.length) throw new Error(`desktop stream ended ${code} with ${frames.length} frames: ${(await new Response(proc.stderr).text()).trim().slice(-300)}`);
  const inWindow = frames.filter((f) => f.at >= w0 && f.at <= w1);
  const span = (w1 - w0) / 1000;
  const cadence = inWindow.length > 1 ? (inWindow.length - 1) / ((inWindow.at(-1)!.at - inWindow[0]!.at) / 1000) : 0;
  return {
    fps: cadence,
    kbit: (inWindow.reduce((sum, f) => sum + f.bytes, 0) * 8) / 1000 / span,
    encoderPct: ((e1 - e0) / hz / span) * 100,
    deskdPct: ((d1 - d0) / hz / span) * 100,
    firstFrameMs: frames[0]!.at,
    lagMs: inWindow.length ? median(inWindow.map((f) => f.lagMs)) : median(frames.map((f) => f.lagMs)),
  };
}

/**
 * The stream you watch (C1 step 9), as the node runs it, `seconds` on each of C0's scenes (§2.7): a still page,
 * scrolling text, an animation. On a VM of its own, removed after.
 */
export async function live(b: Bench, seed: number, seconds: number): Promise<Record<"still" | "scroll" | "anim", LiveCost>> {
  const { vm } = await BenchVm.make(b, { desktop: true, seed: seed + 300 });
  try {
    await vm.ready(seed);
    must(await vm.raw(["desktop", "start"]), "desktop start");
    const long = must(await vm.raw(["cat", `${IN_VM}/pages/long.html`]), "read long.html").stdout;
    must(await vm.raw(["sh", "-c", `cat > ${IN_VM}/pages/scroll.html`], { stdin: long.replace("</title>", `</title>${SCROLLING}`) }), "write scroll.html");
    const deskd = await pidOf(vm, ["-f", "deskd.py"]);
    const hz = Number((await vm.raw(["getconf", "CLK_TCK"])).stdout.trim()) || 100;
    const out = {} as Record<"still" | "scroll" | "anim", LiveCost>;
    for (const [scene, page] of [["still", "color.html"], ["scroll", "scroll.html"], ["anim", "anim.html"]] as const) {
      must(await vm.raw(["desktop", "open", PAGE(page)]), `open ${page}`);
      await Bun.sleep(2000);
      out[scene] = await liveFor(vm, deskd, hz, seconds);
    }
    return out;
  } finally {
    await vm.remove();
  }
}

/* ---------- C1 step 10: light by default ---------- */

/** The note deskd leaves in its run directory when it stops a desktop for being unused, for the next deskd (deskd.py's RUN and IDLE_NOTE). */
const IDLE_NOTE = "/tmp/invincible-desktop/idle-stopped";
/**
 * How long the bench's deskd waits before it stops an unused desktop, s (INVINCIBLE_DESKTOP_IDLE; the node's waits 600):
 * the first long enough that the desktop's idle window ends well before it, and each started again after it short, so
 * five stops take a minute and not fifty. What stopping does is the same whatever the wait.
 */
const IDLE_FIRST_S = 40;
const IDLE_AGAIN_S = 8;

/** The guest's memory, from its /proc/meminfo, MB: all of it, what it has available, and what is in use (the rest). */
export function guestMemory(meminfo: string): { totalMb: number; availableMb: number; usedMb: number } {
  const kb = (key: string): number => {
    const found = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(meminfo);
    if (!found) throw new Error(`the guest's /proc/meminfo has no ${key}`);
    return Number(found[1]);
  };
  const totalMb = kb("MemTotal") / 1024;
  const availableMb = kb("MemAvailable") / 1024;
  return { totalMb, availableMb, usedMb: totalMb - availableMb };
}

/**
 * What runs in `after` that didn't in `before`, by name (each a `ps -eo comm=`), as often as it runs: what a stopped
 * desktop left behind it. `ps` itself never counts.
 */
export function leftOver(before: string, after: string): string[] {
  const count = (list: string): Map<string, number> => {
    const n = new Map<string, number>();
    for (const name of list.split("\n").map((line) => line.trim())) if (name && name !== "ps") n.set(name, (n.get(name) ?? 0) + 1);
    return n;
  };
  const was = count(before);
  const left: string[] = [];
  for (const [name, n] of count(after)) for (let i = was.get(name) ?? 0; i < n; i++) left.push(name);
  return left.sort();
}

/** One line of the guest's watcher: its memory (kB), its memory limit (bytes: 0 for none, -1 for none it can read), and when the line came (performance.now()). */
export interface MemoryLine {
  at: number;
  totalKb: number;
  limit: number;
}

/**
 * The first of the guest's lines in which the VM has grown by `addedKb` (nine tenths of it at least: the kernel keeps a
 * little of what is added for its own) and, where the guest could read a limit at first, its limit is `limit` or more.
 */
export function grownAt(lines: readonly MemoryLine[], addedKb: number, limit: number): MemoryLine | null {
  const first = lines[0];
  if (!first) return null;
  return lines.find((line) => line.totalKb - first.totalKb >= addedKb * 0.9 && (first.limit <= 0 || line.limit >= limit)) ?? null;
}

/** The guest's memory and its limit (cgroup v2's, else v1's), a line each time they change, until its stdin closes or `argv[1]` s pass. */
const WATCHER = `
import os, sys, threading, time
def total():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                return int(line.split()[1])
    return 0
def limit():
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path) as f:
                v = f.read().strip()
            n = 0 if v == "max" else int(v)
            return 0 if n >= 1 << 62 else n
        except (OSError, ValueError):
            pass
    return -1
threading.Thread(target=lambda: (sys.stdin.read(), os._exit(0)), daemon=True).start()
seen, end = None, time.monotonic() + float(sys.argv[1])
while time.monotonic() < end:
    now = (total(), limit())
    if now != seen:
        print(*now, flush=True)
        seen = now
    time.sleep(0.005)
`;

/** The watcher in an exec of its own: its lines as they come, its first (within 30 s), and its end (its stdin closed; the exec ended if it hasn't in 10 s). */
function watchMemory(vm: BenchVm): { lines: MemoryLine[]; first: () => Promise<void>; end: () => Promise<void> } {
  const proc = Bun.spawn(["docker", "exec", "-i", vm.container, "python3", "-I", "-c", WATCHER, "120"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: MemoryLine[] = [];
  let came = (): void => {};
  const said = new Promise<void>((resolve) => (came = resolve));
  const reading = (async () => {
    const text = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      const at = performance.now();
      rest += text.decode(chunk, { stream: true });
      for (let i = rest.indexOf("\n"); i >= 0; i = rest.indexOf("\n")) {
        const [totalKb, limit] = rest.slice(0, i).trim().split(" ").map(Number);
        rest = rest.slice(i + 1);
        if (Number.isFinite(totalKb) && Number.isFinite(limit)) {
          lines.push({ at, totalKb: totalKb!, limit: limit! });
          came();
        }
      }
    }
  })();
  const ended = proc.exited.then(async (code): Promise<never> => {
    throw new Error(`the guest's watcher ended (${code}) before it said anything: ${(await new Response(proc.stderr).text()).trim().slice(-300)}`);
  });
  ended.catch(() => {});
  return {
    lines,
    first: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the guest's watcher said nothing within 30 s")), 30_000)));
      try {
        await Promise.race([said, ended, late]);
      } finally {
        clearTimeout(timer);
      }
    },
    end: async () => {
      try {
        proc.stdin.end();
      } catch {
        // (It has ended already.)
      }
      if (!(await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]))) proc.kill();
      await proc.exited;
      await reading;
    },
  };
}

/** A VM grown: until the agent's command could go on and the guest had it all (ms), the call alone, and what the guest saw before and after. */
export interface Grown {
  ms: number;
  callMs: number;
  from: MemoryLine;
  to: MemoryLine;
}

/**
 * A VM grown to `memoryGb` as the node grows one at its desktop's first use (SandboxHost.desktopRoom's call to
 * resizeTeam: live, never made again), watched from inside: until both the call has returned (the agent's command waits
 * for it) and the guest has the memory, and the limit where it can read one.
 */
async function grow(b: Bench, vm: BenchVm, memoryGb: number): Promise<Grown> {
  const was = vm.view.memoryGb;
  const watcher = watchMemory(vm);
  try {
    await watcher.first();
    const t0 = performance.now();
    await b.host.resizeTeam(vm.id, vm.run, { memoryGb, approvedBy: "node", reason: `its desktop's first use: grown from ${was} GB to ${memoryGb} GB (the bench)` });
    const callMs = performance.now() - t0;
    const addedKb = (memoryGb - was) * 1024 * 1024;
    const limit = memoryGb * 1024 ** 3;
    let to = grownAt(watcher.lines, addedKb, limit);
    for (const end = t0 + 10_000; !to && performance.now() < end; to = grownAt(watcher.lines, addedKb, limit)) await Bun.sleep(10);
    if (!to) throw new Error(`the VM wasn't grown to ${memoryGb} GB within 10 s, as its guest saw it: ${watcher.lines.map((l) => `${Math.round(l.totalKb / 1024)} MB, limit ${l.limit}`).join("; ")}`);
    return { ms: Math.max(callMs, to.at - t0), callMs, from: watcher.lines[0]!, to };
  } finally {
    await watcher.end();
  }
}

/** What the light-by-default cases ask of a VM: its commands, run as the VM's own. */
type Commands = Pick<BenchVm, "raw">;

/** The VM's processes by name (`ps -eo comm=`), and whether deskd is among them. */
async function processes(vm: Commands): Promise<{ names: string; deskd: boolean }> {
  const names = must(await vm.raw(["ps", "-eo", "comm="]), "ps").stdout;
  return { names, deskd: /deskd\.py/.test(must(await vm.raw(["ps", "-eo", "args="]), "ps").stdout) };
}

/**
 * Until deskd has stopped the desktop for being unused: its note left and deskd gone, within `ms`; then what it started
 * that still runs, by name, against the VM's processes before its desktop first started (given `settleMs`, 5 s, to be
 * gone: deskd ends as it signals the rest to).
 */
async function untilStopped(vm: Commands, before: string, ms: number, settleMs = 5000): Promise<string[]> {
  const t0 = performance.now();
  while ((await vm.raw(["test", "-e", IDLE_NOTE])).code !== 0 || (await processes(vm)).deskd) {
    if (performance.now() - t0 > ms) throw new Error(`the desktop wasn't stopped within ${Math.round(ms / 1000)} s of being left unused`);
    await Bun.sleep(250);
  }
  let left = leftOver(before, (await processes(vm)).names);
  for (const end = performance.now() + settleMs; left.length && performance.now() < end; left = leftOver(before, (await processes(vm)).names)) await Bun.sleep(250);
  return left;
}

/**
 * A start again after an idle stop: what it took to its page, whether its page was read, and whether the agent was told;
 * then its own idle stop, and what of it still runs after that.
 */
export interface Restarted {
  ms: number;
  usable: boolean;
  told: boolean;
  /** By name, against the VM before its desktop first started. A zombie keeps its name: one the VM never reaped is left. */
  left: string[];
}

/**
 * Started again `restarts` times by the VM's own `desktop open` (deskd's wait IDLE_AGAIN_S), to its page, the first
 * after the caller's idle stop; each then left until deskd stops it again, the last one too, so that what every cycle
 * leaves is seen, and what cycles pile up (each stop's against the same before).
 */
export async function restartCycles(vm: Commands, names: string, restarts: number, log: (line: string) => void, settleMs = 5000): Promise<Restarted[]> {
  const rows: Restarted[] = [];
  for (let i = 0; i < restarts; i++) {
    const again = must(await vm.raw(["desktop", "open", PAGE("form.html")], { env: { INVINCIBLE_DESKTOP_IDLE: String(IDLE_AGAIN_S) } }), "desktop open after an idle stop");
    const usable = (await vm.raw(["desktop", "text"])).stdout.includes("Full name");
    log(`started again ${i + 1}/${restarts}: ${Math.round(again.ms)} ms`);
    const left = await untilStopped(vm, names, (IDLE_AGAIN_S + 30) * 1000, settleMs);
    rows.push({ ms: again.ms, usable, told: again.stderr.includes("was stopped after"), left });
  }
  return rows;
}

/** C1 step 10's numbers, on VMs made with 2 GB as the node makes an agent's now. */
export interface Light {
  /** A workshop VM idle, and a desktop VM whose desktop was never started. */
  workshopIdle: Cost;
  unstarted: Cost;
  /** Grown to 4 GB as at its desktop's first use, on three VMs. */
  grow: Samples;
  grown: Grown[];
  /** Its work as it was once grown: a process it ran before still running, and its /work there. */
  keptWork: boolean;
  /** Grown, started by the agent's first desktop command, and idle on a page. */
  idle: Cost;
  /** Once deskd stopped it for being unused: what the host holds, the guest's memory in use over before it first started (MB), and what of it still runs. */
  afterStop: Cost & { guestKeptMb: number; left: string[] };
  /** Started again after an idle stop by the next command, to its first page; whether its page was read, and whether the command told the agent why its screen is fresh. */
  restart: Samples;
  restartUsable: number;
  restartTold: number;
  /** After each restart, its own idle stop: what of it still runs (Restarted.left), one list a restart. */
  restartLeft: string[][];
  restarts: number;
}

/**
 * Light by default (C1 step 10), each on VMs of its own made with 2 GB: a workshop VM idle; two desktop VMs, each only
 * grown; and one whose desktop is never started, then grown, its work checked, started by the agent's first desktop
 * command and left idle, stopped by deskd for being unused, then started again `restarts` times, each after an idle
 * stop and each stopped again. deskd is started by a question (which starts no desktop) to take the bench's wait
 * (IDLE_FIRST_S), and each time again by the VM's own `desktop open` (IDLE_AGAIN_S). Every VM is removed after.
 */
export async function light(b: Bench, seed: number, seconds: number, restarts = 5): Promise<Light> {
  const { vm: workshop } = await BenchVm.make(b, { desktop: false, memoryGb: 2, seed: seed + 400 });
  let workshopIdle: Cost;
  try {
    await Bun.sleep(5000);
    workshopIdle = await window(await workshop.containerId(), seconds);
  } finally {
    await workshop.remove();
  }
  const grown: Grown[] = [];
  const growFrom = performance.now();
  for (let i = 0; i < 2; i++) {
    const { vm } = await BenchVm.make(b, { desktop: true, memoryGb: 2, seed: seed + 410 + i });
    try {
      await Bun.sleep(2000);
      grown.push(await grow(b, vm, 4));
    } finally {
      await vm.remove();
    }
  }
  const { vm } = await BenchVm.make(b, { desktop: true, memoryGb: 2, seed: seed + 420 });
  try {
    const id = await vm.containerId();
    await Bun.sleep(5000);
    const unstarted = await window(id, seconds);
    await vm.ready(seed);
    const server = await pidOf(vm, ["-f", "server.py"]);
    grown.push(await grow(b, vm, 4));
    const growSpan: [number, number] = [growFrom, performance.now()];
    const keptWork = server !== "" && (await pidOf(vm, ["-f", "server.py"])) === server && (await vm.raw(["test", "-e", `${IN_VM}/server.py`])).code === 0;
    const before = guestMemory(must(await vm.raw(["cat", "/proc/meminfo"]), "read /proc/meminfo").stdout);
    const names = (await processes(vm)).names;
    must(await vm.raw(["desktop", "status"], { env: { INVINCIBLE_DESKTOP_IDLE: String(IDLE_FIRST_S) } }), "desktop status");
    must(await vm.agent(`desktop open ${PAGE("form.html")}`), "the agent's first desktop open");
    await Bun.sleep(3000);
    const idle = await window(id, seconds);
    if ((await vm.raw(["test", "-e", IDLE_NOTE])).code === 0 || !(await processes(vm)).deskd) throw new Error(`the desktop stopped within its idle window: ${IDLE_FIRST_S} s is too short a wait for a ${seconds} s window`);
    const left = await untilStopped(vm, names, (IDLE_FIRST_S + 30) * 1000);
    await Bun.sleep(5000);
    const kept = guestMemory(must(await vm.raw(["cat", "/proc/meminfo"]), "read /proc/meminfo").stdout);
    const afterStop = await window(id, seconds);
    const restartFrom = performance.now();
    const rows = await restartCycles(vm, names, restarts, b.log);
    return {
      workshopIdle,
      unstarted,
      grow: { samples: grown.map((g) => g.ms), span: growSpan },
      grown,
      keptWork,
      idle,
      afterStop: { ...afterStop, guestKeptMb: kept.usedMb - before.usedMb, left },
      restart: { samples: rows.map((r) => r.ms), span: [restartFrom, performance.now()] },
      restartUsable: rows.filter((r) => r.usable).length,
      restartTold: rows.filter((r) => r.told).length,
      restartLeft: rows.map((r) => r.left),
      restarts,
    };
  } finally {
    await vm.remove();
  }
}
