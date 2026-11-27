import { parseArgs } from "node:util";
import { askCommand } from "./ask.ts";
import { allowCommand, asksCommand, denyCommand } from "./asks.ts";
import { boardCommand } from "./board.ts";
import type { FetchLike } from "./client.ts";
import { connect } from "./connect.ts";
import { costCommand } from "./cost.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import type { Command, Flags, Io } from "./io.ts";
import { pairCommand } from "./pair.ts";
import { steerCommand } from "./steer.ts";
import { seatCommand, seatsCommand } from "./seats.ts";
import { againCommand, giveCommand, peekCommand, proofCommand, stopCommand, tasksCommand, watchCommand } from "./work.ts";

/*
 * inv's commands (docs/CLI.md, "Commands"), read from its words and its flags, and the code each exits with. A flag a
 * command doesn't take is bad usage (2), never quietly ignored. A first word that is no command is something to say to
 * your agent (inv "…"), unless it is one word a letter away from a command, which is taken for a typo.
 */

export const HELP = `inv: your agent and its work, from a terminal (docs/CLI.md has all of it)

  inv                          the board: what needs you, what is new, at work and done (live in a terminal)
  inv "…"                      say something to your agent (--chat <id> goes on in a chat)
  inv give "…"                 give a task: --agent <id> --project <p> --gate "<command>"… --budget <usd> --on <node>
                               --title "…" · --wait --json --stream --no-ask --timeout 20m
  inv tasks                    every task by attention: --needs-you --working --done --project <p>
  inv watch <task>             its steps as they finish, then its proof (Ctrl-C leaves, and it works on)
  inv peek <task>              its last lines, or what it waits on
  inv proof <task>             its gates and its review; the exit code is the verdict
  inv stop <task>              stops it
  inv steer <task> "…"         tells it something as it runs: taken at its next safe point, and judged with it
                               (inv steer --chat <id> "…" tells your agent, as it answers in that chat)
  inv again <task> [--from <step>] ["…"]
                               gives it again (from a step: its workspace as it stood then)
  inv asks                     what waits for your answer, shown exactly
  inv allow <id> [--for-task]  ·  inv deny <id> ["why"]
  inv cost                     what it cost at your prices: --task <id> --agent <id> --project <p> --week
  inv pair <invite>            pairs with a node (invincible invite --client there) · inv pair · inv pair --forget
  inv seats                    your accounts with Claude, ChatGPT and others, where each stands and whom it serves
  inv seat add <claude|chatgpt> ["label"] [--email <address>] [--agent <agent>]
                               adds one and signs it in on its vendor's page · inv seat sign-in <seat> · inv seat remove <seat>
  inv seat serve <seat> <agent> · inv seat share <seat> <agent> <agent>…
                               the agent a seat serves, or the agents that share it: they are one trust domain

Every list takes --json. --node local talks to this machine's node even when paired, and --home <dir> names its home.
Exit codes: 0 verified · 1 error · 2 bad usage · 10 a gate failed · 11 the reviewer rejected it · 12 finished without
proof · 13 stopped · 20 needs you · 21 still running · 30 refused · 31 the node is unreachable.
`;

const OPTIONS = {
  json: { type: "boolean" },
  stream: { type: "boolean" },
  wait: { type: "boolean" },
  "no-ask": { type: "boolean" },
  timeout: { type: "string" },
  project: { type: "string" },
  agent: { type: "string" },
  gate: { type: "string", multiple: true },
  budget: { type: "string" },
  on: { type: "string" },
  title: { type: "string" },
  chat: { type: "string" },
  from: { type: "string" },
  "for-task": { type: "boolean" },
  "needs-you": { type: "boolean" },
  working: { type: "boolean" },
  done: { type: "boolean" },
  task: { type: "string" },
  week: { type: "boolean" },
  name: { type: "string" },
  email: { type: "string" },
  forget: { type: "boolean" },
  home: { type: "string" },
  node: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Option = keyof typeof OPTIONS;

/** Every command, and the flags it takes beyond --home, --node and --help. */
const COMMANDS: Readonly<Record<string, { run: Command | "pair"; takes: readonly Option[] }>> = {
  give: { run: giveCommand, takes: ["agent", "project", "gate", "budget", "on", "title", "wait", "json", "stream", "no-ask", "timeout"] },
  again: { run: againCommand, takes: ["from", "wait", "json", "stream", "no-ask", "timeout"] },
  tasks: { run: tasksCommand, takes: ["needs-you", "working", "done", "project", "json"] },
  watch: { run: watchCommand, takes: ["json", "stream"] },
  peek: { run: peekCommand, takes: ["json"] },
  proof: { run: proofCommand, takes: ["json"] },
  stop: { run: stopCommand, takes: ["json"] },
  steer: { run: steerCommand, takes: ["chat", "json"] },
  asks: { run: asksCommand, takes: ["json"] },
  allow: { run: allowCommand, takes: ["for-task", "json"] },
  deny: { run: denyCommand, takes: ["json"] },
  cost: { run: costCommand, takes: ["task", "agent", "project", "week", "json"] },
  pair: { run: "pair", takes: ["name", "forget", "json"] },
  seats: { run: seatsCommand, takes: ["json"] },
  seat: { run: seatCommand, takes: ["email", "json", "no-ask"] },
  /** (inv ask "…" is inv "…", for the hand used to invincible ask.) */
  ask: { run: askCommand, takes: ["chat", "json"] },
};
const BOARD: readonly Option[] = ["json"];
const SAY: readonly Option[] = ["chat", "json"];
const EVERYWHERE: readonly Option[] = ["home", "node", "help"];

/** One edit apart at most: a letter added, dropped or changed, or two side by side swapped. */
function nearly(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]! <= 1;
}

