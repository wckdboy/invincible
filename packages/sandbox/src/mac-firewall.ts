import { lstatSync, readFileSync } from "node:fs";
import { NETWORKS, SANDBOX_GATEWAY_PORT } from "./spec.ts";

/*
 * The Mac's sandbox firewall: what galahad-firewall is on Ultra (scripts/remote-setup.sh), for Apple's `container`.
 * A gateway sandbox reaches the gateway's one port and nothing else. An online one reaches the internet and the
 * resolver at its network's gateway, never the Mac itself, your network or your tailnet (stricter than Ultra, whose
 * online sandboxes reach past their host). No sandbox reaches another. Two things give it:
 *
 *  - pf's rules, in an anchor under com.apple/ (macOS's own pf.conf evaluates every anchor there, and pf is on while
 *    vmnet's networks are), for what reaches the Mac's IP stack;
 *  - each Galahad bridge's member filter (BRDGSFILT with IFBF_FILT_MEMBER, XNU's if_bridge.c), so pf also sees what
 *    passes between a bridge's VMs, which never reaches the IP stack and which no ifconfig option turns on.
 *
 * Both need root, so a helper does them: root's own file in /Library/PrivilegedHelperTools, the rules inside it,
 * which launchd runs every ten seconds once `galahad firewall install` has put it there with the owner's password.
 * What it did it writes to /var/run, root's. The node reads that, and the bridges for itself (a bridge's filter can
 * be read without root), and makes no sandbox on a Mac while either says the firewall isn't on. Each way out of both
 * kinds of sandbox was tried on the Mac mini, 17 November 2026, open without it and shut with it (docs/MAC.md).
 */

export const MAC_FIREWALL = {
  label: "sh.galahad.firewall",
  helper: "/Library/PrivilegedHelperTools/sh.galahad.firewall",
  plist: "/Library/LaunchDaemons/sh.galahad.firewall.plist",
  status: "/var/run/sh.galahad.firewall.json",
  anchor: "com.apple/galahad",
  /** Seconds between its runs. */
  every: 10,
} as const;

/** The bridge's filter flag that has pf see traffic between its members (XNU's if_bridgevar.h). */
const IFBF_FILT_MEMBER = 0x2;

/** What isn't the internet (RFC 6890): the Mac's own addresses, your network and your tailnet among them. */
const NOT_THE_INTERNET = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"];

/** The anchor's rules (pf's: the first `quick` rule that matches decides). Every VM here has no IPv6 (container.ts). */
export function macFirewallRules(): string {
  const gw = NETWORKS.gateway;
  const on = NETWORKS.online;
  return [
    `# Galahad's sandboxes on this Mac (docs/MAC.md), loaded by ${MAC_FIREWALL.label} into ${MAC_FIREWALL.anchor}.`,
    `gw4 = "${gw.subnet}"`,
    `on4 = "${on.subnet}"`,
    `pass in quick inet proto tcp from $gw4 to ${gw.gateway} port ${SANDBOX_GATEWAY_PORT}`,
    `pass in quick inet proto { tcp, udp } from $on4 to ${on.gateway} port 53`,
    "block return in quick inet from $gw4",
    `block return in quick inet from $on4 to { ${NOT_THE_INTERNET.join(", ")} }`,
    "block return in quick inet from $on4 to self",
    "",
  ].join("\n");
}

/**
 * The helper, as root runs it: perl, which macOS has, so nothing is compiled or downloaded. It reads nothing anyone
 * but root can write: the rules are inside it, and each bridge it touches is one carrying a Galahad gateway's address.
 * The rules are loaded afresh each run (`self` is the Mac's addresses as they are then).
 */
