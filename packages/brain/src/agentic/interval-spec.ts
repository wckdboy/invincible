import { type AgenticTask, type Built, type Check, int, js, packageJson, pickOne, type Rng } from "./kit.ts";

/*
 * Specification: an implementation from a written spec with nasty edge cases. Sets of
 * integers written as ranges: parse, normalize, print. The edges are where a quick
 * implementation thinks in real intervals: over the integers [1..3] and [4..6] touch
 * and are one range, (3..4) is empty, an unbounded end has a bracket of its own.
 *
 * The dial: how much of the notation there is. Level 1: closed ranges. Level 2: open
 * ends and bare integers. Level 3: unbounded ends and subtraction. Level 4: a half-open
 * canonical form, membership, and syntax errors that say exactly where.
 */

interface Syntax {
  inner: string;
  outer: string;
  inf: string;
  open: boolean;
  bare: boolean;
  unbounded: boolean;
  subtract: boolean;
  halfOpen: boolean;
  positions: boolean;
  /** False only in the wrong solution: ranges that touch aren't joined. */
  adjacency: boolean;
}

/** The implementation, as a module (the reference solution) or as the checks' oracle. */
function source(s: Syntax, as: "module" | "oracle"): string {
  const names = ["parse", "format", "normalize", ...(s.subtract ? ["subtract"] : []), ...(s.positions ? ["contains"] : [])];
  const body = js`const S = ${JSON.stringify(s)};

const fail = (message, position) => {
  const error = new SyntaxError(message + " at " + position);
  error.position = position;
  throw error;
};
const before = (a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : a.hi < b.hi ? -1 : a.hi > b.hi ? 1 : 0);

/** Sorted, with ranges that overlap or touch joined, and empty ones gone. */
function normalize(ranges) {
  const sorted = ranges.filter((r) => r.lo <= r.hi).map((r) => ({ lo: r.lo, hi: r.hi })).sort(before);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi + (S.adjacency ? 1 : 0)) {
      if (r.hi > last.hi) last.hi = r.hi;
    } else out.push(r);
  }
  return out;
}

function parse(text) {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  // A token, character by character: the first one that differs is where the text went wrong.
  const expect = (token, what) => {
    for (const ch of token) {
      if (text[i] !== ch) fail("expected " + what, i);
      i++;
    }
  };
  const digit = (ch) => ch !== undefined && ch >= "0" && ch <= "9";
  /** An integer, or (where it may stand) an unbounded end. which: "lo" after a bracket, "hi" after the dots, "bare". */
  const bound = (which, opener) => {
    skip();
    let sign = 1;
    if (text[i] === "-") {
      sign = -1;
      i++;
    }
    if (digit(text[i])) {
      let n = 0;
      while (digit(text[i])) n = n * 10 + (text.charCodeAt(i++) - 48);
      return sign * n || 0;
    }
    // Not a digit: only an unbounded end can stand here, -inf to open a round bracket, inf to close one.
    const unbounded = S.unbounded && ((which === "lo" && sign === -1 && opener === "(") || (which === "hi" && sign === 1));
    if (!unbounded) fail("expected an integer", i);
    expect(S.inf, "an integer or " + S.inf);
    return sign * Infinity;
  };
  const ranges = [];
  skip();
  if (i === text.length) return [];
  for (;;) {
    skip();
    const opener = text[i];
    if (opener === "[" || (S.open && opener === "(")) {
      i++;
      const lo = bound("lo", opener);
      skip();
      expect(S.inner, JSON.stringify(S.inner));
      const hi = bound("hi", opener);
      skip();
      const closer = text[i];
      // An unbounded end closes with a round bracket, and nothing else.
      if (hi === Infinity ? closer !== ")" : closer !== "]" && !(S.open && closer === ")")) fail("expected a closing bracket", i);
      i++;
      ranges.push({ lo: opener === "(" && lo !== -Infinity ? lo + 1 : lo, hi: closer === ")" && hi !== Infinity ? hi - 1 : hi });
    } else if (S.bare && (opener === "-" || digit(opener))) {
      const n = bound("bare");
      ranges.push({ lo: n, hi: n });
    } else fail("expected a range", i);
    skip();
    if (i === text.length) break;
    expect(S.outer, JSON.stringify(S.outer));
  }
  return normalize(ranges);
}

function format(ranges) {
  return normalize(ranges)
    .map((r) => {
      if (S.bare && r.lo === r.hi) return String(r.lo);
      const left = r.lo === -Infinity ? "(-" + S.inf : "[" + r.lo;
      const right = r.hi === Infinity ? S.inf + ")" : S.halfOpen ? r.hi + 1 + ")" : r.hi + "]";
      return left + S.inner + right;
    })
    .join(S.outer + " ");
}

/** What of a is not in b. */
function subtract(a, b) {
  let rest = normalize(a);
  for (const cut of normalize(b)) {
    const next = [];
    for (const r of rest) {
      if (cut.hi < r.lo || cut.lo > r.hi) {
        next.push(r);
        continue;
      }
      if (cut.lo > r.lo) next.push({ lo: r.lo, hi: cut.lo - 1 });
      if (cut.hi < r.hi) next.push({ lo: cut.hi + 1, hi: r.hi });
    }
    rest = next;
  }
  return rest;
}

function contains(ranges, n) {
  return Number.isInteger(n) && normalize(ranges).some((r) => r.lo <= n && n <= r.hi);
}
`;
  if (as === "module") return `${body}\nexport { ${names.join(", ")} };\n`;
  return `const oracle = (() => {\n${body}\n  return { parse, format, normalize, subtract, contains };\n})();\n`;
}

