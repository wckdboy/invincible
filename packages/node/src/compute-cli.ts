import type { Calibration, ComputeLimit, ComputeNodeView, ComputeView, EffortAsk, NodeCapacity, RouteName } from "@galahad/core";

/*
 * The terminal side of compute. Thin: every rule lives in the node (and the pure
 * functions of packages/core/src/compute.ts); this shapes input and prints.
 *
 *   galahad compute                          the census: what each node measured, its ceiling, slots in use and
 *                                            waiting, his plan, the day's budget, what more compute would buy
 *   galahad compute calibrate [node]         a node measures itself now
 *   galahad compute limit <node> [--cores n] [--mem gb] [--sandboxes n] [--model-calls n] [--reset]
 *   galahad compute effort [auto|1|2|3] [--budget n]
 */

export interface ComputeApi {
  call<T = any>(name: RouteName, input?: unknown): Promise<T>;
}

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const str = (flags: Flags, key: string) => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const one = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** "3 days ago", "just now". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** What a node measured, in a line. */
export function measuredLine(c: Calibration, capacity: NodeCapacity | null): string {
  const parts = [`${one(capacity?.strength ?? 0)} reference cores' worth on ${plural(c.cpu.threads, "thread")}${capacity?.speed ? ` (one thread: ${capacity.speed.toFixed(2)}× the reference)` : ""}`];
  if (c.memoryGbps !== undefined) parts.push(`memory ${one(c.memoryGbps)} GB/s`);
  if (c.disk) parts.push(`disk ${c.disk.writeMbps.toLocaleString("en")} MB/s written, ${c.disk.readMbps.toLocaleString("en")} read`);
  for (const s of c.sandbox ?? []) parts.push(`a ${s.kind === "vm" ? "microVM" : "container"} sandbox ready in ${seconds(s.startMs)}`);
  for (const m of c.models ?? []) parts.push(`${m.runtime}/${m.model} ${one(m.tps)} tokens/s`);
  return parts.join(" · ");
}

/** The owner's ceiling in words, or that it's the default. */
export function limitLine(limit: ComputeLimit | null): string {
  if (!limit) return "the defaults (half of the machine)";
  const parts: string[] = [];
  if (limit.cores !== undefined) parts.push(plural(limit.cores, "thread"));
  if (limit.memoryGb !== undefined) parts.push(`${limit.memoryGb} GB`);
  if (limit.sandboxes !== undefined) parts.push(plural(limit.sandboxes, "sandbox", "sandboxes"));
  if (limit.modelCalls !== undefined) parts.push(plural(limit.modelCalls, "model call"));
  return `yours: ${parts.join(", ")}`;
}

const bar = (used: number, of: number): string => (of > 0 && of <= 24 ? `${"█".repeat(Math.min(used, of))}${"░".repeat(Math.max(0, of - used))} ` : "");

function nodeLines(n: ComputeNodeView, now: number): string[] {
  const lines = [`${bold(n.name)} ${dim(`${n.self ? "this node" : n.online ? "online" : "offline"}${n.due ? ` · due to measure itself (${n.due === "joined" ? "it never has" : "its body, its ceiling or the benchmark changed"})` : ""}`)}`];
  if (!n.body || !n.capacity) return [...lines, dim("  no capability profile yet")];
  lines.push(`  measured  ${n.calibration ? `${measuredLine(n.calibration, n.capacity)} ${dim(`· ${ago(n.calibration.at, now)}`)}` : dim(`not yet: galahad compute calibrate ${n.name}`)}`);
  lines.push(`  ceiling   ${n.capacity.cores} of ${n.body.cores} threads and ${n.capacity.memoryGb} of ${Math.round(n.body.memoryGb)} GB are his to use ${dim(`· ${limitLine(n.limit)}`)}`);
  const slots = n.capacity.sandboxes;
  const use = n.use;
  lines.push(
    `  slots     ${
      !n.body.sandboxHost
        ? dim("no sandboxes (not a sandbox host)")
        : use
          ? `${bar(use.sandboxes, slots)}${use.sandboxes} of ${plural(slots, "sandbox", "sandboxes")} in use${use.queued ? ` · ${bold(`${use.queued} waiting`)}` : ""}${use.kept ? dim(` · and ${plural(use.kept, "knight's VM", "knights' VMs")}, which take no slot`) : ""}`
          : `${plural(slots, "sandbox", "sandboxes")} ${dim("(in use: not known)")}`
    }${use ? ` · ${use.modelCalls} of ${plural(n.capacity.modelCalls, "model call")}${use.modelQueued ? ` (${use.modelQueued} waiting)` : ""}` : ` · ${plural(n.capacity.modelCalls, "model call")}`}`,
  );
  for (const q of n.queue) lines.push(dim(`            waiting: ${q.quest} (${q.cpus} threads, ${q.memoryGb} GB) since ${new Date(q.since).toLocaleTimeString()}: ${q.why}`));
  for (const reason of n.capacity.reasons) lines.push(dim(`            ${reason}`));
  return lines;
}

