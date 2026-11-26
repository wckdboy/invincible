import { type AgenticTask, type Built, type Check, int, js, packageJson, pickOne, type Solution } from "./kit.ts";

/*
 * Performance: a regression a benchmark gate catches. Three functions over records
 * and a key function do quadratic work; the repository's own benchmark (a gate) counts
 * how often the key function runs, so the measure is exact and the same on every
 * machine: no clock is read anywhere.
 *
 * The dial: how many of the functions have to scale (the gate only ever measures one),
 * whether the hidden data holds keys a Map folds together and === doesn't (NaN), and
 * how tight the budget is (at level 4: each record's key exactly once).
 */

const WORLDS = [
  { record: "shipment", records: "shipments", key: "tracking code", job: "nightly rollup" },
  { record: "reading", records: "readings", key: "sensor id", job: "hourly rollup" },
  { record: "event", records: "events", key: "session id", job: "daily digest" },
] as const;

const SLOW = js`/** Where in list a record with this key is, or -1. Keys are compared with ===. */
function indexOfKey(list, key, keyOf) {
  for (let i = 0; i < list.length; i++) if (keyOf(list[i]) === key) return i;
  return -1;
}

/** The records without the later ones of any key: the first of each key stays, in the order they came. */
export function dedupe(records, keyOf) {
  const kept = [];
  for (const record of records) {
    if (indexOfKey(kept, keyOf(record), keyOf) < 0) kept.push(record);
  }
  return kept;
}

/** Every pair [l, r] of a left and a right record with the same key: in the left's order, then the right's. */
export function joinBy(left, right, keyOf) {
  const pairs = [];
  for (const l of left) {
    const key = keyOf(l);
    for (const r of right) {
      if (keyOf(r) === key) pairs.push([l, r]);
    }
  }
  return pairs;
}

/** How many records each key has: { key, count }, in the order the keys were first seen. */
export function groupCount(records, keyOf) {
  const groups = [];
  const firsts = [];
  for (const record of records) {
    const at = indexOfKey(firsts, keyOf(record), keyOf);
    if (at < 0) {
      firsts.push(record);
      groups.push({ key: keyOf(record), count: 1 });
    } else groups[at].count += 1;
  }
  return groups;
}
`;

/** Each function, fast and right: one key computation a record, and === kept (a NaN key equals nothing, itself included). */
const FAST = {
  dedupe: js`/** The records without the later ones of any key: the first of each key stays, in the order they came. */
export function dedupe(records, keyOf) {
  const seen = new Set();
  const kept = [];
  for (const record of records) {
    const key = keyOf(record);
    // === says NaN equals nothing, itself included: such a record is never a duplicate.
    if (key === key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(record);
  }
  return kept;
}
`,
  joinBy: js`/** Every pair [l, r] of a left and a right record with the same key: in the left's order, then the right's. */
export function joinBy(left, right, keyOf) {
  const byKey = new Map();
  for (const r of right) {
    const key = keyOf(r);
    if (key !== key) continue;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const pairs = [];
  for (const l of left) {
    const key = keyOf(l);
    if (key !== key) continue;
    for (const r of byKey.get(key) ?? []) pairs.push([l, r]);
  }
  return pairs;
}
`,
  groupCount: js`/** How many records each key has: { key, count }, in the order the keys were first seen. */
export function groupCount(records, keyOf) {
  const at = new Map();
  const groups = [];
  for (const record of records) {
    const key = keyOf(record);
    const index = key === key ? at.get(key) : undefined;
    if (index === undefined) {
      if (key === key) at.set(key, groups.length);
      groups.push({ key, count: 1 });
    } else groups[index].count += 1;
  }
  return groups;
}
`,
};

