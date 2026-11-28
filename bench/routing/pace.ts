import { Pacer } from "../../packages/models/src/bursts.ts";
import { rng, subSeed } from "../lib.ts";

/*
 * A plan's pace (bursts.ts Pacer, providers.ts pace), in virtual time. Several agents call one plan in turn, each call
 * followed by a command of its own (a few seconds, drawn from the seed). The plan is OpenCode Go as it was measured on
 * 28 November 2026: it refuses a call once 25 have begun in the minute before, and a model's call takes 2.58 s, C1's
 * median through it. Without the pace a refused call is waited out as bursts.ts does (2, 4, 8, 16, then 30 s, six asks
 * in all, then given up: the turn's next model is asked, or the turn fails). With it, every call takes its turn from
 * the node's one pacer, as chat() and the gateway do, at the preset's 24 a minute. The pacer is the real one; the
 * plan's refusals and the waits after them are the stand-in's.
 */

const SECOND = 1_000;
export const LIMIT_PER_MINUTE = 25;
export const CALL_MS = 2_580;
/** The waits before each ask again of a burst (bursts.ts), and how many asks in all before it is given up. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface PaceResult {
  /** Calls the plan answered. */
  served: number;
  /** Asks it refused as a burst. */
  refused: number;
  /** Calls given up after six refusals: each a turn's model passed over, or a turn failed. */
  givenUp: number;
  /** Seconds the agents spent waiting their turn or waiting out a burst, in all. */
  waitedS: number;
}

export function runPace(options: { seed: number; agents?: number; minutes?: number; pace?: number }): PaceResult {
  const random = rng(subSeed(options.seed, "routing.pace"));
  const agents = options.agents ?? 4;
  const end = (options.minutes ?? 10) * 60 * SECOND;
  const pacer = options.pace ? new Pacer() : null;
  /** When each call the plan served began: what it counts a minute back from. */
  const served: number[] = [];
  const result: PaceResult = { served: 0, refused: 0, givenUp: 0, waitedS: 0 };
  // Each agent's next ask: when, and how many times this call has been refused so far.
  const next = Array.from({ length: agents }, (_, i) => ({ at: i * 500, refusals: 0 }));
  for (;;) {
    let who = -1;
    for (let i = 0; i < agents; i++) if (next[i]!.at < end && (who === -1 || next[i]!.at < next[who]!.at)) who = i;
    if (who === -1) break;
    const ask = next[who]!;
    // Its turn first, with the pace (the waits a burst would have cost, taken before).
    const wait = pacer && ask.refusals === 0 ? pacer.turn("opencode-go", options.pace!, ask.at) : 0;
    const begins = ask.at + wait;
    result.waitedS += wait / SECOND;
    const lastMinute = served.filter((t) => t > begins - 60 * SECOND).length;
    if (lastMinute >= LIMIT_PER_MINUTE) {
      result.refused += 1;
      if (ask.refusals + 1 >= BACKOFF_MS.length + 1) {
        // Given up: the turn goes on without this model, after a command's worth of time.
        result.givenUp += 1;
        next[who] = { at: begins + (1 + random() * 4) * SECOND, refusals: 0 };
      } else {
        const backoff = BACKOFF_MS[ask.refusals]!;
        result.waitedS += backoff / SECOND;
        next[who] = { at: begins + backoff, refusals: ask.refusals + 1 };
      }
      continue;
    }
    served.push(begins);
    result.served += 1;
    // Its answer, then a command of its own (1 to 5 s), then its next call.
    next[who] = { at: begins + CALL_MS + (1 + random() * 4) * SECOND, refusals: 0 };
  }
  result.waitedS = Math.round(result.waitedS * 10) / 10;
  return result;
}