/** The census, as the terminal prints it. Pure. */
export function describeCompute(view: ComputeView, now = Date.now()): string {
  const hosts = view.nodes.filter((n) => n.capacity && n.capacity.sandboxes > 0);
  const slots = hosts.reduce((sum, n) => sum + n.capacity!.sandboxes, 0);
  const known = hosts.filter((n) => n.use);
  const inUse = known.reduce((sum, n) => sum + n.use!.sandboxes, 0);
  const waiting = known.reduce((sum, n) => sum + n.use!.queued, 0);
  const effort = view.policy.effort === "auto" ? `auto (up to ${view.plan.effort})` : String(view.policy.effort);
  const lines = [
    `${bold("Compute")} ${dim("what the fleet carries; he uses what he's given and acquires nothing")}`,
    `  ${inUse} of ${plural(slots, "sandbox slot")} in use${waiting ? ` · ${bold(`${waiting} waiting`)}` : " · nothing waiting"} · effort ${effort} · ${view.budget.usedToday} of ${plural(view.budget.perDay, "extra attempt")} used in the last day`,
    "",
  ];
  for (const n of view.nodes) lines.push(...nodeLines(n, now), "");
  if (view.work.length) {
    lines.push(bold("Work in hand"));
    for (const w of view.work) {
      lines.push(`  ${w.quest}  effort ${w.effort}${w.asked === "auto" ? " (auto)" : ""} ${dim(`· asked by ${w.by}`)}${w.label ? `  ${w.label}` : ""}`);
      for (const a of w.attempts) lines.push(dim(`    attempt ${a.index}  at the ${a.station.padEnd(11)} ${a.active ? a.doing : "between steps"}${a.model ? ` · ${a.model}` : ""}${a.sandbox ? ` · sandbox ${a.sandbox}` : ""}`));
    }
    lines.push("");
  }
  if (view.more.length) {
    lines.push(bold("What more compute would buy"));
    for (const m of view.more) lines.push(`  - ${m}`);
    lines.push("");
  }
  if (view.suggestions.length) {
    lines.push(`${bold("He suggests")} ${dim("(yours to decide: he installs, downloads and hires nothing himself)")}`);
    for (const s of view.suggestions) lines.push(`  - ${s.title.replace(/^Galahad suggests: /, "")}`, dim(`      ${s.body}`));
    lines.push("");
  }
  if (view.adapted) {
    lines.push(dim(`His defaults were last re-derived ${ago(view.adapted.at, now)}${view.adapted.changes.length ? `: ${view.adapted.changes.join(" ")}` : "."}`));
  } else lines.push(dim("His defaults aren't on record yet: his next heartbeat records them."));
  lines.push(dim("galahad compute calibrate [node] · galahad compute limit <node> --cores n --mem gb · galahad compute effort auto|1|2|3 --budget n"));
  return lines.join("\n");
}

