//! The composer's text: several lines, a cursor, the usual editing keys (ctrl+a/e/w/u/k/y,
//! words with alt), history on ↑/↓ at the first and last line, ctrl+r searching the history back
//! as you type, and large pastes kept aside as `[pasted N lines]` until the message is sent.
//! Attached images stand in the text as `[image 1: shot.png 1280×720]`; like a paste's label,
//! backspace takes one whole.

use std::path::Path;

use unicode_width::UnicodeWidthChar;

use crate::images::Attachment;

/// Pastes longer than this many lines (or characters) are shown as one label.
const PASTE_LINES: usize = 4;
const PASTE_CHARS: usize = 800;

#[derive(Debug, Default)]
pub struct Editor {
    text: String,
    /// A byte index into [text], on a character boundary.
    cursor: usize,
    history: Vec<String>,
    /// Where ↑/↓ is in [history] (None: the draft), and the draft kept while browsing.
    browsing: Option<usize>,
    draft: String,
    /// Labels standing in for pastes this session, and what they stand for.
    pastes: Vec<(String, String)>,
    /// Labels standing in for images attached this session, and the images.
    images: Vec<(String, Attachment)>,
    /// What ctrl+w/u/k took, for ctrl+y.
    killed: String,
    /// ctrl+r: searching the history.
    search: Option<Search>,
}

/// A reverse search through the history (ctrl+r): what is typed, the entry it found, and what
/// the composer held before (esc puts it back).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Search {
    pub query: String,
    /// The history entry shown.
    pub found: Option<usize>,
    /// The last search found nothing (older): the entry shown stays.
    pub failed: bool,
    saved: (String, usize),
}

impl Editor {
    pub fn with_history(history: Vec<String>) -> Self {
        Self { history, ..Self::default() }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn history(&self) -> &[String] {
        &self.history
    }

    /// Replaces everything (a prefilled request, a completion).
    pub fn set(&mut self, text: &str) {
        text.clone_into(&mut self.text);
        self.cursor = self.text.len();
        self.browsing = None;
    }

    /// Replaces the bytes [range] with [with], the cursor after it.
    pub fn replace(&mut self, range: std::ops::Range<usize>, with: &str) {
        self.text.replace_range(range.clone(), with);
        self.cursor = range.start + with.len();
    }

    pub fn insert(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.browsing = None;
    }

    pub fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.browsing = None;
    }

    /// A paste: as it is when short, as a label when long.
    pub fn paste(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let lines = text.lines().count();
        if lines <= PASTE_LINES && text.chars().count() <= PASTE_CHARS {
            self.insert(&text);
            return;
        }
        let what = if lines > 1 { format!("{lines} lines") } else { format!("{} chars", text.chars().count()) };
        let base = format!("[pasted {what}");
        let n =
            self.pastes.iter().filter(|(l, _)| *l == format!("{base}]") || l.starts_with(&format!("{base} #"))).count();
        let label = if n == 0 { format!("[pasted {what}]") } else { format!("[pasted {what} #{}]", n + 1) };
        self.insert(&label);
        self.pastes.push((label, text));
    }

    /// The labels standing in for pastes and images (to show them quieter).
    pub fn labels(&self) -> impl Iterator<Item = &str> {
        self.pastes.iter().map(|(label, _)| label.as_str()).chain(self.images.iter().map(|(label, _)| label.as_str()))
    }

    /// Puts [image] in at the cursor, as its label (`[image N: name W×H]`, N counting this
    /// session's images); the label.
    pub fn attach(&mut self, image: Attachment) -> String {
        let label = match self.images.iter().find(|(_, a)| *a == image) {
            Some((label, _)) => label.clone(),
            None => {
                let label = image.label(self.images.len() + 1);
                self.images.push((label.clone(), image));
                label
            }
        };
        let before = self.before();
        let space = if before.is_empty() || before.ends_with(char::is_whitespace) { "" } else { " " };
        self.insert(&format!("{space}{label} "));
        label
    }

