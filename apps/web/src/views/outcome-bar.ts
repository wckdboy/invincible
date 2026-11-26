import type { TeamOutcome } from "@galahad/core";
import { type Ctx, errorMessage } from "../context.ts";
import { badge, busy, button, callout, field, type Tone } from "../ui/controls.ts";
import { confirmAction, openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { toast } from "../ui/toast.ts";

/*
 * The bar over an outcome's room (PLAN #43): Galahad owns it; where it stands (its spend against its budget, its tasks),
 * the first line of his plan, and yours to pause, resume, stop or give more budget (one that spent what it may goes on).
 * The room below is where he reports and asks.
 */

const STATUS: Record<TeamOutcome["status"], { label: string; tone: Tone }> = {
  active: { label: "He's working it", tone: "info" },
  paused: { label: "Paused", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  stopped: { label: "Stopped", tone: "neutral" },
  spent: { label: "Budget spent", tone: "warn" },
};

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
/** An amount to the cent, where one is set or told (a budget of $7.50 isn't $8). */
const usd_ = (n: number) => `$${n.toFixed(2)}`;

/** Whether a room is an outcome's (its id is the outcome's). */
export const isOutcomeRoom = (room: string): boolean => /^out-[a-z0-9_-]{12}$/.test(room);

export function outcomeBar(ctx: Ctx, room: string, signal: AbortSignal): { el: HTMLElement; refresh: () => Promise<void> } {
  const el = h("div", { class: "team-notice outcome-bar", role: "status", hidden: true });
  let shown = "";
  let asked = 0;
  async function refresh(): Promise<void> {
    // The room reloads every few seconds; what an outcome stands at changes slower: asked at most every 15 s.
    if (Date.now() - asked < 15_000) return;
    asked = Date.now();
    try {
      const { outcomes } = await ctx.api.get<{ outcomes: TeamOutcome[] }>("/api/team/outcomes", signal);
      const outcome = outcomes.find((o) => o.room === room);
      if (!outcome) return void (el.hidden = true);
      const version = JSON.stringify([outcome.status, outcome.spentUsd, outcome.committedUsd, outcome.tasks, outcome.notes.slice(0, 200), outcome.ended]);
      if (version === shown) return;
      shown = version;
      draw(outcome);
    } catch {
      // (The room itself still shows; the bar waits for the next look.)
    }
  }
  function draw(outcome: TeamOutcome): void {
    const st = STATUS[outcome.status];
    const left = Math.max(0, outcome.budgetUsd - outcome.spentUsd - outcome.committedUsd);
    const admin = ctx.can("fleet:admin");
    const control = (action: "pause" | "resume" | "stop", label: string) =>
      button(label, {
        size: "sm",
        variant: action === "stop" ? "ghost" : "default",
        onClick: async (event) => {
          if (action === "stop" && !(await confirmAction({ title: `Stop ${outcome.title}?`, body: "Its waiting work is stopped, and it ends. Its room and what it did stay.", confirmLabel: "Stop it" }))) return;
          await busy(event.currentTarget as HTMLButtonElement, async () => {
            try {
              const { outcome: next } = await ctx.api.post<{ outcome: TeamOutcome }>("/api/team/outcomes/control", { id: outcome.id, action });
              shown = "";
              draw(next);
            } catch (error) {
              toast(`Couldn't ${action} it`, { tone: "error", description: errorMessage(error) });
            }
          });
        },
      });
    const open = outcome.status === "active" || outcome.status === "paused";
    // Its budget, set anew: a new total, never below what it has spent and holds; one that had spent what it may goes on.
    const budget = button("Budget…", {
      size: "sm",
      variant: outcome.status === "spent" ? "primary" : "ghost",
      onClick: () => {
        const floor = outcome.spentUsd + outcome.committedUsd;
        const amount = h("input", { class: "input tnum", inputmode: "decimal", maxlength: 10, autocomplete: "off", value: String(Math.ceil((outcome.budgetUsd + (outcome.status === "spent" ? 2 : 0)) * 100) / 100) });
        const problem = h("div");
        const save = button("Set budget", {
          variant: "primary",
          onClick: async (event) => {
            const usd = Number(amount.value.trim().replace(/^\$/, "").replace(",", "."));
            if (!Number.isFinite(usd) || usd < Math.max(0.5, floor)) return void replace(problem, callout("warn", `A budget in US dollars of at least ${usd_(Math.max(0.5, floor))}: what it has spent and holds.`));
            await busy(event.currentTarget as HTMLButtonElement, async () => {
              try {
                const { outcome: next } = await ctx.api.post<{ outcome: TeamOutcome }>("/api/team/outcomes/control", { id: outcome.id, action: "budget", budgetUsd: usd });
                sheet.close();
                shown = "";
                draw(next);
                toast(`Its budget is ${usd_(usd)}`, { tone: "ok" });
              } catch (error) {
                replace(problem, callout("danger", errorMessage(error)));
              }
            });
          },
        });
        const sheet = openSheet({
          title: `Budget for ${outcome.title}`,
          description: `Spent ${usd_(outcome.spentUsd)}${outcome.committedUsd ? `, ${usd_(outcome.committedUsd)} held for waiting work` : ""}, of ${usd_(outcome.budgetUsd)}.${outcome.status === "spent" ? " It had spent what it may: a larger budget and he takes it up again." : ""}`,
          body: [field("Its budget, in all (US dollars)", amount), problem],
          footer: save,
        });
      },
    });
    replace(
      el,
      h(
        "div",
        { class: "grow stack snug" },
        h("div", { class: "row wrap" }, h("strong", {}, "Galahad owns this outcome"), badge(st.label, st.tone)),
        h(
          "span",
          { class: "small muted tnum" },
          `Spent ${usd(outcome.spentUsd)} of ${usd(outcome.budgetUsd)}${outcome.committedUsd ? `, ${usd(outcome.committedUsd)} held for waiting work` : ""}, ${usd(left)} left · ${outcome.tasks.done} done and verified, ${outcome.tasks.running} running, ${outcome.tasks.queued} waiting${outcome.tasks.failed ? `, ${outcome.tasks.failed} not done` : ""}`,
        ),
        outcome.notes ? h("span", { class: "small ellipsis", title: outcome.notes }, `Plan: ${outcome.notes.split("\n")[0]}`) : null,
        outcome.ended ? h("span", { class: "small muted" }, outcome.ended) : null,
      ),
      admin && (open || outcome.status === "spent") ? h("div", { class: "row" }, open ? (outcome.status === "active" ? control("pause", "Pause") : control("resume", "Resume")) : null, budget, open ? control("stop", "Stop") : null) : null,
    );
    el.hidden = false;
  }
  return { el, refresh };
}
