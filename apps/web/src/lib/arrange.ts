/*
 * Who sits where when the agents are shown. Pure (no DOM). Galahad is in no list of yours: he comes first, then the
 * knights as the node lists them (by handle).
 */

/** Galahad's handle at the Roundtable (core's TEAM_GALAHAD: the app takes only types from core's team module). */
export const GALAHAD = "galahad";

/** Everyone at the table as they are shown: Galahad first, then the knights. */
export const seating = (knights: readonly string[]): string[] => [GALAHAD, ...knights];
