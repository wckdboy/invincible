import { artifactTitle, type ChartSpec, compactNumber, isBlockKind, type PlanStep, readArtifact, readChart, readChoices, readStats, readSteps, type Stat } from "@galahad/core/blocks";
import { copyText } from "./controls.ts";
import { openSheet } from "./dialog.ts";
import { h, replace, svg } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

/*
 * An answer's blocks drawn as what they are (core blocks.ts): a chart, figures, choices to tap, a plan's steps, a
 * page. What a model wrote goes in as text and attributes, never as markup, with one exception: a page, whose HTML is
 * parsed only inside a frame sealed off from Galahad (`framed`). A block that can't be drawn is shown as its code,
 * with why.
 */

export interface BlockOptions {
  /** The answer is still being written: a page waits for its end (each new word would load it again). */
  live?: boolean;
  /** Choices may be tapped, and a tapped one is sent as your reply. Without it they show what was offered. */
  choose?: (text: string) => void;
}

export interface CodeBlock {
  lang: string;
  v: string;
  open: boolean;
}

type Code = (block: CodeBlock) => HTMLElement;

/** The block drawn as its element; null when it's code (any language that isn't a block). */
export function drawBlock(block: CodeBlock, options: BlockOptions, code: Code): HTMLElement | null {
  const lang = block.lang.toLowerCase();
  if (lang === "html" && !block.open && readArtifact(block.v).ok) return previewable(block, code);
  if (lang === "svg" && !block.open && /^\s*<svg[\s>]/i.test(block.v) && block.v.length <= 100_000) return picture(block, code);
  if (!isBlockKind(lang)) return null;
  if (block.open) return pending(lang);
  switch (lang) {
    case "chart": {
      const read = readChart(block.v);
      return read.ok ? chartFigure(read.value) : refused("chart", read.why, code(block));
    }
    case "stats": {
      const read = readStats(block.v);
      return read.ok ? statsGrid(read.value) : refused("figures", read.why, code(block));
    }
    case "choices": {
      const read = readChoices(block.v);
      return read.ok ? choicesRow(read.value, options.choose) : refused("choices", read.why, code(block));
    }
    case "steps": {
      const read = readSteps(block.v);
      return read.ok ? stepsList(read.value) : refused("steps", read.why, code(block));
    }
    case "artifact": {
      const read = readArtifact(block.v);
      if (!read.ok) return refused("page", read.why, code(block));
      return options.live ? pending("artifact") : pageCard(read.value, () => code(block));
    }
  }
}

const PENDING: Record<string, [IconName, string]> = {
  chart: ["activity", "Drawing a chart…"],
  stats: ["gauge", "Gathering figures…"],
  choices: ["chat", "Writing choices…"],
  steps: ["layers", "Planning steps…"],
  artifact: ["file", "Making a page: it opens when he's done"],
};

function pending(lang: string): HTMLElement {
  const [glyph, words] = PENDING[lang] ?? ["zap", "Drawing…"];
  return h("div", { class: "viz-pending", role: "status" }, icon(glyph, { size: 15 }), h("span", {}, words));
}

function refused(what: string, why: string, codeEl: HTMLElement): HTMLElement {
  return h("div", { class: "viz-refused" }, h("p", { class: "tiny subtle" }, `This ${what} couldn't be drawn: ${why}.`), codeEl);
}

/* ---------- a chart ---------- */

const PALETTE = 6;
const colorOf = (i: number) => `var(--viz-${(i % PALETTE) + 1})`;
/** A unit of one sign sits on its number (12%); a word stands apart (3,400 DKK). */
const withUnit = (text: string, unit: string | null) => (!unit ? text : /^[%°‰]$/.test(unit) ? `${text}${unit}` : `${text} ${unit}`);

/** Clean round ticks over [lo, hi], about `count` of them. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (lo === hi) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi)];
  const rough = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = magnitude * ([1, 2, 2.5, 5, 10].find((n) => rough / magnitude <= n) ?? 10);
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks.at(-1)! < hi) ticks.push(Number((ticks.at(-1)! + step).toPrecision(12)));
  return ticks;
}

/** The values a chart spans: a bar grows from zero, so does a stack (its totals) and an area; a line may float. */
export function domainOf(spec: ChartSpec): [number, number] {
  const values = spec.type === "stacked" ? spec.labels.map((_, i) => spec.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)) : spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (spec.type !== "line") [lo, hi] = [Math.min(0, lo), Math.max(0, hi)];
  else if (lo > 0 && lo / hi < 0.35) lo = 0;
  return [lo, hi];
}