    /// The images [text] (as sent) names by their labels, in order, and the text with each label
    /// as the model sees it: `[image 1: shot.png]`, numbered in this message.
    pub fn images_in(&self, text: &str) -> (String, Vec<Attachment>) {
        let mut found: Vec<(usize, &str, &Attachment)> = Vec::new();
        for (label, image) in &self.images {
            found.extend(text.match_indices(label.as_str()).map(|(i, _)| (i, label.as_str(), image)));
        }
        found.sort_by_key(|(i, ..)| *i);
        let (mut out, mut images, mut at) = (String::new(), Vec::<Attachment>::new(), 0);
        for (i, label, image) in found {
            if i < at {
                continue;
            }
            out.push_str(&text[at..i]);
            let n = match images.iter().position(|a| a == image) {
                Some(k) => k + 1,
                None => {
                    images.push(image.clone());
                    images.len()
                }
            };
            out.push_str(&image.marker(n));
            at = i + label.len();
        }
        out.push_str(&text[at..]);
        (out, images)
    }

    fn before(&self) -> &str {
        &self.text[..self.cursor]
    }

    fn line_start(&self) -> usize {
        self.before().rfind('\n').map_or(0, |i| i + 1)
    }

    fn line_end(&self) -> usize {
        self.text[self.cursor..].find('\n').map_or(self.text.len(), |i| self.cursor + i)
    }

    pub fn left(&mut self) {
        if let Some(c) = self.before().chars().next_back() {
            self.cursor -= c.len_utf8();
        }
    }

    pub fn right(&mut self) {
        if let Some(c) = self.text[self.cursor..].chars().next() {
            self.cursor += c.len_utf8();
        }
    }

    pub fn home(&mut self) {
        self.cursor = self.line_start();
    }

    pub fn end(&mut self) {
        self.cursor = self.line_end();
    }

    /// Where the word before the cursor starts (spaces before it skipped).
    fn word_back(&self) -> usize {
        let before = self.before();
        let trimmed = before.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
        trimmed.rfind(|c: char| !c.is_alphanumeric() && c != '_').map_or(0, |i| i + 1)
    }

    fn word_forward(&self) -> usize {
        let after = &self.text[self.cursor..];
        let skip = after.find(|c: char| c.is_alphanumeric() || c == '_').unwrap_or(after.len());
        let rest = &after[skip..];
        let word = rest.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(rest.len());
        self.cursor + skip + word
    }

    pub fn word_left(&mut self) {
        self.cursor = self.word_back();
    }

    pub fn word_right(&mut self) {
        self.cursor = self.word_forward();
    }

    pub fn backspace(&mut self) {
        // A paste's or an image's label goes whole (with the space after an image's).
        let before = self.before();
        let image = self.images.iter().map(|(l, _)| format!("{l} ")).find(|l| before.ends_with(l.as_str()));
        let label = self.labels().find(|l| before.ends_with(l)).map(str::to_owned).or(image);
        if let Some(label) = label {
            let start = self.cursor - label.len();
            self.text.replace_range(start..self.cursor, "");
            self.cursor = start;
            return;
        }
        let start = self.cursor;
        self.left();
        self.text.replace_range(self.cursor..start, "");
    }

    pub fn delete(&mut self) {
        let start = self.cursor;
        if let Some(c) = self.text[start..].chars().next() {
            self.text.replace_range(start..start + c.len_utf8(), "");
        }
    }

    fn kill(&mut self, range: std::ops::Range<usize>) {
        if range.is_empty() {
            return;
        }
        self.killed = self.text[range.clone()].to_owned();
        self.text.replace_range(range.clone(), "");
        self.cursor = range.start;
    }

    /// ctrl+w: the word before the cursor.
    pub fn kill_word(&mut self) {
        self.kill(self.word_back()..self.cursor);
    }

    /// alt+d: the word after the cursor.
    pub fn kill_word_forward(&mut self) {
        self.kill(self.cursor..self.word_forward());
    }

    /// ctrl+u: back to the start of the line (the line break before it, at its start).
    pub fn kill_to_start(&mut self) {
        let start = self.line_start();
        let start = if start == self.cursor && start > 0 { start - 1 } else { start };
        self.kill(start..self.cursor);
    }

    /// ctrl+k: to the end of the line (the line break, at its end).
    pub fn kill_to_end(&mut self) {
        let end = self.line_end();
        let end = if end == self.cursor && end < self.text.len() { end + 1 } else { end };
        self.kill(self.cursor..end);
    }

    /// ctrl+y: what was killed last.
    pub fn yank(&mut self) {
        let killed = self.killed.clone();
        self.insert(&killed);
    }

