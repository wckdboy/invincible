import type { TeamMessage, TeamRoom, TeamTask, TeamTaskInput } from "@galahad/core/team";
import { taskEnd } from "./task-card.ts";

/*
 * A knight is one timeline: what was said and the tasks it was given, in the order they
 * happened. Pure (no DOM). A task sits where it was given and stays there while it runs
 * and after it ends, so nothing in the timeline moves under you.
 */

export type TimelineItem = { kind: "message"; key: string; at: number; message: TeamMessage } | { kind: "task"; key: string; at: number; task: TeamTask };

/**
 * `since`: where the words begin, when the node sent only the latest of them. Tasks that ended before it are left
 * out with the words they went with; work still in hand is always there.
 */
export function timeline(messages: readonly TeamMessage[], tasks: readonly TeamTask[], options: { since?: number } = {}): TimelineItem[] {
  const said: TimelineItem[] = messages.map((message) => ({ kind: "message", key: message.id, at: message.createdAt, message }));
  const shown = options.since === undefined ? tasks : tasks.filter((task) => task.createdAt >= options.since! || task.status === "proposed" || task.status === "queued" || task.status === "running");
  // (The node lists tasks latest first: turned round, two given at the same moment keep the order they were given in.)
  const given: TimelineItem[] = [...shown].reverse().map((task) => ({ kind: "task", key: `task:${task.id}`, at: task.createdAt, task }));
  // A stable sort: at the same moment, the words come before the work they asked for.
  return [...said, ...given].sort((a, b) => a.at - b.at);
}

/** The tasks a conversation's timeline holds: for a knight's own, every task given to it, wherever; for a room, the room's. */
export function timelineTasks(room: Pick<TeamRoom, "id" | "direct" | "members">, all: readonly TeamTask[]): TeamTask[] {
  const knight = room.direct && room.members.length === 1 ? room.members[0] : null;
  return all.filter((task) => (knight ? task.assignee === knight : task.room === room.id));
}

/** The same task, given again as a new one: what was asked, of whom and where, and which it gives again (your stepping in,
 * counted on the new one), with what came of it last time (againGoal). One in sensitive mode is again, on the same models. */
export const giveAgain = (task: Pick<TeamTask, "id" | "room" | "assignee" | "title" | "goal" | "gates" | "dependsOn" | "status" | "verified" | "error" | "output" | "models">): TeamTaskInput =>
  ({ room: task.room, assignee: task.assignee, title: task.title.trim(), goal: againGoal(task), gates: [...task.gates], dependsOn: [...task.dependsOn], ...(task.models?.length ? { models: [...task.models] } : {}), again: task.id });

/** Where a try's lesson begins in a goal: replaced by the next try's, never piled up. */
const LAST_TIME = "\n\nLast time (";
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What a task given again is asked: what was asked before, and when it ran and wasn't verified, what came of it (why,
 * what the knight said of its work, and what the independent review said), so the next try starts from there. Only the
 * latest try's is kept; a task stopped, cut off or verified is asked again as it was.
 */
export function againGoal(task: Pick<TeamTask, "id" | "goal" | "status" | "verified" | "error" | "output">): string {
  const asked = task.goal.split(LAST_TIME)[0]!;
  const ran = task.status === "failed" || (task.status === "done" && !task.verified);
  const end = ran ? taskEnd(task) : null;
  if (!end?.why) return asked;
  const review = task.output.split("\n\nReview:")[1]?.split("\nWorkspace:")[0]?.trim() ?? "";
  const lines = [
    `${asked}${LAST_TIME}${task.id}), it ended without verified work: ${end.why}`,
    end.said ? `What it said of its work: ${cut(end.said, 600)}` : null,
    // (A verdict alone, PASS or FAIL, says nothing more.)
    /\s/.test(review) ? `What the independent review said: ${cut(review, 1500)}` : null,
  ];
  return lines.filter(Boolean).join("\n").slice(0, 8000);
}
