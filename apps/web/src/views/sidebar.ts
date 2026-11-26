import type { Ctx, Route } from "../context.ts";
import { button, dot, kbd } from "../ui/controls.ts";
import { h, isMac, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { appMark } from "../ui/orb.ts";
import { placesNav } from "./places.ts";

/*
 * A wide screen's sidebar: the drawer's places, kept open (I11: "at desktop width, the drawer's places as a sidebar that
 * stays open, Home beside it, and search on ⌘K"). At its head the I-beam and the app's name, which go Home, and the
 * sidebar folded away; then search; then the drawer's list (views/places.ts): a new chat and your latest chats, what
 * needs you, the agents, all your chats, the keys, the connectors, Settings and More; at its foot the machine it talks
 * to. Your agent and the work are Home's, beside it: nothing is said twice. It asks the node nothing of its own.
 */

export interface Sidebar {
  el: HTMLElement;
  /** Where the app is: its head is marked on Home, and that place's row elsewhere. */
  at(where: { route: Route; task?: string | null }): void;
  dispose(): void;
}

export function sidebarNav(ctx: Ctx, shell: { toggle(): void }): Sidebar {
  // ---- the head: the I-beam and the name (Home), the sidebar folded away; then search ----
  const collapse = button("Hide the sidebar", { variant: "ghost", size: "sm", iconOnly: true, icon: "sidebar", title: "Hide the sidebar  ( [ )", onClick: () => shell.toggle() });
  const home = h("a", { class: "side-mark", href: "#/home", title: "Home: your agent, what needs you, and the work" }, appMark(22), h("span", { class: "wordmark-text" }, "Invincible"));
  const head = h("div", { class: "side-head" }, home, collapse);
  const search = h(
    "button",
    { class: "search-trigger side-search", type: "button", onclick: () => ctx.palette(), "aria-label": `Search, or ask your agent (${isMac() ? "⌘" : "Ctrl"}+K)` },
    icon("search", { size: 14 }),
    h("span", { class: "label" }, "Search, or ask"),
    h("span", { class: "kbds" }, ...kbd(isMac() ? "⌘" : "Ctrl", "K")),
  );
  const places = placesNav(ctx);

  // ---- the foot: the machine it talks to, by its name from the first frame; how many of the fleet's are online once
  // it says ----
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
  const foot = h("div", { class: "side-foot" }, machine);

  const el = h("aside", { class: "sidebar", "aria-label": "Everything" }, head, search, h("div", { class: "side-places" }, places.el), foot);
  const stop = ctx.live.fleet.subscribe(drawMachine);
  drawMachine();
  return {
    el,
    at(where) {
      if (where.route === "home") home.setAttribute("aria-current", "page");
      else home.removeAttribute("aria-current");
      places.at(where.route);
    },
    dispose() {
      stop();
      places.dispose();
    },
  };
}
