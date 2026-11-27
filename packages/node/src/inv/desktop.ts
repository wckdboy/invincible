import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { plainLine, type TeamSnapshot } from "@invincible/core";
import type { DesktopView } from "../../../../apps/web/src/lib/desktop.ts";
import { holdEnds } from "../../../../apps/web/src/lib/desktop-stream.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import type { Command } from "./io.ts";
import { faint } from "./render.ts";

/*
 * inv desktop <agent> [--out <file>] [--json] (docs/CLI.md, docs/DESKTOP.md): an agent's desktop, looked at and never touched. A look is no
 * input, so it never takes the desktop over, and the ledger doesn't record it: watching is looking. It says the screen's
 * size and whether you have it; --out writes its picture to a file. Watching it live, and taking it over, are the apps'.
 */

const USAGE = "usage: inv desktop <agent> [--out <file>] [--json]";

export const desktopCommand: Command = async (conn, args, flags, io) => {
  if (args.length !== 1) throw usageError(USAGE);
  const ref = args[0]!;
  const { client } = await conn();
  const snapshot = await client.call<TeamSnapshot>("team");
  const agent = snapshot.agents.find((one) => one.id === ref) ?? snapshot.agents.find((one) => one.name.toLowerCase() === ref.toLowerCase());
  if (!agent) throw new CliError(`no agent ${plainLine(ref)} (${snapshot.agents.map((one) => one.id).join(", ") || "none yet"})`);
  const view = await client.call<DesktopView>("teamDesktop", { id: agent.id });
  if (flags.out) writePrivately(flags.out, Buffer.from(view.shot.data, "base64"));
  const held = view.held ?? null;
  if (flags.json) {
    io.out(`${JSON.stringify({ agent: agent.id, width: view.width, height: view.height, mediaType: view.shot.mediaType, held, out: flags.out ?? null })}\n`);
    return EXIT.ok;
  }
  const name = plainLine(agent.name);
  const lines = [`${name}'s screen · ${view.width}×${view.height} · seen just now`];
  if (held) lines.push(`You have it until ${new Date(holdEnds(held, io.now())).toISOString().slice(11, 16)} UTC. ${name}'s desktop commands wait.`);
  else lines.push(`No one has it: ${name}'s own desktop commands run.`);
  if (flags.out) lines.push(`Its picture: ${plainLine(flags.out)}`);
  lines.push(faint(io.style, "Watch it live, and take it over, in an app."));
  io.out(`${lines.join("\n")}\n`);
  return EXIT.ok;
};

/**
 * The picture to `path`, readable by you alone: written beside it with mode 0600 and moved over it, so a file there before
 * is replaced whole, and never left readable by others with what a screen can show.
 */
function writePrivately(path: string, bytes: Uint8Array): void {
  const beside = join(dirname(path), `.${basename(path)}.${process.pid}.part`);
  try {
    writeFileSync(beside, bytes, { mode: 0o600, flag: "wx" });
    renameSync(beside, path);
  } catch (error) {
    rmSync(beside, { force: true });
    throw new CliError(`couldn't write the picture to ${plainLine(path)}: ${(error as Error).message}`);
  }
}
