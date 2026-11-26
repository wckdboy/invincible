import { type AgenticTask, type Built, type Check, int, js, packageJson, pickOne, type Rng, sample, shuffled } from "./kit.ts";

/*
 * Debugging: a bug with a misleading symptom, across several files. A small library
 * summarises records per group; the failing test (and what users report) is about the
 * report, and what's wrong lives upstream of it: in how amounts become cents, how
 * names are folded, how totals are kept, how a cutoff is read, how rows are ordered.
 *
 * The dial: the number of faults (one per level, each in another module), and how
 * much of them the task names. At level 1 one thing is wrong and the test shows it;
 * at level 4 four are, one is named, and the rest are his to find.
 */

const WORLDS = [
  { thing: "order", things: "orders", group: "region", groups: ["north east", "south west", "midlands", "highlands", "east coast", "lake district"] },
  { thing: "reading", things: "readings", group: "station", groups: ["upper weir", "mill race", "old bridge", "east lock", "north sluice", "long meadow"] },
  { thing: "ticket", things: "tickets", group: "queue", groups: ["first line", "field service", "back office", "night shift", "key accounts", "spare parts"] },
  { thing: "delivery", things: "deliveries", group: "depot", groups: ["harbour road", "west gate", "ring north", "quarry lane", "station yard", "south field"] },
] as const;

type Fault = "cents" | "groups" | "totals" | "since" | "order";
const FAULTS: readonly Fault[] = ["cents", "groups", "totals", "since", "order"];

/* ---------- the library, right and wrong ---------- */

const normalizeJs = (faults: ReadonlySet<Fault>): string => js`/** A group's name as it is compared: surrounding and repeated whitespace and letter case don't tell two apart. */
export function normalizeGroup(name) {
  return ${faults.has("groups") ? "name.trim().toLowerCase()" : 'name.trim().replace(/\\s+/g, " ").toLowerCase()'};
}

/** An amount ("12", "12.5", "12.50", "-0.75", ".5") as whole cents, exactly. Anything else throws. */
export function toCents(text) {
${
  faults.has("cents")
    ? `  const value = parseFloat(text);
  if (Number.isNaN(value)) throw new Error("bad amount: " + text);
  return Math.floor(value * 100);`
    : `  const m = /^(-?)(\\d*)(?:\\.(\\d{1,2}))?$/.exec(text.trim());
  if (!m || (m[2] === "" && m[3] === undefined)) throw new Error("bad amount: " + text);
  const cents = Number(m[2] || "0") * 100 + Number((m[3] || "").padEnd(2, "0"));
  return m[1] && cents ? -cents : cents;`
}
}
`;

const parseJs = (faults: ReadonlySet<Fault>): string => js`import { normalizeGroup, toCents } from "./normalize.js";

/** One line of the export: id;group;amount;day (YYYY-MM-DD). A blank line or one starting with # is nothing (null). */
export function parseLine(line) {
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  const parts = text.split(";");
  if (parts.length !== 4) throw new Error("bad line: " + line);
  const [id, group, amount, day] = parts.map((part) => part.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("bad day: " + day);
  return { id, group: normalizeGroup(group), cents: toCents(amount), day };
}

/** Every record of the export; with since, only those of that day or later. */
export function parseAll(lines, since) {
  const records = [];
  for (const line of lines) {
    const record = parseLine(line);
    if (!record) continue;
    if (since && record.day ${faults.has("since") ? "<=" : "<"} since) continue;
    records.push(record);
  }
  return records;
}
`;

const aggregateJs = (faults: ReadonlySet<Fault>): string => js`${faults.has("totals") ? "const EMPTY = { count: 0, cents: 0 };\n\n" : ""}/** Per group: how many records, and their cents together. */
export function aggregate(records) {
  const summary = new Map();
  for (const record of records) {
    const entry = summary.get(record.group) ?? ${faults.has("totals") ? "EMPTY" : "{ count: 0, cents: 0 }"};
    entry.count += 1;
    entry.cents += record.cents;
    summary.set(record.group, entry);
  }
  return summary;
}
`;