    /// ↑: a line up, or the previous message at the first line. Whether anything moved.
    pub fn up(&mut self) -> bool {
        let start = self.line_start();
        if start > 0 {
            let column = self.text[start..self.cursor].chars().count();
            let prev_start = self.text[..start - 1].rfind('\n').map_or(0, |i| i + 1);
            self.cursor = at_column(&self.text, prev_start, start - 1, column);
            return true;
        }
        let next = match self.browsing {
            None if self.history.is_empty() => return false,
            None => {
                self.draft = self.text.clone();
                self.history.len() - 1
            }
            Some(0) => return false,
            Some(i) => i - 1,
        };
        self.browsing = Some(next);
        self.text = self.history[next].clone();
        // At the end of its first line, so another ↑ goes on back.
        self.cursor = self.text.find('\n').unwrap_or(self.text.len());
        true
    }

    /// ↓: a line down, or the next message (then the draft) at the last line.
    pub fn down(&mut self) -> bool {
        let end = self.line_end();
        if end < self.text.len() {
            let column = self.text[self.line_start()..self.cursor].chars().count();
            let next_end = self.text[end + 1..].find('\n').map_or(self.text.len(), |i| end + 1 + i);
            self.cursor = at_column(&self.text, end + 1, next_end, column);
            return true;
        }
        let Some(i) = self.browsing else { return false };
        if i + 1 < self.history.len() {
            self.browsing = Some(i + 1);
            self.text = self.history[i + 1].clone();
        } else {
            self.browsing = None;
            self.text = std::mem::take(&mut self.draft);
        }
        self.cursor = self.text.len();
        true
    }

    /// The search going on, if one is.
    pub fn searching(&self) -> Option<&Search> {
        self.search.as_ref()
    }

    /// ctrl+r: starts searching the history back; while searching, the next older match.
    pub fn search_back(&mut self) {
        let Some(search) = &self.search else {
            self.search = Some(Search { saved: (self.text.clone(), self.cursor), ..Search::default() });
            return;
        };
        let before = search.found.unwrap_or(self.history.len());
        let query = search.query.clone();
        self.find(&query, before, true);
    }

    /// A character typed into the search: the newest match from the one shown, it included.
    pub fn search_type(&mut self, c: char) {
        let Some(search) = &mut self.search else { return };
        search.query.push(c);
        let before = search.found.map_or(self.history.len(), |i| i + 1);
        let query = search.query.clone();
        self.find(&query, before, false);
    }

    /// Backspace in the search: the query a character shorter, searched again from the newest.
    pub fn search_backspace(&mut self) {
        let Some(search) = &mut self.search else { return };
        search.query.pop();
        let query = search.query.clone();
        if query.is_empty() {
            let (text, cursor) = search.saved.clone();
            search.found = None;
            search.failed = false;
            self.text = text;
            self.cursor = cursor;
            return;
        }
        self.find(&query, self.history.len(), false);
    }

    /// Shows the newest entry before [before] that has [query] ([skip_same]: and is not the one
    /// shown now); marks the search failed when there is none.
    fn find(&mut self, query: &str, before: usize, skip_same: bool) {
        let skip = skip_same.then(|| self.text.clone());
        let found = find_back(&self.history, query, before, skip.as_deref());
        let Some(search) = &mut self.search else { return };
        match found {
            Some((i, at)) => {
                search.found = Some(i);
                search.failed = false;
                self.text = self.history[i].clone();
                self.cursor = at;
            }
            None => search.failed = !query.is_empty(),
        }
    }

    /// Enter (or a key that edits): the entry found stays in the composer, to send or change.
    pub fn search_accept(&mut self) {
        self.search = None;
        self.browsing = None;
    }

    /// Esc: the composer as it was before the search.
    pub fn search_cancel(&mut self) {
        if let Some(search) = self.search.take() {
            (self.text, self.cursor) = search.saved;
        }
    }

