import { readFileSync } from "node:fs";
import { type ActionView, type ArgValue, type ConnectorLibraryView, type ConnectorRequestView, type ConnectorToolDefinition, type ConnectorView, describeWake, type FindingView, GITHUB_WAKE_EVENTS, type LoopDraftView, type LoopRunView, type LoopTask, type LoopView, type LoopWake, type NoticeView, type OrderView, type RouteName, type SelfActionView, zonedParts } from "@galahad/core";
import { CATALOG } from "@galahad/brain";

/*
 * The terminal side of loops, the heartbeat, notices, connectors and approvals.
 * Thin: every rule lives in the node; this only shapes input and prints.
 */

export interface Api {
  call<T = any>(name: RouteName, input?: unknown): Promise<T>;
}

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const str = (flags: Flags, key: string) => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const list = (flags: Flags, key: string): string[] => {
  const value = flags[key];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v): v is string => typeof v === "string");
};
const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toLocaleString());
const MARK: Record<string, string> = { ok: "✓", attention: "△", failed: "✗", interrupted: "■", info: "·", warn: "△", alert: "✗" };

export function describeTask(task: LoopTask | null): string {
  if (!task) return "(a task this version can't read)";
  if (task.kind === "heartbeat") return `${task.checklist ? "heartbeat + your checklist" : "heartbeat"}${task.selfAction === false ? " (self-action off)" : ""}`;
  if (task.kind === "quest") return `quest (${task.network}${task.gates?.length ? `, ${task.gates.length} gate${task.gates.length === 1 ? "" : "s"}` : ""}): ${task.goal.length > 70 ? `${task.goal.slice(0, 70)}…` : task.goal}`;
  if (task.kind === "tell") return `tell you${task.text ? `: ${task.text}` : " what woke it"}`;
  if (task.kind === "bilag") return `copy the bilag in the mail that wakes it to Google Drive (${task.folder ?? "Bilag"}/<year>/<month>)`;
  const args = Object.entries(task.args ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  return `call ${task.connector}.${task.tool}${args ? ` ${args}` : ""}`;
}

/** What wakes a loop besides its schedule, in a line ("" when nothing does). */
export function describeWakes(wakes: readonly LoopWake[], cooldownMs: number | null): string {
  if (!wakes.length) return "";
  const minutes = cooldownMs ? Math.round(cooldownMs / 60_000) : null;
  return `wakes on ${wakes.map(describeWake).join(" · ")}${minutes ? ` (a burst within ${minutes} min wakes it once)` : ""}`;
}

/**
 * `--wake` as you'd say it: webhook · gmail [search words] · outlook [words] · github owner/repo [ci.failed,pushed,issue.opened,pr.opened] [branch].
 * A GitHub wake with no events named wakes on a failed CI run.
 */
export function parseWake(spec: string): LoopWake {
  const [kind, ...rest] = spec.trim().split(/\s+/);
  const usage = 'give --wake webhook, --wake "gmail <search words>", --wake "outlook <words>" or --wake "github <owner>/<repo> [ci.failed,pushed,issue.opened,pr.opened] [branch]"';
  if (kind === "webhook" && !rest.length) return { kind: "webhook" };
  if (kind === "gmail" || kind === "outlook") return { kind: "mail", connector: kind, ...(rest.length ? { query: rest.join(" ") } : {}) };
  if (kind === "github") {
    const [slug, events, branch, extra] = rest;
    const [owner, repo, more] = (slug ?? "").split("/");
    if (!owner || !repo || more !== undefined || extra !== undefined) throw new Error(usage);
    const on = (events ?? "ci.failed").split(",");
    const unknown = on.find((e) => !(GITHUB_WAKE_EVENTS as readonly string[]).includes(e));
    if (unknown) throw new Error(`a GitHub wake is ${GITHUB_WAKE_EVENTS.join(" or ")}, not "${unknown}"`);
    return { kind: "github", owner, repo, on: on as (typeof GITHUB_WAKE_EVENTS)[number][], ...(branch ? { branch } : {}) };
  }
  throw new Error(usage);
}

/** `--cooldown 10m` (m or h) in ms. */
function cooldownFrom(flags: Flags): number | undefined {
  const text = str(flags, "cooldown");
  if (text === undefined) return undefined;
  const m = /^(\d{1,4})\s*([mh])$/.exec(text.trim());
  if (!m) throw new Error('--cooldown takes minutes or hours, such as "10m" or "1h"');
  return Number(m[1]) * (m[2] === "h" ? 3600_000 : 60_000);
}

/** A webhook's secret, shown once, with how to sign a body for it. */
function printHook(path: string, secret: string, node: string): void {
  console.log(`Its webhook: POST ${bold(path)} on ${node}'s address (where this CLI reaches it, the same port).`);
  console.log(`Secret, shown this once (galahad loop hook <name> makes a new one): ${bold(secret)}`);
  console.log(dim("Sign each body as GitHub does: X-Hub-Signature-256: sha256=<the HMAC-SHA256 of the body with the secret, in hex>. GitHub's own webhooks work as they are."));
  console.log(dim(`  body='{"hello":"world"}'; sig=$(printf %s "$body" | openssl dgst -sha256 -hmac "<secret>" -r | cut -d' ' -f1)`));
  console.log(dim(`  curl -X POST -H "X-Hub-Signature-256: sha256=$sig" -H 'Content-Type: application/json' -d "$body" http://<node>:7777${path}`));
}

/** What a loop is now, after it was set: its schedule, where it runs, its task, what wakes it, its next run. */
function printSet(loop: LoopView, hookSecret: string | undefined): void {
  const when_ = loop.schedule === "never" ? "only when woken" : `${loop.schedule}${loop.tz !== "UTC" ? ` (${loop.tz})` : ""}`;
  console.log(`Loop ${bold(loop.name)}: ${when_} on ${loop.onName}, ${describeTask(loop.task)}.${loop.schedule === "never" ? "" : ` Next run ${when(loop.next)}.`}`);
  if (loop.wakes.length) console.log(`  ${describeWakes(loop.wakes, loop.cooldownMs)}.`);
  if (hookSecret && loop.hook) printHook(loop.hook, hookSecret, loop.onName ?? loop.on);
}

function printRun(run: LoopRunView, loop?: string): void {
  const how = run.run.startsWith("w") ? dim(" (woken)") : run.slot === null ? dim(" (by hand)") : "";
  const head = `${MARK[run.status] ?? "?"} ${dim(new Date(run.started).toLocaleString())}${loop ? ` ${bold(loop)}` : ""} ${run.status}${how}`;
  console.log(`  ${head}\n      ${run.summary.replace(/\n/g, "\n      ")}`);
}

/** `--arg key=value` pairs, typed by the tool's declared params. */
async function toolArgs(api: Api, connector: string, tool: string, flags: Flags): Promise<Record<string, ArgValue>> {
  const pairs = list(flags, "arg");
  if (!pairs.length) return {};
  const { connectors } = await api.call<{ connectors: ConnectorView[] }>("connectors");
  const params = connectors.find((c) => c.id === connector)?.tools.find((t) => t.name === tool)?.params ?? {};
  const args: Record<string, ArgValue> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--arg takes key=value, not "${pair}"`);
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    const types = (params[key]?.type ?? "string").split("|");
    if (types.includes("array") || types.includes("object")) {
      // Lists and objects (MCP tools) are given as JSON: --arg labels='["bug","sandbox"]'
      try {
        args[key] = JSON.parse(raw) as ArgValue;
      } catch {
        throw new Error(`--arg ${key} takes JSON (it's ${types.join(" or ")})`);
      }
    } else if (types.includes("integer") || types.includes("number")) args[key] = Number(raw);
    else if (types.includes("boolean")) args[key] = raw === "true";
    else args[key] = raw;
  }
  return args;
}

