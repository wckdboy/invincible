//! Terminal colors, off when the output is not a terminal or `NO_COLOR` is set.

use std::sync::atomic::{AtomicBool, Ordering};

static COLOR: AtomicBool = AtomicBool::new(false);

/// Colors on or off for everything printed from now on.
pub fn set_color(on: bool) {
    COLOR.store(on, Ordering::Relaxed);
}

/// Whether to color: a terminal, and no `NO_COLOR`.
pub fn detect() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
}

fn paint(code: &str, text: &str) -> String {
    if COLOR.load(Ordering::Relaxed) { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_owned() }
}

pub fn bold(t: &str) -> String {
    paint("1", t)
}
pub fn dim(t: &str) -> String {
    paint("2", t)
}
pub fn italic(t: &str) -> String {
    paint("3", t)
}
pub fn underline(t: &str) -> String {
    paint("4", t)
}
pub fn red(t: &str) -> String {
    paint("31", t)
}
pub fn green(t: &str) -> String {
    paint("32", t)
}
pub fn yellow(t: &str) -> String {
    paint("33", t)
}
pub fn blue(t: &str) -> String {
    paint("34", t)
}
pub fn magenta(t: &str) -> String {
    paint("35", t)
}
pub fn cyan(t: &str) -> String {
    paint("36", t)
}
/// The accent: Autobot's orange.
pub fn accent(t: &str) -> String {
    paint("38;5;208", t)
}
/// Code: a soft teal.
pub fn code(t: &str) -> String {
    paint("38;5;80", t)
}
pub fn gray(t: &str) -> String {
    paint("38;5;245", t)
}

/// Columns [text] takes on a terminal: escape sequences left out, wide characters (CJK, emoji)
/// two, combining marks none, tabs to the next multiple of 8.
pub fn width(text: &str) -> usize {
    use unicode_width::UnicodeWidthChar;
    let mut n = 0;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else if c == '\t' {
            n += 8 - n % 8;
        } else {
            n += c.width().unwrap_or(0);
        }
    }
    n
}

/// The end of [text] that fits in [columns] (no escape sequences in it).
pub fn last_columns(text: &str, columns: usize) -> String {
    use unicode_width::UnicodeWidthChar;
    let mut used = 0;
    let mut kept: Vec<char> = Vec::new();
    for c in text.chars().rev() {
        let w = c.width().unwrap_or(0);
        if used + w > columns {
            break;
        }
        used += w;
        kept.push(c);
    }
    kept.into_iter().rev().collect()
}

/// The terminal's width in columns (80 when unknown).
pub fn columns() -> usize {
    crossterm::terminal::size().map(|(w, _)| w as usize).ok().filter(|w| *w > 10).unwrap_or(80)
}

#[cfg(test)]
mod tests {
    #[test]
    fn width_skips_escapes() {
        assert_eq!(super::width("\x1b[1mhi\x1b[0m there"), 8);
        assert_eq!(super::width("• ok"), 4);
        assert_eq!(super::width("日本"), 4, "wide");
        assert_eq!(super::width("e\u{301}"), 1, "a combining mark takes no column");
        assert_eq!(super::width("\tx"), 9);
        assert_eq!(super::last_columns("abc日本", 4), "日本");
        assert_eq!(super::last_columns("abc日本", 5), "c日本");
    }
}
