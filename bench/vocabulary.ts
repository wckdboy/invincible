// The vocabulary check: `bun bench/vocabulary.ts` (and `bun run check`, which runs it). Exits 1 on a word of the old theme.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Invincible keeps none of the words of the theme it was carried from (docs/ARCHITECTURE.md §10, where they are named
 * once): its agents are workers, not characters. This finds any of them, in any tracked file, in any case and inside
 * any identifier (a camelCase, snake_case or kebab-case part is a word of its own), and in any file's name, and says
 * where.
 *
 * Not looked at: that one section of docs/ARCHITECTURE.md, the licence and the notice, and the importer (which reads
 * the old system's home, in its words) under IMPORTER, with its tests under IMPORTER_TESTS. A file that isn't text
 * (it holds a NUL) is skipped too.
 *
 * The words are written here backwards, so this file says none of them itself.
 */

const backwards = (word: string): string => [...word].reverse().join("");

/** Words of the theme, matched as a whole word or identifier part, with an s, es, ed or ing after them. */
export const STEMS: readonly string[] = ["thgink", "elbatdnuor", "eriuqs", "tseuq", "htao", "lairt", "liarg", "egeil"].map(backwards);
/** Names, matched as a whole word or identifier part (and their possessive). */
export const NAMES: readonly string[] = [
  "dahalag", "tolemac", "rubilacxe", "ruhtra", "nairuhtra", "nilrem", "tolecnal", "ereveniug", "niawag", "lavicrep",
  "lavecrep", "erevideb", "hterag", "sirehag", "niavarga", "derdrom", "natsirt", "martsirt", "edlosi", "tluesi",
  "ettenyl", "sedemalap", "eronillep", "rehtu", "eumin", "anagrom", "rotce", "srob", "yak", "karomal",
].map(backwards);

const STEM_PART = new RegExp(`^(${STEMS.join("|")})(s|es|ed|ing)?$`);
const NAME_PART = new Set(NAMES);
/** The theme's one word written as two, with a space, a hyphen or an underscore between them. */
const PHRASES = [new RegExp(`\\b${backwards("dnuor")}[ _-]+${backwards("elbat")}s?\\b`, "gi")];
/** The title before a name. */
const TITLE = new RegExp(`\\b[Ss]${backwards("ri")}\\s+[A-Z][a-z]`, "g");

/** Where the importer lives (docs/PLAN.md, Phase 4), and its tests: it reads the old system's home, so they may say its words. */
export const IMPORTER = "packages/node/src/import/";
export const IMPORTER_TESTS = "packages/node/test/import/";
const EXEMPT = new Set(["LICENSE", "NOTICE"]);
const exempt = (path: string): boolean => EXEMPT.has(path) || path.startsWith(IMPORTER) || path.startsWith(IMPORTER_TESTS);
/** docs/ARCHITECTURE.md's own section on where Invincible comes from: its heading's number. */
const OWN_SECTION = /^## 10\. /;

export interface Finding {
  path: string;
  line: number;
  word: string;
  text: string;
}

/** The parts of a line a word can be: runs of letters, split again where a lowercase letter meets a capital. */
function parts(line: string): { part: string; at: number }[] {
  const out: { part: string; at: number }[] = [];
  for (const run of line.matchAll(/[A-Za-z]+/g)) {
    for (const piece of run[0].matchAll(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g)) out.push({ part: piece[0], at: run.index! + piece.index! });
  }
  return out;
}

/** The theme's words on one line, each with where it starts. */
export function wordsIn(line: string): string[] {
  const found: string[] = [];
  for (const { part } of parts(line)) {
    const word = part.toLowerCase();
    if (STEM_PART.test(word) || NAME_PART.has(word) || (word.endsWith("s") && NAME_PART.has(word.slice(0, -1)))) found.push(part);
  }
  for (const phrase of PHRASES) for (const m of line.matchAll(phrase)) found.push(m[0]);
  for (const m of line.matchAll(TITLE)) found.push(m[0]);
  return found;
}

/** Whether a tracked file is looked at, and which of its lines are (docs/ARCHITECTURE.md: all but its own section). */
export function linesToRead(path: string, text: string): { line: number; text: string }[] {
  if (exempt(path)) return [];
  const lines = text.split("\n");
  const out: { line: number; text: string }[] = [];
  let inOwnSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (path === "docs/ARCHITECTURE.md" && line.startsWith("## ")) inOwnSection = OWN_SECTION.test(line);
    if (!inOwnSection) out.push({ line: i + 1, text: line });
  }
  return out;
}

/** Every word of the theme in these files, and in their names (a finding at line 0 is in the path). */
export function findOldWords(files: readonly { path: string; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!exempt(file.path)) for (const word of wordsIn(file.path)) findings.push({ path: file.path, line: 0, word, text: file.path });
    if (file.text.includes("\0")) continue;
    for (const { line, text } of linesToRead(file.path, file.text)) {
      for (const word of wordsIn(text)) findings.push({ path: file.path, line, word, text: text.trim().slice(0, 160) });
    }
  }
  return findings;
}

/** The repository's tracked files, as text. */
export function trackedFiles(root: string): { path: string; text: string }[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  return listed.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .flatMap((path) => {
      try {
        return [{ path, text: readFileSync(join(root, path), "utf8") }];
      } catch {
        return []; // listed but not on disk (deleted in the working tree): nothing to read
      }
    });
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = trackedFiles(root);
  const findings = findOldWords(files);
  for (const f of findings) console.log(`${f.path}:${f.line}: ${f.word}  ${f.text}`);
  if (findings.length) {
    console.log(`\nThe vocabulary check: ${findings.length} word${findings.length === 1 ? "" : "s"} of the old theme in ${new Set(findings.map((f) => f.path)).size} file(s). docs/ARCHITECTURE.md §10 names them once; nothing else does.`);
    process.exit(1);
  }
  console.log(`The vocabulary check: none of the old theme's words in ${files.length} tracked files.`);
}
