//! `edit_file`'s matching: an exact match first; when there is none, the same lines with the
//! whitespace a model gets wrong most often (at line ends, a file's `\r\n`, the indentation of
//! the whole block) taken as it is in the file, when that finds one place only; and when
//! nothing matches, the lines that come closest, so the next try can be right without reading
//! the file again.

/// How a match was found, when it was not exact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loose {
    /// The file's line breaks are `\r\n`, the text's `\n`.
    LineBreaks,
    /// Spaces and tabs at line ends.
    LineEnds,
    /// The whole block indented differently (the replacement is indented as the file is).
    Indentation,
}

impl Loose {
    pub fn describe(self) -> &'static str {
        match self {
            Self::LineBreaks => "matched with the file's \\r\\n line breaks",
            Self::LineEnds => "matched ignoring spaces at line ends",
            Self::Indentation => "matched with the file's indentation, and the new text indented the same",
        }
    }
}

/// [text] with [old] replaced by [new] (every match with [all], else exactly one), how many
/// there were, and how they were found when not exactly. `Err(n)`: no single match (n = 0:
/// none; more: that many, and not [all]).
pub fn apply(text: &str, old: &str, new: &str, all: bool) -> Result<(String, usize, Option<Loose>), usize> {
    let found = text.matches(old).count();
    if found == 1 || (found > 1 && all) {
        return Ok((text.replace(old, new), found, None));
    }
    if found > 1 {
        return Err(found);
    }
    // The file's line breaks.
    if text.contains("\r\n") && old.contains('\n') && !old.contains("\r\n") {
        let old = old.replace('\n', "\r\n");
        // The new text's breaks made the file's too (whether it had them already or not).
        let new = new.replace("\r\n", "\n").replace('\n', "\r\n");
        let found = text.matches(old.as_str()).count();
        if found == 1 || (found > 1 && all) {
            return Ok((text.replace(old.as_str(), &new), found, Some(Loose::LineBreaks)));
        }
    }
    // Whole lines, compared loosely: one place only (never several, even with [all]).
    match by_lines(text, old, new) {
        Some(done) => Ok(done),
        None => Err(0),
    }
}

/// [text] without one line break at its end; and whether it had one.
fn strip_break(text: &str) -> (&str, bool) {
    match text.strip_suffix('\n') {
        Some(rest) => (rest.strip_suffix('\r').unwrap_or(rest), true),
        None => (text, false),
    }
}

/// Text in [new] whose lines must stay as they are (a multi-line string, a heredoc): it cannot
/// be indented again without changing what it says.
fn literal(new: &str) -> bool {
    new.contains('\n') && ["\"\"\"", "\'\'\'", "`", "<<"].iter().any(|m| new.contains(m))
}

