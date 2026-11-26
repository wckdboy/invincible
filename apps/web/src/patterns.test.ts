import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * A form field's `pattern` is compiled by the browser with the v flag. One that isn't valid there is not an
 * error anyone sees: the field is simply never checked, and the console says why. Found in a real browser
 * (Team's handle field, 13 November 2026); held here for every pattern the app carries.
 */

const SRC = import.meta.dir;
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : []));
}

test("every pattern a form field carries is one a browser can compile", () => {
  const found: { file: string; pattern: string }[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    // A pattern written where the field is made, and one named so it can be shared.
    for (const match of text.matchAll(/\bpattern: "((?:[^"\\]|\\.)*)"|_PATTERN = "((?:[^"\\]|\\.)*)"/g)) found.push({ file: file.slice(SRC.length + 1), pattern: JSON.parse(`"${match[1] ?? match[2]}"`) as string });
  }
  expect(found.length).toBeGreaterThanOrEqual(2);
  for (const { file, pattern } of found) {
    let problem: string | null = null;
    try { new RegExp(`^(?:${pattern})$`, "v"); } catch (error) { problem = String((error as Error).message); }
    expect([file, pattern, problem]).toEqual([file, pattern, null]);
  }
});

/*
 * A field that turns spelling off holds a name, a code or an address. iOS still offers and makes its corrections there
 * (and can capitalise a word it knows) unless autocorrect is off as well: seen in the iOS 26.1 simulator, with word
 * suggestions over a loop's name. Held here for every such field the app makes.
 */
test("every field that turns spelling off turns autocorrect off too", () => {
  const missing: string[] = [];
  let fields = 0;
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/h\("(input|textarea)", \{/g)) {
      // The field's attributes: from its opening brace to the one that closes it.
      let depth = 0;
      let end = match.index! + match[0].length - 1;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
      }
      const attrs = text.slice(match.index!, end + 1);
      if (!/spellcheck: (false|"false")/.test(attrs)) continue;
      fields++;
      if (!/autocorrect: "off"/.test(attrs)) missing.push(`${file.slice(SRC.length + 1)}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(fields).toBeGreaterThan(20);
  expect(missing).toEqual([]);
});
