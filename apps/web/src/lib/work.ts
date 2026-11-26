import type { ProjectView } from "@galahad/core";
import { costOf, type Prices, type UsageLine } from "@galahad/core/spend";
import type { TeamSnapshot, TeamTask, Teammate } from "@galahad/core/team";
import { type KnightState, STATES, type StateLook } from "./knight-state.ts";
import { type Ask, knightOfCaller } from "./roster.ts";
import { relativeTime } from "./time.ts";

/*
 * The work, told by project (your word, 25 November 2026: "way more task/coding focused … the other knights should be
 * more like per task/per project like t3code"): every task a thread of its own, under the project it is in, with the
 * knight on it beside it; and what is under way across all of them, what needs you first. Pure (no DOM), from what the
 * app already has: the team as one snapshot, and your projects.
 *
 * A project is a repository: the one a knight works in (its `repository`), named by a project of yours with that
 * repository where there is one, else by the repository's own last part. A task is in its knight's project; a knight
 * with no repository works on other work.
 */

export interface WorkTask {
  id: string;
  /** The conversation it was given in: where it opens. */
  room: string;
  title: string;
  knight: { id: string; name: string; avatar: unknown };
  /** Its ring's state (lib/knight-state.ts). */
  state: KnightState;
  /** Who, and how it stands, in a line: "Gareth · Gate 1/2 · bun test", "Gareth · verified · 30 min ago". */
  line: string;
  at: number;
}

export interface WorkProject {
  /** Its repository's address without its scheme (github.com/owner/repo), or "other". */
  key: string;
  name: string;
  repo: string | null;
  host: string | null;
  /** The knights that work in it, by handle. */
  knights: string[];
  tasks: WorkTask[];
  running: number;
  needs: number;
}

export interface Work {
  underWay: WorkTask[];
  projects: WorkProject[];
  other: WorkProject | null;
}

/** A repository's address as one key, however it was written (case of its host, `.git`, a trailing slash); null for
 * anything that isn't an https address. */
