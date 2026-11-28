import type { ProjectView } from "@invincible/core";
import type { Ctx, Route } from "../context.ts";
import { type AgentState, primaryState, withState } from "../lib/agent-state.ts";
import { glassState } from "@invincible/core/glass";
import { button, dot, kbd } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { arrowsThrough, h, isMac, replace } from "../ui/dom.ts";
import { guardianMark } from "../ui/glass.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { agentMark, markStateOfAgent } from "../ui/mark.ts";
import { appMark } from "../ui/orb.ts";
import { needsCount } from "./needs.ts";
import { homeTimes, tableOf, tableSources } from "./roster.ts";
import { askProjects, projectNames, workNow, workSources } from "./work-rows.ts";
import { openDirect } from "./team-forms.ts";
import { placesFor, taskOf } from "../lib/nav.ts";
import { teamLocation } from "../lib/team.ts";
import { listTime } from "../lib/time.ts";

/*
 * The roster (the owner's word of 27 November 2026: "something like t3code on desktop, and openmausbot/grokbot on
 * mobile"): a wide screen's sidebar, an icon rail on a screen between, and a phone's drawer, the same list in each. What
 * needs you first, its count, to its page; then your agent, with its line; then each agent (its glass, its state the
 * glass's dot, its name and its latest line, muted), each room and each project. At its foot the work, Settings,
 * everything else and the machine it talks to. Drawn from the table the app has (views/roster.ts tableOf) and kept true
 * while it shows: it asks the node nothing of its own but your projects' names, once a session. A group comes whole, so
 * nothing above anything moves as the rest arrives (the scorecard's layout shift).
 */

export interface Roster {
  el: HTMLElement;
  /** Where the app is: that row is marked. */
  at(where: { route: Route; room?: string | null; task?: string | null }): void;
  dispose(): void;
}

/** One row: a face, a name and a line. Its key says which thing it is, so a row is kept as it changes. */
interface Row {
  key: string;
  href: string;
  run?: () => void;
  face: () => HTMLElement | SVGElement;
  /** What its face is drawn from: a new one only when this changes. */
  look: string;
  name: string;
  line: string;
  state: AgentState;
  /** A phone's list: when it last did something, and what its dot says (null: no dot). */
  end?: { time: string; mark: string | null };
}

/**
 * [phone]: the drawer as a phone's list (I10's phone-gaps, the lead's word of 28 November 2026): your agent pinned, then
 * every agent and room the latest first, each its face (its glass moves as it stands, no dot on it), its name, its line
 * in plain words (RosterRow.plain), and at its end when, and an ink dot where something waits on you or is new; no
 * Needs you row (each ask is in its own chat), no section's head, no projects; at its foot Settings and everything else.
 */
