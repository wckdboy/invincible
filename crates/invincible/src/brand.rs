//! How Sovware's tools look in a terminal: Invincible and Autobot share this, so they read as
//! one lab's work while each keeps its own signal color. See BRAND.md.
//!
//! - Warm neutrals for almost everything: the terminal's own foreground, ash for what is
//!   secondary, a fainter ash for structure (gutters, rules).
//! - One signal color per product, used sparingly: its mark, the prompt, what needs you now.
//!   Autobot is lilac; Invincible is orange: complements, opposite on the wheel.
//! - The mark is a small square, `■`, before the lowercase name.
//! - States are words and plain glyphs: `✓` in ash when fine, `!` yellow when it needs a look,
//!   `✗` in the error color when it failed. Color never carries meaning alone.
//!
//! Truecolor where the terminal says it has it (`COLORTERM`), the nearest of the 256 colors
//! otherwise; none when the output is not a terminal or `NO_COLOR` is set.

use std::sync::atomic::{AtomicU8, Ordering};

/// A color: its RGB and the nearest of the 256.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color {
    pub rgb: (u8, u8, u8),
    pub ansi: u8,
}

const fn color(r: u8, g: u8, b: u8, ansi: u8) -> Color {
    Color { rgb: (r, g, b), ansi }
}

/// Autobot's signal: lilac (`#5444BA` on paper, `#A99BF5` here, for dark terminals).
pub const LILAC: Color = color(0xA9, 0x9B, 0xF5, 147);
/// Invincible's signal: orange (`#9E4C0C` on paper, `#F0882E` here, for dark terminals).
pub const ORANGE: Color = color(0xF0, 0x88, 0x2E, 208);
/// Secondary text.
pub const ASH: Color = color(0x8E, 0x8A, 0x84, 245);
/// Structure: gutters, rules, hints.
pub const FAINT: Color = color(0x6E, 0x6A, 0x64, 242);
/// Something to look at: yellow, clear of Invincible's orange.
pub const YELLOW: Color = color(0xE2, 0xC0, 0x44, 185);
pub const ERROR: Color = color(0xFF, 0x6A, 0x47, 209);
/// Diffs: added and removed lines, muted so a long diff is not a wall of color.
pub const ADDED: Color = color(0x8F, 0xB5, 0x73, 107);
pub const REMOVED: Color = color(0xE0, 0x6C, 0x5C, 167);

/// The mark, before a product's name.
pub const MARK: &str = "■";

/// The products, each with its signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    Autobot,
    Invincible,
}

impl Product {
    pub fn signal(self) -> Color {
        match self {
            Self::Autobot => LILAC,
            Self::Invincible => ORANGE,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Autobot => "autobot",
            Self::Invincible => "invincible",
        }
    }

    /// `■ name version`, the first line a command prints.
    pub fn header(self, version: &str) -> String {
        format!("{} {} {}", paint(self.signal(), MARK), bold(self.name()), paint(ASH, version))
    }
}

/// 0: no color, 1: 256 colors, 2: truecolor.
static DEPTH: AtomicU8 = AtomicU8::new(0);

/// Colors for everything printed from now on: on, with the depth the terminal has, or off.
pub fn set_color(on: bool) {
    let depth = if !on {
        0
    } else if std::env::var("COLORTERM").is_ok_and(|v| v == "truecolor" || v == "24bit") {
        2
    } else {
        1
    };
    DEPTH.store(depth, Ordering::Relaxed);
}

/// Whether [stream] should be colored: a terminal, and no `NO_COLOR`.
pub fn detect(terminal: bool) -> bool {
    terminal
        && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
        && std::env::var("TERM").as_deref() != Ok("dumb")
}

/// Colors on when stdout is a terminal (and NO_COLOR is not set).
pub fn init() {
    use std::io::IsTerminal;
    set_color(detect(std::io::stdout().is_terminal()));
}

pub fn colored() -> bool {
    DEPTH.load(Ordering::Relaxed) > 0
}

fn sgr(code: &str, text: &str) -> String {
    if colored() { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_owned() }
}

/// [text] in [color].
pub fn paint(color: Color, text: &str) -> String {
    match DEPTH.load(Ordering::Relaxed) {
        0 => text.to_owned(),
        1 => format!("\x1b[38;5;{}m{text}\x1b[0m", color.ansi),
        _ => {
            let (r, g, b) = color.rgb;
            format!("\x1b[38;2;{r};{g};{b}m{text}\x1b[0m")
        }
    }
}

pub fn bold(text: &str) -> String {
    sgr("1", text)
}

pub fn dim(text: &str) -> String {
    sgr("2", text)
}

pub fn italic(text: &str) -> String {
    sgr("3", text)
}

pub fn underline(text: &str) -> String {
    sgr("4", text)
}

pub fn ash(text: &str) -> String {
    paint(ASH, text)
}

pub fn faint(text: &str) -> String {
    paint(FAINT, text)
}

/// A check that passed: `✓ what`, quiet.
pub fn ok(what: &str) -> String {
    format!("{} {what}", paint(ASH, "✓"))
}

/// Something to look at: `! what`.
pub fn warn(what: &str) -> String {
    format!("{} {what}", paint(YELLOW, "!"))
}

/// A failure: `✗ what`.
pub fn fail(what: &str) -> String {
    format!("{} {what}", paint(ERROR, "✗"))
}

/// `  label   value` rows, labels in ash and padded to one column.
pub fn rows(rows: &[(&str, String)]) -> String {
    let width = rows.iter().map(|(l, _)| l.chars().count()).max().unwrap_or(0);
    rows.iter().map(|(label, value)| format!("  {}  {value}\n", ash(&format!("{label:<width$}")))).collect()
}

/// Columns a terminal gives [text]: escape sequences left out.
pub fn visible(text: &str) -> usize {
    let mut n = 0;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            n += 1;
        }
    }
    n
}

/// Rows as aligned columns, two spaces apart, indented; the first column bold. The last
/// column is not padded.
pub fn table(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> =
        (0..columns).map(|c| rows.iter().filter_map(|r| r.get(c)).map(|s| visible(s)).max().unwrap_or(0)).collect();
    let mut out = String::new();
    for row in rows {
        let mut line = String::from("  ");
        for (c, cell) in row.iter().enumerate() {
            let shown = if c == 0 { bold(cell) } else { cell.clone() };
            line.push_str(&shown);
            if c + 1 < row.len() {
                line.push_str(&" ".repeat(widths[c] - visible(cell) + 2));
            }
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// How a command's failure is printed: `✗ message` on a colored terminal, `name: message`
/// otherwise (logs and scripts keep the program's name).
pub fn error_line(product: Product, message: &str) -> String {
    if colored() { fail(message) } else { format!("{}: {message}", product.name()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_without_color() {
        set_color(false);
        assert_eq!(paint(LILAC, "x"), "x");
        assert_eq!(Product::Autobot.header("0.1"), "■ autobot 0.1");
        assert_eq!(ok("gateway"), "✓ gateway");
        assert_eq!(
            rows(&[("model", "qwen".into()), ("approvals", "ask".into())]),
            "  model      qwen\n  approvals  ask\n"
        );
        let t = table(&[vec!["a".into(), "long one".into(), "x".into()], vec!["bbb".into(), "c".into(), "y".into()]]);
        assert_eq!(t, "  a    long one  x\n  bbb  c         y\n");
        assert_eq!(error_line(Product::Invincible, "no"), "invincible: no");
        assert_eq!(visible("\x1b[1mab\x1b[0m"), 2);
    }
}