    /// Empties the composer (what was in it is not kept).
    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.browsing = None;
    }

    /// What was typed, as it is shown (labels for pastes), and as it is sent (pastes in full); the
    /// composer emptied and the shown text added to the history.
    pub fn take(&mut self) -> (String, String) {
        self.take_as(true)
    }

    /// Like [Self::take], the history left as it is when not [keep] (an answer to a question).
    pub fn take_as(&mut self, keep: bool) -> (String, String) {
        self.search = None;
        let shown = std::mem::take(&mut self.text);
        // Pastes are kept for the session, so a message brought back with ↑ sends them again.
        // One pass over what is shown: a paste that holds a label's text is not expanded again.
        let mut sent = String::with_capacity(shown.len());
        let mut rest = shown.as_str();
        while let Some(i) = rest.find('[') {
            sent.push_str(&rest[..i]);
            rest = &rest[i..];
            match self.pastes.iter().filter(|(label, _)| rest.starts_with(label.as_str())).max_by_key(|(l, _)| l.len())
            {
                Some((label, text)) => {
                    sent.push_str(text);
                    rest = &rest[label.len()..];
                }
                None => {
                    sent.push('[');
                    rest = &rest[1..];
                }
            }
        }
        sent.push_str(rest);
        self.cursor = 0;
        self.browsing = None;
        if keep && !shown.trim().is_empty() && self.history.last() != Some(&shown) {
            self.history.push(shown.clone());
        }
        (shown, sent)
    }

    /// The text in rows of at most [width] columns (cut where they fall), and the cursor's row
    /// and column among them.
    pub fn layout(&self, width: usize) -> (Vec<String>, (usize, usize)) {
        let width = width.max(4);
        let mut rows = vec![String::new()];
        let mut used = 0;
        let mut cursor = (0, 0);
        for (i, c) in self.text.char_indices() {
            if i == self.cursor {
                cursor = (rows.len() - 1, used);
            }
            if c == '\n' {
                rows.push(String::new());
                used = 0;
                continue;
            }
            let w = c.width().unwrap_or(0);
            if used + w > width {
                rows.push(String::new());
                used = 0;
                if i == self.cursor {
                    cursor = (rows.len() - 1, 0);
                }
            }
            rows.last_mut().expect("a row").push(c);
            used += w;
        }
        if self.cursor >= self.text.len() {
            cursor = if used >= width { (rows.len(), 0) } else { (rows.len() - 1, used) };
            if cursor.0 == rows.len() {
                rows.push(String::new());
            }
        }
        (rows, cursor)
    }
}

/// The newest entry of [history] before index [before] that contains [query] (and is not
/// [skip]): its index, and the byte where the match starts. Smart case: a query without capitals
/// matches any case.
pub fn find_back(history: &[String], query: &str, before: usize, skip: Option<&str>) -> Option<(usize, usize)> {
    if query.is_empty() {
        return None;
    }
    let exact = query.chars().any(char::is_uppercase);
    history[..before.min(history.len())]
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, entry)| Some(entry.as_str()) != skip)
        .find_map(|(i, entry)| find_in(entry, query, exact).map(|at| (i, at)))
}

/// Where [needle] starts in [hay] (a byte index), ignoring case unless [exact].
fn find_in(hay: &str, needle: &str, exact: bool) -> Option<usize> {
    if exact {
        return hay.find(needle);
    }
    let same = |a: char, b: char| a == b || a.to_lowercase().eq(b.to_lowercase());
    hay.char_indices().map(|(i, _)| i).find(|&i| {
        let mut rest = hay[i..].chars();
        needle.chars().all(|n| rest.next().is_some_and(|h| same(h, n)))
    })
}

/// The byte index in `text[start..end]` at [column] characters (or its end).
fn at_column(text: &str, start: usize, end: usize, column: usize) -> usize {
    text[start..end].char_indices().nth(column).map_or(end, |(i, _)| start + i)
}

/// The history file (rustyline's format, so the old history carries over): `#V2`, then one
/// entry a line, `\n` and `\\` escaped.
pub fn load_history(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .filter(|l| *l != "#V2" && !l.is_empty())
        .map(|l| {
            let mut out = String::new();
            let mut chars = l.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => out.push('\n'),
                        Some(other) => out.push(other),
                        None => out.push('\\'),
                    }
                } else {
                    out.push(c);
                }
            }
            out
        })
        .collect()
}

pub fn save_history(path: &Path, history: &[String]) {
    let keep = &history[history.len().saturating_sub(2000)..];
    let mut text = String::from("#V2\n");
    for entry in keep {
        text.push_str(&entry.replace('\\', "\\\\").replace('\n', "\\n"));
        text.push('\n');
    }
    let _ = invincible::fsutil::replace_private(path, &text);
}

#[cfg(test)]
mod tests {
    use super::{Editor, find_back, load_history, save_history};

    fn typed(text: &str) -> Editor {
        let mut e = Editor::default();
        e.insert(text);
        e
    }