export function macFirewallHelper(): string {
  return `#!/usr/bin/perl
# Galahad's firewall for its sandboxes on this Mac (docs/MAC.md), run as root by launchd every ${MAC_FIREWALL.every} seconds
# (${MAC_FIREWALL.label}). It loads the rules below into pf's anchor ${MAC_FIREWALL.anchor}, has pf see what passes between the
# VMs on each Galahad bridge (the bridge's member filter), and writes what it did to ${MAC_FIREWALL.status}.
# Written by \`galahad firewall install\`: change Galahad's source, not this file.
use strict;
use warnings;
use IPC::Open3 qw(open3);
use JSON::PP ();
use Socket qw(AF_INET SOCK_DGRAM);

my $ANCHOR = "${MAC_FIREWALL.anchor}";
my $STATUS = "${MAC_FIREWALL.status}";
my @GATEWAYS = ("${NETWORKS.gateway.gateway}", "${NETWORKS.online.gateway}");
my $RULES = <<'RULES';
${macFirewallRules()}RULES

$ENV{PATH} = "/usr/bin:/bin:/usr/sbin:/sbin";
my %status = (v => 1, at => time, pf => JSON::PP::false, rules => 0, bridges => {}, error => undef);

# A bridge's filter flags: read, or set when given (BRDGGFILT and BRDGSFILT, through SIOCGDRVSPEC and SIOCSDRVSPEC).
sub filter {
  my ($sock, $bridge, $set) = @_;
  my $param = pack("L", $set // 0);
  my $ifd = pack("Z16 Q Q P4", $bridge, defined $set ? 24 : 23, 4, $param);
  ioctl($sock, defined $set ? 0x8028697B : 0xC028697B, $ifd) or die "$bridge\\'s filter: $!\\n";
  return unpack("L", $param);
}

eval {
  system("pfctl -E >/dev/null 2>&1") unless \`pfctl -s info 2>/dev/null\` =~ /Status: Enabled/;
  $status{pf} = \`pfctl -s info 2>/dev/null\` =~ /Status: Enabled/ ? JSON::PP::true : JSON::PP::false;
  my $pid = open3(my $in, my $out, undef, "pfctl", "-a", $ANCHOR, "-f", "-");
  print $in $RULES;
  close $in;
  my $said = do { local $/; <$out> } // "";
  waitpid($pid, 0);
  die "pfctl refused the rules: " . join(" ", grep { !/flushing of rules|present in the main ruleset|pf.conf for further|ALTQ/ } split /\\n/, $said) . "\\n" if $? != 0;
  $status{rules} = scalar grep { /\\S/ } \`pfctl -a $ANCHOR -s rules 2>/dev/null\`;
  my ($if, %at);
  for (\`ifconfig -a 2>/dev/null\`) {
    $if = $1 if /^(\\S+?):\\s/;
    $at{$1} = $if if defined $if && /^\\s+inet (\\d+\\.\\d+\\.\\d+\\.\\d+)\\s/;
  }
  socket(my $sock, AF_INET, SOCK_DGRAM, 0) or die "socket: $!\\n";
  for my $gw (@GATEWAYS) {
    my $bridge = $at{$gw};
    next unless defined $bridge && $bridge =~ /^bridge\\d+$/;
    my $flags = filter($sock, $bridge);
    filter($sock, $bridge, $flags | ${IFBF_FILT_MEMBER}) unless $flags & ${IFBF_FILT_MEMBER};
    $status{bridges}{$gw} = { if => $bridge, filter => filter($sock, $bridge) + 0 };
  }
};
if ($@) {
  ($status{error} = $@) =~ s/\\s+$//;
}
open(my $f, ">", "$STATUS.tmp") or die "$STATUS.tmp: $!";
print $f JSON::PP->new->canonical->encode(\\%status), "\\n";
close $f;
chmod 0644, "$STATUS.tmp";
rename "$STATUS.tmp", $STATUS or die "$STATUS: $!";
`;
}

/** Its launchd job: root's (a LaunchDaemon), at boot and every few seconds after. */
export function macFirewallPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_FIREWALL.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/perl</string>
    <string>${MAC_FIREWALL.helper}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${MAC_FIREWALL.every}</integer>