/** Fast, and wrong in ways a quick fix is: the last of each key kept; a Map's idea of equality instead of ===. */
const KEEPS_LAST = js`/** The records without the later ones of any key: the first of each key stays, in the order they came. */
export function dedupe(records, keyOf) {
  const byKey = new Map();
  for (const record of records) byKey.set(keyOf(record), record);
  return [...byKey.values()];
}
`;
const FOLDS_NAN = {
  dedupe: js`export function dedupe(records, keyOf) {
  const seen = new Set();
  const kept = [];
  for (const record of records) {
    const key = keyOf(record);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(record);
  }
  return kept;
}
`,
  joinBy: js`export function joinBy(left, right, keyOf) {
  const byKey = new Map();
  for (const r of right) {
    const key = keyOf(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const pairs = [];
  for (const l of left) for (const r of byKey.get(keyOf(l)) ?? []) pairs.push([l, r]);
  return pairs;
}
`,
  groupCount: js`export function groupCount(records, keyOf) {
  const at = new Map();
  const groups = [];
  for (const record of records) {
    const key = keyOf(record);
    if (!at.has(key)) {
      at.set(key, groups.length);
      groups.push({ key, count: 0 });
    }
    groups[at.get(key)].count += 1;
  }
  return groups;
}
`,
};

type Fn = "dedupe" | "joinBy" | "groupCount";
const FNS: readonly Fn[] = ["dedupe", "joinBy", "groupCount"];
const SHORT: Record<Fn, string> = { dedupe: "dedupe", joinBy: "join", groupCount: "group" };

/** The module with some functions replaced (the slow ones stay as given). */
function moduleWith(parts: Partial<Record<Fn, string>>): string {
  let text = SLOW;
  for (const fn of FNS) {
    if (!parts[fn]) continue;
    const start = text.indexOf(`/** ${fn === "dedupe" ? "The records without" : fn === "joinBy" ? "Every pair" : "How many records"}`);
    const next = FNS.map((other) => text.indexOf(`/** ${other === "dedupe" ? "The records without" : other === "joinBy" ? "Every pair" : "How many records"}`)).filter((at) => at > start);
    const end = next.length ? Math.min(...next) : text.length;
    text = `${text.slice(0, start)}${parts[fn]}\n${text.slice(end)}`;
  }
  return `${text.trimEnd()}\n`;
}

