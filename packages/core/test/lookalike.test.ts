import { describe, expect, test } from "bun:test";
import { hasUndrawn, LOOKALIKES, oneScript, readAlike, skeleton } from "../src/index.ts";

/*
 * Names that read alike (lookalike.ts). Every look-alike below is written by its code point, so this file
 * shows what it tests: a Cyrillic or Greek letter typed here would be indistinguishable from the Latin one.
 */

const cp = (...points: number[]) => String.fromCodePoint(...points);
const CYRILLIC = { a: cp(0x430), e: cp(0x435), o: cp(0x43e), c: cp(0x441), y: cp(0x443), s: cp(0x455), we: cp(0x51d), pe: cp(0x43f), ghe: cp(0x433), te: cp(0x442), em: cp(0x43c), A: cp(0x410), S: cp(0x405), Y: cp(0x4ae), T: cp(0x422), E: cp(0x415), M: cp(0x41c), de: cp(0x434) };
const GREEK = { gamma: cp(0x3b3), omicron: cp(0x3bf), upsilon: cp(0x3c5), Upsilon: cp(0x3a5), Omicron: cp(0x39f) };
const CHEROKEE_GALAHAD = [0x13c0, 0x13aa, 0x13de, 0x13aa, 0x13bb, 0x13aa, 0x13a0];

describe("names that would be taken for one another", () => {
  test("the same word reads the same however it is spelled: other scripts in either case, small capitals, 1 and I for l, 0 for o, rn for m, cl for d", () => {
    const galahad = [
      "Galahad", "GALAHAD", "galahad",
      `G${CYRILLIC.a}lahad`, `G${CYRILLIC.A}LAHAD`, // one Cyrillic letter, among small letters and among capitals
      "GaIahad", "Ga1ahad", "Galahacl", // capital i, the digit one, c and l for a d
      cp(0x262, 0x1d00, 0x29f, 0x1d00, 0x29c, 0x1d00, 0x1d05), // small capitals
      cp(...CHEROKEE_GALAHAD), cp(...CHEROKEE_GALAHAD.map((point) => point - 0x13a0 + 0xab70)), // Cherokee letters drawn like G A L A H A D, and their small forms
      `${cp(0xa7ac)}alahad`, `${cp(0x1e4)}alahad`, `Ga${cp(0x19a)}ahad`, `Galaha${cp(0x257)}`, // script G, G with a stroke, l with a bar, d with a hook
      "G\u00e1lahad", `Ga${cp(0x142)}ahad`, "Gala-had", "G'alahad", `Galahad${cp(0x2bc)}`, `Galahad${cp(0x30fc)}`, // an accent, a stroke, a hyphen, apostrophes, a long-vowel mark
    ];
    for (const name of galahad) expect([name, readAlike(name, "galahad")]).toEqual([name, true]);
    const owner = ["owner", "OWNER", "0wner", `${CYRILLIC.o}wner`, "ovvner", "\uff4f\uff57\uff4e\uff45\uff52", `OWNE${cp(0x1a6)}`, CYRILLIC.o + CYRILLIC.we + CYRILLIC.pe + CYRILLIC.e + CYRILLIC.ghe, `own${cp(0x25b)}r`];
    for (const name of owner) expect([name, readAlike(name, "owner")]).toEqual([name, true]);
    const system = ["system", "systern", "\u017fystem", CYRILLIC.S + CYRILLIC.Y + CYRILLIC.S + CYRILLIC.T + CYRILLIC.E + CYRILLIC.M, CYRILLIC.S + CYRILLIC.y + CYRILLIC.s + CYRILLIC.te + CYRILLIC.e + CYRILLIC.em];
    for (const name of system) expect([name, readAlike(name, "system")]).toEqual([name, true]);
    const you = ["You", "YOU", `Y${CYRILLIC.o}u`, GREEK.gamma + GREEK.omicron + GREEK.upsilon, `${GREEK.Upsilon}${GREEK.Omicron}U`, `Yo${cp(0x289)}`, `yo${cp(0x28b)}`, `${cp(0x263)}ou`];
    for (const name of you) expect([name, readAlike(name, "you")]).toEqual([name, true]);
  });

  test("names that read differently stay different, in any script; a capital L is not a capital I", () => {
    const names = ["Ada", "Ida", "Lin", "Scout", "Ada-2", "Jean-Luc", "D'Arcy", "\u7814\u7a76\u54e1", "\u00c5sa", `${CYRILLIC.A}${CYRILLIC.de}${CYRILLIC.a}`, "Mona", "Nona", "Systems", "Yours", "Owen", "Galadriel"];
    for (const a of names) for (const b of names) expect([a, b, readAlike(a, b)]).toEqual([a, b, a === b]);
    for (const [a, b] of [["Lan", "Ian"], ["Lo", "Io"], ["LAN", "Ian"]] as const) expect([a, b, readAlike(a, b)]).toEqual([a, b, false]);
    // A whole word of another script that is drawn like a Latin one reads as it; so do l for I, rn for m, and case alone.
    for (const [a, b] of [[CYRILLIC.A + CYRILLIC.c + CYRILLIC.a, "Aca"], ["Rnona", "Mona"], ["llya", "Ilya"], ["lan", "Ian"], ["ILYA", "Ilya"], ["ADA", "Ada"], [`Ada${cp(0x2bc)}`, "Ada"], [`Ada${cp(0xa78c)}`, "Ada"], [`Ada${cp(0x640)}`, "Ada"]] as const) {
      expect([a, b, readAlike(a, b)]).toEqual([a, b, true]);
    }
    expect(skeleton("GaIahad")).toBe(skeleton("Galahad"));
    expect(skeleton("Lan")).not.toBe(skeleton("Ian"));
  });

  test("the table itself: each look-alike is one character outside ASCII standing for one Latin letter, and the ones spelled out here are the letters they should be", () => {
    expect(LOOKALIKES.size).toBeGreaterThan(130);
    for (const [from, to] of LOOKALIKES) {
      expect([...from]).toHaveLength(1);
      expect(from.codePointAt(0)!).toBeGreaterThan(0x7f);
      expect(to).toMatch(/^[A-Za-z]$/);
      // None is dead: each is still itself after the normalization a name goes through first.
      expect([from.codePointAt(0)!.toString(16), from.normalize("NFKC")]).toEqual([from.codePointAt(0)!.toString(16), from]);
    }
    // First and last of each run, and some in between: a pair of strings out of step would move every one of these.
    const spelled: [number, string][] = [
      [0x430, "a"], [0x43e, "o"], [0x441, "c"], [0x4cf, "l"], [0x43a, "k"], [0x433, "r"], [0x4af, "y"], // Cyrillic small
      [0x410, "A"], [0x41d, "H"], [0x420, "P"], [0x405, "S"], [0x4ae, "Y"], [0x50c, "G"], // Cyrillic capitals
      [0x3b1, "a"], [0x3bd, "v"], [0x3c2, "c"], [0x3c9, "w"], [0x3c4, "t"], [0x391, "A"], [0x397, "H"], [0x3a7, "X"], // Greek
      [0x578, "n"], [0x570, "h"], [0x54d, "U"], [0x53c, "L"], // Armenian
      [0x13a0, "D"], [0x13aa, "A"], [0x13c0, "G"], [0x13de, "L"], [0x13f4, "B"], // Cherokee
      [0x1d00, "a"], [0x262, "g"], [0x29f, "l"], [0x280, "r"], [0x1d22, "z"], // small capitals
      [0x251, "a"], [0x1c0, "l"], [0x289, "u"], [0x142, "l"], [0xf8, "o"], [0x257, "d"], // other Latin
    ];
    for (const [point, letter] of spelled) expect([point.toString(16), LOOKALIKES.get(cp(point))]).toEqual([point.toString(16), letter]);
  });
});

