import { plainLine, plainText, moneyLabel, visibleText } from "@invincible/core";
import type { StateLook } from "../../../../apps/web/src/lib/agent-state.ts";
import { type StepGroup, workedFor } from "../../../../apps/web/src/lib/steps.ts";
import type { WorkRow } from "../../../../apps/web/src/lib/work.ts";
import { type ProofJson, reasonOf } from "./proof.ts";
import type { BoardView, Section } from "./view.ts";

/*
 * What inv prints for people (docs/CLI.md, "Output"). In a terminal: the state words in their colours (amber needs
 * you, red failed, blue at work, green verified, grey queued or stopped), frames, and lines cut to its width. Piped (or
 * with NO_COLOR): the same lines, plain, with no escape code and nothing cut. Nothing here blinks, rings or moves: what
 * is drawn changes only when what it shows does. Every word a model or a device wrote goes through core's plain text,
 * and an operation that waits for your approval is shown exactly (visibleText).
 */

export interface Style {
  color: boolean;
  /** A terminal's columns; null when piped (nothing is cut). */
  width: number | null;
}

export function styleFor(out: { isTTY?: boolean; columns?: number }, env: Record<string, string | undefined>): Style {
  const tty = out.isTTY === true;
  return { color: tty && !env.NO_COLOR && env.TERM !== "dumb", width: tty ? Math.max(40, out.columns ?? 80) : null };
}

export const PLAIN: Style = { color: false, width: null };

type Tone = StateLook["tone"];
const SGR: Readonly<Record<Tone, string>> = { needs: "33", failed: "31", work: "34", ok: "32", neutral: "90" };
export const paint = (style: Style, tone: Tone, text: string): string => (style.color && text ? `\x1b[${SGR[tone]}m${text}\x1b[39m` : text);
export const strong = (style: Style, text: string): string => (style.color && text ? `\x1b[1m${text}\x1b[22m` : text);
export const faint = (style: Style, text: string): string => (style.color && text ? `\x1b[2m${text}\x1b[22m` : text);

/** Columns a text takes in a terminal (its escape codes none, a wide character two). */
export const columns = (text: string): number => Bun.stringWidth(text);

