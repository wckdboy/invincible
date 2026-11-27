import type { ProjectView } from "@invincible/core";
import type { Ctx } from "../context.ts";
import { isWaiting } from "../live.ts";
import { hashOf } from "../lib/nav.ts";
import { type Attended, attended, type WorkRow } from "../lib/work.ts";
import { dot, type Tone } from "../ui/controls.ts";
import { cx, h } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { agentFace } from "../ui/orb.ts";
import { signal, type Signal } from "../ui/signal.ts";

/*
 * The work's rows, as every list of them draws them (a wide screen's sidebar, a phone's Home): a task in three lines, as
 * T3 Code's sidebar has it (your word, 26 November 2026: "project/tasks/coding t3code style for the [agents]"): its
 * project's badge and name with how it stands in a word in its state's colour; its title; its agent's orb, still, with
 * its name and what it is doing or what it came to. A row opens the task's own thread (#/task/<id>). What the rows say is
 * lib/work.ts's; this only draws them, and keeps what they are drawn from: the team, the approvals waiting, your projects'
 * names. Nothing is asked for per row.
 */

/** Your projects (GET /api/projects), for the names a project's rows go by: asked once a session, where this device may read. */
export const projectNames: Signal<ProjectView[]> = signal<ProjectView[]>([]);
let askedProjects = false;
export function askProjects(ctx: Ctx): void {
  if (askedProjects || !ctx.can("mind:read")) return;
  askedProjects = true;
  ctx.api.get<{ projects: ProjectView[] }>("/api/projects").then(
    (answer) => projectNames.set(answer.projects),
    () => void (askedProjects = false),
  );
}

/** What every list of the work is drawn from: watched, it is drawn again whenever one of these changes. */
export const workSources = (ctx: Ctx): Signal<unknown>[] => [ctx.live.team, ctx.live.actions, projectNames] as Signal<unknown>[];

/** The work by attention as the app has it now (null: the team isn't known yet). */
export function workNow(ctx: Ctx): Attended | null {
  const snapshot = ctx.live.team.value;
  if (!snapshot) return null;
  const now = Date.now();
  const asks = ctx.live.actions.value.filter((action) => isWaiting(action, now)).map((action) => ({ by: action.by, connector: action.connector, tool: action.tool }));
  return attended({ snapshot, projects: projectNames.value, asks, now });
}

/** A row's words, for a screen reader and a tooltip: what it is, where, how it stands and who is on it. */
export const rowLabel = (row: WorkRow): string => [row.title, row.project.name, row.word, `${row.agent.name}${row.detail ? `: ${row.detail}` : ""}`, row.age ? `${row.age} ago` : null].filter(Boolean).join(", ");

/** A project's badge: its letter on a small tile (other work's is an empty, dashed one). */
export const projectTile = (project: WorkRow["project"]): HTMLElement => h("span", { class: cx("work-badge", !project.badge && "is-none"), "aria-hidden": "true" }, project.badge);

/**
 * A task as a row of three lines. `face`: its agent's orb's size (14 to 18; still: only the orb in focus moves).
 * `current`: it is the task open now.
 */
export function workRow(row: WorkRow, opts: { face?: number; current?: boolean; project?: boolean } = {}): HTMLAnchorElement {
  // How it stands: a dot of its colour and its word (proven work, its tick: a tick for nothing less), so neither the
  // colour nor the word is alone.
  const stands = [h("span", { class: "work-word", "data-tone": row.tone }, row.verdict === "proven" ? icon("check", { size: 12 }) : dot(row.tone as Tone), row.word), row.age ? h("span", { class: "work-age tnum" }, row.age) : null];
  // (What it came to, unless its word says it already: "Gave up", never "gave up" again under it.)
  const detail = row.detail && row.detail.toLowerCase() !== row.word.toLowerCase() ? row.detail : "";
  // Its project named only where the work is in more than one (lib/work.ts namesProjects): a row is then two lines, its
  // title with how it stands and its age, and its agent with what it is doing (as the iPhone's).
  const named = opts.project ?? true;
  return h(
    "a",
    {
      class: "work-row",
      href: hashOf("task", { task: row.id }),
      draggable: "false",
      "data-key": `task:${row.id}`,
      "data-attention": row.attention,
      "data-state": row.state,
      "aria-current": opts.current ? "page" : null,
      "aria-label": rowLabel(row),
      title: rowLabel(row),
    },
    named ? h("span", { class: "work-l1" }, projectTile(row.project), h("span", { class: "work-project ellipsis" }, row.project.name), ...stands) : null,
    named ? h("span", { class: "work-l2 ellipsis" }, row.title) : h("span", { class: "work-l2 work-l2-stands" }, h("span", { class: "work-title" }, row.title), ...stands),
    h(
      "span",
      { class: "work-l3" },
      agentFace({ id: row.agent.id, profile: row.agent.avatar, size: opts.face ?? 16 }),
      h("span", { class: "work-agent" }, row.agent.name),
      detail ? h("span", { class: cx("work-detail ellipsis", row.mono && "mono") }, detail) : null,
    ),
  );
}

/** Beside a folded Done, how many of it failed, in red and in words ("Done 4 · 1 failed"; lib/work.ts failedIn), and a
 * tap away: it opens the latest that failed, so why one failed is one tap from the list even once it is settled. None
 * failed: nothing. */
export function failedNote(rows: readonly WorkRow[]): HTMLElement | null {
  const failed = rows.filter((row) => row.state === "failed");
  if (!failed.length) return null;
  const latest = failed.reduce((a, b) => (b.at > a.at ? b : a));
  return h("a", { class: "fold-failed tnum", href: hashOf("task", { task: latest.id }), title: `Why “${latest.title}” failed` }, `${failed.length} failed`);
}

/** A fold's line: its button (its name, its count, its chevron) and, beside it, what failed in it (failedNote). */
export const foldLine = (fold: HTMLElement, failed: HTMLElement | null): HTMLElement => (failed ? h("div", { class: "fold-line" }, fold, failed) : fold);

/** What a list of rows is drawn as, to be compared before drawing it again (a row that says the same is not redrawn). */
export const rowsVersion = (rows: readonly WorkRow[]): string =>
  JSON.stringify(rows.map((row) => [row.id, row.title, row.word, row.tone, row.age, row.detail, row.state, row.project.name, row.agent.name, row.agent.avatar]));