export function projectKey(repo: string): string | null {
  try {
    const url = new URL(repo.trim());
    if (url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return path.length > 1 ? `${url.host.toLowerCase()}${path}` : null;
  } catch {
    return null;
  }
}

/** A task's state, as its ring shows it: at work; waiting on you (proposed, or cut short and yours to look at); queued;
 * failed; verified; stopped (paused); done without verification, at rest. */
export function taskState(task: Pick<TeamTask, "status" | "verified">): KnightState {
  switch (task.status) {
    case "running": return "working";
    case "proposed": case "interrupted": return "needs";
    case "queued": return "queued";
    case "failed": return "failed";
    case "stopped": return "paused";
    case "done": return task.verified ? "verified" : "resting";
  }
}

const ENDED: Readonly<Record<string, string>> = { "gave-up": "gave up", unverified: "not verified", stopped: "stopped" };
const firstLine = (text: string | null | undefined): string => (text ?? "").trim().split("\n")[0]?.trim() ?? "";

function line(task: TeamTask, who: string, now: number): string {
  const when = relativeTime(task.updatedAt, now);
  switch (task.status) {
    case "running": return `${who} · ${firstLine(task.progress) || "at work"}`;
    case "proposed": return `${task.proposedBy && task.proposedBy !== task.assignee ? "proposed for" : ""} ${who} · waits for your approval`.trim();
    case "queued": return `${who} · queued`;
    case "interrupted": return `${who} · interrupted: look before it resumes`;
    case "failed": {
      const why = firstLine(task.error);
      return `${who} · failed${why ? `: ${ENDED[why] ?? why}` : ""} · ${when}`;
    }
    case "stopped": return `${who} · stopped · ${when}`;
    case "done": return `${who} · ${task.verified ? "verified" : "done, not verified"} · ${when}`;
  }
}

const UNDER_WAY: Partial<Record<KnightState, number>> = { needs: 0, working: 1, queued: 2 };

export function workOf(input: { snapshot: Pick<TeamSnapshot, "teammates" | "tasks">; projects: readonly ProjectView[]; now: number }): Work {
  const { snapshot, now } = input;
  const knights = new Map(snapshot.teammates.map((knight) => [knight.id, knight]));
  const named = new Map(input.projects.flatMap((project) => (project.repo && projectKey(project.repo) ? [[projectKey(project.repo)!, project] as const] : [])));
  const groups = new Map<string, WorkProject>();
  const group = (key: string, make: () => WorkProject): WorkProject => {
    let found = groups.get(key);
    if (!found) groups.set(key, (found = make()));
    return found;
  };
  // Each knight's project, by its repository (so a project with knights but no task yet is still there).
  const projectOf = (repository: string | null | undefined): WorkProject => {
    const key = repository ? projectKey(repository) : null;
    if (!key) return group("other", () => ({ key: "other", name: "Other work", repo: null, host: null, knights: [], tasks: [], running: 0, needs: 0 }));
    const yours = named.get(key);
    return group(key, () => ({ key, name: yours?.name ?? key.split("/").at(-1)!, repo: `https://${key}`, host: key.split("/")[0]!, knights: [], tasks: [], running: 0, needs: 0 }));
  };
  for (const knight of snapshot.teammates) {
    const project = projectOf(knight.repository);
    if (project.key !== "other") project.knights.push(knight.id);
  }
  const tasks = [...snapshot.tasks].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const underWay: WorkTask[] = [];
  for (const task of tasks) {
    const knight = knights.get(task.assignee);
    const project = projectOf(knight?.repository);
    const state = taskState(task);
    const shown: WorkTask = { id: task.id, room: task.room, title: task.title, knight: { id: task.assignee, name: knight?.name ?? task.assignee, avatar: knight?.avatar }, state, line: line(task, knight?.name ?? task.assignee, now), at: task.updatedAt };
    project.tasks.push(shown);
    if (state === "working") project.running++;
    if (state === "needs") project.needs++;
    if (UNDER_WAY[state] !== undefined) underWay.push(shown);
  }
  underWay.sort((a, b) => UNDER_WAY[a.state]! - UNDER_WAY[b.state]! || b.at - a.at);
  const busy = (p: WorkProject) => (p.needs ? 2 : 0) + (p.running ? 1 : 0);
  const latest = (p: WorkProject) => p.tasks[0]?.at ?? 0;
  const projects = [...groups.values()].filter((p) => p.key !== "other").sort((a, b) => busy(b) - busy(a) || latest(b) - latest(a) || a.name.localeCompare(b.name));
  const other = groups.get("other");
  return { underWay, projects, other: other && other.tasks.length ? other : null };
}

/*
 * The work by attention (your word, 26 November 2026: "project/tasks/coding t3code style for the knights"; T3 Code's
 * sidebar, its rows in three lines, what needs you first): every task as a row of three lines (its project and how it
 * stands, its title, its knight and what it is doing or came to), in one of four sections by what it asks of you:
 *
 *   needs    only you can move it on: a proposal to approve, work cut short to look at, its knight asking your leave
 *            while it works, work queued behind a knight you paused;
 *   active   a result new to you: it ended (failed, or done) after you last looked at its knight or its room, on any
 *            device, as an email is unread (a node that keeps no such mark: for half a day after it ended);
 *   working  at work, or queued;
 *   done     settled: ended and seen, or stopped.
 *
 * Pure (no DOM), from what the app already has: the team as one snapshot, your projects, and the approvals waiting.
 * The phone's home, the wide screen's sidebar and the Work page all draw these rows; the iPhone, iPad, Mac and Android
 * apps port this.
 */

export type Attention = "needs" | "active" | "working" | "done";
export const ATTENTION: readonly Attention[] = ["needs", "active", "working", "done"];

export interface WorkRow {
  id: string;
  room: string;
  title: string;
  /** Its knight's repository, as the work names it: its key, its name, and the letter on its badge ("" for other work). */
  project: { key: string; name: string; badge: string };
  knight: { id: string; name: string; avatar: unknown };
  state: KnightState;
  attention: Attention;
  /** How it stands in a word or two, at the end of its first line in its state's colour: "Allow?", "Failed · gate 2",
   * "Verified", "Working · 4m", "Queued". Never colour alone: the word says it. */
  word: string;
  tone: StateLook["tone"];
  /** How long since it last moved ("12m", "3h", "2d"); null at work, whose word says how long it has been in hand. */
  age: string | null;
  /** Its third line, after its knight's name: what it is doing, or what it came to ("bun test packages/link", "5 files
   * kept", "gave up"). Empty: nothing more to say. */
  detail: string;
  /** The detail is a command or a path, set in mono. */
  mono: boolean;
  /** When it last moved: the order within a section. */
  at: number;
}

export interface Attended {
  needs: WorkRow[];
  active: WorkRow[];
  working: WorkRow[];
  done: WorkRow[];
  /** The projects with tasks, for the filters: the busiest first, as the work's projects are ordered. */
  projects: { key: string; name: string; badge: string; count: number }[];
}

export interface AttentionInput {
  snapshot: Pick<TeamSnapshot, "teammates" | "tasks" | "seen">;
  projects: readonly Pick<ProjectView, "name" | "repo">[];
  /** Approvals waiting for your answer (lib/roster.ts' Ask): one a knight filed is its running task's to show. */
  asks?: readonly Ask[];
  now: number;
}

const MINUTE = 60_000;
/** How long a result stays new to you on a node that keeps no read marks. */
export const NEW_FOR_MS = 12 * 60 * MINUTE;

/** A span of time as a row says it, short: "now", "4m", "3h", "2d". */
export function shortSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The letter on a project's badge: its name's first letter or digit, as a capital ("" for none). */
export const projectBadge = (name: string): string => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "").toLocaleUpperCase();

