import { LOOK_LIMITS, type TeamTask } from "@invincible/core";
import type { ChatStore } from "./chats.ts";

/*
 * It writes first when a task it gave from a chat of yours ends (your word, 27 November 2026: "be proactive";
 * docs/ARCHITECTURE.md: it proposes the next step when a task ends). Each task it gives from a chat comes with a look of
 * its there for when it ends (set when it gave it, so it reads, as every look does, as one it said it would take): due
 * once the task has ended, a turn of its there (looks.ts), as the device whose turn gave the task and in that turn's
 * zone, which says what came of it and proposes the next step, and starts it itself where that is its to do (its tools,
 * within its money).
 * Once for each way the task ends; a task given before its giving device was kept, a task gone, or a chat gone: none.
 * Within the limits a look of its has: a chat that has as many as may wait gets it at a later run.
 */

const ENDED: Partial<Record<TeamTask["status"], (task: TeamTask) => string>> = {
  done: (task) => (task.verified ? "is done and proven" : "is done but not proven"),
  failed: (task) => `failed${task.error ? `: ${task.error.replace(/\s+/g, " ").trim().slice(0, 200)}` : ""}`,
  stopped: () => "was stopped",
  interrupted: () => "was interrupted",
};

export interface WriteFirstDeps {
  chats: ChatStore;
  /** A task of the team's, as it stands now (null: none). */
  task: (id: string) => TeamTask | null;
  now?: () => number;
}

/** Each task it gave from a chat that ended since it last looked: a look of its due now in that chat. How many it set. */
export function writeFirst(deps: WriteFirstDeps): number {
  const now = (deps.now ?? Date.now)();
  let set = 0;
  for (const given of deps.chats.handoffsToTell()) {
    const task = deps.task(given.task);
    if (!task || !deps.chats.summary(given.conversation)) {
      deps.chats.handoffTold(given.conversation, given.task, "gone");
      continue;
    }
    const how = ENDED[task.status];
    if (!how || given.told === task.status) continue;
    if (deps.chats.looksWaiting(given.conversation).length >= LOOK_LIMITS.perChat || deps.chats.looksWaiting().length >= LOOK_LIMITS.perNode) continue;
    const note = `When the task you gave @${task.assignee}, “${task.title}” (${task.id}), ended: it ${how(task)}. Say what came of it and propose the next step; start it yourself where that is yours to do, within your money.`;
    deps.chats.lookAdd({ conversation: given.conversation, at: now, set: given.at, note: note.slice(0, LOOK_LIMITS.noteChars), zone: given.zone, by: given.by, held: null });
    deps.chats.handoffTold(given.conversation, given.task, task.status);
    set++;
  }
  return set;
}
