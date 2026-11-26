import { createHash } from "node:crypto";
import { type ClientCall, type ExecResult, redact } from "@galahad/core";
import type { ToolSpec } from "./adapters.ts";

/*
 * The engineer's own tools (QuestOptions.tools): a shell, and a file's reading, editing and writing, called as tools and
 * several in a turn, as the coding agents that do best work (OpenCode, Claude Code, Codex), in place of one shell
 * command a reply. Each runs in the quest's sandbox through the one thing a quest has there, a shell command
 * (QuestDeps.exec), and each is said as a shell command: what your tripwires, checks and tells are matched against, and
 * what the reviewer reads. A file goes in and out as base64, so its bytes are never read as anything else.
 */

type Exec = (command: string, timeoutSec: number) => Promise<ExecResult>;

/** At most this many lines in one read, and this many characters of a line. */
export const READ_LINES = 2_000;
const LINE_CHARS = 2_000;
/** At most this many characters of a file in one read: the rest is read on from where it stopped. */
const READ_CHARS = 100_000;
/** A file's bytes go into the sandbox this many at a time (60,000 characters of base64: a command is at most 100,000). */
const CHUNK_BYTES = 45_000;

const pathInput = { type: "string", description: "The file's path: relative to the workspace's directory, or absolute." };

/** The engineer's tools, as the model is offered them. */
export const ENGINEER_TOOLS: ToolSpec[] = [
  {
    name: "bash",
    description:
      "Run a shell command in your workspace (bash -c), non-interactive. Each starts fresh in the workspace's directory: cd and variables don't carry over, so chain with && or give paths. You get its exit code and output; long output keeps its head and tail.",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "The command." } }, required: ["command"], additionalProperties: false },
  },
  {
    name: "read",
    description: `Read a text file, its lines numbered as cat -n numbers them (the number, a tab, the line): up to ${READ_LINES.toLocaleString("en-US")} lines from offset (the first line is 1). A folder is listed. Read a file before you edit it.`,
    inputSchema: {
      type: "object",
      properties: {
        path: pathInput,
        offset: { type: "integer", minimum: 1, description: "The first line to show (default 1)." },
        limit: { type: "integer", minimum: 1, maximum: READ_LINES, description: `How many lines (default ${READ_LINES}).` },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description:
      "Change a file: old_string, exactly as the file has it, becomes new_string. Copy old_string from what read showed (without its line numbers), with enough of the lines around it to be found once, or set replace_all. When nothing matches exactly, whole lines are matched with their indentation, spacing and typographic quotes forgiven, if that finds them once.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathInput,
        old_string: { type: "string", description: "The text to replace, as the file has it." },
        new_string: { type: "string", description: "What it becomes." },
        replace_all: { type: "boolean", description: "Replace every place old_string is found (default: it must be found once)." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "write",
    description: "Write a whole file: made new, or replaced, its folders made as needed. To change part of a file, use edit.",
    inputSchema: { type: "object", properties: { path: pathInput, content: { type: "string", description: "The whole file." } }, required: ["path", "content"], additionalProperties: false },
  },
];

/** A call as the quest runs it: said as a command (for your rules and the trail), and run in the sandbox. */
export interface EngineerStep {
  said: string;
  /** Runs it: what the sandbox said (its exit code above all) and what the engineer is told of it, redacted. */
  run(exec: Exec, timeoutSec: number): Promise<{ result: ExecResult; told: string }>;
}

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** A here-document's end word that no line of `text` is. */
function endWord(text: string): string {
  const lines = new Set(text.split(/\r?\n/));
  let word = "EOF";
  for (let n = 2; lines.has(word); n++) word = `EOF_${n}`;
  return word;
}

/** A path as given, or null; one that starts with `-` is read as a path, never as an option. */
function pathOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) return null;
  return value.startsWith("-") ? `./${value}` : value;
}

/** A whole number from `least` up, absent (null), or wrong (undefined). */
function countOf(value: unknown, least: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= least ? value : undefined;
}

/** A command that can't be run comes back as a failed result, never as an error that ends the turn. */
async function safely(exec: Exec, command: string, timeoutSec: number): Promise<ExecResult> {
  try {
    return await exec(command, timeoutSec);
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: `The sandbox could not run this: ${(error as Error).message}`, durationMs: 0, truncated: false };
  }
}

