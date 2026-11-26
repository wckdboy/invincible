/*
 * The doctor: one look at a whole installation, answered in plain lines. Each line is one
 * check: ok, needs you, or broken, and for anything that isn't ok, what to do about it.
 * Read-only: the doctor changes nothing.
 *
 * No zod here: the PWA draws from this file. The route's input is checked in api.ts.
 */

/** ok: well · needs-you: works, but something is yours to do · broken: doesn't work · skipped: not looked at this time (and why). */
export const DOCTOR_STATES = ["ok", "needs-you", "broken", "skipped"] as const;
export type DoctorState = (typeof DOCTOR_STATES)[number];

/** What a check is about, in the order a report lists them. */
export const DOCTOR_AREAS = ["node", "mind", "vault", "models", "archive", "sandbox", "compute", "loops", "connectors", "app", "notify", "disk", "service"] as const;
export type DoctorArea = (typeof DOCTOR_AREAS)[number];

export const DOCTOR_AREA_TITLES: Record<DoctorArea, string> = {
  node: "This node",
  mind: "The mind",
  vault: "The vault",
  models: "Models",
  archive: "The archive",
  sandbox: "Sandboxes",
  compute: "Compute",
  loops: "Loops",
  connectors: "Connectors",
  app: "The app",
  notify: "Notifications",
  disk: "Disk",
  service: "The service",
};

export interface DoctorCheck {
  /** Stable: the same check keeps the same id ("mind.clock", "role.planner"). */
  id: string;
  area: DoctorArea;
  state: DoctorState;
  /** What was found, in a plain line. Never a secret. */
  line: string;
  /** What to do, for anything that isn't ok. */
  fix?: string;
  /** How long it took, where that's worth saying (a model's answer, a container's start). */
  ms?: number;
}

export interface DoctorTally {
  ok: number;
  needsYou: number;
  broken: number;
  skipped: number;
}

export interface DoctorReport {
  node: string;
  at: number;
  /** Quick: only what costs nothing to look at (no model call, no container, no integrity scan, no connector probe). */
  quick: boolean;
  /** Offline: nothing was sent outward (no model was asked, no connector's service probed). */
  offline: boolean;
  checks: DoctorCheck[];
  tally: DoctorTally;
  tookMs: number;
}

export function doctorTally(checks: readonly Pick<DoctorCheck, "state">[]): DoctorTally {
  const tally: DoctorTally = { ok: 0, needsYou: 0, broken: 0, skipped: 0 };
  for (const check of checks) {
    if (check.state === "ok") tally.ok += 1;
    else if (check.state === "needs-you") tally.needsYou += 1;
    else if (check.state === "broken") tally.broken += 1;
    else tally.skipped += 1;
  }
  return tally;
}

/** A process's exit code for a report: 0 all is well (skipped checks don't count), 1 something needs you, 2 something is broken. */
export const doctorExit = (tally: DoctorTally): 0 | 1 | 2 => (tally.broken ? 2 : tally.needsYou ? 1 : 0);

/** The verdict in a sentence. */
export function doctorVerdict(tally: DoctorTally): string {
  const parts: string[] = [];
  if (tally.broken) parts.push(`${tally.broken} broken`);
  if (tally.needsYou) parts.push(`${tally.needsYou} ${tally.needsYou === 1 ? "needs" : "need"} you`);
  const skipped = tally.skipped ? ` (${tally.skipped} not looked at)` : "";
  if (!parts.length) return `All is well: ${tally.ok} ${tally.ok === 1 ? "check" : "checks"} passed${skipped}.`;
  return `${parts.join(", ")}; ${tally.ok} well${skipped}.`;
}

export const DOCTOR_STATE_WORDS: Record<DoctorState, string> = { ok: "ok", "needs-you": "needs you", broken: "broken", skipped: "skipped" };

/** Checks in the report's order: by area, and within one the worst first, otherwise as given. */
export function doctorSorted<T extends Pick<DoctorCheck, "area" | "state">>(checks: readonly T[]): T[] {
  const area = (a: DoctorArea) => DOCTOR_AREAS.indexOf(a);
  const rank: Record<DoctorState, number> = { broken: 0, "needs-you": 1, ok: 2, skipped: 3 };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => area(a.check.area) - area(b.check.area) || rank[a.check.state] - rank[b.check.state] || a.index - b.index)
    .map((entry) => entry.check);
}

/** How long a check took, for a line: "840 ms", "1.7 s". */
export const doctorTook = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** How a terminal may dress the lines (colour); plain by default. */
export interface DoctorStyle {
  head(text: string): string;
  state(state: DoctorState, text: string): string;
  dim(text: string): string;
}
const PLAIN: DoctorStyle = { head: (s) => s, state: (_state, s) => s, dim: (s) => s };

/** A report as lines for a terminal: a heading per area, a line per check, the advice under it, the verdict last. */
export function doctorLines(report: DoctorReport, style: DoctorStyle = PLAIN): string[] {
  const out: string[] = [];
  let area: DoctorArea | null = null;
  for (const check of doctorSorted(report.checks)) {
    if (check.area !== area) {
      area = check.area;
      out.push("", style.head(DOCTOR_AREA_TITLES[area]));
    }
    const took = check.ms !== undefined && check.state !== "skipped" ? style.dim(` (${doctorTook(check.ms)})`) : "";
    out.push(`  ${style.state(check.state, DOCTOR_STATE_WORDS[check.state].padEnd(9))} ${check.line}${took}`);
    if (check.fix && check.state !== "ok") out.push(`            ${style.dim("→")} ${check.fix}`);
  }
  out.push("", style.head(doctorVerdict(report.tally)));
  return out;
}
