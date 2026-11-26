/*
 * Code coloured by what each part of it is: comments, strings, numbers and a language's own words, found by a small
 * scanner for each family of languages, and a diff by its lines. Pure (no DOM): ui/markdown.ts draws the pieces, and
 * the Apple apps' Highlight.swift says the same (held to it by the vectors). A language it doesn't know, and code past
 * LONG characters, is left as it is.
 */

export type Tone = "comment" | "string" | "number" | "keyword" | "added" | "removed" | "meta";
export interface Piece {
  text: string;
  tone?: Tone;
}

interface Family {
  /** What starts a comment to the end of its line (a `#` only at a line's start or after a space). */
  line: string[];
  block?: [string, string];
  /** Quotes that open a string to the same quote, on one line (a backtick's may run on). */
  quotes: string[];
  /** A `'` is a character, closed within three more (C, Rust, Java): one that isn't stays as it is (a lifetime). */
  chars?: boolean;
  /** `"""` (or `'''`) opens a string to the same three. */
  triple?: boolean;
  words: ReadonlySet<string>;
  /** Its words in any case (SQL). */
  caseless?: boolean;
}

// (Each list a string of words between bars: written with spaces, a list with "import" in it would read as an import
// statement to the bundle check, assets.test.ts.)
const words = (list: string) => new Set(list.split("|"));
const C = words(
  "as|async|await|break|case|catch|class|const|continue|default|defer|do|else|enum|extends|extension|false|final|fileprivate|fn|for|func|go|goto|guard|if|impl|import|in|init|inout|interface|internal|let|loop|match|mod|move|mut|namespace|new|nil|null|object|open|operator|override|package|private|protected|protocol|pub|public|repeat|return|self|Self|static|struct|super|switch|this|throw|throws|true|try|type|typealias|union|unsafe|use|using|var|virtual|void|volatile|where|while|yield",
);
const JS = words(
  "as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|package|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield",
);
const PY = words("and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|match|None|nonlocal|not|or|pass|raise|return|self|True|try|while|with|yield");
const SH = words("if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|return|exit|export|local|readonly|unset|shift|break|continue|source|alias|trap");
const RB = words("alias|and|begin|break|case|class|def|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|require|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield");
const SQL = words(
  "add|all|alter|and|as|asc|begin|between|by|case|check|column|commit|create|default|delete|desc|distinct|drop|else|end|exists|foreign|from|full|group|having|if|in|index|inner|insert|into|is|join|key|left|like|limit|not|null|offset|on|or|order|outer|primary|references|returning|right|rollback|select|set|table|then|transaction|union|unique|update|values|view|when|where|with",
);
const DATA = words("true|false|null");

const FAMILIES: Record<string, Family> = {
  c: { line: ["//"], block: ["/*", "*/"], quotes: ['"'], chars: true, triple: true, words: C },
  go: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "`"], chars: true, words: C },
  js: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'", "`"], words: JS },
  py: { line: ["#"], quotes: ['"', "'"], triple: true, words: PY },
  sh: { line: ["#"], quotes: ['"', "'"], words: SH },
  rb: { line: ["#"], quotes: ['"', "'"], words: RB },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'"], words: SQL, caseless: true },
  json: { line: [], quotes: ['"'], words: DATA },
  yaml: { line: ["#"], quotes: ['"', "'"], words: DATA },
};

/** A fence's language, by the names models and people give it. */
const LANGS: Record<string, string> = {
  swift: "c", rust: "c", rs: "c", java: "c", kotlin: "c", kt: "c", c: "c", cpp: "c", "c++": "c", h: "c", hpp: "c", cs: "c", csharp: "c", scala: "c", dart: "c", zig: "c", php: "c",
  go: "go", golang: "go",
  ts: "js", typescript: "js", tsx: "js", js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", jsonc: "js",
  py: "py", python: "py", python3: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", fish: "sh", shellscript: "sh",
  rb: "rb", ruby: "rb",
  sql: "sql", sqlite: "sql", postgres: "sql", postgresql: "sql", mysql: "sql",
  json: "json",
  yaml: "yaml", yml: "yaml", toml: "yaml",
};

/** Past this many characters code is shown as it is: colouring it would cost more than it gives. */
export const LONG = 60_000;

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;
const WORD = /^[A-Za-z_$][\w$]*/;
const isSpace = (ch: string | undefined) => ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);

export function highlight(code: string, lang: string): Piece[] {
  const name = lang.trim().toLowerCase();
  if (code.length > LONG) return [{ text: code }];
  if (name === "diff" || name === "patch") return diffPieces(code);
  const family = FAMILIES[LANGS[name] ?? ""];
  if (!family) return [{ text: code }];
  const out: Piece[] = [];
  let plain = "";
  const push = (text: string, tone?: Tone) => {
    if (!tone) {
      plain += text;
      return;
    }
    if (plain) out.push({ text: plain });
    plain = "";
    out.push({ text, tone });
  };
  /** From `at` to just past `close` (the end, when it never comes). */
  const through = (at: number, close: string) => {
    const end = code.indexOf(close, at);
    return end < 0 ? code.length : end + close.length;
  };
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    const comment = family.line.find((mark) => code.startsWith(mark, i) && (mark !== "#" || isSpace(code[i - 1])));
    if (comment) {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    if (family.block && code.startsWith(family.block[0], i)) {
      const stop = through(i + family.block[0].length, family.block[1]);
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    if (family.triple && (ch === '"' || ch === "'") && code.startsWith(ch.repeat(3), i)) {
      const stop = through(i + 3, ch.repeat(3));
      push(code.slice(i, stop), "string");
      i = stop;
      continue;
    }
    if (family.quotes.includes(ch)) {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && (code[j] !== "\n" || ch === "`")) j += code[j] === "\\" ? 2 : 1;
      const stop = Math.min(code.length, j + 1);
      push(code.slice(i, stop), "string");
      i = stop;
      continue;
    }
    if (family.chars && ch === "'") {
      const close = code.indexOf("'", i + 1);
      if (close > i && close - i <= 4 && !code.slice(i + 1, close).includes("\n")) {
        push(code.slice(i, close + 1), "string");
        i = close + 1;
        continue;
      }
    }
    if (ch >= "0" && ch <= "9" && !isWordChar(code[i - 1])) {
      const number = NUMBER.exec(code.slice(i, i + 64))?.[0] ?? ch;
      push(number, "number");
      i += number.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch) && !isWordChar(code[i - 1])) {
      const word = WORD.exec(code.slice(i, i + 128))?.[0] ?? ch;
      push(word, family.words.has(family.caseless ? word.toLowerCase() : word) ? "keyword" : undefined);
      i += word.length;
      continue;
    }
    push(ch);
    i += 1;
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** A diff, line by line: what it adds, what it takes out, and the lines that say where (each with its own newline). */
function diffPieces(code: string): Piece[] {
  const out: Piece[] = [];
  for (const line of code.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const tone: Tone | undefined =
      line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")
        ? "meta"
        : line.startsWith("+")
          ? "added"
          : line.startsWith("-")
            ? "removed"
            : undefined;
    const last = out.at(-1);
    if (!tone && last && !last.tone) last.text += line;
    else out.push(tone ? { text: line, tone } : { text: line });
  }
  return out;
}

/** The language a file is written in, by its name (for its colours), or "" when it isn't one highlight knows. */
export function languageOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  if (name === "Dockerfile" || name === "Makefile") return "sh";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return ({ md: "", markdown: "", yml: "yaml", h: "c", hpp: "cpp", mts: "ts", cts: "ts" } as Record<string, string>)[ext] ?? ext;
}
