import type { Calibration, ComputeLimit, ComputeNodeView, ComputeView, EffortAsk, NodeCapacity } from "@galahad/core";
import { type Ctx, errorMessage } from "../context.ts";
import { attemptLine, budgetText, ceilingChange, ceilingOwner, ceilingText, effortText, fleetSlots, limitRanges, measuredFacts, modelCallsText, slotsText, strengthText } from "../lib/compute.ts";
import { plural } from "../lib/text.ts";
import { relativeTime } from "../lib/time.ts";
import { badge, busy, button, callout, empty, rangeControl, segmented, statTile, switchControl } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { type Child, h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/*
 * Compute on the Fleet page: what each node measured, the ceiling he may not pass
 * and whose it is, its slots in use and what waits for one; the quests in hand with
 * their effort and parallel attempts; what more compute would buy. He uses the
 * machines you enrolled and acquires none: there is nothing here to buy or rent.
 */

/** Slots as pips (a few) or a count (many): filled ones are in use. */
function pips(used: number, total: number): HTMLElement | null {
  if (total <= 0 || total > 16) return null;
  return h("span", { class: "pips", "aria-hidden": "true" }, ...Array.from({ length: total }, (_, i) => h("span", { class: i < used ? "on" : "" })));
}

const row = (label: string, value: Child, action: Child = null): HTMLElement => h("div", { class: "cap-row" }, h("div", { class: "cap-label" }, label), h("div", { class: "cap-value" }, value), action ? h("div", { class: "cap-action" }, action) : null);

/** A node's capacity, inside its card. `changed`: after a calibration or a new ceiling, read the census again. */
export function capacityBlock(ctx: Ctx, node: ComputeNodeView, changed: () => void): HTMLElement {
  const admin = ctx.can("fleet:admin");
  const mayMeasure = ctx.can("brain:write") && node.online;
  const slots = slotsText(node);
  const measure = mayMeasure
    ? button(node.calibration ? "Measure again" : "Measure", { size: "sm", variant: "ghost", icon: "gauge", label: `Measure ${node.name}${node.calibration ? " again" : ""}` })
    : null;
  measure?.addEventListener("click", () =>
    void busy(measure, async () => {
      try {
        const done = await ctx.api.post<{ node: string; calibration: Calibration; capacity: NodeCapacity }>("/api/compute/calibrate", { on: node.id });
        toast(`${done.node} measured itself`, { tone: "ok", description: `He counts ${plural(done.capacity.cores, "thread")} and ${done.capacity.memoryGb} GB: ${plural(done.capacity.sandboxes, "sandbox slot")}.` });
        changed();
      } catch (error) {
        toast(`Couldn't measure ${node.name}`, { tone: "error", description: errorMessage(error) });
      }
    }),
  );
  const facts = node.calibration ? measuredFacts(node.calibration, node) : [];
  const ceiling = admin && node.body ? button("Set ceiling", { size: "sm", variant: "ghost", icon: "settings", label: `Set ${node.name}'s ceiling`, onClick: () => openCeiling(ctx, node, changed) }) : null;
  return h(
    "div",
    { class: "capacity", "aria-label": `${node.name}'s capacity` },
    row(
      "Strength",
      h(
        "div",
        { class: "row wrap" },
        h("span", { class: "strong" }, strengthText(node)),
        node.calibration ? h("span", { class: "tiny subtle" }, `measured ${relativeTime(node.calibration.at)}`) : null,
        // Its body, its ceiling or the benchmark changed since: it measures itself again shortly.
        node.due === "changed" ? badge("measuring again", "warn") : null,
      ),
      measure,
    ),
    // Everything it measured, the full width of the card.
    facts.length ? h("div", { class: "chips cap-facts" }, ...facts.map((f) => h("span", { class: "chip", title: f.title }, h("span", { class: "subtle" }, f.label), f.value))) : null,
    node.calibration?.note ? h("div", { class: "tiny subtle" }, node.calibration.note) : null,
    row("Ceiling", h("div", { class: "stack snug" }, h("span", { class: "tnum" }, ceilingText(node)), h("span", { class: "tiny subtle" }, ceilingOwner(node))), ceiling),
    row(
      "Slots",
      h(
        "div",
        { class: "stack snug" },
        h(
          "div",
          { class: "row wrap" },
          node.use && node.capacity ? pips(node.use.sandboxes, node.capacity.sandboxes) : null,
          h("span", { class: "tnum" }, slots.text),
          slots.waiting ? badge(`${slots.waiting} waiting`, "warn", "clock") : null,
        ),
        node.capacity ? h("span", { class: "tiny subtle tnum" }, modelCallsText(node)) : null,
        ...node.queue.map((q) => h("div", { class: "tiny subtle" }, h("span", { class: "mono" }, q.quest), ` waits (${q.cpus} threads, ${q.memoryGb} GB): ${q.why}`)),
      ),
    ),
    node.capacity?.reasons.length
      ? h("details", {}, h("summary", {}, "Why these numbers"), h("ul", {}, ...node.capacity.reasons.map((reason) => h("li", {}, reason))))
      : null,
  );
}

/** The ceiling for one node: threads and memory he may use there, sandboxes and model calls at once. Yours alone. */
function openCeiling(ctx: Ctx, node: ComputeNodeView, changed: () => void): void {
  const body = node.body!;
  const ranges = limitRanges(body);
  const limit: ComputeLimit = node.limit ?? {};
  const halfCores = Math.max(1, Math.floor(body.cores / 2));
  const halfMemory = Math.max(1, Math.floor(body.memoryGb / 2));
  const cores = rangeControl({
    label: "Threads he may use at once",
    ...ranges.cores,
    value: limit.cores ?? halfCores,
    format: (v) => `${v} of ${body.cores}`,
    scale: ["1", `all ${body.cores}`],
  });
  const memory = rangeControl({
    label: "Memory he may use",
    ...ranges.memory,
    value: Math.min(ranges.memory.max, Math.round(limit.memoryGb ?? halfMemory)),
    format: (v) => `${v} of ${Math.round(body.memoryGb)} GB`,
    scale: ["1 GB", `${Math.round(body.memoryGb)} GB`],
  });
  let sandboxesOn = limit.sandboxes !== 0;
  const opened = { cores: limit.cores ?? halfCores, memoryGb: Math.min(ranges.memory.max, Math.round(limit.memoryGb ?? halfMemory)) };
  const note = h("div");
  const save = button("Set ceiling", { variant: "primary", icon: "check" });
  const reset = button("Back to the default", { variant: "ghost", icon: "undo" });
  const sheet = openSheet({
    title: `${node.name}'s ceiling`,
    description: "What he may use of this machine, at most. He measures what it delivers within it and never goes past it.",
    body: h(
      "div",
      { class: "stack loose" },
      callout(
        "info",
        `By default he uses half of a machine (${halfCores} of ${body.cores} threads, ${halfMemory} of ${Math.round(body.memoryGb)} GB) and leaves the rest to whatever else runs there. Whatever you set, a tenth of its threads stays the host's while other work wants it, and work that doesn't fit waits.`,
        { icon: "shield" },
      ),
      cores.el,
      memory.el,
      body.sandboxHost ? switchControl("Sandboxes on this node", sandboxesOn, (on) => (sandboxesOn = on), { hint: "Off: quests and trials go to other nodes." }) : null,
      note,
    ),
    footer: h("div", { class: "row between grow" }, reset, save),
  });
  const send = async (payload: Record<string, unknown>, said: string): Promise<void> => {
    try {
      await ctx.api.post("/api/compute/limit", { node: node.id, ...payload });
      toast(said, { tone: "ok", description: "It measures itself again for the new ceiling." });
      sheet.close();
      changed();
    } catch (error) {
      replace(note, callout("danger", errorMessage(error), { title: "Couldn't set the ceiling" }));
    }
  };
  save.addEventListener("click", () =>
    void busy(save, () => send(ceilingChange(node.limit, opened, { cores: cores.value(), memoryGb: memory.value(), sandboxes: !body.sandboxHost || sandboxesOn }), `${node.name}: ${cores.value()} threads, ${memory.value()} GB at most`)),
  );
  reset.addEventListener("click", () => void busy(reset, () => send({ reset: true }, `${node.name} is back to the default ceiling`)));
}

/** The fleet's slots, as a stat tile beside the others. */
export function slotsTile(view: ComputeView): HTMLElement {
  const total = fleetSlots(view);
  return statTile({
    label: "Sandbox slots",
    icon: "gauge",
    value: [String(total.inUse), h("span", { class: "of" }, ` / ${total.slots}`)],
    note: total.waiting ? `${total.waiting} waiting for a slot` : total.slots ? `${plural(total.free, "slot")} free now` : "no sandbox host yet",
  });
}

/** How he spends compute on a quest: the level auto may reach and the day's budget. Yours to set. */
function openEffort(ctx: Ctx, view: ComputeView, changed: () => void): void {
  let effort: EffortAsk = view.policy.effort;
  const budget = rangeControl({ label: "Extra attempts a day", min: 0, max: 60, step: 1, value: Math.min(60, view.policy.attemptsPerDay), format: (v) => (v ? String(v) : "none"), scale: ["none", "60"] });
  const levels = segmented(
    [
      { value: "auto", label: "Auto" },
      { value: "1", label: "1" },
      { value: "2", label: "2" },
      { value: "3", label: "3" },
    ],
    String(effort),
    (value) => (effort = value === "auto" ? "auto" : (Number(value) as 1 | 2 | 3)),
    { label: "Attempts at a quest when he chooses", block: true },
  );
  const note = h("div");
  const save = button("Save", { variant: "primary", icon: "check" });
  const sheet = openSheet({
    title: "Effort",
    description: "More attempts at a quest spend more compute and more model calls for a better answer.",
    body: h(
      "div",
      { class: "stack loose" },
      h("div", { class: "stack tight" }, h("div", { class: "label" }, "Attempts at a quest when he chooses"), levels.el, h("p", { class: "tiny subtle" }, "Auto takes what the free slots allow, up to 3. Each attempt works in its own sandbox and is reviewed; the independent reviewer takes the best on the evidence alone.")),
      budget.el,
      h("p", { class: "tiny subtle" }, "Each attempt beyond a quest's first counts against the day's budget. A level you name yourself (galahad do --effort 3) stands whatever the budget."),
      note,
    ),
    footer: save,
  });
  save.addEventListener("click", () =>
    void busy(save, async () => {
      try {
        await ctx.api.post("/api/compute/policy", { effort, attemptsPerDay: budget.value() });
        toast("Effort saved", { tone: "ok" });
        sheet.close();
        changed();
      } catch (error) {
        replace(note, callout("danger", errorMessage(error), { title: "Couldn't save it" }));
      }
    }),
  );
}

/** The Compute section: effort and the budget, quests in hand with their attempts, what more would buy, what he suggests. */
export function computeBody(ctx: Ctx, view: ComputeView, changed: () => void): HTMLElement {
  const total = fleetSlots(view);
  const mayPolicy = ctx.can("brain:write");
  const policy = h(
    "div",
    { class: "card pad" },
    h(
      "div",
      { class: "row wrap between" },
      h(
        "div",
        { class: "stack snug" },
        h("div", { class: "row wrap" }, h("span", { class: "strong" }, "Effort"), h("span", {}, effortText(view)), badge(`budget: ${budgetText(view.budget)}`, view.budget.usedToday >= view.budget.perDay ? "warn" : "neutral")),
        h("div", { class: "tiny subtle" }, "Several attempts at a quest in parallel sandboxes, each reviewed, the best taken by the independent reviewer on the evidence alone."),
      ),
      mayPolicy ? button("Change", { size: "sm", icon: "settings", label: "Change effort and the budget", onClick: () => openEffort(ctx, view, changed) }) : null,
    ),
  );
  const work = view.work.length
    ? h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "rows" },
          ...view.work.map((w) =>
            h(
              "div",
              { class: "item" },
              h("span", { class: "avatar" }, icon("compass", { size: 16 })),
              h(
                "div",
                { class: "grow" },
                h("div", { class: "row wrap" }, h("span", { class: "strong small" }, w.label || w.quest), badge(`effort ${w.effort}${w.asked === "auto" ? " · auto" : ""}`, "accent"), h("span", { class: "tiny subtle" }, plural(w.attempts.length, "attempt"), " at work")),
                h("div", { class: "work-attempts" }, ...w.attempts.map((a) => h("div", { class: "tiny" }, h("span", { class: a.active ? "" : "subtle" }, attemptLine(a)), a.model ? h("span", { class: "subtle mono" }, ` · ${a.model}`) : null))),
                h("div", { class: "meta" }, h("span", { class: "mono" }, w.quest), h("span", {}, `asked by ${w.by}`), h("span", {}, `started ${relativeTime(w.since)}`), ...w.reasons.slice(0, 2).map((reason) => h("span", {}, reason))),
              ),
            ),
          ),
        ),
      )
    : h("div", { class: "card" }, empty({ icon: "compass", title: "No quests in hand", body: total.slots ? "A quest with effort shows here, with each of its attempts and where it is." : "A quest needs a sandbox host: a machine with Docker.", compact: true }));
  return h(
    "div",
    { class: "stack loose" },
    policy,
    work,
    view.more.length
      ? h("div", { class: "card pad stack tight" }, h("h3", {}, "What more compute would buy"), h("ul", { class: "plain-list small" }, ...view.more.map((line) => h("li", {}, line))), h("p", { class: "tiny subtle" }, "He uses the machines you enroll and never acquires any: nothing here rents, buys or signs up for anything."))
      : null,
    ...view.suggestions.map((s) => callout("quiet", s.body, { title: s.title, icon: "lightbulb" })),
    view.adapted?.changes.length ? h("p", { class: "tiny subtle" }, `His defaults were last re-derived ${relativeTime(view.adapted.at)}: ${view.adapted.changes.join(" ")}`) : null,
  );
}