export interface RunOptions {
  /** How inv reaches its node (tests: a stand-in). */
  fetch?: FetchLike;
  /** How long `inv pair` waits for an approval, and how often it asks. */
  pairTimeoutMs?: number;
  pairIntervalMs?: number;
}

export async function run(argv: readonly string[], io: Io, opts: RunOptions = {}): Promise<number> {
  let machine = argv.includes("--json") || argv.includes("--stream");
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (error) {
      throw usageError(`${(error as Error).message.replace(/\s*To specify a positional argument[^]*$/, "")} (inv help)`);
    }
    const values = parsed.values as Partial<Record<Option, string | boolean | string[]>>;
    machine = values.json === true || values.stream === true;
    const flags: Flags = {
      json: values.json === true,
      stream: values.stream === true,
      wait: values.wait === true,
      noAsk: values["no-ask"] === true,
      gate: (values.gate as string[] | undefined) ?? [],
      forTask: values["for-task"] === true,
      needsYou: values["needs-you"] === true,
      working: values.working === true,
      done: values.done === true,
      week: values.week === true,
      forget: values.forget === true,
      help: values.help === true,
      ...Object.fromEntries((["timeout", "project", "agent", "budget", "on", "title", "chat", "from", "task", "name", "email", "home", "node"] as const).filter((key) => typeof values[key] === "string").map((key) => [key, values[key]])),
    };
    const [first, ...rest] = parsed.positionals;
    if (flags.help || first === "help") {
      io.out(HELP);
      return EXIT.ok;
    }
    if (flags.node !== undefined && flags.node !== "local") throw usageError("--node takes one word: local (this machine's node, even when paired)");
    if (flags.json && flags.stream) throw usageError("give --json or --stream, not both");

    const known = first !== undefined ? COMMANDS[first] : undefined;
    // One word a letter away from a command is a typo, not something to say to your agent.
    if (first !== undefined && !known && rest.length === 0 && /^[a-z]+$/.test(first)) {
      const like = Object.keys(COMMANDS).find((name) => nearly(first, name));
      if (like) throw usageError(`there is no inv ${first}: did you mean inv ${like}? (to say one word to your agent: inv "${first}?")`);
    }
    const takes = first === undefined ? BOARD : known ? known.takes : SAY;
    const given = (Object.keys(values) as Option[]).filter((key) => values[key] !== undefined && !(Array.isArray(values[key]) && !(values[key] as string[]).length));
    const stray = given.find((key) => !takes.includes(key) && !EVERYWHERE.includes(key));
    if (stray) throw usageError(`${first === undefined ? "the board" : known ? `inv ${first}` : `inv "…"`} takes no --${stray} (inv help)`);

    const conn = () => connect({ env: io.env, home: flags.home, local: flags.node === "local", ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    if (first === undefined) return await boardCommand(conn, [], flags, io);
    if (!known) return await askCommand(conn, parsed.positionals, flags, io);
    if (known.run === "pair") {
      if (rest.length > 1) throw usageError("usage: inv pair [<invite>] [--name <name>] [--forget]");
      const say = (line: string) => (flags.json ? io.err(`${line}\n`) : io.out(`${line}\n`));
      const result = await pairCommand({ env: io.env, invite: rest[0], name: flags.name, forget: flags.forget, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.pairTimeoutMs ? { timeoutMs: opts.pairTimeoutMs } : {}), ...(opts.pairIntervalMs ? { intervalMs: opts.pairIntervalMs } : {}) }, { say });
      if (flags.json) io.out(`${JSON.stringify(result)}\n`);
      return EXIT.ok;
    }
    return await known.run(conn, rest, flags, io);
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError(String((error as Error)?.message ?? error));
    io.err(`inv: ${failure.message}\n`);
    if (machine) io.out(`${JSON.stringify({ error: failure.message, exit: failure.exit })}\n`);
    return failure.exit;
  }
}
