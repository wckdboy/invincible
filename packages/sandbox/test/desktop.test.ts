import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESKTOP_IMAGE, OWN_IMAGES } from "../src/index.ts";
import { spawned } from "../../../bench/spawned.ts";

/*
 * The agents' desktop image: a display, a window manager, a browser, a terminal and an editor in an agent's own VM,
 * one process that holds them (deskd) and one command that is its client (`desktop`). What the command does is held in
 * deskd.test.ts; here, what the image is made of, and how deskd starts the browser.
 */

const context = new URL("../../../sandbox/desktop/", import.meta.url);
const dockerfile = readFileSync(new URL("Dockerfile", context), "utf8");

describe("the desktop image", () => {
  test("is the agents' image with a display, a window manager, a browser, a terminal, an editor and the tools that operate them, and ends as the agent", () => {
    expect(dockerfile).toMatch(/^FROM invincible\/sandbox:1$/m);
    const installed = dockerfile.replace(/\\\n/g, " ");
    // C0 (26 November 2026) found no terminal and no editor on it: the terminal and editor tasks couldn't be done.
    for (const pkg of ["xvfb", "openbox", "chromium", "x11-utils", "python3-websocket", "fonts-noto-cjk", "xterm", "mousepad", "xclip", "at-spi2-core", "python3-pyatspi", "python3-xlib", "libturbojpeg0"]) expect(installed).toMatch(new RegExp(`apt-get install[^\\n]* ${pkg}( |$)`, "m"));
    // Text is UTF-8 in the image's own environment: a raw exec there stopped at the first letter that isn't ASCII.
    expect(dockerfile).toMatch(/^ENV LANG=C\.UTF-8$/m);
    // Every app shows its accessibility tree, whoever starts it (deskd, or the agent from its shell).
    expect(dockerfile).toMatch(/^ENV ACCESSIBILITY_ENABLED=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1$/m);
    // Nothing animates for show: GTK's switch, for GTK 3 and 4, which the browser's own interface follows.
    for (const v of ["3.0", "4.0"]) expect(dockerfile).toContain(`COPY seed/gtk-settings.ini /etc/xdg/gtk-${v}/settings.ini`);
    expect(readFileSync(fileURLToPath(new URL("seed/gtk-settings.ini", context)), "utf8")).toMatch(/^\[Settings\]\ngtk-enable-animations=false$/m);
    // No app's first-run or restore question: the seed is installed, compiled, and checked as the image is built.
    expect(dockerfile).toContain("COPY seed/90_invincible-desktop.gschema.override /usr/share/glib-2.0/schemas/\n");
    expect(dockerfile).toContain('"$(ls /usr/lib/*/glib-2.0/glib-compile-schemas)" /usr/share/glib-2.0/schemas');
    expect(dockerfile).toMatch(/get_string\('session-restore'\); assert v == 'never'/);
    expect(readFileSync(new URL("seed/90_invincible-desktop.gschema.override", context), "utf8")).toMatch(/^\[org\.xfce\.mousepad\.preferences\.file\]\nsession-restore='never'$/m);
    // deskd, and its client built in the image with the workshop's compiler, strictly.
    expect(dockerfile).toContain("COPY deskd.py /usr/local/lib/invincible/deskd.py\n");
    expect(dockerfile).toContain("RUN cc -O2 -Wall -Wextra -Werror -o /usr/local/bin/desktop /tmp/desktop.c && rm /tmp/desktop.c");
    expect(dockerfile).toContain("chmod 0755 /usr/local/bin/desktop && chmod 0644 /usr/local/lib/invincible/deskd.py");
    // Root only to install: the image is left as the agent's user, like the one it is made from.
    expect(dockerfile.trimEnd().split("\n").filter((line) => line.startsWith("USER ")).at(-1)).toBe("USER 1000:1000");
    expect(DESKTOP_IMAGE).toBe("invincible/desktop:1");
    // (Made from the agents' image, which is in no registry: never pulled, and made first when it's gone. own-images.test.ts)
    expect(OWN_IMAGES[DESKTOP_IMAGE]).toEqual({ context: "desktop", keeper: "invincible-desktop-image", base: "invincible/sandbox:1" });
  });

  test("deskd starts the display, the window manager, the buses and the browser: nothing listening outside the VM", async () => {
    // deskd's own Pieces.start, with what it would start written down instead (and found up once asked for).
    const script = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("deskd", sys.argv[1]); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
started = []
p = d.Pieces(home="/work")
p._spawn = lambda argv, log, keep=None: started.append(argv) or 4242
class Ran:
    returncode, stdout, stderr = 0, "unix:path=/tmp/dbus-example,guid=0\\n4321\\n", ""
d.subprocess.run = lambda argv, **kw: started.append(argv) or Ran()
p.display_up = lambda: any(a[0] == "Xvfb" for a in started)
p.browser_up = lambda: any(a[0] == "chromium" for a in started)
p.a11y_bus = lambda: "unix:path=/tmp/at-spi-example" if any(a[0] == d.LAUNCHER for a in started) else ""
d._own = lambda comm: [1] if any(a[0].split("/")[-1][:15] == comm for a in started) else []
d._alive = lambda pid: pid == 4321
import os; os.makedirs = lambda *a, **k: None
p.start(); p.start()
print(json.dumps(started))`;
    const ran = await spawned(["python3", "-c", script, fileURLToPath(new URL("deskd.py", context))], { stdout: "pipe", stderr: "pipe" });
    expect(ran.stderr.toString()).toBe("");
    const started = JSON.parse(ran.stdout.toString()) as string[][];
    // Once: a second start finds them running.
    expect(started.map((argv) => argv[0])).toEqual(["Xvfb", "openbox", "dbus-daemon", "/usr/libexec/at-spi-bus-launcher", "chromium"]);
    // (Never reset when its last client leaves: deskd's own "is it up?" was one, and a start that came during the reset
    // found no display, one boot in about 35 on Ultra.)
    expect(started[0]).toEqual(["Xvfb", ":1", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-noreset"]);
    // The session bus on its own default (a socket in the VM, no address of ours to listen on): the accessibility
    // bus is AT-SPI's launcher's, on the same.
    expect(started[2]).toEqual(["dbus-daemon", "--session", "--fork", "--print-address=1", "--print-pid=1"]);
    expect(started[3]).toEqual(["/usr/libexec/at-spi-bus-launcher", "--launch-immediately"]);
    // The browser: its profile on the workspace (a sign-in there stays with the agent's disk), its own inner sandbox
    // off (the VM forbids it), its debugging port on loopback alone, and its accessibility tree on.
    for (const flag of ["--user-data-dir=/work/.config/chromium", "--no-sandbox", "--hide-crash-restore-bubble", "--no-first-run", "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1", "--window-size=1280,800", "--force-renderer-accessibility"]) expect(started[4]).toContain(flag);
    // And started light, for its first page on one CPU (C1, measured on Ultra).
    for (const flag of ["--in-process-gpu", "--disable-features=SpareRendererForSitePerProcess", "--password-store=basic"]) expect(started[4]).toContain(flag);
  });
});
