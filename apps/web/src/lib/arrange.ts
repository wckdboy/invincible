/*
 * Who sits where when the agents are shown. Pure (no DOM). The primary is in no list of yours: it comes first, then the
 * agents as the node lists them (by handle).
 */

/** The primary's handle among the agents (core's TEAM_PRIMARY: the app takes only types from core's team module). */
export const PRIMARY = "primary";

/** Everyone at the table as they are shown: the primary first, then the agents. */
export const seating = (agents: readonly string[]): string[] => [PRIMARY, ...agents];
