//! Answers are Markdown, as models write it. Each platform shows its own dialect: Slack's mrkdwn,
//! the HTML subset Telegram and Matrix take, or plain text (Signal, email). Long answers go out
//! in parts under the platform's limit, split at line breaks, with an open code block closed at
//! the end of a part and opened again in the next.

/// How one platform writes each piece.
struct Style {
    bold: (&'static str, &'static str),
    italic: (&'static str, &'static str),
    strike: (&'static str, &'static str),
    code: (&'static str, &'static str),
    link: fn(&str, &str) -> String,
    escape: fn(&str) -> String,
    heading: fn(&str) -> String,
    bullet: &'static str,
    /// A fenced block: its language and its (escaped) lines.
    fence: fn(&str, &str) -> String,
    quote: fn(&str) -> String,
}

fn same(text: &str) -> String {
    text.to_owned()
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn slack_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

const PLAIN: Style = Style {
    bold: ("", ""),
    italic: ("", ""),
    strike: ("", ""),
    code: ("", ""),
    link: |text, url| if text == url || text.is_empty() { url.to_owned() } else { format!("{text} ({url})") },
    escape: same,
    heading: same,
    bullet: "• ",
    fence: |_, body| body.to_owned(),
    quote: |line| format!("> {line}"),
};

const SLACK: Style = Style {
    bold: ("*", "*"),
    italic: ("_", "_"),
    strike: ("~", "~"),
    code: ("`", "`"),
    link: |text, url| {
        let url = url.replace('|', "%7C").replace('>', "%3E");
        if text.is_empty() || text == url { format!("<{url}>") } else { format!("<{url}|{text}>") }
    },
    escape: slack_escape,
    heading: |text| format!("*{text}*"),
    bullet: "• ",
    fence: |_, body| format!("```\n{body}\n```"),
    quote: |line| format!("> {line}"),
};

const HTML: Style = Style {
    bold: ("<b>", "</b>"),
    italic: ("<i>", "</i>"),
    strike: ("<s>", "</s>"),
    code: ("<code>", "</code>"),
    link: |text, url| {
        let url = url.replace('"', "%22");
        format!("<a href=\"{url}\">{}</a>", if text.is_empty() { html_escape(&url) } else { text.to_owned() })
    },
    escape: html_escape,
    heading: |text| format!("<b>{text}</b>"),
    bullet: "• ",
    fence: |lang, body| {
        let lang: String = lang.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '+').collect();
        if lang.is_empty() {
            format!("<pre>{body}</pre>")
        } else {
            format!("<pre><code class=\"language-{lang}\">{body}</code></pre>")
        }
    },
    quote: |line| format!("<blockquote>{line}</blockquote>"),
};

const WHATSAPP: Style = Style {
    bold: ("*", "*"),
    italic: ("_", "_"),
    strike: ("~", "~"),
    code: ("`", "`"),
    link: |text, url| if text == url || text.is_empty() { url.to_owned() } else { format!("{text} ({url})") },
    escape: same,
    heading: |text| format!("*{text}*"),
    bullet: "• ",
    fence: |_, body| format!("```\n{body}\n```"),
    quote: |line| format!("> {line}"),
};

/// WhatsApp's formatting: `*bold*`, `_italic_`, `~strike~`, code; links as `text (url)`.
pub fn to_whatsapp(markdown: &str) -> String {
    render(markdown, &WHATSAPP)
}

/// Plain text: no markup left, links as `text (url)`.
pub fn to_plain(markdown: &str) -> String {
    render(markdown, &PLAIN)
}

/// Slack's mrkdwn.
pub fn to_slack(markdown: &str) -> String {
    render(markdown, &SLACK)
}

/// The HTML subset Telegram (`parse_mode: HTML`) and Matrix (`formatted_body`) show.
pub fn to_html(markdown: &str) -> String {
    render(markdown, &HTML)
}

