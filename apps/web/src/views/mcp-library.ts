import type { ConnectorLibraryView, ConnectorView, LibrarySort, McpCategory, McpLibraryView } from "@galahad/core";
import { type Ctx, errorMessage } from "../context.ts";
import { plural } from "../lib/text.ts";
import { relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, empty, section, segmented } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";
import { type McpDeps, openKey, openSignIn } from "./mcp.ts";

/*
 * The library of hosted MCP servers, on Connectors: Galahad's reviewed list and the index at mcp.galahad.sh (the
 * official MCP Registry's servers that are their service's own, ranked and probed), asked of the node a page at a time
 * (POST /api/connectors/library). Words, how it lets Galahad in, a shelf and an order narrow it; Add puts one in, and its
 * sign-in or its key comes next, in a sheet of its own.
 */

const PAGE = 30;
const HOW: Record<McpLibraryView["auth"], string> = { oauth: "Signs in", key: "Takes a key", none: "Open" };
const host = (url: string) => new URL(url).host;

export function mcpLibrarySection(ctx: Ctx, deps: McpDeps): { el: HTMLElement; refresh(): void } {
  const state: { q: string; auth: "" | McpLibraryView["auth"]; category: "" | McpCategory; sort: LibrarySort; shown: number } = { q: "", auth: "", category: "", sort: "popular", shown: 0 };
  const search = h("input", { class: "input grow", type: "search", placeholder: "Search the library", autocomplete: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Search the library" });
  const kinds = segmented<"" | McpLibraryView["auth"]>(
    [
      { value: "", label: "All" },
      { value: "oauth", label: "Sign in" },
      { value: "key", label: "Key" },
      { value: "none", label: "Open" },
    ],
    "",
    (value) => {
      state.auth = value;
      void load();
    },
    { label: "How it lets Galahad in", small: true },
  );
  const shelf = h("select", { class: "select", "aria-label": "Shelf" }, h("option", { value: "" }, "Every shelf"));
  const order = h("select", { class: "select", "aria-label": "Order" }, h("option", { value: "popular" }, "Popular"), h("option", { value: "name" }, "A–Z"), h("option", { value: "updated" }, "Recently updated"));
  const list = h("div", { class: "rows" });
  const more = button("Show more", { size: "sm", onClick: () => void busy(more, () => load(true)) });
  const status = h("p", { class: "tiny subtle" });
  let typing: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.q = search.value.trim();
      void load();
    }, 200);
  });
  shelf.addEventListener("change", () => {
    state.category = shelf.value as McpCategory | "";
    void load();
  });
  order.addEventListener("change", () => {
    state.sort = order.value as LibrarySort;
    void load();
  });

  // Only the latest ask is shown: a slower, older answer is dropped.
  let asked = 0;
  let firstRead: ReturnType<typeof setTimeout> | undefined;
  async function load(append = false): Promise<void> {
    const mine = ++asked;
    try {
      const page = await ctx.api.post<ConnectorLibraryView>("/api/connectors/library", {
        ...(state.q ? { q: state.q } : {}),
        ...(state.auth ? { auth: state.auth } : {}),
        ...(state.category ? { category: state.category } : {}),
        sort: state.sort,
        offset: append ? state.shown : 0,
        limit: PAGE,
      });
      if (mine !== asked) return;
      show(page, append);
    } catch (error) {
      if (mine === asked) replace(list, callout("danger", errorMessage(error), { title: "The library couldn't be read" }));
    }
  }

  function show(page: ConnectorLibraryView, append: boolean): void {
    // The shelves as the words and the kind leave them, the one chosen kept even when it holds nothing now.
    const chosen = state.category;
    replace(
      shelf,
      h("option", { value: "" }, "Every shelf"),
      ...page.categories.map((c) => h("option", { value: c.name, selected: c.name === chosen }, `${c.name} (${c.count})`)),
      chosen && !page.categories.some((c) => c.name === chosen) ? h("option", { value: chosen, selected: true }, `${chosen} (0)`) : null,
    );
    const rows = page.entries.map((e) => row(e));
    if (append) list.append(...rows);
    else replace(list, ...(rows.length ? rows : [empty({ icon: "search", title: state.q ? `Nothing matches "${state.q}"` : "Nothing here", body: "Try other words, or every shelf.", compact: true })]));
    state.shown = (append ? state.shown : 0) + page.entries.length;
    more.hidden = state.shown >= page.total;
    const index = page.index;
    replace(
      status,
      `${page.total.toLocaleString("en")} ${page.total === 1 ? "server" : "servers"}${page.total > state.shown ? `, ${state.shown} shown` : ""}. `,
      index.problem
        ? `The index couldn't be read (${index.problem}): Galahad's reviewed servers are here.`
        : index.fetched
          ? `Galahad's reviewed servers, and ${index.count.toLocaleString("en")} more the index found in the official MCP Registry, each the service's own (read ${relativeTime(index.fetched)}).`
          : index.url
            ? "Reading the index for the first time…"
            : "Galahad's reviewed servers (this node reads no index).",
    );
    // A first read is under way: asked again in a moment, once.
    clearTimeout(firstRead);
    if (index.url && index.fetched === null && !index.problem) firstRead = setTimeout(() => void load(), 2500);
  }

  function row(e: McpLibraryView): HTMLElement {
    const add = !e.installed && ctx.can("brain:write") ? button("Add", { size: "sm", icon: "plus" }) : null;
    add?.addEventListener("click", () =>
      void busy(add, async () => {
        try {
          const { connector } = await ctx.api.post<{ connector: ConnectorView }>("/api/connectors", { id: e.id });
          deps.changed();
          void load();
          if (connector.oauth?.provider === "mcp" && connector.key !== "ready") openSignIn(ctx, connector);
          else if (connector.key === "missing" || connector.key === "wrong-origin") openKey(ctx, connector, deps);
          else toast(`${connector.label} added`, { tone: "ok", description: `${plural(connector.tools.length, "tool")}, on every node.` });
        } catch (error) {
          toast(`Couldn't add ${e.label}`, { tone: "error", description: errorMessage(error) });
        }
      }),
    );
    return h(
      "div",
      { class: "item center library-item" },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row tight wrap" }, h("strong", {}, e.label), e.reviewed ? badge("Reviewed", "accent") : null, e.installed ? badge("Installed", "ok", "check") : null),
        h("p", { class: "tiny subtle" }, `${HOW[e.auth]} · ${e.category} · `, h("span", { class: "mono" }, host(e.url))),
        e.description ? h("p", { class: "small muted library-line" }, e.description) : null,
      ),
      add,
    );
  }

  const el = section(
    "MCP library",
    { id: "connectors-library" },
    h("p", { class: "small subtle" }, "Hosted MCP servers, each the service's own. One that signs in needs no key and no app of yours: add it, and sign in as yourself."),
    h("div", { class: "row wrap library-tools" }, search, kinds.el, shelf, order),
    status,
    h("div", { class: "card flat" }, list),
    h("div", { class: "row" }, more),
  );
  return { el, refresh: () => void load() };
}
