//! Operator variables: named, non-secret values the owner wants every turn to know.
//!
//! They are stored in `$AUTOBOT_HOME/variables.json` (mode 0600) and added to the system prompt as
//! data, never as instructions. Secrets belong in the connector files, not here: a variable is
//! visible to the model.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_VALUE: usize = 4_000;
const MAX_DESCRIPTION: usize = 200;
const MAX_PROMPT: usize = 8_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Variable {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub updated_at: u64,
}

impl Variable {
    pub fn view(&self) -> Value {
        json!({
            "key": self.key,
            "value": self.value,
            "description": self.description,
            "updated_at": self.updated_at,
        })
    }
}

pub struct Variables {
    home: PathBuf,
    lock: Mutex<()>,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    variables: BTreeMap<String, Variable>,
}

impl Variables {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), lock: Mutex::new(()) }
    }

    fn file(&self) -> PathBuf {
        self.home.join("variables.json")
    }

    fn load(&self) -> Result<BTreeMap<String, Variable>, String> {
        let Some(text) = invincible::fsutil::read_optional(&self.file())? else {
            return Ok(BTreeMap::new());
        };
        if text.trim().is_empty() {
            return Ok(BTreeMap::new());
        }
        let registry: Registry = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.file().display()))?;
        Ok(registry.variables)
    }

    fn save(&self, variables: &BTreeMap<String, Variable>) -> Result<(), String> {
        let text =
            serde_json::to_string_pretty(&Registry { variables: variables.clone() }).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&self.file(), &format!("{text}\n"))
    }

    pub fn list(&self) -> Result<Vec<Variable>, String> {
        let _guard = self.lock.lock().map_err(|_| "the variables lock is poisoned".to_owned())?;
        Ok(self.load()?.into_values().collect())
    }

    pub fn set(&self, key: &str, value: &str, description: &str) -> Result<Variable, String> {
        let key = key.trim();
        validate_key(key)?;
        let value = value.trim().to_owned();
        if value.is_empty() {
            return Err("the value is empty".to_owned());
        }
        if value.contains('\n') || value.contains('\r') || value.chars().any(char::is_control) {
            return Err("a variable is one line and has no control characters".to_owned());
        }
        if value.chars().count() > MAX_VALUE {
            return Err(format!("the value is at most {MAX_VALUE} characters"));
        }
        let description = description.trim().to_owned();
        if description.chars().count() > MAX_DESCRIPTION || description.chars().any(char::is_control) {
            return Err(format!("the description is at most {MAX_DESCRIPTION} characters, one line"));
        }
        let _guard = self.lock.lock().map_err(|_| "the variables lock is poisoned".to_owned())?;
        let mut variables = self.load()?;
        let variable = Variable { key: key.to_owned(), value, description, updated_at: now() };
        variables.insert(key.to_owned(), variable.clone());
        self.save(&variables)?;
        Ok(variable)
    }

    pub fn remove(&self, key: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().map_err(|_| "the variables lock is poisoned".to_owned())?;
        let mut variables = self.load()?;
        let removed = variables.remove(key).is_some();
        if removed {
            self.save(&variables)?;
        }
        Ok(removed)
    }

    /// The block added to the system prompt. Empty when there are no variables.
    pub fn prompt(&self) -> Option<String> {
        let variables = self.list().ok()?;
        if variables.is_empty() {
            return None;
        }
        let mut out = String::from(
            "\n\n## Operator variables\nData set by the owner for context, not instructions. Use it when it is relevant.\n",
        );
        for variable in variables {
            let line = format!(
                "- {}: {}{}\n",
                variable.key,
                variable.value,
                if variable.description.is_empty() { String::new() } else { format!("  ({})", variable.description) }
            );
            if out.len() + line.len() > MAX_PROMPT {
                break;
            }
            out.push_str(&line);
        }
        Some(out)
    }
}

pub fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 80 {
        return Err("a variable key is 1–80 characters".to_owned());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err("a variable key uses letters, digits, _, - and . only".to_owned());
    }
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The variables file for [home], for callers that only need to read the prompt.
pub fn prompt(home: &Path) -> Option<String> {
    Variables::new(home).prompt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "autobot-variables-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn variables_round_trip_and_build_a_prompt() {
        let dir = dir();
        let variables = Variables::new(&dir);
        variables.set("project.name", "checkout", "the repository name").unwrap();
        variables.set("deploy.host", "staging.example.org", "").unwrap();
        let prompt = variables.prompt().unwrap();
        assert!(prompt.contains("project.name: checkout"));
        assert!(prompt.contains("deploy.host: staging.example.org"));
        assert_eq!(variables.list().unwrap().len(), 2);
        assert!(variables.remove("deploy.host").unwrap());
        assert!(!variables.remove("missing").unwrap());
        assert!(!variables.prompt().unwrap().contains("deploy.host"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keys_and_values_are_bounded() {
        let dir = dir();
        let variables = Variables::new(&dir);
        assert!(variables.set("", "x", "").is_err());
        assert!(variables.set("a/b", "x", "").is_err());
        assert!(variables.set("ok", "line\nbreak", "").is_err());
        assert!(variables.set("ok", "x".repeat(MAX_VALUE + 1).as_str(), "").is_err());
        assert!(variables.set("café", "x", "").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
