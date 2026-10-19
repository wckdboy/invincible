//! Skills: how-to notes the owner gives the agent, one Markdown file each in
//! `$AUTOBOT_HOME/skills/` (`deploy.md`, `nightfall-export.md`). The agent sees every skill's name and
//! one-line description and reads one with `read_skill` when it fits the task. A file may start
//! with front matter (`---\ndescription: …\n---`); otherwise its first line of text describes it.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// Longest skill handed to the model (characters).
const MAX_SKILL: usize = 16 * 1024;

fn dir(home: &Path) -> PathBuf {
    home.join("skills")
}

/// A skill name: letters, digits, `-` and `_`.
pub fn valid(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn list(home: &Path) -> Vec<Skill> {
    let mut skills: Vec<Skill> = std::fs::read_dir(dir(home))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.strip_suffix(".md")?.to_owned();
            if !valid(&name) {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            Some(Skill { description: describe(&text), name, path })
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// The skill [name]'s text, or why not.
pub fn read(home: &Path, name: &str) -> Result<String, String> {
    if !valid(name) {
        return Err(format!("{name:?} is not a skill name"));
    }
    let path = dir(home).join(format!("{name}.md"));
    let text = std::fs::read_to_string(&path).map_err(|_| {
        let known: Vec<String> = list(home).into_iter().map(|s| s.name).collect();
        format!(
            "there is no skill {name:?} (skills: {})",
            if known.is_empty() { "none".into() } else { known.join(", ") }
        )
    })?;
    Ok(text.chars().take(MAX_SKILL).collect())
}

/// The list for the system prompt; None when there are no skills.
pub fn prompt(home: &Path) -> Option<String> {
    let skills = list(home);
    (!skills.is_empty())
        .then(|| skills.iter().map(|s| format!("- {}: {}", s.name, s.description)).collect::<Vec<_>>().join("\n"))
}

fn describe(text: &str) -> String {
    if let Some(rest) = text.strip_prefix("---")
        && let Some(end) = rest.find("\n---")
        && let Some(line) = rest[..end].lines().find_map(|l| l.trim().strip_prefix("description:"))
    {
        return line.trim().trim_matches('"').chars().take(200).collect();
    }
    let body = text.strip_prefix("---").and_then(|r| r.find("\n---").map(|e| &r[e + 4..])).unwrap_or(text);
    body.lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .unwrap_or("(no description)")
        .chars()
        .take(200)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{list, prompt, read};

    #[test]
    fn skills_are_listed_described_and_read() {
        let home = std::env::temp_dir().join(format!("autobot-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert!(prompt(&home).is_none());
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::write(
            home.join("skills/deploy.md"),
            "---\ndescription: Deploy the site to the VPS\n---\n1. git pull\n2. restart",
        )
        .unwrap();
        std::fs::write(home.join("skills/backup.md"), "# Check the nightly backup\n\nLook in /var/backups.").unwrap();
        std::fs::write(home.join("skills/bad name.md"), "x").unwrap();
        std::fs::write(home.join("skills/notes.txt"), "x").unwrap();
        let skills = list(&home);
        assert_eq!(skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["backup", "deploy"]);
        assert_eq!(prompt(&home).unwrap(), "- backup: Check the nightly backup\n- deploy: Deploy the site to the VPS");
        assert!(read(&home, "deploy").unwrap().contains("git pull"));
        assert!(read(&home, "../config").is_err());
        assert!(read(&home, "nope").unwrap_err().contains("skills: backup, deploy"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
