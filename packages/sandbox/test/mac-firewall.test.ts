import { describe, expect, test } from "bun:test";
import { interfacesOf, MAC_FIREWALL, macFirewall, macFirewallHelper, macFirewallInstalled, macFirewallPlist, macFirewallRules, type MacFirewallDeps, NETWORKS, SANDBOX_GATEWAY_PORT } from "../src/index.ts";

/*
 * The Mac's sandbox firewall (mac-firewall.ts): its rules, the helper root runs and its launchd job, and how the node
 * reads whether it is on. What they do to traffic was tried on the Mac mini (docs/MAC.md); here, that they say it.
 */

/** `ifconfig -a` as the Mac mini printed it (17 November 2026), trimmed: the two Galahad bridges, and two others. */
const IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
		ipfilter disabled flags 0x0
	member: en2 flags=3<LEARNING,DISCOVER>
bridge100: flags=8a63<UP,BROADCAST,SMART,RUNNING,ALLMULTI,SIMPLEX,MULTICAST> mtu 1500
	inet 172.31.249.1 netmask 0xffffff00 broadcast 172.31.249.255
	Configuration:
		ipfilter disabled flags 0x2
	member: vmenet0 flags=20003<LEARNING,DISCOVER,VIRTIO>
bridge101: flags=8a63<UP,BROADCAST,SMART,RUNNING,ALLMULTI,SIMPLEX,MULTICAST> mtu 1500
	inet 172.31.250.1 netmask 0xffffff00 broadcast 172.31.250.255
	Configuration:
		ipfilter disabled flags 0x2
	member: vmenet1 flags=20003<LEARNING,DISCOVER,VIRTIO>
`;

const NOW = 1_794_876_711_000;
const said = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, at: NOW / 1000 - 4, pf: true, rules: 5, bridges: {}, error: null, ...over });
const deps = (over: Partial<MacFirewallDeps> = {}): MacFirewallDeps => ({ status: () => ({ uid: 0, mode: 0o100644, text: said() }), ifconfig: async () => IFCONFIG, now: () => NOW, ...over });

describe("its rules", () => {
  test("a gateway sandbox reaches the gateway's one port and nothing else; an online one its resolver and the internet, never what isn't", () => {
    const rules = macFirewallRules();
    expect(rules).toContain(`gw4 = "${NETWORKS.gateway.subnet}"`);
    expect(rules).toContain(`on4 = "${NETWORKS.online.subnet}"`);
    const lines = rules.split("\n").filter((l) => /^(pass|block)/.test(l));
    expect(lines).toEqual([
      `pass in quick inet proto tcp from $gw4 to ${NETWORKS.gateway.gateway} port ${SANDBOX_GATEWAY_PORT}`,
      `pass in quick inet proto { tcp, udp } from $on4 to ${NETWORKS.online.gateway} port 53`,
      "block return in quick inet from $gw4",
      "block return in quick inet from $on4 to { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }",
      "block return in quick inet from $on4 to self",
    ]);
    // What lets a sandbox through comes before every block (pf's first quick match decides).
    expect(lines.findLastIndex((l) => l.startsWith("pass"))).toBeLessThan(lines.findIndex((l) => l.startsWith("block")));
  });
});

describe("its helper and launchd job", () => {
  test("the helper is perl, which macOS has, with the rules inside it and nothing read from anywhere anyone but root can write", () => {
    const helper = macFirewallHelper();
    expect(helper.startsWith("#!/usr/bin/perl\n")).toBe(true);
    expect(helper).toContain(`my $RULES = <<'RULES';\n${macFirewallRules()}RULES\n`);
    expect(helper).toContain(`my $ANCHOR = "${MAC_FIREWALL.anchor}";`);
    expect(helper).toContain(`my @GATEWAYS = ("${NETWORKS.gateway.gateway}", "${NETWORKS.online.gateway}");`);
    expect(helper).toContain('$ENV{PATH} = "/usr/bin:/bin:/usr/sbin:/sbin";');
    // Only a bridge's filter is set, by its name as the kernel gave it, and its status is written by rename.
    expect(helper).toContain("next unless defined $bridge && $bridge =~ /^bridge\\d+$/;");
    expect(helper).toContain('rename "$STATUS.tmp", $STATUS');
    expect(helper).not.toMatch(/\/Users\/|\$ENV\{HOME\}|<STDIN>|@ARGV/);
  });

  test("its job is root's, at boot and every few seconds after, running the helper from root's own directory", () => {
    const plist = macFirewallPlist();
    expect(plist).toContain(`<string>${MAC_FIREWALL.label}</string>`);
    expect(plist).toContain(`<string>/usr/bin/perl</string>\n    <string>${MAC_FIREWALL.helper}</string>`);
    expect(plist).toContain(`<key>StartInterval</key>\n  <integer>${MAC_FIREWALL.every}</integer>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(MAC_FIREWALL.helper.startsWith("/Library/PrivilegedHelperTools/")).toBe(true);
    expect(MAC_FIREWALL.plist.startsWith("/Library/LaunchDaemons/")).toBe(true);
  });
});

