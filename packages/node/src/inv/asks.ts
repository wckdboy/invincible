import { type ActionView, callerName, plainLine, type TeamSnapshot, type TeamTask } from "@invincible/core";
import { hlcMs } from "../../../../apps/web/src/lib/time.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import type { Command } from "./io.ts";
import { askLines, type AskView, hiddenIn } from "./render.ts";
import { askingAgent, primaryName, waiting, type Whoami } from "./view.ts";

/*
 * inv asks, allow and deny (docs/CLI.md): what waits for your answer, shown exactly. An approval is an operation that
 * only you may allow (money, legal, destructive, outward: the primary approves the rest itself), with its inputs whole
 * and every character that can't be seen made visible. A proposal is a task an agent wrote, which runs once you allow it.
 * Answering is yours alone: the node checks fleet:admin, as it does for the apps.
 */

/** Who asks, in words: an agent by its handle, your agent by its name, a loop, you. */
function askerOf(by: string, primary: string): string {
  const agent = askingAgent({ by });
  if (agent) return agent;
  if (by === "arm:primary") return primary;
  if (by.startsWith("loop:")) return `loop ${by.slice(5)}`;
  if (by.startsWith("arm:")) return by.slice(4);
  return by.startsWith("node:") ? by.slice(5) : by;
}

/** An approval, or a proposed task, as inv shows it. */
export function askView(item: ActionView | TeamTask, snapshot: Pick<TeamSnapshot, "tasks">, whoami: Pick<Whoami, "primaryName"> | null = null): AskView {
  if ("assignee" in item) {
    const inputs = { title: item.title, goal: item.goal, ...(item.gates.length ? { gates: item.gates } : {}), ...(item.budgetUsd !== undefined ? { budgetUsd: item.budgetUsd } : {}) };
    const view: AskView = { id: item.id, kind: "proposal", op: "task.start", inputs, class: "proposal", by: item.proposedBy ?? item.assignee, task: item.id, title: plainLine(item.title), why: null, expires: null, hidden: 0 };
    return { ...view, hidden: hiddenIn(view).length };
  }
  const agent = askingAgent(item);
  const working = agent ? snapshot.tasks.find((task) => task.assignee === agent && task.status === "running") : undefined;
  const view: AskView = {
    id: item.id,
    kind: "approval",
    op: `${item.connector}.${item.tool}`,
    inputs: item.args,
    class: item.class,
    by: askerOf(item.by, primaryName(whoami)),
    task: working?.id ?? null,
    title: working ? plainLine(working.title) : null,
    why: item.why,
    expires: item.expires,
    hidden: 0,
  };
  return { ...view, hidden: hiddenIn(view).length };
}

/** What waits: every approval waiting, then every task an agent proposed. */
async function waitingNow(client: Awaited<ReturnType<Parameters<Command>[0]>>["client"]) {
  const [snapshot, actions, whoami] = await Promise.all([
    client.call<TeamSnapshot>("team"),
    client.call<{ actions: ActionView[] }>("actions").then((read) => read.actions),
    client.call<Whoami>("whoami").catch(() => null),
  ]);
  return { snapshot, actions, whoami };
}

export const asksCommand: Command = async (conn, args, flags, io) => {
  if (args.length) throw usageError("usage: inv asks [--json]");
  const { client } = await conn();
  const { snapshot, actions, whoami } = await waitingNow(client);
  const order = (a: ActionView, b: ActionView) => (hlcMs(a.requestedAt) ?? 0) - (hlcMs(b.requestedAt) ?? 0);
  const asks = [...waiting(actions).sort(order).map((action) => askView(action, snapshot, whoami)), ...snapshot.tasks.filter((task) => task.status === "proposed").map((task) => askView(task, snapshot, whoami))];
  if (flags.json) {
    io.out(`${JSON.stringify({ asks })}\n`);
    return EXIT.ok;
  }
  if (!asks.length) io.out("Nothing waits for your answer.\n");
  for (const ask of asks) io.out(`${askLines(ask, io.style).join("\n")}\n`);
  return EXIT.ok;
};

/** The approval or proposal an id names: whole, or by a start of it that names one alone. */
function named(ref: string | undefined, actions: readonly ActionView[], tasks: readonly TeamTask[], usage: string): ActionView | TeamTask {
  if (!ref) throw usageError(usage);
  const proposal = tasks.find((task) => task.status === "proposed" && (task.id === ref || task.id === `task-${ref}`));
  if (proposal) return proposal;
  const exact = actions.find((action) => action.id === ref);
  if (exact) return exact;
  const found = ref.length >= 6 ? actions.filter((action) => action.id.startsWith(ref)) : [];
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw usageError(`"${ref}" names ${found.length} approvals: give more of its id`);
  const task = tasks.find((one) => one.id === ref || one.id === `task-${ref}`);
  if (task) throw new CliError(`${task.id} isn't a proposal waiting for you (it is ${task.status}); inv asks lists what waits`);
  throw new CliError(`nothing waiting is ${ref} (inv asks lists what waits)`);
}