fn render(markdown: &str, style: &Style) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fence: Option<(String, Vec<String>)> = None;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```") {
            match fence.take() {
                Some((lang, body)) => {
                    let body: Vec<String> = body.iter().map(|l| (style.escape)(l)).collect();
                    out.push((style.fence)(&lang, &body.join("\n")));
                }
                None => fence = Some((rest.trim().to_owned(), Vec::new())),
            }
            continue;
        }
        if let Some((_, body)) = &mut fence {
            body.push(line.to_owned());
            continue;
        }
        out.push(block(line, style));
    }
    // A block never closed: shown as one anyway.
    if let Some((lang, body)) = fence {
        let body: Vec<String> = body.iter().map(|l| (style.escape)(l)).collect();
        out.push((style.fence)(&lang, &body.join("\n")));
    }
    out.join("\n")
}

/// One line outside a code block.
fn block(line: &str, style: &Style) -> String {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    if let Some(level) = (1..=6).find(|n| trimmed.starts_with(&format!("{} ", "#".repeat(*n)))) {
        return (style.heading)(&inline(trimmed[level + 1..].trim(), style));
    }
    if let Some(rest) = trimmed.strip_prefix("> ").or_else(|| (trimmed == ">").then_some("")) {
        return (style.quote)(&inline(rest, style));
    }
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(bullet) {
            return format!("{indent}{}{}", style.bullet, inline(rest, style));
        }
    }
    if trimmed.chars().all(|c| c == '-' || c == '*' || c == '_') && trimmed.len() >= 3 {
        return "──────".to_owned();
    }
    format!("{}{}", (style.escape)(indent), inline(trimmed, style))
}

/// Code spans, links, bold, italic and strike-through in one line.
fn inline(text: &str, style: &Style) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut plain = String::new();
    let mut i = 0;
    let flush = |plain: &mut String, out: &mut String| {
        out.push_str(&(style.escape)(plain));
        plain.clear();
    };
    let find = |from: usize, marker: &[char]| -> Option<usize> {
        (from..chars.len().saturating_sub(marker.len() - 1)).find(|&j| chars[j..j + marker.len()] == *marker)
    };
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        // `code`
        if c == '`'
            && let Some(end) = find(i + 1, &['`'])
        {
            flush(&mut plain, &mut out);
            let code: String = chars[i + 1..end].iter().collect();
            out.push_str(style.code.0);
            out.push_str(&(style.escape)(&code));
            out.push_str(style.code.1);
            i = end + 1;
            continue;
        }
        // [text](url)
        if c == '['
            && let Some(close) = find(i + 1, &[']'])
            && chars.get(close + 1) == Some(&'(')
            && let Some(end) = find(close + 2, &[')'])
        {
            let url: String = chars[close + 2..end].iter().collect();
            if !url.contains(' ') && !url.is_empty() {
                flush(&mut plain, &mut out);
                let label: String = chars[i + 1..close].iter().collect();
                out.push_str(&(style.link)(&inline(&label, style), &url));
                i = end + 1;
                continue;
            }
        }
        // **bold**, __bold__, ~~strike~~
        if let Some(n) = next
            && (c == '*' || c == '_' || c == '~')
            && n == c
            && chars.get(i + 2).is_some_and(|c| !c.is_whitespace())
            && let Some(end) = find(i + 2, &[c, c])
            && end > i + 2
        {
            flush(&mut plain, &mut out);
            let inner: String = chars[i + 2..end].iter().collect();
            let (open, close) = if c == '~' { style.strike } else { style.bold };
            out.push_str(open);
            out.push_str(&inline(&inner, style));
            out.push_str(close);
            i = end + 2;
            continue;
        }
        // *italic*, _italic_ (not inside a word: snake_case stays)
        if (c == '*' || c == '_')
            && next.is_some_and(|n| !n.is_whitespace() && n != c)
            && (i == 0 || !chars[i - 1].is_alphanumeric())
            && let Some(end) = find(i + 1, &[c])
            && !chars[end - 1].is_whitespace()
            && chars.get(end + 1).is_none_or(|a| !a.is_alphanumeric())
        {
            flush(&mut plain, &mut out);
            let inner: String = chars[i + 1..end].iter().collect();
            out.push_str(style.italic.0);
            out.push_str(&inline(&inner, style));
            out.push_str(style.italic.1);
            i = end + 1;
            continue;
        }
        plain.push(c);
        i += 1;
    }
    flush(&mut plain, &mut out);
    out
}

