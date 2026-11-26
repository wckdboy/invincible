import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteName } from "@galahad/core";
import {
  CONTAINER_MAJOR,
  CONTAINER_RELEASE,
  containerImageInspectArgs,
  containerKernel,
  containerSystemStartArgs,
  containerVersionArgs,
  DEFAULT_IMAGE,
  macFirewall,
  macFirewallInstalled,
  type MacFirewallState,
  parseContainerVersion,
} from "@galahad/sandbox";
import { type AsRoot, shellQuote, systemAsRoot } from "./as-root.ts";

/*
 * `galahad sandbox setup`: what a Mac's knights' VMs need, given to it (docs/MAC.md, *Give its knights VMs*), as the
 * app's step 3 and This Mac give it, and as you would in Terminal:
 *
 *   container  Apple's container: its signed installer at the release this driver was checked against, fetched from
 *              its releases on GitHub, checked against the SHA-256 pinned for it (CONTAINER_RELEASE), and installed
 *   firewall   the sandbox firewall (mac-firewall.ts), this release's
 *   service    container's service, and its kernel (fetched by container, which checks its digest)
 *   node       the node restarted when it doesn't host VMs yet: it finds container as it starts
 *   image      the sandbox image, built by the node
 *   vm         a VM made through the firewall, a command run in it, and the VM removed: the proof
 *
 * What holds already is left as it is, so setting it up again changes nothing that is right. What only root may do
 * (the first two) is asked for once, together (as-root.ts). `galahad sandbox setup status` changes nothing: it says
 * what holds and what doesn't. Each step is said as it goes, in words, or (`--json`) as one line of JSON, which the
 * app reads.
 */

