import { costOf, type Prices, spendTotal, tokensLabel, type UsageLine, moneyLabel } from "./spend.ts";
import { KIND_WORDS, type TaskKind } from "./routing.ts";

/*
 * What an agent's task came to, in words: the same from the same record at a terminal and in the
 * app. No dependencies (no zod): the PWA imports this directly (@invincible/core/team-record).
 */

/** The plan a task's coding tool ran on, as this reads it (team.ts TeamTaskPlan has all of this). */
export interface TaskPlanRead {
  seat: string | null;
  kind: string;
  windows: readonly { window: string; share: number }[];
  usd: number | null;
}

/** Whose models did a task's work, as this reads it (team.ts TeamTaskRouting has all of this). */
export interface TaskRoutingRead {
  began: string;
  because?: string;
  moved?: string;
  kind?: string;
  round?: boolean;
}

/** A task's record as this reads it (a TeamTaskRecord has all of this). */
export interface TaskRecordRead {
  startedAt: number;
  endedAt: number;
  ended: string;
  commands: number;
  revisions: number;
  spent: readonly UsageLine[];
  plan?: TaskPlanRead;
  routing?: TaskRoutingRead;
}

/** A plan's kind as a sentence names it (seats.ts SeatKind), and whose sign-in it is where it is a tool's own. */
const PLAN_NAMES: Readonly<Record<string, { plan: string; vendor: string }>> = {
  "claude-subscription": { plan: "Claude plan", vendor: "Claude" },
  "chatgpt-codex": { plan: "ChatGPT plan", vendor: "ChatGPT" },
  "chatgpt-siwc": { plan: "ChatGPT plan", vendor: "ChatGPT" },
  "mistral-vibe": { plan: "Mistral plan", vendor: "Mistral" },
  "google-antigravity": { plan: "Gemini plan", vendor: "Google" },
  plan: { plan: "coding plan", vendor: "coding plan" },
  api: { plan: "API key", vendor: "API key" },
};

/**
 * A plan's window as a person names it, from its tool's name for it (vendor-cli.ts window(): Claude Code's own names,
 * Codex's by their length): five hours, week, week (Opus), its length where it says one, else its name in words.
 */
export function windowName(name: string): string {
  if (name === "five_hour") return "five hours";
  if (name === "seven_day") return "week";
  const model = /^seven_day_([a-z0-9]+)$/.exec(name);
  if (model) return `week (${model[1]!.charAt(0).toUpperCase()}${model[1]!.slice(1)})`;
  const minutes = /^minutes_(\d{1,7})$/.exec(name);
  if (minutes) {
    const n = Number(minutes[1]);
    if (n % 1440 === 0) return `${n / 1440} day${n === 1440 ? "" : "s"}`;
    if (n % 60 === 0) return `${n / 60} hour${n === 60 ? "" : "s"}`;
    return `${n} minutes`;
  }
  return name.replace(/_/g, " ");
}

/**
 * The plan a task's coding tool ran on, in words (I15 step 10): a seat of yours ("on your Claude plan") or its VM's own
 * sign-in ("on its own Claude sign-in"), the share of each window it took (a window it took nothing of is left out),
 * and what its calls would have cost at API prices, which the plan covers (none guessed where none was said).
 */
export function taskPlanFacts(plan: TaskPlanRead): string[] {
  const named = PLAN_NAMES[plan.kind] ?? { plan: "plan", vendor: plan.kind };
  const whose = plan.seat ? `on your ${named.plan}` : `on its own ${named.vendor} sign-in`;
  const shares = plan.windows.filter((window) => window.share > 0).map((window) => `${window.share}% of its ${windowName(window.window)}`);
  return [shares.length ? `${whose}, ${shares.join(" and ")}` : whose, plan.usd === null ? "" : `≈${moneyLabel(plan.usd)} at API prices, covered by the plan`].filter(Boolean);
}

const took = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** Money at your prices: the whole of it, a lower bound ("at least") when a call went unreported, "no price" when a model that answered has none, nothing when nothing was counted. */
function money(total: ReturnType<typeof spendTotal>, cost: ReturnType<typeof costOf>): string {
  if (!total.calls || total.unknown === total.calls) return "";
  if (cost.unpriced.length) return "no price";
  return `${cost.complete ? "" : "at least "}${moneyLabel(cost.usd)}`;
}

/** Why work moved up to the planner's models, as a fact says it (agents' run.ts EscalationWhy: team.ts TeamTaskRouting). */
const MOVED: Readonly<Record<string, string>> = {
  gate: "the same gate failed twice",
  review: "the reviewer sent it back twice",
  stall: "two audits steered it",
  rereads: "it read the same files again and again",
};

/**
 * Whose models did a task's work, when that wasn't the engineer's alone (team.ts TeamTaskRouting): it began on the
 * planner's, because its plan or its agent's last tasks asked for them; or it moved up to them, and why. None: the
 * engineer's did it all.
 */
export function taskRoutingFacts(routing: TaskRoutingRead): string[] {
  const kind = routing.kind && routing.kind in KIND_WORDS ? KIND_WORDS[routing.kind as TaskKind] : null;
  const memory = kind ? `its agent's last ${kind.one} was verified there` : "its agent's last tasks needed them";
  return [
    routing.began === "planner" ? `began on the planner's models: ${routing.because === "memory" ? memory : "its plan asked for them"}` : "",
    routing.began === "engineer" && routing.because === "probe" ? `began on the engineer's models: a try of them after its ${kind?.many ?? "tasks"} began on the planner's` : "",
    routing.moved ? `moved up to the planner's models: ${MOVED[routing.moved] ?? routing.moved}` : "",
    routing.round ? "went round on the planner's models too: you were told" : "",
  ].filter(Boolean);
}

/**
 * A task's run in a few facts, in order: how it ended when that isn't "done", how long it took, its commands and
 * how often the work was sent back, its tokens as the providers reported them (its coding tool's on a plan too),
 * money at your prices where every model that answered has one, the plan its coding tool ran on (taskPlanFacts), and
 * whose models did the work when the planner's did some of it (taskRoutingFacts).
 */
export function taskRecordFacts(record: TaskRecordRead, prices: Prices): string[] {
  const total = spendTotal(record.spent);
  const cost = costOf(record.spent, prices);
  return [
    record.ended === "done" ? "" : record.ended === "gave-up" ? "gave up" : `ended ${record.ended}`,
    // (Under a second, nothing: never "0s".)
    record.endedAt - record.startedAt < 1000 ? "" : took(record.endedAt - record.startedAt),
    `${record.commands} command${record.commands === 1 ? "" : "s"}${record.revisions ? `, sent back ${record.revisions === 1 ? "once" : `${record.revisions} times`}` : ""}`,
    !total.calls ? "no model calls" : total.unknown === total.calls ? "tokens unknown" : `${tokensLabel(total.tokens)}${total.complete ? "" : "+"} tokens`,
    money(total, cost),
    ...(record.plan ? taskPlanFacts(record.plan) : []),
    ...(record.routing ? taskRoutingFacts(record.routing) : []),
  ].filter(Boolean);
}
