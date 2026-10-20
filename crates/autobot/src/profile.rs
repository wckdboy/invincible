//! What the agent knows about how its owner works: `$AUTOBOT_HOME/USER.md`, a short Markdown list
//! it keeps up to date with `update_user_profile` (one small change at a time, shown to the owner
//! as a diff), and that leads every conversation. The owner reads and edits it like any file
//! (`autobot profile`, `/profile`). Never secrets or personal data: every change goes through
//! [sensitive] (the gateway's redactor for personal data, and patterns for keys and tokens) and is
//! refused when it finds something.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

/// Most of USER.md kept, and shown to the model (characters).
pub const MAX_PROFILE: usize = 2000;
/// Longest entry.
pub const MAX_ENTRY: usize = 300;

const HEADER: &str = "# About the owner\n\nKept by Autobot with update_user_profile; edit it freely.\n\n";

pub fn path(home: &Path) -> PathBuf {
    home.join("USER.md")
}

/// USER.md as it is; empty when there is none.
pub fn read(home: &Path) -> String {
    std::fs::read_to_string(path(home)).unwrap_or_default()
}

/// Its entries: the `- ` lines.
pub fn entries(home: &Path) -> Vec<String> {
    read(home).lines().filter_map(|l| l.trim().strip_prefix("- ").map(|e| e.trim().to_owned())).collect()
}

/// One change to the profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Add(String),
    /// The entry that contains the first text becomes the second.
    Replace(String, String),
    /// The entry that contains this text goes.
    Remove(String),
}

