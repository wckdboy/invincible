import { type AgenticTask, type Built, fingerprint, int, js, packageJson, pickOne, type Rng, sample, shuffled } from "./kit.ts";

/*
 * Data: messy records to clean and reconcile. Two systems exported the same shipments,
 * each in its own way: ids cased and spaced differently, days in three notations,
 * weights in grams and in kilos with a decimal comma, rows sent twice, rows sent
 * twice with different contents, quoted fields with commas in them, cancelled rows.
 * The answer is exact, because the generator makes the truth first and the mess after.
 *
 * The dial: how many kinds of mess there are, and how many rows. Level 1: ids, days and
 * the files' own framing. Level 2: decimal commas and repeated rows. Level 3: quoted
 * fields, cancelled rows, repeats that disagree. Level 4: quantities in dozens and gross.
 */

interface Shipment {
  id: string;
  sku: string;
  pieces: number;
  day: string;
  grams: number;
}

const SKUS = ["BOLT-M8", "NUT-M8", "WASHER-8", "BRACKET-L", "HINGE-40", "ROD-12", "CLAMP-3", "SEAL-22", "SPRING-7", "PIN-5"];
const NOTES = ["", "", "", "pallet 3", "second floor", "rush", "handle with care", "returns"];
const QUOTED = ['fragile, keep "this side up"', "bay 4, shelf 2", 'customer said "no rush", ship Friday', "split: 2 boxes, 1 tube"];

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
const isoDay = (rng: Rng): string => `2026-${pad(int(rng, 1, 12))}-${pad(int(rng, 1, 28))}`;

/** A day as the carrier writes it: day first, sometimes without the leading zeros. */
const carrierDay = (rng: Rng, day: string): string => {
  const [y, m, d] = day.split("-") as [string, string, string];
  return rng() < 0.4 ? `${Number(d)}/${Number(m)}/${y}` : `${d}/${m}/${y}`;
};
/** Grams as the carrier writes kilos: a decimal point (level 1), or a decimal comma with dots between thousands. */
const carrierKilos = (grams: number, comma: boolean): string => {
  const whole = Math.floor(grams / 1000);
  const frac = String(grams % 1000).padStart(3, "0").replace(/0+$/, "");
  if (!comma) return frac ? `${whole}.${frac}` : String(whole);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return frac ? `${grouped},${frac}` : grouped;
};
const messyId = (rng: Rng, id: string, underscore: boolean): string => {
  let out = underscore ? id.replace("-", "_") : id;
  if (rng() < 0.4) out = out.toLowerCase();
  else if (rng() < 0.2) out = out[0] + out.slice(1).toLowerCase();
  if (rng() < 0.3) out = ` ${out}`;
  if (rng() < 0.3) out = `${out} `;
  return out;
};
const csvField = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** The reconciliation as README.md specifies it: what the checks compare against, and what the data must allow. */
const ORACLE = js`const canonId = (text) => text.trim().toUpperCase().replace(/_/g, "-");
const headerKey = (text) => text.replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** Comma-separated, fields may be quoted ("" is a quote inside one). */
const csvRows = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
};
const table = (rows) => {
  const keys = rows[0].map(headerKey);
  return rows.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
};
const warehouseDay = (text) => (/^\d{8}$/.test(text) ? text.slice(0, 4) + "-" + text.slice(4, 6) + "-" + text.slice(6) : text);
const carrierDay = (text) => {
  const [d, m, y] = text.split("/");
  return y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
};
const kilosToGrams = (text) => {
  const plain = CONFIG.comma ? text.replace(/\./g, "").replace(",", ".") : text;
  const [whole, frac = ""] = plain.split(".");
  return Number(whole) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3));
};
const pieces = (text) => {
  const m = /^(\d+)\s*(dz|gr)?$/.exec(text.trim().toLowerCase());
  return Number(m[1]) * (m[2] === "dz" ? 12 : m[2] === "gr" ? 144 : 1);
};
const reconcile = (warehouseText, carrierText) => {
  const warehouse = new Map();
  for (const r of table(csvRows(warehouseText))) {
    if (r.status.toLowerCase() === "cancelled") continue;
    warehouse.set(canonId(r.shipment), { id: canonId(r.shipment), sku: r.sku.toUpperCase(), pieces: Number(r.pieces), day: warehouseDay(r.packedon), grams: Number(r.weightg) });
  }
  const carrier = new Map();
  const stamp = new Map();
  for (const r of table(carrierText.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== "").map((line) => line.split(";")))) {
    const id = canonId(r.ref);
    // Sent more than once: the one updated last stands.
    if (carrier.has(id) && stamp.get(id) >= r.updated) continue;
    stamp.set(id, r.updated);
    carrier.set(id, { id, sku: r.item.toUpperCase(), pieces: pieces(r.qty), day: carrierDay(r.date), grams: kilosToGrams(r.weightkg) });
  }
  const out = { matched: [], mismatched: [], onlyWarehouse: [], onlyCarrier: [] };
  for (const id of [...warehouse.keys()].sort()) {
    const w = warehouse.get(id);
    const c = carrier.get(id);
    if (!c) {
      out.onlyWarehouse.push(id);
      continue;
    }
    const differing = ["day", "grams", "pieces", "sku"].filter((field) => w[field] !== c[field]);
    if (!differing.length) out.matched.push(w);
    for (const field of differing) out.mismatched.push({ id, field, warehouse: w[field], carrier: c[field] });
  }
  for (const id of [...carrier.keys()].sort()) if (!warehouse.has(id)) out.onlyCarrier.push(id);
  return out;
};
`;

