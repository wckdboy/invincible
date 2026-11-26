import { costOf, type Prices, spendTotal, tokensLabel, type UsageLine, usdLabel } from "./spend.ts";

/*
 * What a knight's task came to, in words: the same from the same record at a terminal and in the
 * app. No dependencies (no zod): the PWA imports this directly (@galahad/core/team-record).
 */

/** A task's record as this reads it (a TeamTaskRecord has all of this). */
export interface TaskRecordRead {
  startedAt: number;
  endedAt: number;
  ended: string;
  commands: number;
  revisions: number;
  spent: readonly UsageLine[];
}

const took = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** Money at your prices: the whole of it, a lower bound ("at least") when a call went unreported, "no price" when a model that answered has none, nothing when nothing was counted. */
function money(total: ReturnType<typeof spendTotal>, cost: ReturnType<typeof costOf>): string {
  if (!total.calls || total.unknown === total.calls) return "";
  if (cost.unpriced.length) return "no price";
  return `${cost.complete ? "" : "at least "}${usdLabel(cost.usd)}`;
}

/**
 * A task's run in a few facts, in order: how it ended when that isn't "done", how long it took, its commands and
 * how often the work was sent back, its tokens as the providers reported them, and money at your prices where
 * every model that answered has one.
 */
export function taskRecordFacts(record: TaskRecordRead, prices: Prices): string[] {
  const total = spendTotal(record.spent);
  const cost = costOf(record.spent, prices);
  return [
    record.ended === "done" ? "" : `ended ${record.ended}`,
    took(record.endedAt - record.startedAt),
    `${record.commands} command${record.commands === 1 ? "" : "s"}${record.revisions ? `, sent back ${record.revisions === 1 ? "once" : `${record.revisions} times`}` : ""}`,
    !total.calls ? "no model calls" : total.unknown === total.calls ? "tokens unknown" : `${tokensLabel(total.tokens)}${total.complete ? "" : "+"} tokens`,
    money(total, cost),
  ].filter(Boolean);
}