const CLASSES = ["read", "create", "modify", "outward", "delete"];

/** `--class name=read …` → { name: "read" }. */
function classFlags(flags: Flags): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of list(flags, "class")) {
    const at = pair.lastIndexOf("=");
    const cls = pair.slice(at + 1);
    if (at < 1 || !CLASSES.includes(cls)) throw new Error(`--class takes tool=${CLASSES.join("|")} (or *=class for the rest), not "${pair}"`);
    out[pair.slice(0, at)] = cls;
  }
  return Object.keys(out).length ? out : undefined;
}

function printDiscovered(connector: ConnectorView, d: { server: string | null; tools: number; needsKey: boolean; needsSignIn?: boolean; added: string[]; changed: string[]; removed: string[]; skipped: number }): void {
  if (d.needsSignIn) {
    // Its own sign-in: no app of yours, no key; its tools are listed once you've signed in.
    console.log(`Installed ${connector.label} (${connector.url}) without tools yet: sign in to it as you, and they are listed then.`);
    console.log(`  galahad connector signin ${connector.id} --redirect <your app's address>/oauth/callback   (or Sign in on its card in Connectors, in the app)`);
    return;
  }
  if (d.needsKey) {
    console.log(`Installed ${connector.label} (${connector.url}) without tools yet: it needs its key first.`);
    console.log(`  galahad secret set ${connector.secret} --connector ${connector.id}   then   galahad connector refresh ${connector.id}`);
    return;
  }
  console.log(`${connector.label}${d.server ? ` (${d.server})` : ""}: ${d.tools} tools${d.skipped ? `, ${d.skipped} left out` : ""}.`);
  if (d.added.length) console.log(`  new: ${d.added.join(", ")}`);
  if (d.changed.length) console.log(bold(`  changed on the server since you installed it: ${d.changed.join(", ")} (your classes stay; orders on them stop applying)`));
  if (d.removed.length) console.log(`  gone: ${d.removed.join(", ")}`);
  for (const t of connector.tools) {
    const claimed = t.hints?.readOnly ? "says read-only" : t.hints?.destructive ? "says destructive" : "no hints";
    console.log(`  ${t.name.padEnd(28)} ${(t.asks ? bold(`${t.class}: asks you`) : t.class).padEnd(tty ? 26 : 18)} ${dim(claimed)}`);
  }
  console.log(dim(`\n  The server's hints only propose a class. Change one: galahad connector refresh ${connector.id} --class <tool>=read|create|modify|outward|delete`));
}

async function taskFrom(api: Api, flags: Flags): Promise<LoopTask | undefined> {
  const kinds = ["heartbeat", "quest", "call", "tell", "bilag"].filter((k) => (k === "bilag" ? flags.bilag === true : flags[k] !== undefined) || (k === "tell" && flags.say !== undefined));
  if (kinds.length > 1) throw new Error("give one of --heartbeat, --quest, --call, --tell or --bilag");
  // Copy the bilag in the mail that wakes it to Google Drive (--bilag, into --folder <name> when you give one).
  if (flags.bilag) return { kind: "bilag", ...(str(flags, "folder") ? { folder: str(flags, "folder")! } : {}) };
  // Tell you: a notice each run, with what woke it (and your words, --say "…").
  if (flags.tell || str(flags, "say")) return { kind: "tell", ...(str(flags, "say") ? { text: str(flags, "say")! } : {}) };
  if (flags.heartbeat) return { kind: "heartbeat", ...(str(flags, "checklist") ? { checklist: str(flags, "checklist")! } : {}) };
  if (str(flags, "quest")) {
    const steps = str(flags, "steps");
    return {
      kind: "quest",
      goal: str(flags, "quest")!,
      network: (str(flags, "net") ?? "isolated") as "isolated" | "gateway" | "online",
      ...(steps ? { maxSteps: Number(steps) } : {}),
      ...(list(flags, "gate").length ? { gates: list(flags, "gate") } : {}),
    };
  }
  if (str(flags, "call")) {
    const [connector, ...rest] = str(flags, "call")!.split(".");
    const tool = rest.join(".");
    if (!connector || !tool) throw new Error("--call takes <connector>.<tool>, e.g. github.notifications");
    return { kind: "call", connector, tool, args: await toolArgs(api, connector, tool, flags) };
  }
  if (str(flags, "checklist") !== undefined) return { kind: "heartbeat", checklist: str(flags, "checklist")! };
  return undefined;
}