    #[test]
    fn editing_keys() {
        let mut e = typed("hello brave world");
        e.kill_word();
        assert_eq!(e.text(), "hello brave ");
        e.yank();
        assert_eq!(e.text(), "hello brave world");
        e.home();
        e.word_right();
        assert_eq!(e.cursor(), 5);
        e.kill_to_end();
        assert_eq!(e.text(), "hello");
        e.left();
        e.backspace();
        assert_eq!(e.text(), "helo");
        e.end();
        e.kill_to_start();
        assert!(e.is_empty());
        let mut e = typed("añb");
        e.left();
        e.left();
        e.backspace();
        assert_eq!(e.text(), "ñb", "characters, not bytes");
    }

    #[test]
    fn lines_and_history() {
        let mut e = Editor::with_history(vec!["first".into(), "second".into()]);
        e.insert("draft");
        assert!(e.up());
        assert_eq!(e.text(), "second");
        assert!(e.up());
        assert_eq!(e.text(), "first");
        assert!(!e.up(), "the oldest");
        assert!(e.down());
        assert!(e.down());
        assert_eq!(e.text(), "draft", "back to the draft");
        e.set("one\ntwo");
        assert!(e.up(), "a line up, not history");
        assert_eq!(e.text(), "one\ntwo");
        assert_eq!(e.cursor(), 3);
        e.kill_to_end();
        assert_eq!(e.text(), "onetwo", "ctrl+k at a line's end joins the next");
    }

    #[test]
    fn long_pastes_are_a_label_until_sent() {
        let mut e = typed("look: ");
        let big: String = (0..40).map(|i| format!("line {i}\n")).collect();
        e.paste(&big);
        assert_eq!(e.text(), "look: [pasted 40 lines]");
        e.paste("short");
        let (shown, sent) = e.take();
        assert_eq!(shown, "look: [pasted 40 lines]short");
        assert!(sent.starts_with("look: line 0\nline 1\n") && sent.ends_with("line 39\nshort"));
        assert_eq!(e.history(), ["look: [pasted 40 lines]short"]);
        assert!(e.up());
        assert_eq!(e.take().1, sent, "brought back, it sends the paste again");
        let mut e = typed("x ");
        e.paste(&big);
        e.backspace();
        assert_eq!(e.text(), "x ", "a label is deleted whole");
    }

    #[test]
    fn images_are_tokens_until_sent() {
        let shot = |name: &str| crate::images::Attachment {
            path: format!("/tmp/{name}").into(),
            name: name.into(),
            sha256: name.repeat(4),
            bytes: 10,
            mime: "image/png".into(),
            width: 1280,
            height: 720,
        };
        let mut e = typed("what is");
        assert_eq!(e.attach(shot("shot.png")), "[image 1: shot.png 1280×720]");
        e.insert("and");
        e.attach(shot("b.png"));
        e.insert("vs ");
        e.attach(shot("shot.png"));
        assert_eq!(
            e.text(),
            "what is [image 1: shot.png 1280×720] and [image 2: b.png 1280×720] vs [image 1: shot.png 1280×720] "
        );
        let (shown, sent) = e.take();
        assert_eq!(shown, sent, "pastes only are put back at take");
        let (text, images) = e.images_in(&sent);
        assert_eq!(text, "what is [image 1: shot.png] and [image 2: b.png] vs [image 1: shot.png] ");
        assert_eq!(images, vec![shot("shot.png"), shot("b.png")]);
        // Numbered in the message: the second image of the session alone is image 1 there.
        assert_eq!(e.images_in("[image 2: b.png 1280×720]").0, "[image 1: b.png]");
        assert_eq!(e.images_in("no images").1, vec![]);
        // Backspace takes a token whole, with its space.
        let mut e = typed("see ");
        e.attach(shot("shot.png"));
        e.backspace();
        assert_eq!(e.text(), "see ");
        e.attach(shot("shot.png"));
        e.left();
        e.backspace();
        assert_eq!(e.text(), "see  ");
    }

    #[test]
    fn layout_wraps_and_finds_the_cursor() {
        let e = typed("abcdefgh\nij");
        let (rows, cursor) = e.layout(5);
        assert_eq!(rows, ["abcde", "fgh", "ij"]);
        assert_eq!(cursor, (2, 2));
        let e = typed("abcde");
        assert_eq!(e.layout(5), (vec!["abcde".to_owned(), String::new()], (1, 0)));
        let mut e = typed("abc");
        e.home();
        assert_eq!(e.layout(5).1, (0, 0));
    }

