import type { Ctx } from "../context.ts";
import { type Place, placesFor, placesIndex } from "../lib/nav.ts";
import { button, list, listRow, section } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, isMac } from "../ui/dom.ts";
import { giveToRoundtable } from "./team-forms.ts";

/*
 * Everything else, under "…" (your words, 26 November 2026: on a phone no tab bar, "a '…' sheet for everything else";
 * the wide screen's rail went with it, its places here and in the command palette): the Roundtable, where the knights and
 * their rooms are, then every place More lists, each with a line saying what is there, only what this device may see.
 * A sheet on every screen (a bottom sheet on a phone); More (#/more) is the same index as a page.
 */

/** A place's row in the index (the Inbox counts what waits there). */
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

/** The index as sections: the Roundtable on its own, then More's headings. */
export function placesSections(ctx: Ctx): HTMLElement[] {
  const waiting = ctx.live.inboxCount.value;
  return placesIndex(placesFor(ctx.can)).map((group) => (group.heading ? section(group.heading, {}, list(group.places.map((place) => placeRow(place, waiting)), { nav: group.heading })) : list(group.places.map((place) => placeRow(place, waiting)), { nav: "The Roundtable" })));
}

/** Opens the index under "…": a search and a task to give at its head, then every place. */
export function openPlaces(ctx: Ctx, from?: Element): void {
  const canGive = ctx.can("fleet:admin") && ctx.can("chat");
  const sheet = openSheet({
    title: "Everything else",
    description: "Every place this device may open. Search finds the rest, and your chats.",
    body: h(
      "div",
      { class: "stack loose places-index" },
      h(
        "div",
        { class: "row wrap" },
        button("Search", { icon: "search", label: `Search and commands (${isMac() ? "⌘" : "Ctrl"}+K)`, onClick: () => (sheet.close(), ctx.palette(undefined, from)) }),
        canGive ? button("Give a task", { icon: "layers", onClick: () => (sheet.close(), giveToRoundtable(ctx)) }) : null,
        // (What the rail's Add was: the palette, on everything this device may add, a key, an MCP server, a loop…)
        button("Add…", { icon: "plus", title: "Add a key, an MCP server, a connector, a loop and more", onClick: () => (sheet.close(), ctx.palette("Add ", from)) }),
      ),
      ...placesSections(ctx),
    ),
  });
}