describe("what is installed", () => {
  test("this release's helper and job, another's, or none: read as anyone may read them", () => {
    const files = (helper: string | null, plist: string | null) => (path: string) => (path === MAC_FIREWALL.helper ? helper : path === MAC_FIREWALL.plist ? plist : null);
    expect(macFirewallInstalled(files(macFirewallHelper(), macFirewallPlist()))).toBe("current");
    expect(macFirewallInstalled(files(macFirewallHelper().replace("every", "each"), macFirewallPlist()))).toBe("other");
    expect(macFirewallInstalled(files(macFirewallHelper(), null))).toBe("other");
    expect(macFirewallInstalled(files(null, null))).toBe("none");
  });
});

describe("what ifconfig prints, read", () => {
  test("each interface, its IPv4 addresses, and a bridge's filter flags", () => {
    expect(interfacesOf(IFCONFIG)).toEqual([
      { name: "lo0", inet: ["127.0.0.1"], filter: null },
      { name: "en0", inet: ["192.168.1.20"], filter: null },
      { name: "bridge0", inet: [], filter: 0 },
      { name: "bridge100", inet: ["172.31.249.1"], filter: 2 },
      { name: "bridge101", inet: ["172.31.250.1"], filter: 2 },
    ]);
  });
});

describe("whether it is on", () => {
  test("on: its helper ran a moment ago with pf on and its rules loaded, and both Galahad bridges have pf see between their VMs", async () => {
    expect(await macFirewall(deps())).toEqual({ on: true });
  });

  test("not installed: said, with what to do", async () => {
    expect(await macFirewall(deps({ status: () => null }))).toEqual({ on: false, installed: false, soon: false, why: "this Mac's sandbox firewall isn't installed: run `galahad firewall install` (it asks for your password once)" });
  });

  test("a status file anyone but root could have written is never believed", async () => {
    for (const status of [{ uid: 501, mode: 0o100644 }, { uid: 0, mode: 0o100664 }, { uid: 0, mode: 0o100646 }]) {
      const state = await macFirewall(deps({ status: () => ({ ...status, text: said() }) }));
      expect(state).toMatchObject({ on: false, soon: false, why: `${MAC_FIREWALL.status} isn't root's alone, so what it says can't be trusted` });
    }
  });

  test("off whenever its helper says anything is wrong, or hasn't run for three of its turns", async () => {
    const off = async (text: string) => macFirewall(deps({ status: () => ({ uid: 0, mode: 0o100644, text }) }));
    expect(await off("not json")).toMatchObject({ on: false, why: expect.stringContaining("can't be read") });
    expect(await off(said({ error: "pfctl refused the rules: syntax error" }))).toMatchObject({ on: false, why: "the sandbox firewall's helper says: pfctl refused the rules: syntax error" });
    expect(await off(said({ pf: false }))).toMatchObject({ on: false, why: expect.stringContaining("pf isn't on") });
    expect(await off(said({ rules: 0 }))).toMatchObject({ on: false, why: "the sandbox firewall's rules aren't loaded" });
    expect(await off(said({ at: NOW / 1000 - 31 }))).toMatchObject({ on: false, soon: false, why: expect.stringContaining("last ran 31 s ago") });
    expect(await off(said({ at: NOW / 1000 - 29 }))).toEqual({ on: true });
  });

  test("a bridge without its filter yet, or no bridge yet, is off until the helper's next run: soon", async () => {
    const unfiltered = IFCONFIG.replace("inet 172.31.250.1 netmask 0xffffff00 broadcast 172.31.250.255\n\tConfiguration:\n\t\tipfilter disabled flags 0x2", "inet 172.31.250.1 netmask 0xffffff00 broadcast 172.31.250.255\n\tConfiguration:\n\t\tipfilter disabled flags 0x0");
    expect(await macFirewall(deps({ ifconfig: async () => unfiltered }))).toEqual({ on: false, installed: true, soon: true, why: "pf doesn't see what passes between the VMs on bridge101 (galahad-gw) yet" });
    const noOnline = IFCONFIG.replace("inet 172.31.249.1 ", "inet 172.31.248.1 ");
    expect(await macFirewall(deps({ ifconfig: async () => noOnline }))).toEqual({ on: false, installed: true, soon: true, why: "the galahad-net network has no bridge on this Mac yet" });
  });

  test("a gateway's address on anything but a bridge is off, and not soon", async () => {
    const elsewhere = IFCONFIG.replace("inet 192.168.1.20 ", "inet 172.31.250.1 ");
    expect(await macFirewall(deps({ ifconfig: async () => elsewhere }))).toMatchObject({ on: false, soon: false, why: "172.31.250.1 is on en0, which isn't a bridge" });
  });
});
