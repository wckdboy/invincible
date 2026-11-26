import type { Database } from "bun:sqlite";
import { costOf, mergeSpend, type Price, spendTotal, type Usage, type UsageBudgetInput, type UsageLine, type UsageMeter, type UsageRow, type UsageWindow } from "@galahad/core";

/*
 * This node's own count of its model calls: for each day, who asked, the role and the
 * model, how many calls and their tokens as the providers reported them. Node-local
 * (the home's local database, never the mind's log): it is telemetry about this
 * node's calls, a row per day and model, and nothing any replica decides on. What must
 * be the same everywhere (your prices, what a trial spent) is in the log instead.
 *
 * Counts only. Nothing of a prompt or an answer ever reaches this table.
 */

/** Days of rows kept (older ones are dropped as new ones are written). */
export const USAGE_KEEP_DAYS = 400;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class UsageStore {
  private lastPruned = "";

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL, who TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, who, role, model))`);
    db.exec("CREATE TABLE IF NOT EXISTS usage_budget (k TEXT PRIMARY KEY, usd REAL, per TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS spent_windows (provider TEXT PRIMARY KEY, until INTEGER NOT NULL, noted INTEGER NOT NULL, said TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS refused_keys (provider TEXT PRIMARY KEY, refused_at INTEGER NOT NULL, said TEXT NOT NULL)");
  }

  /**
   * The plans a provider said are spent, and until when (brain windows.ts), kept through a restart: their models stay
   * passed over, and the meter says so, until each resets. One that has ended is dropped.
   */
  spentWindows(): { provider: string; until: number; noted: number; said: string }[] {
    this.db.query("DELETE FROM spent_windows WHERE until <= ?").run(this.now());
    return this.db.query<{ provider: string; until: number; noted: number; said: string }, []>("SELECT provider, until, noted, said FROM spent_windows ORDER BY provider").all();
  }

  /** A plan's spent window, as its provider said it: kept until it ends (the latest told wins). */
  keepSpentWindow(window: { provider: string; until: number; noted: number; said: string }): void {
    this.db
      .query("INSERT INTO spent_windows (provider, until, noted, said) VALUES (?, ?, ?, ?) ON CONFLICT (provider) DO UPDATE SET until = excluded.until, noted = excluded.noted, said = excluded.said")
      .run(window.provider, window.until, window.noted, window.said);
  }

  /** Providers whose key a call got refused (brain refused-keys.ts), kept through a restart: the doctor says each. */
  refusedKeys(): { provider: string; at: number; said: string }[] {
    return this.db.query<{ provider: string; refused_at: number; said: string }, []>("SELECT provider, refused_at, said FROM refused_keys ORDER BY provider").all().map((row) => ({ provider: row.provider, at: row.refused_at, said: row.said }));
  }

  /** A provider's refused key, as its call said it: kept until a later call that got through forgets it (the latest told wins). */
  keepRefusedKey(refusal: { provider: string; at: number; said: string }): void {
    this.db
      .query("INSERT INTO refused_keys (provider, refused_at, said) VALUES (?, ?, ?) ON CONFLICT (provider) DO UPDATE SET refused_at = excluded.refused_at, said = excluded.said")
      .run(refusal.provider, refusal.at, refusal.said);
  }

  /** A later call to that provider got through: its key works, so its refusal is forgotten. */
  forgetRefusedKey(provider: string): void {
    this.db.query("DELETE FROM refused_keys WHERE provider = ?").run(provider);
  }

  /** Your budget for this node's calls: a day's or a month's, in US dollars at your prices (null: none). */
  budget(): { usd: number | null; per: "day" | "month" } {
    const row = this.db.query<{ usd: number | null; per: string }, []>("SELECT usd, per FROM usage_budget WHERE k = 'budget'").get();
    return { usd: row?.usd ?? null, per: row?.per === "day" ? "day" : "month" };
  }

  setBudget(input: UsageBudgetInput): { usd: number | null; per: "day" | "month" } {
    this.db.query("INSERT INTO usage_budget (k, usd, per) VALUES ('budget', ?, ?) ON CONFLICT (k) DO UPDATE SET usd = excluded.usd, per = excluded.per").run(input.usd, input.per);
    return this.budget();
  }

  /** This period's calls (today, or this month so far, UTC) at your prices, against the budget, with the providers whose
   * allowance is spent now (absent when there are none, so a client from before the windows reads the meter as it did). */
  meter(node: string, prices: Record<string, Price>, windows: readonly UsageWindow[] = []): UsageMeter {
    const { usd: budgetUsd, per } = this.budget();
    const today = dayOf(this.now());
    const since = per === "day" ? today : `${today.slice(0, 8)}01`;
    const rows = this.db
      .query<UsageRow, [string]>("SELECT day, who, role, model, calls, unknown, input, output, cached, reasoning FROM usage_daily WHERE day >= ?")
      .all(since);
    const lines: UsageLine[] = rows.map(({ day: _day, who: _who, ...line }) => line);
    const cost = costOf(lines, prices);
    const total = spendTotal(lines);
    const byModel = [...new Set(lines.map((l) => l.model))].map((model) => {
      const of = mergeSpend(lines.filter((l) => l.model === model));
      const priced = costOf(of, prices);
      return { model, usd: priced.unpriced.length ? null : priced.usd, tokens: spendTotal(of).tokens };
    });
    byModel.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.tokens - a.tokens);
    const meter: UsageMeter = {
      node,
      per,
      since,
      budgetUsd,
      spentUsd: cost.usd,
      complete: cost.complete,
      unpriced: cost.unpriced,
      tokens: total.tokens,
      calls: total.calls,
      leftUsd: budgetUsd === null ? null : Math.max(0, budgetUsd - cost.usd),
      top: byModel.slice(0, 5),
    };
    if (windows.length) meter.windows = windows.map(({ provider, until, said }) => ({ provider, until, said }));
    return meter;
  }

  /** One model call that ended: its tokens as the provider reported them, or null when it reported nothing. */
  note(who: string, role: string, model: string, usage: Usage | null): void {
    const day = dayOf(this.now());
    const n = (x: number | undefined): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
    const input = usage ? n(usage.input) : 0;
    const output = usage ? n(usage.output) : 0;
    this.db
      .query(
        `INSERT INTO usage_daily (day, who, role, model, calls, unknown, input, output, cached, reasoning) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (day, who, role, model) DO UPDATE SET calls = calls + 1, unknown = unknown + excluded.unknown,
           input = input + excluded.input, output = output + excluded.output, cached = cached + excluded.cached, reasoning = reasoning + excluded.reasoning`,
      )
      .run(day, who.slice(0, 100), role.slice(0, 40), model.slice(0, 200), usage ? 0 : 1, input, output, usage ? Math.min(n(usage.cached), input) : 0, usage ? Math.min(n(usage.reasoning), output) : 0);
    if (day !== this.lastPruned) {
      this.lastPruned = day;
      this.db.query("DELETE FROM usage_daily WHERE day < ?").run(dayOf(this.now() - USAGE_KEEP_DAYS * 86_400_000));
    }
  }

  /** The rows of the last `days` days (today included), newest day first. */
  rows(days: number): { since: string; rows: UsageRow[] } {
    const since = dayOf(this.now() - (Math.max(1, Math.floor(days)) - 1) * 86_400_000);
    const rows = this.db
      .query<UsageRow, [string]>("SELECT day, who, role, model, calls, unknown, input, output, cached, reasoning FROM usage_daily WHERE day >= ? ORDER BY day DESC, who, role, model")
      .all(since);
    return { since, rows };
  }
}

