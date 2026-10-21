//! Conversations, one JSONL file each under `$AUTOBOT_HOME/sessions`: one message per line, in
//! the OpenAI chat shape, appended as they happen so a crash loses at most the line in flight.

use std::path::{Path, PathBuf};

use serde_json::Value;

pub struct Session {
    pub id: String,
    path: PathBuf,
    pub messages: Vec<Value>,
    /// Characters of recent messages sent per call at most ([CHAR_BUDGET] unless set).
    pub budget: usize,
    /// The file ends in a torn line (a crash mid-write): the next line starts on a new one.
    torn: bool,
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

/// The start of a message the agent adds for itself: a browser screenshot to look at.
pub const SCREENSHOT_NOTE: &str = "(Screenshot from the browser";

/// Whether [message] is a request from the owner: not a note they added while a turn ran, and
/// not a screenshot the agent took.
pub fn is_request(message: &Value) -> bool {
    message["role"] == "user"
        && !message["content"]
            .as_str()
            .is_some_and(|c| c.starts_with("(The owner adds") || c.starts_with(SCREENSHOT_NOTE))
}

/// What [message] takes of the budget: its characters, and about what an image costs
/// ([crate::images::BUDGET_CHARS]) for each it carries.
pub fn cost(message: &Value) -> usize {
    let images = message.get(crate::images::KEY).and_then(Value::as_array).map_or(0, Vec::len);
    // Its length as JSON, counted as it is written out rather than kept.
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    let _ = serde_json::to_writer(&mut count, message);
    count.0 + images * crate::images::BUDGET_CHARS
}

impl Session {
    /// The session [id] in [dir], with what it already holds.
    pub fn open(dir: &Path, id: &str) -> Result<Self, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("{id:?} is not a session name (letters, digits, - and _)"));
        }
        let path = dir.join(format!("{id}.jsonl"));
        let mut messages = Vec::new();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        // A torn line (a crash mid-write) is dropped, not fatal; so is one cut inside a
        // character (the rest of the file is still read as text).
        let mut take = |message: serde_json::Result<Value>| {
            if let Ok(message) = message
                && !message.is_null()
            {
                messages.push(message);
            }
        };
        match std::str::from_utf8(&bytes) {
            Ok(text) => text.lines().filter(|l| !l.trim().is_empty()).for_each(|l| take(serde_json::from_str(l))),
            Err(_) => bytes.split(|b| *b == b'\n').for_each(|l| take(serde_json::from_slice(l))),
        }
        // A torn last line: the next message starts a line of its own, or it would be appended
        // to the torn one and be lost with it. (The file is not cut here: whoever only reads
        // the conversation must not touch a line another writer is still writing.)
        let torn = bytes.last().is_some_and(|b| *b != b'\n');
        Ok(Self { id: id.to_owned(), path, messages, budget: CHAR_BUDGET, torn })
    }

    pub fn push(&mut self, message: Value) -> Result<(), String> {
        // Serialized whole and written at once (formatting a value straight into the file is a
        // system call per piece).
        let line = message.to_string();
        if self.torn {
            invincible::fsutil::append_private(&self.path, &format!("\n{line}"))?;
            self.torn = false;
        } else {
            invincible::fsutil::append_private(&self.path, &line)?;
        }
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
        self.messages.iter().rposition(is_request)
    }

    /// Takes the last turn out of the conversation (`/retry`): its request comes back as it was
    /// sent (text, and image references), to run again. Files it changed stay as they are; their
    /// undo log stays too, so `/undo` after the retried turn still goes back to before both.
    pub fn take_back(&mut self) -> Result<Value, String> {
        let start = self.last_turn().ok_or("nothing to retry yet")?;
        let request = self.messages[start].clone();
        self.truncate(start)?;
        Ok(request)
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
        invincible::fsutil::append_private(&dir.join(format!("{id}.undo")), &entry.to_string())
    }

    /// Keeps only the first [n] messages, on disk too.
    pub fn truncate(&mut self, n: usize) -> Result<(), String> {
        self.messages.truncate(n);
        let mut text = String::new();
        for m in &self.messages {
            text.push_str(&m.to_string());
            text.push('\n');
        }
        invincible::fsutil::replace_private(&self.path, &text)?;
        self.torn = false;
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
        let _ = std::fs::remove_file(self.undo_path());
        self.messages.clear();
        self.torn = false;
        crate::context::forget(self.path.parent(), &self.id);
        Ok(())
    }

    /// Where the recent part starts. What left the budget is summarized in batches
    /// ([Session::compaction]): until enough has left to be worth a model call, the window keeps
    /// it (going over the budget by at most an eighth), so nothing is out of both.
    fn window_start(&self) -> usize {
        let start = self.budget_start();
        if self.due(start) { start } else { self.after_summary().unwrap_or(start).min(start) }
    }

    /// The first user message the latest summary does not cover.
    fn after_summary(&self) -> Option<usize> {
        (self.covered().min(self.messages.len())..self.messages.len()).find(|&i| self.messages[i]["role"] == "user")
    }

    /// Whether what left the window since the last summary, [start] being where the budget
    /// starts it, is enough to summarize now: an eighth of the budget, or a quarter of [WINDOW]
    /// messages.
    fn due(&self, start: usize) -> bool {
        let covered = self.covered().min(start);
        let gone = self.messages[covered..start].iter().filter(|m| !is_summary(m));
        let (mut count, mut chars) = (0, 0);
        for m in gone {
            count += 1;
            chars += cost(m);
        }
        count > 0 && (chars >= self.budget / 8 || count >= WINDOW / 4)
    }

    /// Where the recent part starts by the budget alone: at most [WINDOW] messages and
    /// [CHAR_BUDGET] characters, beginning at a user message so no tool result is cut off from
    /// the call it answers.
    fn budget_start(&self) -> usize {
        let mut used = 0;
        let mut from = self.messages.len();
        for (i, m) in self.messages.iter().enumerate().rev() {
            if is_summary(m) {
                continue;
            }
            used += cost(m);
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

    /// The recent part of the conversation, summaries left out (see [Session::summary]). A turn
    /// longer than the budget on its own keeps its request and its newest results whole, and
    /// the results of its earlier steps cleared ([fit]).
    pub fn window(&self) -> Vec<Value> {
        let mut window: Vec<Value> =
            self.messages[self.window_start()..].iter().filter(|m| !is_summary(m)).cloned().collect();
        fit(&mut window, self.budget);
        window
    }

    /// The latest summary of what came before the window, if there is one.
    pub fn summary(&self) -> Option<&str> {
        self.messages.iter().rev().find(|m| is_summary(m)).and_then(|m| m["content"].as_str())
    }

    /// Messages that left the window since the last summary: the previous summary (if any) and
    /// those messages, to be summarized together; None when there are none, or too few yet to be
    /// worth a model call (the window still holds them).
    pub fn compaction(&self) -> Option<(Option<String>, Vec<Value>)> {
        let start = self.budget_start();
        if !self.due(start) {
            return None;
        }
        let last = self.messages.iter().rev().find(|m| is_summary(m));
        let covered = last.and_then(|m| m["upto"].as_u64()).unwrap_or(0) as usize;
        let pending: Vec<Value> =
            self.messages.get(covered..start)?.iter().filter(|m| !is_summary(m)).cloned().collect();
        (!pending.is_empty()).then(|| (last.and_then(|m| m["content"].as_str()).map(str::to_owned), pending))
    }

    /// Keeps [text] as the summary of everything before the window.
    pub fn add_summary(&mut self, text: &str) -> Result<(), String> {
        let upto = self.budget_start();
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

/// Tool results [fit] keeps whole, however long the turn: the newest ones.
const KEEP_RESULTS: usize = 3;
/// Results are cleared this many at a time, so most steps send what the step before sent and a
/// model's prompt cache still holds it (one result more each step would change the prompt at
/// every step).
const CLEAR_BATCH: usize = 8;
/// Results shorter than this stay: clearing them saves little.
const CLEAR_MIN: usize = 1024;
/// How a cleared result starts.
pub const CLEARED: &str = "[cleared to fit the context:";

/// Makes [window] fit [budget] when one long turn is over it by more than an eighth (a window
/// of whole turns is never much over; a turn of many steps can be any length): the tool results
/// of its earlier steps are cleared, oldest first and in batches, until it fits. Each still
/// answers its call, so the conversation stays one a model takes, and says what it was.
fn fit(window: &mut [Value], budget: usize) {
    let costs: Vec<usize> = window.iter().map(cost).collect();
    let total: usize = costs.iter().sum();
    if total <= budget + budget / 8 {
        return;
    }
    let results: Vec<usize> = (0..window.len())
        .filter(|&i| window[i]["role"] == "tool" && costs[i] >= CLEAR_MIN && window[i]["content"].is_string())
        .collect();
    let candidates = &results[..results.len().saturating_sub(KEEP_RESULTS)];
    let note = |bytes: usize| {
        format!(
            "{CLEARED} the result of an earlier step ({bytes} bytes) was taken out of the conversation; call the tool again if it is still needed]"
        )
    };
    let (mut left, mut need) = (total, 0);
    for (k, &i) in candidates.iter().enumerate() {
        if left <= budget {
            break;
        }
        left = left.saturating_sub(costs[i]) + note(costs[i]).len() + 40;
        need = k + 1;
    }
    let clear = (need.div_ceil(CLEAR_BATCH) * CLEAR_BATCH).min(candidates.len());
    for &i in &candidates[..clear] {
        let bytes = window[i]["content"].as_str().map_or(0, str::len);
        window[i]["content"] = note(bytes).into();
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

/// Removes the conversations in [dir] untouched for [age] or longer, with the files kept beside
/// each (`<id>.undo`, `<id>.context.json`, …); with [dry_run], only says which. The ones removed
/// (or that would be), with their bytes.
pub fn prune(dir: &Path, age: std::time::Duration, dry_run: bool) -> Result<Vec<(String, u64)>, String> {
    let now = std::time::SystemTime::now();
    let old: Vec<String> = list(dir)
        .into_iter()
        .filter(|(_, modified)| now.duration_since(*modified).is_ok_and(|d| d >= age))
        .map(|(id, _)| id)
        .collect();
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
    let mut out = Vec::new();
    for id in old {
        // A session id has no dots, so `<id>.` is its files and no other's.
        let prefix = format!("{id}.");
        let mine: Vec<&std::fs::DirEntry> =
            entries.iter().filter(|e| e.file_name().to_string_lossy().starts_with(&prefix)).collect();
        let bytes = mine.iter().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum();
        if !dry_run {
            for entry in &mine {
                let path = entry.path();
                let removed = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                removed.map_err(|e| format!("{}: {e}", path.display()))?;
            }
            // Its word index for recall ([crate::recall]).
            let _ = std::fs::remove_file(dir.join(".index").join(format!("{id}.json")));
        }
        out.push((id, bytes));
    }
    Ok(out)
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
mod prune_tests {
    use super::*;

    #[test]
    fn old_conversations_go_with_their_files_and_new_ones_stay() {
        let dir = std::env::temp_dir().join(format!("autobot-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join(".index")).unwrap();
        for name in
            ["old.jsonl", "old.undo", "old.context.json", "old_2.jsonl", "new.jsonl", "notes.txt", ".index/old.json"]
        {
            std::fs::write(dir.join(name), "{}\n").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 86400);
        for name in ["old.jsonl", "old_2.jsonl"] {
            std::fs::File::options().write(true).open(dir.join(name)).unwrap().set_modified(long_ago).unwrap();
        }
        let month = std::time::Duration::from_secs(30 * 86400);
        let said = prune(&dir, month, true).unwrap();
        let names: Vec<&str> = said.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names.len(), 2, "{said:?}");
        assert!(names.contains(&"old") && names.contains(&"old_2"));
        assert_eq!(said.iter().find(|(n, _)| n == "old").unwrap().1, 9, "with its files");
        assert!(dir.join("old.jsonl").exists(), "a dry run removes nothing");
        prune(&dir, month, false).unwrap();
        let left: std::collections::BTreeSet<String> =
            std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, [".index".to_owned(), "new.jsonl".to_owned(), "notes.txt".to_owned()].into());
        assert!(!dir.join(".index/old.json").exists(), "its recall index goes too");
        std::fs::remove_dir_all(dir).unwrap();
    }
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
        // A few over, until enough left for a summary.
        assert!(window.len() <= WINDOW + WINDOW / 4);
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
        let search = crate::recall::search;
        let found = search(&dir, "database backup", 5, "now");
        assert_eq!(found[0].session, "a");
        assert!(found[0].snippet.contains("/srv/backup"));
        // Tool output is not searched (it may be huge and is not what was said).
        assert!(found.iter().all(|h| !h.snippet.starts_with("tool")));
        assert!(search(&dir, "database", 5, "a").is_empty(), "the current conversation is skipped");
        assert!(search(&dir, "xy", 5, "").is_empty(), "short words alone find nothing");
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
    fn a_little_over_the_budget_waits_in_the_window_for_a_summary() {
        let dir = std::env::temp_dir().join(format!("autobot-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Session::open(&dir, "b").unwrap();
        s.budget = 16 * 1024;
        // A summary of everything so far, then turns of about 1 KiB each.
        for i in 0..20 {
            s.push(json!({"role": "user", "content": format!("turn {i}")})).unwrap();
            s.push(json!({"role": "assistant", "content": "x".repeat(1000)})).unwrap();
        }
        assert!(s.compaction().is_some());
        s.add_summary("the first turns").unwrap();
        assert!(s.compaction().is_none());
        // One more turn pushes one out of the budget: too little for a model call, so the window
        // keeps it rather than lose it.
        s.push(json!({"role": "user", "content": "one more"})).unwrap();
        s.push(json!({"role": "assistant", "content": "y".repeat(1000)})).unwrap();
        assert!(s.compaction().is_none());
        let first = s.window()[0]["content"].as_str().unwrap().to_owned();
        let covered = s.covered();
        assert_eq!(s.messages[covered]["content"], first.as_str(), "the window starts where the summary ends");
        // A few more, and what left is summarized in one call.
        for i in 0..3 {
            s.push(json!({"role": "user", "content": format!("later {i}")})).unwrap();
            s.push(json!({"role": "assistant", "content": "z".repeat(1000)})).unwrap();
        }
        let (previous, pending) = s.compaction().unwrap();
        assert_eq!(previous.as_deref(), Some("the first turns"));
        assert!(pending.len() >= 4 && pending[0]["content"] == first.as_str(), "{pending:?}");
        let _ = std::fs::remove_dir_all(&dir);
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
