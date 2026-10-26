//! The agent's action log: every command, file write, outside read and cloud send it asked to do,
//! whether it ran, and who said so (the policy, the owner on which channel, a grant for the
//! session), in `$AUTOBOT_HOME/actions.jsonl`. Read with `autobot actions` or `GET /v1/agent/actions`.

use std::io::BufRead;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The log is rotated (to `actions.1.jsonl`, replacing an older one) past this size.
const ROTATE_AT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Unix seconds.
    pub at: u64,
    pub session: String,
    /// `command`, `write`, `read` or `cloud`.
    pub kind: String,
    /// What it was, as the owner was shown it.
    pub action: String,
    pub ran: bool,
    /// `policy` (allowed or refused by the rules), `grant` (an earlier "always" in this session),
    /// or the channel the owner answered on (`cli`, `app`, `telegram`); `unattended` when no one
    /// could be asked.
    pub by: String,
    /// On a command that ran: where, and how confined ([crate::tools::Tools::confinement]):
    /// `bwrap` or `sandbox-exec` (here, writing only in the working directory), `off` (here,
    /// unconfined), `container` or `ssh`. None on other kinds and on older entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
}

pub struct ActionLog {
    path: PathBuf,
}

impl ActionLog {
    pub fn new(home: &Path) -> Self {
        Self { path: home.join("actions.jsonl") }
    }

    fn rotated(&self) -> PathBuf {
        self.path.with_file_name("actions.1.jsonl")
    }

    pub fn append(&self, entry: &Entry) -> Result<(), String> {
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() >= ROTATE_AT) {
            std::fs::rename(&self.path, self.rotated()).map_err(|e| format!("{}: {e}", self.path.display()))?;
        }
        let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        invincible::fsutil::append_private(&self.path, &line)
    }

    /// The newest [limit] entries at or after [since] (unix seconds), oldest first.
    pub fn read(&self, since: u64, limit: usize) -> Vec<Entry> {
        let entries: Vec<Entry> = [self.rotated(), self.path.clone()]
            .iter()
            .filter_map(|p| std::fs::File::open(p).ok())
            .flat_map(|f| std::io::BufReader::new(f).lines().map_while(Result::ok))
            .filter_map(|l| serde_json::from_str::<Entry>(&l).ok())
            .filter(|e| e.at >= since)
            .collect();
        let skip = entries.len().saturating_sub(limit);
        entries.into_iter().skip(skip).collect()
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{ActionLog, Entry};

    #[test]
    fn appends_and_reads_the_newest() {
        let home = std::env::temp_dir().join(format!("autobot-actions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let log = ActionLog::new(&home);
        assert!(log.read(0, 10).is_empty());
        for (i, by) in ["policy", "telegram", "grant"].iter().enumerate() {
            log.append(&Entry {
                at: 100 + i as u64,
                session: "s".into(),
                kind: "command".into(),
                action: format!("run: echo {i}"),
                ran: i != 1,
                by: (*by).into(),
                sandbox: (i != 1).then(|| "off".into()),
            })
            .unwrap();
        }
        let newest = log.read(0, 2);
        assert_eq!(newest.iter().map(|e| e.by.as_str()).collect::<Vec<_>>(), ["telegram", "grant"]);
        assert!(!newest[0].ran);
        assert_eq!(newest[1].sandbox.as_deref(), Some("off"));
        assert_eq!(log.read(102, 10).len(), 1);
        // Entries from before the field was recorded still read.
        let old = r#"{"at":1,"session":"s","kind":"command","action":"run: ls","ran":true,"by":"policy"}"#;
        assert_eq!(serde_json::from_str::<Entry>(old).unwrap().sandbox, None);
        std::fs::remove_dir_all(home).unwrap();
    }
}
