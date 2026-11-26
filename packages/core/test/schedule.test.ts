import { describe, expect, test } from "bun:test";
import { CATCH_UP_MS, dueRun, isTimeZone, nextRun, parseSchedule, ScheduleError } from "../src/index.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const next = (text: string, after: string, tz?: string) => iso(nextRun(parseSchedule(text), at(after), tz));

describe("schedules", () => {
  test("intervals are aligned to the clock, so a restart never shifts them", () => {
    expect(parseSchedule("every 30m")).toMatchObject({ kind: "every", ms: 30 * 60_000, text: "every 30m" });
    expect(next("every 30m", "2026-11-09T10:07:13Z")).toBe("2026-11-09T10:30:00.000Z");
    expect(next("every 30m", "2026-11-09T10:30:00Z")).toBe("2026-11-09T11:00:00.000Z");
    expect(next("every 2h", "2026-11-09T10:07:00Z")).toBe("2026-11-09T12:00:00.000Z");
    expect(next("Every 1D", "2026-11-09T10:07:00Z")).toBe("2026-11-10T00:00:00.000Z");
  });

  test("intervals are bounded", () => {
    expect(() => parseSchedule("every 0m")).toThrow(ScheduleError);
    expect(() => parseSchedule("every 400d")).toThrow(ScheduleError);
    expect(() => parseSchedule("every 5s")).toThrow(ScheduleError);
  });

  test("cron: fields, ranges, lists, steps, names and aliases", () => {
    // Friday 08:00 → the next weekday 07:00 is Monday.
    expect(next("0 7 * * 1-5", "2026-11-06T08:00:00Z")).toBe("2026-11-09T07:00:00.000Z");
    expect(next("*/15 * * * *", "2026-11-09T10:07:00Z")).toBe("2026-11-09T10:15:00.000Z");
    expect(next("5/20 * * * *", "2026-11-09T10:26:00Z")).toBe("2026-11-09T10:45:00.000Z");
    expect(next("0 9,17 * * *", "2026-11-09T10:00:00Z")).toBe("2026-11-09T17:00:00.000Z");
    expect(next("0 9 * jan mon", "2026-11-09T10:00:00Z")).toBe("2027-01-04T09:00:00.000Z");
    expect(next("0 0 * * 7", "2026-11-09T10:00:00Z")).toBe("2026-11-15T00:00:00.000Z"); // 7 is Sunday too
    expect(next("@daily", "2026-11-09T10:00:00Z")).toBe("2026-11-10T00:00:00.000Z");
    expect(next("@hourly", "2026-11-09T10:00:00Z")).toBe("2026-11-09T11:00:00.000Z");
  });

  test("cron: a day matching either day-of-month or day-of-week runs (Vixie)", () => {
    expect(next("0 0 13 * 5", "2026-02-01T00:00:00Z")).toBe("2026-02-06T00:00:00.000Z"); // a Friday comes first
    expect(next("0 0 13 * *", "2026-02-01T00:00:00Z")).toBe("2026-02-13T00:00:00.000Z");
  });

  test("cron reads the wall clock of its zone, across daylight saving and odd offsets", () => {
    expect(next("0 7 * * *", "2026-11-06T08:00:00Z", "Europe/Copenhagen")).toBe("2026-11-07T06:00:00.000Z"); // CET
    expect(next("0 7 * * *", "2026-07-01T08:00:00Z", "Europe/Copenhagen")).toBe("2026-07-02T05:00:00.000Z"); // CEST
    // 02:30 doesn't exist in Copenhagen on 29 March 2026 (clocks jump 02:00 → 03:00): that day is skipped.
    expect(next("30 2 * * *", "2026-03-28T12:00:00Z", "Europe/Copenhagen")).toBe("2026-03-30T00:30:00.000Z");
    expect(next("0 9 * * *", "2026-11-06T08:00:00Z", "Asia/Kolkata")).toBe("2026-11-07T03:30:00.000Z"); // +05:30
  });

  test("a schedule that never comes says so, and a rare one is still found", () => {
    expect(next("0 0 31 2 *", "2026-11-06T08:00:00Z")).toBeNull();
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z", "Europe/Copenhagen")).toBe("2028-02-28T23:00:00.000Z");
  });

  test('"never": a loop that only something else wakes has no run and is never due', () => {
    for (const text of ["never", " NEVER "]) expect(parseSchedule(text)).toEqual({ kind: "never", text: "never" });
    const never = parseSchedule("never");
    expect(nextRun(never, Date.UTC(2026, 10, 18))).toBeNull();
    expect(dueRun(never, Number.NEGATIVE_INFINITY, Date.UTC(2026, 10, 18))).toBeNull();
    expect(() => parseSchedule("never ever")).toThrow(ScheduleError);
  });

  test('"at": once, at a time of day in the loop\'s zone; then never again', () => {
    for (const text of ["at 2026-11-25 09:00", " AT 2026-11-25T09:00 "]) expect(parseSchedule(text)).toMatchObject({ kind: "once", text: "at 2026-11-25 09:00" });
    // 09:00 in Copenhagen is 08:00 UTC in November, 07:00 in June.
    expect(next("at 2026-11-25 09:00", "2026-11-24T20:00:00Z", "Europe/Copenhagen")).toBe("2026-11-25T08:00:00.000Z");
    expect(next("at 2027-06-01 09:00", "2026-11-24T20:00:00Z", "Europe/Copenhagen")).toBe("2027-06-01T07:00:00.000Z");
    expect(next("at 2026-11-25 09:00", "2026-11-24T20:00:00Z")).toBe("2026-11-25T09:00:00.000Z");
    // Once it has come, there is no next.
    expect(next("at 2026-11-25 09:00", "2026-11-25T08:00:00Z", "Europe/Copenhagen")).toBeNull();
    const once = parseSchedule("at 2026-11-25 09:00");
    const t = at("2026-11-25T08:00:00Z");
    expect(dueRun(once, at("2026-11-24T20:00:00Z"), t - 1, "Europe/Copenhagen")).toBeNull();
    expect(dueRun(once, at("2026-11-24T20:00:00Z"), t, "Europe/Copenhagen")).toBe(t);
    // A node away at the time runs it when it is back (within a week, as any loop), and never twice.
    expect(dueRun(once, at("2026-11-24T20:00:00Z"), t + 3 * 3600_000, "Europe/Copenhagen")).toBe(t);
    expect(dueRun(once, t, t + 3 * 3600_000, "Europe/Copenhagen")).toBeNull();
    expect(dueRun(once, at("2026-11-24T20:00:00Z"), t + CATCH_UP_MS + 1, "Europe/Copenhagen")).toBeNull();
    // A time the clocks skip (02:30 on the morning summer time begins) is as much later as they moved: 03:30. One they
    // repeat (02:30 on the morning it ends), the first.
    expect(next("at 2027-03-28 02:30", "2027-03-01T00:00:00Z", "Europe/Copenhagen")).toBe("2027-03-28T01:30:00.000Z");
    expect(next("at 2026-10-25 02:30", "2026-10-01T00:00:00Z", "Europe/Copenhagen")).toBe("2026-10-25T00:30:00.000Z");
    for (const bad of ["at 2026-02-30 09:00", "at 2026-13-01 09:00", "at 2026-11-25 24:00", "at 2026-11-25 9:00", "at tomorrow 09:00", "at 2026-11-25"]) {
      expect(() => parseSchedule(bad)).toThrow(ScheduleError);
    }
  });

  test("malformed cron lines are refused with a reason", () => {
    for (const bad of ["61 * * * *", "* * *", "* * * * * *", "1-x * * * *", "5-1 * * * *", "*/0 * * * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 8", ""]) {
      expect(() => parseSchedule(bad)).toThrow(ScheduleError);
    }
  });

  test("due: the latest missed slot runs once, never once per missed slot", () => {
    const schedule = parseSchedule("every 30m");
    expect(iso(dueRun(schedule, at("2026-11-09T09:00:00Z"), at("2026-11-09T11:10:00Z")))).toBe("2026-11-09T11:00:00.000Z");
    expect(dueRun(schedule, at("2026-11-09T11:00:00Z"), at("2026-11-09T11:10:00Z"))).toBeNull();
    const weekdays = parseSchedule("0 7 * * 1-5");
    expect(iso(dueRun(weekdays, at("2026-11-05T07:00:00Z"), at("2026-11-09T08:00:00Z")))).toBe("2026-11-09T07:00:00.000Z");
    expect(dueRun(weekdays, at("2026-11-09T07:00:00Z"), at("2026-11-09T08:00:00Z"))).toBeNull();
  });

  test("due: a node away for months looks back a week at most", () => {
    const every = parseSchedule("* * * * *");
    const now = at("2026-11-09T12:00:30Z");
    const started = performance.now();
    expect(iso(dueRun(every, 0, now))).toBe("2026-11-09T12:00:00.000Z");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(CATCH_UP_MS).toBe(7 * 24 * 60 * 60_000);
  });

  test("time zones are IANA names", () => {
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Europe/Copenhagen")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("Europe/Copenhagen; rm -rf")).toBe(false);
  });
});
