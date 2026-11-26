import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

/*
 * deskd, the one desktop process of an agent's VM, and `desktop`, its client (sandbox/desktop: deskd.py and
 * desktop.c). The real deskd runs here, with stand-ins for what a VM has (deskd-harness.py: the display, its window
 * manager, the browser, the processes), each writing down what it was asked; the tests speak to it as the VM's
 * command does (the C client, built here) and as the node's held session does (JSON lines on its socket).
 */

const desktopDir = fileURLToPath(new URL("../../../sandbox/desktop/", import.meta.url));
const harness = fileURLToPath(new URL("deskd-harness.py", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "invincible-deskd-"));
const client = join(root, "desktop");
/** Built with the system's compiler, as the image builds it; where there is none, the client's tests say so. */
let built: string | null = null;

beforeAll(() => {
  const cc = Bun.spawnSync(["cc", "-O2", "-Wall", "-Wextra", "-Werror", "-o", client, join(desktopDir, "desktop.c")], { stderr: "pipe" });
  built = cc.exitCode === 0 ? client : null;
  if (!built) console.warn(`deskd.test.ts: the desktop client's tests SKIPPED, unverified: no C compiler here (${cc.stderr.toString().slice(0, 200)})`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Running {
  run: string;
  trace: () => Record<string, unknown>[];
  stop: () => void;
  env: Record<string, string>;
}
const running: Running[] = [];
afterEach(() => {
  for (const r of running.splice(0)) r.stop();
});

/** A fake xdotool on the PATH, for what deskd still hands to it (text the keyboard has no keys for). */
function bin(dir: string, trace: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "xdotool"), `#!/bin/sh\nprintf '{"call":"xdotool","argv":%s}\\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1:]))' "$@")" >> "${trace}"\n`);
  chmodSync(join(dir, "xdotool"), 0o755);
  return dir;
}

async function deskd(env: Record<string, string> = {}): Promise<Running> {
  const dir = mkdtempSync(join(root, "vm-"));
  const run = join(dir, "run");
  const trace = join(dir, "trace");
  writeFileSync(trace, "");
  const all = { PATH: `${bin(join(dir, "bin"), trace)}:${process.env.PATH}`, HOME: dir, INVINCIBLE_DESKTOP_RUN: run, DESKD_TRACE: trace, INVINCIBLE_DESKD: harness, ...env };
  const proc = Bun.spawn(["python3", harness], { env: all, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 500 && !existsSync(join(run, "deskd.sock")); i++) await Bun.sleep(10);
  const r: Running = {
    run,
    env: all,
    trace: () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((t) => t.call !== "serving"),
    stop: () => proc.kill(),
  };
  running.push(r);
  return r;
}

/** The VM's command, as an agent runs it. */
function desktop(r: Running, args: string[], extra: Record<string, string> = {}, cwd = r.run) {
  const t0 = performance.now();
  const p = Bun.spawnSync([built!, ...args], { env: { ...r.env, ...extra }, cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), ms: performance.now() - t0 };
}

/** The node's held session: JSON lines on deskd's socket. */
async function session(r: Running, requests: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const s = createConnection(join(r.run, "deskd.sock"));
    let buffer = "";
    const answers: any[] = [];
    s.on("connect", () => s.write(`SESSION\n${requests.map((q) => (typeof q === "string" ? q : JSON.stringify(q))).join("\n")}\n`));
    s.on("data", (chunk) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        answers.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        if (answers.length === requests.length) {
          s.end();
          resolve(answers);
        }
      }
    });
    s.on("error", reject);
  });
}

