/*
 * What an agent may show in an answer beyond words: a fenced block whose language names it. The app draws each as a
 * live element (a chart, figures, choices to tap, a plan's steps, a page); anywhere else (a terminal, a notification)
 * it stays the text it is, so it must read as text too. Its own file, with no imports, because the app reads it at its
 * boundary: what a model writes is untrusted, so each reader checks every field and caps every size, and a block it
 * doesn't accept is shown as the code it is, with why.
 *
 *   ```chart     {"type":"line|area|bar|stacked","title":"…","unit":"…","labels":["Aug","Sep"],"series":[{"name":"…","values":[1,2]}]}
 *   ```stats     [{"label":"…","value":12,"unit":"…","delta":-3,"note":"since Monday","good":"down"}]
 *   ```choices   ["Ship it","Hold until Monday"]
 *   ```steps     [{"text":"Read the failing test","state":"done|doing|todo|failed|skipped"}]
 *   ```artifact  a whole HTML page (inline CSS, and scripts that run only when you say so)
 */

export const BLOCK_KINDS = ["chart", "stats", "choices", "steps", "artifact"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const isBlockKind = (lang: string): lang is BlockKind => (BLOCK_KINDS as readonly string[]).includes(lang);

export const CHART_TYPES = ["line", "area", "bar", "stacked"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const STEP_STATES = ["done", "doing", "todo", "failed", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];

/** Sizes past which a block isn't drawn: a chart of more is a table, and a page bigger than this is no answer. */
export const BLOCK_LIMITS = { labels: 60, series: 6, title: 80, name: 32, unit: 12, stats: 6, statLabel: 40, statValue: 24, note: 60, choices: 6, choice: 80, steps: 20, step: 120, artifactChars: 200_000 } as const;

export interface ChartSpec {
  type: ChartType;
  title: string | null;
  unit: string | null;
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
}

export interface Stat {
  label: string;
  value: number | string;
  unit: string | null;
  /** The change against `note`'s period, signed. */
  delta: number | null;
  note: string | null;
  /** Which way is good, so a change can say whether it is: up, down, or neither. */
  good: "up" | "down" | null;
}

export interface PlanStep {
  text: string;
  state: StepState;
}

export type Read<T> = { ok: true; value: T } | { ok: false; why: string };

const no = (why: string): { ok: false; why: string } => ({ ok: false, why });

function json(text: string): Read<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return no("it isn't valid JSON");
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One line of text, its whitespace folded, cut to `max` characters with an ellipsis. Null when there's none. */
function line(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const text = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A chart: numbers over time (line, area) or across categories (bar, stacked). One axis, at most six series. */
export function readChart(text: string): Read<ChartSpec> {
  const parsed = json(text);
  if (!parsed.ok) return parsed;
  const c = parsed.value;
  if (!isObject(c)) return no("a chart is an object with type, labels and series");
  const type = c.type ?? "line";
  if (!(CHART_TYPES as readonly unknown[]).includes(type)) return no(`its type is one of ${CHART_TYPES.join(", ")}`);
  if (!Array.isArray(c.labels) || !c.labels.length) return no("it needs labels: what each value is for (a month, a name)");
  if (c.labels.length > BLOCK_LIMITS.labels) return no(`at most ${BLOCK_LIMITS.labels} labels: more is a table`);
  const labels = c.labels.map((l) => line(l, BLOCK_LIMITS.name) ?? "");
  if (!Array.isArray(c.series) || !c.series.length) return no("it needs a series of values");
  if (c.series.length > BLOCK_LIMITS.series) return no(`at most ${BLOCK_LIMITS.series} series: fold the rest into one called Other`);
  const series: ChartSpec["series"] = [];
  for (const [i, s] of c.series.entries()) {
    if (!isObject(s) || !Array.isArray(s.values)) return no(`series ${i + 1} needs values`);
    if (s.values.length !== labels.length) return no(`series ${i + 1} has ${s.values.length} values for ${labels.length} labels`);
    const values = s.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
    if (s.values.some((v, j) => v !== null && values[j] === null)) return no(`series ${i + 1} has a value that isn't a number (null leaves a gap)`);
    if (type === "stacked" && values.some((v) => v !== null && v < 0)) return no("a stacked chart's values are parts of a whole: none below zero");
    const name = line(s.name, BLOCK_LIMITS.name) ?? (c.series.length === 1 ? (line(c.title, BLOCK_LIMITS.name) ?? "Value") : `Series ${i + 1}`);
    if (series.some((other) => other.name.toLowerCase() === name.toLowerCase())) return no(`two series are called ${name}`);
    series.push({ name, values });
  }
  if (!series.some((s) => s.values.some((v) => v !== null))) return no("it has no values");
  return { ok: true, value: { type: type as ChartType, title: line(c.title, BLOCK_LIMITS.title), unit: line(c.unit, BLOCK_LIMITS.unit), labels, series } };
}

/** A few headline figures, each with what it is, and maybe how it changed and whether that's good. */
export function readStats(text: string): Read<Stat[]> {
  const parsed = json(text);
  if (!parsed.ok) return parsed;
  const list = isObject(parsed.value) && Array.isArray(parsed.value.stats) ? parsed.value.stats : parsed.value;
  if (!Array.isArray(list) || !list.length) return no("figures are a list of {label, value}");
  if (list.length > BLOCK_LIMITS.stats) return no(`at most ${BLOCK_LIMITS.stats} figures`);
  const stats: Stat[] = [];
  for (const [i, s] of list.entries()) {
    if (!isObject(s)) return no(`figure ${i + 1} is an object with a label and a value`);
    const label = line(s.label, BLOCK_LIMITS.statLabel);
    const value = typeof s.value === "number" && Number.isFinite(s.value) ? s.value : line(s.value, BLOCK_LIMITS.statValue);
    if (!label || value === null) return no(`figure ${i + 1} needs a label and a value`);
    const delta = typeof s.delta === "number" && Number.isFinite(s.delta) ? s.delta : null;
    const good = s.good === "up" || s.good === "down" ? s.good : null;
    stats.push({ label, value, unit: line(s.unit, BLOCK_LIMITS.unit), delta, note: line(s.note, BLOCK_LIMITS.note), good });
  }
  return { ok: true, value: stats };
}

/** Answers to tap: each one, tapped, is sent as your reply. */
export function readChoices(text: string): Read<string[]> {
  const parsed = json(text);
  if (!parsed.ok) return parsed;
  const list = isObject(parsed.value) && Array.isArray(parsed.value.options) ? parsed.value.options : parsed.value;
  if (!Array.isArray(list)) return no("choices are a list of short answers");
  const choices: string[] = [];
  for (const c of list) {
    const choice = line(c, BLOCK_LIMITS.choice);
    if (choice && !choices.some((other) => other.toLowerCase() === choice.toLowerCase())) choices.push(choice);
  }
  if (choices.length < 2) return no("at least two choices");
  if (choices.length > BLOCK_LIMITS.choices) return no(`at most ${BLOCK_LIMITS.choices} choices`);
  return { ok: true, value: choices };
}

/** A plan's steps and where each stands. A bare line is a step still to do. */
export function readSteps(text: string): Read<PlanStep[]> {
  const parsed = json(text);
  if (!parsed.ok) return parsed;
  const list = isObject(parsed.value) && Array.isArray(parsed.value.steps) ? parsed.value.steps : parsed.value;
  if (!Array.isArray(list) || !list.length) return no("steps are a list of {text, state}");
  if (list.length > BLOCK_LIMITS.steps) return no(`at most ${BLOCK_LIMITS.steps} steps`);
  const steps: PlanStep[] = [];
  for (const [i, s] of list.entries()) {
    const text = line(isObject(s) ? s.text : s, BLOCK_LIMITS.step);
    if (!text) return no(`step ${i + 1} needs its text`);
    const state = isObject(s) && (STEP_STATES as readonly unknown[]).includes(s.state) ? (s.state as StepState) : "todo";
    steps.push({ text, state });
  }
  return { ok: true, value: steps };
}

/** A whole page: HTML with its own CSS (and scripts, which run only when you say so). */
export function readArtifact(text: string): Read<string> {
  const page = text.trim();
  if (!page.includes("<")) return no("a page is HTML");
  if (page.length > BLOCK_LIMITS.artifactChars) return no(`a page is at most ${BLOCK_LIMITS.artifactChars / 1000}K characters`);
  return { ok: true, value: page };
}

/** The page's own <title>, as plain text, for its card. */
export function artifactTitle(page: string): string | null {
  const found = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(page)?.[1];
  return found ? line(found.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"), BLOCK_LIMITS.title) : null;
}

/** A figure as people read it: 1,284 under ten thousand; 12.9K, 4.2M above. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10_000) return n.toLocaleString("en-US", { maximumFractionDigits: abs < 10 ? 2 : abs < 100 ? 1 : 0 });
  const units = [[1e3, "K"], [1e6, "M"], [1e9, "B"], [1e12, "T"]] as const;
  let at = units.findLastIndex(([size]) => abs >= size);
  const shown = (i: number): { text: string; rounded: number } => {
    const scaled = n / units[i]![0];
    const digits = Math.abs(scaled) < 100 ? 1 : 0;
    return { text: scaled.toLocaleString("en-US", { maximumFractionDigits: digits }), rounded: Math.abs(Number(scaled.toFixed(digits))) };
  };
  // 999,999 rounds to 1,000K: that's 1M.
  if (shown(at).rounded >= 1000 && at < units.length - 1) at++;
  return `${shown(at).text}${units[at]![1]}`;
}
