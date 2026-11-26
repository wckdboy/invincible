import type { UsageMeter } from "@galahad/core";
import { tokensLabel, usdLabel } from "@galahad/core/spend";
import { type Ctx, errorMessage } from "../context.ts";
import { spentWindowLines } from "../lib/usage-windows.ts";
import { button, callout, meter, segmented, statTile } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";

/*
 * The usage meter (GET /api/usage/meter; the Apple apps' UsageMeterView, the terminal's `galahad usage`): this
 * period's model calls on the node at your prices against your budget, as a tile with a bar that stands still. Opened,
 * what they came to, what cost most, and the budget to set (a line to watch, never a stop).
 */

const period = (m: UsageMeter) => (m.per === "day" ? "Today" : "This month");
/** "at least" where some calls had no price or reported nothing (never of $0: nothing priced is simply $0). */
const spentWords = (m: UsageMeter) => `${m.complete || m.spentUsd === 0 ? "" : "at least "}${usdLabel(m.spentUsd)}`;

/** The meter in words, against the budget (or how much, with none). */
export function meterWords(m: UsageMeter): string {
  if (m.budgetUsd === null) return `${tokensLabel(m.tokens)} tokens, no budget`;
  return m.leftUsd ? `of ${usdLabel(m.budgetUsd)} · ${usdLabel(m.leftUsd)} left` : `of ${usdLabel(m.budgetUsd)} · spent`;
}

/** The tile: the period's spend, against the budget with a bar; a tap opens the sheet. */
/**
 * The place a usage tile's bar takes, kept with no budget to fill it (and while the meter loads): a tile whose bar came
 * in when it answered grew its row of tiles, and moved everything under it (the PWA's layout bench, 22 November 2026).
 */
export function meterSlot(): HTMLElement {
  const slot = meter(0);
  slot.style.visibility = "hidden";
  slot.setAttribute("aria-hidden", "true");
  return slot;
}

export function usageTile(ctx: Ctx, m: UsageMeter, changed: (m: UsageMeter) => void): HTMLElement {
  const spent = m.budgetUsd !== null && !m.leftUsd;
  const tile = statTile({
    label: `${period(m)}'s usage`,
    icon: "gauge",
    value: spentWords(m),
    note: [meterWords(m), m.budgetUsd ? meter(m.spentUsd / m.budgetUsd, spent ? "var(--danger)" : undefined, `${Math.round((m.spentUsd / m.budgetUsd) * 100)}% of the budget`) : meterSlot(), ...spentWindowLines(m.windows)],
  });
  tile.classList.add("usage-tile");
  tile.setAttribute("role", "button");
  tile.tabIndex = 0;
  const open = () => openUsage(ctx, m, changed);
  tile.addEventListener("click", open);
  tile.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  return tile;
}

export function openUsage(ctx: Ctx, m: UsageMeter, changed: (m: UsageMeter) => void): void {
  const canSet = ctx.can("brain:write");
  let chosen: "day" | "month" = m.per;
  const per = segmented<"day" | "month">([{ value: "day", label: "Day" }, { value: "month", label: "Month" }], m.per, (value) => void (chosen = value), { label: "Per" });
  const amount = h("input", { class: "input tnum", inputmode: "decimal", maxlength: 10, placeholder: "No budget", autocomplete: "off", value: m.budgetUsd === null ? "" : String(m.budgetUsd) });
  const problem = h("div");
  const top = m.top.length
    ? h("div", { class: "card flat" }, h("div", { class: "rows" }, ...m.top.map((t) => h("div", { class: "item center" }, h("span", { class: "grow mono small ellipsis" }, t.model), h("span", { class: "tnum small muted" }, t.usd === null ? `${tokensLabel(t.tokens)} tokens` : usdLabel(t.usd))))))
    : null;
  const save = canSet
    ? button("Save budget", {
        variant: "primary",
        onClick: async () => {
          const typed = amount.value.trim().replace(/^\$/, "").replace(",", ".");
          const usd = typed ? Number(typed) : null;
          if (usd !== null && !(Number.isFinite(usd) && usd > 0 && usd <= 100_000)) return void replace(problem, callout("warn", "A budget is an amount in US dollars above 0, like 25, or empty for none."));
          try {
            const next = await ctx.api.post<UsageMeter>("/api/usage/budget", { usd, per: chosen });
            changed(next);
            sheet.close();
            toast(usd === null ? "No budget" : `Budget: ${usdLabel(usd)} a ${next.per}`, { tone: "ok" });
          } catch (error) {
            replace(problem, callout("danger", errorMessage(error)));
          }
        },
      })
    : null;
  const sheet = openSheet({
    title: "Usage",
    description: `Since ${m.since} (UTC), on this node, at the prices you've set.`,
    body: h(
      "div",
      { class: "stack loose" },
      h(
        "div",
        { class: "stack" },
        h("div", { class: "stat-value" }, spentWords(m)),
        h("p", { class: "small muted" }, `${period(m).toLowerCase()}: ${meterWords(m)} · ${tokensLabel(m.tokens)} tokens in ${m.calls} call${m.calls === 1 ? "" : "s"}`),
        m.budgetUsd ? meter(m.spentUsd / m.budgetUsd, m.leftUsd ? undefined : "var(--danger)") : null,
      ),
      top ? h("div", { class: "stack" }, h("strong", { class: "small" }, "What cost most"), top) : null,
      m.windows?.length
        ? h("div", { class: "stack" }, h("strong", { class: "small" }, "Passed over until their allowance resets"), h("div", { class: "stack" }, ...spentWindowLines(m.windows).map((line) => h("p", { class: "small muted" }, line))))
        : null,
      m.unpriced.length ? h("p", { class: "tiny subtle" }, `No price for ${m.unpriced.join(", ")}: ${m.unpriced.length === 1 ? "its" : "their"} tokens aren't in this. Set one under Models.`) : null,
      canSet
        ? h(
            "div",
            { class: "stack" },
            h("strong", { class: "small" }, "Your budget"),
            h("div", { class: "row wrap" }, per.el, amount),
            h("p", { class: "tiny subtle" }, "A line to watch, never a stop: work goes on past it. A task's own budget is what stops a task."),
            problem,
          )
        : null,
    ),
    footer: save,
  });
}
