//! Trajectories: finished turns as the model saw them (the system prompt, the tool list, the
//! conversation with its tool calls and results, and the answer), one JSON line each, for
//! fine-tuning a local model on the agent's own good work.
//!
//! `[agent] trajectories = true` keeps every turn in `$AUTOBOT_HOME/trajectories/<YYYY-MM>.jsonl`
//! (0600, like the sessions; off by default); `autobot eval --trajectories FILE` keeps the
//! passing runs of an eval. `autobot trajectories` counts them and exports them, filtered, in
//! the OpenAI fine-tuning shape or ShareGPT's.
//!
//! A line: `{"messages": [...], "tools": [...], "meta": {"at", "session", "agent", "models",
//! "receipts", "steps", "refused", "outcome": "answer" | "stopped", "source": "turn" | "eval",
//! "task", "pass"}}`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};

/// Where finished turns go.
#[derive(Debug)]
pub enum Recorder {
    /// Appended to `<dir>/<YYYY-MM>.jsonl`.
    Dir(PathBuf),
    /// Kept in memory (an eval keeps a run only when its checks pass).
    Memory(Mutex<Vec<Value>>),
}

impl Recorder {
    pub fn dir(home: &Path) -> Self {
        Self::Dir(home.join("trajectories"))
    }

    pub fn memory() -> Self {
        Self::Memory(Mutex::default())
    }

    pub fn record(&self, record: Value) {
        match self {
            Self::Dir(dir) => {
                let file = dir.join(format!("{}.jsonl", chrono::Utc::now().format("%Y-%m")));
                if let Err(e) = append(&file, &record) {
                    tracing::warn!("trajectory not kept: {e}");
                }
            }
            Self::Memory(kept) => kept.lock().expect("trajectories").push(record),
        }
    }

    /// What a [Recorder::Memory] kept (nothing for a directory).
    pub fn take(&self) -> Vec<Value> {
        match self {
            Self::Dir(_) => Vec::new(),
            Self::Memory(kept) => std::mem::take(&mut *kept.lock().expect("trajectories")),
        }
    }
}

/// Appends [record] as a line of [file] (0600).
pub fn append(file: &Path, record: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut out = options.open(file).map_err(|e| format!("{}: {e}", file.display()))?;
    writeln!(out, "{record}").map_err(|e| format!("{}: {e}", file.display()))
}

/// Every trajectory in [dir] (oldest first), torn lines skipped.
pub fn load(dir: &Path) -> Vec<Value> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    files.iter().flat_map(|f| read(f)).collect()
}

/// The trajectories in one file.
pub fn read(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["messages"].is_array())
        .collect()
}

/// Which trajectories to export.
#[derive(Clone, Debug, Default)]
pub struct Filter {
    /// Only those that ended in an answer, with nothing refused (and, from an eval, passed).
    pub clean: bool,
    /// Only those a model with this id answered in.
    pub model: Option<String>,
    /// Only those this recent (RFC 3339 or a date).
    pub since: Option<String>,
    /// Only the lead's turns, or only this member's.
    pub agent: Option<String>,
}

impl Filter {
    pub fn keeps(&self, t: &Value) -> bool {
        let meta = &t["meta"];
        if self.clean
            && (meta["outcome"] != "answer" || meta["refused"].as_u64().unwrap_or(0) > 0 || meta["pass"] == false)
        {
            return false;
        }
        if let Some(model) = &self.model
            && !meta["models"].as_array().is_some_and(|m| m.iter().any(|x| x == model.as_str()))
        {
            return false;
        }
        if let Some(since) = &self.since
            && meta["at"].as_str().is_none_or(|at| at < since.as_str())
        {
            return false;
        }
        match self.agent.as_deref() {
            None => true,
            Some("lead") => meta["agent"].is_null(),
            Some(name) => meta["agent"] == name,
        }
    }
}

/// The export shapes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// `{"messages": [...], "tools": [...]}`: OpenAI's fine-tuning shape, read by most trainers.
    OpenAi,
    /// `{"conversations": [{"from", "value"}], "tools": "..."}`, tool calls as `<tool_call>` and
    /// results as `<tool_response>` (Hermes' function-calling format).
    ShareGpt,
}

impl std::str::FromStr for Format {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "openai" => Ok(Self::OpenAi),
            "sharegpt" => Ok(Self::ShareGpt),
            _ => Err(format!("{s:?}: openai or sharegpt")),
        }
    }
}

