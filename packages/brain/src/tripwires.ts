import type { NamedCheck, NamedRule, NamedTell, RuleDoes } from "@galahad/core";
import { commandWords, readOf } from "./shell-paths.ts";

/*
 * Your rules (core's rules.ts) against a command: tripwires before it runs, checks after. A rule's globs are matched
 * against the command's words (shell-paths' commandWords) and its piece of text against the whole command; the quest
 * loop halts the work or refuses the command, or runs your checks once it has run, on what this says. Deterministic:
 * no model is asked, and nothing is run here.
 *
 * Globs, never regular expressions: a glob becomes a short list of steps, and a word is read once, left to right,
 * keeping every place in the glob it could have reached by then (an automaton, not backtracking). A check costs at
 * most the glob's length times the word's, whatever the glob, so no rule can make one hang.
 */

/** One step of a glob: a character as itself, `?`, `*`, `**`, or `**` with a `/` after it (no folder, or any folders). */
type Step = { kind: "char"; char: string } | { kind: "one" } | { kind: "star" } | { kind: "any" } | { kind: "dirs" };

export interface Glob {
  steps: Step[];
  /** It starts with `/`: matched against a whole word only. */
  anchored: boolean;
  /** It ends with `/**`: the folder itself, or anything in it. */
  rest: boolean;
}

export function compileGlob(glob: string): Glob {
  const anchored = glob.startsWith("/");
  const rest = glob.length > 3 && glob.endsWith("/**");
  const text = rest ? glob.slice(0, -3) : glob;
  const steps: Step[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "*" && text[i + 1] === "*") {
      // (Three stars or more are two.)
      let end = i + 2;
      while (text[end] === "*") end++;
      if (text[end] === "/") {
        steps.push({ kind: "dirs" });
        i = end;
      } else {
        steps.push({ kind: "any" });
        i = end - 1;
      }
    } else if (char === "*") steps.push({ kind: "star" });
    else if (char === "?") steps.push({ kind: "one" });
    else steps.push({ kind: "char", char });
  }
  return { steps, anchored, rest };
}

/** Whether a word matches a glob: the whole word, or (unless the glob starts with `/`) what follows any `/` in it. */
export function globMatches(glob: Glob, word: string): boolean {
  const { steps, anchored, rest } = glob;
  const n = steps.length;
  let now = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  for (let at = 0; ; at++) {
    if (at === 0 || (!anchored && word[at - 1] === "/")) now[0] = 1;
    // A star, `**` and `**/` may match nothing: the step after one may begin here too.
    for (let i = 0; i < n; i++) if (now[i] && steps[i]!.kind !== "char" && steps[i]!.kind !== "one") now[i + 1] = 1;
    if (now[n] && (at === word.length || (rest && word[at] === "/"))) return true;
    if (at === word.length) return false;
    const char = word[at]!;
    next.fill(0);
    for (let i = 0; i < n; i++) {
      if (!now[i]) continue;
      const step = steps[i]!;
      if (step.kind === "char") {
        if (step.char === char) next[i + 1] = 1;
      } else if (step.kind === "one") {
        if (char !== "/") next[i + 1] = 1;
      } else if (step.kind === "star") {
        if (char !== "/") next[i] = 1;
      } else if (step.kind === "any") next[i] = 1;
      else {
        next[i] = 1;
        if (char === "/") next[i + 1] = 1;
      }
    }
    [now, next] = [next, now];
  }
}

/** A command a rule of yours stopped: which rule, what it does, and why, in words (the word and its glob, the text it holds). */
export interface Trip {
  rule: string;
  does: RuleDoes;
  why: string;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** Halts first, then refusals, each by name: whatever order the rules come in, a command trips the same one. */
const first = (a: NamedRule & { on: "command" }, b: NamedRule & { on: "command" }): number => (a.does !== b.does ? (a.does === "halt" ? -1 : 1) : byName(a, b));

const shown = (word: string): string => (word.length > 80 ? `${word.slice(0, 79)}…` : word);

/** Why a rule matches a command, in words (the word and its glob, the text it holds); null when it doesn't. `words`: the command's, read once. */
function matchOf(rule: { words: readonly string[]; contains?: string }, command: string, words: () => string[]): string | null {
  if (rule.contains !== undefined && !command.includes(rule.contains)) return null;
  let matched = "";
  if (rule.words.length) {
    const globs = rule.words.map((glob) => ({ glob, compiled: compileGlob(glob) }));
    for (const word of words()) {
      const hit = globs.find((g) => globMatches(g.compiled, word));
      if (!hit) continue;
      matched = `the word \`${shown(word)}\` matches \`${hit.glob}\``;
      break;
    }
    if (!matched) return null;
  }
  const held = rule.contains !== undefined ? `it holds \`${rule.contains}\`` : "";
  return [matched, held].filter(Boolean).join(", and ");
}

const wordsOf = (command: string): (() => string[]) => {
  let words: string[] | null = null;
  return () => (words ??= commandWords(command));
};

/** The tripwire a command trips, if any. (A check is no tripwire: it runs after a command, never stops one.) */
export function tripOf(rules: readonly NamedRule[], command: string): Trip | null {
  const words = wordsOf(command);
  for (const rule of rules.filter((r): r is NamedRule & { on: "command" } => r.on === "command").sort(first)) {
    const why = matchOf(rule, command, words);
    if (why !== null) return { rule: rule.name, does: rule.does, why };
  }
  return null;
}

/**
 * The checks a command calls for once it has run, by name: each is run once, whatever else matched. A command that only
 * shows a file (`cat`, `head`, `sed -n …p`: shell-paths' readOf) calls for none: it changed nothing.
 */
export function checksAfter(rules: readonly NamedRule[], command: string): NamedCheck[] {
  if (readOf(command) !== null) return [];
  const words = wordsOf(command);
  return rules.filter((r): r is NamedCheck => r.on === "after" && r.does === "check" && matchOf(r, command, words) !== null).sort(byName);
}

/**
 * The rules that tell you a command has run, by name, however it ended: what you asked to hear of, the moment it runs.
 * Unlike a check, a command that only shows a file is told of too (you may want to know what was read).
 */
export function tellsAfter(rules: readonly NamedRule[], command: string): NamedTell[] {
  const words = wordsOf(command);
  return rules.filter((r): r is NamedTell => r.on === "after" && r.does === "tell" && matchOf(r, command, words) !== null).sort(byName);
}