/** A PNG's size and its pixels as RGB (it is made with no filter: deskd's own). */
function decodePng(png: Buffer): { width: number; height: number; at: (x: number, y: number) => [number, number, number] } {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; ) {
    const n = png.readUInt32BE(o);
    if (png.subarray(o + 4, o + 8).toString() === "IDAT") idat.push(png.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  return { width, height, at: (x, y) => [raw[y * stride + 1 + x * 3]!, raw[y * stride + 2 + x * 3]!, raw[y * stride + 3 + x * 3]!] };
}

const calls = (trace: Record<string, unknown>[], kind: string) => trace.filter((t) => t.call === kind);
const keys = (trace: Record<string, unknown>[]) => calls(trace, "key").map((t) => `${t.down ? "+" : "-"}${t.key}`);

describe("deskd's held session (the node's): toolset actions in, answers out", () => {
  test("an action is named as the toolset names it, and answers with what it did, whether the screen changed, and the focus", async () => {
    const r = await deskd();
    const [click, typed, key] = await session(r, [
      { id: 1, name: "left_click", input: { coordinate: [640, 450] } },
      { id: 2, name: "type", input: { text: "Hi!" } },
      { id: 3, name: "key", input: { text: "ctrl+l" } },
    ]);
    expect(click).toMatchObject({ id: 1, ok: true, action: "left_click", did: "clicked at 640,450", changed: true, focus: { before: { app: "Chromium" }, after: { app: "Chromium" } } });
    expect(click.changed_ms).toBeLessThan(20);
    expect(click.text).toMatch(/^clicked at 640,450 · the screen changed \(\d+ ms\) · focus: Chromium "about:blank - Chromium"$/);
    // (A text field of the page has the focus: the text goes in by the browser's own insertText. Below, the other ways.)
    expect(typed).toMatchObject({ id: 2, ok: true, did: "typed 3 characters into the page" });
    expect(key).toMatchObject({ id: 3, ok: true, did: "pressed ctrl+l" });
    const t = r.trace();
    expect(calls(t, "motion")).toEqual([{ call: "motion", x: 640, y: 450 }]);
    expect(calls(t, "button").map(({ at, ...b }) => b)).toEqual([{ call: "button", button: 1, down: true }, { call: "button", button: 1, down: false }]);
    expect(keys(t)).toEqual(["+Control_L", "+l", "-l", "-Control_L"]);
  });

  test("an action that changes nothing on the screen says so, having waited no longer than its grace", async () => {
    const r = await deskd({ DESKD_QUIET: "1" });
    const t0 = performance.now();
    const [answer] = await session(r, [{ id: 1, name: "left_click", input: { coordinate: [10, 10] } }]);
    const ms = performance.now() - t0;
    expect(answer).toMatchObject({ ok: true, changed: false, changed_ms: null });
    expect(answer.text).toContain("nothing on the screen changed");
    expect(ms).toBeGreaterThanOrEqual(55);
    expect(ms).toBeLessThan(1000);
  });

  test("a window or a dialog that appears is in the next answer, with its title and its application", async () => {
    const r = await deskd();
    const [opened, after] = await session(r, [
      { id: 1, name: "key", input: { text: "F5" } },
      { id: 2, name: "mouse_move", input: { coordinate: [5, 5] } },
    ]);
    expect(opened.appeared).toEqual([{ id: "0x400002", title: "Save As", app: "Mousepad", dialog: true, box: [300, 200, 600, 400] }]);
    expect(opened.text).toContain('a dialog appeared: "Save As" (Mousepad)');
    expect(after.appeared).toEqual([]);
  });

  test("a screenshot is the screen with the pointer drawn in, as a PNG, at the screen's own size", async () => {
    const r = await deskd();
    const [, shot] = await session(r, [{ id: 1, name: "mouse_move", input: { coordinate: [100, 120] } }, { id: 2, name: "screenshot", input: {} }]);
    expect(shot.image).toMatchObject({ media_type: "image/png", width: 1280, height: 800, settled: { settled: true } });
    const png = decodePng(Buffer.from(shot.image.data, "base64"));
    expect([png.width, png.height]).toEqual([1280, 800]);
    expect(png.at(605, 405)).toEqual([0, 0, 0]);
    expect(png.at(100, 120)).toEqual([255, 0, 0]);
    expect(png.at(102, 122)).toEqual([255, 255, 255]);
  });

  test("a zoom is a region, larger by whole times, in the same space as the screen's coordinates", async () => {
    const r = await deskd();
    const [zoom, bad] = await session(r, [{ id: 1, name: "zoom", input: { region: [600, 400, 640, 425] } }, { id: 2, name: "zoom", input: { region: [10, 10, 5, 5] } }]);
    const png = decodePng(Buffer.from(zoom.image.data, "base64"));
    // 40x25 made 32 times larger fills 1280x800: the black square (600-610, 400-410) is its first 320x320.
    expect([png.width, png.height]).toEqual([1280, 800]);
    expect(png.at(10, 10)).toEqual([0, 0, 0]);
    expect(png.at(319, 319)).toEqual([0, 0, 0]);
    expect(png.at(330, 10)).toEqual([255, 255, 255]);
    expect(bad).toMatchObject({ ok: false, refused: true });
  });

  test("what isn't an action, or isn't one it can do, is refused and touches nothing; a line that isn't JSON is answered too", async () => {
    const r = await deskd();
    const answers = await session(r, [
      { id: 1, name: "dance", input: {} },
      { id: 2, name: "left_click", input: { coordinate: [-1, 5] } },
      { id: 3, name: "key", input: { text: "nosuchkey" } },
      { id: 4, name: "scroll", input: { scroll_direction: "sideways", scroll_amount: 3 } },
      "this is not json",
      { id: 5, name: "key", input: { text: "Return", repeat: 500 } },
    ]);
    for (const answer of answers) expect(answer.ok).toBe(false);
    expect(answers.filter((a) => a.refused)).toHaveLength(6);
    expect(r.trace().filter((t) => ["motion", "button", "key"].includes(String(t.call)))).toEqual([]);
  });

  test("a command line through the session answers as the command would (the agent's own commands, routed)", async () => {
    const r = await deskd();
    const [text, bad] = await session(r, [{ id: 7, argv: ["text"], cwd: "/work" }, { id: 8, argv: ["click", "x", "1"] }]);
    expect(text).toEqual({ id: 7, ok: true, code: 0, stdout: "Example\nhttps://example.test/\nHello\n", stderr: "" });
    expect(bad).toMatchObject({ id: 8, ok: false, code: 2, stdout: "" });
  });

  test("settling waits for 150 ms with nothing drawn; on a screen that never stops it gives up at its cap and says so", async () => {
    const calm = await deskd();
    const [, settled] = await session(calm, [{ id: 1, name: "left_click", input: { coordinate: [1, 1] } }, { id: 2, name: "settle", input: {} }]);
    expect(settled).toMatchObject({ ok: true, settled: true });
    expect(settled.settled_ms).toBeGreaterThanOrEqual(100);
    expect(settled.settled_ms).toBeLessThan(400);
    const busy = await deskd({ DESKD_BUSY: "1" });
    const [restless] = await session(busy, [{ id: 1, name: "settle", input: { cap: 0.5 } }]);
    expect(restless).toMatchObject({ ok: true, settled: false });
    expect(restless.settled_ms).toBeGreaterThanOrEqual(500);
  });
});

describe("the desktop command: deskd's thin client", () => {
  const needs = () => {
    if (!built) {
      console.warn("SKIPPED, unverified: no C compiler, so no desktop client to try");
      return false;
    }
    return true;
  };

  test("a click is one short command: it prints what happened, and exits 0", async () => {
    if (!needs()) return;
    const r = await deskd();
    const click = desktop(r, ["click", "640", "450"]);
    expect(click).toMatchObject({ code: 0, err: "" });
    expect(click.out).toMatch(/^clicked at 640,450 · the screen changed \(\d+ ms\) · focus: Chromium "about:blank - Chromium"\n$/);
    expect(calls(r.trace(), "button")).toHaveLength(2);
    // The verbs as the toolset names them work too.
    expect(desktop(r, ["left_click", "10", "20"]).out).toStartWith("clicked at 10,20");
    expect(desktop(r, ["double_click", "10", "20"]).out).toStartWith("double-clicked at 10,20");
    expect(desktop(r, ["cursor_position"]).out).toBe("X=10, Y=20\n");
  });

  test("what isn't a place, a key or a verb is refused with exit 2 before anything is touched", async () => {
    if (!needs()) return;
    const r = await deskd();
    for (const args of [["click", "10", "x"], ["click", "-5", "10"], ["click", "10", "20", "sideways"], ["key", "ctrl+l; reboot"], ["key"], ["scroll", "sideways"], ["open", "javascript:alert(1)"], ["type"], ["dance"]]) {
      expect({ args, code: desktop(r, args).code }).toEqual({ args, code: 2 });
    }
    expect(r.trace().filter((t) => ["motion", "button", "key"].includes(String(t.call)))).toEqual([]);
  });

  test("a screenshot is a file it names, relative to where the command ran, with the pointer drawn in", async () => {
    if (!needs()) return;
    const r = await deskd();
    desktop(r, ["move", "50", "60"]);
    const here = realpathSync(join(r.run, ".."));
    const shot = desktop(r, ["shot", "mine.png"], {}, here);
    expect(shot).toMatchObject({ code: 0, out: `${join(here, "mine.png")}\n` });
    expect(decodePng(readFileSync(join(here, "mine.png"))).at(50, 60)).toEqual([255, 0, 0]);
  });

  test("look puts the question and a fresh picture to the eyes named for this VM, with its token from the environment, never an argument", async () => {
    if (!needs()) return;
    let asked: { auth: string | null; body: any } | null = null;
    const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { asked = { auth: req.headers.get("authorization"), body: await req.json() }; return Response.json({ choices: [{ message: { content: "640,400" } }] }); } });
    try {
      const r = await deskd();
      const blind = desktop(r, ["look", "Where is it?"]);
      expect(blind.code).toBe(3);
      const eyes = { INVINCIBLE_EYES: "vision/model-1", INVINCIBLE_GATEWAY: `http://127.0.0.1:${gateway.port}/gw`, INVINCIBLE_TOKEN: "gw_test-only" };
      // (Run without blocking this process: the stand-in gateway answers from it.)
      const looking = Bun.spawn([built!, "look", "Where", "is", "Send?"], { env: { ...r.env, ...eyes }, stdout: "pipe" });
      expect(await new Response(looking.stdout).text()).toBe("640,400\n");
      expect(await looking.exited).toBe(0);
      expect(asked!.auth).toBe("Bearer gw_test-only");
      expect(asked!.body.model).toBe("model-1");
      expect(asked!.body.messages[0].content[0].text).toEndWith("Where is Send?");
      expect(asked!.body.messages[0].content[1].image_url.url).toMatch(/^data:image\/(png|jpeg);base64,/);
    } finally {
      gateway.stop(true);
    }
  });

  test("with no desktop process running, the command starts one and is answered; help needs none", async () => {
    if (!needs()) return;
    const dir = mkdtempSync(join(root, "cold-"));
    const run = join(dir, "run");
    const trace = join(dir, "trace");
    writeFileSync(trace, "");
    const env = { PATH: `${bin(join(dir, "bin"), trace)}:${process.env.PATH}`, HOME: dir, INVINCIBLE_DESKTOP_RUN: run, DESKD_TRACE: trace, INVINCIBLE_DESKD: harness };
    const help = Bun.spawnSync([built!, "help"], { env, stdout: "pipe" });
    expect(help.stdout.toString()).toContain("desktop click <x> <y>");
    expect(existsSync(join(run, "deskd.sock"))).toBe(false);
    const first = Bun.spawnSync([built!, "click", "1", "2"], { env, stdout: "pipe", stderr: "pipe" });
    try {
      expect(first.stdout.toString()).toStartWith("clicked at 1,2");
      expect(first.exitCode).toBe(0);
      // Its socket is the agent's alone, in a directory of its own.
      expect(statSync(join(run, "deskd.sock")).mode & 0o777).toBe(0o600);
      expect(statSync(run).mode & 0o777).toBe(0o700);
    } finally {
      const pid = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((t) => t.call === "serving")?.pid;
      if (pid) process.kill(pid);
    }
  });
});