/// [t] in [format], without its meta.
pub fn export(t: &Value, format: Format) -> Value {
    match format {
        Format::OpenAi => json!({ "messages": t["messages"], "tools": t["tools"] }),
        Format::ShareGpt => {
            let mut conversations = Vec::new();
            for m in t["messages"].as_array().into_iter().flatten() {
                let content = m["content"].as_str().unwrap_or_default();
                let (from, value) = match m["role"].as_str() {
                    Some("system") => ("system", content.to_owned()),
                    Some("user") => ("human", content.to_owned()),
                    Some("tool") => ("tool", format!("<tool_response>\n{content}\n</tool_response>")),
                    _ => {
                        let mut value = content.to_owned();
                        for call in m["tool_calls"].as_array().into_iter().flatten() {
                            let arguments = call["function"]["arguments"]
                                .as_str()
                                .and_then(|a| serde_json::from_str::<Value>(a).ok())
                                .unwrap_or_else(|| call["function"]["arguments"].clone());
                            let call = json!({ "name": call["function"]["name"], "arguments": arguments });
                            if !value.is_empty() {
                                value.push('\n');
                            }
                            value.push_str(&format!("<tool_call>\n{call}\n</tool_call>"));
                        }
                        ("gpt", value)
                    }
                };
                conversations.push(json!({ "from": from, "value": value }));
            }
            json!({ "conversations": conversations, "tools": t["tools"].to_string() })
        }
    }
}

/// Counts for `autobot trajectories`: total, clean, and per model.
pub fn stats(all: &[Value]) -> String {
    let clean = Filter { clean: true, ..Default::default() };
    let mut per_model: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
    for t in all {
        let ok = clean.keeps(t);
        for model in t["meta"]["models"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let entry = per_model.entry(model.to_owned()).or_default();
            entry.0 += 1;
            entry.1 += usize::from(ok);
        }
    }
    let mut out = format!(
        "{} trajectories, {} clean (an answer, nothing refused)\n",
        all.len(),
        all.iter().filter(|t| clean.keeps(t)).count()
    );
    for (model, (n, ok)) in per_model {
        out.push_str(&format!("  {model}: {n} ({ok} clean)\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Filter, Format, Recorder, export, load, stats};
    use serde_json::json;

    fn sample(outcome: &str, refused: u64, model: &str) -> serde_json::Value {
        json!({
            "messages": [
                { "role": "system", "content": "You are Autobot." },
                { "role": "user", "content": "list files" },
                { "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
                    "function": { "name": "list_dir", "arguments": "{\"path\":\".\"}" } }] },
                { "role": "tool", "tool_call_id": "c1", "content": "a.txt" },
                { "role": "assistant", "content": "a.txt" },
            ],
            "tools": [{ "type": "function", "function": { "name": "list_dir" } }],
            "meta": { "at": "2026-10-19T10:00:00Z", "models": [model], "outcome": outcome, "refused": refused,
                      "agent": null },
        })
    }

    #[test]
    fn turns_are_kept_and_filtered() {
        let dir = std::env::temp_dir().join(format!("autobot-traj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let recorder = Recorder::Dir(dir.clone());
        recorder.record(sample("answer", 0, "qwen"));
        recorder.record(sample("answer", 1, "qwen"));
        recorder.record(sample("stopped", 0, "deepseek"));
        let all = load(&dir);
        assert_eq!(all.len(), 3);
        let clean = Filter { clean: true, ..Default::default() };
        assert_eq!(all.iter().filter(|t| clean.keeps(t)).count(), 1);
        let deepseek = Filter { model: Some("deepseek".into()), ..Default::default() };
        assert_eq!(all.iter().filter(|t| deepseek.keeps(t)).count(), 1);
        let later = Filter { since: Some("2026-11-01".into()), ..Default::default() };
        assert_eq!(all.iter().filter(|t| later.keeps(t)).count(), 0);
        assert_eq!(
            all.iter().filter(|t| Filter { agent: Some("lead".into()), ..Default::default() }.keeps(t)).count(),
            3
        );
        assert!(stats(&all).starts_with("3 trajectories, 1 clean"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exports_in_both_shapes() {
        let t = sample("answer", 0, "qwen");
        let openai = export(&t, Format::OpenAi);
        assert!(openai.get("meta").is_none());
        assert_eq!(openai["messages"].as_array().unwrap().len(), 5);
        let share = export(&t, Format::ShareGpt);
        let turns = share["conversations"].as_array().unwrap();
        assert_eq!(turns[1]["from"], "human");
        assert_eq!(
            turns[2]["value"],
            "<tool_call>\n{\"arguments\":{\"path\":\".\"},\"name\":\"list_dir\"}\n</tool_call>"
        );
        assert_eq!(turns[3]["value"], "<tool_response>\na.txt\n</tool_response>");
        assert_eq!(turns[4], json!({ "from": "gpt", "value": "a.txt" }));
    }
}