/** Each knight's project (by its repository, named by a project of yours with that repository), and other work's. */
export function projectsOfKnights(teammates: readonly Pick<Teammate, "id" | "repository">[], projects: readonly Pick<ProjectView, "name" | "repo">[]): (knight: string) => { key: string; name: string; badge: string } {
  const named = new Map(projects.flatMap((project) => (project.repo && projectKey(project.repo) ? [[projectKey(project.repo)!, project.name] as const] : [])));
  const of = new Map(
    teammates.map((knight) => {
      const key = knight.repository ? projectKey(knight.repository) : null;
      if (!key) return [knight.id, OTHER] as const;
      const name = named.get(key) ?? key.split("/").at(-1)!;
      return [knight.id, { key, name, badge: projectBadge(name) }] as const;
    }),
  );
  return (knight) => of.get(knight) ?? OTHER;
}
const OTHER = { key: "other", name: "Other work", badge: "" } as const;

/** What a task's latest line says it is doing, for its row: the command it runs (mono), else the step it is at. */
export function doingNow(progress: string): { text: string; mono: boolean } {
  const line = firstLine(progress);
  const [mark, ...rest] = line.split(" · ");
  const said = rest.join(" · ").trim();
  switch (mark) {
    case "Running": return { text: said, mono: true };
    case "Plan": return { text: "planning", mono: false };
    case "Thinking": return { text: "thinking", mono: false };
    case "Submitted for review": return { text: "its gates run", mono: false };
    case "Review": return { text: "in review", mono: false };
    case "Exit": return { text: "reading what it printed", mono: false };
  }
  const gate = /^Gate (\d+)\/(\d+)$/.exec(mark ?? "");
  if (gate) return { text: `gate ${gate[1]} of ${gate[2]}`, mono: false };
  return { text: line.length > 80 ? `${line.slice(0, 79)}…` : line, mono: false };
}

/** The gate a failed task's latest line says it failed at (null: it doesn't say). */
export const failedGate = (progress: string): number | null => {
  const gate = /^Gate (\d+)\/\d+ · exit (-?\d+)/.exec(firstLine(progress));
  return gate && gate[2] !== "0" ? Number(gate[1]) : null;
};

