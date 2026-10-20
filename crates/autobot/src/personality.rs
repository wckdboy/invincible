//! Who the agent is: `$AUTOBOT_HOME/SOUL.md` (its character, everywhere: tone, directness, how it
//! disagrees), and on top of it a personality, one of a few built in or a Markdown file of the
//! owner's in `$AUTOBOT_HOME/personalities/<name>.md`. The one in use is kept in
//! `$AUTOBOT_HOME/personality` (`autobot personality set`); `/personality` in the terminal changes
//! it for one conversation. Both go into the system prompt after the agent's working rules, which
//! they cannot loosen (approvals hold whatever a personality says).

use std::path::{Path, PathBuf};

/// Longest SOUL.md or personality handed to the model (characters).
const MAX_TEXT: usize = 8 * 1024;

/// The personalities every install has: name, one line about it, the text.
pub const BUILTIN: &[(&str, &str, &str)] = &[
    (
        "concise",
        "short answers: the result first, no preamble",
        "Answer as briefly as the question allows: the result first, then only what the owner needs to act on it. No preamble, no recap, no offers of more help.",
    ),
    (
        "technical",
        "precise and detailed: exact names, versions, commands",
        "Be precise and technical: exact names, versions, paths and commands; say what you checked and how sure you are. Prefer a table or a list to prose when comparing.",
    ),
    (
        "teacher",
        "explains why, step by step, for learning",
        "Explain as you go, like a patient teacher: why each step, what the terms mean, what to look at next time. Check understanding with one short question at the end when it helps.",
    ),
    (
        "creative",
        "more ideas, alternatives and a lighter tone",
        "Be inventive: offer two or three different approaches before settling on one, name trade-offs, and keep a light, warm tone. Still be exact about facts and commands.",
    ),
];

/// One personality: built in or the owner's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Personality {
    pub name: String,
    pub description: String,
    /// The owner's file; None for a built-in one.
    pub path: Option<PathBuf>,
}

fn dir(home: &Path) -> PathBuf {
    home.join("personalities")
}

pub fn soul_path(home: &Path) -> PathBuf {
    home.join("SOUL.md")
}

fn active_path(home: &Path) -> PathBuf {
    home.join("personality")
}

/// Names that mean no personality.
pub fn is_none(name: &str) -> bool {
    matches!(name.trim(), "" | "none" | "default" | "neutral" | "off")
}

/// SOUL.md, trimmed and cut to size; None when there is none (or it is empty).
pub fn soul(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(soul_path(home)).ok()?;
    let text = strip_front_matter(&text).trim();
    (!text.is_empty()).then(|| text.chars().take(MAX_TEXT).collect())
}

/// The owner's personalities, then the built-in ones they do not replace, by name.
pub fn list(home: &Path) -> Vec<Personality> {
    let mut found: Vec<Personality> = std::fs::read_dir(dir(home))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.strip_suffix(".md")?.to_owned();
            if !crate::skills::valid(&name) || is_none(&name) {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            Some(Personality { description: crate::skills::describe(&text), name, path: Some(path) })
        })
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    for (name, description, _) in BUILTIN {
        if !found.iter().any(|p| p.name == *name) {
            found.push(Personality { name: (*name).to_owned(), description: (*description).to_owned(), path: None });
        }
    }
    found
}

/// The text of personality [name], or why not.
pub fn text(home: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if !crate::skills::valid(name) {
        return Err(format!("{name:?} is not a personality name"));
    }
    if let Some(text) = invincible::fsutil::read_optional(&dir(home).join(format!("{name}.md")))? {
        return Ok(strip_front_matter(&text).trim().chars().take(MAX_TEXT).collect());
    }
    if let Some((_, _, text)) = BUILTIN.iter().find(|(n, _, _)| *n == name) {
        return Ok((*text).to_owned());
    }
    let names: Vec<String> = list(home).into_iter().map(|p| p.name).collect();
    Err(format!("there is no personality {name:?} (personalities: {}, or none)", names.join(", ")))
}