const failed = (durationMs: number, said: string): { result: ExecResult; told: string } => ({
  result: { exitCode: 1, stdout: "", stderr: said, durationMs, truncated: false },
  told: redact(said),
});

/** What the sandbox said went wrong, in a line. */
const why = (result: ExecResult): string => (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).split("\n").slice(-3).join(" ").slice(0, 400);

/** A call read: the step it is, or what is wrong with it (said to the engineer as its result). */
export function engineerStep(call: ClientCall, shown: (result: ExecResult) => string): EngineerStep | { problem: string } {
  const input = call.input;
  switch (call.name) {
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      if (!command.trim()) return { problem: "bash needs a command." };
      return {
        said: command,
        run: async (exec, timeoutSec) => {
          const result = await safely(exec, command, timeoutSec);
          return { result, told: shown(result) };
        },
      };
    }
    case "read": {
      const path = pathOf(input.path);
      const offset = countOf(input.offset, 1);
      const limit = countOf(input.limit, 1);
      if (!path) return { problem: "read needs a path." };
      if (offset === undefined || limit === undefined) return { problem: "read's offset and limit are whole numbers from 1." };
      const from = offset ?? 1;
      const lines = Math.min(limit ?? READ_LINES, READ_LINES);
      return {
        said: `sed -n '${from},${from + lines - 1}p' ${quote(path)}`,
        run: async (exec, timeoutSec) => {
          const result = await safely(exec, readCommand(path, from, lines), timeoutSec);
          return { result, told: readTold(path, from, result) };
        },
      };
    }
    case "edit": {
      const path = pathOf(input.path);
      const old = typeof input.old_string === "string" ? input.old_string : null;
      const next = typeof input.new_string === "string" ? input.new_string : null;
      if (!path) return { problem: "edit needs a path." };
      if (old === null || next === null) return { problem: "edit needs old_string and new_string." };
      const all = input.replace_all === true;
      const diff = [...old.split("\n").map((line) => `-${line}`), ...(next ? next.split("\n").map((line) => `+${line}`) : [])].join("\n");
      const end = endWord(diff);
      return {
        said: `edit ${quote(path)}${all ? " --all" : ""} <<'${end}'\n${diff}\n${end}`,
        run: (exec, timeoutSec) => editFile(exec, timeoutSec, path, old, next, all),
      };
    }
    case "write": {
      const path = pathOf(input.path);
      const content = typeof input.content === "string" ? input.content : null;
      if (!path) return { problem: "write needs a path." };
      if (content === null) return { problem: "write needs the file's content." };
      const end = endWord(content);
      // (A here-document ends its last line itself: the file's own last line break is that one.)
      return {
        said: `cat > ${quote(path)} <<'${end}'\n${content.replace(/\n$/, "")}\n${end}`,
        run: async (exec, timeoutSec) => {
          const bytes = Buffer.from(content, "utf8");
          const result = await putFile(exec, timeoutSec, path, bytes, null);
          if (result.exitCode !== 0) return { result, told: redact(`${path} was not written: ${why(result)}`) };
          const lines = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
          return { result, told: `Wrote ${path}: ${lines} line${lines === 1 ? "" : "s"}, ${bytes.length.toLocaleString("en-US")} bytes.` };
        },
      };
    }
    default:
      return { problem: `There is no tool "${call.name}": there is ${ENGINEER_TOOLS.map((t) => t.name).join(", ")}.` };
  }
}

/**
 * A read: a folder is listed; a file that isn't there, or is binary (a NUL in its first 8,000 bytes), is said to be;
 * a text file's lines are numbered from `from`, each cut at LINE_CHARS and the whole at READ_CHARS. Its last line on
 * stderr says how many lines it has and the last one shown.
 */