/* ---------- writing ranges, here, for the spec's examples and the visible tests ---------- */

type R = { lo: number; hi: number };
const write = (s: Syntax, r: R, how: "closed" | "open" | "left" | "right" = "closed"): string => {
  const lo = r.lo === -Infinity ? `(-${s.inf}` : how === "open" || how === "left" ? `(${r.lo - 1}` : `[${r.lo}`;
  const hi = r.hi === Infinity ? `${s.inf})` : how === "open" || how === "right" ? `${r.hi + 1})` : `${r.hi}]`;
  return `${lo}${s.inner}${hi}`;
};
const canonical = (s: Syntax, ranges: R[]): string =>
  ranges
    .map((r) => {
      if (s.bare && r.lo === r.hi) return String(r.lo);
      const left = r.lo === -Infinity ? `(-${s.inf}` : `[${r.lo}`;
      const right = r.hi === Infinity ? `${s.inf})` : s.halfOpen ? `${r.hi + 1})` : `${r.hi}]`;
      return `${left}${s.inner}${right}`;
    })
    .join(`${s.outer} `);
const lit = (ranges: R[]): string => `[${ranges.map((r) => `{ lo: ${r.lo === -Infinity ? "-Infinity" : r.lo}, hi: ${r.hi === Infinity ? "Infinity" : r.hi} }`).join(", ")}]`;

/** Ranges apart from each other (never touching), ascending. */
function apart(rng: Rng, n: number, from = -40): R[] {
  const out: R[] = [];
  let at = from + int(rng, 0, 9);
  for (let i = 0; i < n; i++) {
    const lo = at;
    const hi = lo + int(rng, 1, 8);
    out.push({ lo, hi });
    at = hi + int(rng, 6, 12);
  }
  return out;
}