export const SETUP_STEPS = ["container", "firewall", "service", "node", "image", "vm"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
/** done: it holds; todo: it doesn't yet (what status says); working: being done now; failed: it couldn't be, and why; skipped: not now, and why. */
export const SETUP_STATES = ["done", "todo", "working", "failed", "skipped"] as const;
export type SetupState = (typeof SETUP_STATES)[number];

export interface SetupLine {
  step: SetupStep;
  state: SetupState;
  said: string;
}

export const SETUP_TITLES: Record<SetupStep, string> = {
  container: "Apple's container",
  firewall: "The sandbox firewall",
  service: "Its service and kernel",
  node: "The node",
  image: "The sandbox image",
  vm: "A VM",
};

/** This Mac's node, spoken to as its owner (the CLI's admin client). */
export interface SetupNode {
  name: string;
  call<T = any>(route: RouteName, input?: unknown): Promise<T>;
}

export interface SetupDeps {
  platform: string;
  arch: string;
  /** macOS's version (27 for macOS 27.2.1), or null when it can't be read. */
  macos(): Promise<number | null>;
  /** Your home folder: container keeps its data, its kernel among it, under it. */
  home: string;
  uid: number;
  run(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  exists(path: string): boolean;
  /** A file's text, or null when there is none (or it can't be read). */
  read(path: string): string | null;
  /** The file at `url` saved to `to`; `progress` is told how many bytes have come as they come. */
  download(url: string, to: string, progress: (bytes: number) => void): Promise<void>;
  sha256(path: string): Promise<string>;
  /** A new folder of this account's alone, for the installer while it is checked; removed after. */
  tempDir(): string;
  removeDir(path: string): void;
  asRoot: AsRoot;
  /** This CLI as a command (Bun, then its file): what root runs `firewall install` with. */
  cli: string[];
  firewall(): Promise<MacFirewallState>;
  /** This Mac's node, or null when this Mac isn't one. */
  node(): SetupNode | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  say(line: SetupLine): void;
}

/** The node's launchd job, where install.sh and the app put it (the app's NodeAgent). */
const NODE_LABEL = "sh.galahad.node";
const MB = (bytes: number) => Math.round(bytes / 1_000_000);

/**
 * What root runs: Apple's installer, copied into a folder of root's alone and checked there again (so nothing can be
 * put in its place between the check and the install), installed, and removed; then the sandbox firewall put in
 * root's places by this CLI as root (`firewall install`).
 */
export function setupRootScript(work: { pkg: string | null; firewall: boolean }, cli: string[]): string {
  const lines = ["set -e"];
  if (work.pkg) {
    lines.push(
      "d=$(/usr/bin/mktemp -d /private/var/tmp/galahad-container.XXXXXX)",
      `trap '/bin/rm -rf "\${d:?}"' EXIT`,
      `/bin/cp ${shellQuote(work.pkg)} "$d/container.pkg"`,
      `[ "$(/usr/bin/shasum -a 256 "$d/container.pkg" | /usr/bin/cut -c1-64)" = ${shellQuote(CONTAINER_RELEASE.sha256)} ] || { echo "The installer isn't the one Apple published for container ${CONTAINER_RELEASE.version}: not installed." >&2; exit 3; }`,
      `/usr/sbin/installer -pkg "$d/container.pkg" -target /`,
    );
  }
  if (work.firewall) lines.push(`${cli.map(shellQuote).join(" ")} firewall install`);
  return lines.join("\n");
}

/** The last thing a command said (why it failed, as it put it), or how it ended. */
const lastLine = (output: string, code: number) =>
  output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/^\d+:\d+: execution error: /, "")
    .slice(0, 300) ?? `it ended with ${code}`;

/** Runs `galahad sandbox setup [status]` (`check`: status, changing nothing): 0 when every step holds; 1 when one doesn't, or failed (each line says why). */
export async function sandboxSetup(deps: SetupDeps, opts: { check?: boolean } = {}): Promise<number> {
  const check = !!opts.check;
  const states = new Map<SetupStep, SetupState>();
  const say = (step: SetupStep, state: SetupState, said: string) => {
    states.set(step, state);
    deps.say({ step, state, said });
  };
  const done = () => (SETUP_STEPS.every((step) => states.get(step) === "done") ? 0 : 1);
  /** Every step not said yet, said as waiting for `why`. */
  const rest = (why: string) => {
    for (const step of SETUP_STEPS) if (!states.has(step)) say(step, "skipped", why);
    return done();
  };
  const after = (step: SetupStep) => rest(`waits for ${SETUP_TITLES[step].replace(/^(The|Its|A) /, (word) => word.toLowerCase())}`);

  if (deps.platform !== "darwin") return rest("on Linux a node's sandboxes are Docker's, and its VMs Kata's: install.sh and deploy.sh set them up");
  const macos = await deps.macos();
  if (deps.arch !== "arm64" || (macos !== null && macos < 26))
    return rest("Apple's container needs Apple silicon and macOS 26 or later: on this Mac a node's sandboxes are Docker Desktop's, OrbStack's or Colima's");

  // Apple's container, and the firewall: what root must do is asked for once, for both.
  const bin = CONTAINER_RELEASE.command;
  const version = async () => (deps.exists(bin) ? parseContainerVersion((await deps.run([bin, ...containerVersionArgs()], 15_000)).stdout) : null);
  let found = await version();
  if (found && found.major !== CONTAINER_MAJOR) {
    say("container", "failed", `${found.version} is installed, and this node speaks ${CONTAINER_MAJOR}.x of it, so it makes no VMs with it`);
    return after("container");
  }
  const wall = await deps.firewall();
  const there = macFirewallInstalled(deps.read);
  const wallHolds = there === "current" && (wall.on || wall.soon);
  const wallWords = (state: MacFirewallState) =>
    state.on
      ? "on: a gateway sandbox reaches the gateway alone, an online one its resolver and the internet, and no sandbox another"
      : "installed: it is on once the node's networks are up";

  if (check) {
    if (found) say("container", "done", `${found.version} is installed`);
    else say("container", "todo", `not installed: Apple's signed installer (${CONTAINER_RELEASE.version}, ${MB(CONTAINER_RELEASE.bytes)} MB) is fetched from its releases on GitHub, checked against the one Apple published, and installed`);
    if (wallHolds) say("firewall", "done", wallWords(wall));
    else if (there === "none") say("firewall", "todo", "not installed: it keeps each sandbox here from this Mac, your network and the other sandboxes");
    else if (there === "other") say("firewall", "todo", "another release's is installed: this release's is put in its place");
    else say("firewall", "todo", `installed, and off (${wall.on ? "" : wall.why}): it is installed again`);
  } else {
    let pkg: string | null = null;
    let folder: string | null = null;
    try {
      if (found) say("container", "done", `${found.version} is installed`);
      else {
        folder = deps.tempDir();
        pkg = join(folder, `container-${CONTAINER_RELEASE.version}-installer-signed.pkg`);
        say("container", "working", `fetching Apple's signed installer (${CONTAINER_RELEASE.version}, ${MB(CONTAINER_RELEASE.bytes)} MB)…`);
        let told = 0;
        try {
          await deps.download(CONTAINER_RELEASE.url, pkg, (bytes) => {
            // Said each fifth of the way, not each chunk.
            const fifth = Math.floor((bytes / CONTAINER_RELEASE.bytes) * 5);
            if (fifth > told && fifth < 5) {
              told = fifth;
              say("container", "working", `fetching Apple's signed installer: ${MB(bytes)} of ${MB(CONTAINER_RELEASE.bytes)} MB…`);
            }
          });
        } catch (error) {
          say("container", "failed", `Apple's installer couldn't be fetched: ${(error as Error).message}`);
          return after("container");
        }
        if ((await deps.sha256(pkg)) !== CONTAINER_RELEASE.sha256) {
          say("container", "failed", `what was fetched isn't the installer Apple published for ${CONTAINER_RELEASE.version} (its SHA-256 differs), so it isn't installed`);
          return after("container");
        }
      }
      if (!found || !wallHolds) {
        const both = !found && !wallHolds;
        const why = `Galahad needs your password to install ${both ? "Apple's container and the sandbox firewall" : !found ? "Apple's container" : "the sandbox firewall"}, for its knights' VMs.`;
        if (!found) say("container", "working", "checked: it is the installer Apple published. Installing it (macOS asks for your password)…");
        if (!wallHolds) say("firewall", "working", "installing it (macOS asks for your password)…");
        const ran = await deps.asRoot(setupRootScript({ pkg, firewall: !wallHolds }, deps.cli), why);
        const failure = ran.code === 0 ? null : ran.cancelled ? "the password wasn't given" : lastLine(ran.output, ran.code);
        if (!found) {
          found = await version();
          if (!found) {
            say("container", "failed", `not installed: ${failure ?? "the installer ended, and container isn't there"}`);
            return after("container");
          }
          say("container", "done", `${found.version} is installed`);
        }
        if (!wallHolds) {
          const now = await deps.firewall();
          if (failure || macFirewallInstalled(deps.read) !== "current" || !(now.on || now.soon)) {
            say("firewall", "failed", `not installed: ${failure ?? (now.on ? "its files aren't this release's" : now.why)}`);
            return after("firewall");
          }
          say("firewall", "done", wallWords(now));
        }
      }
      if (wallHolds) say("firewall", "done", wallWords(wall));
    } finally {
      if (folder) deps.removeDir(folder);
    }
  }

  // Its service, and its kernel.
  const kernel = () => deps.exists(containerKernel(deps.home));
  if (found?.running && kernel()) say("service", "done", "running, with its kernel");
  else if (check || !found) say("service", "todo", `${found?.running ? "running, with no kernel yet" : "not running"}: it is started${kernel() ? "" : ", and container fetches its recommended Linux kernel, once"}`);
  else {
    say("service", "working", `starting it${kernel() ? "" : ", and fetching its kernel (the first time only)"}…`);
    const started = await deps.run([bin, ...containerSystemStartArgs(true)], 15 * 60_000);
    found = await version();
    if (!found?.running) say("service", "failed", `it wouldn't start: ${lastLine(`${started.stdout}\n${started.stderr}`, started.code)}`);
    else if (!kernel()) say("service", "failed", "it runs, with no kernel: container system kernel set --recommended fetches it");
    else say("service", "done", "running, with its kernel");
  }
  if (!check && states.get("service") !== "done") return after("service");

  // The node: it finds container as it starts, so one that started before container did is restarted.
  const node = deps.node();
  if (!node) {
    say("node", "skipped", "this Mac isn't a node yet: make it one (in the app, or with galahad init or galahad join), then set this up again");
    return rest("not done: this Mac isn't a node yet");
  }
  const hosts = async () => {
    const fleet = await node.call<{ self: string; devices: { id: string; caps: { sandbox?: { engine?: string } | null } | null }[] }>("fleet");
    return fleet.devices.find((d) => d.id === fleet.self)?.caps?.sandbox?.engine === "container";
  };
  let hosting: boolean;
  try {
    hosting = await hosts();
  } catch {
    say("node", "failed", "it isn't running: start it, then set this up again");
    return after("node");
  }
  if (hosting) say("node", "done", "it hosts knights' VMs");
  else if (check) say("node", "todo", "it doesn't host VMs yet: it is restarted, and finds container as it starts");
  else {
    say("node", "working", "restarting it, so it finds container…");
    const kicked = await deps.run(["/bin/launchctl", "kickstart", "-k", `gui/${deps.uid}/${NODE_LABEL}`], 30_000);
    if (kicked.code !== 0) {
      say("node", "failed", `launchd doesn't run it (${NODE_LABEL}), so it isn't restarted from here: restart it, then set this up again`);
      return after("node");
    }
    const until = deps.now() + 120_000;
    while (!hosting && deps.now() < until) {
      await deps.sleep(1_000);
      hosting = await hosts().catch(() => false);
    }
    if (!hosting) {
      say("node", "failed", "it restarted, and doesn't host VMs: its log says why (galahad doctor too)");
      return after("node");
    }
    say("node", "done", "it hosts knights' VMs");
  }

  // The sandbox image, built by the node.
  const built = async () => found?.running === true && (await deps.run([bin, ...containerImageInspectArgs(DEFAULT_IMAGE)], 15_000)).code === 0;
  if (await built()) say("image", "done", "built");
  else if (check) say("image", "todo", "not built yet: the node builds it (a few minutes, the first time)");
  else {
    say("image", "working", "building it (a few minutes, the first time)…");
    try {
      await node.call("buildSandboxImage", {});
    } catch (error) {
      say("image", "failed", `the build failed: ${(error as Error).message.slice(0, 300)}`);
      return after("image");
    }
    if (!(await built())) {
      say("image", "failed", "the build ended, and the image isn't there: galahad sandbox build says why");
      return after("image");
    }
    say("image", "done", "built");
  }

  // The proof: a VM, made through the firewall, a command run in it, and the VM removed.
  if (check) {
    const now = await deps.firewall();
    if (now.on && states.get("node") === "done" && states.get("image") === "done") say("vm", "done", "VMs start here, through the firewall");
    else say("vm", "todo", "not tried yet: one is made through the firewall, a command run in it, and it is removed");
    return done();
  }
  say("vm", "working", "making one through the firewall…");
  const started = deps.now();
  try {
    const { sandbox } = await node.call<{ sandbox: { id: string } }>("createSandbox", { network: "gateway", cpus: 1, memoryGb: 1, ttlMinutes: 10, on: node.name });
    try {
      const ran = await node.call<{ exitCode: number; stderr: string }>("execSandbox", { id: sandbox.id, cmd: ["true"], on: node.name });
      if (ran.exitCode !== 0) throw new Error(`a command in it ended with ${ran.exitCode}: ${ran.stderr.trim().slice(0, 200)}`);
    } finally {
      await node.call("destroySandbox", { id: sandbox.id, on: node.name }).catch(() => {});
    }
  } catch (error) {
    say("vm", "failed", (error as Error).message.slice(0, 300));
    return done();
  }
  say("vm", "done", `one was made through the firewall, ran a command, and was removed, in ${Math.max(1, Math.round((deps.now() - started) / 1000))} s`);
  return done();
}

/** A line as a terminal shows it. */
export const setupWords = (line: SetupLine): string => `  ${line.state.padEnd(8)} ${SETUP_TITLES[line.step]}: ${line.said}`;

/** This Mac, as `galahad sandbox setup` finds it and changes it. */
export function systemSetupDeps(over: { node(): SetupNode | null; say(line: SetupLine): void }): SetupDeps {
  const run: SetupDeps["run"] = async (argv, timeoutMs) => {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  return {
    platform: process.platform,
    arch: process.arch,
    async macos() {
      const ran = await run(["/usr/bin/sw_vers", "-productVersion"], 10_000).catch(() => null);
      const major = Number.parseInt(ran?.stdout.trim() ?? "", 10);
      return Number.isInteger(major) ? major : null;
    },
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    run,
    exists: existsSync,
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    async download(url, to, progress) {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`);
      const file = Bun.file(to).writer();
      let bytes = 0;
      for await (const chunk of response.body) {
        file.write(chunk);
        bytes += chunk.byteLength;
        progress(bytes);
      }
      await file.end();
    },
    async sha256(path) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest("hex");
    },
    tempDir: () => mkdtempSync(join(tmpdir(), "galahad-setup-")),
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    asRoot: systemAsRoot(),
    cli: [process.execPath, process.argv[1]!],
    firewall: () => macFirewall(),
    node: over.node,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    say: over.say,
  };
}