/** An escape code that colours what follows (a terminal acts on it; it takes no column). */
const SGR_AT = /\x1b\[[0-9;]*m/y;

/** At most `room` columns of it, cut with an ellipsis; a colour it began is ended where it is cut. */
export function fit(text: string, room: number): string {
  if (room <= 0) return "";
  if (columns(text) <= room) return text;
  let out = "";
  let used = 0;
  let coloured = false;
  for (let i = 0; i < text.length; ) {
    SGR_AT.lastIndex = i;
    const code = SGR_AT.exec(text);
    if (code) {
      out += code[0];
      coloured = true;
      i += code[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const wide = columns(char);
    if (used + wide > room - 1) break;
    out += char;
    used += wide;
    i += char.length;
  }
  return `${out}…${coloured ? "\x1b[0m" : ""}`;
}

const pad = (text: string, room: number): string => text + " ".repeat(Math.max(0, room - columns(text)));

/** A time of day, as a person reads one: 14:02. */
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

// ---- rows ----------------------------------------------------------------------------------------------------------

/** What a row says after its word: its title, then its agent and what it is doing or came to. */
const who = (row: WorkRow): string => plainLine(`${row.agent.name}${row.detail ? ` · ${row.detail}` : ""}`);

/** One task as a line: its word in its state's colour, its title, its agent and detail, how long since it moved, its id. */
export function rowLine(row: WorkRow, style: Style, wordRoom = 0): string {
  const title = plainLine(row.title);
  const age = row.age ?? "";
  if (style.width === null) return `  ${[row.word, title, who(row), age, row.id].filter(Boolean).join("  ")}`;
  // In a terminal: the title takes what is left after the word, its agent and detail (a quarter of the width, 28 at
  // most), its age and its id, two columns between each, within the width less one. On a narrow one the id goes
  // first, then the agent.
  const word = pad(row.word, wordRoom);
  const agentRoom = Math.min(28, Math.floor(style.width / 4));
  const room = style.width - 1 - (2 + columns(word) + 2) - (2 + 4);
  const withId = room - (2 + agentRoom) - (2 + row.id.length) >= 16;
  const withAgent = room - (2 + agentRoom) >= 16;
  const titleRoom = room - (withAgent ? 2 + agentRoom : 0) - (withId ? 2 + row.id.length : 0);
  const parts = [`  ${paint(style, row.tone, word)}  ${pad(fit(title, titleRoom), titleRoom)}`];
  if (withAgent) parts.push(faint(style, pad(fit(who(row), agentRoom), agentRoom)));
  parts.push(pad(age, 4));
  if (withId) parts.push(faint(style, row.id));
  return fit(parts.join("  ").trimEnd(), style.width - 1);
}

const TITLES: Readonly<Record<Section, string>> = { needs: "NEEDS YOU", active: "ACTIVE", working: "WORKING", done: "DONE" };

/** How many of the settled rows the board shows (the rest: inv tasks --done). */
export const DONE_SHOWN = 5;

// ---- the board -----------------------------------------------------------------------------------------------------

export function boardLines(view: BoardView, style: Style, opts: { doneShown?: number } = {}): string[] {
  const out: string[] = [];
  // (A terminal's board keeps a column of margin; piped lines start at the first.)
  const margin = style.width === null ? "" : " ";
  const nodes = view.nodes.map((node) => `${node.online ? "●" : "○"} ${node.name}`).join("  ");
  const cost = view.cost ? `${view.cost.complete ? "" : "at least "}${moneyLabel(view.cost.usd)} today` : "";
  const line = view.primary.needs ? paint(style, "needs", view.primary.line) : view.primary.line;
  const left = `${strong(style, view.primary.name)} · ${line}`;
  if (style.width === null) {
    const nodesWords = view.nodes.map((node) => `${node.name} (${node.online ? "online" : "offline"}${node.self ? ", this one" : ""})`).join(", ");
    out.push([left, nodesWords ? `nodes: ${nodesWords}` : "", cost].filter(Boolean).join(" · "));
  } else {
    const right = [nodes, cost].filter(Boolean).join("    ");
    // (One column of margin each side: the line is the terminal's width less one.)
    const gap = style.width - 2 - columns(left) - columns(right);
    out.push(gap >= 2 ? ` ${left}${" ".repeat(gap)}${faint(style, right)}` : ` ${fit(left, style.width - 1)}`);
    out.push(faint(style, ` ${"─".repeat(style.width - 2)}`));
  }
  const all = [...view.work.needs, ...view.work.active, ...view.work.working, ...view.work.done];
  const wordRoom = style.width === null ? 0 : Math.min(18, Math.max(0, ...all.map((row) => columns(row.word))));
  const doneShown = opts.doneShown ?? DONE_SHOWN;
  let any = false;
  for (const section of ["needs", "active", "working", "done"] as const) {
    const rows = view.work[section];
    const extra = section === "needs" ? view.beyond : 0;
    if (!rows.length && !extra) continue;
    any = true;
    const shown = section === "done" ? rows.slice(0, doneShown) : rows;
    const count = section === "done" && rows.length > shown.length ? ` · ${rows.length}` : "";
    out.push(`${margin}${strong(style, TITLES[section])}${faint(style, count)}`);
    for (const row of shown) out.push(rowLine(row, style, wordRoom));
    if (extra) out.push(`  ${paint(style, "needs", pad("Allow?", wordRoom))}  ${extra} more ${extra === 1 ? "waits" : "wait"} for your approval: inv asks`);
    if (section === "done" && rows.length > shown.length) out.push(faint(style, `  ${rows.length - shown.length} more: inv tasks --done`));
  }
  if (!any) out.push(`${margin}No tasks yet. Each task you or your agent give an agent is a row here: what needs you first, then what is new, at work, and done.`, `${margin}inv give "…" gives one.`);
  if (style.width !== null) {
    out.push(faint(style, ` ${"─".repeat(style.width - 2)}`));
    out.push(faint(style, ' inv give "…" · inv asks · inv watch <task> · inv proof <task> · Ctrl-C leaves'));
  }
  // (In a terminal no line is wider than it, less one: the board is drawn again in place, and a folded line would move it.)
  return style.width === null ? out : out.map((line) => fit(line, style.width! - 1));
}

/** Rows by section, as `inv tasks` prints them. */
export function taskLines(sections: readonly { section: Section; rows: readonly WorkRow[] }[], style: Style): string[] {
  const out: string[] = [];
  const all = sections.flatMap((s) => s.rows);
  const wordRoom = style.width === null ? 0 : Math.min(18, Math.max(0, ...all.map((row) => columns(row.word))));
  for (const { section, rows } of sections) {
    if (!rows.length) continue;
    out.push(`${strong(style, TITLES[section])}${faint(style, ` · ${rows.length}`)}`);
    for (const row of rows) out.push(rowLine(row, style, wordRoom));
  }
  if (!all.length) out.push("No tasks here.");
  return style.width === null ? out : out.map((line) => fit(line, style.width! - 1));
}

// ---- frames --------------------------------------------------------------------------------------------------------

/** Lines in a frame of its own, its head in the top rule, in a terminal; plain lines, the head first, piped. */
export function framed(head: string, body: readonly string[], style: Style, tone: Tone = "neutral", foot = ""): string[] {
  if (style.width === null) return [head, ...body.map((line) => `  ${line}`), ...(foot ? [`  ${foot}`] : [])];
  // Each line is its inner width and five more: never wider than the terminal less one, so none is ever folded.
  const inner = Math.min(style.width - 6, Math.max(40, columns(head) + 4, columns(foot) + 4, ...body.map(columns)));
  const top = fit(head, inner - 2);
  const bottom = fit(foot, inner - 2);
  return [
    `┌─ ${paint(style, tone, top)} ${"─".repeat(Math.max(0, inner - 1 - columns(top)))}┐`,
    ...body.map((line) => `│ ${pad(fit(line, inner), inner)} │`),
    bottom ? `└${"─".repeat(Math.max(0, inner - columns(bottom) - 1))} ${faint(style, bottom)} ─┘` : `└${"─".repeat(inner + 2)}┘`,
  ].map((line) => ` ${line}`);
}

const secs = (ms: number | null): string => (ms === null ? "" : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** The proof's head, in a word or two and why. */
export function proofHead(proof: ProofJson): { text: string; tone: Tone } {
  const failing = proof.gates.findIndex((gate) => gate.exit !== null && gate.exit !== 0);
  const word: Record<ProofJson["state"], [string, Tone]> = {
    // (Proven, as the apps say it and as its `word` does: it said "Verified" until 27 November 2026.)
    verified: ["Proven", "ok"],
    // (The apps' words for these too: "Finished without proof" and "Not verified" until 27 November 2026.)
    unproven: ["Reviewed, not proven", "needs"],
    failed: [`Failed · gate ${failing + 1}${proof.gates.length > 1 ? ` of ${proof.gates.length}` : ""}`, "failed"],
    rejected: ["Sent back", "failed"],
    stopped: ["Stopped", "neutral"],
    "needs-you": [proof.word, "needs"],
    working: [proof.word, "work"],
    queued: ["Queued", "neutral"],
    error: ["Failed", "failed"],
  };
  const [text, tone] = word[proof.state];
  return { text: `${text} · ${reasonOf(proof)}`, tone };
}

/** What a gate's line says after its exit: whether it shows the work. */
function gateNote(gate: ProofJson["gates"][number]): string {
  if (gate.exit === null) return "not run in its last round";
  if (gate.exit !== 0) return "failed";
  if (gate.before === null) return "";
  return gate.before === 0 ? "passed before the work too: proves nothing" : "failed before the work: it shows the work ✓";
}

export function proofLines(proof: ProofJson, style: Style): string[] {
  const head = proofHead(proof);
  const body: string[] = [];
  const cmdRoom = Math.min(48, Math.max(0, ...proof.gates.map((gate) => columns(gate.cmd))));
  // (What a gate's note says is what matters most: where its line won't fit the frame, the note goes under it.)
  const room = style.width === null ? Number.POSITIVE_INFINITY : style.width - 6;
  for (const gate of proof.gates) {
    const exit = gate.exit === null ? "" : `exit ${gate.exit}${gate.ms === null ? "" : ` · ${secs(gate.ms)}`}`;
    const line = `gate    ${pad(fit(plainLine(gate.cmd), cmdRoom), cmdRoom)}  ${pad(exit, 16)}${gateNote(gate)}`.trimEnd();
    if (columns(line) <= room) body.push(line);
    else body.push(`gate    ${fit(plainLine(gate.cmd), Math.max(8, room - 26))}  ${exit}`.trimEnd(), `        ${gateNote(gate)}`);
  }
  if (!proof.gates.length) body.push("gate    none: no command shows the work");
  if (proof.review) body.push(`review  ${proof.review.verdict === "pass" ? "passed it" : "sent it back"}${proof.review.sameModel ? ", by the model that did the work" : ""}${proof.review.notes ? ` · ${proof.review.notes} ${proof.review.notes === 1 ? "note" : "notes"}` : ""}`);
  else body.push("review  none yet");
  // What it was told as it ran, whose words, and what the review judged the work against: steered work is proven against its steers.
  if (proof.steers.length) {
    const n = proof.steers.length;
    const reached = proof.steers.filter((steer) => steer.step !== null).length;
    const whose = proof.steers.every((steer) => steer.by === "owner") ? "yours" : proof.steers.every((steer) => steer.by === "primary") ? "your agent's" : "yours and your agent's";
    // (Measured against those that reached the work: one that never did was judged by no one.)
    const judged = !proof.review
      ? "no review yet"
      : proof.review.steers === 0
        ? `its review came before ${reached === 1 ? "it" : "them"}`
        : proof.review.steers >= reached
          ? `the review judged the work against ${reached === 1 ? "it" : "them, in order"}`
          : `the review judged the work against ${proof.review.steers} of them`;
    const never = n - reached;
    const ending = !reached ? (n === 1 ? "it never reached the work" : "none of them reached the work") : `${judged}${never ? ` · ${never} never reached it` : ""}`;
    body.push(`steered ${n === 1 ? "once" : `${n} times`}, ${whose} · ${ending}`);
  }
  if (proof.changes) body.push(`change  ${proof.changes.files} ${proof.changes.files === 1 ? "file" : "files"} · kept as ${proof.changes.artifact}`);
  const money = proof.costUsd === null ? null : `${proof.costComplete ? "" : "at least "}${moneyLabel(proof.costUsd)}`;
  const spend = money ? (proof.budgetUsd !== null ? `${money} of ${moneyLabel(proof.budgetUsd)}` : money) : proof.budgetUsd !== null ? `budget ${moneyLabel(proof.budgetUsd)}` : null;
  const cost = [spend, proof.ms !== null ? workedFor(proof.ms) : null].filter(Boolean).join(" · ");
  if (cost) body.push(`cost    ${cost}`);
  body.push(`task    ${proof.task} · ${plainLine(proof.title)}`);
  body.push(`by      ${proof.agent}${proof.node ? ` on ${proof.node}` : ""}${proof.project ? ` · ${proof.project}` : ""}`);
  const next: Partial<Record<ProofJson["state"], string>> = { failed: `inv again ${proof.task}`, rejected: `inv again ${proof.task}`, stopped: `inv again ${proof.task}`, error: `inv again ${proof.task}`, working: `inv watch ${proof.task}`, queued: `inv watch ${proof.task}`, "needs-you": `inv peek ${proof.task}` };
  const lines = framed(head.text, body, style, head.tone, next[proof.state] ?? "");
  if (proof.said) lines.push(`${style.width === null ? "" : " "}${proof.agent} said: “${proof.said}”  ${faint(style, "its words, not proof")}`);
  return lines;
}

// ---- asks ----------------------------------------------------------------------------------------------------------

/** What waits for your answer, as `inv asks` lists it (docs/CLI.md, "The objects --json prints"). */
export interface AskView {
  id: string;
  kind: "approval" | "proposal";
  op: string;
  inputs: Record<string, unknown>;
  class: string;
  /** Who asks: an agent's handle, your agent ("primary"), a loop, you. */
  by: string;
  task: string | null;
  title: string | null;
  why: string | null;
  expires: number | null;
  /** How many characters in it can't be seen (each shown as ⟨U+…⟩). */
  hidden: number;
}

/** An input's value as it is: text whole, its lines kept and what can't be seen shown; anything else as JSON. */
function shown(value: unknown): { text: string; hidden: string[] } {
  return visibleText(typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));
}

/** The characters an ask holds that can't be seen, each once. */
export function hiddenIn(ask: Pick<AskView, "op" | "inputs">): string[] {
  const all = new Set<string>(visibleText(ask.op).hidden);
  for (const [key, value] of Object.entries(ask.inputs)) for (const char of [...visibleText(key).hidden, ...shown(value).hidden]) all.add(char);
  return [...all];
}

export function askLines(ask: AskView, style: Style): string[] {
  const label = (char: string) => visibleText(char).text;
  const head = `${plainLine(ask.by)} asks${ask.task ? ` · task ${ask.task}${ask.title ? ` “${plainLine(ask.title)}”` : ""}` : ""}`;
  const body: string[] = [];
  if (ask.kind === "proposal") body.push("to start a task it proposed");
  else body.push(`${visibleText(ask.op).text} (${ask.class})`);
  for (const [key, value] of Object.entries(ask.inputs)) {
    const [first = "", ...more] = shown(value).text.split("\n");
    body.push(`  ${visibleText(key).text}: ${first}`);
    for (const line of more) body.push(`    ${line}`);
  }
  const hidden = hiddenIn(ask);
  if (hidden.length) body.push(paint(style, "needs", `⚠ ${hidden.length} ${hidden.length === 1 ? "character" : "characters"} you can't see, shown as ${hidden.map(label).join(", ")}`));
  if (ask.why) body.push(`why: ${plainLine(ask.why)}`);
  if (ask.expires) body.push(faint(style, `answer by ${clock(ask.expires)}, or it is no`));
  // How to answer it, a line each, so neither is ever cut in a narrow terminal.
  if (ask.kind === "proposal") body.push(`inv allow ${ask.id} starts it · inv deny ${ask.id} "why"`);
  else body.push(`inv allow ${ask.id}${ask.task ? " [--for-task]" : ""}`, `inv deny ${ask.id} "why"`);
  return framed(head, body, style, "needs");
}

// ---- the work as it goes -------------------------------------------------------------------------------------------

const MARK: Readonly<Record<StepGroup["tone"], [string, Tone]>> = { ok: ["✓", "ok"], failed: ["✗", "failed"], warn: ["!", "needs"], neutral: ["·", "neutral"] };

/** A step of the work, folded (lib/steps.ts' stepGroups): "Ran 4 commands · 1 failed", "Gate 1 of 2 · passed · bun test". */
export function stepLine(group: StepGroup, style: Style): string {
  const [mark, tone] = MARK[group.tone];
  const what = group.kind === "gate" && group.items[0] ? `${group.text} · ${plainLine(group.items[0].text)}` : plainLine(group.text);
  const line = `${paint(style, tone, mark)} ${group.tone === "neutral" ? faint(style, what) : what}`;
  return style.width === null ? line : fit(` ${line}`, style.width - 1);
}

/** What it is doing now, in one line that stays put: a still ● (nothing here moves), what, and since when. */
export function liveLine(step: { text: string; since: number }, style: Style): string {
  const line = `${paint(style, "work", "●")} ${plainLine(step.text)} ${faint(style, `· since ${clock(step.since)}`)}`;
  return style.width === null ? line : fit(` ${line}`, style.width - 1);
}

/** The last lines of a task's trail, each with its time. */
export function trailLines(entries: readonly { at: number; text: string }[], style: Style): string[] {
  return entries.map((entry) => {
    const [first = "", ...rest] = plainText(entry.text).trimEnd().split("\n");
    return [`${faint(style, new Date(entry.at).toTimeString().slice(0, 8))}  ${first}`, ...rest.slice(0, 3).map((line) => `          ${faint(style, line)}`)].join("\n");
  });
}
