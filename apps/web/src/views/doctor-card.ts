import type { DoctorCheck, DoctorReport } from "@galahad/core/doctor";
import { isUnavailable } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { checkLine, doctorCard, readDoctorReport, STATE_LABEL, stateTone } from "../lib/doctor.ts";
import { relativeTime } from "../lib/time.ts";
import { badge, busy, button, dot, section, skeletonRows } from "../ui/controls.ts";
import { h, keepPlace, replace, type Scope } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";

/*
 * The doctor, on the Overview: is everything well on the node you're talking to?
 * It opens with a quick look (what costs nothing to check), says the verdict in a
 * line, lists what needs you with what to do, and keeps every other line one click
 * away. A full check is yours to ask for: it asks each role's model one word and
 * starts a sandbox, so it isn't done just because the page was opened.
 */

function attentionRow(check: DoctorCheck): HTMLElement {
  return h(
    "li",
    { class: "doctor-item", "data-state": check.state },
    h("div", { class: "doctor-item-head" }, badge(STATE_LABEL[check.state], stateTone(check.state)), h("span", { class: "doctor-line" }, checkLine(check))),
    check.fix ? h("div", { class: "doctor-fix" }, icon("chevron-right", { size: 13 }), h("span", {}, check.fix)) : null,
  );
}

/** How many things to attend to are shown before the rest fold away. */
const ATTENTION_AT_A_GLANCE = 3;

/** A line in the whole list: its state as a dot, and what was found (what to do is said once, above). */
function plainRow(check: DoctorCheck): HTMLElement {
  const tone = stateTone(check.state);
  return h("li", { class: "doctor-row", "data-state": check.state }, dot(tone === "neutral" ? null : tone, { label: STATE_LABEL[check.state] }), h("div", { class: "doctor-row-text" }, h("span", {}, checkLine(check))));
}

export function doctorSection(ctx: Ctx, scope: Scope): HTMLElement | null {
  // The doctor is the owner's to ask (fleet:admin): a device paired without it shows no card.
  if (!ctx.can("fleet:admin")) return null;
  const body = h("div", { class: "card doctor" }, skeletonRows(3));
  const el = section("Doctor", {}, body);
  let report: DoctorReport | null = null;
  let open = false;
  let more = false;
  let failed: string | null = null;
  let working: "quick" | "full" | null = null;

  const again = button("Look again", { size: "sm", variant: "ghost", icon: "refresh", onClick: () => void busy(again, () => run({ quick: true })) });
  const full = button("Full check", { size: "sm", icon: "activity", onClick: () => void busy(full, () => run({})) });

  function render(): void {
    if (!report) {
      replace(
        body,
        failed
          ? h("div", { class: "doctor-head" }, dot("warn"), h("div", { class: "grow" }, h("div", { class: "strong small" }, "The doctor couldn't look"), h("div", { class: "tiny subtle" }, failed)), again)
          : skeletonRows(3),
      );
      return;
    }
    const view = doctorCard(report);
    const all = report.checks.length;
    // The worst three at a glance; the rest one click away, so a node with much to mend doesn't bury the page.
    const first = view.attention.slice(0, ATTENTION_AT_A_GLANCE);
    const rest = view.attention.slice(ATTENTION_AT_A_GLANCE);
    keepPlace(body, () =>
      replace(
        body,
        h(
          "div",
          { class: "doctor-head" },
          dot(view.tone === "neutral" ? null : view.tone, { live: view.tone !== "ok" }),
          h("div", { class: "grow" }, h("div", { class: "strong small", role: "status" }, view.headline), h("div", { class: "tiny subtle" }, `${view.how}, ${relativeTime(report!.at)}`)),
        ),
        failed ? h("div", { class: "doctor-note error", role: "alert" }, failed) : null,
        first.length ? h("ul", { class: "doctor-list" }, ...first.map(attentionRow)) : null,
        rest.length
          ? h(
              "details",
              { class: "doctor-more", open: more, ontoggle: (event: Event) => (more = (event.currentTarget as HTMLDetailsElement).open) },
              h("summary", { class: "tiny" }, `${rest.length} more ${rest.length === 1 ? "thing needs" : "things need"} a look`),
              h("ul", { class: "doctor-list" }, ...rest.map(attentionRow)),
            )
          : null,
        h(
          "details",
          { class: "doctor-all", open, ontoggle: (event: Event) => (open = (event.currentTarget as HTMLDetailsElement).open) },
          h("summary", { class: "tiny" }, `All ${all} ${all === 1 ? "line" : "lines"}`),
          ...view.groups.map((group) => h("div", { class: "doctor-group" }, h("div", { class: "label" }, group.title), h("ul", { class: "doctor-rows" }, ...group.checks.map(plainRow)))),
        ),
        h(
          "div",
          { class: "doctor-foot" },
          h(
            "p",
            { class: "tiny subtle grow" },
            working === "full"
              ? "Asking each role's model one word, starting a sandbox and removing it. Up to a minute."
              : report!.quick
                ? "A quick look costs nothing. A full check also asks each role's model one word, starts a sandbox and removes it, and asks each connector's service to answer. Neither changes anything."
                : "It changed nothing: the sandbox it started is gone, and it's in the ledger like every sandbox.",
          ),
          h("div", { class: "row" }, again, full),
        ),
      ),
    );
  }

  async function run(input: { quick?: boolean }): Promise<void> {
    working = input.quick ? "quick" : "full";
    failed = null;
    if (report) render();
    try {
      const answer = readDoctorReport(await ctx.api.post<unknown>("/api/doctor", input, scope.signal));
      if (scope.disposed) return;
      if (!answer) throw new Error("The node's answer wasn't a report.");
      report = answer;
    } catch (error) {
      if (scope.disposed) return;
      // A node from before the doctor: nothing to show here yet.
      if (isUnavailable(error)) {
        el.hidden = true;
        return;
      }
      failed = errorMessage(error);
    } finally {
      working = null;
    }
    if (!scope.disposed) render();
  }

  // Its last quick look this session, at once (api.peek), while it looks again.
  const last = readDoctorReport(ctx.api.peek<unknown>("/api/doctor", { quick: true }));
  if (last) {
    report = last;
    render();
  }
  void run({ quick: true });
  return el;
}