/// Splits [text] into parts of at most [limit] characters, at line breaks where it can. A code
/// block cut in two is closed at the end of a part and opened again at the start of the next.
pub fn split(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(16);
    let mut parts = Vec::new();
    let mut rest = text.to_owned();
    // Room for the fence a part may need to close and reopen.
    let room = limit - 8;
    while rest.chars().count() > limit {
        let cut = rest.char_indices().nth(room).map_or(rest.len(), |(i, _)| i);
        let at = rest[..cut].rfind('\n').filter(|&i| i > cut / 2).unwrap_or(cut);
        let mut part = rest[..at].to_owned();
        let mut next = rest[at..].trim_start_matches('\n').to_owned();
        let open = part.lines().filter(|l| l.trim_start().starts_with("```")).count() % 2 == 1;
        if open {
            let lang = part
                .lines()
                .rev()
                .find(|l| l.trim_start().starts_with("```"))
                .map(|l| l.trim_start().trim_start_matches('`').trim().to_owned())
                .unwrap_or_default();
            part.push_str("\n```");
            next = format!("```{lang}\n{next}");
        }
        parts.push(part);
        rest = next;
    }
    if !rest.is_empty() || parts.is_empty() {
        parts.push(rest);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# Done\n\nI changed **two** files, see [the PR](https://x.org/pr/1) and `src/main.rs`.\n\n- one_thing *now*\n- ~~old~~ <new>\n\n```rust\nlet a = b && c;\n```\n> quoted";

    #[test]
    fn slack_mrkdwn() {
        let out = to_slack(SAMPLE);
        assert_eq!(
            out,
            "*Done*\n\nI changed *two* files, see <https://x.org/pr/1|the PR> and `src/main.rs`.\n\n• one_thing _now_\n• ~old~ &lt;new&gt;\n\n```\nlet a = b &amp;&amp; c;\n```\n> quoted"
        );
    }

    #[test]
    fn whatsapp_formatting() {
        assert_eq!(
            to_whatsapp(SAMPLE),
            "*Done*\n\nI changed *two* files, see the PR (https://x.org/pr/1) and `src/main.rs`.\n\n• one_thing _now_\n• ~old~ <new>\n\n```\nlet a = b && c;\n```\n> quoted"
        );
    }

    #[test]
    fn html_for_telegram_and_matrix() {
        let out = to_html(SAMPLE);
        assert!(out.starts_with("<b>Done</b>\n\nI changed <b>two</b> files, see <a href=\"https://x.org/pr/1\">the PR</a> and <code>src/main.rs</code>."), "{out}");
        assert!(out.contains("• <s>old</s> &lt;new&gt;"));
        assert!(out.contains("<pre><code class=\"language-rust\">let a = b &amp;&amp; c;</code></pre>"));
        assert!(out.ends_with("<blockquote>quoted</blockquote>"));
        assert_eq!(to_html("a < b"), "a &lt; b");
    }

    #[test]
    fn plain_text_drops_markup() {
        let out = to_plain(SAMPLE);
        assert!(out.starts_with("Done\n\nI changed two files, see the PR (https://x.org/pr/1) and src/main.rs."));
        assert!(out.contains("• one_thing now"), "snake_case stays: {out}");
        assert!(out.contains("let a = b && c;"));
        assert!(!out.contains("```"));
        assert_eq!(to_plain("2 * 3 * 4"), "2 * 3 * 4", "a lone star is not italic");
        assert_eq!(to_plain("[https://a.b](https://a.b)"), "https://a.b");
    }

    #[test]
    fn long_text_splits_under_the_limit() {
        assert_eq!(split("hi", 100), vec!["hi"]);
        let long = format!("{}\n{}", "a".repeat(60), "b".repeat(60));
        assert_eq!(split(&long, 100), vec!["a".repeat(60), "b".repeat(60)]);
        let parts = split(&"é".repeat(250), 100);
        assert!(parts.len() >= 3);
        assert!(parts.iter().all(|p| p.chars().count() <= 100));
        assert_eq!(parts.concat(), "é".repeat(250));
    }

    #[test]
    fn a_code_block_cut_in_two_stays_a_code_block() {
        let code: Vec<String> = (0..40).map(|n| format!("line {n}")).collect();
        let text = format!("Here:\n```sh\n{}\n```\nDone.", code.join("\n"));
        let parts = split(&text, 120);
        assert!(parts.len() > 2);
        for part in &parts {
            assert!(part.chars().count() <= 120, "{part}");
            assert_eq!(part.matches("```").count() % 2, 0, "balanced: {part}");
        }
        assert!(parts[1].starts_with("```sh\n"));
    }
}