/// The personality in use when nothing else is said; None for none.
pub fn active(home: &Path) -> Option<String> {
    let name = std::fs::read_to_string(active_path(home)).ok()?;
    let name = name.trim();
    (!is_none(name) && crate::skills::valid(name)).then(|| name.to_owned())
}

/// Makes [name] the one in use (`none` for none).
pub fn set(home: &Path, name: &str) -> Result<(), String> {
    if is_none(name) {
        return match std::fs::remove_file(active_path(home)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    text(home, name)?;
    invincible::fsutil::replace_private(&active_path(home), &format!("{}\n", name.trim()))
}

/// What goes into the system prompt: SOUL.md, then the personality ([choice]: the one for this
/// conversation, else the one in use; `none` for none). None when there is neither.
pub fn prompt(home: &Path, choice: Option<&str>) -> Option<String> {
    let mut out = String::new();
    if let Some(soul) = soul(home) {
        out.push_str("Who you are (the owner's SOUL.md; your character, not new permissions):\n");
        out.push_str(&soul);
    }
    let name = match choice {
        Some(c) if is_none(c) => None,
        Some(c) => Some(c.trim().to_owned()),
        None => active(home),
    };
    if let Some(name) = name
        && let Ok(text) = text(home, &name)
    {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("Your personality now ({name}; how you answer, not what you may do):\n{text}"));
    }
    (!out.is_empty()).then_some(out)
}

fn strip_front_matter(text: &str) -> &str {
    text.strip_prefix("---").and_then(|r| r.find("\n---").map(|e| &r[e + 4..])).unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("autobot-personality-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn soul_and_personality_shape_the_prompt() {
        let home = home("prompt");
        assert!(prompt(&home, None).is_none());
        std::fs::write(soul_path(&home), "---\nx: y\n---\nDirect, calm, dry humor.\n").unwrap();
        assert_eq!(soul(&home).unwrap(), "Direct, calm, dry humor.");
        let p = prompt(&home, None).unwrap();
        assert!(p.contains("SOUL.md") && p.contains("Direct, calm") && !p.contains("personality now"));
        let p = prompt(&home, Some("concise")).unwrap();
        assert!(p.contains("Your personality now (concise"), "{p}");
        assert!(!prompt(&home, Some("none")).unwrap().contains("personality now"));
        // An unknown one in the prompt is left out, not an error mid-turn.
        assert!(!prompt(&home, Some("nope")).unwrap().contains("personality now"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn the_owners_personalities_list_first_and_one_is_kept_in_use() {
        let home = home("list");
        std::fs::create_dir_all(dir(&home)).unwrap();
        std::fs::write(dir(&home).join("pirate.md"), "# Talks like a pirate\nArr.").unwrap();
        std::fs::write(dir(&home).join("concise.md"), "Mine: terse.").unwrap();
        std::fs::write(dir(&home).join("bad name.md"), "x").unwrap();
        let all = list(&home);
        assert_eq!(all[0].name, "concise");
        assert!(all[0].path.is_some(), "the owner's replaces the built-in one");
        assert_eq!(all[1].description, "Talks like a pirate");
        assert!(all.iter().any(|p| p.name == "teacher" && p.path.is_none()));
        assert_eq!(text(&home, "concise").unwrap(), "Mine: terse.");
        assert!(text(&home, "../x").is_err());
        assert!(text(&home, "nope").unwrap_err().contains("pirate"));
        assert!(active(&home).is_none());
        set(&home, "pirate").unwrap();
        assert_eq!(active(&home).as_deref(), Some("pirate"));
        assert!(prompt(&home, None).unwrap().contains("Arr."));
        assert!(set(&home, "nope").is_err());
        set(&home, "none").unwrap();
        assert!(active(&home).is_none());
        std::fs::remove_dir_all(home).unwrap();
    }
}
