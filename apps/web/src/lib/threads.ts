import type { ConversationSummary, ProjectView, TeamChangedFile, TeamTask } from "@invincible/core";
import type { ChatState } from "@invincible/core/turns";
import type { AgentState } from "./agent-state.ts";
import type { Verdict } from "./steps.ts";
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

/**
 * What a desk's thread header names beside its title (views/task.ts, from 1024 px), as T3 Code's does:
 *  - its verdict as its proof allows it (lib/steps.ts verdictOf), toned as its row and its card are (lib/work.ts);
 *  - the branch its fix is on, or else the commit its work began from (kept, or read from its VM: `base`);
 *  - its pull request: where it was shipped, or the one its fix is on (a fix is always GitHub's: TeamTaskFix).
 */
export interface ThreadChips {
  verdict: { word: string; tone: "ok" | "failed" | "neutral"; proven: boolean } | null;
  branch: { text: string; title: string } | null;
  pr: { number: number; url: string } | null;
}

export function threadChips(task: Pick<TeamTask, "shipped" | "fix" | "changes">, verdict: { word: string; verdict: Verdict } | null, base: string | null = null): ThreadChips {
  const failed = verdict?.verdict === "failed" || verdict?.verdict === "rejected" || verdict?.verdict === "gave-up";
  const from = task.changes?.base ?? base;
  const fix = task.fix;
  const shipped = task.shipped?.pr ? { number: task.shipped.pr, url: task.shipped.url } : null;
  return {
    verdict: verdict ? { word: verdict.word, tone: verdict.verdict === "proven" ? "ok" : failed ? "failed" : "neutral", proven: verdict.verdict === "proven" } : null,
    branch: fix ? { text: fix.branch, title: `On ${fix.branch}` } : from ? { text: `from ${from.slice(0, 8)}`, title: `Its work began from ${from}` } : null,
    pr: shipped ?? (fix?.pr ? { number: fix.pr, url: `https://github.com/${encodeURIComponent(fix.owner)}/${encodeURIComponent(fix.repo)}/pull/${fix.pr}` } : null),
  };
}

/** What a task changed, in a line over its files (a desk's Changes panel): how many, the lines added and taken away (a
 * binary file counts none), and since when. */
export function changesLine(view: { files: readonly Pick<TeamChangedFile, "added" | "removed">[]; base: string | null }): { files: number; added: number; removed: number; from: string } {
  return {
    files: view.files.length,
    added: view.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: view.files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    from: view.base ? `from ${view.base.slice(0, 8)}` : "since its last commit",
  };
}

/** A file's part of a diff from its first hunk (a desk's Changes, as T3 Code's diff shows it): its header lines (diff --git,
 * index, ---, +++) say only what its file's line above it says. A part with no hunk (a binary file, a mode changed) whole. */
export function hunksOf(part: string): string {
  if (part.startsWith("@@")) return part;
  const at = part.indexOf("\n@@");
  return at < 0 ? part : part.slice(at + 1);
}
