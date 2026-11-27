import type { Ctx } from "../context.ts";
import { type Place, placesFor, placesIndex } from "../lib/nav.ts";
import { list, listRow, section } from "../ui/controls.ts";
import { h } from "../ui/dom.ts";

/*
 * Every place, as More (#/more) lists them: the whole index as a page, with a line saying what is in each. The agents,
 * what needs you and your agent are the roster's (views/sidebar.ts: a wide screen's sidebar, a phone's drawer); this is
 * everything else, and the command palette reaches each place too.
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
