/** Shared UI/runtime limits, without loading boundary validation in the PWA. recruitsPerDay, saysPerDay and givesPerDay
 * are the primary's own allowance in a day, from your conversation: agents it seats, messages it sends them, and tasks
 * it gives the agents. */
export const TEAM_LIMITS = { agents: 32, rooms: 128, pending: 256, message: 20_000, memory: 12_000, output: 40_000, progress: 8_000, history: 100, recruitsPerDay: 8, saysPerDay: 40, givesPerDay: 12, ownTaskUsd: 3, ownDailyUsd: 10, steer: 4_000, steers: 20 } as const;
// ownTaskUsd: what a task it gives, or a proposed one it starts on its own yes, may spend at most (your word, 23 November
// 2026: it approves its own decisions and its agents'; past this, or past what is left of your budget, money is yours to say).
// ownDailyUsd: with no usage budget of yours, what it may commit on its own word in a day (the budgets of the tasks it
// gives, and of the proposals it approves itself), until you set another (invincible agents daily <usd>): three of its own
// $3 tasks fit, and a fourth is yours. (The system it succeeds was held to $2 a day, which no $3 task fits.)
// steer, steers: how long one steer of a running task may be, and how many a task takes in all (yours and your agent's
// together): every one is said to the work and to its reviewer, in order, so they are bounded as a prompt is.

/** A dollar amount you set as a cap, as you would write it: whole dollars bare ($10), else to the cent ($2.50). */
export const capLabel = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`);