/** A while from now (`--in 2h`), as the wall-clock time it will be in a zone, to the minute after: `2026-11-24 23:08`. */
function wallIn(text: string, tz: string, now: number): string {
  const m = /^(\d{1,4})\s*([mhd])$/.exec(text.trim());
  if (!m) throw new Error('--in takes minutes, hours or days, such as "45m", "2h" or "1d"');
  const at = Math.ceil((now + Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]) / 60_000) * 60_000;
  const p = zonedParts(at, tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

export async function loopCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags, opts: { now?: () => number } = {}): Promise<void> {
  const name = rest[0];
  switch (sub) {
    case undefined:
    case "ls": {
      const { loops } = await api.call<{ loops: LoopView[] }>("loops");
      if (!loops.length) console.log('No loops yet. Try: galahad loop add morning --cron "0 7 * * 1-5" --tz Europe/Copenhagen --quest "…"');
      for (const loop of loops) {
        const state = loop.enabled ? (loop.running ? bold("running") : "on") : dim("paused");
        const when_ = loop.schedule === "never" ? "only when woken" : `${loop.schedule}${loop.tz !== "UTC" ? ` (${loop.tz})` : ""}`;
        console.log(`  ${bold(loop.name.padEnd(16))} ${state.padEnd(tty ? 7 : 7)}  ${when_} on ${loop.onName ?? loop.on.slice(0, 12)}`);
        console.log(`  ${" ".repeat(16)} ${dim(describeTask(loop.task))}${loop.problem ? `  ${bold(loop.problem)}` : ""}`);
        if (loop.wakes.length) console.log(`  ${" ".repeat(16)} ${dim(describeWakes(loop.wakes, loop.cooldownMs))}`);
        console.log(`  ${" ".repeat(16)} ${dim(`next ${loop.enabled ? when(loop.next) : "—"}`)}${loop.last ? dim(` · last ${MARK[loop.last.status]} ${loop.last.summary.split("\n")[0]!.slice(0, 80)}`) : ""}`);
      }
      return;
    }
    case "drafts": {
      const { drafts } = await api.call<{ drafts: LoopDraftView[] }>("loopDrafts");
      if (!drafts.length) console.log("No drafts. Ask Galahad in chat for something on a schedule, and his draft waits here for you.");
      for (const draft of drafts) {
        console.log(`  ${bold(draft.id)}  ${bold(draft.name)}: ${draft.schedule}${draft.tz !== "UTC" ? ` (${draft.tz})` : ""}${draft.on ? ` on ${draft.on}` : ""}${draft.replaces ? dim(" (replaces your loop of that name)") : ""}`);
        console.log(`  ${" ".repeat(draft.id.length)}  ${dim(describeTask(draft.task))}`);
        if (draft.wakes.length) console.log(`  ${" ".repeat(draft.id.length)}  ${dim(describeWakes(draft.wakes, draft.cooldownMs))}`);
        if (draft.why) console.log(`  ${" ".repeat(draft.id.length)}  ${dim(`why: ${draft.why}`)}`);
      }
      if (drafts.length) console.log(dim("Add one: galahad loop add --draft <id> · dismiss one: galahad loop dismiss <id>"));
      return;
    }
    case "dismiss": {
      if (!name) throw new Error("usage: galahad loop dismiss <draft id>");
      await api.call("dismissLoopDraft", { id: name });
      console.log("Dismissed. Nothing was added.");
      return;
    }
    case "add":
    case "set": {
      // A draft Galahad made when you asked in chat: added as he drafted it (where it runs may still be given).
      if (sub === "add" && str(flags, "draft")) {
        const { drafts } = await api.call<{ drafts: LoopDraftView[] }>("loopDrafts");
        const draft = drafts.find((d) => d.id === str(flags, "draft"));
        if (!draft) throw new Error(`no draft ${str(flags, "draft")} (it was added, dismissed, or a week went by): galahad loop drafts`);
        const on = str(flags, "on") ?? draft.on;
        const { loop, hookSecret } = await api.call<{ loop: LoopView; hookSecret?: string }>("setLoop", {
          name: draft.name,
          schedule: draft.schedule,
          tz: draft.tz,
          task: draft.task,
          ...(draft.wakes.length ? { wakes: draft.wakes } : {}),
          ...(draft.cooldownMs ? { cooldownMs: draft.cooldownMs } : {}),
          ...(on ? { on } : {}),
          ...(draft.label ? { label: draft.label } : {}),
          draft: draft.id,
        });
        printSet(loop, hookSecret);
        return;
      }
      if (!name) throw new Error(`usage: galahad loop ${sub} <name> (--every 30m | --cron "0 7 * * *" | --at "2026-11-25 09:00" | --in 2h | --wake …) [--tz Zone] [--on node] (--heartbeat | --quest "goal" | --call connector.tool [--arg k=v] | --tell)`);
      const every = str(flags, "every");
      const cron = str(flags, "cron");
      const at = str(flags, "at");
      const later = str(flags, "in");
      if ([every, cron, at, later].filter((given) => given !== undefined).length > 1) throw new Error("give one of --every, --cron, --at or --in");
      const wakes = flags["no-wakes"] ? [] : list(flags, "wake").length ? list(flags, "wake").map(parseWake) : undefined;
      // Once (a reminder, a look later): at a time in your zone, this terminal's unless --tz says another.
      const tz = str(flags, "tz") ?? (at !== undefined || later !== undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : undefined);
      const once = at !== undefined ? `at ${at}` : later !== undefined ? `at ${wallIn(later, tz!, (opts.now ?? Date.now)())}` : undefined;
      // Something to wake it and no schedule: it runs only when woken.
      const schedule = every ? `every ${every}` : (cron ?? once ?? (sub === "add" && wakes?.length ? "never" : undefined));
      const task = await taskFrom(api, flags);
      if (sub === "add" && (!schedule || !task)) throw new Error("a new loop needs --every, --cron, --at, --in or something to wake it (--wake), and --heartbeat, --quest, --call or --tell");
      const cooldownMs = cooldownFrom(flags);
      const { loop, hookSecret } = await api.call<{ loop: LoopView; hookSecret?: string }>("setLoop", {
        name,
        ...(schedule ? { schedule } : {}),
        ...(tz ? { tz } : {}),
        ...(str(flags, "on") ? { on: str(flags, "on") } : {}),
        ...(task ? { task } : {}),
        ...(wakes ? { wakes } : {}),
        ...(cooldownMs ? { cooldownMs } : {}),
        ...(str(flags, "label") ? { label: str(flags, "label") } : {}),
      });
      printSet(loop, hookSecret);
      return;
    }
    case "hook": {
      if (!name) throw new Error("usage: galahad loop hook <name>   (a new secret for its webhook; the old one stops working)");
      const hook = await api.call<{ path: string; node: string; secret: string }>("loopHook", { name });
      printHook(hook.path, hook.secret, hook.node);
      return;
    }
    case "pause":
    case "resume": {
      if (!name) throw new Error(`usage: galahad loop ${sub} <name>`);
      await api.call("setLoop", { name, enabled: sub === "resume" });
      console.log(sub === "pause" ? `Paused ${name}.` : `Resumed ${name}.`);
      return;
    }
    case "rm": {
      if (!name) throw new Error("usage: galahad loop rm <name>");
      await api.call("removeLoop", { name });
      console.log(`Removed ${name}. Its runs stay in the mind's history.`);
      return;
    }
    case "run": {
      if (!name) throw new Error("usage: galahad loop run <name>");
      const result = await api.call<{ run: string; node: string }>("runLoop", { name });
      console.log(`Started ${name} on ${result.node} (run ${result.run}). See it with: galahad loop runs ${name}`);
      return;
    }
    case "runs": {
      const { runs } = await api.call<{ runs: LoopRunView[] }>("loopRuns", { ...(name ? { name } : {}), limit: Number(str(flags, "limit") ?? 10) });
      if (!runs.length) console.log(name ? `${name} hasn't run yet.` : "No loop has run yet.");
      for (const run of runs.reverse()) printRun(run, name ? undefined : run.loop);
      return;
    }
    default:
      throw new Error("usage: galahad loop ls | add | set | pause | resume | rm | run | runs | hook | drafts | dismiss");
  }
}

