import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  let why: string;
  try {
    const cc = Bun.spawnSync(["cc", "-O2", "-Wall", "-Wextra", "-Werror", "-o", client, join(desktopDir, "desktop.c")], { stderr: "pipe" });
    built = cc.exitCode === 0 ? client : null;
    why = cc.stderr.toString();
  } catch (error) {
    // No cc on the PATH at all: Bun throws for a command it can't find (1.4.4), where a compiler that fails answers.
    why = (error as Error).message;
  }
  if (!built) console.warn(`deskd.test.ts: the desktop client's tests SKIPPED, unverified: no C compiler here (${why.slice(0, 200)})`);
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
  // (The desktop command waits for deskd as long as a busy machine may take to start it, and this for its socket: with
  // 2 % of a core, 28 November 2026, the socket came 8 to 18 s after deskd's start. The product's own wait, 20 s
  // unless told, stays the product's: these are how long a test's machine may take, never what a test checks.)
  const all = { PATH: `${bin(join(dir, "bin"), trace)}:${process.env.PATH}`, HOME: dir, INVINCIBLE_DESKTOP_RUN: run, DESKD_TRACE: trace, INVINCIBLE_DESKD: harness, INVINCIBLE_DESKTOP_WAIT: "120", ...env };
  const proc = Bun.spawn(["python3", harness], { env: all, stdout: "ignore", stderr: "inherit" });
  for (const until = Date.now() + 120_000; Date.now() < until && !existsSync(join(run, "deskd.sock")); ) await Bun.sleep(10);
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

/** A held session that stays open, as the node's does: on the agent's socket, or on the owner's beside the run directory. */
async function opened(r: Running, owner = false): Promise<{ ask: (q: unknown) => Promise<any>; close: () => Promise<void> }> {
  const s = createConnection(owner ? `${r.run}.owner.sock` : join(r.run, "deskd.sock"));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("error", reject);
  });
  s.write("SESSION\n");
  let buffer = "";
  const waiting: ((answer: any) => void)[] = [];
  s.on("data", (chunk) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const answer = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.shift()?.(answer);
    }
  });
  return {
    ask: (q) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        s.write(`${JSON.stringify(q)}\n`);
      }),
    close: () => new Promise((resolve) => s.end(() => resolve())),
  };
}

