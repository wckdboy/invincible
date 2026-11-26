import { findSecrets } from "@galahad/core/secret-scan";
import type { View } from "../context.ts";
import { galahadState } from "../lib/knight-state.ts";
import { orbMoodOfState } from "../lib/orb-motion.ts";
import { atAGlance, type Attended, inProject, type WorkRow } from "../lib/work.ts";
import { setWorkOpen, workOpen } from "../prefs.ts";
import { arrive, button, callout, count, dot, setCount, skeletonRows } from "../ui/controls.ts";
import { cx, h, keepPlace, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { orb } from "../ui/orb.ts";
import { toast } from "../ui/toast.ts";
import { answerStep, chatActivity, nodeTurns, questsInHand, sendMessage, startNewChat, unreadChats } from "./chat.ts";
import { needsCount, needsItems, needsVersion, tickExpiries } from "./needs.ts";
import { openPlaces } from "./places.ts";
import { galahadLine } from "./sidebar.ts";
import { giveToRoundtable } from "./team-forms.ts";
import { askProjects, projectTile, rowsVersion, workNow, workRow, workSources } from "./work-rows.ts";

/*
 * Home: Galahad, first (your words, 26 November 2026: "agent first (Galahad)"; on a phone no tab bar, "a '…' sheet for
 * everything else"). His orb, the one that moves on the screen, his name and a line of how things stand, the machine he
 * runs on, and "…". Then what needs you, each with its answer in place (views/needs.ts); then the work in one list by
 * attention (what is new to you, then what is at work, faded; what is settled folds), each task a row of three lines
 * that opens its thread, with a filter for each project; and his message box docked at the foot, where whatever you ask
 * him starts a conversation with him. A phone opens here; a wide screen has it at #/home beside the same work in its
 * sidebar.
 */

/** The project the list is filtered to on this page, while the app is open (null: every project). */
let filtered: string | null = null;

export const homeView: View = (root, ctx, { scope }) => {
  askProjects(ctx);
  const canChat = ctx.can("chat");
  const canGive = ctx.can("fleet:admin") && canChat;

  // ---- his header: the orb (moving as he is), his name, how things stand, the machine, everything else ----
  const face = h("span", { class: "home-orb" });
  const line = h("p", { class: "home-line ellipsis" });
  const machine = h("a", { class: "home-chip", href: "#/fleet", hidden: !ctx.can("mind:read") });
  const more = button("Everything else", { variant: "ghost", iconOnly: true, icon: "more", onClick: (event) => openPlaces(ctx, event.currentTarget as Element) });
  more.classList.add("places-button");
  const head = h(
    "header",
    { class: "page-head home-head" },
    h("a", { class: "home-who", href: "#/chat", title: "Galahad: his own conversation" }, face, h("div", { class: "home-name" }, h("h1", {}, "Galahad"), line)),
    machine,
    more,
  );

  // ---- what needs you, then the work ----
  // In the alerts' look (an .alert-card in amber): its count rolls as it changes, and something new breathes once.
  const needs = h("section", { class: "home-needs alert-card", "data-tone": "needs", "aria-label": "Needs you", hidden: true });
  const needsShown = count(0, false, "needs");
  const needsHead = h("h2", { class: "home-needs-head" }, dot("needs"), h("span", {}, "Needs you"), needsShown);
  let needsBefore: number | null = null;
  const filters = h("div", { class: "home-filters", role: "group", "aria-label": "Show the work of" });
  const list = h("div", { class: "home-work-rows" }, skeletonRows(4, { avatar: true }));
  const work = h("section", { class: "home-work", "aria-labelledby": "home-work-head" }, h("div", { class: "home-work-head" }, h("h2", { id: "home-work-head" }, "Work"), filters), list);

  // ---- his message box, docked ----
  const input = h("textarea", { rows: 1, placeholder: "Ask Galahad…", "aria-label": "Ask Galahad", autocomplete: "off", enterkeyhint: "send" });
  const send = button("Send", { variant: "primary", iconOnly: true, icon: "arrow-up", type: "submit", label: "Send to Galahad" });
  const problem = h("div", { class: "home-dock-problem", role: "status" });
  let sending = false;
  const sync = (): void => {
    const secret = findSecrets(input.value).length > 0;
    send.disabled = sending || !input.value.trim() || secret;
    replace(problem, secret ? callout("warn", "That looks like a secret. Remove it before sending; keys belong in the vault.") : null);
  };
  const deliver = async (): Promise<void> => {
    sync();
    if (send.disabled) return;
    const text = input.value.trim();
    sending = true;
    sync();
    // A new conversation with him, as "Ask Galahad" anywhere starts one (the one open last stays among your chats).
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
        h(
          "form",
          { class: "home-composer", onsubmit: (event: Event) => (event.preventDefault(), void deliver()) },
          canGive ? button("Give a task", { variant: "ghost", iconOnly: true, icon: "plus", title: "Give a task to the knight best suited to it, or to one by name", onClick: () => giveToRoundtable(ctx) }) : null,
          input,
          send,
        ),
      )
    : null;

  // What needs you and the work appear whole, in one frame, behind one placeholder until then (as a page body does): the
  // one never pushes the other down as it comes.
  const wait = h("div", { class: "skeleton home-wait", "aria-hidden": "true" });
  const body = h("div", { class: "home-body", hidden: true }, needs, work);
  replace(root, h("div", { class: cx("home", dock && "has-dock") }, head, wait, body, dock));
  sync();

  // ---- drawn from what the app has: his line, the Inbox, the team ----
  let shownFace = "";
  let shown = "";
  let open = workOpen();
  const drawHead = (work: Attended | null, waiting: number): void => {
    const now = galahadLine(ctx);
    const state = galahadState(now);
    const look = `${now.tone}/${state}`;
    if (look !== shownFace) {
      shownFace = look;
      // The one orb that moves here: his (the knights' in their rows are still).
      replace(face, orb({ size: 48, tone: now.tone, mood: orbMoodOfState(state), key: "galahad:home", label: `Galahad: ${now.text}` }));
    }
    const glance = work ? atAGlance(work, waiting, now.text) : { text: now.text, needs: false };
    if (line.textContent !== glance.text) line.textContent = glance.text;
    line.dataset.tone = glance.needs ? "needs" : now.tone;
    const fleet = ctx.live.fleet.value;
    // The machine he runs on, by its name from the first frame (its dot says how the fleet stands once it answers).
    const self = ctx.whoami.nodeName || ctx.whoami.fleetName || "This node";
    const nodes = fleet ? fleet.devices.filter((device) => device.kind === "node" && !device.revokedAt) : [];
    const online = fleet ? nodes.filter((device) => device.id === fleet.self || fleet.peers.find((peer) => peer.device === device.id)?.online).length : 0;
    replace(machine, dot(!fleet ? null : online === nodes.length ? "ok" : online === 0 ? "danger" : "warn"), h("span", { class: "ellipsis" }, self));
    machine.setAttribute("aria-label", fleet ? `${self}: ${online} of ${nodes.length} machines online` : self);
  };

  const rowEl = (row: WorkRow): HTMLElement => workRow(row, { face: 18 });
  /** The page is drawn once the team and the Inbox have both answered (or a moment has passed): what needs you comes in
   * with the work, rather than above it a moment later, pushing it down. */
  const started = Date.now();
  const settled = (): boolean => ctx.live.inboxLoaded.value || Date.now() - started >= 1500;
  scope.timeout(() => draw(), 1500);
  function draw(): void {
    const all = settled() ? workNow(ctx) : null;
    drawHead(all, all ? needsCount(ctx, all) : 0);
    const version = JSON.stringify([all && [rowsVersion(all.needs), rowsVersion(all.active), rowsVersion(all.working), rowsVersion(all.done), all.projects], filtered, [...open], needsVersion(ctx), Boolean(ctx.live.teamProblem.value)]);
    if (version === shown) return;
    shown = version;
    // What needs you: amber, only when something waits.
    const items = all ? needsItems(ctx, all) : [];
    needs.hidden = !items.length;
    if (items.length) {
      setCount(needsShown, items.length);
      replace(needs, needsHead, ...items);
      // More waiting than when it was last drawn (not the page's first drawing): one slow breath of its edge.
      if (needsBefore !== null && items.length > needsBefore) arrive(needs);
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
    const doneOpen = open.has("done");
    const rows = [...shownWork.active, ...shownWork.working];
    keepPlace(list, () =>
      replace(
        list,
        ...rows.map(rowEl),
        shownWork.done.length
          ? h("button", { type: "button", class: "home-fold", "aria-expanded": String(doneOpen), onclick: () => (setWorkOpen("done", !doneOpen), (open = workOpen()), draw()) }, h("span", { class: "grow" }, "Done"), h("span", { class: "tnum" }, String(shownWork.done.length)), icon("chevron-right", { size: 14, class: "chev" }))
          : null,
        ...(doneOpen ? shownWork.done.map(rowEl) : []),
        !rows.length && !shownWork.done.length && !shownWork.needs.length
          ? h(
              "div",
              { class: "home-empty" },
              h("p", {}, filtered ? "Nothing in this project." : "Nothing under way. Ask Galahad below, or give a knight a task: each is a row here, from its first step to verified."),
              canGive && !filtered ? button("Give a task", { size: "sm", icon: "layers", onClick: () => giveToRoundtable(ctx) }) : null,
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

  for (const source of [...workSources(ctx), ctx.live.inboxCount, ctx.live.inboxLoaded, ctx.live.pairings, ctx.live.secretRequests, ctx.live.questions, ctx.live.notices, ctx.live.loopDrafts, ctx.live.connectorRequests, ctx.live.aboutYou, ctx.live.screenSessions, ctx.live.fleet, ctx.live.teamProblem, nodeTurns, questsInHand, unreadChats, answerStep, chatActivity] as { subscribe(listener: () => void): () => void }[]) scope.add(source.subscribe(() => draw()));
  // "4m" moves on: drawn again each minute (only what changed is); an approval's time to answer, every half minute.
  scope.interval(() => draw(), 60_000);
  scope.interval(() => tickExpiries(needs), 30_000);
  draw();
  void ctx.live.refreshInbox();
};