/** `galahad self-action [on|off]`: whether he fixes what's safe himself after each heartbeat, and what he fixed. */
export async function selfActionCommand(api: Api, sub: string | undefined): Promise<void> {
  if (sub !== undefined && sub !== "on" && sub !== "off") throw new Error("usage: galahad self-action [on|off]");
  const view = sub ? await api.call<SelfActionView>("setSelfAction", { on: sub === "on" }) : await api.call<SelfActionView>("selfAction");
  console.log(`Self-action is ${bold(view.on ? "on" : "off")}${view.heartbeats.length ? dim(` (after each run of ${view.heartbeats.join(", ")})`) : dim(" (there's no heartbeat loop for it to follow)")}.`);
  console.log(view.on ? "After each heartbeat Galahad fixes these himself, and asks you about everything else:" : "Galahad only reports; these would wait for you too:");
  for (const a of view.allowlist) console.log(`  ${bold(a.kind.padEnd(16))} ${dim(`${a.class}: ${a.why}`)}`);
  if (view.recent.length) {
    console.log("\nWhat he fixed lately:");
    for (const e of view.recent.slice(0, 10)) console.log(`  ${dim(new Date(Number(e.hlc.slice(0, 15))).toLocaleString())} ${e.reason?.startsWith("Galahad's own fix didn't") ? "✗" : "✓"} ${e.detail ?? e.target}`);
  }
}

export async function heartbeatCommand(api: Api): Promise<void> {
  const { node, findings } = await api.call<{ node: string; findings: FindingView[] }>("heartbeat", {});
  if (!findings.length) console.log(`✓ All quiet, as seen from ${node}.`);
  for (const f of findings) console.log(`  ${MARK[f.severity]} ${bold(f.title)}\n      ${f.body}`);
}

export async function noticeCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  if (sub === "dismiss") {
    if (!rest[0]) throw new Error("usage: galahad notice dismiss <key>");
    await api.call("dismissNotice", { key: rest[0] });
    console.log("Dismissed. It stays quiet until it changes.");
    return;
  }
  const { notices } = await api.call<{ notices: NoticeView[] }>("notices");
  const shown = flags.all ? notices : notices.filter((n) => !n.dismissed);
  if (!shown.length) console.log("Nothing needs you.");
  for (const n of shown) console.log(`  ${MARK[n.severity]} ${bold(n.title)}${n.dismissed ? dim(" (dismissed)") : ""}  ${dim(n.key)}\n      ${n.body}`);
}

/** How long `connector signin` waits for you to finish signing in at the provider's page. */
const SIGN_IN_WAIT_MS = 10 * 60_000;