export function attended(input: AttentionInput): Attended {
  const { snapshot, now } = input;
  const knights = new Map(snapshot.teammates.map((knight) => [knight.id, knight]));
  const projectOf = projectsOfKnights(snapshot.teammates, input.projects);
  const titles = new Map(snapshot.tasks.map((task) => [task.id, task.title]));
  // What a knight asks your leave for, while its task runs (a knight works one thing at a time).
  const asking = new Map<string, Ask[]>();
  for (const ask of input.asks ?? []) {
    const knight = knightOfCaller(ask.by);
    if (knight) asking.set(knight, [...(asking.get(knight) ?? []), ask]);
  }
  const seenAt = (task: TeamTask): number | null => {
    if (!snapshot.seen) return null;
    return Math.max(snapshot.seen[`knight:${task.assignee}`] ?? 0, snapshot.seen[`room:${task.room}`] ?? 0);
  };
  const out: Attended = { needs: [], active: [], working: [], done: [], projects: [] };
  const counts = new Map<string, { key: string; name: string; badge: string; count: number; busy: number; at: number }>();
  for (const task of snapshot.tasks) {
    const knight = knights.get(task.assignee);
    const name = knight?.name ?? task.assignee;
    const project = projectOf(task.assignee);
    const row = rowOf(task, { name, paused: knight ? !knight.enabled : false, asks: task.status === "running" ? (asking.get(task.assignee) ?? []) : [], seen: seenAt(task), now, titles });
    const shown: WorkRow = { id: task.id, room: task.room, title: task.title, project, knight: { id: task.assignee, name, avatar: knight?.avatar }, ...row, at: task.updatedAt };
    out[row.attention].push(shown);
    const counted = counts.get(project.key) ?? { ...project, count: 0, busy: 0, at: 0 };
    counted.count++;
    counted.busy = Math.max(counted.busy, row.attention === "needs" ? 3 : row.attention === "active" ? 2 : row.attention === "working" ? 1 : 0);
    counted.at = Math.max(counted.at, task.updatedAt);
    counts.set(project.key, counted);
  }
  const newest = (a: WorkRow, b: WorkRow) => b.at - a.at || (a.id < b.id ? -1 : 1);
  out.needs.sort(newest);
  out.active.sort(newest);
  out.done.sort(newest);
  // At work before queued, and each the latest first.
  out.working.sort((a, b) => Number(b.state === "working") - Number(a.state === "working") || newest(a, b));
  out.projects = [...counts.values()]
    .sort((a, b) => Number(a.key === "other") - Number(b.key === "other") || b.busy - a.busy || b.at - a.at || a.name.localeCompare(b.name))
    .map(({ key, name, badge, count }) => ({ key, name, badge, count }));
  return out;
}

/** The rows of one project alone (a filter), its sections as they were; every project's with none. */
export function inProject(work: Attended, key: string | null): Attended {
  if (key === null) return work;
  const only = (rows: WorkRow[]) => rows.filter((row) => row.project.key === key);
  return { needs: only(work.needs), active: only(work.active), working: only(work.working), done: only(work.done), projects: work.projects };
}

/** Every row, in the order of attention: what needs you, what is new to you, what is at work, then what is settled. */
export const byAttention = (work: Attended): WorkRow[] => ATTENTION.flatMap((section) => work[section]);

interface RowFacts {
  name: string;
  paused: boolean;
  asks: readonly Ask[];
  /** When its knight's page or its room was last looked at (null: the node keeps no such mark). */
  seen: number | null;
  now: number;
  titles: ReadonlyMap<string, string>;
}

type RowState = Pick<WorkRow, "state" | "attention" | "word" | "tone" | "age" | "detail" | "mono">;

function rowOf(task: TeamTask, f: RowFacts): RowState {
  const age = shortSpan(f.now - task.updatedAt);
  const say = (state: KnightState, attention: Attention, word: string, detail = "", mono = false, shownAge: string | null = age): RowState => ({ state, attention, word, tone: STATES[state].tone, age: shownAge, detail, mono });
  switch (task.status) {
    case "proposed": {
      const by = task.proposedBy && task.proposedBy !== task.assignee ? `proposed for ${f.name}` : "proposed by its knight";
      return say("needs", "needs", "Approve?", task.proposedBy ? by : "waits for your approval");
    }
    case "interrupted":
      return say("needs", "needs", "Interrupted", "look at it before it resumes");
    case "running": {
      const ask = f.asks[0];
      const doing = doingNow(task.progress);
      if (ask) return say("needs", "needs", "Allow?", ask.connector && ask.tool ? `${ask.connector}.${ask.tool}` : "asks your leave", Boolean(ask.connector), age);
      const span = shortSpan(f.now - task.createdAt);
      return say("working", "working", span === "now" ? "Working" : `Working · ${span}`, doing.text, doing.mono, null);
    }
    case "queued": {
      if (f.paused) return say("needs", "needs", "Knight paused", `resume ${f.name} to start it`);
      const waiting = task.dependsOn.map((id) => f.titles.get(id)).find((title) => title !== undefined);
      return say("queued", "working", "Queued", waiting ? `after “${waiting}”` : "");
    }
    case "stopped":
      return say("paused", "done", "Stopped");
  }
  // Ended: done (verified), or failed (which a task that wasn't verified is). New to you until you look.
  const unread = f.seen === null ? f.now - task.updatedAt < NEW_FOR_MS : task.updatedAt > f.seen;
  const attention: Attention = unread ? "active" : "done";
  if (task.status === "done") {
    const detail = task.shipped ? (task.shipped.pr ? `PR #${task.shipped.pr}` : "shipped") : task.changes ? `${task.changes.files} file${task.changes.files === 1 ? "" : "s"} kept` : "";
    return task.verified ? say("verified", attention, "Verified", detail) : say("resting", attention, "Not verified", detail);
  }
  const why = firstLine(task.error);
  const gate = failedGate(task.progress);
  return say("failed", attention, gate ? `Failed · gate ${gate}` : "Failed", ENDED[why] ?? (why.length > 60 ? `${why.slice(0, 59)}…` : why));
}

