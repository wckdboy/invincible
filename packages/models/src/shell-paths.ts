/*
 * Which file a shell command shows, and which files it changes: read conservatively from the command's words, for
 * the quest loop to tell a file's contents a later command made stale (quest.ts compact). Anything it can't read for
 * certain (a pipe into a read, a glob, a substitution) names nothing, so nothing is called stale by a guess.
 */

/** A command's words, split into its simple commands at unquoted `&&`, `||`, `;`, `|`, `&` and newlines. Each word
 * says whether any of it was unquoted dynamic shell (`$`, a glob, a backtick), which a read can't be judged by. */
interface Word { text: string; dynamic: boolean; operator?: string }

/**
 * The command without a here-document's body (its lines are data, not commands). A here-string (`<<<`) is not one.
 * `keepUnended`: a body whose end never comes keeps its lines (a `<<` inside quotes looks like one).
 */
function withoutHereDocs(command: string, keepUnended = false): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const here = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!here) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === here[2]);
    if (end === -1) {
      if (keepUnended) continue;
      break;
    }
    i = end;
  }
  return out.join("\n");
}

function segments(command: string): Word[][] {
  const all: Word[][] = [[]];
  let text = "", dynamic = false, started = false;
  const end = () => {
    if (started) all.at(-1)!.push({ text, dynamic });
    text = ""; dynamic = false; started = false;
  };
  const operator = (op: string) => { end(); all.at(-1)!.push({ text: op, dynamic: false, operator: op }); };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return [];
      text += command.slice(i + 1, close); started = true; i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length) { text += command[++j]; continue; }
        if (command[j] === "$" || command[j] === "`") dynamic = true;
        text += command[j];
      }
      if (j >= command.length) return [];
      started = true; i = j;
    } else if (c === "\\" && i + 1 < command.length) {
      text += command[++i]; started = true;
    } else if (c === " " || c === "\t") {
      end();
    } else if (c === "\n" || c === ";") {
      end(); all.push([]);
    } else if (c === "&" || c === "|") {
      // `&>` and `>&` are redirects, read below; `&&`, `||`, `|` and `&` end a simple command.
      if (c === "&" && command[i + 1] === ">") { operator(command[i + 2] === ">" ? "&>>" : "&>"); i += command[i + 2] === ">" ? 2 : 1; continue; }
      end();
      if (command[i + 1] === c) i++;
      all.push([]);
    } else if (c === ">" || c === "<") {
      // A redirect, with the descriptor it names (`2>`) when the word before it is only that.
      let op = c;
      if (/^\d$/.test(text) && started) { op = text + op; text = ""; started = false; }
      end();
      if (command[i + 1] === c) { op += c; i++; }
      if (command[i + 1] === "&") { op += "&"; i++; }
      operator(op);
    } else {
      if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[") dynamic = true;
      text += c; started = true;
    }
  }
  end();
  return all.filter((words) => words.length > 0);
}

const clean = (path: string): string => path.replace(/^(\.\/)+/, "");

