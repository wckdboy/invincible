import type { Ctx, Route } from "../context.ts";
import { isWaiting } from "../live.ts";
import { galahadState } from "../lib/knight-state.ts";
import { galahadNow, type Now } from "../lib/now.ts";
import { orbMoodOfState } from "../lib/orb-motion.ts";
import { galahadNeeds } from "../lib/roster.ts";
import { type Attended, inboxBeyond, type WorkRow } from "../lib/work.ts";
import { type WorkFold, setWorkOpen, workOpen } from "../prefs.ts";
import { button, dot, kbd, skeletonRows } from "../ui/controls.ts";
import { cx, h, isMac, keepPlace, replace, type Child } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { orb } from "../ui/orb.ts";
import type { Signal } from "../ui/signal.ts";
import { answerStep, chatActivity, galahadWork, nodeTurns, questsInHand, stopChat, unreadChats } from "./chat.ts";
import { openPlaces } from "./places.ts";
import { giveToRoundtable } from "./team-forms.ts";
import { askProjects, rowsVersion, workNow, workRow, workSources } from "./work-rows.ts";

/*
 * A wide screen's sidebar, as T3 Code's (your words, 26 November 2026: "agent first (Galahad), and project/tasks/coding
 * t3code style for the knights"): the mark, a task to give and the sidebar folded away; search; Galahad's row pinned, his
 * orb and what he is doing (it opens his own conversation); then the work in one list by attention, every task a row of
 * three lines (views/work-rows.ts): what needs you, what is new to you, what is at work (folded), what is settled
 * (folded); and at its foot the machine it talks to, the knights, and everything else ("…"). The rail of places went with
 * it: they are under "…" and in the command palette. It asks the node nothing of its own.
 */

export interface Sidebar {
  el: HTMLElement;
  /** Where the app is: Galahad's row or a task's is marked, and his orb is still while his conversation is open beside it. */
  at(where: { route: Route; task?: string | null }): void;
  dispose(): void;
}

/** What his row and line are drawn from, beyond the work's. */
const galahadSources = (ctx: Ctx): Signal<unknown>[] => [nodeTurns, questsInHand, unreadChats, answerStep, chatActivity, ctx.live.inboxCount, ctx.live.inboxLoaded, ctx.live.actions] as Signal<unknown>[];

/** His line, as his row and Home say it: what he is doing, and what needs you that is no task's. */
export function galahadLine(ctx: Ctx): Now {
  const waiting = ctx.live.actions.value.filter((action) => isWaiting(action));
  const needs = ctx.live.inboxLoaded.value ? galahadNeeds(ctx.live.inboxCount.value, waiting, ctx.live.team.value?.teammates.map((person) => person.id) ?? []) : null;
  return galahadNow({ ...galahadWork(), needs });
}