/** What waits in the Inbox beyond the task rows that ask for it: its count, less the approvals a needs row stands for
 * (its knight asking your leave as its task runs). Devices asking to join, keys he asked for, notices, his own asks. */
export function inboxBeyond(inbox: number, asks: readonly Pick<Ask, "by">[], needs: readonly Pick<WorkRow, "word" | "knight">[]): number {
  const asking = new Set(needs.filter((row) => row.word === "Allow?").map((row) => row.knight.id));
  return Math.max(0, inbox - asks.filter((ask) => asking.has(knightOfCaller(ask.by) ?? "")).length);
}

/**
 * What opening a task marks as read, on every device (POST /api/team/seen): its knight's page, when the task has ended
 * and is the latest of that knight's results still new to you. Read marks are kept by knight and by room, as a time, so
 * this settles that knight's older results too, as opening its page does; an older result opened first marks nothing,
 * and the newest still waits for you. Null: nothing to mark (still in hand, already read, or a node that keeps no marks).
 */
export function seenOnOpen(id: string, snapshot: Pick<TeamSnapshot, "tasks" | "seen">): { knight: string } | null {
  const task = snapshot.tasks.find((one) => one.id === id);
  if (!task || !snapshot.seen || !(task.status === "done" || task.status === "failed")) return null;
  const seenAt = (one: TeamTask) => Math.max(snapshot.seen?.[`knight:${one.assignee}`] ?? 0, snapshot.seen?.[`room:${one.room}`] ?? 0);
  const unread = snapshot.tasks.filter((one) => one.assignee === task.assignee && (one.status === "done" || one.status === "failed") && one.updatedAt > seenAt(one));
  const newest = unread.reduce<TeamTask | undefined>((latest, one) => (!latest || one.updatedAt > latest.updatedAt ? one : latest), undefined);
  return newest?.id === task.id ? { knight: task.assignee } : null;
}

/** Home's line under Galahad's name (the phone's header): how many are at work and how much needs you, else his own line. */
export function atAGlance(work: Pick<Attended, "working">, needs: number, his: string): { text: string; needs: boolean } {
  const atWork = work.working.filter((row) => row.state === "working").length;
  const parts = [atWork ? `${atWork} at work` : null, needs ? `${needs} need${needs === 1 ? "s" : ""} you` : null].filter((part): part is string => part !== null);
  return parts.length ? { text: parts.join(" · "), needs: needs > 0 } : { text: his, needs: false };
}

/**
 * What a knight's tasks that ended since `since` cost at your prices, as their runner recorded them: its sum, and
 * whether it is the whole of it (a call that reported nothing, or a model with no price, makes it a lower bound). Null:
 * none of its tasks ended in that time with a model call counted.
 */
export function spentSince(tasks: readonly Pick<TeamTask, "assignee" | "record">[], knight: string, since: number, prices: Prices): { usd: number; complete: boolean } | null {
  const lines = tasks.filter((task) => task.assignee === knight && task.record && task.record.endedAt >= since).flatMap((task) => task.record!.spent as UsageLine[]);
  if (!lines.some((line) => line.calls > line.unknown)) return null;
  const cost = costOf(lines, prices);
  return { usd: cost.usd, complete: cost.complete && !cost.unpriced.length };
}