const readCommand = (path: string, from: number, lines: number): string =>
  [
    `f=${quote(path)}`,
    'if [ -d "$f" ]; then echo folder >&2; exec ls -la "$f"; fi',
    'if [ ! -f "$f" ]; then echo "No such file." >&2; exit 1; fi',
    `if [ "$(head -c 8000 "$f" | tr -d -c '\\000' | wc -c | tr -d ' ')" != 0 ]; then echo "A binary file of $(wc -c < "$f" | tr -d ' ') bytes: look at it with a command (file, od, xxd)." >&2; exit 1; fi`,
    `exec awk -v s=${from} -v n=${lines} -v w=${LINE_CHARS} -v max=${READ_CHARS} 'NR >= s && NR < s + n && !stop { if (length($0) > w) $0 = substr($0, 1, w) " [line cut at " w " characters]"; out += length($0) + 8; if (out > max) { stop = NR; next } printf "%6d\\t%s\\n", NR, $0; last = NR } END { printf "lines %d %d\\n", NR, last > "/dev/stderr" }' "$f"`,
  ].join("\n");

function readTold(path: string, from: number, result: ExecResult): string {
  if (result.exitCode === 0 && /^folder$/m.test(result.stderr)) return redact(`${path}: a folder\n${result.stdout.trimEnd()}`);
  const counted = /^lines (\d+) (\d+)$/m.exec(result.stderr);
  if (result.exitCode !== 0 || !counted) return redact(`${path}: ${why(result)}`);
  const total = Number(counted[1]);
  const last = Number(counted[2]);
  if (total === 0) return `${path}: an empty file`;
  if (last === 0) return `${path} has ${total} line${total === 1 ? "" : "s"}: none from line ${from}.`;
  const more = last < total ? `\n(Lines ${last + 1}–${total} aren't shown: read on with offset ${last + 1}.)` : "";
  return redact(`${path}: lines ${from}–${last} of ${total}\n${result.stdout.trimEnd()}${more}`);
}

/**
 * A file's new bytes, put in place whole: written beside it first, then over it (its mode and owner kept), so one cut
 * short leaves it as it was. `unchanged`: its SHA-256 as it was read, for an edit; one that changed since isn't
 * overwritten. Over CHUNK_BYTES, the bytes go in several commands.
 */
async function putFile(exec: Exec, timeoutSec: number, path: string, bytes: Buffer, unchanged: string | null): Promise<ExecResult> {
  const at = `f=${quote(path)}; t="$f.galahad-new"`;
  const guard = unchanged ? `[ "$(sha256sum < "$f" | cut -c1-64)" = '${unchanged}' ] || { echo "It changed while it was being edited: read it again." >&2; exit 1; }; ` : "";
  const place = 'cat "$t" > "$f"; s=$?; rm -f "$t"; exit $s';
  if (bytes.length <= CHUNK_BYTES) return await safely(exec, `${at}; ${guard}mkdir -p "$(dirname "$f")" && printf %s '${bytes.toString("base64")}' | base64 -d > "$t" && ${place}`, timeoutSec);
  let spent = 0;
  const step = async (command: string): Promise<ExecResult> => {
    const result = await safely(exec, command, timeoutSec);
    spent += result.durationMs;
    return { ...result, durationMs: spent };
  };
  let result = await step(`${at}; ${guard}mkdir -p "$(dirname "$f")" && : > "$t"`);
  for (let start = 0; result.exitCode === 0 && start < bytes.length; start += CHUNK_BYTES) {
    result = await step(`${at}; printf %s '${bytes.subarray(start, start + CHUNK_BYTES).toString("base64")}' | base64 -d >> "$t"`);
  }
  if (result.exitCode !== 0) {
    await safely(exec, `${at}; rm -f "$t"`, 30);
    return result;
  }
  return await step(`${at}; ${guard}${place}`);
}

async function editFile(exec: Exec, timeoutSec: number, path: string, old: string, next: string, all: boolean): Promise<{ result: ExecResult; told: string }> {
  const read = await safely(exec, `f=${quote(path)}; if [ ! -f "$f" ]; then echo "No such file: write makes a new one." >&2; exit 1; fi; base64 < "$f"`, timeoutSec);
  if (read.exitCode !== 0) return failed(read.durationMs, `${path}: ${why(read)}`);
  if (read.truncated) return failed(read.durationMs, `${path} is too large to edit with this tool: change it with a command (sed, a script).`);
  const bytes = Buffer.from(read.stdout.replace(/\s+/g, ""), "base64");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return failed(read.durationMs, `${path} isn't UTF-8 text: change it with a command.`);
  }
  const edited = applyEdit(text, old, next, all);
  if ("problem" in edited) return failed(read.durationMs, `${path}: ${edited.problem}`);
  const written = await putFile(exec, timeoutSec, path, Buffer.from(edited.text, "utf8"), createHash("sha256").update(bytes).digest("hex"));
  const result = { ...written, durationMs: read.durationMs + written.durationMs };
  if (written.exitCode !== 0) return { result, told: redact(`${path} was not changed: ${why(written)}`) };
  const at = edited.lines;
  const changes = `${at.length} change${at.length === 1 ? "" : "s"}, at line${at.length === 1 ? "" : "s"} ${at.slice(0, 20).join(", ")}${at.length > 20 ? ", …" : ""}`;
  return { result, told: redact(`Edited ${path}: ${changes}${edited.forgiven ? " (found with its whitespace and quotes forgiven)" : ""}.\n${around(edited.text, at[0]!, edited.size)}`) };
}

