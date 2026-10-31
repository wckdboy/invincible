//! The plan for a long task: the `todo` list, kept for the conversation.
//!
//! A list that lives only in the transcript is lost to compaction and invisible to a resumed
//! delegated run. It is also a tool result, not an instruction. This stores the latest list in
//! `$AUTOBOT_HOME/sessions/<id>.plan.json` (mode 0600, replaced whole) and puts it back into the
//! system prompt on every step, so a long task keeps one current plan. The panel shows the same
//! list beside the conversation.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The most items one plan may have.
pub const MAX_ITEMS: usize = 100;
/// The most characters one item's text may have.
pub const MAX_TEXT: usize = 500;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Pending,
    Doing,
    Done,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Item {
    pub text: String,
    #[serde(default)]
    pub status: Status,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub session: String,
    pub items: Vec<Item>,
    /// Unix seconds.
    pub updated_at: u64,
}

impl Plan {
    pub fn done(&self) -> usize {
        self.items.iter().filter(|item| item.status == Status::Done).count()
    }

    pub fn view(&self) -> Value {
        json!({
            "session": self.session,
            "items": self.items,
            "updated_at": self.updated_at,
            "done": self.done(),
            "total": self.items.len(),
        })
    }

    /// How the model sees it: short marks, then the count.
    pub fn render(&self) -> String {
        let mut text = String::new();
        for item in &self.items {
            let mark = match item.status {
                Status::Done => "[x]",
                Status::Doing => "[>]",
                Status::Pending => "[ ]",
            };
            text.push_str(&format!("{mark} {}\n", item.text));
        }
        text.push_str(&format!("({} of {} done)", self.done(), self.items.len()));
        text
    }
}

fn valid_session(session: &str) -> bool {
    (1..=64).contains(&session.len()) && session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn file(home: &Path, session: &str) -> PathBuf {
    home.join("sessions").join(format!("{session}.plan.json"))
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub fn load(home: &Path, session: &str) -> Result<Option<Plan>, String> {
    if !valid_session(session) {
        return Err("not a session id".to_owned());
    }
    let path = file(home, session);
    let Some(text) = invincible::fsutil::read_optional(&path)? else {
        return Ok(None);
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let plan: Plan = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    if plan.items.len() > MAX_ITEMS {
        return Err(format!("{} has more than {MAX_ITEMS} items", path.display()));
    }
    Ok(Some(plan))
}

/// Reads the model's whole `todo` list, validates it and saves it. An empty list clears the plan.
pub fn save(home: &Path, session: &str, items: &Value) -> Result<Option<Plan>, String> {
    if !valid_session(session) {
        return Err("not a session id".to_owned());
    }
    let items = items.as_array().ok_or("`items` is a list")?;
    if items.len() > MAX_ITEMS {
        return Err(format!("a plan has at most {MAX_ITEMS} items"));
    }
    let mut plan = Plan { session: session.to_owned(), items: Vec::with_capacity(items.len()), updated_at: now() };
    for item in items {
        let text = item["text"].as_str().unwrap_or_default().trim();
        if text.is_empty() {
            return Err("every item needs text".to_owned());
        }
        if text.chars().count() > MAX_TEXT {
            return Err(format!("an item's text is at most {MAX_TEXT} characters"));
        }
        let status = match item["status"].as_str() {
            Some("done") => Status::Done,
            Some("doing") => Status::Doing,
            Some("pending") | None => Status::Pending,
            Some(other) => return Err(format!("unknown status {other:?} (pending, doing or done)")),
        };
        plan.items.push(Item { text: text.to_owned(), status });
    }
    let path = file(home, session);
    if plan.items.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
        return Ok(None);
    }
    let text = serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())?;
    invincible::fsutil::replace_private(&path, &format!("{text}\n"))?;
    Ok(Some(plan))
}

pub fn remove(home: &Path, session: &str) -> Result<(), String> {
    if !valid_session(session) {
        return Ok(());
    }
    let path = file(home, session);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The plan as the system prompt carries it, when there is one.
pub fn prompt(home: &Path, session: &str) -> Option<String> {
    let plan = load(home, session).ok().flatten()?;
    if plan.items.is_empty() {
        return None;
    }
    Some(format!(
        "Your plan for this task (the `todo` tool keeps it; update it as you go, and do not claim \
         it is done while an item is open):\n{}",
        plan.render()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("autobot-plan-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        dir
    }

    #[test]
    fn a_plan_survives_and_is_rendered() {
        let home = dir();
        let items = json!([
            { "text": "read the parser", "status": "done" },
            { "text": "fix the test", "status": "doing" },
            { "text": "run the suite", "status": "pending" }
        ]);
        let plan = save(&home, "s1", &items).unwrap().unwrap();
        assert_eq!(plan.done(), 1);
        let loaded = load(&home, "s1").unwrap().unwrap();
        assert_eq!(loaded.render(), "[x] read the parser\n[>] fix the test\n[ ] run the suite\n(1 of 3 done)");
        let carried = prompt(&home, "s1").unwrap();
        assert!(carried.contains("Your plan for this task"));
        assert!(carried.contains("[>] fix the test"));
        // A new whole list replaces the old one; an empty list clears it.
        save(&home, "s1", &json!([{ "text": "ship", "status": "done" }])).unwrap();
        assert_eq!(load(&home, "s1").unwrap().unwrap().items.len(), 1);
        assert!(save(&home, "s1", &json!([])).unwrap().is_none());
        assert!(load(&home, "s1").unwrap().is_none());
        assert!(prompt(&home, "s1").is_none());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_bad_plan_is_refused() {
        let home = dir();
        assert!(save(&home, "s1", &json!("no")).is_err());
        assert!(save(&home, "s1", &json!([{ "text": "", "status": "pending" }])).is_err());
        assert!(save(&home, "s1", &json!([{ "text": "x", "status": "later" }])).is_err());
        assert!(save(&home, "../escape", &json!([])).is_err());
        let _ = std::fs::remove_dir_all(home);
    }
}
