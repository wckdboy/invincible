import type { ConversationSummary } from "@invincible/core";
import { glassState } from "@invincible/core/glass";
import type { Ctx, Route } from "../context.ts";
import { type AgentState, primaryState, STATES, withState } from "../lib/agent-state.ts";
import { keyWords } from "../lib/keys.ts";
import { taskOf } from "../lib/nav.ts";
import { teamLocation } from "../lib/team.ts";
import { age, type Thread, type ThreadProject, threadsOf } from "../lib/threads.ts";
import { workOf } from "../lib/work.ts";
import { button, dot } from "../ui/controls.ts";
import { arrowsThrough, h, isMac, replace } from "../ui/dom.ts";
import { guardianMark } from "../ui/glass.ts";
import { icon } from "../ui/icons.ts";
import { agentMark, markStateOfAgent } from "../ui/mark.ts";
import { appMark } from "../ui/orb.ts";
import { openChatId } from "../prefs.ts";
import { nodeTurns, onChatsChanged, startNewChat, unreadChats } from "./chat.ts";
import { needsCount } from "./needs.ts";
import { tableOf, tableSources } from "./roster.ts";
import type { Sidebar } from "./sidebar.ts";
import { askProjects, projectNames, workNow, workSources } from "./work-rows.ts";
import { openDirect } from "./team-forms.ts";

/*
 * A desk's sidebar, from 1024 px (the owner's word of 28 November 2026: "a near copy of t3code"; the lead gave the wide
 * layout to the Mac desktop work, a phone's drawer and the rail between staying views/sidebar.ts's). T3 Code's shape:
 * the app's mark with a new chat, search and the fold; your agent, its own chats folded under it; what needs you; your
 * projects, each with its threads newest first (lib/threads.ts: its agents' tasks and your agent's chats in it); your
 * agents and rooms; at its foot the node and Settings. A thread is one line: its face and dot, its title, how long ago.
 * Drawn from what the app already has (the team, your projects, your agent's kept chats, read again only as the live
 * stream says a turn moved), at most once a frame; a group is drawn again only when its rows change.
 */

const SHOWN = 5;
const OPEN_KEY = "invincible:desk-open";

/** Which groups you opened past their first five, or folded (this device's, a UI preference). */
function readOpen(): Record<string, "all" | "folded"> {
  try {
    const kept = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as unknown;
    return kept && typeof kept === "object" ? (kept as Record<string, "all" | "folded">) : {};
  } catch {
    return {};
  }
}

function keepOpen(open: Record<string, "all" | "folded">): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open));
  } catch {
    /* storage refused: as it is this session only */
  }
}

