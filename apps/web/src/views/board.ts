import { moneyPrices, type Prices, usdLabel } from "@galahad/core/spend";
import type { Ctx } from "../context.ts";
import { GALAHAD } from "../lib/arrange.ts";
import { besideChip, withState } from "../lib/knight-state.ts";
import { teamHash } from "../lib/team.ts";
import { spentSince } from "../lib/work.ts";
import { roundtableView, setRoundtableView, type RoundtableView } from "../prefs.ts";
import { leadMark, stateChip } from "../ui/avatar.ts";
import { button, list, listRow, pageHead, section, segmented } from "../ui/controls.ts";
import { cx, h, keepPlace, replace, type Scope } from "../ui/dom.ts";
import { sortable } from "../ui/drag.ts";
import { icon } from "../ui/icons.ts";
import { arrangeControls } from "./arrange.ts";
import { dropped, openSeat, type Seat, seatFace, type Table, tableOf, tableSources } from "./roster.ts";
import { editKnight, editRoom, giveToRoundtable } from "./team-forms.ts";

/*
 * The Roundtable's own page (#/team with no conversation open): everyone at the table, in your order and who leads
 * first, as a board of cards (each knight's portrait in its seat, its name and job, its state in a word, what it is doing
 * now) or as a list, this device's choice (a phone's is the list: your words, 26 November 2026, "workers, quietly: who
 * does what, and what it costs"); each with what its work cost this week at your prices; then the rooms. A knight is
 * dragged into your order (ui/drag.ts); Arrange does the same with buttons, and chooses who leads. It reads what the
 * seats read (views/roster.ts's tableOf), and asks the node for your prices alone.
 */

/** A portrait on a card, and a face in a list's row. */
const PORTRAIT = 104;
const FACE = 36;

