/*
 * Standing orders, as people read them, and the order editor's rows turned
 * into an order's terms. The node checks every rule again when you sign
 * (packages/core/src/orders.ts); these only explain them early, in plain words.
 * Pure (no DOM, no zod), so they are unit-tested.
 */

/** How one argument may vary: exactly this value, a pattern with `*`, or anything. */
export type ArgMode = "exact" | "pattern" | "any";

export interface ArgRow {
  name: string;
  mode: ArgMode;
  /** The exact value or the pattern. Kept while the row is "any", so switching back loses nothing. */
  value: string;
  /** Where the request goes (a {placeholder} in the tool's path): always named, and at least one stays pinned. */
  inPath: boolean;
  /** In every call (required, or in the path). "Any" then names it as `*`, which says the same and keeps it named. */
  always: boolean;
  /** Text or a number. A list or an object (an MCP tool's) can't be pinned: an order compares text. */
  pinnable: boolean;
}

export const MAX_PATTERN = 200;
export const MAX_LABEL = 128;
export const MAX_CALLERS = 16;
export const ORDER_DAYS = [7, 30, 90] as const;
export const DEFAULT_DAYS = 30;
export const DAY_MS = 24 * 60 * 60_000;

/**
 * The name an order's `callers` match, as the node computes it: an arm's label
 * (`arm:claude-code` → `claude-code`), `loop.<name>` for a loop however it called
 * (`loop:morning` → `loop.morning`), else who asked as recorded.
 */
export const callerName = (by: string): string => (by.startsWith("arm:") ? by.slice(4) : by.startsWith("loop:") ? `loop.${by.slice(5)}` : by);

/** An MCP tool's call, as the outbox files it: `mcp createIssue {"repo":…}`. It has no path. */
export const isMcpTarget = (target: string): boolean => /^mcp\s/.test(target);

const scalar = (value: unknown) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** An argument's value as an order compares it: the text of a scalar. */
export const argText = (value: unknown): string => (typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value));

/** The {placeholders} of a tool's path template, in order. */
export const pathPlaceholders = (path: string): string[] => [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);

/**
 * Which of a call's arguments went into its path, in the path's order, read back
 * from the action's target ("POST /repos/amiriteorg/galahad/pulls"): those whose
 * value is one of its segments. A coincidence only ever makes the default stricter.
 */
