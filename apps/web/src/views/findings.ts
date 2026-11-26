import type { InvestigationView } from "@galahad/core";
import { isUnavailable } from "../api.ts";
import type { Ctx, View } from "../context.ts";
import { absoluteTime, relativeTime } from "../lib/time.ts";
import { findingState, predictionLines } from "../lib/trials.ts";
import { badge, button, callout, copyField, empty, errorState, pageHead, section, skeletonRows, type Tone } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";

/*
 * Findings: what investigations concluded. Each one's pre-registration (the
 * hypothesis, falsifiable predictions, verification and decision rule recorded
 * before anything ran, digest-checked by every replica) beside what was found,
 * the reviewer's judgement of the method, and the evidence kept as an artifact.
 */

const VERDICT: Record<string, { label: string; tone: Tone }> = {
  consistent: { label: "Consistent", tone: "ok" },
  refuted: { label: "Refuted", tone: "danger" },
  undetermined: { label: "Undetermined", tone: "warn" },
};

function openFinding(ctx: Ctx, i: InvestigationView): void {
  const state = findingState(i);
  const r = i.registration;
  const block = (title: string, text: string | null) => (text ? h("div", { class: "stack tight" }, h("h3", { class: "small strong" }, title), h("p", { class: "small wrap-anywhere pre-wrap" }, text)) : null);
  const body = h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row wrap" },
      badge(state.label, state.tone),
      h("span", { class: "small muted" }, `registered ${absoluteTime(i.registeredAt)} on ${i.nodeName}, before anything ran`),
    ),
    r
      ? h(
          "div",
          { class: "stack" },
          block("Hypothesis", r.hypothesis),
          block("Alternative to rule out", r.alternative),
          h(
            "div",
            { class: "stack tight" },
            h("h3", { class: "small strong" }, "Predictions"),
            h(
              "div",
              { class: "rows" },
              ...predictionLines(i).map((p) =>
                h(
                  "div",
                  { class: "item" },
                  h("span", { class: "avatar mono tiny" }, p.id),
                  h(
                    "div",
                    { class: "grow stack tight" },
                    h("span", { class: "small" }, p.statement),
                    h("span", { class: "tiny subtle" }, `Expected ${p.expected}. Refuted if ${p.refutedIf}.`),
                    p.value ? h("span", { class: "small mono tnum" }, p.value) : null,
                  ),
                  p.verdict ? badge(VERDICT[p.verdict]!.label, VERDICT[p.verdict]!.tone) : badge("No result", "neutral"),
                ),
              ),
            ),
          ),
          h(
            "div",
            { class: "stack tight" },
            h("h3", { class: "small strong" }, "How the instruments were checked"),
            h("ul", { class: "plain-list small" }, ...r.verification.map((v) => h("li", {}, v))),
          ),
          block("Decision rule", r.decision),
        )
      : callout("quiet", "This registration was written by a newer node; update this one to read it."),
    block("What was found", i.summary),
    block("The reviewer, on the method", i.review),
    i.artifact
      ? h(
          "div",
          { class: "row end" },
          button("Open the evidence", {
            icon: "archive",
            onClick: () => {
              sheet.close();
              ctx.navigate("artifacts", { intent: i.artifact! });
            },
          }),
        )
      : null,
  );
  const sheet = openSheet({ title: i.question, description: i.id, body });
}

export const findingsView: View = (root, ctx, { scope, opts }) => {
  const box = h("div", { class: "card" }, skeletonRows(4, { avatar: true }));
  let opened = false;

  function row(i: InvestigationView): HTMLElement {
    const state = findingState(i);
    const lines = predictionLines(i);
    return h(
      "button",
      { class: "item item-button", type: "button", "data-key": i.id, "aria-label": `${i.question}: ${state.label}`, onclick: () => openFinding(ctx, i) },
      h("span", { class: "avatar" }, icon("flask", { size: 14 })),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "row wrap" }, h("span", { class: "strong small" }, i.question), badge(state.label, state.tone)),
        h(
          "div",
          { class: "meta tnum" },
          h("span", { title: absoluteTime(i.registeredAt) }, relativeTime(i.registeredAt)),
          lines.length ? h("span", {}, `${lines.filter((p) => p.verdict === "consistent").length} of ${lines.length} predictions held`) : null,
          h("span", {}, `on ${i.nodeName}`),
        ),
      ),
      icon("chevron-right", { size: 16, class: "subtle" }),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const { investigations } = await ctx.api.get<{ investigations: InvestigationView[] }>("/api/investigations", scope.signal);
      if (scope.disposed) return;
      keepPlace(box, () =>
        replace(
          box,
          investigations.length
            ? h("div", { class: "rows" }, ...investigations.map(row))
            : empty({
                icon: "flask",
                title: "No findings yet",
                body: h(
                  "div",
                  { class: "stack tight" },
                  h("p", {}, "Ask a scientific question from a terminal on a node. The hypothesis and its predictions are recorded before anything runs; the experiment runs in the Lab; an independent reviewer judges the method."),
                  copyField('galahad investigate "<question>"'),
                ),
              }),
        ),
      );
      if (!opened && opts.intent) {
        opened = true;
        const wanted = investigations.find((i) => i.id === opts.intent);
        if (wanted) openFinding(ctx, wanted);
      }
    } catch (error) {
      if (scope.disposed) return;
      replace(
        box,
        isUnavailable(error)
          ? empty({ icon: "flask", title: "Findings aren't available on this node yet", body: "They arrive with an update.", compact: true })
          : errorState("Couldn't load findings", error, () => void refresh()),
      );
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead(
        "Findings",
        "What investigations concluded: supported, refuted or inconclusive. Each one's hypothesis and predictions were recorded before anything ran, so they can't have moved to fit the results.",
      ),
      section("Investigations", {}, box),
    ),
  );
  scope.interval(() => void refresh(), 30_000);
  void refresh();
};