/** The lines `text` has around a change at `line` that is `size` lines long, numbered as read numbers them. */
function around(text: string, line: number, size: number): string {
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, line - 3);
  const to = Math.min(lines.length, line + size + 2, from + 39);
  return numbered(lines.slice(from - 1, to), from);
}

const numbered = (lines: readonly string[], first: number): string => lines.map((l, i) => `${String(first + i).padStart(6)}\t${l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)} [line cut]` : l}`).join("\n");

/** A file's change: its new text, the lines each change starts at, whether it was found forgiving, and how long it is. */
export interface Edit {
  text: string;
  lines: number[];
  forgiven: boolean;
  size: number;
}

/** Read's numbering, on a line copied from it ("    12\t…"). */
const NUMBERED = /^ *\d+\t/;

/** A line as it is compared when nothing matches exactly: its ends trimmed, its spacing one space, its quotes and dashes plain. */
const plain = (line: string): string =>
  line
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s\u00A0\u2000-\u200B\u202F\u205F\u3000]+/g, " ")
    .trim();

/** Each line's start and end (before its line break) in `text`. */
function linesOf(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    const at = text.indexOf("\n", start);
    if (at === -1) {
      out.push({ start, end: text.length });
      return out;
    }
    out.push({ start, end: at > start && text[at - 1] === "\r" ? at - 1 : at });
    start = at + 1;
  }
}

/** The line (from 1) that `offset` of `text` is on. */
const lineAt = (text: string, offset: number): number => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

/** Where each of `spans` is replaced by `next`, and the line each replacement starts at in the new text. */
function replaced(text: string, spans: readonly [number, number][], next: string): { text: string; lines: number[] } {
  let out = "";
  let at = 0;
  const lines: number[] = [];
  for (const [start, end] of spans) {
    out += text.slice(at, start);
    lines.push(lineAt(out, out.length));
    out += next;
    at = end;
  }
  return { text: out + text.slice(at), lines };
}

/** Where `old` is in `text`, exactly, without overlapping. */
function exactly(text: string, old: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let at = text.indexOf(old); at !== -1; at = text.indexOf(old, at + old.length)) spans.push([at, at + old.length]);
  return spans;
}

const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * `old` becomes `next` in a file's text: found exactly, or, failing that, with read's line numbers copied in taken out,
 * or, failing that, as whole lines compared plainly (their ends trimmed, spacing and quotes forgiven; then `next` takes
 * the file's indentation in place of the one `old` was given with). It must be found once (or `all`: anywhere); else
 * the problem says where it is, or the lines most like it.
 */
export function applyEdit(text: string, oldString: string, newString: string, all = false): Edit | { problem: string } {
  if (!oldString) return { problem: "old_string is empty. To make a file, or replace one whole, use write." };
  if (oldString === newString) return { problem: "old_string and new_string are the same: nothing would change." };
  // A file whose lines end in CRLF keeps them so.
  const crlf = text.includes("\r\n");
  const ends = (s: string): string => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
  let old = ends(oldString);
  let next = ends(newString);
  const once = (spans: [number, number][], forgiven: boolean, put: string): Edit | { problem: string } => {
    if (spans.length > 1 && !all) {
      const where = spans.slice(0, 10).map(([start]) => lineAt(text, start));
      return { problem: `old_string is there ${spans.length} times (at lines ${where.join(", ")}${spans.length > 10 ? ", …" : ""}): give more of the lines around it, so it is found once, or set replace_all.` };
    }
    return { ...replaced(text, spans, put), forgiven, size: lineCount(put) };
  };
  let spans = exactly(text, old);
  if (spans.length) return once(spans, false, next);
  // Read's numbering copied in with every line: the lines it numbers are meant (and new_string's, if it has them too).
  const oldLines = old.split(/\r?\n/).filter((line, i, all) => line || i < all.length - 1);
  if (oldLines.every((line) => NUMBERED.test(line))) {
    old = ends(oldLines.map((line) => line.replace(NUMBERED, "")).join("\n")) + (/\r?\n$/.test(old) ? ends("\n") : "");
    const nextLines = next.split(/\r?\n/).filter((line, i, all) => line || i < all.length - 1);
    if (nextLines.length && nextLines.every((line) => NUMBERED.test(line))) next = ends(nextLines.map((line) => line.replace(NUMBERED, "")).join("\n")) + (/\r?\n$/.test(next) ? ends("\n") : "");
    spans = exactly(text, old);
    if (spans.length) return once(spans, false, next);
  }
  // Whole lines, compared plainly.
  const want = old.split(/\r?\n/);
  if (want.length > 1 && want.at(-1) === "") want.pop();
  const wanted = want.map(plain);
  const lines = linesOf(text);
  if (wanted.some(Boolean)) {
    const found: number[] = [];
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      if (wanted.every((w, j) => plain(text.slice(lines[i + j]!.start, lines[i + j]!.end)) === w)) found.push(i);
    }
    if (found.length) {
      // The replacement ends where the last line found does (its line break stays), so one given with a line break at
      // its end loses it; and it takes the file's indentation where old_string had another.
      let put = /\r?\n$/.test(old) ? next.replace(/\r?\n$/, "") : next;
      const given = /^[ \t]*/.exec(want[0]!)![0];
      const file = /^[ \t]*/.exec(text.slice(lines[found[0]!]!.start, lines[found[0]!]!.end))![0];
      const putLines = put.split(/\r?\n/);
      if (given !== file && putLines.every((line) => !line.trim() || line.startsWith(given))) {
        put = putLines.map((line) => (line.trim() ? file + line.slice(given.length) : line)).join(crlf ? "\r\n" : "\n");
      }
      return once(
        found.map((i): [number, number] => [lines[i]!.start, lines[i + wanted.length - 1]!.end]),
        true,
        put,
      );
    }
  }
  const already = next.trim() ? exactly(text, next) : [];
  const made = already.length ? ` (new_string is, at line ${lineAt(text, already[0]![0])}: the change may be made already)` : "";
  const near = closest(text, old);
  return { problem: `old_string isn't in the file${made}.${near ? ` The lines most like it:\n${near}\n` : " "}Read the file again and copy old_string from it exactly.` };
}

