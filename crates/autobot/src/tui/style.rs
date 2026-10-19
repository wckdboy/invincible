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

/// Characters shown, escape sequences left out (close enough for wrapping: no wide-char table).
pub fn width(text: &str) -> usize {
    let mut n = 0;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else if !c.is_control() {
            n += 1;
        }
    }
    n
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
    }
}