export function pathArgs(target: string, args: Record<string, unknown>): string[] {
  if (isMcpTarget(target)) return [];
  const path = target.replace(/^[A-Z]+\s+/, "").split(/[?#]/)[0] ?? "";
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return Object.entries(args)
    .map(([name, value]) => ({ name, at: typeof value === "string" || typeof value === "number" ? segments.indexOf(String(value)) : -1 }))
    .filter((arg) => arg.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((arg) => arg.name);
}

/** Where it goes first (in the path's order), then what every call carries, then the rest; otherwise as given. */
function ordered(rows: ArgRow[], path: string[]): ArgRow[] {
  const rank = (row: ArgRow) => (row.inPath ? path.indexOf(row.name) : row.always ? path.length : path.length + 1);
  return rows.map((row, i) => ({ row, i })).sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i).map(({ row }) => row);
}

/**
 * Rows for an order made from a call that waits for you: where it went starts
 * pinned to exactly this, everything else starts free. A delete pins everything
 * it can (lists and objects can't be pinned).
 */
export function rowsFromCall(call: { class: string; target: string; args: Record<string, unknown> }): ArgRow[] {
  const path = pathArgs(call.target, call.args);
  const rows = Object.entries(call.args).map(([name, value]): ArgRow => {
    const inPath = path.includes(name);
    const pinnable = scalar(value);
    return { name, value: argText(value), inPath, always: inPath, pinnable, mode: pinnable && (call.class === "delete" || inPath) ? "exact" : "any" };
  });
  return ordered(rows, path);
}

/**
 * Rows for an order made from scratch: every parameter of the tool. A tool with
 * a path starts with the path's parameters pinned and the rest free. An MCP tool
 * has no path, so everything a call always carries starts pinned, and you loosen
 * what you mean to.
 */
export function rowsForTool(params: Record<string, { required: boolean; type?: string }>, cls: string, path: string | null): ArgRow[] {
  const placeholders = path ? pathPlaceholders(path) : [];
  const rows = Object.entries(params).map(([name, p]): ArgRow => {
    const inPath = placeholders.includes(name);
    const always = p.required || inPath;
    const pinnable = !/array|object/.test(p.type ?? "string");
    const pinned = pinnable && (cls === "delete" || !path ? always : inPath);
    return { name, value: "", inPath, always, pinnable, mode: pinned ? "exact" : "any" };
  });
  return ordered(rows, placeholders);
}

/**
 * The modes a row may take: a delete names exactly one thing, so it has no
 * patterns, and what it always carries stays exact. Lists and objects stay free.
 */
export function modesFor(row: Pick<ArgRow, "always" | "pinnable">, cls: string): ArgMode[] {
  if (!row.pinnable) return ["any"];
  if (cls === "delete") return row.always ? ["exact"] : ["exact", "any"];
  return ["exact", "pattern", "any"];
}

const bareStar = (pattern: string) => /^\*+$/.test(pattern);

export type TermsRead = { args: Record<string, string>; free: string[] } | { problem: string; row?: string };

/** The editor's rows as an order's args (and the names left free), or what's wrong, in the node's words said early. */
export function rowsToArgs(rows: ArgRow[], cls: string): TermsRead {
  const args: Record<string, string> = {};
  const free: string[] = [];
  for (const row of rows) {
    if (row.mode === "any") {
      if (cls === "delete" && row.always) {
        return {
          problem: row.pinnable
            ? `An order to delete names exactly one thing: give ${row.name} its exact value.`
            : `An order to delete names exactly one thing, and ${row.name} is a list or an object, which an order can't pin. Answer these one at a time.`,
          row: row.name,
        };
      }
      // Named as `*`: the same as leaving it out for what every call carries, and it keeps where-it-goes named.
      if (row.always && row.pinnable) args[row.name] = "*";
      free.push(row.name);
      continue;
    }
    const value = row.value;
    if (!value.trim()) return { problem: `Give ${row.name} ${row.mode === "exact" ? "a value" : "a pattern"}, or choose Any.`, row: row.name };
    if (value.length > MAX_PATTERN) return { problem: `${row.name} is too long to pin (${MAX_PATTERN} characters at most). Use a pattern with *, or choose Any.`, row: row.name };
    if (value.includes("*")) {
      if (cls === "delete") return { problem: `An order to delete names exactly one thing, so ${row.name} can't have a *.`, row: row.name };
      if (row.mode === "exact") return { problem: `${row.name} has a *, which matches anything. Choose Pattern if that's what you mean.`, row: row.name };
      if (bareStar(value)) free.push(row.name);
    }
    args[row.name] = value;
  }
  const where = rows.filter((r) => r.inPath);
  if (where.length && !where.some((r) => Object.hasOwn(args, r.name) && !args[r.name]!.includes("*"))) {
    return { problem: `Pin ${where.length === 1 ? where[0]!.name : `at least one of ${list(where.map((r) => r.name), "or")}`} to an exact value: an order says where, not "anywhere".`, row: where[0]!.name };
  }
  return { args, free };
}

/** "claude-code, loop:release" → the callers an order names, or none (any of Galahad's agents). */
export function parseCallers(text: string): { callers: string[] | null } | { problem: string } {
  const names = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  if (!names.length) return { callers: null };
  if (names.length > MAX_CALLERS) return { problem: `Name at most ${MAX_CALLERS} agents, or leave it empty for any of them.` };
  const long = names.find((n) => n.length > MAX_PATTERN);
  if (long) return { problem: `"${long.slice(0, 24)}…" is too long for an agent's name.` };
  return { callers: names };
}

export type PatternShape =
  | { kind: "any" }
  | { kind: "exact"; text: string }
  | { kind: "prefix"; text: string }
  | { kind: "suffix"; text: string }
  | { kind: "contains"; text: string }
  | { kind: "glob"; text: string };

/** What a pattern means: anything, exactly this, starting with, ending with, containing, or a pattern of its own. */
export function patternShape(pattern: string): PatternShape {
  if (bareStar(pattern)) return { kind: "any" };
  if (!pattern.includes("*")) return { kind: "exact", text: pattern };
  const inner = pattern.replace(/^\*+/, "").replace(/\*+$/, "");
  if (!inner.includes("*")) {
    const open = pattern.startsWith("*");
    const close = pattern.endsWith("*");
    if (!open && close) return { kind: "prefix", text: inner };
    if (open && !close) return { kind: "suffix", text: inner };
    if (open && close) return { kind: "contains", text: inner };
  }
  return { kind: "glob", text: pattern };
}

/** Text in a sentence: quoted when it has spaces at its edges or inside, so they show. */
const quoted = (text: string) => (/\s/.test(text) || !text ? `“${text}”` : text);

/** A pattern on its own: "any", "amiriteorg", "starts with feat/". */
export function patternWords(pattern: string): string {
  const shape = patternShape(pattern);
  switch (shape.kind) {
    case "any":
      return "any";
    case "exact":
      return quoted(shape.text);
    case "prefix":
      return `starts with ${quoted(shape.text)}`;
    case "suffix":
      return `ends with ${quoted(shape.text)}`;
    case "contains":
      return `contains ${quoted(shape.text)}`;
    case "glob":
      return `matches ${quoted(shape.text)}`;
  }
}

/** One constraint in a sentence: "owner amiriteorg", "head starting with feat/". */
function phrase(name: string, pattern: string): string {
  const shape = patternShape(pattern);
  switch (shape.kind) {
    case "any":
      return `any ${name}`;
    case "exact":
      return `${name} ${quoted(shape.text)}`;
    case "prefix":
      return `${name} starting with ${quoted(shape.text)}`;
    case "suffix":
      return `${name} ending with ${quoted(shape.text)}`;
    case "contains":
      return `${name} containing ${quoted(shape.text)}`;
    case "glob":
      return `${name} matching ${quoted(shape.text)}`;
  }
}

/** "a", "a and b", "a, b and c". */
export function list(items: string[], last: "and" | "or" = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

/** Who may use an order, as a sentence starts: "Only claude-code", "Any of Galahad's agents". */
export const whoWords = (callers: string[] | null): string => (callers?.length ? `Only ${list(callers, "or")}` : "Any of Galahad's agents");

/**
 * The order in one plain sentence, for the preview before you sign:
 * "Only claude-code may use github.pr.create without asking you for owner amiriteorg
 * and head starting with feat/, with any repo, until Dec 10. Each call still shows up in your inbox."
 */
export function orderSentence(order: { connector: string; tool: string; args: Record<string, string>; free?: string[]; callers: string[] | null; until: string }): string {
  const constrained = Object.entries(order.args).filter(([, pattern]) => !bareStar(pattern));
  const free = [...new Set([...Object.entries(order.args).filter(([, p]) => bareStar(p)).map(([name]) => name), ...(order.free ?? [])])];
  let terms = "";
  if (constrained.length) terms += ` for ${list(constrained.map(([name, pattern]) => phrase(name, pattern)))}`;
  if (free.length) terms += `, with any ${list(free)}`;
  return `${whoWords(order.callers)} may use ${order.connector}.${order.tool} without asking you${terms}, until ${order.until}. Each call still shows up in your inbox.`;
}

/**
 * What a delete names, for typing before you approve it: the last segment of
 * where it goes ("DELETE /…/buckets/scratch" → "scratch"); for an MCP tool, its
 * one argument; otherwise the tool's name.
 */
export function deleteName(call: { connector: string; tool: string; target: string; args: Record<string, unknown> }): string {
  const fallback = `${call.connector}.${call.tool}`;
  if (isMcpTarget(call.target)) {
    const values = Object.values(call.args).filter(scalar);
    return values.length === 1 ? argText(values[0]) : fallback;
  }
  const path = call.target.replace(/^[A-Z]+\s+/, "").split(/[?#]/)[0] ?? "";
  const last = path.split("/").filter(Boolean).at(-1);
  if (!last) return fallback;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A label to start from: the tool, and where the call went ("github.pr.create on amiriteorg/galahad"). */
export function defaultLabel(call: { connector: string; tool: string; target: string; args: Record<string, unknown> }): string {
  const where = pathArgs(call.target, call.args).map((name) => argText(call.args[name]));
  const label = `${call.connector}.${call.tool}${where.length ? ` on ${where.join("/")}` : ""}`;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/** Orders still meant to apply (stale ones first: they need you), then the old ones. Newest first within each. */
export function splitOrders<T extends { state: string; signedAt: number }>(orders: T[]): { current: T[]; old: T[] } {
  const newest = (a: T, b: T) => b.signedAt - a.signedAt;
  const rank = (o: T) => (o.state === "stale" ? 0 : 1);
  return {
    current: orders.filter((o) => o.state === "active" || o.state === "stale").sort((a, b) => rank(a) - rank(b) || newest(a, b)),
    old: orders.filter((o) => o.state !== "active" && o.state !== "stale").sort(newest),
  };
}
