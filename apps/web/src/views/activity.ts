import type { Ctx, View } from "../context.ts";
import { CLASS_LABEL, type LedgerFilter, ledgerFilterSummary, ledgerMatches, ledgerSignature, VERDICT_LABEL } from "../lib/activity.ts";
import { shortId } from "../lib/text.ts";
import { clockTime, dayKey, dayLabel, hlcMs, relativeTime } from "../lib/time.ts";
import { isUnavailable } from "../api.ts";
import type { ActionClass, LedgerEntry, Verdict } from "../types.ts";
import { badge, button, card, empty, errorState, meta, note, pageHead, section, skeletonRows, type Tone } from "../ui/controls.ts";
import { debounce, h, keepPlace, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { selector, type SelectorGroup } from "../ui/selector.ts";

/*
 * The ledger: every side-effecting action Galahad classified, with the oath's
 * verdict and why. Reads are free, creating and modifying are logged, outward
 * and destructive actions ask, and anything that breaks a hard limit is denied.
 */

export const CLASS_INFO: Record<ActionClass, { label: string; icon: IconName; tone: Tone; rule: string; verdict: Verdict | "allow (logged)" }> = {
  read: { label: CLASS_LABEL.read, icon: "eye", tone: "neutral", rule: "Look, list, fetch", verdict: "allow" },
  create: { label: CLASS_LABEL.create, icon: "plus", tone: "info", rule: "New bucket, branch, container, credential", verdict: "allow (logged)" },
  modify: { label: CLASS_LABEL.modify, icon: "edit", tone: "info", rule: "Change config, write objects, edit files", verdict: "allow (logged)" },
  outward: { label: CLASS_LABEL.outward, icon: "external", tone: "warn", rule: "Push, send, post, deploy, purchase", verdict: "ask" },
  delete: { label: CLASS_LABEL.delete, icon: "trash", tone: "danger", rule: "Remove anything persistent", verdict: "ask" },
  forbidden: { label: CLASS_LABEL.forbidden, icon: "ban", tone: "danger", rule: "Breaks a hard limit of the oath", verdict: "deny" },
};

export const VERDICT_TONE: Record<Verdict, Tone> = { allow: "ok", ask: "warn", deny: "danger", approved: "accent" };

export function verdictBadge(verdict: Verdict): HTMLElement {
  return badge(VERDICT_LABEL[verdict] ?? verdict, VERDICT_TONE[verdict] ?? "neutral");
}

/** A device id as the owner knows it: this node, a fleet name, or a short id. */
export function deviceName(ctx: Ctx, id: string): string {
  if (id === ctx.whoami.node) return ctx.whoami.nodeName;
  const known = ctx.live.fleet.value?.devices.find((d) => d.id === id);
  return known?.name ?? shortId(id);
}

export function ledgerItem(ctx: Ctx, entry: LedgerEntry, compact = false): HTMLElement {
  const info = CLASS_INFO[entry.class] ?? CLASS_INFO.read;
  const ms = hlcMs(entry.hlc);
  return h(
    "div",
    { class: "tl-item", "data-tone": info.tone },
    h("span", { class: "tl-icon", title: info.label }, icon(info.icon)),
    h(
      "div",
      { class: "tl-main" },
      h("div", { class: "tl-title" }, h("span", { class: "strong small" }, entry.resource), h("span", { class: "mono small wrap-anywhere" }, entry.target), verdictBadge(entry.verdict)),
      meta(
        h("span", {}, info.label.toLowerCase()),
        entry.quest ? h("span", {}, "quest ", h("span", { class: "mono" }, entry.quest)) : null,
        h("span", {}, "on ", deviceName(ctx, entry.device)),
        entry.reason ? h("span", { class: "muted" }, entry.reason) : null,
      ),
      !compact && entry.detail ? h("details", {}, h("summary", {}, "Details"), h("pre", {}, entry.detail)) : null,
    ),
    h("span", { class: "tl-time", title: ms ? new Date(ms).toLocaleString() : "" }, ms ? (compact ? relativeTime(ms) : clockTime(ms)) : ""),
  );
}

/** The autonomy view: what Galahad may do on his own, what asks, what's denied, with recent counts. */
export function autonomyCard(entries: LedgerEntry[] | null): HTMLElement {
  const since = Date.now() - 24 * 3600_000;
  const counts = new Map<ActionClass, number>();
  for (const e of entries ?? []) {
    const ms = hlcMs(e.hlc);
    if (ms && ms >= since) counts.set(e.class, (counts.get(e.class) ?? 0) + 1);
  }
  return card(
    { title: "Autonomy", icon: "shield", actions: h("span", { class: "tiny subtle" }, entries ? "last 24 h" : ""), foot: note("Set by the oath. Only you can amend it, with your signature. Galahad may clean up ephemeral things he made for a quest."), flush: true },
    h(
      "div",
      { class: "autonomy" },
      ...(Object.keys(CLASS_INFO) as ActionClass[]).map((cls) => {
        const info = CLASS_INFO[cls];
        const n = counts.get(cls);
        const tone: Tone = info.verdict === "ask" ? "warn" : info.verdict === "deny" ? "danger" : "ok";
        return h(
          "div",
          { class: "a-row" },
          h("div", { class: "row" }, h("span", { class: "line-icon" }, icon(info.icon, { size: 15 })), h("div", {}, h("div", { class: "strong" }, info.label), h("div", { class: "tiny subtle" }, info.rule))),
          h("div", { class: "row" }, n ? h("span", { class: "tiny subtle tnum" }, String(n)) : null, badge(info.verdict, tone)),
        );
      }),
    ),
  );
}

const PAGE = 60;

export const activityView: View = (root, ctx, { scope }) => {
  let entries: LedgerEntry[] = [];
  let signature = "";
  /** How many rows are drawn: a page at a time, so a long ledger stays light on a phone. */
  let limit = PAGE;
  const filter: LedgerFilter = { classes: new Set(), verdict: "all", query: "" };
  // As tall as a screenful of rows, so nothing below it jumps when they arrive.
  const timeline = h("div", { class: "card" }, skeletonRows(12));
  // Filled once the ledger has answered: on a phone it sits under the timeline, and a card that was
  // there already would jump when the timeline settles to its real height.
  const autonomyBox = h("div");
  const countLabel = h("span", { class: "count-label tnum" });
  const search = h("input", { class: "input", type: "search", placeholder: "Search activity", "aria-label": "Search activity", autocomplete: "off", autocorrect: "off", spellcheck: "false" });

  const counts = () => {
    const byClass = new Map<string, number>();
    const byVerdict = new Map<string, number>();
    for (const e of entries) {
      byClass.set(e.class, (byClass.get(e.class) ?? 0) + 1);
      byVerdict.set(e.verdict, (byVerdict.get(e.verdict) ?? 0) + 1);
    }
    return { byClass, byVerdict };
  };
  const filtering = () => filter.classes.size > 0 || filter.verdict !== "all";

  // The kinds and the verdict: one control that says what's shown.
  const filters = selector({
    label: "Filter activity",
    scope,
    search: false,
    current: () => ({ text: ledgerFilterSummary(filter), icon: "filter", active: filtering() }),
    groups: () => {
      const { byClass, byVerdict } = counts();
      const groups: SelectorGroup[] = [
        {
          id: "class",
          label: "Kind of action",
          mode: "many",
          options: (Object.keys(CLASS_INFO) as ActionClass[]).map((cls) => ({
            value: cls,
            label: CLASS_INFO[cls].label,
            icon: CLASS_INFO[cls].icon,
            meta: `${CLASS_INFO[cls].rule} · ${byClass.get(cls) ?? 0}`,
            selected: filter.classes.has(cls),
          })),
        },
        {
          id: "verdict",
          label: "Verdict",
          options: (["all", "allow", "ask", "deny", "approved"] as const).map((v) => ({
            value: v,
            label: v === "all" ? "Any verdict" : VERDICT_LABEL[v][0]!.toUpperCase() + VERDICT_LABEL[v].slice(1),
            meta: v === "all" ? `${entries.length} in all` : `${byVerdict.get(v) ?? 0}`,
            ...(v === "all" ? {} : { tone: VERDICT_TONE[v] }),
            selected: filter.verdict === v,
          })),
        },
      ];
      if (filtering()) groups.push({ id: "clear", mode: "action", options: [{ value: "clear", label: "Show everything", icon: "x" }] });
      return groups;
    },
    onSelect: (group, option) => {
      if (group === "class") {
        const cls = option.value as ActionClass;
        filter.classes.has(cls) ? filter.classes.delete(cls) : filter.classes.add(cls);
      } else if (group === "verdict") filter.verdict = option.value as Verdict | "all";
      else {
        filter.classes.clear();
        filter.verdict = "all";
      }
      limit = PAGE;
      render();
    },
  });

  function render(): void {
    const list = entries.filter((e) => ledgerMatches(e, filter, deviceName(ctx, e.device)));
    countLabel.textContent = entries.length ? `${list.length} of ${entries.length}` : "";
    filters.refresh();
    if (!entries.length) {
      replace(timeline, empty({ icon: "activity", title: "Nothing recorded yet", body: "When Galahad creates, changes, sends or deletes anything, it is written here with the oath's verdict." }));
      return;
    }
    if (!list.length) {
      replace(
        timeline,
        empty({
          icon: "filter",
          title: "Nothing matches",
          body: filter.query ? "Try fewer words, or search for a node, a quest or a verdict." : undefined,
          actions: button("Show everything", {
            icon: "x",
            onClick: () => {
              filter.classes.clear();
              filter.verdict = "all";
              filter.query = search.value = "";
              render();
            },
          }),
          compact: true,
        }),
      );
      return;
    }
    const nodes: HTMLElement[] = [];
    let day = "";
    for (const entry of list.slice(0, limit)) {
      const ms = hlcMs(entry.hlc) ?? 0;
      if (dayKey(ms) !== day) {
        day = dayKey(ms);
        nodes.push(h("div", { class: "tl-day" }, dayLabel(ms)));
      }
      nodes.push(ledgerItem(ctx, entry));
    }
    const more = list.length - limit;
    // Opened details and keyboard focus stay where they were.
    keepPlace(timeline, () =>
      replace(
        timeline,
        h("div", { class: "timeline" }, ...nodes),
        more > 0
          ? h(
              "div",
              { class: "card-foot centered" },
              button(`Show ${Math.min(more, PAGE)} more`, {
                variant: "ghost",
                icon: "chevron-down",
                label: `Show ${Math.min(more, PAGE)} more (${more} not shown)`,
                onClick: () => {
                  limit += PAGE;
                  render();
                },
              }),
            )
          : null,
      ),
    );
  }

  async function load(): Promise<void> {
    try {
      const { entries: loaded } = await ctx.api.get<{ entries: LedgerEntry[] }>("/api/ledger", scope.signal);
      if (scope.disposed) return;
      const sorted = [...loaded].sort((a, b) => (a.hlc < b.hlc ? 1 : a.hlc > b.hlc ? -1 : 0));
      const next = ledgerSignature(sorted);
      // Nothing new: leave the page exactly as it is.
      if (next === signature) return;
      signature = next;
      entries = sorted;
      replace(autonomyBox, autonomyCard(entries));
      render();
    } catch (error) {
      if (scope.disposed) return;
      signature = "";
      // What Galahad may do alone is worth showing even without the ledger's counts.
      if (!autonomyBox.firstChild) replace(autonomyBox, autonomyCard(null));
      if (isUnavailable(error)) {
        replace(
          timeline,
          empty({
            icon: "scroll",
            title: "The ledger isn't on this node yet",
            body: "It arrives with an upcoming update. Until then, the oath still gates every action; it just isn't shown here.",
          }),
        );
        stop();
      } else if (!entries.length) replace(timeline, errorState("Couldn't read the ledger", error, () => void load()));
      // With entries on screen, a failed refresh keeps them; the shell says the node can't be reached.
    }
  }

  const renderSoon = debounce(() => {
    filter.query = search.value;
    limit = PAGE;
    render();
  }, 120);
  search.addEventListener("input", renderSoon);
  scope.add(() => renderSoon.cancel());

  const bar = h("div", { class: "filter-bar", role: "search" }, h("div", { class: "input-wrap" }, icon("search", { size: 16 }), search), filters.el);
  replace(
    root,
    h(
      "div",
      { class: "page" },
      pageHead("Activity", "Everything Galahad does is written down. Reads are free, creating is logged, outward and destructive actions ask you first."),
      h("div", { class: "two-col" }, h("div", { class: "stack" }, bar, section("Timeline", {}, timeline)), h("div", { class: "stack loose" }, autonomyBox)),
    ),
  );
  root.querySelector(".section-head h2")?.after(countLabel);

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => void load(), 10_000);
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  scope.add(stop);
  void load();
};