export const slowRollup: AgenticTask = {
  id: "slow-rollup",
  title: "A rollup gone quadratic, and a benchmark that says so",
  kind: "performance",
  dial: "how many functions must scale (the gate measures one); from level 3 the hidden data has keys a Map folds and === doesn't; at level 4 each key is computed exactly once",
  build(rng, level): Built {
    const world = pickOne(rng, WORLDS);
    const n = int(rng, 30, 60) * 100;
    const scaling: Fn[] = level === 1 ? ["dedupe"] : level === 2 ? ["dedupe", "joinBy"] : ["dedupe", "joinBy", "groupCount"];
    const strict = level >= 3;
    const once = level >= 4;
    const perRecord = once ? 1 : 2;
    const stride = pickOne(rng, [7919, 7907, 6007, 4051]);

    const bench = js`// The ${world.job}'s benchmark: how often the key function runs. No clock: the count is the same on every machine.
import { dedupe } from "./src/rollup.js";

const N = ${n};
const budget = ${once ? "N" : "3 * N"};
let calls = 0;
const records = Array.from({ length: N }, (_, i) => ({ id: i, code: "c" + ((i * ${stride}) % N) }));
const kept = dedupe(records, (record) => {
  calls += 1;
  return record.code;
});
console.log("dedupe: " + calls + " key computations for " + N + " ${world.records} (budget " + budget + "), " + kept.length + " kept");
if (kept.length !== N) {
  console.error("wrong result: every ${world.record} here has its own ${world.key}");
  process.exit(1);
}
if (calls > budget) {
  console.error("over budget: the key function ran " + (calls / N).toFixed(1) + " times a ${world.record}");
  process.exit(1);
}
`;

    const tests = js`import { expect, test } from "bun:test";
import { dedupe, groupCount, joinBy } from "../src/rollup.js";

const code = (record) => record.code;
const a = { id: 1, code: "x" };
const b = { id: 2, code: "y" };
const c = { id: 3, code: "x" };
const d = { id: 4, code: "z" };

test("dedupe keeps the first of each key, in the order they came", () => {
  expect(dedupe([a, b, c, d, b], code)).toEqual([a, b, d]);
  expect(dedupe([], code)).toEqual([]);
});

test("joinBy pairs every left with every right of its key: the left's order, then the right's", () => {
  expect(joinBy([a, b, c], [{ id: 9, code: "x" }, { id: 8, code: "q" }, { id: 7, code: "x" }], code)).toEqual([
    [a, { id: 9, code: "x" }],
    [a, { id: 7, code: "x" }],
    [c, { id: 9, code: "x" }],
    [c, { id: 7, code: "x" }],
  ]);
});

test("groupCount counts each key, in the order the keys were first seen", () => {
  expect(groupCount([a, b, c, d, b, c], code)).toEqual([
    { key: "x", count: 3 },
    { key: "y", count: 2 },
    { key: "z", count: 1 },
  ]);
});
`;

    const readme = `# The ${world.job}

\`src/rollup.js\` has what the ${world.job} is made of. Each takes \`keyOf\`, a function from a ${world.record} to its key (here: its ${world.key}).

- \`dedupe(records, keyOf)\`: the ${world.records} without the later ones of any key. The first of each key stays, in the order they came.
- \`joinBy(left, right, keyOf)\`: every pair \`[l, r]\` with the same key, in the left's order and, for one left, the right's.
- \`groupCount(records, keyOf)\`: \`{ key, count }\` for each key, in the order the keys were first seen.

Keys are compared with \`===\`. So \`1\` and \`"1"\` are different keys${strict ? ", `0` and `-0` are the same key, and a key that is `NaN` equals nothing, itself included: two records with a `NaN` key never share a key" : ""}.

\`keyOf\` can be expensive (it may parse a whole ${world.record}). ${
      once ? `Every function here calls it **exactly once for each ${world.record}** it is given, whatever the input.` : `The work each function does has to grow in step with its input: about one key computation a ${world.record}, not one for every pair of them.`
    }

\`bun bench.mjs\` counts how often \`keyOf\` runs for ${n} ${world.records}, and fails over its budget.
`;

    const statement = [
      `The ${world.job} has become far too slow. \`bun bench.mjs\` in the repository counts how often the key function runs and fails its budget; make it pass.`,
      "What each function returns must not change: README.md says exactly what that is.",
      level === 1
        ? ""
        : level === 2
          ? "`joinBy` runs in the same job on inputs as large, and has to scale the same way, though the benchmark doesn't measure it."
          : `Everything in src/rollup.js runs on inputs this large: all of it has to meet what the README says about the key function${once ? " (read it closely)" : ""}, though the benchmark measures only one.`,
    ]
      .filter(Boolean)
      .join(" ");

    const prelude = js`const STRICT = ${strict};
const PER_RECORD = ${perRecord};

/** The functions as they were given: slow, and right. What the fast ones must still return. */
const oracle = (() => {
  const indexOfKey = (list, key, keyOf) => {
    for (let i = 0; i < list.length; i++) if (keyOf(list[i]) === key) return i;
    return -1;
  };
  return {
    dedupe(records, keyOf) {
      const kept = [];
      for (const record of records) if (indexOfKey(kept, keyOf(record), keyOf) < 0) kept.push(record);
      return kept;
    },
    joinBy(left, right, keyOf) {
      const pairs = [];
      for (const l of left) for (const r of right) if (keyOf(r) === keyOf(l)) pairs.push([l, r]);
      return pairs;
    },
    groupCount(records, keyOf) {
      const groups = [];
      const firsts = [];
      for (const record of records) {
        const at = indexOfKey(firsts, keyOf(record), keyOf);
        if (at < 0) {
          firsts.push(record);
          groups.push({ key: keyOf(record), count: 1 });
        } else groups[at].count += 1;
      }
      return groups;
    },
  };
})();

/** Records with keys of several kinds: many distinct, or few. From level 3, some keys are NaN. */
const make = (n, distinct, seed) => {
  const next = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const pick = Math.floor(next() * distinct);
    const roll = next();
    const key = STRICT && roll < 0.04 ? NaN : roll < 0.3 ? pick : roll < 0.4 ? String(pick) : "k" + pick;
    return { id: i, key };
  });
};
const keyOf = (record) => record.key;
const same = (got, want, what) => {
  assert.equal(got.length, want.length, what + ": " + got.length + " instead of " + want.length);
  for (let i = 0; i < want.length; i++) {
    if (Array.isArray(want[i])) assert.ok(got[i][0] === want[i][0] && got[i][1] === want[i][1], what + ": pair " + i + " differs");
    else if ("count" in want[i]) assert.ok(Object.is(got[i].key, want[i].key) && got[i].count === want[i].count, what + ": group " + i + " differs");
    else assert.ok(got[i] === want[i], what + ": record " + i + " differs");
  }
};

/** A key function that counts, and gives up once the budget is gone (so slow code fails soon, not late). */
const counting = (budget) => {
  const state = { calls: 0 };
  state.keyOf = (record) => {
    if (++state.calls > budget) throw new Error("over budget: more than " + budget + " key computations");
    return record.key;
  };
  return state;
};

/** Right on small inputs of both kinds (against the functions as given), and the tests as given untouched. */
const right = async (name) => {
  testsIntact();
  const lib = await load("src/rollup.js");
  for (const [n, distinct, seed] of [[900, 900, 11], [900, 30, 12], [0, 1, 13], [1, 1, 14], [700, 5, 15]]) {
    const records = make(n, distinct, seed);
    if (name === "joinBy") {
      const other = make(Math.min(n, 400), distinct, seed + 100);
      same(lib.joinBy(records, other, keyOf), oracle.joinBy(records, other, keyOf), "joinBy");
    } else same(lib[name](records, keyOf), oracle[name](records, keyOf), name);
  }
  return lib;
};

/** Within budget on a large input: so many key computations a record, no more. */
const scales = async (name, distinct) => {
  const lib = await right(name);
  const n = 20000;
  const records = make(n, distinct(n), 21);
  if (name === "joinBy") {
    const other = make(n, distinct(n), 22);
    const count = counting(PER_RECORD * 2 * n);
    lib.joinBy(records, other, count.keyOf);
  } else {
    const count = counting(PER_RECORD * n);
    lib[name](records, count.keyOf);
  }
};
`;

    const checks: Check[] = scaling.flatMap((fn) => [
      { key: `${SHORT[fn]}_fast_unique`, what: `${fn} scales when every key is its own, and returns what it did`, body: `    await scales(${JSON.stringify(fn)}, (n) => n);` },
      { key: `${SHORT[fn]}_fast_repeats`, what: `${fn} scales when keys repeat, and returns what it did`, body: `    await scales(${JSON.stringify(fn)}, () => 50);` },
    ]);

    const done = (why: string): Solution["result"] => ({ outcome: "done", why, evidence: ["bench.mjs", "test/rollup.test.js"] });
    const wrong: Solution[] = [];
    if (level <= 2) wrong.push({ name: "fast, and keeps the last of each key instead of the first", files: { "src/rollup.js": moduleWith({ dedupe: KEEPS_LAST, ...(level === 2 ? { joinBy: FAST.joinBy } : {}) }) }, result: done("The benchmark passes.") });
    if (level >= 2) wrong.push({ name: "only the function the benchmark measures", files: { "src/rollup.js": moduleWith({ dedupe: FAST.dedupe }) }, result: done("The benchmark passes.") });
    if (strict) wrong.push({ name: "fast with a Map, which folds NaN keys together", files: { "src/rollup.js": moduleWith(FOLDS_NAN) }, result: done("The benchmark passes; every function uses a Map.") });

    return {
      statement,
      files: {
        "package.json": packageJson(`${world.record}-rollup`),
        "README.md": readme,
        "src/rollup.js": SLOW,
        "bench.mjs": bench,
        "test/rollup.test.js": tests,
      },
      gates: ["cd /work/repo && bun bench.mjs", "cd /work/repo && bun test"],
      prelude,
      checks,
      reference: { name: "every function that must scale, one key computation a record, === kept", files: { "src/rollup.js": moduleWith(Object.fromEntries(scaling.map((fn) => [fn, FAST[fn]]))) }, result: done("Each function computes a record's key once; results are unchanged.") },
      wrong,
      maxSteps: level >= 3 ? 35 : 25,
    };
  },
};