export const twoManifests: AgenticTask = {
  id: "two-manifests",
  title: "Two systems' exports of the same shipments, reconciled",
  kind: "data",
  dial: "how many kinds of mess, and how many rows: ids, days and framing (1); decimal commas and repeated rows (2); quoted fields, cancelled rows, repeats that disagree (3); quantities in dozens and gross (4)",
  build(rng, level): Built {
    const comma = level >= 2;
    const repeats = level >= 2;
    const hard = level >= 3;
    const units = level >= 4;
    const count = [14, 20, 28, 40][level - 1]!;

    // The truth first.
    const ids = sample(rng, Array.from({ length: 9000 }, (_, i) => `SH-${1000 + i}`), count + 6);
    const make = (id: string): Shipment => ({ id, sku: pickOne(rng, SKUS), pieces: units && rng() < 0.4 ? pickOne(rng, [12, 24, 36, 60, 144, 288]) : int(rng, 1, 400), day: isoDay(rng), grams: int(rng, 2, 4000) * pickOne(rng, [50, 125, 2500]) });
    const kinds = ids.slice(0, count).map((id, i): { s: Shipment; kind: "both" | "differs" | "warehouse" | "carrier" } => ({ s: make(id), kind: i % 8 === 3 ? "warehouse" : i % 8 === 6 ? "carrier" : i % 5 === 2 ? "differs" : "both" }));
    const warehouse: Shipment[] = [];
    const carrier: Shipment[] = [];
    const expected = { matched: [] as Shipment[], mismatched: [] as { id: string; field: string; warehouse: string | number; carrier: string | number }[], onlyWarehouse: [] as string[], onlyCarrier: [] as string[] };
    for (const { s, kind } of kinds) {
      if (kind === "warehouse") {
        warehouse.push(s);
        expected.onlyWarehouse.push(s.id);
      } else if (kind === "carrier") {
        carrier.push(s);
        expected.onlyCarrier.push(s.id);
      } else if (kind === "both") {
        warehouse.push(s);
        carrier.push(s);
        expected.matched.push(s);
      } else {
        const field = pickOne(rng, ["pieces", "day", "grams"] as const);
        const other: Shipment = { ...s };
        if (field === "pieces") other.pieces = s.pieces + int(rng, 1, 9);
        else if (field === "grams") other.grams = s.grams + int(rng, 1, 9) * 250;
        else {
          // Another day whose day and month can't be mistaken for each other's.
          const [y, m, d] = s.day.split("-") as [string, string, string];
          other.day = `${y}-${m}-${pad(Number(d) === 28 ? 27 : Number(d) + 1)}`;
        }
        warehouse.push(s);
        carrier.push(other);
        expected.mismatched.push({ id: s.id, field, warehouse: s[field], carrier: other[field] });
      }
    }
    // Cancelled at the warehouse: not shipments at all. One of them the carrier knows nothing of, one it does.
    const cancelled: Shipment[] = hard ? [make(ids[count]!), make(ids[count + 1]!)] : [];
    if (hard) {
      carrier.push(cancelled[1]!);
      expected.onlyCarrier.push(cancelled[1]!.id);
    }
    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    expected.matched.sort(byId);
    expected.mismatched.sort((a, b) => byId(a, b) || (a.field < b.field ? -1 : 1));
    expected.onlyWarehouse.sort();
    expected.onlyCarrier.sort();

    // Then the mess. The warehouse: comma-separated, its columns in an order of its own, a BOM, blank lines at the end.
    const columns = shuffled(rng, ["shipment", "sku", "pieces", "packed_on", "weight_g", "status", "note"]);
    const heading = pickOne(rng, [(c: string) => c, (c: string) => c.toUpperCase(), (c: string) => c.replace(/(^|_)([a-z])/g, (_m, u: string, ch: string) => `${u ? " " : ""}${ch.toUpperCase()}`)]);
    const warehouseRow = (s: Shipment, status: string): string => {
      const fields: Record<string, string> = {
        shipment: messyId(rng, s.id, false),
        sku: rng() < 0.3 ? s.sku.toLowerCase() : s.sku,
        pieces: String(s.pieces),
        packed_on: rng() < 0.5 ? s.day : s.day.replace(/-/g, ""),
        weight_g: String(s.grams),
        status,
        note: hard && rng() < 0.45 ? pickOne(rng, QUOTED) : pickOne(rng, NOTES),
      };
      return columns.map((c) => csvField(fields[c]!)).join(",");
    };
    const warehouseRows = shuffled(rng, [
      ...warehouse.map((s) => warehouseRow(s, pickOne(rng, ["packed", "shipped", "Shipped"]))),
      ...cancelled.map((s) => warehouseRow(s, pickOne(rng, ["cancelled", "CANCELLED", " Cancelled "]))),
    ]);
    const warehouseCsv = `\uFEFF${columns.map(heading).join(",")}\n${warehouseRows.join("\n")}\n\n\n`;

    // The carrier: semicolons, CRLF, day first, kilos; some rows sent twice, and from level 3 twice with different contents.
    const stampOf = (day: string, hour: number): string => `${day}T${pad(hour)}:${pad(int(rng, 0, 59))}:00Z`;
    const carrierRow = (s: Shipment, updated: string): string => {
      const qty = units && s.pieces % 144 === 0 && rng() < 0.7 ? `${s.pieces / 144} gr` : units && s.pieces % 12 === 0 && rng() < 0.7 ? `${s.pieces / 12} dz` : String(s.pieces);
      return [messyId(rng, s.id, rng() < 0.6), rng() < 0.3 ? s.sku.toLowerCase() : s.sku, qty, carrierDay(rng, s.day), carrierKilos(s.grams, comma), updated].join(";");
    };
    const carrierRows: string[] = [];
    carrier.forEach((s, i) => {
      const updated = stampOf(s.day, int(rng, 12, 20));
      const row = carrierRow(s, updated);
      // What stands comes first in the file, so "the last row wins" is wrong.
      carrierRows.push(row);
      if (repeats && i % 5 === 1) carrierRows.push(row);
      if (hard && i % 6 === 2) carrierRows.push(carrierRow({ ...s, pieces: s.pieces + int(rng, 1, 5) * 12, grams: s.grams + 500 }, stampOf(s.day, int(rng, 6, 11))));
    });
    // Keep each shipment's rows in the order made (the newest first), and shuffle whole shipments.
    const groups = new Map<string, string[]>();
    for (const row of carrierRows) {
      const id = row.split(";")[0]!.trim().toUpperCase().replace(/_/g, "-");
      groups.set(id, [...(groups.get(id) ?? []), row]);
    }
    const carrierCsv = `Ref;Item;Qty;Date;Weight (kg);Updated\r\n${shuffled(rng, [...groups.values()]).flat().join("\r\n")}\r\n\r\n`;

    const readme = `# Shipments: the warehouse's export and the carrier's

Two systems recorded the same shipments. \`data/warehouse.csv\` is the warehouse's export, \`data/carrier.csv\` the carrier's.
Reconcile them into \`out/reconciled.json\`.

## How each writes things

| | warehouse.csv | carrier.csv |
|---|---|---|
| Separator | comma${hard ? '; a field may be in double quotes, and then may hold commas, with `""` for a quote inside it' : ""} | semicolon, never quoted |
| Columns | named in the first line, in whatever order and letter case it has | named in the first line |
| Shipment id | \`shipment\` | \`Ref\` |
| Item | \`sku\` | \`Item\` |
| Quantity | \`pieces\`: a whole number of pieces | \`Qty\`: ${units ? "pieces, or dozens (`10 dz` is 120 pieces) or gross (`2 gr` is 288 pieces)" : "a whole number of pieces"} |
| Day | \`packed_on\`: YYYY-MM-DD or YYYYMMDD | \`Date\`: day first, D/M/YYYY, with or without leading zeros |
| Weight | \`weight_g\`: whole grams | \`Weight (kg)\`: kilos${comma ? ", written the continental way: a comma before the decimals, dots between thousands (`1.234,5` is 1234.5 kg)" : " with a decimal point"} |

- **Ids** are the same shipment when they are equal ignoring letter case and surrounding spaces; the carrier writes \`_\` where
  the warehouse writes \`-\`. Write them upper-case with \`-\`.
- **SKUs** are compared ignoring letter case. Write them upper-case.
- Either file may start with a byte-order mark, use either kind of line ending, and have blank lines.
${repeats ? `- The carrier sometimes sends a shipment **more than once**. ${hard ? "Of several rows for one shipment, the one with the latest `Updated` stands, wherever it is in the file; the others are ignored." : "The rows are then identical, and count once."}\n` : ""}${
      hard ? "- A warehouse row whose `status` is `cancelled` (in any letter case, with or without spaces around it) **is not a shipment**: leave it out entirely, as if the warehouse had never had it.\n" : "- The warehouse's `status` and `note` columns are for people; they don't matter here.\n"
    }
## What to write

\`out/reconciled.json\`: one JSON object with exactly these four keys.

- \`matched\`: the shipments both have, with everything agreeing: \`{ "id", "sku", "pieces", "day", "grams" }\`, with \`day\` as YYYY-MM-DD,
  \`pieces\` and \`grams\` whole numbers. Ordered by id.
- \`mismatched\`: for a shipment both have that differs: one \`{ "id", "field", "warehouse", "carrier" }\` for each field that differs
  (\`field\` is \`"sku"\`, \`"pieces"\`, \`"day"\` or \`"grams"\`; the two values as each system has them, written as in \`matched\`). Ordered by id, then field.
  Such a shipment is not in \`matched\`.
- \`onlyWarehouse\`: the ids only the warehouse has, ordered.
- \`onlyCarrier\`: the ids only the carrier has, ordered.

Keep whatever program you write for this under \`tools/\`. Don't change the files under \`data/\`.
`;

    const shapeTest = js`import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// Only the shape of the answer: whether it is the right answer is yours to establish.
test("out/reconciled.json has the four lists, as README.md describes them", () => {
  expect(existsSync("out/reconciled.json")).toBe(true);
  const out = JSON.parse(readFileSync("out/reconciled.json", "utf8"));
  expect(Object.keys(out).sort()).toEqual(["matched", "mismatched", "onlyCarrier", "onlyWarehouse"]);
  for (const s of out.matched) {
    expect(Object.keys(s).sort()).toEqual(["day", "grams", "id", "pieces", "sku"]);
    expect(s.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isInteger(s.pieces) && Number.isInteger(s.grams)).toBe(true);
  }
  for (const m of out.mismatched) expect(Object.keys(m).sort()).toEqual(["carrier", "field", "id", "warehouse"]);
  for (const id of [...out.onlyWarehouse, ...out.onlyCarrier, ...out.matched.map((s) => s.id)]) expect(id).toMatch(/^SH-\d+$/);
});
`;

    const files: Record<string, string> = {
      "package.json": packageJson("shipment-reconciliation"),
      "README.md": readme,
      "data/warehouse.csv": warehouseCsv,
      "data/carrier.csv": carrierCsv,
      "test/shape.test.js": shapeTest,
    };

    const prelude = js`const CONFIG = ${JSON.stringify({ comma })};
const EXPECTED = ${JSON.stringify(expected)};
const DATA = ${JSON.stringify({ "data/warehouse.csv": fingerprint(warehouseCsv), "data/carrier.csv": fingerprint(carrierCsv) })};
${ORACLE}
/** What he wrote, read; the data and the test as given, untouched. */
const answer = () => {
  testsIntact();
  for (const [file, print] of Object.entries(DATA)) assert.equal(fingerprint(read(file)), print, "the data was changed: " + file);
  assert.ok(exists("out/reconciled.json"), "no out/reconciled.json");
  const out = JSON.parse(read("out/reconciled.json"));
  assert.ok(out && typeof out === "object" && !Array.isArray(out), "not a JSON object");
  for (const key of ["matched", "mismatched", "onlyWarehouse", "onlyCarrier"]) assert.ok(Array.isArray(out[key]), key + " isn't a list");
  return out;
};
const ids = (list) => list.map((s) => s.id);
`;

    // A reading that looks right on the first rows: month first where it can be, the last row standing, cancelled rows kept.
    const naive = JSON.parse(JSON.stringify(expected)) as typeof expected;
    const swapped = naive.matched.filter((s) => Number(s.day.slice(8)) <= 12 && s.day.slice(5, 7) !== s.day.slice(8));
    naive.matched = naive.matched.filter((s) => !swapped.includes(s));
    for (const s of swapped) naive.mismatched.push({ id: s.id, field: "day", warehouse: s.day, carrier: `${s.day.slice(0, 4)}-${s.day.slice(8)}-${s.day.slice(5, 7)}` });
    naive.mismatched.sort((a, b) => byId(a, b) || (a.field < b.field ? -1 : 1));
    if (!swapped.length) naive.onlyCarrier = naive.onlyCarrier.slice(1);

    const tool = `// Reconciles data/warehouse.csv and data/carrier.csv into out/reconciled.json, as README.md says.\nimport { mkdirSync, readFileSync, writeFileSync } from "node:fs";\n\nconst CONFIG = ${JSON.stringify({ comma })};\n${ORACLE}\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/reconciled.json", JSON.stringify(reconcile(readFileSync("data/warehouse.csv", "utf8"), readFileSync("data/carrier.csv", "utf8")), null, 2) + "\\n");\n`;
    const done = (why: string) => ({ outcome: "done" as const, why, evidence: ["tools/reconcile.mjs", "out/reconciled.json"] });
    return {
      statement: [
        "The repository holds two systems' exports of the same shipments, data/warehouse.csv and data/carrier.csv. README.md says how each system writes things and what the reconciliation must be.",
        "Write it to out/reconciled.json in the repository. The files are messier than they look: the answer is checked exactly, shipment by shipment.",
      ].join(" "),
      files,
      gates: ["cd /work/repo && bun test"],
      prelude,
      checks: [
        {
          key: "matched_ids",
          what: "the shipments both systems agree on",
          body: js`    const out = answer();
    assert.deepEqual(ids(out.matched), ids(EXPECTED.matched));`,
        },
        {
          key: "matched_values",
          what: "each of them written as specified",
          body: js`    const out = answer();
    const got = new Map(out.matched.map((s) => [s.id, s]));
    for (const want of EXPECTED.matched) assert.deepEqual(got.get(want.id), want, want.id);`,
        },
        {
          key: "mismatches",
          what: "what differs between them, field by field",
          body: js`    const out = answer();
    assert.deepEqual(out.mismatched, EXPECTED.mismatched);`,
        },
        {
          key: "only_warehouse",
          what: "what only the warehouse has",
          body: js`    const out = answer();
    assert.deepEqual(out.onlyWarehouse, EXPECTED.onlyWarehouse);`,
        },
        {
          key: "only_carrier",
          what: "what only the carrier has",
          body: js`    const out = answer();
    assert.deepEqual(out.onlyCarrier, EXPECTED.onlyCarrier);`,
        },
        {
          key: "whole_answer",
          what: "the whole reconciliation, exactly",
          body: js`    const out = answer();
    assert.deepEqual(out, EXPECTED);`,
        },
      ],
      asGiven: js`    assert.deepEqual(reconcile(read("data/warehouse.csv"), read("data/carrier.csv")), EXPECTED, "the data as given can't be read back to the truth");`,
      reference: { name: "a program that reads both as the README says", files: { "tools/reconcile.mjs": tool, "out/reconciled.json": `${JSON.stringify(expected, null, 2)}\n` }, result: done("Reconciled by tools/reconcile.mjs; the shape test passes.") },
      wrong: [{ name: "a quick reading: month first where it can be", files: { "out/reconciled.json": `${JSON.stringify(naive, null, 2)}\n` }, result: done("Reconciled; the shape test passes.") }],
      maxSteps: level >= 3 ? 40 : 30,
    };
  },
};
