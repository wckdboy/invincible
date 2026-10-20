//! Conversations, one JSONL file each under `$AUTOBOT_HOME/sessions`: one message per line, in
//! the OpenAI chat shape, appended as they happen so a crash loses at most the line in flight.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub struct Session {
    pub id: String,
    path: PathBuf,
    pub messages: Vec<Value>,
    /// Characters of recent messages sent per call at most ([CHAR_BUDGET] unless set).
    pub budget: usize,
}

/// Messages sent per call at most (or a 1 KiB budget each, when the budget is larger); older ones
/// stay on disk, summarized ([Session::compaction]).
const WINDOW: usize = 60;
/// Characters of recent messages sent per call at most (about 12k tokens: small local models
/// have small contexts, and one tool result can be 16 KiB).
pub const CHAR_BUDGET: usize = 48 * 1024;

/// A summary of the conversation up to a point, kept in the session file as a line of its own:
/// `{"role": "system", "autobot": "summary", "upto": <messages covered>, "content": "…"}`.
fn is_summary(message: &Value) -> bool {
    message["autobot"] == "summary"
}

impl Session {
    /// The session [id] in [dir], with what it already holds.
    pub fn open(dir: &Path, id: &str) -> Result<Self, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("{id:?} is not a session name (letters, digits, - and _)"));
        }
        let path = dir.join(format!("{id}.jsonl"));
        let mut messages = Vec::new();
        if let Some(text) = invincible::fsutil::read_optional(&path)? {
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                // A torn last line (crash mid-write) is dropped, not fatal.
                if let Ok(message) = serde_json::from_str(line) {
                    messages.push(message);
                }
            }
        }
        Ok(Self { id: id.to_owned(), path, messages, budget: CHAR_BUDGET })
    }

    pub fn push(&mut self, message: Value) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        writeln!(file, "{message}").map_err(|e| format!("{}: {e}", self.path.display()))?;
        self.messages.push(message);
        Ok(())
    }

    /// A new conversation [to] that starts as this one did, up to message [at] (all of it when
    /// None, or at the end of the turn [at] falls in, so no tool call is cut from its result).
    pub fn fork(&self, dir: &Path, to: &str, at: Option<usize>) -> Result<Session, String> {
        let mut end = at.unwrap_or(self.messages.len()).min(self.messages.len());
        // Up to the next user message, so the copy ends between turns.
        while end < self.messages.len() && self.messages[end]["role"] != "user" {
            end += 1;
        }
        let mut copy = Session::open(dir, to)?;
        if !copy.messages.is_empty() {
            return Err(format!("there is a conversation {to:?} already"));
        }
        for message in &self.messages[..end] {
            copy.push(message.clone())?;
        }
        Ok(copy)
    }

    /// Answers tool calls left without a result (a turn stopped mid-way), so the conversation
    /// stays one a model accepts.
    pub fn close_dangling(&mut self) -> Result<(), String> {
        let Some(at) = self.messages.iter().rposition(|m| m["role"] == "assistant") else { return Ok(()) };
        let ids: Vec<String> = self.messages[at]["tool_calls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c["id"].as_str().map(str::to_owned))
            .collect();
        for id in ids {
            let answered =
                self.messages[at + 1..].iter().any(|m| m["role"] == "tool" && m["tool_call_id"] == id.as_str());
            if !answered {
                self.push(serde_json::json!({ "role": "tool", "tool_call_id": id, "content": "stopped by the owner; it may have partly run (check before doing it again)" }))?;
            }
        }
        Ok(())
    }

    fn undo_path(&self) -> PathBuf {
        self.path.with_extension("undo")
    }

    /// The index of the last turn's request (not a note added while it worked).
    fn last_turn(&self) -> Option<usize> {
        self.messages.iter().rposition(|m| {
            m["role"] == "user" && !m["content"].as_str().is_some_and(|c| c.starts_with("(The owner adds"))
        })
    }

    /// Undoes the last turn: files it wrote or edited go back to what they were (or are removed,
    /// when it created them), and the turn leaves the conversation. Its request and the files
    /// put back.
    pub fn undo(&mut self) -> Result<(String, Vec<String>), String> {
        let start = self.last_turn().ok_or("nothing to undo")?;
        let request = self.messages[start]["content"].as_str().unwrap_or_default().to_owned();
        let log = invincible::fsutil::read_optional(&self.undo_path())?.unwrap_or_default();
        let mut keep = String::new();
        let mut undo: Vec<Value> = Vec::new();
        for line in log.lines() {
            let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
            if entry["at"].as_u64().is_some_and(|at| at as usize > start) {
                undo.push(entry);
            } else {
                keep.push_str(line);
                keep.push('\n');
            }
        }
        let mut restored = Vec::new();
        // Newest first, so a file changed twice ends as it was before the first change.
        for entry in undo.iter().rev() {
            let Some(path) = entry["path"].as_str() else { continue };
            let result = match (entry["before"].as_str(), entry["before_hex"].as_str()) {
                (Some(text), _) => std::fs::write(path, text),
                (None, Some(hex)) => match unhex(hex) {
                    Some(bytes) => std::fs::write(path, bytes),
                    None => return Err(format!("{path}: the undo log is damaged")),
                },
                // It did not exist before the turn.
                (None, None) => std::fs::remove_file(path)
                    .or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
            };
            result.map_err(|e| format!("{path}: {e}"))?;
            if !restored.iter().any(|p| p == path) {
                restored.push(path.to_owned());
            }
        }
        invincible::fsutil::replace_private(&self.undo_path(), &keep)?;
        self.truncate(start)?;
        restored.reverse();
        Ok((request, restored))
    }

    /// Keeps [path]'s contents before the agent changes it ([before]: None when it does not
    /// exist yet), for [Session::undo]: as text, or as hex when it is not UTF-8.
    pub fn checkpoint(dir: &Path, id: &str, at: usize, path: &Path, before: Option<&[u8]>) -> Result<(), String> {
        let mut entry = serde_json::json!({ "at": at, "path": path.display().to_string() });
        match before.map(std::str::from_utf8) {
            Some(Ok(text)) => entry["before"] = text.into(),
            Some(Err(_)) => entry["before_hex"] = hex(before.unwrap_or_default()).into(),
            None => {}
        }
        let file = dir.join(format!("{id}.undo"));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut out = options.open(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        writeln!(out, "{entry}").map_err(|e| format!("{}: {e}", file.display()))
    }

    /// Keeps only the first [n] messages, on disk too.
    pub fn truncate(&mut self, n: usize) -> Result<(), String> {
        self.messages.truncate(n);
        let mut text = String::new();
        for m in &self.messages {
            text.push_str(&m.to_string());
            text.push('\n');
        }
        invincible::fsutil::replace_private(&self.path, &text)
    }

    /// Starts over: the old conversation is kept under a dated name.
    pub fn reset(&mut self) -> Result<(), String> {
        if self.path.exists() {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default();
            let old = self.path.with_file_name(format!("{}-{stamp}.jsonl", self.id));
            std::fs::rename(&self.path, &old).map_err(|e| format!("{}: {e}", self.path.display()))?;
        }
        let _ = std::fs::remove_file(self.undo_path());
        self.messages.clear();
        Ok(())
    }

    /// Where the recent part starts: at most [WINDOW] messages and [CHAR_BUDGET] characters,
    /// beginning at a user message so no tool result is cut off from the call it answers.
    fn window_start(&self) -> usize {
        let mut used = 0;
        let mut from = self.messages.len();
        for (i, m) in self.messages.iter().enumerate().rev() {
            if is_summary(m) {
                continue;
            }
            used += m.to_string().len();
            if used > self.budget || self.messages.len() - i > WINDOW.max(self.budget / 1024) {
                break;
            }
            from = i;
        }
        // Never before what the latest summary covers (`/compact` summarizes up to the last turn).
        let from = from.max(self.covered()).min(self.messages.len());
        (from..self.messages.len())
            .find(|&i| self.messages[i]["role"] == "user")
            // A single turn over the budget: from its start anyway, the model sees the request.
            .or_else(|| (0..self.messages.len()).rev().find(|&i| self.messages[i]["role"] == "user"))
            .unwrap_or(from)
    }

    /// The recent part of the conversation, summaries left out (see [Session::summary]).
    pub fn window(&self) -> Vec<Value> {
        self.messages[self.window_start()..].iter().filter(|m| !is_summary(m)).cloned().collect()
    }

    /// The latest summary of what came before the window, if there is one.
    pub fn summary(&self) -> Option<&str> {
        self.messages.iter().rev().find(|m| is_summary(m)).and_then(|m| m["content"].as_str())
    }

    /// Messages that left the window since the last summary: the previous summary (if any) and
    /// those messages, to be summarized together; None when there are none.
    pub fn compaction(&self) -> Option<(Option<String>, Vec<Value>)> {
        let start = self.window_start();
        let last = self.messages.iter().rev().find(|m| is_summary(m));
        let covered = last.and_then(|m| m["upto"].as_u64()).unwrap_or(0) as usize;
        let pending: Vec<Value> =
            self.messages.get(covered..start)?.iter().filter(|m| !is_summary(m)).cloned().collect();
        (!pending.is_empty()).then(|| (last.and_then(|m| m["content"].as_str()).map(str::to_owned), pending))
    }

    /// Keeps [text] as the summary of everything before the window.
    pub fn add_summary(&mut self, text: &str) -> Result<(), String> {
        let upto = self.window_start();
        self.add_summary_upto(text, upto)
    }

    /// Keeps [text] as the summary of the messages before [upto] (a user message).
    pub fn add_summary_upto(&mut self, text: &str, upto: usize) -> Result<(), String> {
        self.push(serde_json::json!({ "role": "system", "autobot": "summary", "upto": upto, "content": text }))
    }

    /// How many messages the latest summary covers.
    fn covered(&self) -> usize {
        self.messages.iter().rev().find(|m| is_summary(m)).and_then(|m| m["upto"].as_u64()).unwrap_or(0) as usize
    }

    /// Everything not yet summarized but the last turn (`/compact`): the previous summary, those
    /// messages, and where the last turn starts; None when there is nothing to fold.
    pub fn compaction_all(&self) -> Option<(Option<String>, Vec<Value>, usize)> {
        let cut = (0..self.messages.len()).rev().find(|&i| self.messages[i]["role"] == "user")?;
        let covered = self.covered();
        let pending: Vec<Value> = self.messages.get(covered..cut)?.iter().filter(|m| !is_summary(m)).cloned().collect();
        (!pending.is_empty()).then(|| (self.summary().map(str::to_owned), pending, cut))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

/// Past conversations in [dir] that mention [query]'s words: (session, snippet), best first, at
/// most [limit]. Plain word matching over the files: enough for one machine's history.
pub fn search(dir: &Path, query: &str, limit: usize, skip: &str) -> Vec<(String, String)> {
    let words: Vec<String> =
        query.split_whitespace().map(str::to_lowercase).filter(|w| w.chars().count() > 2).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(usize, String, String)> = Vec::new();
    for (name, _) in list(dir) {
        if name == skip {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(dir.join(format!("{name}.jsonl"))) else { continue };
        for line in text.lines() {
            let Ok(m) = serde_json::from_str::<Value>(line) else { continue };
            let Some(content) = m["content"].as_str() else { continue };
            if !matches!(m["role"].as_str(), Some("user" | "assistant")) && !is_summary(&m) {
                continue;
            }
            let lower = content.to_lowercase();
            let score = words.iter().filter(|w| lower.contains(w.as_str())).count();
            if score > 0 {
                let at = words.iter().filter_map(|w| lower.find(w.as_str())).min().unwrap_or(0);
                let start = content.char_indices().map(|(i, _)| i).take_while(|i| *i + 120 <= at).last().unwrap_or(0);
                let snippet: String = content[start..].chars().take(300).collect();
                hits.push((
                    score,
                    name.clone(),
                    format!("{}: {}", m["role"].as_str().unwrap_or("summary"), snippet.replace('\n', " ")),
                ));
            }
        }
    }
    // Most words matched first; newer sessions first among equals (list is newest first).
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter().take(limit).map(|(_, name, snippet)| (name, snippet)).collect()
}

/// The sessions in [dir], newest first.
pub fn list(dir: &Path) -> Vec<(String, std::time::SystemTime)> {
    let mut found: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().strip_suffix(".jsonl")?.to_owned();
            Some((name, e.metadata().and_then(|m| m.modified()).ok()?))
        })
        .collect();
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found
}

/// What the session [id] in [dir] is about: the first line of its first request (cut to [max]
/// characters), read from the start of its file only.
pub fn title(dir: &Path, id: &str, max: usize) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(dir.join(format!("{id}.jsonl"))).ok()?;
    std::io::BufReader::new(file).lines().take(200).map_while(Result::ok).find_map(|line| {
        let message: Value = serde_json::from_str(&line).ok()?;
        if message["role"] != "user" {
            return None;
        }
        let text = message["content"].as_str()?;
        let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
        let mut title: String = first.chars().take(max).collect();
        if first.chars().count() > max {
            title.push('…');
        }
        Some(title)
    })
}

/// The last answer in [messages]: the newest assistant message with text.
pub fn last_answer(messages: &[Value]) -> Option<&str> {
    messages
        .iter()
        .rev()
        .filter(|m| m["role"] == "assistant")
        .find_map(|m| m["content"].as_str().filter(|t| !t.trim().is_empty()))
}

#[cfg(test)]
mod tests {
    use super::{Session, WINDOW};
    use serde_json::json;

    #[test]
    fn appends_reloads_and_resets() {
        let dir = std::env::temp_dir().join(format!("autobot-sessions-{}", std::process::id()));
        let mut s = Session::open(&dir, "cli").unwrap();
        s.push(json!({"role": "user", "content": "hi"})).unwrap();
        s.push(json!({"role": "assistant", "content": "hello"})).unwrap();
        // A torn line from a crash.
        std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("cli.jsonl"))
            .map(|mut f| {
                use std::io::Write;
                f.write_all(b"{\"role\":\"us").unwrap();
            })
            .unwrap();
        let again = Session::open(&dir, "cli").unwrap();
        assert_eq!(again.messages.len(), 2);
        assert_eq!(super::title(&dir, "cli", 40).as_deref(), Some("hi"));
        let mut again = again;
        again.reset().unwrap();
        assert!(Session::open(&dir, "cli").unwrap().messages.is_empty());
        assert_eq!(super::list(&dir).len(), 1);
        assert_eq!(super::title(&dir, "missing", 40), None);
        let messages = vec![
            json!({"role": "user", "content": "q"}),
            json!({"role": "assistant", "content": "**the answer**"}),
            json!({"role": "user", "content": "again"}),
            json!({"role": "assistant", "content": null, "tool_calls": []}),
        ];
        assert_eq!(super::last_answer(&messages), Some("**the answer**"));
        assert_eq!(super::last_answer(&messages[..1]), None);
        assert!(Session::open(&dir, "../x").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_window_starts_at_a_user_message() {
        let dir = std::env::temp_dir().join(format!("autobot-window-{}", std::process::id()));
        let mut s = Session::open(&dir, "w").unwrap();
        for i in 0..WINDOW {
            s.messages.push(json!({"role": if i % 3 == 0 { "user" } else { "tool" }, "content": i}));
        }
        s.messages.push(json!({"role": "tool", "content": "last"}));
        let window = s.window();
        assert_eq!(window[0]["role"], "user");
        assert!(window.len() <= WINDOW);
    }

    #[test]
    fn a_fork_starts_as_the_original_did() {
        let dir = std::env::temp_dir().join(format!("autobot-fork-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Session::open(&dir, "main").unwrap();
        for m in [
            json!({"role": "user", "content": "one"}),
            json!({"role": "assistant", "content": "", "tool_calls": [{"id": "c"}]}),
            json!({"role": "tool", "tool_call_id": "c", "content": "x"}),
            json!({"role": "assistant", "content": "done one"}),
            json!({"role": "user", "content": "two"}),
            json!({"role": "assistant", "content": "done two"}),
        ] {
            s.push(m).unwrap();
        }
        // At 2 (inside the first turn): the whole first turn, not a call without its result.
        let fork = s.fork(&dir, "branch", Some(2)).unwrap();
        assert_eq!(fork.messages.len(), 4);
        assert_eq!(Session::open(&dir, "branch").unwrap().messages.len(), 4);
        assert_eq!(s.fork(&dir, "all", None).unwrap().messages.len(), 6);
        assert!(s.fork(&dir, "branch", None).is_err(), "never over another conversation");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn earlier_conversations_are_searched_by_words() {
        let dir = std::env::temp_dir().join(format!("autobot-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut a = Session::open(&dir, "a").unwrap();
        a.push(json!({"role": "user", "content": "Back up the database to /srv/backup every night"})).unwrap();
        a.push(json!({"role": "tool", "content": "backup database srv"})).unwrap();
        a.push(json!({"role": "assistant", "content": "Scheduled the nightly backup."})).unwrap();
        let mut b = Session::open(&dir, "b").unwrap();
        b.push(json!({"role": "user", "content": "What's the weather?"})).unwrap();
        let found = super::search(&dir, "database backup", 5, "now");
        assert_eq!(found[0].0, "a");
        assert!(found[0].1.contains("/srv/backup"));
        // Tool output is not searched (it may be huge and is not what was said).
        assert!(found.iter().all(|(_, s)| !s.starts_with("tool")));
        assert!(super::search(&dir, "database", 5, "a").is_empty(), "the current conversation is skipped");
        assert!(super::search(&dir, "xy", 5, "").is_empty(), "short words alone find nothing");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compact_folds_all_but_the_last_turn() {
        let dir = std::env::temp_dir().join(format!("autobot-compact-all-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Session::open(&dir, "c").unwrap();
        for i in 0..3 {
            s.push(json!({"role": "user", "content": format!("task {i}")})).unwrap();
            s.push(json!({"role": "assistant", "content": format!("done {i}")})).unwrap();
        }
        let (previous, pending, cut) = s.compaction_all().unwrap();
        assert!(previous.is_none());
        assert_eq!(pending.len(), 4);
        s.add_summary_upto("tasks 0 and 1 done", cut).unwrap();
        let window = s.window();
        assert_eq!(window.len(), 2, "{window:?}");
        assert_eq!(window[0]["content"], "task 2");
        assert!(s.compaction_all().is_none());
        assert!(s.compaction().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_leaves_the_window_is_summarized_once() {
        let dir = std::env::temp_dir().join(format!("autobot-compact-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Session::open(&dir, "c").unwrap();
        assert!(s.compaction().is_none());
        // Big tool results: the character budget, not the count, closes the window.
        for i in 0..8 {
            s.push(json!({"role": "user", "content": format!("task {i}")})).unwrap();
            s.push(json!({"role": "tool", "content": "x".repeat(12 * 1024)})).unwrap();
        }
        let window = s.window();
        assert!(window.len() < 16 && window[0]["role"] == "user");
        let (previous, pending) = s.compaction().unwrap();
        assert!(previous.is_none());
        assert_eq!(pending[0]["content"], "task 0");
        s.add_summary("The owner asked for tasks 0 to 4.").unwrap();
        assert!(s.compaction().is_none(), "nothing new left the window");
        assert_eq!(s.summary(), Some("The owner asked for tasks 0 to 4."));
        assert!(s.window().iter().all(|m| m["autobot"] != "summary"));
        // More turns push more out: they come with the previous summary.
        for i in 8..10 {
            s.push(json!({"role": "user", "content": format!("task {i}")})).unwrap();
            s.push(json!({"role": "tool", "content": "y".repeat(12 * 1024)})).unwrap();
        }
        let (previous, pending) = s.compaction().unwrap();
        assert_eq!(previous.as_deref(), Some("The owner asked for tasks 0 to 4."));
        assert!(pending.iter().all(|m| m["autobot"] != "summary"));
        // Kept on disk.
        let again = Session::open(&dir, "c").unwrap();
        assert_eq!(again.summary(), Some("The owner asked for tasks 0 to 4."));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn undo_puts_files_back_and_drops_the_turn() {
        let dir = std::env::temp_dir().join(format!("autobot-undo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (old, new) = (dir.join("old.txt"), dir.join("new.txt"));
        std::fs::write(&old, "first").unwrap();
        let mut s = Session::open(&dir, "u").unwrap();
        s.push(json!({ "role": "user", "content": "one" })).unwrap();
        s.push(json!({ "role": "assistant", "content": "ok" })).unwrap();
        s.push(json!({ "role": "user", "content": "change them" })).unwrap();
        // The turn edits old.txt twice and creates new.txt.
        Session::checkpoint(&dir, "u", 3, &old, Some(b"first")).unwrap();
        std::fs::write(&old, "second").unwrap();
        Session::checkpoint(&dir, "u", 4, &old, Some(b"second")).unwrap();
        // A file that is not UTF-8 comes back byte for byte (it is not taken for a new one).
        let latin = dir.join("latin1.txt");
        std::fs::write(&latin, b"caf\xe9").unwrap();
        Session::checkpoint(&dir, "u", 4, &latin, Some(b"caf\xe9")).unwrap();
        std::fs::write(&latin, "changed").unwrap();
        std::fs::write(&old, "third").unwrap();
        Session::checkpoint(&dir, "u", 4, &new, None).unwrap();
        std::fs::write(&new, "made").unwrap();
        s.push(json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c9", "type": "function", "function": { "name": "terminal", "arguments": "{}" } }] })).unwrap();
        // Stopped mid-way: the call gets an answer.
        s.close_dangling().unwrap();
        assert_eq!(s.messages.last().unwrap()["tool_call_id"], "c9");
        let (request, restored) = s.undo().unwrap();
        assert_eq!(request, "change them");
        assert_eq!(restored.len(), 3);
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "first");
        assert_eq!(std::fs::read(&latin).unwrap(), b"caf\xe9");
        assert!(!new.exists());
        assert_eq!(Session::open(&dir, "u").unwrap().messages.len(), 2);
        // The first turn changed nothing; undoing it just drops it.
        assert_eq!(s.undo().unwrap(), ("one".to_owned(), vec![]));
        assert!(s.undo().is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