export function sidebarNav(ctx: Ctx, shell: { toggle(): void }): Sidebar {
  askProjects(ctx);
  const canGive = ctx.can("fleet:admin") && ctx.can("chat");
  let where: { route: Route | null; task?: string | null } = { route: null };
  let open = workOpen();

  // ---- the head: the mark, a task to give, the sidebar folded away; then search ----
  const collapse = button("Hide the sidebar", { variant: "ghost", size: "sm", iconOnly: true, icon: "sidebar", title: "Hide the sidebar  ( [ )", onClick: () => shell.toggle() });
  const head = h(
    "div",
    { class: "side-head" },
    h("a", { class: "side-mark", href: "#/home", title: "Home: what needs you, and the work" }, h("img", { src: "/icon-64.png", alt: "", width: 20, height: 20, decoding: "async" }), h("span", { class: "wordmark-text" }, "Galahad")),
    canGive ? button("Give a task", { variant: "ghost", size: "sm", iconOnly: true, icon: "edit", title: "Give a task to the knight best suited to it, or to one by name", onClick: () => giveToRoundtable(ctx) }) : null,
    collapse,
  );
  const search = h(
    "button",
    { class: "search-trigger side-search", type: "button", onclick: () => ctx.palette(), "aria-label": `Search, or ask Galahad (${isMac() ? "⌘" : "Ctrl"}+K)` },
    icon("search", { size: 14 }),
    h("span", { class: "label" }, "Search, or ask"),
    h("span", { class: "kbds" }, ...kbd(isMac() ? "⌘" : "Ctrl", "K")),
  );

  // ---- Galahad, pinned: his orb in his state's colour, his name, and his line. Only the orb in focus moves (your word, 26
  // November 2026: calm): his is still beside a pane with orbs of its own (his conversation's, Home's, the Roundtable's,
  // a task's knight), and moves as he does beside any other page ----
  const face = h("span", { class: "side-galahad-orb" });
  const line = h("span", { class: "side-galahad-line ellipsis" });
  const stop = button("Stop", { variant: "ghost", size: "sm", iconOnly: true, icon: "stop", label: "Stop Galahad answering", onClick: (event) => (event.preventDefault(), stopChat()) });
  const galahad = h("a", { class: "side-galahad", href: "#/chat" }, face, h("span", { class: "side-galahad-text" }, h("strong", {}, "Galahad"), line), stop);
  let shownFace = "";
  const drawGalahad = (): void => {
    const now = galahadLine(ctx);
    const state = galahadState(now);
    const elsewhere = where.route === "chat" || where.route === "home" || where.route === "team" || where.route === "task";
    const look = `${now.tone}/${state}/${elsewhere}`;
    if (look !== shownFace) {
      shownFace = look;
      replace(face, orb({ size: 34, tone: now.tone, mood: elsewhere ? undefined : orbMoodOfState(state), key: "galahad:side" }));
    }
    if (line.textContent !== now.text) line.textContent = now.text;
    line.dataset.tone = now.tone;
    galahad.title = `Galahad: ${now.text}`;
    stop.hidden = !chatActivity.value.streaming;
    if (where.route === "chat") galahad.setAttribute("aria-current", "page");
    else galahad.removeAttribute("aria-current");
  };

  // ---- the work, by attention ----
  const work = h("nav", { class: "side-work", "aria-label": "The work" }, skeletonRows(4));
  let shown = "";
  const section = (label: string, tone: string | null, count: number | null, ...rows: Child[]): HTMLElement =>
    h("section", { class: "side-section", "aria-label": label }, h("h2", { class: "side-label", "data-tone": tone }, label, count !== null ? h("span", { class: "tnum" }, `· ${count}`) : null), ...rows);
  const fold = (which: WorkFold, label: string, rows: WorkRow[]): HTMLElement => {
    const opened = open.has(which);
    // A folded section still shows the task that is open now, as T3 Code's does.
    const shownRows = opened ? rows : rows.filter((row) => row.id === where.task);
    return h(
      "section",
      { class: "side-section", "aria-label": label },
      h("button", { type: "button", class: "side-fold", "aria-expanded": String(opened), onclick: () => toggle(which) }, h("span", { class: "grow" }, label), h("span", { class: "tnum side-fold-count" }, String(rows.length)), icon("chevron-right", { size: 14, class: "chev" })),
      ...shownRows.map(rowEl),
    );
  };
  const toggle = (which: WorkFold): void => {
    setWorkOpen(which, !open.has(which));
    open = workOpen();
    render();
  };
  const rowEl = (row: WorkRow): HTMLElement => workRow(row, { face: 16, current: where.route === "task" && row.id === where.task });

  /** The work is drawn once the team and the Inbox have both answered (or a moment has passed): what needs you then
   * comes in with the rest, rather than above it a moment later, pushing it down. */
  const started = Date.now();
  const settled = (): boolean => ctx.live.inboxLoaded.value || Date.now() - started >= 1500;
  const late = setTimeout(() => render(), 1500);

  function render(): void {
    drawGalahad();
    const now = settled() ? workNow(ctx) : null;
    const beyond = now ? inboxBeyond(ctx.live.inboxCount.value, ctx.live.actions.value.filter((action) => isWaiting(action)), now.needs) : 0;
    const version = JSON.stringify([now && [rowsVersion(now.needs), rowsVersion(now.active), rowsVersion(now.working), rowsVersion(now.done)], beyond, where, [...open], Boolean(ctx.live.teamProblem.value)]);
    if (version === shown) return;
    shown = version;
    keepPlace(work, () => replace(work, ...(now ? sections(now, beyond) : [ctx.live.teamProblem.value ? h("p", { class: "side-note" }, "The work can't be read just now. ", button("Try again", { variant: "ghost", size: "sm", onClick: () => void ctx.live.refreshTeam() })) : skeletonRows(4)])));
  }

  function sections(now: Attended, beyond: number): HTMLElement[] {
    const parts: HTMLElement[] = [];
    const inbox = beyond
      ? h("a", { class: cx("side-inbox", where.route === "inbox" && "is-current"), href: "#/inbox", "aria-current": where.route === "inbox" ? "page" : null }, icon("inbox", { size: 14 }), h("span", { class: "grow" }, "Inbox"), h("span", { class: "work-word", "data-tone": "needs" }, `${beyond} waiting`))
      : null;
    const needs = now.needs.length + beyond;
    if (needs) parts.push(section("Needs you", "needs", needs, inbox, ...now.needs.map(rowEl)));
    if (now.active.length) parts.push(section("Active", null, null, ...now.active.map(rowEl)));
    if (now.working.length) parts.push(fold("working", "Working", now.working));
    if (now.done.length) parts.push(fold("done", "Done", now.done));
    if (!parts.length) {
      parts.push(
        h(
          "div",
          { class: "side-empty" },
          h("p", {}, "No tasks yet. Each task you or Galahad give a knight is a row here: what needs you first, then what is new, at work, and done."),
          canGive ? button("Give a task", { size: "sm", icon: "layers", onClick: () => giveToRoundtable(ctx) }) : null,
        ),
      );
    }
    return parts;
  }

  // ---- the foot: the machine it talks to, the knights, everything else ----
  // (The knights first and the machine after them: what either says when its answer comes changes no other's place.)
  const machine = h("a", { class: "side-pill", href: "#/fleet", hidden: !ctx.can("mind:read") });
  const knights = h("a", { class: "side-pill", href: "#/team", hidden: !ctx.can("chat") });
  const more = button("Everything else", { variant: "ghost", size: "sm", iconOnly: true, icon: "settings", title: "Everything else: places, settings, this device", onClick: (event) => openPlaces(ctx, event.currentTarget as Element) });
  const foot = h("div", { class: "side-foot" }, knights, machine, h("span", { class: "grow" }), more);
  const drawFoot = (): void => {
    const fleet = ctx.live.fleet.value;
    const nodes = fleet ? fleet.devices.filter((device) => device.kind === "node" && !device.revokedAt) : [];
    const online = fleet ? nodes.filter((device) => device.id === fleet.self || fleet.peers.find((peer) => peer.device === device.id)?.online).length : 0;
    // The machine this app talks to, by its name from the first frame; how many of the fleet's are online once it says.
    const self = ctx.whoami.nodeName || ctx.whoami.fleetName || "This node";
    const tone = !fleet ? null : online === nodes.length ? "ok" : online === 0 ? "danger" : "warn";
    replace(machine, dot(tone), h("span", { class: "ellipsis tnum" }, fleet && nodes.length > 1 ? `${self} · ${online}/${nodes.length}` : self));
    machine.setAttribute("aria-label", fleet ? `${self}: ${online} of ${nodes.length} machines online` : self);
    const count = ctx.live.team.value?.teammates.length;
    // (A figure space holds the count's place until the team answers.)
    replace(knights, icon("roundtable", { size: 14 }), h("span", { class: "tnum" }, count === undefined ? "Knights \u2007" : `Knights ${count}`));
    knights.setAttribute("aria-label", count === undefined ? "The knights" : `The knights: ${count}`);
  };

  const el = h("aside", { class: "sidebar", "aria-label": "Galahad and the work" }, head, search, galahad, work, foot);
  const stops = [...workSources(ctx), ...galahadSources(ctx), ctx.live.teamProblem, ctx.live.inboxLoaded].map((source) => source.subscribe(render));
  stops.push(ctx.live.fleet.subscribe(drawFoot), ctx.live.team.subscribe(drawFoot));
  // "2 min ago" moves on, and a working row's time: drawn again each minute (only what changed is).
  const minute = setInterval(render, 60_000);
  render();
  drawFoot();
  return {
    el,
    at(next) {
      where = next;
      render();
    },
    dispose() {
      stops.forEach((stopping) => stopping());
      clearInterval(minute);
      clearTimeout(late);
    },
  };
}
