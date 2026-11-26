import { costOf, type Prices, spendTotal, type UsageLine, usdLabel } from "@galahad/core/spend";
import type { TeamTask, TeamTrailEntry } from "@galahad/core/team";

/*
 * A task's work, folded (T3 Code's "Worked for 2m 14s ›", its steps grouped: "Read 6 files", "Edited 3 files", "Ran 4
 * commands"), and what proves it, told apart from what its knight says: each gate's command and how it ended, and the
 * reviewer's verdict, as the runner wrote them on the task's trail (POST /api/team/trail), never the knight's own account.
 * Pure (no DOM), from the trail's lines as the node keeps them (the node's team-runtime.ts progress(): each line starts
 * with its step's mark, "Running · …", "Exit 0 · …", "Gate 1/2 · exit 0 · …", "Review · pass"). The iPhone, iPad, Mac
 * and Android apps port this.
 */

export type StepKind = "plan" | "read" | "edit" | "run" | "submitted" | "gate" | "review" | "note";
export type StepTone = "neutral" | "ok" | "failed" | "warn";

/** One line of the work, folded: a step of its own (its plan, a gate, the review, a note), or a run of steps alike. */
export interface StepGroup {
  kind: StepKind;
  /** The line it folds to: "Read 6 files in packages/link", "Edited sync.ts and resume.ts", "Ran 4 commands · 1 failed". */
  text: string;
  /** What is in it, a line each (a command or a path, set in mono), with each command's exit where it is known. */
  items: { text: string; exit: number | null }[];
  tone: StepTone;
  /** The trail's numbers it spans, and when it began. */
  from: number;
  to: number;
  at: number;
}

export interface WorkSummary {
  /** From its first line to its last (or the runner's record of when it began and ended, where there is one). */
  ms: number;
  commands: number;
  failed: number;
  /** Files it read, and files it edited or wrote, each counted once. */
  read: number;
  edited: number;
}

export type GateState = "passed" | "failed" | "running" | "waiting";

export interface GateRow {
  command: string;
  state: GateState;
  exit: number | null;
  /** How long it took, from the line before its result to its result (null: not run in this round). */
  ms: number | null;
  /** What it printed, its first line that says anything. */
  said: string;
  /** How it exited before any work (the gates run first): 0 means it passed already, so it shows nothing about the work. */
  before: number | null;
}

export interface Review {
  verdict: "pass" | "revise";
  notes: string;
  at: number;
}

/** A trail line read: its mark and what follows it. */
type Line =
  | { kind: "plan"; text: string }
  | { kind: "command"; command: string }
  | { kind: "exit"; code: number }
  | { kind: "gate"; index: number; of: number; exit: number; command: string; output: string }
  | { kind: "gates"; commands: string[] }
  | { kind: "gated" }
  | { kind: "baseline"; exits: number[] }
  | { kind: "submitted"; summary: string }
  | { kind: "review"; verdict: "pass" | "revise"; notes: string }
  | { kind: "thought" }
  | { kind: "note"; text: string; tone: StepTone };

const NOTE_TONE: Readonly<Record<string, StepTone>> = {
  Tripwire: "warn", Check: "neutral", Audit: "neutral", Budget: "warn", Retry: "neutral", Escalated: "warn", Routed: "neutral",
  "Tests changed": "warn", Contract: "neutral", Steps: "neutral", Lease: "warn", "No command to run": "neutral", Review: "warn",
};

/** A line of the trail, read by its mark. */
function read(text: string): Line {
  const [head = "", ...rest] = text.split("\n");
  const body = rest.join("\n");
  const at = head.indexOf(" · ");
  const mark = at < 0 ? head : head.slice(0, at);
  const said = at < 0 ? "" : head.slice(at + 3);
  switch (mark) {
    case "Plan": return { kind: "plan", text: [said, body].filter(Boolean).join("\n") };
    case "Running": return { kind: "command", command: [said, body].filter(Boolean).join("\n") };
    case "Thinking": return { kind: "thought" };
    case "Submitted for review": return { kind: "submitted", summary: said };
    case "Gates before the work": return { kind: "baseline", exits: [said, ...rest].map((line) => /^\d+\. exit (-?\d+) · /.exec(line)?.[1]).filter((exit): exit is string => exit !== undefined).map(Number) };
  }
  const exit = /^Exit (-?\d+)$/.exec(mark);
  if (exit) return { kind: "exit", code: Number(exit[1]) };
  const gate = /^Gate (\d+)\/(\d+)$/.exec(mark);
  const gateRest = /^exit (-?\d+) · ([\s\S]*)$/.exec(said);
  if (gate && gateRest) return { kind: "gate", index: Number(gate[1]), of: Number(gate[2]), exit: Number(gateRest[1]), command: gateRest[2]!, output: body };
  if (mark === "Gates") {
    // "Gates · 1. bun test\n2. bun run typecheck" (the list), or "Gates · all 2 passed" / "1 of 2 failed: back to the work".
    const listed = [said, ...rest].map((line) => /^\d+\. ([\s\S]+)$/.exec(line)?.[1]).filter((command): command is string => command !== undefined);
    return listed.length ? { kind: "gates", commands: listed } : { kind: "gated" };
  }
  if (mark === "Review" && (said === "pass" || said === "revise")) return { kind: "review", verdict: said, notes: body.trim() };
  return { kind: "note", text: head, tone: NOTE_TONE[mark] ?? "neutral" };
}

