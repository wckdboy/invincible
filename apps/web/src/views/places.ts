import type { Ctx, Route } from "../context.ts";
import { type Place, placesFor, placesIndex } from "../lib/nav.ts";
import { list, listRow, section } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { arrowsThrough, cx, h, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { appMark } from "../ui/orb.ts";
import { chatsForPalette, onChatsChanged, startNewChat } from "./chat.ts";
import { needsCount } from "./needs.ts";
import { workNow, workSources } from "./work-rows.ts";

/*
 * Everything else, as the iPhone's drawer (your words, 26 November 2026: on a phone no tab bar; Home with a bar at its
 * foot and a drawer): a new chat; what needs you and the agents, each with its count, all your chats, the keys, the
 * connectors, Settings and More, every other place; then your latest chats, so a past one is two taps from Home (last,
 * where their coming a moment later moves nothing). On a
 * phone, and wherever no sidebar shows, it is a drawer from the left edge (Home's I-beam opens it, or a swipe from the
 * edge, or "…"); on a wide screen it is the sidebar, kept open beside the page (views/sidebar.ts). More (#/more) is
 * the whole index as a page, with a line saying what is in each place.
 */

/** A place's row in More's index (the Inbox counts what waits there). */
export function placeRow(place: Place, waiting = 0): HTMLElement {
  return listRow({
    lead: place.icon,
    title: place.label,
    sub: place.about,
    href: `#/${place.id}`,
    chevron: true,
    ...(place.id === "inbox" && waiting ? { trail: h("span", { class: "count", "aria-label": `${waiting} waiting` }, waiting > 99 ? "99+" : String(waiting)) } : {}),
  });
}

/** More's index as sections: the agents on its own, then More's headings. */
export function placesSections(ctx: Ctx): HTMLElement[] {
  const waiting = ctx.live.inboxCount.value;
  return placesIndex(placesFor(ctx.can)).map((group) => (group.heading ? section(group.heading, {}, list(group.places.map((place) => placeRow(place, waiting)), { nav: group.heading })) : list(group.places.map((place) => placeRow(place, waiting)), { nav: "The agents" })));
}

/** How many of your latest chats it lists. */
export const LATEST_CHATS = 5;

/** The places it names, in the iPhone drawer's order (Needs you is the Inbox; your chats come after the agents). The
 * others are under More. */
const NAMED = ["inbox", "team", "vault", "connectors", "settings"] as const satisfies readonly Route[];

/** What it calls them (the iPhone's words): the keys. */
const NAMES: Partial<Record<Route, string>> = { vault: "Keys" };

export interface PlacesNav {
  el: HTMLElement;
  /** Where the app is: that place's row is marked. */
  at(route: Route | null): void;
  dispose(): void;
}

/** The list itself, drawn from what the app has and kept true while it shows. `picked` is told a row was chosen (the
 * drawer closes). */
export function placesNav(ctx: Ctx, picked: () => void = () => {}): PlacesNav {
  const visible = placesFor(ctx.can);
  const canChat = ctx.can("chat");
  const named = new Set<Route>(NAMED);
  const rows = new Map<Route, HTMLElement>();
  const stops: (() => void)[] = [];

  const row = (o: { lead: IconName; text: string; href?: string; run?: () => void; trail?: HTMLElement | null; quiet?: boolean; label?: string }): HTMLElement => {
    const parts = [icon(o.lead, { size: 18 }), h("span", { class: "grow ellipsis" }, o.text), o.trail ?? null];
    const attrs = { class: cx("place", o.quiet && "quiet"), "aria-label": o.label ?? null };
    return o.href
      ? h("a", { ...attrs, href: o.href, onclick: () => picked() }, ...parts)
      : h("button", { ...attrs, type: "button", onclick: () => (picked(), o.run?.()) }, ...parts);
  };
  const placeOf = (id: Route, trail?: HTMLElement): HTMLElement | null => {
    const place = visible.find((one) => one.id === id);
    if (!place) return null;
    const el = row({ lead: place.icon, text: NAMES[id] ?? place.label, href: `#/${id}`, trail });
    rows.set(id, el);
    return el;
  };

  // ---- a new chat, and your latest ----
  const chats = h("div", { class: "places-chats" });
  let chatsShown = "";
  const drawChats = (): void => {
    const latest = [...chatsForPalette(ctx.api, { chat: true, read: ctx.can("mind:read") }).chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LATEST_CHATS);
    const version = JSON.stringify(latest.map((chat) => [chat.id, chat.title]));
    if (version === chatsShown) return;
    chatsShown = version;
    replace(chats, ...latest.map((chat) => row({ lead: "chat", text: chat.title || "A chat", href: `#/chat?c=${chat.id}`, quiet: true })));
  };
  if (canChat) {
    drawChats();
    stops.push(onChatsChanged(drawChats));
  }

  // ---- the places, each count the one shown everywhere ----
  const needs = h("span", { class: "place-count tnum", "data-tone": "needs" });
  const agents = h("span", { class: "place-count tnum" });
  const drawCounts = (): void => {
    const work = ctx.live.inboxLoaded.value ? workNow(ctx) : null;
    const waiting = work ? needsCount(ctx, work) : 0;
    needs.textContent = waiting ? String(waiting) : "";
    rows.get("inbox")?.setAttribute("aria-label", waiting ? `Needs you: ${waiting}` : "Needs you");
    const team = ctx.live.team.value?.agents.length;
    agents.textContent = team ? String(team) : "";
  };
  const more = visible.some((place) => place.under !== "primary" && place.under !== "thread" && place.id !== "more" && !named.has(place.id)) ? placeOf("more") : null;

  const el = h(
    "nav",
    { class: "places-nav", "aria-label": "Everything else" },
    h(
      "div",
      { class: "places-group" },
      canChat ? row({ lead: "edit", text: "New chat", run: () => (startNewChat(), ctx.navigate("chat")) }) : null,
      placeOf("inbox", needs),
      placeOf("team", agents),
      canChat ? row({ lead: "clock", text: "All chats", run: () => ctx.navigate("chat", { intent: "history" }) }) : null,
      placeOf("vault"),
      placeOf("connectors"),
      placeOf("settings"),
      more,
    ),
    // Your latest chats last: they come a moment after the list is drawn, and under it their coming moves nothing (the
    // scorecard's layout shift: above the places, they pushed every row down on every page of a wide screen).
    canChat ? h("div", { class: "places-group places-latest" }, chats) : null,
  );
  arrowsThrough(el, ".place");
  for (const source of [...workSources(ctx), ctx.live.inboxLoaded, ctx.live.inboxCount, ctx.live.pairings, ctx.live.secretRequests, ctx.live.questions, ctx.live.screenSessions, ctx.live.notices, ctx.live.loopDrafts, ctx.live.connectorRequests, ctx.live.aboutYou] as { subscribe(listener: () => void): () => void }[]) stops.push(source.subscribe(drawCounts));
  drawCounts();

  return {
    el,
    at(route) {
      for (const [id, place] of rows) {
        if (id === route) place.setAttribute("aria-current", "page");
        else place.removeAttribute("aria-current");
      }
    },
    dispose() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}

/** Opens it as the drawer, from the screen's left edge. */
export function openPlaces(ctx: Ctx): void {
  const nav = placesNav(ctx, () => sheet.close());
  const sheet = openSheet({
    title: "Invincible",
    description: ctx.whoami.nodeName || ctx.whoami.fleetName || undefined,
    lead: appMark(28),
    side: "left",
    body: nav.el,
    initialFocus: () => nav.el.querySelector<HTMLElement>(".place"),
    onClose: () => nav.dispose(),
  });
  nav.at(null);
}
