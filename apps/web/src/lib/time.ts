/*
 * Time, as people read it. Pure functions (no DOM) so they are unit-tested.
 * HLC strings look like `001762689012345.000003`: the digits before the dot are
 * wall-clock milliseconds, the rest is a logical counter.
 */

export function hlcMs(hlc: string): number | null {
  const ms = Number(hlc.split(".")[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "4 min ago", "3 h ago", "yesterday", "Mon", "Nov 3", "Nov 3, 2025"; future: "in 5 min". */
export function relativeTime(ms: number, now = Date.now()): string {
  const delta = now - ms;
  const future = delta < 0;
  const abs = Math.abs(delta);
  const wrap = (s: string) => (future ? `in ${s}` : `${s} ago`);
  if (abs < 45_000) return future ? "in a moment" : "just now";
  if (abs < HOUR) return wrap(`${Math.max(1, Math.round(abs / MIN))} min`);
  if (abs < DAY) return wrap(`${Math.round(abs / HOUR)} h`);
  if (future) return abs < 7 * DAY ? `in ${Math.round(abs / DAY)} d` : shortDate(ms, now);
  if (dayKey(ms) === dayKey(now - DAY)) return "yesterday";
  if (abs < 6 * DAY) return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  return shortDate(ms, now);
}

export function shortDate(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Local calendar day, e.g. "2026-11-09", for grouping a timeline. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(ms: number, now = Date.now()): string {
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - DAY)) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/**
 * The locale the list's times are said in: the app's language, English (every word of the app is), with the device's
 * region, its likely one where the device names none ("da": Denmark). So "Yesterday" and a weekday's name are English
 * while the clock and the date are written as that region writes them: a phone in Danish says "Thursday", "14.05",
 * "21/11/2026", never "torsdag" beside "Yesterday" (the lead's word, 28 November 2026: the owner is Danish).
 */
export function listLocale(device: string): string {
  const region = new Intl.Locale(device).maximize().region;
  return region ? `en-${region}` : "en";
}

/**
 * When, as a chat app's list says it (the list that is home on a phone, after Grok Bot): the clock time today, "Yesterday",
 * the weekday's name within the week before, else the date in numbers with its whole year. In the device's time zone, in
 * English with the device's region (listLocale): [zone] and [device] pin them, for the vectors every app checks. A day
 * ahead (a clock running fast) is a date too.
 */
export function listTime(ms: number, now: number, zone?: string, device?: string): string {
  const timeZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = listLocale(device ?? Intl.DateTimeFormat().resolvedOptions().locale);
  const days = calendarDay(now, timeZone) - calendarDay(ms, timeZone);
  if (days === 0) return new Intl.DateTimeFormat(locale, { timeZone, timeStyle: "short" }).format(ms);
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(ms);
  return new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(ms);
}

/** The day [ms] falls on by the calendar in [timeZone], as a count of days: its date there, not a 24-hour span. */
export function calendarDay(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((one) => one.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY;
}

/**
 * When a chat went on, as its small centred mark says it (after Grok Bot's; I10's for the iPhone): the day as people say
 * it, then its clock time: "Today 09:41", "Yesterday 18:20", the weekday's name within the week before ("Tuesday
 * 10:00"), else the date with its month's short name ("21 Nov 2026 09:00"). In the device's time zone, in English with
 * its region (listLocale), as the list says its times; a day ahead is a date.
 */
export function timeMark(ms: number, now: number, zone?: string, device?: string): string {
  const timeZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = listLocale(device ?? Intl.DateTimeFormat().resolvedOptions().locale);
  const days = calendarDay(now, timeZone) - calendarDay(ms, timeZone);
  const clock = new Intl.DateTimeFormat(locale, { timeZone, timeStyle: "short" }).format(ms);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  if (days > 1 && days < 7) return `${new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(ms)} ${clock}`;
  return `${new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "short", day: "numeric" }).format(ms)} ${clock}`;
}

/** "850 ms", "4.2 s", "3 min 20 s", "1 h 5 min". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < MIN) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  if (ms < HOUR) {
    const s = Math.round((ms % MIN) / 1000);
    return s ? `${Math.floor(ms / MIN)} min ${s} s` : `${Math.floor(ms / MIN)} min`;
  }
  const m = Math.round((ms % HOUR) / MIN);
  return m ? `${Math.floor(ms / HOUR)} h ${m} min` : `${Math.floor(ms / HOUR)} h`;
}

/** "9:05" for a countdown; "1:02:03" past an hour. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Minutes as people say them: "45 min", "2 h", "1 d 6 h". */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.round((minutes % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
