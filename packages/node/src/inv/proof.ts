import { costOf, plainLine, plainText, type Prices, type TeamTask, type TeamTrailEntry, type UsageLine } from "@invincible/core";
import { judgedWith, type Proof as Seen, proofOf } from "../../../../apps/web/src/lib/steps.ts";
import { EXIT, type ExitCode } from "./exit.ts";

/*
 * A task's proof, as docs/CLI.md ("The proof") promises it, and its verdict as an exit code. What proves it is what the
 * apps' Verified card reads (apps/web/src/lib/steps.ts, proofOf): each gate's command and how it ended, and the
 * reviewer's verdict, as the runner wrote them on the task's trail, never the agent's own account.
 *
 * Verified (0) asks more than the node's own word "verified" does: a gate that failed before the work and passes now,
 * so it shows the work was done, and a reviewer that didn't do the work. Passed without that, it is unproven (12).
 */

export type ProofState = "verified" | "failed" | "rejected" | "unproven" | "stopped" | "needs-you" | "working" | "queued" | "error";

export const STATE_EXIT: Readonly<Record<ProofState, ExitCode>> = {
  verified: EXIT.ok,
  failed: EXIT.gateFailed,
  rejected: EXIT.rejected,
  unproven: EXIT.unproven,
  stopped: EXIT.stopped,
  "needs-you": EXIT.needsYou,
  working: EXIT.stillRunning,
  queued: EXIT.stillRunning,
  error: EXIT.error,
};

/** A gate that shows the work: it failed before any work, and passes now. */
export const proves = (gate: { exit: number | null; before: number | null }): boolean => gate.exit === 0 && gate.before !== null && gate.before !== 0;

const firstLine = (text: string | null | undefined): string => (text ?? "").trim().split("\n")[0]?.trim() ?? "";

/** Whether a task has ended: its proof is final. */
export const ended = (status: TeamTask["status"]): boolean => status === "done" || status === "failed" || status === "stopped";

/** The verdict. `asking`: its agent waits for your approval as it works. */
export function verdictOf(task: Pick<TeamTask, "status" | "verified" | "error" | "record">, seen: Pick<Seen, "gates" | "review" | "sameModel">, asking: boolean): ProofState {
  switch (task.status) {
    case "queued":
      return "queued";
    case "proposed":
    case "interrupted":
      return "needs-you";
    case "running":
      return asking ? "needs-you" : "working";
    case "stopped":
      return "stopped";
    case "done":
      return task.verified && seen.review?.verdict === "pass" && !seen.sameModel && seen.gates.some(proves) ? "verified" : "unproven";
    case "failed": {
      // How its run ended, as the runner recorded it (a task from before records were kept says it in its error).
      const how = task.record?.ended ?? firstLine(task.error);
      if (how === "stopped") return "stopped";
      if (seen.gates.some((gate) => gate.state === "failed")) return "failed";
      if (how === "unverified" && seen.review?.verdict === "revise") return "rejected";
      return "error";
    }
  }
}

export interface ProofGate {
  cmd: string;
  exit: number | null;
  ms: number | null;
  before: number | null;
  failedBefore: boolean;
  said: string;
}

export interface ProofJson {
  v: 1;
  task: string;
  title: string;
  state: ProofState;
  exit: ExitCode;
  word: string;
  agent: string;
  node: string | null;
  project: string | null;
  gates: ProofGate[];
  /** How many steers it judged the work against: every one its run had taken (`steers`, below). */
  review: { verdict: "pass" | "revise"; sameModel: boolean; notes: number; steers: number } | null;
  changes: { files: number; artifact: string } | null;
  costUsd: number | null;
  costComplete: boolean;
  budgetUsd: number | null;
  ms: number | null;
  said: string;
  /** What you and your agent said to it as it ran, in order: whose words, and the step its run took them at (null: never). */
  steers: { by: "owner" | "primary"; text: string; step: number | null }[];
}

export interface ProofFacts {
  /** The apps' word for it, as its row says it. */
  word: string;
  /** Where its agent's VM is (a node's name), and its project's name: null when not known. */
  node: string | null;
  project: string | null;
  prices: Prices;
  asking: boolean;
}

export function proofFor(task: TeamTask, entries: readonly TeamTrailEntry[], facts: ProofFacts): ProofJson {
  const seen = proofOf(task, entries);
  const state = verdictOf(task, seen, facts.asking);
  const cost = task.record ? costOf(task.record.spent as readonly UsageLine[], facts.prices) : null;
  return {
    v: 1,
    task: task.id,
    title: plainLine(task.title),
    state,
    exit: STATE_EXIT[state],
    word: facts.word,
    agent: task.assignee,
    node: facts.node,
    project: facts.project,
    gates: seen.gates.map((gate) => ({ cmd: gate.command, exit: gate.exit, ms: gate.ms, before: gate.before, failedBefore: gate.before !== null && gate.before !== 0, said: plainLine(gate.said) })),
    review: seen.review ? { verdict: seen.review.verdict, sameModel: seen.sameModel, notes: seen.review.notes.split("\n").filter((line) => line.trim()).length, steers: judgedWith(entries) ?? 0 } : null,
    changes: task.changes ? { files: task.changes.files, artifact: task.changes.artifact } : null,
    costUsd: cost ? Math.round(cost.usd * 1e6) / 1e6 : null,
    costComplete: cost ? cost.complete && !cost.unpriced.length : false,
    budgetUsd: task.budgetUsd ?? null,
    ms: task.record ? Math.max(0, task.record.endedAt - task.record.startedAt) : null,
    said: plainLine(firstLine(task.output)),
    steers: (task.steers ?? []).map((steer) => ({ by: steer.by, text: plainText(steer.text), step: steer.taken?.step ?? null })),
  };
}

/** Why it stands where it does, in a few words, for the proof's frame. */
export function reasonOf(proof: Pick<ProofJson, "state" | "gates" | "review">): string {
  const failing = proof.gates.findIndex((gate) => gate.exit !== null && gate.exit !== 0);
  switch (proof.state) {
    case "verified":
      return "by its gates and a reviewer that didn't do the work";
    case "unproven":
      if (proof.review?.verdict === "pass" && proof.review.sameModel) return "reviewed only by the model that did the work";
      if (!proof.gates.length) return "no gate shows the work: the reviewer decided alone";
      if (proof.gates.every((gate) => gate.before === 0)) return "every gate passed before the work, so none shows it";
      return proof.review?.verdict === "pass" ? "no gate shows the work" : "not reviewed";
    case "failed":
      return `gate ${failing + 1} of ${proof.gates.length} didn't pass`;
    case "rejected":
      return "its gates passed, and the reviewer sent it back";
    case "stopped":
      return "stopped before it was verified";
    case "needs-you":
      return "it waits on you";
    case "working":
      return "at work: no verdict yet";
    case "queued":
      return "queued: no verdict yet";
    case "error":
      return "it ended without a gate or a review that says why";
  }
}
