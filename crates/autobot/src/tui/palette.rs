//! What the composer offers as you type: the slash commands for a `/` at the start, the
//! project's files for an `@` word. Matches rank by where the typed text falls: the start of the
//! name, the start of a word in it, anywhere, then its letters in order. A picker (`/model`,
//! `/resume` with nothing after them) is a palette too: everything to choose from, narrowed by
//! what is typed.

use std::path::Path;

/// One suggestion: what replaces the typed word, and a line about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub text: String,
    pub detail: String,
}

/// What is offered, for which bytes of the composer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Palette {
    pub items: Vec<Item>,
    pub selected: usize,
    /// The bytes the chosen item replaces.
    pub range: std::ops::Range<usize>,
    pub kind: Kind,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Kind {
    #[default]
    Command,
    Path,
    /// A picker's choices.
    Pick,
}

/// A list to choose from for a command: what is typed narrows it, enter runs [command] with the
/// chosen item's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picker {
    /// `/model`, `/resume`.
    pub command: String,
    /// What is chosen: `models`, `conversations`.
    pub noun: String,
    pub all: Vec<Item>,
    /// The item chosen at first (the current one).
    pub current: usize,
}

impl Picker {
    /// The palette for [query]: the matches, best first (all, in their order, for nothing typed),
    /// the current item chosen while nothing is typed.
    pub fn palette(&self, query: &str) -> Palette {
        let query = query.trim();
        let items = filter(&self.all, query);
        let selected = if query.is_empty() { self.current.min(items.len().saturating_sub(1)) } else { 0 };
        Palette { items, selected, range: 0..0, kind: Kind::Pick }
    }
}

/// [items] that match [query] by their text or, less well, by what is said about them; best
/// first.
pub fn filter(items: &[Item], query: &str) -> Vec<Item> {
    let mut found: Vec<(usize, usize, &Item)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            let by_text = score(query, &item.text);
            let by_detail = score(query, &item.detail).filter(|s| *s < 4).map(|s| s + 5);
            by_text.or(by_detail).map(|s| (s, i, item))
        })
        .collect();
    if !query.is_empty() {
        found.sort_by_key(|(s, i, _)| (*s, *i));
    }
    found.into_iter().map(|(_, _, item)| item.clone()).collect()
}

impl Palette {
    pub fn up(&mut self) {
        let n = self.items.len().max(1);
        self.selected = (self.selected + n - 1) % n;
    }

    pub fn down(&mut self) {
        self.selected = (self.selected + 1) % self.items.len().max(1);
    }

    pub fn chosen(&self) -> Option<&Item> {
        self.items.get(self.selected)
    }

    /// The items to show, at most [rows], scrolled so the selected one is among them; with the
    /// index of the first.
    pub fn window(&self, rows: usize) -> (usize, &[Item]) {
        let rows = rows.max(1);
        let start = self.selected.saturating_sub(rows - 1).min(self.items.len().saturating_sub(rows));
        (start, &self.items[start..(start + rows).min(self.items.len())])
    }
}

/// How well [query] matches [name]: lower is better; None when it does not.
pub fn score(query: &str, name: &str) -> Option<usize> {
    let q = query.to_lowercase();
    let n = name.to_lowercase();
    if q.is_empty() {
        return Some(3);
    }
    if n.starts_with(&q) {
        return Some(0);
    }
    let base = n.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&n);
    if base.starts_with(&q) {
        return Some(1);
    }
    if n.match_indices(&q).any(|(i, _)| i == 0 || !n.as_bytes()[i - 1].is_ascii_alphanumeric()) {
        return Some(2);
    }
    if n.contains(&q) {
        return Some(3);
    }
    let mut chars = n.chars();
    q.chars().all(|c| chars.any(|n| n == c)).then_some(4)
}

/// The palette for [text] with the cursor at [cursor], if it offers anything: commands when the
/// text is a `/word` (no space yet), paths when the cursor ends an `@word`.
pub fn suggest(text: &str, cursor: usize, commands: &[(String, String)], files: Option<&[String]>) -> Option<Palette> {
    let before = &text[..cursor];
    if let Some(query) = before.strip_prefix('/')
        && !before.contains(char::is_whitespace)
    {
        let items = rank(query, commands.iter().map(|(name, detail)| (name.trim_start_matches('/'), detail.as_str())));
        let items: Vec<Item> = items
            .into_iter()
            .map(|(name, detail)| Item { text: format!("/{name}"), detail: detail.to_owned() })
            .collect();
        // A command typed out in full needs no list.
        if items.is_empty() || (items.len() == 1 && items[0].text == before) {
            return None;
        }
        let end = text[cursor..].find(char::is_whitespace).map_or(text.len(), |i| cursor + i);
        return Some(Palette { items, selected: 0, range: 0..end, kind: Kind::Command });
    }
    let start = before.char_indices().rfind(|(_, c)| c.is_whitespace()).map_or(0, |(i, c)| i + c.len_utf8());
    let query = before[start..].strip_prefix('@')?;
    let files = files?;
    let items: Vec<Item> = rank(query, files.iter().map(|f| (f.as_str(), "")))
        .into_iter()
        .take(50)
        .map(|(path, _)| {
            // Images are shown to the model, not pasted in as text.
            let image = crate::images::is_image(Path::new(path));
            Item { text: format!("@{path}"), detail: if image { "image".into() } else { String::new() } }
        })
        .collect();
    if items.is_empty() || (items.len() == 1 && items[0].text == before[start..]) {
        return None;
    }
    Some(Palette { items, selected: 0, range: start..cursor, kind: Kind::Path })
}

