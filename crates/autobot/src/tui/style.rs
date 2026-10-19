//! Terminal colors, from the lab's shared palette ([invincible::brand]): Autobot's signal is
//! lilac. Off when the output is not a terminal or `NO_COLOR` is set.

use invincible::brand::{self, Color};

/// Code in prose: copper (verdigris is copper's patina; Invincible wears that).
const COPPER: Color = Color { rgb: (0xC8, 0x95, 0x6C), ansi: 173 };

/// Colors on or off for everything printed from now on.
pub fn set_color(on: bool) {
    brand::set_color(on);
}

/// Whether to color: a terminal, and no `NO_COLOR`.
pub fn detect() -> bool {
    use std::io::IsTerminal;
    brand::detect(std::io::stdout().is_terminal())
}

pub fn bold(t: &str) -> String {
    brand::bold(t)
}
pub fn dim(t: &str) -> String {
    brand::dim(t)
}
pub fn italic(t: &str) -> String {
    brand::italic(t)
}
pub fn underline(t: &str) -> String {
    brand::underline(t)
}
/// Failures.
pub fn red(t: &str) -> String {
    brand::paint(brand::ERROR, t)
}
/// Added lines.
pub fn green(t: &str) -> String {
    brand::paint(brand::ADDED, t)
}
/// Removed lines.
pub fn removed(t: &str) -> String {
    brand::paint(brand::REMOVED, t)
}
/// Needs a look.
pub fn yellow(t: &str) -> String {
    brand::paint(brand::AMBER, t)
}
/// The signal: Autobot's lilac. The mark, the prompt, what needs the owner now.
pub fn accent(t: &str) -> String {
    brand::paint(brand::LILAC, t)
}
/// Code.
pub fn code(t: &str) -> String {
    brand::paint(COPPER, t)
}
/// Secondary text.
pub fn gray(t: &str) -> String {
    brand::ash(t)
}
/// Structure: gutters, rules, hints.
pub fn faint(t: &str) -> String {
    brand::faint(t)
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
