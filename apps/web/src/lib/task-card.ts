import { interventionWords } from "@invincible/core/interventions";
import type { TeamTask } from "@invincible/core/team";
import { factsOfRecord, verdictOf } from "./steps.ts";

/*
 * What a task's card says, in words (pure: no DOM). Where it stands, how it ended and why, what the agent
 * said of it, what can be done with it, who gave it to the agents, and what it kept. The card shows these;
 * views/task-card.ts draws them.
 */

type Tone = "ok" | "warn" | "danger" | "accent" | "neutral";

/** Where a task stands, toned as status is everywhere: green only for verified work. */
export function taskBadge(task: Pick<TeamTask, "status" | "verified">): { text: string; tone: Tone } {
  switch (task.status) {
    case "proposed": return { text: "Waiting for you", tone: "accent" };
    case "queued": return { text: "Queued", tone: "neutral" };
    case "running": return { text: "Running", tone: "accent" };
    case "done": return task.verified ? { text: "Verified", tone: "ok" } : { text: "Not verified", tone: "warn" };
    case "failed": return { text: "Failed", tone: "danger" };
    case "stopped": return { text: "Stopped", tone: "neutral" };
    case "interrupted": return { text: "Interrupted", tone: "warn" };
  }
}

/** How an agent's run can end, as the runner records it on a task that wasn't verified. */
const RUN_ENDS: Readonly<Record<string, string>> = {
  "gave-up": "It gave up.",
  unverified: "Not verified: its gates or the independent review did not pass.",
  stopped: "It stopped before the work was done.",
};

/** When nothing was recorded of why. */
const UNSAID: Readonly<Record<string, string>> = { failed: "It failed without saying why.", stopped: "Stopped.", interrupted: "Interrupted. Review it before resuming.", done: "The work was not independently verified." };

/** As much of what the agent said as a card shows. */
const SAID = 1000;

/**
 * How a task ended: why it wasn't verified (null: it was), and what the agent said of it, its own summary before the
 * runner's lines (null: nothing). Null for work still in hand.
 */
export function taskEnd(task: Pick<TeamTask, "status" | "verified" | "error" | "output">): { why: string | null; said: string | null } | null {
  if (task.status === "proposed" || task.status === "queued" || task.status === "running") return null;
  const summary = task.output.split("\n\nReview:")[0]!.trim();
  const said = !summary || summary.startsWith("Review:") ? null : summary.length > SAID ? `${summary.slice(0, SAID - 1)}…` : summary;
  if (task.status === "done" && task.verified) return { why: null, said };
  const error = task.error?.trim();
  return { why: (error && (RUN_ENDS[error] ?? error)) || UNSAID[task.status]!, said };
}

export type TaskAction = "approve" | "decline" | "stop" | "resume" | "again" | "ship";

/** What can be done with a task: a proposal approved or declined, work in hand stopped, work that ended unverified
 * resumed or given again, and verified work it kept shipped as a pull request (not a fix: that goes onto its own). */
export function taskActions(task: Pick<TeamTask, "status" | "verified" | "changes" | "fix" | "shipped">): TaskAction[] {
  if (task.status === "proposed") return ["approve", "decline"];
  if (task.status === "queued" || task.status === "running") return ["stop"];
  if (task.status === "done") return !task.verified ? ["again"] : task.changes && !task.fix && !task.shipped ? ["ship"] : [];
  return ["resume", "again"];
}

/**
 * The one answer a task offers in full on its card (as its thread's prominent button), and the rest, a tap further (the
 * iPhone's TaskCard.answers, I10): a proposal approved, work cut short resumed, verified work shipped, work that wasn't
 * verified given again; declining, stopping and the others in its menu. Work in hand, or verified with nothing to ship,
 * has no answer in full: a list of ten queued tasks isn't ten Stops.
 */
export function taskAnswers(task: Pick<TeamTask, "status" | "verified" | "changes" | "fix" | "shipped">): { prominent: TaskAction | null; rest: TaskAction[] } {
  switch (task.status) {
    case "proposed":
      return { prominent: "approve", rest: ["decline"] };
    case "queued":
    case "running":
      return { prominent: null, rest: ["stop"] };
    case "done":
      if (!task.verified) return { prominent: "again", rest: [] };
      return { prominent: task.changes && !task.fix && !task.shipped ? "ship" : null, rest: ["again"] };
    case "failed":
      return { prominent: "again", rest: ["resume"] };
    case "stopped":
    case "interrupted":
      return { prominent: "resume", rest: ["again"] };
  }
}

/**
 * How a task stands on its card, beside its title (the iPhone's TaskCardView): while it is in hand its word, Waits for
 * you, Working, Queued or Interrupted; once it has ended its verdict as its proof allows (lib/steps.ts verdictOf),
 * never "Verified". `tone`: "proven" in ink with its check, "failed" in red, "active" and "quiet" in the secondary ink.
 */