export async function connectorCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags, readHidden?: (prompt: string) => Promise<string>, sleep: (ms: number) => Promise<void> = Bun.sleep): Promise<void> {
  switch (sub) {
    case undefined:
    case "ls": {
      const { connectors } = await api.call<{ connectors: ConnectorView[] }>("connectors");
      for (const c of connectors) {
        const key = c.oauth
          ? c.key === "ready"
            ? `signed in${c.oauth.account ? ` as ${c.oauth.account}` : ""} ✓`
            : c.oauth.provider === "mcp"
              ? // A hosted MCP server's own sign-in: no app of yours.
                `not signed in: galahad connector signin ${c.id} --redirect <your app's address>/oauth/callback`
              : c.key === "signed-out"
                ? `not signed in: galahad connector signin ${c.id}`
                : `needs your app: galahad connector app ${c.id}`
          : ({ "none-needed": "no key needed", ready: "key ✓", missing: "needs a key", "optional-missing": "no key (public only)", "wrong-origin": "key pinned elsewhere" }[c.key] ?? c.key);
        console.log(`  ${bold(c.id.padEnd(16))} ${(c.installed ? "installed" : dim("available")).padEnd(tty ? 18 : 9)} ${c.origin ?? dim("(your address)")}  ${c.installed ? key : ""}`);
        if (c.problem) console.log(`      ${bold(c.problem)}`);
      }
      console.log(dim("\n  galahad connector add <id> · galahad connector tools <id> · galahad connector call <id>.<tool> --arg k=v"));
      const { requests } = await api.call<{ requests: ConnectorRequestView[] }>("connectorRequests").catch(() => ({ requests: [] as ConnectorRequestView[] }));
      if (requests.length) console.log(bold(`  ${requests.length} asked for by an agent: galahad connector requests`));
      return;
    }
    case "library": {
      // The library of hosted MCP servers: Galahad's reviewed list and the index at mcp.galahad.sh, searched.
      const words = rest.join(" ").trim();
      const asked = str(flags, "auth");
      const auth = asked === undefined ? undefined : ({ "sign-in": "oauth", signin: "oauth", oauth: "oauth", key: "key", open: "none", none: "none" } as Record<string, string>)[asked];
      if (asked !== undefined && !auth) throw new Error("--auth is sign-in, key or open");
      const page = await api.call<ConnectorLibraryView>("connectorLibrary", {
        ...(words ? { q: words } : {}),
        ...(auth ? { auth } : {}),
        ...(str(flags, "category") ? { category: str(flags, "category") } : {}),
        ...(str(flags, "sort") ? { sort: str(flags, "sort") } : {}),
        limit: Math.min(100, Number(str(flags, "limit") ?? 30)),
      });
      if (!page.entries.length) console.log(words ? `Nothing in the library matches "${words}".` : "The library is empty.");
      for (const e of page.entries) {
        const how = e.auth === "oauth" ? "sign in" : e.auth === "key" ? "a key" : "open";
        console.log(`  ${bold(e.id.padEnd(28))} ${how.padEnd(8)} ${e.label}${e.reviewed ? dim(" · reviewed") : ""}${e.installed ? dim(" · installed") : ""}`);
        console.log(`  ${" ".repeat(28)} ${dim(`${e.category} · ${new URL(e.url).host}${e.description ? ` · ${e.description.length > 90 ? `${e.description.slice(0, 89)}…` : e.description}` : ""}`)}`);
      }
      console.log(dim(`\n  ${page.total} in all${page.total > page.entries.length ? `, ${page.entries.length} shown (--limit)` : ""}. Add one: galahad connector add <id>`));
      if (page.index.problem) console.log(dim(`  The index couldn't be read: ${page.index.problem}. The reviewed list is still here.`));
      else if (page.index.url && page.index.fetched === null) console.log(dim("  The index is being read for the first time: ask again in a moment."));
      return;
    }
    case "requests": {
      const { requests } = await api.call<{ requests: ConnectorRequestView[] }>("connectorRequests");
      if (!requests.length) console.log("No agent is asking for a connector. When one needs a service it doesn't have, its request waits here.");
      for (const request of requests) {
        const pad = " ".repeat(request.id.length);
        console.log(`  ${bold(request.id)}  ${bold(request.label ?? request.connector)}, ${request.access ? `${request.by} asks to use it` : `asked by ${request.by}`}`);
        console.log(`  ${pad}  ${dim(`why: ${request.why}`)}`);
        const how = request.access
          ? `let them: galahad connector allow ${request.connector} ${request.agent}`
          : request.label
            ? `add it: galahad connector add ${request.connector}`
            : `not one Galahad ships: add it as an MCP server (galahad connector add ${request.connector} --mcp <url>) or from a manifest`;
        console.log(`  ${pad}  ${dim(how)}`);
      }
      if (requests.length) console.log(dim("Dismiss one: galahad connector dismiss <id>"));
      return;
    }
    case "allow":
    case "disallow": {
      if (!rest[0] || !rest[1]) throw new Error(`usage: galahad connector ${sub} <id> <agent> (an agent's label, as galahad connector requests shows it)`);
      const { connector } = await api.call<{ connector: ConnectorView }>("setConnectorAccess", { id: rest[0], agent: rest[1], allow: sub === "allow" });
      console.log(sub === "allow" ? `${rest[1]} may use ${connector.label} now.` : `${rest[1]} may not use ${connector.label} any more: it asks first.`);
      return;
    }
    case "app": {
      // The app you registered with Google or Microsoft: its client id, and Google's secret, typed hidden.
      const [id] = rest;
      const client = str(flags, "client-id");
      if (!id || !client) throw new Error("usage: galahad connector app <id> --client-id <id> (Google's secret is asked for, hidden)");
      const c = (await api.call<{ connectors: ConnectorView[] }>("connectors")).connectors.find((x) => x.id === id && x.installed);
      if (!c?.oauth) throw new Error(`${id} isn't an installed connector that signs in`);
      const secret = c.oauth.provider === "google" ? await (readHidden ?? (() => Promise.reject(new Error("no way to ask for the secret here"))))("Its client secret (hidden): ") : undefined;
      const { connector } = await api.call<{ connector: ConnectorView }>("setOAuthApp", { connector: id, client, ...(secret ? { secret } : {}) });
      console.log(`Sealed ${connector.label}'s app. Sign in: galahad connector signin ${id}${c.oauth.provider === "google" ? " --redirect <your app's address>/oauth/callback" : ""}`);
      return;
    }
    case "signin": {
      const [id] = rest;
      if (!id) throw new Error("usage: galahad connector signin <id> [--redirect <your app's address>/oauth/callback] (Google returns there)");
      const redirect = str(flags, "redirect");
      const started = await api.call<{ flow: "code"; url: string } | { flow: "device"; code: string; url: string; expires: number }>("oauthStart", { connector: id, ...(redirect ? { redirect } : {}) });
      if (started.flow === "code") console.log(`Open this page, choose your account and allow it:\n  ${started.url}\nIt comes back to ${redirect}, which says when you're signed in.`);
      else console.log(`Open ${started.url} and type the code ${bold(started.code)}. This waits while you do.`);
      // Watched until it's done (or the wait ends): its card says when it's signed in, and as whom.
      for (const until = Date.now() + SIGN_IN_WAIT_MS; Date.now() < until; await sleep(3000)) {
        const c = (await api.call<{ connectors: ConnectorView[] }>("connectors")).connectors.find((x) => x.id === id);
        if (c?.key === "ready") {
          console.log(`Signed in${c.oauth?.account ? ` as ${c.oauth.account}` : ""}.`);
          return;
        }
      }
      throw new Error("Not signed in yet, and this stopped waiting: galahad connector ls says when it is");
    }
    case "signout": {
      if (!rest[0]) throw new Error("usage: galahad connector signout <id>");
      const { connector } = await api.call<{ connector: ConnectorView }>("oauthSignOut", { connector: rest[0] });
      console.log(
        connector.oauth?.provider === "mcp"
          ? `Signed out of ${connector.label}. Sign in again with galahad connector signin ${connector.id} --redirect <your app's address>/oauth/callback.`
          : `Signed out of ${connector.label}. The app you registered stays; sign in again with galahad connector signin ${connector.id}.`,
      );
      return;
    }
    case "dismiss": {
      if (!rest[0]) throw new Error("usage: galahad connector dismiss <request id> (galahad connector requests lists them)");
      await api.call("dismissConnectorRequest", { id: rest[0] });
      console.log("Dismissed. Nothing was added.");
      return;
    }
    case "add": {
      const file = str(flags, "manifest");
      if (file) {
        const manifest = JSON.parse(readFileSync(file, "utf8")) as { id?: string };
        const { connector } = await api.call<{ connector: ConnectorView }>("setConnector", { id: manifest.id ?? rest[0], manifest });
        console.log(`Installed ${connector.label} (${connector.tools.length} tools) for ${connector.origin}.`);
        if (connector.secret && connector.key !== "ready") console.log(`Its key: galahad secret set ${connector.secret} --connector ${connector.id}`);
        return;
      }
      const mcp = str(flags, "mcp");
      if (mcp) {
        const id = str(flags, "id") ?? rest[0] ?? new URL(mcp).hostname.split(".").filter((p) => !["mcp", "api", "www"].includes(p))[0]?.replace(/[^a-z0-9-]/g, "-");
        if (!id) throw new Error("give it an id: galahad connector add <id> --mcp <url>");
        const auth = str(flags, "auth");
        const { connector, discovered } = await api
          .call<{ connector: ConnectorView; discovered: Parameters<typeof printDiscovered>[1] }>("setConnector", {
            id,
            mcp: {
              url: mcp,
              ...(str(flags, "label") ? { label: str(flags, "label") } : {}),
              ...(auth ? { auth: auth.startsWith("header") ? "header" : auth, ...(auth.startsWith("header:") ? { header: auth.slice(7) } : {}) } : {}),
              ...(str(flags, "only") ? { only: str(flags, "only")!.split(",").filter(Boolean) } : {}),
              ...(classFlags(flags) ? { classes: classFlags(flags) } : {}),
            },
          })
          .catch((error: Error) => {
            if (/wants a key or a sign-in/.test(error.message)) error.message += ` (here: --auth bearer, --auth header:<name>, or --auth oauth)`;
            throw error;
          });
        printDiscovered(connector, discovered);
        return;
      }
      if (!rest[0]) throw new Error("usage: galahad connector add <id> [--origin url] [--owner org] | --manifest file.json | --mcp <url>");
      const owner = str(flags, "owner");
      if (owner && rest[0] !== "github") throw new Error("--owner goes with github: one more GitHub owner, with its own token");
      if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw new Error("--owner is a GitHub user or organization name");
      // One more GitHub owner (a token per organization): the catalog's manifest under github-<owner>, with its own key.
      const own = owner ? `github-${owner.toLowerCase()}` : null;
      const { connector, discovered } = await api.call<{ connector: ConnectorView; discovered?: Parameters<typeof printDiscovered>[1] }>(
        "setConnector",
        own
          ? {
              id: own,
              manifest: {
                ...structuredClone(CATALOG.github!.manifest),
                id: own,
                label: `GitHub (${owner})`,
                description: `GitHub, with the token for ${owner}. ${CATALOG.github!.manifest.description ?? ""}`.trim(),
                auth: { secret: own, scheme: "bearer" },
              },
            }
          : { id: rest[0], ...(str(flags, "origin") ? { origin: str(flags, "origin") } : {}) },
      );
      if (discovered) {
        // A hosted MCP server from the library (core mcp-library.ts): its tools as listed, or its sign-in next.
        printDiscovered(connector, discovered);
        return;
      }
      console.log(`Installed ${connector.label} (${connector.tools.length} tools) for ${connector.origin}.`);
      if (connector.oauth) {
        // It signs in as you: the app you registered, then your sign-in (docs/MAIL.md for mail).
        console.log(`It signs in as you: galahad connector app ${connector.id} --client-id <id>, then galahad connector signin ${connector.id}${connector.keyHelp ? dim(`\n  (${connector.keyHelp})`) : ""}`);
      } else if (connector.secret && connector.key !== "ready") {
        console.log(`Its key${connector.key === "optional-missing" ? " (optional; public reads work without it)" : ""}: galahad secret set ${connector.secret} --connector ${connector.id}${connector.keyHelp ? dim(`\n  (${connector.keyHelp})`) : ""}`);
      }
      return;
    }
    case "refresh": {
      const { connectors } = await api.call<{ connectors: ConnectorView[] }>("connectors");
      const c = connectors.find((x) => x.id === rest[0] && x.installed);
      if (!c?.url) throw new Error(`usage: galahad connector refresh <id> (an installed MCP server)`);
      const { connector, discovered } = await api.call<{ connector: ConnectorView; discovered: Parameters<typeof printDiscovered>[1] }>("setConnector", {
        id: c.id,
        mcp: {
          url: c.url,
          ...(str(flags, "only") ? { only: str(flags, "only")!.split(",").filter(Boolean) } : {}),
          ...(classFlags(flags) ? { classes: classFlags(flags) } : {}),
        },
      });
      printDiscovered(connector, discovered);
      return;
    }
    case "rm": {
      if (!rest[0]) throw new Error("usage: galahad connector rm <id>");
      await api.call("removeConnector", { id: rest[0] });
      console.log(`Removed ${rest[0]}. Its key stays in the vault until you remove it.`);
      return;
    }
    case "tools": {
      // One tool named: that one whole, as its server defines it now.
      const [id, named] = rest[1] ? [rest[0], rest[1]] : (rest[0] ?? "").split(/\.(.+)/);
      if (id && named) {
        const t = await api.call<ConnectorToolDefinition>("connectorTool", { connector: id, tool: named });
        console.log(`  ${bold(`${t.connector}.${t.tool}`)}  ${t.asks ? bold(`(${t.class}: asks you)`) : dim(`(${t.class})`)}${t.changed ? `\n  ${bold("It differs on its server now from what you installed:")} galahad connector refresh ${t.connector} shows how.` : ""}`);
        console.log(`\n${t.description}\n\n${JSON.stringify(t.input, null, 2)}`);
        return;
      }
      const { connectors } = await api.call<{ connectors: ConnectorView[] }>("connectors");
      const c = connectors.find((x) => x.id === rest[0]);
      if (!c) throw new Error(`no connector "${rest[0]}"`);
      if (c.url) console.log(dim(`  MCP server ${c.url}: tool descriptions come from the server (untrusted text)`));
      for (const t of c.tools) {
        const params = Object.entries(t.params).map(([k, p]) => `${p.required ? k : `[${k}]`}${p.type !== "string" ? `:${p.type}` : ""}`).join(" ");
        console.log(`  ${bold(`${c.id}.${t.name}`)} ${params}  ${t.asks ? bold(`(${t.class}: asks you)`) : dim(`(${t.class})`)}\n      ${t.description}`);
      }
      return;
    }
    case "call": {
      const [connector, ...toolParts] = (rest[0] ?? "").split(".");
      const tool = toolParts.join(".");
      if (!connector || !tool) throw new Error("usage: galahad connector call <id>.<tool> [--arg key=value …]");
      const args = await toolArgs(api, connector, tool, flags);
      const outcome = await api.call<{
        status: string;
        action?: string;
        target: string;
        order?: { label: string };
        result?: { ok: boolean; status: number; body: string; truncated: boolean; mcp?: boolean };
      }>("callConnector", {
        connector,
        tool,
        args,
        ...(str(flags, "why") ? { why: str(flags, "why") } : {}),
      });
      if (outcome.status === "asked") {
        console.log(`Filed for approval: action ${outcome.action}.`);
        return;
      }
      const result = outcome.result!;
      if (outcome.order) console.error(dim(`Sent under your standing order "${outcome.order.label}".`));
      console.error(dim(`${outcome.target} → ${result.mcp ? (result.ok ? "ok" : "tool error") : result.status}${result.truncated ? " (truncated)" : ""}`));
      let body = result.body;
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not JSON */
      }
      console.log(body);
      return;
    }
    default:
      throw new Error("usage: galahad connector ls | add | refresh | rm | tools | call | requests | dismiss | allow | disallow");
  }
}

