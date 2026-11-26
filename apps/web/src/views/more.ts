import type { View } from "../context.ts";
import { pageHead } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";
import { placesSections } from "./places.ts";

/* More: the index under "…" as a page of its own (#/more): the Roundtable, then every other place under its heading,
 * each with a line saying what is there. Only what this device may see. */

export const moreView: View = (root, ctx) => {
  replace(root, h("div", { class: "page narrow" }, pageHead("More", "Everything else, in one place."), ...placesSections(ctx)));
};
