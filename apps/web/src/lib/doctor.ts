import type { DoctorArea, DoctorCheck, DoctorReport, DoctorState } from "@galahad/core/doctor";
import { DOCTOR_AREA_TITLES, doctorSorted, doctorTook, doctorVerdict } from "@galahad/core/doctor";

/*
 * The doctor's report as the Overview draws it (pure: the card only lays it out).
 * What needs you comes first, each with what to do; everything else is one click away,
 * grouped the way a terminal lists it.
 */

export type DoctorTone = "ok" | "warn" | "danger" | "neutral";

export const stateTone = (state: DoctorState): DoctorTone => (state === "broken" ? "danger" : state === "needs-you" ? "warn" : state === "ok" ? "ok" : "neutral");
export const STATE_LABEL: Record<DoctorState, string> = { ok: "Ok", "needs-you": "Needs you", broken: "Broken", skipped: "Not looked at" };

export interface DoctorCardView {
  tone: DoctorTone;
  /** "All is well: 31 checks passed." */
  headline: string;
  /** Which look this was, and how long it took. */
  how: string;
  /** What isn't ok, the worst first. */
  attention: DoctorCheck[];
  /** Every check, by area in the report's order. */
  groups: { area: DoctorArea; title: string; checks: DoctorCheck[] }[];
}

/** A check's line with how long it took, where that's worth saying. */
export const checkLine = (check: DoctorCheck): string => (check.ms !== undefined && check.state !== "skipped" ? `${check.line} (${doctorTook(check.ms)})` : check.line);

export function doctorCard(report: DoctorReport): DoctorCardView {
  const sorted = doctorSorted(report.checks);
  const rank = (state: DoctorState) => (state === "broken" ? 0 : 1);
  const attention = sorted.filter((c) => c.state === "broken" || c.state === "needs-you").sort((a, b) => rank(a.state) - rank(b.state));
  const groups: DoctorCardView["groups"] = [];
  for (const check of sorted) {
    const last = groups.at(-1);
    if (last?.area === check.area) last.checks.push(check);
    else groups.push({ area: check.area, title: DOCTOR_AREA_TITLES[check.area], checks: [check] });
  }
  const kind = report.quick ? "A quick look" : report.offline ? "A full check, offline" : "A full check";
  return {
    tone: report.tally.broken ? "danger" : report.tally.needsYou ? "warn" : "ok",
    headline: doctorVerdict(report.tally),
    how: `${kind} at ${report.node}, in ${doctorTook(report.tookMs)}`,
    attention,
    groups,
  };
}

/** A report the node sent, read at the page's boundary: anything that isn't one is no report. */
export function readDoctorReport(raw: unknown): DoctorReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DoctorReport>;
  if (typeof r.node !== "string" || typeof r.at !== "number" || !Array.isArray(r.checks) || !r.tally || typeof r.tally !== "object") return null;
  const states = new Set<string>(["ok", "needs-you", "broken", "skipped"]);
  const checks = r.checks.filter(
    (c): c is DoctorCheck => !!c && typeof c === "object" && typeof (c as DoctorCheck).id === "string" && typeof (c as DoctorCheck).line === "string" && states.has((c as DoctorCheck).state) && Object.hasOwn(DOCTOR_AREA_TITLES, (c as DoctorCheck).area),
  );
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    node: r.node,
    at: r.at,
    quick: r.quick === true,
    offline: r.offline === true,
    checks,
    tally: { ok: n(r.tally.ok), needsYou: n(r.tally.needsYou), broken: n(r.tally.broken), skipped: n(r.tally.skipped) },
    tookMs: n(r.tookMs),
  };
}
