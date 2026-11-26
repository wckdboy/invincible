import { describe, expect, test } from "bun:test";
import { CONTAINER_RELEASE, containerKernel, MAC_FIREWALL, macFirewallHelper, macFirewallPlist, type MacFirewallState } from "@invincible/sandbox";
import { cancelledPrompt, promptArgs, shellQuote } from "../src/as-root.ts";
import { sandboxSetup, type SetupDeps, type SetupLine, type SetupNode, setupRootScript, setupWords } from "../src/sandbox-setup.ts";

/*
 * `invincible sandbox setup` (sandbox-setup.ts) on a stand-in Mac: its container, root's places, launchd and the node are
 * all this file's, so nothing here touches the machine it runs on. What setting a Mac up does for real was run on the
 * Mac mini (docs/MAC.md).
 */

const HOME = "/Users/someone";
const CLI = ["/Applications/Galahad.app/Contents/Helpers/bun", "/Applications/Galahad.app/Contents/Resources/node/packages/node/src/cli.ts"];

interface Mac {
  installed?: boolean;
  version?: string;
  running?: boolean;
  kernel?: boolean;
  image?: boolean;
  firewall?: "current" | "other" | "none";
  wall?: MacFirewallState;
  node?: null | { running?: boolean; hosting?: boolean; launchd?: boolean; build?: boolean; vm?: "ok" | "fails" };
  digest?: string;
  download?: "ok" | "fails";
  root?: { code: number; output?: string; cancelled?: boolean };
  platform?: string;
  arch?: string;
  macos?: number | null;
}

function mac(over: Mac = {}) {
  const m = {
    installed: over.installed ?? false,
    version: over.version ?? "1.7.1",
    running: over.running ?? false,
    kernel: over.kernel ?? false,
    image: over.image ?? false,
    firewall: over.firewall ?? "none",
    wall: over.wall ?? ({ on: false, installed: false, soon: false, why: "this Mac's sandbox firewall isn't installed" } as MacFirewallState),
    node: over.node === null ? null : { running: true, hosting: false, launchd: true, build: true, vm: "ok" as const, ...over.node },
  };
  const lines: SetupLine[] = [];
  const ran: string[][] = [];
  const asked: { script: string; why: string }[] = [];
  const calls: { route: string; input: any }[] = [];
  const folders: string[] = [];
  const removed: string[] = [];
  let clock = 1_000_000;
  /** The node's admin routes this file answers, as the node would. */
  const answer = async (route: string, input?: unknown): Promise<any> => {
    calls.push({ route, input });
    if (!m.node!.running) throw new Error("no daemon on http://127.0.0.1:7400 — start it with `invincible serve`");
    if (route === "fleet") return { self: "dev-mini", devices: [{ id: "dev-ultra", caps: { sandbox: {} } }, { id: "dev-mini", caps: m.node!.hosting ? { sandbox: { engine: "container" } } : { sandbox: null } }] };
    if (route === "buildSandboxImage") {
      if (!m.node!.build) throw new Error("container build failed: no space left on device");
      m.image = true;
      return {};
    }
    if (route === "createSandbox") {
      // Made, the keepers bring the bridges up, and the firewall is on.
      m.wall = { on: true };
      return { sandbox: { id: "sbx-proof" } };
    }
    if (route === "execSandbox") return m.node!.vm === "ok" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 127, stdout: "", stderr: "true: not found" };
    if (route === "destroySandbox") return {};
    throw new Error(`no route ${route} in this file`);
  };
  const deps: SetupDeps = {
    platform: over.platform ?? "darwin",
    arch: over.arch ?? "arm64",
    macos: async () => (over.macos === undefined ? 27 : over.macos),
    home: HOME,
    uid: 501,
    run: async (argv) => {
      ran.push(argv);
      if (argv[0] === CONTAINER_RELEASE.command) {
        const args = argv.slice(1).join(" ");
        if (args === "system version --format json") {
          const rows = [{ appName: "container", version: m.version }, ...(m.running ? [{ appName: "container-apiserver", version: m.version }] : [])];
          return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
        }
        if (args.startsWith("system start")) {
          m.running = true;
          if (args.includes("--enable-kernel-install")) m.kernel = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.startsWith("image inspect")) return { code: m.running && m.image ? 0 : 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "/bin/launchctl" && argv[1] === "kickstart") {
        if (!m.node?.launchd) return { code: 113, stdout: "", stderr: "Could not find service" };
        m.node.running = true;
        m.node.hosting = m.running;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "not this file's" };
    },
    exists: (path) => (path === CONTAINER_RELEASE.command ? m.installed : path === containerKernel(HOME) ? m.kernel : false),
    read: (path) => {
      if (m.firewall === "none") return null;
      if (path === MAC_FIREWALL.helper) return m.firewall === "current" ? macFirewallHelper() : "#!/usr/bin/perl\n# an older release's\n";
      if (path === MAC_FIREWALL.plist) return macFirewallPlist();
      return null;
    },
    download: async (url, to, progress) => {
      if (over.download === "fails") throw new Error("GitHub answered 503");
      expect(url).toBe(CONTAINER_RELEASE.url);
      expect(to.startsWith(folders.at(-1)!)).toBe(true);
      for (let got = 0; got < CONTAINER_RELEASE.bytes; got += 1 << 20) progress(Math.min(got + (1 << 20), CONTAINER_RELEASE.bytes));
    },
    sha256: async () => over.digest ?? CONTAINER_RELEASE.sha256,
    tempDir: () => {
      folders.push(`/private/var/folders/xy/T/invincible-setup-${folders.length}`);
      return folders.at(-1)!;
    },
    removeDir: (path) => void removed.push(path),
    asRoot: async (script, why) => {
      asked.push({ script, why });
      const result = over.root ?? { code: 0 };
      if (result.code === 0) {
        if (script.includes("/usr/sbin/installer")) m.installed = true;
        if (script.includes("firewall install")) {
          m.firewall = "current";
          m.wall = { on: false, installed: true, soon: true, why: "no bridge carries the sandbox networks yet" };
        }
      }
      return { code: result.code, output: result.output ?? "", cancelled: !!result.cancelled };
    },
    cli: CLI,
    firewall: async () => m.wall,
    node: () => m.node && { name: "mini", call: answer as SetupNode["call"] },
    sleep: async (ms) => void (clock += ms),
    now: () => (clock += 250),
    say: (line) => void lines.push(line),
  };
  /** The last thing said of each step. */
  const last = () => Object.fromEntries(lines.map((l) => [l.step, l]));
  return { deps, m, lines, ran, asked, calls, folders, removed, last };
}