/** deskd's own classes driven by a few lines of Python, with stand-ins set on them: what they print, as JSON. */
function py(lines: string): unknown {
  const script = `import importlib.util, json, sys, time\nsys.dont_write_bytecode = True\nspec = importlib.util.spec_from_file_location("deskd", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)\n${lines}`;
  const ran = Bun.spawnSync(["python3", "-c", script, join(desktopDir, "deskd.py")], { stdout: "pipe", stderr: "pipe" });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return JSON.parse(ran.stdout.toString());
}

describe("deskd's browser and the desk that holds it", () => {
  test("the tab read and navigated is the one in front: the window's title names it, else the one that is visible, else the newest; never merely the first listed (C0's F5)", () => {
    expect(py(`
b = d.Browser(); b.ws = True
b.pages = {"t1": {"session": "s1", "title": "first tab", "opened": 1}, "t2": {"session": "s2", "title": "color 0", "opened": 2}}
seen = {"window": "color 0 - Chromium", "visible": "s2"}
b.window_title = lambda: seen["window"]
b.call = lambda method, params=None, session=None, bound=2.0: {"result": {"value": "visible" if session == seen["visible"] else "hidden"}}
out = [b.front()[0]]
seen["window"] = "first tab - Chromium"; out.append(b.front()[0])
seen["window"] = ""; seen["visible"] = "s1"; out.append(b.front()[0])
seen["visible"] = None; out.append(b.front()[0])
print(json.dumps(out))`)).toEqual(["t2", "t1", "t1", "t2"]);
  });

  test("a browser that isn't running (killed, or its last tab closed) is started again by the next command that needs it, and spoken to afresh", () => {
    expect(py(`
class P:
    running = False; starts = 0
    def start(self): P.starts += 1; P.running = True
    def browser_running(self): return P.running
    def browser_up(self): return P.running
d.Browser.front = lambda self: ("T1", {"session": "S1"})  # (a browser that answers)
old = d.Browser()
desk = d.Desk(pieces=P(), display=object(), watch=object(), browser=old)
fresh = desk.browser_ready()
again = desk.browser_ready()
print(json.dumps({"starts": P.starts, "new": fresh is not old, "kept": again is fresh}))`)).toEqual({ starts: 1, new: true, kept: true });
  });

  test("a screen isn't settled while a page is loading, however still it looks: the picture after a click that navigates is the new page's (C0's F6)", () => {
    const got = py(`
class W:
    lock = __import__("threading").Lock(); last_change = time.monotonic() - 10
class B:
    ws = True; until = time.monotonic() + 0.3
    def loading(self): return time.monotonic() < B.until
desk = d.Desk(pieces=object(), display=object(), watch=W(), browser=B())
print(json.dumps(desk.settle(cap=2)))`) as { settled: boolean; settled_ms: number };
    expect(got.settled).toBe(true);
    expect(got.settled_ms).toBeGreaterThanOrEqual(290);
    expect(got.settled_ms).toBeLessThan(1000);
  });
});