/** A shell word at the start of `text` ('quoted', as the tools quote a path, or bare), and what follows it. */
function word(text: string): { word: string; rest: string } | null {
  if (text.startsWith("'")) {
    let out = "";
    let i = 1;
    for (;;) {
      const close = text.indexOf("'", i);
      if (close < 0) return null;
      out += text.slice(i, close);
      // '\'' is a quote inside a quoted word.
      if (text.startsWith("\\''", close + 1)) {
        out += "'";
        i = close + 4;
        continue;
      }
      return { word: out, rest: text.slice(close + 1) };
    }
  }
  const bare = /^(\S+)([\s\S]*)$/.exec(text);
  return bare ? { word: bare[1]!, rest: bare[2]! } : null;
}

/** What a command was, as the knight's own tools say their calls (engineer-tools.ts): a file read, edited or written, or
 * a command run. */
export function commandKind(command: string): { kind: "read" | "edit" | "run"; path: string | null } {
  const reading = /^sed -n '\d+,\d+p' ([\s\S]+)$/.exec(command);
  if (reading) {
    const path = word(reading[1]!);
    if (path && !path.rest.trim()) return { kind: "read", path: path.word };
  }
  const editing = /^edit ([\s\S]+)$/.exec(command);
  if (editing) {
    const path = word(editing[1]!);
    if (path && /^( --all)? <<'/.test(path.rest)) return { kind: "edit", path: path.word };
  }
  const writing = /^cat > ([\s\S]+)$/.exec(command);
  if (writing) {
    const path = word(writing[1]!);
    if (path && /^ <<'/.test(path.rest)) return { kind: "edit", path: path.word };
  }
  return { kind: "run", path: null };
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";
const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) || path;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The folder every path is in, under the task's own workspace (null: none in common, or only the workspace itself). */
function commonFolder(paths: readonly string[]): string | null {
  const parts = paths.map((path) => path.replace(/^\/work\/tasks\/task-[a-z0-9_-]{12}\//, "").split("/").slice(0, -1));
  if (!parts.length) return null;
  const shared: string[] = [];
  for (let i = 0; parts.every((p) => i < p.length && p[i] === parts[0]![i]); i++) shared.push(parts[0]![i]!);
  const folder = shared.join("/");
  return folder && folder !== "/" ? folder : null;
}

/** Names, as a sentence: "a.ts", "a.ts and b.ts", "a.ts, b.ts and c.ts"; more than three are counted. */
function named(names: readonly string[]): string {
  if (names.length > 3) return "";
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function groupText(kind: "read" | "edit" | "run", items: { text: string; exit: number | null; path: string | null }[]): { text: string; tone: StepTone } {
  if (kind === "run") {
    const failed = items.filter((item) => item.exit !== null && item.exit !== 0).length;
    const text = items.length === 1 ? `Ran ${firstLine(items[0]!.text)}` : `Ran ${plural(items.length, "command")}`;
    return { text: failed ? `${text} · ${failed === items.length && items.length === 1 ? "failed" : `${failed} failed`}` : text, tone: failed ? "warn" : "neutral" };
  }
  const paths = [...new Set(items.map((item) => item.path ?? item.text))];
  const names = named(paths.map(baseName));
  const folder = commonFolder(paths);
  const verb = kind === "read" ? "Read" : "Edited";
  return { text: names ? `${verb} ${names}` : `${verb} ${plural(paths.length, "file")}${folder ? ` in ${folder}` : ""}`, tone: "neutral" };
}

/**
 * The work, folded: steps alike in a row become one group (reads, edits, commands), and the plan, each gate, the review
 * and each note of the runner's stand alone, in the order they happened. What the knight thought aloud is not a step.
 */
export function stepGroups(entries: readonly TeamTrailEntry[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let open: (StepGroup & { kind: "read" | "edit" | "run"; raw: { text: string; exit: number | null; path: string | null }[] }) | null = null;
  const close = () => {
    if (!open) return;
    const { raw, ...group } = open;
    groups.push({ ...group, ...groupText(open.kind, raw), items: raw.map(({ text, exit }) => ({ text, exit })) });
    open = null;
  };
  for (const entry of entries) {
    const line = read(entry.text);
    if (line.kind === "thought" || line.kind === "gates" || line.kind === "gated" || line.kind === "baseline") continue;
    if (line.kind === "exit") {
      const last = open?.raw.at(-1);
      if (last && last.exit === null) {
        last.exit = line.code;
        open!.to = entry.n;
      }
      continue;
    }
    if (line.kind === "command") {
      const what = commandKind(line.command);
      if (!open || open.kind !== what.kind) {
        close();
        open = { kind: what.kind, text: "", items: [], tone: "neutral", from: entry.n, to: entry.n, at: entry.at, raw: [] };
      }
      open.raw.push({ text: what.kind === "run" ? firstLine(line.command) : (what.path ?? line.command), exit: null, path: what.path });
      open.to = entry.n;
      continue;
    }
    close();
    const one = (kind: StepKind, text: string, tone: StepTone, items: StepGroup["items"] = []) => groups.push({ kind, text, items, tone, from: entry.n, to: entry.n, at: entry.at });
    if (line.kind === "plan") one("plan", "Planned the work", "neutral", line.text.split("\n").filter((l) => l.trim()).map((text) => ({ text: text.trim(), exit: null })));
    else if (line.kind === "submitted") one("submitted", "Submitted it for its gates and review", "neutral");
    else if (line.kind === "gate") one("gate", `Gate ${line.index} of ${line.of} · ${line.exit === 0 ? "passed" : `failed, exit ${line.exit}`}`, line.exit === 0 ? "ok" : "failed", [{ text: line.command, exit: line.exit }]);
    else if (line.kind === "review") one("review", line.verdict === "pass" ? "The reviewer passed it" : "The reviewer sent it back", line.verdict === "pass" ? "ok" : "warn", line.notes ? [{ text: firstLine(line.notes), exit: null }] : []);
    else if (line.kind === "note") one("note", line.text, line.tone);
  }
  close();
  return groups;
}

/** What the work came to in figures, for its folded line ("Worked for 6m 12s · ran 14 commands · edited 5 files"). */
export function workSummary(entries: readonly TeamTrailEntry[], record?: { startedAt: number; endedAt: number } | null): WorkSummary {
  let commands = 0;
  let failed = 0;
  const read_ = new Set<string>();
  const edited = new Set<string>();
  let last: { kind: "read" | "edit" | "run" } | null = null;
  for (const entry of entries) {
    const line = read(entry.text);
    if (line.kind === "command") {
      const what = commandKind(line.command);
      last = what;
      if (what.kind === "read") read_.add(what.path!);
      else if (what.kind === "edit") edited.add(what.path!);
      else commands++;
    } else if (line.kind === "exit" && last?.kind === "run" && line.code !== 0) {
      failed++;
      last = null;
    }
  }
  const ms = record ? Math.max(0, record.endedAt - record.startedAt) : entries.length > 1 ? Math.max(0, entries.at(-1)!.at - entries[0]!.at) : 0;
  return { ms, commands, failed, read: read_.size, edited: edited.size };
}

/** A span of work as its folded line says it: "42s", "6m 12s", "1h 04m". */
export function workedFor(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The folded line's figures after its time, as words: "ran 14 commands · edited 5 files". */
export function summaryWords(summary: WorkSummary): string {
  return [summary.commands ? `ran ${plural(summary.commands, "command")}` : null, summary.edited ? `edited ${plural(summary.edited, "file")}` : summary.read ? `read ${plural(summary.read, "file")}` : null].filter(Boolean).join(" · ");
}

/**
 * Each of a task's gates (`gates`: its commands, yours first) as its latest round left it, from the runner's lines:
 * passed or failed with its exit and how long it took; running (the first without a result, while the task is at work
 * and has been submitted); or waiting. With how each exited before any work: a gate that passed then shows nothing.
 */
export function gateRows(gates: readonly string[], entries: readonly TeamTrailEntry[], running: boolean): GateRow[] {
  // The gates as the runner knows them (yours, and the planner's own), where its trail lists them.
  let commands = [...gates];
  let before: number[] = [];
  let round = -1;
  entries.forEach((entry, i) => {
    const line = read(entry.text);
    if (line.kind === "gates") commands = line.commands;
    else if (line.kind === "baseline") before = line.exits;
    else if (line.kind === "submitted") round = i;
  });
  const results = new Map<number, { exit: number; ms: number; said: string }>();
  let lastAt = round >= 0 ? entries[round]!.at : 0;
  if (round >= 0) {
    for (const entry of entries.slice(round + 1)) {
      const line = read(entry.text);
      if (line.kind === "gate") {
        results.set(line.index - 1, { exit: line.exit, ms: Math.max(0, entry.at - lastAt), said: firstSaid(line.output) });
        lastAt = entry.at;
      }
    }
  }
  const submitted = round >= 0;
  let next = running && submitted;
  return commands.map((command, i) => {
    const result = results.get(i);
    const exitBefore = before[i] ?? null;
    if (result) return { command, state: result.exit === 0 ? "passed" : "failed", exit: result.exit, ms: result.ms, said: result.said, before: exitBefore };
    const state: GateState = next ? "running" : "waiting";
    next = false;
    return { command, state, exit: null, ms: null, said: "", before: exitBefore };
  });
}

/** The first line of what a command printed that says something (not its exit, not "stderr:"). */
function firstSaid(output: string): string {
  return output.split("\n").map((line) => line.trim()).find((line) => line && line !== "stderr:" && line !== "(no output)" && !/^exit -?\d+$/.test(line))?.slice(0, 200) ?? "";
}

/** The reviewer's latest verdict, as the runner wrote it (null: no review yet). */
export function reviewOf(entries: readonly TeamTrailEntry[]): Review | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = read(entries[i]!.text);
    if (line.kind === "review") return { verdict: line.verdict, notes: line.notes, at: entries[i]!.at };
  }
  return null;
}

/** Whether the review was by the same model that did the work after all (no other reviewer model could answer). */
export const sameModelReview = (entries: readonly TeamTrailEntry[]): boolean => entries.some((entry) => entry.text.startsWith("Review · by the same model"));

/** What a running task is doing this moment, as its live line says it: the command it runs (and since when), or the step. */
export function liveStep(entries: readonly TeamTrailEntry[]): { text: string; command: boolean; since: number } | null {
  const last = entries.at(-1);
  if (!last) return null;
  const line = read(last.text);
  if (line.kind === "command") return { text: firstLine(line.command), command: true, since: last.at };
  if (line.kind === "submitted") return { text: "Running its gates", command: false, since: last.at };
  if (line.kind === "gate") return { text: line.index < line.of ? `Running gate ${line.index + 1} of ${line.of}` : "The reviewer is reading it", command: false, since: last.at };
  if (line.kind === "plan") return { text: "Starting on its plan", command: false, since: last.at };
  if (line.kind === "review") return { text: line.verdict === "pass" ? "Keeping its changes" : "Back to the work", command: false, since: last.at };
  if (line.kind === "exit") return { text: "Reading what it printed", command: false, since: last.at };
  if (line.kind === "thought") return { text: "Thinking", command: false, since: last.at };
  return { text: "Working", command: false, since: last.at };
}

/** What proves a task, in one place: its gates as they stand, the reviewer's state, and the two ways a pass can say
 * less than it seems (a review by the model that did the work; gates that passed before any work). */
export interface Proof {
  gates: GateRow[];
  passed: number;
  review: Review | null;
  /** passed or sent back: its verdict; reading: every gate of this round passed and the work is with it; waits: the
   * gates come first; none: it never got there. */
  reviewer: "passed" | "sent back" | "reading" | "waits" | "none";
  sameModel: boolean;
  /** Every gate passed before any work: none of them shows the work was done, and the reviewer decided alone. */
  provesNothing: boolean;
}

export function proofOf(task: Pick<TeamTask, "gates" | "status">, entries: readonly TeamTrailEntry[]): Proof {
  const running = task.status === "running";
  const gates = gateRows(task.gates, entries, running);
  const passed = gates.filter((gate) => gate.state === "passed").length;
  const review = reviewOf(entries);
  const reviewer = review ? (review.verdict === "pass" ? "passed" : "sent back") : !running ? "none" : gates.length && passed === gates.length ? "reading" : "waits";
  const provesNothing = gates.length > 0 && gates.every((gate) => gate.before === 0);
  return { gates, passed, review, reviewer, sameModel: sameModelReview(entries), provesNothing };
}

/**
 * What a task cost, in a line: its money at your prices (a lower bound with "at least" when a call went uncounted, "no
 * price" when a model that answered has none) against its budget, and how long it ran, as the runner recorded it.
 * Before it has ended, its budget alone (the runner records its spend at the end).
 */
export function costWords(task: Pick<TeamTask, "record" | "budgetUsd">, prices: Prices): string {
  const budget = task.budgetUsd !== undefined ? usdLabel(task.budgetUsd) : null;
  if (!task.record) return budget ? `budget ${budget}` : "";
  const total = spendTotal(task.record.spent as readonly UsageLine[]);
  const cost = costOf(task.record.spent as readonly UsageLine[], prices);
  const money = !total.calls ? null : total.unknown === total.calls ? "spend unknown" : cost.unpriced.length ? "no price" : `${cost.complete ? "" : "at least "}${usdLabel(cost.usd)}`;
  const spent = money ? (budget ? `${money} of ${budget}` : money) : budget ? `budget ${budget}` : !total.calls ? "no model calls" : null;
  return [spent, workedFor(task.record.endedAt - task.record.startedAt)].filter(Boolean).join(" · ");
}