export function taskStanding(task: Pick<TeamTask, "status" | "verified" | "record" | "error">): { word: string; tone: "proven" | "failed" | "active" | "quiet"; strong: boolean } {
  const verdict = verdictOf(task, factsOfRecord(task.record));
  if (verdict) {
    const failed = verdict.verdict === "failed" || verdict.verdict === "rejected" || verdict.verdict === "gave-up";
    return { word: verdict.word, tone: failed ? "failed" : verdict.verdict === "proven" ? "proven" : "quiet", strong: true };
  }
  if (task.status === "proposed") return { word: "Waits for you", tone: "active", strong: true };
  if (task.status === "running") return { word: "Working", tone: "active", strong: false };
  if (task.status === "queued") return { word: "Queued", tone: "quiet", strong: false };
  return { word: "Interrupted", tone: "active", strong: true };
}

/** Where a task stands in one grey word, as a chat's compact row says it beside its title (I10's phone-gaps, the lead's
 * word of 28 November 2026): working, waiting (its turn, or your yes), done, failed, or stopped (by you, or cut short).
 * Its verdict and the rest are a tap away, in its thread. */
export type TaskWord = "working" | "waiting" | "done" | "failed" | "stopped";
export function taskWord(task: Pick<TeamTask, "status">): TaskWord {
  switch (task.status) {
    case "running":
      return "working";
    case "proposed":
    case "queued":
      return "waiting";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

/** What proves a proposal, in a line under its goal (null: no command was given to prove it). */
export const gatesLine = (gates: readonly string[]): string | null => (gates.length ? `Done when ${gates.join(" · ")} pass${gates.length === 1 ? "es" : ""}` : null);

/** A running task's latest line on its card: the first of its progress, as the node last said it ("" before any). */
export const latestLine = (task: Pick<TeamTask, "progress">): string => (task.progress ?? "").trim().split("\n")[0]?.trim() ?? "";

/** The node a task was handed over from (`node:<id>`, the fabric's hand-offs), by its id; null: it wasn't. */
export const handedFrom = (by: string | undefined): string | null => (by?.startsWith("node:") ? by.slice("node:".length) : null);

/** Who gave a task to the agents rather than to an agent by name (null: it was given by name). `node`: a node's name, by its id. */
export const givenLine = (task: Pick<TeamTask, "givenBy">, node?: (id: string) => string): string | null => {
  const from = handedFrom(task.givenBy);
  if (from) return `Handed over by ${node?.(from) ?? "another node of yours"}`;
  return task.givenBy === "owner" ? "Given to the agents by you" : task.givenBy === "primary" ? "Given to the agents by your agent" : null;
};

/** Who wrote a task, when an agent did (null: you or the primary gave it): `proposer` is that agent's name. */
export const proposedLine = (task: Pick<TeamTask, "proposedBy" | "status">, proposer: string | null): string | null => {
  if (!task.proposedBy) return null;
  // Another node's hand-off beyond your grant: yours to approve, as any proposal.
  if (handedFrom(task.proposedBy)) return task.status === "proposed" ? `${proposer ?? "Another node of yours"} handed this over beyond your grant: it starts when you approve it` : `Handed over by ${proposer ?? "another node of yours"}, beyond your grant`;
  return task.status === "proposed" ? `${proposer ?? task.proposedBy} proposes this: it starts when you approve it` : `Proposed by ${proposer ?? task.proposedBy}`;
};

/** How you stepped in on a task, the north star's count (#28; null: you never did). */
export const steppedLine = (task: Pick<TeamTask, "interventions">): string | null => {
  const words = interventionWords(task.interventions);
  return words ? `You stepped in: ${words}` : null;
};

/** What a task kept of its changes: how many files, and the artifact that holds them (null: nothing kept). */
/** Sensitive mode for this task alone, in a line: the models every call of its work is held to (null: not in it). */
export const sensitiveLine = (task: Pick<TeamTask, "models">): string | null => (task.models?.length ? `Sensitive mode: on ${task.models.join(", ")} alone` : null);

export const keptChanges = (task: Pick<TeamTask, "changes">): { text: string; artifact: string } | null =>
  task.changes ? { text: `${task.changes.files} file${task.changes.files === 1 ? "" : "s"} changed`, artifact: task.changes.artifact } : null;

/** Its pull request, once you shipped it (null: not shipped from an app). */
export const shippedLine = (task: Pick<TeamTask, "shipped">): { text: string; url: string } | null =>
  task.shipped ? { text: task.shipped.pr ? `Pull request #${task.shipped.pr}` : "Its pull request", url: task.shipped.url } : null;
