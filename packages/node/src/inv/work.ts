import { type ActionView, type FleetView, moneyPrices, plainLine, plainText, type Prices, type ProjectView, type TeamRoom, type TeamSnapshot, type TeamTask, type TeamTrailEntry, type UsageView, moneyLabel } from "@invincible/core";
import { liveStep, stepGroups } from "../../../../apps/web/src/lib/steps.ts";
import { attended, projectsOfAgents, type WorkRow } from "../../../../apps/web/src/lib/work.ts";
import type { NodeClient } from "./client.ts";
import { Tracker, type InvEvent } from "./events.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import { follow, needsYou, type Update } from "./follow.ts";
import { type Command, type Flags, type Io, parseDuration, parseUsd, resolveTask } from "./io.ts";
import { ended, proofFor, type ProofJson } from "./proof.ts";
import { askLines, faint, liveLine, proofLines, rowLine, stepLine, taskLines, trailLines } from "./render.ts";
import { asksOf, askingAgent, rowJson, type Section, SECTIONS, waiting, workOf } from "./view.ts";
import { askView } from "./asks.ts";

/*
 * The work: inv give, again, tasks, watch, peek, proof and stop (docs/CLI.md, "Commands"). Giving returns at once with
 * the task's id unless asked to wait; following it shows its steps folded as they finish and one line for what it is
 * doing now, then its proof, and exits with the verdict. Ctrl-C only ever leaves.
 */

const print = (io: Io, lines: readonly string[]): void => {
  if (lines.length) io.out(`${lines.join("\n")}\n`);
};
const json = (io: Io, value: unknown): void => io.out(`${JSON.stringify(value)}\n`);

/** The row the apps would show for this one task (its word, its state), from the same snapshot. */
export function rowOf(task: TeamTask, snapshot: Pick<TeamSnapshot, "agents" | "seen">, actions: readonly ActionView[], projects: readonly ProjectView[], now: number): { row: WorkRow; section: Section } {
  const work = attended({ snapshot: { agents: snapshot.agents, tasks: [task], ...(snapshot.seen ? { seen: snapshot.seen } : {}) }, projects, asks: asksOf(actions), now });
  for (const section of SECTIONS) if (work[section][0]) return { row: work[section][0]!, section };
  throw new CliError(`${task.id} has no row`);
}

/** What the proof is told beside the task: where its agent's VM is, its project, and your prices. */
interface Around {
  prices: Prices;
  fleet: FleetView | null;
  projects: ProjectView[];
}

async function around(client: NodeClient): Promise<Around> {
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const [usage, fleet, projects] = await Promise.all([quiet(client.call<UsageView>("usage", { days: 1 })), quiet(client.call<FleetView>("fleet")), quiet(client.call<{ projects: ProjectView[] }>("projects"))]);
  return { prices: usage ? moneyPrices(usage.prices, usage.plans ?? []) : {}, fleet, projects: projects?.projects ?? [] };
}

export function proofNow(update: Pick<Update, "task" | "snapshot" | "entries" | "actions">, facts: Around, now: number): ProofJson {
  const { row } = rowOf(update.task, update.snapshot, update.actions, facts.projects, now);
  return proofFor(update.task, update.entries, { word: row.word, ...whereOf(update.task, update.snapshot, facts), prices: facts.prices, asking: needsYou(update.task, update.actions) && update.task.status === "running" });
}

/** A task's whole trail. */
async function trailOf(client: NodeClient, task: string): Promise<TeamTrailEntry[]> {
  const entries: TeamTrailEntry[] = [];
  for (let page = 0; page < 1000; page++) {
    const read = await client.call<{ entries: TeamTrailEntry[]; more: boolean }>("teamTrail", { task, after: entries.at(-1)?.n ?? 0 });
    entries.push(...read.entries);
    if (!read.more || !read.entries.length) break;
  }
  return entries;
}

const actionsOf = (client: NodeClient): Promise<ActionView[]> => client.call<{ actions: ActionView[] }>("actions").then((read) => read.actions, () => []);

// ---- following a task to its end -----------------------------------------------------------------------------------

interface FollowAs {
  json: boolean;
  stream: boolean;
  noAsk: boolean;
  deadline?: number;
  /** What `task.started` says, when this command gave the task. */
  started?: { agent: string; room: string; why: string | null; budgetUsd: number | null };
}