describe("deskd's browser client, against a socket that answers as Chromium does", () => {
  /** Chromium's answers, as they came in a VM (26 November 2026): its targets on discovery, then the attach's two. */
  const CHROMIUM = `
import queue
class WS:
    def __init__(self): self.q = queue.Queue(); self.sent = []
    def send(self, text):
        m = json.loads(text); self.sent.append(m["method"])
        if m["method"] == "Target.setDiscoverTargets":
            self.q.put({"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "T1", "type": "page", "title": "about:blank", "url": "about:blank", "attached": False}}})
            self.q.put({"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "U1", "type": "browser_ui", "title": "Omnibox Popup", "url": "chrome://omnibox-popup.top-chrome/"}}})
            self.q.put({"id": m["id"], "result": {}})
        elif m["method"] == "Target.attachToTarget":
            self.q.put({"method": "Target.attachedToTarget", "params": {"sessionId": "S1", "targetInfo": {"targetId": m["params"]["targetId"], "type": "page"}}})
            self.q.put({"id": m["id"], "result": {"sessionId": "S1"}})
        elif m["method"] == "Runtime.evaluate":
            self.q.put({"id": m["id"], "sessionId": m.get("sessionId"), "result": {"result": {"value": "on " + str(m.get("sessionId"))}}})
        elif "id" in m:
            self.q.put({"id": m["id"], "result": {}})
    def recv(self): return json.dumps(self.q.get())
ws = WS()
b = d.Browser(connect=lambda: ws)
`;

  test("the first read of a page connects, finds the browser's pages (not its own UI's) and attaches to them", () => {
    expect(py(`${CHROMIUM}
got = b.evaluate("document.title")
print(json.dumps({"got": got, "pages": list(b.pages), "sent": ws.sent[:3]}))`)).toEqual({ got: "on S1", pages: ["T1"], sent: ["Target.setDiscoverTargets", "Target.attachToTarget", "Page.enable"] });
  });
});