export function rosterNav(ctx: Ctx, picked: () => void = () => {}, phone = false): Roster {
  const stops: (() => void)[] = [];
  const rows = new Map<string, { el: HTMLElement; face: HTMLElement; look: string; text: string }>();
  /** Where the app is, and the row that is (worked out again as the table comes: a room's agent is known only then). */
  let where: { route: Route; room?: string | null; task?: string | null } = { route: "chat" };
  let current: string | null = null;
  const currentOf = (): string | null => {
    const table = tableOf(ctx);
    const task = where.task ? table.snapshot?.tasks.find((one) => one.id === where.task) : undefined;
    const agent = where.room ? table.seats.find((seat) => seat.room === where.room) : task ? table.seats.find((seat) => seat.id === task.assignee) : undefined;
    return where.route === "chat" ? "primary" : agent && agent.id !== "primary" ? `agent:${agent.id}` : where.room ? `room:${where.room}` : null;
  };
  const mark = (): void => {
    current = currentOf();
    for (const [key, row] of rows) {
      if (key === current) row.el.setAttribute("aria-current", "page");
      else row.el.removeAttribute("aria-current");
    }
  };

  const draw = (row: Row): HTMLElement => {
    const text = `${row.name}\n${row.line}\n${row.state}\n${row.href}\n${row.end?.time ?? ""}\n${row.end?.mark ?? ""}`;
    const kept = rows.get(row.key);
    if (kept && kept.text === text && kept.look === row.look) return kept.el;
    const face = kept && kept.look === row.look ? kept.face : h("span", { class: "roster-face" }, row.face());
    const label = `${withState(row.name, row.state)}${row.line ? `: ${row.line}` : ""}${row.end?.mark ? `, ${row.end.mark}` : ""}${row.end?.time ? `, ${row.end.time}` : ""}`;
    const attrs = { class: "roster-row", "data-state": row.state, title: label, "aria-label": row.end ? label : null, "aria-current": current === row.key ? "page" : null };
    const parts = [
      face,
      h("span", { class: "roster-text" }, h("span", { class: "roster-name" }, row.name), h("span", { class: "roster-line" }, row.line)),
      // (Its dot's place is kept whether or not it shows, so a row never moves as its dot comes and goes.)
      row.end ? h("span", { class: "roster-end", "aria-hidden": "true" }, h("span", { class: "roster-time tnum" }, row.end.time), h("span", { class: "roster-mark", "data-on": row.end.mark ? "" : null })) : null,
    ];
    const el = row.run
      ? h("button", { ...attrs, type: "button", onclick: () => (picked(), row.run?.()) }, ...parts)
      : h("a", { ...attrs, href: row.href, onclick: () => picked() }, ...parts);
    el.dataset.key = row.key;
    kept?.el.replaceWith(el);
    rows.set(row.key, { el, face, look: row.look, text });
    return el;
  };

  // ---- what needs you: always there, so its count coming moves nothing ----
  const needsCountEl = h("span", { class: "roster-count tnum" });
  const needs = h("a", { class: "roster-needs", href: "#/inbox", onclick: () => picked() }, icon("inbox", { size: 16 }), h("span", { class: "roster-text" }, h("span", { class: "roster-name" }, "Needs you")), needsCountEl);
  const drawNeeds = (): void => {
    const work = ctx.live.inboxLoaded.value ? workNow(ctx) : null;
    const n = work ? needsCount(ctx, work) : ctx.live.inboxCount.value;
    needsCountEl.textContent = n ? String(n) : "";
    needs.dataset.count = n ? "some" : "none";
    needs.setAttribute("aria-label", n ? `Needs you: ${n}` : "Needs you: nothing");
    needs.title = n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "Nothing needs you";
  };

  // ---- your agent, the agents, the rooms ----
  const primarySlot = h("div", { class: "roster-primary" });
  const agents = h("div", { class: "roster-group", role: "group", "aria-label": "Agents" });
  const rooms = h("div", { class: "roster-group", role: "group", "aria-label": "Rooms" });
  const heading = (text: string, href: string): HTMLElement => h("a", { class: "roster-heading", href, onclick: () => picked() }, text);
  let shownAgents = "";
  let shownRooms = "";
  const drawTable = (): void => {
    const table = tableOf(ctx);
    const [primary, ...seats] = table.seats;
    const times = phone ? homeTimes(ctx) : null;
    const now = Date.now();
    const size = phone ? 44 : 22;
    const at = (key: string): string => {
      const when = times?.get(key);
      return when ? listTime(when, now) : "";
    };
    if (primary) {
      const state = primary.now ? primaryState(primary.now) : "resting";
      replace(primarySlot, draw({ key: "primary", href: "#/chat", face: () => guardianMark({ size, state: glassState(markStateOfAgent(state)) }), look: `primary:${state}:${size}`, name: "Your agent", line: primary.line, state, ...(phone ? { end: { time: "", mark: primary.needs ? "Needs you" : null } } : {}) }));
    }
    const agentRows = seats.map((seat) => {
      const state = seat.state;
      const profile = seat.row?.avatar;
      return draw({
        key: `agent:${seat.id}`,
        href: seat.href,
        // (One you have not written to yet: its conversation is made on the way in, as its card's.)
        run: seat.room ? undefined : () => void openDirect(ctx, { id: seat.id }),
        face: () => agentMark({ id: seat.id, profile, size, state: markStateOfAgent(state) }),
        look: `${JSON.stringify(profile ?? null)}:${state}:${size}`,
        name: seat.name,
        line: phone ? (seat.row?.plain ?? seat.line) : seat.line,
        state,
        ...(phone ? { end: { time: at(`person:${seat.id}`), mark: seat.needs ? "Needs you" : seat.row?.unread ? "New" : null } } : {}),
      });
    });
    const roomRows = table.rooms.map((room) =>
      draw({
        key: `room:${room.id}`,
        href: `#/team?room=${encodeURIComponent(room.id)}`,
        face: () => (phone ? h("span", { class: "roster-room-face" }, icon("agents", { size: 20 })) : icon("hash", { size: 16 })),
        look: phone ? "room:phone" : "room",
        name: room.name,
        line: phone ? room.plain : room.line,
        state: room.state ?? "resting",
        ...(phone ? { end: { time: at(`room:${room.id}`), mark: room.needs ? "Needs you" : room.unread ? "New" : null } } : {}),
      }),
    );
    // A phone's list: every agent and room in one, the latest first (homeRows' order), with no section's head.
    if (phone) {
      const order = (el: HTMLElement): number => times?.get(el.dataset.key?.replace(/^agent:/, "person:") ?? "") ?? 0;
      const all = [...agentRows, ...roomRows].sort((a, b) => order(b) - order(a) || ((a.dataset.key ?? "") < (b.dataset.key ?? "") ? -1 : 1));
      const keys = all.map((el) => el.dataset.key).join("|");
      if (keys !== shownAgents) {
        shownAgents = keys;
        replace(agents, ...all);
      }
      return;
    }
    // (A group comes whole, and only when it changed which rows it has: a row's own words change in place.)
    const agentKeys = agentRows.map((el) => el.dataset.key).join("|");
    if (agentKeys !== shownAgents) {
      shownAgents = agentKeys;
      replace(agents, ...(agentRows.length ? [heading("Agents", "#/team"), ...agentRows] : []));
    }
    const roomKeys = roomRows.map((el) => el.dataset.key).join("|");
    if (roomKeys !== shownRooms) {
      shownRooms = roomKeys;
      replace(rooms, ...(roomRows.length ? [heading("Rooms", "#/team"), ...roomRows] : []));
    }
  };

  // ---- your projects, last: they come a moment later, and under the rest their coming moves nothing ----
  const projects = h("div", { class: "roster-group", role: "group", "aria-label": "Projects" });
  let shownProjects = "";
  const drawProjects = (): void => {
    // (A phone's list holds chats alone: a project is a place, under everything else.)
    if (phone) return;
    const list: ProjectView[] = projectNames.value;
    const version = JSON.stringify(list.map((project) => [project.id, project.name]));
    if (version === shownProjects) return;
    shownProjects = version;
    const projectRows = list.map((project) =>
      draw({ key: `project:${project.id}`, href: "#/projects", run: () => ctx.navigate("projects", { project: project.id }), face: () => icon("folder", { size: 16 }), look: "project", name: project.name, line: project.repo ?? "", state: "resting" }),
    );
    replace(projects, ...(projectRows.length ? [heading("Projects", "#/projects"), ...projectRows] : []));
  };

  // ---- the foot: the work, settings, everything else, and the machine ----
  const place = (id: Route, lead: IconName, text: string): HTMLElement | null =>
    placesHave(ctx, id) ? h("a", { class: "roster-place", href: `#/${id}`, title: text, "aria-label": text, onclick: () => picked() }, icon(lead, { size: 16 }), h("span", { class: "roster-text" }, text)) : null;
  const machine = h("a", { class: "side-pill", href: "#/fleet", hidden: !ctx.can("mind:read"), onclick: () => picked() });
  const drawMachine = (): void => {
    const fleet = ctx.live.fleet.value;
    const nodes = fleet ? fleet.devices.filter((device) => device.kind === "node" && !device.revokedAt) : [];
    const online = fleet ? nodes.filter((device) => device.id === fleet.self || fleet.peers.find((peer) => peer.device === device.id)?.online).length : 0;
    const self = ctx.whoami.nodeName || ctx.whoami.fleetName || "This node";
    const tone = !fleet ? null : online === nodes.length ? "ok" : online === 0 ? "danger" : "warn";
    replace(machine, dot(tone), h("span", { class: "ellipsis tnum" }, fleet && nodes.length > 1 ? `${self} · ${online}/${nodes.length}` : self));
    machine.setAttribute("aria-label", fleet ? `${self}: ${online} of ${nodes.length} machines online` : self);
  };
  const foot = phone
    ? h("div", { class: "roster-foot" }, place("settings", "settings", "Settings"), place("more", "more", "Everything else"))
    : h("div", { class: "roster-foot" }, place("home", "layers", "Work"), place("settings", "settings", "Settings"), place("more", "more", "Everything else"), machine);

  const body = phone ? h("div", { class: "roster-body" }, primarySlot, agents) : h("div", { class: "roster-body" }, needs, primarySlot, agents, rooms, projects);
  const el = h("nav", { class: "roster", "aria-label": "Your agents", "data-phone": phone ? "" : null }, body, foot);
  arrowsThrough(el, ".roster-needs, .roster-row, .roster-heading, .roster-place");

  // ---- kept true while it shows, drawn at most once a frame ----
  let frame = 0;
  const redraw = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawNeeds();
      drawTable();
      mark();
    });
  };
  for (const source of [...tableSources(ctx), ...workSources(ctx), ctx.live.inboxLoaded, ctx.live.inboxCount] as { subscribe(listener: () => void): () => void }[]) stops.push(source.subscribe(redraw));
  if (ctx.can("mind:read")) {
    askProjects(ctx);
    stops.push(projectNames.subscribe(drawProjects));
  }
  stops.push(ctx.live.fleet.subscribe(drawMachine));
  drawNeeds();
  drawTable();
  drawProjects();
  drawMachine();

  return {
    el,
    at(now) {
      where = now;
      mark();
      if (where.route === "inbox") needs.setAttribute("aria-current", "page");
      else needs.removeAttribute("aria-current");
      for (const link of foot.querySelectorAll<HTMLAnchorElement>(".roster-place")) {
        if (link.getAttribute("href") === `#/${where.route}`) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      for (const stop of stops.splice(0)) stop();
    },
  };
}