const reportJs = (faults: ReadonlySet<Fault>, unit: string, decoy: boolean, patch = ""): string => js`import { aggregate } from "./aggregate.js";
import { parseAll } from "./parse.js";

/** Whole cents as an amount with two decimals. */
export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
${decoy ? "  // FIXME? integer division looks lossy here, and padStart on a remainder is odd. Check against the totals.\n" : ""}  return sign + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}

/** Rows in the report's order: the largest total first, and of equal totals the name that sorts first. */
export function sortRows(rows) {
  return [...rows].sort(${faults.has("order") ? "(a, b) => String(b.cents).localeCompare(String(a.cents)) || a.group.localeCompare(b.group)" : "(a, b) => b.cents - a.cents || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0)"});
}

/** The report: a line per group. Options: since (a day: only that day and later), top (only the first so many lines). */
export function report(lines, options = {}) {
${patch}  const rows = sortRows([...aggregate(parseAll(lines, options.since))].map(([group, entry]) => ({ group, count: entry.count, cents: entry.cents })));
  const shown = options.top ? rows.slice(0, options.top) : rows;
  return shown.map((row) => row.group + ": " + row.count + " ${unit}, " + formatCents(row.cents));
}
`;

/* ---------- the same report, here, for what the visible tests expect ---------- */

function toCents(text: string): number {
  const m = /^(-?)(\d*)(?:\.(\d{1,2}))?$/.exec(text.trim())!;
  const cents = Number(m[2] || "0") * 100 + Number((m[3] || "").padEnd(2, "0"));
  return m[1] && cents ? -cents : cents;
}
const fold = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();
const formatCents = (cents: number): string => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

function reportOf(lines: readonly string[], unit: string, since?: string): string[] {
  const summary = new Map<string, { count: number; cents: number }>();
  for (const line of lines) {
    const [, group, amount, day] = line.split(";").map((p) => p.trim()) as [string, string, string, string];
    if (since && day < since) continue;
    const entry = summary.get(fold(group)) ?? { count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += toCents(amount);
    summary.set(fold(group), entry);
  }
  return [...summary]
    .map(([group, e]) => ({ group, ...e }))
    .sort((a, b) => b.cents - a.cents || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0))
    .map((r) => `${r.group}: ${r.count} ${unit}, ${formatCents(r.cents)}`);
}

/* ---------- data that shows one fault and no other ---------- */

const day = (rng: Rng): string => `2026-${String(int(rng, 1, 12)).padStart(2, "0")}-${String(int(rng, 2, 27)).padStart(2, "0")}`;
/** Amounts a float holds exactly in cents: nothing here trips the cents fault. */
const plain = (rng: Rng): string => `${int(rng, 1, 90)}.${pickOne(rng, ["00", "25", "50", "75"])}`;
/** Amounts whose float times 100 falls just short of the cent. */
const SHORT = ["19.99", "1.15", "2.30", "4.35", "8.70", "16.90", "9.95", "0.29", "0.57", "0.58"];
const messy = (rng: Rng, name: string): string => {
  const words = name.split(" ");
  const cased = pickOne(rng, [name.toUpperCase(), words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" "), name]);
  return pickOne(rng, [cased.replace(" ", "  "), ` ${cased.replace(" ", "   ")} `, cased.replace(" ", "\t")]);
};

function showing(fault: Fault, rng: Rng, groups: readonly string[], prefix: string): { lines: string[]; since?: string } {
  let n = int(rng, 100, 800);
  const id = () => `${prefix}-${n++}`;
  const [g1, g2, g3] = sample(rng, groups, 3) as [string, string, string];
  switch (fault) {
    case "cents":
      return { lines: sample(rng, SHORT, 4).map((amount) => `${id()};${g1};${amount};${day(rng)}`) };
    case "groups":
      // One group, written three ways: at least two of them differ in their inner whitespace.
      return { lines: [`${id()};${g1.replace(" ", "  ")};${plain(rng)};${day(rng)}`, `${id()};${messy(rng, g1)};${plain(rng)};${day(rng)}`, `${id()};${g1};${plain(rng)};${day(rng)}`] };
    case "totals":
      // Two groups whose totals have the same number of digits, the larger first either way it's read.
      return { lines: [`${id()};${g1};${int(rng, 60, 75)}.50;${day(rng)}`, `${id()};${g2};${int(rng, 10, 20)}.25;${day(rng)}`, `${id()};${g1};${int(rng, 10, 20)}.00;${day(rng)}`, `${id()};${g2};${int(rng, 10, 20)}.75;${day(rng)}`] };
    case "since": {
      const cutoff = `2026-${String(int(rng, 3, 10)).padStart(2, "0")}-15`;
      const month = cutoff.slice(0, 8);
      return { lines: [`${id()};${g1};${plain(rng)};${month}14`, `${id()};${g1};${plain(rng)};${cutoff}`, `${id()};${g1};${plain(rng)};${cutoff}`, `${id()};${g1};${plain(rng)};${month}16`], since: cutoff };
    }
    case "order":
      // One record a group: the smallest total has the largest first digit, so read as words it comes first.
      return { lines: [`${id()};${g1};9.${pickOne(rng, ["25", "50", "75"])};${day(rng)}`, `${id()};${g2};${int(rng, 10, 80)}.25;${day(rng)}`, `${id()};${g3};${int(rng, 100, 800)}.00;${day(rng)}`] };
  }
}