/// USER.md as it would be after [change]; or why not.
pub fn apply(text: &str, change: &Change) -> Result<String, String> {
    let entry = |t: &str| -> Result<String, String> {
        let t = t.trim().trim_start_matches("- ").replace('\n', " ");
        if t.is_empty() {
            return Err("the entry is empty".to_owned());
        }
        if t.chars().count() > MAX_ENTRY {
            return Err(format!("keep an entry under {MAX_ENTRY} characters"));
        }
        if let Some(why) = sensitive(&t) {
            return Err(format!(
                "not kept: it contains {why}; the profile is for how the owner works, never secrets or personal data"
            ));
        }
        Ok(t)
    };
    let base = if text.trim().is_empty() { HEADER.to_owned() } else { text.to_owned() };
    let mut lines: Vec<String> = base.lines().map(str::to_owned).collect();
    let find = |lines: &[String], needle: &str| -> Result<usize, String> {
        let needle = needle.trim().trim_start_matches("- ");
        let hits: Vec<usize> = (0..lines.len())
            .filter(|&i| lines[i].trim().starts_with("- ") && !needle.is_empty() && lines[i].contains(needle))
            .collect();
        match hits.as_slice() {
            [one] => Ok(*one),
            [] => Err(format!("no entry contains {needle:?}")),
            _ => Err(format!("{} entries contain {needle:?}; quote more of the one you mean", hits.len())),
        }
    };
    match change {
        Change::Add(t) => {
            let t = entry(t)?;
            if lines.iter().any(|l| l.trim().strip_prefix("- ").is_some_and(|e| e.trim() == t)) {
                return Ok(base);
            }
            lines.push(format!("- {t}"));
        }
        Change::Replace(old, new) => {
            let i = find(&lines, old)?;
            lines[i] = format!("- {}", entry(new)?);
        }
        Change::Remove(old) => {
            let i = find(&lines, old)?;
            lines.remove(i);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    if out.chars().count() > MAX_PROFILE {
        return Err(format!(
            "the profile would be over {MAX_PROFILE} characters; merge or remove an entry first (replace, remove)"
        ));
    }
    Ok(out)
}

/// Applies [change] to USER.md; what it says to the model.
pub fn update(home: &Path, change: &Change) -> Result<String, String> {
    let before = read(home);
    let after = apply(&before, change)?;
    if after == before {
        return Ok("already in the profile".to_owned());
    }
    invincible::fsutil::replace_private(&path(home), &after)?;
    Ok(match change {
        Change::Add(_) => "added to the owner's profile".to_owned(),
        Change::Replace(..) => "changed in the owner's profile".to_owned(),
        Change::Remove(_) => "removed from the owner's profile".to_owned(),
    })
}

/// The change as a diff, for the owner to see; None when it would fail.
pub fn preview(home: &Path, change: &Change) -> Option<String> {
    let before = read(home);
    let after = apply(&before, change).ok()?;
    Some(crate::diff::unified(&before, &after, "~/.autobot/USER.md"))
}

/// For the system prompt; None when there is nothing in it.
pub fn prompt(home: &Path) -> Option<String> {
    let text = read(home);
    let entries: Vec<&str> = text.lines().filter(|l| l.trim().starts_with("- ")).collect();
    if entries.is_empty() {
        return None;
    }
    Some(entries.join("\n").chars().take(MAX_PROFILE).collect())
}

static SECRETS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"\b(sk|rk|pk)-[A-Za-z0-9_\-]{16,}", "an API key"),
        (r"\bsk-ant-[A-Za-z0-9_\-]{10,}", "an API key"),
        (r"\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}", "a GitHub token"),
        (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", "a Slack token"),
        (r"\bAKIA[0-9A-Z]{16}\b", "an AWS key"),
        (r"\bAIza[0-9A-Za-z_\-]{30,}", "a Google key"),
        (r"\b\d{8,10}:[A-Za-z0-9_\-]{30,}", "a bot token"),
        (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"),
        (r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.", "a token"),
        (r"(?i)\b(password|passwd|passphrase|secret|api[_-]?key|token)\s*[:=]\s*\S{4,}", "a password or key"),
        (r"\b[A-Fa-f0-9]{40,}\b", "a long hex string (a key?)"),
    ]
    .into_iter()
    .map(|(p, why)| (Regex::new(p).expect("a pattern"), why))
    .collect()
});

/// What in [text] must not be kept: a secret (keys, tokens, passwords), or personal data the
/// gateway's redactor finds (emails, phone numbers, cards, IBANs, account numbers; names and
/// addresses are not refused, a profile may say what to call the owner). None when it is clean.
pub fn sensitive(text: &str) -> Option<String> {
    if let Some((_, why)) = SECRETS.iter().find(|(re, _)| re.is_match(text)) {
        return Some((*why).to_owned());
    }
    use invincible::redact::Kind;
    invincible::redact::detect(text)
        .into_iter()
        .find(|s| !matches!(s.kind, Kind::Person | Kind::Address))
        .map(|s| format!("personal data ({})", s.kind.tag().to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_changes_in_small_checked_steps() {
        let home = std::env::temp_dir().join(format!("autobot-profile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert!(prompt(&home).is_none());
        let add = Change::Add("Prefers short answers, results first".into());
        let diff = preview(&home, &add).unwrap();
        assert!(diff.contains("+- Prefers short answers"), "{diff}");
        assert_eq!(update(&home, &add).unwrap(), "added to the owner's profile");
        assert_eq!(update(&home, &add).unwrap(), "already in the profile");
        update(&home, &Change::Add("Works in Rust, on macOS".into())).unwrap();
        assert_eq!(entries(&home), ["Prefers short answers, results first", "Works in Rust, on macOS"]);
        update(&home, &Change::Replace("Rust".into(), "Works in Rust and Kotlin, on macOS".into())).unwrap();
        assert!(read(&home).contains("- Works in Rust and Kotlin"));
        assert!(update(&home, &Change::Remove("nothing like this".into())).is_err());
        update(&home, &Change::Remove("short answers".into())).unwrap();
        assert_eq!(prompt(&home).unwrap(), "- Works in Rust and Kotlin, on macOS");
        // Never secrets or personal data.
        for bad in [
            "Their key is sk-abcdefghijklmnopqrstuvwx",
            "email them at jane.doe@fastmail.fm",
            "password: hunter22",
            "token ghp_abcdefghijklmnopqrstuvwxyz0123",
        ] {
            let result = update(&home, &Change::Add(bad.into()));
            assert!(result.as_ref().is_err_and(|e| e.starts_with("not kept")), "{bad}: {result:?}");
        }
        assert!(update(&home, &Change::Add("x".repeat(MAX_ENTRY + 1))).is_err());
        assert!(sensitive("Call him Bob; he lives in Berlin").is_none());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn the_profile_stays_small() {
        let mut text = String::new();
        for i in 0..20 {
            match apply(&text, &Change::Add(format!("{i} {}", "y".repeat(120)))) {
                Ok(next) => text = next,
                Err(e) => {
                    assert!(e.contains("over 2000"), "{e}");
                    return;
                }
            }
        }
        panic!("never refused");
    }
}