describe("the desk's focus and clicks, as a window manager takes its time", () => {
  test("a click that gives another window the focus answers once it has it: the keys after it reach that window, not the last", async () => {
    const r = await deskd();
    const [click] = await session(r, [{ id: 1, name: "left_click", input: { coordinate: [900, 500] } }]);
    expect(click.focus).toMatchObject({ before: { app: "Chromium" }, after: { app: "Mousepad" } });
    expect(click.text).toContain('focus: Mousepad "Untitled 1 - Mousepad", was Chromium');
  });

  test("a single click at the same place as the last one is never held back; a double click waits out the toolkit's double-click time first (C0's F7)", async () => {
    const r = await deskd();
    const t0 = performance.now();
    await session(r, [{ id: 1, name: "left_click", input: { coordinate: [10, 10] } }, { id: 2, name: "left_click", input: { coordinate: [10, 10] } }]);
    expect(performance.now() - t0).toBeLessThan(400);
    const t1 = performance.now();
    await session(r, [{ id: 3, name: "double_click", input: { coordinate: [10, 10] } }]);
    expect(performance.now() - t1).toBeGreaterThan(300);
  });

  test("a window named is brought forward with the keyboard's focus, the way between apps a full-screen browser hides", async () => {
    if (!built) return;
    const r = await deskd();
    const moved = desktop(r, ["focus", "Mousepad"]);
    expect(moved).toMatchObject({ code: 0, out: 'focus: Mousepad "Untitled 1 - Mousepad"\n' });
    expect(calls(r.trace(), "activate")).toEqual([{ call: "activate", window: "0x600001" }]);
    expect(desktop(r, ["focus", "Nothing like it"]).code).toBe(1);
  });

  test("a window that appears is brought to the front with the focus: an app an agent starts is the one it then works in", () => {
    // The watcher's own listing, with a stand-in display: the second listing has a new window.
    expect(py(`
w = d.Watch.__new__(d.Watch)
import threading; w.lock = threading.Lock(); w.known = {}; w.appeared = []; w.gone = []; w.started = False
lists = [[1], [1, 2]]
class D:
    def clients(self): return lists.pop(0)
    def window(self, x): return {"id": hex(x), "title": "w%d" % x, "app": "A", "dialog": False, "box": [0, 0, 10, 10]}
    activated = []
    def activate(self, x): D.activated.append(x)
w.d = D()
w._list(); w.started = True; w._list()
print(json.dumps({"activated": D.activated, "appeared": [a["id"] for _, a in w.appeared]}))`)).toEqual({ activated: [2], appeared: ["0x1", "0x2"] });
  });

  test("a browser whose process lingers after it was killed, but whose port doesn't answer, is not running: it is started again", () => {
    expect(py(`
p = d.Pieces(home="/work")
d._own = lambda comm: [4242]
p.browser_up = lambda: False
print(json.dumps(p.browser_running()))`)).toBe(false);
  });
});

describe("deskd when the browser has no page, and after it opens one", () => {
  test("a browser whose last tab was closed (C0's F10) is given a page by the next read, not answered with none", () => {
    expect(py(`
import queue
class WS:
    def __init__(self): self.q = queue.Queue()
    def send(self, text):
        m = json.loads(text)
        if m["method"] == "Target.setDiscoverTargets":
            self.q.put({"id": m["id"], "result": {}})
        elif m["method"] == "Target.createTarget":
            self.q.put({"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "T2", "type": "page", "title": "about:blank", "url": "about:blank"}}})
            self.q.put({"id": m["id"], "result": {"targetId": "T2"}})
        elif m["method"] == "Target.attachToTarget":
            self.q.put({"method": "Target.attachedToTarget", "params": {"sessionId": "S2", "targetInfo": {"targetId": "T2", "type": "page"}}})
            self.q.put({"id": m["id"], "result": {"sessionId": "S2"}})
        elif "id" in m:
            self.q.put({"id": m["id"], "result": {}})
    def recv(self): return json.dumps(self.q.get())
b = d.Browser(connect=WS)
print(json.dumps(b.front()[0]))`)).toBe("T2");
  });

  test("an address opened is answered once the page has loaded and the screen has settled, so the picture after it is the page's at once", async () => {
    if (!built) return;
    const busy = await deskd({ DESKD_BUSY: "1" });
    const opened = desktop(busy, ["open", "https://example.test/"]);
    expect(opened).toMatchObject({ code: 0, out: "Example · https://example.test/\n" });
    // (A screen that never stops: the open waits its settle out, a second at most.)
    expect(opened.ms).toBeGreaterThan(900);
    expect(opened.ms).toBeLessThan(3000);
  });
});

describe("text that arrives exactly (step 4): typed by what has the focus, never by remapping keys", () => {
  const TEST_STRING = "Søren Ærø – blåbærgrød 25 °C ✓ € ü 日本語 🙂";

  test("into a text field of the browser's page it goes by the browser's own insertText, whole, and what landed is checked", async () => {
    const r = await deskd({ DESKD_FOCUS: "field" });
    const [typed] = await session(r, [{ id: 1, name: "type", input: { text: TEST_STRING } }]);
    expect(typed).toMatchObject({ ok: true, did: "typed 40 characters into the page" });
    const t = r.trace();
    expect(calls(t, "cdp").filter((c) => c.method === "Input.insertText")).toEqual([{ call: "cdp", method: "Input.insertText", params: { text: TEST_STRING } }]);
    expect(calls(t, "key")).toEqual([]);
    expect(calls(t, "xdotool")).toEqual([]);
  });

  test("with nothing that takes text focused (C0's F1: the page, its body), it is an error, not exit 0, and nothing is typed", async () => {
    if (!built) return;
    const r = await deskd({ DESKD_FOCUS: "body" });
    const blind = desktop(r, ["type", "typed-blind"]);
    expect(blind.code).toBe(1);
    expect(blind.err).toContain("nothing that takes text has the keyboard's focus");
    const none = await deskd({ DESKD_FOCUS: "none" });
    expect(desktop(none, ["type", "x"]).code).toBe(1);
    for (const run of [r, none]) expect(run.trace().filter((t) => ["key", "xdotool", "own"].includes(String(t.call)) || (t.call === "cdp" && t.method === "Input.insertText"))).toEqual([]);
  });

  test("into a terminal, text the keyboard has no keys for is pasted from a selection deskd holds, with shift+Insert; into another app, with ctrl+v", async () => {
    const term = await deskd({ DESKD_FOCUS: "xterm" });
    await session(term, [{ id: 1, name: "type", input: { text: TEST_STRING } }]);
    expect(calls(term.trace(), "own")).toEqual([{ call: "own", text: TEST_STRING }]);
    expect(keys(term.trace())).toEqual(["+Shift_L", "+Insert", "-Insert", "-Shift_L"]);
    const editor = await deskd({ DESKD_FOCUS: "mousepad" });
    await session(editor, [{ id: 1, name: "type", input: { text: TEST_STRING } }]);
    expect(calls(editor.trace(), "own")).toEqual([{ call: "own", text: TEST_STRING }]);
    expect(keys(editor.trace())).toEqual(["+Control_L", "+v", "-v", "-Control_L"]);
    for (const run of [term, editor]) expect(calls(run.trace(), "xdotool")).toEqual([]);
  });

  test("short text the keyboard has keys for still goes key by key, shift where it needs it, into whatever takes text", async () => {
    const r = await deskd({ DESKD_FOCUS: "xterm" });
    await session(r, [{ id: 1, name: "type", input: { text: "Ls -a" } }]);
    expect(keys(r.trace())).toEqual(["+Shift_L", "+l", "-l", "-Shift_L", "+s", "-s", "+space", "-space", "+-", "--", "+a", "-a"]);
    expect(calls(r.trace(), "own")).toEqual([]);
  });
});

