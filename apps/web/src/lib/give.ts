import type { TeamGiveInput } from "@galahad/core/team";

/*
 * Giving a task (pure: no DOM). The commands that prove it is done, as typed; a task given to the Roundtable
 * as the node takes it (POST /api/team/give); and its answer in words: which knight took it and why, and how
 * each of the others stood. The Roundtable is a technocracy: the knight best suited to a task takes it.
 */

const GATES = 16;
const GATE_LENGTH = 1000;

/** One command a line, blank lines left out: at most sixteen, each at most a thousand characters (more is said, never cut). */
export function gatesFrom(text: string): { gates: string[] } | { error: string } {
  const gates = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (gates.length > GATES) return { error: `At most ${GATES} commands: this has ${gates.length}.` };
  const long = gates.findIndex((gate) => gate.length > GATE_LENGTH);
  if (long >= 0) return { error: `A command can be at most 1,000 characters: line ${long + 1} is longer.` };
  return { gates };
}

/**
 * A task's budget as typed: US dollars above 0 and at most 100 ("0.50", "$2", "1,5" with a comma for the point), or
 * none when nothing is typed. Its model calls may spend that much at your prices; it stops when it is spent.
 */
export function budgetFrom(text: string): { usd: number | null } | { error: string } {
  const typed = text.trim().replace(/^\$\s*/, "").replace(",", ".");
  if (!typed) return { usd: null };
  if (!/^\d+(\.\d+)?$/.test(typed)) return { error: "A budget is an amount in US dollars, like 0.50." };
  const usd = Number(typed);
  if (usd <= 0 || usd > 100) return { error: "A budget is more than $0 and at most $100." };
  return { usd };
}

/** A task for the Roundtable, as the node takes it: only what was given. */
export function giveInput(form: { goal: string; title: string; gates: string[]; desktop: boolean; repository: string; budgetUsd?: number | null }): TeamGiveInput {
  const title = form.title.trim();
  const repository = form.repository.trim();
  const needs = { ...(form.desktop ? { desktop: true } : {}), ...(repository ? { repository } : {}) };
  return {
    goal: form.goal.trim(),
    ...(title ? { title } : {}),
    ...(form.gates.length ? { gates: form.gates } : {}),
    ...(Object.keys(needs).length ? { needs } : {}),
    ...(form.budgetUsd ? { budgetUsd: form.budgetUsd } : {}),
  };
}

/** The node's answer to a task given to the Roundtable. */
export interface Given {
  task: { id: string; room: string };
  choice: { id: string; name: string; reasons: string[] };
  considered: { id: string; name: string; eligible: boolean; why: string[] }[];
}

/** Who took it and why, where the task now is, and how each of the others stood (the node's order: those that could, first). */
export function givenTo(answer: Given): { id: string; name: string; room: string; why: string; others: { id: string; name: string; line: string; could: boolean }[] } {
  return {
    id: answer.choice.id,
    name: answer.choice.name,
    room: answer.task.room,
    why: answer.choice.reasons.join(" · "),
    others: answer.considered
      .filter((knight) => knight.id !== answer.choice.id)
      .map((knight) => ({ id: knight.id, name: knight.name, line: `${knight.eligible ? "" : "can't take it: "}${knight.why.join(" · ")}`, could: knight.eligible })),
  };
}