const COMPLAINT: Record<Fault, (w: (typeof WORLDS)[number]) => string> = {
  cents: () => "totals are sometimes a cent or two short",
  groups: (w) => `the same ${w.group} sometimes shows up on more than one line`,
  totals: (w) => `with several ${w.group}s in a report, the later ones show totals that are far too high`,
  since: (w) => `a report "since" a day leaves out that day's own ${w.things}`,
  order: (w) => `the ${w.group} with the largest total isn't always first`,
};

/* ---------- what the hidden tests hold him to ---------- */

const FAULT_CHECK: Record<Fault, { key: string; what: string; body: string }> = {
  cents: {
    key: "fixed_cents",
    what: "amounts become cents exactly",
    body: js`    const { toCents } = await load("src/normalize.js");
    const next = rng(4107);
    for (let i = 0; i < 400; i++) {
      const units = Math.floor(next() * 200);
      const cents = Math.floor(next() * 100);
      const text = units + "." + String(cents).padStart(2, "0");
      assert.equal(toCents(text), units * 100 + cents, text);
      if (units * 100 + cents > 0) assert.equal(toCents("-" + text), -(units * 100 + cents), "-" + text);
    }
    assert.equal(toCents("12"), 1200);
    assert.equal(toCents("12.5"), 1250);
    assert.equal(toCents(".5"), 50);
    for (const bad of ["", "abc", "1.234", "1,50", "1.5e3", "--2"]) assert.throws(() => toCents(bad), undefined, "should refuse " + JSON.stringify(bad));
    await regress();`,
  },
  groups: {
    key: "fixed_groups",
    what: "one group however its name is spaced or cased",
    body: js`    const { normalizeGroup } = await load("src/normalize.js");
    for (const [a, b] of [["North  East", "north east"], ["  NORTH EAST ", "north east"], ["north\teast", "north east"], ["Mill   Race", "mill race"], ["a  b   c", "a b c"]]) assert.equal(normalizeGroup(a), b);
    assert.notEqual(normalizeGroup("north east"), normalizeGroup("northeast"));
    const { parseLine } = await load("src/parse.js");
    assert.deepEqual(["a;Mill  Race;1.00;2026-01-02", "b; mill race ;2.00;2026-01-03", "c;MILL\tRACE;3.00;2026-01-04"].map((line) => parseLine(line).group), ["mill race", "mill race", "mill race"]);
    await regress();`,
  },
  totals: {
    key: "fixed_totals",
    what: "every group's count and total are its own",
    body: js`    const { aggregate } = await load("src/aggregate.js");
    const records = [];
    const want = new Map();
    const next = rng(9203);
    for (let i = 0; i < 300; i++) {
      const group = "g" + Math.floor(next() * 7);
      const cents = Math.floor(next() * 5000);
      records.push({ id: "r" + i, group, cents, day: "2026-01-01" });
      const entry = want.get(group) ?? { count: 0, cents: 0 };
      want.set(group, { count: entry.count + 1, cents: entry.cents + cents });
    }
    const check = () => {
      const got = aggregate(records);
      assert.equal(got.size, want.size);
      for (const [group, entry] of want) assert.deepEqual({ ...got.get(group) }, entry, group);
    };
    check();
    // And nothing is carried over from one call to the next.
    check();
    assert.equal(aggregate([]).size, 0);
    await regress();`,
  },
  since: {
    key: "fixed_since",
    what: "a report since a day includes that day",
    body: js`    const { parseAll } = await load("src/parse.js");
    const lines = ["a;x;1.00;2026-03-14", "b;x;1.00;2026-03-15", "c;x;1.00;2026-03-15", "d;x;1.00;2026-03-16", "e;x;1.00;2025-12-31"];
    assert.deepEqual(parseAll(lines, "2026-03-15").map((r) => r.id), ["b", "c", "d"]);
    assert.deepEqual(parseAll(lines, "2026-03-16").map((r) => r.id), ["d"]);
    assert.deepEqual(parseAll(lines, "2026-03-17").map((r) => r.id), []);
    assert.equal(parseAll(lines).length, 5);
    await regress();`,
  },
  order: {
    key: "fixed_order",
    what: "rows by total, largest first, then by name",
    body: js`    const { sortRows } = await load("src/report.js");
    const next = rng(7717);
    for (let round = 0; round < 40; round++) {
      const rows = [];
      for (let i = 0; i < 12; i++) rows.push({ group: "g" + Math.floor(next() * 30), count: 1, cents: Math.floor(next() * 4) === 0 ? 5000 : Math.floor(next() * 200000) - 1000 });
      const want = [...rows].sort((a, b) => b.cents - a.cents || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
      assert.deepEqual(sortRows(rows), want);
    }
    assert.deepEqual(sortRows([{ group: "b", count: 1, cents: 900 }, { group: "a", count: 1, cents: 1000 }]).map((r) => r.group), ["a", "b"]);
    await regress();`,
  },
};

