//! Text to a terminal's width: words kept whole where they fit, escape sequences left out of the
//! count, and a style that spans a break closed at the end of one line and opened again on the
//! next (each line stands alone, so a redraw of one row looks the same as the first draw).

use unicode_width::UnicodeWidthChar;

/// A piece of styled text: an escape sequence, or one character and its width.
enum Piece<'a> {
    Escape(&'a str),
    Char(char, usize),
}

fn pieces(text: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < text.len() {
        if bytes[i] == 0x1b {
            let start = i;
            i += 1;
            // CSI (`ESC [ … letter`) or a two-byte escape.
            if bytes.get(i) == Some(&b'[') {
                i += 1;
                while i < text.len() && !bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
            }
            i = (i + 1).min(text.len());
            out.push(Piece::Escape(&text[start..i]));
            continue;
        }
        let c = text[i..].chars().next().unwrap_or(' ');
        i += c.len_utf8();
        let w = if c == '\t' { 4 } else { c.width().unwrap_or(0) };
        out.push(Piece::Char(if c == '\t' { ' ' } else { c }, w));
    }
    out
}

/// The styles in effect after [escape], given those before it.
fn track(active: &mut Vec<String>, escape: &str) {
    if escape == "\x1b[0m" || escape == "\x1b[m" {
        active.clear();
    } else if escape.ends_with('m') {
        active.push(escape.to_owned());
    }
}

struct Lines {
    out: Vec<String>,
    line: String,
    used: usize,
    active: Vec<String>,
    rest: String,
    rest_width: usize,
}

impl Lines {
    fn new(first: &str, rest: &str) -> Self {
        Self {
            out: Vec::new(),
            line: first.to_owned(),
            used: super::style::width(first),
            active: Vec::new(),
            rest: rest.to_owned(),
            rest_width: super::style::width(rest),
        }
    }

    fn push_char(&mut self, c: char, w: usize) {
        self.line.push(c);
        self.used += w;
    }

    fn push_escape(&mut self, e: &str) {
        self.line.push_str(e);
        track(&mut self.active, e);
    }

    fn rest_width(&self) -> usize {
        self.rest_width
    }

    fn break_line(&mut self) {
        let trimmed_len = self.line.trim_end_matches(' ').len();
        // Trailing spaces are not kept (escapes after them are).
        if self.line[trimmed_len..].chars().all(|c| c == ' ') {
            self.used -= self.line.len() - trimmed_len;
            self.line.truncate(trimmed_len);
        }
        if !self.active.is_empty() {
            self.line.push_str("\x1b[0m");
        }
        let mut next = self.rest.clone();
        for e in &self.active {
            next.push_str(e);
        }
        self.out.push(std::mem::replace(&mut self.line, next));
        self.used = self.rest_width;
    }
}

/// [text] in lines of at most [width] columns: the first starting with [first], the others with
/// [rest] (a hanging indent). Words move to the next line whole; a word longer than a line is cut.
/// Without [words], it is cut at the width wherever that falls (code).
pub fn wrap(text: &str, width: usize, first: &str, rest: &str, words: bool) -> Vec<String> {
    let width = width.max(super::style::width(rest) + 4).max(8);
    let mut lines = Lines::new(first, rest);
    let all = pieces(text);
    let mut i = 0;
    while i < all.len() {
        match &all[i] {
            Piece::Escape(e) => {
                lines.push_escape(e);
                i += 1;
            }
            Piece::Char(' ', w) if words => {
                if lines.used + w <= width {
                    lines.push_char(' ', *w);
                }
                i += 1;
            }
            Piece::Char(..) if words => {
                // The whole word, up to the next space.
                let end = (i..all.len()).find(|&j| matches!(all[j], Piece::Char(' ', _))).unwrap_or(all.len());
                let word: usize = all[i..end].iter().map(|p| if let Piece::Char(_, w) = p { *w } else { 0 }).sum();
                let room = width.saturating_sub(lines.used);
                let fresh = width.saturating_sub(lines.rest_width());
                if word > room && word <= fresh && lines.used > lines.rest_width() {
                    lines.break_line();
                }
                for piece in &all[i..end] {
                    match piece {
                        Piece::Escape(e) => lines.push_escape(e),
                        Piece::Char(c, w) => {
                            if lines.used + w > width {
                                lines.break_line();
                            }
                            lines.push_char(*c, *w);
                        }
                    }
                }
                i = end;
            }
            Piece::Char(c, w) => {
                if lines.used + w > width {
                    lines.break_line();
                }
                lines.push_char(*c, *w);
                i += 1;
            }
        }
    }
    let Lines { mut out, line, .. } = lines;
    out.push(line);
    out
}

/// [text] cut to [width] columns, with `…` where it was cut; styles closed.
pub fn truncate(text: &str, width: usize) -> String {
    if super::style::width(text) <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    let mut styled = false;
    for piece in pieces(text) {
        match piece {
            Piece::Escape(e) => {
                out.push_str(e);
                styled = true;
            }
            Piece::Char(c, w) => {
                if used + w + 1 > width {
                    break;
                }
                out.push(c);
                used += w;
            }
        }
    }
    out.push('…');
    if styled {
        out.push_str("\x1b[0m");
    }
    out
}

/// [text] padded with spaces to [width] columns (cut when longer).
pub fn pad(text: &str, width: usize) -> String {
    let text = truncate(text, width);
    let used = super::style::width(&text);
    format!("{text}{}", " ".repeat(width.saturating_sub(used)))
}

#[cfg(test)]
mod tests {
    use super::{pad, truncate, wrap};
    use crate::tui::style::width;

    #[test]
    fn words_move_whole_and_indents_hang() {
        let lines = wrap("the quick brown fox jumps over the lazy dog", 16, "• ", "  ", true);
        assert_eq!(lines, ["• the quick", "  brown fox", "  jumps over the", "  lazy dog"]);
        assert!(lines.iter().all(|l| width(l) <= 16));
        assert_eq!(wrap("short", 40, "", "", true), ["short"]);
        assert_eq!(wrap("", 40, "> ", "", true), ["> "]);
    }

    #[test]
    fn long_words_and_code_are_cut() {
        assert_eq!(wrap("abcdefghijklmnop", 10, "", "", true), ["abcdefghij", "klmnop"]);
        assert_eq!(wrap("let x = 1; let y = 2;", 10, "│ ", "│ ", false), ["│ let x =", "│ 1; let y", "│  = 2;"]);
        assert_eq!(wrap("日本語の文", 8, "", "", true), ["日本語の", "文"], "wide characters count twice");
    }

    #[test]
    fn styles_close_at_a_break_and_open_again() {
        let lines = wrap("\x1b[1mbold words here\x1b[0m done", 11, "", "", true);
        assert_eq!(lines, ["\x1b[1mbold words\x1b[0m", "\x1b[1mhere\x1b[0m done"]);
    }

    #[test]
    fn cut_and_padded() {
        assert_eq!(truncate("hello world", 8), "hello w…");
        assert_eq!(truncate("hello", 8), "hello");
        assert_eq!(truncate("\x1b[2mhello world\x1b[0m", 6), "\x1b[2mhello…\x1b[0m");
        assert_eq!(pad("ab", 4), "ab  ");
    }
}
