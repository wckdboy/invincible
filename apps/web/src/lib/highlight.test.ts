import { describe, expect, test } from "bun:test";
import { highlight, languageOf, LONG } from "./highlight.ts";

const tones = (code: string, lang: string) => highlight(code, lang).map((p) => (p.tone ? `${p.tone}:${p.text}` : p.text));

describe("code, coloured by what each part is", () => {
  test("a C-family language: its words, strings, characters, numbers and both kinds of comment", () => {
    expect(tones(`let x = "hi \\" there" // say it\nif c == 'a' { return 0x1F }`, "swift")).toEqual([
      "keyword:let", " x = ", 'string:"hi \\" there"', " ", "comment:// say it", "\n", "keyword:if", " c == ", "string:'a'", " { ", "keyword:return", " ", "number:0x1F", " }",
    ]);
    expect(tones("/* a\nblock */ fn main<'a>() {}", "rust")).toEqual(["comment:/* a\nblock */", " ", "keyword:fn", " main<'a>() {}"]);
  });

  test("JavaScript and TypeScript take three quotes; Go a backtick that runs on", () => {
    expect(tones("const s = `a\nb`; const t = 'x';", "ts")).toEqual(["keyword:const", " s = ", "string:`a\nb`", "; ", "keyword:const", " t = ", "string:'x'", ";"]);
    expect(tones("x := `raw\nline`", "go")).toEqual(["x := ", "string:`raw\nline`"]);
  });

  test("Python's comments, triple quotes and words; a shell's # only where a comment starts", () => {
    expect(tones('def f():\n    """doc\n    string"""\n    return None  # nothing', "python")).toEqual([
      "keyword:def", " f():\n    ", 'string:"""doc\n    string"""', "\n    ", "keyword:return", " ", "keyword:None", "  ", "comment:# nothing",
    ]);
    expect(tones('echo "a#b" # say\nif [ $x ]; then exit 1; fi', "bash")).toEqual(["echo ", 'string:"a#b"', " ", "comment:# say", "\n", "keyword:if", " [ $x ]; ", "keyword:then", " ", "keyword:exit", " ", "number:1", "; ", "keyword:fi"]);
  });

  test("SQL's words in any case; JSON's few", () => {
    expect(tones("SELECT id FROM t -- all\nwhere n > 2", "sql")).toEqual(["keyword:SELECT", " id ", "keyword:FROM", " t ", "comment:-- all", "\n", "keyword:where", " n > ", "number:2"]);
    expect(tones('{"a": [1.5e3, true, null]}', "json")).toEqual(["{", 'string:"a"', ": [", "number:1.5e3", ", ", "keyword:true", ", ", "keyword:null", "]}"]);
  });

  test("a diff by its lines", () => {
    expect(highlight("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n same\n same too\n", "diff")).toEqual([
      { text: "diff --git a/x b/x\n", tone: "meta" },
      { text: "@@ -1 +1 @@\n", tone: "meta" },
      { text: "-old\n", tone: "removed" },
      { text: "+new\n", tone: "added" },
      { text: " same\n same too\n" },
    ]);
  });

  test("a language it doesn't know, or code that long, is left as it is", () => {
    expect(highlight("<b>x</b>", "html")).toEqual([{ text: "<b>x</b>" }]);
    expect(highlight("let x", "")).toEqual([{ text: "let x" }]);
    const long = "let x = 1\n".repeat(LONG / 10 + 1);
    expect(highlight(long, "swift")).toEqual([{ text: long }]);
    // An unclosed string or comment runs to the end, and nothing is lost.
    for (const [code, lang] of [['say("open', "swift"], ["/* never closed", "ts"], ["'''x", "py"]] as const) expect(highlight(code, lang).map((p) => p.text).join("")).toBe(code);
  });
});

describe("a file's language, by its name", () => {
  test("its extension, a few named, or none", () => {
    expect(languageOf("/work/src/app.ts")).toBe("ts");
    expect(languageOf("config.YML")).toBe("yaml");
    expect(languageOf("README.md")).toBe("");
    expect(languageOf("Dockerfile")).toBe("sh");
    expect(languageOf(".env")).toBe("");
  });
});