/** Whether this device sees a place. */
const placesHave = (ctx: Ctx, id: Route): boolean => placesFor(ctx.can).some((place) => place.id === id);

export interface Sidebar {
  el: HTMLElement;
  at(where: { route: Route; room?: string | null; task?: string | null }): void;
  dispose(): void;
}

/** A wide screen's sidebar: the app's mark and name (your agent's chat), search, and the roster; on a screen between, the
 * same as a rail of faces. Folded away by its button or [. */
export function sidebarNav(ctx: Ctx, shell: { toggle(): void }): Sidebar {
  const collapse = button("Hide the sidebar", { variant: "ghost", size: "sm", iconOnly: true, icon: "sidebar", title: "Hide the sidebar  ( [ )", onClick: () => shell.toggle() });
  const search = button("Search", { variant: "ghost", size: "sm", iconOnly: true, icon: "search", title: `Search and commands  (${isMac() ? "⌘" : "Ctrl"} K)`, onClick: () => ctx.palette() });
  search.classList.add("side-search");
  const mark = h("a", { class: "side-mark", href: "#/chat", title: "Your agent" }, appMark(20), h("span", { class: "wordmark-text" }, "Invincible"));
  const head = h("div", { class: "side-head" }, mark, h("span", { class: "side-keys", "aria-hidden": "true" }, ...kbd(isMac() ? "⌘" : "Ctrl", "K")), search, collapse);
  const roster = rosterNav(ctx);
  const el = h("aside", { class: "sidebar", "aria-label": "Everything" }, head, roster.el);
  return { el, at: (where) => roster.at(where), dispose: () => roster.dispose() };
}