</dict>
</plist>
`;
}

/**
 * What is in root's places now, read as anyone may read them (the helper is 0755, its job 0644): this release's
 * helper and job ("current"), another's or changed ("other": installed again, they are this release's), or none.
 */
export function macFirewallInstalled(read: (path: string) => string | null): "current" | "other" | "none" {
  const [helper, plist] = [read(MAC_FIREWALL.helper), read(MAC_FIREWALL.plist)];
  if (helper === null && plist === null) return "none";
  return helper === macFirewallHelper() && plist === macFirewallPlist() ? "current" : "other";
}

/** Each interface `ifconfig -a` prints: its IPv4 addresses, and a bridge's filter flags (null: it has none). */
export function interfacesOf(text: string): { name: string; inet: string[]; filter: number | null }[] {
  const found: { name: string; inet: string[]; filter: number | null }[] = [];
  for (const line of text.split("\n")) {
    const head = /^(\S+?):\s/.exec(line);
    if (head) {
      found.push({ name: head[1]!, inet: [], filter: null });
      continue;
    }
    const current = found.at(-1);
    if (!current) continue;
    const inet = /^\s+inet (\d+\.\d+\.\d+\.\d+)\s/.exec(line);
    if (inet) current.inet.push(inet[1]!);
    const filter = /^\s+ipfilter \S+ flags 0x([0-9a-fA-F]+)/.exec(line);
    if (filter) current.filter = Number.parseInt(filter[1]!, 16);
  }
  return found;
}

/** Whether the firewall is on; when it isn't, why, and whether its helper's next run puts it right (`soon`). */
export type MacFirewallState = { on: true } | { on: false; installed: boolean; soon: boolean; why: string };

export interface MacFirewallDeps {
  /** The helper's status file as it is: who owns it, its mode, what it says; null when there's none (or it isn't a file). */
  status(): { uid: number; mode: number; text: string } | null;
  /** `ifconfig -a`, as it prints. */
  ifconfig(): Promise<string>;
  now(): number;
}

const SYSTEM: MacFirewallDeps = {
  status() {
    try {
      const file = lstatSync(MAC_FIREWALL.status);
      return file.isFile() ? { uid: file.uid, mode: file.mode, text: readFileSync(MAC_FIREWALL.status, "utf8") } : null;
    } catch {
      return null;
    }
  },
  async ifconfig() {
    const proc = Bun.spawn(["/sbin/ifconfig", "-a"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return text;
  },
  now: () => Date.now(),
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** This Mac's sandbox firewall, as its helper last said and as the bridges are now. */
export async function macFirewall(deps: MacFirewallDeps = SYSTEM): Promise<MacFirewallState> {
  const off = (why: string, soon = false) => ({ on: false as const, installed: true, soon, why });
  const file = deps.status();
  if (!file) return { on: false, installed: false, soon: false, why: "this Mac's sandbox firewall isn't installed: run `galahad firewall install` (it asks for your password once)" };
  if (file.uid !== 0 || (file.mode & 0o022) !== 0) return off(`${MAC_FIREWALL.status} isn't root's alone, so what it says can't be trusted`);
  let said: unknown;
  try {
    said = JSON.parse(file.text);
  } catch {
    said = null;
  }
  if (!isObj(said) || said.v !== 1 || typeof said.at !== "number") return off(`${MAC_FIREWALL.status} can't be read: reinstall it with \`galahad firewall install\``);
  if (typeof said.error === "string") return off(`the sandbox firewall's helper says: ${said.error.slice(0, 300)}`);
  const age = deps.now() - said.at * 1000;
  if (age > 3 * MAC_FIREWALL.every * 1000) return off(`the sandbox firewall's helper last ran ${Math.round(age / 1000)} s ago: is it loaded? (sudo launchctl print system/${MAC_FIREWALL.label})`);
  if (said.pf !== true) return off("pf isn't on, so the sandbox firewall's rules hold nothing");
  if (typeof said.rules !== "number" || said.rules < 1) return off("the sandbox firewall's rules aren't loaded");
  const interfaces = interfacesOf(await deps.ifconfig());
  for (const kind of ["gateway", "online"] as const) {
    const network = NETWORKS[kind];
    const bridge = interfaces.find((i) => i.inet.includes(network.gateway));
    if (!bridge) return off(`the ${network.name} network has no bridge on this Mac yet`, true);
    if (!/^bridge\d+$/.test(bridge.name)) return off(`${network.gateway} is on ${bridge.name}, which isn't a bridge`);
    if (bridge.filter === null || (bridge.filter & IFBF_FILT_MEMBER) === 0) return off(`pf doesn't see what passes between the VMs on ${bridge.name} (${network.name}) yet`, true);
  }
  return { on: true };
}
