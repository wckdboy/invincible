/** Shared UI/runtime limits, without loading boundary validation in the PWA. The last three are Galahad's own
 * allowance in a day, from your conversation: knights he seats, messages he sends them, and tasks he gives the Roundtable. */
export const TEAM_LIMITS = { teammates: 32, rooms: 128, pending: 256, message: 20_000, memory: 12_000, output: 40_000, progress: 8_000, history: 100, recruitsPerDay: 8, saysPerDay: 40, givesPerDay: 12, ownTaskUsd: 3 } as const;
// ownTaskUsd: what a proposed task he starts on his own yes may spend at most (your word, 23 November 2026: he approves his
// own decisions and his knights'; past this, or past what is left of your budget, money is yours to say).
