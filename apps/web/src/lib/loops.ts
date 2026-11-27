import type { LoopTask } from "@invincible/core";

/*
 * A loop's task in words (pure: no DOM), as its card on Loops and a loop it drafted in Needs you say it. The iPhone says
 * the same, held to it by the vectors' `loops` (apps/apple/scripts/vectors.ts).
 */

/** As much of a text as a line keeps, counted as a string's length is (UTF-16), and an ellipsis where it was cut. */
const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** What a loop runs, in a sentence: a heartbeat, a run (its network, its goal, what proves it), a call (its tool and its
 * arguments, by name, so every app says them in one order), or a tell. */
export function describeTask(task: LoopTask | null): string {
  if (!task) return "A task this node can't read.";
  if (task.kind === "heartbeat") {
    const what = task.checklist ? "Heartbeat: checks the fleet, then reads your checklist." : "Heartbeat: checks the fleet and the machine it runs on.";
    return `${what}${task.selfAction === false ? " Only reports: self-action is off." : " Then fixes what's safe itself."}`;
  }
  if (task.kind === "run") {
    const gates = task.gates?.length ? ` Done means ${task.gates.length === 1 ? "this passes" : `these ${task.gates.length} pass`}: ${clip(task.gates.join(" · "), 160)}` : "";
    // (Its network's name in lower case, as its label says it: isolated, gateway, online.)
    return `Run, ${task.network}: ${clip(task.goal, 160)}${gates}`;
  }
  if (task.kind === "tell") return `Tells you${task.text ? `: ${clip(task.text, 160)}` : ", with what woke it"}: a notice in Needs you, and your loop's name on your phone.`;
  const args = Object.entries(task.args ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `Calls ${task.connector}.${task.tool}${args ? ` ${clip(args, 120)}` : ""}`;
}
