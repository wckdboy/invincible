import { moneyPrices, type Prices, usdLabel } from "@invincible/core/spend";
import type { Ctx } from "../context.ts";
import { PRIMARY } from "../lib/arrange.ts";
import { besideChip, withState } from "../lib/agent-state.ts";
import { teamRoutingLines } from "../lib/routing.ts";
import { teamHash } from "../lib/team.ts";
import { spentSince } from "../lib/work.ts";
import { agentsView, setAgentsView, type AgentsView } from "../prefs.ts";
import { stateChip } from "../ui/avatar.ts";
import { button, list, listRow, pageHead, section, segmented } from "../ui/controls.ts";
import { cx, h, keepPlace, replace, type Scope } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { openSeat, type Seat, seatFace, type Table, tableOf, tableSources } from "./roster.ts";
import { editAgent, editRoom, giveToAgents } from "./team-forms.ts";

/*
 * The agents' own page (#/team with no conversation open): everyone at the table, the primary first, as a board of cards (each agent's portrait in its seat, its name and job, its state in a word, what it is doing
 * now) or as a list, this device's choice (a phone's is the list: your words, 26 November 2026, "workers, quietly: who
 * does what, and what it costs"); each with what its work cost this week at your prices; then the rooms. It reads what
 * the seats read (views/roster.ts's tableOf), and asks the node for your prices alone.
 */

/** A portrait on a card, and a face in a list's row. */
const PORTRAIT = 104;
const FACE = 36;