/// The lines of [text] that [old]'s lines match once without their line-end spaces, or with
/// only their indentation changed by the same amount everywhere; replaced by [new]'s. When
/// [old] ends with a line break, so does what it matched (the break is replaced too, as an
/// exact match would); when that cannot be done exactly, nothing is.
fn by_lines(text: &str, old: &str, new: &str) -> Option<(String, usize, Option<Loose>)> {
    let (body, old_breaks) = strip_break(old);
    let old_lines: Vec<&str> = body.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    if old_lines.iter().all(|l| l.trim().is_empty()) {
        return None;
    }
    // Each line of the file: where it starts, where its text ends, and where its line break does.
    let mut spans = Vec::new();
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches('\n').trim_end_matches('\r');
        spans.push((start, start + body.len(), start + line.len()));
        start += line.len();
    }
    let line = |i: usize| &text[spans[i].0..spans[i].1];
    let n = old_lines.len();
    if n > spans.len() {
        return None;
    }
    for loose in [Loose::LineEnds, Loose::Indentation] {
        let mut places = Vec::new();
        for at in 0..=spans.len() - n {
            let matched = match loose {
                Loose::LineEnds => (0..n).all(|k| line(at + k).trim_end() == old_lines[k].trim_end()),
                _ => shift(&(0..n).map(|k| line(at + k)).collect::<Vec<_>>(), &old_lines).is_some(),
            };
            if matched {
                places.push(at);
                if places.len() > 1 {
                    break;
                }
            }
        }
        let [at] = places[..] else {
            if places.len() > 1 {
                return None;
            }
            continue;
        };
        let last = spans[at + n - 1];
        // The old text ends with a line break; the file's last matched line must have one.
        if old_breaks && last.2 == last.1 {
            return None;
        }
        // The line break of the matched lines (a file can mix them).
        let brk = (at..at + n)
            .chain(at.checked_sub(1))
            .find(|&i| spans[i].2 > spans[i].1)
            .map_or("\n", |i| &text[spans[i].1..spans[i].2]);
        let new = new.replace("\r\n", "\n");
        let new = match loose {
            Loose::Indentation => {
                if literal(&new) {
                    return None;
                }
                let file_lines: Vec<&str> = (0..n).map(|k| line(at + k)).collect();
                let (add, remove) = shift(&file_lines, &old_lines)?;
                new.split('\n')
                    .map(|l| {
                        if l.trim().is_empty() {
                            return l.to_owned();
                        }
                        let l = l.strip_prefix(remove.as_str()).unwrap_or(l);
                        format!("{add}{l}")
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            _ => new,
        };
        let replacement = if brk == "\n" { new } else { new.replace('\n', brk) };
        let (from, to) = (spans[at].0, if old_breaks { last.2 } else { last.1 });
        let mut out = String::with_capacity(text.len() + replacement.len());
        out.push_str(&text[..from]);
        out.push_str(&replacement);
        out.push_str(&text[to..]);
        if out == text {
            return None;
        }
        return Some((out, 1, Some(loose)));
    }
    None
}

/// How [file] lines are indented against [old] ones when only that differs, by the same amount
/// on every line that has text: (what the file has more, what the old text has more).
fn shift(file: &[&str], old: &[&str]) -> Option<(String, String)> {
    let indent = |l: &str| l.len() - l.trim_start().len();
    let first = old.iter().position(|l| !l.trim().is_empty())?;
    let (f, o) = (file[first], old[first]);
    let (fi, oi) = (&f[..indent(f)], &o[..indent(o)]);
    let (add, remove) = if let Some(add) = fi.strip_suffix(oi) {
        (add.to_owned(), String::new())
    } else if let Some(remove) = oi.strip_suffix(fi) {
        (String::new(), remove.to_owned())
    } else {
        return None;
    };
    if add.is_empty() && remove.is_empty() {
        return None;
    }
    for (f, o) in file.iter().zip(old) {
        if o.trim().is_empty() {
            if !f.trim().is_empty() {
                return None;
            }
            continue;
        }
        let o = o.trim_end();
        let o = o.strip_prefix(remove.as_str())?;
        if f.trim_end() != format!("{add}{o}") {
            return None;
        }
    }
    Some((add, remove))
}

/// Longest line [closest] compares by similarity (longer ones only when equal).
const CLOSEST_MAX: usize = 2000;
/// How long [closest] may look, in all.
const CLOSEST_TIME: std::time::Duration = std::time::Duration::from_millis(200);

/// Where [text] comes closest to [old]: its line number and those lines (as many as [old] has,
/// at most 12), when something is close at all. Bounded: only lines of about the needle's
/// length are compared (no other can come close), each comparison and the whole search with a
/// time limit, so one long line (minified code, a log) cannot stall it.
pub fn closest(text: &str, old: &str) -> Option<(usize, String)> {
    let old_lines: Vec<&str> = old.lines().filter(|l| !l.trim().is_empty()).collect();
    let first = old_lines.first()?.trim();
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > 20_000 {
        return None;
    }
    // A ratio of 0.6 needs the shorter at least 0.43 of the longer: 2m / (a + b) <= 2a / (a + b).
    let (low, high) = (first.len() * 2 / 5, (first.len() * 5 / 2).max(1));
    let deadline = std::time::Instant::now() + CLOSEST_TIME;
    let mut best = (0.0f32, 0usize);
    for (i, line) in lines.iter().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let score = if line == first {
            1.0
        } else if line.len() < low || line.len() > high || line.len() > CLOSEST_MAX || first.len() > CLOSEST_MAX {
            continue;
        } else {
            similar::TextDiff::configure().timeout(std::time::Duration::from_millis(5)).diff_chars(line, first).ratio()
        };
        if score > best.0 {
            best = (score, i);
            if score == 1.0 {
                break;
            }
        }
        if std::time::Instant::now() > deadline {
            break;
        }
    }
    if best.0 < 0.6 {
        return None;
    }
    let count = old.lines().count().clamp(1, 12);
    let end = (best.1 + count).min(lines.len());
    let shown: Vec<String> =
        (best.1..end).map(|i| format!("{:>5}  {}", i + 1, lines[i].chars().take(300).collect::<String>())).collect();
    Some((best.1 + 1, shown.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::{Loose, apply, closest};

    #[test]
    fn exact_matches_come_first_and_must_be_unique() {
        assert_eq!(apply("a b a", "b", "c", false), Ok(("a c a".into(), 1, None)));
        assert_eq!(apply("a b a", "a", "c", false), Err(2));
        assert_eq!(apply("a b a", "a", "c", true), Ok(("c b c".into(), 2, None)));
        assert_eq!(apply("a b a", "z", "c", false), Err(0));
    }

    #[test]
    fn spaces_at_line_ends_and_crlf_are_forgiven_once() {
        let text = "fn a() {   \n    one();\n}\n";
        let (out, n, loose) = apply(text, "fn a() {\n    one();\n}", "fn a() {\n    two();\n}", false).unwrap();
        assert_eq!((out.as_str(), n, loose), ("fn a() {\n    two();\n}\n", 1, Some(Loose::LineEnds)));
        let crlf = "x = 1\r\ny = 2\r\n";
        let (out, _, loose) = apply(crlf, "x = 1\ny = 2", "x = 3\ny = 4", false).unwrap();
        assert_eq!((out.as_str(), loose), ("x = 3\r\ny = 4\r\n", Some(Loose::LineBreaks)));
        // Two loose places: not guessed.
        assert_eq!(apply("a \nb\na\t\nb\n", "a\nb", "c", false), Err(0));
    }

    #[test]
    fn a_block_indented_differently_is_found_and_the_new_one_indented_alike() {
        let text = "class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        return 2\n";
        let (out, _, loose) =
            apply(text, "def f(self):\n    return 1", "def f(self):\n    x = 1\n    return x", false).unwrap();
        assert_eq!(loose, Some(Loose::Indentation));
        assert_eq!(
            out,
            "class A:\n    def f(self):\n        x = 1\n        return x\n\n    def g(self):\n        return 2\n"
        );
        // Indented too much: taken off the same way.
        let (out, _, _) = apply("if x:\n  y()\n", "    if x:\n      y()", "    if x:\n      z()", false).unwrap();
        assert_eq!(out, "if x:\n  z()\n");
        // Uneven changes are not a shift.
        assert_eq!(apply("a\n  b\n", "  a\nb", "q", false), Err(0));
    }

    #[test]
    fn the_closest_lines_are_shown_with_their_numbers() {
        let text = "one\ntwo\nfn compute_total(items) {\n    sum(items)\n}\n";
        let (line, shown) = closest(text, "fn compute_totl(items) {\n    sum(itms)\n}").unwrap();
        assert_eq!(line, 3);
        assert!(shown.starts_with("    3  fn compute_total(items) {"), "{shown}");
        assert_eq!(shown.lines().count(), 3);
        assert!(closest(text, "nothing like it at all here").is_none());
    }

    #[test]
    fn one_very_long_line_does_not_stall_the_closest_lines() {
        let text = format!("short\n{}\nfn main() {{}}\n", "x".repeat(200_000));
        let started = std::time::Instant::now();
        let found = closest(&text, "fn mian() {}");
        assert!(started.elapsed() < std::time::Duration::from_millis(500), "{:?}", started.elapsed());
        assert_eq!(found.map(|f| f.0), Some(3));
        let needle = "y".repeat(10_000);
        let started = std::time::Instant::now();
        let _ = closest(&format!("{}\n", "y".repeat(10_001)).repeat(50), &needle);
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
    }

    #[test]
    fn line_breaks_at_the_end_go_as_an_exact_match_would() {
        // A line taken out with its break.
        assert_eq!(apply("a\nfoo  \nb\n", "foo\n", "", false).unwrap().0, "a\nb\n");
        assert_eq!(apply("a\nfoo  \nbar \nb\n", "foo\nbar\n", "", false).unwrap().0, "a\nb\n");
        assert_eq!(apply("a\nfoo  \nb\n", "foo\n", "baz\n", false).unwrap().0, "a\nbaz\nb\n");
        // The blank line after it is part of what is matched.
        assert_eq!(apply("foo \n\nbar\n", "foo\n\n", "foo\n", false).unwrap().0, "foo\nbar\n");
        // Indented differently, with its break.
        let (out, _, loose) = apply("if x:\n    y()\nz\n", "      y()\n", "", false).unwrap();
        assert_eq!((out.as_str(), loose), ("if x:\nz\n", Some(Loose::Indentation)));
        // A break the file does not have at its end: not guessed.
        assert_eq!(apply("a\nfoo  ", "foo\n", "", false), Err(0));
        // A change that changes nothing is not a success.
        assert_eq!(apply("foo \nbar\n", "foo\nbar", "foo \nbar", false), Err(0));
    }

    #[test]
    fn line_breaks_come_from_the_lines_matched() {
        // The new text already has \r\n: not doubled.
        let (out, _, _) = apply("x = 1\r\ny = 2\r\n", "x = 1\ny = 2", "x = 3\r\ny = 4", false).unwrap();
        assert_eq!(out, "x = 3\r\ny = 4\r\n");
        // A file with both: the matched lines' kind.
        let mixed = "a\r\nb\r\nc  \nd\ne\n";
        let (out, _, _) = apply(mixed, "c\nd", "C\nD", false).unwrap();
        assert_eq!(out, "a\r\nb\r\nC\nD\ne\n");
        let (out, _, _) = apply("a  \r\nb\r\nc\n", "a\nb", "A\nB", false).unwrap();
        assert_eq!(out, "A\r\nB\r\nc\n");
    }

    #[test]
    fn multi_line_literals_are_not_indented_again() {
        let text = "def f():\n    x = 1\n    return x\n";
        let new = "x = \"\"\"\nkeep\n  as is\n\"\"\"\nreturn x";
        assert_eq!(apply(text, "x = 1\nreturn x", new, false), Err(0));
        assert_eq!(apply(text, "x = 1\nreturn x", "cat <<EOF\nhi\nEOF", false), Err(0));
        // Without one, it is.
        assert!(apply(text, "x = 1\nreturn x", "x = 2\nreturn x", false).is_ok());
    }
}
