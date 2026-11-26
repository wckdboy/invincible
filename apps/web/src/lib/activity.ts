import type { ActionClass, LedgerEntry, Verdict } from "../types.ts";

/*
 * The activity timeline as the app filters it. Pure functions (no DOM), unit-tested.
 */

export const CLASS_LABEL: Record<ActionClass, string> = { read: "Read", create: "Create", modify: "Modify", outward: "Outward", delete: "Delete", forbidden: "Forbidden" };
export const VERDICT_LABEL: Record<Verdict, string> = { allow: "allowed", ask: "asked you", deny: "denied", approved: "you approved" };

export interface LedgerFilter {
  /** Empty: every kind. */
  classes: Set<ActionClass>;
  verdict: Verdict | "all";
  query: string;
}

/** Everything a row shows, as one lowercase text: what the search looks through. */
function rowText(entry: LedgerEntry, deviceName: string): string {
  return [entry.resource, entry.target, entry.quest ?? "", entry.reason ?? "", entry.detail ?? "", deviceName, CLASS_LABEL[entry.class] ?? entry.class, VERDICT_LABEL[entry.verdict] ?? entry.verdict]
    .join("\n")
    .toLowerCase();
}

/** In the chosen kinds, with the chosen verdict, and every word of the query somewhere in the row. */
export function ledgerMatches(entry: LedgerEntry, filter: LedgerFilter, deviceName: string): boolean {
  if (filter.classes.size && !filter.classes.has(entry.class)) return false;
  if (filter.verdict !== "all" && entry.verdict !== filter.verdict) return false;
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = rowText(entry, deviceName);
  return words.every((w) => text.includes(w));
}

/** The filter in plain words, for the control that sets it. */
export function ledgerFilterSummary(filter: Pick<LedgerFilter, "classes" | "verdict">): string {
  const kinds = [...filter.classes];
  const all = Object.keys(CLASS_LABEL).length;
  const classes = !kinds.length || kinds.length === all ? null : kinds.length <= 2 ? kinds.map((c) => CLASS_LABEL[c]).join(", ") : `${kinds.length} kinds`;
  const verdict = filter.verdict === "all" ? null : VERDICT_LABEL[filter.verdict];
  if (!classes && !verdict) return "All activity";
  if (!classes) return verdict![0]!.toUpperCase() + verdict!.slice(1);
  return verdict ? `${classes} · ${verdict}` : classes;
}

/** Changes when the entries do (a background refresh with nothing new leaves the list alone). */
export const ledgerSignature = (entries: LedgerEntry[]): string => `${entries.length}:${entries.map((e) => e.id).join(",")}`;