/** The lines of `text` most like `old`'s first line (the most words in common), with a few around them; empty if none. */
function closest(text: string, old: string): string {
  const first = old.split(/\r?\n/).map(plain).find(Boolean);
  if (!first) return "";
  const words = new Set(first.split(/[^A-Za-z0-9_]+/).filter((w) => w.length > 1));
  const lines = text.split(/\r?\n/);
  let best = 0;
  let at = -1;
  for (const [i, line] of lines.entries()) {
    let score = 0;
    for (const w of new Set(plain(line).split(/[^A-Za-z0-9_]+/))) if (words.has(w)) score++;
    if (score > best) {
      best = score;
      at = i;
    }
  }
  if (at === -1) return "";
  const from = Math.max(0, at - 2);
  const to = Math.min(lines.length, at + old.split(/\r?\n/).length + 2, from + 30);
  return numbered(lines.slice(from, to), from + 1);
}

/**
 * A call's input as it is kept in the conversation once it has run: a long string (a file written whole, a long edit)
 * is cut to its head and tail, as a long reply is, so it isn't sent again whole on every turn. Null when nothing is cut.
 */
export function keptInput(input: Record<string, unknown>, head = 12_000, tail = 4_000): Record<string, unknown> | null {
  let cut = false;
  const kept = Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (typeof value !== "string" || value.length <= head + tail + 200) return [key, value];
      cut = true;
      return [key, `${value.slice(0, head)}\n… [${(value.length - head - tail).toLocaleString("en-US")} characters cut here: the tool had them all] …\n${value.slice(-tail)}`];
    }),
  );
  return cut ? kept : null;
}