export function agentsHome(ctx: Ctx, root: HTMLElement, scope: Scope): void {
  const canEdit = ctx.can("fleet:admin");
  const narrow = matchMedia("(max-width: 767px)");
  let view: AgentsView = agentsView();
  /** Your prices, for what each agent's work cost this week (asked once; without them, nothing is said of money). */
  let prices: Prices | null = null;
  if (ctx.can("mind:read")) {
    ctx.api.get<{ prices: Prices; plans?: string[] }>("/api/prices", scope.signal).then(
      (answer) => {
        prices = moneyPrices(answer.prices, answer.plans ?? []);
        shown = "";
        render();
      },
      () => {},
    );
  }
  /** This week's spend of an agent's work, in words ("$1.02 this week"), or nothing. */
  const weekWords = (seated: Seat, now: Table): string | null => {
    if (!prices || seated.id === PRIMARY || !now.snapshot) return null;
    const spent = spentSince(now.snapshot.tasks, seated.id, Date.now() - 7 * 24 * 3600_000, prices);
    return spent ? `${spent.complete ? "" : "at least "}${usdLabel(spent.usd)} this week` : null;
  };
  let shown = "";

  const body = h("div", { class: "agents-body" });
  const viewSwitch = segmented(
    [
      { value: "board", label: "Board" },
      { value: "list", label: "List" },
    ],
    view,
    (next) => {
      view = next;
      setAgentsView(next);
      render();
    },
    { label: "Show the agents as", small: true },
  );
  const newAgent = button("New agent", { icon: "plus", onClick: () => void editAgent(ctx) });
  const give = button("Give a task", { variant: "primary", icon: "layers", onClick: () => giveToAgents(ctx) });
  give.dataset.give = "";
  const page = h(
    "div",
    { class: "page agents-home" },
    pageHead("The agents", "Your agents, and what each is doing now.", [viewSwitch.el, canEdit ? [newAgent, give] : null]),
    body,
  );

  /** What a seat is for, under its name: an agent's job, and the primary's standing. */
  const roleOf = (seated: Seat, now: Table): string => (seated.id === PRIMARY ? "First among equals" : (now.snapshot?.agents.find((agent) => agent.id === seated.id)?.role ?? ""));
  const keyOf = (seated: Seat): string => (seated.id === PRIMARY ? "primary" : `person:${seated.id}`);

  /** An agent on the board: a link to its timeline. */
  function card(seated: Seat, now: Table): HTMLElement {
    const content = [
      h("div", { class: "agent-card-portrait" }, seatFace(seated, PORTRAIT)),
      h("div", { class: "agent-card-text" }, h("div", { class: "agent-card-head" }, h("h3", { class: "ellipsis" }, seated.name), stateChip(seated.state)), h("div", { class: "agent-card-role" }, [roleOf(seated, now), weekWords(seated, now)].filter(Boolean).join(" · ")), h("p", { class: "agent-card-line" }, besideChip(seated.line, seated.state))),
    ];
    const attrs = { class: "card agent-card", "data-key": keyOf(seated), "data-state": seated.state, "data-needs": seated.needs ? "" : null };
    const open = openSeat(ctx, seated);
    return h("a", { ...attrs, href: seated.href, draggable: "false", title: `${seated.name}: ${seated.line}`, "aria-label": `${withState(seated.name, seated.state)}: ${seated.line}`, ...(open ? { onclick: open } : {}) }, ...content);
  }

  /** An agent in the list: the same, as a row. */
  function row(seated: Seat, now: Table): HTMLElement {
    const el = listRow({
      lead: seatFace(seated, FACE),
      title: h("span", { class: "agent-row-title" }, h("span", { class: "ellipsis" }, seated.name), stateChip(seated.state)),
      sub: besideChip(seated.line, seated.state),
      meta: [h("span", {}, roleOf(seated, now)), weekWords(seated, now) ? h("span", { class: "tnum" }, weekWords(seated, now)) : null],
      key: keyOf(seated),
      href: seated.href,
      chevron: true,
      ...(openSeat(ctx, seated) ? { onClick: openSeat(ctx, seated)! } : {}),
    });
    if (seated.needs) el.dataset.needs = "";
    if (el instanceof HTMLAnchorElement) el.draggable = false;
    return el;
  }

  function render(): void {
    // A phone's is the list, with no choice of a board (its cards are a wide screen's).
    view = narrow.matches ? "list" : agentsView();
    viewSwitch.el.hidden = narrow.matches;
    const now = tableOf(ctx);
    if (!now.snapshot) return;
    const agents = now.seats.length - 1;
    // How the team's finished work was routed (lib/routing.ts, core's report): a quiet line each kind, at a desk's width.
    // A phone has none.
    const routing = narrow.matches ? [] : teamRoutingLines(now.snapshot.tasks);
    const version = JSON.stringify([now.seats, now.rooms, view, Boolean(prices), routing]);
    if (version === shown && page.isConnected) return;
    shown = version;
    if (!page.isConnected) replace(root, page);
    give.hidden = !agents;
    body.dataset.view = view;
    const working = now.seats.filter((seated) => seated.state === "working").length;
    const waiting = now.seats.filter((seated) => seated.state === "needs" || seated.state === "failed").length;
    const count = [String(agents), working ? `${working} working` : "", waiting ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""].filter(Boolean).join(" · ");
    const seatNew = canEdit;
    keepPlace(body, () =>
      replace(
        body,
        section(
          "Agents",
          { count, ...(!agents && canEdit ? { note: "Seat an agent beside your agent: a name, a lasting job and a workspace of its own." } : {}) },
          view === "board"
            ? h("div", { class: "board" }, ...now.seats.map((seated) => card(seated, now)), seatNew ? h("button", { type: "button", class: "card agent-card agent-card-add", onclick: () => void editAgent(ctx) }, h("span", { class: "agent-card-plus" }, icon("plus", { size: 18 })), "Seat an agent") : null)
            : list([...now.seats.map((seated) => row(seated, now)), seatNew ? listRow({ lead: "plus", title: "Seat an agent", sub: "A name, a lasting job and a workspace of its own", onClick: () => void editAgent(ctx) }) : null]),
        ),
        section(
              "Rooms",
              { count: now.rooms.length ? `${now.rooms.length}` : undefined, actions: canEdit && agents ? button("New room", { variant: "ghost", size: "sm", icon: "hash", onClick: () => editRoom(ctx) }) : null },
              list(
                now.rooms.map((room) => listRow({ lead: "hash", title: room.name, sub: room.line, href: teamHash({ room: room.room! }), chevron: true, key: room.key })),
                { empty: { icon: "hash", title: "No rooms yet", body: agents ? "A room is a conversation several agents share, your agent among them." : "Seat an agent first: a room is where agents talk together." } },
              ),
            ),
        routing.length
          ? section(
              "Routing",
              { note: "How the tasks this node finished last were routed, by kind. invincible agents routing says it all." },
              h("div", { class: "stack tight" }, ...routing.map((line) => h("p", { class: "meta" }, line))),
            )
          : null,
      ),
    );
  }

  for (const source of tableSources(ctx)) scope.add(source.subscribe(render));
  const media = () => render();
  narrow.addEventListener("change", media);
  scope.add(() => narrow.removeEventListener("change", media));
  render();
}