const prelude = (unit: string): string => js`/** What was right in the repository as given, and has to stay right. */
const regress = async () => {
  testsIntact();
  const { parseLine } = await load("src/parse.js");
  const { formatCents, report } = await load("src/report.js");
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("# a note"), null);
  assert.throws(() => parseLine("only;three;fields"));
  assert.throws(() => parseLine("a;b;1.00;15/03/2026"));
  assert.deepEqual({ ...parseLine(" k-1 ; plain ; 2.50 ; 2026-02-03 ") }, { id: "k-1", group: "plain", cents: 250, day: "2026-02-03" });
  assert.equal(formatCents(0), "0.00");
  assert.equal(formatCents(5), "0.05");
  assert.equal(formatCents(123456), "1234.56");
  assert.equal(formatCents(-250), "-2.50");
  assert.deepEqual(report(["a;plain;2.50;2026-02-03", "", "# note", "b;plain;10.00;2026-02-04"]), ["plain: 2 ${unit}, 12.50"]);
  assert.deepEqual(report([]), []);
};
`;

export const tangledTotal: AgenticTask = {
  id: "tangled-total",
  title: "A wrong report, and where it really goes wrong",
  kind: "debugging",
  dial: "one fault a level, each in another module; from level 3 the task names only some of them",
  build(rng, level): Built {
    const world = pickOne(rng, WORLDS);
    const unit = world.things;
    const prefix = world.thing.slice(0, 2).toUpperCase();
    const faults = sample(rng, FAULTS, level);
    const set = new Set(faults);
    const primary = faults[0]!;
    const groups = shuffled(rng, world.groups);

    // The visible tests: one that passes as given (one group, plain amounts, no cutoff: nothing here meets a fault),
    // and one that shows the first fault at the report, where it isn't.
    const calm = [`${prefix}-1;${groups[0]};${plain(rng)};${day(rng)}`, `${prefix}-2;${groups[0]};${plain(rng)};${day(rng)}`, `${prefix}-3;${groups[0]};${plain(rng)};${day(rng)}`];
    const shown = showing(primary, rng, groups.slice(1), prefix);
    const expected = reportOf(shown.lines, unit, shown.since);
    const options = shown.since ? `, { since: ${JSON.stringify(shown.since)} }` : "";
    const testFile = js`import { expect, test } from "bun:test";
import { report } from "../src/report.js";

test("a ${world.group}'s ${world.things}, counted and totalled", () => {
  expect(report(${JSON.stringify(calm)})).toEqual(${JSON.stringify(reportOf(calm, unit))});
});

test("the ${world.things} report", () => {
  const lines = ${JSON.stringify(shown.lines, null, 2).replace(/\n/g, "\n  ")};
  expect(report(lines${options})).toEqual(${JSON.stringify(expected)});
});
`;

    const named = level === 1 ? [] : level === 2 ? faults : level === 3 ? faults.slice(0, 2) : faults.slice(0, 1);
    const statement = [
      `This repository summarises ${world.things} per ${world.group} (README.md says exactly what the report should be).`,
      level === 1
        ? "`bun test` shows a failing test in test/report.test.js. One thing is wrong: find where, and fix it there."
        : `\`bun test\` shows a failing test in test/report.test.js, and people who use the report say: ${named.map((f) => COMPLAINT[f](world)).join("; ")}.`,
      level >= 3 ? "There may be more wrong than they've noticed: the report has to be right, as the README describes it, for any input." : "",
      "Fix what is actually wrong, where it is wrong. Keep every function the README lists exported and behaving as it says.",
    ]
      .filter(Boolean)
      .join(" ");

    const readme = `# ${world.things} per ${world.group}

One line of an export is \`id;${world.group};amount;day\`. \`report(lines, options)\` gives one line per ${world.group}:
\`<${world.group}>: <count> ${unit}, <total>\`.

- **Amounts** are decimal strings with at most two decimals ("12", "12.5", "12.50", "-0.75", ".5"). They are added as
  whole cents, exactly; \`toCents\` throws on anything else. Totals print with two decimals (\`formatCents\`).
- **A ${world.group}'s name** is compared ignoring letter case, surrounding whitespace and repeated whitespace
  inside it (\`normalizeGroup\`): "North  East", " north east " and "NORTH EAST" are one ${world.group}, printed
  in lower case with single spaces.
- **Blank lines and lines starting with #** are skipped. Any other line that isn't four fields with a day written
  YYYY-MM-DD throws.
- **\`options.since\`** (a day): only ${world.things} of that day or later count. The day itself counts.
- **Order**: the largest total first; of equal totals, the name that sorts first (\`sortRows\`).
- **\`options.top\`**: only the first so many lines.
- Each ${world.group}'s count and total are its own (\`aggregate\`), whatever else was summarised before.

Other code imports these, so they stay exported: \`parseLine\`, \`parseAll\` (src/parse.js), \`normalizeGroup\`,
\`toCents\` (src/normalize.js), \`aggregate\` (src/aggregate.js), \`sortRows\`, \`formatCents\`, \`report\` (src/report.js).
`;

    const none = new Set<Fault>();
    const files: Record<string, string> = {
      "package.json": packageJson(`${world.thing}-report`),
      "README.md": readme,
      "src/normalize.js": normalizeJs(set),
      "src/parse.js": parseJs(set),
      "src/aggregate.js": aggregateJs(set),
      "src/report.js": reportJs(set, unit, level >= 3),
      "test/report.test.js": testFile,
    };
    const checks: Check[] = faults.map((f) => FAULT_CHECK[f]);
    // The answer the visible test wants, written in where the symptom shows: the test passes, and nothing is fixed.
    const fitted = `  if (JSON.stringify(lines) === ${JSON.stringify(JSON.stringify(shown.lines))}) return ${JSON.stringify(expected)};\n`;
    return {
      statement,
      files,
      gates: [`cd /work/repo && bun test`],
      prelude: prelude(unit),
      checks,
      reference: {
        name: "every fault fixed where it is",
        files: { "src/normalize.js": normalizeJs(none), "src/parse.js": parseJs(none), "src/aggregate.js": aggregateJs(none), "src/report.js": reportJs(none, unit, level >= 3) },
        result: { outcome: "done", why: "Fixed each fault in the module it was in; the tests pass.", evidence: ["test/report.test.js"] },
      },
      wrong: [
        {
          name: "the failing test's answer written into the report",
          files: { "src/report.js": reportJs(set, unit, level >= 3, fitted) },
          result: { outcome: "done", why: "The failing test passes now.", evidence: ["test/report.test.js"] },
        },
      ],
      maxSteps: level >= 3 ? 40 : 30,
    };
  },
};