/** Where a task's agent works, and its project, for what is said of it: names, or null when not known. */
function whereOf(task: TeamTask, snapshot: Pick<TeamSnapshot, "agents">, facts: Around): { node: string | null; project: string | null } {
  const nodeId = snapshot.agents.find((one) => one.id === task.assignee)?.workspace?.node ?? null;
  const project = projectsOfAgents(snapshot.agents, facts.projects)(task.assignee);
  return { node: nodeId ? (facts.fleet?.devices.find((device) => device.id === nodeId)?.name ?? null) : null, project: project.key === "other" ? null : project.name };
}

/** Follows a task to its end (or until inv leaves), showing it as asked, and returns the verdict's exit code. */
async function followTask(client: NodeClient, id: string, as: FollowAs, io: Io): Promise<number> {
  const style = io.style;
  const facts = await around(client);
  const tty = style.width !== null;
  let tracker: Tracker | null = null;
  const emit = (event: InvEvent): void => json(io, event);
  let shown = 0;
  let live = "";
  const asked = new Set<string>();
  const clearLive = (): void => {
    if (tty && live) io.out("\r\x1b[2K");
    live = "";
  };
  const end = await follow(client, id, {
    noAsk: as.noAsk,
    signal: io.signal,
    ...(as.deadline !== undefined ? { deadline: as.deadline } : {}),
    ...(io.pollMs !== undefined ? { pollMs: io.pollMs } : {}),
    now: io.now,
    onUpdate: (update) => {
      const now = io.now();
      if (!tracker) {
        tracker = new Tracker(id, update.task.gates, update.task.createdAt);
        const started = as.started ?? { agent: update.task.assignee, room: update.task.room, why: null, budgetUsd: update.task.budgetUsd ?? null };
        if (as.stream) emit(tracker.started(now, { title: plainLine(update.task.title), ...started, ...whereOf(update.task, update.snapshot, facts), gates: update.task.gates }));
        if (!as.stream && !as.json) print(io, [`${plainLine(update.task.title)} · ${update.task.assignee} · ${id}`, faint(style, `Ctrl-C leaves, and it works on · inv stop ${id} stops it`)]);
      }
      const { row } = rowOf(update.task, update.snapshot, update.actions, [], now);
      if (as.stream) {
        for (const event of tracker.trail(update.fresh)) emit(event);
        for (const event of tracker.asks(update.actions, update.task.assignee, now)) emit(event);
        for (const event of tracker.stands(needsYou(update.task, update.actions) ? "needs-you" : update.task.status, row.word, now)) emit(event);
        return;
      }
      if (as.json) return;
      // Its steps, folded as each finishes (the last may still grow while it works), then what it asks, then the live line.
      const groups = stepGroups(update.entries);
      const finished = ended(update.task.status) ? groups.length : Math.max(0, groups.length - 1);
      const lines: string[] = [];
      for (; shown < finished; shown++) lines.push(stepLine(groups[shown]!, style));
      for (const action of waiting(update.actions)) {
        if (askingAgent(action) !== update.task.assignee || asked.has(action.id)) continue;
        asked.add(action.id);
        lines.push(...askLines(askView(action, update.snapshot), style));
      }
      if (lines.length) {
        clearLive();
        print(io, lines);
      }
      if (!tty) return;
      const step = ended(update.task.status) ? null : liveStep(update.entries);
      const next = step ? liveLine(step, style) : update.task.status === "queued" ? liveLine({ text: "Queued: it starts when its agent is free", since: update.task.createdAt }, style) : "";
      if (next !== live) {
        clearLive();
        if (next) io.out(next);
        live = next;
      }
    },
  });
  clearLive();
  const proof = proofNow(end.last, facts, io.now());
  if (end.left) {
    const exit = end.left === "needs-you" ? EXIT.needsYou : EXIT.stillRunning;
    if (as.stream) emit((tracker ?? new Tracker(id, [], 0)).left(io.now(), end.left, exit));
    // (The object's exit is always the code inv exits with: when it leaves first, 21, or 20 for --no-ask.)
    else if (as.json) json(io, { ...proof, exit, ...(end.left === "needs-you" ? { state: "needs-you" } : {}) });
    else {
      const why = { timeout: "Its --timeout ran out", interrupted: "Left it", "needs-you": "It came to need you, and --no-ask stopped it" }[end.left];
      io.err(`${why}${end.left === "needs-you" ? "" : `: it works on without you. inv watch ${id} looks in again; inv stop ${id} stops it`}.\n`);
    }
    return exit;
  }
  if (as.stream) emit((tracker ?? new Tracker(id, [], 0)).end(io.now(), proof));
  else if (as.json) json(io, proof);
  else print(io, proofLines(proof, style));
  return proof.exit;
}

