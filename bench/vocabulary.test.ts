import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOldWords, IMPORTER, NAMES, STEMS, trackedFiles, wordsIn } from "./vocabulary.ts";

/*
 * The vocabulary check (vocabulary.ts) catches every word of the old theme however it is written, lets ordinary
 * words that merely contain one through, reads all of docs/ARCHITECTURE.md but its own section, and finds nothing in
 * this repository. The words are built here from the check's own list, so this file says none of them either.
 */

const cap = (word: string): string => word[0]!.toUpperCase() + word.slice(1);
const one = (path: string, text: string) => findOldWords([{ path, text }]);

describe("every word of the theme is caught", () => {
  test("each word, in every case and inside identifiers, paths and kinds", () => {
    expect(STEMS.length).toBe(8);
    expect(NAMES.length).toBeGreaterThanOrEqual(30);
    for (const word of [...STEMS, ...NAMES]) {
      const forms = [
        word, cap(word), word.toUpperCase(), // as written in prose, at a sentence's start, as a constant
        `the ${word}'s`, `my${cap(word)}Field`, `${word.toUpperCase()}_HOME`, `${word}_id`, // possessive, camelCase, SCREAMING and snake case
        `x-${word}-y`, `/api/${word}/1`, `"${word}.started"`, `${cap(word)}Store`, // kebab case, a route, an event kind, a class
      ];
      for (const form of forms) expect([form, wordsIn(form).length > 0]).toEqual([form, true]);
    }
  });

  test("a stem takes its plural and its other endings", () => {
    for (const stem of STEMS) for (const ending of ["s", "ed", "ing"]) expect([stem + ending, wordsIn(stem + ending).length]).toEqual([stem + ending, 1]);
  });

  test("written apart, as two words, and as a title before a name", () => {
    const backwards = (word: string): string => [...word].reverse().join("");
    const round = backwards("dnuor");
    const table = backwards("elbat");
    for (const apart of [`the ${round} ${table}`, `${cap(round)} ${cap(table)}`, `${round}-${table}`]) expect([apart, wordsIn(apart).length > 0]).toEqual([apart, true]);
    const title = backwards("riS");
    for (const titled of [`${title} Ada`, `${title.toLowerCase()} Bob`]) expect([titled, wordsIn(titled).length]).toEqual([titled, 1]);
  });

  test("ordinary words that hold one inside them stay ordinary", () => {
    for (const word of ["request", "requests", "question", "conquest", "industrial", "loathe", "okay", "Vector", "director", "sirloin", "Sirius", "desire", "oathbound"]) {
      expect([word, wordsIn(word)]).toEqual([word, []]);
    }
    // (A part is a word of its own only where case or a separator says so: "oathbound" is one word, never two.)
    expect(wordsIn("sir, yes sir")).toEqual([]);
  });
});

describe("what it reads", () => {
  const first = NAMES[0]!;
  test("docs/ARCHITECTURE.md, all but its own section on where Invincible comes from", () => {
    const doc = ["# Invincible", `## 9. Packages`, `no ${first} here`, "## 10. From where it comes", `${cap(first)} is named here`, "## 11. Later", `and ${first} again`].join("\n");
    expect(one("docs/ARCHITECTURE.md", doc).map((f) => f.line)).toEqual([3, 7]);
    // The same words in any other file are found on every line.
    expect(one("docs/PLAN.md", doc).map((f) => f.line)).toEqual([3, 5, 7]);
  });

  test("not the licence, the notice or the importer; nor a file that isn't text", () => {
    for (const path of ["LICENSE", "NOTICE", `${IMPORTER}home.ts`]) expect(one(path, `${first} ${first}`)).toEqual([]);
    expect(one("assets/icon.png", `\u0000PNG ${first}`)).toEqual([]);
    expect(one("README.md", `${first}`)).toEqual([{ path: "README.md", line: 1, word: first, text: first }]);
  });
});

test("nothing in this repository says any of them", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = trackedFiles(root);
  expect(files.length).toBeGreaterThan(500);
  expect(findOldWords(files).map((f) => `${f.path}:${f.line}: ${f.word}`)).toEqual([]);
});
