import { plainLine, type SeatKind, type SeatSignInCard, type SeatView } from "@invincible/core";
import { quickLabel, seatStateWords } from "../../../../apps/web/src/lib/seats.ts";
import { CliError, EXIT, usageError } from "./exit.ts";
import type { Command, Io } from "./io.ts";

/*
 * Seats from a terminal (docs/CLI.md; core's seats.ts): the accounts you hold with a vendor, that any agent may use.
 *   inv seats                        each seat and where it stands
 *   inv seat add <claude|chatgpt> ["label"] [--email <address>]
 *                                    adds one and signs it in: its page to open (and Codex's code to enter there);
 *                                    for Claude, the code its page shows is pasted here
 *   inv seat sign-in <seat>          signs one in (again)
 *   inv seat remove <seat>           removes it, and its sign-in
 * A sign-in waits until it has ended: 0 signed in, 1 not (in its words). 30: this device may not.
 */

const USAGE = 'usage: inv seat add <claude|chatgpt> ["label"] [--email <address>] · inv seat sign-in <seat> · inv seat remove <seat>';
const KINDS: Record<string, SeatKind> = { claude: "claude-subscription", chatgpt: "chatgpt-codex" };

/** A seat by its id, its label, or the start of its id. */
function resolveSeat(seats: readonly SeatView[], ref: string | undefined): SeatView {
  if (!ref) throw usageError(USAGE);
  const found = seats.filter((seat) => seat.id === ref || seat.label === ref || (ref.length >= 4 && seat.id.slice(3).startsWith(ref.replace(/^st_/, ""))));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw usageError(`"${ref}" names ${found.length} seats: give its id`);
  throw new CliError(`no seat ${ref} (inv seats lists them)`);
}

export const seatsCommand: Command = async (conn, args, flags, io) => {
  if (args.length) throw usageError("usage: inv seats [--json]");
  const { client } = await conn();
  const { seats } = await client.call<{ seats: SeatView[] }>("seats");
  if (flags.json) {
    io.out(`${JSON.stringify({ seats })}\n`);
    return EXIT.ok;
  }
  if (!seats.length) {
    io.out("No seats yet: inv seat add claude, or inv seat add chatgpt.\n");
    return EXIT.ok;
  }
  for (const seat of seats) io.out(`${plainLine(seat.label)}  ${seat.vendor}  ${seatStateWords(seat.state, seat.plan, io.now()).word}  ${seat.id}\n`);
  return EXIT.ok;
};

export const seatCommand: Command = async (conn, args, flags, io) => {
  const [what, ...rest] = args;
  const { client } = await conn();
  if (what === "add") {
    const kind = KINDS[rest[0] ?? ""];
    if (!kind || rest.length > 2) throw usageError(USAGE);
    const { seats } = await client.call<{ seats: SeatView[] }>("seats");
    const { seat } = await client.call<{ seat: SeatView }>("addSeat", { kind, label: rest[1] ?? quickLabel(kind, seats), ...(flags.email ? { email: flags.email } : {}) });
    if (!flags.json) io.out(`Added ${plainLine(seat.label)} (${seat.id}).\n`);
    return signIn(client, seat, flags.json, flags.noAsk, io);
  }
  if (what === "sign-in") {
    if (rest.length !== 1) throw usageError(USAGE);
    const { seats } = await client.call<{ seats: SeatView[] }>("seats");
    return signIn(client, resolveSeat(seats, rest[0]), flags.json, flags.noAsk, io);
  }
  if (what === "remove") {
    if (rest.length !== 1) throw usageError(USAGE);
    const { seats } = await client.call<{ seats: SeatView[] }>("seats");
    const seat = resolveSeat(seats, rest[0]);
    await client.call("removeSeat", { id: seat.id });
    io.out(flags.json ? `${JSON.stringify({ removed: seat.id })}\n` : `Removed ${plainLine(seat.label)}, and its sign-in.\n`);
    return EXIT.ok;
  }
  throw usageError(USAGE);
};

type Client = Parameters<Command>[0] extends () => Promise<infer C> ? (C extends { client: infer K } ? K : never) : never;

/** A seat's sign-in, from here: its card said, Claude's code read from this terminal, and how it ended. */
async function signIn(client: Client, seat: SeatView, json: boolean, noAsk: boolean, io: Io): Promise<number> {
  const { card } = await client.call<{ card: SeatSignInCard }>("startSeatSignIn", { id: seat.id });
  if (json) io.out(`${JSON.stringify({ card })}\n`);
  else if (card.kind === "device-code") {
    if (card.firstTime) io.out("First, turn on device code sign-in in ChatGPT's settings (Security): this is its first ChatGPT seat.\n");
    io.out(`Open ${card.url} and sign in to the account this seat is for, then enter this code there: ${card.code}\n`);
  } else io.out(`Open ${card.url} and sign in to the account this seat is for.\n`);
  if (card.kind === "paste-code") {
    if (noAsk || !io.readLine) throw new CliError("its page shows a code to paste back here: run it in a terminal, without --no-ask", EXIT.usage);
    const code = (await io.readLine("Paste the code it shows: "))?.trim();
    if (!code) {
      await client.call("cancelSeatSignIn", { id: seat.id, attempt: card.attempt });
      throw new CliError("no code was given: the sign-in was cancelled");
    }
    await client.call("answerSeatSignIn", { id: seat.id, attempt: card.attempt, code });
  }
  for (;;) {
    const { seats } = await client.call<{ seats: SeatView[] }>("seats");
    const now = seats.find((one) => one.id === seat.id);
    if (!now) throw new CliError("the seat was removed meanwhile");
    if (now.state.is !== "signing-in") {
      const words = seatStateWords(now.state, now.plan, io.now()).word;
      if (json) io.out(`${JSON.stringify({ seat: now.id, state: now.state })}\n`);
      else io.out(`${plainLine(now.label)}: ${words}\n`);
      return now.state.is === "ready" ? EXIT.ok : EXIT.error;
    }
    if (io.signal.aborted) return EXIT.error;
    await Bun.sleep(io.pollMs ?? 2_000);
  }
}