export const intervalSpec: AgenticTask = {
  id: "interval-spec",
  title: "Sets of integers as ranges, from a written spec",
  kind: "specification",
  dial: "how much notation the spec has: closed ranges (1), open ends and bare integers (2), unbounded ends and subtraction (3), a half-open canonical form, membership and exact error positions (4)",
  build(rng, level): Built {
    const inner = pickOne(rng, ["..", ","]);
    const s: Syntax = {
      inner,
      outer: pickOne(rng, [";", "|", "+"]),
      inf: pickOne(rng, ["inf", "oo", "*"]),
      open: level >= 2,
      bare: level >= 2,
      unbounded: level >= 3,
      subtract: level >= 3,
      halfOpen: level >= 4,
      positions: level >= 4,
      adjacency: true,
    };
    const names = ["parse", "format", "normalize", ...(s.subtract ? ["subtract"] : []), ...(s.positions ? ["contains"] : [])];
    const stubs = `// Sets of integers, written as ranges. SPEC.md says what each of these does.\n\n${names.map((n) => `export function ${n}() {\n  throw new Error("not implemented");\n}\n`).join("\n")}`;

    const [a, b, c] = apart(rng, 3) as [R, R, R];
    const sep = `${s.outer} `;
    // Out of order, overlapping, touching, empty: one of each.
    const touching: R = { lo: a.hi + 1, hi: a.hi + 3 };
    const overlapping: R = { lo: b.lo + 1, hi: b.hi + 2 };
    const empty = `[${c.hi + 5}${s.inner}${c.hi + 2}]`;
    const mergedText = [write(s, overlapping), write(s, touching), empty, write(s, a), write(s, b)].join(sep);
    const merged: R[] = [{ lo: a.lo, hi: touching.hi }, { lo: b.lo, hi: overlapping.hi }];
    const point = c.hi + 20;

    const examples: [string, R[]][] = [
      [[write(s, a), write(s, b)].join(sep), [a, b]],
      [mergedText, merged],
      [`  ${write(s, b).replace(s.inner, ` ${s.inner} `)}${s.outer}${write(s, a)}  `, [a, b]],
      ["", []],
    ];
    if (s.open) {
      examples.push([[write(s, a, "open"), write(s, b, "left"), write(s, c, "right")].join(sep), [a, b, c]]);
      examples.push([`(${point}${s.inner}${point + 1})${sep}${point}${sep}${point + 1}`, [{ lo: point, hi: point + 1 }]]);
    }
    if (s.unbounded) examples.push([[write(s, { lo: -Infinity, hi: a.lo }), write(s, { lo: c.hi, hi: Infinity })].join(sep), [{ lo: -Infinity, hi: a.lo }, { lo: c.hi, hi: Infinity }]]);

    const bad: string[] = [`[${a.lo}${s.inner}${a.hi}`, `${write(s, a)}${s.outer}`, `${write(s, a)}${s.outer}${s.outer}${write(s, b)}`, `[1.5${s.inner}3]`, `[${a.lo}${s.inner}x]`, `${write(s, a)} ${write(s, b)}`];
    if (!s.open) bad.push(`(${a.lo}${s.inner}${a.hi})`, String(point));
    if (s.unbounded) bad.push(`[-${s.inf}${s.inner}3]`, `[3${s.inner}${s.inf}]`, `(${s.inf}${s.inner}3)`);
    else bad.push(`(-${s.inf}${s.inner}3]`);

    const tests = `import { expect, test } from "bun:test";
import { format, normalize, parse${s.subtract ? ", subtract" : ""}${s.positions ? ", contains" : ""} } from "../src/ranges.js";

test("the spec's examples", () => {
${examples.map(([text, ranges]) => `  expect(parse(${JSON.stringify(text)})).toEqual(${lit(ranges)});\n  expect(format(parse(${JSON.stringify(text)}))).toBe(${JSON.stringify(canonical(s, ranges))});`).join("\n")}
});

test("normalize joins what overlaps or touches", () => {
  expect(normalize(${lit([b, a, touching])})).toEqual(${lit([{ lo: a.lo, hi: touching.hi }, b])});
});

test("text that isn't ranges is refused", () => {
  expect(() => parse(${JSON.stringify(bad[0])})).toThrow();
  expect(() => parse(${JSON.stringify(bad[1])})).toThrow();
});
${s.subtract ? `\ntest("subtract", () => {\n  expect(subtract(${lit([{ lo: a.lo, hi: b.hi }])}, ${lit([{ lo: a.hi + 1, hi: b.lo - 1 }])})).toEqual(${lit([a, b])});\n});\n` : ""}${
      s.positions ? `\ntest("contains", () => {\n  expect(contains(${lit([a, b])}, ${a.hi})).toBe(true);\n  expect(contains(${lit([a, b])}, ${a.hi + 1})).toBe(false);\n});\n` : ""
    }`;

    const spec = `# Sets of integers, written as ranges

\`src/ranges.js\` exports ${names.map((n) => `\`${n}\``).join(", ")}. A **set** here is a set of integers. In code a set is an array of
ranges \`{ lo, hi }\`: every integer from \`lo\` to \`hi\`, both included${s.unbounded ? " (`lo` may be `-Infinity` and `hi` may be `Infinity`)" : ""}.

## Normal form

\`normalize(ranges)\` returns the same set in its one normal form, as new objects (what it is given isn't changed):

- ascending;
- ranges that overlap **or touch** are one range. These are sets of integers, so \`{ lo: 1, hi: 3 }\` and \`{ lo: 4, hi: 6 }\`
  touch (nothing lies between 3 and 4) and become \`{ lo: 1, hi: 6 }\`;
- a range with \`lo > hi\` holds nothing and is dropped. The empty set is \`[]\`.

Every function below returns sets in normal form, and accepts sets that aren't.

## Text

A set is written as ranges separated by \`${s.outer}\`. A range is \`[lo${s.inner}hi]\`: both ends included.${
      s.open
        ? `
