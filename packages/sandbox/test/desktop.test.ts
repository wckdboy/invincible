import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_IMAGE, OWN_IMAGES } from "../src/index.ts";

/*
 * A knight's desktop: a display, a window manager and a browser in its own VM, and one command (`desktop`) that
 * operates them: open an address, read the page, take a screenshot, move the pointer, press keys. Tried by hand in
 * a microVM on ultra on 14 November 2026 before any of this was written (Chromium runs there only without its own
 * inner sandbox: the VM's restrictions forbid it, and the microVM is the boundary). Here the command itself is run,
 * with stand-ins for the display's tools that write down what they were asked.
 */

const context = new URL("../../../sandbox/desktop/", import.meta.url);
const script = fileURLToPath(new URL("desktop", context));
const dockerfile = readFileSync(new URL("Dockerfile", context), "utf8");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A machine with stand-ins for the display's tools: each writes its name and arguments to `trace`, one line a call. */
function machine(options: { running?: boolean; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "galahad-desktop-")); dirs.push(dir);
  const bin = join(dir, "bin"), home = join(dir, "home"), run = join(dir, "run"), trace = join(dir, "trace");
  mkdirSync(bin); mkdirSync(home); mkdirSync(run);
  // (One write a call: tools started in the background write at the same time as those that wait for them.)
  const tool = (name: string, body = "") => { writeFileSync(join(bin, name), `#!/bin/sh\nline=${name}; for a in "$@"; do line="$line [$a]"; done; printf '%s\\n' "$line" >> "$TRACE"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  for (const name of ["Xvfb", "openbox", "chromium", "xdotool"]) tool(name);
  // The display answers once it is "up": after Xvfb was asked for, or from the start.
  tool("xdpyinfo", options.running ? 'echo "  dimensions:    1280x800 pixels"' : 'grep -q "^Xvfb" "$TRACE" && echo "  dimensions:    1280x800 pixels" || exit 1');
  tool("scrot", 'for a in "$@"; do last=$a; done; printf PNG > "$last"');
  tool("pgrep", options.running ? "exit 0" : 'grep -q "^chromium" "$TRACE" && exit 0 || exit 1');
  tool("python3", 'echo "Example Domain"; echo "https://example.com/"; echo "This domain is for use in documentation examples."');
  const ask = (...args: string[]) => {
    const proc = Bun.spawnSync(["sh", script, ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TRACE: trace, GALAHAD_DESKTOP_RUN: run, TMPDIR: run, GALAHAD_DESKTOP_WAIT: "3", ...options.env } });
    return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
  };
  const traced = () => (existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean) : []);
  return { ask, traced, home, run };
}

describe("the desktop command", () => {
  // (Each of these runs the real desktop script, which waits for what it starts: 30 s, not bun's 5, for a busy machine. On 19 November 2026 two ran past 5 s under a load of 10 on 12 cores.)
  test("start brings up the display, the window manager and the browser, once: a second start finds them running", () => {
    const m = machine();
    expect(m.ask("start")).toMatchObject({ code: 0, out: "The desktop is up: 1280x800, display :1." });
    const started = m.traced().filter((line) => /^(Xvfb|openbox|chromium)( |$)/.test(line));
    expect(started.map((line) => line.split(" ")[0])).toEqual(["Xvfb", "openbox", "chromium"]);
    expect(started[0]).toBe("Xvfb [:1] [-screen] [0] [1280x800x24] [-nolisten] [tcp]");
    // The browser: its profile on the workspace (a sign-in there stays with the knight's disk), its own inner sandbox
    // off (the VM forbids it), and a port on loopback through which a page can be read as text.
    for (const flag of [`[--user-data-dir=${m.home}/.config/chromium]`, "[--no-sandbox]", "[--hide-crash-restore-bubble]", "[--remote-debugging-port=9222]", "[--remote-debugging-address=127.0.0.1]", "[--window-size=1280,800]"]) expect(started[2]).toContain(flag);
    expect(m.ask("start").code).toBe(0);
    expect(m.traced().filter((line) => /^(Xvfb|openbox|chromium)( |$)/.test(line))).toHaveLength(3);
  }, 30_000);

  test("every other command starts the desktop if it isn't up, then does one thing with the pointer, the keyboard or the browser", () => {
    const m = machine();
    expect(m.ask("click", "640", "330").code).toBe(0);
    expect(m.traced().some((line) => line.startsWith("Xvfb "))).toBe(true);
    expect(m.traced().at(-1)).toBe("xdotool [mousemove] [640] [330] [click] [1]");
    const up = machine({ running: true });
    const last = (...args: string[]) => { expect(up.ask(...args)).toMatchObject({ code: 0 }); return up.traced().at(-1); };
    expect(last("click", "10", "20", "right")).toBe("xdotool [mousemove] [10] [20] [click] [3]");
    expect(last("click", "10", "20", "double")).toBe("xdotool [mousemove] [10] [20] [click] [--repeat] [2] [1]");
    expect(last("move", "5", "6")).toBe("xdotool [mousemove] [5] [6]");
    expect(last("scroll", "down", "3")).toBe("xdotool [click] [--repeat] [3] [5]");
    expect(last("scroll", "up")).toBe("xdotool [click] [--repeat] [1] [4]");
    expect(last("key", "ctrl+l", "Return")).toBe("xdotool [key] [--] [ctrl+l] [Return]");
    // What is typed is one argument to the tool, whatever is in it: never a command.
    expect(last("type", "a; rm -rf / $(id) `id`")).toBe("xdotool [type] [--delay] [12] [--] [a; rm -rf / $(id) `id`]");
    // An address goes to the browser's one page through its own port, never to a second browser: what is opened is what is read.
    expect(last("open", "https://example.com/a?b=c")).toBe("python3 [-] [navigate] [https://example.com/a?b=c]");
    expect(last("text")).toBe("python3 [-] [text]");
    expect(up.traced().filter((line) => line.startsWith("chromium"))).toEqual([]);
    expect(up.traced().some((line) => line.startsWith("Xvfb "))).toBe(false);
  }, 30_000);

  test("a screenshot is a file it names, and the page in front can be read as text", () => {
    const m = machine({ running: true });
    const shot = m.ask("shot");
    expect(shot.code).toBe(0);
    expect(shot.out).toMatch(/\/shot-\d+\.png$/);
    expect(readFileSync(shot.out, "utf8")).toBe("PNG");
    const named = join(m.run, "mine.png");
    expect(m.ask("shot", named)).toMatchObject({ code: 0, out: named });
    expect(m.ask("text")).toMatchObject({ code: 0, out: "Example Domain\nhttps://example.com/\nThis domain is for use in documentation examples." });
  }, 30_000);

  test("what isn't a place on the screen, a key, or an address is refused before anything is touched", () => {
    const m = machine({ running: true });
    const refused = (...args: string[]) => { const before = m.traced().length; const r = m.ask(...args); expect({ args, code: r.code }).toEqual({ args, code: 2 }); expect(m.traced().filter((line) => /^(xdotool|chromium|scrot|python3) /.test(line)).length).toBe(m.traced().slice(0, before).filter((line) => /^(xdotool|chromium|scrot|python3) /.test(line)).length); return r.err; };
    expect(refused("click", "10", "x")).toContain("whole numbers");
    expect(refused("click", "-5", "10")).toContain("whole numbers");
    expect(refused("click", "10", "20", "sideways")).toContain("left, right, middle or double");
    expect(refused("key", "ctrl+l; reboot")).toContain("keys are names like");
    expect(refused("key")).toContain("keys are names like");
    expect(refused("scroll", "sideways")).toContain("up or down");
    expect(refused("open", "javascript:alert(1)")).toContain("http, https, file or about");
    expect(refused("open", "--proxy-server=evil")).toContain("http, https, file or about");
    expect(refused("dance")).toContain("desktop start");
    // With nothing asked, it says what it can do.
    expect(m.ask("help").out).toContain("desktop click <x> <y>");
  }, 30_000);
});

describe("looking at the screen", () => {
  test("look takes a screenshot and puts the question to the model that was named for this VM, through the gateway it was given", () => {
    const m = machine({ running: true, env: { GALAHAD_EYES: "opencode-go/gpt-6-luna", GALAHAD_GATEWAY: "http://gateway.test/gw", GALAHAD_TOKEN: "gw_test-only" } });
    expect(m.ask("look", "Where is the Sign in button?")).toMatchObject({ code: 0 });
    const asked = m.traced().filter((line) => /^(scrot|python3) /.test(line));
    // A fresh picture of the screen (a JPEG: a tenth of the size), then the question with it.
    expect(asked[0]).toMatch(/^scrot \[-o\] \[.*\/look-\d+\.jpg\]$/);
    expect(asked[1]).toMatch(/^python3 \[-\] \[look\] \[.*\/look-\d+\.jpg\] \[Where is the Sign in button\?\]$/);
    // Nothing of the token is ever an argument (the script reads it from its environment).
    expect(m.traced().join("\n")).not.toContain("gw_test-only");
  }, 30_000);

  test("with no model that can see named for this VM, or no question, look says so and touches nothing", () => {
    const blind = machine({ running: true });
    const none = blind.ask("look", "What is on the screen?");
    expect(none.code).toBe(3);
    expect(none.err).toContain("no model that can see is set for this VM");
    expect(blind.traced().filter((line) => /^(scrot|python3) /.test(line))).toEqual([]);
    const m = machine({ running: true, env: { GALAHAD_EYES: "opencode-go/gpt-6-luna", GALAHAD_GATEWAY: "http://gateway.test/gw", GALAHAD_TOKEN: "gw_test-only" } });
    expect(m.ask("look").code).toBe(2);
    expect(m.ask("help").out).toContain('desktop look "<question>"');
  }, 30_000);
});

describe("the desktop image", () => {
  test("is the knights' image with a display, a window manager, a browser and the tools that operate them, and ends as the knight", () => {
    expect(dockerfile).toMatch(/^FROM galahad\/sandbox:1$/m);
    const installed = dockerfile.replace(/\\\n/g, " ");
    for (const pkg of ["xvfb", "openbox", "chromium", "xdotool", "scrot", "x11-utils", "python3-websocket", "fonts-noto-cjk"]) expect(installed).toMatch(new RegExp(`apt-get install[^\\n]* ${pkg}( |$)`, "m"));
    expect(dockerfile).toContain("COPY desktop /usr/local/bin/desktop\n");
    expect(dockerfile).toContain("RUN chmod 0755 /usr/local/bin/desktop\n");
    // Root only to install: the image is left as the knight's user, like the one it is made from.
    expect(dockerfile.trimEnd().split("\n").filter((line) => line.startsWith("USER ")).at(-1)).toBe("USER 1000:1000");
    expect(DESKTOP_IMAGE).toBe("galahad/desktop:1");
    // (Made from the knights' image, which is in no registry: never pulled, and made first when it's gone. own-images.test.ts)
    expect(OWN_IMAGES[DESKTOP_IMAGE]).toEqual({ context: "desktop", keeper: "galahad-desktop-image", base: "galahad/sandbox:1" });
  });
});
