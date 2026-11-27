import type { View } from "../context.ts";
import { type WorkRow, inProject, namesProjects } from "../lib/work.ts";
import { setWorkOpen, workOpen } from "../prefs.ts";
import { arrive, button, count, setCount, skeletonRows } from "../ui/controls.ts";
import { arrowsThrough, h, keepPlace, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { needsItems, needsVersion } from "./needs.ts";
import { editAgent, giveToAgents } from "./team-forms.ts";
import { askProjects, failedNote, foldLine, projectTile, rowsVersion, workNow, workRow, workSources } from "./work-rows.ts";

/*
 * The work (Home's place, #/home, since the owner's word of 27 November 2026 that the app opens on your agent's chat,
 * as T3 Code opens on a thread): what needs you, three decisions at most with their answers in place (views/needs.ts),
 * the rest a tap away; then the work in one list by attention (what is new to you, then what is at work; what is settled
 * folds), each task a row that opens its thread, with a filter for each project. Your agent and the agents are the
 * sidebar's (views/sidebar.ts), its message box your agent's chat's.
 */

/** The project the list is filtered to on this page, while the app is open (null: every project). */
let filtered: string | null = null;

export const homeView: View = (root, ctx, { scope }) => {
  askProjects(ctx);
  const canGive = ctx.can("fleet:admin") && ctx.can("chat");
  const head = h("header", { class: "page-head" }, h("h1", {}, "Work"));

  // ---- what needs you, then the work ----
  // A list under its heading, as the iPhone's (no card round it): its count rolls as it changes, and breathes once when
  // something new comes.
  const needs = h("section", { class: "home-needs", "aria-label": "Needs you", hidden: true });
  const needsShown = count(0, false, "needs");
  const needsHead = h("h2", { class: "home-needs-head" }, h("span", {}, "Needs you"), needsShown);
  let needsBefore: number | null = null;
  const filters = h("div", { class: "home-filters", role: "group", "aria-label": "Show the work of" });
  const list = h("div", { class: "home-work-rows" }, skeletonRows(4, { avatar: true }));
  // ↑ ↓ Home End through the rows, a fold's line and its failures among them.
  arrowsThrough(list, ".work-row, .home-fold, .fold-failed");
  const work = h("section", { class: "home-work", "aria-labelledby": "home-work-head" }, h("div", { class: "home-work-head" }, h("h2", { id: "home-work-head" }, "Tasks"), filters), list);
  /** What needs you on Home: three decisions at most, each with its answer; the rest a tap away in the Inbox (X2). */
  const NEEDS_SHOWN = 3;

  // What needs you and the work appear whole, in one frame, behind one placeholder until then (as a page body does): the
  // one never pushes the other down as it comes.
  const wait = h("div", { class: "skeleton home-wait", "aria-hidden": "true" });
  const body = h("div", { class: "home-body", hidden: true }, needs, work);
  replace(root, h("div", { class: "home" }, head, wait, body));

  // ---- drawn from what the app has: the Inbox and the team ----
  let shown = "";
  let open = workOpen();
  let named = true;
  const rowEl = (row: WorkRow): HTMLElement => workRow(row, { face: 18, project: named });
  /** A stranger's first day: no agent yet (an agent is added before a task is given to one). */
  const firstDay = (): boolean => ctx.live.team.value !== null && ctx.live.team.value.agents.length === 0;
  /** The page is drawn once the team and the Inbox have both answered (or a moment has passed): what needs you comes in
   * with the work, rather than above it a moment later, pushing it down. */
  const started = Date.now();
  const settled = (): boolean => ctx.live.inboxLoaded.value || Date.now() - started >= 1500;
  scope.timeout(() => draw(), 1500);
  function draw(): void {
    const all = settled() ? workNow(ctx) : null;
    const version = JSON.stringify([all && [rowsVersion(all.needs), rowsVersion(all.active), rowsVersion(all.working), rowsVersion(all.done), all.projects], filtered, [...open], needsVersion(ctx), Boolean(ctx.live.teamProblem.value), firstDay()]);
    if (version === shown) return;
    shown = version;
    // What needs you: amber, only when something waits.
    const items = all ? needsItems(ctx, all) : [];
    needs.hidden = !items.length;
    if (items.length) {
      setCount(needsShown, items.length);
      const beyond = items.length - NEEDS_SHOWN;
      replace(needs, needsHead, ...items.slice(0, NEEDS_SHOWN), beyond > 0 ? h("a", { class: "home-needs-more", href: "#/inbox" }, h("span", { class: "grow" }, `${beyond} more`), icon("chevron-right", { size: 14 })) : null);
      // More waiting than when it was last drawn (not the page's first drawing): one slow breath of its edge.
      if (needsBefore !== null && items.length > needsBefore) arrive(needsShown);
    }
    if (all) needsBefore = items.length;
    if (!all) {
      if (ctx.live.teamProblem.value) {
        replace(list, h("p", { class: "home-note" }, "The work can't be read just now. ", button("Try again", { variant: "ghost", size: "sm", onClick: () => void ctx.live.refreshTeam() })));
        show();
      }
      return;
    }
    // A filter for each project with work, when there is more than one.
    if (filtered && !all.projects.some((project) => project.key === filtered)) filtered = null;
    const chip = (key: string | null, label: string, badge: HTMLElement | null) =>
      h("button", { type: "button", class: "home-filter", "aria-pressed": String(filtered === key), onclick: () => ((filtered = key), (shown = ""), draw()) }, badge, label);
    replace(filters, ...(all.projects.length > 1 ? [chip(null, "All", null), ...all.projects.map((project) => chip(project.key, project.name, projectTile(project)))] : []));
    const shownWork = inProject(all, filtered);
    named = namesProjects(all) && filtered === null;
    const doneOpen = open.has("done");
    const rows = [...shownWork.active, ...shownWork.working];
    keepPlace(list, () =>
      replace(
        list,
        ...rows.map(rowEl),
        shownWork.done.length
          ? // "Done 4 · 1 failed": a failure you've seen is settled, folded with the rest, but said beside the fold, a tap from why.
            foldLine(
              h(
                "button",
                { type: "button", class: "home-fold", "aria-expanded": String(doneOpen), onclick: () => (setWorkOpen("done", !doneOpen), (open = workOpen()), draw()) },
                icon("chevron-right", { size: 14, class: "chev" }),
                h("span", {}, "Done ", h("span", { class: "tnum" }, String(shownWork.done.length))),
              ),
              failedNote(shownWork.done),
            )
          : null,
        ...(doneOpen ? shownWork.done.map(rowEl) : []),
        !rows.length && !shownWork.done.length && !shownWork.needs.length
          ? h(
              "div",
              { class: "home-empty" },
              h("p", {}, filtered ? "Nothing in this project." : firstDay() ? "No agents yet. Ask your agent below, or add your first agent: a name, a lasting job and a workspace of its own. Each task you give it is then a row here, from its first step to proven." : "Nothing under way. Ask your agent below, or give an agent a task: each is a row here, from its first step to proven."),
              canGive && !filtered ? (firstDay() ? button("Add an agent", { size: "sm", icon: "plus", onClick: () => void editAgent(ctx) }) : button("Give a task", { size: "sm", icon: "layers", onClick: () => giveToAgents(ctx) })) : null,
            )
          : null,
      ),
    );
    show();
  }
  function show(): void {
    if (!body.hidden) return;
    wait.remove();
    body.hidden = false;
  }

  for (const source of [...workSources(ctx), ctx.live.inboxCount, ctx.live.inboxLoaded, ctx.live.pairings, ctx.live.secretRequests, ctx.live.questions, ctx.live.notices, ctx.live.loopDrafts, ctx.live.connectorRequests, ctx.live.aboutYou, ctx.live.screenSessions, ctx.live.fleet, ctx.live.teamProblem] as { subscribe(listener: () => void): () => void }[]) scope.add(source.subscribe(() => draw()));
  // "4m" moves on: drawn again each minute (only what changed is).
  scope.interval(() => draw(), 60_000);
  draw();
  void ctx.live.refreshInbox();
};
