import { ACTIVITY_GATES_MAX, ACTIVITY_OTHERS_MAX, type ActivityReview, type ActivityState } from "@invincible/core/live-activity";
import type { TeamTask, TeamTrailEntry } from "@invincible/core/team";
import { factsOfProof, factsOfRecord, proofOf, verdictOf } from "./steps.ts";

/*
 * A task on its Live Activity (core's live-activity.ts), from the task and its trail: what the node says to Apple while
 * the iPhone app isn't in front, and what the app says to its own activity while it is, held to each other by the
 * apps' vectors. Fixed words and counts only: the verdict as its proof allows (verdictOf), each gate as its latest round
 * left it (gateRows), the reviewer, which gate failed, and how many of the team's other tasks are at work (the app keeps
 * one activity for the team). And the line and the word its Lock Screen and its Dynamic Island say of it.
 */

export function activityOf(task: Pick<TeamTask, "status" | "verified" | "record" | "error" | "gates">, entries: readonly TeamTrailEntry[], at: number, others = 0): ActivityState {
  const count = Math.min(Math.max(0, Math.floor(others)), ACTIVITY_OTHERS_MAX);
  const proof = proofOf(task, entries);
  const facts = entries.length ? factsOfProof(proof) : (factsOfRecord(task.record) ?? factsOfProof(proof));
  const said = verdictOf(task, facts);
  // Each gate as its trail has it; where there is none, as its record does (an exit of 0 passed, any other failed).
  const gates = (entries.length || !factsOfRecord(task.record) ? proof.gates.map((gate) => gate.state) : facts.gates.map((gate) => (gate.exit === null ? "waiting" : gate.exit === 0 ? "passed" : "failed"))).slice(0, ACTIVITY_GATES_MAX);
  const review: ActivityReview | null =
    proof.reviewer === "passed" ? "passed" : proof.reviewer === "sent back" ? "sent-back" : proof.reviewer === "reading" ? "reading" : proof.reviewer === "waits" ? "waits" : facts.review === "pass" ? "passed" : facts.review === "revise" ? "sent-back" : null;
  if (said) {
    const failing = facts.gates.findIndex((gate) => gate.exit !== null && gate.exit !== 0);
    const gate = said.verdict === "failed" && failing >= 0 && failing < gates.length ? failing + 1 : null;
    return { phase: "ended", gates, review: review === "reading" || review === "waits" ? null : review, verdict: said.verdict, gate, others: count, at };
  }
  const phase = task.status === "queued" ? "queued" : task.status === "interrupted" ? "interrupted" : proof.reviewer === "reading" ? "review" : "running";
  return { phase, gates, review: phase === "queued" ? null : review, verdict: null, gate: null, others: count, at };
}

/** How many others are at work besides the task it shows, as the roster says the work ("2 at work"): none, nothing. */
export function activityOthers(state: ActivityState): string {
  return state.others > 0 ? `${state.others} more at work` : "";
}

const VERDICT_WORDS: Record<NonNullable<ActivityState["verdict"]>, string> = {
  proven: "Proven",
  reviewed: "Reviewed, not proven",
  failed: "Failed",
  rejected: "Sent back",
  "gave-up": "Gave up",
  stopped: "Stopped",
  unverified: "Not verified",
};

/** What its Lock Screen says under its title (and its Dynamic Island when it opens): where it is, or its verdict. */
export function activityLine(state: ActivityState): string {
  switch (state.phase) {
    case "queued":
      return "Queued";
    case "interrupted":
      return "Interrupted: it needs you";
    case "review":
      return "The reviewer is reading it";
    case "running": {
      const at = state.gates.indexOf("running");
      if (at >= 0) return `Gate ${at + 1} of ${state.gates.length}`;
      return state.review === "sent-back" ? "Back to the work" : "Working";
    }
    case "ended":
      return state.verdict === "failed" && state.gate ? `Failed · gate ${state.gate}` : VERDICT_WORDS[state.verdict!];
  }
}

/** The word its Dynamic Island says beside its orb: how far through its gates, or its verdict in a word. */
export function activityShort(state: ActivityState): string {
  switch (state.phase) {
    case "queued":
      return "Queued";
    case "interrupted":
      return "Needs you";
    case "review":
      return "Review";
    case "running":
      return state.gates.length ? `${state.gates.filter((gate) => gate === "passed").length}/${state.gates.length}` : "Working";
    case "ended":
      return state.verdict === "reviewed" ? "Reviewed" : state.verdict === "unverified" ? "Unverified" : VERDICT_WORDS[state.verdict!];
  }
}