// ---- inv give, inv again -------------------------------------------------------------------------------------------

interface Given {
  task: string;
  agent: string;
  room: string;
  why: string | null;
  budgetUsd: number | null;
}

/** How a give or an again follows its task: --wait, --stream, --no-ask and --timeout each make it wait. */
function waitsOf(flags: Flags, io: Io): { wait: boolean; deadline?: number } {
  const timeout = flags.timeout === undefined ? undefined : parseDuration(flags.timeout);
  const wait = flags.wait || flags.stream || flags.noAsk || timeout !== undefined;
  return { wait, ...(timeout !== undefined ? { deadline: io.now() + timeout } : {}) };
}

async function handOver(client: NodeClient, given: Given, flags: Flags, io: Io, what: string): Promise<number> {
  const waits = waitsOf(flags, io);
  if (!waits.wait) {
    if (flags.json) json(io, { task: given.task, agent: given.agent, room: given.room, why: given.why });
    else {
      print(io, [`${what} ${given.agent} · task ${given.task}${given.budgetUsd !== null ? ` · budget ${moneyLabel(given.budgetUsd)}` : ""}`]);
      if (given.why) print(io, [faint(io.style, `${given.agent} takes it: ${plainLine(given.why)}`)]);
      print(io, [`It works on without you. inv watch ${given.task} looks in; inv stop ${given.task} stops it.`]);
    }
    return EXIT.ok;
  }
  if (!flags.json && !flags.stream) print(io, [`${what} ${given.agent} · task ${given.task}${given.budgetUsd !== null ? ` · budget ${moneyLabel(given.budgetUsd)}` : ""}`]);
  return followTask(client, given.task, { json: flags.json, stream: flags.stream, noAsk: flags.noAsk, ...(waits.deadline !== undefined ? { deadline: waits.deadline } : {}), started: { agent: given.agent, room: given.room, why: given.why, budgetUsd: given.budgetUsd } }, io);
}

/** A node named by its name or its id (or the start of its id), among the fleet's nodes. */
function nodeNamed(fleet: FleetView, ref: string): { id: string; name: string } {
  const nodes = fleet.devices.filter((device) => device.kind === "node" && !device.revokedAt);
  const found = nodes.filter((device) => device.id === ref || device.name.toLowerCase() === ref.toLowerCase() || (ref.length >= 6 && device.id.startsWith(ref)));
  if (found.length !== 1) throw new CliError(found.length ? `"${ref}" names ${found.length} nodes: name one by its id` : `no node "${ref}" in this fleet (${nodes.map((node) => node.name).join(", ") || "none"})`);
  return { id: found[0]!.id, name: found[0]!.name };
}

/** A project of yours, by its id or its name, with the repository its agents work in. */
function projectNamed(projects: readonly ProjectView[], ref: string): ProjectView & { repo: string } {
  const found = projects.filter((project) => project.id === ref || project.name.toLowerCase() === ref.toLowerCase());
  if (found.length !== 1) throw new CliError(found.length ? `"${ref}" names ${found.length} projects` : `no project "${ref}" (${projects.map((project) => project.name).join(", ") || "none yet"})`);
  const project = found[0]!;
  if (!project.repo) throw new CliError(`the project ${project.name} has no repository, so no agent works in it: give it one (invincible project set ${project.id} --repo https://…), or name an agent with --agent`);
  return { ...project, repo: project.repo };
}

