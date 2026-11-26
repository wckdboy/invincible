import { type AgenticTask, type Built, int, js, packageJson, pickOne, type Rng, type Solution } from "./kit.ts";

/*
 * Refactoring: a tangled function split into named parts, with its behaviour kept to
 * the cent under property tests. The function prices an order (weight in half-kilo
 * steps, a handling fee, a bulk discount, a fragile surcharge with a cap, a zone
 * multiplier, lines rounded half down, an order minimum), and every one of those has
 * an edge a tidy rewrite gets wrong.
 *
 * The dial: how much the task says about those edges. At level 1 they are listed and
 * the repository's tests cover each; at level 3 the code is the only specification
 * and the tests cover the plain case; at level 4 the code's own comments are wrong.
 */

interface Rates {
  step: number;
  handling: number;
  bulkAt: number;
  bulkOff: number;
  fragile: number;
  fragileCap: number;
  mid: number;
  far: number;
  minimum: number;
}

const draw = (rng: Rng): Rates => ({
  step: int(rng, 7, 12) * 5,
  handling: int(rng, 6, 12) * 25,
  bulkAt: int(rng, 5, 12),
  bulkOff: pickOne(rng, [10, 15, 20, 25]),
  fragile: int(rng, 8, 18) * 5,
  fragileCap: int(rng, 6, 12) * 50,
  mid: pickOne(rng, [125, 135, 145, 155]),
  far: pickOne(rng, [185, 195, 215, 235]),
  minimum: int(rng, 10, 18) * 50,
});

/** One line's cents, as the code computes it (for the tests the repository ships with). */
function lineOf(r: Rates, zone: "near" | "mid" | "far", weight: number, quantity: number, fragile: boolean): number {
  const q = Math.floor(Number(quantity));
  if (!(q > 0)) return 0;
  const w = Math.ceil(Number(weight) * 2);
  let c = w > 0 ? Math.max(w * r.step * q, r.handling) : r.handling;
  if (q >= r.bulkAt) c -= Math.floor((c * r.bulkOff) / 100);
  if (fragile) c += Math.min(r.fragile * q, r.fragileCap);
  c = (c * (zone === "near" ? 100 : zone === "mid" ? r.mid : r.far)) / 100;
  return Math.ceil(c - 0.5);
}
type Item = { weight: number; quantity: number; fragile?: boolean };
function quoteOf(r: Rates, order: { zone?: string; items: Item[] }): { zone: string; lines: number[]; cents: number } {
  const zone = order.zone === "near" || order.zone === "mid" ? order.zone : "far";
  const lines = order.items.map((i) => lineOf(r, zone, i.weight, i.quantity, !!i.fragile));
  const sum = lines.reduce((s, x) => s + x, 0);
  return { zone, lines, cents: lines.length > 0 && sum < r.minimum ? r.minimum : sum };
}

/** The function as it stands: one loop, flags and magic numbers. */
const tangledOnce = (r: Rates, lying: boolean): string => js`// Quotes for the shop. Grown over the years; it works, don't ask.
export function quote(order) {
  var t = 0;
  var ls = [];
  var z = order.zone;
  var f = false;
  if (z != "near") {
    if (z != "mid") {
      z = "far";
    }
  }
  var its = order.items ? order.items : [];
  for (var i = 0; i < its.length; i++) {
    var it = its[i];
    var q = Math.floor(Number(it.quantity));
    var c = 0;
    if (q > 0) {
      var w = Math.ceil(Number(it.weight) * 2);
      if (w > 0) {
        c = w * ${r.step} * q;
        if (c < ${r.handling}) {
          c = ${r.handling};
        }
      } else {
        c = ${r.handling};
      }
      if (q >= ${r.bulkAt}) {
        c = c - Math.floor((c * ${r.bulkOff}) / 100);
      }
      if (it.fragile) {
        var fr = ${r.fragile} * q;
        if (fr > ${r.fragileCap}) {
          fr = ${r.fragileCap};
        }
        c = c + fr;
        f = true;
      }
      if (z == "near") {
        c = (c * 100) / 100;
      } else if (z == "mid") {
        c = (c * ${r.mid}) / 100;
      } else {
        c = (c * ${r.far}) / 100;
      }
      ${lying ? "// round to the nearest cent, halves up" : "// to whole cents"}
      c = Math.ceil(c - 0.5);
    } else {
      c = 0;
    }
    ls.push(c);
    t = t + c;
  }
  ${lying ? "// orders with nothing to pay for are free; anything else pays at least the minimum" : "// the minimum"}
  if (ls.length > 0) {
    if (t < ${r.minimum}) {
      t = ${r.minimum};
    }
  }
  return { zone: z, lines: ls, cents: t };
}
`;