A round bracket leaves its end out: \`(lo${s.inner}hi]\`, \`[lo${s.inner}hi)\`, \`(lo${s.inner}hi)\`. Over the integers \`(2${s.inner}6)\` is 3, 4 and 5, and \`(3${s.inner}4)\` is empty.
A bare integer is the range holding only it: \`7\` is \`[7${s.inner}7]\`.`
        : ""
    }${
      s.unbounded
        ? `
An end may be unbounded: \`-${s.inf}\` as the low end, \`${s.inf}\` as the high end. An unbounded end is always written with a round
bracket, \`(-${s.inf}${s.inner}5]\` or \`[5${s.inner}${s.inf})\`; with a square bracket it is a syntax error. \`${s.inf}\` can't be a low end nor \`-${s.inf}\` a high end.`
        : ""
    }

Integers are decimal digits with an optional \`-\` directly in front (\`-0\` is 0); no \`+\`, no decimals, no exponent.
Whitespace may stand between tokens (around brackets, integers, \`${s.inner}\` and \`${s.outer}\`), not inside one: not between a \`-\` and its
digits. The empty text (or only whitespace) is the empty set. Anything else is a syntax error: an empty place between
two \`${s.outer}\`, a \`${s.outer}\` at the start or the end, a missing bracket, two ranges with no \`${s.outer}\` between them${s.open ? "" : ", a round bracket, a bare integer"}.

\`parse(text)\` returns the set in normal form, or throws${s.positions ? "" : " (any Error)"} on a syntax error. A range written with \`lo > hi\` is not an
error: it is empty.

\`format(set)\` writes the set's normal form: ${
      s.halfOpen
        ? `every range as \`[lo${s.inner}hi+1)\`, **half-open**: the low end included, the high end written one past the last integer and left out`
        : `every range as \`[lo${s.inner}hi]\``
    }${s.bare ? ", except that a range holding one integer is written as that integer alone" : ""}${s.unbounded ? `; an unbounded end is written \`(-${s.inf}\` or \`${s.inf})\`` : ""}.
Ranges are joined by \`${s.outer}\` and one space. The empty set is the empty text. \`parse(format(set))\` is always the set's normal form.
${
  s.subtract
    ? `
## Subtraction