function chartFigure(spec: ChartSpec): HTMLElement {
  const n = spec.labels.length;
  const bars = spec.type === "bar" || spec.type === "stacked";
  const many = spec.series.length > 1;
  const value = (v: number | null) => (v === null ? "–" : withUnit(compactNumber(v), spec.unit));
  // Drawn at about the width it's shown at, so its words stay their size: a phone's column, or a wide screen's.
  const W = Math.round(Math.max(280, Math.min(640, (typeof window === "undefined" ? 640 : window.innerWidth) - 72)));
  const H = 200;
  const ticks = niceTicks(...domainOf(spec));
  const [lo, hi] = [ticks[0]!, ticks.at(-1)!];
  const tickText = ticks.map((t) => compactNumber(t));
  // End labels for a line or an area of three series or fewer, when they don't collide; else the legend and tooltip.
  const lastOf = (s: ChartSpec["series"][number]) => {
    for (let i = n - 1; i >= 0; i--) if (s.values[i] !== null) return { i, v: s.values[i]! };
    return null;
  };
  const ends = !bars && spec.series.length <= 3 ? spec.series.map(lastOf) : [];
  const pad = { top: 12, bottom: 22, left: Math.max(...tickText.map((t) => t.length)) * 6.4 + 10, right: ends.length ? Math.max(...ends.map((e) => (e ? compactNumber(e.v).length : 0))) * 6.6 + 14 : 10 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / n;
  const x = (i: number) => (bars || n === 1 ? pad.left + band * i + band / 2 : pad.left + (plotW * i) / (n - 1));
  const base = y(Math.max(lo, Math.min(0, hi)));

  const grid = svg("g", { class: "viz-grid", "aria-hidden": "true" }, ...ticks.map((t, i) => [
    svg("line", { x1: pad.left, x2: W - pad.right, y1: y(t), y2: y(t), class: t === 0 ? "viz-zero" : null }),
    svg("text", { x: pad.left - 8, y: y(t), "text-anchor": "end", "dominant-baseline": "middle", class: "viz-tick" }, tickText[i]!),
  ]));

  // The x labels that fit, the last one included when there's room for it.
  const labelW = Math.max(...spec.labels.map((l) => l.length)) * 6.2 + 10;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / labelW))));
  const shownX = spec.labels.map((_, i) => i % every === 0 || (i === n - 1 && (n - 1) % every >= Math.ceil(every / 2)));
  const xLabels = svg("g", { class: "viz-x", "aria-hidden": "true" }, ...spec.labels.map((label, i) => (shownX[i] ? svg("text", { x: x(i), y: H - 6, "text-anchor": n > 1 && !bars && i === 0 ? "start" : n > 1 && !bars && i === n - 1 ? "end" : "middle", class: "viz-tick" }, label) : null)));

  const marks = svg("g", { class: "viz-marks" });
  const highlight = svg("rect", { class: "viz-band", x: 0, y: pad.top, width: Math.max(0, band - 2), height: plotH, visibility: "hidden" });
  const cross = svg("line", { class: "viz-cross", x1: 0, x2: 0, y1: pad.top, y2: pad.top + plotH, visibility: "hidden" });
  const dots = svg("g", { class: "viz-dots", visibility: "hidden" });

  if (bars) {
    const m = spec.type === "stacked" ? 1 : spec.series.length;
    const barW = Math.max(2, Math.min(24, (band * 0.72 - (m - 1) * 2) / m));
    for (let i = 0; i < n; i++) {
      if (spec.type === "stacked") {
        let sum = 0;
        const top = spec.series.reduce((last, s, j) => ((s.values[i] ?? 0) > 0 ? j : last), -1);
        spec.series.forEach((s, j) => {
          const v = s.values[i] ?? 0;
          if (v <= 0) return;
          const from = y(sum) - (sum > 0 ? 2 : 0);
          sum += v;
          const to = y(sum);
          if (from - to > 0.5) marks.append(svg("path", { d: barPath(x(i) - barW / 2, barW, from, to, j === top), fill: colorOf(j) }));
        });
      } else {
        const groupW = m * barW + (m - 1) * 2;
        spec.series.forEach((s, j) => {
          const v = s.values[i] ?? null;
          if (v === null) return;
          marks.append(svg("path", { d: barPath(x(i) - groupW / 2 + j * (barW + 2), barW, base, y(v), true), fill: colorOf(j) }));
        });
      }
    }
    // A few bars carry their value at the tip; more, and the tooltip and the table do.
    const totals = spec.labels.map((_, i) => (spec.type === "stacked" ? spec.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0) : null));
    if (n * m <= 8) {
      const groupW = m * barW + (m - 1) * 2;
      for (let i = 0; i < n; i++) {
        if (spec.type === "stacked") marks.append(svg("text", { x: x(i), y: y(totals[i]!) - 6, "text-anchor": "middle", class: "viz-value" }, compactNumber(totals[i]!)));
        else spec.series.forEach((s, j) => {
          const v = s.values[i] ?? null;
          if (v !== null) marks.append(svg("text", { x: x(i) - groupW / 2 + j * (barW + 2) + barW / 2, y: v >= 0 ? y(v) - 6 : y(v) + 13, "text-anchor": "middle", class: "viz-value" }, compactNumber(v)));
        });
      }
    }
  } else {
    spec.series.forEach((s, j) => {
      // A null breaks the line: each unbroken run is drawn on its own.
      const runs: [number, number][][] = [[]];
      s.values.forEach((v, i) => (v === null ? runs.push([]) : runs.at(-1)!.push([x(i), y(v)])));
      for (const run of runs.filter((r) => r.length)) {
        const d = run.map(([px, py], k) => `${k ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
        if (spec.type === "area") marks.append(svg("path", { d: `${d}L${run.at(-1)![0].toFixed(1)},${base.toFixed(1)}L${run[0]![0].toFixed(1)},${base.toFixed(1)}Z`, fill: colorOf(j), class: "viz-wash" }));
        marks.append(run.length > 1 ? svg("path", { d, stroke: colorOf(j), class: "viz-line" }) : svg("circle", { cx: run[0]![0], cy: run[0]![1], r: 3, fill: colorOf(j) }));
      }
      const end = lastOf(s);
      if (end) marks.append(svg("circle", { cx: x(end.i), cy: y(end.v), r: 4, fill: colorOf(j), class: "viz-dot" }));
    });
    // Each line's last value beside its end, unless two would touch.
    const placed = ends.flatMap((e, j) => (e ? [{ j, at: y(e.v), text: compactNumber(e.v) }] : [])).sort((a, b) => a.at - b.at);
    if (placed.every((p, k) => k === 0 || p.at - placed[k - 1]!.at >= 13)) {
      for (const p of placed) marks.append(svg("text", { x: W - pad.right + 8, y: p.at, "dominant-baseline": "middle", class: "viz-value" }, p.text));
    }
  }

  const kind = { line: "Line chart", area: "Area chart", bar: "Bar chart", stacked: "Stacked bar chart" }[spec.type];
  const summary = `${kind}${spec.title ? `: ${spec.title}` : ""}. ${spec.series.length === 1 ? "One series" : `${spec.series.length} series`} over ${n} ${n === 1 ? "label" : "labels"}; the data is in the table below.`;
  const plot = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": summary }, grid, highlight, marks, cross, dots, xLabels);
  const tip = h("div", { class: "viz-tip", hidden: true, "aria-hidden": "true" });
  const legend = many
    ? h("div", { class: "viz-legend" }, ...spec.series.map((s, j) => h("span", { class: "viz-key" }, h("span", { class: bars || spec.type === "area" ? "viz-swatch" : "viz-stroke", style: `--key:${colorOf(j)}` }), s.name)))
    : null;

  // What's at one label: a crosshair over a line's points, or a band behind a bar's; every series in the tooltip.
  const show = (i: number): void => {
    if (bars) highlight.setAttribute("x", String(pad.left + band * i + 1));
    else {
      cross.setAttribute("x1", String(x(i)));
      cross.setAttribute("x2", String(x(i)));
    }
    highlight.setAttribute("visibility", bars ? "visible" : "hidden");
    cross.setAttribute("visibility", bars ? "hidden" : "visible");
    replace(dots, ...(bars ? [] : spec.series.map((s, j) => (s.values[i] === null ? null : svg("circle", { cx: x(i), cy: y(s.values[i]!), r: 4, fill: colorOf(j), class: "viz-dot" })))));
    dots.setAttribute("visibility", "visible");
    const total = spec.type === "stacked" && many ? spec.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0) : null;
    replace(
      tip,
      h("div", { class: "viz-tip-label" }, spec.labels[i]!),
      ...spec.series.map((s, j) => h("div", { class: "viz-tip-row" }, h("span", { class: "viz-stroke", style: `--key:${colorOf(j)}` }), h("strong", {}, value(s.values[i] ?? null)), many ? h("span", {}, s.name) : null)),
      total === null ? null : h("div", { class: "viz-tip-row" }, h("span", { class: "viz-stroke blank" }), h("strong", {}, value(total)), h("span", {}, "Total")),
    );
    // Beside the point, on whichever side has room; centred over it when neither has.
    tip.hidden = false;
    const width = plot.getBoundingClientRect().width;
    const point = (x(i) / W) * width;
    const tw = tip.offsetWidth;
    let left = point + 12;
    if (left + tw > width) left = point - 12 - tw;
    if (left < 0) left = Math.max(0, Math.min(width - tw, point - tw / 2));
    tip.style.left = `${left}px`;
  };
  const hide = (): void => {
    highlight.setAttribute("visibility", "hidden");
    cross.setAttribute("visibility", "hidden");
    dots.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  let at = -1;
  const indexAt = (event: PointerEvent): number => {
    const box = plot.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    return Math.max(0, Math.min(n - 1, bars || n === 1 ? Math.floor((px - pad.left) / band) : Math.round(((px - pad.left) / plotW) * (n - 1))));
  };
  const hit = svg("rect", { class: "viz-hit", x: pad.left, y: 0, width: plotW, height: H });
  plot.append(hit);
  hit.addEventListener("pointermove", (event) => show((at = indexAt(event))));
  hit.addEventListener("pointerdown", (event) => {
    figure.focus({ preventScroll: true });
    show((at = indexAt(event)));
  });
  hit.addEventListener("pointerleave", (event) => event.pointerType === "mouse" && document.activeElement !== figure && hide());

  const table = h(
    "details",
    { class: "viz-data" },
    h("summary", {}, "Data"),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), ...spec.series.map((s) => h("th", { scope: "col" }, s.name)))),
        h("tbody", {}, ...spec.labels.map((label, i) => h("tr", {}, h("th", { scope: "row" }, label), ...spec.series.map((s) => h("td", {}, value(s.values[i] ?? null)))))),
      ),
    ),
  );

  const figure = h(
    "figure",
    {
      class: "viz",
      tabindex: 0,
      "aria-label": summary,
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          show((at = at < 0 ? (event.key === "ArrowRight" ? 0 : n - 1) : Math.max(0, Math.min(n - 1, at + (event.key === "ArrowRight" ? 1 : -1)))));
        } else if (event.key === "Escape") hide();
      },
      onfocus: () => at >= 0 && show(at),
      onblur: hide,
    },
    spec.title || spec.unit ? h("figcaption", { class: "viz-head" }, spec.title ? h("span", { class: "viz-title" }, spec.title) : null, spec.unit ? h("span", { class: "viz-unit" }, spec.unit) : null) : null,
    legend,
    h("div", { class: "viz-plot" }, plot, tip),
    table,
  );
  return figure;
}

/** A bar from its baseline to its value: its data end rounded (4px), its base square. */
function barPath(left: number, width: number, from: number, to: number, round: boolean): string {
  const up = to < from;
  const r = round ? Math.min(4, width / 2, Math.abs(from - to)) : 0;
  const [l, rt] = [left.toFixed(1), (left + width).toFixed(1)];
  if (!r) return `M${l},${from.toFixed(1)}V${to.toFixed(1)}H${rt}V${from.toFixed(1)}Z`;
  const edge = (up ? to + r : to - r).toFixed(1);
  const sweep = up ? 1 : 0;
  return `M${l},${from.toFixed(1)}V${edge}A${r},${r} 0 0 ${sweep} ${(left + r).toFixed(1)},${to.toFixed(1)}H${(left + width - r).toFixed(1)}A${r},${r} 0 0 ${sweep} ${rt},${edge}V${from.toFixed(1)}Z`;
}

/* ---------- figures, choices, steps ---------- */

function statsGrid(stats: Stat[]): HTMLElement {
  return h(
    "div",
    { class: "viz-stats", role: "list" },
    ...stats.map((s) => {
      const shown = typeof s.value === "number" ? compactNumber(s.value) : s.value;
      const tone = s.delta === null || s.delta === 0 || s.good === null ? "neutral" : (s.delta > 0) === (s.good === "up") ? "good" : "bad";
      const delta =
        s.delta === null
          ? null
          : h(
              "div",
              { class: `viz-delta ${tone}` },
              s.delta === 0 ? null : icon(s.delta > 0 ? "arrow-up" : "arrow-down", { size: 13 }),
              h("span", {}, `${s.delta > 0 ? "+" : s.delta < 0 ? "−" : "±"}${withUnit(compactNumber(Math.abs(s.delta)), s.unit)}`),
              s.note ? h("span", { class: "viz-note" }, s.note) : null,
              tone === "neutral" ? null : h("span", { class: "sr-only" }, tone === "good" ? "(good)" : "(not good)"),
            );
      return h(
        "div",
        { class: "viz-stat", role: "listitem" },
        h("div", { class: "viz-stat-label" }, s.label),
        h("div", { class: "viz-stat-value" }, shown, s.unit && typeof s.value === "number" ? h("span", { class: "viz-stat-unit" }, s.unit) : null),
        delta ?? (s.note ? h("div", { class: "viz-note" }, s.note) : null),
      );
    }),
  );
}

function choicesRow(choices: string[], choose: ((text: string) => void) | undefined): HTMLElement {
  if (!choose) return h("div", { class: "viz-choices", role: "list", "aria-label": "What he offered" }, ...choices.map((c) => h("span", { class: "viz-choice static", role: "listitem" }, c)));
  const buttons = choices.map((c) =>
    h("button", {
      class: "viz-choice",
      type: "button",
      onclick: (event: Event) => {
        for (const b of buttons) b.disabled = true;
        (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", "true");
        choose(c);
      },
    }, c),
  );
  return h("div", { class: "viz-choices", role: "group", "aria-label": "Answer with one" }, ...buttons);
}

const STEP_LOOK: Record<PlanStep["state"], [IconName | null, string]> = {
  done: ["check-circle", "Done"],
  doing: ["play-circle", "Doing now"],
  todo: [null, "To do"],
  failed: ["x-circle", "Failed"],
  skipped: ["minus", "Skipped"],
};

function stepsList(steps: PlanStep[]): HTMLElement {
  return h(
    "ol",
    { class: "viz-steps" },
    ...steps.map((s) => {
      const [glyph, said] = STEP_LOOK[s.state];
      return h("li", { "data-state": s.state }, glyph ? icon(glyph, { size: 16 }) : h("span", { class: "viz-todo", "aria-hidden": "true" }), h("span", { class: "sr-only" }, `${said}: `), h("span", {}, s.text));
    }),
  );
}

/* ---------- a page ---------- */

/**
 * A page's HTML as its frame gets it. The frame is sandboxed (an origin of its own: nothing of Galahad's, no forms,
 * popups or navigating the app) and, until you press Run, runs no script. Our head comes first, and holds for what
 * follows: a page can add to its policy, never undo it. Nothing loads from the network (an image's address could
 * carry what he wrote out), links to other files are removed, and so is looking up a name ahead of time.
 */
export function framed(page: string, run: boolean): string {
  const policy = `default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'${run ? "; script-src 'unsafe-inline'" : ""}`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">${page.replace(/<link\b[^>]*>/gi, "")}`;
}

/** The pages frames that run code are waiting to be handed, by frame. */
const waiting = new WeakMap<HTMLIFrameElement, string>();
let listening = false;

/**
 * A page in its frame. Shown as it is, it's a srcdoc frame that runs nothing. Run, it goes to the node's frame host
 * (frame.html), which runs under a policy of its own (the app's would refuse its scripts) and is handed the page once
 * it says it's ready: only by the frame it was meant for.
 */
function frameFor(page: string, run: boolean, title: string, tall = false): HTMLIFrameElement {
  const attrs = { class: `viz-frame${tall ? " tall" : ""}`, title, referrerpolicy: "no-referrer" };
  if (!run) return h("iframe", { ...attrs, sandbox: "", srcdoc: framed(page, false), loading: "lazy" });
  if (!listening) {
    listening = true;
    addEventListener("message", (event) => {
      if (event.data !== "galahad-frame-ready") return;
      const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe.viz-frame[data-run]")].find((f) => f.contentWindow === event.source);
      const handed = frame && waiting.get(frame);
      if (!frame || handed === undefined) return;
      waiting.delete(frame);
      frame.contentWindow!.postMessage(handed, "*");
    });
  }
  const frame = h("iframe", { ...attrs, sandbox: "allow-scripts", src: "/frame.html", "data-run": true });
  waiting.set(frame, framed(page, true));
  return frame;
}

/** The pages you pressed Run on, this session: drawn again (a new message in the chat), they're still running. */
const running = new Set<string>();

function pageCard(page: string, asCode: () => HTMLElement): HTMLElement {
  const title = artifactTitle(page) ?? "A page he made";
  let run = running.has(page);
  let showing: "page" | "code" = "page";
  const stage = h("div", { class: "viz-stage" });
  const note = h("p", { class: "viz-page-note" });
  const runButton = h("button", { class: "btn ghost sm", type: "button" }, icon("play", { size: 13 }), h("span", {}, "Run"));
  const codeButton = h("button", { class: "btn ghost sm icon-only", type: "button", "aria-pressed": "false", "aria-label": "Its code", title: "Its code" }, icon("code", { size: 14 }));
  const render = () => {
    replace(stage, showing === "code" ? asCode() : frameFor(page, run, title));
    replace(runButton, icon(run ? "stop" : "play", { size: 13 }), h("span", {}, run ? "Stop" : "Run"));
    runButton.hidden = showing === "code";
    codeButton.setAttribute("aria-pressed", String(showing === "code"));
    note.textContent = run ? "Running its own code, sealed off from Galahad and your data. It can't fetch anything; like a link, it could still open a web address." : "Shown as it is: its scripts don't run until you press Run, and nothing loads from the network.";
  };
  runButton.addEventListener("click", () => {
    run = !run;
    if (run) running.add(page);
    else running.delete(page);
    render();
  });
  codeButton.addEventListener("click", () => ((showing = showing === "code" ? "page" : "code"), render()));
  const open = h("button", { class: "btn ghost sm icon-only", type: "button", "aria-label": "Open full screen", title: "Open full screen" }, icon("external", { size: 14 }));
  open.addEventListener("click", () => void openSheet({ title, size: "wide", body: frameFor(page, run, title, true) }));
  const copy = h("button", { class: "btn ghost sm icon-only", type: "button", "aria-label": "Copy its HTML", title: "Copy its HTML" }, icon("copy", { size: 14 }));
  copy.addEventListener("click", () => void copyText(page, "Page copied"));
  render();
  return h("div", { class: "viz-page" }, h("div", { class: "viz-page-head" }, icon("file", { size: 15 }), h("strong", { class: "grow ellipsis" }, title), runButton, codeButton, open, copy), stage, note);
}

/** HTML he wrote as code: shown as code, with Preview to see it as a page (sealed off the same way). */
function previewable(block: CodeBlock, code: Code): HTMLElement {
  const holder = h("div", {});
  const asCode = code(block);
  const preview = h("button", { class: "btn ghost sm", type: "button" }, icon("eye", { size: 13 }), h("span", {}, "Preview"));
  preview.addEventListener("click", () => replace(holder, pageCard(block.v, () => code(block))));
  asCode.querySelector(".cb-head")?.insertBefore(preview, asCode.querySelector(".cb-head > button"));
  replace(holder, asCode);
  return holder;
}

/** An SVG he wrote, as the picture it is (an image runs nothing and loads nothing), with its code a tap away. */
function picture(block: CodeBlock, code: Code): HTMLElement {
  const holder = h("figure", { class: "viz-picture" });
  const img = h("img", { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.v)}`, alt: "A picture he drew", decoding: "async" });
  const toggle = h("button", { class: "btn ghost sm", type: "button" }, icon("code", { size: 13 }), h("span", {}, "Code"));
  let asCode = false;
  toggle.addEventListener("click", () => {
    asCode = !asCode;
    replace(stage, asCode ? code(block) : img);
    toggle.lastElementChild!.textContent = asCode ? "Picture" : "Code";
  });
  const stage = h("div", {}, img);
  holder.append(stage, h("figcaption", {}, toggle));
  return holder;
}
