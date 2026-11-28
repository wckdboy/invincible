import { type ActionView, AT_MOST_NOTE, boundWord, costOf, moneyPrices, plainLine, type ProjectView, spendLineLabel, type TeamSnapshot, type TeamTask, type UsageLine, type UsageView, moneyLabel } from "@invincible/core";
import { projectsOfAgents } from "../../../../apps/web/src/lib/work.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import { type Command, resolveTask } from "./io.ts";
import { faint, paint } from "./render.ts";
import { rowOf } from "./work.ts";

/*
 * inv cost (docs/CLI.md): what the work cost at your prices, against its budgets. This node's model calls, as it counts
 * them by its UTC day (a coding plan's calls cost nothing: they're paid for already), and each task's spend as its runner
 * recorded it when it ended, beside its budget. A model with no price of yours makes a sum a lower bound, and says so; a
 * handed task's call counted at its most (its provider silent in time) makes it an upper bound, and says so. With
 * --task, the task's lines as its record kept them, a line each role and model beneath its row; the JSON's rows carry
 * them as kept (`spent`, null where a task has no record yet).
 */

const DAY_MS = 86_400_000;

const money = (cost: { usd: number; complete: boolean; atMost?: boolean }): string => `${boundWord(!cost.complete, cost.atMost === true)}${moneyLabel(cost.usd)}`;

export const costCommand: Command = async (conn, args, flags, io) => {
  if (args.length) throw usageError("usage: inv cost [--task <id> | --agent <id> | --project <p>] [--week] [--json]");
  if ([flags.task, flags.agent, flags.project].filter(Boolean).length > 1) throw usageError("give one of --task, --agent or --project");
  const { client } = await conn();
  const [snapshot, usage, projects, actions] = await Promise.all([
    client.call<TeamSnapshot>("team"),
    client.call<UsageView>("usage", { days: flags.week ? 7 : 1 }),
    client.call<{ projects: ProjectView[] }>("projects").then((read) => read.projects, () => []),
    client.call<{ actions: ActionView[] }>("actions").then((read) => read.actions, () => []),
  ]);
  const now = io.now();
  const prices = moneyPrices(usage.prices, usage.plans ?? []);
  const today = new Date(now).toISOString().slice(0, 10);
  const since = flags.week ? new Date(now - 6 * DAY_MS).toISOString().slice(0, 10) : today;
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  const callCost = (rows: UsageView["rows"]) => {
    const cost = costOf(rows, prices);
    return { usd: Math.round(cost.usd * 1e6) / 1e6, complete: cost.complete && !cost.unpriced.length, atMost: cost.atMost };
  };
  const calls = callCost(usage.rows.filter((row) => row.day >= since));
  const todays = callCost(usage.rows.filter((row) => row.day === today));
  const projectOf = projectsOfAgents(snapshot.agents, projects);

  let tasks: TeamTask[];
  if (flags.task) tasks = [resolveTask(snapshot, flags.task, "usage: inv cost --task <id>")];
  else {
    tasks = snapshot.tasks.filter((task) => task.record && task.record.endedAt >= sinceMs);
    if (flags.agent) {
      if (!snapshot.agents.some((agent) => agent.id === flags.agent)) throw new CliError(`no agent ${flags.agent}`);
      tasks = tasks.filter((task) => task.assignee === flags.agent);
    }
    if (flags.project) {
      const want = flags.project.toLowerCase();
      tasks = tasks.filter((task) => {
        const project = projectOf(task.assignee);
        return project.key !== "other" && (project.name.toLowerCase() === want || project.key === flags.project);
      });
    }
  }
  const rows = tasks
    .map((task) => {
      const cost = task.record ? costOf(task.record.spent as readonly UsageLine[], prices) : null;
      const project = projectOf(task.assignee);
      return {
        id: task.id,
        title: plainLine(task.title),
        agent: task.assignee,
        project: project.key === "other" ? null : project.name,
        usd: cost ? Math.round(cost.usd * 1e6) / 1e6 : null,
        complete: cost ? cost.complete && !cost.unpriced.length : false,
        atMost: cost?.atMost ?? false,
        budgetUsd: task.budgetUsd ?? null,
        spent: task.record ? (task.record.spent as readonly UsageLine[]) : null,
        word: rowOf(task, snapshot, actions, projects, now).row.word,
        at: task.record?.endedAt ?? task.updatedAt,
      };
    })
    .sort((a, b) => b.at - a.at);
  const priced = rows.filter((row) => row.usd !== null);
  const total = { usd: Math.round(priced.reduce((sum, row) => sum + row.usd!, 0) * 1e6) / 1e6, complete: priced.every((row) => row.complete) && priced.length === rows.length, atMost: priced.some((row) => row.atMost) };

  if (flags.json) {
    io.out(`${JSON.stringify({ since, today: todays, calls, tasks: rows.map(({ word: _word, at: _at, ...row }) => row), total })}\n`);
    return EXIT.ok;
  }
  const style = io.style;
  const lines: string[] = [];
  lines.push(`${flags.week ? `The last seven days (from ${since}, UTC)` : `Today (${today}, UTC)`}: this node's model calls cost ${money(calls)}.`);
  if (flags.task) lines.push("");
  else lines.push(rows.length ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"} ended${flags.agent ? ` for ${flags.agent}` : flags.project ? ` in ${flags.project}` : ""}, ${money(total)} in all:` : "No task ended in that time.");
  for (const row of rows) {
    const spent = row.usd === null ? (row.budgetUsd !== null ? `budget ${moneyLabel(row.budgetUsd)}` : "not ended") : `${money({ usd: row.usd, complete: row.complete, atMost: row.atMost })}${row.budgetUsd !== null ? ` of ${moneyLabel(row.budgetUsd)}` : ""}`;
    lines.push(`  ${spent.padEnd(18)}  ${paint(style, "neutral", row.word.padEnd(16))}  ${row.agent}  ${row.title}  ${faint(style, row.id)}`);
    if (flags.task) for (const line of row.spent ?? []) lines.push(`    ${spendLineLabel(line, prices)}`);
  }
  if (!calls.complete || !total.complete) lines.push(faint(style, "At least: a model that answered has no price of yours, or a call said nothing of its tokens (invincible price set gives one)."));
  if (calls.atMost || total.atMost) lines.push(faint(style, AT_MOST_NOTE));
  io.out(`${lines.filter((line, i) => line || i < lines.length - 1).join("\n")}\n`);
  return EXIT.ok;
};