const whole = (flags: Flags, key: string, min: number, max: number): number | undefined => {
  const raw = str(flags, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be a whole number from ${min} to ${max}`);
  return n;
};

/** --effort: auto, 1, 2 or 3 (undefined when absent). */
export function parseEffort(raw: string | undefined): EffortAsk | undefined {
  if (raw === undefined) return undefined;
  if (raw === "auto") return "auto";
  if (raw === "1" || raw === "2" || raw === "3") return Number(raw) as 1 | 2 | 3;
  throw new Error("--effort must be auto, 1, 2 or 3 (attempts at a quest at once)");
}

export async function computeCommand(api: ComputeApi, sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  switch (sub) {
    case undefined:
    case "status": {
      console.log(describeCompute(await api.call<ComputeView>("compute")));
      return;
    }
    case "calibrate": {
      const on = rest[0];
      console.log(dim(`[measuring ${on ?? "this node"}: a few seconds, at low priority, within its ceiling]`));
      const done = await api.call<{ node: string; calibration: Calibration; capacity: NodeCapacity }>("calibrateCompute", on ? { on } : {});
      console.log(`${bold(done.node)} measured ${measuredLine(done.calibration, done.capacity)} ${dim(`in ${seconds(done.calibration.tookMs)}`)}`);
      if (done.calibration.note) console.log(dim(`  ${done.calibration.note}`));
      console.log(`He counts ${plural(done.capacity.cores, "thread")}, ${done.capacity.memoryGb} GB: ${plural(done.capacity.sandboxes, "sandbox", "sandboxes")} and ${plural(done.capacity.modelCalls, "model call")} at once.`);
      return;
    }
    case "limit": {
      const node = rest[0];
      if (!node) throw new Error("usage: galahad compute limit <node> [--cores n] [--mem gb] [--sandboxes n] [--model-calls n] [--reset]");
      const cores = whole(flags, "cores", 1, 4096);
      const memoryGb = whole(flags, "mem", 1, 65_536);
      const sandboxes = whole(flags, "sandboxes", 0, 256);
      const modelCalls = whole(flags, "model-calls", 1, 256);
      const given = { ...(cores !== undefined ? { cores } : {}), ...(memoryGb !== undefined ? { memoryGb } : {}), ...(sandboxes !== undefined ? { sandboxes } : {}), ...(modelCalls !== undefined ? { modelCalls } : {}) };
      if (!flags.reset && !Object.keys(given).length) {
        const view = await api.call<ComputeView>("compute");
        const found = view.nodes.find((n) => n.name === node || n.id === node);
        if (!found) throw new Error(`no node "${node}"`);
        console.log(nodeLines(found, Date.now()).join("\n"));
        return;
      }
      const done = await api.call<{ node: string; limit: ComputeLimit; capacity: NodeCapacity | null }>("setComputeLimit", { node, ...given, ...(flags.reset ? { reset: true } : {}) });
      console.log(`${bold(done.node)}'s ceiling: ${limitLine(Object.keys(done.limit).length ? done.limit : null)}.`);
      if (done.capacity) console.log(`He counts ${plural(done.capacity.cores, "thread")}, ${done.capacity.memoryGb} GB: ${plural(done.capacity.sandboxes, "sandbox", "sandboxes")} and ${plural(done.capacity.modelCalls, "model call")} at once.${cores !== undefined || flags.reset ? dim(" It measures itself again for the new ceiling.") : ""}`);
      return;
    }
    case "effort": {
      const effort = parseEffort(rest[0]);
      const budget = whole(flags, "budget", 0, 500);
      const done =
        effort === undefined && budget === undefined
          ? await api.call<ComputeView>("compute").then((v) => ({ policy: v.policy, budget: v.budget }))
          : await api.call<{ policy: ComputeView["policy"]; budget: ComputeView["budget"] }>("setComputePolicy", { ...(effort !== undefined ? { effort } : {}), ...(budget !== undefined ? { attemptsPerDay: budget } : {}) });
      console.log(
        `Effort ${bold(String(done.policy.effort))}: ${
          done.policy.effort === "auto" ? "he runs as many attempts at a quest as the free slots and the budget allow, up to 3" : done.policy.effort === 1 ? "one attempt at a quest, unless you name more" : `up to ${done.policy.effort} attempts at a quest when he chooses`
        }.`,
      );
      console.log(`Budget: ${plural(done.budget.perDay, "extra attempt")} a day (${done.budget.usedToday} used in the last 24 hours). ${dim("A level you name yourself (galahad do --effort 3) stands whatever the budget.")}`);
      return;
    }
    default:
      throw new Error(`unknown compute command "${sub}" (calibrate, limit, effort)`);
  }
}