/// [candidates] that match [query], best first (ties: shorter, then as they came).
fn rank<'a>(query: &str, candidates: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<(&'a str, &'a str)> {
    let mut found: Vec<(usize, usize, (&str, &str))> =
        candidates.enumerate().filter_map(|(i, c)| score(query, c.0).map(|s| (s, i, c))).collect();
    if !query.is_empty() {
        found.sort_by_key(|(s, i, c)| (*s, c.0.len(), *i));
    }
    found.into_iter().map(|(_, _, c)| c).collect()
}

/// The project's files and directories (directories end in `/`), relative, `.gitignore`d and
/// hidden ones left out; at most [max].
pub fn files(workdir: &Path, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let walk = ignore::WalkBuilder::new(workdir)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .require_git(false)
        .max_depth(Some(16))
        .build();
    for entry in walk.flatten() {
        let Ok(rel) = entry.path().strip_prefix(workdir) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let dir = entry.file_type().is_some_and(|t| t.is_dir());
        out.push(format!("{}{}", rel.display(), if dir { "/" } else { "" }));
        if out.len() >= max {
            break;
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::{Item, Kind, Picker, filter, score, suggest};

    fn commands() -> Vec<(String, String)> {
        ["/help", "/model", "/approvals", "/compact", "/commands", "/context", "/memory"]
            .iter()
            .map(|c| (c.to_string(), format!("about {c}")))
            .collect()
    }

    #[test]
    fn scores_rank_the_start_first() {
        assert_eq!(score("mo", "model"), Some(0));
        assert_eq!(score("main", "src/main.rs"), Some(1));
        assert_eq!(score("rs", "src/main.rs"), Some(2));
        assert_eq!(score("ain", "src/main.rs"), Some(3));
        assert_eq!(score("smr", "src/main.rs"), Some(4));
        assert_eq!(score("zz", "src/main.rs"), None);
    }

    #[test]
    fn a_slash_lists_the_commands() {
        let all = suggest("/", 1, &commands(), None).unwrap();
        assert_eq!(all.items.len(), 7, "all, in their order");
        assert_eq!(all.items[0].text, "/help");
        let co = suggest("/co", 3, &commands(), None).unwrap();
        let names: Vec<&str> = co.items.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(names, ["/compact", "/context", "/commands"]);
        assert_eq!(co.kind, Kind::Command);
        assert_eq!(co.items[0].detail, "about /compact");
        assert!(suggest("/model", 6, &commands(), None).is_none(), "typed out in full");
        assert!(suggest("/model x", 8, &commands(), None).is_none(), "arguments now");
        assert!(suggest("hi /mo", 6, &commands(), None).is_none(), "only at the start");
        assert!(suggest("/zzz", 4, &commands(), None).is_none());
    }

    #[test]
    fn an_at_word_lists_files() {
        let files: Vec<String> = ["Cargo.toml", "src/", "src/main.rs", "src/tui/mod.rs", "docs/Shot.PNG"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let p = suggest("look at @ma", 11, &[], Some(&files)).unwrap();
        assert_eq!(p.kind, Kind::Path);
        assert_eq!(p.range, 8..11);
        assert_eq!(p.items[0].text, "@src/main.rs");
        assert_eq!(p.items[0].detail, "");
        let shot = suggest("@sho", 4, &[], Some(&files)).unwrap();
        assert_eq!((shot.items[0].text.as_str(), shot.items[0].detail.as_str()), ("@docs/Shot.PNG", "image"));
        assert!(suggest("look at @src/main.rs", 20, &[], Some(&files)).is_none(), "already whole");
        assert!(suggest("no at word", 10, &[], Some(&files)).is_none());
        assert!(suggest("@x", 2, &[], None).is_none(), "no files known yet");
    }

    #[test]
    fn a_picker_narrows_as_you_type() {
        let item = |text: &str, detail: &str| Item { text: text.into(), detail: detail.into() };
        let all = vec![
            item("qwen3-coder", "node · 32k context"),
            item("claude-sonnet", "cloud · 200k context"),
            item("deepseek-chat", "cloud · 64k context"),
            item("auto", "the gateway's router picks"),
        ];
        let texts = |items: Vec<Item>| items.into_iter().map(|i| i.text).collect::<Vec<_>>();
        assert_eq!(texts(filter(&all, "")), ["qwen3-coder", "claude-sonnet", "deepseek-chat", "auto"]);
        assert_eq!(texts(filter(&all, "se")), ["deepseek-chat", "claude-sonnet"], "inside the name, then in order");
        assert_eq!(texts(filter(&all, "cloud")), ["claude-sonnet", "deepseek-chat"], "then by what it is");
        assert_eq!(texts(filter(&all, "dsc")), ["deepseek-chat"], "letters in order");
        assert!(filter(&all, "zzz").is_empty());
        let picker = Picker { command: "/model".into(), noun: "models".into(), all, current: 2 };
        let p = picker.palette("");
        assert_eq!((p.kind, p.selected), (Kind::Pick, 2), "the current one chosen");
        assert_eq!(picker.palette("qw").selected, 0);
        assert_eq!(picker.palette("qw").chosen().unwrap().text, "qwen3-coder");
    }

    #[test]
    fn the_window_follows_the_selection() {
        let mut p = suggest("/", 1, &commands(), None).unwrap();
        assert_eq!(p.window(3).0, 0);
        for _ in 0..5 {
            p.down();
        }
        let (start, shown) = p.window(3);
        assert_eq!((start, shown.len()), (3, 3));
        assert_eq!(shown[2].text, "/context");
        p.down();
        p.down();
        assert_eq!(p.selected, 0, "wraps around");
        p.up();
        assert_eq!(p.selected, 6);
    }
}