    #[test]
    fn searching_the_history_back() {
        let history: Vec<String> =
            ["cargo build", "git status", "cargo test -p parser", "Cargo fmt"].iter().map(|s| s.to_string()).collect();
        assert_eq!(find_back(&history, "cargo", 4, None), Some((3, 0)), "smart case: any case");
        assert_eq!(find_back(&history, "Cargo", 3, None), None, "a capital matches exactly");
        assert_eq!(find_back(&history, "test", 4, None), Some((2, 6)));
        assert_eq!(find_back(&history, "cargo", 3, Some("cargo test -p parser")), Some((0, 0)));
        assert_eq!(find_back(&history, "", 4, None), None);
        assert_eq!(find_back(&history, "zz", 4, None), None);

        let mut e = Editor::with_history(history);
        e.insert("draft");
        e.search_back();
        assert_eq!(e.searching().unwrap().query, "");
        assert_eq!(e.text(), "draft", "nothing typed yet");
        for c in "car".chars() {
            e.search_type(c);
        }
        assert_eq!((e.text(), e.cursor()), ("Cargo fmt", 0));
        e.search_type('g');
        e.search_type('o');
        e.search_type(' ');
        e.search_type('t');
        assert_eq!((e.text(), e.cursor()), ("cargo test -p parser", 0), "typing narrows from the match");
        e.search_backspace();
        e.search_backspace();
        assert_eq!(e.text(), "Cargo fmt", "a shorter query searches from the newest again");
        e.search_back();
        assert_eq!(e.text(), "cargo test -p parser", "ctrl+r again: older");
        e.search_back();
        assert_eq!(e.text(), "cargo build");
        e.search_back();
        assert!(e.searching().unwrap().failed, "nothing older");
        assert_eq!(e.text(), "cargo build", "the last match stays");
        e.search_cancel();
        assert_eq!((e.text(), e.cursor()), ("draft", 5), "esc: as it was");
        assert!(e.searching().is_none());
        e.search_back();
        e.search_type('s');
        e.search_type('t');
        assert_eq!((e.text(), e.cursor()), ("cargo test -p parser", 8));
        e.search_accept();
        assert!(e.searching().is_none());
        assert_eq!(e.text(), "cargo test -p parser", "enter keeps it to change or send");
    }

    #[test]
    fn whatever_is_typed_and_pasted_is_sent_as_it_was() {
        invincible::testgen::cases("paste", |g| {
            let mut e = Editor::default();
            let mut expected = String::new();
            for _ in 0..g.below(6) {
                if g.one_in(2) {
                    // Typed: anything but a bracket (a label typed by hand is a label).
                    let typed: String = g.text(20).chars().filter(|c| *c != '[').collect();
                    e.insert(&typed);
                    expected.push_str(&typed);
                } else {
                    // Pasted: short or long, any line ends, sometimes holding a label's text.
                    let mut text =
                        g.assemble(&["\r\n", "\n", "\r", "[pasted 6 lines]", "[pasted 6 lines #2]", "line"], 12);
                    if g.one_in(3) {
                        text.push_str(&"x".repeat(g.below(1200)));
                    }
                    // Short ones go in as they are: one holding a label's text is the owner's
                    // ambiguity, as if typed (the long ones become labels themselves).
                    if text.lines().count() <= 4 && text.chars().count() <= 800 {
                        text = text.replace('[', "(");
                    }
                    e.paste(&text);
                    expected.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
                }
            }
            let (shown, sent) = e.take();
            assert_eq!(sent, expected, "shown as {shown:?}");
            assert!(shown.chars().count() <= sent.chars().count() + 64 * 6, "labels are short");
        });
    }

    #[test]
    fn history_file_round_trips() {
        let path = std::env::temp_dir().join(format!("autobot-history-{}", std::process::id()));
        let entries = vec!["one".to_owned(), "two\nlines".to_owned(), r"back\slash".to_owned()];
        save_history(&path, &entries);
        assert!(std::fs::read_to_string(&path).unwrap().starts_with("#V2\none\ntwo\\nlines\n"));
        assert_eq!(load_history(&path), entries);
        std::fs::remove_file(path).unwrap();
    }
}
