//! Skills: how-to notes for the agent in `$AUTOBOT_HOME/skills/`, in the
//! [agentskills.io](https://agentskills.io) format: a directory per skill with a `SKILL.md`
//! (YAML front matter with `name`, `description` and optionally `allowed-tools`, then the
//! instructions) and any supporting files beside it (scripts, references). A plain `<name>.md`
//! file is a skill too (front matter `description:`, or its first line). The agent sees every
//! skill's name and description and reads one with `read_skill` when it fits the task.
//!
//! The agent can write skills itself: `create_skill` after a task that took many steps and
//! worked, `improve_skill` to change one it used. Both are proposals in `skills/proposed/`, never
//! used until the owner accepts them (`autobot skills accept`, `/skills accept`, the app), since a
//! skill is instructions the agent will follow.

use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Its `SKILL.md`, or the `<name>.md` file.
    pub path: PathBuf,
    /// `allowed-tools` from its front matter (shown, never granted: approvals still hold).
    pub allowed_tools: Vec<String>,
    /// A proposal that changes an existing skill (not a new one).
    pub improves: bool,
}

impl Skill {
    /// The directory of a skill with supporting files; None for a plain `<name>.md`.
    pub fn dir(&self) -> Option<&Path> {
        (self.path.file_name().is_some_and(|n| n == "SKILL.md")).then(|| self.path.parent()).flatten()
    }

    /// Its supporting files (relative), besides SKILL.md.
    pub fn files(&self) -> Vec<String> {
        self.dir().map(files_of).unwrap_or_default()
    }
}

/// Longest skill handed to the model (characters).
const MAX_SKILL: usize = 16 * 1024;
/// Most supporting files a skill the agent writes may have, and their size each.
const MAX_FILES: usize = 8;
const MAX_FILE: usize = 32 * 1024;
/// What an installed skill may hold in all.
const MAX_INSTALL: u64 = 4 * 1024 * 1024;

fn dir(home: &Path) -> PathBuf {
    home.join("skills")
}

