import type { TeamSnapshot, TeamTask } from "@invincible/core";
import type { Connection } from "./connect.ts";
import { CliError, usageError } from "./exit.ts";
import type { Style } from "./render.ts";

/*
 * What every command is given: where it writes (stdout for its answer, stderr for what is said beside it), how to show
 * it, the environment, the clock, and Ctrl-C. Commands never call process.exit and never read process.* themselves,
 * so the tests run them whole with an Io of their own.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** How stdout shows text (a terminal's colours and width, or plain), and stderr. */
  style: Style;
  errStyle: Style;
  /** The terminal's rows, when stdout is one (the board is never taller). */
  rows: number | null;
  env: Record<string, string | undefined>;
  now(): number;
  /** Aborted when you press Ctrl-C: a command that follows work leaves. */
  signal: AbortSignal;
  /**
   * Ctrl-C does `handler` instead, until the returned release is called (inv "…": the first press stops the answer).
   * Pressed twice, inv leaves at once.
   */
  onInterrupt(handler: () => void): () => void;
  /** Called with the terminal's new size when it changes (the board draws itself again). */
  onResize(handler: (size: { columns: number; rows: number }) => void): () => void;
  /** How long a follower waits between looks when nothing wakes it (tests shorten it). */
  pollMs?: number;
  /** A line you type, after its prompt (a seat's sign-in: the code its page shows): only where stdin is a terminal. */
  readLine?(prompt: string): Promise<string | null>;
}

export interface Flags {
  json: boolean;
  stream: boolean;
  wait: boolean;
  noAsk: boolean;
  timeout?: string;
  project?: string;
  agent?: string;
  gate: string[];
  budget?: string;
  on?: string;
  title?: string;
  chat?: string;
  from?: string;
  forTask: boolean;
  needsYou: boolean;
  working: boolean;
  done: boolean;
  task?: string;
  week: boolean;
  name?: string;
  /** inv seat add: the account's email its sign-in starts with. */
  email?: string;
  /** inv desktop: the file its picture is written to. */
  out?: string;
  forget: boolean;
  home?: string;
  node?: string;
  help: boolean;
}

export type Command = (conn: () => Promise<Connection>, args: string[], flags: Flags, io: Io) => Promise<number>;

/** A task named by its id, or by a part of it that names one alone (its last characters, or its first after "task-"). */
export function resolveTask(snapshot: Pick<TeamSnapshot, "tasks">, ref: string | undefined, usage: string): TeamTask {
  if (!ref) throw usageError(usage);
  const exact = snapshot.tasks.find((task) => task.id === ref || task.id === `task-${ref}`);
  if (exact) return exact;
  const short = ref.replace(/^task-/, "");
  const found = short.length >= 4 ? snapshot.tasks.filter((task) => task.id.slice(5).startsWith(short) || task.id.endsWith(short)) : [];
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw usageError(`"${ref}" names ${found.length} tasks: give more of its id (${found.slice(0, 4).map((task) => task.id).join(", ")})`);
  throw new CliError(`no task ${ref} on this node (inv tasks lists them)`);
}

/** A duration as --timeout takes it: 90s, 20m, 2h (a bare number is seconds). */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(text.trim());
  if (!match) throw usageError(`--timeout takes a duration such as 90s, 20m or 2h, not "${text}"`);
  const ms = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "s" | "m" | "h"];
  if (!(ms > 0) || ms > 7 * 24 * 3_600_000) throw usageError("--timeout is more than nothing, and a week at most");
  return ms;
}

/** Dollars as --budget takes them: 2, 0.5, $1.50 (more than nothing, $100 at most, as the node takes a task's budget). */
export function parseUsd(text: string): number {
  const match = /^\$?(\d+(?:\.\d+)?)$/.exec(text.trim());
  const usd = match ? Number(match[1]) : Number.NaN;
  if (!(usd > 0) || usd > 100) throw usageError(`--budget takes US dollars, more than nothing and 100 at most, not "${text}"`);
  return Math.round(usd * 100) / 100;
}