/**
 * --for-task, as the node keeps it today (docs/CLI.md): a standing order for the asking agent alone and this call
 * exactly, for a day. An order reads * as any text and can't pin a value that isn't text, a number or a yes or no: such
 * a call is allowed once instead, and said why.
 */
export function forTaskOrder(action: ActionView, task: string | null): { connector: string; tool: string; args: Record<string, string>; callers: string[]; days: number; label: string; approve: string } {
  const agent = askingAgent(action);
  if (!agent) throw usageError("--for-task is for an agent's approval while its task runs; this one isn't an agent's: inv allow <id> allows it once");
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(action.args)) {
    if (value === null || typeof value === "object") throw usageError(`--for-task can't pin ${key} (it isn't text, a number or a yes or no): inv allow <id> allows it once`);
    const text = String(value);
    if (text.includes("*")) throw usageError(`--for-task can't pin ${key} exactly (an order reads * as any text): inv allow <id> allows it once`);
    args[key] = text;
  }
  return { connector: action.connector, tool: action.tool, args, callers: [callerName(action.by)], days: 1, label: `inv --for-task: ${agent}${task ? ` · ${task}` : ""}`.slice(0, 128), approve: action.id };
}

export const allowCommand: Command = async (conn, args, flags, io) => {
  const usage = "usage: inv allow <id> [--for-task] [--json]";
  if (args.length > 1) throw usageError(usage);
  const { client } = await conn();
  const { snapshot, actions } = await waitingNow(client);
  const item = named(args[0], actions, snapshot.tasks, usage);
  if ("assignee" in item) {
    if (flags.forTask) throw usageError("--for-task is for an approval; a proposal is allowed to start: inv allow <task>");
    await client.call("controlTeam", { task: item.id, action: "approve" });
    if (flags.json) io.out(`${JSON.stringify({ task: item.id, state: "queued" })}\n`);
    else io.out(`Allowed: ${plainLine(item.title)} starts when ${item.assignee} is free (${item.id}).\n`);
    return EXIT.ok;
  }
  if (item.state !== "waiting") throw new CliError(`${item.id} is ${item.state} already: nothing to allow`);
  const working = askView(item, snapshot).task;
  let state: string;
  if (flags.forTask) {
    const { order, action } = await client.call<{ order: { id: string }; action?: ActionView }>("setOrder", forTaskOrder(item, working));
    state = action?.state ?? "approved";
    if (!flags.json) io.out(`Allowed: ${item.connector}.${item.tool}. ${askingAgent(item)}'s same call goes out without asking for a day (order ${order.id}: invincible order revoke ${order.id} ends it).\n`);
  } else {
    const { action } = await client.call<{ action: ActionView }>("decideAction", { id: item.id, approve: true });
    state = action.state;
    if (!flags.json) io.out(`Allowed: ${item.connector}.${item.tool}. The node that asked sends it once.\n`);
  }
  if (flags.json) io.out(`${JSON.stringify({ id: item.id, state })}\n`);
  return EXIT.ok;
};

export const denyCommand: Command = async (conn, args, flags, io) => {
  const usage = 'usage: inv deny <id> ["why"] [--json]';
  const { client } = await conn();
  const { snapshot, actions } = await waitingNow(client);
  const item = named(args[0], actions, snapshot.tasks, usage);
  const why = args.slice(1).join(" ").trim();
  if (why.length > 500) throw usageError("a reason is 500 characters at most");
  if ("assignee" in item) {
    await client.call("controlTeam", { task: item.id, action: "stop" });
    if (flags.json) io.out(`${JSON.stringify({ task: item.id, state: "stopped" })}\n`);
    else io.out(`Declined: ${plainLine(item.title)} (${item.id}).\n`);
    return EXIT.ok;
  }
  if (item.state !== "waiting") throw new CliError(`${item.id} is ${item.state} already: nothing to deny`);
  const { action } = await client.call<{ action: ActionView }>("decideAction", { id: item.id, approve: false, ...(why ? { note: why } : {}) });
  if (flags.json) io.out(`${JSON.stringify({ id: item.id, state: action.state })}\n`);
  else io.out(`Denied: ${item.connector}.${item.tool}${why ? `, saying why` : ""}. It isn't sent.\n`);
  return EXIT.ok;
};

