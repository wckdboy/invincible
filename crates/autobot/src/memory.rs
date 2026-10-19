//! What the agent remembers between conversations: short facts it chose to keep (`remember`), in
//! `$AUTOBOT_HOME/memory.jsonl`, shown to it at the start of every turn. The owner reads and
//! removes them with `autobot memory`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One remembered fact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    pub id: u64,
    /// Unix seconds.
    pub at: u64,
    pub text: String,
}

/// Longest fact kept (characters).
pub const MAX_FACT: usize = 500;
/// Most of memory shown to the model per turn (characters), newest facts first.
const PROMPT_BUDGET: usize = 4000;

pub struct Memory {
    path: PathBuf,
}

impl Memory {
    pub fn new(home: &Path) -> Self {
        Self { path: home.join("memory.jsonl") }
    }

    /// A team member's own memory (`agents/<name>/memory.jsonl`): what it keeps for itself.
    pub fn member(home: &Path, name: &str) -> Self {
        Self { path: home.join("agents").join(name).join("memory.jsonl") }
    }

    /// The memory for this turn: the member's own when a team member is working, else the shared one.
    pub fn current(home: &Path) -> Self {
        match crate::tools::TURN.try_with(|t| t.agent.clone()).ok().flatten() {
            Some(name) if crate::team::valid_name(&name) => Self::member(home, &name),
            _ => Self::new(home),
        }
    }

    pub fn list(&self) -> Vec<Fact> {
        std::fs::read_to_string(&self.path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// Keeps [text]; its id.
    pub fn add(&self, text: &str) -> Result<u64, String> {
        let text: String = text.trim().chars().take(MAX_FACT).collect();
        if text.is_empty() {
            return Err("nothing to remember".to_owned());
        }
        let facts = self.list();
        if let Some(same) = facts.iter().find(|f| f.text == text) {
            return Ok(same.id);
        }
        let id = facts.iter().map(|f| f.id).max().unwrap_or(0) + 1;
        let at =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        let line = serde_json::to_string(&Fact { id, at, text }).map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| format!("{}: {e}", self.path.display()))?;
        Ok(id)
    }

    /// Removes fact [id]; false when there is none.
    pub fn forget(&self, id: u64) -> Result<bool, String> {
        let facts = self.list();
        let kept: Vec<&Fact> = facts.iter().filter(|f| f.id != id).collect();
        if kept.len() == facts.len() {
            return Ok(false);
        }
        let text: String = kept.iter().filter_map(|f| serde_json::to_string(f).ok()).map(|l| l + "\n").collect();
        invincible::fsutil::replace_private(&self.path, &text)?;
        Ok(true)
    }

    /// The facts for the system prompt, newest first, within the budget; None when there are none.
    pub fn prompt(&self) -> Option<String> {
        let mut used = 0;
        let lines: Vec<String> = self
            .list()
            .into_iter()
            .rev()
            .take_while(|f| {
                used += f.text.len() + 3;
                used <= PROMPT_BUDGET
            })
            .map(|f| format!("- {}", f.text))
            .collect();
        (!lines.is_empty()).then(|| lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_FACT, Memory};

    #[test]
    fn remembers_forgets_and_fits_the_prompt() {
        let home = std::env::temp_dir().join(format!("autobot-memory-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let memory = Memory::new(&home);
        assert!(memory.prompt().is_none());
        assert_eq!(memory.add("The owner's main project is Nightfall.").unwrap(), 1);
        assert_eq!(memory.add("Backups run at 02:00.").unwrap(), 2);
        assert_eq!(memory.add("Backups run at 02:00.").unwrap(), 2, "no duplicates");
        assert!(memory.add("   ").is_err());
        assert_eq!(memory.prompt().unwrap(), "- Backups run at 02:00.\n- The owner's main project is Nightfall.");
        assert!(memory.forget(1).unwrap());
        assert!(!memory.forget(1).unwrap());
        assert_eq!(memory.list().len(), 1);
        assert_eq!(
            memory
                .add(&"x".repeat(2 * MAX_FACT))
                .map(|id| memory.list().iter().find(|f| f.id == id).unwrap().text.len())
                .unwrap(),
            MAX_FACT
        );
        for i in 0..40 {
            memory.add(&format!("{i} {}", "y".repeat(400))).unwrap();
        }
        assert!(memory.prompt().unwrap().len() <= 4000);
        assert!(memory.prompt().unwrap().starts_with("- 39 "), "newest first");
        std::fs::remove_dir_all(home).unwrap();
    }
}
