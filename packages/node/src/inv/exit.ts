/*
 * inv's exit codes (docs/CLI.md, "Exit codes"): a promise to scripts. The code is the verdict, so 0 means proven,
 * never merely that nothing broke. A code keeps its meaning, and a new one comes only with a new meaning. The test
 * holds this table to the one in docs/CLI.md.
 */

export const EXIT = {
  /** Proven; or, for a command that gives no verdict, it did what it says. */
  ok: 0,
  /** The command couldn't be done, or a task ended in a way no code below names. */
  error: 1,
  /** An unknown command or flag, or a missing or malformed argument. */
  usage: 2,
  /** The task ended with a gate that didn't pass. */
  gateFailed: 10,
  /** Every gate passed, and the reviewer sent it back until its revisions ran out. */
  rejected: 11,
  /** The reviewer passed it, but no gate shows the work. */
  unproven: 12,
  /** Stopped: by you, by its budget, or by a rule of yours (and an answer you stopped with Ctrl-C). */
  stopped: 13,
  /** With --no-ask it came to need you, and inv stopped it; for inv proof, it waits on you now. */
  needsYou: 20,
  /** --timeout ran out, or you left with Ctrl-C, and the task goes on; for inv proof, no verdict yet. */
  stillRunning: 21,
  /** The pairing was refused, or this device's key is no longer enrolled, or it lacks the scope. */
  refused: 30,
  /** Nothing answered at the node's address, or what answered wasn't the node. */
  unreachable: 31,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure with the code it exits with. Thrown, never `process.exit`, so what is open is closed on the way out. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exit: ExitCode = EXIT.error,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A command used wrongly: exit 2, with what would have been right. */
export const usageError = (message: string): CliError => new CliError(message, EXIT.usage);
