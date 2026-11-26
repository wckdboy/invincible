import { plainLine, TEAM_LIMITS, type TeamSnapshot, type TeamSteer, type TeamTask, type TurnView } from "@invincible/core";
import { CliError, EXIT, usageError } from "./exit.ts";
import { type Command, resolveTask } from "./io.ts";

/*
 * inv steer (docs/CLI.md): your words to work under way, taken at its next safe point, as Steer does in the apps.
 *   inv steer <task> "…"         a task that is running: its run takes them (a command it runs finishes first), its
 *                                trail says them where it took them, and its reviewer judges the work against them.
 *   inv steer --chat <id> "…"    your agent's turn running in that chat: it reads them at its next safe point.
 * It returns once the node has them: 0. A refusal is the node's, in its words (1); this device's scopes are 30.
 */

const USAGE = 'usage: inv steer <task> "<what it should take up>" · inv steer --chat <id> "…"';

/** The words, as one steer: what was given after the task (or all of it, with --chat), held to a steer's limit. */
function wordsOf(args: readonly string[]): string {
  const text = args.join(" ").trim();
  if (!text) throw usageError(USAGE);
  if (text.length > TEAM_LIMITS.steer) throw usageError(`a steer holds at most ${TEAM_LIMITS.steer} characters`);
  return text;
}

export const steerCommand: Command = async (conn, args, flags, io) => {
  const print = (line: string) => io.out(`${line}\n`);
  if (flags.chat !== undefined) {
    const text = wordsOf(args);
    const { client } = await conn();
    const { turns } = await client.call<{ turns: TurnView[] }>("turns");
    const running = turns.find((turn) => turn.conversation === flags.chat && turn.state === "running" && turn.watchable);
    if (!running) throw new CliError(`nothing is running in that chat now: inv "…" --chat ${flags.chat} says it there`, EXIT.error);
    const { waiting } = await client.call<{ steered: boolean; waiting: number }>("steerTurn", { turn: running.id, text });
    if (flags.json) print(JSON.stringify({ chat: flags.chat, turn: running.id, waiting }));
    else print(`Steered your agent in “${plainLine(running.title ?? flags.chat)}”: it reads your words at its next safe point.`);
    return EXIT.ok;
  }
  if (!args.length) throw usageError(USAGE);
  const text = wordsOf(args.slice(1));
  const { client } = await conn();
  const found = resolveTask(await client.call<TeamSnapshot>("team"), args[0], USAGE);
  const { task } = await client.call<{ task: TeamTask; steer: TeamSteer }>("steerTeamTask", { task: found.id, text });
  if (flags.json) print(JSON.stringify({ task: task.id, waiting: (task.steers ?? []).filter((steer) => !steer.taken).length }));
  else print(`Steered ${task.id}: ${plainLine(task.title)}. It takes your words at its next safe point; inv watch ${task.id} shows where.`);
  return EXIT.ok;
};
