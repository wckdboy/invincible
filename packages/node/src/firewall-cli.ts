import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAC_FIREWALL, macFirewall, macFirewallHelper, macFirewallPlist, macFirewallRules, type MacFirewallState } from "@galahad/sandbox";

/*
 * `galahad firewall`: the Mac's sandbox firewall (packages/sandbox/src/mac-firewall.ts), as galahad-firewall is
 * Ultra's. `status` says whether it is on, and why not; `rules`, what it lets through; `install` puts its helper and
 * launchd job in root's places and starts them; `remove` takes them away. Those two are root's to do: run as anyone
 * else, they ask sudo for your password and run again as root. Nothing is written where anyone but root could write.
 */

export interface FirewallDeps {
  platform: string;
  uid: number;
  run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** This command again as root, through sudo (its password asked on this terminal): its exit code. */
  asRoot(): Promise<number>;
  /** A directory as it is (who owns it, its mode), or null when it isn't there. */
  dir(path: string): { uid: number; mode: number } | null;
  mkdir(path: string, mode: number): void;
  /** A file put in place: written beside it, made root's with its mode, then renamed over it. */
  place(path: string, text: string, mode: number): void;
  remove(path: string): void;
  state(): Promise<MacFirewallState>;
  sleep(ms: number): Promise<void>;
  print(line: string): void;
}

export const systemFirewallDeps = (): FirewallDeps => ({
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  async run(argv) {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  },
  async asRoot() {
    return Bun.spawn(["sudo", process.execPath, ...process.argv.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  },
  dir(path) {
    try {
      const found = lstatSync(path);
      return found.isDirectory() ? { uid: found.uid, mode: found.mode } : null;
    } catch {
      return null;
    }
  },
  mkdir: (path, mode) => {
    mkdirSync(path, { mode });
    chownSync(path, 0, 0);
    chmodSync(path, mode);
  },
  place(path, text, mode) {
    const beside = `${path}.galahad-${process.pid}`;
    writeFileSync(beside, text, { mode, flag: "wx" });
    chownSync(beside, 0, 0);
    chmodSync(beside, mode);
    renameSync(beside, path);
  },
  remove: (path) => {
    if (existsSync(path)) rmSync(path);
  },
  state: () => macFirewall(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  print: (line) => console.log(line),
});

const USAGE = "usage: galahad firewall [status|rules|install|remove]";

/** Runs `galahad firewall <sub>`: its exit code (0 on, or done; 1 off, or refused). */
export async function firewallCommand(sub: string | undefined, deps: FirewallDeps): Promise<number> {
  const { print } = deps;
  if (sub === "rules") {
    print(macFirewallRules().trimEnd());
    return 0;
  }
  if (sub && !["status", "install", "remove"].includes(sub)) {
    print(USAGE);
    return 1;
  }
  if (deps.platform !== "darwin") {
    print("The Mac's sandbox firewall is a Mac's: on Linux, galahad-firewall holds sandboxes to the gateway (a deploy with --sudo installs it).");
    return sub && sub !== "status" ? 1 : 0;
  }
  if (!sub || sub === "status") return status(deps);
  if (deps.uid !== 0) return deps.asRoot();
  return sub === "install" ? install(deps) : remove(deps);
}

async function status(deps: FirewallDeps): Promise<number> {
  const state = await deps.state();
  if (state.on) deps.print("On: a gateway sandbox reaches the gateway alone; an online one, its resolver and the internet, never this Mac or your networks; no sandbox reaches another.");
  else deps.print(`Off: ${state.why}${state.soon ? ` (it turns on by itself once the node's networks are up: its helper runs every ${MAC_FIREWALL.every} s)` : ""}`);
  return state.on ? 0 : 1;
}

/** Root's alone: owned by root, and no one else may write in it. */
function rootsAlone(deps: FirewallDeps, path: string): string | null {
  const found = deps.dir(path);
  if (!found) return `${path} isn't there`;
  return found.uid === 0 && (found.mode & 0o022) === 0 ? null : `${path} isn't root's alone, so what is put there can't be trusted`;
}

async function install(deps: FirewallDeps): Promise<number> {
  const helpers = dirname(MAC_FIREWALL.helper);
  // (macOS makes no /Library/PrivilegedHelperTools until something asks for one: made root's, as it makes it.)
  if (!deps.dir(helpers) && !rootsAlone(deps, dirname(helpers))) deps.mkdir(helpers, 0o755);
  for (const path of [dirname(helpers), helpers, dirname(MAC_FIREWALL.plist)]) {
    const why = rootsAlone(deps, path);
    if (why) {
      deps.print(`Not installed: ${why}.`);
      return 1;
    }
  }
  deps.place(MAC_FIREWALL.helper, macFirewallHelper(), 0o755);
  deps.place(MAC_FIREWALL.plist, macFirewallPlist(), 0o644);
  await deps.run(["/bin/launchctl", "bootout", `system/${MAC_FIREWALL.label}`]);
  const loaded = await deps.run(["/bin/launchctl", "bootstrap", "system", MAC_FIREWALL.plist]);
  if (loaded.code !== 0) {
    deps.print(`Its files are in place, but launchd wouldn't load it: ${(loaded.stderr.trim() || `exit ${loaded.code}`).slice(0, 300)}`);
    return 1;
  }
  // It runs as it is loaded; what it did is in its status a moment later.
  let state = await deps.state();
  for (let i = 0; i < 10 && !state.on && !state.soon; i++) {
    await deps.sleep(500);
    state = await deps.state();
  }
  if (state.on) deps.print(`Installed and on (${MAC_FIREWALL.label}, every ${MAC_FIREWALL.every} s): sandboxes on this Mac reach what galahad firewall rules shows, and nothing else.`);
  else if (state.soon) deps.print(`Installed (${MAC_FIREWALL.label}, every ${MAC_FIREWALL.every} s). It is on once the node's networks are up, which its node does as it starts: ${state.why}.`);
  else deps.print(`Installed, but it isn't on: ${state.why}.`);
  return state.on || state.soon ? 0 : 1;
}

async function remove(deps: FirewallDeps): Promise<number> {
  await deps.run(["/bin/launchctl", "bootout", `system/${MAC_FIREWALL.label}`]);
  for (const path of [MAC_FIREWALL.plist, MAC_FIREWALL.helper, MAC_FIREWALL.status]) deps.remove(path);
  await deps.run(["/sbin/pfctl", "-a", MAC_FIREWALL.anchor, "-F", "all"]);
  deps.print("Removed: its rules are gone, and no sandbox is made on this Mac until it is installed again. (A bridge keeps pf seeing between its VMs until it next goes, which lets everything through without the rules.)");
  return 0;
}