/** Everything a set-up Mac has. */
const SET_UP: Mac = { installed: true, running: true, kernel: true, image: true, firewall: "current", wall: { on: true }, node: { hosting: true } };

describe("invincible sandbox setup", () => {
  test("a Mac with nothing: each step in order, the password asked for once, and a VM made to be sure", async () => {
    const t = mac();
    expect(await sandboxSetup(t.deps)).toBe(0);
    const last = t.last();
    expect(Object.values(last).map((l) => [l.step, l.state])).toEqual([
      ["container", "done"],
      ["firewall", "done"],
      ["service", "done"],
      ["node", "done"],
      ["image", "done"],
      ["vm", "done"],
    ]);
    expect(last.container!.said).toBe("1.7.1 is installed");
    // Once, for both, naming both: through sudo or macOS's own prompt, never Galahad's.
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.why).toBe("Galahad needs your password to install Apple's container and the sandbox firewall, for its knights' VMs.");
    expect(t.asked[0]!.script).toBe(setupRootScript({ pkg: `${t.folders[0]}/container-1.7.1-installer-signed.pkg`, firewall: true }, CLI));
    // Fetched into a folder of its own, removed after.
    expect(t.removed).toEqual(t.folders);
    // Its service started with its kernel; the node restarted by launchd; the image built by the node; then the proof.
    expect(t.ran.filter((a) => a[1] === "system" && a[2] === "start")).toEqual([[CONTAINER_RELEASE.command, "system", "start", "--enable-kernel-install", "--timeout", "60"]]);
    expect(t.ran.filter((a) => a[0] === "/bin/launchctl")).toEqual([["/bin/launchctl", "kickstart", "-k", "gui/501/sh.invincible.node"]]);
    expect(t.calls.map((c) => c.route).filter((r) => r !== "fleet")).toEqual(["buildSandboxImage", "createSandbox", "execSandbox", "destroySandbox"]);
    expect(t.calls.find((c) => c.route === "createSandbox")!.input).toEqual({ network: "gateway", cpus: 1, memoryGb: 1, ttlMinutes: 10, on: "mini" });
    expect(last.vm!.said).toMatch(/^one was made through the firewall, ran a command, and was removed, in \d+ s$/);
  });

  test("the fetch is said a fifth of the way at a time, never each chunk", async () => {
    const t = mac();
    await sandboxSetup(t.deps);
    const fetching = t.lines.filter((l) => l.step === "container" && l.state === "working").map((l) => l.said);
    expect(fetching[0]).toBe("fetching Apple's signed installer (1.7.1, 170 MB)…");
    // (Said at the first chunk past each fifth: this file's chunks are a MiB each.)
    expect(fetching.slice(1, -1)).toEqual(["fetching Apple's signed installer: 35 of 170 MB…", "fetching Apple's signed installer: 68 of 170 MB…", "fetching Apple's signed installer: 103 of 170 MB…", "fetching Apple's signed installer: 136 of 170 MB…"]);
    expect(fetching.at(-1)).toBe("checked: it is the installer Apple published. Installing it (macOS asks for your password)…");
  });

  test("a Mac that has it all: status says so, and setting it up again changes nothing but making the proof's VM", async () => {
    const status = mac(SET_UP);
    expect(await sandboxSetup(status.deps, { check: true })).toBe(0);
    expect(status.lines.map((l) => [l.step, l.state, l.said])).toEqual([
      ["container", "done", "1.7.1 is installed"],
      ["firewall", "done", "on: a gateway sandbox reaches the gateway alone, an online one its resolver and the internet, and no sandbox another"],
      ["service", "done", "running, with its kernel"],
      ["node", "done", "it hosts knights' VMs"],
      ["image", "done", "built"],
      ["vm", "done", "VMs start here, through the firewall"],
    ]);
    expect(status.asked).toEqual([]);
    expect(status.calls.map((c) => c.route)).toEqual(["fleet"]);

    const again = mac(SET_UP);
    expect(await sandboxSetup(again.deps)).toBe(0);
    expect(again.asked).toEqual([]);
    expect(again.folders).toEqual([]);
    expect(again.ran.some((a) => a[2] === "start" || a[0] === "/bin/launchctl")).toBe(false);
    expect(again.calls.map((c) => c.route).filter((r) => r !== "fleet")).toEqual(["createSandbox", "execSandbox", "destroySandbox"]);
  });

  test("status on a Mac with nothing: what each step would do, and nothing done", async () => {
    const t = mac();
    expect(await sandboxSetup(t.deps, { check: true })).toBe(1);
    expect(t.lines.map((l) => [l.step, l.state])).toEqual([
      ["container", "todo"],
      ["firewall", "todo"],
      ["service", "todo"],
      ["node", "todo"],
      ["image", "todo"],
      ["vm", "todo"],
    ]);
    expect(t.last().container!.said).toBe("not installed: Apple's signed installer (1.7.1, 170 MB) is fetched from its releases on GitHub, checked against the one Apple published, and installed");
    expect(t.last().firewall!.said).toBe("not installed: it keeps each sandbox here from this Mac, your network and the other sandboxes");
    expect(t.last().service!.said).toBe("not running: it is started, and container fetches its recommended Linux kernel, once");
    expect([t.asked, t.folders, t.ran.filter((a) => a[0] === "/bin/launchctl" || a[2] === "start")]).toEqual([[], [], []]);
  });

  test("an installer that isn't the one Apple published is never installed", async () => {
    const t = mac({ digest: "0".repeat(64) });
    expect(await sandboxSetup(t.deps)).toBe(1);
    expect(t.last().container).toEqual({ step: "container", state: "failed", said: "what was fetched isn't the installer Apple published for 1.7.1 (its SHA-256 differs), so it isn't installed" });
    expect(t.asked).toEqual([]);
    expect(t.removed).toEqual(t.folders);
    expect(t.lines.filter((l) => l.state === "skipped").map((l) => [l.step, l.said])).toEqual([
      ["firewall", "waits for Apple's container"],
      ["service", "waits for Apple's container"],
      ["node", "waits for Apple's container"],
      ["image", "waits for Apple's container"],
      ["vm", "waits for Apple's container"],
    ]);
  });

  test("an installer that couldn't be fetched says why, and asks for nothing", async () => {
    const t = mac({ download: "fails" });
    expect(await sandboxSetup(t.deps)).toBe(1);
    expect(t.last().container!.said).toBe("Apple's installer couldn't be fetched: GitHub answered 503");
    expect([t.asked, t.removed]).toEqual([[], t.folders]);
  });

  test("the password not given: nothing is installed, and it says so", async () => {
    const t = mac({ root: { code: 1, output: "0:181: execution error: User canceled. (-128)", cancelled: true } });
    expect(await sandboxSetup(t.deps)).toBe(1);
    expect(t.last().container).toEqual({ step: "container", state: "failed", said: "not installed: the password wasn't given" });
    expect(t.removed).toEqual(t.folders);
    expect(t.last().service!.state).toBe("skipped");
  });

  test("root's work failing says what it said", async () => {
    const t = mac({ installed: true, running: true, kernel: true, root: { code: 1, output: "Not installed: /Library/LaunchDaemons isn't root's alone, so what is put there can't be trusted." } });
    expect(await sandboxSetup(t.deps)).toBe(1);
    expect(t.last().firewall).toEqual({ step: "firewall", state: "failed", said: "not installed: Not installed: /Library/LaunchDaemons isn't root's alone, so what is put there can't be trusted." });
  });

  test("container there and the firewall not: the password is asked for the firewall alone, and nothing is fetched", async () => {
    const t = mac({ installed: true, running: true, kernel: true, image: true, node: { hosting: true } });
    expect(await sandboxSetup(t.deps)).toBe(0);
    expect(t.folders).toEqual([]);
    expect(t.asked).toEqual([{ script: setupRootScript({ pkg: null, firewall: true }, CLI), why: "Galahad needs your password to install the sandbox firewall, for its knights' VMs." }]);
    expect(t.asked[0]!.script).not.toContain("installer");
    expect(t.last().firewall!.said).toBe("installed: it is on once the node's networks are up");
  });

  test("another release's firewall is put back as this release's", async () => {
    const status = mac({ ...SET_UP, firewall: "other" });
    expect(await sandboxSetup(status.deps, { check: true })).toBe(1);
    expect(status.last().firewall).toEqual({ step: "firewall", state: "todo", said: "another release's is installed: this release's is put in its place" });
    const t = mac({ ...SET_UP, firewall: "other" });
    expect(await sandboxSetup(t.deps)).toBe(0);
    expect(t.asked.map((a) => a.script)).toEqual([setupRootScript({ pkg: null, firewall: true }, CLI)]);
  });

  test("a firewall installed and off is installed again", async () => {
    const t = mac({ ...SET_UP, wall: { on: false, installed: true, soon: false, why: "pf is off" } });
    expect(await sandboxSetup(t.deps, { check: true })).toBe(1);
    expect(t.last().firewall!.said).toBe("installed, and off (pf is off): it is installed again");
  });

  test("a Mac that isn't a node yet: container, the firewall and its service, then it says what to do", async () => {
    const t = mac({ node: null });
    expect(await sandboxSetup(t.deps)).toBe(1);
    expect(t.lines.filter((l) => l.state !== "working").map((l) => [l.step, l.state])).toEqual([
      ["container", "done"],
      ["firewall", "done"],
      ["service", "done"],
      ["node", "skipped"],
      ["image", "skipped"],
      ["vm", "skipped"],
    ]);
    expect(t.last().node!.said).toBe("this Mac isn't a node yet: make it one (in the app, or with invincible init or invincible join), then set this up again");
  });

  test("a node that isn't running, or that launchd doesn't run, is said so, not started", async () => {
    const down = mac({ ...SET_UP, node: { running: false } });
    expect(await sandboxSetup(down.deps)).toBe(1);
    expect(down.last().node).toEqual({ step: "node", state: "failed", said: "it isn't running: start it, then set this up again" });
    const byHand = mac({ ...SET_UP, node: { hosting: false, launchd: false } });
    expect(await sandboxSetup(byHand.deps)).toBe(1);
    expect(byHand.last().node!.said).toBe("launchd doesn't run it (sh.invincible.node), so it isn't restarted from here: restart it, then set this up again");
    expect(byHand.last().image).toEqual({ step: "image", state: "skipped", said: "waits for the node" });
  });

  test("a build that fails, and a VM that won't run, say why; the VM is removed either way", async () => {
    const build = mac({ ...SET_UP, image: false, node: { hosting: true, build: false } });
    expect(await sandboxSetup(build.deps)).toBe(1);
    expect(build.last().image!.said).toBe("the build failed: container build failed: no space left on device");
    expect(build.last().vm!.said).toBe("waits for the sandbox image");
    const vm = mac({ ...SET_UP, node: { hosting: true, vm: "fails" } });
    expect(await sandboxSetup(vm.deps)).toBe(1);
    expect(vm.last().vm).toEqual({ step: "vm", state: "failed", said: "a command in it ended with 127: true: not found" });
    expect(vm.calls.map((c) => c.route)).toContain("destroySandbox");
  });

  test("a container this node doesn't speak is said so, and left as it is", async () => {
    const t = mac({ ...SET_UP, version: "2.0.0" });
    expect(await sandboxSetup(t.deps)).toBe(1);
    expect(t.last().container).toEqual({ step: "container", state: "failed", said: "2.0.0 is installed, and this node speaks 1.x of it, so it makes no VMs with it" });
    expect(t.asked).toEqual([]);
  });

  test("off a Mac of Apple silicon and macOS 26 or later, every step says why it isn't this machine's", async () => {
    for (const [over, why] of [
      [{ platform: "linux" }, "on Linux a node's sandboxes are Docker's, and its VMs Kata's: install.sh and deploy.sh set them up"],
      [{ arch: "x64" }, "Apple's container needs Apple silicon and macOS 26 or later: on this Mac a node's sandboxes are Docker Desktop's, OrbStack's or Colima's"],
      [{ macos: 15 }, "Apple's container needs Apple silicon and macOS 26 or later: on this Mac a node's sandboxes are Docker Desktop's, OrbStack's or Colima's"],
    ] as [Mac, string][]) {
      const t = mac(over);
      expect(await sandboxSetup(t.deps)).toBe(1);
      expect(t.lines.map((l) => [l.state, l.said])).toEqual(Array(6).fill(["skipped", why]));
      expect([t.asked, t.ran]).toEqual([[], []]);
    }
  });
});

