import { type GateView, type QuestState, redact } from "@galahad/core";
import type { QuestEvent } from "./quest.ts";

/*
 * Where a quest stands, from its own events: the plan, the step he's on, each gate's
 * last result, how it ended. A pure fold, so whoever runs a quest (a terminal, a loop)
 * can tell its node the same thing after every event, and the node only has to show it.
 */

export interface QuestStanding {
  state: QuestState;
  plan: string;
  /** The command he's on, or the last one he ran. */
  step: number;
  maxSteps: number;
  /** What he's doing now, in a line. */
  doing: string;
  /** Times the work was sent back (a gate that failed, or the reviewer's REVISE). */
  revisions: number;
  gates: GateView[];
  summary: string;
}

export const questStanding = (maxSteps: number): QuestStanding => ({ state: "planning", plan: "", step: 0, maxSteps, doing: "Planning", revisions: 0, gates: [], summary: "" });

const line = (text: string, max = 240): string => {
  const first = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/** The standing after one more event. */
export function standingAfter(s: QuestStanding, event: QuestEvent): QuestStanding {
  switch (event.type) {
    case "plan":
      return { ...s, state: "working", plan: redact(event.text).slice(0, 6000), doing: "Starting on the plan" };
    case "gates":
      return { ...s, gates: event.gates.map((g) => ({ command: g.command, by: g.by, exitCode: null })) };
    case "command":
      return { ...s, state: "working", step: Math.max(s.step, event.step), doing: `$ ${line(redact(event.command))}` };
    case "thought":
      return s.state === "working" && event.text.trim() ? { ...s, step: Math.max(s.step, event.step), doing: line(redact(event.text)) } : s;
    case "submitted":
      return { ...s, state: s.gates.length ? "gating" : "reviewing", doing: s.gates.length ? "Submitted: running the gates" : "Submitted: the reviewer is reading the evidence" };
    case "gate": {
      const gates = s.gates.map((g, i) => (i === event.index - 1 ? { ...g, exitCode: event.exitCode, excerpt: event.output.split("\n").slice(1).join("\n").slice(0, 1500) } : g));
      return { ...s, state: "gating", gates, doing: `Gate ${event.index} of ${event.of}: $ ${line(event.command, 200)}` };
    }
    case "gated":
      return event.passed
        ? { ...s, state: "reviewing", doing: "The gates passed: the reviewer is reading the evidence" }
        : { ...s, state: "working", revisions: s.revisions + 1, doing: `Sent back: ${event.results.filter((g) => g.exitCode !== 0).length} of ${event.results.length} gate(s) failed` };
    case "review":
      return event.verdict === "pass" ? { ...s, doing: "The reviewer passed it" } : { ...s, state: "working", revisions: s.revisions + 1, doing: "Sent back by the reviewer" };
    case "retry":
      return { ...s, doing: `The ${event.role} couldn't answer: asking again in ${Math.round(event.waitMs / 1000)} s` };
    case "skipped":
      return { ...s, doing: line(`${event.model} couldn't answer as ${event.role}: ${event.answered} answers instead`, 300) };
    case "escalated":
      return { ...s, doing: line(`The same gate failed twice in a row: the ${event.to}'s models take the work`, 300) };
    case "routed":
      return { ...s, doing: line(`${event.why[0]!.toUpperCase()}${event.why.slice(1)}: the ${event.to}'s models do it`, 300) };
    case "contract":
      return { ...s, doing: line(event.kept ? `The planner wrote the test the work must pass: $ ${redact(event.command ?? "")}` : `No contract: ${event.why}`, 300) };
    case "tripped":
      return { ...s, step: Math.max(s.step, event.step), doing: line(`Your tripwire ${event.rule} ${event.does === "halt" ? "halted it" : "refused"}: $ ${redact(event.command)}`, 300) };
    case "checked":
      return { ...s, doing: line(`Your check ${event.rule} ${event.exitCode === 0 ? "passed" : "failed"}: $ ${redact(event.command)}`, 300) };
    case "finished":
      return {
        ...s,
        state: event.outcome.status,
        step: event.outcome.steps,
        revisions: event.outcome.revisions,
        gates: event.outcome.gates ? event.outcome.gates.map((g) => ({ command: g.command, by: g.by, exitCode: g.exitCode, excerpt: g.excerpt.slice(0, 1500) })) : s.gates,
        doing: "",
        summary: redact(event.outcome.summary).trim().slice(0, 800),
      };
    default:
      return s;
  }
}
