//! The owner's own slash commands: a Markdown file each, its text a prompt. `/review src/x.rs`
//! sends `review.md` with `$ARGUMENTS` (or `$1`…`$9`) filled in. Found in the project's
//! `.autobot/commands` and `.claude/commands` (so commands written for Claude Code work as they
//! are), then `$AUTOBOT_HOME/commands`; the first of a name wins. A subdirectory makes a prefix:
//! `git/pr.md` is `/git:pr`. Optional front matter gives a `description` for `/help`.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Custom {
    /// Without the slash: `review`, `git:pr`.
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// Where commands are looked for, first wins.
fn dirs(workdir: &Path, home: &Path) -> Vec<(PathBuf, &'static str)> {
    vec![
        (workdir.join(".autobot/commands"), "project"),
        (workdir.join(".claude/commands"), "project"),
        (home.join("commands"), "yours"),
    ]
}

/// Every command, by name.
pub fn list(workdir: &Path, home: &Path) -> Vec<Custom> {
    let mut found: Vec<Custom> = Vec::new();
    for (dir, scope) in dirs(workdir, home) {
        let mut files = Vec::new();
        collect(&dir, "", 0, &mut files);
        files.sort();
        for (name, path) in files {
            if found.iter().any(|c| c.name == name) || builtin(&name) {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let (meta, body) = front_matter(&text);
            let description = meta
                .iter()
                .find(|(k, _)| k == "description")
                .map(|(_, v)| v.clone())
                .or_else(|| {
                    body.lines()
                        .map(str::trim)
                        .find(|l| !l.is_empty())
                        .map(|l| l.trim_start_matches('#').trim().to_owned())
                })
                .unwrap_or_default();
            let description: String = description.chars().take(80).collect();
            found.push(Custom { name, description: format!("{description} ({scope})"), path });
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn collect(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() && depth < 2 {
            collect(&path, &format!("{prefix}{name}:"), depth + 1, out);
        } else if let Some(stem) = name.strip_suffix(".md")
            && !stem.is_empty()
            && stem.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            out.push((format!("{prefix}{stem}"), path));
        }
    }
}

/// Names the chat itself answers to: a file cannot take them over.
fn builtin(name: &str) -> bool {
    matches!(
        name,
        "help"
            | "exit"
            | "quit"
            | "q"
            | "model"
            | "models"
            | "approvals"
            | "mode"
            | "private"
            | "tools"
            | "context"
            | "undo"
            | "diff"
            | "status"
            | "new"
            | "fork"
            | "sessions"
            | "resume"
            | "memory"
            | "skills"
            | "team"
            | "board"
            | "clear"
            | "init"
            | "compact"
            | "ps"
            | "commands"
            | "copy"
            | "image"
    )
}

/// `key: value` lines between `---` fences at the top, and the rest.
fn front_matter(text: &str) -> (Vec<(String, String)>, &str) {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (Vec::new(), text);
    };
    let Some(end) = rest.find("\n---") else { return (Vec::new(), text) };
    let meta = rest[..end]
        .lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().trim_matches('"').to_owned()))
        .collect();
    let body = &rest[end + 4..];
    (meta, body.strip_prefix('\n').or_else(|| body.strip_prefix("\r\n")).unwrap_or(body))
}

/// The prompt [command] makes with [args]: `$ARGUMENTS` is all of them, `$1`…`$9` one each;
/// a prompt that names none gets them appended.
pub fn expand(command: &Custom, args: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(&command.path).map_err(|e| format!("{}: {e}", command.path.display()))?;
    let (_, body) = front_matter(&text);
    Ok(fill(body, args))
}

fn fill(body: &str, args: &str) -> String {
    let words: Vec<&str> = args.split_whitespace().collect();
    let mut out = body.replace("$ARGUMENTS", args);
    let mut named = out != body;
    for n in (1..=9).rev() {
        let key = format!("${n}");
        if out.contains(&key) {
            named = true;
            out = out.replace(&key, words.get(n - 1).copied().unwrap_or(""));
        }
    }
    if !named && !args.trim().is_empty() {
        out = format!("{}\n\n{}", out.trim_end(), args.trim());
    }
    out.trim().to_owned()
}

/// What `/init` asks: the project's AGENTS.md, written or brought up to date.
pub const INIT: &str = "Look through this project (its layout, build files, README, CI, a few central source files) and write AGENTS.md at its root: what the project is, how to build, test, lint and run it (the exact commands), the code layout, the conventions the code follows, and anything an agent working here must not do. Short and specific: commands and paths, no generic advice. If AGENTS.md or CLAUDE.md already exists, read it first and improve it instead of starting over; keep what is still true.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_arguments() {
        assert_eq!(fill("Review $ARGUMENTS carefully.", "src/a.rs"), "Review src/a.rs carefully.");
        assert_eq!(fill("From $1 to $2.", "main dev"), "From main to dev.");
        assert_eq!(fill("Fix the tests.", "in crate x"), "Fix the tests.\n\nin crate x");
        assert_eq!(fill("Fix the tests.", ""), "Fix the tests.");
    }

    #[test]
    fn finds_project_and_home_commands() {
        let root = std::env::temp_dir().join(format!("autobot-commands-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (work, home) = (root.join("w"), root.join("h"));
        std::fs::create_dir_all(work.join(".claude/commands/git")).unwrap();
        std::fs::create_dir_all(home.join("commands")).unwrap();
        std::fs::write(work.join(".claude/commands/review.md"), "---\ndescription: Review a file\n---\nReview $1")
            .unwrap();
        std::fs::write(work.join(".claude/commands/git/pr.md"), "# Open a PR\nOpen a pull request.").unwrap();
        std::fs::write(home.join("commands/review.md"), "mine").unwrap();
        std::fs::write(home.join("commands/help.md"), "not allowed").unwrap();
        std::fs::write(home.join("commands/standup.md"), "Summarize yesterday.").unwrap();
        let all = list(&work, &home);
        let names: Vec<&str> = all.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["git:pr", "review", "standup"]);
        let review = &all[1];
        assert_eq!(review.description, "Review a file (project)");
        assert_eq!(expand(review, "x.rs").unwrap(), "Review x.rs");
        assert_eq!(all[0].description, "Open a PR (project)");
        let _ = std::fs::remove_dir_all(&root);
    }
}