export function deskNav(ctx: Ctx, shell: { toggle(): void }): Sidebar {
  const stops: (() => void)[] = [];
  const open = readOpen();
  let where: { route: Route; room?: string | null; task?: string | null; chat?: string | null } = { route: "chat" };
  let conversations: ConversationSummary[] = [];

  // ---- the head: the app's mark (your agent's chat), a new chat, search and the fold ----
  const fold = button("Hide the sidebar", { variant: "ghost", size: "sm", iconOnly: true, icon: "sidebar", title: `Hide the sidebar  (${keyWords(["mod", "B"], isMac())} or [ )`, onClick: () => shell.toggle() });
  const search = button("Search", { variant: "ghost", size: "sm", iconOnly: true, icon: "search", title: `Search and commands  (${isMac() ? "⌘" : "Ctrl"} K)`, onClick: () => ctx.palette() });
  const fresh = button("New chat", { variant: "ghost", size: "sm", iconOnly: true, icon: "edit", title: `New chat with your agent  (${keyWords(["mod", "N"], isMac())})`, onClick: () => (startNewChat(), ctx.navigate("chat")) });
  const brand = h("a", { class: "side-mark", href: "#/chat", title: "Your agent" }, appMark(20), h("span", { class: "wordmark-text" }, "Invincible"));
  const head = h("div", { class: "side-head" }, brand, fresh, search, fold);

  // ---- one row: a thread, an agent, your agent ----
  const rowOf = (opts: { key: string; href: string; run?: () => void; face: HTMLElement | SVGElement; title: string; meta?: string; state: AgentState; label: string; depth?: number }): HTMLElement => {
    const attrs = { class: "desk-row", "data-key": opts.key, "data-state": opts.state, "data-depth": opts.depth ? String(opts.depth) : null, title: opts.label, "aria-label": opts.label };
    const parts = [h("span", { class: "desk-face" }, opts.face), h("span", { class: "desk-title" }, opts.title), opts.meta ? h("span", { class: "desk-meta tnum" }, opts.meta) : null];
    return opts.run ? h("button", { ...attrs, type: "button", onclick: () => opts.run?.() }, ...parts) : h("a", { ...attrs, href: opts.href }, ...parts);
  };
  const threadRow = (thread: Thread, now: number, depth = 1): HTMLElement => {
    const face = thread.agent
      ? agentMark({ id: thread.agent.id, profile: thread.agent.avatar as never, size: 16, state: markStateOfAgent(thread.state) })
      : guardianMark({ size: 14, state: glassState(markStateOfAgent(thread.state)) });
    const who = thread.agent ? thread.agent.name : "Your agent";
    return rowOf({ key: `${thread.kind}:${thread.id}`, href: thread.href, face, title: thread.title, meta: age(thread.at, now), state: thread.state, label: `${thread.title}: ${withState(who, thread.state)}, ${age(thread.at, now)}`, depth });
  };
  const more = (key: string, hidden: number): HTMLElement =>
    h("button", { type: "button", class: "desk-more", "data-depth": "1", onclick: () => ((open[key] = "all"), keepOpen(open), draw()) }, `Show ${hidden} more`);
  const fewer = (key: string): HTMLElement => h("button", { type: "button", class: "desk-more", "data-depth": "1", onclick: () => (delete open[key], keepOpen(open), draw()) }, "Show fewer");
  const threadsIn = (key: string, threads: Thread[], now: number): HTMLElement[] => {
    if (open[key] === "folded") return [];
    const all = open[key] === "all";
    const shown = all ? threads : threads.slice(0, SHOWN);
    return [...shown.map((thread) => threadRow(thread, now)), ...(threads.length > SHOWN ? [all ? fewer(key) : more(key, threads.length - SHOWN)] : [])];
  };
  const groupHead = (key: string, name: string, lead: HTMLElement | SVGElement, count: number, href?: string): HTMLElement => {
    const folded = open[key] === "folded";
    const toggle = (): void => {
      if (folded) delete open[key];
      else open[key] = "folded";
      keepOpen(open);
      draw();
    };
    return h(
      "div",
      { class: "desk-group-head" },
      h("button", { type: "button", class: "desk-fold", "aria-expanded": String(!folded), "aria-label": `${folded ? "Show" : "Hide"} ${name}'s threads`, onclick: toggle }, icon("chevron-right", { size: 12 })),
      href ? h("a", { class: "desk-group-name", href }, lead, h("span", { class: "ellipsis" }, name)) : h("span", { class: "desk-group-name" }, lead, h("span", { class: "ellipsis" }, name)),
      count ? h("span", { class: "desk-meta tnum" }, String(count)) : null,
    );
  };

  // ---- your agent, its chats; what needs you ----
  const primarySlot = h("div", { class: "desk-group" });
  const needsCountEl = h("span", { class: "roster-count tnum" });
  const needs = h("a", { class: "desk-row desk-needs", href: "#/inbox" }, h("span", { class: "desk-face" }, icon("inbox", { size: 16 })), h("span", { class: "desk-title" }, "Needs you"), needsCountEl);
  const projectsSlot = h("div", { class: "desk-section", role: "group", "aria-label": "Projects" });
  const agentsSlot = h("div", { class: "desk-section", role: "group", "aria-label": "Agents" });
  const heading = (text: string, href: string, add?: { label: string; run: () => void }): HTMLElement =>
    h(
      "div",
      { class: "desk-heading" },
      h("a", { href }, text),
      add ? button(add.label, { variant: "ghost", size: "sm", iconOnly: true, icon: "plus", title: add.label, onClick: add.run }) : null,
    );

  const drawNeeds = (): void => {
    const work = ctx.live.inboxLoaded.value ? workNow(ctx) : null;
    const n = work ? needsCount(ctx, work) : ctx.live.inboxCount.value;
    needsCountEl.textContent = n ? String(n) : "";
    needs.dataset.count = n ? "some" : "none";
    needs.setAttribute("aria-label", n ? `Needs you: ${n}` : "Needs you: nothing");
  };

  let shown = "";
  // Its rows are drawn first once your agent's chats and the team are both in hand (or a few seconds have gone by), all
  // at once: drawn as each arrived, your agent's chats pushed what was under them down, on every place (the scorecard's
  // web suite holds every place still, its sidebar included).
  let chatsRead = !ctx.can("chat");
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    body.append(primarySlot, needs, projectsSlot, agentsSlot);
  };
  const draw = (): void => {
    const now = Date.now();
    const snapshot = ctx.live.team.value;
    if (!settled) {
      if (!chatsRead || (ctx.can("chat") && !snapshot && !ctx.live.teamProblem.value)) return;
      settle();
    }
    const table = tableOf(ctx);
    const threads = threadsOf({ work: snapshot ? workOf({ snapshot, projects: projectNames.value, now }) : { projects: [], other: null }, projects: projectNames.value, conversations });
    // (Drawn again only when what it shows changed: the same rows, the same words, the same minutes.)
    const version = JSON.stringify([table.seats.map((s) => [s.id, s.state, s.line, s.room]), table.rooms.map((r) => [r.id, r.name, r.state]), threads, Math.floor(now / 60_000), open]);
    if (version === shown) return mark();
    shown = version;

    const [primary, ...seats] = table.seats;
    const primaryState_ = primary?.now ? primaryState(primary.now) : "resting";
    const own = threads.own;
    replace(
      primarySlot,
      h(
        "div",
        { class: "desk-group-head desk-primary" },
        h("button", { type: "button", class: "desk-fold", "aria-expanded": String(open.own !== "folded"), "aria-label": `${open.own === "folded" ? "Show" : "Hide"} your agent's chats`, onclick: () => ((open.own === "folded" ? delete open.own : (open.own = "folded")), keepOpen(open), draw()) }, icon("chevron-right", { size: 12 })),
        rowOf({ key: "primary", href: "#/chat", face: guardianMark({ size: 18, state: glassState(markStateOfAgent(primaryState_)) }), title: "Your agent", state: primaryState_, label: withState("Your agent", primaryState_) + (primary?.line ? `: ${primary.line}` : "") }),
      ),
      ...threadsIn("own", own, now),
    );

    const groups: ThreadProject[] = [...threads.projects, ...(threads.other ? [threads.other] : [])];
    replace(
      projectsSlot,
      heading("Projects", "#/projects", ctx.can("brain:write") ? { label: "New project", run: () => ctx.navigate("projects") } : undefined),
      ...groups.flatMap((group) => [groupHead(group.key, group.name, icon(group.key === "other" ? "layers" : "folder", { size: 14 }), group.threads.length), ...threadsIn(group.key, group.threads, now)]),
      ...(groups.length ? [] : [h("p", { class: "desk-empty" }, "No projects yet. A project is a repository your agents work in.")]),
    );

    const agentRows = seats.map((seat) =>
      rowOf({
        key: `agent:${seat.id}`,
        href: seat.href,
        // (One you have not written to yet: its conversation is made on the way in, as its card's.)
        run: seat.room ? undefined : () => void openDirect(ctx, { id: seat.id }),
        face: agentMark({ id: seat.id, profile: seat.row?.avatar, size: 16, state: markStateOfAgent(seat.state) }),
        title: seat.name,
        meta: STATES[seat.state].words ?? "",
        state: seat.state,
        label: `${withState(seat.name, seat.state)}${seat.line ? `: ${seat.line}` : ""}`,
      }),
    );
    const roomRows = table.rooms.map((room) =>
      rowOf({ key: `room:${room.id}`, href: `#/team?room=${encodeURIComponent(room.id)}`, face: icon("hash", { size: 14 }), title: room.name, state: room.state ?? "resting", label: `${room.name}${room.line ? `: ${room.line}` : ""}` }),
    );
    replace(agentsSlot, ...(agentRows.length || roomRows.length ? [heading("Agents", "#/team"), ...agentRows, ...roomRows] : []));
    mark();
  };

  // ---- where the app is: that row is marked ----
  const mark = (): void => {
    const table = tableOf(ctx);
    const task = where.task ? `task:${where.task}` : null;
    const open = where.route === "chat" ? (where.chat ?? openChatId()) : null;
    const chat = where.route === "chat" ? (open && conversations.some((one) => one.id === open) ? `chat:${open}` : "primary") : null;
    const agent = where.room ? table.seats.find((seat) => seat.room === where.room) : undefined;
    const current = task ?? chat ?? (agent ? `agent:${agent.id}` : where.room ? `room:${where.room}` : null);
    for (const row of el.querySelectorAll<HTMLElement>(".desk-row[data-key]")) {
      if (row.dataset.key === current) row.setAttribute("aria-current", "page");
      else row.removeAttribute("aria-current");
    }
    if (where.route === "inbox") needs.setAttribute("aria-current", "page");
    else needs.removeAttribute("aria-current");
  };

  // ---- the foot: the node, and Settings ----
  const machine = h("a", { class: "side-pill", href: "#/fleet", hidden: !ctx.can("mind:read") });
  const drawMachine = (): void => {
    const fleet = ctx.live.fleet.value;
    const nodes = fleet ? fleet.devices.filter((device) => device.kind === "node" && !device.revokedAt) : [];
    const online = fleet ? nodes.filter((device) => device.id === fleet.self || fleet.peers.find((peer) => peer.device === device.id)?.online).length : 0;
    const self = ctx.whoami.nodeName || ctx.whoami.fleetName || "This node";
    const tone = !fleet ? null : online === nodes.length ? "ok" : online === 0 ? "danger" : "warn";
    replace(machine, dot(tone), h("span", { class: "ellipsis tnum" }, fleet && nodes.length > 1 ? `${self} · ${online}/${nodes.length}` : self));
    machine.setAttribute("aria-label", fleet ? `${self}: ${online} of ${nodes.length} machines online` : self);
  };
  const settings = h("a", { class: "desk-foot-link", href: "#/settings", title: "Settings" }, icon("settings", { size: 16 }), h("span", {}, "Settings"));
  const everything = h("a", { class: "desk-foot-link", href: "#/more", title: "Everything else" }, icon("more", { size: 16 }), h("span", {}, "More"));
  const foot = h("div", { class: "desk-foot" }, machine, h("span", { class: "desk-foot-links" }, everything, settings));

  const body = h("nav", { class: "desk-body", "aria-label": "Your work" });
  const el = h("aside", { class: "sidebar desk", "aria-label": "Everything" }, head, body, foot);
  arrowsThrough(el, ".desk-row, .desk-more, .desk-group-name");

  // ---- kept true while it shows, drawn at most once a frame ----
  let frame = 0;
  const redraw = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawNeeds();
      draw();
    });
  };
  // Your agent's kept chats: read now, and again as the live stream says a turn moved (one began, or ended).
  const readChats = (): void => {
    if (!ctx.can("chat")) return;
    ctx.api.get<{ conversations: ConversationSummary[] }>("/api/conversations").then(
      (answer) => {
        conversations = answer.conversations;
        chatsRead = true;
        redraw();
      },
      () => {
        chatsRead = true;
        redraw();
      },
    );
  };
  stops.push(ctx.live.follow(["turns"], () => readChats(), null, 2000));
  // (The chat view says when a chat opens, starts, or is renamed or deleted: the list and the mark follow.)
  stops.push(onChatsChanged(() => (readChats(), mark())));
  for (const source of [...tableSources(ctx), ...workSources(ctx), ctx.live.inboxLoaded, ctx.live.inboxCount, nodeTurns, unreadChats] as { subscribe(listener: () => void): () => void }[]) stops.push(source.subscribe(redraw));
  if (ctx.can("mind:read")) askProjects(ctx);
  stops.push(ctx.live.fleet.subscribe(drawMachine));
  // (The minutes beside each thread move on their own, once a minute, only while the page shows.)
  const minutes = setInterval(() => document.visibilityState === "visible" && redraw(), 60_000);
  stops.push(() => clearInterval(minutes));
  // (A node slow to answer: what is known is drawn after a few seconds, never an empty sidebar.)
  const late = setTimeout(() => {
    settle();
    redraw();
  }, 4000);
  stops.push(() => clearTimeout(late));
  readChats();
  drawNeeds();
  draw();
  drawMachine();

  return {
    el,
    at(now) {
      where = { ...now, chat: now.route === "chat" ? chatOf(location.hash) : null };
      // A new chat of yours (or one renamed) is read once you're in it.
      if (now.route === "chat" && where.chat && !conversations.some((one) => one.id === where.chat)) readChats();
      mark();
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      for (const stop of stops.splice(0)) stop();
    },
  };
}

/** The threads in a desk's sidebar as it shows them, top to bottom (your agent's chats, each project's): ⌘1–⌘9 go to the
 * first nine, ⌘⇧[ and ⌘⇧] to the one above and below the one you are on (lib/keys.ts). None where there is no desk's. */
export function deskThreadRows(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".sidebar.desk .desk-row[data-key]")].filter((row) => /^(task|chat):/.test(row.dataset.key ?? ""));
}

/** The kept chat an address names (#/chat?c=<id>), or null. */
export function chatOf(hash: string): string | null {
  const id = /^#\/chat\?(?:.*&)?c=([^&]+)/.exec(hash)?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** Where the address is now, for the mark: its place, and the room, the task or the chat it names. */
export function deskWhere(hash: string): { route: Route; room: string | null; task: string | null; chat: string | null } {
  const route = (hash.match(/^#\/([a-z]+)/)?.[1] ?? "chat") as Route;
  return { route, room: route === "team" ? (teamLocation(hash).room ?? null) : null, task: route === "task" ? taskOf(hash) : null, chat: route === "chat" ? chatOf(hash) : null };
}
