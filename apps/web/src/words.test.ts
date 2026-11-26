import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * The owner's words (14 November 2026): the place is the Roundtable and its members are knights; Galahad is his
 * primary knight, and the others are not beneath him. "Don't call it Hivemind anywhere." So no file of the app says
 * either old word, in what it shows or in how it explains itself, with one exception: the old name stays a word the
 * search finds the Roundtable by, as `galahad squires` still works at a terminal. Addresses and file names (#/team,
 * /api/team, team.ts) are the code's own and unchanged.
 */
const app = join(import.meta.dir, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|html|webmanifest)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
const sources = [...files(join(app, "src")), ...files(join(app, "design"))].map((path) => ({ path: relative(app, path), text: readFileSync(path, "utf8") }));

describe("the app's words", () => {
  test("it reads the files it is about", () => {
    expect(sources.map((source) => source.path)).toContain("src/views/roster.ts");
    expect(sources.map((source) => source.path)).toContain("design/gallery.ts");
  });

  test("nothing in it says hivemind", () => {
    expect(sources.filter((source) => /hive ?mind/i.test(source.text)).map((source) => source.path)).toEqual([]);
  });

  test("nothing in it says squire, but for the search word that finds the Roundtable by its old name", () => {
    const said = sources.flatMap((source) => [...source.text.matchAll(/^.*squire.*$/gim)].map((line) => `${source.path}: ${line[0].trim()}`));
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith("src/lib/nav.ts: ");
    expect(said[0]).toContain('label: "Roundtable"');
    expect(said[0]).toContain('"squires"');
  });
});
