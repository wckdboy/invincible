import { alertReserve, CLOCK, newsBudget, NOTIFY_KIND_INFO, NOTIFY_KINDS, NOTIFY_PER_DAY, type NotifyDeviceView, type NotifyKind, type NotifyPrefs, type NotifyView, type RouteName } from "@galahad/core";

/*
 * `galahad notify`: he comes to you, seen and set from a terminal. Thin: the node keeps
 * the subscriptions and the settings and decides what's sent; this shapes input and prints.
 *
 *   galahad notify                          the devices he can reach, what he tells you, quiet hours, the day's
 *                                           limit, and what was sent today
 *   galahad notify test [device]            one test notification: to every device, or the one named
 *   galahad notify kinds [<kind> on|off …]  what he tells you (needs-you, approval, finished, question, told)
 *   galahad notify quiet [on | off | HH:MM-HH:MM] [--tz Europe/Copenhagen]
 *   galahad notify limit <n>                at most n a day
 *   galahad notify digest [on | off | HH:MM] the day's digest: what happened that he didn't buzz you for, once a day
 *   galahad notify off <device>             remove a device's subscription
 *   galahad notify apple-key < key.json     the Apple push key the iPhone app is notified with:
 *                                           {"key": "<the .p8's text>", "keyId": "…", "teamId": "…"[, "topic": "<bundle id>"]}
 *
 * A device is turned on from that device (Settings → Notifications): a subscription is a
 * browser's to hand over, never a terminal's to make.
 */

interface Api {
  call<T = any>(name: RouteName, input?: unknown): Promise<T>;
}

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const USAGE = "usage: galahad notify | notify test [device] | notify kinds [<kind> on|off …] | notify quiet [on|off|HH:MM-HH:MM] [--tz zone] | notify limit <n> | notify digest [on|off|HH:MM] | notify off <device> | notify apple-key < key.json";

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The device a name or the start of an id means, among those subscribed. Never a guess between two. */
export function deviceNamed(devices: NotifyDeviceView[], ref: string): NotifyDeviceView {
  const matches = devices.filter((d) => d.device === ref || d.name === ref || (ref.length >= 6 && d.device.startsWith(ref)));
  if (!matches.length) throw new Error(`no device named "${ref}" has notifications on (galahad notify lists them)`);
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} devices; name one by its id:\n${matches.map((d) => `  ${d.device.slice(0, 14)}  ${d.name}`).join("\n")}`);
  return matches[0]!;
}

/** `zone`: the zone your day is read in now (the one your devices last said), when it isn't the setting's. */
export function quietWords(prefs: NotifyPrefs, zone?: string): string {
  return prefs.quiet.on ? `${prefs.quiet.from} to ${prefs.quiet.to}, ${zone ?? prefs.quiet.tz} time: everything but an alert waits, then one message says what waited` : "off: he tells you whenever it happens";
}

export function digestWords(prefs: NotifyPrefs, zone?: string): string {
  return prefs.digest.on ? `at ${prefs.digest.at}, ${zone ?? prefs.quiet.tz} time: what happened that he didn't buzz you for, once a day, quietly` : "off: what he doesn't buzz you for waits in your Inbox";
}

/** Everything `galahad notify` prints: who, what, when, and today. Never an endpoint (the node gives none). */
export function statusLines(view: NotifyView): string[] {
  const out: string[] = [bold(`Notifications from ${view.node}`)];
  if (!view.devices.length) out.push("  No device has them on. Turn them on from each device: the app's Settings → Notifications (on an iPhone, from the Home Screen app).");
  for (const d of view.devices) {
    const state = d.lastError ? `not arriving: ${d.lastError}` : d.lastOk ? `last reached ${new Date(d.lastOk).toLocaleString()}` : "nothing sent yet";
    out.push(`  ${d.name.padEnd(20)} ${dim(`through ${d.service} · on since ${new Date(d.since).toLocaleDateString()} · ${state}`)}`);
  }
  out.push("", bold("What he tells you"));
  for (const kind of NOTIFY_KINDS) out.push(`  ${(view.prefs.kinds[kind] ? "on " : "off").padEnd(4)} ${kind.padEnd(10)} ${dim(NOTIFY_KIND_INFO[kind].label)}`);
  out.push("", `${bold("Quiet hours")}  ${quietWords(view.prefs, view.zone)}${view.quiet ? dim(` (now; ${view.held} waiting)`) : ""}`);
  if (view.zone && view.zone !== view.prefs.quiet.tz) out.push(dim(`  (your devices say they're in ${view.zone}; the setting's ${view.prefs.quiet.tz} is used when none has said)`));
  out.push(`${bold("The digest")}  ${digestWords(view.prefs, view.zone)}`);
  out.push(`${bold("The day's limit")}  ${view.today.count} of ${view.today.limit} sent today (${view.today.day})`);
  for (const sent of view.today.sent) out.push(`  ${time(sent.at)}  ${sent.kind.padEnd(10)} ${dim(`to ${sent.devices.join(", ")}${sent.ok ? "" : " (didn't arrive)"}`)}`);
  return out;
}

