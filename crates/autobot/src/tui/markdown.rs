//! Markdown in the terminal, a line at a time (answers stream in): headings, lists, quotes,
//! rules, fenced code, and inline code, bold, italics and links.

use super::style;

/// Where a stream of lines is: inside a code fence or not.
#[derive(Debug, Default)]
pub struct Markdown {
    fence: Option<String>,
}

impl Markdown {
    /// [line] (without its newline) as it should look.
    pub fn line(&mut self, line: &str) -> String {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```").or_else(|| trimmed.strip_prefix("~~~")) {
            return match self.fence.take() {
                Some(_) => style::gray("  ╰────"),
                None => {
                    let lang = rest.trim().to_owned();
                    let label = if lang.is_empty() { String::new() } else { format!(" {lang} ") };
                    self.fence = Some(lang);
                    style::gray(&format!("  ╭──{label}──"))
                }
            };
        }
        if self.fence.is_some() {
            return format!("{} {}", style::gray("  │"), style::code(line));
        }
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|c| *c == '#').count();
            if let Some(text) = trimmed[level..].strip_prefix(' ')
                && level <= 6
            {
                let text = inline(text.trim());
                return if level <= 2 { style::bold(&style::accent(&text)) } else { style::bold(&text) };
            }
        }
        let indent = &line[..line.len() - trimmed.len()];
        if matches!(trimmed, "---" | "***" | "___") {
            return style::gray(&"─".repeat(40));
        }
        if let Some(rest) = trimmed.strip_prefix("> ").or_else(|| (trimmed == ">").then_some("")) {
            return format!("{} {}", style::gray("▎"), style::italic(&inline(rest)));
        }
        for bullet in ["- [ ] ", "- [x] ", "- [X] "] {
            if let Some(rest) = trimmed.strip_prefix(bullet) {
                let mark = if bullet == "- [ ] " { "☐" } else { "☑" };
                return format!("{indent}{} {}", style::accent(mark), inline(rest));
            }
        }
        for bullet in ["- ", "* ", "+ "] {
            if let Some(rest) = trimmed.strip_prefix(bullet) {
                return format!("{indent}{} {}", style::accent("•"), inline(rest));
            }
        }
        let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
        if digits > 0
            && let Some(rest) = trimmed[digits..].strip_prefix(". ")
        {
            return format!("{indent}{} {}", style::accent(&trimmed[..=digits]), inline(rest));
        }
        format!("{indent}{}", inline(trimmed))
    }

    /// Inside a code fence now.
    pub fn in_code(&self) -> bool {
        self.fence.is_some()
    }
}

/// Inline marks: `code`, **bold**, *italic* / _italic_, [text](url).
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
    use super::{Markdown, inline};

    // Colors are off in tests (nothing turns them on), so the shapes show.
    #[test]
    fn lines_render_without_their_marks() {
        let mut md = Markdown::default();
        assert_eq!(md.line("## Changes"), "Changes");
        assert_eq!(md.line("- one `x` here"), "• one x here");
        assert_eq!(md.line("  * nested"), "  • nested");
        assert_eq!(md.line("2. second"), "2. second");
        assert_eq!(md.line("- [x] done"), "☑ done");
        assert_eq!(md.line("> quoted"), "▎ quoted");
        assert_eq!(md.line("```rust"), "  ╭── rust ──");
        assert!(md.in_code());
        assert_eq!(md.line("let **x** = 1;"), "  │ let **x** = 1;");
        assert_eq!(md.line("```"), "  ╰────");
        assert!(!md.in_code());
        assert_eq!(md.line("#not a heading"), "#not a heading");
    }

    #[test]
    fn inline_marks() {
        assert_eq!(inline("a **bold** and *it* and `c`"), "a bold and it and c");
        assert_eq!(inline("keep snake_case_names and 2*3*4"), "keep snake_case_names and 2*3*4");
        assert_eq!(inline("see [docs](https://x.dev)"), "see docs (https://x.dev)");
        assert_eq!(inline("unclosed `tick and **star"), "unclosed `tick and **star");
    }
}
