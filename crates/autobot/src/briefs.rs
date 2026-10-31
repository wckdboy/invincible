//! The owner's brief for a project: standing context for a large repository.
//!
//! `AGENTS.md` is the repository's instructions and is read from whatever checkout a turn runs
//! in. A brief is the owner's own, kept beside the agent in `$AUTOBOT_HOME/briefs.json` and keyed
//! by the project's root, so every thread worktree of the same repository shares it even when it
//! is not committed. It is carried in the system prompt of every turn; it is not a secret
//! (secrets stay in the secret files).

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The most bytes one brief may have.
pub const MAX_BRIEF: usize = 64 * 1024;
/// The most projects with a brief.
pub const MAX_BRIEFS: usize = 50;

static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Brief {
    /// The canonical project root.
    pub root: String,
    pub name: String,
    pub brief: String,
    /// Unix seconds.
    pub updated_at: u64,
}

impl Brief {
    pub fn view(&self) -> Value {
        json!({
            "root": self.root,
            "name": self.name,
            "brief": self.brief,
            "characters": self.brief.chars().count(),
            "updated_at": self.updated_at,
        })
    }
}

fn valid_root(root: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    Ok(root)
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub fn root_for(workdir: &Path) -> PathBuf {
    workdir.canonicalize().unwrap_or_else(|_| workdir.to_path_buf())
}

struct Store {
    home: PathBuf,
}

impl Store {
    fn file(&self) -> PathBuf {
        self.home.join("briefs.json")
    }

    fn load(&self) -> Result<Vec<Brief>, String> {
        let Some(text) = invincible::fsutil::read_optional(&self.file())? else {
            return Ok(Vec::new());
        };
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        #[derive(Default, Deserialize)]
        struct Registry {
            #[serde(default)]
            briefs: Vec<Brief>,
        }
        let registry: Registry = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.file().display()))?;
        Ok(registry.briefs)
    }

    fn save(&self, briefs: &[Brief]) -> Result<(), String> {
        #[derive(Serialize)]
        struct Registry<'a> {
            briefs: &'a [Brief],
        }
        let text = serde_json::to_string_pretty(&Registry { briefs }).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&self.file(), &format!("{text}\n"))
    }
}

/// Every brief, newest first.
pub fn list(home: &Path) -> Result<Vec<Brief>, String> {
    let _guard = LOCK.lock().map_err(|_| "the brief store lock is poisoned".to_owned())?;
    let mut briefs = Store { home: home.to_owned() }.load()?;
    briefs.sort_by_key(|brief| std::cmp::Reverse(brief.updated_at));
    Ok(briefs)
}

pub fn get(home: &Path, root: &Path) -> Result<Option<Brief>, String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    Ok(list(home)?.into_iter().find(|brief| Path::new(&brief.root) == root))
}

/// Writes the brief for [root]; an empty text removes it. The root must be a directory.
pub fn set(home: &Path, root: &Path, text: &str) -> Result<Option<Brief>, String> {
    let root = valid_root(root)?;
    let text = text.trim_end();
    if text.len() > MAX_BRIEF {
        return Err(format!("a brief is at most {MAX_BRIEF} bytes"));
    }
    let _guard = LOCK.lock().map_err(|_| "the brief store lock is poisoned".to_owned())?;
    let store = Store { home: home.to_owned() };
    let mut briefs = store.load()?;
    let root_text = root.display().to_string();
    briefs.retain(|brief| brief.root != root_text);
    if text.trim().is_empty() {
        store.save(&briefs)?;
        return Ok(None);
    }
    if briefs.len() >= MAX_BRIEFS {
        return Err(format!("there are already {MAX_BRIEFS} project briefs; remove one first"));
    }
    let name = root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| root_text.clone());
    let brief = Brief { root: root_text, name, brief: text.to_owned(), updated_at: now() };
    briefs.push(brief.clone());
    store.save(&briefs)?;
    Ok(Some(brief))
}

pub fn remove(home: &Path, root: &Path) -> Result<bool, String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let _guard = LOCK.lock().map_err(|_| "the brief store lock is poisoned".to_owned())?;
    let store = Store { home: home.to_owned() };
    let mut briefs = store.load()?;
    let before = briefs.len();
    let root_text = root.display().to_string();
    briefs.retain(|brief| brief.root != root_text);
    if briefs.len() == before {
        return Ok(false);
    }
    store.save(&briefs)?;
    Ok(true)
}

/// The brief as the system prompt carries it, when [root] has one.
pub fn prompt(home: &Path, root: &Path) -> Option<String> {
    let brief = get(home, root).ok().flatten()?;
    if brief.brief.trim().is_empty() {
        return None;
    }
    Some(format!("The owner's brief for {} ({}):\n{}", brief.name, brief.root, brief.brief))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "autobot-brief-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("project")).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        dir
    }

    #[test]
    fn a_brief_is_kept_per_project_and_reaches_the_prompt() {
        let dir = temp("one");
        let root = dir.join("project");
        let home = dir.join("home");
        let brief = set(&home, &root, "Rust workspace; run `cargo test`.").unwrap().unwrap();
        assert_eq!(brief.name, "project");
        assert_eq!(get(&home, &root).unwrap().unwrap().brief, "Rust workspace; run `cargo test`.");
        assert!(prompt(&home, &root).unwrap().contains("cargo test"));
        // Setting it again replaces it; empty text removes it.
        set(&home, &root, "Two crates.").unwrap();
        assert_eq!(list(&home).unwrap().len(), 1);
        assert!(set(&home, &root, "   ").unwrap().is_none());
        assert!(list(&home).unwrap().is_empty());
        assert!(prompt(&home, &root).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_brief_is_bounded_and_roots_must_exist() {
        let dir = temp("two");
        let home = dir.join("home");
        assert!(set(&home, &dir.join("missing"), "x").is_err());
        assert!(set(&home, &dir.join("project"), &"x".repeat(MAX_BRIEF + 1)).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
