//! Markdown in the terminal, a line at a time (answers stream in), wrapped to the width:
//! headings, lists (with hanging indents), quotes, rules, tables (held until their last row, then
//! aligned), fenced code with its language and a light tint, and inline code, bold, italics and
//! links.

use super::style;
use super::wrap::wrap;

/// Where a stream of lines is: inside a code fence, or in a table.
#[derive(Clone, Debug, Default)]
pub struct Markdown {
    fence: Option<String>,
    table: Vec<String>,
}

impl Markdown {
    /// [line] (without its newline) as the lines it should look like at [width]; none while a
    /// table is still coming (its rows come out with the first line after it, or [Self::finish]).
    pub fn push(&mut self, line: &str, width: usize) -> Vec<String> {
        let trimmed = line.trim_start();
        if self.fence.is_none() && trimmed.starts_with('|') {
            self.table.push(trimmed.to_owned());
            return Vec::new();
        }
        let mut out = self.finish(width);
        out.extend(self.line(line, width));
        out
    }

    /// What is held back (a table), now.
    pub fn finish(&mut self, width: usize) -> Vec<String> {
        if self.table.is_empty() {
            return Vec::new();
        }
        table(&std::mem::take(&mut self.table), width)
    }

    /// How [partial] (a line still coming in) would look now, with what is held back before it;
    /// nothing changes.
    pub fn preview(&self, partial: &str, width: usize) -> Vec<String> {
        let mut md = self.clone();
        let mut out = md.finish(width);
        if !partial.is_empty() {
            let trimmed = partial.trim_start();
            if md.fence.is_none() && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
                out.push(style::faint(partial));
            } else if md.fence.is_some() {
                out.extend(md.line(partial, width));
            } else {
                // A mark still open shows as it will look once it closes.
                let mut line = partial.to_owned();
                if line.matches('`').count() % 2 == 1 {
                    line.push('`');
                } else if line.matches("**").count() % 2 == 1 {
                    line.push_str("**");
                }
                out.extend(md.line(&line, width));
            }
        }
        out
    }

    fn line(&mut self, line: &str, width: usize) -> Vec<String> {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```").or_else(|| trimmed.strip_prefix("~~~")) {
            return vec![match self.fence.take() {
                Some(_) => style::faint("  ╰────"),
                None => {
                    let lang = rest.trim().to_owned();
                    let label = if lang.is_empty() { String::new() } else { format!(" {} ", style::gray(&lang)) };
                    self.fence = Some(lang);
                    format!("{}{label}{}", style::faint("  ╭──"), style::faint("──"))
                }
            }];
        }
        if let Some(lang) = &self.fence {
            let gutter = style::faint("  │ ");
            return wrap(&tint(lang, &line.replace('\t', "    ")), width, &gutter, &gutter, false);
        }
        if trimmed.is_empty() {
            return vec![String::new()];
        }
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|c| *c == '#').count();
            if let Some(text) = trimmed[level..].strip_prefix(' ')
                && level <= 6
            {
                let text = inline(text.trim().trim_end_matches('#').trim_end());
                let shown = match level {
                    1 => style::bold(&style::underline(&text)),
                    2 => style::bold(&text),
                    _ => style::bold(&style::gray(&text)),
                };
                return wrap(&shown, width, "", "", true);
            }
        }
        let indent = &line[..line.len() - trimmed.len()];
        if matches!(trimmed, "---" | "***" | "___") {
            return vec![style::faint(&"─".repeat(width.clamp(8, 48)))];
        }
        if let Some(rest) = trimmed.strip_prefix("> ").or_else(|| (trimmed == ">").then_some("")) {
            let bar = format!("{} ", style::faint("▎"));
            return wrap(&style::italic(&inline(rest)), width, &bar, &bar, true);
        }
        let hang = |mark: &str, rest: &str| {
            let first = format!("{indent}{mark} ");
            let pad = " ".repeat(style::width(&first));
            wrap(&inline(rest), width, &first, &pad, true)
        };
        for bullet in ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] "] {
            if let Some(rest) = trimmed.strip_prefix(bullet) {
                let mark = if bullet.contains("[ ]") { style::faint("☐") } else { style::gray("☑") };
                return hang(&mark, rest);
            }
        }
        for bullet in ["- ", "* ", "+ "] {
            if let Some(rest) = trimmed.strip_prefix(bullet) {
                return hang(&style::gray("•"), rest);
            }
        }
        let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
        if digits > 0
            && let Some(rest) = trimmed[digits..].strip_prefix(". ").or_else(|| trimmed[digits..].strip_prefix(") "))
        {
            return hang(&style::gray(&trimmed[..=digits]), rest);
        }
        wrap(&inline(trimmed), width, indent, indent, true)
    }

    /// Inside a code fence now.
    pub fn in_code(&self) -> bool {
        self.fence.is_some()
    }
}

/// Table rows (`| a | b |`) aligned, with a rule under the header; as they came when they do not
/// fit the width.
fn table(rows: &[String], width: usize) -> Vec<String> {
    let cells = |row: &str| -> Vec<String> {
        let inner = row.trim().trim_start_matches('|').trim_end_matches('|');
        inner.split('|').map(|c| c.trim().to_owned()).collect()
    };
    let is_rule = |row: &str| row.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '));
    let parsed: Vec<(bool, Vec<String>)> = rows.iter().map(|r| (is_rule(r), cells(r))).collect();
    let columns = parsed.iter().map(|(_, c)| c.len()).max().unwrap_or(0);
    let mut widths = vec![0; columns];
    for (rule, row) in &parsed {
        if !rule {
            for (i, cell) in row.iter().enumerate() {
                widths[i] = widths[i].max(style::width(&inline(cell)));
            }
        }
    }
    let total: usize = widths.iter().sum::<usize>() + 3 * columns.saturating_sub(1) + 2;
    if total > width || columns == 0 {
        return rows.iter().map(|r| inline(r)).collect();
    }
    let header = parsed.iter().any(|(rule, _)| *rule);
    let mut out = Vec::new();
    for (n, (rule, row)) in parsed.iter().enumerate() {
        if *rule {
            let line: Vec<String> = widths.iter().map(|w| "─".repeat(*w)).collect();
            out.push(style::faint(&format!("  {}", line.join("─┼─"))));
            continue;
        }
        let shown: Vec<String> = (0..columns)
            .map(|i| {
                let text = inline(row.get(i).map_or("", String::as_str));
                let text = if header && n == 0 { style::bold(&text) } else { text };
                let pad = widths[i].saturating_sub(style::width(&text));
                format!("{text}{}", " ".repeat(pad))
            })
            .collect();
        out.push(format!("  {}", shown.join(&style::faint(" │ "))).trim_end().to_owned());
    }
    out
}

const KEYWORDS: &[&str] = &[
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "crate",
    "def",
    "default",
    "defer",
    "del",
    "do",
    "elif",
    "else",
    "enum",
    "except",
    "export",
    "extends",
    "extern",
    "false",
    "fi",
    "finally",
    "fn",
    "for",
    "from",
    "func",
    "function",
    "go",
    "if",
    "impl",
    "import",
    "in",
    "interface",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "new",
    "nil",
    "None",
    "null",
    "package",
    "pass",
    "pub",
    "raise",
    "return",
    "self",
    "Self",
    "static",
    "struct",
    "super",
    "switch",
    "then",
    "this",
    "throw",
    "trait",
    "True",
    "False",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "unsafe",
    "use",
    "val",
    "var",
    "void",
    "where",
    "while",
    "with",
    "yield",
    "done",
    "esac",
    "local",
    "echo",
];

/// A line of code in [lang], lightly tinted: keywords, strings, numbers, comments. Diffs get
/// their added and removed colors.
pub fn tint(lang: &str, line: &str) -> String {
    let lang = lang.to_ascii_lowercase();
    if matches!(lang.as_str(), "diff" | "patch") {
        return if line.starts_with('+') {
            style::green(line)
        } else if line.starts_with('-') {
            style::removed(line)
        } else if line.starts_with("@@") {
            style::faint(line)
        } else {
            line.to_owned()
        };
    }
    if matches!(lang.as_str(), "" | "text" | "txt" | "plain" | "console" | "output" | "log") {
        return style::code(line);
    }
    let hash = matches!(
        lang.as_str(),
        "sh" | "bash"
            | "zsh"
            | "shell"
            | "fish"
            | "py"
            | "python"
            | "rb"
            | "ruby"
            | "toml"
            | "yaml"
            | "yml"
            | "make"
            | "makefile"
            | "dockerfile"
            | "r"
            | "perl"
            | "nix"
            | "conf"
            | "ini"
    );
    let dashes = matches!(lang.as_str(), "sql" | "lua" | "haskell" | "hs");
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let rest = || chars[i..].iter().collect::<String>();
        let comment = (!hash && !dashes && c == '/' && chars.get(i + 1) == Some(&'/'))
            || (hash && c == '#' && (i == 0 || chars[i - 1].is_whitespace()))
            || (dashes && c == '-' && chars.get(i + 1) == Some(&'-'));
        if comment {
            out.push_str(&style::faint(&style::italic(&rest())));
            break;
        }
        if c == '"' || c == '`' || (c == '\'' && lang != "rust" && lang != "rs") {
            let end = (i + 1..chars.len()).find(|&j| chars[j] == c && chars[j - 1] != '\\');
            let end = end.unwrap_or(chars.len() - 1);
            out.push_str(&style::string(&chars[i..=end].iter().collect::<String>()));
            i = end + 1;
            continue;
        }
        if c.is_ascii_digit() && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')) {
            let end =
                (i..chars.len()).find(|&j| !(chars[j].is_ascii_alphanumeric() || chars[j] == '.' || chars[j] == '_'));
            let end = end.unwrap_or(chars.len());
            out.push_str(&style::number(&chars[i..end].iter().collect::<String>()));
            i = end;
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let end =
                (i..chars.len()).find(|&j| !(chars[j].is_alphanumeric() || chars[j] == '_')).unwrap_or(chars.len());
            let word: String = chars[i..end].iter().collect();
            if KEYWORDS.contains(&word.as_str()) {
                out.push_str(&style::keyword(&word));
            } else {
                out.push_str(&word);
            }
            i = end;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Inline marks: `code`, **bold**, *italic* / _italic_, ~~struck~~, [text](url).