describe("what it says", () => {
  test("a line in words for a terminal, and in JSON for the app, which knows each step and state it says", () => {
    const line: SetupLine = { step: "firewall", state: "working", said: "installing it (macOS asks for your password)…" };
    expect(setupWords(line)).toBe("  working  The sandbox firewall: installing it (macOS asks for your password)…");
    expect(JSON.stringify(line)).toBe('{"step":"firewall","state":"working","said":"installing it (macOS asks for your password)…"}');
    // The Mac app reads these lines and drops a step or state it doesn't know; its check against SETUP_STEPS and
    // SETUP_STATES comes back with the Mac app (a later phase).
  });
});

describe("what root runs", () => {
  test("Apple's installer, copied where only root can write, checked there against the pinned digest, installed, removed", () => {
    const script = setupRootScript({ pkg: "/private/var/folders/xy/T/invincible-setup-1/container.pkg", firewall: true }, CLI);
    expect(script.split("\n")).toEqual([
      "set -e",
      "d=$(/usr/bin/mktemp -d /private/var/tmp/invincible-container.XXXXXX)",
      `trap '/bin/rm -rf "\${d:?}"' EXIT`,
      `/bin/cp '/private/var/folders/xy/T/invincible-setup-1/container.pkg' "$d/container.pkg"`,
      `[ "$(/usr/bin/shasum -a 256 "$d/container.pkg" | /usr/bin/cut -c1-64)" = '${CONTAINER_RELEASE.sha256}' ] || { echo "The installer isn't the one Apple published for container 1.7.1: not installed." >&2; exit 3; }`,
      `/usr/sbin/installer -pkg "$d/container.pkg" -target /`,
      `'${CLI[0]}' '${CLI[1]}' firewall install`,
    ]);
  });

  test("a path is a word to the shell, whatever is in it", () => {
    expect(shellQuote("/Users/o'brien/Applications/Galahad.app")).toBe(`'/Users/o'\\''brien/Applications/Galahad.app'`);
    expect(setupRootScript({ pkg: null, firewall: true }, ["/a b/bun", "/c$d/cli.ts"])).toBe("set -e\n'/a b/bun' '/c$d/cli.ts' firewall install");
  });

  test("macOS's prompt is given the script and why as arguments, never as AppleScript's source", () => {
    const args = promptArgs(`echo "it's"; id -u`, "Galahad needs your password.");
    expect(args.slice(0, 7)).toEqual(["/usr/bin/osascript", "-e", "on run argv", "-e", "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings", "-e", "end run"]);
    expect(args.slice(7)).toEqual([`echo "it's"; id -u`, "Galahad needs your password."]);
    expect(cancelledPrompt("0:181: execution error: User canceled. (-128)\n")).toBe(true);
    expect(cancelledPrompt("0:181: execution error: The administrator user name or password was incorrect. (-60007)")).toBe(false);
  });
});
