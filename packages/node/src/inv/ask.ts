import { type ChatStreamEvent, plainLine, plainStream } from "@invincible/core";
import { CliError, EXIT, usageError } from "./exit.ts";
import type { Command } from "./io.ts";
import { faint } from "./render.ts";

/*
 * inv "…" (docs/CLI.md): a word with your agent, in a chat kept in your history as the apps keep theirs (--chat goes on
 * in one), its answer streamed as it is written and shown as plain text. The turn is the node's: Ctrl-C asks it to stop,
 * as Stop does in the apps, and what it had said is kept; a terminal that goes away stops nothing. --json waits for the
 * answer and prints one object.
 */

export const askCommand: Command = async (conn, args, flags, io) => {
  const text = args.join(" ").trim();
  if (!text) throw usageError('usage: inv "<what you want to say>" [--chat <id>] [--json]');
  const { client } = await conn();
  const events = client.events("chat", { messages: [{ role: "user", content: text }], ...(flags.chat ? { conversation: flags.chat } : { save: true }) });
  const plain = plainStream();
  let answer = "";
  let turn: string | null = null;
  let chat: string | null = flags.chat ?? null;
  let model: string | null = null;
  let stopped = false;
  let failed: string | null = null;
  let stopping = false;
  const release = io.onInterrupt(() => {
    if (!turn || stopping) return;
    stopping = true;
    io.err(faint(io.errStyle, "\n[stopping it: what it said is kept]\n"));
    void client.call("stopTurn", { turn }).catch(() => {});
  });
  try {
    for await (const data of events) {
      const event = JSON.parse(data) as ChatStreamEvent;
      if (event.type === "turn") {
        turn = event.id;
        chat = event.conversation ?? chat;
      } else if (event.type === "conversation") chat = event.id;
      else if (event.type === "model") model = event.ref;
      else if (event.type === "text") {
        const piece = plain(event.text);
        answer += piece;
        if (!flags.json) io.out(piece);
      } else if (event.type === "tool" && !flags.json) io.err(faint(io.errStyle, `\n[${plainLine(event.title || event.name)}]\n`));
      else if (event.type === "stopped") stopped = true;
      else if (event.type === "error") failed = event.error;
    }
  } finally {
    release();
  }
  if (!flags.json && answer && !answer.endsWith("\n")) io.out("\n");
  if (failed && !stopped) throw new CliError(`your agent couldn't answer: ${plainLine(failed)}`);
  if (flags.json) io.out(`${JSON.stringify({ chat, turn, model, text: answer, stopped })}\n`);
  return stopped ? EXIT.stopped : EXIT.ok;
};