pub fn inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let find = |from: usize, close: &[char]| -> Option<usize> {
        (from..chars.len()).find(|&j| chars[j..].starts_with(close) && j > from)
    };
    while i < chars.len() {
        let c = chars[i];
        if c == '`'
            && let Some(end) = find(i + 1, &['`'])
        {
            out.push_str(&style::code(&chars[i + 1..end].iter().collect::<String>()));
            i = end + 1;
            continue;
        }
        if chars[i..].starts_with(&['*', '*'])
            && let Some(end) = find(i + 2, &['*', '*'])
        {
            out.push_str(&style::bold(&inline(&chars[i + 2..end].iter().collect::<String>())));
            i = end + 2;
            continue;
        }
        if chars[i..].starts_with(&['~', '~'])
            && let Some(end) = find(i + 2, &['~', '~'])
        {
            out.push_str(&style::gray(&chars[i + 2..end].iter().collect::<String>()));
            i = end + 2;
            continue;
        }
        // *x* or _x_, not inside a word (snake_case stays as it is).
        if (c == '*' || c == '_')
            && (i == 0 || !chars[i - 1].is_alphanumeric())
            && chars.get(i + 1).is_some_and(|n| !n.is_whitespace())
            && let Some(end) = find(i + 1, &[c])
            && chars.get(end + 1).is_none_or(|n| !n.is_alphanumeric())
        {
            out.push_str(&style::italic(&chars[i + 1..end].iter().collect::<String>()));
            i = end + 1;
            continue;
        }
        if c == '['
            && let Some(close) = find(i + 1, &[']'])
            && chars.get(close + 1) == Some(&'(')
            && let Some(end) = find(close + 2, &[')'])
        {
            let label: String = chars[i + 1..close].iter().collect();
            let url: String = chars[close + 2..end].iter().collect();
            out.push_str(&style::underline(&label));
            if url != label {
                out.push_str(&style::gray(&format!(" ({url})")));
            }
            i = end + 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Markdown, inline, tint};

    fn one(md: &mut Markdown, line: &str) -> String {
        md.push(line, 80).join("\n")
    }

    // Colors are off in tests (nothing turns them on), so the shapes show.
    #[test]
    fn lines_render_without_their_marks() {
        let mut md = Markdown::default();
        assert_eq!(one(&mut md, "## Changes"), "Changes");
        assert_eq!(one(&mut md, "- one `x` here"), "• one x here");
        assert_eq!(one(&mut md, "  * nested"), "  • nested");
        assert_eq!(one(&mut md, "2. second"), "2. second");
        assert_eq!(one(&mut md, "- [x] done"), "☑ done");
        assert_eq!(one(&mut md, "> quoted"), "▎ quoted");
        assert_eq!(one(&mut md, "```rust"), "  ╭── rust ──");
        assert!(md.in_code());
        assert_eq!(one(&mut md, "let **x** = 1;"), "  │ let **x** = 1;");
        assert_eq!(one(&mut md, "```"), "  ╰────");
        assert!(!md.in_code());
        assert_eq!(one(&mut md, "#not a heading"), "#not a heading");
    }

    #[test]
    fn lists_wrap_with_a_hanging_indent() {
        let mut md = Markdown::default();
        let lines = md.push("- a list item that is long enough to wrap", 20);
        assert_eq!(lines, ["• a list item that", "  is long enough to", "  wrap"]);
        let lines = md.push("10. numbered and long enough", 16);
        assert_eq!(lines, ["10. numbered and", "    long enough"]);
    }

    #[test]
    fn tables_come_out_aligned_after_their_last_row() {
        let mut md = Markdown::default();
        assert!(md.push("| name | size |", 80).is_empty());
        assert!(md.push("|---|---:|", 80).is_empty());
        assert!(md.push("| `a.rs` | 12 |", 80).is_empty());
        assert_eq!(md.preview("", 80).len(), 3, "a preview shows what is held");
        let lines = md.push("after", 80);
        assert_eq!(lines, ["  name │ size", "  ─────┼─────", "  a.rs │ 12", "after"]);
        assert!(md.finish(80).is_empty());
    }

    #[test]
    fn a_preview_changes_nothing() {
        let mut md = Markdown::default();
        md.push("```", 80);
        assert_eq!(md.preview("fn main", 80), ["  │ fn main"]);
        assert!(md.in_code());
        md.push("```", 80);
        assert_eq!(md.preview("the **length by", 80), ["the length by"], "an open mark is not shown");
        assert_eq!(md.preview("a `cod", 80), ["a cod"]);
    }

    #[test]
    fn inline_marks() {
        assert_eq!(inline("a **bold** and *it* and `c`"), "a bold and it and c");
        assert_eq!(inline("keep snake_case_names and 2*3*4"), "keep snake_case_names and 2*3*4");
        assert_eq!(inline("see [docs](https://x.dev)"), "see docs (https://x.dev)");
        assert_eq!(inline("unclosed `tick and **star"), "unclosed `tick and **star");
    }

    #[test]
    fn code_tint_keeps_the_text() {
        for (lang, line) in
            [("rust", "let x = \"a\" + 'b'; // note"), ("python", "def f(x): return 1  # one"), ("diff", "+added")]
        {
            assert_eq!(tint(lang, line), line, "without color the text is unchanged");
        }
    }
}