export async function notifyCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags, print: (line: string) => void = console.log, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<void> {
  if (sub === undefined) {
    for (const line of statusLines(await api.call<NotifyView>("notify"))) print(line);
    return;
  }
  if (sub === "test") {
    const view = rest[0] ? await api.call<NotifyView>("notify") : null;
    const { sent } = await api.call<{ sent: { device: string; ok: boolean; error: string | null }[] }>("notifyTest", view ? { device: deviceNamed(view.devices, rest[0]!).device } : {});
    for (const s of sent) print(s.ok ? `Sent to ${s.device}.` : `Didn't reach ${s.device}: ${s.error ?? "no reason given"}.`);
    return;
  }
  if (sub === "kinds") {
    if (rest.length % 2) throw new Error(`a kind, then on or off: galahad notify kinds finished off\n${USAGE}`);
    const kinds: Partial<Record<NotifyKind, boolean>> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const kind = rest[i]!;
      const to = rest[i + 1]!;
      if (!(NOTIFY_KINDS as readonly string[]).includes(kind)) throw new Error(`"${kind}" isn't a kind he tells you about: ${NOTIFY_KINDS.join(", ")}`);
      if (to !== "on" && to !== "off") throw new Error(`"${to}" isn't on or off (galahad notify kinds ${kind} on)`);
      kinds[kind as NotifyKind] = to === "on";
    }
    const prefs = rest.length ? (await api.call<{ prefs: NotifyPrefs }>("setNotify", { kinds })).prefs : (await api.call<NotifyView>("notify")).prefs;
    for (const kind of NOTIFY_KINDS) print(`  ${(prefs.kinds[kind] ? "on " : "off").padEnd(4)} ${kind.padEnd(10)} ${dim(NOTIFY_KIND_INFO[kind].hint)}`);
    return;
  }
  if (sub === "quiet") {
    const tz = typeof flags.tz === "string" ? flags.tz : undefined;
    const arg = rest[0];
    let quiet: Partial<NotifyPrefs["quiet"]> | null = null;
    if (arg === "on" || arg === "off") quiet = { on: arg === "on", ...(tz ? { tz } : {}) };
    else if (arg !== undefined) {
      const [from, to] = arg.split("-");
      if (!from || !to || !CLOCK.test(from) || !CLOCK.test(to)) throw new Error(`quiet hours are two times of day: galahad notify quiet 22:00-07:00 [--tz Europe/Copenhagen]`);
      quiet = { on: true, from, to, ...(tz ? { tz } : {}) };
    } else if (tz) quiet = { tz };
    const prefs = quiet ? (await api.call<{ prefs: NotifyPrefs }>("setNotify", { quiet })).prefs : (await api.call<NotifyView>("notify")).prefs;
    print(`Quiet hours: ${quietWords(prefs)}.`);
    return;
  }
  if (sub === "limit") {
    const n = Number(rest[0]);
    if (!rest[0] || !Number.isInteger(n) || n < NOTIFY_PER_DAY.min || n > NOTIFY_PER_DAY.max) throw new Error(`the day's limit is a whole number from ${NOTIFY_PER_DAY.min} to ${NOTIFY_PER_DAY.max}: galahad notify limit 12`);
    const { prefs } = await api.call<{ prefs: NotifyPrefs }>("setNotify", { perDay: n });
    const kept = alertReserve(prefs.perDay);
    print(`At most ${prefs.perDay} a day${kept ? `, the last ${kept === 1 ? "one" : kept} kept for alerts` : ""}; news alone at most ${newsBudget(prefs.perDay)} (the rest goes to the digest). When what needs you reaches the limit, one message says so.`);
    return;
  }
  if (sub === "digest") {
    const arg = rest[0];
    let digest: Partial<NotifyPrefs["digest"]> | null = null;
    if (arg === "on" || arg === "off") digest = { on: arg === "on" };
    else if (arg !== undefined) {
      if (!CLOCK.test(arg)) throw new Error(`the digest's time is a time of day: galahad notify digest 08:00`);
      digest = { on: true, at: arg };
    }
    const view = digest ? null : await api.call<NotifyView>("notify");
    const prefs = digest ? (await api.call<{ prefs: NotifyPrefs }>("setNotify", { digest })).prefs : view!.prefs;
    print(`The digest: ${digestWords(prefs, view?.zone)}.`);
    return;
  }
  if (sub === "apple-key") {
    // On stdin, never on a command line (shells and remote sessions keep those): the key, its ID and your Team ID.
    let input: unknown;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      throw new Error('give the key on stdin, as JSON: {"key": "<the .p8 file\'s text>", "keyId": "…", "teamId": "…"} (galahad notify apple-key < key.json)');
    }
    const kept = await api.call<{ keyId: string; topic: string }>("setApplePushKey", input);
    print(`Apple push key ${kept.keyId} sealed, for ${kept.topic}: the iPhone app can be notified. Turn it on in the app (Settings → Notifications).`);
    return;
  }
  if (sub === "off") {
    if (!rest[0]) throw new Error(`name the device: galahad notify off <device>\n${USAGE}`);
    const device = deviceNamed((await api.call<NotifyView>("notify")).devices, rest[0]);
    await api.call("pushUnsubscribe", { device: device.device });
    print(`${device.name} won't be notified. It's turned on again from that device (Settings → Notifications).`);
    return;
  }
  throw new Error(USAGE);
}
