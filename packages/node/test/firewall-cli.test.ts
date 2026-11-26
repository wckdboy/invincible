import { describe, expect, test } from "bun:test";
import { MAC_FIREWALL, macFirewallHelper, macFirewallPlist, macFirewallRules, type MacFirewallState } from "@galahad/sandbox";
import { firewallCommand, type FirewallDeps } from "../src/firewall-cli.ts";

/*
 * `galahad firewall` (firewall-cli.ts), with stand-ins for root's places, launchd and the firewall's state: nothing
 * here touches the machine it runs on. What the firewall does to traffic was tried on the Mac mini (docs/MAC.md).
 */

function mac(over: { uid?: number; platform?: string; state?: MacFirewallState[]; dirs?: Record<string, { uid: number; mode: number }>; launchd?: number } = {}) {
  const printed: string[] = [];
  const ran: string[][] = [];
  const placed: { path: string; text: string; mode: number }[] = [];
  const made: string[] = [];
  const removed: string[] = [];
  const states = [...(over.state ?? [{ on: true }])];
  const dirs: Record<string, { uid: number; mode: number }> = over.dirs ?? {
    "/Library": { uid: 0, mode: 0o40755 },
    "/Library/LaunchDaemons": { uid: 0, mode: 0o40755 },
  };
  let rooted = 0;
  const deps: FirewallDeps = {
    platform: over.platform ?? "darwin",
    uid: over.uid ?? 0,
    run: async (argv) => {
      ran.push(argv);
      return argv[1] === "bootstrap" ? { code: over.launchd ?? 0, stdout: "", stderr: over.launchd ? "Bootstrap failed: 5: Input/output error" : "" } : { code: 0, stdout: "", stderr: "" };
    },
    asRoot: async () => {
      rooted++;
      return 0;
    },
    dir: (path) => dirs[path] ?? null,
    mkdir: (path, mode) => {
      made.push(path);
      dirs[path] = { uid: 0, mode: 0o40000 | mode };
    },
    place: (path, text, mode) => void placed.push({ path, text, mode }),
    remove: (path) => void removed.push(path),
    state: async () => (states.length > 1 ? states.shift()! : states[0]!),
    sleep: async () => {},
    print: (line) => void printed.push(line),
  };
  return { deps, printed, ran, placed, made, removed, rooted: () => rooted };
}

describe("galahad firewall", () => {
  test("status: on, or off with why; its exit code says which", async () => {
    const on = mac();
    expect(await firewallCommand(undefined, on.deps)).toBe(0);
    expect(on.printed[0]).toStartWith("On: a gateway sandbox reaches the gateway alone");
    const off = mac({ state: [{ on: false, installed: false, soon: false, why: "this Mac's sandbox firewall isn't installed: run `galahad firewall install` (it asks for your password once)" }] });
    expect(await firewallCommand("status", off.deps)).toBe(1);
    expect(off.printed).toEqual(["Off: this Mac's sandbox firewall isn't installed: run `galahad firewall install` (it asks for your password once)"]);
  });

  test("rules: what it lets through, as pf is given it", async () => {
    const m = mac();
    expect(await firewallCommand("rules", m.deps)).toBe(0);
    expect(m.printed).toEqual([macFirewallRules().trimEnd()]);
  });

  test("install, run as anyone but root, runs again as root through sudo, and writes nothing itself", async () => {
    const m = mac({ uid: 501 });
    expect(await firewallCommand("install", m.deps)).toBe(0);
    expect(m.rooted()).toBe(1);
    expect(m.placed).toEqual([]);
    expect(m.ran).toEqual([]);
  });

  test("install as root: root's helper directory made as macOS would, the helper and its job put in place, loaded, and on", async () => {
    const m = mac();
    expect(await firewallCommand("install", m.deps)).toBe(0);
    expect(m.made).toEqual(["/Library/PrivilegedHelperTools"]);
    expect(m.placed).toEqual([
      { path: MAC_FIREWALL.helper, text: macFirewallHelper(), mode: 0o755 },
      { path: MAC_FIREWALL.plist, text: macFirewallPlist(), mode: 0o644 },
    ]);
    expect(m.ran).toEqual([
      ["/bin/launchctl", "bootout", "system/sh.galahad.firewall"],
      ["/bin/launchctl", "bootstrap", "system", MAC_FIREWALL.plist],
    ]);
    expect(m.printed.at(-1)).toStartWith("Installed and on (sh.galahad.firewall, every 10 s)");
  });

  test("installed before the node's networks are up: said, and that its node brings them up", async () => {
    const m = mac({ state: [{ on: false, installed: true, soon: true, why: "the galahad-gw network has no bridge on this Mac yet" }] });
    expect(await firewallCommand("install", m.deps)).toBe(0);
    expect(m.printed.at(-1)).toBe("Installed (sh.galahad.firewall, every 10 s). It is on once the node's networks are up, which its node does as it starts: the galahad-gw network has no bridge on this Mac yet.");
  });

  test("never writes where anyone but root could: a place that isn't root's alone is refused, and nothing is put anywhere", async () => {
    const places: Record<string, { uid: number; mode: number }>[] = [
      { "/Library": { uid: 0, mode: 0o40755 }, "/Library/PrivilegedHelperTools": { uid: 501, mode: 0o40755 }, "/Library/LaunchDaemons": { uid: 0, mode: 0o40755 } },
      { "/Library": { uid: 0, mode: 0o40755 }, "/Library/PrivilegedHelperTools": { uid: 0, mode: 0o40775 }, "/Library/LaunchDaemons": { uid: 0, mode: 0o40755 } },
      { "/Library": { uid: 0, mode: 0o40777 }, "/Library/LaunchDaemons": { uid: 0, mode: 0o40755 } },
    ];
    for (const dirs of places) {
      const m = mac({ dirs });
      expect(await firewallCommand("install", m.deps)).toBe(1);
      expect(m.printed.at(-1)).toMatch(/^Not installed: \/Library\S* isn't root's alone, so what is put there can't be trusted\.$/);
      expect(m.placed).toEqual([]);
      expect(m.ran).toEqual([]);
    }
  });

  test("launchd refusing it is said, with what it said", async () => {
    const m = mac({ launchd: 5 });
    expect(await firewallCommand("install", m.deps)).toBe(1);
    expect(m.printed.at(-1)).toBe("Its files are in place, but launchd wouldn't load it: Bootstrap failed: 5: Input/output error");
  });

  test("remove: its job unloaded, its files gone, its rules flushed", async () => {
    const m = mac();
    expect(await firewallCommand("remove", m.deps)).toBe(0);
    expect(m.ran).toEqual([
      ["/bin/launchctl", "bootout", "system/sh.galahad.firewall"],
      ["/sbin/pfctl", "-a", "com.apple/galahad", "-F", "all"],
    ]);
    expect(m.removed).toEqual([MAC_FIREWALL.plist, MAC_FIREWALL.helper, MAC_FIREWALL.status]);
  });

  test("on Linux it is galahad-firewall's to do: said, and install refuses", async () => {
    const m = mac({ platform: "linux" });
    expect(await firewallCommand("status", m.deps)).toBe(0);
    expect(m.printed[0]).toContain("galahad-firewall");
    expect(await firewallCommand("install", m.deps)).toBe(1);
    expect(m.placed).toEqual([]);
  });

  test("anything else: its usage", async () => {
    const m = mac();
    expect(await firewallCommand("open", m.deps)).toBe(1);
    expect(m.printed).toEqual(["usage: galahad firewall [status|rules|install|remove]"]);
  });
});