export async function actionCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  if (sub === "approve" || sub === "deny") {
    if (!rest[0]) throw new Error(`usage: galahad action ${sub} <id> [--note text]${sub === "approve" ? " [--edit key=text …]" : ""}`);
    // Your own words in its text, before your yes: --edit text="Hello, world" (each a text it already has).
    const edits: Record<string, string> = {};
    for (const pair of list(flags, "edit")) {
      const at = pair.indexOf("=");
      if (at < 1) throw new Error(`--edit takes key=text, not "${pair}"`);
      edits[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const edited = Object.keys(edits).length > 0;
    if (edited && sub !== "approve") throw new Error("an edit goes with a yes: galahad action approve <id> --edit key=text");
    const { action } = await api.call<{ action: ActionView }>("decideAction", { id: rest[0], approve: sub === "approve", ...(str(flags, "note") ? { note: str(flags, "note") } : {}), ...(edited ? { edits } : {}) });
    console.log(sub === "approve" ? `Approved${edited ? ` as you edited it (sent as ${action.id})` : ""}: ${action.target}. The node that asked sends it once.` : "Declined. Nothing was sent.");
    return;
  }
  const { actions } = await api.call<{ actions: ActionView[] }>("actions");
  // An approval that expired unsent shows for a week: you approved it, and it didn't happen.
  const recent = (a: ActionView) => a.state === "lapsed" && a.sendBy !== null && a.sendBy > Date.now() - 7 * 24 * 60 * 60_000;
  const shown = flags.all ? actions : actions.filter((a) => a.state === "waiting" || a.state === "approved" || recent(a));
  if (!shown.length) console.log(flags.all ? "No actions yet." : "Nothing is waiting for you. (--all shows history)");
  for (const a of shown) {
    const state = a.state === "lapsed" ? "expired" : a.state;
    console.log(`  ${bold(a.id)}  ${state.padEnd(8)} ${a.class.padEnd(7)} ${a.connector}.${a.tool}  ${dim(`asked by ${a.by}`)}`);
    if (a.state === "lapsed") console.log(dim(`      your approval expired ${new Date(a.sendBy!).toISOString()} before the node that asked could send it: never sent`));
    if (a.state === "approved" && a.sendBy !== null) console.log(dim(`      sent by ${new Date(a.sendBy).toISOString()} or never`));
    const answered = a.order ? dim(`  · answered by your standing order "${a.order.label}"`) : a.self ? dim(`  · ${a.note ?? "Galahad approved it himself"}`) : "";
    console.log(`      ${a.target}${a.why ? dim(`  · ${a.why}`) : ""}${answered}${a.receipt ? `\n      ${dim(a.receipt.slice(0, 200))}` : ""}`);
  }
  if (shown.some((a) => a.state === "waiting")) {
    console.log(dim("\n  galahad action approve <id> · galahad action deny <id> · galahad order add --from <id>  (approve, and answer the same way next time)"));
  }
}

const ORDER_STATE: Record<OrderView["state"], string> = { active: "active", expired: "expired", revoked: "revoked", stale: "stale: the tool changed since you signed" };

export function describeOrder(o: Pick<OrderView, "connector" | "tool" | "args" | "callers">): string {
  const args = Object.entries(o.args).map(([k, v]) => `${k}=${v}`).join(" ");
  return `${o.connector}.${o.tool}${args ? ` ${args}` : ""}${o.callers ? ` · only ${o.callers.join(", ")}` : " · any of Galahad's agents"}`;
}

/** Standing orders: your answers given in advance, narrow and expiring. */
export async function orderCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  switch (sub) {
    case undefined:
    case "ls": {
      const { orders } = await api.call<{ orders: OrderView[] }>("orders");
      const shown = flags.all ? orders : orders.filter((o) => o.state === "active" || o.state === "stale");
      if (!shown.length) console.log(flags.all ? "No standing orders yet." : "No standing orders: everything outward or deleting asks you. (--all shows old ones)");
      for (const o of shown) {
        console.log(`  ${bold(o.id)}  ${o.class.padEnd(7)} ${bold(o.label)}  ${dim(ORDER_STATE[o.state])}`);
        console.log(`      ${describeOrder(o)}`);
        console.log(dim(`      until ${new Date(o.until).toLocaleDateString()} · used ${o.uses}× ${o.lastUsed ? `(last ${when(o.lastUsed)})` : ""}`));
      }
      if (shown.length) console.log(dim("\n  galahad order revoke <id>"));
      return;
    }
    case "add": {
      const from = str(flags, "from");
      let connector: string;
      let tool: string;
      let args: Record<string, string> = {};
      if (from) {
        // Start from a request that waits for you: the same call, pinned exactly; loosen with --arg key=pattern.
        const { actions } = await api.call<{ actions: ActionView[] }>("actions");
        const action = actions.find((a) => a.id === from);
        if (!action) throw new Error(`no action ${from}`);
        connector = action.connector;
        tool = action.tool;
        args = Object.fromEntries(Object.entries(action.args).map(([k, v]) => [k, String(v)]));
      } else {
        const ref = rest[0] ?? "";
        const dot = ref.indexOf(".");
        if (dot < 1) throw new Error('usage: galahad order add <connector>.<tool> --arg key=pattern … [--for loop.name] [--days 30] --label "…"');
        connector = ref.slice(0, dot);
        tool = ref.slice(dot + 1);
      }
      for (const pair of list(flags, "arg")) {
        const at = pair.indexOf("=");
        if (at < 1) throw new Error(`--arg takes key=pattern, not "${pair}"`);
        args[pair.slice(0, at)] = pair.slice(at + 1);
      }
      for (const key of list(flags, "free")) delete args[key];
      const days = str(flags, "days");
      const callers = list(flags, "for");
      const label = str(flags, "label") ?? `${connector}.${tool}`;
      const { order, action } = await api.call<{ order: OrderView; action?: ActionView }>("setOrder", {
        connector,
        tool,
        args,
        label,
        ...(callers.length ? { callers } : {}),
        ...(days ? { days: Number(days) } : {}),
        ...(from ? { approve: from } : {}),
      });
      console.log(`Signed ${bold(order.id)}: ${describeOrder(order)}, until ${new Date(order.until).toLocaleDateString()}.`);
      if (action) console.log(`Approved ${action.target}: the node that asked sends it once.`);
      console.log(dim("Calls it covers go out without asking (each is still in your inbox and the ledger). galahad order revoke <id> ends it."));
      return;
    }
    case "revoke":
    case "rm": {
      if (!rest[0]) throw new Error("usage: galahad order revoke <id>");
      const { order } = await api.call<{ order: OrderView }>("revokeOrder", { id: rest[0] });
      console.log(`Revoked "${order.label}". Those calls ask you again.`);
      return;
    }
    default:
      throw new Error("usage: galahad order ls [--all] | order add … | order revoke <id>");
  }
}

