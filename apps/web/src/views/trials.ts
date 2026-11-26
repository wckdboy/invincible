import type { TrialRunsView, TrialView } from "@galahad/core";
import { effortReport } from "@galahad/core/galahad-index";
import { type Price, tokensLabel, usdLabel } from "@galahad/core/spend";
import { type Comparison, doneLine, doneReport, modelReport, type ModelRow, reviewerReport, type ReviewerRow, type RoleReport, variantReport } from "@galahad/core/trial-reports";
import { isUnavailable } from "../api.ts";
import type { Ctx, View } from "../context.ts";
import { plural } from "../lib/text.ts";
import { absoluteTime, relativeTime } from "../lib/time.ts";
import { checkLabel, heldLabels, isCheck, runCost, spentLine } from "../lib/trial-cost.ts";
import { byProblem, durationLabel, groupRuns, type Mark, markOf, numberLabel, offBy, percent, type RunSummary } from "../lib/trials.ts";
import { badge, button, callout, copyField, empty, errorState, meter, pageHead, section, segmented, skeletonBlock, skeletonRows, statTile, type Tone } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";

/*
 * Trials: is Galahad getting better? Problems posed from a seed, worked as ordinary
 * quests, and graded by a program on the node, never by a model. Four suites:
 * engineering (exact answers, in the Lab), agentic (real work in a small repository,
 * graded by hidden tests in a fresh sandbox), reviewer (a quest's evidence with a
 * known answer, put to the reviewer) and yours (your knights' tasks that passed review,
 * worked again and graded by their own gates). Here: the Galahad Index per run with what it cost
 * (tokens as the providers reported them, money at your prices), each problem over
 * every run, every answer or hidden check, and what the records say when runs are
 * compared: per effort, per model in each role, per variant of the harness. Runs
 * start from a terminal (`galahad trial run`).
 */

const MARK: Record<Mark, { label: string; tone: Tone }> = {
  solved: { label: "Solved", tone: "ok" },
  partial: { label: "Partly", tone: "warn" },
  missed: { label: "Missed", tone: "danger" },
  crashed: { label: "Crashed", tone: "neutral" },
};

const SUITE: Record<string, { label: string; about: string }> = {
  engineering: { label: "Engineering", about: "Mathematics, physics and engineering problems with exact answers, solved in the Lab." },
  agentic: { label: "Agentic", about: "Real work in a small repository, graded by hidden tests run in a fresh sandbox against what he left." },
  reviewer: { label: "Reviewer", about: "A quest's evidence with a known answer, put to the reviewer: does it pass what it should fail?" },
  yours: { label: "Yours", about: "Your knights' tasks that passed review, each worked again from the commit it began at and graded by its own gates." },
};

const scoreTone = (x: number) => (x >= 0.9 ? "var(--ok)" : x >= 0.6 ? "var(--warn)" : "var(--danger)");

