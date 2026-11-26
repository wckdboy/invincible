import type { BankStatusView } from "@galahad/core";

/*
 * The bank page, as people read it. Pure functions (no DOM), unit-tested.
 */

export interface BankCallback {
  code: string | null;
  state: string | null;
  error: string | null;
}

/** What the bank's redirect brought back (read once, then removed from the address bar). */
export function readBankCallback(search: string): BankCallback {
  const params = new URLSearchParams(search);
  const clip = (v: string | null, n: number) => (v === null ? null : v.slice(0, n));
  const error = params.get("error");
  const description = params.get("error_description");
  return {
    code: clip(params.get("code"), 4096),
    state: clip(params.get("state"), 64),
    error: error ? clip(`${error}${description ? `: ${description}` : ""}`.replace(/[\u0000-\u001f]/g, " "), 300) : null,
  };
}

/** How much of the consent is left, as a fraction of the 89 days asked for. */
export const consentLeft = (s: BankStatusView, days = 89): number => (s.daysRemaining === null ? 0 : Math.max(0, Math.min(1, s.daysRemaining / days)));

/** A sentence about an account's background fetches. */
export function budgetLabel(b: BankStatusView["budget"][number], now = Date.now()): string {
  const age = b.cacheAgeSeconds === null ? "nothing cached yet" : b.cacheAgeSeconds < 120 ? "cache just now" : b.cacheAgeSeconds < 7200 ? `cache ${Math.round(b.cacheAgeSeconds / 60)} min old` : `cache ${Math.round(b.cacheAgeSeconds / 3600)} h old`;
  const cooling = b.coolingDownUntil && Date.parse(b.coolingDownUntil) > now ? ` · the bank asked for a pause until ${new Date(b.coolingDownUntil).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "";
  return `${b.remaining} of ${b.perDay} background fetches left today · ${age}${cooling}`;
}

/** Why bank access is off, as one sentence (the node's message may begin by saying it's off). */
export function offReason(message: string): string {
  const reason = message.replace(/^\s*bank access is off[:.]?\s*/i, "").trim();
  if (!reason) return "";
  const sentence = reason[0]!.toUpperCase() + reason.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