export function roundtableHome(ctx: Ctx, root: HTMLElement, scope: Scope): void {
  const canEdit = ctx.can("fleet:admin");
  const narrow = matchMedia("(max-width: 959px)");
  let view: RoundtableView = roundtableView();
  /** Your prices, for what each knight's work cost this week (asked once; without them, nothing is said of money). */
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
  /** This week's spend of a knight's work, in words ("$1.02 this week"), or nothing. */
  const weekWords = (seated: Seat, now: Table): string | null => {
    if (!prices || seated.id === GALAHAD || !now.snapshot) return null;
    const spent = spentSince(now.snapshot.tasks, seated.id, Date.now() - 7 * 24 * 3600_000, prices);
    return spent ? `${spent.complete ? "" : "at least "}${usdLabel(spent.usd)} this week` : null;
  };
  let arranging = false;
  let shown = "";
  let table: Table | null = null;

  const body = h("div", { class: "roundtable-body" });
  const viewSwitch = segmented(
    [
      { value: "board", label: "Board" },
      { value: "list", label: "List" },
    ],
    view,
    (next) => {
      view = next;
      setRoundtableView(next);
      render();
    },
    { label: "Show the knights as", small: true },
  );
  const arrangeButton = button("Arrange", { title: "Your order of the knights, and who leads", onClick: () => ((arranging = true), render()) });
  const done = button("Done", { variant: "primary", onClick: () => ((arranging = false), render()) });
  const newKnight = button("New knight", { icon: "plus", onClick: () => void editKnight(ctx) });
  const give = button("Give a task", { variant: "primary", icon: "layers", onClick: () => giveToRoundtable(ctx) });
  give.dataset.give = "";
  const page = h(
    "div",
    { class: "page roundtable-home" },
    pageHead("The Roundtable", "Your knights in your order, and what each is doing now. Whoever leads answers what you say in a room without naming anyone.", [viewSwitch.el, canEdit ? [arrangeButton, done, newKnight, give] : null]),
    body,
  );

  const drag = canEdit
    ? sortable(body, {
        items: () => [...body.querySelectorAll<HTMLElement>("[data-moves]")],
        layout: () => (view === "board" ? { kind: "grid", gap: 16 } : { kind: "rows", gap: 0 }),
        onDrop: (key, index) => table && dropped(ctx, table, key, index),
        onEnd: () => render(),
      })
    : null;
  scope.add(() => drag?.dispose());

  /** What a seat is for, under its name: a knight's job, and Galahad's standing. */
  const roleOf = (seated: Seat, now: Table): string => (seated.id === GALAHAD ? "First among equals" : (now.snapshot?.teammates.find((knight) => knight.id === seated.id)?.role ?? ""));
  const keyOf = (seated: Seat): string => (seated.id === GALAHAD ? "galahad" : `person:${seated.id}`);
  const movable = (seated: Seat, now: Table): boolean => canEdit && seated.id !== GALAHAD && seated.id !== now.primary;
  const leads = (seated: Seat, now: Table) => (seated.id === now.primary ? leadMark(seated.name) : null);

  /** A knight on the board: a link to its timeline, or, while you arrange, its card with the buttons that move it. */
  function card(seated: Seat, now: Table): HTMLElement {
    const content = [
      leads(seated, now),
      h("div", { class: "knight-card-portrait" }, seatFace(seated, PORTRAIT)),
      h("div", { class: "knight-card-text" }, h("div", { class: "knight-card-head" }, h("h3", { class: "ellipsis" }, seated.name), stateChip(seated.state)), h("div", { class: "knight-card-role" }, [roleOf(seated, now), weekWords(seated, now)].filter(Boolean).join(" · ")), h("p", { class: "knight-card-line" }, besideChip(seated.line, seated.state))),
    ];
    const attrs = { class: "card knight-card", "data-key": keyOf(seated), "data-state": seated.state, "data-needs": seated.needs ? "" : null, "data-moves": movable(seated, now) ? "" : null };
    if (arranging) return h("div", attrs, ...content, h("div", { class: "knight-card-arrange" }, ...arrangeControls(ctx, now.snapshot!, seated)));
    const open = openSeat(ctx, seated);
    return h("a", { ...attrs, href: seated.href, draggable: "false", title: `${seated.name}: ${seated.line}`, "aria-label": `${withState(seated.name, seated.state)}: ${seated.line}`, ...(open ? { onclick: open } : {}) }, ...content);
  }

  /** A knight in the list: the same, as a row. */
  function row(seated: Seat, now: Table): HTMLElement {
    const el = listRow({
      lead: seatFace(seated, FACE),
      title: h("span", { class: "knight-row-title" }, h("span", { class: "ellipsis" }, seated.name), leads(seated, now), stateChip(seated.state)),
      sub: besideChip(seated.line, seated.state),
      meta: [h("span", {}, roleOf(seated, now)), weekWords(seated, now) ? h("span", { class: "tnum" }, weekWords(seated, now)) : null],
      key: keyOf(seated),
      ...(arranging ? { trail: arrangeControls(ctx, now.snapshot!, seated) } : { href: seated.href, chevron: true, ...(openSeat(ctx, seated) ? { onClick: openSeat(ctx, seated)! } : {}) }),
    });
    if (movable(seated, now)) el.dataset.moves = "";
    if (seated.needs) el.dataset.needs = "";
    if (el instanceof HTMLAnchorElement) el.draggable = false;
    return el;
  }

  function render(): void {
    if (drag?.dragging()) return;
    // A phone's is the list, with no choice of a board (its cards are a wide screen's).
    view = narrow.matches ? "list" : roundtableView();
    viewSwitch.el.hidden = narrow.matches;
    const now = tableOf(ctx);
    table = now;
    if (!now.snapshot) return;
    const knights = now.seats.length - 1;
    if (!knights) arranging = false;
    const version = JSON.stringify([now.seats, now.rooms, now.primary, view, arranging, Boolean(prices)]);
    if (version === shown && page.isConnected) return;
    shown = version;
    if (!page.isConnected) replace(root, page);
    arrangeButton.hidden = arranging || !knights;
    done.hidden = !arranging;
    newKnight.hidden = give.hidden = arranging;
    give.hidden ||= !knights;
    body.dataset.view = view;
    if (arranging) body.dataset.arranging = "";
    else delete body.dataset.arranging;
    const working = now.seats.filter((seated) => seated.state === "working").length;
    const waiting = now.seats.filter((seated) => seated.state === "needs" || seated.state === "failed").length;
    const count = [String(knights), working ? `${working} working` : "", waiting ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""].filter(Boolean).join(" · ");
    const seatNew = canEdit && !arranging;
    keepPlace(body, () =>
      replace(
        body,
        section(
          "Knights",
          { count, ...(arranging ? { note: "Who leads comes first, and Galahad beside it; the others in your order. Every device shows it." } : !knights && canEdit ? { note: "Seat a knight beside Galahad: a name, a lasting job and a workspace of its own." } : {}) },
          view === "board"
            ? h("div", { class: cx("board", arranging && "arranging") }, ...now.seats.map((seated) => card(seated, now)), seatNew ? h("button", { type: "button", class: "card knight-card knight-card-add", onclick: () => void editKnight(ctx) }, h("span", { class: "knight-card-plus" }, icon("plus", { size: 18 })), "Seat a knight") : null)
            : list([...now.seats.map((seated) => row(seated, now)), seatNew ? listRow({ lead: "plus", title: "Seat a knight", sub: "A name, a lasting job and a workspace of its own", onClick: () => void editKnight(ctx) }) : null]),
        ),
        arranging
          ? null
          : section(
              "Rooms",
              { count: now.rooms.length ? `${now.rooms.length}` : undefined, actions: canEdit && knights ? button("New room", { variant: "ghost", size: "sm", icon: "hash", onClick: () => editRoom(ctx) }) : null },
              list(
                now.rooms.map((room) => listRow({ lead: "hash", title: room.name, sub: room.line, href: teamHash({ room: room.room! }), chevron: true, key: room.key })),
                { empty: { icon: "hash", title: "No rooms yet", body: knights ? "A room is a conversation several knights share, Galahad among them." : "Seat a knight first: a room is where knights talk together." } },
              ),
            ),
      ),
    );
  }

  for (const source of tableSources(ctx)) scope.add(source.subscribe(render));
  const media = () => render();
  narrow.addEventListener("change", media);
  scope.add(() => narrow.removeEventListener("change", media));
  render();
}