function openTrial(ctx: Ctx, t: TrialView, prices: Record<string, Price>): void {
  const mark = MARK[markOf(t)];
  const passed = t.answers.filter((a) => a.ok).length;
  const checks = t.answers.some(isCheck);
  const answers = h(
    "div",
    { class: "rows" },
    ...t.answers.map((a) =>
      isCheck(a)
        ? // A hidden test or a verdict: it passed or it didn't.
          h("div", { class: "item" }, h("div", { class: "grow" }, h("span", { class: "mono strong small wrap-anywhere" }, a.key)), badge(checkLabel(a), a.got === null ? "neutral" : a.ok ? "ok" : "danger", a.ok ? "check" : "x"))
        : h(
            "div",
            { class: "item" },
            h(
              "div",
              { class: "grow" },
              h("div", { class: "row wrap" }, h("span", { class: "mono strong small" }, a.key), h("span", { class: "tiny subtle" }, a.units)),
              h(
                "div",
                { class: "meta tnum" },
                h("span", {}, "got ", h("span", { class: "mono" }, numberLabel(a.got))),
                h("span", {}, "exact ", h("span", { class: "mono" }, numberLabel(a.expected)), " ± ", h("span", { class: "mono" }, numberLabel(a.tolerance))),
              ),
            ),
            badge(offBy(a), a.ok ? "ok" : "danger", a.ok ? "check" : "x"),
          ),
    ),
  );
  const spent = spentLine(t, prices);
  const facts: [string, string][] = [
    ["Kind", t.domain],
    ["Seed", String(t.seed)],
    ["Run", t.run],
    ["Revision", t.version],
    ["Models", t.models.join(", ") || "—"],
    ["Quest", t.quest ? `${t.quest.status}, ${plural(t.quest.steps, "command")}, ${plural(t.quest.revisions, "revision")}` : "—"],
    ["Took", durationLabel(t.seconds)],
    ["Spent", spent ?? "not counted (recorded before model calls were)"],
    ["Recorded", `${absoluteTime(t.recordedAt)} on ${t.nodeName}`],
  ];
  const body = h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "row wrap" },
      badge(mark.label, mark.tone),
      t.status === "scored" ? h("span", { class: "small muted tnum" }, checks ? `${passed} of ${plural(t.answers.length, "check")} passed` : `${passed} of ${t.answers.length} answers within tolerance`) : null,
    ),
    t.note ? callout(t.status === "crashed" ? "warn" : "quiet", t.note, { title: t.status === "crashed" ? "The run itself failed, so it isn't counted" : undefined }) : null,
    answers,
    t.spent?.lines.length
      ? h(
          "div",
          { class: "rows" },
          ...t.spent.lines.map((l) =>
            h(
              "div",
              { class: "item" },
              h("div", { class: "grow" }, h("div", { class: "row wrap" }, h("span", { class: "strong small" }, l.role), h("span", { class: "mono tiny subtle wrap-anywhere" }, l.model))),
              h("span", { class: "small muted tnum" }, `${plural(l.calls, "call")}${l.unknown ? ` (${l.unknown} unreported)` : ""} · ${tokensLabel(l.input)} in · ${tokensLabel(l.output)} out`),
            ),
          ),
        )
      : null,
    h("dl", { class: "kv" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", { class: k === "Revision" || k === "Run" ? "mono" : null }, v)])),
    h(
      "p",
      { class: "tiny subtle" },
      checks
        ? "Graded by a program: each check is a hidden test run in a fresh sandbox against what he left, or a verdict compared with the known one. The same seed poses exactly this again."
        : "Graded by a program against the exact solution. The same seed poses exactly this problem again.",
    ),
    t.artifact
      ? h(
          "div",
          { class: "row end" },
          button("Open its work", {
            icon: "archive",
            onClick: () => {
              sheet.close();
              ctx.navigate("artifacts", { intent: t.artifact! });
            },
          }),
        )
      : null,
  );
  const sheet = openSheet({ title: t.title, description: `Trial ${t.problem}`, body });
}

function trialRow(ctx: Ctx, t: TrialView, prices: Record<string, Price>): HTMLElement {
  const mark = MARK[markOf(t)];
  const passed = t.answers.filter((a) => a.ok).length;
  return h(
    "button",
    { class: "item item-button", type: "button", "data-key": t.id, "aria-label": `${t.title}: ${mark.label}`, onclick: () => openTrial(ctx, t, prices) },
    h("span", { class: "avatar" }, icon(t.status === "crashed" ? "alert" : t.score === 1 ? "check" : "x", { size: 14 })),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "row wrap" }, h("span", { class: "strong small" }, t.title), badge(mark.label, mark.tone)),
      h(
        "div",
        { class: "meta tnum" },
        h("span", {}, t.domain),
        t.status === "scored" ? h("span", {}, `${passed}/${t.answers.length} ${t.answers.some(isCheck) ? "checks" : "answers"}`) : null,
        h("span", {}, durationLabel(t.seconds)),
        h("span", {}, `seed ${t.seed}`),
      ),
    ),
    icon("chevron-right", { size: 16, class: "subtle" }),
  );
}

/** A run's cost in a paragraph: tokens, time, money, and what the quality cost. */
function costNote(trials: readonly TrialView[], prices: Record<string, Price>): HTMLElement | null {
  const cost = runCost(trials, prices);
  if (!cost) return null;
  return h(
    "p",
    { class: "small muted" },
    `Cost: ${cost.tokens}${cost.money ? ` · ${cost.money}` : " · money not known (a price is missing, or a call went unreported)"}${cost.counted < cost.of ? ` · counted for ${cost.counted} of ${cost.of} trials` : ""}.`,
    cost.buys.length ? ` It bought ${cost.buys.join(" · ")}.` : "",
  );
}