/** A phone's drawer: the roster from the screen's left edge (the menu in a page's header, or a swipe), as a phone's list. */
export function openRoster(ctx: Ctx): void {
  const roster = rosterNav(ctx, () => sheet.close(), true);
  const sheet = openSheet({
    title: "Invincible",
    description: ctx.whoami.nodeName || ctx.whoami.fleetName || undefined,
    lead: appMark(24),
    side: "left",
    body: roster.el,
    initialFocus: () => roster.el.querySelector<HTMLElement>("[aria-current='page']") ?? roster.el.querySelector<HTMLElement>(".roster-row"),
    onClose: () => roster.dispose(),
  });
  roster.at(whereNow());
  void ctx.live.refreshTeam();
}

/** Where the address is now (for the drawer's mark): its place, and the room or the task it names. */
function whereNow(): { route: Route; room: string | null; task: string | null } {
  const route = (location.hash.match(/^#\/([a-z]+)/)?.[1] ?? "chat") as Route;
  return { route, room: route === "team" ? (teamLocation(location.hash).room ?? null) : null, task: route === "task" ? taskOf(location.hash) : null };
}

/** The arrow at a timeline's start, on a phone (a wide screen has the roster beside it): it opens the roster. */
export function rosterBack(ctx: Ctx): HTMLButtonElement {
  return h("button", { type: "button", class: "btn ghost sm icon-only pane-back", "aria-label": "Your agents", title: "Your agents", onclick: () => openRoster(ctx) }, icon("chevron-left", { size: 16 }));
}
