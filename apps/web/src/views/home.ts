import { findSecrets } from "@invincible/core/secret-scan";
import type { Ctx, View } from "../context.ts";
import { isWaiting } from "../live.ts";
import { primaryState } from "../lib/agent-state.ts";
import { primaryNow, type Now } from "../lib/now.ts";
import { orbMoodOfState } from "../lib/orb-motion.ts";
import { primaryNeeds } from "../lib/roster.ts";
import { atAGlance, type Attended, inProject, namesProjects, type WorkRow } from "../lib/work.ts";
import { setWorkOpen, workOpen } from "../prefs.ts";
import { stateChip } from "../ui/avatar.ts";
import { arrive, button, callout, count, dot, setCount, skeletonRows } from "../ui/controls.ts";
import { arrowsThrough, cx, h, isMac, keepPlace, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { orb } from "../ui/orb.ts";
import { toast } from "../ui/toast.ts";
import { answerStep, chatActivity, chatsForPalette, nodeTurns, primaryWork, runsInHand, sendMessage, startNewChat, unreadChats } from "./chat.ts";
import { needsCount, needsItems, needsVersion } from "./needs.ts";
import { openPlaces } from "./places.ts";
import { openSeat, seatFace, tableOf } from "./roster.ts";
import { editAgent, giveToAgents } from "./team-forms.ts";
import { askProjects, failedNote, foldLine, projectTile, rowsVersion, workNow, workRow, workSources } from "./work-rows.ts";

/*
 * Home: the primary, first (your words, 26 November 2026: "agent first ([the primary])"; no tab bar; Home with a bar at
 * its foot and a drawer, as the iPhone's). Its I-beam, which opens the drawer (views/places.ts), its name and a line of
 * how things stand, and the machine it runs on. Then the agents in a strip, each a tap from its page, what needs you
 * first; what needs you, three decisions at most with their answers in place (views/needs.ts), the rest a tap away;
 * then the work in one list by attention (what is new to you, then what is at work; what is settled folds), each task a
 * row that opens its thread, with a filter for each project; and the bar docked at the foot: search, its message box
 * (whatever you ask it starts a conversation with it) and a task to give. Every screen opens here; a wide one has the
 * drawer's places beside it, kept open as its sidebar, which has the I-beam and the machine instead.
 */

/** Its line, as Home's header says it: what it is doing, and what needs you that is no task's. */
function primaryLine(ctx: Ctx): Now {
  const waiting = ctx.live.actions.value.filter((action) => isWaiting(action));
  const needs = ctx.live.inboxLoaded.value ? primaryNeeds(ctx.live.inboxCount.value, waiting, ctx.live.team.value?.agents.map((person) => person.id) ?? []) : null;
  return primaryNow({ ...primaryWork(), needs });
}

/** The project the list is filtered to on this page, while the app is open (null: every project). */
let filtered: string | null = null;

export const homeView: View = (root, ctx, { scope }) => {
  askProjects(ctx);
  const canChat = ctx.can("chat");
  const canGive = ctx.can("fleet:admin") && canChat;

  // ---- its header: the I-beam (it opens the drawer, everything else), its name and how things stand (they open its
  // conversation), the machine ----
  const face = h("button", { type: "button", class: "home-orb home-drawer", "aria-label": "Everything else", title: "Everything else: your chats, the agents, every place", onclick: () => openPlaces(ctx) });
  const line = h("p", { class: "home-line ellipsis" });
  const machine = h("a", { class: "home-chip", href: "#/fleet", hidden: !ctx.can("mind:read") });
  const head = h(
    "header",
    { class: "page-head home-head" },
    h("div", { class: "home-who" }, face, h("a", { class: "home-name", href: "#/chat", title: "Your agent: its own conversation" }, h("h1", {}, "Your agent"), line)),
    machine,
  );
  // Your latest chats, read now, so the drawer lists them the moment it opens.
  if (canChat) chatsForPalette(ctx.api, { chat: true, read: ctx.can("mind:read") });

  // ---- the agents in a strip: each a tap from its page, what needs you first; their marks the only colour ----
  const strip = h("nav", { class: "home-strip", "aria-label": "Your agents", hidden: true });
  let stripShown = "";
  const drawStrip = (): void => {
    const seats = tableOf(ctx).seats.filter((seated) => seated.id !== "primary");
    const rank = (seated: (typeof seats)[number]) => (seated.needs ? 0 : seated.state === "working" ? 1 : seated.state === "failed" ? 2 : 3);
    const ordered = seats.map((seated, i) => ({ seated, i })).sort((a, b) => rank(a.seated) - rank(b.seated) || a.i - b.i).map(({ seated }) => seated);
    const version = JSON.stringify(ordered.map((seated) => [seated.id, seated.name, seated.state, seated.needs, seated.href]));
    if (version === stripShown) return;
    stripShown = version;
    strip.hidden = !ordered.length;
    replace(
      strip,
      ...ordered.map((seated) => {
        // (What needs you first: its mark and its word say the same.)
        const shown = { ...seated, state: seated.needs ? ("needs" as const) : seated.state };
        return h(
          "a",
          { class: "home-strip-agent", href: seated.href, onclick: openSeat(ctx, seated), title: `${seated.name}: ${seated.line}` },
          seatFace(shown, 40),
          h("span", { class: "home-strip-name ellipsis" }, seated.name),
          stateChip(shown.state) ?? h("span", { class: "home-strip-rest", "aria-hidden": "true" }, " "),
        );
      }),
    );
  };

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
  const work = h("section", { class: "home-work", "aria-labelledby": "home-work-head" }, h("div", { class: "home-work-head" }, h("h2", { id: "home-work-head" }, "Work"), filters), list);
  /** What needs you on Home: three decisions at most, each with its answer; the rest a tap away in the Inbox (X2). */
  const NEEDS_SHOWN = 3;

  // ---- its message box, docked ----
  const input = h("textarea", { rows: 1, placeholder: "Ask your agent…", "aria-label": "Ask your agent", autocomplete: "off", enterkeyhint: "send" });
  const send = button("Send", { variant: "primary", iconOnly: true, icon: "arrow-up", type: "submit", label: "Send to your agent" });
  // (Only once there's something to send: the bar at rest is search, its box and a task to give, as the iPhone's.)
  send.hidden = true;
  const problem = h("div", { class: "home-dock-problem", role: "status" });
  let sending = false;
  const sync = (): void => {
    const secret = findSecrets(input.value).length > 0;
    send.disabled = sending || !input.value.trim() || secret;
    send.hidden = !input.value.trim();
    replace(problem, secret ? callout("warn", "That looks like a secret. Remove it before sending; keys belong in the vault.") : null);
  };
  const deliver = async (): Promise<void> => {
    sync();
    if (send.disabled) return;
    const text = input.value.trim();
    sending = true;
    sync();
    // A new conversation with it, as "Ask the primary" anywhere starts one (the one open last stays among your chats).
    startNewChat();
    const result = await sendMessage(ctx.api, text);
    sending = false;
    if (typeof result === "object") {
      toast("Not sent", { tone: "error", description: result.problem });
      sync();
      return;
    }
    input.value = "";
    ctx.navigate("chat");
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
      event.preventDefault();
      void deliver();
    }
  });
  const dock = canChat
    ? h(
        "div",
        { class: "home-dock" },
        problem,
        // The bar, as the iPhone's: search and commands, your agent's message box, a task to give.
        h(
          "form",
          { class: "home-composer", onsubmit: (event: Event) => (event.preventDefault(), void deliver()) },
          button("Search", { variant: "ghost", iconOnly: true, icon: "search", label: `Search and commands (${isMac() ? "⌘" : "Ctrl"}+K)`, onClick: (event) => ctx.palette(undefined, event.currentTarget as Element) }),
          input,
          send,
          canGive ? button("Give a task", { variant: "ghost", iconOnly: true, icon: "plus", title: "Give a task to the agent best suited to it, or to one by name", onClick: () => giveToAgents(ctx) }) : null,
        ),
      )
    : null;

  // What needs you and the work appear whole, in one frame, behind one placeholder until then (as a page body does): the
  // one never pushes the other down as it comes.
  const wait = h("div", { class: "skeleton home-wait", "aria-hidden": "true" });
  const body = h("div", { class: "home-body", hidden: true }, strip, needs, work);
  replace(root, h("div", { class: cx("home", dock && "has-dock") }, head, wait, body, dock));
  sync();

  // ---- drawn from what the app has: its line, the Inbox, the team ----
  let shownFace = "";
  let shown = "";
  let open = workOpen();
  const drawHead = (work: Attended | null, waiting: number): void => {
    const now = primaryLine(ctx);
    const state = primaryState(now);
    const look = `${now.tone}/${state}`;
    if (look !== shownFace) {
      shownFace = look;
      // The one orb that moves here: its (the agents' in their rows are still).
      replace(face, orb({ size: 48, tone: now.tone, mood: orbMoodOfState(state), key: "invincible:home" }));
    }
    const glance = work ? atAGlance(work, waiting, now.text) : { text: now.text, needs: false };
    if (line.textContent !== glance.text) line.textContent = glance.text;
    line.dataset.tone = glance.needs ? "needs" : now.tone;
    const fleet = ctx.live.fleet.value;
    // The machine it runs on, by its name from the first frame (its dot says how the fleet stands once it answers).
    const self = ctx.whoami.nodeName || ctx.whoami.fleetName || "This node";
    const nodes = fleet ? fleet.devices.filter((device) => device.kind === "node" && !device.revokedAt) : [];
    const online = fleet ? nodes.filter((device) => device.id === fleet.self || fleet.peers.find((peer) => peer.device === device.id)?.online).length : 0;
    replace(machine, dot(!fleet ? null : online === nodes.length ? "ok" : online === 0 ? "danger" : "warn"), h("span", { class: "ellipsis" }, self));
    machine.setAttribute("aria-label", fleet ? `${self}: ${online} of ${nodes.length} machines online` : self);
  };

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
    drawStrip();
    const all = settled() ? workNow(ctx) : null;
    drawHead(all, all ? needsCount(ctx, all) : 0);
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

  for (const source of [...workSources(ctx), ctx.live.inboxCount, ctx.live.inboxLoaded, ctx.live.pairings, ctx.live.secretRequests, ctx.live.questions, ctx.live.notices, ctx.live.loopDrafts, ctx.live.connectorRequests, ctx.live.aboutYou, ctx.live.screenSessions, ctx.live.fleet, ctx.live.teamProblem, nodeTurns, runsInHand, unreadChats, answerStep, chatActivity] as { subscribe(listener: () => void): () => void }[]) scope.add(source.subscribe(() => draw()));
  // "4m" moves on: drawn again each minute (only what changed is).
  scope.interval(() => draw(), 60_000);
  draw();
  void ctx.live.refreshInbox();
};
