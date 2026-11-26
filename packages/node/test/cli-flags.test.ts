import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The CLI reads its options with node's parseArgs, not strictly: an option it doesn't declare is taken for a bare
 * switch, and the word after it for a positional. So `roundtable provision bob --network gateway`, `network` never
 * declared, made bob's VM online, with the internet, not the gateway-only VM asked for (found on the Mac mini, 17
 * November 2026). Every option a command reads must be declared, with its type, where the CLI parses them.
 */

const SRC = join(import.meta.dir, "../src");

function declared(): Set<string> {
  const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
  const start = cli.indexOf("const parsed = parseArgs({");
  const block = cli.slice(start, cli.indexOf("});", start));
  return new Set([...block.matchAll(/^\s+"?([a-z][a-z0-9-]*)"?: \{ type: "(?:string|boolean)"/gm)].map((m) => m[1]!));
}

function read(): Map<string, string[]> {
  const files = ["cli.ts", ...readdirSync(SRC).filter((f) => f.endsWith("-cli.ts"))];
  const found = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/\b(?:str|string)\("([a-z][a-z0-9-]*)"\)|flags\["([a-z][a-z0-9-]*)"\]|flags\.([a-z][a-zA-Z0-9]*)\b/g)) {
      const key = m[1] ?? m[2] ?? m[3]!;
      found.set(key, [...(found.get(key) ?? []), file]);
    }
  }
  return found;
}

describe("the CLI's options", () => {
  test("every option a command reads is declared where they are parsed, so its value is never taken for a word", () => {
    const options = declared();
    expect(options.size).toBeGreaterThan(100);
    const undeclared = [...read()].filter(([key]) => !options.has(key) && key !== "help").map(([key, files]) => `--${key} (${[...new Set(files)].join(", ")})`);
    expect(undeclared).toEqual([]);
  });
});