/** Where a tripwire's word ends besides a space: the shell's quotes, operators and substitutions, and an option's `=`, `,` or `:`. */
const PUNCTUATION = /[\s;&|<>()$`'"\\{}=,:]+/;

/**
 * The words a tripwire's globs are matched against (tripwires.ts), every one that might name what a command runs or
 * touches: each word of each simple command as the shell reads it (quotes and escapes taken away), a word that holds a
 * command of its own read as one too (`bash -c 'rm -rf x'`, `ssh box "make"`), and every run of text between the shell's
 * punctuation (a substitution's `$(rm x)`, `--file=bun.lock`, a command with a quote it never closes). Never the lines of
 * a here-document, which are what a command reads, not what it runs; one whose end never comes is read whole.
 */
export function commandWords(command: string): string[] {
  const words = new Set<string>();
  const read = (text: string, depth: number): void => {
    const shown = withoutHereDocs(text, true);
    for (const word of segments(shown).flat()) {
      if (word.operator || !word.text) continue;
      words.add(word.text);
      if (depth < 2 && /[\s;&|]/.test(word.text)) read(word.text, depth + 1);
    }
    for (const piece of shown.split(PUNCTUATION)) if (piece) words.add(piece);
  };
  read(command, 0);
  return [...words];
}

/** The one file a plain read shows (`cat`, `head`, `tail`, `nl`, `sed -n '…p'`), or null when it is anything more. */
export function readOf(command: string): string | null {
  if (command.includes("<<")) return null;
  const all = segments(command);
  if (all.length !== 1) return null;
  const words = all[0]!;
  if (words.some((w) => w.operator)) return null;
  const [name, ...rest] = words;
  if (!name || name.dynamic) return null;
  const files: Word[] = [];
  if (name.text === "cat" || name.text === "nl") {
    for (const w of rest) if (!w.text.startsWith("-")) files.push(w);
  } else if (name.text === "head" || name.text === "tail") {
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (w.text === "-n" || w.text === "-c") { i++; continue; }
      if (!w.text.startsWith("-")) files.push(w);
    }
  } else if (name.text === "sed") {
    if (!rest.some((w) => w.text === "-n")) return null;
    const args = rest.filter((w) => !w.text.startsWith("-"));
    const [script, ...paths] = args;
    if (!script || !/^(\d+|\$)(,(\d+|\$))?p$/.test(script.text)) return null;
    files.push(...paths);
  } else return null;
  if (files.length !== 1 || files[0]!.dynamic || !files[0]!.text) return null;
  return clean(files[0]!.text);
}

/** Programs that only show what is there (with the options readsOf checks): a command made of these changes nothing. */
const SHOWS = new Set(["cat", "nl", "head", "tail", "sed", "awk", "grep", "egrep", "fgrep", "rg", "ls", "wc", "echo", "printf", "cd", "pwd", "true", "git", "find", "sort", "uniq", "cut", "column", "diff", "file", "stat"]);
/** What git may be asked and still only show. */
const GIT_SHOWS = new Set(["show", "log", "diff", "status", "blame", "grep", "ls-files", "rev-parse"]);
/** Its first operand is a program or a pattern, not a file. */
const SCRIPTED = new Set(["sed", "awk", "grep", "egrep", "fgrep", "rg"]);
/** A word that reads as a path (it has a directory, or an extension). */
const PATHLIKE = /\/|\.[A-Za-z0-9]{1,8}$/;

/**
 * The files a command shows, when all it does is show: every simple command one of SHOWS, with no redirect that writes
 * (but to /dev/null), no here-document and nothing dynamic (`cd x && awk 'NR>=1 && NR<=40' a.ts && echo --- && sed -n
 * '1,9p' b.ts` shows a.ts and b.ts). Null when it might change anything or can't be read for certain; an empty list when
 * it shows no file (`ls`, `pwd`). Folders count as what they show (`grep -rn x packages/node/src`).
 */
export function readsOf(command: string): string[] | null {
  if (command.includes("<<")) return null;
  const all = segments(command);
  if (!all.length) return null;
  const files: string[] = [];
  for (const words of all) {
    for (let i = 0; i < words.length; i++) {
      const op = words[i]!.operator;
      if (!op) continue;
      // A copy of one stream onto another (`2>&1`) changes nothing; a write does, but to /dev/null; a read is a read.
      if (/^\d?>&$/.test(op) || op === "<") continue;
      if (/^(\d|&)?>>?$/.test(op) && words[i + 1]?.text === "/dev/null") continue;
      return null;
    }
    const plain = words.filter((w, i) => !w.operator && !(i > 0 && words[i - 1]!.operator));
    const [name, ...args] = plain;
    if (!name || name.dynamic || !SHOWS.has(name.text) || args.some((w) => w.dynamic)) return null;
    const flags = args.filter((w) => w.text.startsWith("-")).map((w) => w.text);
    let operands = args.filter((w) => !w.text.startsWith("-")).map((w) => w.text);
    if (name.text === "sed" && (!flags.includes("-n") || flags.some((f) => /^(-i|--in-place)/.test(f)) || !/^(\d+|\$)(,(\d+|\$))?p(;(\d+|\$)(,(\d+|\$))?p)*$/.test(operands[0] ?? ""))) return null;
    // An awk program that writes a file, pipes to a command or runs one is no showing.
    if (name.text === "awk" && /system\s*\(|getline|\|\s*"|>\s*"|>>/.test(operands[0] ?? "")) return null;
    if (name.text === "git") {
      if (!GIT_SHOWS.has(operands[0] ?? "")) return null;
      // `git show REV:path`, `git diff -- path`: only what follows `--` is a file of the working tree.
      const dashes = args.findIndex((w) => w.text === "--");
      operands = dashes === -1 ? [] : args.slice(dashes + 1).map((w) => w.text);
    }
    if (name.text === "find" && flags.some((f) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(f))) return null;
    if (name.text === "sort" && flags.some((f) => /^(-o|--output)/.test(f))) return null;
    if (name.text === "uniq" && operands.length > 1) return null;
    if (name.text === "head" || name.text === "tail") operands = operands.filter((o, i) => !/^\d+$/.test(o) || !/^-[nc]$/.test(args[args.findIndex((w) => w.text === o) - 1]?.text ?? ""));
    if (name.text === "echo" || name.text === "printf" || name.text === "cd") continue;
    if (SCRIPTED.has(name.text)) operands = operands.slice(1);
    for (const o of operands) if (PATHLIKE.test(o)) files.push(clean(o));
  }
  return [...new Set(files)];
}

/** Programs whose output is a file's own contents, with the options readsOf allows them (`cat -n`, `sed -n '1,80p'`). */
const CONTENTS = new Set(["cat", "nl", "head", "tail", "sed", "awk"]);

/**
 * The files whose contents a command shows, when that is all it does: a read (readsOf) by cat, nl, head, tail, sed -n
 * or awk, with cd, echo or printf between (`cd x && cat -n a.ts && echo --- && sed -n '1,90p' b.ts`). Null for anything
 * else: a search, a listing or a log shows what is there, not a file to be read whole.
 */
export function contentsOf(command: string): string[] | null {
  const files = readsOf(command);
  if (!files?.length) return null;
  const names = segments(command).map((words) => words.find((w) => !w.operator)?.text ?? "");
  return names.every((n) => CONTENTS.has(n) || n === "cd" || n === "echo" || n === "printf") ? files : null;
}

/** What a Python script may do besides read and write the files it names: run, move or remove things, or find files itself. */
const PYTHON_REACHES = /\b(subprocess|os\.(system|popen|spawn\w*|exec\w*|remove|unlink|rename|renames|replace|makedirs|mkdir|rmdir|removedirs|chmod|chown|chdir|link|symlink|truncate|walk|listdir|scandir)|shutil|glob|fnmatch|rglob|iterdir|exec|eval|compile|__import__|importlib|runpy|ctypes|socket|urllib|requests|http)\b/;
/** A Python script that writes: a file opened to write or append, or written whole. */
const PYTHON_WRITES = /\.write_(text|bytes)\s*\(|\bopen\s*\([^)]*['"][rwxab+t]*[wxa+][rwxab+t]*['"]|\.write\s*\(/;

/** A Python script's string literals, each as written between its quotes (escapes kept), triple-quoted ones included. */
function pythonStrings(script: string): { text: string; formatted: boolean }[] {
  const out: { text: string; formatted: boolean }[] = [];
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "#") {
      const end = script.indexOf("\n", i);
      i = end === -1 ? script.length : end;
      continue;
    }
    if (c !== "'" && c !== '"') continue;
    const formatted = /[fF][rRbB]?$|[rRbB][fF]$/.test(script.slice(Math.max(0, i - 2), i));
    const quote = script.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    let j = i + quote.length;
    for (; j < script.length && !script.startsWith(quote, j); j++) if (script[j] === "\\") j++;
    out.push({ text: script.slice(i + quote.length, j), formatted });
    i = j + quote.length - 1;
  }
  return out;
}

/**
 * What a Python script given inline (`python3 - <<'PY'`, `python3 -c '…'`, after a `cd`) may have changed: nothing when
 * it writes nothing; else the paths its strings name, when it does nothing but read and write files (the way a knight
 * edits code: `sub("packages/core/src/team.ts", old, new)`); anything when it may run or find something by itself, builds
 * a path from a formatted string, or writes without naming a path. Null when the command is anything else.
 */
function pythonChanges(command: string): "nothing" | "anything" | string[] | null {
  const all = segments(withoutHereDocs(command));
  const runs = all.filter((words) => words.find((w) => !w.operator)?.text !== "cd");
  if (runs.length !== 1 || runs[0]!.some((w) => w.operator && w.operator !== "<<")) return null;
  // (Its words, but the here-document's end after `<<`.)
  const words = runs[0]!.filter((w, i, all) => !w.operator && !(i > 0 && all[i - 1]!.operator));
  if (!/^python3?$/.test(words[0]?.text ?? "")) return null;
  let script: string | null = null;
  if (words[1]?.text === "-c" && words.length === 3 && !words[2]!.dynamic) script = words[2]!.text;
  else if (words.length <= 2 && (words[1]?.text ?? "-") === "-") {
    // Its here-document, the only one, given whole: with its end quoted, the shell expands nothing in it.
    const lines = command.split("\n");
    const opens = lines.flatMap((line, i) => (/(?<!<)<<(?!<)/.test(line) ? [i] : []));
    const here = opens.length === 1 ? /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[opens[0]!]!) : null;
    const end = here ? lines.findIndex((l, j) => j > opens[0]! && l.trim() === here[2]) : -1;
    if (!here || end === -1) return "anything";
    script = lines.slice(opens[0]! + 1, end).join("\n");
    if (!here[1] && /[$`]/.test(script)) return "anything";
  }
  if (script === null) return null;
  if (PYTHON_REACHES.test(script)) return "anything";
  // (A path holds no quote, brace or semicolon: a line of code quoted to be replaced isn't one.)
  const named = pythonStrings(script).filter((s) => !/[\n"'`;{}()<>=]/.test(s.text) && PATHLIKE.test(s.text));
  if (named.some((s) => s.formatted)) return "anything";
  if (!PYTHON_WRITES.test(script)) return "nothing";
  return named.length ? [...new Set(named.map((s) => clean(s.text)))] : "anything";
}

/** A run of a project's tests or its type check: it changes no file of the work (a check, not an edit). */
const CHECKS = /^(bun (test|x tsc|run (check|test|typecheck|lint)\b)|bunx tsc|npx (--no-install )?(tsc|vitest|jest)|tsc|npm (test|run (test|check|typecheck|lint)\b)|pytest|python3? -m pytest|go (test|vet)|cargo (test|check|clippy))(\s|$)/;
/** Programs that change only the files their words name (writesOf reads which), with `cd` and the folders a write needs. */
const EDITS = new Set(["cd", "sed", "cat", "echo", "printf", "tee", "cp", "mv", "rm", "git", "mkdir", "touch", "edit"]);

/**
 * What a command may have changed, for what was read before it: nothing (it only shows, or it runs the project's checks),
 * the files it names (an edit: `sed -i`, a redirect, `mv`), or anything (a script, an install: what it touches can't be
 * read from its words).
 */
export function changesOf(command: string): "nothing" | "anything" | string[] {
  if (readsOf(command) !== null) return "nothing";
  const all = segments(withoutHereDocs(command));
  if (!all.length) return "anything";
  const shown = all.map((words) => words.filter((w) => !w.operator).map((w) => w.text).join(" "));
  if (shown.every((s) => /^cd(\s|$)/.test(s) || CHECKS.test(s))) return "nothing";
  const script = pythonChanges(command);
  if (script !== null) return script;
  const writes = writesOf(command);
  const names = all.map((words) => words.find((w) => !w.operator)?.text ?? "");
  return writes.length && names.every((n) => EDITS.has(n)) ? writes : "anything";
}

/** A test's file: named as one (`x.test.ts`, `a_spec.rb`, `test_x.py`), or a file in a tests folder. Never a folder. */
const TEST_FILE = /[._-](test|spec)s?\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.[A-Za-z0-9]+$|(^|\/)(tests?|specs?|__tests__)\/(.+\/)?[^/]+\.[A-Za-z0-9]+$/;

/**
 * The test files a gate names, word for word: the contract its work may not change (quest.ts locks them). A bare test
 * run, a folder or a pattern names none, so a task that must change a test can, when its gate doesn't name it.
 */
export function testFilesOf(command: string): string[] {
  const out: string[] = [];
  for (const words of segments(withoutHereDocs(command))) {
    for (const [i, w] of words.entries()) {
      if (i === 0 || w.operator || w.dynamic || w.text.startsWith("-") || (i > 0 && words[i - 1]!.operator)) continue;
      if (TEST_FILE.test(w.text)) out.push(clean(w.text));
    }
  }
  return [...new Set(out)];
}

/** The programs that check work: test runners, type checkers, linters and builds, as a command line names them. */
const CHECKER = /^(?:bun (?:test|run [\w:.-]+)|bunx (?:tsc|eslint|biome|vitest|jest|prettier)|npx (?:--no-install )?(?:tsc|eslint|biome|vitest|jest|prettier)|(?:npm|pnpm|yarn) (?:test|run [\w:.-]+)|tsc|eslint|biome check|vitest(?: run)?|jest|pytest|python3? -m (?:pytest|unittest|mypy)|go (?:test|build|vet)|cargo (?:test|build|check|clippy)|ruff(?: check)?|mypy|make(?: [\w.-]+)?)(?=\s|$)/;

/**
 * The check a one-line command runs, when it runs one (a test run, a typecheck, a lint, a build): its program and what
 * it names to check (no target: all of it). Where it runs (`cd … &&`), its environment, and what it's piped to or
 * redirected to are aside: `cd /work && bun test a.test.ts 2>&1 | tail -40` is `bun test` on `a.test.ts`. A script,
 * or anything else, is no check.
 */
export function checkOf(command: string): { program: string; targets: string[] } | null {
  if (command.includes("\n")) return null;
  let line = command.trim().replace(/^(?:cd\s+[^\s;&|]+\s*&&\s*)+/, "");
  line = line.split(/\s*(?:\|\|?|;|&&)\s*/)[0]!.replace(/\s+\d?>&\d\b|\s+\d?>>?\s*\S+/g, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
  const program = CHECKER.exec(line)?.[0];
  if (!program) return null;
  return { program, targets: line.slice(program.length).trim().split(/\s+/).filter((word) => word && !word.startsWith("-")) };
}

/**
 * The files a command writes, moves, removes or restores, in the order it names them (none it can't read for certain).
 * `edit <file>` changes the file it names: the engineer's edit tool is said so (engineer-tools.ts).
 */
export function writesOf(command: string): string[] {
  const out: string[] = [];
  const add = (w: Word | undefined) => { if (w && !w.dynamic && !w.operator && w.text) out.push(clean(w.text)); };
  for (const words of segments(withoutHereDocs(command))) {
    // Redirects that write: `>`, `>>`, `2>`, `&>` (not a duplication such as `2>&1`, nor a read `<`).
    words.forEach((w, i) => { if (w.operator && /^(\d|&)?>>?$/.test(w.operator)) add(words[i + 1]); });
    const plain = words.filter((w, i) => !w.operator && !(i > 0 && words[i - 1]!.operator));
    let at = 0;
    while (at < plain.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[at]!.text)) at++;
    const name = plain[at]?.text;
    const args = plain.slice(at + 1);
    const operands = args.filter((w) => !w.text.startsWith("-"));
    if (name === "sed" && args.some((w) => /^(-i|--in-place)/.test(w.text))) {
      const files: Word[] = [];
      let script = !args.some((w) => w.text === "-e" || w.text === "-f");
      for (let i = 0; i < args.length; i++) {
        const w = args[i]!;
        if (w.text === "-e" || w.text === "-f") { i++; continue; }
        // BSD sed's suffix as a word of its own: `-i ''`.
        if (w.text === "-i" && args[i + 1]?.text === "") { i++; continue; }
        if (w.text.startsWith("-")) continue;
        if (script) { script = false; continue; }
        files.push(w);
      }
      files.forEach(add);
    } else if (name === "tee" || name === "rm" || name === "edit") operands.forEach(add);
    else if (name === "mv") operands.forEach(add);
    else if (name === "cp") add(operands.at(-1));
    else if (name === "git" && operands[0]?.text === "restore") operands.slice(1).forEach(add);
    else if (name === "git" && operands[0]?.text === "checkout") {
      const dashes = args.findIndex((w) => w.text === "--");
      if (dashes !== -1) args.slice(dashes + 1).forEach(add);
    }
  }
  return [...new Set(out)];
}