export const giveCommand: Command = async (conn, args, flags, io) => {
  const goal = args.join(" ").trim();
  if (!goal) throw usageError('usage: inv give "<goal>" [--agent <id>] [--project <p>] [--gate "<command>"]… [--budget <usd>] [--on <node>] [--wait] [--json] [--stream] [--no-ask] [--timeout 20m]');
  const budgetUsd = flags.budget === undefined ? undefined : parseUsd(flags.budget);
  waitsOf(flags, io);
  const { client } = await conn();
  const [snapshot, projects, fleet] = await Promise.all([
    client.call<TeamSnapshot>("team"),
    flags.project ? client.call<{ projects: ProjectView[] }>("projects").then((read) => read.projects) : Promise.resolve([]),
    flags.on ? client.call<FleetView>("fleet") : Promise.resolve(null),
  ]);
  const project = flags.project ? projectNamed(projects, flags.project) : null;
  const node = flags.on && fleet ? nodeNamed(fleet, flags.on) : null;
  const title = flags.title?.trim() || undefined;
  if (flags.agent) {
    const agent = snapshot.agents.find((one) => one.id === flags.agent);
    if (!agent) throw new CliError(`no agent ${flags.agent} (${snapshot.agents.map((one) => one.id).join(", ") || "none yet: invincible agents add <id> --name <name>"})`);
    if (node && agent.workspace?.node !== node.id) throw new CliError(`${agent.id}'s VM is ${agent.workspace ? "on another node" : "not made yet"}, not on ${node.name}: leave out --on, or make it there (invincible agents provision ${agent.id} --on ${node.name})`);
    if (project && (!agent.repository || agent.repository.toLowerCase().replace(/\.git$/, "") !== project.repo.toLowerCase().replace(/\/$/, "").replace(/\.git$/, ""))) throw new CliError(`${agent.id} doesn't work in ${project.name}'s repository`);
    const { room } = await client.call<{ room: TeamRoom }>("directAgent", { id: agent.id });
    const { task } = await client.call<{ task: TeamTask }>("createTeamTask", { room: room.id, assignee: agent.id, title: title ?? goal.slice(0, 200), goal, gates: flags.gate, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    return handOver(client, { task: task.id, agent: agent.id, room: room.id, why: null, budgetUsd: budgetUsd ?? null }, flags, io, "Gave it to");
  }
  const needs = { ...(project ? { repository: project.repo } : {}), ...(node ? { node: node.id } : {}) };
  const given = await client.call<{ task: TeamTask; choice: { id: string; name: string; reasons: string[] } }>("giveTeamTask", {
    goal,
    ...(title ? { title } : {}),
    ...(flags.gate.length ? { gates: flags.gate } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(Object.keys(needs).length ? { needs } : {}),
  });
  return handOver(client, { task: given.task.id, agent: given.choice.id, room: given.task.room, why: given.choice.reasons.join("; "), budgetUsd: budgetUsd ?? null }, flags, io, "Gave it to");
};

export const againCommand: Command = async (conn, args, flags, io) => {
  const usage = 'usage: inv again <task> [--from <step>] ["<goal>"] [--wait] [--json] [--stream] [--no-ask] [--timeout 20m]';
  waitsOf(flags, io);
  const step = flags.from === undefined ? undefined : Number(flags.from);
  if (step !== undefined && (!Number.isInteger(step) || step < 1)) throw usageError(`--from names a step by its number (invincible agents steps <task> lists them): ${usage}`);
  const { client } = await conn();
  const snapshot = await client.call<TeamSnapshot>("team");
  const old = resolveTask(snapshot, args[0], usage);
  const goal = args.slice(1).join(" ").trim() || old.goal;
  const { task } = await client.call<{ task: TeamTask }>("createTeamTask", {
    room: old.room,
    assignee: old.assignee,
    title: old.title,
    goal,
    gates: old.gates,
    ...(old.dependsOn.length ? { dependsOn: old.dependsOn } : {}),
    ...(old.budgetUsd !== undefined ? { budgetUsd: old.budgetUsd } : {}),
    ...(old.models?.length ? { models: old.models } : {}),
    again: old.id,
    ...(step !== undefined ? { from: { task: old.id, step } } : {}),
  });
  return handOver(client, { task: task.id, agent: task.assignee, room: task.room, why: `${old.id} given again${step !== undefined ? `, from its step ${step}` : ""}`, budgetUsd: task.budgetUsd ?? null }, flags, io, "Gave it again to");
};

// ---- inv tasks -----------------------------------------------------------------------------------------------------

export const tasksCommand: Command = async (conn, args, flags, io) => {
  if (args.length) throw usageError("usage: inv tasks [--needs-you | --working | --done] [--project <p>] [--json]");
  const { client } = await conn();
  const [snapshot, projects, actions] = await Promise.all([client.call<TeamSnapshot>("team"), client.call<{ projects: ProjectView[] }>("projects").then((read) => read.projects, () => []), actionsOf(client)]);
  const work = workOf({ snapshot, projects, actions, now: io.now() });
  const only: Section[] | null = flags.needsYou || flags.working || flags.done ? [...(flags.needsYou ? (["needs"] as const) : []), ...(flags.working ? (["working"] as const) : []), ...(flags.done ? (["active", "done"] as const) : [])] : null;
  const projectKey = flags.project ? work.projects.find((project) => project.name.toLowerCase() === flags.project!.toLowerCase() || project.key === flags.project)?.key : null;
  if (flags.project && !projectKey) throw new CliError(`no task is in a project "${flags.project}" (${work.projects.map((project) => project.name).join(", ") || "no tasks yet"})`);
  const sections = SECTIONS.filter((section) => !only || only.includes(section)).map((section) => ({ section, rows: work[section].filter((row) => !projectKey || row.project.key === projectKey) }));
  if (flags.json) json(io, { tasks: sections.flatMap(({ section, rows }) => rows.map((row) => rowJson(row, section))) });
  else print(io, taskLines(sections, io.style));
  return EXIT.ok;
};

// ---- inv watch, peek, proof, stop ----------------------------------------------------------------------------------

export const watchCommand: Command = async (conn, args, flags, io) => {
  const usage = "usage: inv watch <task> [--json] [--stream]";
  if (args.length > 1) throw usageError(usage);
  const { client } = await conn();
  const task = resolveTask(await client.call<TeamSnapshot>("team"), args[0], usage);
  return followTask(client, task.id, { json: flags.json, stream: flags.stream, noAsk: false }, io);
};

export const peekCommand: Command = async (conn, args, flags, io) => {
  const usage = "usage: inv peek <task> [--json]";
  if (args.length > 1) throw usageError(usage);
  const { client } = await conn();
  const snapshot = await client.call<TeamSnapshot>("team");
  const task = resolveTask(snapshot, args[0], usage);
  const [entries, actions] = await Promise.all([trailOf(client, task.id), actionsOf(client)]);
  const { row } = rowOf(task, snapshot, actions, [], io.now());
  const asks = [
    ...(task.status === "proposed" ? [askView(task, snapshot)] : []),
    ...(task.status === "running" ? waiting(actions).filter((action) => askingAgent(action) === task.assignee).map((action) => askView(action, snapshot)) : []),
  ];
  const last = entries.slice(-12);
  if (flags.json) {
    json(io, { task: task.id, state: needsYou(task, actions) ? "needs-you" : task.status, word: row.word, lines: last.map((entry) => ({ n: entry.n, at: entry.at, text: plainText(entry.text) })), asks });
    return EXIT.ok;
  }
  print(io, [`${plainLine(task.title)} · ${task.assignee} · ${row.word} · ${task.id}`]);
  if (asks.length) for (const ask of asks) print(io, askLines(ask, io.style));
  else if (!last.length) print(io, [faint(io.style, task.status === "queued" ? "Queued: nothing done yet." : "Nothing on its trail yet.")]);
  print(io, trailLines(last, io.style));
  return EXIT.ok;
};

export const proofCommand: Command = async (conn, args, flags, io) => {
  const usage = "usage: inv proof <task> [--json]";
  if (args.length > 1) throw usageError(usage);
  const { client } = await conn();
  const snapshot = await client.call<TeamSnapshot>("team");
  const task = resolveTask(snapshot, args[0], usage);
  const [entries, actions, facts] = await Promise.all([trailOf(client, task.id), actionsOf(client), around(client)]);
  const proof = proofNow({ task, snapshot, entries, actions }, facts, io.now());
  if (flags.json) json(io, proof);
  else print(io, proofLines(proof, io.style));
  return proof.exit;
};

export const stopCommand: Command = async (conn, args, flags, io) => {
  const usage = "usage: inv stop <task> [--json]";
  if (args.length > 1) throw usageError(usage);
  const { client } = await conn();
  const task = resolveTask(await client.call<TeamSnapshot>("team"), args[0], usage);
  if (ended(task.status)) {
    if (flags.json) json(io, { task: task.id, state: task.status });
    else print(io, [`${task.id} had already ended (${task.status}): nothing to stop.`]);
    return EXIT.ok;
  }
  await client.call("controlTeam", { task: task.id, action: "stop" });
  if (flags.json) json(io, { task: task.id, state: "stopped" });
  else print(io, [`Stopped ${task.id}: ${plainLine(task.title)}. inv again ${task.id} gives it again.`]);
  return EXIT.ok;
};