/** The same function, worse: the loop written out once per zone, as code like this ends up. */
const tangledThrice = (r: Rates, lying: boolean): string => {
  const loop = (zone: string, mult: number, v: string): string => js`    for (var ${v} = 0; ${v} < its.length; ${v}++) {
      var q${v} = Math.floor(Number(its[${v}].quantity));
      var c${v} = 0;
      if (q${v} > 0) {
        var w${v} = Math.ceil(Number(its[${v}].weight) * 2);
        c${v} = w${v} > 0 ? w${v} * ${r.step} * q${v} : ${r.handling};
        if (c${v} < ${r.handling}) c${v} = ${r.handling};
        if (!(q${v} < ${r.bulkAt})) c${v} -= Math.floor((c${v} * ${r.bulkOff}) / 100);
        if (its[${v}].fragile) c${v} += ${r.fragile} * q${v} > ${r.fragileCap} ? ${r.fragileCap} : ${r.fragile} * q${v};
        c${v} = Math.ceil((c${v} * ${mult}) / 100 - 0.5);${lying && zone === "mid" ? " // nearest cent" : ""}
      }
      ls.push(c${v});
      t += c${v};
    }`;
  return js`// Quotes for the shop. Grown over the years; it works, don't ask.
export function quote(order) {
  var t = 0;
  var ls = [];
  var its = order.items || [];
  var z;
  if (order.zone == "near") {
    z = "near";
${loop("near", 100, "i")}
  } else if (order.zone == "mid") {
    z = "mid";
${loop("mid", r.mid, "j")}
  } else {
    ${lying ? "// unknown zones are refused upstream, so this is always the far zone" : "// everything else"}
    z = "far";
${loop("far", r.far, "k")}
  }
  ${lying ? "// free orders stay free" : "// the minimum"}
  if (ls.length != 0 && t < ${r.minimum}) t = ${r.minimum};
  return { zone: z, lines: ls, cents: t };
}
`;
};

const refactored = (r: Rates, how: "right" | "tidy" | "loose"): string => js`/** What the shop charges, in cents (zones in percent). */
export const RATES = ${how === "loose" ? "" : "Object.freeze("}{
  step: ${r.step},
  handling: ${r.handling},
  bulkAt: ${r.bulkAt},
  bulkOff: ${r.bulkOff},
  fragile: ${r.fragile},
  fragileCap: ${r.fragileCap},
  zone: ${how === "loose" ? "" : "Object.freeze("}{ near: 100, mid: ${r.mid}, far: ${r.far} }${how === "loose" ? "" : ")"},
  minimum: ${r.minimum},
}${how === "loose" ? "" : ")"};

/** An order as the pricing reads it: a known zone, and each item in half-kilo steps and whole pieces. */
export function normalize(order) {
  const zone = order.zone === "near" || order.zone === "mid" ? order.zone : "far";
  const items = (order.items ? order.items : []).map((item) => {
    const quantity = Math.floor(Number(item.quantity));
    const steps = Math.ceil(Number(item.weight) * 2);
    return { steps: steps > 0 ? steps : 0, quantity: quantity > 0 ? quantity : 0, fragile: Boolean(item.fragile) };
  });
  return { zone, items };
}

/** One normalized item's cents in a zone. */
export function lineCost(item, zone) {
  if (item.quantity === 0) return 0;
  let cost = item.steps > 0 ? Math.max(item.steps * RATES.step * item.quantity, RATES.handling) : RATES.handling;
  if (item.quantity >= RATES.bulkAt) cost -= Math.floor((cost * RATES.bulkOff) / 100);
  if (item.fragile) cost += Math.min(RATES.fragile * item.quantity, RATES.fragileCap);
  ${how === "tidy" ? "return Math.round((cost * RATES.zone[zone]) / 100);" : "// Halves go down, as they always have.\n  return Math.ceil((cost * RATES.zone[zone]) / 100 - 0.5);"}
}

/** An order's cents from its lines': any order with a line pays at least the minimum. */
export function total(lines) {
  const sum = lines.reduce((cents, line) => cents + line, 0);
  return ${how === "tidy" ? "sum > 0 && sum < RATES.minimum" : "lines.length > 0 && sum < RATES.minimum"} ? RATES.minimum : sum;
}

export function quote(order) {
  const { zone, items } = normalize(order);
  const lines = items.map((item) => lineCost(item, zone));
  return { zone, lines, cents: total(lines) };
}
`;

