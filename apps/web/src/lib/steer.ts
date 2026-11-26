import type { TeamSteer, TeamTask } from "@invincible/core/team";
import { composerAction, type EnterPref } from "./turns.ts";

/*
 * Steering an agent's running task, in words (pure: no DOM). While a task runs its composer does one of two things: it
 * steers the task (POST /api/team/steer: the run takes the words at its next safe point, and its reviewer judges the
 * work against them) or it queues a message for after it (POST /api/team/messages: its agent answers once the task is
 * done). Enter does what this device chose (Settings → Chat, as a chat's composer does), Ctrl or ⌘ with Enter the other.
 * The views draw these; the iPhone, iPad, Mac and Android apps port them, held to the vectors.
 */

/** The composer's two actions while a task runs, in the brief's words, and what each does. */
export const STEER_WORDS = {
  steer: "Steer this task",
  queue: "Queue for after it",
  steerTitle: "It takes your words at its next safe point: a command it's running finishes first",
  queueTitle: "A message, kept until this task is done: its agent answers then",
} as const;

/** What sending does from a task's composer: while it runs, steer or queue as Enter and its modifier say; otherwise a message. */
export function steerAction(input: { running: boolean; enter: EnterPref; modifier: boolean }): "send" | "steer" | "queue" {
  return composerAction({ busy: input.running, enter: input.enter, modifier: input.modifier, canQueue: true });
}

/**
 * The line under a task's composer: while it runs, what the keys do now (a phone's buttons say it themselves); queued,
 * when its agent answers a message (after this task: the node runs an agent's work in order). Otherwise nothing.
 */
export function steerHint(input: { status: TeamTask["status"]; name: string; enter: EnterPref; coarse: boolean; mac: boolean }): string {
  if (input.status === "queued") return `${input.name} answers after this task`;
  if (input.status !== "running" || input.coarse) return "";
  const mod = input.mac ? "⌘" : "Ctrl";
  // (Short enough to stand beside the composer's two buttons on a laptop.)
  return input.enter === "steer" ? `Enter steers ${input.name} · ${mod}+Enter queues for after it` : `Enter queues for after it · ${mod}+Enter steers ${input.name}`;
}

/** A steer as a line: whose words, then what they said (its first line). */
const lineOf = (steer: Pick<TeamSteer, "by" | "text">): string => `${steer.by === "owner" ? "You" : "Your agent"}: ${steer.text.trim().split("\n")[0]}`;

/** What is on its way to the work: what you and your agent said that its run hasn't taken yet, in order (null: nothing, or it has ended). */
export function steersWaiting(task: Pick<TeamTask, "status" | "steers">, name: string): { title: string; lines: string[] } | null {
  if (task.status !== "running") return null;
  const waiting = (task.steers ?? []).filter((steer) => !steer.taken);
  return waiting.length ? { title: `On its way to ${name}, at its next safe point`, lines: waiting.map(lineOf) } : null;
}

/** What an ended task never took: it ended before those words reached it (null: nothing of the kind, or it hasn't ended). */
export function neverReached(task: Pick<TeamTask, "status" | "steers">): { title: string; lines: string[] } | null {
  if (task.status !== "done" && task.status !== "failed" && task.status !== "stopped") return null;
  const never = (task.steers ?? []).filter((steer) => !steer.taken);
  return never.length ? { title: "It ended before this reached it", lines: never.map(lineOf) } : null;
}

/**
 * What its proof was judged against, in a line, from how many steers its latest review judged the work against (the
 * trail's judgedWith) and the task's steers: "Judged against its brief and your steer". Null: none, or no review.
 */
export function judgedLine(judged: number | null, steers: readonly Pick<TeamSteer, "by" | "taken">[]): string | null {
  if (!judged) return null;
  const taken = steers.filter((steer) => steer.taken);
  const these = taken.slice(0, judged);
  if (these.length < judged) return `Judged against its brief and ${judged === 1 ? "a steer" : `${judged} steers, in order`}`;
  if (judged < taken.length) return `Judged against its brief and the first ${judged === 1 ? "" : `${judged} `}of its ${taken.length} steers`;
  const n = judged === 1 ? "steer" : `${judged} steers`;
  const order = judged > 1 ? ", in order" : "";
  if (these.every((steer) => steer.by === "owner")) return `Judged against its brief and your ${n}${order}`;
  if (these.every((steer) => steer.by === "primary")) return `Judged against its brief and your agent's ${n}${order}`;
  return `Judged against its brief and ${judged} steers, yours and your agent's${order}`;
}
