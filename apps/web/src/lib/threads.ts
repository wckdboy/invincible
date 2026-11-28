import type { ConversationSummary, ProjectView } from "@invincible/core";
import type { ChatState } from "@invincible/core/turns";
import type { AgentState } from "./agent-state.ts";
import { projectKey, type Work, type WorkTask } from "./work.ts";

/*
 * A wide screen's sidebar, as T3 Code's (the owner's word of 28 November 2026: "a near copy of t3code"): your projects,
 * each with its threads, newest first. A thread is one piece of work in a project: a task one of your agents runs (its
 * project is its agent's repository's, as lib/work.ts finds it), or a chat with your agent in that project (the lead's
 * word: your agent's project chats are threads). Your agent's other chats are its own, under its row. Projects keep the
 * order your node lists them in (then the repositories no project of yours names, by name, then "Other work"), so a
 * project never jumps as its work moves; only its threads reorder within it. Pure: no DOM, from what the app already has.
 */

export interface Thread {
  kind: "task" | "chat";
  id: string;
  title: string;
  href: string;
  /** How it stands, as a dot and its word (lib/agent-state.ts). */
  state: AgentState;
  /** The agent whose work it is; null: your agent's own chat. */
  agent: { id: string; name: string; avatar: unknown } | null;
  /** When it last moved. */
  at: number;
}

export interface ThreadProject {
  /** Its repository's address without its scheme, a project of yours with none ("project:<id>"), or "other". */
  key: string;
  /** Yours, when a project of yours names it: where its new threads start. */
  project: string | null;
  name: string;
  threads: Thread[];
}

export interface Threads {
  projects: ThreadProject[];
  /** Work in no repository: last, and only when there is some. */
  other: ThreadProject | null;
  /** Your agent's chats in no project, newest first. */
  own: Thread[];
}

/** A kept chat's state, as a thread's dot says it. */
export function chatState(chat: Pick<ConversationSummary, "state" | "unread">): AgentState {
  const by: Record<ChatState, AgentState> = { working: "working", waiting: "needs", queued: "queued", stopped: "paused", failed: "failed", done: "resting" };
  const state = by[chat.state] ?? "resting";
  return state === "resting" && chat.unread ? "unread" : state;
}

const taskThread = (task: WorkTask): Thread => ({ kind: "task", id: task.id, title: task.title, href: `#/task/${encodeURIComponent(task.id)}`, state: task.state, agent: task.agent, at: task.at });

const chatThread = (chat: ConversationSummary): Thread => ({
  kind: "chat",
  id: chat.id,
  title: chat.title,
  href: `#/chat?c=${encodeURIComponent(chat.id)}`,
  state: chatState(chat),
  agent: null,
  at: chat.updatedAt,
});

const newest = (a: Thread, b: Thread): number => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function threadsOf(input: { work: Pick<Work, "projects" | "other">; projects: readonly ProjectView[]; conversations: readonly ConversationSummary[] }): Threads {
  const groups = new Map<string, ThreadProject>();
  // Yours first, in the order your node lists them: each under its repository's key (or one of its own, with none).
  const keyOf = (project: ProjectView): string => (project.repo && projectKey(project.repo)) || `project:${project.id}`;
  for (const project of input.projects) {
    const key = keyOf(project);
    if (!groups.has(key)) groups.set(key, { key, project: project.id, name: project.name, threads: [] });
  }
  // The repositories your agents work in that no project of yours names, by name.
  const unnamed = input.work.projects.filter((work) => !groups.has(work.key)).sort((a, b) => a.name.localeCompare(b.name));
  for (const work of unnamed) groups.set(work.key, { key: work.key, project: null, name: work.name, threads: [] });
  for (const work of input.work.projects) groups.get(work.key)!.threads.push(...work.tasks.map(taskThread));
  const other: ThreadProject | null = input.work.other?.tasks.length ? { key: "other", project: null, name: "Other work", threads: input.work.other.tasks.map(taskThread) } : null;

  // Your agent's chats: in their project's group, or its own.
  const byId = new Map(input.projects.map((project) => [project.id, keyOf(project)]));
  const own: Thread[] = [];
  for (const chat of input.conversations) {
    const key = chat.project ? byId.get(chat.project) : undefined;
    if (key) groups.get(key)!.threads.push(chatThread(chat));
    else own.push(chatThread(chat));
  }
  for (const group of groups.values()) group.threads.sort(newest);
  other?.threads.sort(newest);
  own.sort(newest);
  return { projects: [...groups.values()], other, own };
}

/** How long ago, as a sidebar's row says it, in a few characters: now, 4m, 3h, 2d, 5w. */
export function age(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