describe("nothing hangs, nothing is silent (step 5)", () => {
  test("a key that commits (Return) waits for the screen to settle after what was typed before it, as a person's would; other keys don't wait", async () => {
    // (C1's step 3 run: a Save As dialog's name typed in full, and the Return 20 ms after it never saved, 5 runs of 5.)
    const r = await deskd({ DESKD_FOCUS: "mousepad" });
    await session(r, [{ id: 1, name: "type", input: { text: "Hello" } }, { id: 2, name: "key", input: { text: "Tab" } }, { id: 3, name: "type", input: { text: "abc" } }, { id: 4, name: "key", input: { text: "Return" } }]);
    const k = calls(r.trace(), "key") as { key: string; down: boolean; at: number }[];
    const lastUp = (before: number) => k.slice(0, before).filter((e) => !e.down).at(-1)!.at;
    const tab = k.findIndex((e) => e.key === "Tab" && e.down);
    const ret = k.findIndex((e) => e.key === "Return" && e.down);
    expect(k[tab]!.at - lastUp(tab)).toBeLessThan(0.1);
    expect(k[ret]!.at - lastUp(ret)).toBeGreaterThanOrEqual(0.15);
  });

  test("a paste is answered once the app has taken the text, so the Return after it can't overtake it; a paste nothing takes is an error", async () => {
    // (C1's step 4 run: in xterm, the line came after its Return, 20 of 20.)
    const r = await deskd({ DESKD_FOCUS: "xterm", DESKD_PASTE_TAKES: "0.3" });
    const [typed] = await session(r, [{ id: 1, name: "type", input: { text: "Søren Ærø 🙂" } }, { id: 2, name: "key", input: { text: "Return" } }]);
    expect(typed).toMatchObject({ ok: true, did: "pasted 11 characters" });
    const order = r.trace().filter((t) => t.call === "taken" || (t.call === "key" && t.key === "Return" && t.down)).map((t) => t.call);
    expect(order).toEqual(["taken", "key"]);
    const never = await deskd({ DESKD_FOCUS: "xterm", DESKD_PASTE_TAKES: "never" });
    const [lost] = await session(never, [{ id: 1, name: "type", input: { text: "Søren Ærø 🙂" } }]);
    expect(lost).toMatchObject({ ok: false, error: "nothing took the pasted text within 1 s: is a text field focused?" });
  });

  test("a click's press comes right after its move: nothing is asked of the display between them", async () => {
    const r = await deskd();
    await session(r, [{ id: 1, name: "left_click", input: { coordinate: [640, 450] } }]);
    const t = r.trace().map((e) => e.call as string);
    const moved = t.indexOf("motion");
    expect(t.slice(moved, moved + 2)).toEqual(["motion", "button"]);
  });

  test("double clicks at one place, one after another, are each a double click: the next waits out the double-click time and a margin (C0's F7)", async () => {
    const r = await deskd({ DESKD_QUIET: "1" });
    await session(r, [{ id: 1, name: "double_click", input: { coordinate: [640, 450] } }, { id: 2, name: "double_click", input: { coordinate: [641, 451] } }]);
    const presses = (calls(r.trace(), "button") as { down: boolean; at: number }[]).filter((b) => b.down);
    expect(presses).toHaveLength(4);
    expect(presses[2]!.at - presses[1]!.at).toBeGreaterThanOrEqual(0.58);
  });

  /** A page with a JavaScript alert up: Chromium answers nothing on that page while it is (C0's F4: 30 s, then a traceback). */
  const ALERT = `
import queue
class WS:
    def __init__(self): self.q = queue.Queue(); self.sent = []
    def send(self, text):
        m = json.loads(text); self.sent.append(m)
        if m["method"] == "Target.setDiscoverTargets":
            self.q.put({"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "T1", "type": "page", "title": "alert", "url": "http://127.0.0.1:8000/alert.html"}}})
            self.q.put({"id": m["id"], "result": {}})
        elif m["method"] == "Target.attachToTarget":
            self.q.put({"method": "Target.attachedToTarget", "params": {"sessionId": "S1", "targetInfo": {"targetId": "T1", "type": "page"}}})
            self.q.put({"id": m["id"], "result": {"sessionId": "S1"}})
            self.q.put({"method": "Page.javascriptDialogOpening", "sessionId": "S1", "params": {"url": "http://127.0.0.1:8000/alert.html", "message": "Hello from the page", "type": "alert", "hasBrowserHandler": False}})
        elif m["method"] == "Runtime.evaluate":
            pass  # (no answer while the alert is up)
        elif m["method"] == "Page.handleJavaScriptDialog":
            self.q.put({"id": m["id"], "sessionId": "S1", "result": {}})
            self.q.put({"method": "Page.javascriptDialogClosed", "sessionId": "S1", "params": {"result": m["params"]["accept"], "userInput": ""}})
        elif "id" in m:
            self.q.put({"id": m["id"], "result": {}})
    def recv(self): return json.dumps(self.q.get())
ws = WS()
b = d.Browser(connect=lambda: ws)
class P:
    def browser_running(self): return True
    def browser_up(self): return True
    def start(self): pass
desk = d.Desk(pieces=P(), display=object(), watch=object(), browser=b)
`;

  test("a JavaScript alert is reported within a second, with its words and its buttons, never waited out (C0's F4)", () => {
    const got = py(`${ALERT}
t0 = time.monotonic(); code, out, err = d.cli(desk, ["text"])
print(json.dumps({"code": code, "err": err, "ms": (time.monotonic() - t0) * 1000}))`) as { code: number; err: string; ms: number };
    expect(got.ms).toBeLessThan(1000);
    expect(got.code).toBe(1);
    expect(got.err).toContain('a JavaScript alert is open on the page: "Hello from the page" [OK]');
    expect(got.err).toContain("desktop dialog accept");
  });

  test("a dialog the page puts up is in the answer of the action that brought it up, with its words and its buttons", async () => {
    const r = await deskd({ DESKD_DIALOG: "confirm" });
    const [click] = await session(r, [{ id: 1, name: "left_click", input: { coordinate: [640, 450] } }]);
    expect(click.dialog).toMatchObject({ type: "confirm", message: "Delete the draft?", buttons: ["OK", "Cancel"] });
    expect(click.text).toContain('a JavaScript confirm is open on the page: "Delete the draft?" [OK] [Cancel]. desktop dialog accept answers it (or Return), desktop dialog dismiss cancels it (or Escape)');
  });

  test("the dialog is answered by its own verb, as the page's own buttons would", () => {
    const got = py(`${ALERT}
d.cli(desk, ["text"])
code, out, err = d.cli(desk, ["dialog", "accept"])
time.sleep(0.1)
print(json.dumps({"code": code, "out": out, "sent": [m for m in ws.sent if m["method"] == "Page.handleJavaScriptDialog"], "open": b.dialog()}))`) as { code: number; out: string; sent: unknown[]; open: unknown };
    expect(got).toMatchObject({ code: 0, out: 'accepted the alert "Hello from the page"\n', open: null });
    expect(got.sent).toEqual([{ id: expect.any(Number), method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: "S1" }]);
  });

  /** A page that puts up its alert as it loads, 100 ms after the navigation, with a read of it already asked for. */
  const ALERT_AS_IT_LOADS = `
import queue, threading
class WS:
    def __init__(self): self.q = queue.Queue(); self.sent = []
    def send(self, text):
        m = json.loads(text); self.sent.append(m)
        if m["method"] == "Target.setDiscoverTargets":
            self.q.put({"method": "Target.targetCreated", "params": {"targetInfo": {"targetId": "T1", "type": "page", "title": "", "url": "about:blank"}}})
            self.q.put({"id": m["id"], "result": {}})
        elif m["method"] == "Target.attachToTarget":
            self.q.put({"method": "Target.attachedToTarget", "params": {"sessionId": "S1", "targetInfo": {"targetId": "T1", "type": "page"}}})
            self.q.put({"id": m["id"], "result": {"sessionId": "S1"}})
        elif m["method"] == "Page.navigate":
            self.q.put({"method": "Target.targetInfoChanged", "params": {"targetInfo": {"targetId": "T1", "type": "page", "title": "alert", "url": m["params"]["url"]}}})
            self.q.put({"id": m["id"], "sessionId": "S1", "result": {"frameId": "T1", "loaderId": "L1"}})
            threading.Timer(0.1, lambda: self.q.put({"method": "Page.javascriptDialogOpening", "sessionId": "S1", "params": {"url": m["params"]["url"], "message": "Hello from the page", "type": "alert", "hasBrowserHandler": False}})).start()
        elif m["method"] == "Runtime.evaluate":
            pass  # (the page is busy loading, then its alert holds it)
        elif "id" in m:
            self.q.put({"id": m["id"], "result": {}})
    def recv(self): return json.dumps(self.q.get())
ws = WS()
b = d.Browser(connect=lambda: ws)
class P:
    def browser_running(self): return True
    def browser_up(self): return True
    def start(self): pass
class Settled:
    def take(self): return []
    def since(self, t): return 0
desk = d.Desk(pieces=P(), display=object(), watch=Settled(), browser=b)
desk.settle = lambda cap=None, since=None: None
`;

  test("a page that puts up an alert as it loads: desktop open answers at once, the page opened and its alert said, never the 30 s of a load that waits on it", () => {
    const got = py(`${ALERT_AS_IT_LOADS}
t0 = time.monotonic(); code, out, err = d.cli(desk, ["open", "http://127.0.0.1:8000/alert.html"])
print(json.dumps({"code": code, "out": out, "err": err, "ms": (time.monotonic() - t0) * 1000}))`) as { code: number; out: string; err: string; ms: number };
    expect(got.ms).toBeLessThan(1000);
    expect(got.code).toBe(0);
    expect(got.out).toContain("http://127.0.0.1:8000/alert.html");
    expect(got.out).toContain('a JavaScript alert is open on the page: "Hello from the page" [OK]');
  });

  test("a read already waiting when the alert goes up is answered then, with the alert: not at its 2 s bound", () => {
    const got = py(`${ALERT_AS_IT_LOADS}
b.connect()
t0 = time.monotonic(); b.call("Page.navigate", {"url": "http://127.0.0.1:8000/alert.html"}, "S1")
code, out, err = d.cli(desk, ["text"])
print(json.dumps({"code": code, "err": err, "ms": (time.monotonic() - t0) * 1000}))`) as { code: number; err: string; ms: number };
    expect(got.ms).toBeLessThan(1000);
    expect(got.code).toBe(1);
    expect(got.err).toContain('a JavaScript alert is open on the page: "Hello from the page" [OK]');
  });

  test("deskd keeps the browser and the window manager running: one that ends is started again as it ends, not at the next command (C0's F9), and not once it is stopping", () => {
    expect(py(`
class P:
    starts = 0; asked = 0; ended = None
    def start(self): P.starts += 1
    def browser_running(self): P.asked += 1; return True
    def browser_up(self): P.asked += 1; return True
    def window_manager_running(self): P.asked += 1; return True
    def a11y_running(self): P.asked += 1; return True
pieces = P()
desk = d.Desk(pieces=pieces, display=object(), watch=object(), browser=d.Browser())
desk.supervise()
pieces.ended("browser")
desk.stopping = True
pieces.ended("browser")
print(json.dumps({"starts": P.starts}))`)).toEqual({ starts: 1 });
  });

  test("the keeper waits on what deskd started, and asks nothing at rest: a piece's end is known as it happens (C1: asking four times a second cost the idle desktop 0.7 % of a core)", () => {
    const got = py(`
import os, signal, tempfile
d.RUN = tempfile.mkdtemp()
p = d.Pieces(home=d.RUN)
ended = []
p.ended = lambda name: ended.append([name, time.monotonic()])
pid = p._spawn(["sleep", "30"], "kept.log", keep="browser")
time.sleep(1.1)
t = time.monotonic(); os.kill(pid, signal.SIGKILL); time.sleep(0.3)
first = round((ended[0][1] - t) * 1000) if ended else None
# One that ends as it starts is started again a second later, not at once, and again.
pid = p._spawn(["sleep", "30"], "kept.log", keep="windows")
t = time.monotonic(); os.kill(pid, signal.SIGKILL); time.sleep(1.4)
second = round((ended[1][1] - t) * 1000) if len(ended) > 1 else None
print(json.dumps({"ended": [n for n, _ in ended], "first": first, "second": second, "threads": sorted(x.name for x in __import__("threading").enumerate() if x.name.startswith("keep"))}))`) as { ended: string[]; first: number; second: number; threads: string[] };
    expect(got.ended).toEqual(["browser", "windows"]);
    expect(got.first).toBeLessThan(100);
    expect(got.second).toBeGreaterThanOrEqual(1000);
    expect(got.second).toBeLessThan(1300);
    expect(got.threads).toEqual([]);
    // Nothing asked at rest: no piece is polled.
    expect(py(`
class P:
    asked = 0
    def start(self): pass
    def browser_running(self): P.asked += 1; return True
    def browser_up(self): P.asked += 1; return True
    def window_manager_running(self): P.asked += 1; return True
    def a11y_running(self): P.asked += 1; return True
desk = d.Desk(pieces=P(), display=object(), watch=object(), browser=d.Browser())
desk.supervise(); time.sleep(0.6)
print(json.dumps(P.asked))`)).toBe(0);
  });

  test("the keeper and a command that both find the browser gone start one browser, not two", () => {
    expect(py(`
import tempfile, threading
p = d.Pieces(home=tempfile.mkdtemp())
spawned = []
def spawn(argv, log, keep=None):
    spawned.append(argv[0]); time.sleep(0.05); return 4242
p._spawn = spawn
d._own = lambda comm: [1] if comm in ("Xvfb", "openbox") else []
d._alive = lambda pid: True
p.display_up = lambda: True
p.browser_up = lambda: False
both = [threading.Thread(target=p.start) for _ in range(2)]
for t in both: t.start()
for t in both: t.join()
print(json.dumps(spawned))`)).toEqual(["chromium"]);
  });

  test("stopping the desktop closes each window as a person would (WM_DELETE_WINDOW) before any process is ended: no restore question next time", async () => {
    if (!built) return;
    const r = await deskd();
    expect(desktop(r, ["stop"])).toMatchObject({ code: 0, out: "The desktop is stopped.\n" });
    for (let i = 0; i < 50 && !calls(r.trace(), "stop").length; i++) await Bun.sleep(20);
    const order = r.trace().filter((t) => t.call === "close" || t.call === "stop").map((t) => (t.call === "close" ? `close ${t.window}` : "stop"));
    expect(order.at(-1)).toBe("stop");
    expect(order.filter((o) => o.startsWith("close")).sort()).toEqual(["close 0x400001", "close 0x500001", "close 0x600001"]);
  });
});
