import { z } from "zod";

/*
 * The bank: read-only account information (PSD2 AIS) from your own accounts through
 * Enable Banking. Agents read through four typed tools and need the bank:read scope,
 * which you grant per agent; authorising (and re-authorising every 89 days) needs
 * fleet:admin, which no agent can ever hold. There is no payment anything.
 */

/** An account's uid as Enable Banking returns it (a UUID today; kept strict either way). */
export const BankAccountUid = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "an account uid from bank_accounts");

/** A calendar date, YYYY-MM-DD, that exists. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
  }, "no such date");

export const BankBalancesInput = z.strictObject({
  account: BankAccountUid,
  /** Ask the bank now (within the day's budget) instead of serving the cache. */
  refresh: z.boolean().optional(),
});

export const BankTransactionsInput = z.strictObject({
  account: BankAccountUid,
  from: IsoDate,
  to: IsoDate,
  refresh: z.boolean().optional(),
});

/** The callback's parameters, as the bank's redirect carries them back. */
export const BankCompleteInput = z.strictObject({
  code: z.string().min(1).max(4096),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export interface BankAccountView {
  uid: string;
  name: string;
  /** Only the last four characters, unless asked for more where that's allowed. */
  iban: string | null;
  currency: string | null;
}

export interface BankStatusView {
  /** This node has an app ID, a key and a redirect URL configured. */
  configured: boolean;
  /** Why bank access is off (a key readable by others, a missing file…), in words. */
  problem: string | null;
  aspsp: string | null;
  accounts: BankAccountView[];
  validUntil: string | null;
  daysRemaining: number | null;
  reauthorizationRequired: boolean;
  /** Per account: background fetches left in the last 24 hours, and the newest cached data's age. */
  budget: { account: string; remaining: number; perDay: number; cacheAgeSeconds: number | null; coolingDownUntil: string | null }[];
  message: string;
}

/** Everything bank data tools return: what strangers wrote is marked as such. */
export interface UntrustedBankData<T> {
  untrusted_data: true;
  notice: string;
  source: "cache" | "live";
  fetched_at: string | null;
  note?: string;
  data: T;
}