/** What his "done" was worth in a run: how often a quest that ended done was found short by the grading. Null where no trial has a quest (the reviewer's cases). */
function doneNote(trials: readonly TrialView[]): HTMLElement | null {
  const report = doneReport(trials);
  if (!report) return null;
  return h("p", { class: report.falseDone.count ? "small danger-text" : "small muted" }, `His "done": ${doneLine(report)}.`);
}

function openRun(ctx: Ctx, r: RunSummary, held: string[], prices: Record<string, Price>): void {
  const body = h(
    "div",
    { class: "stack" },
    h(
      "div",
      { class: "stack tight" },
      h("div", { class: "row wrap between" }, h("span", { class: "strong" }, `Galahad Index ${percent(r.index.mean)}`), h("span", { class: "small muted tnum" }, `90% interval ${percent(r.index.low)}–${percent(r.index.high)}`)),
      meter(r.index.mean, scoreTone(r.index.mean), "Galahad Index"),
      h("p", { class: "small muted" }, `${r.solved} of ${r.index.n} solved outright${r.crashed ? `; ${plural(r.crashed, "trial")} crashed and ${r.crashed === 1 ? "isn't" : "aren't"} counted` : ""}. Revision `, h("span", { class: "mono" }, r.version), ` on ${r.nodeName}.`),
      held.length ? h("div", { class: "row wrap" }, ...held.map((label) => badge(label, "accent"))) : null,
      costNote(r.trials, prices),
      doneNote(r.trials),
    ),
    h("div", { class: "rows" }, ...r.trials.map((t) => trialRow(ctx, t, prices))),
  );
  openSheet({ title: `Run ${r.run}`, description: `${r.suite} · ${absoluteTime(r.startedAt)}`, body });
}