describe("one writing system", () => {
  test("a name in one script is one; so are Japanese and Korean names, which use several together", () => {
    for (const name of ["Scout", "Ada-2", "Jean-Luc", "D'Arcy", "\u00c5se", "\u7814\u7a76\u54e1", "\u30b3\u30fc\u30d2\u30fc", "\u3055\u304f\u3089\u82b1", "\ud55c\uad6d\uc5b4", `${CYRILLIC.A}${CYRILLIC.de}${CYRILLIC.a}`, "\u0391\u03b8\u03b7\u03bd\u03ac", "\u10d7\u10d0\u10db\u10d0\u10e0", "\u05d3\u05d5\u05d3", "7", "R2-D2"]) {
      expect([name, oneScript(name)]).toEqual([name, true]);
    }
  });

  test("letters of two scripts in one name are not, whichever scripts they are; nor is a script nothing here can vouch for", () => {
    const mixed = [`G${CYRILLIC.a}lahad`, `Y${CYRILLIC.o}u`, `${CYRILLIC.o}wner`, `${GREEK.Upsilon}${GREEK.Omicron}U`, "Ada\u7814", `${CYRILLIC.A}${GREEK.omicron}`, cp(0x10e7, 0x2c9f, 0xe1a), cp(0x10d7, 0xe1a)];
    for (const name of mixed) expect([name, oneScript(name)]).toEqual([name, false]);
    // Lisu is drawn almost wholly like Latin capitals: these four spell Galahad, you, owner and system.
    const lisu = [cp(0xa4d6, 0xa4ee, 0xa4e1, 0xa4ee, 0xa4e7, 0xa4ee, 0xa4d3), cp(0xa4ec, 0xa4f3, 0xa4f4), cp(0xa4f3, 0xa4ea, 0xa4e0, 0xa4f0, 0xa4e3), cp(0xa4e2, 0xa4ec, 0xa4e2, 0xa4d4, 0xa4f0, 0xa4df)];
    for (const name of [...lisu, cp(0x2c9f, 0x2c9f), cp(0x16a0, 0x16a2)]) expect([name, oneScript(name)]).toEqual([name, false]);
  });

  test("what is written but never drawn is found: a filler, a joiner, a tag", () => {
    for (const hidden of [0x3164, 0x200d, 0x200c, 0xad, 0xe0041, 0x115f]) expect([hidden.toString(16), hasUndrawn(`Ada${cp(hidden)}`)]).toEqual([hidden.toString(16), true]);
    for (const name of ["Ada", "\u7814\u7a76\u54e1", "D'Arcy", "\u30b3\u30fc\u30d2\u30fc"]) expect(hasUndrawn(name)).toBe(false);
  });
});
