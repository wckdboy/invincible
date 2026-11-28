import { expect, test } from "bun:test";
import { listLocale, listTime, timeMark } from "./time.ts";

// Saturday 28 November 2026, 14:30 in Copenhagen (13:30 UTC); a list in British English, as the vectors pin it.
const NOW = Date.UTC(2026, 10, 28, 13, 30);
const ZONE = "Europe/Copenhagen";
const LOCALE = "en-GB";
/** A moment, as Copenhagen's clock read it (CET: UTC + 1 in November and December). */
const cph = (year: number, month: number, day: number, hour: number, minute: number) => Date.UTC(year, month - 1, day, hour - 1, minute);
const said = (ms: number) => listTime(ms, NOW, ZONE, LOCALE);

test("today, the clock time, in the device's own zone: one past midnight there is today, though UTC had not got there", () => {
  expect(said(cph(2026, 11, 28, 14, 5))).toBe("14:05");
  expect(said(cph(2026, 11, 28, 0, 30))).toBe("00:30");
  // (A clock running a minute fast is still today.)
  expect(said(cph(2026, 11, 28, 14, 31))).toBe("14:31");
});

test("the day before, Yesterday, to its last minute", () => {
  expect(said(cph(2026, 11, 27, 23, 59))).toBe("Yesterday");
  expect(said(cph(2026, 11, 27, 0, 1))).toBe("Yesterday");
});

test("two to six days back, the weekday's name; a week back and older, the date in numbers with its whole year", () => {
  expect(said(cph(2026, 11, 26, 9, 0))).toBe("Thursday");
  expect(said(cph(2026, 11, 22, 9, 0))).toBe("Sunday");
  expect(said(cph(2026, 11, 21, 9, 0))).toBe("21/11/2026");
  expect(said(cph(2025, 12, 31, 23, 0))).toBe("31/12/2025");
});

test("a day ahead, from a clock running fast, is its date", () => {
  expect(said(cph(2026, 11, 29, 9, 0))).toBe("29/11/2026");
});

test("a phone in Danish: the app's words, English, in Denmark's clock and dates, never torsdag beside Yesterday", () => {
  const dane = (ms: number) => listTime(ms, NOW, ZONE, "da-DK");
  expect(dane(cph(2026, 11, 28, 14, 5))).toBe("14.05");
  expect(dane(cph(2026, 11, 27, 23, 59))).toBe("Yesterday");
  expect(dane(cph(2026, 11, 26, 9, 0))).toBe("Thursday");
  expect(dane(cph(2026, 11, 21, 9, 0))).toBe("21/11/2026");
});

test("they're said in English with the device's region: its likely one where it names none", () => {
  expect(listLocale("da-DK")).toBe("en-DK");
  expect(listLocale("da")).toBe("en-DK");
  expect(listLocale("en-GB")).toBe("en-GB");
  expect(listLocale("en")).toBe("en-US");
  expect(listLocale("de-AT")).toBe("en-AT");
});

test("a chat's mark says when it went on: the day as people say it, then its clock time", () => {
  const mark = (ms: number, device = LOCALE) => timeMark(ms, NOW, ZONE, device);
  expect(mark(cph(2026, 11, 28, 9, 41))).toBe("Today 09:41");
  expect(mark(cph(2026, 11, 27, 18, 20))).toBe("Yesterday 18:20");
  expect(mark(cph(2026, 11, 24, 10, 0))).toBe("Tuesday 10:00");
  expect(mark(cph(2026, 11, 21, 9, 0))).toBe("21 Nov 2026 09:00");
  expect(mark(cph(2026, 11, 5, 8, 0))).toBe("5 Nov 2026 08:00");
  // (A phone in Danish: the app's words, Denmark's clock.)
  expect(mark(cph(2026, 11, 27, 18, 20), "da-DK")).toBe("Yesterday 18.20");
  expect(mark(cph(2026, 11, 24, 10, 0), "da-DK")).toBe("Tuesday 10.00");
});
