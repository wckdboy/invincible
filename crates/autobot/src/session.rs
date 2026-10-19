//! Conversations, one JSONL file each under `$AUTOBOT_HOME/sessions`: one message per line, in
//! the OpenAI chat shape, appended as they happen so a crash loses at most the line in flight.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub struct Session {
    pub id: String,
    path: PathBuf,
    pub messages: Vec<Value>,
}

/// Messages sent per call at most; older ones stay on disk, summarized ([Session::compaction]).
const WINDOW: usize = 60;
/// Characters of recent messages sent per call at most (about 12k tokens: small local models
/// have small contexts, and one tool result can be 16 KiB).
const CHAR_BUDGET: usize = 48 * 1024;

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
        Ok(Self { id: id.to_owned(), path, messages })
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
            if used > CHAR_BUDGET || self.messages.len() - i > WINDOW {
                break;
            }
            from = i;
        }
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
        self.push(serde_json::json!({ "role": "system", "autobot": "summary", "upto": upto, "content": text }))
    }
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
        let mut again = again;
        again.reset().unwrap();
        assert!(Session::open(&dir, "cli").unwrap().messages.is_empty());
        assert_eq!(super::list(&dir).len(), 1);
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
}
