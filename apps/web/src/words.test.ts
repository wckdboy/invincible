import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * The owner's words (14 November 2026): the others are not beneath the primary agent, and "Don't call it Hivemind
 * anywhere." So no file of the app says it, in what it shows or in how it explains itself. Addresses and file names
 * (#/team, /api/team, team.ts) are the code's own and unchanged.
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

  // (The old theme's words, everywhere in the repository and not just here, are bench/vocabulary.ts's to find.)
});