/// A skill name: letters, digits, `-` and `_`.
pub fn valid(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn list(home: &Path) -> Vec<Skill> {
    list_in(&dir(home))
}

/// The skill [name], if there is one.
pub fn find(home: &Path, name: &str) -> Option<Skill> {
    valid(name).then(|| list(home).into_iter().find(|s| s.name == name)).flatten()
}

fn list_in(dir: &Path) -> Vec<Skill> {
    let mut skills: Vec<Skill> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let file = path.file_name()?.to_str()?.to_owned();
            let (name, path) = if path.is_dir() {
                (file, path.join("SKILL.md"))
            } else {
                (file.strip_suffix(".md")?.to_owned(), path)
            };
            if !valid(&name) || name == "proposed" {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            let meta = front_matter(&text);
            let allowed_tools = meta
                .iter()
                .find(|(k, _)| k == "allowed-tools" || k == "allowed_tools")
                .map(|(_, v)| {
                    v.trim_matches(['[', ']'])
                        .split([',', ' '])
                        .map(|t| t.trim().trim_matches(['"', '\'']).to_owned())
                        .filter(|t| !t.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let improves = meta.iter().any(|(k, v)| k == "proposed" && v == "improvement");
            Some(Skill { description: describe(&text), name, path, allowed_tools, improves })
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// The skill [name]'s text with the names of its supporting files, or one of those files
/// ([file], relative to the skill's directory); or why not.
pub fn read(home: &Path, name: &str) -> Result<String, String> {
    read_with(home, name, None)
}

/// [read], or with [file] one of the skill's supporting files.
pub fn read_with(home: &Path, name: &str, file: Option<&str>) -> Result<String, String> {
    if !valid(name) {
        return Err(format!("{name:?} is not a skill name"));
    }
    let Some(skill) = find(home, name) else {
        let known: Vec<String> = list(home).into_iter().map(|s| s.name).collect();
        return Err(format!(
            "there is no skill {name:?} (skills: {})",
            if known.is_empty() { "none".into() } else { known.join(", ") }
        ));
    };
    if let Some(file) = file.map(str::trim).filter(|f| !f.is_empty()) {
        let base = skill.dir().ok_or(format!("{name} has no supporting files"))?;
        let path = inside(base, file).ok_or(format!("{file:?} is not a file of {name}"))?;
        let bytes = std::fs::read(&path).map_err(|_| format!("{name} has no file {file:?}"))?;
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return Err(format!("{file} is not a text file ({} bytes)", bytes.len()));
        }
        return Ok(String::from_utf8_lossy(&bytes).chars().take(MAX_SKILL).collect());
    }
    let text = std::fs::read_to_string(&skill.path).map_err(|e| format!("{}: {e}", skill.path.display()))?;
    let mut out: String = text.chars().take(MAX_SKILL).collect();
    if let Some(base) = skill.dir() {
        let files = files_of(base);
        if !files.is_empty() {
            out.push_str(&format!(
                "\n\n[Files with this skill (read one with read_skill and file): {}]",
                files.join(", ")
            ));
        }
    }
    Ok(out)
}

/// The text of a skill without its front matter, for running it (`/<skill>`).
pub fn body(home: &Path, name: &str) -> Result<String, String> {
    let text = read(home, name)?;
    let rest = text.strip_prefix("---").and_then(|r| r.find("\n---").map(|e| &r[e + 4..])).unwrap_or(&text);
    Ok(rest.trim().to_owned())
}

/// [file] under [base], when it stays there (no `..`, not absolute, no links out).
fn inside(base: &Path, file: &str) -> Option<PathBuf> {
    let rel = Path::new(file);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let path = base.join(rel).canonicalize().ok()?;
    path.starts_with(base.canonicalize().ok()?).then_some(path)
}

/// The files of a skill's directory besides `SKILL.md`, relative (two levels at most).
fn files_of(base: &Path) -> Vec<String> {
    let mut out = Vec::new();
    collect_files(base, base, 0, &mut out);
    out.retain(|f| f != "SKILL.md");
    out.sort();
    out
}

fn collect_files(base: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() && depth < 2 {
            collect_files(base, &path, depth + 1, out);
        } else if kind.is_file()
            && let Ok(rel) = path.strip_prefix(base)
        {
            out.push(rel.display().to_string());
        }
    }
}

fn proposed_dir(home: &Path) -> PathBuf {
    dir(home).join("proposed")
}

/// A `SKILL.md`: front matter in the agentskills.io shape, then the instructions.
fn skill_md(name: &str, description: &str, body: &str, proposed: &str) -> String {
    let description = description.replace('\n', " ").replace('"', "'");
    format!("---\nname: {name}\ndescription: \"{}\"\nproposed: {proposed}\n---\n{}\n", description.trim(), body.trim())
}

/// Checks a skill the agent writes: a name, a one-line description, the instructions, and no
/// secrets in them.
fn check_new(name: &str, description: &str, body: &str) -> Result<(), String> {
    if !valid(name) {
        return Err(format!("{name:?} is not a skill name (letters, digits, - and _)"));
    }
    if description.trim().is_empty() || body.trim().is_empty() {
        return Err("a skill needs a one-line description and the steps".to_owned());
    }
    if let Some(why) = crate::profile::sensitive(body).or_else(|| crate::profile::sensitive(description)) {
        return Err(format!("not kept: it contains {why}; skills are instructions, never secrets"));
    }
    Ok(())
}

/// Keeps a skill the agent wrote from experience, as a proposal (`skills/proposed/<name>/`):
/// it is not used until the owner accepts it. [files]: supporting files (relative path, text).
pub fn propose(
    home: &Path,
    name: &str,
    description: &str,
    body: &str,
    files: &[(String, String)],
) -> Result<String, String> {
    let description = description.lines().next().unwrap_or_default().trim();
    check_new(name, description, body)?;
    if find(home, name).is_some() {
        return Err(format!("there is a skill {name:?} already; improve it with improve_skill, or pick another name"));
    }
    let text = skill_md(name, description, body, "true");
    if text.len() > MAX_SKILL {
        return Err(format!("too long ({} characters, at most {MAX_SKILL})", text.len()));
    }
    if files.len() > MAX_FILES {
        return Err(format!("at most {MAX_FILES} supporting files"));
    }
    for (path, content) in files {
        let rel = Path::new(path);
        if path.is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) || path == "SKILL.md" {
            return Err(format!("{path:?} is not a file name for a skill (relative, inside it)"));
        }
        if content.len() > MAX_FILE {
            return Err(format!("{path} is too long (at most {MAX_FILE} bytes)"));
        }
        if let Some(why) = crate::profile::sensitive(content) {
            return Err(format!("not kept: {path} contains {why}"));
        }
    }
    let base = proposed_dir(home).join(name);
    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_file(proposed_dir(home).join(format!("{name}.md")));
    invincible::fsutil::replace_private(&base.join("SKILL.md"), &text)?;
    for (path, content) in files {
        invincible::fsutil::replace_private(&base.join(path), content)?;
    }
    let extra = if files.is_empty() { String::new() } else { format!(" with {} files", files.len()) };
    Ok(format!("proposed the skill {name}{extra}; the owner decides whether to keep it"))
}

/// The `SKILL.md` an improvement of skill [name] would leave: [body] (and [description]) in
/// place of the old ones, or [old] replaced by [new] in it.
pub fn improved(
    home: &Path,
    name: &str,
    description: Option<&str>,
    body: Option<&str>,
    edit: Option<(&str, &str)>,
) -> Result<(String, String), String> {
    let skill = find(home, name).ok_or(format!("there is no skill {name:?} to improve"))?;
    let before = std::fs::read_to_string(&skill.path).map_err(|e| format!("{}: {e}", skill.path.display()))?;
    let old_body =
        before.strip_prefix("---").and_then(|r| r.find("\n---").map(|e| &r[e + 4..])).unwrap_or(&before).trim();
    let description = description.map(str::trim).filter(|d| !d.is_empty()).unwrap_or(&skill.description).to_owned();
    let new_body = match (body, edit) {
        (Some(body), _) if !body.trim().is_empty() => body.to_owned(),
        (_, Some((old, new))) => {
            let found = old_body.matches(old).count();
            if old.is_empty() || found != 1 {
                return Err(format!(
                    "old_text is in {name}'s SKILL.md {found} times; copy it exactly, with enough around it to be unique"
                ));
            }
            old_body.replacen(old, new, 1)
        }
        _ => return Err("give the new body, or old_text and new_text".to_owned()),
    };
    check_new(name, &description, &new_body)?;
    let after = skill_md(name, &description, &new_body, "improvement");
    if after.len() > MAX_SKILL {
        return Err(format!("too long ({} characters, at most {MAX_SKILL})", after.len()));
    }
    Ok((before, after))
}

/// Proposes an improvement of skill [name] ([improved]); the owner sees the diff and decides.
pub fn improve(
    home: &Path,
    name: &str,
    description: Option<&str>,
    body: Option<&str>,
    edit: Option<(&str, &str)>,
) -> Result<String, String> {
    let (_, after) = improved(home, name, description, body, edit)?;
    let base = proposed_dir(home).join(name);
    let _ = std::fs::remove_dir_all(&base);
    invincible::fsutil::replace_private(&base.join("SKILL.md"), &after)?;
    Ok(format!("proposed an improvement of {name}; the owner decides whether to keep it"))
}

/// The diff an improvement proposal makes (for the owner), None for a new skill.
pub fn proposal_diff(home: &Path, name: &str) -> Option<String> {
    let proposal = proposals(home).into_iter().find(|s| s.name == name && s.improves)?;
    let after = std::fs::read_to_string(&proposal.path).ok()?.replacen("proposed: improvement\n", "", 1);
    let current = find(home, name)?;
    let before = std::fs::read_to_string(&current.path).ok()?;
    Some(crate::diff::unified(&before, &after, &format!("skills/{name}/SKILL.md")))
}

/// The proposals waiting for the owner.
pub fn proposals(home: &Path) -> Vec<Skill> {
    list_in(&proposed_dir(home))
}

/// Accepts proposal [name]: from now on the agent sees it like any skill (an improvement takes
/// the old one's place; its other files stay).
pub fn accept(home: &Path, name: &str) -> Result<(), String> {
    if !valid(name) {
        return Err(format!("{name:?} is not a skill name"));
    }
    let proposal =
        proposals(home).into_iter().find(|s| s.name == name).ok_or(format!("there is no proposed skill {name:?}"))?;
    let existing = find(home, name);
    let text = std::fs::read_to_string(&proposal.path).map_err(|e| format!("{}: {e}", proposal.path.display()))?;
    let clean = text.replacen("proposed: true\n", "", 1).replacen("proposed: improvement\n", "", 1);
    match (proposal.improves, existing) {
        (false, Some(_)) => return Err(format!("there is a skill {name:?} already")),
        (true, None) => return Err(format!("there is no skill {name:?} to improve any more")),
        (true, Some(current)) => {
            if current.dir().is_none() {
                std::fs::remove_file(&current.path).map_err(|e| format!("{}: {e}", current.path.display()))?;
            }
            invincible::fsutil::replace_private(&dir(home).join(name).join("SKILL.md"), &clean)?;
        }
        (false, None) => match proposal.dir() {
            Some(from) => {
                let to = dir(home).join(name);
                std::fs::rename(from, &to).map_err(|e| format!("{}: {e}", to.display()))?;
                invincible::fsutil::replace_private(&to.join("SKILL.md"), &clean)?;
                return Ok(());
            }
            None => invincible::fsutil::replace_private(&dir(home).join(format!("{name}.md")), &clean)?,
        },
    }
    remove_at(&proposal)
}

fn remove_at(skill: &Skill) -> Result<(), String> {
    match skill.dir() {
        Some(dir) => std::fs::remove_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display())),
        None => std::fs::remove_file(&skill.path).map_err(|e| format!("{}: {e}", skill.path.display())),
    }
}

pub fn reject(home: &Path, name: &str) -> Result<bool, String> {
    if !valid(name) {
        return Ok(false);
    }
    match proposals(home).into_iter().find(|s| s.name == name) {
        Some(proposal) => remove_at(&proposal).map(|()| true),
        None => Ok(false),
    }
}

/// Removes the skill [name] (`autobot skills remove`); false when there is none.
pub fn remove(home: &Path, name: &str) -> Result<bool, String> {
    match find(home, name) {
        Some(skill) => remove_at(&skill).map(|()| true),
        None => Ok(false),
    }
}

/// Installs the skills at [source]: a directory with a `SKILL.md`, a directory (a repository)
/// with skill directories in it, or a git URL to clone. A skill by a name already here is left
/// out. The names installed, and the ones left out with why.
pub fn install(home: &Path, source: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let source = source.trim();
    let git = source.starts_with("https://")
        || source.starts_with("http://")
        || source.starts_with("git@")
        || source.starts_with("ssh://")
        || source.ends_with(".git");
    let mut clone = None;
    let root = if git {
        let git_cmd = crate::find_on_path("git").ok_or("installing from a URL needs git")?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let into = std::env::temp_dir().join(format!("autobot-skill-{}-{stamp}", std::process::id()));
        let out = std::process::Command::new(git_cmd)
            .args(["clone", "--depth", "1", "--quiet", "--"])
            .arg(source)
            .arg(&into)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("git: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_dir_all(&into);
            return Err(format!("git clone {source}: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        clone = Some(into.clone());
        into
    } else {
        let path = crate::config::expand(Path::new(source));
        path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?
    };
    let found = find_skill_dirs(&root, 0);
    let result = (|| {
        if found.is_empty() {
            return Err(format!("no SKILL.md in {source}"));
        }
        let (mut installed, mut skipped) = (Vec::new(), Vec::new());
        for src in found {
            let text = std::fs::read_to_string(src.join("SKILL.md")).unwrap_or_default();
            let named = front_matter(&text).into_iter().find(|(k, _)| k == "name").map(|(_, v)| v);
            let fallback = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let name = named.filter(|n| valid(n)).unwrap_or(fallback);
            if !valid(&name) {
                skipped.push(format!("{}: not a skill name", src.display()));
                continue;
            }
            if find(home, &name).is_some() {
                skipped.push(format!("{name}: there is a skill by that name already (remove it first)"));
                continue;
            }
            let to = dir(home).join(&name);
            let mut budget = MAX_INSTALL;
            if let Err(e) = copy_tree(&src, &to, 0, &mut budget) {
                let _ = std::fs::remove_dir_all(&to);
                skipped.push(format!("{name}: {e}"));
                continue;
            }
            installed.push(name);
        }
        Ok((installed, skipped))
    })();
    if let Some(clone) = clone {
        let _ = std::fs::remove_dir_all(clone);
    }
    result
}

/// Directories under [dir] with a `SKILL.md` (this one, or up to three levels down).
fn find_skill_dirs(dir: &Path, depth: usize) -> Vec<PathBuf> {
    if dir.join("SKILL.md").is_file() {
        return vec![dir.to_owned()];
    }
    if depth >= 3 {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    entries.sort();
    for entry in entries {
        found.extend(find_skill_dirs(&entry, depth + 1));
    }
    found
}

/// Copies regular files only (no links, no dot names), within [budget] bytes.
fn copy_tree(from: &Path, to: &Path, depth: usize, budget: &mut u64) -> Result<(), String> {
    if depth > 4 {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = to.join(&name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, depth + 1, budget)?;
        } else if kind.is_file() {
            let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if len > *budget {
                return Err(format!("larger than {} MiB", MAX_INSTALL / 1024 / 1024));
            }
            *budget -= len;
            std::fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
    }
    Ok(())
}

/// The list for the system prompt; None when there are no skills.
pub fn prompt(home: &Path) -> Option<String> {
    let skills = list(home);
    (!skills.is_empty())
        .then(|| skills.iter().map(|s| format!("- {}: {}", s.name, s.description)).collect::<Vec<_>>().join("\n"))
}

/// `key: value` lines of the front matter (values unquoted).
fn front_matter(text: &str) -> Vec<(String, String)> {
    let Some(rest) = text.strip_prefix("---") else { return Vec::new() };
    let Some(end) = rest.find("\n---") else { return Vec::new() };
    rest[..end]
        .lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().trim_matches(['"', '\'']).to_owned()))
        .collect()
}

/// What a skill (or a personality) is for: its front matter's `description`, else its first
/// line of text.
pub fn describe(text: &str) -> String {
    if let Some((_, line)) = front_matter(text).into_iter().find(|(k, v)| k == "description" && !v.is_empty()) {
        return line.chars().take(200).collect();
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
    use super::{list, prompt, read, read_with};
    use std::path::PathBuf;

    fn home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("autobot-skills-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        home
    }

    #[test]
    fn proposals_wait_for_the_owner() {
        let home = home("propose");
        assert!(super::propose(&home, "deploy", "Deploy the site", "1. git pull\n2. restart", &[]).is_ok());
        assert!(list(&home).is_empty(), "not used until accepted");
        assert_eq!(super::proposals(&home)[0].description, "Deploy the site");
        assert!(super::propose(&home, "../x", "d", "b", &[]).is_err());
        assert!(super::propose(&home, "empty", "d", "  ", &[]).is_err());
        assert!(
            super::propose(&home, "leak", "d", "export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", &[]).is_err()
        );
        super::accept(&home, "deploy").unwrap();
        assert_eq!(list(&home)[0].name, "deploy");
        assert!(home.join("skills/deploy/SKILL.md").is_file(), "an agentskills.io directory");
        assert!(!read(&home, "deploy").unwrap().contains("proposed"));
        assert!(super::proposals(&home).is_empty());
        assert!(super::propose(&home, "deploy", "again", "x", &[]).is_err(), "a skill by that name exists");
        super::propose(&home, "other", "Other", "x", &[]).unwrap();
        assert!(super::reject(&home, "other").unwrap());
        assert!(super::proposals(&home).is_empty());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn supporting_files_go_with_a_skill_and_stay_inside_it() {
        let home = home("files");
        let files = vec![("scripts/check.sh".to_owned(), "df -h\n".to_owned())];
        super::propose(&home, "disk", "Check the disk", "Run scripts/check.sh", &files).unwrap();
        assert!(super::propose(&home, "bad", "d", "b", &[("../x".into(), "y".into())]).is_err());
        super::accept(&home, "disk").unwrap();
        let text = read(&home, "disk").unwrap();
        assert!(text.contains("[Files with this skill (read one with read_skill and file): scripts/check.sh]"));
        assert_eq!(read_with(&home, "disk", Some("scripts/check.sh")).unwrap(), "df -h\n");
        assert!(read_with(&home, "disk", Some("../../config.toml")).is_err());
        assert!(read_with(&home, "disk", Some("/etc/hosts")).is_err());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn an_improvement_shows_its_diff_and_replaces_the_skill_when_kept() {
        let home = home("improve");
        std::fs::create_dir_all(home.join("skills")).unwrap();
        std::fs::write(home.join("skills/backup.md"), "# Check the nightly backup\n\nLook in /var/backups.").unwrap();
        assert!(super::improve(&home, "nope", None, Some("x"), None).is_err());
        assert!(super::improve(&home, "backup", None, None, Some(("missing", "x"))).is_err());
        super::improve(&home, "backup", None, None, Some(("/var/backups", "/srv/backups"))).unwrap();
        let diff = super::proposal_diff(&home, "backup").unwrap();
        assert!(diff.contains("-Look in /var/backups.") && diff.contains("+Look in /srv/backups."), "{diff}");
        assert!(read(&home, "backup").unwrap().contains("/var/backups"), "not used until kept");
        super::accept(&home, "backup").unwrap();
        assert!(!home.join("skills/backup.md").exists());
        let text = read(&home, "backup").unwrap();
        assert!(text.contains("/srv/backups") && text.starts_with("---\nname: backup\n"), "{text}");
        assert!(!text.contains("proposed"));
        assert_eq!(list(&home)[0].description, "Check the nightly backup");
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn skills_install_from_a_directory_and_remove() {
        let home = home("install");
        let repo = std::env::temp_dir().join(format!("autobot-skill-repo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(repo.join("skills/pdf/scripts")).unwrap();
        std::fs::create_dir_all(repo.join("skills/web")).unwrap();
        std::fs::write(
            repo.join("skills/pdf/SKILL.md"),
            "---\nname: pdf-tools\ndescription: Work with PDFs\nallowed-tools: Bash Read\n---\nUse pdftotext.",
        )
        .unwrap();
        std::fs::write(repo.join("skills/pdf/scripts/x.py"), "print(1)").unwrap();
        std::fs::write(repo.join("skills/web/SKILL.md"), "---\ndescription: Browse\n---\nOpen it.").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", repo.join("skills/web/link")).unwrap();
        let (installed, skipped) = super::install(&home, repo.to_str().unwrap()).unwrap();
        assert_eq!(installed, ["pdf-tools", "web"]);
        assert!(skipped.is_empty());
        assert!(!home.join("skills/web/link").exists(), "links are not copied");
        let pdf = super::find(&home, "pdf-tools").unwrap();
        assert_eq!(pdf.allowed_tools, ["Bash", "Read"]);
        assert_eq!(read_with(&home, "pdf-tools", Some("scripts/x.py")).unwrap(), "print(1)");
        let (again, skipped) = super::install(&home, repo.to_str().unwrap()).unwrap();
        assert!(again.is_empty() && skipped.len() == 2, "names already here are left out");
        assert!(super::remove(&home, "web").unwrap());
        assert!(!super::remove(&home, "web").unwrap());
        assert!(super::install(&home, "/definitely/not/here").is_err());
        std::fs::remove_dir_all(home).unwrap();
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn skills_are_listed_described_and_read() {
        let home = home("list");
        assert!(prompt(&home).is_none());
        std::fs::create_dir_all(home.join("skills/review")).unwrap();
        std::fs::write(
            home.join("skills/deploy.md"),
            "---\ndescription: Deploy the site to the VPS\n---\n1. git pull\n2. restart",
        )
        .unwrap();
        std::fs::write(home.join("skills/backup.md"), "# Check the nightly backup\n\nLook in /var/backups.").unwrap();
        std::fs::write(
            home.join("skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review a PR\n---\nRead it.",
        )
        .unwrap();
        std::fs::write(home.join("skills/bad name.md"), "x").unwrap();
        std::fs::write(home.join("skills/notes.txt"), "x").unwrap();
        let skills = list(&home);
        assert_eq!(skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["backup", "deploy", "review"]);
        assert_eq!(
            prompt(&home).unwrap(),
            "- backup: Check the nightly backup\n- deploy: Deploy the site to the VPS\n- review: Review a PR"
        );
        assert!(read(&home, "deploy").unwrap().contains("git pull"));
        assert_eq!(super::body(&home, "review").unwrap(), "Read it.");
        assert!(read(&home, "../config").is_err());
        assert!(read(&home, "nope").unwrap_err().contains("skills: backup, deploy, review"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