export const trialsView: View = (root, ctx, { scope }) => {
  const stats = h("div", { class: "grid stats" }, skeletonBlock(92), skeletonBlock(92), skeletonBlock(92));
  const runsBox = h("div", { class: "card" }, skeletonRows(3, { avatar: true }));
  const problemsBox = h("div", { class: "card" }, skeletonRows(4, { avatar: true }));
  const content = h("div", { class: "stack" });
  /** Each run's settings (its effort, its variant, what it pinned), for the runs that recorded them. */
  let settings: TrialRunsView = {};
  let prices: Record<string, Price> = {};
  /** The suite shown; until you choose, the latest run's. */
  let chosen: string | null = null;

  /** The Index per effort level, with the verdict: did more compute help? Null when no run spent more than one attempt. */
  function effortSection(trials: readonly TrialView[]): HTMLElement | null {
    const efforts = Object.fromEntries(Object.entries(settings).map(([run, s]) => [run, s.effort]));
    if (!trials.some((t) => (efforts[t.run] ?? 1) > 1)) return null;
    const report = effortReport(trials, efforts);
    return section(
      "By effort",
      { count: "attempts per trial" },
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "rows" },
          ...report.levels.map((l) =>
            h(
              "div",
              { class: "item" },
              h("span", { class: "avatar tnum strong" }, String(l.effort)),
              h(
                "div",
                { class: "grow stack tight" },
                h("div", { class: "row wrap" }, h("span", { class: "strong small tnum" }, `Index ${percent(l.mean)}`), h("span", { class: "tiny subtle tnum" }, `${percent(l.low)}–${percent(l.high)}`)),
                meter(l.mean, scoreTone(l.mean), `Galahad Index at effort ${l.effort}`),
                h("div", { class: "meta tnum" }, h("span", {}, l.effort === 1 ? "one attempt a trial" : `${l.effort} attempts a trial`), h("span", {}, plural(l.n, "trial")), h("span", {}, plural(l.runs, "run"))),
              ),
            ),
          ),
        ),
      ),
      callout(report.helps ? "ok" : "quiet", report.verdict, { title: report.helps ? "More compute made him more capable" : report.helps === false ? "More compute didn't measurably help" : "Not compared yet", icon: "gauge" }),
      h("p", { class: "tiny subtle" }, "With effort, each trial makes that many attempts; the independent reviewer takes one on the evidence before anything is graded, and only that one's answers count."),
    );
  }

  /** One candidate for a role: the Index with its interval, and what a trial of it cost. */
  function modelRow(row: ModelRow): HTMLElement {
    const cost = [
      row.tokensPerTrial !== null ? `${tokensLabel(row.tokensPerTrial)} tokens a trial` : "tokens unknown",
      durationLabel(Math.round(row.secondsPerTrial)),
      row.usdPerTrial !== null ? `${usdLabel(row.usdPerTrial)} a trial` : "no price",
    ];
    return h(
      "div",
      { class: "item" },
      h("span", { class: "avatar" }, icon("models", { size: 14 })),
      h(
        "div",
        { class: "grow stack tight" },
        h("div", { class: "row wrap" }, h("span", { class: row.model ? "mono strong small wrap-anywhere" : "strong small" }, row.model ?? "The roster as it is"), h("span", { class: "strong small tnum" }, percent(row.quality.mean)), h("span", { class: "tiny subtle tnum" }, `${percent(row.quality.low)}–${percent(row.quality.high)}`)),
        meter(row.quality.mean, scoreTone(row.quality.mean), `Index with ${row.model ?? "the roster"}`),
        h("div", { class: "meta tnum" }, h("span", {}, plural(row.quality.n, "trial")), ...cost.map((c) => h("span", {}, c)), row.crashed ? h("span", {}, `${row.crashed} crashed`) : null),
      ),
    );
  }

  /** Which model is best in each role, and best for its cost: from the runs that held a role to one model. */
  function modelsSection(reports: readonly RoleReport[]): HTMLElement | null {
    if (!reports.length) return null;
    return section(
      "By model, per role",
      { count: "one role held to one model" },
      ...reports.flatMap((report) => [
        h("div", { class: "card" }, h("div", { class: "rows" }, ...report.rows.map(modelRow))),
        callout("quiet", h("div", { class: "stack tight" }, h("p", {}, report.best), h("p", {}, report.bestForCost)), { title: `As ${report.role}`, icon: "models" }),
      ]),
      h("p", { class: "tiny subtle" }, "Each row is the same seeded tasks with one role held to one model and every other role as the roster has it (galahad trial sweep). A model is \"best\" only when its interval clears the others'."),
    );
  }

  /** Does a change to the harness help? Each variant against the baseline run beside it. */
  function variantsSection(comparisons: readonly Comparison[]): HTMLElement | null {
    if (!comparisons.length) return null;
    const title = (c: Comparison): string => (c.verdict === "helps" ? "Measurably helps" : c.verdict === "hurts" ? "Measurably hurts" : c.verdict === "none" ? "No measurable difference" : "Not measured yet");
    return section(
      "Variants of the harness",
      { count: "the same tasks under each" },
      ...comparisons.map((c) =>
        callout(c.verdict === "helps" ? "ok" : c.verdict === "hurts" ? "warn" : "quiet", h("div", { class: "stack tight" }, ...c.lines.map((line) => h("p", { class: "small" }, line))), { title: `${c.b.name}: ${title(c)}`, icon: "gauge" }),
      ),
      h("p", { class: "tiny subtle" }, "A variant is a named set of harness switches (gates, the planner's own gates, effort, skills, the archive's context, revisions), recorded with its run. It \"helps\" only when its interval clears the baseline's (galahad trial ab)."),
    );
  }

  /** The reviewer's two error rates, by the model that reviewed. */
  function reviewerSection(rows: readonly ReviewerRow[]): HTMLElement | null {
    if (!rows.length) return null;
    const rate = (p: ReviewerRow["passedWrong"]): string => (p.of ? `${p.count} of ${p.of}${p.rate ? ` (${percent(p.rate.mean)})` : ""}` : "no such case yet");
    return section(
      "The reviewer",
      { count: "by the model that reviewed" },
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "rows" },
          ...rows.map((row) =>
            h(
              "div",
              { class: "item" },
              h("span", { class: "avatar" }, icon("review", { size: 14 })),
              h(
                "div",
                { class: "grow stack tight" },
                h("div", { class: "row wrap" }, h("span", { class: "mono strong small wrap-anywhere" }, row.model), h("span", { class: "strong small tnum" }, `right ${percent(row.right.mean)}`), h("span", { class: "tiny subtle tnum" }, `${percent(row.right.low)}–${percent(row.right.high)}`)),
                meter(row.right.mean, scoreTone(row.right.mean), `How often ${row.model} was right`),
                h(
                  "div",
                  { class: "meta tnum" },
                  h("span", { class: row.passedWrong.count ? "danger-text" : null }, `passed what it should fail: ${rate(row.passedWrong)}`),
                  h("span", {}, `failed what it should pass: ${rate(row.failedRight)}`),
                  row.tokensPerCase !== null ? h("span", {}, `${tokensLabel(row.tokensPerCase)} tokens a case`) : null,
                ),
              ),
            ),
          ),
        ),
      ),
      h("p", { class: "tiny subtle" }, "Each case is a quest's evidence with a known answer, asked in the words a real quest uses. Passing what should fail lets wrong work through; failing what should pass wastes revisions."),
    );
  }

  function runRow(r: RunSummary): HTMLElement {
    const held = heldLabels(settings[r.run]);
    const cost = runCost(r.trials, prices);
    const falseDone = doneReport(r.trials)?.falseDone.count ?? 0;
    return h(
      "button",
      { class: "item item-button", type: "button", "data-key": r.run, "aria-label": `Run ${r.run}: Index ${percent(r.index.mean)}`, onclick: () => openRun(ctx, r, held, prices) },
      h("span", { class: "avatar" }, icon("gauge", { size: 14 })),
      h(
        "div",
        { class: "grow stack tight" },
        h(
          "div",
          { class: "row wrap" },
          h("span", { class: "strong small tnum" }, `Index ${percent(r.index.mean)}`),
          h("span", { class: "tiny subtle tnum" }, `${percent(r.index.low)}–${percent(r.index.high)}`),
          ...held.map((label) => badge(label, "accent")),
          r.crashed ? badge(`${r.crashed} crashed`, "neutral") : null,
        ),
        meter(r.index.mean, scoreTone(r.index.mean)),
        h(
          "div",
          { class: "meta tnum" },
          h("span", { title: absoluteTime(r.startedAt) }, relativeTime(r.startedAt)),
          h("span", {}, `${r.solved}/${r.index.n} solved`),
          falseDone ? h("span", { class: "danger-text" }, `${falseDone} called done and found short`) : null,
          cost ? h("span", {}, cost.money ? `${cost.tokens} · ${cost.money}` : cost.tokens) : null,
          h("span", { class: "mono" }, r.version),
          r.models.length ? h("span", { class: "wrap-anywhere" }, r.models.join(", ")) : null,
        ),
      ),
      icon("chevron-right", { size: 16, class: "subtle" }),
    );
  }

  function render(all: readonly TrialView[]): void {
    const suites = [...new Set(all.map((t) => t.suite))];
    const latestSuite = groupRuns(all)[0]!.suite;
    const suite = chosen && suites.includes(chosen) ? chosen : latestSuite;
    const trials = all.filter((t) => t.suite === suite);
    const runs = groupRuns(trials);
    const latest = runs[0]!;
    const latestCost = runCost(latest.trials, prices);
    const tabs =
      suites.length > 1
        ? segmented(
            suites.map((s) => ({ value: s, label: SUITE[s]?.label ?? s })),
            suite,
            (value) => {
              chosen = value;
              render(all);
            },
            { label: "Suite" },
          ).el
        : null;
    replace(
      content,
      tabs,
      SUITE[suite] ? h("p", { class: "small muted" }, SUITE[suite]!.about) : null,
      stats,
      effortSection(trials),
      modelsSection(modelReport(trials, settings, prices, suite)),
      variantsSection(variantReport(trials, settings, prices, suite)),
      suite === "reviewer" ? reviewerSection(reviewerReport(trials)) : null,
      section("Runs", { count: plural(runs.length, "run") }, runsBox),
      section(suite === "reviewer" ? "By case" : "By problem", { count: "every run" }, problemsBox),
    );
    replace(
      stats,
      statTile({
        label: "Galahad Index",
        icon: "gauge",
        value: percent(latest.index.mean),
        note: `latest run · 90% interval ${percent(latest.index.low)}–${percent(latest.index.high)}`,
      }),
      statTile({ label: "Solved", icon: "check", value: `${latest.solved}/${latest.index.n}`, note: latest.crashed ? `${latest.crashed} crashed, not counted` : "outright, in the latest run" }),
      latestCost
        ? statTile({ label: "Cost", icon: "zap", value: latestCost.money ?? latestCost.tokens, note: latestCost.money ? `${latestCost.tokens} · ${latestCost.buys[0] ?? "the latest run"}` : (latestCost.buys[0] ?? "no price stated: tokens only") })
        : statTile({ label: "Revision", icon: "code", value: h("span", { class: "mono" }, latest.version.slice(0, 12)), note: latest.models.join(", ") || "models unknown" }),
    );
    keepPlace(runsBox, () => replace(runsBox, h("div", { class: "rows" }, ...runs.map(runRow))));
    keepPlace(problemsBox, () =>
      replace(
        problemsBox,
        h(
          "div",
          { class: "rows" },
          ...byProblem(trials).map((p) =>
            h(
              "button",
              { class: "item item-button", type: "button", "data-key": p.problem, "aria-label": `${p.title}: ${p.solved} of ${p.tries} solved`, onclick: () => openTrial(ctx, p.latest, prices) },
              h("span", { class: "avatar" }, icon(p.solved === p.tries ? "check" : p.solved ? "minus" : "x", { size: 14 })),
              h(
                "div",
                { class: "grow stack tight" },
                h("div", { class: "row wrap" }, h("span", { class: "strong small" }, p.title), h("span", { class: "tiny subtle" }, suite === "engineering" ? p.domain : `${p.domain} · ${p.problem}`)),
                meter(p.mean, scoreTone(p.mean)),
                h("div", { class: "meta tnum" }, h("span", {}, `${p.solved} of ${plural(p.tries, "try", "tries")} solved`), h("span", {}, `mean ${percent(p.mean)}`), h("span", {}, `latest ${relativeTime(p.latest.recordedAt)}`)),
              ),
              icon("chevron-right", { size: 16, class: "subtle" }),
            ),
          ),
        ),
      ),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const [{ trials, runs = {} }, priced] = await Promise.all([
        ctx.api.get<{ trials: TrialView[]; runs?: TrialRunsView }>("/api/trials", scope.signal),
        // A node that predates prices has none: tokens are still shown.
        ctx.api.get<{ prices: Record<string, Price> }>("/api/prices", scope.signal).catch(() => ({ prices: {} as Record<string, Price> })),
      ]);
      if (scope.disposed) return;
      settings = runs;
      prices = priced.prices;
      if (!trials.length) {
        replace(
          content,
          empty({
            icon: "gauge",
            title: "No trials yet",
            body: h(
              "div",
              { class: "stack tight" },
              h("p", {}, "Four suites, each graded by a program: engineering problems with exact answers, agentic tasks with hidden tests, the reviewer's own cases, and your knights' tasks that passed review, worked again and graded by their own gates. Start a run from a terminal on a node; a run keeps to a budget and says first what past runs cost."),
              copyField("galahad trial run"),
              copyField("galahad trial run --suite agentic"),
            ),
          }),
        );
        return;
      }
      render(trials);
    } catch (error) {
      if (scope.disposed) return;
      replace(
        content,
        isUnavailable(error)
          ? empty({ icon: "gauge", title: "Trials aren't available on this node yet", body: "They arrive with an update: problems with exact answers, graded by a program.", compact: true })
          : errorState("Couldn't load trials", error, () => void refresh()),
      );
    }
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      pageHead(
        "Trials",
        "Is Galahad getting better? Problems posed from a seed, worked as ordinary quests and graded by a program, never a model. The Galahad Index is a run's mean score, with its 90% interval; beside it, what the run cost.",
      ),
      content,
    ),
  );
  replace(content, stats, section("Runs", {}, runsBox), section("By problem", {}, problemsBox));
  scope.interval(() => void refresh(), 30_000);
  void refresh();
};