/** One line for `galahad status`: loops, and what needs you, every kind the apps' Inbox holds, each with where to answer it. */
export async function statusLine(api: Api): Promise<void> {
  // How many of a route's list wait for you (none from a node too old to have the route).
  const waiting = <T>(route: RouteName, list: (body: any) => T[], open: (item: T) => boolean = () => true): Promise<number> =>
    api.call(route).then((body) => list(body).filter(open).length).catch(() => 0);
  const [loops, ...counts] = await Promise.all([
    api.call<{ loops: LoopView[] }>("loops").then((r) => r.loops).catch(() => [] as LoopView[]),
    waiting<NoticeView>("notices", (b) => b.notices, (n) => !n.dismissed),
    waiting<ActionView>("actions", (b) => b.actions, (a) => a.state === "waiting"),
    waiting("secretRequests", (b) => b.requests),
    waiting("pairings", (b) => b.pairings),
    waiting("aboutYou", (b) => b.proposed),
    waiting("loopDrafts", (b) => b.drafts),
    waiting("connectorRequests", (b) => b.requests),
    waiting<{ state: string }>("screenSessions", (b) => b.sessions, (s) => s.state === "waiting"),
    waiting("turns", (b) => b.unread ?? []),
  ]);
  const said = (n: number, one: string, many: string, where = "") => `${n} ${n === 1 ? one : many}${where ? ` (${where})` : ""}`;
  const [notices, actions, keys, pairings, facts, drafts, connectors, screens, unread] = counts as number[];
  const needs = [
    notices ? said(notices, "notice", "notices") : "",
    actions ? said(actions, "waiting for your answer", "waiting for your answer", "galahad action ls") : "",
    keys ? said(keys, "key asked for", "keys asked for", "galahad secret list") : "",
    pairings ? said(pairings, "device asking to join", "devices asking to join", "galahad pairings") : "",
    facts ? said(facts, "fact to keep", "facts to keep", "galahad about") : "",
    drafts ? said(drafts, "loop drafted", "loops drafted", "galahad loop drafts") : "",
    connectors ? said(connectors, "connector asked for", "connectors asked for", "galahad connectors requests") : "",
    screens ? said(screens, "ask to use a Mac", "asks to use a Mac", "galahad screen sessions") : "",
  ].filter(Boolean);
  const beat = loops.find((l) => l.name === "heartbeat")?.last;
  const parts = [
    `${loops.length} loop${loops.length === 1 ? "" : "s"}`,
    beat ? `heartbeat ${MARK[beat.status]} ${new Date(beat.finished).toLocaleTimeString()}` : "no heartbeat yet",
    ...(needs.length ? needs.map(bold) : ["nothing needs you"]),
    // His answers you haven't read: news, not something that needs you.
    ...(unread ? [said(unread, "new answer", "new answers", "galahad chats")] : []),
  ];
  console.log(`\n  ${parts.join(" · ")}`);
}
