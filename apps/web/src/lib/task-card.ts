import { interventionWords } from "@invincible/core/interventions";
import type { TeamTask } from "@invincible/core/team";

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

/** Who gave a task to the agents rather than to an agent by name (null: it was given by name). */
export const givenLine = (task: Pick<TeamTask, "givenBy">): string | null =>
  task.givenBy === "owner" ? "Given to the agents by you" : task.givenBy === "primary" ? "Given to the agents by your agent" : null;

/** Who wrote a task, when an agent did (null: you or the primary gave it): `proposer` is that agent's name. */
export const proposedLine = (task: Pick<TeamTask, "proposedBy" | "status">, proposer: string | null): string | null =>
  !task.proposedBy ? null : task.status === "proposed" ? `${proposer ?? task.proposedBy} proposes this: it starts when you approve it` : `Proposed by ${proposer ?? task.proposedBy}`;

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
