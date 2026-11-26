import type { UsageView } from "@galahad/core";
import { type Price, tokensLabel, usdLabel } from "@galahad/core/spend";
import { type Ctx, errorMessage } from "../context.ts";
import { priceLabel, type PriceRow, priceRows } from "../lib/trial-cost.ts";
import { badge, busy, button, callout, empty, field, section } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/*
 * What models cost, on the Models page: for every model the roster hires (and every
 * one this node called), your price for it and what its calls came to here in the last
 * thirty days. Tokens are counted as the providers report them, always; money only
 * where you've stated a price. Prices are yours to state (dollars per million tokens),
 * shared by every node; nothing here guesses one.
 */

const DAYS = 30;

export function modelCost(ctx: Ctx, signal: AbortSignal): { el: HTMLElement; refresh(roster: Readonly<Record<string, { models: string[] }>>): Promise<void> } {
  const write = ctx.can("brain:write");
  const box = h("div", { class: "card" });
  const note = h("p", { class: "tiny subtle" });
  let roster: Readonly<Record<string, { models: string[] }>> = {};

  function openPrice(row: PriceRow): void {
    const number = (value: number | undefined, label: string) => h("input", { class: "input mono", type: "number", min: "0", step: "any", inputmode: "decimal", value: value === undefined ? "" : String(value), "aria-label": label });
    const input = number(row.inherited ? undefined : row.price?.input, "Dollars per million tokens in");
    const output = number(row.inherited ? undefined : row.price?.output, "Dollars per million tokens out");
    const cached = number(row.inherited ? undefined : row.price?.cached, "Dollars per million cached tokens in");
    const status = h("div");
    const save = button("Save price", { variant: "primary", type: "submit", icon: "check" });
    const own = !!row.price && !row.inherited;
    const form = h(
      "form",
      {
        class: "stack loose",
        onsubmit: (event: Event) => {
          event.preventDefault();
          const values = [input.value, output.value].map((v) => (v.trim() === "" ? NaN : Number(v)));
          const cachedValue = cached.value.trim() === "" ? undefined : Number(cached.value);
          if (values.some((v) => !Number.isFinite(v) || v < 0) || (cachedValue !== undefined && (!Number.isFinite(cachedValue) || cachedValue < 0))) {
            replace(status, callout("warn", "A price is dollars per million tokens, in and out: two numbers, zero or more."));
            return;
          }
          void busy(save, async () => {
            try {
              await ctx.api.post("/api/prices", { model: row.model, input: values[0], output: values[1], ...(cachedValue !== undefined ? { cached: cachedValue } : {}) });
              sheet.close();
              toast(`Price stated for ${row.model}`, { tone: "ok" });
              await refresh(roster);
            } catch (error) {
              replace(status, callout("danger", errorMessage(error)));
            }
          });
        },
      },
      h("div", { class: "fields" }, field("$ per million tokens in", input), field("$ per million tokens out", output)),
      field("$ per million cached tokens in (optional)", cached, { hint: "Where the provider bills what it read from its cache apart. Left empty: the price of input." }),
      row.inherited && row.price ? callout("quiet", `It is priced by its provider's price today (${priceLabel(row.price)}). A price of its own takes its place.`) : null,
      status,
      h(
        "div",
        { class: "row end" },
        own
          ? button("Remove price", {
              icon: "trash",
              onClick: async () => {
                try {
                  await ctx.api.post("/api/prices/remove", { model: row.model });
                  sheet.close();
                  toast(`No price for ${row.model} any more`, { tone: "ok", description: "Its tokens are still counted." });
                  await refresh(roster);
                } catch (error) {
                  replace(status, callout("danger", errorMessage(error)));
                }
              },
            })
          : null,
        button("Cancel", { onClick: () => sheet.close() }),
        save,
      ),
    );
    const sheet = openSheet({ title: `Price of ${row.model}`, description: "US dollars per million tokens, as its provider bills you. Yours to state: nothing guesses it.", body: form });
  }

  function costRow(row: PriceRow): HTMLElement {
    const spent = row.calls
      ? `${tokensLabel(row.tokens)} tokens in ${row.calls} call${row.calls === 1 ? "" : "s"}${row.unknown ? ` (${row.unknown} unreported)` : ""}${row.usd !== null ? ` · ${row.unknown ? "at least " : ""}${usdLabel(row.usd)}` : ""}`
      : "no calls here";
    return h(
      "div",
      { class: "item center" },
      h("span", { class: "avatar" }, icon("models", { size: 14 })),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row wrap" }, h("span", { class: "mono strong small wrap-anywhere" }, row.model), ...row.roles.map((role) => badge(role, "neutral"))),
        h("div", { class: "meta tnum" }, h("span", { class: row.price ? null : "warn-text" }, row.price ? `${priceLabel(row.price)}${row.inherited ? " (its provider's)" : ""}` : "no price: tokens only"), h("span", {}, spent)),
      ),
      write ? h("div", { class: "item-actions" }, button(row.price && !row.inherited ? "Change" : "Set price", { size: "sm", icon: "edit", label: `Set the price of ${row.model}`, onClick: () => openPrice(row) })) : null,
    );
  }

  async function refresh(next: Readonly<Record<string, { models: string[] }>>): Promise<void> {
    roster = next;
    try {
      const [{ prices }, usage] = await Promise.all([
        ctx.api.get<{ prices: Record<string, Price> }>("/api/prices", signal),
        ctx.api.post<UsageView>("/api/usage", { days: DAYS }),
      ]);
      const rows = priceRows(roster, prices, usage.rows);
      replace(box, rows.length ? h("div", { class: "rows" }, ...rows.map(costRow)) : empty({ icon: "models", title: "No models yet", body: "Hire a model for a role, and what it costs shows here.", compact: true }));
      const total = rows.reduce((sum, r) => sum + r.tokens, 0);
      const priced = rows.filter((r) => r.usd !== null);
      replace(
        note,
        `On ${usage.node}, since ${usage.since}: ${tokensLabel(total)} tokens as the providers reported them${priced.length ? `, ${usdLabel(priced.reduce((sum, r) => sum + r.usd!, 0))} at your prices${priced.length < rows.filter((r) => r.calls).length ? " (models without a price not counted)" : ""}` : ""}. Each node counts its own calls; prices are shared by all of them. From a terminal: galahad usage · galahad price set <provider/model> <in> <out>.`,
      );
    } catch {
      // A node that predates the count has neither route: the section says nothing rather than something wrong.
      replace(box, empty({ icon: "models", title: "Costs aren't available on this node yet", body: "They arrive with an update: every model call's tokens, and your prices.", compact: true }));
      replace(note, "");
    }
  }

  return { el: section("What they cost", { count: `the last ${DAYS} days on this node` }, box, note), refresh };
}
