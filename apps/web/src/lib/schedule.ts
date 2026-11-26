/*
 * Loop schedules, as people say them. The node parses and runs schedules
 * (packages/core/src/schedule.ts); this only puts the common shapes into words
 * and leaves anything unusual as the cron line it is. Pure, so it is unit-tested.
 */

const UNIT: Record<string, [string, string]> = { m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"] };
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const normal = (text: string) => text.trim().replace(/\s+/g, " ");
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Once: "at 2026-11-25 09:00", a date and a time of day in the loop's zone. */
const ONCE = /^at (\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})$/;

/** The days of week a cron field names (0 = Sunday), or null for anything with steps or nonsense. */
function days(field: string): Set<number> | null {
  const out = new Set<number>();
  const day = (token: string): number | null => {
    const named = DAY_KEYS.indexOf(token);
    if (named >= 0) return named;
    if (!/^\d$/.test(token) || Number(token) > 7) return null;
    return Number(token) % 7;
  };
  for (const part of field.split(",")) {
    const [a, b, more] = part.split("-");
    if (more !== undefined || !a) return null;
    const lo = day(a);
    const hi = b === undefined ? lo : day(b);
    if (lo === null || hi === null) return null;
    // "5-7" runs Friday to Sunday (7 is Sunday too).
    const end = b !== undefined && b === "7" ? 7 : hi;
    if (end < lo) return null;
    for (let d = lo; d <= end; d++) out.add(d % 7);
  }
  return out;
}

function daysPhrase(set: Set<number>): string {
  const sorted = [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
  if (set.size === 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  if (set.size === 1) return `${DAY_NAMES[sorted[0]!]}s`;
  return sorted.map((d) => DAY_NAMES[d]!.slice(0, 3)).join(", ");
}

/** "every 30m" → "Every 30 minutes", "0 7 * * 1-5" → "Weekdays at 07:00"; null when it's best left as written. */
export function describeSchedule(input: string): string | null {
  const text = normal(input).toLowerCase();
  if (text === "never") return "Only when woken";
  const once = text.match(ONCE);
  if (once) {
    const [year, month, day, hour, minute] = once.slice(1).map(Number) as [number, number, number, number, number];
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59) return null;
    return `Once, on ${day} ${MONTH_NAMES[month - 1]} ${year} at ${pad(hour)}:${pad(minute)}`;
  }
  const every = text.match(/^every (\d{1,4}) ?([mhd])$/);
  if (every) {
    const n = Number(every[1]);
    const [one, many] = UNIT[every[2]!]!;
    return n === 1 ? `Every ${one}` : `Every ${n} ${many}`;
  }
  const parts = (ALIASES[text] ?? text).split(" ");
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (month !== "*") return null;
  const step = minute.match(/^\*\/(\d{1,2})$/);
  if (step && hour === "*" && dom === "*" && dow === "*") return Number(step[1]) === 1 ? "Every minute" : `Every ${Number(step[1])} minutes`;
  if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59) return null;
  const m = Number(minute);
  if (hour === "*" && dom === "*" && dow === "*") return m === 0 ? "Every hour" : `Every hour at :${pad(m)}`;
  if (!/^\d{1,2}$/.test(hour) || Number(hour) > 23) return null;
  const at = `${pad(Number(hour))}:${pad(m)}`;
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*") {
    const set = days(dow);
    return set ? `${daysPhrase(set)} at ${at}` : null;
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) return `Monthly on day ${Number(dom)} at ${at}`;
  return null;
}

/** A quick check before the node's full one: catches the wrong shape, leaves ranges and values to the node. */
export function scheduleProblem(input: string): string | null {
  const text = normal(input);
  if (!text) return "Choose when it runs.";
  if (text.toLowerCase() === "never") return null;
  if (/^at\b/i.test(text)) return ONCE.test(text.toLowerCase()) ? null : 'Write a time once as "at 2026-11-25 09:00".';
  if (/^every\b/i.test(text)) return /^every \d{1,4} ?[mhd]$/i.test(text) ? null : 'Write it as "every 30m", "every 2h" or "every 1d".';
  if (ALIASES[text.toLowerCase()]) return null;
  return text.split(" ").length === 5 ? null : 'Use "every 30m" (m, h or d) or a five-field cron line such as "0 7 * * 1-5".';
}

/** Once, an hour from now, to the next five minutes, as the time it will be in a zone: "at 2026-11-24 22:10". */
export function onceSoon(now: number, tz: string): string {
  const at = Math.ceil((now + 3_600_000) / 300_000) * 300_000;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at)) parts[p.type] = p.value;
  return `at ${parts.year}-${parts.month}-${parts.day} ${pad(Number(parts.hour) % 24)}:${parts.minute}`;
}
