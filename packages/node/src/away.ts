import type { AwayLine, LoopRunView, NoticeView, TeamTask } from "@galahad/core";

/*
 * While you were away (PLAN #37): what happened since you last looked, in a few lines, from what the node holds and no
 * model: the knights' tasks that ended (verified, or not and why in a word), his outcomes' reports and questions, the
 * loops that failed, and what waits for you now. Each line in its state's colour, as everywhere: done green, failed red,
 * what waits on you amber. Nothing happened: no lines, and nothing is said.
 */

export interface AwayInput {
  since: number;
  /** Every knight's tasks (they say when they last changed). */
  tasks: readonly TeamTask[];
  /** A knight's name by its handle. */
  name: (id: string) => string;
  notices: readonly NoticeView[];
  runs: readonly LoopRunView[];
  /** How many things wait for your answer now (approvals, keys, devices, facts, drafts). */
  waiting: number;
}

/** Of the tasks that ended, at most this many are named; the rest are counted. */
export const AWAY_TASKS = 3;
const ENDED = new Set<TeamTask["status"]>(["done", "failed", "stopped"]);

const quoted = (text: string): string => {
  const line = text.trim().split("\n", 1)[0]!;
  return `“${line.length > 80 ? `${line.slice(0, 79)}…` : line}”`;
};

export function awayLines(input: AwayInput): AwayLine[] {
  const lines: AwayLine[] = [];
  const ended = input.tasks.filter((t) => ENDED.has(t.status) && t.updatedAt > input.since).sort((a, b) => b.updatedAt - a.updatedAt);
  const passed = ended.filter((t) => t.status === "done" && t.verified);
  if (ended.length > AWAY_TASKS) {
    const not = ended.length - passed.length;
    lines.push({ text: `${ended.length} knights' tasks ended: ${passed.length} verified${not ? `, ${not} didn't pass` : ""}.`, tone: not ? "danger" : "ok" });
  }
  for (const t of ended.slice(0, AWAY_TASKS)) {
    const who = input.name(t.assignee);
    if (t.status === "done" && t.verified) lines.push({ text: `${who} finished ${quoted(t.title)}, verified.`, tone: "ok" });
    else lines.push({ text: `${who}'s ${quoted(t.title)} ended without passing${t.status === "stopped" || t.error === "stopped" ? " (stopped)" : ""}.`, tone: "danger" });
  }
  // His outcomes: a question waits on you; a report is news. (Other notices are the Inbox's, and counted below.)
  for (const n of input.notices.filter((n) => !n.dismissed && n.at > input.since && n.source.startsWith("outcome:")).sort((a, b) => b.at - a.at)) {
    lines.push({ text: n.title, tone: n.severity === "info" ? "neutral" : "warn" });
  }
  const failed = input.runs.filter((r) => r.finished > input.since && r.status === "failed");
  for (const loop of [...new Set(failed.map((r) => r.loop))]) {
    const runs = failed.filter((r) => r.loop === loop);
    lines.push({ text: `The loop ${loop} failed${runs.length > 1 ? ` ${runs.length} times` : ""}: ${runs[0]!.summary.split("\n", 1)[0]!.slice(0, 120)}`, tone: "danger" });
  }
  if (input.waiting) lines.push({ text: `${input.waiting} ${input.waiting === 1 ? "thing needs" : "things need"} your answer.`, tone: "warn" });
  return lines;
}