/** The agent's command from its shell, run while the test goes on. */
async function agentAsync(r: Running, args: string[]) {
  const t0 = performance.now();
  const p = Bun.spawn([built!, ...args], { env: r.env, cwd: r.run, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, ms: performance.now() - t0 };
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

  // C1 step 9: the owner's take-over. Their requests come on their own socket, from their own uid (the node's exec as
  // OWNER_UID: here the test's own uid, set so), and only theirs take the desktop over or give it back.
  const me = String(process.getuid!());

  test("while the owner holds the desktop, an agent's command waits; it runs once they give it back, and is told how long it waited", async () => {
    if (!needs()) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: me, INVINCIBLE_DESKTOP_HOLD_WAIT: "10" });
    const node = await opened(r, true);
    expect(await node.ask({ id: 1, name: "take", input: { idle: 30 } })).toMatchObject({ ok: true, took: true, hold: { idle: 30, most: 900 } });
    const clicking = agentAsync(r, ["click", "10", "20"]);
    await Bun.sleep(700);
    expect(calls(r.trace(), "button")).toHaveLength(0);
    expect(await node.ask({ id: 2, name: "release" })).toMatchObject({ ok: true, released: true });
    const clicked = await clicking;
    expect(clicked).toMatchObject({ code: 0 });
    expect(clicked.out).toStartWith("clicked at 10,20");
    expect(clicked.err).toMatch(/^desktop: the owner had this desktop; they gave it back after \d+ s, and this ran then\.\n/);
    expect(clicked.ms).toBeGreaterThan(600);
    expect(calls(r.trace(), "button")).toHaveLength(2);
    await node.close();
  });

  test("an agent's command still waiting when its time is up does nothing: it exits 75 and says the owner has the desktop", async () => {
    if (!needs()) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: me, INVINCIBLE_DESKTOP_HOLD_WAIT: "0.4" });
    const node = await opened(r, true);
    await node.ask({ id: 1, name: "take" });
    const held = await agentAsync(r, ["click", "10", "20"]);
    expect(held).toMatchObject({ code: 75, out: "" });
    expect(held.err).toMatch(/^desktop: nothing was done: the owner took this desktop over \d+ s ago, and has it for up to \d+ s more/);
    expect(calls(r.trace(), "button")).toHaveLength(0);
    // A look waits too: no picture is taken while the owner has the desktop. Its status and `start` don't.
    expect((await agentAsync(r, ["screenshot", "--base64"])).code).toBe(75);
    expect((await agentAsync(r, ["status"])).out).toContain("The owner has it: the owner took this desktop over");
    expect((await agentAsync(r, ["start"])).code).toBe(0);
    await node.close();
  });

  test("the owner's own requests run while they hold it; with no input from them for its idle time, it ends by itself", async () => {
    if (!needs()) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: me, INVINCIBLE_DESKTOP_HOLD_WAIT: "0.3" });
    const node = await opened(r, true);
    await node.ask({ id: 1, name: "take", input: { idle: 1 } });
    expect(await node.ask({ id: 2, name: "left_click", input: { coordinate: [5, 5] } })).toMatchObject({ ok: true });
    expect((await agentAsync(r, ["click", "10", "20"])).code).toBe(75);
    await Bun.sleep(1300);
    const after = await agentAsync(r, ["click", "10", "20"]);
    expect(after).toMatchObject({ code: 0, err: "" });
    await node.close();
  });

  test("the owner's input takes the desktop over when no one has it, and keeps their hold; their looks don't, and each answer of theirs says whether they have it", async () => {
    if (!needs()) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: me, INVINCIBLE_DESKTOP_HOLD_WAIT: "0.3" });
    const node = await opened(r, true);
    // Looking is not taking, and asking whether they have it is neither.
    expect(await node.ask({ id: 0, name: "hold" })).toEqual({ id: 0, ok: true, hold: null });
    expect(await node.ask({ id: 1, argv: ["status"] })).toMatchObject({ ok: true, hold: null });
    expect((await agentAsync(r, ["click", "10", "20"])).code).toBe(0);
    // Their first click takes it, for the usual window.
    const first = await node.ask({ id: 2, name: "left_click", input: { coordinate: [5, 5] } });
    expect(first).toMatchObject({ ok: true, took: true, hold: { idle: 120, most: 900 } });
    expect((await agentAsync(r, ["click", "10", "20"])).code).toBe(75);
    // Their next keeps it: the same hold, not a fresh one.
    const next = await node.ask({ id: 3, argv: ["click", "6", "6"] });
    expect(next).toMatchObject({ ok: true, code: 0, hold: { since: first.hold.since } });
    expect(next.took).toBeUndefined();
    // A hold with a short idle time: a look of theirs doesn't start it again, as input does.
    await node.ask({ id: 4, name: "take", input: { idle: 2 } });
    await Bun.sleep(1000);
    expect((await node.ask({ id: 5, argv: ["status"] })).hold).toMatchObject({ idle: 2 });
    await Bun.sleep(1300);
    // (2.3 s after their last input, past its idle time, however often they looked meanwhile.)
    expect(await node.ask({ id: 6, name: "screenshot" })).toMatchObject({ hold: null });
    expect(await agentAsync(r, ["click", "10", "20"])).toMatchObject({ code: 0, err: "" });
    await node.close();
  });

  test("only the owner's socket, from the owner's uid, takes the desktop over: the agent's own session can't, whatever it says", async () => {
    if (!needs()) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: me });
    const [plain, claiming, asking] = await session(r, [{ id: 1, name: "take" }, { id: 2, name: "take", as: "owner" }, { id: 3, name: "hold" }]);
    for (const answer of [plain, claiming, asking]) expect(answer).toMatchObject({ ok: false, refused: true, error: "only the owner takes the desktop over, or gives it back: through their node" });
    expect(plain.hold).toBeUndefined();
    // On the owner's socket, from another uid than the owner's: no more the owner's than the agent's own.
    const other = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: "4242" });
    const stranger = await opened(other, true);
    expect(await stranger.ask({ id: 1, name: "take" })).toMatchObject({ ok: false, refused: true });
    await stranger.close();
    expect(statSync(`${r.run}.owner.sock`).mode & 0o777).toBe(0o666);
    expect(statSync(r.run).mode & 0o777).toBe(0o700);
  });

  test("the desktop is given back as the owner's connection ends, and a second take starts a fresh window", async () => {
    if (!needs()) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_OWNER_UID: me, INVINCIBLE_DESKTOP_HOLD_WAIT: "0.3" });
    const first = await opened(r, true);
    await first.ask({ id: 1, name: "take", input: { idle: 1 } });
    await Bun.sleep(700);
    const again = await first.ask({ id: 2, name: "take", input: { idle: 2 } });
    expect(again.hold.ends_in).toBeGreaterThan(1.9);
    await Bun.sleep(700);
    // (1.4 s after the first take, its idle second long gone: the second's window, to 2.7 s, holds it still.)
    expect((await agentAsync(r, ["click", "10", "20"])).code).toBe(75);
    await first.close();
    await Bun.sleep(100);
    expect(await agentAsync(r, ["click", "10", "20"])).toMatchObject({ code: 0, err: "" });
  });

  test("desktop stream starts the desktop, says so on stderr, and becomes the encoder: its stdout is the frames alone", async () => {
    if (!needs()) return;
    const r = await deskd();
    // (The encoder, stood in on the PATH as the image has it: what it prints is all that stdout carries.)
    const bin = r.env.PATH!.split(":")[0]!;
    writeFileSync(join(bin, "desktop-stream"), "#!/bin/sh\nprintf 'FRAMES'\n");
    chmodSync(join(bin, "desktop-stream"), 0o755);
    const streamed = desktop(r, ["stream"]);
    expect(streamed).toMatchObject({ code: 0, out: "FRAMES" });
    // (What `desktop start` says, on stderr: the desktop is up before the encoder runs.)
    expect(streamed.err).toContain("The desktop is up");
  });

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

  test("the hardware image's apps (C1 step 11): KiCad and FreeCAD start on the screen where the image has them, a file named whole; elsewhere, they're not said", async () => {
    if (!needs()) return;
    // (Stand-ins for the hardware image's programs, on the PATH deskd sees: it starts what it finds, nothing else.)
    const tools = mkdtempSync(join(root, "hardware-"));
    for (const name of ["kicad", "pcbnew", "eeschema", "freecad"]) {
      writeFileSync(join(tools, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tools, name), 0o755);
    }
    const r = await deskd({ PATH: `${tools}:${process.env.PATH}` });
    const started = desktop(r, ["app", "pcbnew", "/work/board.kicad_pcb"]);
    expect(started).toMatchObject({ code: 0, out: "Started pcbnew on /work/board.kicad_pcb.\n" });
    expect(desktop(r, ["app", "freecad"])).toMatchObject({ code: 0, out: "Started freecad.\n" });
    expect(r.trace().filter((t) => t.call === "spawn").map((t) => t.argv)).toEqual([["pcbnew", "/work/board.kicad_pcb"], ["freecad"]]);
    // (In /tmp: KiCad's API server makes its socket in TMPDIR, and kipy looks for it in /tmp/kicad, whatever TMPDIR a
    // command of the agent's had.)
    expect(r.trace().filter((t) => t.call === "spawn").map((t) => t.env)).toEqual([{ TMPDIR: "/tmp" }, { TMPDIR: "/tmp" }]);
    // A file by its whole path, and one: anything else is refused before anything starts.
    for (const args of [["app", "pcbnew", "board.kicad_pcb"], ["app", "freecad", "/work/a.FCStd", "/work/b.FCStd"]]) expect(desktop(r, args)).toMatchObject({ code: 2, err: expect.stringContaining("by its whole path") });
    expect(r.trace().filter((t) => t.call === "spawn")).toHaveLength(2);
    expect(desktop(r, ["help"]).out).toContain("desktop app <kicad|pcbnew|eeschema|freecad> [file]");
    expect(desktop(r, ["app", "inkscape"]).err).toContain("desktop app <terminal|editor|kicad|pcbnew|eeschema|freecad>");
    // On the desktop's own image, none of them is there, nor said.
    const plain = await deskd();
    expect(desktop(plain, ["app", "pcbnew"])).toMatchObject({ code: 2, err: expect.stringContaining("desktop app <terminal|editor>") });
    expect(desktop(plain, ["help"]).out).not.toContain("kicad");
    expect(plain.trace().filter((t) => t.call === "spawn")).toEqual([]);
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

  test("a screenshot or a zoom with --base64 is printed as a data address on one line, for a loop to hand its model: no file is written", async () => {
    if (!needs()) return;
    const r = await deskd();
    desktop(r, ["mouse_move", "50", "60"]);
    const before = Bun.spawnSync(["ls", "-A", r.run]).stdout.toString();
    const shot = desktop(r, ["screenshot", "--base64"]);
    expect(shot).toMatchObject({ code: 0, err: "" });
    const [, data] = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})\n$/.exec(shot.out) ?? [];
    const png = decodePng(Buffer.from(data!, "base64"));
    expect([png.width, png.height, ...png.at(50, 60)]).toEqual([1280, 800, 255, 0, 0]);
    const zoom = desktop(r, ["zoom", "0", "0", "640", "400", "--base64"]);
    const [, zoomed] = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})\n$/.exec(zoom.out) ?? [];
    expect(decodePng(Buffer.from(zoomed!, "base64")).width).toBe(1280);
    expect(Bun.spawnSync(["ls", "-A", r.run]).stdout.toString()).toBe(before);
  });

  test("a printed picture can be kept as well (--keep): its own bytes in the folder named, under their SHA-256, so the trail's hash names its file", async () => {
    if (!needs()) return;
    const r = await deskd();
    const kept = join(realpathSync(join(r.run, "..")), "evidence");
    const shot = desktop(r, ["screenshot", "--base64", "--keep", kept]);
    expect(shot).toMatchObject({ code: 0, err: "" });
    const bytes = Buffer.from(/^data:image\/png;base64,(\S+)\n$/.exec(shot.out)![1]!, "base64");
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(readFileSync(join(kept, `${sha}.png`)).equals(bytes)).toBe(true);
    // A folder that isn't absolute is refused, and so is keeping a picture that isn't printed.
    expect(desktop(r, ["screenshot", "--base64", "--keep", "evidence"]).code).toBe(2);
    expect(desktop(r, ["screenshot", "--keep", kept]).code).toBe(2);
  });

  test("a click, a drag or a scroll holds the keys it is given (--hold) while it acts, as the toolset's own text asks", async () => {
    if (!needs()) return;
    const r = await deskd();
    expect(desktop(r, ["left_click", "10", "20", "--hold", "shift"])).toMatchObject({ code: 0, err: "" });
    expect(desktop(r, ["click", "30", "40", "right", "--hold", "ctrl"]).code).toBe(0);
    expect(desktop(r, ["left_click_drag", "10", "20", "30", "40", "--hold", "alt"]).code).toBe(0);
    expect(desktop(r, ["scroll", "down", "2", "100", "200", "--hold", "ctrl+shift"]).code).toBe(0);
    const t = r.trace().filter((e) => e.call === "key" || e.call === "button");
    const said = t.map((e) => (e.call === "key" ? `${e.down ? "+" : "-"}${e.key}` : `${e.down ? "+" : "-"}b${e.button}`));
    expect(said).toEqual([
      "+Shift_L", "+b1", "-b1", "-Shift_L",
      "+Control_L", "+b3", "-b3", "-Control_L",
      "+Alt_L", "+b1", "-b1", "-Alt_L",
      "+Control_L", "+Shift_L", "+b5", "-b5", "+b5", "-b5", "-Shift_L", "-Control_L",
    ]);
    // A key it can't hold is refused before anything is touched.
    const before = r.trace().length;
    expect(desktop(r, ["left_click", "10", "20", "--hold", "ctrl;reboot"]).code).toBe(2);
    expect(desktop(r, ["left_click", "10", "20", "--hold"]).code).toBe(2);
    expect(r.trace().slice(before).filter((e) => ["motion", "button", "key"].includes(String(e.call)))).toEqual([]);
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

  test("a look the gateway couldn't get answered, its plan taking too many calls at once, is said as that, never as a broken model", async () => {
    if (!needs()) return;
    // The gateway's words once it has waited a burst out (models' bursts.ts), as it answers them.
    const said = `vision is taking too many calls at once: asked 6 times over 60 s, it still answered 429 ("Rate limit exceeded. Please try again later."). That's a limit on how fast it's called, not its allowance: ask again in a minute.`;
    const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: { type: "invincible_burst", message: said } }, { status: 429, headers: { "x-invincible-waited": "6 asks, 60000 ms" } }) });
    try {
      const r = await deskd();
      const eyes = { INVINCIBLE_EYES: "vision/model-1", INVINCIBLE_GATEWAY: `http://127.0.0.1:${gateway.port}/gw`, INVINCIBLE_TOKEN: "gw_test-only" };
      const looking = Bun.spawn([built!, "look", "Where is Send?"], { env: { ...r.env, ...eyes }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = [await new Response(looking.stdout).text(), await new Response(looking.stderr).text()];
      expect(await looking.exited).toBe(1);
      expect(out).toBe("");
      expect(err).toBe(`desktop: no answer to the look this time: ${said}\n`);
    } finally {
      gateway.stop(true);
    }
  });

  test("eyes that answer places in a space of their own (--space, or INVINCIBLE_EYES_SPACE) have them put in the screen's pixels, and said so", async () => {
    if (!needs()) return;
    let said = "";
    const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => Response.json({ choices: [{ message: { content: said } }] }) });
    try {
      const r = await deskd();
      const eyes = { INVINCIBLE_EYES: "vision/model-1", INVINCIBLE_GATEWAY: `http://127.0.0.1:${gateway.port}/gw`, INVINCIBLE_TOKEN: "gw_test-only" };
      const look = async (args: string[], extra: Record<string, string> = {}) => {
        const looking = Bun.spawn([built!, "look", ...args], { env: { ...r.env, ...eyes, ...extra }, stdout: "pipe", stderr: "pipe" });
        return { out: await new Response(looking.stdout).text(), err: await new Response(looking.stderr).text(), code: await looking.exited };
      };
      said = "Send is at 500,500; Cancel at (250, 125).";
      expect(await look(["--space", "per-mille", "Where is Send?"])).toEqual({ out: "Send is at 640,400; Cancel at (320, 100).\n(Its places, in its own 0 to 1000, are given here in the screen's pixels.)\n", err: "", code: 0 });
      expect((await look(["Where is Send?"], { INVINCIBLE_EYES_SPACE: "scaled:1.25" })).out).toBe("Send is at 625,625; Cancel at (313, 156).\n(Its places, in a frame of its own, are given here in the screen's pixels.)\n");
      // Its own pixels: as it said them. A space that isn't one is refused.
      expect((await look(["Where is Send?"])).out).toBe("Send is at 500,500; Cancel at (250, 125).\n");
      expect((await look(["--space", "inches", "Where is Send?"])).code).toBe(2);
    } finally {
      gateway.stop(true);
    }
  });

  test("the owner's session, opened beside the agent's before deskd runs, waits for the agent's to start it, and starts none itself", async () => {
    if (!needs()) return;
    const dir = mkdtempSync(join(root, "cold-"));
    const run = join(dir, "run");
    const trace = join(dir, "trace");
    writeFileSync(trace, "");
    const env = { PATH: `${bin(join(dir, "bin"), trace)}:${process.env.PATH}`, HOME: dir, INVINCIBLE_DESKTOP_RUN: run, DESKD_TRACE: trace, INVINCIBLE_DESKD: harness, INVINCIBLE_DESKTOP_OWNER_UID: String(process.getuid!()) };
    const owner = Bun.spawn([built!, "--owner-session"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    owner.stdin.write('{"id":1,"name":"hold"}\n');
    owner.stdin.flush();
    try {
      await Bun.sleep(300);
      expect(existsSync(join(run, "deskd.sock"))).toBe(false);
      // The agent's own command starts deskd (as the node's session for the agent does), and the owner's is answered.
      expect(Bun.spawnSync([built!, "status"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      const reader = owner.stdout.getReader();
      let said = "";
      while (!said.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        said += new TextDecoder().decode(value);
      }
      expect(JSON.parse(said)).toEqual({ id: 1, ok: true, hold: null });
    } finally {
      owner.kill();
      const pid = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((t) => t.call === "serving")?.pid;
      if (pid) process.kill(pid);
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

  test("into a terminal, text the keyboard has no keys for is pasted from a selection deskd holds, PRIMARY, with shift+Insert; into another app, CLIPBOARD, with ctrl+v", async () => {
    const term = await deskd({ DESKD_FOCUS: "xterm" });
    await session(term, [{ id: 1, name: "type", input: { text: TEST_STRING } }]);
    expect(calls(term.trace(), "own")).toEqual([{ call: "own", text: TEST_STRING, selection: "PRIMARY" }]);
    expect(keys(term.trace())).toEqual(["+Shift_L", "+Insert", "-Insert", "-Shift_L"]);
    const editor = await deskd({ DESKD_FOCUS: "mousepad" });
    await session(editor, [{ id: 1, name: "type", input: { text: TEST_STRING } }]);
    expect(calls(editor.trace(), "own")).toEqual([{ call: "own", text: TEST_STRING, selection: "CLIPBOARD" }]);
    expect(keys(editor.trace())).toEqual(["+Control_L", "+v", "-v", "-Control_L"]);
    for (const run of [term, editor]) expect(calls(run.trace(), "xdotool")).toEqual([]);
  });

  test("a paste takes only the selection its keys read: CLIPBOARD for ctrl+v, never PRIMARY too, so the text an app has selected stays selected and the paste replaces it", () => {
    // (Taking PRIMARY from a GTK app unselects its text: KiCad's field, ctrl+a then a pasted name, got the name after
    // the one selected, 27 November 2026. deskd's own Watch, its display a stand-in that writes down what is taken.)
    expect(py(`
import threading
w = d.Watch.__new__(d.Watch)
w.lock = threading.Lock(); w.given = threading.Event(); w.win = 7; w.clip = None
taken = []
class X:
    def XSetSelectionOwner(self, dpy, atom, win, when): taken.append((atom, win))
class D:
    dpy = None; atoms = {"PRIMARY": 1, "CLIPBOARD": 2}; x = X()
    def sync(self): pass
w.d = D()
w.own("Søren 🙂", "CLIPBOARD"); ctrl_v = list(taken); del taken[:]
w.own("Søren 🙂", "PRIMARY"); shift_insert = list(taken)
print(json.dumps({"ctrl+v": ctrl_v, "shift+Insert": shift_insert, "held": w.clip.decode("utf-8")}))`)).toEqual({ "ctrl+v": [[2, 7]], "shift+Insert": [[1, 7]], held: "Søren 🙂" });
  });

  test("short text the keyboard has keys for still goes key by key, shift where it needs it, into whatever takes text", async () => {
    const r = await deskd({ DESKD_FOCUS: "xterm" });
    await session(r, [{ id: 1, name: "type", input: { text: "Ls -a" } }]);
    expect(keys(r.trace())).toEqual(["+Shift_L", "+l", "-l", "-Shift_L", "+s", "-s", "+space", "-space", "+-", "--", "+a", "-a"]);
    expect(calls(r.trace(), "own")).toEqual([]);
  });
});

describe("what deskd starts and doesn't keep, an app the agent asked for, ends as itself", () => {
  test("waited on as it quits: never a zombie under deskd, which a look at the processes takes for one still running", () => {
    // (KiCad quit by its own key closed its window at once, and stayed in the process table under deskd, a zombie, until
    // deskd next started anything: Ultra, 27 November 2026.)
    expect(
      py(`
import os, tempfile
d.RUN = tempfile.mkdtemp()
p = d.Pieces(home=tempfile.mkdtemp())
pid = p._spawn(["sh", "-c", "exit 0"], "app-quits.log")
for _ in range(100):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        print(json.dumps("ended"))
        break
    time.sleep(0.05)
else:
    print(json.dumps("still in the process table"))`),
    ).toBe("ended");
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
d._own = lambda comm: [1] if comm in ("Xvfb", "openbox", "at-spi-bus-laun") else []
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

describe("light by default (C1 step 10): an unused desktop stops, and the next command starts it again", () => {
  const me = String(process.getuid!());
  /**
   * How long these desktops sit unused before they stop: 3 s, where it was 0.3. A command must reach the desktop it
   * starts before then, and a starved machine's can't within 0.3 s (2 % of a core, 28 November 2026: each deskd started
   * again stopped before its command came, twelve times over). Its stop is waited for that long and more; each test
   * has the time a busy machine takes (12 to 14 s with 2 % of a core, one 59 s), which is never what it checks.
   */
  const IDLE = "3";
  const STOPS_WITHIN = 15_000;
  const LIMIT = 60_000;
  /** Until the trace says the desktop was stopped (once more than `since` times), `ms` at most: whether it was. */
  const stopped = async (r: Running, ms: number, since = 0) => {
    for (let waited = 0; waited < ms; waited += 20) {
      if (calls(r.trace(), "stop").length > since) return true;
      await Bun.sleep(20);
    }
    return false;
  };

  test("left unused, it stops as `desktop stop` does, each window closed first; the agent's next command starts it again and is told, once", async () => {
    if (!built) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_IDLE: IDLE });
    expect(desktop(r, ["click", "10", "20"]).code).toBe(0);
    expect(await stopped(r, STOPS_WITHIN)).toBe(true);
    const order = r.trace().filter((t) => t.call === "close" || t.call === "stop").map((t) => (t.call === "close" ? "close" : "stop"));
    expect(order.at(-1)).toBe("stop");
    expect(order.filter((o) => o === "close").length).toBeGreaterThan(0);
    // (The next deskd keeps it up this time: its own word is the one asked of.)
    const next = desktop(r, ["click", "10", "20"], { INVINCIBLE_DESKTOP_IDLE: "60" });
    expect(next.code).toBe(0);
    expect(next.err).toMatch(/^desktop: this desktop was stopped after 3\.0 s with nothing done on it and no one watching, its windows closed as a person closes them; this command started it again, a fresh screen \(the browser's profile, and what is signed in there, are kept in \/work\)\.\n/);
    expect(desktop(r, ["click", "10", "20"]).err).not.toContain("was stopped");
    expect(existsSync(join(r.run, "idle-stopped"))).toBe(false);
  }, LIMIT);

  test("started and never used after (the node's start, as a desktop task's work begins), it stops as any unused desktop does, and the agent's first command is told", async () => {
    if (!built) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_IDLE: IDLE });
    expect(desktop(r, ["start"]).code).toBe(0);
    expect(await stopped(r, STOPS_WITHIN)).toBe(true);
    const order = r.trace().filter((t) => t.call === "close" || t.call === "stop").map((t) => (t.call === "close" ? "close" : "stop"));
    expect(order.at(-1)).toBe("stop");
    const next = desktop(r, ["click", "10", "20"], { INVINCIBLE_DESKTOP_IDLE: "60" });
    expect(next.code).toBe(0);
    expect(next.err).toContain("this desktop was stopped after 3.0 s with nothing done on it and no one watching");
  }, LIMIT);

  test("a deskd the client started on its own, after an idle stop, ends with its test as the one the test started does", async () => {
    if (!built) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_IDLE: IDLE });
    expect(desktop(r, ["click", "10", "20"]).code).toBe(0);
    expect(await stopped(r, STOPS_WITHIN)).toBe(true);
    // (The next one the client starts itself, apart from it, as in a VM: asked only whether the desktop is up, it never
    // brings it up, so it never stops for being unused either. Every run of this file left one running, for hours.)
    expect(desktop(r, ["status"], { INVINCIBLE_DESKTOP_IDLE: "60" }).code).toBe(0);
    const trace = join(dirname(r.run), "trace");
    // (A deskd that left at once, another holding the lock, never served: the client may start one again as it waits.)
    const said = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const left = new Set(said.filter((t) => t.call === "left").map((t) => t.pid as number));
    const served = said.filter((t) => t.call === "serving" && !left.has(t.pid as number)).map((t) => t.pid as number);
    expect(served).toHaveLength(2);
    const started = served.at(-1)!;
    // (Ended: gone, or a zombie, ended and not yet reaped: its parent is then the first process of wherever it runs, which
    // in a container may never reap it, as in CI's. Where there is a /proc, its state says which.)
    const ended = (): boolean => {
      try {
        process.kill(started, 0);
      } catch {
        return true;
      }
      try {
        const stat = readFileSync(`/proc/${started}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z");
      } catch {
        return false;
      }
    };
    expect(ended()).toBe(false);
    // Its test over (its folder gone), it ends, within 4 s at the most.
    rmSync(trace);
    for (let i = 0; i < 40 && !ended(); i++) await Bun.sleep(100);
    expect(ended()).toBe(true);
  }, LIMIT);

  test("used, held or watched, it stays up; watched no more, it stops", async () => {
    if (!built) return;
    const watched = join(mkdtempSync(join(root, "watch-")), "watched");
    const r = await deskd({ INVINCIBLE_DESKTOP_IDLE: IDLE, INVINCIBLE_DESKTOP_OWNER_UID: me, DESKD_WATCHED: watched });
    // Each for 4 s, longer than it sits unused before it stops. (Its stops are counted from its first command: one a
    // starved machine made before it came isn't one while it was used.)
    expect(desktop(r, ["windows"]).code).toBe(0);
    const before = calls(r.trace(), "stop").length;
    // Used: a command every 0.1 s.
    for (let i = 0; i < 40; i++) {
      expect(desktop(r, ["windows"]).code).toBe(0);
      await Bun.sleep(100);
    }
    expect(calls(r.trace(), "stop")).toHaveLength(before);
    // Held: the owner has it, with nothing asked.
    const node = await opened(r, true);
    expect(await node.ask({ id: 1, name: "take", input: { idle: 30 } })).toMatchObject({ ok: true, took: true });
    await Bun.sleep(4000);
    expect(calls(r.trace(), "stop")).toHaveLength(before);
    expect(await node.ask({ id: 2, name: "release" })).toMatchObject({ ok: true, released: true });
    await node.close();
    // Watched: the stream's encoder runs, with nothing asked; then no one watches, and it stops.
    writeFileSync(watched, "");
    await Bun.sleep(4000);
    expect(calls(r.trace(), "stop")).toHaveLength(before);
    rmSync(watched);
    expect(await stopped(r, STOPS_WITHIN, before)).toBe(true);
    // (Its forty commands and two 4 s waits took 59 s with 2 % of a core: three times that.)
  }, 180_000);

  test("a command that comes as the unused desktop stops, its deskd still holding the lock, starts deskd again as it waits, and is answered", async () => {
    if (!built) return;
    // The deskd that stops for being unused holds deskd.lock until it has gone, and one started meanwhile leaves at once
    // (one deskd at a time). Here the test's deskd is stopped outright and the lock held 2 s after, as a stopping deskd
    // holds it on a busy machine (2 % of a core, 28 November 2026): the command's first deskd leaves, and it must start
    // another as it waits, within the product's own 20 s.
    const r = await deskd();
    r.stop();
    const holding = Bun.spawn(["python3", "-I", "-c", "import fcntl, sys, time\nf = open(sys.argv[1], 'w')\nfcntl.flock(f, fcntl.LOCK_EX)\nprint('held', flush=True)\ntime.sleep(2)", join(r.run, "deskd.lock")], { stdout: "pipe" });
    expect(new TextDecoder().decode((await holding.stdout.getReader().read()).value)).toBe("held\n");
    const asked = desktop(r, ["status"], { INVINCIBLE_DESKTOP_WAIT: "20" });
    expect({ code: asked.code, err: asked.err }).toEqual({ code: 0, err: "" });
    await holding.exited;
    // (The command's first deskd left while the lock was held; one started again served it, after the test's own.)
    const said = readFileSync(join(dirname(r.run), "trace"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const left = new Set(said.filter((t) => t.call === "left").map((t) => t.pid as number));
    expect(left.size).toBeGreaterThanOrEqual(1);
    expect(said.filter((t) => t.call === "serving" && !left.has(t.pid as number))).toHaveLength(2);
  }, LIMIT);

  test("asking only whether it is up keeps it from nothing; and the owner's look that starts it again leaves the agent's word for the agent", async () => {
    if (!built) return;
    const r = await deskd({ INVINCIBLE_DESKTOP_IDLE: IDLE, INVINCIBLE_DESKTOP_OWNER_UID: me });
    expect(desktop(r, ["click", "10", "20"]).code).toBe(0);
    // (The stop that comes while it is asked only whether it is up: one a starved machine made before the click isn't it.)
    const before = calls(r.trace(), "stop").length;
    let stoppedWhileAsked = false;
    for (const until = Date.now() + STOPS_WITHIN; Date.now() < until && !stoppedWhileAsked; ) {
      desktop(r, ["status"]);
      stoppedWhileAsked = calls(r.trace(), "stop").length > before;
      await Bun.sleep(100);
    }
    expect(stoppedWhileAsked).toBe(true);
    // The owner looks first (their app, after it): the node asks `status` on the agent's session, which starts deskd, and
    // their look starts the desktop again. The word waits for the agent's own command.
    await Bun.sleep(100);
    const status = desktop(r, ["status"], { INVINCIBLE_DESKTOP_IDLE: "60" });
    expect(status.code).toBe(0);
    expect(status.err).not.toContain("was stopped");
    const node = await opened(r, true);
    const look = await node.ask({ id: 1, name: "screenshot", input: {} });
    expect(JSON.stringify(look)).not.toContain("was stopped");
    await node.close();
    expect(desktop(r, ["click", "10", "20"]).err).toContain("this desktop was stopped after 3.0 s");
  }, LIMIT);
});

describe("the accessibility tree beside the pixels (step 6)", () => {
  /**
   * An accessibility bus as AT-SPI's registry and its apps answer it: Chromium (its page's form, in the window with the
   * focus, and a window behind it), and a GTK 4 app, whose boxes are its own window's, not the screen's.
   */
  const BUS = `
SHOWING, VISIBLE, SENSITIVE, FOCUSED, EDITABLE, ACTIVE, COLLAPSED = 1 << 25, 1 << 30, 1 << 24, 1 << 12, 1 << 7, 1 << 1, 1 << 5
ON = SHOWING | VISIBLE | SENSITIVE
ROLE = {r: i for i, r in enumerate(d.ROLES)}
APPS = {":1.5": {"name": "Chromium", "toolkit": "Chromium", "version": "1.0", "pid": 300}, ":1.9": {"name": "notes", "toolkit": "GTK", "version": "4.18.6", "pid": 400}}
# Each node: its app, its parent, its role, its name, its states, its box (in the screen's space; GTK 4's in its window's).
NODES = {
    "/f1": (":1.5", "/r", "frame", "Form - Chromium", ON | ACTIVE, (0, 0, 1280, 800)),
    "/d1": (":1.5", "/f1", "document web", "Form", ON, (0, 80, 1280, 720)),
    "/n1": (":1.5", "/d1", "entry", "Name", ON | FOCUSED | EDITABLE, (100, 200, 300, 24)),
    "/n2": (":1.5", "/d1", "entry", "Email", ON | EDITABLE, (100, 240, 300, 24)),
    "/n3": (":1.5", "/d1", "combo box", "Plan", ON | COLLAPSED, (100, 280, 200, 24)),
    "/n4": (":1.5", "/d1", "check box", "I agree to the terms", ON, (100, 320, 13, 13)),
    "/n5": (":1.5", "/d1", "push button", "Send", ON, (100, 360, 60, 24)),
    "/n6": (":1.5", "/d1", "push button", "Hidden", VISIBLE | SENSITIVE, (100, 400, 60, 24)),
    "/n7": (":1.5", "/d1", "label", "Name", ON, (100, 180, 60, 18)),
    "/n8": (":1.5", "/d1", "link", "Far below", ON, (100, 2000, 80, 18)),
    "/n9": (":1.5", "/d1", "text", "Read only", ON, (100, 440, 300, 18)),
    "/n10": (":1.5", "/d1", "push button", "Not now", VISIBLE | SHOWING, (200, 360, 60, 24)),
    "/f2": (":1.5", "/r", "frame", "Other - Chromium", ON, (0, 0, 1280, 800)),
    "/m1": (":1.5", "/f2", "push button", "Behind", ON, (500, 500, 60, 24)),
    "/g0": (":1.9", "/r", "frame", "Notes", ON | ACTIVE, (0, 0, 400, 300)),
    "/g1": (":1.9", "/g0", "push button", "Save", ON, (10, 10, 60, 30)),
}
COLLECTION = True  # (an app without it is walked)
TEXTS = {"/n1": "Søren Ærø", "/n2": "soren@example.test"}  # (what a field holds, its caret at its end)
calls, spaces = [], []
def kids(bus, path):
    return [(bus, p) for p, n in NODES.items() if n[0] == bus and n[1] == path]
def under(bus, path):
    out = []
    for ref in kids(bus, path):
        out += [ref] + under(*ref)
    return out
def unbits(words):
    return {i * 32 + b for i, w in enumerate(words) for b in range(32) if (w & 0xFFFFFFFF) >> b & 1}
def call(bus, path, iface, method, signature, args):
    calls.append(method)
    if method == "GetChildren":
        return ([(b, "/r") for b in APPS],) if bus == "org.a11y.atspi.Registry" else (kids(bus, path),)
    if method == "GetConnectionUnixProcessID":
        return (APPS[args[0]]["pid"],)
    if method == "Get" and path == "/r":
        return ({"Name": APPS[bus]["name"], "ToolkitName": APPS[bus]["toolkit"], "Version": APPS[bus]["version"]}[args[1]],)
    if path not in NODES:
        raise d.Failed("gone")
    n = NODES[path]
    if method == "Get" and args[0] == "org.a11y.atspi.Text":
        return (len(TEXTS.get(path, "")),)
    if method == "Get":
        return (n[3],)
    if method == "GetRole":
        return (ROLE[n[2]],)
    if method == "GetState":
        return ([n[4] & 0xFFFFFFFF, n[4] >> 32],)
    if method == "GetMatches":
        if not COLLECTION:
            raise d.Failed("the accessibility bus didn't answer GetMatches: org.freedesktop.DBus.Error.UnknownMethod")
        (st, stm, _, _, ro, rom, _, _, _), _, _, _ = args
        want, roles = unbits(st), unbits(ro)
        return ([r for r in under(bus, path) if all(NODES[r[1]][4] >> s & 1 for s in want) and ROLE[NODES[r[1]][2]] in roles],)
    if method == "GetText":
        return (TEXTS.get(path, "")[args[0]:args[1]],)
    if method == "GetExtents":
        spaces.append([path, args[0]])
        own = APPS[bus]["toolkit"] == "GTK"
        return (n[5],) if args[0] == (1 if own else 0) else ((0, 0) + n[5][2:],)
    raise AssertionError(method)
origins = []
def origin(pid, title):
    origins.append([pid, title]); return (200, 150) if pid == 400 else None
t = d.Tree(call=call, window_origin=origin)
`;

  test("the window with the focus, as what can be acted on in it: each node a line with its ref, role, name, centre and size; nothing off the screen, hidden, inert or behind", () => {
    const got = py(`${BUS}
said = t.actable(pid=300, title="Form - Chromium")
print(json.dumps({"lines": [d.say_node(r, n, b) for r, n, b in said], "refs": sorted(t.refs), "matches": calls.count("GetMatches"), "walked": calls.count("GetChildren")}))`) as { lines: string[]; refs: number[]; matches: number; walked: number };
    expect(got.lines).toEqual([
      '[1] entry "Name" at 250,212 (300x24) focused',
      '[2] entry "Email" at 250,252 (300x24)',
      '[3] combo box "Plan" at 200,292 (200x24) collapsed',
      '[4] check box "I agree to the terms" at 106,326 (13x13)',
      '[5] push button "Send" at 130,372 (60x24)',
      '[6] push button "Not now" at 230,372 (60x24) disabled',
    ]);
    expect(got.refs).toEqual([1, 2, 3, 4, 5, 6]);
    // The app searches its own tree, in one call for the window: no walk (the registry's list and the app's windows only).
    expect(got).toMatchObject({ matches: 1, walked: 2 });
  });

  test("an app that can't search its own tree (no Collection) is walked, many calls in flight, never below what isn't showing: the same nodes", () => {
    const got = py(`${BUS}
COLLECTION = False
said = t.actable(pid=300, title="Form - Chromium")
print(json.dumps({"lines": [d.say_node(r, n, b) for r, n, b in said]}))`) as { lines: string[] };
    expect(got.lines).toEqual([
      '[1] entry "Name" at 250,212 (300x24) focused',
      '[2] entry "Email" at 250,252 (300x24)',
      '[3] combo box "Plan" at 200,292 (200x24) collapsed',
      '[4] check box "I agree to the terms" at 106,326 (13x13)',
      '[5] push button "Send" at 130,372 (60x24)',
      '[6] push button "Not now" at 230,372 (60x24) disabled',
    ]);
  });

  test("GTK 4 says 0,0 for every place on the screen: it is asked for its window's, and that window's place on the screen (from X) is added, by its process and title; others' are the screen's already", () => {
    const got = py(`${BUS}
said = t.actable(app="notes")
print(json.dumps({"lines": [d.say_node(r, n, b) for r, n, b in said], "origins": origins, "spaces": spaces}))`) as { lines: string[]; origins: unknown[]; spaces: unknown[] };
    expect(got.lines).toEqual(['[1] push button "Save" at 240,175 (60x30)']);
    expect(got.origins).toEqual([[400, "Notes"]]);
    expect(got.spaces).toEqual([["/g1", 1]]);
    expect(py(`${BUS}
t.actable(pid=300, title="Form - Chromium")
print(json.dumps(origins))`)).toEqual([]);
  });

  test("find: the role in a model's words, the name in any case, the app with the focus first; its centre and a ref", () => {
    const got = py(`${BUS}
ref, node, box = t.find("button", "send", pid=300)
miss = t.find("checkbox", "nothing like it", pid=300)
try:
    t.find("gizmo", "x"); bad = None
except d.Refused as e:
    bad = str(e)
print(json.dumps({"ref": ref, "role": node["role"], "box": box, "miss": miss, "line": d.say_node(ref, node, box), "bad": bad}))`) as Record<string, unknown>;
    expect(got).toEqual({ ref: 1, role: "push button", box: [100, 360, 60, 24], miss: null, line: '[1] push button "Send" at 130,372 (60x24)', bad: 'there is no role "gizmo" (desktop tree shows the roles on the screen)' });
  });

  test("a ref is clicked where its node is at that moment, not where it was said; one that's gone says so", () => {
    const got = py(`${BUS}
t.actable(pid=300, title="Form - Chromium")
NODES["/n5"] = NODES["/n5"][:5] + ((100, 500, 60, 24),)
node, box = t.at(5)
del NODES["/n5"]
try:
    t.at(5); gone = None
except d.Failed as e:
    gone = str(e)
try:
    t.at(99); unknown = None
except d.Refused as e:
    unknown = str(e)
print(json.dumps({"box": box, "gone": gone, "unknown": unknown}))`) as Record<string, unknown>;
    expect(got).toEqual({ box: [100, 500, 60, 24], gone: 'ref=5 (push button "Send") is gone: desktop tree, again', unknown: "there is no ref=99: desktop tree (or find) gives them" });
  });

  test("an app that isn't on the bus is named among those that are", () => {
    expect(py(`${BUS}
try:
    t.actable(app="kicad"); said = None
except d.Failed as e:
    said = str(e)
print(json.dumps(said))`)).toBe("no app named like kicad is on the accessibility bus (on it: Chromium, notes)");
  });

  test("the tree reads what is before the caret of the field with the focus, in the window with the focus; a password field, or an app not on the bus, it can't say", () => {
    expect(py(`${BUS}
got = t.caret_text(pid=300, title="Form - Chromium")
NODES["/n1"] = NODES["/n1"][:2] + ("password text",) + NODES["/n1"][3:]
hidden = t.caret_text(pid=300, title="Form - Chromium")
print(json.dumps({"got": got, "hidden": hidden, "elsewhere": t.caret_text(pid=999)}))`)).toEqual({ got: "Søren Ærø", hidden: null, elsewhere: null });
  });

  test("what is typed into an app is checked where its accessibility tree can say what landed, as the page's is by its DOM (step 4's last line)", async () => {
    const right = await deskd({ DESKD_FOCUS: "mousepad", DESKD_LANDED: "Dear Søren,\n  Hello" });
    const [ok] = await session(right, [{ id: 1, name: "type", input: { text: "Hello" } }]);
    expect(ok).toMatchObject({ ok: true, did: "typed 5 characters" });
    expect(calls(right.trace(), "caret_text").length).toBeGreaterThan(0);
    const wrong = await deskd({ DESKD_FOCUS: "mousepad", DESKD_LANDED: "Dear Søren,\n  Hel" });
    const [lost] = await session(wrong, [{ id: 1, name: "type", input: { text: "Hello" } }]);
    expect(lost).toMatchObject({ ok: false, error: 'the text didn\'t land as typed: the field holds "Dear Søren,\\n  Hel"' });
    // A field whose text the tree reads differently only in its spacing (an editor's indent) landed.
    const spaced = await deskd({ DESKD_FOCUS: "mousepad", DESKD_LANDED: "def f():\n        return 1" });
    const [indented] = await session(spaced, [{ id: 1, name: "type", input: { text: "def f():\n    return 1" } }]);
    expect(indented).toMatchObject({ ok: true });
    // Where the tree can't say (a terminal shows none), nothing is asked of it.
    const term = await deskd({ DESKD_FOCUS: "xterm", DESKD_LANDED: "nothing like it" });
    const [termed] = await session(term, [{ id: 1, name: "type", input: { text: "ls" } }]);
    expect(termed).toMatchObject({ ok: true });
    expect(calls(term.trace(), "caret_text")).toEqual([]);
  });

  test("the bus's resident listener starts with the first lookup, once, off the answer's path: not at the desktop's start, where it slowed the browser's first page", () => {
    expect(py(`
class FakeTree:
    listened = 0
    def listen(self, session_bus): FakeTree.listened += 1
class P:
    session_bus = ("unix:path=/tmp/example-bus", 4321)
    def start(self): pass
desk = d.Desk(pieces=P(), display=object(), watch=object(), browser=d.Browser(), tree=FakeTree())
before = FakeTree.listened
desk.tree; desk.tree; time.sleep(0.1)
print(json.dumps({"before": before, "after": FakeTree.listened}))`)).toEqual({ before: 0, after: 1 });
  });

  test("the accessibility bus starts before the browser, which is started with its accessibility on", () => {
    const got = py(`
import tempfile
p = d.Pieces(home=tempfile.mkdtemp())
order = []
class Ran:
    returncode, stdout, stderr = 0, "unix:path=/tmp/example-session-bus,guid=0\\n4321\\n", ""
d.subprocess.run = lambda argv, **kw: (order.append(argv[0]), Ran())[1]
def spawn(argv, log, keep=None):
    order.append(argv[0] if argv[0] != "chromium" else "chromium " + " ".join(a for a in argv if "accessib" in a)); return 4242
p._spawn = spawn
d._own = lambda comm: [1] if comm in ("Xvfb", "openbox") else []
d._alive = lambda pid: False
p.display_up = lambda: True
p.browser_up = lambda: False
p.a11y_bus = lambda: "unix:path=/tmp/example-a11y-bus"
p.start()
print(json.dumps({"order": order, "bus": d.os.environ.get("DBUS_SESSION_BUS_ADDRESS")}))`) as { order: string[]; bus: string };
    expect(got.order).toEqual(["dbus-daemon", "/usr/libexec/at-spi-bus-launcher", "chromium --force-renderer-accessibility"]);
    expect(got.bus).toBe("unix:path=/tmp/example-session-bus,guid=0");
  });
});