export const untangle: AgenticTask = {
  id: "untangle",
  title: "A tangled function, split without changing a cent",
  kind: "refactoring",
  dial: "how much the task says about the edges to keep: listed and tested (1), listed (2), only in the code (3), and contradicted by the code's own comments (4)",
  build(rng, level): Built {
    const r = draw(rng);
    const lying = level >= 4;
    const given = level >= 3 ? tangledThrice(r, lying) : tangledOnce(r, lying);

    const plain = { zone: "near", items: [{ weight: 2, quantity: 2 }, { weight: 1.2, quantity: 1, fragile: true }] };
    const edges: { name: string; order: { zone?: string; items: Item[] } }[] = [
      { name: "weight goes up to the next half kilo; a light line still pays handling", order: { zone: "near", items: [{ weight: 0.01, quantity: 1 }, { weight: 2.01, quantity: 3 }, { weight: 0, quantity: 2 }] } },
      { name: "the bulk discount comes off before the fragile surcharge, which is capped a line", order: { zone: "mid", items: [{ weight: 1, quantity: r.bulkAt, fragile: true }, { weight: 1, quantity: r.bulkAt - 1, fragile: true }, { weight: 3, quantity: 40, fragile: true }] } },
      { name: "a zone nobody knows is the far zone; half a cent goes down", order: { zone: "moon", items: [{ weight: 0.5, quantity: 1 }, { weight: 1.5, quantity: 1, fragile: true }, { weight: 2.5, quantity: 3 }] } },
      { name: "a line of nothing costs nothing, and still makes the order pay the minimum; no lines, no charge", order: { zone: "far", items: [{ weight: 4, quantity: 0 }, { weight: 4, quantity: -3 }] } },
    ];
    const shown = level === 1 ? edges : level === 2 ? edges.slice(0, 2) : [];
    const test = (name: string, order: { zone?: string; items: Item[] }): string => `test(${JSON.stringify(name)}, () => {\n  expect(quote(${JSON.stringify(order)})).toEqual(${JSON.stringify(quoteOf(r, order))});\n});\n`;
    const tests = `import { expect, test } from "bun:test";\nimport { quote } from "../src/quote.js";\n\n${test("an order's lines and total", plain)}\n${shown.map((e) => test(e.name, e.order)).join("\n")}${level === 1 ? `\ntest("no lines, no charge", () => {\n  expect(quote({ zone: "near", items: [] })).toEqual({ zone: "near", lines: [], cents: 0 });\n});\n` : ""}`;

    const careful =
      level <= 2
        ? `
## Careful

The shop's customers have been quoted by this code for years, and every quote has to stay what it was. In particular:

- A weight counts in half-kilo steps, rounded **up**; a line whose weight isn't positive, or whose cost comes to less than the handling fee, pays the handling fee.
- A quantity is floored; a line whose quantity isn't positive (or isn't a number) costs 0, and is still a line.
- The bulk discount (from ${r.bulkAt} pieces) comes off **before** the fragile surcharge, rounded down; the surcharge is per piece, capped per line.
- The zone's percentage applies last. A zone that isn't "near" or "mid" is "far".
- Each line is rounded to whole cents with halves going **down**; the total is the sum of the rounded lines.
- An order with at least one line pays at least the minimum, even if every line costs 0. An order with no lines pays 0.
`
        : `
The shop's customers have been quoted by this code for years, and every quote has to stay what it was, for every order it accepts today. The code is the only specification there is.
`;

    const refactorMd = `# Splitting \`quote\`

\`src/quote.js\` exports one function, \`quote(order)\`, which nobody dares touch. Split it, in the same file, into:

- \`RATES\`: a frozen object with every number the pricing uses, and nothing else:
  \`{ step, handling, bulkAt, bulkOff, fragile, fragileCap, zone: { near, mid, far }, minimum }\`
  (cents, pieces and percent, as the code uses them; \`zone\` is frozen too).
- \`normalize(order)\` → \`{ zone, items }\`: \`zone\` is "near", "mid" or "far"; each item is \`{ steps, quantity, fragile }\` with
  \`steps\` the weight in half-kilo steps as the pricing counts it (0 when the weight isn't positive), \`quantity\` the whole
  pieces it counts (0 when that isn't positive), and \`fragile\` a boolean.
- \`lineCost(item, zone)\` → one normalized item's cents in that zone.
- \`total(lines)\` → the order's cents from its lines' cents.
- \`quote(order)\` → \`{ zone, lines, cents }\` exactly as today, and now nothing but
  \`normalize\`, then \`lineCost\` for each item, then \`total\`.

All five are exported. None of them changes what it is given, and none keeps anything between calls.
${careful}`;

    const statement = [
      "REFACTOR.md in the repository says how `quote` in src/quote.js is to be split into named parts. Do that.",
      "Every quote must stay exactly what it is today, to the cent, for every order the function accepts: that is what the work is graded on, with thousands of orders you haven't seen.",
    ].join(" ");

    const prelude = js`const R = ${JSON.stringify(r)};

/** The function as it was given, written plainly: what every quote must still be. */
const oracle = (order) => {
  const zone = order.zone === "near" || order.zone === "mid" ? order.zone : "far";
  const mult = zone === "near" ? 100 : zone === "mid" ? R.mid : R.far;
  const lines = [];
  let sum = 0;
  for (const item of order.items ? order.items : []) {
    const q = Math.floor(Number(item.quantity));
    let c = 0;
    if (q > 0) {
      const w = Math.ceil(Number(item.weight) * 2);
      c = w > 0 ? w * R.step * q : R.handling;
      if (c < R.handling) c = R.handling;
      if (q >= R.bulkAt) c = c - Math.floor((c * R.bulkOff) / 100);
      if (item.fragile) c = c + Math.min(R.fragile * q, R.fragileCap);
      c = Math.ceil((c * mult) / 100 - 0.5);
    }
    lines.push(c);
    sum += c;
  }
  return { zone, lines, cents: lines.length > 0 && sum < R.minimum ? R.minimum : sum };
};
const normalized = (order) => ({
  zone: order.zone === "near" || order.zone === "mid" ? order.zone : "far",
  items: (order.items ? order.items : []).map((item) => {
    const q = Math.floor(Number(item.quantity));
    const w = Math.ceil(Number(item.weight) * 2);
    return { steps: w > 0 ? w : 0, quantity: q > 0 ? q : 0, fragile: Boolean(item.fragile) };
  }),
});

const WEIGHTS = [0, -1, NaN, 0.01, 0.49, 0.5, 0.51, 1, 1.01, 2.5, 7.3, 12, 25.25, "3", 0.25, 1.75];
const QUANTITIES = [0, -2, NaN, 1, 1.9, 2, 3, R.bulkAt - 1, R.bulkAt, R.bulkAt + 0.5, R.bulkAt + 1, 20, 37, "4"];
const ZONES = ["near", "mid", "far", "moon", undefined, "", "NEAR"];
const FRAGILE = [true, false, undefined, 1, 0, "yes"];
const orders = (seed, n) => {
  const next = rng(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const count = Math.floor(next() * 6);
    const items = [];
    for (let j = 0; j < count; j++) {
      const item = { weight: next() < 0.6 ? pick(WEIGHTS) : Math.round(next() * 3000) / 100, quantity: next() < 0.6 ? pick(QUANTITIES) : Math.floor(next() * 30) };
      const fragile = pick(FRAGILE);
      if (fragile !== undefined) item.fragile = fragile;
      items.push(item);
    }
    const order = { items };
    const zone = pick(ZONES);
    if (zone !== undefined) order.zone = zone;
    out.push(order);
  }
  out.push({ zone: "near" }, { zone: "mid", items: [] }, { items: [{ weight: 1, quantity: 0 }] });
  return out;
};

/** Every quote is what it was, the tests as given are untouched, and the parts are there. */
const unchanged = async () => {
  testsIntact();
  const lib = await load("src/quote.js");
  for (const name of ["normalize", "lineCost", "total", "quote"]) assert.equal(typeof lib[name], "function", name + " isn't exported");
  for (const order of orders(5150, 3000)) assert.deepEqual(lib.quote(order), oracle(order), "a quote changed: " + JSON.stringify(order));
  return lib;
};
`;

    const result = (why: string): Solution["result"] => ({ outcome: "done", why, evidence: ["src/quote.js", "test/quote.test.js"] });
    return {
      statement,
      files: {
        "package.json": packageJson("shop-quotes"),
        "REFACTOR.md": refactorMd,
        "src/quote.js": given,
        "test/quote.test.js": tests,
      },
      gates: ["cd /work/repo && bun test"],
      prelude,
      checks: [
        {
          key: "normalize_split",
          what: "normalize is the order as the pricing reads it, and no quote changed",
          body: js`    const lib = await unchanged();
    for (const order of orders(61, 800)) assert.deepEqual(lib.normalize(order), normalized(order), "normalize: " + JSON.stringify(order));`,
        },
        {
          key: "line_cost_split",
          what: "lineCost is one line of the quote, and no quote changed",
          body: js`    const lib = await unchanged();
    for (const order of orders(62, 800)) {
      const want = oracle(order);
      const n = normalized(order);
      n.items.forEach((item, i) => assert.equal(lib.lineCost(item, n.zone), want.lines[i], "lineCost: " + JSON.stringify([item, n.zone])));
    }`,
        },
        {
          key: "total_split",
          what: "total is the order's cents from its lines', and no quote changed",
          body: js`    const lib = await unchanged();
    for (const order of orders(63, 800)) assert.equal(lib.total(oracle(order).lines), oracle(order).cents, "total: " + JSON.stringify(oracle(order).lines));
    assert.equal(lib.total([]), 0);
    assert.equal(lib.total([0, 0]), R.minimum);`,
        },
        {
          key: "rates_table",
          what: "RATES holds every number, frozen, and no quote changed",
          body: js`    const lib = await unchanged();
    assert.deepEqual(JSON.parse(JSON.stringify(lib.RATES)), { step: R.step, handling: R.handling, bulkAt: R.bulkAt, bulkOff: R.bulkOff, fragile: R.fragile, fragileCap: R.fragileCap, zone: { near: 100, mid: R.mid, far: R.far }, minimum: R.minimum });
    assert.ok(Object.isFrozen(lib.RATES) && Object.isFrozen(lib.RATES.zone), "RATES isn't frozen all the way down");`,
        },
        {
          key: "composed_and_pure",
          what: "quote is normalize, lineCost and total and nothing else; nothing is changed or kept between calls",
          body: js`    const lib = await unchanged();
    for (const order of orders(64, 800)) {
      const before = JSON.stringify(order);
      const n = lib.normalize(order);
      const lines = n.items.map((item) => lib.lineCost(item, n.zone));
      assert.deepEqual(lib.quote(order), { zone: n.zone, lines, cents: lib.total(lines) }, "quote isn't its parts: " + before);
      assert.deepEqual(lib.quote(order), lib.quote(order));
      assert.equal(JSON.stringify(order), before, "the order was changed");
    }`,
        },
      ],
      reference: { name: "split as asked, every quote as it was", files: { "src/quote.js": refactored(r, "right") }, result: result("Split into RATES, normalize, lineCost, total and quote; quotes are unchanged.") },
      asGiven: js`    const lib = await load("src/quote.js");
    for (const order of orders(5150, 3000)) assert.deepEqual(lib.quote(order), oracle(order), "the code as given isn't the oracle: " + JSON.stringify(order));`,
      wrong: [
        { name: "a tidy rewrite: halves round up, and an order of nothing is free", files: { "src/quote.js": refactored(r, "tidy") }, result: result("Split as REFACTOR.md asks; the tests pass.") },
        { name: "every quote as it was, RATES left unfrozen", files: { "src/quote.js": refactored(r, "loose") }, result: result("Split as REFACTOR.md asks; the tests pass.") },
      ],
      maxSteps: 30,
    };
  },
};
