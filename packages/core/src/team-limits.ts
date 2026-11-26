/** Shared UI/runtime limits, without loading boundary validation in the PWA. The last three are the primary's own
 * allowance in a day, from your conversation: agents it seats, messages it sends them, and tasks it gives the agents. */
export const TEAM_LIMITS = { agents: 32, rooms: 128, pending: 256, message: 20_000, memory: 12_000, output: 40_000, progress: 8_000, history: 100, recruitsPerDay: 8, saysPerDay: 40, givesPerDay: 12, ownTaskUsd: 3 } as const;
// ownTaskUsd: what a proposed task it starts on its own yes may spend at most (your word, 23 November 2026: it approves its
// own decisions and its agents'; past this, or past what is left of your budget, money is yours to say).
