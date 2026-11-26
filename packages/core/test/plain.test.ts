import { describe, expect, test } from "bun:test";
import { cleanSkillText, codePointLabel, plainLine, plainStream, plainText, visibleText } from "../src/index.ts";

/* Words as written, with nothing in them that hides, reorders or steers (plain.ts). */

describe("plain text", () => {
  test("what a terminal would act on is taken out: escapes, carriage returns, bells, the one-character CSI", () => {
    expect(plainText("a\u001b[31mred\u001b[0m b\u0007\u0008 \u009b2Jc\u007f")).toBe("a[31mred[0m b 2Jc");
    expect(plainLine("a\u001b[31mred\u001b[0m b\u0007\u0008 \u009b2Jc\u007f")).toBe("a[31mred[0m b 2Jc");
    for (let code = 0; code < 0xa0; code++) {
      const shown = plainText(`x${String.fromCharCode(code)}y`);
      const kept = code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : code === 0x09 ? "\t" : code === 0x0a || code === 0x0d || code === 0x85 ? "\n" : "";
      expect(shown).toBe(`x${kept}y`);
    }
  });

  test("what hides or reorders is taken out: bidirectional overrides and isolates, zero-width characters, the byte-order mark", () => {
    const hidden = ["\u061c", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2060", "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff"];
    for (const mark of hidden) {
      expect(plainText(`ab${mark}cd`)).toBe("abcd");
      expect(plainLine(`ab${mark}cd`)).toBe("abcd");
    }
  });

  test("what is never drawn is taken out too: a soft hyphen, fillers, deprecated format characters, tags", () => {
    for (const point of [0xad, 0x115f, 0x1160, 0x180e, 0x206a, 0x206f, 0x3164, 0xffa0, 0xe0001, 0xe0041, 0xe007f]) {
      const mark = String.fromCodePoint(point);
      expect([point.toString(16), plainText(`ab${mark}cd`), plainLine(`ab${mark}cd`)]).toEqual([point.toString(16), "abcd", "abcd"]);
    }
    // The joiners go with the rest, which costs joined emoji their joining and Persian its half-space: the price of nothing hidden.
    expect(plainLine("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}")).toBe("\u{1f468}\u{1f469}\u{1f467}");
    expect(plainLine("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe("\u0645\u06cc\u062e\u0648\u0627\u0647\u0645");
  });

  test("words that arrive in pieces come out as they would whole: a line break split between two pieces is one line break", () => {
    const whole = "one\r\ntwo\rthree\r\n\r\nfour\u001b[2J";
    for (const pieces of [[whole], ["one\r", "\ntwo\r", "three\r\n\r", "\nfour\u001b", "[2J"], [...whole], ["one\r", "", "\ntwo\rthree\r\n\r\nfour\u001b[2J"]]) {
      const plain = plainStream();
      expect(pieces.map(plain).join("")).toBe("one\ntwo\nthree\n\nfour[2J");
    }
  });

  test("text keeps its lines, every kind of line break as a newline; a line is one line", () => {
    expect(plainText("one\r\ntwo\rthree\u2028four\u2029five\u0085six\n\tseven")).toBe("one\ntwo\nthree\nfour\nfive\nsix\n\tseven");
    expect(plainLine("  one\r\ntwo\rthree\u2028four\u2029five\u0085six\n\tseven  ")).toBe("one two three four five six seven");
  });

  test("words in any script are left as they are", () => {
    for (const words of ["Åse D'Arcy", "研究員 は 調べる", "Ελληνικά και Кириллица", "naïve café 🙂", "a < b && c > d"]) {
      expect(plainText(words)).toBe(words);
      expect(plainLine(words)).toBe(words);
    }
  });

  test("a skill's text is kept by the same rule", () => {
    expect(cleanSkillText).toBe(plainLine);
  });
});

/* What a person must see exactly (an operation that waits for their approval): what can't be seen is shown, never taken out. */
describe("visible text", () => {
  test("everything plain text takes out or changes is shown in its place as its code point, and nothing else is", () => {
    const points = [...Array.from({ length: 0x3200 }, (_, i) => i), 0xfeff, 0xffa0, 0xe0001, 0xe0041, 0xe007f];
    for (const point of points) {
      const char = String.fromCodePoint(point);
      if (char === "\n" || (point >= 0xd800 && point <= 0xdfff)) continue;
      const line = `x${char}y`;
      if (plainText(line) !== line) expect([point.toString(16), visibleText(line).text]).toEqual([point.toString(16), `x${codePointLabel(char)}y`]);
    }
    expect(visibleText("a b\nc").text).toBe("a b\nc");
  });

  test("a space that isn't a plain one is shown too: a tab, a no-break space, the other widths", () => {
    for (const point of [0x09, 0xa0, 0x1680, 0x2000, 0x2007, 0x200a, 0x202f, 0x205f, 0x3000]) {
      const char = String.fromCodePoint(point);
      expect(visibleText(`a${char}b`)).toEqual({ text: `a${codePointLabel(char)}b`, hidden: [char] });
    }
    expect(codePointLabel("\u202e")).toBe("⟨U+202E⟩");
    expect(codePointLabel("\u{e0041}")).toBe("⟨U+E0041⟩");
  });

  test("what it shows can't be acted on or misread: no character of it is hidden, each hidden one is named once, in order", () => {
    const shown = visibleText("rm -rf /tmp/old\u202e /\u200b\u001b[2J\u202e\r\n");
    expect(shown.text).toBe("rm -rf /tmp/old⟨U+202E⟩ /⟨U+200B⟩⟨U+001B⟩[2J⟨U+202E⟩⟨U+000D⟩\n");
    expect(shown.hidden).toEqual(["\u202e", "\u200b", "\u001b", "\r"]);
    expect(plainText(shown.text)).toBe(shown.text);
    for (const words of ["Åse D'Arcy", "研究員 は 調べる", "naïve café 🙂", "a < b && c > d"]) expect(visibleText(words)).toEqual({ text: words, hidden: [] });
  });
});