\`subtract(a, b)\` returns, in normal form, every integer of \`a\` that isn't in \`b\`.
`
    : ""
}${
      s.positions
        ? `
## Membership

\`contains(set, n)\` is true when \`n\` is an integer in the set; false for anything else.

## Where a text goes wrong

\`parse\` throws a \`SyntaxError\` whose \`position\` property is a number: the index (from 0, in the text as given) of the
first character at which the text stops being the beginning of any valid text. If the whole text is the beginning of a
valid text and merely ends too soon, \`position\` is the text's length.

- \`${`[1${s.inner}2`}\` ends too soon: position ${`[1${s.inner}2`.length}.
- \`[1.5${s.inner}3]\`: ${s.inner === ".." ? "`[1.` could still become `[1..`, and the `5` can't follow it: position 3" : "after `[1` only whitespace or `,` can come, and `.` is neither: position 2"}.
- \`[-${s.inf}${s.inner}3]\`: after \`[-\` only a digit can come: position 2.
- \`[3${s.inner}${s.inf}]\`: \`[3${s.inner}${s.inf}\` is fine so far, and only \`)\` can close it: position ${`[3${s.inner}${s.inf}`.length}.
`
        : ""
    }
## Examples

${examples.map(([text, ranges]) => `- \`parse(${JSON.stringify(text)})\` → \`${lit(ranges)}\`, which \`format\` writes as \`${JSON.stringify(canonical(s, ranges))}\``).join("\n")}
`;

    const statement = [
      "SPEC.md in the repository specifies a small module, src/ranges.js, whose functions are stubs. Implement them exactly as the spec says.",
      "The spec is short and every sentence in it is tested, with many inputs you haven't seen: read it closely, the edge cases above all.",
    ].join(" ");

    const prelude = js`const S = ${JSON.stringify(s)};
${source(s, "oracle")}
/** Random sets as text, written every way the spec allows, and as arrays. */
const maker = (seed) => {
  const next = rng(seed);
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const space = () => (next() < 0.25 ? " ".repeat(int(1, 2)) : next() < 0.05 ? "\t" : "");
  const range = () => {
    if (S.unbounded && next() < 0.08) return next() < 0.5 ? { lo: -Infinity, hi: int(-30, 30) } : { lo: int(-30, 30), hi: Infinity };
    const lo = int(-40, 40);
    return { lo, hi: lo + (next() < 0.12 ? -int(1, 3) : int(0, 9)) };
  };
  const written = (r) => {
    if (S.bare && r.lo === r.hi && next() < 0.5) return String(r.lo);
    const openLo = r.lo === -Infinity || (S.open && next() < 0.4);
    const openHi = r.hi === Infinity || (S.open && next() < 0.4);
    const lo = r.lo === -Infinity ? "-" + S.inf : String(openLo ? r.lo - 1 : r.lo);
    const hi = r.hi === Infinity ? S.inf : String(openHi ? r.hi + 1 : r.hi);
    return (openLo ? "(" : "[") + space() + lo + space() + S.inner + space() + hi + space() + (openHi ? ")" : "]");
  };
  const set = (n = int(0, 6)) => Array.from({ length: n }, range);
  const text = (ranges) => space() + ranges.map(written).join(space() + S.outer + space()) + space();
  return { next, int, set, text };
};
const agree = (lib, text) => {
  let want;
  let threw = null;
  try {
    want = oracle.parse(text);
  } catch (error) {
    threw = error;
  }
  if (threw) {
    let got = null;
    try {
      lib.parse(text);
    } catch (error) {
      got = error;
    }
    assert.ok(got, "should refuse " + JSON.stringify(text));
    if (S.positions) {
      assert.ok(got instanceof SyntaxError, "not a SyntaxError for " + JSON.stringify(text));
      assert.equal(got.position, threw.position, "position for " + JSON.stringify(text));
    }
    return;
  }
  assert.deepEqual(lib.parse(text), want, "parse(" + JSON.stringify(text) + ")");
  assert.equal(lib.format(want), oracle.format(want), "format of " + JSON.stringify(text));
};
const lib = async () => {
  testsIntact();
  return load("src/ranges.js");
};
const EXAMPLES = ${JSON.stringify(examples.map(([text]) => text))};
const BAD = ${JSON.stringify(bad)};
`;

    const checks: Check[] = [
      {
        key: "parses_and_prints",
        what: "ranges apart from each other parse, print and parse again",
        body: js`    const m = await lib();
    for (const text of EXAMPLES) agree(m, text);
    const make = maker(301);
    for (let i = 0; i < 300; i++) {
      // Ranges that neither overlap nor touch, written closed.
      const ranges = [];
      let at = make.int(-60, 0);
      for (let k = make.int(0, 5); k > 0; k--) {
        const hi = at + make.int(1, 9);
        ranges.push({ lo: at, hi });
        at = hi + make.int(2, 9);
      }
      const text = ranges.map((r) => "[" + r.lo + S.inner + r.hi + "]").join(S.outer);
      assert.deepEqual(m.parse(text), ranges, text);
      assert.equal(m.format(ranges), oracle.format(ranges));
      assert.deepEqual(m.parse(m.format(ranges)), ranges);
    }`,
      },
      {
        key: "merges",
        what: "what overlaps or touches is one range; empty ranges vanish; order doesn't matter",
        body: js`    const m = await lib();
    assert.deepEqual(m.normalize([{ lo: 4, hi: 6 }, { lo: 1, hi: 3 }]), [{ lo: 1, hi: 6 }]);
    assert.deepEqual(m.normalize([{ lo: 1, hi: 3 }, { lo: 5, hi: 6 }]), [{ lo: 1, hi: 3 }, { lo: 5, hi: 6 }]);
    assert.deepEqual(m.normalize([{ lo: 5, hi: 2 }]), []);
    assert.deepEqual(m.normalize([{ lo: 1, hi: 9 }, { lo: 3, hi: 4 }, { lo: 9, hi: 9 }, { lo: 10, hi: 10 }]), [{ lo: 1, hi: 10 }]);
    const given = [{ lo: 4, hi: 6 }, { lo: 1, hi: 3 }];
    m.normalize(given);
    assert.deepEqual(given, [{ lo: 4, hi: 6 }, { lo: 1, hi: 3 }], "normalize changed what it was given");
    const make = maker(302);
    for (let i = 0; i < 400; i++) {
      const ranges = make.set();
      assert.deepEqual(m.normalize(ranges), oracle.normalize(ranges), JSON.stringify(ranges));
      assert.equal(m.format(ranges), oracle.format(ranges), JSON.stringify(ranges));
    }`,
      },
      {
        key: "whitespace_and_empty",
        what: "whitespace between tokens, and the empty set",
        body: js`    const m = await lib();
    for (const text of ["", "   ", "\t\n"]) assert.deepEqual(m.parse(text), []);
    assert.equal(m.format([]), "");
    assert.equal(m.format([{ lo: 3, hi: 1 }]), "");
    assert.deepEqual(m.parse(" [ 1 " + S.inner + " 3 ] " + S.outer + "\n[ -7" + S.inner + "-5 ]"), [{ lo: -7, hi: -5 }, { lo: 1, hi: 3 }]);
    assert.deepEqual(m.parse("[-0" + S.inner + "0]"), [{ lo: 0, hi: 0 }]);
    assert.ok(Object.is(m.parse("[-0" + S.inner + "0]")[0].lo, 0), "-0 is 0");
    assert.throws(() => m.parse("[- 5" + S.inner + "9]"));`,
      },
      {
        key: "rejects_bad_text",
        what: "what isn't ranges is a syntax error",
        body: js`    const m = await lib();
    // Refusing everything isn't refusing what's wrong: what is right has to be read.
    for (const text of EXAMPLES) agree(m, text);
    for (const text of BAD) agree(m, text);
    for (const text of ["[1" + S.inner + "2]]", "[[1" + S.inner + "2]", "[+1" + S.inner + "2]", "[1e2" + S.inner + "200]", "[" + S.inner + "2]", "[1" + S.inner + "]", "]1" + S.inner + "2[", "1" + S.inner + "2", S.outer, "[1" + S.inner + "2] x"]) agree(m, text);`,
      },
      {
        key: "random_agrees",
        what: "any text: the same set, the same print, the same refusals",
        body: js`    const m = await lib();
    const make = maker(305);
    for (let i = 0; i < 1500; i++) {
      const text = make.text(make.set());
      agree(m, text);
      // The same text with a character lost, doubled or swapped for another: refused, or read, exactly as specified.
      if (text.length) {
        const at = make.int(0, text.length - 1);
        const roll = make.next();
        const other = "[]()-0123456789., ;|+*x"[make.int(0, 22)];
        agree(m, roll < 0.34 ? text.slice(0, at) + text.slice(at + 1) : roll < 0.67 ? text.slice(0, at) + text[at] + text.slice(at) : text.slice(0, at) + other + text.slice(at + 1));
      }
    }`,
      },
    ];
    if (s.open) {
      checks.push({
        key: "open_ends",
        what: "a round bracket leaves its end out, over the integers",
        body: js`    const m = await lib();
    assert.deepEqual(m.parse("(2" + S.inner + "6)"), [{ lo: 3, hi: 5 }]);
    assert.deepEqual(m.parse("(3" + S.inner + "4)"), []);
    assert.deepEqual(m.parse("(3" + S.inner + "3)"), []);
    assert.deepEqual(m.parse("(3" + S.inner + "5]" + S.outer + "[6" + S.inner + "9)"), [{ lo: 4, hi: 8 }]);
    assert.deepEqual(m.parse("[1" + S.inner + "3)" + S.outer + "(3" + S.inner + "6]"), [{ lo: 1, hi: 2 }, { lo: 4, hi: 6 }]);
    assert.deepEqual(m.parse("(-5" + S.inner + "-2)"), [{ lo: -4, hi: -3 }]);`,
      });
      checks.push({
        key: "bare_integers",
        what: "a bare integer is the range holding it, read and written",
        body: js`    const m = await lib();
    assert.deepEqual(m.parse("7"), [{ lo: 7, hi: 7 }]);
    assert.deepEqual(m.parse("-3" + S.outer + "-2" + S.outer + "5"), [{ lo: -3, hi: -2 }, { lo: 5, hi: 5 }]);
    assert.equal(m.format([{ lo: 7, hi: 7 }, { lo: -3, hi: -3 }]), "-3" + S.outer + " 7");
    assert.equal(m.format([{ lo: 7, hi: 8 }]), oracle.format([{ lo: 7, hi: 8 }]));
    assert.throws(() => m.parse("7 8"));
    assert.throws(() => m.parse("7" + S.inner + "8"));`,
      });
    }
    if (s.unbounded) {
      checks.push({
        key: "unbounded_ends",
        what: "unbounded ends: read, joined, written, and refused with a square bracket",
        body: js`    const m = await lib();
    const lowText = "(-" + S.inf + S.inner + "5]";
    const highText = "[5" + S.inner + S.inf + ")";
    assert.deepEqual(m.parse(lowText), [{ lo: -Infinity, hi: 5 }]);
    assert.deepEqual(m.parse(highText), [{ lo: 5, hi: Infinity }]);
    assert.deepEqual(m.parse(lowText + S.outer + "[6" + S.inner + S.inf + ")"), [{ lo: -Infinity, hi: Infinity }]);
    assert.deepEqual(m.parse("(-" + S.inf + S.inner + "5)"), [{ lo: -Infinity, hi: 4 }]);
    assert.deepEqual(m.parse("(5" + S.inner + S.inf + ")"), [{ lo: 6, hi: Infinity }]);
    for (const set of [[{ lo: -Infinity, hi: 5 }], [{ lo: 5, hi: Infinity }], [{ lo: -Infinity, hi: Infinity }], [{ lo: -Infinity, hi: 2 }, { lo: 4, hi: Infinity }]]) {
      assert.equal(m.format(set), oracle.format(set));
      assert.deepEqual(m.parse(m.format(set)), set);
    }
    for (const text of ["[-" + S.inf + S.inner + "5]", "[5" + S.inner + S.inf + "]", "(" + S.inf + S.inner + "5)", "(5" + S.inner + "-" + S.inf + ")", S.inf, "-" + S.inf]) agree(m, text);`,
      });
      checks.push({
        key: "subtracts",
        what: "what of one set isn't in another",
        body: js`    const m = await lib();
    assert.deepEqual(m.subtract([{ lo: 1, hi: 10 }], [{ lo: 4, hi: 6 }]), [{ lo: 1, hi: 3 }, { lo: 7, hi: 10 }]);
    assert.deepEqual(m.subtract([{ lo: 1, hi: 10 }], [{ lo: 1, hi: 10 }]), []);
    assert.deepEqual(m.subtract([{ lo: -Infinity, hi: Infinity }], [{ lo: 0, hi: 0 }]), [{ lo: -Infinity, hi: -1 }, { lo: 1, hi: Infinity }]);
    assert.deepEqual(m.subtract([{ lo: 1, hi: 3 }, { lo: 4, hi: 9 }], []), [{ lo: 1, hi: 9 }]);
    const make = maker(309);
    for (let i = 0; i < 600; i++) {
      const a = make.set();
      const b = make.set();
      assert.deepEqual(m.subtract(a, b), oracle.subtract(a, b), JSON.stringify([a, b]));
    }`,
      });
    }
    if (s.positions) {
      checks.push({
        key: "membership_right",
        what: "whether an integer is in a set",
        body: js`    const m = await lib();
    const make = maker(311);
    for (let i = 0; i < 300; i++) {
      const set = make.set();
      for (let n = -45; n <= 55; n += 3) assert.equal(m.contains(set, n), oracle.contains(set, n), JSON.stringify([set, n]));
    }
    assert.equal(m.contains([{ lo: 1, hi: 3 }], 2.5), false);
    assert.equal(m.contains([{ lo: 1, hi: 3 }], "2"), false);
    assert.equal(m.contains([{ lo: -Infinity, hi: Infinity }], NaN), false);`,
      });
      checks.push({
        key: "error_positions",
        what: "a syntax error says where the text stopped being the beginning of a valid one",
        body: js`    const m = await lib();
    const where = (text) => {
      try {
        m.parse(text);
      } catch (error) {
        assert.ok(error instanceof SyntaxError, "not a SyntaxError for " + JSON.stringify(text));
        return error.position;
      }
      assert.fail("should refuse " + JSON.stringify(text));
    };
    const want = (text) => {
      try {
        oracle.parse(text);
      } catch (error) {
        return error.position;
      }
      assert.fail("the oracle reads " + JSON.stringify(text));
    };
    for (const text of ["[1" + S.inner + "2", "[1.5" + S.inner + "3]", "[-" + S.inf + S.inner + "3]", "[3" + S.inner + S.inf + "]", "[1" + S.inner + "2]" + S.outer, S.outer + "[1" + S.inner + "2]", "[1" + S.inner + "2] [3" + S.inner + "4]", "[- 1" + S.inner + "2]", "(" + S.inf + S.inner + "3)", "(1" + S.inner + "-" + S.inf + ")", "[1" + S.inner + "2]x", "", "[", "[1", "(-" + S.inf.slice(0, 1)]) {
      if (text === "") continue;
      assert.equal(where(text), want(text), "position for " + JSON.stringify(text));
    }`,
      });
    }

    const done = { outcome: "done" as const, why: "Implemented as SPEC.md says; the tests pass.", evidence: ["SPEC.md", "test/ranges.test.js"] };
    return {
      statement,
      files: { "package.json": packageJson("integer-ranges"), "SPEC.md": spec, "src/ranges.js": stubs, "test/ranges.test.js": tests },
      gates: ["cd /work/repo && bun test"],
      prelude,
      checks,
      reference: { name: "the spec, to the letter", files: { "src/ranges.js": source(s, "module") }, result: done },
      wrong: [{ name: "ranges as real intervals: what merely touches isn't joined", files: { "src/ranges.js": source({ ...s, adjacency: false }, "module") }, result: done }],
      maxSteps: level >= 3 ? 40 : 30,
    };
  },
};
